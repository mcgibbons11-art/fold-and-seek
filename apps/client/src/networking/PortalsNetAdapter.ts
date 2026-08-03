import {
  MatchSimulation,
  type MatchCommand,
  type ObjectRegistry,
  type PublicMatchState,
  type MatchSettingsPatch,
  type PrivateMatchState,
  type PrivateSimEvent,
  type SimEvent,
  type SimOutput,
  type SpatialValidator,
} from "@foldseek/game-sim";
import {
  DEFAULT_MATCH_SETTINGS,
  eyesAgree,
  LIMITS,
  MatchPhase,
  MatchSnapshotSchema,
  type MatchSettings,
} from "@foldseek/shared";
import {
  BotSeats,
  isBotSeat,
  type AddBotOptions,
  type BotSeatOptions,
  type BotSeatSink,
} from "./botSeats";
import {
  EMPTY_SYNC,
  idleConnection,
  type BotSeatControls,
  type CommandRejection,
  type ConnectionDetail,
  type ConnectionState,
  type ConnectionStatus,
  type ForgeSnapshot,
  type InspectorCameraSample,
  type EyePosition,
  type MatchSync,
  type NetworkAdapter,
  type PaintUpdate,
  type RosterEntry,
  type Unsubscribe,
} from "./NetworkAdapter";
import {
  batchEvents,
  decodeChunks,
  MAX_EYE_REPORTS_PER_SECOND,
  decodeHostPublication,
  decodePaintBook,
  decodePoseBook,
  encodeChunks,
  jsonByteLength,
  parseEnvelope,
  type NetEnvelope,
  KeyedRateWindow,
  MAX_COMMANDS_PER_SECOND,
  MAX_FORGE_SNAPSHOTS_PER_SECOND,
  MAX_PAYLOAD_BYTES,
  MAX_REJECTIONS_PER_MESSAGE,
  PORTALS_PROTOCOL_VERSION,
  RATE_WINDOW_MS,
  RateWindow,
  SEND_RATE_LIMIT,
  SNAPSHOT_WRITES_PER_SECOND,
  STATE_WRITES_PER_SECOND,
  type HostPublication,
  type PaintBook,
  type PoseBook,
} from "./portalsProtocol";
import {
  DEFAULT_ROOM_SLOT,
  ROOM_HEARTBEAT_MS,
  ROOM_SLOTS,
  RoomAdSchema,
  RoomDirectory,
  VACANT_SLOT,
  freeRoomCode,
  sanitizeRoomName,
  type RoomAd,
  type RoomListing,
  type RoomSlot,
} from "./roomRegistry";
import { Signal } from "./signal";
import type {
  PortalsNet,
  PortalsNetPlayer,
  PortalsNetSession,
  PortalsSdk,
} from "../types/portals";

/**
 * Portals.net transport. The relay is a plain message bus with no server-side
 * authority, so one client runs the authoritative MatchSimulation and every
 * other client sends it commands and applies the events it publishes
 * (docs/PORTALS_CONSTRAINTS.md).
 *
 * Authority election is the lowest seat id among the session players. Because
 * every client sees the same player set, all clients agree without negotiating.
 * The holder keeps authority while it remains in the session: a joining client
 * never takes it, so a late join cannot interrupt a round. When the holder
 * leaves, the remaining clients re-elect from the same rule and the winner
 * rebuilds from the last published snapshot.
 *
 * IDENTITY. Portals reports a per-connection `id` that changes every time a
 * player reconnects, and a `playerId` that is stable for signed-in players. The
 * simulation is keyed on the stable one, called the seat id here, so a player
 * who drops and returns inside the reconnect grace lands back in their own slot
 * with their role and disguise intact (§27.9). A guest has no stable id, so
 * their connection id is their seat and they behave as before.
 *
 * ROOMS. One relay channel carries every match in the session, because the SDK
 * holds a single net session and a client cannot be in two channels at once. A
 * room is therefore a logical partition: each one owns a disjoint range of state
 * keys, every envelope names the room it belongs to, and a client drops the
 * traffic of any room but its own. `roomRegistry.ts` holds the slot table, the
 * key budget that fixes how many rooms a session can carry, and the
 * advertisements that let a player find them. Joining the channel and joining a
 * match are separate steps here — `joinSession` does the first and leaves the
 * client browsing, `enterRoom` and `createRoom` do the second — and `join` runs
 * both, which is what keeps a session with one room behaving exactly as it did
 * before rooms existed.
 *
 * A second LIVE connection of one account is a second player rather than a
 * refusal. Both panes of the Portals editor's two-player preview carry the same
 * account, so refusing the duplicate made the only tool that can test
 * multiplayer show a one-seat lobby in each pane; on a real account it means a
 * phone and a laptop can both play, which is the right answer for a party game.
 * The newcomer takes a seat derived from its connection id and is a distinct
 * player to the simulation, with its own role, disguise and anonymity. What is
 * unchanged is the reconnect: when the account's existing connection is gone,
 * the returning one reclaims the account's own seat exactly as before, which is
 * what `indexSeats` decides.
 */

export const PORTALS_TICK_HZ = 10;
/** Outbound coalescing window, matching the 100-150 ms sampling guidance. */
export const FLUSH_INTERVAL_MS = 100;
const SNAPSHOT_INTERVAL_MS = Math.round(1_000 / SNAPSHOT_WRITES_PER_SECOND);
/**
 * Pause before the one automatic retry of a failed relay join. Long enough for
 * the leave() that precedes it to have taken effect, short enough that a player
 * reads the whole sequence as a join that took a moment.
 */
export const JOIN_RETRY_DELAY_MS = 400;
/**
 * Separates an account id from the connection that made a second seat of it.
 * Never produced by Portals in either half, so a derived seat cannot be
 * mistaken for an account id some other client is using whole.
 */
export const DERIVED_SEAT_SEPARATOR = "~";

export interface PortalsAdapterOptions extends BotSeatOptions {
  readonly settings?: MatchSettingsPatch;
  readonly seed?: number;
  readonly tickHz?: number;
  /**
   * Range and line-of-sight checks for whichever client ends up host. The
   * simulation defaults to a permissive validator, so leaving this out means
   * accusations and direct-look escapes are not gated on geometry.
   */
  readonly spatial?: SpatialValidator;
  /**
   * The map's accusable objects, for whichever client ends up host. Omitted,
   * the simulation falls back to its five-prop test fixture and refuses every
   * accusation aimed at a real prop as `target_unknown`. It is also what names
   * the map in a published snapshot, so a successor whose registry disagrees
   * refuses to restore rather than resuming a round about a different room.
   */
  readonly objectRegistry?: ObjectRegistry;
  /**
   * Where a remote Inspector reports looking from, for whichever client ends up
   * host. It is called on the host only, once per accepted `eye` report, and
   * the caller is expected to feed it to the same validator passed as `spatial`.
   * Omitted, the host knows only its own eye and refuses every accusation any
   * other client fires.
   */
  readonly onInspectorEye?: (seatId: string, eye: EyePosition | null) => void;
  /**
   * Clock for the authoritative simulation. Defaults to Date.now() so the
   * timeline in a published snapshot still means something to the next host.
   */
  readonly now?: () => number;
  /**
   * How long to wait before the single automatic retry of a failed relay join.
   * Zero retries immediately and without a timer, which is what the tests use.
   */
  readonly joinRetryDelayMs?: number;
}

/**
 * Why a room could not be entered. Every one of these is the player's business
 * and reaches them as a sentence, so none of them is reported as a bare failure.
 */
export type RoomEntryFailure =
  /** Not in the relay session at all, so there is nothing to browse. */
  | "not_in_session"
  /** The code names no live room: it was mistyped, or the room has closed. */
  | "no_such_room"
  | "room_full"
  /** Both of the session's room slots are taken (roomRegistry.ts). */
  | "session_full"
  | "already_in_room";

export type RoomEntryResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: RoomEntryFailure };

/** Reads the SDK the Portals host injects, or null outside Portals. */
export function detectPortals(): PortalsSdk | null {
  if (typeof window === "undefined") return null;
  const candidate: unknown = (window as { Portals?: unknown }).Portals;
  return isPortalsSdk(candidate) ? candidate : null;
}

export function isPortalsSdk(value: unknown): value is PortalsSdk {
  if (typeof value !== "object" || value === null) return false;
  const sdk = value as Partial<PortalsSdk>;
  return typeof sdk.ready === "function" && typeof sdk.net === "object" && sdk.net !== null;
}

export class PortalsNetAdapter implements NetworkAdapter {
  readonly mode = "portals" as const;

  private readonly portals: PortalsSdk;
  private readonly net: PortalsNet;
  private readonly options: PortalsAdapterOptions;
  private readonly tickHz: number;
  private readonly clock: () => number;
  private readonly joinRetryDelayMs: number;

  private readonly eventSignal = new Signal<SimEvent>();
  private readonly privateSignal = new Signal<PrivateSimEvent>();
  private readonly rosterSignal = new Signal<readonly RosterEntry[]>();
  private readonly statusSignal = new Signal<ConnectionState>();
  private readonly rejectionSignal = new Signal<CommandRejection>();
  private readonly syncSignal = new Signal<MatchSync>();
  private readonly cameraSignal = new Signal<{
    readonly seatId: string;
    readonly sample: InspectorCameraSample | null;
  }>();

  private players: PortalsNetPlayer[] = [];
  /** Relay connection id: changes on every reconnect, used only for addressing. */
  private selfConnectionId: string | null = null;
  /** Stable identity the simulation knows this client by. */
  private selfSeatId: string | null = null;
  private authoritySeatId: string | null = null;
  private sim: MatchSimulation | null = null;

  /** Live connection id to seat id, decided once per connection by indexSeats. */
  private readonly connectionSeats = new Map<string, string>();
  /** The name each live connection plays under, numbered when it is a second seat. */
  private readonly connectionNames = new Map<string, string>();
  /** Host only: which connection currently holds each seated player's slot. */
  private readonly seatOwners = new Map<string, string>();

  /**
   * The room this client is playing in, and the state keys that room publishes
   * on. Null while the client is in the session but has not picked a room, which
   * is the state the browser is read in: no simulation, no authority, and every
   * envelope on the channel dropped.
   */
  private roomCode: string | null = null;
  private roomSlot: RoomSlot = DEFAULT_ROOM_SLOT;
  private roomName = "";
  /** The settings the room was opened with, clamped to what its slot can carry. */
  private roomSettings: MatchSettingsPatch = {};
  /**
   * Seats the session was already using when this client arrived, read once out
   * of every room's publication. `indexSeats` needs it to tell a second live
   * connection of one account from a returning one before this client has
   * entered a room and so has a publication of its own.
   */
  private knownSeatIds: ReadonlySet<string> = new Set();
  /** The name to play under, kept from the join so `enterRoom` can announce it. */
  private displayName = "";
  private readonly directory = new RoomDirectory();
  private readonly directorySignal = new Signal<readonly RoomListing[]>();
  /** Host only: the advertisement's heartbeat, and when it last went out. */
  private adBeat = 0;
  private lastAdAt = 0;
  /** The last advertisement written, minus its beat, to spot a real change. */
  private lastAdBody = "";

  private connection: ConnectionState = idleConnection("portals");
  private sync: MatchSync = EMPTY_SYNC;
  private lastSnapshot: HostPublication | null = null;
  /** Newest authoritative snapshot seen, whether published here or read. */
  private lastSimSnapshot: unknown = null;
  private lastSimSeq = 0;
  private simSnapshotBlockedAt = 0;
  /** Re-sent verbatim when a new host asks: the pose this client last published. */
  private lastForgeSnapshot: ForgeSnapshot | null = null;
  /** The same, for the paint layer, which is equally unrecoverable elsewhere. */
  private lastPaintUpdate: PaintUpdate | null = null;
  /** A layer a reforge asked for, waiting on the flush after the pose went out. */
  private pendingPaintResend: PaintUpdate | null = null;
  /** Where this client last said it was looking from, and where it is now. */
  private pendingEye: EyePosition | null = null;
  private sentEye: EyePosition | null = null;
  private eyeReported = false;
  /** Locked poses, kept out of the frequently rewritten publication. */
  private poseBook: PoseBook = {};
  private poseSeq = 0;
  private lastPoseSerialized = "";
  /** Body paint, on its own range for the same reason the poses are. */
  private paintBook: PaintBook = {};
  private paintSeq = 0;
  private lastPaintSerialized = "";
  /**
   * Ranges whose value is too large for the keys they own. Latched so that a
   * fault which repeats on every publish is reported once rather than filling
   * every client's rejection queue twice a second.
   */
  private readonly oversizedRanges = new Set<string>();
  private readonly stateWindow = new RateWindow(STATE_WRITES_PER_SECOND, RATE_WINDOW_MS);
  private snapshotSeq = 0;
  private snapshotDirty = false;
  private lastSnapshotAt = 0;

