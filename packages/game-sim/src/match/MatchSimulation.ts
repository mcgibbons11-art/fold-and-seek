import {
  DEFAULT_ARRANGEMENT_ID,
  DEFAULT_MATCH_SETTINGS,
  MatchPhase,
  MatchSnapshotSchema,
  decodeDisguiseWire,
  type MatchSettings,
  type PlayerRole,
  type StarterArrangementId,
  type TauntId,
} from "@foldseek/shared";
import { DeterministicRng, hashString, mixSeeds } from "../deterministic/rng";
import {
  SETTABLE_SETTING_KEYS,
  SETTING_BOUNDS,
  type CommandRejectionReason,
  type CommandResult,
  type MatchCommand,
  type MatchSettingsPatch,
  type SettableSettingKey,
} from "./commands";
import {
  CLOSE_PASS_COOLDOWN_MS,
  CORRECT_ACCUSATION_COOLDOWN_MS,
  CREEP_SPEED_TOLERANCE,
  LOADING_TIMEOUT_MS,
  MIN_LOCK_GRACE_MS,
  PUBLIC_ID_LENGTH,
  RESULT_VOTE_CATEGORIES,
  SCORE_INSPECTOR_MAX_FOCUSED_OBJECTS,
  TAUNT_COOLDOWN_MS,
  WATCHED_THROTTLE_MS,
  finalCountdownMs,
  phaseDurationMs,
  type ResultVoteCategory,
} from "./constants";
import type {
  DisguiseOwnership,
  DisguiseSource,
  MatchResults,
  MatchWinner,
  PlayerLeftReason,
  PlayerLifeState,
  PlayerResult,
  PrivateSimEvent,
  PrivateSimEventDraft,
  SimEvent,
  SimEventDraft,
  SimOutput,
  WatchedLevel,
} from "./events";
import {
  MATCH_SNAPSHOT_VERSION,
  type MatchSnapshot,
  type PoseSource,
  type RestoreDeps,
  type SnapshotDisguise,
  type SnapshotOptions,
  type SnapshotPlayer,
} from "./snapshot";
import {
  DEFAULT_OBJECT_REGISTRY,
  reactionsFor,
  type ObjectRegistry,
  type RegisteredObject,
} from "./objects";
import { assignInspectors, inspectorCountForRoster, type RoleHistory } from "./roles";
import { scoreInspector, scoreMimic } from "./scoring";
import { PERMISSIVE_SPATIAL_VALIDATOR, type SpatialValidator } from "./spatial";

/** What everyone in the room may see about a player. */
export interface PublicPlayerView {
  /**
   * The opaque key the transport used to seat this player. Who is in the room
   * is public, so this lets a UI attribute host and authority to roster rows.
   * It never appears in an event, and nothing public links it to a disguise:
   * ownership stays in the private stream until the reveal (§27.10).
   */
  readonly seatId: string;
  readonly publicPlayerId: string;
  readonly displayName: string;
  readonly isHost: boolean;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly lifeState: PlayerLifeState;
  /** Mimic identity is never public before the reveal, so it reads as "unknown". */
  readonly rolePublicState: "unknown" | "inspector" | "spectator" | "mimic";
}

export interface PublicDisguiseView {
  readonly publicObjectId: string;
  readonly encodedPose: string;
  /** Body paint. Public by nature: it is what the object looks like. */
  readonly encodedPaint: string | null;
  /** Named starting pose to render when `encodedPose` is empty (§5.8). */
  readonly defaultArrangementId: StarterArrangementId | null;
  readonly revealed: boolean;
}

export interface PublicMatchState {
  readonly now: number;
  /**
   * Zero-based. The first round of a room is round 0 and each rematch adds one,
   * so a display that counts from one prints `round + 1`.
   */
  readonly round: number;
  readonly phase: MatchPhase;
  readonly phaseEndsAt: number;
  readonly warrantsRemaining: number;
  /** What the round started with, so spent rounds can be rendered. */
  readonly warrantsTotal: number;
  readonly mimicsRemaining: number;
  readonly settings: MatchSettings;
  readonly players: readonly PublicPlayerView[];
  readonly disguises: readonly PublicDisguiseView[];
  readonly results: MatchResults | null;
}

export interface OwnDisguiseView {
  readonly publicObjectId: string;
  readonly encodedPose: string;
  readonly encodedPaint: string | null;
  readonly source: DisguiseSource;
  readonly defaultArrangementId: StarterArrangementId | null;
}

/** Distinguishes "no round has dealt me in yet" from "I am sitting this one out". */
export type PrivateRoleState = "unassigned" | "inspector" | "mimic" | "spectator";

export interface PrivateMatchState {
  readonly playerId: string;
  readonly publicPlayerId: string;
  readonly role: PlayerRole;
  /** `role`, but telling a lobby player apart from a genuine spectator. */
  readonly roleState: PrivateRoleState;
  readonly lifeState: PlayerLifeState;
  readonly isHost: boolean;
  readonly ready: boolean;
  readonly ownDisguise: OwnDisguiseView | null;
  /** Ownership the viewer is entitled to know: teammates, or everything once revealed. */
  readonly knownDisguiseOwners: readonly DisguiseOwnership[];
  readonly warrantsRemaining: number | null;
  readonly accusationReadyAt: number | null;
  /** When this hider may taunt again, so a client need not shadow-count it. */
  readonly tauntReadyAtMs: number | null;
  /** How strongly an Inspector is looking at this hider right now (§5.12). */
  readonly watchedLevel: WatchedLevel;
}

export interface AddPlayerOptions {
  readonly displayName?: string;
  readonly isHost?: boolean;
}

interface RoundStats {
  directLookEscapes: number;
  closePasses: number;
  peerStyleVotes: number;
  correctAccusations: number;
  wrongAccusations: number;
  focusedObjectIds: Set<string>;
  /**
   * Milliseconds this hider spent inside an Inspector's focus while unresolved.
   * Kept in milliseconds and floored to seconds only at scoring time, so a
   * hundred short looks are worth what one long look is.
   */
  lineOfSightMs: number;
  observedTaunts: number;
}

/**
 * A locked disguise. The pose is snapshotted here at lock time rather than read
 * back through the owning player, so the object keeps standing in the room with
 * its last valid pose after its owner is dropped (§5.8, §27.9). `ownerPlayerId`
 * going null is what releases the player slot; the public identity stays, since
 * catching this object still has to name who was inside it.
 */
interface DisguiseRecord {
  readonly publicObjectId: string;
  ownerPlayerId: string | null;
  readonly ownerPublicPlayerId: string;
  readonly ownerDisplayName: string;
  /** Current pose. Hiders stay active, so this changes during the hunt. */
  encodedPose: string;
  revision: number;
  /**
   * Body paint, carried beside the pose rather than inside it. The two are
   * edited independently and change at different rates, so they keep separate
   * revisions and a pose update never rewrites the paint.
   */
  encodedPaint: string | null;
  paintRevision: number;
  readonly source: DisguiseSource;
  readonly defaultArrangementId: StarterArrangementId | null;
  readonly autoLocked: boolean;
  readonly lockedAtMs: number;
  caughtAtMs: number | null;
  /** Root position of the current pose, and when it last changed. */
  rootPosition: readonly [number, number, number];
  movedAtMs: number;
}

interface InternalPlayer {
  readonly playerId: string;
  readonly publicPlayerId: string;
  displayName: string;
  isHost: boolean;
  connected: boolean;
  disconnectedAtMs: number | null;
  ready: boolean;
  role: PlayerRole;
  lifeState: PlayerLifeState;
  readonly joinIndex: number;
  joinedRound: number;
  lastInspectorRound: number;
  inspectorRounds: number;
  disguise: DisguiseRecord | null;
  lastValidPose: { encodedPose: string; revision: number } | null;
  lastValidPaint: { encodedPaint: string; revision: number } | null;
  caughtAtMs: number | null;
  stats: RoundStats;
  lastTauntAtMs: number | null;
  lastForgeUpdateAtMs: number | null;
  /** Last watched level delivered to this player, and when. */
  watchedLevel: WatchedLevel;
  watchedDeliveredAtMs: number | null;
}

const MAX_TRANSITIONS_PER_TICK = 32;
const EMPTY_POSE = "";
const ORIGIN: readonly [number, number, number] = [0, 0, 0];

