import type {
  DisguisePlacement,
  MatchSimulation,
  PrivateSimEvent,
  SimOutput,
} from "@foldseek/game-sim";
import type { Vec3Like } from "@foldseek/map-data";
import { baseSeatIdOf, derivedSeatId, encodeStateChunks } from "@foldseek/shared";

import {
  MAX_SERVER_STATE_CHUNKS,
  SERVER_DEBUG_KEY,
  SERVER_HELLO_KEY,
  SERVER_STATE_KEYS,
  type ClientToServer,
  type ServerToClient,
} from "./protocol";

/**
 * The bridge between the sandbox's `server` global and the simulation.
 *
 * It is a class taking the host as a parameter rather than code that reaches
 * for a global, so the whole authority is testable in an ordinary vitest
 * process against a fake host. Nothing in here touches a timer or a clock it
 * was not handed.
 */

export interface ServerPlayer {
  /** The live connection. Changes every time a player reopens the game. */
  readonly id: string;
  /** The signed-in account, absent for a guest. Stable across a reconnection. */
  readonly playerId?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export interface ServerGlobal {
  on(
    event: "message" | "playerjoin" | "playerleave" | "state",
    handler: (...args: never[]) => void,
  ): void;
  send(data: unknown): void;
  setState(key: string, value: unknown): void;
  getState(key?: string): unknown;
  players(): readonly ServerPlayer[];
  kick(sessionId: string): void;
  setTimeout(callback: () => void, ms: number): number;
  setInterval(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
  log(...values: readonly unknown[]): void;
}

export interface RuntimeOptions {
  readonly tickMs: number;
  readonly stateEveryTicks: number;
  readonly protocolVersion: number;
  readonly onEye: (playerId: string, eye: Vec3Like | null) => void;
  readonly onPlacements: (placements: readonly DisguisePlacement[]) => void;
}

export class PortalsServerRuntime {
  private readonly host: ServerGlobal;
  private readonly sim: MatchSimulation;
  private readonly options: RuntimeOptions;
  private timer: number | null = null;
  private ticks = 0;
  /**
   * Which seat each live connection is playing. The relay stamps arriving
   * messages with a connection id, the simulation knows players by seat, and
   * the two only coincide for a signed-out guest.
   */
  private readonly seatByConnection = new Map<string, string>();
  /** How many keys the last publication used, so a shorter one clears the tail. */
  private publishedCount = 0;
  private stateSeq = 0;
  /**
   * The session clock. The sandbox gives no promise about `Date.now`, and the
   * simulation only ever needs a monotonic millisecond count, so the runtime
   * counts its own ticks instead of trusting the environment for time.
   */
  private nowMs = 0;

  constructor(host: ServerGlobal, sim: MatchSimulation, options: RuntimeOptions) {
    this.host = host;
    this.sim = sim;
    this.options = options;
  }

  start(): void {
    this.host.setState(SERVER_HELLO_KEY, { v: this.options.protocolVersion, epoch: 1 });
    this.host.log("foldseek authority online");

    // Anyone already seated when the script boots - the relay may start it
    // after the first arrivals - is seated before the first tick.
    for (const player of this.host.players()) this.seat(player);

    this.host.on("playerjoin", ((player: ServerPlayer) => {
      const seatId = this.seat(player);
      this.publishState();
      this.syncTo(player.id, seatId);
    }) as (...args: never[]) => void);

    this.host.on("playerleave", ((player: ServerPlayer) => {
      const seatId = this.seatByConnection.get(player.id);
      this.seatByConnection.delete(player.id);
      if (seatId === undefined) return;
      // The seat is held, not dropped. A player who closes the tab mid-round
      // has a grace window to come back to their own disguise, and the
      // simulation runs that clock and evicts the seat itself when it expires.
      this.drain(this.sim.markDisconnected(seatId, this.nowMs));
      this.options.onEye(seatId, null);
      this.publishState();
    }) as (...args: never[]) => void);

    this.host.on("message", ((data: unknown, fromId: string) => {
      this.receive(data, fromId);
    }) as (...args: never[]) => void);

    this.timer = this.host.setInterval(() => {
      this.tick();
    }, this.options.tickMs);
  }

  stop(): void {
    if (this.timer !== null) this.host.clearTimer(this.timer);
    this.timer = null;
  }

  /** Exposed for tests; the interval calls it in the session. */
  tick(): void {
    this.nowMs += this.options.tickMs;
    this.ticks += 1;
    this.drain(this.sim.tick(this.nowMs));
    if (this.ticks % this.options.stateEveryTicks === 0) this.publishState();
  }

  /**
   * Gives a connection its seat, and the simulation a player under it.
   *
   * A signed-in player returns to the seat their account already holds, which
   * is what carries their role, disguise, warrants, and score through a dropped
   * connection. One account playing from two connections gets two seats,
   * because two people are at the keyboards whatever the login says.
   */
  private seat(player: ServerPlayer): string {
    const held = this.seatByConnection.get(player.id);
    if (held !== undefined) return held;

    const base = baseSeatIdOf(player);
    const live = new Set(this.seatByConnection.values());
    const seatId = live.has(base) ? derivedSeatId(base, player.id) : base;
    this.seatByConnection.set(player.id, seatId);

    // A seat the simulation still holds belonged to this account moments ago:
    // the player dropped and came back inside their grace, so they resume the
    // round rather than entering it again as a spectator.
    if (this.sim.getPrivateStateFor(seatId) !== null) {
      this.drain(this.sim.markReconnected(seatId, this.nowMs));
      return seatId;
    }

    const options: { displayName?: string } = {};
    if (player.displayName !== undefined) options.displayName = player.displayName;
    const result = this.sim.addPlayer(seatId, options);
    if (!result.accepted) {
      this.note(`refused a seat for ${seatId}: ${result.reason}`);
      this.seatByConnection.delete(player.id);
      return seatId;
    }
    this.drain(result);
    return seatId;
  }

  private receive(data: unknown, fromId: string): void {
    const envelope = data as ClientToServer | null;
    if (envelope === null || typeof envelope !== "object") return;
    if (envelope.v !== this.options.protocolVersion) return;

    // The relay's word on who sent this, not the sender's. Every seat in this
    // method comes from the connection the message actually arrived on, which
    // is what stops one player acting as another.
    const seatId = this.seatByConnection.get(fromId);
    if (seatId === undefined) return;

    if (envelope.t === "eye") {
      this.options.onEye(seatId, envelope.eye === null ? null : toVec(envelope.eye));
      return;
    }
    if (envelope.t === "resync") {
      this.syncTo(fromId, seatId);
      return;
    }
    if (envelope.t !== "cmd") return;

    // The eye rides with the command so an accusation is judged from the
    // position the shot was actually taken from, never a later one.
    if (envelope.eye !== undefined) this.options.onEye(seatId, toVec(envelope.eye));
    const result = this.sim.handleCommand(seatId, envelope.cmd);
    if (!result.accepted) {
      this.broadcast({
        v: this.options.protocolVersion,
        t: "rejected",
        to: seatId,
        reason: result.detail ?? result.reason ?? "rejected",
      });
      return;
    }
    this.drain(result);
  }

  private drain(output: SimOutput | undefined): void {
    if (output === undefined) return;
    const privateBatches: [string, readonly PrivateSimEvent[]][] = [];
    for (const [playerId, events] of output.private) {
      if (events.length > 0) privateBatches.push([playerId, events]);
    }
    if (output.public.length === 0 && privateBatches.length === 0) return;
    this.broadcast({
      v: this.options.protocolVersion,
      t: "ev",
      public: output.public,
      private: privateBatches,
    });
    this.options.onPlacements(this.sim.getDisguisePlacements());
  }

  /**
   * Publishes the authoritative state across its key range.
   *
   * Every chunk of a publication is written, including one whose payload
   * happens to match the last: readers only assemble a set that shares a
   * sequence number, so leaving one key on an older sequence would make the
   * whole publication unreadable rather than saving a write. The budget is
   * kept by publishing less often instead, which `STATE_EVERY_TICKS` sets.
   */
  private publishState(): void {
    this.stateSeq += 1;
    const chunks = encodeStateChunks(
      this.sim.getPublicState(),
      this.stateSeq,
      MAX_SERVER_STATE_CHUNKS,
    );
    if (chunks === null) {
      // Refusing to publish beats publishing a truncated round: a client would
      // decode the shortened state as a real one with players missing.
      this.note(`public state does not fit ${String(MAX_SERVER_STATE_CHUNKS)} keys`);
      return;
    }

    for (const chunk of chunks) {
      const key = SERVER_STATE_KEYS[chunk.i];
      if (key !== undefined) this.host.setState(key, chunk);
    }

    // A publication needing fewer keys than the last must not leave the tail
    // of the old one behind, where a reader could assemble it as a whole.
    for (let index = chunks.length; index < this.publishedCount; index += 1) {
      const key = SERVER_STATE_KEYS[index];
      if (key !== undefined) this.host.setState(key, null);
    }
    this.publishedCount = chunks.length;
  }

  /**
   * Answers one connection with the room's state and its own slice of it.
   *
   * Addressed by connection rather than by seat because this is what tells a
   * fresh client which seat it got; everything after it is addressed by seat.
   */
  private syncTo(connectionId: string, seatId: string): void {
    this.broadcast({
      v: this.options.protocolVersion,
      t: "sync",
      to: connectionId,
      seat: seatId,
      publicState: this.sim.getPublicState(),
      privateState: this.sim.getPrivateStateFor(seatId),
    });
  }

  private broadcast(message: ServerToClient): void {
    try {
      this.host.send(message);
    } catch (error) {
      // A refused send is a dropped frame, never a dead session: the next
      // tick republishes state and a client can always ask for a resync.
      this.note(`send failed: ${String(error)}`);
    }
  }

  /**
   * Records something worth knowing about this session.
   *
   * `server.log` output is not surfaced anywhere a developer can read it, so
   * the authority's error paths publish to a state key instead. Without this
   * a refused seat is completely silent in production.
   */
  private note(note: string): void {
    this.host.log("foldseek authority:", note);
    try {
      this.host.setState(SERVER_DEBUG_KEY, { at: this.nowMs, note });
    } catch {
      // Diagnostics must never be the thing that takes a session down.
    }
  }
}


function toVec(eye: readonly [number, number, number]): Vec3Like {
  return { x: eye[0], y: eye[1], z: eye[2] };
}