  private readonly publicOutbox: SimEvent[] = [];
  private readonly privateOutbox = new Map<string, PrivateSimEvent[]>();
  private readonly pendingSync = new Set<string>();
  private readonly pendingRejections = new Map<string, CommandRejection[]>();
  /** Connections the simulation would not seat, and why, kept for their resync. */
  private readonly refusedConnections = new Map<string, string>();
  private readonly sendWindow = new RateWindow(SEND_RATE_LIMIT, RATE_WINDOW_MS);
  private readonly commandWindow = new KeyedRateWindow(MAX_COMMANDS_PER_SECOND, RATE_WINDOW_MS);
  private readonly forgeWindow = new KeyedRateWindow(
    MAX_FORGE_SNAPSHOTS_PER_SECOND,
    RATE_WINDOW_MS,
  );
  private readonly eyeWindow = new KeyedRateWindow(MAX_EYE_REPORTS_PER_SECOND, RATE_WINDOW_MS);

  /**
   * Seats nobody is connected on, held only by whichever client is host. They
   * are ordinary players of that client's simulation and reach every other
   * client through the ordinary published state, so no peer has to know they
   * exist to render them.
   */
  private readonly botSeats: BotSeats;

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private listenersAttached = false;
  private disposed = false;

  /**
   * The lobby's add and remove controls. They run against the host's own
   * simulation rather than travelling as a command, because only the host may
   * seat anyone at all: a wire command would exist solely for the host to send
   * to itself, and would give every other client a message to refuse.
   */
  readonly bots: BotSeatControls = {
    canManageBots: () => this.isAuthority() && this.sim !== null,
    addBot: () => this.addBot(),
    removeBot: (seatId: string) => {
      this.removeBot(seatId);
    },
    botSeatIds: () => this.botSeats.ids(),
  };

  constructor(portals: PortalsSdk, options: PortalsAdapterOptions = {}) {
    this.portals = portals;
    this.net = portals.net;
    this.options = options;
    this.tickHz = options.tickHz ?? PORTALS_TICK_HZ;
    this.clock = options.now ?? (() => Date.now());
    this.joinRetryDelayMs = options.joinRetryDelayMs ?? JOIN_RETRY_DELAY_MS;
    this.botSeats = new BotSeats(options);
  }

  /**
   * Seats a bot in the host's simulation. Returns its seat, or null when this
   * client is not the host or the room is already full.
   */
  addBot(options: AddBotOptions = {}): string | null {
    if (!this.isAuthority() || this.sim === null) return null;
    const bot = this.botSeats.add(options);
    const seated = this.applySim("add bot", (sim) =>
      sim.addPlayer(bot.playerId, { displayName: bot.displayName }),
    );
    if (seated === null || !seated.accepted) {
      this.botSeats.remove(bot.playerId);
      console.warn(`[portals] could not seat a bot: ${seated?.reason ?? "no simulation"}`);
      return null;
    }
    // The roster every client renders comes from the published state, and the
    // flush is 100 ms away, so the row appears without a write of its own.
    this.emitRoster();
    return bot.playerId;
  }

  removeBot(seatId: string): void {
    if (!this.isAuthority() || this.sim === null) return;
    if (!this.botSeats.remove(seatId)) return;
    this.applySim("remove bot", (sim) => sim.removePlayer(seatId));
    this.emitRoster();
  }

