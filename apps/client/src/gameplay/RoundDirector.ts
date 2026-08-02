import {
  phaseDurationMs,
  SCORE_MIMIC_PER_CLOSE_PASS,
  SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE,
  type DisguiseOwnership,
  type InnocentReactionId,
  type MissedFindsEntry,
  type PrivateSimEvent,
  type ResultVoteCategory,
  type SimEvent,
  type WatchedLevel,
} from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, MatchPhase, type PlayerRole } from "@foldseek/shared";

import {
  type CommandRejection,
  type ConnectionState,
  type MatchSync,
  type NetworkAdapter,
  type RosterEntry,
  type Unsubscribe,
} from "../networking/NetworkAdapter";
import { isBotSeat } from "../networking/botSeats";
import { Signal } from "../networking/signal";
import { computeAvailability } from "./actionAvailability";
import { correctAccusationStamp, phaseLabel, wrongAccusationStamp } from "./copy";
import type {
  AccusationFeedEntry,
  DeceptionEventView,
  DeceptionView,
  MissedFindsRowView,
  MissedFindsView,
  RejectionView,
  ResultRowView,
  RevealEntryView,
  RevealView,
  RoundViewState,
  RosterPlayerView,
  SelfView,
  VoteCandidateView,
} from "./roundView";

/**
 * Folds everything a NetworkAdapter reports into the single RoundViewState the
 * HUD and the engine read (§12.3). It holds no React and no Three.js: React
 * subscribes through useSyncExternalStore, the engine polls getState(), and the
 * same director serves both.
 *
 * Phase deadlines arrive in the authority's clock, which is not this machine's
 * clock on any transport but the loopback, so the director keeps a running
 * estimate of the difference and reports the countdown already corrected.
 */

const DEFAULT_ACCUSATION_FEED_LIMIT = 6;
const DEFAULT_REJECTION_FEED_LIMIT = 4;
const DEFAULT_DECEPTION_FEED_LIMIT = 4;
const DEFAULT_TICK_INTERVAL_MS = 200;

/** What each deception term is worth, taken from the simulation's own weights. */
const DECEPTION_POINTS: Readonly<Record<DeceptionEventView["kind"], number>> = {
  direct_look_escape: SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE,
  close_pass: SCORE_MIMIC_PER_CLOSE_PASS,
};

const EMPTY_DECEPTION: DeceptionView = {
  recent: [],
  directLookEscapes: 0,
  closePasses: 0,
  points: 0,
};

/**
 * How fast the clock estimate follows a sample below it. Every sample
 * understates the offset by exactly its own transport latency, so the largest
 * sample seen is the best estimate and is adopted at once; a smaller one moves
 * the estimate only slowly, which tracks genuine drift without letting one
 * slow packet drag the countdown.
 */
const CLOCK_DRIFT_RATE = 0.02;

export interface RoundDirectorOptions {
  /** This machine's clock. Defaults to performance.now(). */
  readonly now?: () => number;
  /** Countdown refresh, in milliseconds. Zero drives the timer from tick() only. */
  readonly tickIntervalMs?: number;
  readonly accusationFeedLimit?: number;
  readonly rejectionFeedLimit?: number;
  readonly deceptionFeedLimit?: number;
}

/** One accusation as it happened, projected into a feed entry on publish. */
interface AccusationRecord {
  readonly id: number;
  readonly atServerMs: number;
  readonly inspectorPublicId: string;
  readonly targetObjectId: string;
  readonly correct: boolean;
  readonly stampIndex: number;
  readonly revealedPlayerPublicId: string | null;
  readonly warrantsRemaining: number;
  reactionId: InnocentReactionId | null;
}

interface CaughtRecord {
  readonly publicPlayerId: string;
  readonly survivalSeconds: number;
}

const EMPTY_VOTES: Readonly<Record<ResultVoteCategory, string | null>> = {
  best_disguise: null,
  funniest_attempt: null,
  most_audacious: null,
};

/**
 * Reasons an authority that understands `taunt` can refuse one. Anything else
 * coming back for a taunt means the room is running a build without the
 * command, so the client stops offering it rather than asking again.
 *
 * Transport-level refusals belong here too. A room that rate-limits or rejects
 * an oversized message understood the command perfectly well; treating either
 * as "this build has no taunt" would hide the button for the rest of the match
 * over one busy second.
 */
