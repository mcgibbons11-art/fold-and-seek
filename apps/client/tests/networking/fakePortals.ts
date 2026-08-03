import type {
  PortalsNet,
  PortalsNetEvents,
  PortalsNetJoinOptions,
  PortalsNetPlayer,
  PortalsNetSession,
  PortalsSdk,
} from "../../src/types/portals";

/**
 * In-memory stand-in for Portals.net that honours the documented behaviour the
 * adapter depends on (docs/PORTALS_CONSTRAINTS.md):
 *
 * - a broadcast reaches every other joined player and never its sender;
 * - a message or state value above 8 KB of JSON is refused;
 * - shared state is last-write-wins and the confirming event reaches everyone,
 *   the writer included;
 * - keys are capped at 128 characters and 64 per session.
 *
 * Delivery is synchronous so a test sees the full consequence of a send before
 * the next statement. Refusals are recorded rather than thrown: the adapter is
 * required to stay inside these limits, and a test asserts `violations` is
 * empty instead of catching an exception from inside a network callback.
 */

const MAX_PAYLOAD_BYTES = 8_192;
const MAX_KEY_LENGTH = 128;
const MAX_KEYS = 64;

const encoder = new TextEncoder();

type Listener = (...args: never[]) => void;

export interface FakePeerOptions {
  /** Per-connection id, as the relay reports it. Changes on every reconnect. */
  readonly id: string;
  readonly displayName?: string;
  /**
   * Game-scoped id of a signed-in player, stable across reconnections. Leave it
   * out to model a guest, whose identity is only their connection.
   */
  readonly playerId?: string;
  /**
   * How many of this peer's first join() calls time out (the host's reply
   * outlives the SDK's request window), measured in the Portals editor on a
   * cold start (2026-08-02). Whether the host SEATED the timed-out join is
   * the `registerLate` knob below.
   */
  readonly failJoins?: number;
  /**
   * When true, the host keeps the session a timed-out join created: further
   * joins are refused with "already active", and — matching sdk.js netLeave —
   * a plain leave() is a local no-op that never clears it, because the local
   * mirror is empty and nothing is pending. Only a leave() sent while a join
   * is ARMED reaches the host. When false, the timed-out join never seated,
   * and a plain retry simply works.
   */
  readonly registerLate?: boolean;
}

export class FakePortalsRelay {
  readonly violations: string[] = [];
  readonly sendCount = new Map<string, number>();
  /** join() calls per connection, failed ones included, for the retry tests. */
  readonly joinAttempts = new Map<string, number>();

  /**
   * Some live editor host builds have stored shared state but missed its state
   * callback. Tests can turn callbacks off while keeping getState truthful to
   * prove the room-directory broadcast is a real fallback rather than a fake
   * that depends on writer echo.
   */
  deliverStateEvents = true;

  private readonly peers = new Map<string, FakePortalsNet>();
  private readonly sharedState = new Map<string, unknown>();

  createPeer(options: FakePeerOptions): PortalsSdk {
    const net = new FakePortalsNet(
      this,
      {
        id: options.id,
        playerId: options.playerId ?? null,
        displayName: options.displayName ?? null,
        avatarUrl: null,
      },
      options.failJoins ?? 0,
      options.registerLate ?? false,
    );
    // Only ready() and net are exercised; the rest of the SDK surface is not
    // part of the transport contract this fake stands in for.
    return { ready: async () => ({ player: net.selfPlayer, context: "room" }), net } as PortalsSdk;
  }

  /** Simulates a tab closing: the peer vanishes and the others see a leave. */
  dropPeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.markLeft();
    for (const other of this.peers.values()) {
      other.dispatch("playerleave", peer.selfPlayer, this.playerList());
    }
  }

  /**
   * Delivers a payload without the size or shape checks a well-behaved relay
   * applies. The transport cannot assume anything upstream enforced a limit,
   * so this is how a test reaches the adapter's own inbound guards.
   */
  injectRaw(fromId: string, payload: unknown): void {
    for (const peer of [...this.peers.values()]) {
      if (peer.selfPlayer.id === fromId) continue;
      peer.dispatch("message", payload, fromId);
    }
  }

  /** Wipes state keys, to model a room whose snapshot never made it out. */
  clearKeys(keys: readonly string[]): void {
    for (const key of keys) this.sharedState.delete(key);
  }

  /**
   * Hands the player list out in reverse. The SDK promises no ordering at all,
   * so a client that reads arrival order out of the list is guessing; turning
   * this on is how a test reaches the seating rule that does not depend on it.
   */
  reversePlayerList = false;

  playerList(): PortalsNetPlayer[] {
    const players = [...this.peers.values()].map((peer) => peer.selfPlayer);
    return this.reversePlayerList ? players.reverse() : players;
  }

  stateSnapshot(): Record<string, unknown> {
    return Object.fromEntries(this.sharedState);
  }

  /** @internal */
  countJoinAttempt(id: string): void {
    this.joinAttempts.set(id, (this.joinAttempts.get(id) ?? 0) + 1);
  }

  /** @internal */
  register(peer: FakePortalsNet): PortalsNetPlayer[] {
    this.peers.set(peer.selfPlayer.id, peer);
    const players = this.playerList();
    for (const other of this.peers.values()) {
      if (other === peer) continue;
      other.dispatch("playerjoin", peer.selfPlayer, players);
    }
    return players;
  }

  /** @internal */
  unregister(peer: FakePortalsNet): void {
    this.dropPeer(peer.selfPlayer.id);
  }

  /** @internal */
  broadcast(from: FakePortalsNet, data: unknown): void {
    const encoded = JSON.stringify(data);
    const bytes = encoder.encode(encoded).length;
    if (bytes > MAX_PAYLOAD_BYTES) {
      this.violations.push(`send of ${bytes} bytes from ${from.selfPlayer.id}`);
      return;
    }
    this.sendCount.set(
      from.selfPlayer.id,
      (this.sendCount.get(from.selfPlayer.id) ?? 0) + 1,
    );
    const delivered: unknown = JSON.parse(encoded);
    for (const peer of [...this.peers.values()]) {
      if (peer === from) continue;
      peer.dispatch("message", delivered, from.selfPlayer.id);
    }
  }

  /** @internal */
  write(key: string, value: unknown): void {
    if (key.length > MAX_KEY_LENGTH) {
      this.violations.push(`state key longer than ${MAX_KEY_LENGTH}: ${key}`);
      return;
    }
    const encoded = JSON.stringify(value);
    const bytes = encoder.encode(encoded).length;
    if (bytes > MAX_PAYLOAD_BYTES) {
      this.violations.push(`state write of ${bytes} bytes to ${key}`);
      return;
    }
    if (!this.sharedState.has(key) && this.sharedState.size >= MAX_KEYS) {
      this.violations.push(`state key count above ${MAX_KEYS}`);
      return;
    }
    this.sharedState.set(key, JSON.parse(encoded));
    if (this.deliverStateEvents) {
      for (const peer of [...this.peers.values()]) {
        peer.dispatch("state", key, this.sharedState.get(key));
      }
    }
  }

  /** @internal */
  read(): Map<string, unknown> {
    return this.sharedState;
  }
}

