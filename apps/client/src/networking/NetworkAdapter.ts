import type {
  MatchCommand,
  PrivateMatchState,
  PrivateSimEvent,
  PublicMatchState,
  SimEvent,
} from "@foldseek/game-sim";

/**
 * The single seam between the game client and whatever is running the
 * authoritative MatchSimulation. GameHost consumes this interface and nothing
 * below it, so the same client code plays offline, inside a Portals room over
 * Portals.net, and against the dedicated Colyseus server.
 *
 * The simulation already separates what the room may see from what belongs to
 * one player, so the adapter surfaces the two streams separately as well: a
 * SimEvent always arrived by broadcast, a PrivateSimEvent was addressed here.
 */

export type NetworkMode = "local" | "portals" | "colyseus";

/**
 * A command the authority refused. Every transport reports these the same way,
 * so the Forge and HUD can show one reason string wherever the match is running
 * (§27.3). `type` is the command that was refused; `detail` carries a
 * validator's or decoder's own words when it had any.
 */
export interface CommandRejection {
  readonly type: string;
  readonly reason: string;
  readonly detail?: string;
}

/**
 * An Inspector's eye in world metres, as it travels to whichever machine holds
 * authority. Both networked adapters report one and both authorities check
 * range and line of sight from it, so it is named here rather than twice.
 */
export type EyePosition = readonly [number, number, number];

/** Sparse world-space Inspector telemetry used to present a remote hunter. */
export interface InspectorCameraSample {
  readonly atMs: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  /** True while the sender is jumping or falling. Presentation-only telemetry. */
  readonly airborne: boolean;
  /** True while the sender's controller is traversing a climb link. */
  readonly climbing: boolean;
}

/** The latest legal pose a Mimic has authored, and the revision it belongs to. */
export interface ForgeSnapshot {
  readonly encodedPose: string;
  readonly revision: number;
}

/**
 * The latest body-paint layer a Mimic has authored. Paint keeps a revision of
 * its own because it is authored independently of the pose, so neither one
 * has to carry the other unchanged to be published.
 */
export interface PaintUpdate {
  readonly encodedPaint: string;
  readonly revision: number;
  /** Portals-only compact checkpoint/delta; other transports use encodedPaint. */
  readonly encodedSync?: string;
}

export type ConnectionStatus =
  /** Constructed but never joined. */
  | "idle"
  | "connecting"
  | "connected"
  /** Connection lost. The UI should offer a rejoin, which calls join() again. */
  | "disconnected"
  /** Left deliberately; the adapter can still be re-joined. */
  | "closed"
  | "error";

/**
 * Why the connection state last changed, for UI copy. `null` when the status
 * speaks for itself.
 */
export type ConnectionDetail =
  | "join_failed"
  /** The room already holds every seat the match settings allow. */
  | "room_full"
  /** This account is already playing from another connection (§31.3). */
  | "duplicate_session"
  | "transport_unavailable"
  /** This client took over the authoritative simulation. */
  | "authority_assumed"
  /** Authority moved here and the round in progress carried on unbroken. */
  | "authority_resumed"
  /** Authority moved here and the round in progress could not be resumed. */
  | "authority_migrated_match_reset"
  | "kicked"
  | null;

export interface RosterEntry {
  /**
   * The identity the simulation knows this player by, stable across a
   * reconnection. On Portals that is the signed-in player id (falling back to
   * the connection id for a guest), never the per-connection id, so a player
   * who drops and returns keeps their entry. Against the dedicated server it is
   * the public player id, because session ids stay on the server.
   */
  readonly id: string;
  readonly displayName: string;
  readonly isSelf: boolean;
  /**
   * True for the peer running the authoritative simulation. Always false with
   * a dedicated server, which holds authority outside the roster.
   */
  readonly isAuthority: boolean;
}

/**
 * Seats filled by the machine, offered by the transports that run a simulation
 * in the page. Only the client holding that simulation can seat one, which is
 * what `canManageBots` reports: on the loopback that is always this client, and
 * on Portals it is whichever client is currently elected host.
 *
 * A transport with no simulation of its own — the dedicated server — leaves
 * `NetworkAdapter.bots` undefined, and the lobby offers no control at all.
 */
export interface BotSeatControls {
  canManageBots(): boolean;
  /** The new seat id, or null when the transport or the room refused it. */
  addBot(): string | null;
  removeBot(seatId: string): void;
  /** Seats currently held by bots, oldest first. */
  botSeatIds(): readonly string[];
}

export interface ConnectionState {
  readonly mode: NetworkMode;
  readonly status: ConnectionStatus;
  readonly selfId: string | null;
  readonly authorityId: string | null;
  /** True when calling join() again is expected to restore the session. */
  readonly canRejoin: boolean;
  readonly detail: ConnectionDetail;
}

/**
 * The last authoritative state this client knows about. `privateState` is the
 * viewer's own slice and is never derived from another player's data.
 */
export interface MatchSync {
  readonly publicState: PublicMatchState | null;
  readonly privateState: PrivateMatchState | null;
}

export type Unsubscribe = () => void;

export interface NetworkAdapter {
  /** Discriminator so callers can branch on transport without instanceof. */
  readonly mode: NetworkMode;
  /** Bot seats, on the transports that can hold them. */
  readonly bots?: BotSeatControls;
  /** Human-facing lobby code when this transport has a shared room directory. */
  getRoomCode?(): string | null;

  /** Acquires the transport (SDK handshake, client construction). Idempotent. */
  connect(): Promise<void>;
  /**
   * Enters a session. `room` is a Colyseus room name, a Portals channel, or an
   * ignored label for the local loopback. Also the reconnect entry point.
   */
  join(room: string, displayName: string): Promise<ConnectionState>;
  /** Leaves the session but leaves the adapter reusable. */
  disconnect(): Promise<void>;
  /** Releases every timer and listener. The adapter is not reusable after this. */
  dispose(): void;

  sendCommand(command: MatchCommand): void;
  /**
   * Publishes the sender's latest legal Forge pose. Callers coalesce: this is a
   * periodic snapshot of authoring state, never one call per drag.
   */
  sendForgeSnapshot(snapshot: ForgeSnapshot): void;
  /**
   * Publishes the sender's latest body-paint layer. Coalesced exactly as the
   * pose is: one whole stroke log per call, never one call per brush stamp.
   */
  sendPaintUpdate(update: PaintUpdate): void;
  /** Optional on transports that can share live Inspector presentation. */
  sendCameraSample?(sample: InspectorCameraSample | null): void;

  getSelfId(): string | null;
  getConnection(): ConnectionState;
  getRoster(): readonly RosterEntry[];
  getSync(): MatchSync;

  onEvent(listener: (event: SimEvent) => void): Unsubscribe;
  /** Refusals of this client's own commands, never another player's. */
  onRejection(listener: (rejection: CommandRejection) => void): Unsubscribe;
  onPrivateEvent(listener: (event: PrivateSimEvent) => void): Unsubscribe;
  onRoster(listener: (roster: readonly RosterEntry[]) => void): Unsubscribe;
  onStatus(listener: (state: ConnectionState) => void): Unsubscribe;
  onSync(listener: (sync: MatchSync) => void): Unsubscribe;
  onCameraSample?(
    listener: (seatId: string, sample: InspectorCameraSample | null) => void,
  ): Unsubscribe;
}

export const EMPTY_SYNC: MatchSync = { publicState: null, privateState: null };

export function idleConnection(mode: NetworkMode): ConnectionState {
  return {
    mode,
    status: "idle",
    selfId: null,
    authorityId: null,
    canRejoin: false,
    detail: null,
  };
}