const KNOWN_TAUNT_REFUSALS: ReadonlySet<string> = new Set([
  "wrong_phase",
  "wrong_role",
  "player_not_active",
  "taunt_cooldown",
  "unknown_player",
  "player_disconnected",
  "rate_limited",
  "payload_too_large",
]);

export class RoundDirector {
  private readonly adapter: NetworkAdapter;
  private readonly localNow: () => number;
  private readonly accusationFeedLimit: number;
  private readonly rejectionFeedLimit: number;
  private readonly deceptionFeedLimit: number;
  private readonly subscriptions: Unsubscribe[] = [];
  private readonly changed = new Signal<RoundViewState>();

  private connection: ConnectionState;
  private transportRoster: readonly RosterEntry[];
  private sync: MatchSync;

  private assignedRole: PlayerRole | null = null;
  private assignedRound = 0;
  private ownDisguiseAutoLocked = false;
  private readonly owners = new Map<string, DisguiseOwnership>();

  private previousPhase: MatchPhase | null = null;
  private phaseStartedAtServerMs: number | null = null;
  /**
   * What the newest phase_changed said, held until a sync repeats it. Several
   * transitions can resolve inside one tick, and the sync that follows shows
   * only the last of them, so without this a phase that opened and closed
   * within a tick would never reach the HUD at all.
   *
   * This assumes an adapter publishes a sync no older than the events it has
   * already delivered, which is how every adapter in this client is built:
   * apply the batch, then publish the state.
   */
  private phaseOverride: { phase: MatchPhase; endsAt: number; round: number } | null = null;

  private accusationRecords: AccusationRecord[] = [];
  private catchCount = 0;
  private readonly caughtByObject = new Map<string, CaughtRecord>();

  /**
   * The last missed-finds board. Null until the first one arrives, which is not
   * the same as an empty board: nothing in the match state carries the ranking,
   * so a mid-round joiner genuinely has nothing to show until the next report.
   */
  private missedFinds: {
    entries: readonly MissedFindsEntry[];
    nextUpdateAtServerMs: number;
    final: boolean;
  } | null = null;

  /** Deception events for this player's own disguise. Never anybody else's. */
  private deceptionEvents: DeceptionEventView[] = [];
  private directLookEscapes = 0;
  private closePasses = 0;

  private myVotes: Record<ResultVoteCategory, string | null> = { ...EMPTY_VOTES };
  private rematchYesVotes = 0;
  private rematchTotalVoters = 0;
  private myRematchVote: boolean | null = null;

  private rejections: RejectionView[] = [];
  private rejectionCounter = 0;
  private tauntSupported = true;
  /**
   * Latest tension level for this hider. The private `watched` event leads the
   * sync, so it is held here and the sync only corrects it.
   */
  private watchedLevel: WatchedLevel = 0;

  private clockOffsetMs = 0;
  private hasClockSample = false;

  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private state: RoundViewState;
  private publishedSecondsRemaining = -1;
  private disposed = false;

  constructor(adapter: NetworkAdapter, options: RoundDirectorOptions = {}) {
    this.adapter = adapter;
    this.localNow = options.now ?? (() => performance.now());
    this.accusationFeedLimit = options.accusationFeedLimit ?? DEFAULT_ACCUSATION_FEED_LIMIT;
    this.rejectionFeedLimit = options.rejectionFeedLimit ?? DEFAULT_REJECTION_FEED_LIMIT;
    this.deceptionFeedLimit = options.deceptionFeedLimit ?? DEFAULT_DECEPTION_FEED_LIMIT;

    this.connection = adapter.getConnection();
    this.transportRoster = adapter.getRoster();
    this.sync = adapter.getSync();
    this.absorbSync(this.sync);

    this.subscriptions.push(
      adapter.onEvent((event) => {
        this.applyEvent(event);
      }),
      adapter.onPrivateEvent((event) => {
        this.applyPrivateEvent(event);
      }),
      adapter.onRejection((rejection) => {
        this.applyRejection(rejection);
      }),
      adapter.onRoster((roster) => {
        this.transportRoster = roster;
        this.publish();
      }),
      adapter.onStatus((connection) => {
        this.connection = connection;
        this.publish();
      }),
      adapter.onSync((sync) => {
        this.sync = sync;
        this.absorbSync(sync);
        this.publish();
      }),
    );

    this.state = this.build();
    this.publishedSecondsRemaining = this.state.timer.secondsRemaining;

    const interval = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    if (interval > 0) {
      this.timerHandle = setInterval(() => {
        this.tick();
      }, interval);
    }
  }

