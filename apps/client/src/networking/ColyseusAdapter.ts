import type { MatchCommand, PrivateSimEvent, SimEvent } from "@foldseek/game-sim";
import { eyesAgree, LIMITS, PrivateSimEventSchema, SimEventSchema } from "@foldseek/shared";
import { z } from "zod";
import {
  EMPTY_SYNC,
  idleConnection,
  type CommandRejection,
  type ConnectionDetail,
  type ConnectionState,
  type ConnectionStatus,
  type EyePosition,
  type ForgeSnapshot,
  type MatchSync,
  type NetworkAdapter,
  type PaintUpdate,
  type RosterEntry,
  type Unsubscribe,
} from "./NetworkAdapter";
import { Signal } from "./signal";
import { parseCommandRejection, parsePrivateState, parsePublicState } from "./stateSchemas";

/**
 * colyseus.js client for the dedicated server. The server holds authority, so
 * this adapter only validates, forwards, and republishes.
 *
 * colyseus.js is imported dynamically: the Portals bundle never reaches this
 * file at runtime, and the dynamic boundary keeps the websocket client out of
 * that build.
 */

/** Mirrors SERVER_MESSAGE in apps/server/src/rooms/MatchRoom.ts. */
const SERVER_MESSAGE = {
  simEvents: "sim_events",
  privateEvents: "private_events",
  privateState: "private_state",
  publicState: "public_state",
  commandRejected: "command_rejected",
} as const;

/** Mirrors FORGE_SNAPSHOT_MESSAGE in apps/server/src/rooms/MatchRoom.ts. */
const FORGE_SNAPSHOT_MESSAGE = "forge_snapshot";

/** Mirrors PAINT_UPDATE_MESSAGE in apps/server/src/rooms/MatchRoom.ts. */
const PAINT_UPDATE_MESSAGE = "paint_update";

/** Mirrors INSPECTOR_EYE_MESSAGE in apps/server/src/rooms/MatchRoom.ts. */
const INSPECTOR_EYE_MESSAGE = "eye";

const MAX_EVENTS_PER_MESSAGE = 256;
const SimEventListSchema = z.array(SimEventSchema).max(MAX_EVENTS_PER_MESSAGE);
const PrivateSimEventListSchema = z.array(PrivateSimEventSchema).max(MAX_EVENTS_PER_MESSAGE);

const RosterPlayerSchema = z.object({
  publicId: z.string().min(1).max(LIMITS.idLength),
  displayName: z.string().max(LIMITS.displayNameLength),
  isHost: z.boolean(),
});

/**
 * The parts of colyseus.js this adapter uses. Declared structurally so the
 * dynamic import stays behind one cast instead of leaking through the file.
 */
interface ColyseusRoomLike {
  readonly sessionId: string;
  readonly state: unknown;
  send(type: string, payload?: unknown): void;
  leave(consented?: boolean): Promise<number>;
  onMessage(type: string, handler: (message: unknown) => void): unknown;
  onStateChange(handler: (state: unknown) => void): unknown;
  onLeave(handler: (code: number) => void): unknown;
  onError(handler: (code: number, message?: string) => void): unknown;
}

interface ColyseusClientLike {
  joinOrCreate(roomName: string, options?: Record<string, unknown>): Promise<ColyseusRoomLike>;
}

export interface ColyseusAdapterOptions {
  readonly endpoint: string;
  /** Room name registered with gameServer.define(). */
  readonly roomName?: string;
}

export const DEFAULT_ROOM_NAME = "match";

export class ColyseusAdapter implements NetworkAdapter {
  readonly mode = "colyseus" as const;

  private readonly options: ColyseusAdapterOptions;
  private readonly eventSignal = new Signal<SimEvent>();
  private readonly privateSignal = new Signal<PrivateSimEvent>();
  private readonly rejectionSignal = new Signal<CommandRejection>();
  private readonly rosterSignal = new Signal<readonly RosterEntry[]>();
  private readonly statusSignal = new Signal<ConnectionState>();
  private readonly syncSignal = new Signal<MatchSync>();