  /** Where the bot driver's commands go on the host. */
  private readonly botSink: BotSeatSink = {
    // A bot's refusals are its own business, and reporting one would address a
    // wire message to a seat no connection is listening on.
    applyCommand: (playerId, command) => {
      this.applySim(`bot command ${command.type}`, (sim) => sim.handleCommand(playerId, command));
    },
    applyForgeSnapshot: (playerId, encodedPose, revision, nowMs) => {
      this.applySim("bot forge snapshot", (sim) =>
        sim.recordForgeSnapshot(playerId, encodedPose, revision, nowMs),
      );
    },
  };

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("PortalsNetAdapter was disposed");
    await this.portals.ready();
  }

  /**
   * Enters the session and lands in a room, which is what every caller that does
   * not show a room browser wants.
   *
   * The rule reproduces what the transport did before rooms existed: everybody
   * converges on the one room. A session already running a joinable room puts
   * this client in it, and an empty session gets a room created for it, so a
   * lone client, the editor's two preview panes, and a party that never opens
   * the browser all behave exactly as they did.
   *
   * A session whose rooms are all full is a refusal rather than a new room.
   * Opening one would be a defensible thing for a browser to offer, but this
   * entry point means "put me in the game", and a player who lands alone in a
   * room of their own has not joined the party they were trying to join.
   */
  async join(room: string, displayName: string): Promise<ConnectionState> {
    await this.joinSession(room, displayName);

    const nowMs = this.clock();
    const target = this.directory.quickJoinTarget(nowMs);
    const entered =
      target !== null
        ? this.enterRoom(target.code)
        : this.directory.list(nowMs).length === 0
          ? this.createRoom(defaultRoomName(displayName))
          : ({ ok: false, reason: "room_full" } as const);
    if (!entered.ok) {
      this.setStatus("error", entered.reason === "room_full" ? "room_full" : "join_failed");
      await this.leaveQuietly();
      throw new Error(entered.reason);
    }
    return this.connection;
  }

  /**
   * Joins the relay channel and stops there, leaving this client in the session
   * and in no room: it can read the directory and pick one, and until it does,
   * every envelope on the channel belongs to somebody else's match and is
   * dropped. This is the state a room browser is shown in.
   */
  async joinSession(room: string, displayName: string): Promise<ConnectionState> {
    if (this.disposed) throw new Error("PortalsNetAdapter was disposed");
    this.setStatus("connecting", null);

    let session: PortalsNetSession;
    try {
      session = await this.joinRelay(room);
    } catch (error) {
      this.setStatus("error", "join_failed");
      throw error;
    }

    this.selfConnectionId = session.self.id;
    this.displayName = displayName;
    this.players = mergeSelf(session.players, session.self);
    if (session.self.displayName === null) {
      // Portals owns display names; the requested one is only a fallback.
      this.players = this.players.map((player) =>
        player.id === session.self.id ? { ...player, displayName } : player,
      );
    }

    this.attachListeners();
    this.directory.observeState(session.state, this.clock());
    // Seats already spoken for anywhere in the session, gathered once so that
    // the exact rule in `indexSeats` — a derived seat names the connection that
    // owns it — applies to a client that has not entered a room yet and so has
    // no publication of its own to read.
    this.knownSeatIds = publishedSeatIds(session.state);
    this.indexSeats();
    this.selfSeatId = this.connectionSeats.get(session.self.id) ?? baseSeatIdOf(session.self);

    this.startTimers();
    this.setStatus("connected");
    this.emitRoster();
    this.emitDirectory();
    return this.connection;
  }

  /* ------------------------------------------------------------------ rooms */

  /** Live rooms in this session, newest reading of the registry. */
  listRooms(): readonly RoomListing[] {
    return this.directory.list(this.clock());
  }

  /** The room this client is playing in, or null while it is browsing. */
  getRoomCode(): string | null {
    return this.roomCode;
  }

  /** Fires whenever the session's advertised rooms change. */
  onDirectory(listener: (rooms: readonly RoomListing[]) => void): Unsubscribe {
    return this.directorySignal.subscribe(listener);
  }

  /**
   * Opens a room and takes its host seat.
   *
   * The slot decides the room's size rather than the caller: the key ranges a
   * slot owns are what a room's poses and paint have to fit inside, so a room
   * seated past its slot would stop publishing the very thing that makes its
   * disguises visible (roomRegistry.ts).
   */
  createRoom(name: string): RoomEntryResult {
    if (this.connection.status !== "connected" || this.selfSeatId === null) {
      return { ok: false, reason: "not_in_session" };
    }
    if (this.roomCode !== null) return { ok: false, reason: "already_in_room" };

    const nowMs = this.clock();
    const slot = this.directory.freeSlot(nowMs);
    if (slot === null) return { ok: false, reason: "session_full" };

    this.roomSlot = slot;
    this.roomCode = freeRoomCode(this.directory, nowMs);
    this.roomName = sanitizeRoomName(name, defaultRoomName(this.displayName));
    this.roomSettings = {
      ...(this.options.settings ?? {}),
      maxPlayers: Math.min(
        this.options.settings?.maxPlayers ?? DEFAULT_MATCH_SETTINGS.maxPlayers,
        slot.maxPlayers,
      ),
    };
    this.resetRoomState();

    // The room's first host is whoever opened it, without an election: nobody
    // else is in it, so there is nothing to elect between.
    this.authoritySeatId = this.selfSeatId;
    this.assumeAuthority();
    this.publishAd(true);
    this.emitDirectory();
    return { ok: true, code: this.roomCode };
  }

  /** Takes a seat in a room somebody else opened. */
  enterRoom(code: string): RoomEntryResult {
    if (this.connection.status !== "connected" || this.selfConnectionId === null) {
      return { ok: false, reason: "not_in_session" };
    }
    if (this.roomCode !== null) return { ok: false, reason: "already_in_room" };

    const nowMs = this.clock();
    const listing = this.directory.find(code, nowMs);
    if (listing === null) return { ok: false, reason: "no_such_room" };
    const slot = ROOM_SLOTS[listing.slot];
    if (slot === undefined) return { ok: false, reason: "no_such_room" };

    const state = this.net.getState();
    const snapshot = decodeHostPublication(state, slot.keys.snapshot);
    const self = this.players.find((player) => player.id === this.selfConnectionId);
    if (snapshot !== null && self !== undefined && this.isRoomFull(snapshot, self)) {
      // The host would refuse the seat anyway; failing here means the player
      // gets a reason instead of sitting in a room that never seats them.
      return { ok: false, reason: "room_full" };
    }

    this.roomSlot = slot;
    this.roomCode = listing.code;
    this.roomName = listing.name;
    this.roomSettings = {
      ...(this.options.settings ?? {}),
      maxPlayers: Math.min(listing.maxPlayers, slot.maxPlayers),
    };
    this.resetRoomState();

    this.poseBook = decodePoseBook(state, slot.keys.pose) ?? {};
    this.paintBook = decodePaintBook(state, slot.keys.paint) ?? {};
    const simChunk = decodeChunks(state, slot.keys.sim);
    if (simChunk) {
      this.lastSimSeq = simChunk.seq;
      this.lastSimSnapshot = simChunk.value;
    }
    this.lastSnapshot = snapshot;
    if (snapshot !== null) {
      this.adoptSnapshotSeq(snapshot);
      this.setSync(this.withBodies(snapshot), null);
    }

    this.resolveAuthority();
    // The relay's own arrival event says somebody opened the game, not that they
    // joined this match, so the room's host is told in as many words. It reaches
    // every client and only that host acts on it.
    this.rawSend({
      v: PORTALS_PROTOCOL_VERSION,
      t: "enter",
      displayName: this.displayName.slice(0, LIMITS.displayNameLength) || "Visitor",
    });
    if (!this.isAuthority()) this.requestResync();
    this.emitRoster();
    return { ok: true, code: this.roomCode };
  }

  /** Enters the fullest room with a seat left, or opens one when none has. */
  quickJoin(name?: string): RoomEntryResult {
    const target = this.directory.quickJoinTarget(this.clock());
    if (target !== null) return this.enterRoom(target.code);
    return this.createRoom(name ?? defaultRoomName(this.displayName));
  }

  /**
   * Gives up this client's seat and returns it to the browser, still in the
   * session. A host that is the last one out retires its room's advertisement so
   * the slot is free at once rather than after the heartbeat times out.
   */
  leaveRoom(): void {
    const code = this.roomCode;
    if (code === null) return;

    if (this.isAuthority()) {
      const remaining = this.roomSeats().filter((seat) => seat !== this.selfSeatId);
      if (remaining.length === 0) this.retireAd();
    }
    this.rawSend({ v: PORTALS_PROTOCOL_VERSION, t: "exit" });

    this.roomCode = null;
    this.authoritySeatId = null;
    this.releaseAuthority();
    this.resetRoomState();
    this.setStatus(this.connection.status, null);
    this.emitRoster();
    this.emitDirectory();
  }

  /** Everything one room's worth of published state, cleared between rooms. */
  private resetRoomState(): void {
    this.lastSnapshot = null;
    this.lastSimSnapshot = null;
    this.lastSimSeq = 0;
    this.poseBook = {};
    this.paintBook = {};
    this.lastPoseSerialized = "";
    this.lastPaintSerialized = "";
    this.poseSeq = 0;
    this.paintSeq = 0;
    this.snapshotSeq = 0;
    this.snapshotDirty = false;
    this.lastSnapshotAt = 0;
    this.adBeat = 0;
    this.lastAdAt = 0;
    this.lastAdBody = "";
    this.oversizedRanges.clear();
    this.sync = EMPTY_SYNC;
    this.syncSignal.emit(this.sync);
  }

  /**
   * The SDK's own join, with automatic recovery.
   *
   * The failure this survives, established by reading the injected sdk.js
   * after three rounds of editor logs (2026-08-02): a join request the HOST
   * answers after the SDK's 10 s request window leaves the host holding a
   * live session while the SDK's local mirror stays empty — the late reply
   * is dropped, self() returns null, and every further join is refused by
   * the host with "a multiplayer session is already active". Crucially,
   * leave() in that state is a LOCAL no-op (netLeave returns early when the
   * mirror is empty and no join is pending), so leave-and-retry — the two
   * previous cuts of this method — could never reach the host and the
   * refusal repeated forever.
   *
   * A host-side refusal therefore routes through forceHostLeave(), which is
   * the only way to actually clear the host. Timeout-style failures keep
   * plain retry (when the host never seated the join, a fresh knock just
   * works); three attempts in all, then the failure is reported.
   */
  private async joinRelay(room: string): Promise<PortalsNetSession> {
    const options = room.length > 0 ? { channel: room } : undefined;
    const attempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.net.join(options);
      } catch (error) {
        lastError = error;
        if (attempt === attempts) break;
        if (/already (active|in a session)/i.test(String(error))) {
          console.warn(
            "[portals] the host still holds the timed-out join's session; forcing it clear",
            error,
          );
          const rescued = await this.forceHostLeave(options);
          if (rescued !== null) return rescued;
          continue;
        }
        console.warn("[portals] relay join failed, clearing the session and retrying", error);
        await this.leaveQuietly();
        if (this.joinRetryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.joinRetryDelayMs));
        }
      }
    }
    await this.leaveQuietly();
    throw lastError;
  }

  /**
   * Clears a session the HOST holds for a join whose reply this SDK dropped.
   *
   * leave() only travels to the host while the local mirror or a pending
   * join exists (sdk.js netLeave), and in this failure state neither does.
   * So: start a join the host is expected to refuse, give the SDK one
   * microtask to arm it (netJoinPending is set in a .then on the ready
   * promise), and send the leave through that armed window — the host
   * processes the doomed join, refuses it, then processes the leave and
   * clears the session, and the NEXT attempt in the loop gets in clean. If
   * the host happens to order them the other way, the "doomed" join comes
   * back a real session and is returned rather than thrown away.
   */
  private async forceHostLeave(
    options: { channel: string } | undefined,
  ): Promise<PortalsNetSession | null> {
    const doomed: Promise<PortalsNetSession | null> = this.net.join(options).then(
      (session) => session,
      () => null,
    );
    await Promise.resolve();
    await this.leaveQuietly();
    return doomed;
  }

  /** Best effort: after a failed join there may genuinely be nothing to leave. */
  private async leaveQuietly(): Promise<void> {
    try {
      await this.net.leave();
    } catch {
      // Nothing was joined, so nothing needs clearing.
    }
  }

  async disconnect(): Promise<void> {
    // Leaving the session leaves the room first, so a host that is the last one
    // out frees its slot for whoever opens the next room.
    this.leaveRoom();
    this.stopTimers();
    this.detachListeners();
    this.releaseAuthority();
    this.directory.clear();
    this.roomCode = null;
    this.players = [];
    this.connectionSeats.clear();
    this.connectionNames.clear();
    this.selfConnectionId = null;
    this.selfSeatId = null;
    this.authoritySeatId = null;
    this.sync = EMPTY_SYNC;
    this.syncSignal.emit(this.sync);
    this.setStatus("closed", null);
    await this.net.leave();
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimers();
    this.detachListeners();
    this.releaseAuthority();
    this.eventSignal.clear();
    this.privateSignal.clear();
    this.rejectionSignal.clear();
    this.directorySignal.clear();
    this.rosterSignal.clear();
    this.statusSignal.clear();
    this.syncSignal.clear();
    this.cameraSignal.clear();
  }

  sendCommand(command: MatchCommand): void {
    if (this.connection.status !== "connected" || this.selfSeatId === null) {
      console.warn("[portals] command while not connected, ignoring", command.type);
      return;
    }
    if (this.isAuthority()) {
      this.applyCommandFrom(this.selfSeatId, command);
      return;
    }
    if (this.authoritySeatId === null) {
      console.warn("[portals] no authority elected, dropping command", command.type);
      return;
    }
    this.rawSend({
      v: PORTALS_PROTOCOL_VERSION,
      t: "cmd",
      to: this.authoritySeatId,
      cmd: command,
    });
  }

  sendForgeSnapshot(snapshot: ForgeSnapshot): void {
    if (this.connection.status !== "connected" || this.selfSeatId === null) return;
    this.lastForgeSnapshot = snapshot;
    if (this.isAuthority()) {
      this.applyForgeSnapshot(this.selfSeatId, snapshot);
      return;
    }
    if (this.authoritySeatId === null) return;
    this.rawSend({
      v: PORTALS_PROTOCOL_VERSION,
      t: "snap",
      to: this.authoritySeatId,
      snapshot,
    });
  }

  sendPaintUpdate(update: PaintUpdate): void {
    if (this.connection.status !== "connected" || this.selfSeatId === null) return;
    this.lastPaintUpdate = update;
    if (this.isAuthority()) {
      this.applyPaintUpdate(this.selfSeatId, update);
      return;
    }
    if (this.authoritySeatId === null) return;
    this.rawSend({
      v: PORTALS_PROTOCOL_VERSION,
      t: "paint",
      to: this.authoritySeatId,
      paint: update,
    });
  }

  sendCameraSample(sample: InspectorCameraSample | null): void {
    if (this.connection.status !== "connected" || this.selfSeatId === null) return;
    this.rawSend({ v: PORTALS_PROTOCOL_VERSION, t: "cam", sample });
  }

  /**
   * Tells the room where this client is looking from, if anyone else is running
   * the simulation. Called as often as the camera moves; the report itself goes
   * out at the flush cadence, and only once the eye has actually travelled.
   *
   * The host needs nothing from this. Its own bridge is written directly by the
   * round that owns the camera, and that write is what a remote client is here
   * to reproduce.
   */
  reportInspectorEye(eye: EyePosition | null): void {
    this.pendingEye = eye === null ? null : [round3(eye[0]), round3(eye[1]), round3(eye[2])];
    this.eyeReported = true;
  }

  getSelfId(): string | null {
    return this.selfSeatId;
  }

  getConnection(): ConnectionState {
    return this.connection;
  }

  getRoster(): readonly RosterEntry[] {
    // Keyed by seat rather than by connection, which is the identity every
    // other part of the game speaks in. Two connections of one account hold two
    // seats and appear twice, under names a numeral tells apart.
    //
    // It is the room's roster, not the session's: the channel also carries the
    // people in the other match and the people still choosing one, and a lobby
    // listing them would be counting players who are not in the round.
    const members = new Set(this.roomSeats());
    const bySeat = new Map<string, RosterEntry>();
    for (const player of this.players) {
      const seat = this.connectionSeats.get(player.id);
      if (seat === undefined || !members.has(seat) || bySeat.has(seat)) continue;
      bySeat.set(seat, {
        id: seat,
        displayName: this.connectionNames.get(player.id) ?? nameOf(player),
        isSelf: seat === this.selfSeatId,
        isAuthority: seat === this.authoritySeatId,
      });
    }
    return [...bySeat.values()];
  }

  getSync(): MatchSync {
    return this.sync;
  }

  /**
   * Whether the published roster already holds every seat the settings allow.
   * A rejoining player arrives on a new connection id and so needs a new seat,
   * which is why there is no exemption for someone who was here before.
   *
   * Two further things make this a courtesy rather than a rule, and it is
   * written to fail towards letting the player try, since the host decides
   * either way and refuses with a reason of its own.
   *
   * A publication naming this connection's own seat was written after the host
   * had already seated it, so the room has a place for it whatever the count
   * says. That is not hypothetical: the host seats a joiner the moment the
   * relay reports it, and can publish again before the joiner has read the
   * state it was handed.
   *
   * And a room filled out with bots is not full to a person. The host gives one
   * of their seats up in `seatArrival` rather than turning somebody away in
   * favour of a machine, so the joiner is let through to ask.
   */
  private isRoomFull(snapshot: HostPublication, self: PortalsNetPlayer): boolean {
    const { players, settings } = snapshot.publicState;
    // Both forms name this connection outright: the derived seat carries its
    // id, and a guest's seat is its id. An account id is not among them,
    // because a second connection of one account does not hold the first's.
    const ownSeats = new Set([derivedSeatId(baseSeatIdOf(self), self.id), self.id]);
    if (players.some((player) => ownSeats.has(player.seatId))) return false;
    if (players.length < settings.maxPlayers) return false;
    return !players.some((player) => isBotSeat(player.seatId));
  }

  /**
   * Gives up the most recently added bot seat, to make room for a person. The
   * newest is the one with the least of the round invested in it.
   */
  private freeBotSeat(): boolean {
    const seatId = this.botSeats.ids().at(-1);
    if (seatId === undefined) return false;
    this.botSeats.remove(seatId);
    this.applySim("free bot seat", (sim) => sim.removePlayer(seatId));
    return true;
  }

  /** True while this client owns the authoritative simulation. */
  isAuthority(): boolean {
    return this.selfSeatId !== null && this.selfSeatId === this.authoritySeatId;
  }

  onEvent(listener: (event: SimEvent) => void): Unsubscribe {
    return this.eventSignal.subscribe(listener);
  }

  onPrivateEvent(listener: (event: PrivateSimEvent) => void): Unsubscribe {
    return this.privateSignal.subscribe(listener);
  }

  onRejection(listener: (rejection: CommandRejection) => void): Unsubscribe {
    return this.rejectionSignal.subscribe(listener);
  }

  onRoster(listener: (roster: readonly RosterEntry[]) => void): Unsubscribe {
    return this.rosterSignal.subscribe(listener);
  }

  onStatus(listener: (state: ConnectionState) => void): Unsubscribe {
    return this.statusSignal.subscribe(listener);
  }

  onSync(listener: (sync: MatchSync) => void): Unsubscribe {
    return this.syncSignal.subscribe(listener);
  }

  onCameraSample(
    listener: (seatId: string, sample: InspectorCameraSample | null) => void,
  ): Unsubscribe {
    return this.cameraSignal.subscribe(({ seatId, sample }) => listener(seatId, sample));
  }

  // ------------------------------------------------------------- relay events

  private readonly handleMessage = (first: unknown, second: unknown): void => {
    // The checked-in SDK contract is `(data, fromId)`. A few Portals editor
    // host builds have instead exposed a postMessage-like wrapper, and one
    // briefly reversed the two arguments. Normalize those carrier differences
    // before the protocol sees the payload; no game field bypasses validation.
    let data = first;
    let fromId = typeof second === "string" ? second : null;
    if (typeof first === "string" && second !== null && typeof second === "object") {
      fromId = first;
      data = second;
    }
    if (data !== null && typeof data === "object" && !("t" in data) && "data" in data) {
      const wrapper = data as { readonly data: unknown; readonly fromId?: unknown };
      data = wrapper.data;
      if (fromId === null && typeof wrapper.fromId === "string") fromId = wrapper.fromId;
    }
    if (fromId === null) {
      console.warn("[portals] dropped message without a sender");
      return;
    }

    // Size first: an oversized payload is refused before it is parsed, so a
    // peer cannot make the host do work by sending something enormous (§36.5).
    const bytes = jsonByteLength(data);
    if (bytes > MAX_PAYLOAD_BYTES) {
      console.warn(`[portals] dropped ${bytes} byte message from ${fromId}`);
      return;
    }

    const envelope = parseEnvelope(data);
    if (!envelope) {
      const shape =
        data === null
          ? "null"
          : Array.isArray(data)
            ? "array"
            : typeof data === "object"
              ? `object:${String((data as { t?: unknown }).t ?? "no-type")}`
              : typeof data;
      console.warn(`[portals] dropped malformed ${shape} message from ${fromId}`);
      return;
    }

    // Directory broadcasts are session-scoped by design: a player still in
    // the browser has no roomCode, but is exactly who needs to hear this. The
    // durable setState copy is still read on join and host migration.
    if (envelope.t === "ad") {
      const parsed = RoomAdSchema.safeParse(envelope.ad);
      if (!parsed.success) {
        console.warn(`[portals] dropped malformed room advertisement from ${fromId}`);
        return;
      }
      const slot = ROOM_SLOTS[parsed.data.slot];
      if (slot === undefined) return;
      this.directory.observe(slot.adKey, parsed.data, this.clock());
      this.checkAdOwnership();
      this.emitDirectory();
      return;
    }

    // The room partition, and the whole of it. Every client in the session hears
    // every broadcast, so a match's traffic is separated from its neighbour's
    // here and nowhere else: an envelope for another room is another room's
    // business, and a client that has not entered one has no business at all.
    if (this.roomCode === null || envelope.r !== this.roomCode) return;

    // Everything below is decided on the sender's seat. The relay reports a
    // connection, and a connection with no seat has nothing to say to the room.
    let fromSeat = this.connectionSeats.get(fromId);

    // A client can hear from a new host before it has been told the old one
    // left, in which case its own view of who is authoritative is stale and it
    // would reject the very messages that carry the round forward. The relay's
    // live roster settles it, so reconcile before judging the sender.
    if (AUTHORITY_ONLY.has(envelope.t) && fromSeat !== this.authoritySeatId) {
      this.reconcileRoster();
      fromSeat = this.connectionSeats.get(fromId);
    }
    if (fromSeat === undefined && envelope.t !== "refused") return;

    switch (envelope.t) {
      case "cmd":
        // Only the elected authority acts on commands, and only on ones
        // addressed to it, so a stale host cannot fork the simulation.
        if (!this.isAuthority() || envelope.to !== this.selfSeatId) return;
        if (!this.commandWindow.tryConsume(fromId, this.clock())) {
          console.warn(
            `[portals] ${fromId} exceeded ${MAX_COMMANDS_PER_SECOND} commands/s, dropped ${envelope.cmd.type}`,
          );
          return;
        }
        if (fromSeat !== undefined) this.applyCommandFrom(fromSeat, envelope.cmd);
        return;

      case "ev":
        if (fromSeat !== this.authoritySeatId) {
          console.warn("[portals] ignored events from non-authority", fromId);
          return;
        }
        for (const event of envelope.events) this.eventSignal.emit(event);
        return;

      case "pev":
        if (fromSeat !== this.authoritySeatId || envelope.to !== this.selfSeatId) return;
        if (envelope.privateState !== null) {
          this.setSync(this.sync.publicState, envelope.privateState);
        }
        for (const event of envelope.events) this.privateSignal.emit(event);
        for (const rejection of envelope.rejections) this.rejectionSignal.emit(rejection);
        return;

      case "snap":
        if (!this.isAuthority() || envelope.to !== this.selfSeatId) return;
        if (!this.forgeWindow.tryConsume(fromId, this.clock())) {
          console.warn(
            `[portals] ${fromId} exceeded ${MAX_FORGE_SNAPSHOTS_PER_SECOND} forge snapshots/s`,
          );
          return;
        }
        // A creep is a pose update: it produces events for the room and can be
        // refused for moving too fast or leaving the play volume, so both the
        // output and the refusal have to be routed like any other command.
        if (fromSeat !== undefined) this.applyForgeSnapshot(fromSeat, envelope.snapshot);
        return;

      case "paint":
        if (!this.isAuthority() || envelope.to !== this.selfSeatId) return;
        // Deliberately the same window the poses use: the simulation charges
        // both to one command budget, so giving paint a window of its own would
        // let a client alternate the two for twice the inbound rate.
        if (!this.forgeWindow.tryConsume(fromId, this.clock())) {
          console.warn(
            `[portals] ${fromId} exceeded ${MAX_FORGE_SNAPSHOTS_PER_SECOND} forge updates/s`,
          );
          return;
        }
        if (fromSeat !== undefined) this.applyPaintUpdate(fromSeat, envelope.paint);
        return;

      case "eye":
        // Only the host holds a validator anyone is asking, and only it should
        // be spending work on positions. A report addressed to a stale host is
        // dropped rather than applied, exactly as a command would be.
        if (!this.isAuthority() || envelope.to !== this.selfSeatId) return;
        if (!this.eyeWindow.tryConsume(fromId, this.clock())) {
          console.warn(
            `[portals] ${fromId} exceeded ${MAX_EYE_REPORTS_PER_SECOND} eye reports/s`,
          );
          return;
        }
        if (fromSeat !== undefined) this.options.onInspectorEye?.(fromSeat, envelope.eye);
        return;

      case "cam":
        if (fromSeat !== undefined && fromSeat !== this.selfSeatId) {
          this.cameraSignal.emit({ seatId: fromSeat, sample: envelope.sample });
        }
        return;

      case "resync": {
        // A resync costs the host a message, so it spends the sender's own
        // command allowance rather than being free to repeat.
        if (!this.isAuthority()) return;
        if (!this.commandWindow.tryConsume(fromId, this.clock())) return;
        // A joiner asks for its state as soon as it is listening, which is the
        // first moment a refusal can reliably reach it: the playerjoin the host
        // saw may well have arrived before the joiner attached its handlers.
        const refusal = this.refusedConnections.get(fromId);
        if (refusal !== undefined) {
          this.refuseConnection(fromId, refusal);
          return;
        }
        if (fromSeat !== undefined) this.pendingSync.add(fromSeat);
        return;
      }

      case "reforge":
        // Only the authority may ask, and only a client with work to give
        // answers. Re-sending costs one message each and restores what would
        // otherwise be lost with the host that recorded it. Paint made before
        // the lock is as unrecoverable as the pose, so it goes back too.
        if (fromSeat !== this.authoritySeatId || this.isAuthority()) return;
        if (this.lastForgeSnapshot !== null) this.sendForgeSnapshot(this.lastForgeSnapshot);
        this.pendingPaintResend = this.lastPaintUpdate;
        return;

      case "enter": {
        // Only this room's host seats anyone, and it does so from the message
        // rather than from the relay's arrival event, which says nothing about
        // which room the arrival meant.
        if (!this.isAuthority()) return;
        if (!this.commandWindow.tryConsume(fromId, this.clock())) return;
        const player = this.players.find((candidate) => candidate.id === fromId);
        if (player === undefined) return;
        this.connectionNames.set(fromId, this.connectionNames.get(fromId) ?? envelope.displayName);
        this.seatArrival(player);
        // A joiner reads the state keys as it enters, so publish as early as the
        // write cadence allows; the state event carries the rest moments later.
        this.maybeWriteSnapshot();
        this.publishAd();
        this.emitRoster();
        return;
      }

      case "exit": {
        if (!this.isAuthority() || fromSeat === undefined) return;
        if (this.seatOwners.get(fromSeat) !== fromId) return;
        // A deliberate departure is not a dropout: the seat is freed outright
        // rather than held through the reconnect grace, because the player is
        // still in the session and has chosen to be somewhere else.
        this.releaseSeat(fromSeat);
        this.applySim("removePlayer", (sim) => sim.removePlayer(fromSeat));
        this.publishAd();
        this.emitRoster();
        return;
      }

      case "refused":
        // Addressed by connection, so that only the tab that arrived second is
        // turned away when two share a seat.
        if (envelope.to !== this.selfConnectionId) return;
        this.roomCode = null;
        this.releaseAuthority();
        this.authoritySeatId = null;
        this.setStatus("error", refusalDetail(envelope.reason));
        return;
    }
  };

  /**
   * Someone opened the game. That is all it means: the session's one channel
   * carries every room, so an arrival has joined no match until it says which
   * one it wants, which is the `enter` envelope. All this does is give the new
   * connection a seat id to be addressed by.
   */
  private readonly handlePlayerJoin = (
    _player: PortalsNetPlayer,
    players: PortalsNetPlayer[],
  ): void => {
    this.players = players;
    this.indexSeats();
    this.resolveAuthority();
    this.emitRoster();
  };

  /**
   * Seats an arriving connection: a returning player inside their reconnect
   * grace resumes their slot, and anyone else takes a new one.
   *
   * Which of the two it is was already settled by `indexSeats`, which gives a
   * returning connection its account's own seat and a second live connection of
   * that account a seat of its own. All this has to do is ask the simulation
   * whether the seat it was handed is still holding a player.
   */
  private seatArrival(player: PortalsNetPlayer): void {
    const sim = this.sim;
    if (!sim) return;
    const seat = this.connectionSeats.get(player.id);
    if (seat === undefined) return;

    const holder = this.seatOwners.get(seat);
    if (holder !== undefined && holder !== player.id && this.connectionSeats.has(holder)) {
      // Two live connections on one seat, which seat assignment is supposed to
      // make impossible: a duplicate account takes a derived seat and no two
      // connections share an id. Reaching this means the relay contradicted
      // itself, so the newcomer is turned away rather than being let into
      // somebody else's role and disguise.
      this.refuseConnection(player.id, "duplicate_session", true);
      return;
    }

    this.seatOwners.set(seat, player.id);
    this.refusedConnections.delete(player.id);

    if (sim.getPrivateStateFor(seat) !== null) {
      // The slot survived the drop, so the player resumes their role and their
      // disguise rather than entering as a spectator (§27.9).
      this.applySim("markReconnected", (live) => live.markReconnected(seat, this.clock()));
      this.pendingSync.add(seat);
      return;
    }

    const displayName = this.connectionNames.get(player.id) ?? nameOf(player);
    const takeSeat = () =>
      this.applySim("addPlayer", (live) => live.addPlayer(seat, { displayName }));

    let seated = takeSeat();
    // A room the host filled out with bots gives one of them up rather than
    // refusing a person; `isRoomFull` let this connection through to ask.
    if (seated && !seated.accepted && seated.reason === "room_full" && this.freeBotSeat()) {
      seated = takeSeat();
    }
    if (seated && !seated.accepted) {
      this.seatOwners.delete(seat);
      this.refuseConnection(player.id, seated.reason ?? "rejected", true);
      return;
    }
    this.pendingSync.add(seat);
  }

  private readonly handlePlayerLeave = (
    player: PortalsNetPlayer,
    players: PortalsNetPlayer[],
  ): void => {
    const seat = this.connectionSeats.get(player.id) ?? baseSeatIdOf(player);
    this.players = players;
    this.indexSeats();
    this.refusedConnections.delete(player.id);
    this.commandWindow.forget(player.id);
    this.forgeWindow.forget(player.id);
    this.eyeWindow.forget(player.id);

    if (this.sim && this.isAuthority() && this.seatOwners.get(seat) === player.id) {
      this.releaseSeat(seat);
      // Hold the slot rather than dropping it. The simulation runs the grace
      // window and evicts the seat itself once it expires, and a return inside
      // that window is reattached by seatArrival.
      this.applySim("markDisconnected", (sim) => sim.markDisconnected(seat, this.clock()));
      this.publishAd();
    }
    this.resolveAuthority();
    this.emitRoster();
  };

  /**
   * Lets go of everything the host was holding for one seat. The eye goes with
   * it: a departed Inspector's last reported position is not where anybody is
   * standing, and keeping it would leave the validator answering for a ghost.
   */
  private releaseSeat(seat: string): void {
    this.options.onInspectorEye?.(seat, null);
    this.seatOwners.delete(seat);
    this.pendingSync.delete(seat);
    this.privateOutbox.delete(seat);
    this.pendingRejections.delete(seat);
  }

  /**
   * Re-reads the roster from the relay and settles who is authoritative. Used
   * when a message arrives that does not fit this client's view of the room.
   */
  private reconcileRoster(): void {
    this.players = this.net.players();
    this.indexSeats();
    this.resolveAuthority();
    this.emitRoster();
  }

  /**
   * Gives every live connection a seat, keeping the seats already handed out.
   *
   * A seat is decided once per connection and then never moves, because the
   * simulation keys a player's role, disguise and private queue on it.
   * Recomputing the whole map from the current roster would hand a second
   * connection its neighbour's slot the moment that neighbour left, which is a
   * player silently inheriting someone else's round.
   *
   * A signed-in player's first live connection takes their account id, and that
   * is what makes a reconnect land back in their own slot: once the old
   * connection is gone the account id is free again, so the returning one
   * claims it. A second connection made while the first is still live finds the
   * account id taken and gets `derivedSeatId` instead, so the room seats two
   * players rather than refusing one.
   *
   * Two rules settle which of a pair holds the account id on a client that was
   * not present when they arrived, and the first is exact. A derived seat names
   * the connection that owns it, so finding it among the seat ids in the
   * published roster identifies its holder outright and leaves the account id
   * for the other one. Failing that — no publication yet, or a duplicate that
   * arrived since the last one — the relay's player list is taken in order,
   * which is arrival order. The window where only the weaker rule applies is
   * one snapshot interval wide and closes as soon as the host publishes.
   */
  private indexSeats(): void {
    const live = new Set(this.players.map((player) => player.id));
    for (const connectionId of [...this.connectionSeats.keys()]) {
      if (live.has(connectionId)) continue;
      this.connectionSeats.delete(connectionId);
      this.connectionNames.delete(connectionId);
    }

    const publishedSeats = new Set([
      ...this.knownSeatIds,
      ...(this.lastSnapshot?.publicState.players ?? []).map((entry) => entry.seatId),
    ]);
    const undecided: PortalsNetPlayer[] = [];
    for (const player of this.players) {
      if (this.connectionSeats.has(player.id)) continue;
      if (publishedSeats.has(derivedSeatId(baseSeatIdOf(player), player.id))) {
        this.assignSeat(player, true);
      } else {
        undecided.push(player);
      }
    }
    for (const player of undecided) this.assignSeat(player, false);
  }

  /**
   * Records one connection's seat and the name it plays under. A second seat of
   * an account is numbered, because two rows reading "Bex" in the lobby is the
   * kind of ambiguity a player cannot resolve from the screen.
   */
  private assignSeat(player: PortalsNetPlayer, derived: boolean): void {
    const base = baseSeatIdOf(player);
    const takeDerived = derived || [...this.connectionSeats.values()].includes(base);
    if (!takeDerived) {
      this.connectionSeats.set(player.id, base);
      this.connectionNames.set(player.id, nameOf(player));
      return;
    }
    // Counted over the account's connection ids rather than over the seats
    // handed out so far, so the numeral does not depend on the order this
    // client happened to work them out in. The floor of two is the point of a
    // numeral at all: whoever holds the account id is the first, unnumbered.
    const earlier = this.players.filter(
      (other) => baseSeatIdOf(other) === base && other.id < player.id,
    ).length;
    this.connectionSeats.set(player.id, derivedSeatId(base, player.id));
    this.connectionNames.set(player.id, numberedName(nameOf(player), Math.max(2, earlier + 1)));
  }

  private readonly handleState = (key: string, value: unknown): void => {
    // The registry is read whatever room this client is in, and whether or not
    // it is in one at all: it is how a browser learns that a room opened, filled
    // up, started its round or went quiet.
    if (this.directory.observe(key, value, this.clock())) {
      this.checkAdOwnership();
      this.emitDirectory();
      return;
    }
    if (this.isAuthority() || this.roomCode === null) return;
    const keys = this.roomSlot.keys;
    const state = this.net.getState();

    if ((keys.pose as readonly string[]).includes(key)) {
      const poses = decodePoseBook(state, keys.pose);
      if (poses) {
        this.poseBook = poses;
        // The publication this client already holds described these disguises
        // without their geometry; fill it in now that the geometry has landed.
        if (this.lastSnapshot) this.setSync(this.withBodies(this.lastSnapshot), this.sync.privateState);
      }
      return;
    }

    if ((keys.paint as readonly string[]).includes(key)) {
      const paint = decodePaintBook(state, keys.paint);
      if (paint) {
        this.paintBook = paint;
        if (this.lastSnapshot) this.setSync(this.withBodies(this.lastSnapshot), this.sync.privateState);
      }
      return;
    }

    if ((keys.sim as readonly string[]).includes(key)) {
      // Held unparsed until this client actually has to take over. Reading it
      // eagerly would mean every client decoding the room's secrets on every
      // publish for no reason.
      const chunked = decodeChunks(state, keys.sim);
      if (chunked && chunked.seq >= this.lastSimSeq) {
        this.lastSimSeq = chunked.seq;
        this.lastSimSnapshot = chunked.value;
      }
      return;
    }

    if (!(keys.snapshot as readonly string[]).includes(key)) return;
    const snapshot = decodeHostPublication(state, keys.snapshot);
    if (!snapshot) return;
    if (this.lastSnapshot && snapshot.seq <= this.lastSnapshot.seq) return;
    this.lastSnapshot = snapshot;
    this.adoptSnapshotSeq(snapshot);
    this.setSync(this.withBodies(snapshot), this.sync.privateState);
  };

  private readonly handleStatus = (status: "connected" | "disconnected"): void => {
    if (status === "connected") {
      this.setStatus("connected", null);
      return;
    }
    // Portals does not reconnect on its own; the UI offers a rejoin that calls
    // join() again, which re-reads the state keys and requests a private sync.
    this.stopTimers();
    this.releaseAuthority();
    this.authoritySeatId = null;
    this.setStatus("disconnected", null);
  };

  // ------------------------------------------------------------------ authority

  /**
   * The seats this client believes are in its own room.
   *
   * Authority is elected inside a room, never across the session, so the
   * candidate set has to exclude the people browsing and the people playing next
   * door. Two sources agree on it: the room's published roster, which every
   * client has been holding all along, and — on the host, which is the only
   * client that knows it first-hand — the seats it has actually seated. Bots are
   * left out because no connection stands behind them, and a seat whose
   * connection has gone is left out because it cannot run anything.
   */
  private roomSeats(): string[] {
    if (this.roomCode === null) return [];
    const live = new Set(this.connectionSeats.values());
    const seats = new Set<string>();
    if (this.selfSeatId !== null) seats.add(this.selfSeatId);
    for (const player of this.lastSnapshot?.publicState.players ?? []) {
      if (!isBotSeat(player.seatId) && live.has(player.seatId)) seats.add(player.seatId);
    }
    for (const seat of this.seatOwners.keys()) {
      if (live.has(seat)) seats.add(seat);
    }
    return [...seats];
  }

  private resolveAuthority(): void {
    if (this.roomCode === null) {
      // Nobody is authoritative over a client that is only browsing.
      if (this.authoritySeatId === null) return;
      this.authoritySeatId = null;
      this.releaseAuthority();
      return;
    }
    const seats = this.roomSeats();
    const held = this.authoritySeatId !== null && seats.includes(this.authoritySeatId);
    const published = this.lastSnapshot?.authorityId;
    const next = held
      ? this.authoritySeatId
      : published !== undefined && seats.includes(published)
        ? published
        : ([...seats].sort()[0] ?? null);

    if (next === this.authoritySeatId) return;
    this.authoritySeatId = next;
    // A new host has never heard this client's eye, so the record of what was
    // already sent is worthless and the next flush states it again.
    this.sentEye = null;

    if (next !== null && next === this.selfSeatId) {
      this.assumeAuthority();
    } else {
      this.releaseAuthority();
      this.setStatus(this.connection.status);
    }
  }

  /**
   * Rebuilds an authoritative simulation on this client, resuming the round in
   * progress when the departed host left a snapshot this client can restore.
   *
   * The snapshot came from a peer, so it is untrusted no matter who wrote it:
   * it is validated against the simulation's own schema before any of it is
   * believed, and restore() validates again. If anything about it does not
   * hold, the room falls back to a lobby reset rather than running on state
   * nobody can vouch for.
   */
  private assumeAuthority(): void {
    if (this.sim || this.selfSeatId === null) return;

    const snapshot = this.lastSnapshot;
    // The publish counter is what every client uses to tell a newer snapshot
    // from an older one, so it has to keep climbing across a change of host.
    if (snapshot) this.adoptSnapshotSeq(snapshot);

    if (this.resumeFromSnapshot(snapshot)) return;

    const interrupted = snapshot !== null && snapshot.publicState.phase !== MatchPhase.Lobby;
    const settings = snapshot ? settingsPatchOf(snapshot.publicState.settings) : this.roomSettings;

    this.sim = new MatchSimulation(
      settings,
      this.options.seed ?? 1,
      this.options.spatial,
      this.options.objectRegistry,
    );
    this.seatOwners.clear();
    // Seated in a fixed order, so every client that could have taken over would
    // have built the same roster. Ordering by seat rather than by connection is
    // what makes that true of a room holding two connections of one account:
    // the seats are what the simulation records, and their order decides join
    // indexes and therefore role ranking.
    const arrivals = this.seatedConnections().sort((left, right) =>
      left.seat.localeCompare(right.seat),
    );
    for (const { seat, player } of arrivals) {
      const seated = this.applySim("addPlayer", (sim) =>
        sim.addPlayer(seat, {
          displayName: this.connectionNames.get(player.id) ?? nameOf(player),
          isHost: seat === this.selfSeatId,
        }),
      );
      if (seated && !seated.accepted) {
        this.refuseConnection(player.id, seated.reason ?? "rejected", true);
        continue;
      }
      this.seatOwners.set(seat, player.id);
      this.pendingSync.add(seat);
    }
    this.reseatBots(snapshot);

    this.startTimers();
    this.publishSnapshot();
    this.setStatus(
      this.connection.status,
      interrupted ? "authority_migrated_match_reset" : "authority_assumed",
    );
  }

  /**
   * Puts the room's bots back when the round itself could not be resumed.
   *
   * A lobby publishes no simulation snapshot at all — there is nothing worth
   * resuming and no reason to leave the room's secrets in shared state — so on
   * a change of host in the lobby this is the only record the bots have. It is
   * the published roster, which every client has been holding all along, and
   * the seats are taken in id order so that whichever client was promoted would
   * have built the same room.
   */
  private reseatBots(snapshot: HostPublication | null): void {
    if (snapshot === null) return;
    const bots = snapshot.publicState.players
      .filter((player) => isBotSeat(player.seatId))
      .sort((left, right) => left.seatId.localeCompare(right.seatId));

    for (const bot of bots) {
      const seated = this.applySim("reseat bot", (sim) =>
        sim.addPlayer(bot.seatId, { displayName: bot.displayName }),
      );
      if (seated === null || !seated.accepted) continue;
      this.botSeats.adopt([{ seatId: bot.seatId, displayName: bot.displayName }]);
    }
  }

  /**
   * Restores the round the departed host was running. Returns false when there
   * is nothing to restore or the snapshot cannot be trusted, leaving the caller
   * to fall back to a fresh lobby.
   */
  private resumeFromSnapshot(publication: HostPublication | null): boolean {
    if (this.lastSimSnapshot === null || publication === null) return false;

    const parsed = MatchSnapshotSchema.safeParse(this.lastSimSnapshot);
    if (!parsed.success) {
      console.warn("[portals] published simulation snapshot is not valid state, starting fresh");
      return false;
    }

    const seats = [...new Set(this.connectionSeats.values())];
    // Bots are players of the snapshot like any other, and no connection
    // vouches for them, so the successor has to name their seats itself or
    // restore() would treat every one of them as a player who had left.
    const bots = parsed.data.pl
      .filter((entry) => isBotSeat(entry.i))
      .map((entry) => ({ seatId: entry.i, displayName: entry.n }));

    let restored: MatchSimulation;
    try {
      restored = MatchSimulation.restore(parsed.data, {
        ...(this.options.spatial ? { spatial: this.options.spatial } : {}),
        // A snapshot names the map it belongs to, and restore() refuses one
        // that does not match the registry it is given, so the successor has to
        // be holding the same map the departed host was running.
        ...(this.options.objectRegistry ? { objectRegistry: this.options.objectRegistry } : {}),
        // Locked poses were omitted from the snapshot because they are already
        // in the public state this client has been holding all along.
        poses: this.withBodies(publication).disguises,
        seatedPlayerIds: [...seats, ...bots.map((bot) => bot.seatId)],
      });
    } catch (error) {
      console.warn("[portals] could not restore the published round, starting fresh", error);
      return false;
    }

    this.sim = restored;
    // Their seats survived; what has to be picked up again is the driving.
    this.botSeats.adopt(bots);
    this.seatOwners.clear();
    for (const { seat, player } of this.seatedConnections()) {
      if (!this.seatOwners.has(seat)) this.seatOwners.set(seat, player.id);
      this.pendingSync.add(seat);
    }

    this.startTimers();
    // Departures the previous host never saw leave the simulation as queued
    // events; the first tick drains them onto the wire.
    this.tick();
    this.publishSnapshot();

    const phase = restored.getPhase();
    if (phase === MatchPhase.Forge || phase === MatchPhase.Locking) {
      // Working poses were never public, so ask for them rather than lose them.
      this.rawSend({ v: PORTALS_PROTOCOL_VERSION, t: "reforge" });
      // The request reaches everyone except its sender, and the new host is a
      // player too: its own working pose has to be put back by hand. It goes
      // through the same path as any other creep, so the events it produces
      // reach the room and a refusal reaches this client's own UI.
      const ownSeat = this.selfSeatId;
      if (this.lastForgeSnapshot !== null && ownSeat !== null) {
        this.applyForgeSnapshot(ownSeat, this.lastForgeSnapshot);
      }
      // Paced a flush behind the pose, for the reason drainPaintResend gives.
      this.pendingPaintResend = this.lastPaintUpdate;
    }
    this.setStatus(this.connection.status, "authority_resumed");
    return true;
  }

  /**
   * Every connection in THIS ROOM paired with the seat it was given, in roster
   * order. The session's other connections are in another match or in none, and
   * a new host that seated them would pull the whole channel into its round.
   */
  private seatedConnections(): { seat: string; player: PortalsNetPlayer }[] {
    const members = new Set(this.roomSeats());
    const seated: { seat: string; player: PortalsNetPlayer }[] = [];
    for (const player of this.players) {
      const seat = this.connectionSeats.get(player.id);
      if (seat !== undefined && members.has(seat)) seated.push({ seat, player });
    }
    return seated;
  }

  private releaseAuthority(): void {
    this.sim = null;
    // The bots go with the simulation that was holding them. Their seats live
    // on in the published state, and whoever takes over seats them again.
    this.botSeats.clear();
    this.publicOutbox.length = 0;
    this.privateOutbox.clear();
    this.pendingSync.clear();
    this.pendingRejections.clear();
    this.seatOwners.clear();
    this.refusedConnections.clear();
    this.commandWindow.clear();
    this.forgeWindow.clear();
    this.eyeWindow.clear();
    // The next host publishes its own ranges, so it starts with a clean latch
    // and reports a fault of its own rather than inheriting this one's silence.
    this.oversizedRanges.clear();
    this.stopTickTimer();
  }

  private applyCommandFrom(seatId: string, command: MatchCommand): void {
    const result = this.applySim(`command ${command.type}`, (sim) =>
      sim.handleCommand(seatId, command),
    );
    if (result === null || result.accepted) return;
    this.reportRejection(seatId, rejectionOf(command.type, result.reason, result.detail));
  }

  /**
   * Feeds one Forge snapshot to the simulation, publishing what it produced and
   * returning any refusal to whoever sent it.
   */
  private applyForgeSnapshot(seatId: string, snapshot: ForgeSnapshot): void {
    const result = this.applySim("forge snapshot", (sim) =>
      sim.recordForgeSnapshot(seatId, snapshot.encodedPose, snapshot.revision, this.clock()),
    );
    if (result === null || result.accepted) return;
    this.reportRejection(seatId, rejectionOf("forge_snapshot", result.reason, result.detail));
  }

  /** The same, for a body-paint layer. */
  private applyPaintUpdate(seatId: string, update: PaintUpdate): void {
    const result = this.applySim("paint update", (sim) =>
      sim.recordPaintUpdate(seatId, update.encodedPaint, update.revision, this.clock()),
    );
    if (result === null || result.accepted) return;
    this.reportRejection(seatId, rejectionOf("paint_update", result.reason, result.detail));
  }

  /**
   * Reports events too large for a single 8 KB message. A dropped event leaves
   * a client's view diverged from the simulation with nothing in the room to
   * say so, which is the same silent fault an unpublishable key range is, so
   * the loss reaches the player it was addressed to. A public event has no one
   * addressee and is reported to the host that produced it.
   */
  private reportDroppedEvents(
    events: readonly { readonly type: string }[],
    seatId: string | null,
  ): void {
    for (const event of events) {
      const rejection = rejectionOf("event_dropped", "event_too_large", event.type);
      if (seatId === null || seatId === this.selfSeatId) this.rejectionSignal.emit(rejection);
      else this.reportRejection(seatId, rejection);
      console.error(`[portals] dropped ${event.type} event that cannot fit one 8 KB message`);
    }
  }

  /** Routes a refusal to the player who issued the command, and no one else. */
  private reportRejection(seatId: string, rejection: CommandRejection): void {
    if (seatId === this.selfSeatId) {
      this.rejectionSignal.emit(rejection);
      return;
    }
    const queue = this.pendingRejections.get(seatId) ?? [];
    if (queue.length >= MAX_REJECTIONS_PER_MESSAGE) return;
    queue.push(rejection);
    this.pendingRejections.set(seatId, queue);
  }

  /**
   * Runs one simulation call and publishes what it produced. Every entry point
   * the relay or a timer can reach goes through here: the simulation throws on
   * a few malformed inputs, and a throw inside a relay callback would take the
   * host's message pump down with it. The room keeps running on its last good
   * state instead, and the failure is reported rather than swallowed.
   */
  private applySim<T extends SimOutput>(
    label: string,
    call: (sim: MatchSimulation) => T,
  ): T | null {
    const sim = this.sim;
    if (!sim) return null;

    let output: T;
    try {
      output = call(sim);
    } catch (error) {
      console.error(`[portals] simulation failed on ${label}`, error);
      return null;
    }
    this.publishOutput(output);
    return output;
  }

  // --------------------------------------------------------------- publishing

  /**
   * Queues host-produced output for the wire and applies the host's own share
   * locally: the relay never echoes a message back to its sender, so the host
   * would otherwise never see its own simulation's output.
   *
   * The routing is the one the simulation prescribes. `public` is broadcast
   * verbatim and `private` is delivered only to the player it is keyed under,
   * so no redaction happens at this layer and none can be forgotten.
   */
  private publishOutput(output: SimOutput): void {
    if (this.selfSeatId === null) return;
    if (output.public.length === 0 && output.private.size === 0) return;

    this.botSeats.observe(output.public);
    this.publicOutbox.push(...output.public);
    for (const [seatId, events] of output.private) {
      if (seatId === this.selfSeatId || events.length === 0) continue;
      // A bot's private stream is read by the driver straight off the
      // simulation. Queueing it would spend a message per bot per flush
      // addressed to a seat no connection is listening on.
      if (isBotSeat(seatId)) continue;
      const queue = this.privateOutbox.get(seatId) ?? [];
      queue.push(...events);
      this.privateOutbox.set(seatId, queue);
      // A private event always changes the recipient's own view, so pair it
      // with a refreshed private state in the same message.
      this.pendingSync.add(seatId);
    }

    this.snapshotDirty = true;
    for (const event of output.public) this.eventSignal.emit(event);
    for (const event of output.private.get(this.selfSeatId) ?? []) this.privateSignal.emit(event);
    this.refreshAuthorityState();
  }

  private flush(): void {
    if (this.selfSeatId === null) return;
    this.drainPaintResend();
    this.drainEyeReport();
    const room = this.roomCode;
    if (!this.isAuthority() || room === null) return;
    this.publishAd();

    if (this.publicOutbox.length > 0) {
      const pending = coalesceDisguiseUpdates(
        this.publicOutbox.splice(0, this.publicOutbox.length),
      );
      const buildPublic = (events: SimEvent[]): Record<string, unknown> => ({
        v: PORTALS_PROTOCOL_VERSION,
        t: "ev",
        events,
      });
      const { batches, oversized } = batchEvents(pending, buildPublic);
      this.reportDroppedEvents(oversized, null);
      const unsent = this.sendBatches(batches, buildPublic);
      if (unsent.length > 0) this.publicOutbox.unshift(...unsent);
    }

    for (const seatId of this.privateRecipients()) {
      const pending = this.privateOutbox.get(seatId) ?? [];
      this.privateOutbox.delete(seatId);
      const rejections = this.pendingRejections.get(seatId) ?? [];
      this.pendingRejections.delete(seatId);
      const privateState = this.pendingSync.has(seatId)
        ? (this.sim?.getPrivateStateFor(seatId) ?? null)
        : null;
      if (pending.length === 0 && privateState === null && rejections.length === 0) {
        this.pendingSync.delete(seatId);
        continue;
      }
      const build = (events: PrivateSimEvent[]): Record<string, unknown> => ({
        v: PORTALS_PROTOCOL_VERSION,
        t: "pev",
        to: seatId,
        events,
        privateState,
        rejections,
      });

      const { batches, oversized } = batchEvents(pending, build);
      // Queued for the next message rather than this one, whose refusal list
      // was already fixed when `build` closed over it.
      this.reportDroppedEvents(oversized, seatId);
      // An empty batch still carries the private state and any refusals, so a
      // player whose role did not change but whose view did still gets one.
      const unsent = this.sendBatches(batches.length > 0 ? batches : [[]], build);
      if (unsent.length > 0) {
        this.privateOutbox.set(seatId, unsent);
        // Merged, not overwritten: a drop reported a moment ago has to survive
        // the refusals that could not be sent.
        this.pendingRejections.set(
          seatId,
          [...rejections, ...(this.pendingRejections.get(seatId) ?? [])].slice(
            0,
            MAX_REJECTIONS_PER_MESSAGE,
          ),
        );
        break;
      }
      this.pendingSync.delete(seatId);
    }

    this.maybeWriteSnapshot();
  }

  /**
   * Answers the paint half of a reforge, a flush after the pose half.
   *
   * The two are both forge updates and the simulation charges them to one rate
   * budget, so a client that answered with both in the same instant would have
   * the second refused and lose exactly the work the resend exists to save. A
   * flush is 100 ms and the budget allows one every 67 ms, so one apart is
   * enough. This runs on every client, host or not: the new host has to put its
   * own layer back too, and it is subject to the same limiter.
   */
  private drainPaintResend(): void {
    const update = this.pendingPaintResend;
    if (update === null) return;
    this.pendingPaintResend = null;
    this.sendPaintUpdate(update);
  }

  /**
   * Sends this client's eye to the host, at most once per flush and only when
   * it has moved.
   *
   * A client that has not been asked about its eye at all sends nothing, so a
   * Mimic never spends a message on a position the authority does not use. The
   * host is skipped for the reason `reportInspectorEye` gives.
   */
  private drainEyeReport(): void {
    if (!this.eyeReported || this.isAuthority() || this.authoritySeatId === null) return;
    if (this.roomCode === null) return;
    const eye = this.pendingEye;
    if (eyesAgree(eye, this.sentEye)) return;
    if (
      !this.rawSend({
        v: PORTALS_PROTOCOL_VERSION,
        t: "eye",
        to: this.authoritySeatId,
        eye,
      })
    ) {
      return;
    }
    this.sentEye = eye;
  }

  /**
   * Publishes the authoritative snapshot a successor would restore from.
   *
   * Poses are omitted: locked ones are already in the public state, and that
   * keeps a full room to about 5 KB rather than 98 KB. The simulation refuses
   * to omit while a Mimic has a working pose that exists nowhere else, which is
   * normal for part of the Forge; the previous snapshot stays in place and the
   * successor recovers those poses by asking for them.
   */
  private publishSimSnapshot(sim: MatchSimulation): void {
    if (sim.getPhase() === MatchPhase.Lobby) {
      // Nothing worth resuming, and no reason to leave the room's secrets in
      // shared state between rounds.
      this.clearSimSnapshot();
      return;
    }

    // A working Forge pose exists only in the authority until it is locked.
    // Holding the previous compact snapshot is intentional in that window;
    // checking first avoids turning the expected Locking grace state into a
    // recurring warning while still leaving snapshot()'s hard safety check in
    // place for every other caller.
    if (!sim.canOmitSnapshotPoses()) return;

    let snapshot: unknown;
    try {
      snapshot = sim.snapshot({ poses: "omit" });
    } catch (error) {
      // Expected while a working pose is outstanding. Reported at most once a
      // second so a whole Forge phase does not fill the console.
      if (this.clock() - this.simSnapshotBlockedAt >= RATE_WINDOW_MS) {
        this.simSnapshotBlockedAt = this.clock();
        console.warn("[portals] holding the previous authoritative snapshot", error);
      }
      return;
    }

    this.lastSimSeq += 1;
    if (this.writeChunked(snapshot, this.lastSimSeq, this.roomSlot.keys.sim, "simulation snapshot") === "written") {
      this.lastSimSnapshot = snapshot;
    }
  }

  /** Writes the locked poses, and only when the set of them has changed. */
  private publishPoses(disguises: PublicMatchState["disguises"]): void {
    const book: PoseBook = {};
    for (const disguise of disguises) {
      if (disguise.encodedPose.length > 0) book[disguise.publicObjectId] = disguise.encodedPose;
    }
    const serialized = JSON.stringify(book);
    if (serialized === this.lastPoseSerialized) return;

    this.poseSeq += 1;
    if (this.writeChunked(book, this.poseSeq, this.roomSlot.keys.pose, "locked poses") === "written") {
      this.poseBook = book;
      this.lastPoseSerialized = serialized;
    }
  }

  /** Writes the body-paint layers, and only when the set of them has changed. */
  private publishPaint(disguises: PublicMatchState["disguises"]): void {
    const book: PaintBook = {};
    for (const disguise of disguises) {
      const paint = disguise.encodedPaint;
      if (paint !== null && paint.length > 0) book[disguise.publicObjectId] = paint;
    }
    const serialized = JSON.stringify(book);
    if (serialized === this.lastPaintSerialized) return;

    this.paintSeq += 1;
    if (this.writeChunked(book, this.paintSeq, this.roomSlot.keys.paint, "body paint") === "written") {
      this.paintBook = book;
      this.lastPaintSerialized = serialized;
    }
  }

  /**
   * A publication as its reader should see it, with the pose and paint bodies
   * put back from the key ranges that carry them.
   */
  private withBodies(publication: HostPublication): PublicMatchState {
    const state = publication.publicState;
    return {
      ...state,
      disguises: state.disguises.map((entry) => ({
        ...entry,
        encodedPose:
          entry.encodedPose.length > 0
            ? entry.encodedPose
            : (this.poseBook[entry.publicObjectId] ?? ""),
        encodedPaint: entry.encodedPaint ?? this.paintBook[entry.publicObjectId] ?? null,
      })),
    };
  }

  private clearSimSnapshot(): void {
    if (this.lastSimSnapshot === null) return;
    this.lastSimSnapshot = null;
    this.lastSimSeq += 1;
    // A one-chunk empty marker supersedes whatever was there, since the relay
    // has no delete.
    this.writeChunked(null, this.lastSimSeq, this.roomSlot.keys.sim, "simulation snapshot");
  }

  /**
   * Chunks a value across one key range.
   *
   * The two ways this fails are not the same failure. "deferred" means the
   * write budget for this second is spent and the caller will try again in a
   * moment, which is routine. "too_large" means the value will never fit the
   * keys it owns, so the range stops updating for the whole room while every
   * client that produced part of it goes on rendering its own copy correctly.
   * That one is reported to the players it affects rather than logged.
   */
  private writeChunked(
    value: unknown,
    seq: number,
    keys: readonly string[],
    label: string,
  ): "written" | "deferred" | "too_large" {
    const chunks = encodeChunks(value, seq, keys.length);
    if (!chunks) {
      this.reportOversizedRange(label, keys.length);
      return "too_large";
    }
    this.oversizedRanges.delete(label);
    // Every key costs a write, and the relay counts them across all of them.
    for (let index = 0; index < chunks.length; index += 1) {
      if (!this.stateWindow.tryConsume(this.clock())) {
        console.warn(`[portals] state write budget reached, deferring ${label}`);
        return "deferred";
      }
      const key = keys[index];
      const chunk = chunks[index];
      if (key !== undefined && chunk !== undefined) this.net.setState(key, chunk);
    }
    return "written";
  }

  /**
   * Tells the room that one key range has stopped publishing. Everyone is
   * affected, because everyone reads that range, so everyone hears about it:
   * this is exactly the fault whose signature is a client looking correct to
   * itself and invisible to the rest of the room. Latched, since the condition
   * persists across every subsequent publish attempt.
   */
  private reportOversizedRange(label: string, keyCount: number): void {
    if (this.oversizedRanges.has(label)) return;
    this.oversizedRanges.add(label);
    const rejection = rejectionOf("state_publish", "range_too_large", label);
    this.rejectionSignal.emit(rejection);
    for (const seatId of this.seatOwners.keys()) {
      if (seatId !== this.selfSeatId) this.reportRejection(seatId, rejection);
    }
    console.error(`[portals] ${label} exceeds the ${keyCount}-key budget and cannot publish`);
  }

  /**
   * Writes this room's advertisement, which is the whole of what a player
   * browsing the session can see of it.
   *
   * Only the room's host writes it, and only to its own slot's key, so the two
   * rooms in a session never overwrite each other under last-write-wins.
   *
   * It goes out on either of two conditions. Anything a browser can read having
   * changed — a player arriving, the round starting — is published at once,
   * because a room browser that is three seconds behind sends people to a room
   * that filled up while they were reading it. Nothing having changed still
   * publishes on the heartbeat, because the beat is what tells every other
   * client the room is alive at all: a reader retires a room whose counter has
   * stopped moving, measured on the reader's own clock, since the session has no
   * clock the two of them share.
   */
  private publishAd(force = false): void {
    if (!this.isAuthority() || this.roomCode === null || this.selfSeatId === null) return;

    const state = this.sim?.getPublicState();
    const body = {
      v: PORTALS_PROTOCOL_VERSION,
      code: this.roomCode,
      name: this.roomName,
      host: this.selfSeatId,
      slot: this.roomSlot.index,
      players: state?.players.length ?? 1,
      bots: state?.players.filter((player) => isBotSeat(player.seatId)).length ?? 0,
      maxPlayers: Math.min(
        state?.settings.maxPlayers ?? this.roomSlot.maxPlayers,
        this.roomSlot.maxPlayers,
      ),
      seekers: state?.settings.seekerCount ?? DEFAULT_MATCH_SETTINGS.seekerCount,
      phase: state?.phase ?? MatchPhase.Lobby,
    } as const;

    const nowMs = this.clock();
    const serialized = JSON.stringify(body);
    const changed = serialized !== this.lastAdBody;
    if (!force && !changed && nowMs - this.lastAdAt < ROOM_HEARTBEAT_MS) return;
    if (!this.stateWindow.tryConsume(nowMs)) return;

    this.adBeat += 1;
    this.lastAdAt = nowMs;
    this.lastAdBody = serialized;
    const ad: RoomAd = { ...body, beat: this.adBeat };
    this.net.setState(this.roomSlot.adKey, ad);
    // Apply our own write synchronously. Portals does not promise sender echo,
    // and making the creator wait for one was the reason its own browser could
    // keep reading zero rooms after OPEN.
    this.directory.observe(this.roomSlot.adKey, ad, nowMs);
    this.emitDirectory();
    // Peers get a live copy even when an editor host misses the state callback;
    // late joiners still discover the durable setState value above.
    this.rawSend({ v: PORTALS_PROTOCOL_VERSION, t: "ad", ad });
  }

  /** Frees this room's slot at once, rather than leaving it to time out. */
  private retireAd(): void {
    if (this.roomCode === null) return;
    this.directory.forget(this.roomSlot.index);
    this.net.setState(this.roomSlot.adKey, VACANT_SLOT);
  }

  /**
   * Gives up a slot this client lost the race for.
   *
   * Two clients can open a room in the same instant and pick the same free slot,
   * and the relay settles it the only way it can: last write wins, so one of the
   * two advertisements is simply gone. The loser finds a stranger's room on the
   * key it thought it owned, and has to stand down rather than go on publishing
   * a match nobody can find into keys another room is using.
   */
  private checkAdOwnership(): void {
    if (this.roomCode === null || !this.isAuthority()) return;
    const mine = this.directory
      .list(this.clock())
      .find((room) => room.slot === this.roomSlot.index);
    if (mine === undefined || mine.code === this.roomCode) return;

    console.warn(`[portals] lost room slot ${this.roomSlot.index} to ${mine.code}, standing down`);
    const lost = this.roomCode;
    this.roomCode = null;
    this.authoritySeatId = null;
    this.releaseAuthority();
    this.resetRoomState();
    this.rejectionSignal.emit(rejectionOf("create_room", "slot_taken", lost));
    this.setStatus(this.connection.status, null);
    this.emitRoster();
  }

  private emitDirectory(): void {
    this.directorySignal.emit(this.directory.list(this.clock()));
  }

  private adoptSnapshotSeq(snapshot: HostPublication): void {
    this.snapshotSeq = Math.max(this.snapshotSeq, snapshot.seq);
  }

  /** Publishes at most SNAPSHOT_WRITES_PER_SECOND times, and only when stale. */
  private maybeWriteSnapshot(): void {
    if (!this.snapshotDirty) return;
    if (this.clock() - this.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    this.publishSnapshot();
  }

  /** Sends batches in order, returning the events it could not fit in the budget. */
  private sendBatches<E extends SimEvent | PrivateSimEvent>(
    batches: E[][],
    build: (events: E[]) => Record<string, unknown>,
  ): E[] {
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index] as E[];
      if (this.rawSend(build(batch))) continue;
      return batches.slice(index).flat();
    }
    return [];
  }

  /** Every seat with queued private events, refusals, or a stale private view. */
  private privateRecipients(): string[] {
    const recipients = new Set([
      ...this.privateOutbox.keys(),
      ...this.pendingRejections.keys(),
      ...this.pendingSync,
    ]);
    recipients.delete(this.selfSeatId ?? "");
    return [...recipients];
  }

  /**
   * Turns one connection away. Addressed by connection rather than seat so that
   * a second tab is refused without disturbing the tab already playing.
   */
  private refuseConnection(connectionId: string, reason: string, remember = false): void {
    if (remember) this.refusedConnections.set(connectionId, reason);
    console.warn(`[portals] refused connection ${connectionId}: ${reason}`);
    this.rawSend({ v: PORTALS_PROTOCOL_VERSION, t: "refused", to: connectionId, reason });
  }

  private requestResync(): void {
    this.rawSend({ v: PORTALS_PROTOCOL_VERSION, t: "resync" });
  }

  /**
   * The single exit to the relay. Enforces the 8 KB and ~20/s ceilings.
   *
   * It takes a whole envelope rather than any object, so that every message
   * naming the room it belongs to is a compile-time fact rather than a habit:
   * an envelope sent without one would be dropped by every client in the
   * session, silently, and only in a session that had more than one room.
   */
  private rawSend(body: Record<string, unknown>): boolean {
    const room = this.roomCode;
    // Nothing leaves a client that is not in a room: there is no match for it
    // to belong to, and an unaddressed envelope would be dropped by everyone.
    if (room === null) return false;
    const payload = { ...body, r: room };
    const bytes = jsonByteLength(payload);
    if (bytes > MAX_PAYLOAD_BYTES) {
      console.warn(`[portals] dropped ${bytes} byte message over the ${MAX_PAYLOAD_BYTES} byte limit`);
      return false;
    }
    if (!this.sendWindow.tryConsume(this.clock())) {
      console.warn("[portals] send rate limit reached, deferring");
      return false;
    }
    this.net.send(payload);
    return true;
  }

  private publishSnapshot(): void {
    const sim = this.sim;
    if (!sim || this.selfSeatId === null) return;

    const publicState = sim.getPublicState();
    this.publishPoses(publicState.disguises);
    this.publishPaint(publicState.disguises);

    this.snapshotSeq += 1;
    const snapshot: HostPublication = {
      v: PORTALS_PROTOCOL_VERSION,
      seq: this.snapshotSeq,
      authorityId: this.selfSeatId,
      // Pose and paint bodies are stripped here and carried on their own key
      // ranges; the publication keeps only what changes from one publish to the
      // next, which is what holds a full room inside four keys at 2 Hz.
      publicState: {
        ...publicState,
        disguises: publicState.disguises.map((entry) => ({
          ...entry,
          encodedPose: "",
          encodedPaint: null,
        })),
      },
    };
    if (this.writeChunked(snapshot, this.snapshotSeq, this.roomSlot.keys.snapshot, "public state") !== "written") {
      return;
    }
    this.lastSnapshot = snapshot;
    this.lastSnapshotAt = this.clock();
    this.snapshotDirty = false;
    // Locally the host has the real thing, so its own view keeps the geometry.
    this.setSync(publicState, this.sync.privateState);
    this.publishSimSnapshot(sim);
  }

  // ------------------------------------------------------------------ delivery

  /**
   * The host reads its own simulation directly rather than waiting for the
   * snapshot it is about to publish, so its view never lags the 2 Hz cadence
   * that remote clients live with.
   */
  private refreshAuthorityState(): void {
    const sim = this.sim;
    if (!sim || !this.isAuthority() || this.selfSeatId === null) return;
    this.setSync(sim.getPublicState(), sim.getPrivateStateFor(this.selfSeatId));
  }

  private setSync(
    publicState: MatchSync["publicState"],
    privateState: PrivateMatchState | null,
  ): void {
    this.sync = { publicState, privateState };
    this.syncSignal.emit(this.sync);
  }

  private emitRoster(): void {
    this.rosterSignal.emit(this.getRoster());
  }

  /** Omitting `detail` carries the current reason forward across a status change. */
  private setStatus(status: ConnectionStatus, detail: ConnectionDetail = this.connection.detail): void {
    this.connection = {
      mode: "portals",
      status,
      selfId: this.selfSeatId,
      authorityId: this.authoritySeatId,
      canRejoin: status === "disconnected" || status === "error",
      detail,
    };
    this.statusSignal.emit(this.connection);
  }

  // -------------------------------------------------------------------- timers

  private attachListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    this.net.on("message", this.handleMessage);
    this.net.on("playerjoin", this.handlePlayerJoin);
    this.net.on("playerleave", this.handlePlayerLeave);
    this.net.on("state", this.handleState);
    this.net.on("status", this.handleStatus);
  }

  private detachListeners(): void {
    if (!this.listenersAttached) return;
    this.listenersAttached = false;
    this.net.off("message", this.handleMessage);
    this.net.off("playerjoin", this.handlePlayerJoin);
    this.net.off("playerleave", this.handlePlayerLeave);
    this.net.off("state", this.handleState);
    this.net.off("status", this.handleStatus);
  }

  private startTimers(): void {
    if (this.flushTimer === null) {
      this.flushTimer = setInterval(() => {
        this.flush();
      }, FLUSH_INTERVAL_MS);
    }
    if (this.tickTimer === null && this.isAuthority()) {
      this.tickTimer = setInterval(() => {
        this.tick();
      }, Math.round(1_000 / this.tickHz));
    }
  }

  private stopTickTimer(): void {
    if (this.tickTimer === null) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private stopTimers(): void {
    this.stopTickTimer();
    if (this.flushTimer === null) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  /** One authoritative step. The interval calls this; tests drive it directly. */
  tick(): void {
    const sim = this.sim;
    if (!sim || !this.isAuthority()) return;
    // One reading drives the whole step: a bot measures how much of the match
    // it has to catch up on against the clock the phase machine was just
    // advanced to, so a second reading would judge it in a different moment.
    const nowMs = this.clock();
    this.applySim("tick", () => sim.tick(nowMs));
    this.botSeats.drive(sim, nowMs, this.botSink);
    this.flush();
  }
}

/** Envelopes only the elected host may send, and which a stale view would drop. */
const AUTHORITY_ONLY: ReadonlySet<NetEnvelope["t"]> = new Set(["ev", "pev", "reforge"]);

function rejectionOf(type: string, reason?: string, detail?: string): CommandRejection {
  const body = reason ?? "rejected";
  return detail === undefined ? { type, reason: body } : { type, reason: body, detail };
}

/**
 * Collapses a batch's `disguise_updated` events to one per object.
 *
 * A creeping hider produces one of these per simulation tick, so a full roster
 * can generate well over a hundred a second. Only the newest revision of an
 * object describes where it is now, and the older ones would be overwritten the
 * moment they arrived, so sending them costs budget and buys nothing. The
 * `moved` flag is carried forward from any event that set it: a renderer that
 * only learned about the final reshape would otherwise miss that the root
 * travelled on the way there.
 *
 * Everything else keeps its order and its place; the surviving event for an
 * object sits where that object's newest update was.
 */
export function coalesceDisguiseUpdates(events: readonly SimEvent[]): SimEvent[] {
  const newest = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "disguise_updated") continue;
    const previous = newest.get(event.publicObjectId);
    if (previous === undefined || event.revision >= previous) {
      newest.set(event.publicObjectId, event.revision);
    }
  }
  if (newest.size === 0) return [...events];

  const movedObjects = new Set<string>();
  for (const event of events) {
    if (event.type === "disguise_updated" && event.moved) movedObjects.add(event.publicObjectId);
  }

  const kept: SimEvent[] = [];
  const emitted = new Set<string>();
  // Walked backwards so "newest" means the last one in the batch when two share
  // a revision, then reversed to put the batch back in order.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SimEvent;
    if (event.type !== "disguise_updated") {
      kept.push(event);
      continue;
    }
    if (emitted.has(event.publicObjectId)) continue;
    if (event.revision !== newest.get(event.publicObjectId)) continue;
    emitted.add(event.publicObjectId);
    kept.push(
      movedObjects.has(event.publicObjectId) && !event.moved ? { ...event, moved: true } : event,
    );
  }
  return kept.reverse();
}