  getState(): RoundViewState {
    return this.state;
  }

  subscribe(listener: (state: RoundViewState) => void): Unsubscribe {
    return this.changed.subscribe(listener);
  }

  /**
   * Recomputes the countdown. The internal interval calls this; a render loop
   * or a test may call it too. It publishes only when the printed second moved,
   * so subscribers do not re-render at the tick rate.
   */
  tick(): void {
    if (this.disposed) return;
    const next = this.build();
    if (
      next.timer.secondsRemaining === this.publishedSecondsRemaining &&
      next.timer.running === this.state.timer.running &&
      next.timer.finalTen === this.state.timer.finalTen
    ) {
      return;
    }
    this.commit(next);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
    this.changed.clear();
  }

  // --------------------------------------------------------------- ingestion

  private applyEvent(event: SimEvent): void {
    this.sampleClock(event.at);
    switch (event.type) {
      case "phase_changed":
        this.previousPhase = event.previousPhase;
        this.phaseStartedAtServerMs = event.at;
        this.phaseOverride = {
          phase: event.phase,
          endsAt: event.phaseEndsAt,
          round: event.round,
        };
        if (event.phase === MatchPhase.Lobby) this.resetRound();
        break;

      case "rematch_started":
        this.resetRound();
        break;

      case "accusation_resolved": {
        const record: AccusationRecord = {
          id: event.seq,
          atServerMs: event.at,
          inspectorPublicId: event.inspectorPublicId,
          targetObjectId: event.targetObjectId,
          correct: event.correct,
          stampIndex: event.correct ? this.catchCount : 0,
          revealedPlayerPublicId: event.revealedPlayerPublicId ?? null,
          warrantsRemaining: event.warrantsRemaining,
          // Carried on the resolution itself, so the §41.4 stamp is settled the
          // moment the shot resolves. The separate innocent_reaction still
          // arrives for the world, and is the fallback below.
          reactionId: event.reactionId ?? null,
        };
        if (event.correct) this.catchCount += 1;
        this.accusationRecords = [record, ...this.accusationRecords].slice(
          0,
          this.accusationFeedLimit,
        );
        break;
      }

      case "innocent_reaction": {
        // Only matters when the resolution did not carry the reaction itself,
        // which is how an older authority behaves.
        const pending = this.accusationRecords.find(
          (record) =>
            !record.correct && record.targetObjectId === event.objectId && record.reactionId === null,
        );
        if (pending) pending.reactionId = event.reactionId;
        break;
      }

      case "direct_look_escape":
      case "close_pass":
        this.recordDeception(event.type, event.publicObjectId, event.seq, event.at);
        break;

      case "missed_finds_update":
        this.missedFinds = {
          entries: event.entries,
          nextUpdateAtServerMs: event.nextUpdateAtMs,
          final: event.final,
        };
        break;

      case "mimic_caught":
        this.caughtByObject.set(event.publicObjectId, {
          publicPlayerId: event.publicPlayerId,
          survivalSeconds: event.survivalSeconds,
        });
        break;

      case "result_vote_cast":
        if (event.voterPublicId === this.selfPublicId()) {
          this.myVotes = { ...this.myVotes, [event.category]: event.targetPublicObjectId };
        }
        break;

      case "rematch_vote_cast":
        this.rematchYesVotes = event.yesVotes;
        this.rematchTotalVoters = event.totalVoters;
        if (event.voterPublicId === this.selfPublicId()) this.myRematchVote = event.yes;
        break;

      default:
        break;
    }
    this.publish();
  }

  private applyPrivateEvent(event: PrivateSimEvent): void {
    this.sampleClock(event.at);
    switch (event.type) {
      case "role_assigned":
        // A new round's assignment is the reliable signal that the previous
        // round's feed is over, on every transport including a mid-round rejoin.
        if (event.round !== this.assignedRound) this.resetRound();
        this.assignedRole = event.role;
        this.assignedRound = event.round;
        break;

      case "own_disguise_locked":
        this.ownDisguiseAutoLocked = event.autoLocked;
        break;

      case "disguise_owners":
        for (const owner of event.owners) this.owners.set(owner.publicObjectId, owner);
        break;

      case "watched":
        this.watchedLevel = event.level;
        break;
    }
    this.publish();
  }