  private client: ColyseusClientLike | null = null;
  private room: ColyseusRoomLike | null = null;
  private roster: RosterEntry[] = [];
  private connection: ConnectionState = idleConnection("colyseus");
  private sync: MatchSync = EMPTY_SYNC;
  private selfPublicId: string | null = null;
  private sentEye: EyePosition | null = null;
  /** Whether an eye has ever been reported: null is a value, not "unknown". */
  private eyeSent = false;
  private disposed = false;

  constructor(options: ColyseusAdapterOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("ColyseusAdapter was disposed");
    if (this.client) return;
    const module = await import("colyseus.js");
    this.client = new module.Client(this.options.endpoint) as unknown as ColyseusClientLike;
  }

  async join(room: string, displayName: string): Promise<ConnectionState> {
    await this.connect();
    const client = this.client;
    if (!client) throw new Error("colyseus client unavailable");

    this.setStatus("connecting", null);
    try {
      this.room = await client.joinOrCreate(room || this.options.roomName || DEFAULT_ROOM_NAME, {
        displayName,
      });
    } catch (error) {
      this.setStatus("error", "join_failed");
      throw error;
    }

    this.attach(this.room);
    this.setStatus("connected", null);
    return this.connection;
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.roster = [];
    this.sync = EMPTY_SYNC;
    this.selfPublicId = null;
    // A room this client rejoins has never heard its eye, so the record of what
    // was already sent is dropped and the next report goes out in full.
    this.sentEye = null;
    this.eyeSent = false;
    this.syncSignal.emit(this.sync);
    this.rosterSignal.emit(this.roster);
    this.setStatus("closed", null);
    if (room) await room.leave(true);
  }

  dispose(): void {
    this.disposed = true;
    void this.room?.leave(true);
    this.room = null;
    this.client = null;
    this.eventSignal.clear();
    this.privateSignal.clear();
    this.rejectionSignal.clear();
    this.rosterSignal.clear();
    this.statusSignal.clear();
    this.syncSignal.clear();
  }

  sendCommand(command: MatchCommand): void {
    const room = this.room;
    if (!room) {
      console.warn("[colyseus] command while not joined, ignoring", command.type);
      return;
    }
    // The message name is the command's own type, so the server can reject a
    // payload whose body disagrees with the channel it arrived on.
    room.send(command.type, command);
  }

  sendForgeSnapshot(snapshot: ForgeSnapshot): void {
    this.room?.send(FORGE_SNAPSHOT_MESSAGE, snapshot);
  }

  sendPaintUpdate(update: PaintUpdate): void {
    this.room?.send(PAINT_UPDATE_MESSAGE, update);
  }

  /**
   * Reports where this client's Inspector is looking from.
   *
   * The server checks range and line of sight from an eye position and refuses
   * `inspector_position_unknown` for a player it has never been told about, so
   * without this every shot this client fires is refused. It is the same report
   * `PortalsNetAdapter.reportInspectorEye` sends over the relay, and a round
   * feeds both from the one place that knows: the `RoundSpatialBridge`
   * observer, which fires on every local eye write.
   *
   * The room writes into a map and answers nothing, so this is called on the
   * round's own cadence rather than per frame, and an eye that has not moved
   * far enough to change a decision is not sent at all: an Inspector standing
   * still would otherwise spend a message a tick restating where they already
   * are. Null forgets the eye, which is what the round reports when this client
   * stops being an Inspector.
   */
  reportInspectorEye(eye: EyePosition | null): void {
    const rounded = eye === null ? null : ([round3(eye[0]), round3(eye[1]), round3(eye[2])] as const);
    if (this.eyeSent && eyesAgree(rounded, this.sentEye)) return;
    this.eyeSent = true;
    this.sentEye = rounded;
    this.room?.send(INSPECTOR_EYE_MESSAGE, { eye: rounded });
  }