/** Millimetres. Finer than any check the authority makes, and shorter on the wire. */
function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

/**
 * The seat a connection takes when nobody else is holding its account's.
 * Signed-in players get an id that is stable across reconnections, which is
 * what a rejoin lands on; a guest has none, so their connection stands in and
 * two guest tabs have always been two players.
 */
export function baseSeatIdOf(player: PortalsNetPlayer): string {
  return player.playerId ?? player.id;
}

/**
 * The seat a second live connection of one account takes.
 *
 * The connection id is kept whole and the account id is trimmed to fit, because
 * the connection id is what makes the seat unique: two accounts whose ids share
 * a prefix would collide if the trimming went the other way, while no two live
 * connections ever share an id. The result must fit `LIMITS.idLength`, which is
 * the bound every schema carrying a seat applies, and the protocol already
 * holds connection ids to the same length.
 */
export function derivedSeatId(baseSeatId: string, connectionId: string): string {
  const suffix = `${DERIVED_SEAT_SEPARATOR}${connectionId}`;
  const room = Math.max(0, LIMITS.idLength - suffix.length);
  return `${baseSeatId.slice(0, room)}${suffix}`.slice(0, LIMITS.idLength);
}

/**
 * Marks the second and later seats of one account, within the name length the
 * public state allows.
 */