  /**
   * Banks one deception event, if it belongs to this player.
   *
   * Both events are broadcast and name a public object rather than a player,
   * and the only client that can turn that object into a name is the one
   * wearing it. Telling an Inspector that the vase they just walked past was a
   * person would hand them what the whole round is spent guessing, so an event
   * for anything but the viewer's own disguise is dropped here rather than
   * filtered further up.
   */
  private recordDeception(
    kind: DeceptionEventView["kind"],
    publicObjectId: string,
    seq: number,
    atServerMs: number,
  ): void {
    const own = this.sync.privateState?.ownDisguise ?? null;
    if (own === null || own.publicObjectId !== publicObjectId) return;

    if (kind === "direct_look_escape") {
      this.directLookEscapes += 1;
    } else {
      this.closePasses += 1;
    }
    const entry: DeceptionEventView = {
      id: seq,
      atServerMs,
      kind,
      points: DECEPTION_POINTS[kind],
    };
    this.deceptionEvents = [entry, ...this.deceptionEvents].slice(0, this.deceptionFeedLimit);
  }

  private applyRejection(rejection: CommandRejection): void {
    if (rejection.type === "taunt" && !KNOWN_TAUNT_REFUSALS.has(rejection.reason)) {
      this.tauntSupported = false;
    }
    this.rejectionCounter += 1;
    const view: RejectionView = {
      id: this.rejectionCounter,
      commandType: rejection.type,
      reason: rejection.reason,
      detail: rejection.detail ?? null,
    };
    this.rejections = [view, ...this.rejections].slice(0, this.rejectionFeedLimit);
    this.publish();
  }

  private absorbSync(sync: MatchSync): void {
    if (sync.publicState) {
      this.sampleClock(sync.publicState.now);
      this.phaseOverride = null;
    }
    if (sync.privateState) {
      this.watchedLevel = sync.privateState.watchedLevel;
    }
    for (const owner of sync.privateState?.knownDisguiseOwners ?? []) {
      this.owners.set(owner.publicObjectId, owner);
    }
  }

  /**
   * A timestamp minted by the authority understates the offset by its own
   * transit time, so the estimate rises to the best sample immediately and
   * falls only gradually.
   */
  private sampleClock(serverMs: number): void {
    const sample = serverMs - this.localNow();
    if (!this.hasClockSample) {
      this.clockOffsetMs = sample;
      this.hasClockSample = true;
      return;
    }
    if (sample > this.clockOffsetMs) {
      this.clockOffsetMs = sample;
      return;
    }
    this.clockOffsetMs += (sample - this.clockOffsetMs) * CLOCK_DRIFT_RATE;
  }

  private resetRound(): void {
    this.accusationRecords = [];
    this.catchCount = 0;
    this.caughtByObject.clear();
    this.missedFinds = null;
    this.deceptionEvents = [];
    this.directLookEscapes = 0;
    this.closePasses = 0;
    this.owners.clear();
    this.myVotes = { ...EMPTY_VOTES };
    this.rematchYesVotes = 0;
    this.rematchTotalVoters = 0;
    this.myRematchVote = null;
    this.ownDisguiseAutoLocked = false;
    this.assignedRole = null;
    this.watchedLevel = 0;
  }

  // ------------------------------------------------------------- projection

  private publish(): void {
    if (this.disposed) return;
    this.commit(this.build());
  }

  private commit(next: RoundViewState): void {
    this.state = next;
    this.publishedSecondsRemaining = next.timer.secondsRemaining;
    this.changed.emit(next);
  }

  private selfPublicId(): string | null {
    return this.sync.privateState?.publicPlayerId ?? null;
  }