function distanceBetween(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** Whole seconds a hider spent watched, which is what the score formula takes. */
function lineOfSightSecondsOf(player: InternalPlayer): number {
  return Math.floor(player.stats.lineOfSightMs / 1_000);
}

/** Folded into the seed so no published value is derived from it directly. */
const SEED_SALT_TAG = 0x7f4a7c15;

function createStats(): RoundStats {
  return {
    directLookEscapes: 0,
    closePasses: 0,
    peerStyleVotes: 0,
    correctAccusations: 0,
    wrongAccusations: 0,
    focusedObjectIds: new Set<string>(),
    lineOfSightMs: 0,
    observedTaunts: 0,
  };
}

const NO_PRIVATE_EVENTS: ReadonlyMap<string, readonly PrivateSimEvent[]> = new Map();

/** Two-level map to plain pairs, preserving both insertion orders. */
function flattenNested<K extends string, V>(
  source: ReadonlyMap<string, ReadonlyMap<K, V>>,
): ReadonlyArray<readonly [string, ReadonlyArray<readonly [K, V]>]> {
  return [...source.entries()].map(
    ([key, inner]) =>
      [key, [...inner.entries()].map(([innerKey, value]) => [innerKey, value] as const)] as const,
  );
}

function fillNested<K extends string, V>(
  target: Map<string, Map<K, V>>,
  entries: ReadonlyArray<readonly [string, ReadonlyArray<readonly [K, V]>]>,
): void {
  for (const [key, inner] of entries) {
    target.set(key, new Map(inner.map(([innerKey, value]) => [innerKey, value] as [K, V])));
  }
}

/**
 * Locked poses for a pose-omitted snapshot, taken from the public state the new
 * host already holds. A disguise that falls back to a starting arrangement has
 * no encoded pose to begin with and needs none.
 */
function rehydratedPoses(
  snapshot: MatchSnapshot,
  supplied: readonly PoseSource[] | undefined,
): ReadonlyMap<string, string> {
  if (!snapshot.po) return new Map();

  const byObjectId = new Map((supplied ?? []).map((entry) => [entry.publicObjectId, entry.encodedPose]));
  const missing: string[] = [];
  const poses = new Map<string, string>();
  for (const disguise of snapshot.dg) {
    if (disguise.s === "default_arrangement") continue;
    const pose = byObjectId.get(disguise.o);
    if (pose === undefined || pose.length === 0) {
      missing.push(disguise.o);
      continue;
    }
    poses.set(disguise.o, pose);
  }
  if (missing.length > 0) {
    throw new Error(
      `snapshot omitted poses but ${missing.length} could not be supplied: ${missing.join(", ")}`,
    );
  }
  return poses;
}

function restoreDisguise(
  entry: SnapshotDisguise,
  poses: ReadonlyMap<string, string>,
): DisguiseRecord {
  return {
    publicObjectId: entry.o,
    ownerPlayerId: entry.ow,
    ownerPublicPlayerId: entry.op,
    ownerDisplayName: entry.on,
    encodedPose: poses.get(entry.o) ?? entry.e,
    revision: entry.rv,
    source: entry.s,
    defaultArrangementId: entry.a,
    autoLocked: entry.al,
    lockedAtMs: entry.lk,
    caughtAtMs: entry.ct,
    rootPosition: entry.rp,
    movedAtMs: entry.mv,
  };
}

function restorePlayer(
  entry: SnapshotPlayer,
  disguises: ReadonlyMap<string, DisguiseRecord>,
  posesOmitted: boolean,
): InternalPlayer {
  const disguise = entry.o === null ? null : (disguises.get(entry.o) ?? null);
  // lockPlayer records the pose it locked for every source but the fallback
  // arrangement, so an omitted snapshot rebuilds exactly that.
  const lastValidPose =
    posesOmitted && disguise !== null && disguise.source !== "default_arrangement"
      ? { encodedPose: disguise.encodedPose, revision: disguise.revision }
      : entry.vp === null
        ? null
        : { encodedPose: entry.vp[0], revision: entry.vp[1] };
  return {
    playerId: entry.i,
    publicPlayerId: entry.p,
    displayName: entry.n,
    isHost: entry.h,
    connected: entry.c,
    disconnectedAtMs: entry.d,
    ready: entry.y,
    role: entry.r,
    lifeState: entry.l,
    joinIndex: entry.j,
    joinedRound: entry.jr,
    lastInspectorRound: entry.li,
    inspectorRounds: entry.ir,
    // The same record object the disguise map holds, never a copy: detach and
    // capture both write through this reference.
    disguise,
    lastValidPose,
    caughtAtMs: entry.ct,
    stats: {
      directLookEscapes: entry.st.e,
      closePasses: entry.st.c,
      peerStyleVotes: entry.st.v,
      correctAccusations: entry.st.ca,
      wrongAccusations: entry.st.wa,
      focusedObjectIds: new Set(entry.st.f),
      lineOfSightMs: entry.st.los,
      observedTaunts: entry.st.ot,
    },
    lastTauntAtMs: entry.tt,
    lastForgeUpdateAtMs: entry.fu,
    watchedLevel: entry.wl,
    watchedDeliveredAtMs: entry.wa,
  };
}

function reject(reason: CommandRejectionReason, detail?: string): CommandResult {
  const base = { accepted: false as const, public: [], private: NO_PRIVATE_EVENTS };
  return detail === undefined ? { ...base, reason } : { ...base, reason, detail };
}

/**
 * Authoritative deterministic match simulation.
 *
 * The class owns no timers and no I/O: callers drive it with tick(nowMs) and
 * feed it validated commands, so the identical instance runs on a dedicated
 * server or on a host-elected Portals client. Every state change leaves through
 * the returned SimOutput, split into what the room may see and what belongs to
 * one player.
 */
export class MatchSimulation {
  private settings: MatchSettings;
  private readonly seed: number;
  private readonly seedSalt: number;
  private readonly spatial: SpatialValidator;
  private readonly objectRegistry: ObjectRegistry;
  private readonly registeredObjects: ReadonlyMap<string, RegisteredObject>;
  private identityRng: DeterministicRng;

  private readonly players = new Map<string, InternalPlayer>();
  private nextJoinIndex = 0;
  private nowMs = 0;
  private round = 0;
  private phase: MatchPhase = MatchPhase.Lobby;
  private phaseEndsAt = 0;

  private warrantsRemaining = 0;
  private warrantsTotal = 0;
  private inspectionStartedAtMs = 0;
  private inspectionEndsAtMs = 0;
  private inspectionEndedAtMs = 0;
  private lockGraceFloorAt = 0;

  private readonly disguises = new Map<string, DisguiseRecord>();
  private readonly resolvedObjects = new Map<string, "mimic" | "innocent">();
  private objectIdPool: string[] = [];
  private accusationCounter = 0;
  private tauntCounter = 0;

  private readonly accusationReadyAt = new Map<string, number>();
  private readonly focusHolds = new Map<string, { objectId: string; sinceMs: number }>();
  private pendingEscapes: Array<{ inspectorId: string; objectId: string; brokenAtMs: number }> = [];
  // Rate-limit clocks, keyed by inspector then object so one player's entries
  // can be released exactly when they leave.
  private readonly lastEscapeAt = new Map<string, Map<string, number>>();
  private readonly lastClosePassAt = new Map<string, Map<string, number>>();

  private readonly resultVotes = new Map<string, Map<ResultVoteCategory, string>>();
  private readonly rematchVotes = new Map<string, boolean>();
  private results: MatchResults | null = null;

  private readonly publicQueue: SimEvent[] = [];
  private readonly privateQueues = new Map<string, PrivateSimEvent[]>();
  private seq = 0;

  constructor(
    settings: MatchSettingsPatch = {},
    seed = 1,
    spatial: SpatialValidator = PERMISSIVE_SPATIAL_VALIDATOR,
    objectRegistry: ObjectRegistry = DEFAULT_OBJECT_REGISTRY,
  ) {
    this.settings = { ...DEFAULT_MATCH_SETTINGS, ...settings };
    this.seed = seed >>> 0;
    this.seedSalt = mixSeeds(this.seed, SEED_SALT_TAG);
    this.spatial = spatial;
    this.objectRegistry = objectRegistry;
    this.registeredObjects = new Map(
      objectRegistry.objects.map((entry) => [entry.objectId, entry] as const),
    );
    this.identityRng = new DeterministicRng(mixSeeds(this.seed, 0x1d3f));
  }

  // ---------------------------------------------------------------- membership

  addPlayer(playerId: string, options: AddPlayerOptions = {}): CommandResult {
    if (this.players.has(playerId)) return reject("duplicate_player");
    if (this.players.size >= this.settings.maxPlayers) return reject("room_full");

    // A monotonic counter, so an id is never reused after someone leaves and
    // host promotion cannot be steered by cycling players through the room.
    const joinIndex = this.nextJoinIndex;
    this.nextJoinIndex += 1;
    const isHost = options.isHost ?? !this.hasHost();
    const inLobby = this.phase === MatchPhase.Lobby;
    const player: InternalPlayer = {
      playerId,
      publicPlayerId: `p_${this.identityRng.token(PUBLIC_ID_LENGTH)}`,
      displayName: options.displayName ?? `Visitor ${joinIndex + 1}`,
      isHost,
      connected: true,
      disconnectedAtMs: null,
      ready: false,
      role: "spectator",
      lifeState: inLobby ? "active" : "spectating",
      joinIndex,
      joinedRound: this.round,
      lastInspectorRound: -1,
      inspectorRounds: 0,
      disguise: null,
      lastValidPose: null,
      lastValidPaint: null,
      caughtAtMs: null,
      stats: createStats(),
      lastTauntAtMs: null,
      lastForgeUpdateAtMs: null,
      watchedLevel: 0,
      watchedDeliveredAtMs: null,
    };
    this.players.set(playerId, player);
    this.emit({
      type: "player_joined",
      publicPlayerId: player.publicPlayerId,
      displayName: player.displayName,
      isHost: player.isHost,
    });
    return { accepted: true, ...this.drain() };
  }

  removePlayer(playerId: string, reason: PlayerLeftReason = "left"): SimOutput {
    this.detachPlayer(playerId, reason);
    this.advanceAll();
    return this.drain();
  }

  private detachPlayer(playerId: string, reason: PlayerLeftReason): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.players.delete(playerId);
    this.endFocusHold(playerId);
    this.accusationReadyAt.delete(playerId);
    this.rematchVotes.delete(playerId);
    this.lastEscapeAt.delete(playerId);
    this.lastClosePassAt.delete(playerId);
    this.privateQueues.delete(playerId);
    this.pendingEscapes = this.pendingEscapes.filter((entry) => entry.inspectorId !== playerId);
    this.withdrawResultVotes(playerId);
    // The disguise stays in the room with the pose it locked; only the player
    // slot is released (§5.8, §27.9).
    if (player.disguise) player.disguise.ownerPlayerId = null;

    this.emit({ type: "player_left", publicPlayerId: player.publicPlayerId, reason });
    if (player.isHost) this.promoteHost();
  }

  /** Takes back the style votes a departing player cast, so no score keeps them. */
  private withdrawResultVotes(playerId: string): void {
    const votes = this.resultVotes.get(playerId);
    if (!votes) return;
    this.resultVotes.delete(playerId);

    for (const objectId of votes.values()) {
      const owner = this.presentDisguiseOwner(objectId);
      if (owner && owner.stats.peerStyleVotes > 0) owner.stats.peerStyleVotes -= 1;
    }
    if (this.results) this.results = this.computeResults(this.results.winner);
  }

  markDisconnected(playerId: string, nowMs?: number): SimOutput {
    if (nowMs !== undefined) this.setNow(nowMs);
    const player = this.players.get(playerId);
    if (!player || !player.connected) return this.drain();

    player.connected = false;
    player.disconnectedAtMs = this.nowMs;
    this.endFocusHold(playerId);
    this.emit({
      type: "player_connection_changed",
      publicPlayerId: player.publicPlayerId,
      connected: false,
    });
    this.advanceAll();
    return this.drain();
  }

  markReconnected(playerId: string, nowMs?: number): SimOutput {
    if (nowMs !== undefined) this.setNow(nowMs);
    const player = this.players.get(playerId);
    if (!player || player.connected) return this.drain();

    player.connected = true;
    player.disconnectedAtMs = null;
    this.emit({
      type: "player_connection_changed",
      publicPlayerId: player.publicPlayerId,
      connected: true,
    });
    this.advanceAll();
    return this.drain();
  }

  // -------------------------------------------------------------------- clock

  tick(nowMs: number): SimOutput {
    this.setNow(nowMs);
    this.expireDisconnectedPlayers();
    this.resolvePendingEscapes();
    this.advanceAll();
    this.deliverWatchedLevels();
    return this.drain();
  }

  // ----------------------------------------------------------------- commands

  handleCommand(playerId: string, command: MatchCommand): CommandResult {
    const player = this.players.get(playerId);
    if (!player) return reject("unknown_player");

    switch (command.type) {
      case "player_ready":
        return this.commandPlayerReady(player, command.ready);
      case "set_settings":
        return this.commandSetSettings(player, command.settings);
      case "start_match":
        return this.commandStartMatch(player);
      case "lock_disguise":
        return this.commandLockDisguise(player, command.payload, command.revision);
      case "accuse":
        return this.commandAccuse(player, command.targetObjectId);
      case "focus":
        return this.commandFocus(player, command.targetObjectId);
      case "vote_result":
        return this.commandVoteResult(player, command.category, command.targetPublicObjectId);
      case "vote_rematch":
        return this.commandVoteRematch(player, command.yes);
      case "taunt":
        return this.commandTaunt(player, command.tauntId);
    }
  }

  /**
   * A pose from a Mimic, before or after their disguise manifests.
   *
   * Before the lock it is the recovery pose of §5.8, so a Mimic who never sends
   * lock_disguise still locks into their most recent valid work. After the lock
   * it is a live adjustment: hiders stay active through the hunt, reshaping and
   * creeping while the Inspector searches. Both paths validate the pose, since
   * either can become what the room sees.
   */
  recordForgeSnapshot(
    playerId: string,
    encodedPose: string,
    revision: number,
    nowMs?: number,
  ): CommandResult {
    if (nowMs !== undefined) this.setNow(nowMs);
    const player = this.players.get(playerId);
    if (!player) return reject("unknown_player");
    if (player.role !== "mimic") return reject("wrong_role");

    // Phase before life state, matching every other command: which part of the
    // round it is decides whether the request makes sense at all.
    const locked = player.disguise !== null;
    const editable = locked ? this.isPostLockEditPhase() : this.isForgePhase();
    if (!editable) return reject("wrong_phase");
    if (player.lifeState !== "active") return reject("player_not_active");

    // Revisions only ever move forward, so a replayed or reordered update
    // cannot walk a disguise backwards.
    if (this.isStaleRevision(player, revision)) return reject("stale_revision");
    if (player.lastValidPose && revision === player.lastValidPose.revision) {
      return reject("stale_revision", "duplicate_revision");
    }

    const minIntervalReject = this.rateLimitForgeUpdate(player);
    if (minIntervalReject) return minIntervalReject;

    const decoded = decodeDisguiseWire(encodedPose);
    if (!decoded.ok) return reject("invalid_pose", decoded.issue);
    const position = decoded.pose.root.position as readonly [number, number, number];

    let moved = false;
    if (locked) {
      const record = player.disguise as DisguiseRecord;
      const travelled = distanceBetween(record.rootPosition, position);
      moved = travelled > 0;
      if (moved) {
        const decision = this.validateCreep(player, record, position, travelled);
        if (decision) return decision;
      }
    }

    player.lastValidPose = { encodedPose, revision };
    player.lastForgeUpdateAtMs = this.nowMs;

    if (locked) {
      const record = player.disguise as DisguiseRecord;
      record.encodedPose = encodedPose;
      record.revision = revision;
      if (moved) {
        record.rootPosition = position;
        record.movedAtMs = this.nowMs;
      }
      this.emit({
        type: "disguise_updated",
        publicObjectId: record.publicObjectId,
        revision,
        moved,
        painted: false,
      });
    }
    return this.accept();
  }

  /** Refuses forge updates arriving faster than the configured command rate. */
  private rateLimitForgeUpdate(player: InternalPlayer): CommandResult | null {
    const last = player.lastForgeUpdateAtMs;
    if (last === null) return null;
    const hz = this.settings.maxForgeCommandHz;
    if (hz <= 0) return null;
    // Compared as a product to keep the check exact rather than trusting a
    // floating point interval.
    if ((this.nowMs - last) * hz < 1_000) return reject("rate_limited");
    return null;
  }

  /**
   * A creeping hider may cover only hiderCreepSpeed metres per second, measured
   * between consecutive poses. Where it may creep to is map knowledge, so that
   * half of the question goes to the geometry owner (§28.5).
   */
  private validateCreep(
    player: InternalPlayer,
    record: DisguiseRecord,
    position: readonly [number, number, number],
    travelled: number,
  ): CommandResult | null {
    const elapsedMs = Math.max(0, this.nowMs - record.movedAtMs);
    const allowed = (this.settings.hiderCreepSpeed * elapsedMs) / 1_000;
    if (travelled > allowed * CREEP_SPEED_TOLERANCE) {
      return reject(
        "moved_too_fast",
        `${travelled.toFixed(3)}m in ${elapsedMs}ms exceeds ${this.settings.hiderCreepSpeed}m/s`,
      );
    }
    const decision = this.spatial.canOccupy(player.playerId, position);
    if (!decision.ok) return reject("outside_play_volume", decision.reason);
    return null;
  }

  /**
   * A disguised Mimic baits the Inspector (§MECCHA taunt). The object performs
   * it, never the player, so taunting costs anonymity only to the extent that
   * being seen moving does.
   */
  private commandTaunt(player: InternalPlayer, tauntId: TauntId): CommandResult {
    if (!this.isInspectionPhase()) return reject("wrong_phase");
    if (player.role !== "mimic") return reject("wrong_role");
    if (player.lifeState !== "active") return reject("player_not_active");

    const record = player.disguise;
    if (!record || this.resolvedObjects.has(record.publicObjectId)) {
      return reject("player_not_active", "no_live_disguise");
    }

    const last = player.lastTauntAtMs;
    if (last !== null && this.nowMs - last < TAUNT_COOLDOWN_MS) return reject("taunt_cooldown");
    player.lastTauntAtMs = this.nowMs;

    // Points only when someone is actually watching, which is what makes a
    // taunt a gamble rather than free score.
    if (this.isWatched(record.publicObjectId)) {
      player.stats.observedTaunts += 1;
    }

    this.emit({
      type: "taunt_performed",
      publicObjectId: record.publicObjectId,
      tauntId,
      seed: this.publicNonce(this.round, hashString(record.publicObjectId), this.tauntCounter),
    });
    this.tauntCounter += 1;
    return this.accept();
  }

  /** Whether an Inspector currently holds this object in a confirmed focus. */
  private isWatched(publicObjectId: string): boolean {
    return this.watchedLevelFor(publicObjectId) > 0;
  }

  /**
   * How hard this object is being looked at, taking the strongest reading if
   * more than one Inspector is on it. A resolved disguise is nobody's quarry
   * any more, so the indicator drops.
   */
  private watchedLevelFor(publicObjectId: string): WatchedLevel {
    if (!this.unresolvedDisguise(publicObjectId)) return 0;
    let level: WatchedLevel = 0;
    for (const [inspectorId, hold] of this.focusHolds) {
      if (hold.objectId !== publicObjectId) continue;
      const decision = this.spatial.canObserve(inspectorId, publicObjectId);
      if (!decision.ok) continue;
      const reading = decision.level ?? 2;
      if (reading > level) level = reading;
    }
    return level;
  }

  private watchedLevelOf(player: InternalPlayer): WatchedLevel {
    if (player.role !== "mimic" || player.lifeState !== "active") return 0;
    const record = player.disguise;
    return record ? this.watchedLevelFor(record.publicObjectId) : 0;
  }

  /**
   * Delivers the tension indicator to each hider whose reading changed, no
   * oftener than the throttle allows. Only the level travels: naming the
   * Inspector or the distance would turn a mood signal into a radar.
   */
  private deliverWatchedLevels(): void {
    for (const player of this.players.values()) {
      const level = this.watchedLevelOf(player);
      if (level === player.watchedLevel) continue;
      const last = player.watchedDeliveredAtMs;
      if (last !== null && this.nowMs - last < WATCHED_THROTTLE_MS) continue;

      player.watchedLevel = level;
      player.watchedDeliveredAtMs = this.nowMs;
      this.emitPrivate(player.playerId, { type: "watched", level });
    }
  }

  /** Lobby players have no role yet; a spectator is sitting out a live round. */
  private roleStateOf(player: InternalPlayer): PrivateRoleState {
    if (player.role !== "spectator") return player.role;
    const betweenRounds = this.phase === MatchPhase.Lobby || this.phase === MatchPhase.Loading;
    return betweenRounds ? "unassigned" : "spectator";
  }

  /**
   * Close-pass telemetry from the geometry owner (§6.4). Like accusation range
   * checks, proximity lives outside the pure simulation.
   */
  recordClosePass(inspectorPlayerId: string, publicObjectId: string, nowMs?: number): SimOutput {
    if (nowMs !== undefined) this.setNow(nowMs);
    const inspector = this.players.get(inspectorPlayerId);
    if (!inspector || inspector.role !== "inspector") return this.drain();
    if (!this.isInspectionPhase()) return this.drain();

    const record = this.unresolvedDisguise(publicObjectId);
    if (!record) return this.drain();

    const byObject = this.lastClosePassAt.get(inspectorPlayerId) ?? new Map<string, number>();
    const last = byObject.get(publicObjectId);
    if (last !== undefined && this.nowMs - last < CLOSE_PASS_COOLDOWN_MS) return this.drain();

    byObject.set(publicObjectId, this.nowMs);
    this.lastClosePassAt.set(inspectorPlayerId, byObject);

    const owner = this.presentDisguiseOwner(publicObjectId);
    if (owner) owner.stats.closePasses += 1;
    this.emit({
      type: "close_pass",
      publicObjectId,
      inspectorPublicId: inspector.publicPlayerId,
    });
    return this.drain();
  }

  // -------------------------------------------------------------------- views

  getPublicState(): PublicMatchState {
    const revealed = this.phase === MatchPhase.Reveal || this.isPostRoundPhase();
    return {
      now: this.nowMs,
      round: this.round,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      warrantsRemaining: this.warrantsRemaining,
      warrantsTotal: this.warrantsTotal,
      mimicsRemaining: this.countRemainingMimics(),
      settings: { ...this.settings },
      players: [...this.players.values()].map((player) => ({
        seatId: player.playerId,
        publicPlayerId: player.publicPlayerId,
        displayName: player.displayName,
        isHost: player.isHost,
        connected: player.connected,
        ready: player.ready,
        lifeState: player.lifeState,
        rolePublicState: this.publicRoleOf(player, revealed),
      })),
      disguises: [...this.disguises.values()].map((record) => ({
        publicObjectId: record.publicObjectId,
        encodedPose: record.encodedPose,
        encodedPaint: record.encodedPaint,
        defaultArrangementId: record.defaultArrangementId,
        revealed: revealed || this.resolvedObjects.get(record.publicObjectId) === "mimic",
      })),
      results: this.copyResults(this.results),
    };
  }

  getPrivateStateFor(playerId: string): PrivateMatchState | null {
    const player = this.players.get(playerId);
    if (!player) return null;

    const disguise = player.disguise;
    return {
      playerId: player.playerId,
      publicPlayerId: player.publicPlayerId,
      role: player.role,
      roleState: this.roleStateOf(player),
      lifeState: player.lifeState,
      isHost: player.isHost,
      ready: player.ready,
      ownDisguise: disguise
        ? {
            publicObjectId: disguise.publicObjectId,
            encodedPose: disguise.encodedPose,
            encodedPaint: disguise.encodedPaint,
            source: disguise.source,
            defaultArrangementId: disguise.defaultArrangementId,
          }
        : null,
      knownDisguiseOwners: this.entitledDisguiseOwners(player),
      warrantsRemaining: player.role === "inspector" ? this.warrantsRemaining : null,
      accusationReadyAt:
        player.role === "inspector" ? (this.accusationReadyAt.get(player.playerId) ?? 0) : null,
      tauntReadyAtMs:
        player.role === "mimic"
          ? (player.lastTauntAtMs === null ? 0 : player.lastTauntAtMs + TAUNT_COOLDOWN_MS)
          : null,
      watchedLevel: this.watchedLevelOf(player),
    };
  }

  getSettings(): MatchSettings {
    return { ...this.settings };
  }

  getPhase(): MatchPhase {
    return this.phase;
  }

  getObjectRegistry(): ObjectRegistry {
    return this.objectRegistry;
  }

  // ----------------------------------------------------------------- snapshot

  /**
   * Complete authoritative state, for handing the room to another host (§27.11).
   *
   * The result contains every Mimic's role and the disguise-to-player mapping.
   * It is host-to-host secret material: see the warning on MatchSnapshot before
   * putting it anywhere non-host players can read.
   */
  snapshot(options: SnapshotOptions = {}): MatchSnapshot {
    const omitPoses = options.poses === "omit";
    if (omitPoses) {
      // A working pose that was never locked is public nowhere, so there would
      // be nothing to rebuild it from.
      const unlocked = [...this.players.values()].filter(
        (player) => player.disguise === null && player.lastValidPose !== null,
      ).length;
      if (unlocked > 0) {
        throw new Error(
          `cannot omit poses while ${unlocked} unlocked pose(s) exist only here (phase ${this.phase})`,
        );
      }
    }
    return {
      v: MATCH_SNAPSHOT_VERSION,
      map: this.objectRegistry.mapId,
      po: omitPoses,
      s: { ...this.settings },
      sd: this.seed,
      rc: this.identityRng.cursor,
      sq: this.seq,
      nj: this.nextJoinIndex,
      t: this.nowMs,
      r: this.round,
      ph: this.phase,
      pe: this.phaseEndsAt,
      wr: this.warrantsRemaining,
      wt: this.warrantsTotal,
      is: this.inspectionStartedAtMs,
      ie: this.inspectionEndsAtMs,
      ix: this.inspectionEndedAtMs,
      lg: this.lockGraceFloorAt,
      ac: this.accusationCounter,
      op: [...this.objectIdPool],
      pl: [...this.players.values()].map((player) => ({
        i: player.playerId,
        p: player.publicPlayerId,
        n: player.displayName,
        h: player.isHost,
        c: player.connected,
        d: player.disconnectedAtMs,
        y: player.ready,
        r: player.role,
        l: player.lifeState,
        j: player.joinIndex,
        jr: player.joinedRound,
        li: player.lastInspectorRound,
        ir: player.inspectorRounds,
        o: player.disguise?.publicObjectId ?? null,
        // A locked player's recorded pose is a copy of the locked one, so an
        // omitted snapshot drops it and rebuilds it from the disguise.
        vp:
          player.lastValidPose === null || omitPoses
            ? null
            : ([player.lastValidPose.encodedPose, player.lastValidPose.revision] as const),
        ct: player.caughtAtMs,
        st: {
          e: player.stats.directLookEscapes,
          c: player.stats.closePasses,
          v: player.stats.peerStyleVotes,
          ca: player.stats.correctAccusations,
          wa: player.stats.wrongAccusations,
          f: [...player.stats.focusedObjectIds],
          los: player.stats.lineOfSightMs,
          ot: player.stats.observedTaunts,
        },
        tt: player.lastTauntAtMs,
        fu: player.lastForgeUpdateAtMs,
        wl: player.watchedLevel,
        wa: player.watchedDeliveredAtMs,
      })),
      dg: [...this.disguises.values()].map((record) => ({
        o: record.publicObjectId,
        ow: record.ownerPlayerId,
        op: record.ownerPublicPlayerId,
        on: record.ownerDisplayName,
        e: omitPoses ? EMPTY_POSE : record.encodedPose,
        rv: record.revision,
        s: record.source,
        a: record.defaultArrangementId,
        al: record.autoLocked,
        lk: record.lockedAtMs,
        ct: record.caughtAtMs,
        rp: [record.rootPosition[0], record.rootPosition[1], record.rootPosition[2]],
        mv: record.movedAtMs,
      })),
      ro: [...this.resolvedObjects.entries()].map(([id, kind]) => [id, kind] as const),
      ar: [...this.accusationReadyAt.entries()].map(([id, at]) => [id, at] as const),
      fh: [...this.focusHolds.entries()].map(
        ([playerId, hold]) => [playerId, hold.objectId, hold.sinceMs] as const,
      ),
      pes: this.pendingEscapes.map(
        (entry) => [entry.inspectorId, entry.objectId, entry.brokenAtMs] as const,
      ),
      le: flattenNested(this.lastEscapeAt),
      lc: flattenNested(this.lastClosePassAt),
      rv: flattenNested(this.resultVotes),
      rm: [...this.rematchVotes.entries()].map(([id, yes]) => [id, yes] as const),
      rs: this.copyResults(this.results),
      qp: [...this.publicQueue],
      qv: [...this.privateQueues.entries()].map(([id, queue]) => [id, [...queue]] as const),
    };
  }

  /**
   * Rebuilds a simulation from a snapshot. The restored instance continues the
   * same random stream and sequence numbering, so the same later commands and
   * ticks produce the same events they would have on the original host.
   *
   * The registry is a dependency rather than snapshot data, so the map is
   * checked rather than assumed: restoring a round onto a different map would
   * silently change which objects are accusable.
   *
   * The snapshot is validated before any of it is believed. Under Portals the
   * outgoing host hands this to another client, so it is untrusted input from a
   * peer no matter how it was produced.
   */
  static restore(snapshot: MatchSnapshot, deps: RestoreDeps = {}): MatchSimulation {
    if (snapshot.v !== MATCH_SNAPSHOT_VERSION) {
      throw new Error(
        `snapshot version ${snapshot.v} cannot be restored by version ${MATCH_SNAPSHOT_VERSION}`,
      );
    }
    const parsed = MatchSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? "" : issue.path.join(".");
      throw new Error(
        `snapshot is not valid state${where.length > 0 ? ` at ${where}` : ""}: ${issue?.message ?? "unknown"}`,
      );
    }
    const registry = deps.objectRegistry ?? DEFAULT_OBJECT_REGISTRY;
    if (registry.mapId !== snapshot.map) {
      throw new Error(
        `snapshot belongs to map "${snapshot.map}" but the registry describes "${registry.mapId}"`,
      );
    }

    const sim = new MatchSimulation({}, snapshot.sd, deps.spatial, registry);
    sim.settings = { ...snapshot.s };
    sim.identityRng = DeterministicRng.fromCursor(sim.identityRng.seed, snapshot.rc);
    sim.seq = snapshot.sq;
    sim.nextJoinIndex = snapshot.nj;
    sim.nowMs = snapshot.t;
    sim.round = snapshot.r;
    sim.phase = snapshot.ph;
    sim.phaseEndsAt = snapshot.pe;
    sim.warrantsRemaining = snapshot.wr;
    sim.warrantsTotal = snapshot.wt;
    sim.inspectionStartedAtMs = snapshot.is;
    sim.inspectionEndsAtMs = snapshot.ie;
    sim.inspectionEndedAtMs = snapshot.ix;
    sim.lockGraceFloorAt = snapshot.lg;
    sim.accusationCounter = snapshot.ac;
    sim.objectIdPool = [...snapshot.op];
    sim.results = snapshot.rs === null ? null : sim.copyResults(snapshot.rs);

    // Disguises come first: a player holds the same record object the map does,
    // so that catching one is visible through both paths.
    const poses = rehydratedPoses(snapshot, deps.poses);
    for (const entry of snapshot.dg) {
      sim.disguises.set(entry.o, restoreDisguise(entry, poses));
    }
    for (const entry of snapshot.pl) {
      sim.players.set(entry.i, restorePlayer(entry, sim.disguises, snapshot.po));
    }

    for (const [objectId, kind] of snapshot.ro) sim.resolvedObjects.set(objectId, kind);
    for (const [playerId, readyAt] of snapshot.ar) sim.accusationReadyAt.set(playerId, readyAt);
    for (const [playerId, objectId, sinceMs] of snapshot.fh) {
      sim.focusHolds.set(playerId, { objectId, sinceMs });
    }
    sim.pendingEscapes = snapshot.pes.map(([inspectorId, objectId, brokenAtMs]) => ({
      inspectorId,
      objectId,
      brokenAtMs,
    }));
    fillNested(sim.lastEscapeAt, snapshot.le);
    fillNested(sim.lastClosePassAt, snapshot.lc);
    fillNested(sim.resultVotes, snapshot.rv);
    for (const [playerId, yes] of snapshot.rm) sim.rematchVotes.set(playerId, yes);

    sim.publicQueue.push(...snapshot.qp);
    for (const [playerId, queue] of snapshot.qv) sim.privateQueues.set(playerId, [...queue]);

    // Whoever authored this has usually left by now. Reconciling here means the
    // caller never sees a room that believes in players who are not in it.
    if (deps.seatedPlayerIds) {
      const seated = new Set(deps.seatedPlayerIds);
      for (const entry of snapshot.pl) {
        if (!seated.has(entry.i)) sim.detachPlayer(entry.i, "left");
      }
      sim.advanceAll();
    }

    return sim;
  }

  /**
   * Ownership the viewer is entitled to know. Eliminated players may watch the
   * room from inside (§5.12); late joiners and lobby spectators learn nothing
   * until the reveal (§27.10).
   */
  private entitledDisguiseOwners(player: InternalPlayer): DisguiseOwnership[] {
    const revealed = this.phase === MatchPhase.Reveal || this.isPostRoundPhase();
    const seesEverything = revealed || player.lifeState === "caught";

    const owners: DisguiseOwnership[] = [];
    for (const record of this.disguises.values()) {
      const isTeammate = player.role === "mimic" && record.ownerPlayerId !== player.playerId;
      const isCaught = this.resolvedObjects.get(record.publicObjectId) === "mimic";
      if (!seesEverything && !isTeammate && !isCaught) continue;
      owners.push({
        publicObjectId: record.publicObjectId,
        publicPlayerId: record.ownerPublicPlayerId,
        displayName: record.ownerDisplayName,
        survivalSeconds: this.survivalSecondsAt(record.caughtAtMs),
      });
    }
    return owners;
  }

  // --------------------------------------------------------- command handlers

  private commandPlayerReady(player: InternalPlayer, ready: boolean): CommandResult {
    if (this.phase !== MatchPhase.Lobby && this.phase !== MatchPhase.Loading) {
      return reject("wrong_phase");
    }
    if (player.ready === ready) return this.accept();

    player.ready = ready;
    this.emit({ type: "player_ready_changed", publicPlayerId: player.publicPlayerId, ready });
    this.advanceAll();
    return this.accept();
  }

  private commandSetSettings(player: InternalPlayer, patch: MatchSettingsPatch): CommandResult {
    if (!player.isHost) return reject("not_host");
    if (this.phase !== MatchPhase.Lobby) return reject("wrong_phase");

    const changedKeys: SettableSettingKey[] = [];
    const next: MatchSettings = { ...this.settings };
    for (const key of SETTABLE_SETTING_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      const bound = SETTING_BOUNDS[key];
      if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
        return reject("invalid_settings", key);
      }
      if (next[key] === value) continue;
      next[key] = value;
      changedKeys.push(key);
    }
    if (next.maxPlayers < next.minPlayers) return reject("invalid_settings", "maxPlayers");
    // The room cannot be shrunk below the people already standing in it.
    if (next.maxPlayers < this.players.size) return reject("invalid_settings", "maxPlayers");
    if (changedKeys.length === 0) return this.accept();

    this.settings = next;
    this.emit({ type: "settings_changed", changedKeys });
    return this.accept();
  }

  private commandStartMatch(player: InternalPlayer): CommandResult {
    if (!player.isHost) return reject("not_host");
    if (this.phase !== MatchPhase.Lobby) return reject("wrong_phase");

    // Disconnected players neither block the start nor count toward the roster:
    // whoever is actually present decides whether a round can run.
    const roster = this.connectedPlayers();
    if (!this.canFieldARound(roster.length)) return reject("not_enough_players");
    if (roster.some((entry) => !entry.ready)) return reject("players_not_ready");

    this.enterPhase(MatchPhase.Loading);
    this.advanceAll();
    return this.accept();
  }

  private commandLockDisguise(
    player: InternalPlayer,
    encodedPose: string,
    revision: number,
  ): CommandResult {
    if (this.phase !== MatchPhase.Forge && this.phase !== MatchPhase.Locking) {
      return reject("wrong_phase");
    }
    if (player.role !== "mimic") return reject("wrong_role");
    if (player.lifeState !== "active") return reject("player_not_active");
    if (player.disguise) return reject("already_locked");
    if (this.isStaleRevision(player, revision)) return reject("stale_revision");

    const decoded = decodeDisguiseWire(encodedPose);
    if (!decoded.ok) return reject("invalid_pose", decoded.issue);

    this.lockPlayer(player, {
      encodedPose,
      revision,
      source: "player_lock",
      defaultArrangementId: null,
      autoLocked: false,
      rootPosition: decoded.pose.root.position as readonly [number, number, number],
    });
    this.advanceAll();
    return this.accept();
  }

  /**
   * Accusation resolution in the order §28.4 prescribes: phase and role, then
   * warrant, then target, then the geometry seam, and the rate limit last.
   */
  private commandAccuse(player: InternalPlayer, targetObjectId: string): CommandResult {
    if (!this.isInspectionPhase()) return reject("wrong_phase");
    if (player.role !== "inspector") return reject("wrong_role");
    if (this.warrantsRemaining <= 0) return reject("no_warrants");

    const record = this.disguises.get(targetObjectId);
    if (!record && !this.registeredObjects.has(targetObjectId)) return reject("target_unknown");
    if (this.resolvedObjects.has(targetObjectId)) return reject("target_already_resolved");

    const decision = this.spatial.canAccuse(player.playerId, targetObjectId);
    if (!decision.ok) return reject("spatial_rejected", decision.reason);

    const readyAt = this.accusationReadyAt.get(player.playerId) ?? 0;
    if (this.nowMs < readyAt) return reject("accusation_cooldown");

    this.accusationCounter += 1;
    if (record) {
      this.resolveCorrectAccusation(player, record);
    } else {
      this.resolveWrongAccusation(player, targetObjectId);
    }
    this.advanceAll();
    return this.accept();
  }

  private resolveCorrectAccusation(inspector: InternalPlayer, record: DisguiseRecord): void {
    const targetObjectId = record.publicObjectId;
    // Bank the watching that led to the catch before the object stops earning.
    for (const hold of this.focusHolds.values()) {
      if (hold.objectId !== targetObjectId) continue;
      this.creditLineOfSight(hold);
      hold.sinceMs = this.nowMs;
    }
    this.resolvedObjects.set(targetObjectId, "mimic");
    record.caughtAtMs = this.nowMs;

    // The owner may already have left the room; the catch is correct either way
    // and still names who was inside (§27.9).
    const owner = record.ownerPlayerId ? this.players.get(record.ownerPlayerId) : undefined;
    if (owner) {
      owner.lifeState = "caught";
      owner.caughtAtMs = this.nowMs;
    }
    inspector.stats.correctAccusations += 1;
    this.accusationReadyAt.set(inspector.playerId, this.nowMs + CORRECT_ACCUSATION_COOLDOWN_MS);
    this.pendingEscapes = this.pendingEscapes.filter((entry) => entry.objectId !== targetObjectId);

    this.emit({
      type: "accusation_resolved",
      inspectorPublicId: inspector.publicPlayerId,
      correct: true,
      targetObjectId,
      warrantsRemaining: this.warrantsRemaining,
      revealedPlayerPublicId: record.ownerPublicPlayerId,
    });
    this.emit({
      type: "mimic_caught",
      publicObjectId: targetObjectId,
      publicPlayerId: record.ownerPublicPlayerId,
      survivalSeconds: this.survivalSecondsAt(record.caughtAtMs),
      mimicsRemaining: this.countRemainingMimics(),
    });
    this.deliverDisguiseOwners();
  }

  private resolveWrongAccusation(inspector: InternalPlayer, targetObjectId: string): void {
    this.resolvedObjects.set(targetObjectId, "innocent");
    this.warrantsRemaining -= 1;
    inspector.stats.wrongAccusations += 1;
    this.accusationReadyAt.set(
      inspector.playerId,
      this.nowMs + this.settings.wrongAccusationCooldownMs,
    );

    const parts = [this.round, hashString(targetObjectId), this.accusationCounter];
    const reactions = reactionsFor(this.registeredObjects.get(targetObjectId));
    const reactionId = new DeterministicRng(mixSeeds(this.seedSalt, ...parts)).pick(reactions);

    this.emit({
      type: "accusation_resolved",
      inspectorPublicId: inspector.publicPlayerId,
      correct: false,
      targetObjectId,
      warrantsRemaining: this.warrantsRemaining,
      reactionId,
    });
    this.emit({
      type: "innocent_reaction",
      objectId: targetObjectId,
      reactionId,
      seed: this.publicNonce(...parts),
    });
  }

  private commandFocus(player: InternalPlayer, targetObjectId: string | null): CommandResult {
    if (!this.isInspectionPhase()) return reject("wrong_phase");
    if (player.role !== "inspector") return reject("wrong_role");

    if (targetObjectId !== null) {
      if (
        !this.disguises.has(targetObjectId) &&
        !this.registeredObjects.has(targetObjectId)
      ) {
        return reject("target_unknown");
      }
      const decision = this.spatial.canObserve(player.playerId, targetObjectId);
      if (!decision.ok) return reject("spatial_rejected", decision.reason);
    }

    const current = this.focusHolds.get(player.playerId);
    if (current && current.objectId !== targetObjectId) {
      this.releaseFocus(player, current);
    }
    if (targetObjectId === null) {
      this.focusHolds.delete(player.playerId);
    } else if (!current || current.objectId !== targetObjectId) {
      this.focusHolds.set(player.playerId, { objectId: targetObjectId, sinceMs: this.nowMs });
      // Only what can still earn points is retained, so the set cannot grow
      // past the §6.2 cap however many objects the Inspector sweeps.
      if (player.stats.focusedObjectIds.size < SCORE_INSPECTOR_MAX_FOCUSED_OBJECTS) {
        player.stats.focusedObjectIds.add(targetObjectId);
      }
    }
    // A hider should feel the reticle land without waiting for the next tick.
    this.deliverWatchedLevels();
    return this.accept();
  }

  private commandVoteResult(
    player: InternalPlayer,
    category: ResultVoteCategory,
    targetPublicObjectId: string,
  ): CommandResult {
    if (this.phase !== MatchPhase.Reveal && this.phase !== MatchPhase.Results) {
      return reject("wrong_phase");
    }
    // Only players who were in the round may judge it, which keeps spectators
    // and late joiners out of the style vote (§5.15, §27.10).
    if (player.role === "spectator") return reject("wrong_role");
    if (!RESULT_VOTE_CATEGORIES.includes(category)) return reject("invalid_settings", "category");

    const record = this.disguises.get(targetPublicObjectId);
    if (!record) return reject("target_unknown");
    if (record.ownerPlayerId === player.playerId) return reject("duplicate_vote", "self_vote");

    const votes = this.resultVotes.get(player.playerId) ?? new Map<ResultVoteCategory, string>();
    if (votes.has(category)) return reject("duplicate_vote");

    votes.set(category, targetPublicObjectId);
    this.resultVotes.set(player.playerId, votes);
    const owner = this.presentDisguiseOwner(targetPublicObjectId);
    if (owner) owner.stats.peerStyleVotes += 1;
    this.emit({
      type: "result_vote_cast",
      voterPublicId: player.publicPlayerId,
      category,
      targetPublicObjectId,
    });
    if (this.results) this.results = this.computeResults(this.results.winner);
    return this.accept();
  }

  private commandVoteRematch(player: InternalPlayer, yes: boolean): CommandResult {
    if (this.phase !== MatchPhase.Results && this.phase !== MatchPhase.RematchVote) {
      return reject("wrong_phase");
    }
    if (this.rematchVotes.has(player.playerId)) return reject("duplicate_vote");

    this.rematchVotes.set(player.playerId, yes);
    const voters = this.connectedPlayers().length;
    this.emit({
      type: "rematch_vote_cast",
      voterPublicId: player.publicPlayerId,
      yes,
      yesVotes: this.countRematchYes(),
      totalVoters: voters,
    });
    if (this.phase === MatchPhase.RematchVote && this.rematchVotes.size >= voters) {
      this.resolveRematch();
    }
    this.advanceAll();
    return this.accept();
  }

  // ------------------------------------------------------------ phase machine

  private advanceAll(): void {
    let transitions = 0;
    while (this.advanceOnce()) {
      transitions += 1;
      if (transitions > MAX_TRANSITIONS_PER_TICK) {
        throw new Error(`match simulation exceeded ${MAX_TRANSITIONS_PER_TICK} transitions in one step`);
      }
    }
  }

  private advanceOnce(): boolean {
    const expired = this.phaseEndsAt > 0 && this.nowMs >= this.phaseEndsAt;

    switch (this.phase) {
      case MatchPhase.Lobby:
      case MatchPhase.Disposed:
        return false;

      case MatchPhase.Loading:
        if (this.allPresentReady() || expired) {
          this.enterPhase(MatchPhase.MapIntro);
          return true;
        }
        return false;

      case MatchPhase.MapIntro:
        if (!expired) return false;
        this.enterPhase(MatchPhase.RoleReveal);
        return true;

      case MatchPhase.RoleReveal:
        if (!expired) return false;
        this.enterPhase(MatchPhase.BaselineScan);
        return true;

      case MatchPhase.BaselineScan:
        if (!expired) return false;
        this.enterPhase(MatchPhase.Forge);
        return true;

      case MatchPhase.Forge:
        if (this.countRemainingMimics() === 0) {
          this.enterPhase(MatchPhase.Reveal);
          return true;
        }
        if (!expired && !this.allMimicsLocked()) return false;
        this.enterPhase(MatchPhase.Locking);
        return true;

      case MatchPhase.Locking:
        // The grace window exists for Mimics who have not sent a lock yet, but
        // it never collapses to nothing: the shutters and pose blend of §5.8
        // need their moment even when every pose arrived early.
        if (!this.allMimicsLocked()) {
          if (!expired) return false;
          this.autoLockRemaining();
        }
        if (this.nowMs < this.lockGraceFloorAt) return false;
        this.enterPhase(MatchPhase.InspectionIntro);
        return true;

      case MatchPhase.InspectionIntro:
        if (!expired) return false;
        this.enterPhase(MatchPhase.Inspection);
        return true;

      case MatchPhase.Inspection:
      case MatchPhase.FinalCountdown: {
        // A blink of packet loss must not end the round: an Inspector still
        // inside their reconnect grace is still an Inspector (§27.9).
        if (this.countRemainingMimics() === 0 || this.inspectorsWithinGrace().length === 0 || expired) {
          this.enterPhase(MatchPhase.Reveal);
          return true;
        }
        if (
          this.phase === MatchPhase.Inspection &&
          this.nowMs >= this.inspectionEndsAtMs - finalCountdownMs(this.settings)
        ) {
          this.enterPhase(MatchPhase.FinalCountdown, this.inspectionEndsAtMs);
          return true;
        }
        return false;
      }

      case MatchPhase.Reveal:
        if (!expired) return false;
        this.enterPhase(MatchPhase.Results);
        return true;

      case MatchPhase.Results:
        if (!expired) return false;
        this.enterPhase(MatchPhase.RematchVote);
        return true;

      case MatchPhase.RematchVote:
        if (!expired) return false;
        this.resolveRematch();
        return true;
    }
  }

  private enterPhase(phase: MatchPhase, endsAtOverride?: number): void {
    const previousPhase = this.phase;
    this.phase = phase;
    if (endsAtOverride !== undefined) {
      this.phaseEndsAt = endsAtOverride;
    } else if (phase === MatchPhase.Loading) {
      this.phaseEndsAt = this.nowMs + LOADING_TIMEOUT_MS;
    } else {
      const duration = phaseDurationMs(phase, this.settings);
      this.phaseEndsAt = duration > 0 ? this.nowMs + duration : 0;
    }

    this.emit({
      type: "phase_changed",
      phase,
      previousPhase,
      phaseEndsAt: this.phaseEndsAt,
      round: this.round,
    });
    this.onEnterPhase(phase);
  }

  private onEnterPhase(phase: MatchPhase): void {
    switch (phase) {
      case MatchPhase.Loading:
        this.clearReadyFlags();
        return;
      case MatchPhase.RoleReveal:
        this.assignRoles();
        return;
      case MatchPhase.BaselineScan:
        this.emit({ type: "baseline_started", endsAt: this.phaseEndsAt });
        return;
      case MatchPhase.Forge:
        this.emit({ type: "forge_started", endsAt: this.phaseEndsAt });
        return;
      case MatchPhase.Locking:
        this.lockGraceFloorAt = this.nowMs + MIN_LOCK_GRACE_MS;
        return;
      case MatchPhase.InspectionIntro:
        this.deliverDisguiseOwners();
        return;
      case MatchPhase.Inspection:
        this.startInspection();
        return;
      case MatchPhase.Reveal:
        this.closeInspection();
        return;
      case MatchPhase.Results:
        this.publishResults();
        return;
      case MatchPhase.Lobby:
        this.resetForLobby();
        return;
      default:
        return;
    }
  }

  private assignRoles(): void {
    const rng = new DeterministicRng(mixSeeds(this.seed, this.round, 0x5203));
    const participants = this.presentPlayers();
    const histories: RoleHistory[] = participants.map((player) => ({
      playerId: player.playerId,
      lastInspectorRound: player.lastInspectorRound,
      inspectorRounds: player.inspectorRounds,
      joinedRound: player.joinedRound,
    }));
    const inspectorIds = new Set(assignInspectors(histories, rng));

    const inspectorPublicIds: string[] = [];
    const mimicPublicIds: string[] = [];
    for (const player of participants) {
      player.lifeState = "active";
      player.caughtAtMs = null;
      if (inspectorIds.has(player.playerId)) {
        player.role = "inspector";
        player.lastInspectorRound = this.round;
        player.inspectorRounds += 1;
        inspectorPublicIds.push(player.publicPlayerId);
      } else {
        player.role = "mimic";
        mimicPublicIds.push(player.publicPlayerId);
      }
    }

    // Object ids are random tokens drawn before any lock, so neither the token
    // itself nor its position in the pool can be traced back to a player.
    this.objectIdPool = mimicPublicIds.map(() => `obj_${rng.token(PUBLIC_ID_LENGTH)}`);

    this.emit({
      type: "roles_assigned",
      round: this.round,
      inspectorPublicIds,
      mimicCount: mimicPublicIds.length,
    });
    for (const player of participants) {
      const teammates = player.role === "inspector" ? inspectorPublicIds : mimicPublicIds;
      this.emitPrivate(player.playerId, {
        type: "role_assigned",
        round: this.round,
        role: player.role,
        publicPlayerId: player.publicPlayerId,
        teammatePublicIds: teammates.filter((publicId) => publicId !== player.publicPlayerId),
      });
    }
  }

  private lockPlayer(
    player: InternalPlayer,
    lock: {
      encodedPose: string;
      revision: number;
      source: DisguiseSource;
      defaultArrangementId: StarterArrangementId | null;
      autoLocked: boolean;
      rootPosition?: readonly [number, number, number];
    },
  ): void {
    const publicObjectId = this.objectIdPool.shift() ?? `obj_${this.identityRng.token(PUBLIC_ID_LENGTH)}`;
    const record: DisguiseRecord = {
      publicObjectId,
      ownerPlayerId: player.playerId,
      ownerPublicPlayerId: player.publicPlayerId,
      ownerDisplayName: player.displayName,
      encodedPose: lock.encodedPose,
      revision: lock.revision,
      source: lock.source,
      defaultArrangementId: lock.defaultArrangementId,
      encodedPaint: player.lastValidPaint?.encodedPaint ?? null,
      paintRevision: player.lastValidPaint?.revision ?? 0,
      autoLocked: lock.autoLocked,
      lockedAtMs: this.nowMs,
      caughtAtMs: null,
      rootPosition: lock.rootPosition ?? ORIGIN,
      movedAtMs: this.nowMs,
    };
    player.disguise = record;
    if (lock.source !== "default_arrangement") {
      player.lastValidPose = { encodedPose: lock.encodedPose, revision: lock.revision };
    }
    this.disguises.set(publicObjectId, record);

    this.emit({ type: "disguise_locked", publicObjectId });
    this.emitPrivate(player.playerId, {
      type: "own_disguise_locked",
      publicObjectId,
      autoLocked: lock.autoLocked,
      source: lock.source,
      defaultArrangementId: lock.defaultArrangementId,
    });
  }

  /**
   * Locks whoever never sent a pose. A recorded pose is always preferred; only
   * a Mimic who never produced one falls back to a starting arrangement, which
   * §5.8 requires instead of resetting them to a standing person.
   */
  private autoLockRemaining(): void {
    for (const player of this.players.values()) {
      if (player.role !== "mimic" || player.lifeState !== "active" || player.disguise) continue;
      const pose = player.lastValidPose;
      // The recovered pose was validated when it was recorded, so its root is
      // readable here and becomes the baseline the creep cap measures from.
      const recovered = pose ? decodeDisguiseWire(pose.encodedPose) : null;
      this.lockPlayer(
        player,
        pose
          ? {
              encodedPose: pose.encodedPose,
              revision: pose.revision,
              source: "recovered_pose",
              defaultArrangementId: null,
              autoLocked: true,
              rootPosition: recovered?.ok
                ? (recovered.pose.root.position as readonly [number, number, number])
                : ORIGIN,
            }
          : {
              encodedPose: EMPTY_POSE,
              revision: 0,
              source: "default_arrangement",
              defaultArrangementId: DEFAULT_ARRANGEMENT_ID,
              autoLocked: true,
            },
      );
    }
  }

  private startInspection(): void {
    this.inspectionStartedAtMs = this.nowMs;
    this.inspectionEndsAtMs = this.phaseEndsAt;
    this.inspectionEndedAtMs = 0;
    this.warrantsRemaining = this.countRemainingMimics() + this.settings.warrantsBonus;
    this.warrantsTotal = this.warrantsRemaining;
    this.emit({
      type: "inspection_started",
      endsAt: this.inspectionEndsAtMs,
      warrantsRemaining: this.warrantsRemaining,
      mimicsRemaining: this.countRemainingMimics(),
    });
  }

  private closeInspection(): void {
    this.inspectionEndedAtMs = this.nowMs;
    // Whoever was still being watched when the clock ran out is paid for it.
    for (const hold of this.focusHolds.values()) this.creditLineOfSight(hold);
    this.focusHolds.clear();
    this.pendingEscapes = [];
    for (const player of this.players.values()) {
      if (player.role === "mimic" && player.lifeState === "active") {
        player.lifeState = "spectating";
      }
    }
    this.deliverDisguiseOwners();
  }

  private publishResults(): void {
    this.results = this.computeResults(this.determineWinner());
    this.emit({ type: "match_ended", winner: this.results.winner, results: this.results });
  }

  private determineWinner(): MatchWinner {
    for (const player of this.players.values()) {
      if (player.role === "mimic" && player.caughtAtMs === null) return "mimics";
    }
    // A disguise whose owner left still has to be caught to win the round.
    for (const record of this.disguises.values()) {
      if (record.ownerPlayerId === null && record.caughtAtMs === null) return "mimics";
    }
    return "inspectors";
  }

  private computeResults(winner: MatchWinner): MatchResults {
    const inspectionEnd = this.inspectionEndedAtMs > 0 ? this.inspectionEndedAtMs : this.nowMs;
    const timeRemainingMs =
      winner === "inspectors" ? Math.max(0, this.inspectionEndsAtMs - inspectionEnd) : 0;
    const secondsRemaining = Math.floor(timeRemainingMs / 1000);

    const players: PlayerResult[] = [];
    for (const player of this.players.values()) {
      if (player.role === "spectator") continue;
      const survivalSeconds = this.survivalSecondsFor(player);
      const fullRoundSurvival = player.role === "mimic" && player.caughtAtMs === null;
      const score =
        player.role === "inspector"
          ? scoreInspector({
              correctAccusations: player.stats.correctAccusations,
              wrongAccusations: player.stats.wrongAccusations,
              secondsRemainingOnTeamWin: winner === "inspectors" ? secondsRemaining : 0,
              uniqueObjectsFocused: player.stats.focusedObjectIds.size,
            })
          : scoreMimic({
              survivalSeconds,
              directLookEscapes: player.stats.directLookEscapes,
              closePasses: player.stats.closePasses,
              fullRoundSurvival,
              peerStyleVotes: player.stats.peerStyleVotes,
              lineOfSightSeconds: lineOfSightSecondsOf(player),
              observedTaunts: player.stats.observedTaunts,
            });

      players.push({
        publicPlayerId: player.publicPlayerId,
        displayName: player.displayName,
        role: player.role,
        score,
        survivalSeconds,
        fullRoundSurvival,
        directLookEscapes: player.stats.directLookEscapes,
        closePasses: player.stats.closePasses,
        peerStyleVotes: player.stats.peerStyleVotes,
        correctAccusations: player.stats.correctAccusations,
        wrongAccusations: player.stats.wrongAccusations,
        uniqueObjectsFocused: player.stats.focusedObjectIds.size,
        publicObjectId: player.disguise?.publicObjectId ?? null,
        lineOfSightSeconds: lineOfSightSecondsOf(player),
        observedTaunts: player.stats.observedTaunts,
      });
    }

    return {
      round: this.round,
      winner,
      inspectionDurationMs: Math.max(0, inspectionEnd - this.inspectionStartedAtMs),
      timeRemainingMs,
      players,
    };
  }

  private resolveRematch(): void {
    const voters = this.connectedPlayers().length;
    const yesVotes = this.countRematchYes();
    // A rematch has to be able to field a round; otherwise the room goes back to
    // the lobby and waits for people, however the vote went.
    if (this.canFieldARound(voters) && yesVotes * 2 > voters) {
      this.round += 1;
      this.resetForNewRound();
      this.emit({ type: "rematch_started", round: this.round });
      this.enterPhase(MatchPhase.RoleReveal);
      return;
    }
    this.enterPhase(MatchPhase.Lobby);
  }

  private resetForNewRound(): void {
    this.disguises.clear();
    this.resolvedObjects.clear();
    this.resultVotes.clear();
    this.rematchVotes.clear();
    this.accusationReadyAt.clear();
    this.focusHolds.clear();
    this.lastEscapeAt.clear();
    this.lastClosePassAt.clear();
    this.pendingEscapes = [];
    this.objectIdPool = [];
    this.accusationCounter = 0;
    this.warrantsRemaining = 0;
    this.warrantsTotal = 0;
    this.inspectionStartedAtMs = 0;
    this.inspectionEndsAtMs = 0;
    this.inspectionEndedAtMs = 0;
    this.lockGraceFloorAt = 0;
    this.results = null;
    for (const player of this.players.values()) {
      player.disguise = null;
      player.lastValidPose = null;
      player.lastValidPaint = null;
      player.caughtAtMs = null;
      player.stats = createStats();
      player.lifeState = "active";
    }
  }

  private resetForLobby(): void {
    this.resetForNewRound();
    for (const player of this.players.values()) {
      player.role = "spectator";
    }
    this.clearReadyFlags();
  }

  // -------------------------------------------------------------- focus/gaze

  private releaseFocus(
    inspector: InternalPlayer,
    hold: { objectId: string; sinceMs: number },
  ): void {
    this.creditLineOfSight(hold);
    if (this.nowMs - hold.sinceMs < this.settings.directLookMinMs) return;
    if (!this.unresolvedDisguise(hold.objectId)) return;
    this.pendingEscapes.push({
      inspectorId: inspector.playerId,
      objectId: hold.objectId,
      brokenAtMs: this.nowMs,
    });
  }

  /**
   * Time under an Inspector's eye, which is what §6.2 pays a hider for. Held
   * time is banked when the hold ends rather than sampled per tick, so it does
   * not depend on how often the caller ticks. Only an unresolved disguise
   * earns: once caught, being stared at is no achievement.
   */
  /**
   * Drops an Inspector's focus, banking what the hider earned first. An
   * Inspector who walks out mid-stare does not erase the time they spent
   * staring.
   */
  private endFocusHold(inspectorId: string): void {
    const hold = this.focusHolds.get(inspectorId);
    if (!hold) return;
    this.creditLineOfSight(hold);
    this.focusHolds.delete(inspectorId);
  }

  private creditLineOfSight(hold: { objectId: string; sinceMs: number }): void {
    const held = this.nowMs - hold.sinceMs;
    if (held <= 0) return;
    if (!this.unresolvedDisguise(hold.objectId)) return;
    const owner = this.presentDisguiseOwner(hold.objectId);
    if (owner) owner.stats.lineOfSightMs += held;
  }

  /**
   * A direct-look escape completes once the Inspector has stayed off the object
   * for the break window without accusing it (§6.3).
   */
  private resolvePendingEscapes(): void {
    if (this.pendingEscapes.length === 0) return;
    const remaining: typeof this.pendingEscapes = [];
    for (const pending of this.pendingEscapes) {
      if (this.nowMs - pending.brokenAtMs < this.settings.directLookBreakMs) {
        remaining.push(pending);
        continue;
      }
      if (!this.unresolvedDisguise(pending.objectId)) continue;
      const inspector = this.players.get(pending.inspectorId);
      if (!inspector) continue;
      if (!this.spatial.canObserve(pending.inspectorId, pending.objectId).ok) continue;

      const byObject = this.lastEscapeAt.get(pending.inspectorId) ?? new Map<string, number>();
      const last = byObject.get(pending.objectId);
      const rateLimitMs = this.settings.directLookMinMs + this.settings.directLookBreakMs;
      if (last !== undefined && this.nowMs - last < rateLimitMs) continue;

      byObject.set(pending.objectId, this.nowMs);
      this.lastEscapeAt.set(pending.inspectorId, byObject);

      const owner = this.presentDisguiseOwner(pending.objectId);
      if (owner) owner.stats.directLookEscapes += 1;
      this.emit({
        type: "direct_look_escape",
        publicObjectId: pending.objectId,
        inspectorPublicId: inspector.publicPlayerId,
      });
    }
    this.pendingEscapes = remaining;
  }

  // ------------------------------------------------------------------ helpers

  private setNow(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new Error(`tick time must be finite, received ${String(nowMs)}`);
    }
    // Clocks may stall but never run backwards inside the simulation.
    this.nowMs = Math.max(this.nowMs, nowMs);
  }

  private emit(event: SimEventDraft): void {
    this.seq += 1;
    this.publicQueue.push({ ...event, seq: this.seq, at: this.nowMs });
  }

  private emitPrivate(playerId: string, event: PrivateSimEventDraft): void {
    this.seq += 1;
    const queue = this.privateQueues.get(playerId);
    const stamped = { ...event, seq: this.seq, at: this.nowMs };
    if (queue) {
      queue.push(stamped);
    } else {
      this.privateQueues.set(playerId, [stamped]);
    }
  }

  /** Sends every player the ownership mapping they are currently entitled to. */
  private deliverDisguiseOwners(): void {
    for (const player of this.players.values()) {
      const owners = this.entitledDisguiseOwners(player);
      if (owners.length === 0) continue;
      this.emitPrivate(player.playerId, { type: "disguise_owners", owners });
    }
  }

  private drain(): SimOutput {
    const publicEvents = this.publicQueue.splice(0, this.publicQueue.length);
    if (this.privateQueues.size === 0) {
      return { public: publicEvents, private: NO_PRIVATE_EVENTS };
    }
    const privateEvents = new Map<string, readonly PrivateSimEvent[]>(this.privateQueues);
    this.privateQueues.clear();
    return { public: publicEvents, private: privateEvents };
  }

  private accept(): CommandResult {
    return { accepted: true, ...this.drain() };
  }

  /**
   * A public nonce for a room event, replacing the derived master seed that
   * used to be published directly. It is salted and truncated, so the value a
   * client receives is not the seed and does not name it by inspection;
   * recovering the seed would take an offline search of the whole 32-bit seed
   * space. The same room and the same event still produce the same value, which
   * is all the presentation layer needs from it.
   */
  private publicNonce(...parts: number[]): number {
    return mixSeeds(this.seedSalt, ...parts) >>> 8;
  }

  private presentPlayers(): InternalPlayer[] {
    return [...this.players.values()];
  }

  private connectedPlayers(): InternalPlayer[] {
    return this.presentPlayers().filter((player) => player.connected);
  }

  /** Whether a roster of this size can start a round at all (§5.5, §28.3). */
  private canFieldARound(rosterSize: number): boolean {
    return rosterSize >= this.settings.minPlayers && inspectorCountForRoster(rosterSize) > 0;
  }

  private allPresentReady(): boolean {
    const present = this.connectedPlayers();
    return present.length > 0 && present.every((player) => player.ready);
  }

  private clearReadyFlags(): void {
    for (const player of this.players.values()) {
      if (!player.ready) continue;
      player.ready = false;
      this.emit({ type: "player_ready_changed", publicPlayerId: player.publicPlayerId, ready: false });
    }
  }

  private hasHost(): boolean {
    return this.presentPlayers().some((player) => player.isHost);
  }

  private promoteHost(): void {
    const next = this.presentPlayers().sort(
      (a, b) => a.joinIndex - b.joinIndex || (a.playerId < b.playerId ? -1 : 1),
    )[0];
    if (!next || next.isHost) return;
    next.isHost = true;
    this.emit({ type: "host_changed", publicPlayerId: next.publicPlayerId });
  }

  private isWithinReconnectGrace(player: InternalPlayer): boolean {
    if (player.connected || player.disconnectedAtMs === null) return true;
    return this.nowMs - player.disconnectedAtMs < this.settings.reconnectGraceMs;
  }

  private expireDisconnectedPlayers(): void {
    for (const player of this.presentPlayers()) {
      if (player.connected || player.disconnectedAtMs === null) continue;
      if (this.isWithinReconnectGrace(player)) continue;
      this.detachPlayer(player.playerId, "reconnect_timeout");
    }
  }

  private countRemainingMimics(): number {
    let count = 0;
    for (const player of this.players.values()) {
      if (player.role === "mimic" && player.lifeState === "active") count += 1;
    }
    // A disguise left behind by a departed player is still standing there and
    // still has to be found (§27.9).
    for (const record of this.disguises.values()) {
      if (record.ownerPlayerId === null && record.caughtAtMs === null) count += 1;
    }
    return count;
  }

  private allMimicsLocked(): boolean {
    for (const player of this.players.values()) {
      if (player.role === "mimic" && player.lifeState === "active" && !player.disguise) return false;
    }
    return true;
  }

  /** Inspectors who are connected, or disconnected but still inside their grace. */
  private inspectorsWithinGrace(): InternalPlayer[] {
    return this.presentPlayers().filter(
      (player) => player.role === "inspector" && this.isWithinReconnectGrace(player),
    );
  }

  private unresolvedDisguise(publicObjectId: string): DisguiseRecord | null {
    const record = this.disguises.get(publicObjectId);
    if (!record || record.caughtAtMs !== null) return null;
    return record;
  }

  /** The player behind a disguise, when they are still in the room. */
  private presentDisguiseOwner(publicObjectId: string): InternalPlayer | null {
    const ownerId = this.disguises.get(publicObjectId)?.ownerPlayerId;
    if (!ownerId) return null;
    return this.players.get(ownerId) ?? null;
  }

  private isStaleRevision(player: InternalPlayer, revision: number): boolean {
    return player.lastValidPose !== null && revision < player.lastValidPose.revision;
  }

  private survivalSecondsAt(caughtAtMs: number | null): number {
    if (this.inspectionStartedAtMs === 0) return 0;
    const end =
      caughtAtMs ?? (this.inspectionEndedAtMs > 0 ? this.inspectionEndedAtMs : this.nowMs);
    return Math.max(0, Math.floor((end - this.inspectionStartedAtMs) / 1000));
  }

  private survivalSecondsFor(player: InternalPlayer): number {
    if (player.role !== "mimic") return 0;
    return this.survivalSecondsAt(player.caughtAtMs);
  }

  private copyResults(results: MatchResults | null): MatchResults | null {
    if (!results) return null;
    return { ...results, players: results.players.map((entry) => ({ ...entry })) };
  }

  private countRematchYes(): number {
    let yes = 0;
    for (const vote of this.rematchVotes.values()) {
      if (vote) yes += 1;
    }
    return yes;
  }

  private isInspectionPhase(): boolean {
    return this.phase === MatchPhase.Inspection || this.phase === MatchPhase.FinalCountdown;
  }

  private isForgePhase(): boolean {
    return this.phase === MatchPhase.Forge || this.phase === MatchPhase.Locking;
  }

  /**
   * When a manifested disguise may still be adjusted. Locking is excluded on
   * purpose: that phase is the moment everything settles (§5.8), and the reveal
   * and results are over.
   */
  private isPostLockEditPhase(): boolean {
    return this.phase === MatchPhase.InspectionIntro || this.isInspectionPhase();
  }

  private isPostRoundPhase(): boolean {
    return (
      this.phase === MatchPhase.Results ||
      this.phase === MatchPhase.RematchVote ||
      this.phase === MatchPhase.Reveal
    );
  }

  private publicRoleOf(
    player: InternalPlayer,
    revealed: boolean,
  ): PublicPlayerView["rolePublicState"] {
    if (player.role === "inspector") return "inspector";
    if (player.role === "spectator") return "spectator";
    if (revealed || player.lifeState === "caught") return "mimic";
    return "unknown";
  }
}