function numberedName(name: string, ordinal: number): string {
  const mark = ` (${ordinal})`;
  return `${name.slice(0, Math.max(1, LIMITS.displayNameLength - mark.length))}${mark}`.slice(
    0,
    LIMITS.displayNameLength,
  );
}

function refusalDetail(reason: string): ConnectionDetail {
  if (reason === "room_full") return "room_full";
  if (reason === "duplicate_session") return "duplicate_session";
  return "join_failed";
}

/**
 * Every seat the session has already handed out, read from all rooms at once.
 * `indexSeats` needs it before this client has entered a room of its own, and
 * one pass over the state map at join is the whole cost of having it.
 */
function publishedSeatIds(state: Record<string, unknown>): ReadonlySet<string> {
  const seats = new Set<string>();
  for (const slot of ROOM_SLOTS) {
    const publication = decodeHostPublication(state, slot.keys.snapshot);
    for (const player of publication?.publicState.players ?? []) seats.add(player.seatId);
  }
  return seats;
}

/** What a room is called when its host never named it. */
function defaultRoomName(displayName: string): string {
  const owner = displayName.trim();
  return owner.length > 0 ? `${owner}'s room` : "The Curiosity Shop";
}

function mergeSelf(players: PortalsNetPlayer[], self: PortalsNetPlayer): PortalsNetPlayer[] {
  return players.some((player) => player.id === self.id) ? [...players] : [...players, self];
}