  private build(): RoundViewState {
    const publicState = this.sync.publicState;
    const settings = publicState?.settings ?? DEFAULT_MATCH_SETTINGS;
    const phase = this.phaseOverride?.phase ?? publicState?.phase ?? MatchPhase.Lobby;
    const serverNowMs = this.localNow() + this.clockOffsetMs;

    const endsAtServerMs = this.phaseOverride?.endsAt ?? publicState?.phaseEndsAt ?? 0;
    const remainingMs = endsAtServerMs > 0 ? Math.max(0, endsAtServerMs - serverNowMs) : 0;
    const observedTotal =
      this.phaseStartedAtServerMs !== null && endsAtServerMs > 0
        ? Math.max(0, endsAtServerMs - this.phaseStartedAtServerMs)
        : 0;
    const timer = {
      endsAtServerMs,
      remainingMs,
      secondsRemaining: Math.ceil(remainingMs / 1_000),
      totalMs: observedTotal > 0 ? observedTotal : phaseDurationMs(phase, settings),
      running: endsAtServerMs > 0,
      finalTen: phase === MatchPhase.FinalCountdown,
    };

    const selfPublicId = this.selfPublicId();
    const roster = this.buildRoster(selfPublicId);
    const self = this.buildSelf(selfPublicId, roster, serverNowMs);
    const reveal = this.buildReveal();
    const voteCandidates = this.buildVoteCandidates(selfPublicId);

    const connectedPlayers = roster.filter((player) => player.connected);

    return {
      connection: {
        mode: this.connection.mode,
        status: this.connection.status,
        canRejoin: this.connection.canRejoin,
        detail: this.connection.detail,
      },
      round: this.phaseOverride?.round ?? publicState?.round ?? 0,
      phase,
      previousPhase: this.previousPhase,
      phaseLabel: phaseLabel(phase),
      timer,
      self,
      roster,
      botSeats: {
        supported: this.adapter.bots !== undefined,
        canManage: this.adapter.bots?.canManageBots() ?? false,
        // Counted off the published roster rather than off this client's own
        // bookkeeping, so every client prints the same number and only the
        // host's is ever non-empty by accident.
        count: roster.filter((player) => player.isBot).length,
        maxSeats: settings.maxPlayers,
      },
      warrantsRemaining: publicState ? publicState.warrantsRemaining : null,
      // Zero outside a round, which the HUD reads as "no magazine to draw".
      warrantsTotal: publicState ? publicState.warrantsTotal : null,
      mimicsRemaining: publicState?.mimicsRemaining ?? 0,
      accusations: this.buildAccusations(roster, selfPublicId),
      missedFinds: this.buildMissedFinds(selfPublicId, serverNowMs),
      deception:
        this.deceptionEvents.length === 0 &&
        this.directLookEscapes === 0 &&
        this.closePasses === 0
          ? EMPTY_DECEPTION
          : {
              recent: this.deceptionEvents,
              directLookEscapes: this.directLookEscapes,
              closePasses: this.closePasses,
              points:
                this.directLookEscapes * SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE +
                this.closePasses * SCORE_MIMIC_PER_CLOSE_PASS,
            },
      reveal,
      results: this.buildResults(selfPublicId, roster, voteCandidates),
      rematch: {
        yesVotes: this.rematchYesVotes,
        totalVoters:
          this.rematchTotalVoters > 0 ? this.rematchTotalVoters : connectedPlayers.length,
        myVote: this.myRematchVote,
      },
      rejections: this.rejections,
      actions: computeAvailability({
        status: this.connection.status,
        phase,
        role: self.role,
        lifeState: self.lifeState,
        isHost: self.isHost,
        disguiseLocked: self.disguiseLocked,
        warrantsRemaining: self.warrantsRemaining,
        accusationReadyAtServerMs: self.accusationReadyAtServerMs,
        serverNowMs,
        connectedPlayers: connectedPlayers.length,
        connectedPlayersReady: connectedPlayers.filter((player) => player.ready).length,
        minPlayers: settings.minPlayers,
        voteCandidates: voteCandidates.length,
        rematchVoted: this.myRematchVote !== null,
        tauntCooldownMs: self.tauntCooldownMs,
        tauntSupported: this.tauntSupported,
      }),
      capabilities: { taunt: this.tauntSupported },
      clockOffsetMs: this.clockOffsetMs,
    };
  }