class FakePortalsNet implements PortalsNet {
  readonly selfPlayer: PortalsNetPlayer;

  private readonly relay: FakePortalsRelay;
  private readonly listeners = new Map<keyof PortalsNetEvents, Set<Listener>>();
  private joined = false;
  private pendingJoinFailures: number;
  private readonly registerLate: boolean;
  /** A join request is between this SDK and the host (the armed window). */
  private joinPending = false;
  /** The HOST holds a session for this peer, whatever the local mirror says. */
  private hostActive = false;

  constructor(
    relay: FakePortalsRelay,
    self: PortalsNetPlayer,
    failJoins: number,
    registerLate = false,
  ) {
    this.relay = relay;
    this.selfPlayer = self;
    this.pendingJoinFailures = failJoins;
    this.registerLate = registerLate;
  }

  async join(_options?: PortalsNetJoinOptions): Promise<PortalsNetSession> {
    this.relay.countJoinAttempt(this.selfPlayer.id);
    this.joinPending = true;
    // Two microtasks stand in for the postMessage round trip: one for the
    // request crossing to the host, one for the answer crossing back. A
    // leave() issued between them lands INSIDE the armed window, exactly the
    // seam forceHostLeave threads in the real SDK.
    await Promise.resolve();
    await Promise.resolve();
    this.joinPending = false;
    if (this.pendingJoinFailures > 0) {
      this.pendingJoinFailures -= 1;
      // The reply outlives the request window. Whether the host seated the
      // join anyway is the registerLate knob.
      if (this.registerLate) this.hostActive = true;
      throw new Error("join timed out");
    }
    if (this.hostActive && !this.joined) {
      // Host-side refusal, verbatim from the editor logs: the session the
      // timed-out join created is still there and leave() has not reached it.
      throw new Error("A multiplayer session is already active — leave() first.");
    }
    this.joined = true;
    this.hostActive = true;
    const players = this.relay.register(this);
    return { self: this.selfPlayer, players, state: this.relay.stateSnapshot() };
  }

  async leave(): Promise<void> {
    // sdk.js netLeave: the request reaches the host only while the local
    // mirror or a pending join exists; otherwise it clears nothing anywhere.
    if (this.joined || this.joinPending) {
      this.hostActive = false;
      this.relay.unregister(this);
    }
    this.joined = false;
  }

  send(data: unknown): void {
    if (!this.joined) return;
    this.relay.broadcast(this, data);
  }

  setState(key: string, value: unknown): void {
    if (!this.joined) return;
    this.relay.write(key, value);
  }

  getState(key: string): unknown;
  getState(): Record<string, unknown>;
  getState(key?: string): unknown {
    const state = this.relay.read();
    return key === undefined ? Object.fromEntries(state) : state.get(key);
  }

  players(): PortalsNetPlayer[] {
    return this.relay.playerList();
  }

  self(): PortalsNetPlayer | null {
    return this.selfPlayer;
  }

  on<E extends keyof PortalsNetEvents>(event: E, handler: PortalsNetEvents[E]): void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(handler as Listener);
    this.listeners.set(event, set);
  }

  off<E extends keyof PortalsNetEvents>(event: E, handler: PortalsNetEvents[E]): void {
    this.listeners.get(event)?.delete(handler as Listener);
  }

  /** @internal */
  markLeft(): void {
    this.joined = false;
    this.dispatch("status", "disconnected");
  }

  /** @internal */
  dispatch<E extends keyof PortalsNetEvents>(
    event: E,
    ...args: Parameters<PortalsNetEvents[E]>
  ): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as (...values: Parameters<PortalsNetEvents[E]>) => void)(...args);
    }
  }
}