function nameOf(player: PortalsNetPlayer): string {
  return player.displayName ?? `Visitor ${player.id.slice(0, 4)}`;
}

/**
 * A snapshot carries the full settings block; MatchSimulation only accepts the
 * host-settable subset, so the rest is dropped rather than forced back in. The
 * return type is the complete subset, so a key added to SETTABLE_SETTING_KEYS
 * upstream fails the build here instead of being silently lost on migration.
 */
function settingsPatchOf(settings: MatchSettings): Required<MatchSettingsPatch> {
  return {
    maxPlayers: settings.maxPlayers,
    seekerCount: settings.seekerCount,
    mapIntroMs: settings.mapIntroMs,
    roleRevealMs: settings.roleRevealMs,
    baselineScanMs: settings.baselineScanMs,
    forgeMs: settings.forgeMs,
    lockGraceMs: settings.lockGraceMs,
    inspectionIntroMs: settings.inspectionIntroMs,
    inspectionMs: settings.inspectionMs,
    revealMs: settings.revealMs,
    resultsMs: settings.resultsMs,
    rematchVoteMs: settings.rematchVoteMs,
    warrantsBonus: settings.warrantsBonus,
    wrongAccusationCooldownMs: settings.wrongAccusationCooldownMs,
    reconnectGraceMs: settings.reconnectGraceMs,
  };
}