  private buildRoster(selfPublicId: string | null): readonly RosterPlayerView[] {
    const publicState = this.sync.publicState;
    const authorityId = this.connection.authorityId;
    if (!publicState) {
      // Before the first sync the transport roster is all there is, and it says
      // nothing about ready flags or roles. Its ids are seats, not public ids.
      return this.transportRoster.map((entry) => ({
        seatId: entry.id,
        publicPlayerId: "",
        displayName: entry.displayName,
        isSelf: entry.isSelf,
        isAuthority: entry.isAuthority,
        isHost: false,
        connected: true,
        ready: false,
        lifeState: "active" as const,
        rolePublicState: "unknown" as const,
        isBot: isBotSeat(entry.id),
      }));
    }
    return publicState.players.map((player) => ({
      seatId: player.seatId,
      publicPlayerId: player.publicPlayerId,
      isSelf: player.publicPlayerId === selfPublicId,
      // The seat is the only identity a connection-level fact is expressed in,
      // which is what makes this attributable at all.
      isAuthority: authorityId !== null && player.seatId === authorityId,
      displayName: player.displayName,
      isHost: player.isHost,
      connected: player.connected,
      ready: player.ready,
      lifeState: player.lifeState,
      rolePublicState: player.rolePublicState,
      // The seat says so on its own, so a client that never saw the bot seated
      // still knows which rows are people.
      isBot: isBotSeat(player.seatId),
    }));
  }

  private buildSelf(
    selfPublicId: string | null,
    roster: readonly RosterPlayerView[],
    serverNowMs: number,
  ): SelfView {
    const privateState = this.sync.privateState;
    const own = privateState?.ownDisguise ?? null;
    const accusationReadyAtServerMs = privateState?.accusationReadyAt ?? null;
    const tauntReadyAtMs = privateState?.tauntReadyAtMs ?? null;
    const seat = roster.find((player) => player.isSelf);
    const transportSelf = this.transportRoster.find((entry) => entry.isSelf);

    return {
      transportId: this.connection.selfId,
      publicPlayerId: selfPublicId,
      displayName: seat?.displayName ?? transportSelf?.displayName ?? "",
      role: this.resolveRole(),
      lifeState: privateState?.lifeState ?? "active",
      isHost: privateState?.isHost ?? false,
      ready: privateState?.ready ?? false,
      ownDisguise:
        own === null
          ? null
          : {
              publicObjectId: own.publicObjectId,
              encodedPose: own.encodedPose,
              defaultArrangementId: own.defaultArrangementId,
              autoLocked: this.ownDisguiseAutoLocked,
            },
      disguiseLocked: own !== null,
      warrantsRemaining: privateState?.warrantsRemaining ?? null,
      accusationReadyAtServerMs,
      accusationCooldownMs:
        accusationReadyAtServerMs === null
          ? 0
          : Math.max(0, accusationReadyAtServerMs - serverNowMs),
      // Zero means this hider has not taunted yet, which is ready rather than
      // overdue, and the subtraction below says so on its own.
      tauntCooldownMs:
        tauntReadyAtMs === null ? 0 : Math.max(0, tauntReadyAtMs - serverNowMs),
      watchedLevel: this.watchedLevel,
    };
  }

  /**
   * `roleState` distinguishes a lobby player from a genuine spectator, so no
   * phase guessing is needed. The private role_assigned event still leads the
   * sync by a batch, which is the only reason the assignment is kept at all.
   */
  private resolveRole(): PlayerRole | null {
    const roleState = this.sync.privateState?.roleState;
    if (roleState === undefined || roleState === "unassigned") return this.assignedRole;
    return roleState;
  }

  private buildAccusations(
    roster: readonly RosterPlayerView[],
    selfPublicId: string | null,
  ): readonly AccusationFeedEntry[] {
    return this.accusationRecords.map((record) => {
      const revealed =
        record.revealedPlayerPublicId === null
          ? undefined
          : roster.find((player) => player.publicPlayerId === record.revealedPlayerPublicId);
      return {
        id: record.id,
        atServerMs: record.atServerMs,
        inspectorPublicId: record.inspectorPublicId,
        byMe: selfPublicId !== null && record.inspectorPublicId === selfPublicId,
        targetObjectId: record.targetObjectId,
        correct: record.correct,
        stamp: record.correct
          ? correctAccusationStamp(record.stampIndex)
          : wrongAccusationStamp(record.reactionId),
        reactionId: record.reactionId,
        revealedPlayerPublicId: record.revealedPlayerPublicId,
        revealedDisplayName: revealed?.displayName ?? null,
        warrantsRemaining: record.warrantsRemaining,
      };
    });
  }