  getSelfId(): string | null {
    return this.room?.sessionId ?? null;
  }

  getConnection(): ConnectionState {
    return this.connection;
  }

  getRoster(): readonly RosterEntry[] {
    return this.roster;
  }

  getSync(): MatchSync {
    return this.sync;
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

  private attach(room: ColyseusRoomLike): void {
    room.onMessage(SERVER_MESSAGE.simEvents, (message) => {
      const parsed = SimEventListSchema.safeParse(message);
      if (!parsed.success) {
        console.warn("[colyseus] dropped malformed event batch");
        return;
      }
      const events: SimEvent[] = parsed.data;
      for (const event of events) this.eventSignal.emit(event);
    });
    room.onMessage(SERVER_MESSAGE.privateEvents, (message) => {
      const parsed = PrivateSimEventListSchema.safeParse(message);
      if (!parsed.success) {
        console.warn("[colyseus] dropped malformed private event batch");
        return;
      }
      const events: PrivateSimEvent[] = parsed.data;
      for (const event of events) this.privateSignal.emit(event);
    });
    room.onMessage(SERVER_MESSAGE.privateState, (message) => {
      const privateState = parsePrivateState(message);
      if (!privateState) {
        console.warn("[colyseus] dropped malformed private state");
        return;
      }
      this.selfPublicId = privateState.publicPlayerId;
      this.sync = { publicState: this.sync.publicState, privateState };
      this.syncSignal.emit(this.sync);
      this.readRoster(room.state);
    });
    room.onMessage(SERVER_MESSAGE.publicState, (message) => {
      const publicState = parsePublicState(message);
      if (!publicState) {
        console.warn("[colyseus] dropped malformed public state");
        return;
      }
      this.sync = { publicState, privateState: this.sync.privateState };
      this.syncSignal.emit(this.sync);
    });
    room.onMessage(SERVER_MESSAGE.commandRejected, (message) => {
      const rejection = parseCommandRejection(message);
      if (!rejection) {
        console.warn("[colyseus] dropped malformed rejection");
        return;
      }
      this.rejectionSignal.emit(rejection);
    });

    room.onStateChange((state) => {
      this.readRoster(state);
    });
    room.onLeave(() => {
      this.setStatus("disconnected", null);
    });
    room.onError((code, message) => {
      console.warn(`[colyseus] room error ${code}: ${message ?? ""}`);
      this.setStatus("error", null);
    });
  }

  /**
   * Reads the roster out of the synchronized schema. Values are Schema
   * instances rather than plain objects, so each is validated field by field.
   */
  private readRoster(state: unknown): void {
    const players = playersOf(state);
    if (!players) return;

    const roster: RosterEntry[] = [];
    players.forEach((value) => {
      const parsed = RosterPlayerSchema.safeParse(value);
      if (!parsed.success) return;
      roster.push({
        id: parsed.data.publicId,
        displayName: parsed.data.displayName,
        isSelf: parsed.data.publicId === this.selfPublicId,
        isAuthority: false,
      });
    });
    this.roster = roster;
    this.rosterSignal.emit(this.roster);
  }

  private setStatus(status: ConnectionStatus, detail: ConnectionDetail): void {
    this.connection = {
      mode: "colyseus",
      status,
      selfId: this.getSelfId(),
      authorityId: null,
      canRejoin: status === "disconnected" || status === "error",
      detail,
    };
    this.statusSignal.emit(this.connection);
  }
}

/** Millimetres. Finer than any check the server makes, and shorter on the wire. */
function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

interface PlayerMapLike {
  forEach(callback: (value: unknown, key: string) => void): void;
}

function playersOf(state: unknown): PlayerMapLike | null {
  if (typeof state !== "object" || state === null) return null;
  const players = (state as { players?: unknown }).players;
  if (typeof players !== "object" || players === null) return null;
  return typeof (players as PlayerMapLike).forEach === "function"
    ? (players as PlayerMapLike)
    : null;
}