  /**
   * The board as the HUD prints it. The authority already ranked the entries
   * and already decided how precise the points may be, so this only numbers the
   * rows, marks the viewer's own, and turns the next-report deadline into the
   * countdown the original shows beside the ranking.
   */
  private buildMissedFinds(selfPublicId: string | null, serverNowMs: number): MissedFindsView {
    const board = this.missedFinds;
    if (board === null) {
      return {
        received: false,
        rows: [],
        nextUpdateAtServerMs: 0,
        secondsToNextUpdate: null,
        final: false,
      };
    }

    const rows: MissedFindsRowView[] = board.entries.map((entry, index) => ({
      rank: index + 1,
      publicPlayerId: entry.publicPlayerId,
      displayName: entry.displayName,
      points: entry.points,
      isSelf: selfPublicId !== null && entry.publicPlayerId === selfPublicId,
    }));

    return {
      received: true,
      rows,
      nextUpdateAtServerMs: board.nextUpdateAtServerMs,
      secondsToNextUpdate:
        board.nextUpdateAtServerMs > 0
          ? Math.max(0, Math.ceil((board.nextUpdateAtServerMs - serverNowMs) / 1_000))
          : null,
      final: board.final,
    };
  }

  private buildReveal(): RevealView {
    const disguises = this.sync.publicState?.disguises ?? [];
    const entries: RevealEntryView[] = disguises.map((disguise) => {
      const caught = this.caughtByObject.get(disguise.publicObjectId) ?? null;
      const owner = this.owners.get(disguise.publicObjectId) ?? null;
      return {
        publicObjectId: disguise.publicObjectId,
        encodedPose: disguise.encodedPose,
        encodedPaint: disguise.encodedPaint,
        defaultArrangementId: disguise.defaultArrangementId,
        revealed: disguise.revealed,
        caught: caught !== null,
        publicPlayerId: caught?.publicPlayerId ?? owner?.publicPlayerId ?? null,
        displayName: owner?.displayName ?? null,
        // Ownership carries a survival time for survivors too, so the reveal
        // can show one before results exist. The catch event is the fallback
        // for a viewer not entitled to the ownership.
        survivalSeconds: owner?.survivalSeconds ?? caught?.survivalSeconds ?? null,
      };
    });
    return {
      entries,
      survivors: entries.filter((entry) => !entry.caught),
      caught: entries.filter((entry) => entry.caught),
    };
  }

  private buildVoteCandidates(selfPublicId: string | null): readonly VoteCandidateView[] {
    const known = new Set(
      (this.sync.publicState?.disguises ?? []).map((disguise) => disguise.publicObjectId),
    );
    const candidates: VoteCandidateView[] = [];
    for (const owner of this.owners.values()) {
      if (!known.has(owner.publicObjectId)) continue;
      // The simulation refuses a vote for one's own disguise (§5.15).
      if (selfPublicId !== null && owner.publicPlayerId === selfPublicId) continue;
      candidates.push({
        publicObjectId: owner.publicObjectId,
        publicPlayerId: owner.publicPlayerId,
        displayName: owner.displayName,
      });
    }
    return candidates;
  }

  private buildResults(
    selfPublicId: string | null,
    roster: readonly RosterPlayerView[],
    voteCandidates: readonly VoteCandidateView[],
  ): RoundViewState["results"] {
    const results = this.sync.publicState?.results ?? null;
    if (results === null) return null;

    const rows: ResultRowView[] = results.players.map((player) => ({
      publicPlayerId: player.publicPlayerId,
      displayName:
        roster.find((entry) => entry.publicPlayerId === player.publicPlayerId)?.displayName ??
        player.displayName,
      isSelf: selfPublicId !== null && player.publicPlayerId === selfPublicId,
      role: player.role,
      score: player.score,
      survivalSeconds: player.survivalSeconds,
      fullRoundSurvival: player.fullRoundSurvival,
      directLookEscapes: player.directLookEscapes,
      closePasses: player.closePasses,
      peerStyleVotes: player.peerStyleVotes,
      correctAccusations: player.correctAccusations,
      wrongAccusations: player.wrongAccusations,
      uniqueObjectsFocused: player.uniqueObjectsFocused,
      // Stated on the result now, so no join through ownership is needed and an
      // Inspector reads as null rather than as a missing lookup.
      publicObjectId: player.publicObjectId,
    }));

    return {
      round: results.round,
      winner: results.winner,
      inspectionDurationMs: results.inspectionDurationMs,
      timeRemainingMs: results.timeRemainingMs,
      rows,
      voteCandidates,
      myVotes: this.myVotes,
    };
  }
}
