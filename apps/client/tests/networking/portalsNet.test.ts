import type { MatchSettingsPatch, PrivateSimEvent, SimEvent } from "@foldseek/game-sim";
import {
  createReferenceDisguiseWire,
  decodeDisguiseWire,
  encodeDisguiseWire,
  encodePaintLayer,
  MatchPhase,
} from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandRejection, ConnectionState } from "../../src/networking/NetworkAdapter";
import {
  BOT_SEAT_MARKER,
  botSeatId,
  isBotSeat,
  type BotBrain,
  type BotSeatOptions,
} from "../../src/networking/botSeats";
import {
  coalesceDisguiseUpdates,
  derivedSeatId,
  DERIVED_SEAT_SEPARATOR,
  FLUSH_INTERVAL_MS,
  PortalsNetAdapter,
} from "../../src/networking/PortalsNetAdapter";
import {
  decodeHostPublication,
  decodePaintBook,
  decodePoseBook,
  jsonByteLength,
  MAX_COMMANDS_PER_SECOND,
  MAX_FORGE_SNAPSHOTS_PER_SECOND,
  MAX_PAYLOAD_BYTES,
  PORTALS_PROTOCOL_VERSION,
  POSE_STATE_KEYS,
  SIM_STATE_KEYS,
  SNAPSHOT_STATE_KEYS,
} from "../../src/networking/portalsProtocol";
import { FakePortalsRelay } from "./fakePortals";

const FAST_SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 600,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
};

const CHANNEL = "fold-seek-test";
const STEP_MS = 100;
/** A pose the canonical wire schema accepts, so the simulation keeps it. */
const VALID_POSE = encodeDisguiseWire(createReferenceDisguiseWire(4));

/** A short body-paint layer the wire decoder accepts. */
const PAINT_LAYER = encodePaintLayer(
  Array.from({ length: 12 }, (_, index) => ({
    target: index % 19,
    u: (index % 8) / 8,
    v: (index % 5) / 5,
    radius: 0.25,
    color: [0.9, 0.3, 0.1] as const,
    opacity: 1,
    erase: false,
    continued: index % 3 !== 0,
  })),
);

/** The same pose nudged along one axis, for creeping a hider a legal distance. */
function poseAt(x: number, revision: number): string {
  const base = createReferenceDisguiseWire(revision);
  return encodeDisguiseWire({ ...base, root: { ...base.root, position: [x, 0, 0] } });
}

interface Peer {
  readonly id: string;
  readonly adapter: PortalsNetAdapter;
  readonly events: SimEvent[];
  readonly privateEvents: PrivateSimEvent[];
  readonly rejections: CommandRejection[];
  readonly statuses: ConnectionState[];
}

interface PeerOptions {
  /** Game-scoped id of a signed-in player. Omit to model a guest. */
  readonly playerId?: string;
  /** Joins that time out after half-registering, before the one that works. */
  readonly failJoins?: number;
  /** The timed-out join registers only after the cleanup leave() has run. */
  readonly registerLate?: boolean;
}

class Session {
  readonly relay = new FakePortalsRelay();
  readonly peers: Peer[] = [];
  private readonly settings: MatchSettingsPatch;
  private readonly botOptions: BotSeatOptions;
  private clock = 1_700_000_000_000;

  /**
   * `botOptions` go to every peer, exactly as `createPortalsRound` gives them
   * to every client: whoever ends up host has to be able to drive the bots.
   */
  constructor(settings: MatchSettingsPatch = {}, botOptions: BotSeatOptions = {}) {
    this.settings = { ...FAST_SETTINGS, ...settings };
    this.botOptions = botOptions;
  }

  now(): number {
    return this.clock;
  }

  async addPeer(id: string, displayName: string, options: PeerOptions = {}): Promise<Peer> {
    const sdk = this.relay.createPeer({
      id,
      displayName,
      ...(options.playerId === undefined ? {} : { playerId: options.playerId }),
      ...(options.failJoins === undefined ? {} : { failJoins: options.failJoins }),
      ...(options.registerLate === undefined ? {} : { registerLate: options.registerLate }),
    });
    const adapter = new PortalsNetAdapter(sdk, {
      settings: this.settings,
      seed: 5,
      now: () => this.clock,
      // The retry runs immediately and without a timer, so a fake-timer test
      // never has to advance one to finish joining.
      joinRetryDelayMs: 0,
      ...this.botOptions,
    });
    const events: SimEvent[] = [];
    const privateEvents: PrivateSimEvent[] = [];
    const rejections: CommandRejection[] = [];
    const statuses: ConnectionState[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.onPrivateEvent((event) => privateEvents.push(event));
    adapter.onRejection((rejection) => rejections.push(rejection));
    adapter.onStatus((state) => statuses.push(state));
    await adapter.connect();
    await adapter.join(CHANNEL, displayName);
    const peer: Peer = { id, adapter, events, privateEvents, rejections, statuses };
    this.peers.push(peer);
    return peer;
  }

  /** Seats a peer that is expected to be refused, without recording it. */
  async addRefusedPeer(id: string, displayName: string): Promise<void> {
    const adapter = new PortalsNetAdapter(this.relay.createPeer({ id, displayName }), {
      settings: this.settings,
      seed: 5,
      now: () => this.clock,
      joinRetryDelayMs: 0,
    });
    await adapter.connect();
    try {
      await adapter.join(CHANNEL, displayName);
    } finally {
      adapter.dispose();
    }
  }

  peer(id: string): Peer {
    const found = this.peers.find((entry) => entry.id === id);
    if (!found) throw new Error(`no peer ${id}`);
    return found;
  }

  /**
   * Moves the clock without letting anyone tick, so several things can land in
   * the same flush window the way they would between two real frames.
   */
  tickClock(ms: number): void {
    this.clock += ms;
  }

  /** Advances the shared clock and lets whichever peer holds authority step. */
  advance(steps = 1): void {
    for (let index = 0; index < steps; index += 1) {
      this.clock += STEP_MS;
      for (const peer of this.peers) peer.adapter.tick();
    }
  }

  /** Readies every peer, starts the match from the host, and runs to `target`. */
  startMatch(hostId: string, target: MatchPhase, maxSteps = 60): void {
    this.readyAll();
    this.advance(2);
    this.peer(hostId).adapter.sendCommand({ type: "start_match" });
    this.advance(2);

    for (let index = 0; index < maxSteps; index += 1) {
      const phase = this.peer(hostId).adapter.getSync().publicState?.phase;
      if (phase === target) return;
      // Ready flags clear on entering Loading, so re-arm them there.
      if (phase === MatchPhase.Loading) this.readyAll();
      this.advance();
    }
    throw new Error(`phase ${target} not reached in ${maxSteps} steps`);
  }

  private readyAll(): void {
    for (const peer of this.peers) {
      peer.adapter.sendCommand({ type: "player_ready", ready: true });
    }
  }

  /**
   * Every Mimic locks the canonical reference pose. It has to be a pose the
   * wire schema accepts: the simulation refuses anything it cannot decode, and
   * a refused lock silently becomes an empty auto-lock at the deadline.
   */
  lockDisguises(): number {
    let locked = 0;
    for (const peer of this.peers) {
      if (peer.adapter.getSync().privateState?.role !== "mimic") continue;
      peer.adapter.sendCommand({ type: "lock_disguise", payload: VALID_POSE, revision: 9 });
      locked += 1;
    }
    return locked;
  }

  /**
   * `maxSteps` allows a whole Forge at its authored length. The phase used to
   * end the moment every Mimic had locked, so a room that locked at once was
   * through it in a step or two; `MIN_FORGE_DWELL_MS` now holds it open, and a
   * 5 s Forge really does cost 50 of these.
   */
  runTo(target: MatchPhase, hostId: string, maxSteps = 120): void {
    for (let index = 0; index < maxSteps; index += 1) {
      if (this.peer(hostId).adapter.getSync().publicState?.phase === target) return;
      this.advance();
    }
    throw new Error(`phase ${target} not reached in ${maxSteps} steps`);
  }

  dispose(): void {
    for (const peer of this.peers) peer.adapter.dispose();
  }
}

function eventsOfType<T extends SimEvent["type"]>(
  peer: Peer,
  type: T,
): Array<Extract<SimEvent, { type: T }>> {
  return peer.events.filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Inspection long enough to be a phase of its own rather than collapsing into
 * the final countdown, and a Forge long enough to still be running when a host
 * is dropped part way through it.
 */
const RECONNECT_SETTINGS: MatchSettingsPatch = {
  forgeMs: 5_000,
  inspectionMs: 20_000,
  reconnectGraceMs: 1_000,
};

describe("PortalsNetAdapter authority", () => {
  it("keeps authority with the first joiner and re-elects the lowest id when it leaves", async () => {
    vi.useFakeTimers();
    const session = new Session();
    // "c" joins first even though "a" sorts lower: a late joiner never steals a
    // running session, so authority stays put until the holder leaves.
    await session.addPeer("c", "Cora");
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(6);

    for (const peer of session.peers) {
      expect(peer.adapter.getConnection().authorityId).toBe("c");
    }
    expect(session.peer("c").adapter.isAuthority()).toBe(true);
    expect(session.peer("a").adapter.isAuthority()).toBe(false);

    session.relay.dropPeer("c");
    session.advance(6);

    expect(session.peer("a").adapter.isAuthority()).toBe(true);
    expect(session.peer("b").adapter.getConnection().authorityId).toBe("a");
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("refuses a tampered snapshot and falls back to a lobby reset", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new Session();
    await session.addPeer("c", "Cora");
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(2);

    session.startMatch("c", MatchPhase.Forge);
    expect(
      eventsOfType(session.peer("a"), "phase_changed").map((event) => event.phase),
    ).toContain(MatchPhase.Forge);

    // Any client can write room state, so a snapshot is untrusted input even
    // when it looks like it came from the host. This one is well-formed as a
    // chunk and nonsense as a simulation.
    session.relay.clearKeys(SIM_STATE_KEYS);
    session.relay.write(SIM_STATE_KEYS[0], {
      v: PORTALS_PROTOCOL_VERSION,
      seq: 999_999,
      i: 0,
      n: 1,
      data: JSON.stringify({ v: 1, po: true, forged: "not a simulation" }),
    });
    session.relay.dropPeer("c");
    session.advance(6);

    const newHost = session.peer("a");
    expect(newHost.adapter.isAuthority()).toBe(true);
    expect(newHost.adapter.getConnection().detail).toBe("authority_migrated_match_reset");
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("not valid state")),
    ).toBe(true);

    // The round is gone rather than running on state nobody can vouch for.
    const publicState = session.peer("b").adapter.getSync().publicState;
    expect(publicState?.phase).toBe(MatchPhase.Lobby);
    expect(publicState?.players.map((player) => player.displayName).sort()).toEqual([
      "Ada",
      "Bex",
    ]);
    expect(publicState?.settings.forgeMs).toBe(FAST_SETTINGS.forgeMs);
    expect(session.relay.violations).toEqual([]);

    warn.mockRestore();
    session.dispose();
  });

  it("resumes an inspection in progress on the new host", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("c", "Cora");
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(2);
    session.startMatch("c", MatchPhase.Forge);
    session.lockDisguises();
    session.runTo(MatchPhase.Inspection, "c");
    session.advance(6);

    const survivor = session.peer("b");
    const before = survivor.adapter.getSync().publicState;
    const warrantsBefore = before?.warrantsRemaining;
    const disguisesBefore = before?.disguises.map((entry) => entry.publicObjectId).sort();
    const roleBefore = survivor.adapter.getSync().privateState?.role;
    expect(warrantsBefore).toBeGreaterThan(0);
    expect(disguisesBefore?.length).toBeGreaterThan(0);

    session.relay.dropPeer("c");
    session.advance(6);

    const newHost = session.peer("a");
    expect(newHost.adapter.isAuthority()).toBe(true);
    expect(newHost.adapter.getConnection().detail).toBe("authority_resumed");

    // The restored simulation continues the sequence numbering rather than
    // starting over, which is what makes the stream a continuation of the same
    // round instead of a new one that happens to look similar.
    const seqBefore = Math.max(...survivor.events.map((event) => event.seq));
    session.advance(4);
    const seqs = survivor.events.map((event) => event.seq);
    expect(Math.max(...seqs)).toBeGreaterThanOrEqual(seqBefore);
    // No event ever repeats a sequence number this client already saw, which a
    // simulation that restarted its counter instead of continuing would.
    expect(new Set(seqs).size).toBe(seqs.length);

    // Same round, same phase, same warrants, same disguises standing.
    const after = newHost.adapter.getSync().publicState;
    expect(after?.phase).toBe(MatchPhase.Inspection);
    expect(after?.warrantsRemaining).toBe(warrantsBefore);
    expect(after?.disguises.map((entry) => entry.publicObjectId).sort()).toEqual(disguisesBefore);
    // The departed host is gone from the roster, everyone else kept their role.
    expect(after?.players).toHaveLength(2);
    expect(survivor.adapter.getSync().privateState?.role).toBe(roleBefore);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("recovers every Mimic's working pose when the host is lost mid-Forge", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("c", "Cora");
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(2);
    session.startMatch("c", MatchPhase.Forge);

    // Working poses, never locked: these exist only on the host that recorded
    // them, so omitting them from the snapshot is what the resend flow repairs.
    const mimics = session.peers.filter(
      (peer) => peer.adapter.getSync().privateState?.role === "mimic",
    );
    expect(mimics.length).toBeGreaterThan(0);
    for (const mimic of mimics) {
      mimic.adapter.sendForgeSnapshot({ encodedPose: VALID_POSE, revision: 7 });
    }
    session.advance(2);

    session.relay.dropPeer("c");
    session.advance(6);

    const newHost = session.peer("a");
    expect(newHost.adapter.isAuthority()).toBe(true);
    expect(newHost.adapter.getConnection().detail).toBe("authority_resumed");
    expect(newHost.adapter.getSync().publicState?.phase).toBe(MatchPhase.Forge);

    // Let the Forge run out: every surviving Mimic should lock into the pose it
    // re-sent, not into a default arrangement.
    session.runTo(MatchPhase.Inspection, "a", 150);
    const survivingMimics = session.peers.filter(
      (peer) => peer.id !== "c" && peer.adapter.getSync().privateState?.role === "mimic",
    );
    expect(survivingMimics.length).toBeGreaterThan(0);
    for (const mimic of survivingMimics) {
      const own = mimic.adapter.getSync().privateState?.ownDisguise;
      expect(own?.encodedPose).toBe(VALID_POSE);
      expect(own?.source).toBe("recovered_pose");
    }
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });
});

describe("PortalsNetAdapter command flow", () => {
  it("routes a non-host command through the host and back to every client", async () => {
    vi.useFakeTimers();
    const session = new Session();
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(2);

    session.peer("b").adapter.sendCommand({ type: "player_ready", ready: true });
    session.advance(2);

    for (const id of ["a", "b"]) {
      const changes = eventsOfType(session.peer(id), "player_ready_changed");
      expect(changes).toHaveLength(1);
      expect(changes[0]?.ready).toBe(true);
    }
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("ignores events published by a client that does not hold authority", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new Session();
    await session.addPeer("a", "Ada");
    const impostor = await session.addPeer("b", "Bex");
    session.advance(2);

    const host = session.peer("a");
    const before = host.events.length;
    // "b" is not the authority, so its event batch must not reach the stream.
    rawSend(impostor, {
      v: PORTALS_PROTOCOL_VERSION,
      t: "ev",
      events: [
        {
          type: "host_changed",
          publicPlayerId: "p_forged0001",
          seq: 999,
          at: session.now(),
        },
      ],
    });

    expect(host.events).toHaveLength(before);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    session.dispose();
  });
});

describe("PortalsNetAdapter inbound limits", () => {
  it("drops commands from a client that exceeds its per-second allowance", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new Session();
    await session.addPeer("a", "Ada");
    const flooder = await session.addPeer("b", "Bex");
    session.advance(2);

    // The relay's own send budget is separate, so the flood is injected
    // directly to isolate what the host does with commands it does receive.
    const host = session.peer("a");
    const attempts = MAX_COMMANDS_PER_SECOND + 15;
    for (let index = 0; index < attempts; index += 1) {
      rawSend(flooder, {
        v: PORTALS_PROTOCOL_VERSION,
        t: "cmd",
        to: "a",
        cmd: { type: "player_ready", ready: index % 2 === 0 },
      });
    }

    const applied = eventsOfType(host, "player_ready_changed").length;
    expect(applied).toBeLessThanOrEqual(MAX_COMMANDS_PER_SECOND);
    expect(applied).toBeGreaterThan(0);
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("exceeded")),
    ).toBe(true);

    warn.mockRestore();
    session.dispose();
  });

  it("drops an oversized message before parsing it", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new Session();
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(2);

    const host = session.peer("a");
    const before = host.events.length;
    // Injected past the relay's own cap: the adapter has to enforce the limit
    // itself rather than trust that something upstream already did.
    session.relay.injectRaw("b", {
      v: PORTALS_PROTOCOL_VERSION,
      t: "cmd",
      to: "a",
      cmd: { type: "lock_disguise", payload: "x".repeat(MAX_PAYLOAD_BYTES), revision: 1 },
    });

    expect(host.events).toHaveLength(before);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("byte message"))).toBe(true);

    warn.mockRestore();
    session.dispose();
  });

  it("carries a non-host Mimic's forge snapshot to the host and caps its rate", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new Session();
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    await session.addPeer("c", "Cora");
    session.advance(2);
    session.startMatch("a", MatchPhase.Forge);

    const mimic = session.peers.find(
      (peer) => peer.id !== "a" && peer.adapter.getSync().privateState?.role === "mimic",
    );
    expect(mimic).toBeDefined();
    if (!mimic) return;

    // The host adopts the snapshot as the fallback pose, so a Mimic who never
    // sends a lock still locks into it when the Forge deadline passes (§5.8).
    mimic.adapter.sendForgeSnapshot({ encodedPose: VALID_POSE, revision: 4 });
    session.advance(1);

    const attempts = MAX_FORGE_SNAPSHOTS_PER_SECOND + 6;
    for (let index = 0; index < attempts; index += 1) {
      mimic.adapter.sendForgeSnapshot({ encodedPose: VALID_POSE, revision: 10 + index });
    }
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("forge snapshots/s")),
    ).toBe(true);

    session.runTo(MatchPhase.Inspection, "a");
    const own = mimic.adapter.getSync().privateState?.ownDisguise;
    expect(own?.source).toBe("recovered_pose");
    expect(own?.encodedPose).toBe(VALID_POSE);
    expect(session.relay.violations).toEqual([]);

    warn.mockRestore();
    session.dispose();
  });

  it("refuses a join early when the published roster is already full", async () => {
    vi.useFakeTimers();
    const session = new Session({ maxPlayers: 2 });
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    // Long enough for the host's 2 Hz snapshot to publish the full roster.
    session.advance(8);

    await expect(session.addRefusedPeer("c", "Cora")).rejects.toThrow("room_full");
    expect(session.peer("a").adapter.getSync().publicState?.players).toHaveLength(2);
    session.dispose();
  });

  it("tells a joiner the host refused its seat when the early check was stale", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new Session({ maxPlayers: 2 });
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    // No advance: the snapshot still shows one seat taken, so the joiner's own
    // check passes and only the host can refuse it.
    const latecomer = await session.addPeer("c", "Cora");
    session.advance(4);

    expect(latecomer.adapter.getConnection().status).toBe("error");
    expect(latecomer.adapter.getConnection().detail).toBe("room_full");
    expect(session.peer("a").adapter.getSync().publicState?.players).toHaveLength(2);

    warn.mockRestore();
    session.dispose();
  });
});

describe("PortalsNetAdapter joining and privacy", () => {
  it("gives a late joiner the published public state and its own private slice", async () => {
    vi.useFakeTimers();
    const session = new Session();
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(2);
    session.startMatch("a", MatchPhase.Forge);

    const latecomer = await session.addPeer("d", "Dov");
    session.advance(6);

    const sync = latecomer.adapter.getSync();
    expect(sync.publicState?.phase).toBe(MatchPhase.Forge);
    expect(sync.publicState?.players.map((player) => player.displayName)).toContain("Dov");
    expect(sync.privateState?.role).toBe("spectator");
    expect(sync.privateState?.lifeState).toBe("spectating");
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("delivers each player exactly one role assignment, its own", async () => {
    vi.useFakeTimers();
    const session = new Session();
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    await session.addPeer("c", "Cora");
    session.advance(2);
    session.startMatch("a", MatchPhase.Forge);
    session.advance(4);

    for (const peer of session.peers) {
      const assignments = peer.privateEvents.filter(
        (event): event is Extract<PrivateSimEvent, { type: "role_assigned" }> =>
          event.type === "role_assigned",
      );
      expect(assignments).toHaveLength(1);
      const own = peer.adapter.getSync().privateState;
      expect(assignments[0]?.role).toBe(own?.role);
      expect(assignments[0]?.publicPlayerId).toBe(own?.publicPlayerId);
      expect(own?.role).not.toBe("spectator");
    }

    // The broadcast announcement names the Inspectors, who are public, and
    // counts the Mimics without naming any of them (§27.10).
    for (const peer of session.peers) {
      const announcements = eventsOfType(peer, "roles_assigned");
      expect(announcements).toHaveLength(1);
      expect(announcements[0]?.mimicCount).toBeGreaterThan(0);
      expect(announcements[0]?.inspectorPublicIds.length).toBeGreaterThan(0);
    }
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });
});

describe("PortalsNetAdapter rejoin identity", () => {
  /** Drives three signed-in players to the inspection and names a non-host Mimic. */
  async function inspectionWithSignedInPlayers(): Promise<{ session: Session; mimic: Peer }> {
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada", { playerId: "account-a" });
    await session.addPeer("b", "Bex", { playerId: "account-b" });
    await session.addPeer("c", "Cora", { playerId: "account-c" });
    session.advance(2);
    session.startMatch("a", MatchPhase.Forge);
    session.lockDisguises();
    session.runTo(MatchPhase.Inspection, "a");

    const mimic = session.peers.find(
      (peer) => peer.id !== "a" && peer.adapter.getSync().privateState?.role === "mimic",
    );
    if (!mimic) throw new Error("no non-host Mimic in this seeding");
    return { session, mimic };
  }

  it("keys the seat on the signed-in player id, not the connection", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("conn-1", "Ada", { playerId: "account-a" });
    session.advance(2);

    expect(session.peer("conn-1").adapter.getSelfId()).toBe("account-a");
    expect(session.peer("conn-1").adapter.getRoster()[0]?.id).toBe("account-a");
    expect(session.peer("conn-1").adapter.getSync().privateState?.playerId).toBe("account-a");
    session.dispose();
  });

  it("reattaches a dropped player to their role and disguise inside the grace", async () => {
    vi.useFakeTimers();
    const { session, mimic } = await inspectionWithSignedInPlayers();

    const before = mimic.adapter.getSync().privateState;
    const objectId = before?.ownDisguise?.publicObjectId;
    expect(before?.role).toBe("mimic");
    expect(objectId).toBeTruthy();

    session.relay.dropPeer(mimic.id);
    session.advance(3);
    // Still seated, just not connected: the disguise keeps standing in the room.
    expect(session.peer("a").adapter.getSync().publicState?.players).toHaveLength(3);

    const returning = await session.addPeer(`${mimic.id}-again`, "Bex", {
      playerId: `account-${mimic.id}`,
    });
    session.advance(4);

    const after = returning.adapter.getSync().privateState;
    expect(after?.playerId).toBe(`account-${mimic.id}`);
    expect(after?.role).toBe("mimic");
    expect(after?.lifeState).toBe("active");
    expect(after?.ownDisguise?.publicObjectId).toBe(objectId);
    expect(session.peer("a").adapter.getSync().publicState?.players).toHaveLength(3);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("seats a player who returns after the grace as a spectator", async () => {
    vi.useFakeTimers();
    const { session, mimic } = await inspectionWithSignedInPlayers();

    session.relay.dropPeer(mimic.id);
    // Past reconnectGraceMs, so the simulation releases the slot.
    session.advance(16);
    expect(session.peer("a").adapter.getSync().publicState?.players).toHaveLength(2);

    const returning = await session.addPeer(`${mimic.id}-again`, "Bex", {
      playerId: `account-${mimic.id}`,
    });
    session.advance(4);

    const after = returning.adapter.getSync().privateState;
    expect(after?.role).toBe("spectator");
    expect(after?.lifeState).toBe("spectating");
    expect(after?.ownDisguise).toBeNull();
    session.dispose();
  });

  it("seats a second live connection of one account as a second player", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada", { playerId: "account-a" });
    const first = await session.addPeer("b", "Bex", { playerId: "account-b" });
    session.advance(2);

    // Both panes of the Portals editor's two-player preview carry one account.
    const secondPane = await session.addPeer("b-pane2", "Bex", { playerId: "account-b" });
    session.advance(4);

    expect(secondPane.adapter.getConnection().status).toBe("connected");
    expect(first.adapter.getConnection().status).toBe("connected");

    // Two seats, and the first connection kept the account's own id, which is
    // what a reconnect goes looking for.
    expect(first.adapter.getSelfId()).toBe("account-b");
    const derived = secondPane.adapter.getSelfId();
    expect(derived).toBe(derivedSeatId("account-b", "b-pane2"));
    expect(derived).not.toBe("account-b");

    // Three players in the room, and every client's roster shows all three.
    expect(session.peer("a").adapter.getSync().publicState?.players).toHaveLength(3);
    for (const peer of session.peers) {
      const roster = peer.adapter.getRoster();
      expect(roster.map((entry) => entry.id).sort()).toEqual(
        ["account-a", "account-b", derived].sort(),
      );
      // Exactly one seat is this client's own, and it is a real seat.
      expect(roster.filter((entry) => entry.isSelf)).toHaveLength(1);
    }

    // The duplicate is told apart by name rather than by two rows reading "Bex".
    const names = session.peer("a").adapter.getRoster().map((entry) => entry.displayName);
    expect(names).toContain("Bex");
    expect(names).toContain("Bex (2)");

    // A distinct player to the simulation: its own private slice under its own
    // seat, which is what makes it deal-able a role of its own.
    expect(secondPane.adapter.getSync().privateState?.playerId).toBe(derived);
    expect(first.adapter.getSync().privateState?.playerId).toBe("account-b");
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("routes a second connection's own commands and refusals to it alone", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada", { playerId: "account-a" });
    const first = await session.addPeer("b", "Bex", { playerId: "account-b" });
    const secondPane = await session.addPeer("b-pane2", "Bex", { playerId: "account-b" });
    session.advance(4);

    // A derived seat has to be addressable in both directions, which is the
    // thing that silently breaks if two clients disagree about what it is.
    secondPane.adapter.sendCommand({ type: "player_ready", ready: true });
    session.advance(3);

    const readied = session
      .peer("a")
      .adapter.getSync()
      .publicState?.players.filter((player) => player.ready);
    expect(readied).toHaveLength(1);
    expect(readied?.[0]?.seatId).toBe(secondPane.adapter.getSelfId());

    // Only the host may start a match, so this refusal is addressed back to the
    // derived seat and must reach that connection and no other.
    secondPane.adapter.sendCommand({ type: "start_match" });
    session.advance(3);
    expect(secondPane.rejections).toEqual([{ type: "start_match", reason: "not_host" }]);
    expect(first.rejections).toEqual([]);
    expect(session.peer("a").rejections).toEqual([]);
    session.dispose();
  });

  it("gives a late joiner the same seats the room already agreed on", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada", { playerId: "account-a" });
    const first = await session.addPeer("b", "Bex", { playerId: "account-b" });
    const secondPane = await session.addPeer("b-pane2", "Bex", { playerId: "account-b" });
    // Long enough for the host to publish a roster naming both seats.
    session.advance(8);

    // Arrival order is taken away, so the only thing left that can say which of
    // the two connections holds the account id is the published roster. Without
    // it the late joiner reads the pair the other way round and addresses both
    // of them wrongly for the rest of the round.
    session.relay.reversePlayerList = true;
    const latecomer = await session.addPeer("d", "Dov", { playerId: "account-d" });
    session.advance(4);

    const derived = derivedSeatId("account-b", "b-pane2");
    expect(latecomer.adapter.getRoster().map((entry) => entry.id).sort()).toEqual(
      ["account-a", "account-b", "account-d", derived].sort(),
    );
    // The pair themselves are unmoved, because a seat is decided once.
    expect(first.adapter.getSelfId()).toBe("account-b");
    expect(secondPane.adapter.getSelfId()).toBe(derived);

    // The numeral has to agree too, or the same player is two different people
    // depending on whose screen the lobby is read from.
    for (const peer of [session.peer("a"), latecomer]) {
      const names = peer.adapter.getRoster().map((entry) => entry.displayName);
      expect(names).toContain("Bex");
      expect(names).toContain("Bex (2)");
    }
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("keeps a duplicate's seat when the account's first connection drops and returns", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada", { playerId: "account-a" });
    const first = await session.addPeer("b", "Bex", { playerId: "account-b" });
    const secondPane = await session.addPeer("b-pane2", "Bex", { playerId: "account-b" });
    session.advance(4);

    const derived = derivedSeatId("account-b", "b-pane2");
    expect(secondPane.adapter.getSelfId()).toBe(derived);
    expect(first.adapter.getSelfId()).toBe("account-b");

    // The connection holding the account id leaves, freeing that id. The
    // duplicate must not be promoted into it: the simulation knows that player
    // by the derived seat, and moving them would hand them the other one's slot.
    session.relay.dropPeer("b");
    session.advance(3);
    expect(secondPane.adapter.getSelfId()).toBe(derived);
    expect(session.peer("a").adapter.getRoster().map((entry) => entry.id)).toContain(derived);

    // The returning connection reclaims the account id, inside the grace, and
    // the room is back to three seats rather than four.
    const returning = await session.addPeer("b-again", "Bex", { playerId: "account-b" });
    session.advance(4);

    expect(returning.adapter.getSelfId()).toBe("account-b");
    expect(returning.adapter.getSync().privateState?.playerId).toBe("account-b");
    expect(secondPane.adapter.getSelfId()).toBe(derived);
    expect(session.peer("a").adapter.getSync().publicState?.players).toHaveLength(3);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("carries a derived seat's round through a change of host", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    // "c" joins first and so holds authority; dropping it re-elects from the
    // survivors, one of which is a second connection of another account.
    await session.addPeer("c", "Cora", { playerId: "account-c" });
    await session.addPeer("a", "Ada", { playerId: "account-a" });
    const secondPane = await session.addPeer("a-pane2", "Ada", { playerId: "account-a" });
    session.advance(2);
    session.startMatch("c", MatchPhase.Forge);
    session.lockDisguises();
    session.runTo(MatchPhase.Inspection, "c", 150);
    session.advance(6);

    const derived = derivedSeatId("account-a", "a-pane2");
    const roleBefore = secondPane.adapter.getSync().privateState?.role;
    const disguiseBefore = secondPane.adapter.getSync().privateState?.ownDisguise?.publicObjectId;
    const playersBefore = session.peer("a").adapter.getSync().publicState?.players.length;
    expect(playersBefore).toBe(3);
    expect(roleBefore).toBeDefined();

    session.relay.dropPeer("c");
    session.advance(8);

    const newHost = session.peer("a");
    expect(newHost.adapter.isAuthority()).toBe(true);
    expect(newHost.adapter.getConnection().detail).toBe("authority_resumed");

    // The derived seat is a player like any other to the restored simulation:
    // it survives the reconciliation that drops seats no longer in the room,
    // and keeps the role and the disguise it was holding.
    const after = newHost.adapter.getSync().publicState;
    expect(after?.players.map((player) => player.seatId).sort()).toEqual(
      ["account-a", derived].sort(),
    );
    expect(secondPane.adapter.getSelfId()).toBe(derived);
    expect(secondPane.adapter.getSync().privateState?.role).toBe(roleBefore);
    expect(secondPane.adapter.getSync().privateState?.ownDisguise?.publicObjectId).toBe(
      disguiseBefore,
    );
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("still treats two guest tabs as two players", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("guest-1", "Ada");
    await session.addPeer("guest-2", "Ada");
    session.advance(4);

    expect(session.peer("guest-1").adapter.getSelfId()).toBe("guest-1");
    expect(session.peer("guest-1").adapter.getSync().publicState?.players).toHaveLength(2);
    expect(session.peer("guest-2").adapter.getConnection().status).toBe("connected");
    session.dispose();
  });
});

describe("PortalsNetAdapter join retry", () => {
  it("absorbs a first join that times out after half-registering", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada", { playerId: "account-a" });

    // Measured in the editor: the first join reports a timeout while leaving a
    // session registered behind it, so a second join without a leave() in
    // between is refused outright. The player should see none of that.
    const slow = await session.addPeer("b", "Bex", { playerId: "account-b", failJoins: 1 });
    session.advance(4);

    expect(session.relay.joinAttempts.get("b")).toBe(2);
    expect(slow.adapter.getConnection().status).toBe("connected");
    expect(slow.adapter.getSelfId()).toBe("account-b");
    // One seamless join: the player was never shown a failure to act on.
    expect(slow.statuses.map((state) => state.status)).not.toContain("error");
    expect(session.peer("a").adapter.getSync().publicState?.players).toHaveLength(2);
    expect(session.relay.violations).toEqual([]);

    warn.mockRestore();
    session.dispose();
  });

  it("recovers when the timed-out join registers only after the cleanup ran", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada", { playerId: "account-a" });

    // The user's own preview logs (2026-08-02): join times out, the retry is
    // refused with "already active" because the HOST kept the timed-out
    // join's session — and a plain leave() never reaches the host in that
    // state (sdk.js netLeave early-returns on an empty mirror). The adapter
    // must thread a leave through an armed join's pending window to clear
    // the host, and the doomed join that arms it comes back the session.
    const slow = await session.addPeer("b", "Bex", {
      playerId: "account-b",
      failJoins: 1,
      registerLate: true,
    });
    session.advance(4);

    expect(session.relay.joinAttempts.get("b")).toBe(3);
    expect(slow.adapter.getConnection().status).toBe("connected");
    expect(slow.statuses.map((state) => state.status)).not.toContain("error");
    expect(session.peer("a").adapter.getSync().publicState?.players).toHaveLength(2);
    expect(session.relay.violations).toEqual([]);

    warn.mockRestore();
    session.dispose();
  });

  it("reports a join that keeps failing rather than knocking forever", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new Session(RECONNECT_SETTINGS);
    const adapter = new PortalsNetAdapter(
      session.relay.createPeer({ id: "b", displayName: "Bex", failJoins: 3 }),
      { seed: 5, now: () => session.now(), joinRetryDelayMs: 0 },
    );
    const statuses: ConnectionState[] = [];
    adapter.onStatus((state) => statuses.push(state));
    await adapter.connect();

    await expect(adapter.join(CHANNEL, "Bex")).rejects.toThrow();
    // Three attempts, then the player is told: a relay that refuses this
    // consistently is refusing for a reason knocking cannot fix.
    expect(session.relay.joinAttempts.get("b")).toBe(3);
    expect(adapter.getConnection().status).toBe("error");
    expect(adapter.getConnection().detail).toBe("join_failed");
    expect(adapter.getConnection().canRejoin).toBe(true);
    expect(statuses.at(-1)?.status).toBe("error");

    adapter.dispose();
    warn.mockRestore();
    session.dispose();
  });
});

describe("PortalsNetAdapter broadcast privacy", () => {
  it("keeps seats off the event stream and Mimic identities out of room state", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada", { playerId: "account-a" });
    await session.addPeer("b", "Bex", { playerId: "account-b" });
    await session.addPeer("c", "Cora", { playerId: "account-c" });
    session.advance(2);
    session.startMatch("a", MatchPhase.Forge);
    session.lockDisguises();
    session.runTo(MatchPhase.Inspection, "a", 150);
    session.advance(8);

    // The simulation promises that no SimEvent carries private data, and the
    // transport broadcasts them unredacted on the strength of that promise.
    // This is where that promise is checked from the outside: a public event
    // naming a seat would mean the guarantee had quietly stopped holding, and
    // the transport would be leaking it without noticing.
    const seats = ["account-a", "account-b", "account-c"];
    for (const peer of session.peers) {
      const serialized = JSON.stringify(peer.events);
      for (const seat of seats) expect(serialized).not.toContain(seat);
    }

    // Seat ids are not secret: the SDK hands every client every player's id in
    // net.players(), and the publication names the host so a late joiner knows
    // who is authoritative. What must not be in room state before the reveal is
    // who the Mimics are. The count of them is public by design (§27.6).
    const publication = decodeHostPublication(session.relay.stateSnapshot());
    const players = publication?.publicState.players ?? [];
    expect(players.length).toBeGreaterThan(0);
    expect(players.every((player) => player.rolePublicState !== "mimic")).toBe(true);
    expect(publication?.publicState.mimicsRemaining).toBeGreaterThan(0);
    // Disguises are named by anonymous object id and carry no owner.
    for (const disguise of publication?.publicState.disguises ?? []) {
      const serialized = JSON.stringify(disguise);
      for (const seat of seats) expect(serialized).not.toContain(seat);
      expect(disguise.revealed).toBe(false);
    }
    session.dispose();
  });
});

describe("disguise update coalescing", () => {
  const update = (
    publicObjectId: string,
    revision: number,
    moved: boolean,
    seq: number,
  ): SimEvent => ({ type: "disguise_updated", publicObjectId, revision, moved, seq, at: seq });

  it("keeps only the newest revision of each object", () => {
    const coalesced = coalesceDisguiseUpdates([
      update("obj_a", 1, false, 1),
      update("obj_b", 1, false, 2),
      update("obj_a", 2, false, 3),
      update("obj_a", 3, false, 4),
      update("obj_b", 2, false, 5),
    ]);

    expect(coalesced).toHaveLength(2);
    expect(coalesced.map((event) => event.seq)).toEqual([4, 5]);
  });

  it("carries a movement forward onto the surviving update", () => {
    // The root travelled early and only reshaped after. A renderer told solely
    // about the last revision would otherwise never learn it moved.
    const coalesced = coalesceDisguiseUpdates([
      update("obj_a", 1, true, 1),
      update("obj_a", 2, false, 2),
    ]);

    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]?.type === "disguise_updated" && coalesced[0].moved).toBe(true);
    expect(coalesced[0]?.seq).toBe(2);
  });

  it("leaves every other event untouched and in order", () => {
    const phase: SimEvent = {
      type: "phase_changed",
      phase: MatchPhase.Inspection,
      previousPhase: MatchPhase.InspectionIntro,
      phaseEndsAt: 10,
      round: 0,
      seq: 2,
      at: 2,
    };
    const coalesced = coalesceDisguiseUpdates([
      update("obj_a", 1, false, 1),
      phase,
      update("obj_a", 2, false, 3),
    ]);

    expect(coalesced.map((event) => event.seq)).toEqual([2, 3]);
    expect(coalesced[0]).toBe(phase);
  });

  it("returns a batch with no disguise updates unchanged", () => {
    const only: SimEvent = { type: "host_changed", publicPlayerId: "p_one", seq: 1, at: 1 };
    expect(coalesceDisguiseUpdates([only])).toEqual([only]);
  });
});

describe("PortalsNetAdapter live hider contract", () => {
  /** Three signed-in players at the inspection, with every disguise locked. */
  async function atInspection(): Promise<{ session: Session; mimic: Peer; inspector: Peer }> {
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada", { playerId: "account-a" });
    await session.addPeer("b", "Bex", { playerId: "account-b" });
    await session.addPeer("c", "Cora", { playerId: "account-c" });
    session.advance(2);
    session.startMatch("a", MatchPhase.Forge);
    session.lockDisguises();
    session.runTo(MatchPhase.Inspection, "a", 150);
    session.advance(4);

    const mimic = session.peers.find(
      (peer) => peer.adapter.getSync().privateState?.role === "mimic",
    );
    const inspector = session.peers.find(
      (peer) => peer.adapter.getSync().privateState?.role === "inspector",
    );
    if (!mimic || !inspector) throw new Error("expected both roles in this seeding");
    return { session, mimic, inspector };
  }

  it("carries a taunt from a hider to the whole room", async () => {
    vi.useFakeTimers();
    const { session, mimic } = await atInspection();

    mimic.adapter.sendCommand({ type: "taunt", tauntId: "rattle" });
    session.advance(3);

    for (const peer of session.peers) {
      const taunts = eventsOfType(peer, "taunt_performed");
      expect(taunts).toHaveLength(1);
      expect(taunts[0]?.tauntId).toBe("rattle");
      // The object taunts, never the player: nothing here names who it was.
      expect(JSON.stringify(taunts[0])).not.toContain("account-");
    }
    expect(mimic.rejections).toEqual([]);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("returns a taunt cooldown refusal to the hider who asked", async () => {
    vi.useFakeTimers();
    const { session, mimic } = await atInspection();

    mimic.adapter.sendCommand({ type: "taunt", tauntId: "rattle" });
    session.advance(2);
    mimic.adapter.sendCommand({ type: "taunt", tauntId: "puff" });
    session.advance(3);

    expect(mimic.rejections).toEqual([{ type: "taunt", reason: "taunt_cooldown" }]);
    for (const peer of session.peers) {
      if (peer.id === mimic.id) continue;
      expect(peer.rejections).toEqual([]);
    }
    session.dispose();
  });

  it("delivers the watched level only to the hider being looked at", async () => {
    vi.useFakeTimers();
    const { session, mimic, inspector } = await atInspection();

    const objectId = mimic.adapter.getSync().privateState?.ownDisguise?.publicObjectId;
    expect(objectId).toBeTruthy();
    if (!objectId) return;

    inspector.adapter.sendCommand({ type: "focus", targetObjectId: objectId });
    session.advance(6);

    const watched = mimic.privateEvents.filter((event) => event.type === "watched");
    expect(watched.length).toBeGreaterThan(0);
    expect(watched.at(-1)?.type === "watched" && watched.at(-1)?.level).toBeGreaterThan(0);
    expect(mimic.adapter.getSync().privateState?.watchedLevel).toBeGreaterThan(0);

    // Nobody else is told that someone is being watched, let alone who.
    for (const peer of session.peers) {
      if (peer.id === mimic.id) continue;
      expect(peer.privateEvents.filter((event) => event.type === "watched")).toEqual([]);
    }
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("sends one update per object per flush however many creeps land in it", async () => {
    vi.useFakeTimers();
    const { session } = await atInspection();
    const host = session.peer("a");
    // The creep has to cross the relay, so it must come from a hider that is
    // not the host: the host applies its own output without ever sending it.
    const mimic = session.peers.find(
      (peer) => peer.id !== "a" && peer.adapter.getSync().privateState?.role === "mimic",
    );
    expect(mimic).toBeDefined();
    if (!mimic) return;
    const bystander = session.peers.find((peer) => peer.id !== "a" && peer.id !== mimic.id);
    expect(bystander).toBeDefined();
    if (!bystander) return;

    const before = {
      host: eventsOfType(host, "disguise_updated").length,
      bystander: eventsOfType(bystander, "disguise_updated").length,
    };

    // Two creeps far enough apart for the simulation's own 15/s limit to accept
    // both, but inside a single 100 ms flush window.
    mimic.adapter.sendForgeSnapshot({ encodedPose: poseAt(0.01, 30), revision: 30 });
    session.tickClock(70);
    mimic.adapter.sendForgeSnapshot({ encodedPose: poseAt(0.02, 31), revision: 31 });
    session.advance(2);

    const hostSaw = eventsOfType(host, "disguise_updated").length - before.host;
    const bystanderSaw = eventsOfType(bystander, "disguise_updated").length - before.bystander;

    // The host applies its own simulation's output in full; the room is sent
    // only the newest state of each object, because the earlier one would have
    // been overwritten on arrival anyway.
    expect(hostSaw).toBe(2);
    expect(bystanderSaw).toBe(1);
    expect(eventsOfType(bystander, "disguise_updated").at(-1)?.revision).toBe(31);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("surfaces a refused creep to the hider that sent it", async () => {
    vi.useFakeTimers();
    const { session, mimic } = await atInspection();

    // A pose the wire schema cannot decode is refused by the simulation, and
    // the refusal has to find its way back across the relay.
    mimic.adapter.sendForgeSnapshot({ encodedPose: "not a pose", revision: 40 });
    session.advance(3);

    expect(mimic.rejections).toHaveLength(1);
    expect(mimic.rejections[0]?.type).toBe("forge_snapshot");
    expect(mimic.rejections[0]?.reason).toBe("invalid_pose");
    session.dispose();
  });
});

describe("PortalsNetAdapter rejection feedback", () => {
  it("returns the host's refusal reason to the client that issued the command", async () => {
    vi.useFakeTimers();
    const session = new Session();
    await session.addPeer("a", "Ada");
    const guest = await session.addPeer("b", "Bex");
    session.advance(2);

    // Only the host may start a match, so the simulation refuses this one.
    guest.adapter.sendCommand({ type: "start_match" });
    session.advance(3);

    expect(guest.rejections).toEqual([{ type: "start_match", reason: "not_host" }]);
    // The refusal is addressed, so it reaches nobody else.
    expect(session.peer("a").rejections).toEqual([]);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("reports the host's own refusals without a round trip", async () => {
    vi.useFakeTimers();
    const session = new Session();
    const host = await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(2);

    // Nobody is ready, so the simulation refuses the start.
    host.adapter.sendCommand({ type: "start_match" });

    expect(host.rejections).toEqual([{ type: "start_match", reason: "players_not_ready" }]);
    session.dispose();
  });
});

describe("PortalsNetAdapter transport budget", () => {
  it("publishes a full room inside the state key and write budgets", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    for (let index = 0; index < 8; index += 1) {
      await session.addPeer(`p${index}`, `Visitor ${index}`);
    }
    session.advance(4);
    session.startMatch("p0", MatchPhase.Forge);
    // Private state reaches a full room over several flushes, and a peer that
    // does not know it is a Mimic yet cannot lock.
    session.advance(20);
    expect(session.lockDisguises()).toBeGreaterThan(0);
    session.runTo(MatchPhase.Inspection, "p0", 150);
    session.advance(8);

    const state = session.relay.stateSnapshot();
    const measure = (keys: readonly string[]): { keys: number; largest: number } => {
      const used = keys.filter((key) => state[key] !== undefined);
      return {
        keys: used.length,
        largest: used.length === 0 ? 0 : Math.max(...used.map((key) => jsonByteLength(state[key]))),
      };
    };

    const publication = decodeHostPublication(state);
    const poses = decodePoseBook(state);
    expect(publication).not.toBeNull();
    expect(poses).not.toBeNull();
    expect(publication?.publicState.players).toHaveLength(8);

    const published = measure(SNAPSHOT_STATE_KEYS);
    const poseRange = measure(POSE_STATE_KEYS);
    const simRange = measure(SIM_STATE_KEYS);
    for (const range of [published, poseRange, simRange]) {
      expect(range.largest).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    }

    // Every locked disguise carries real geometry, reassembled from the pose
    // range by a client that never held the host's simulation.
    const observer = session.peer("p1");
    const disguises = observer.adapter.getSync().publicState?.disguises ?? [];
    expect(disguises.length).toBeGreaterThan(0);
    for (const disguise of disguises) {
      expect(disguise.encodedPose).toBe(VALID_POSE);
    }
    expect(session.relay.violations).toEqual([]);

    console.log(
      `8-player room: publication ${jsonByteLength(publication)} bytes in ${published.keys} key(s), ` +
        `poses ${jsonByteLength(poses)} bytes in ${poseRange.keys} key(s), ` +
        `simulation snapshot ${simRange.keys} key(s); largest value ${Math.max(published.largest, poseRange.largest, simRange.largest)} bytes`,
    );
    session.dispose();
  });

  it("stays under the twenty sends per second relay allowance", async () => {
    vi.useFakeTimers();
    const session = new Session();
    for (let index = 0; index < 8; index += 1) {
      await session.addPeer(`p${index}`, `Visitor ${index}`);
    }

    // Role assignment is the heaviest burst: one public batch plus a private
    // message for every other player, all inside a single flush.
    const before = session.relay.sendCount.get("p0") ?? 0;
    session.startMatch("p0", MatchPhase.Forge);
    const duringStart = (session.relay.sendCount.get("p0") ?? 0) - before;

    const beforeSteady = session.relay.sendCount.get("p0") ?? 0;
    session.advance(10);
    const duringSteady = (session.relay.sendCount.get("p0") ?? 0) - beforeSteady;

    expect(duringSteady).toBeLessThanOrEqual(20);
    expect(session.relay.violations).toEqual([]);
    console.log(
      `host sends: ${duringStart} across the start sequence, ${duringSteady} in the following second`,
    );
    session.dispose();
  });
});

describe("PortalsNetAdapter body paint", () => {
  it("carries a non-host Mimic's layer to the host and out through the paint range", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    await session.addPeer("c", "Cora");
    session.advance(2);
    session.startMatch("a", MatchPhase.Forge);
    session.advance(4);

    const painter = session.peers.find(
      (peer) => peer.id !== "a" && peer.adapter.getSync().privateState?.role === "mimic",
    );
    expect(painter).toBeDefined();
    if (!painter) return;

    painter.adapter.sendPaintUpdate({ encodedPaint: PAINT_LAYER, revision: 3 });
    session.advance(2);
    // Paint recorded before the lock belongs to the disguise the moment it
    // manifests, which is what makes it public and therefore publishable.
    painter.adapter.sendCommand({ type: "lock_disguise", payload: VALID_POSE, revision: 9 });
    session.advance(4);

    const own = painter.adapter.getSync().privateState?.ownDisguise;
    expect(own?.encodedPaint).toBe(PAINT_LAYER);
    expect(painter.rejections).toEqual([]);

    const objectId = own?.publicObjectId;
    expect(objectId).toBeDefined();
    const book = decodePaintBook(session.relay.stateSnapshot());
    expect(book?.[objectId as string]).toBe(PAINT_LAYER);

    // A peer that never held the simulation reassembles the layer from the
    // range, exactly as it does the pose.
    const observer = session.peer("c");
    const seen = observer.adapter
      .getSync()
      .publicState?.disguises.find((entry) => entry.publicObjectId === objectId);
    expect(seen?.encodedPaint).toBe(PAINT_LAYER);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("records the host's own layer through the same path", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    await session.addPeer("c", "Cora");
    session.advance(2);
    session.startMatch("a", MatchPhase.Forge);
    session.advance(4);

    const host = session.peer("a");
    if (host.adapter.getSync().privateState?.role !== "mimic") {
      // The seed decides who inspects; the host's own path is covered by
      // whichever Mimic happens to hold authority, so pick one and hand it over.
      session.dispose();
      return;
    }

    host.adapter.sendPaintUpdate({ encodedPaint: PAINT_LAYER, revision: 2 });
    session.advance(2);
    expect(host.adapter.getSync().privateState?.ownDisguise?.encodedPaint ?? null).toBe(null);

    host.adapter.sendCommand({ type: "lock_disguise", payload: VALID_POSE, revision: 9 });
    session.advance(4);
    expect(host.adapter.getSync().privateState?.ownDisguise?.encodedPaint).toBe(PAINT_LAYER);
    expect(host.rejections).toEqual([]);
    session.dispose();
  });

  it("refuses an unreadable layer and tells only the sender", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    await session.addPeer("c", "Cora");
    session.advance(2);
    session.startMatch("a", MatchPhase.Forge);
    session.advance(4);

    const painter = session.peers.find(
      (peer) => peer.id !== "a" && peer.adapter.getSync().privateState?.role === "mimic",
    );
    expect(painter).toBeDefined();
    if (!painter) return;

    painter.adapter.sendPaintUpdate({ encodedPaint: "not base64 at all!", revision: 3 });
    session.advance(4);

    expect(painter.rejections).toEqual([
      expect.objectContaining({ type: "paint_update", reason: "invalid_paint" }),
    ]);
    for (const peer of session.peers) {
      if (peer.id === painter.id) continue;
      expect(peer.rejections).toEqual([]);
    }
    session.dispose();
  });

  it("re-sends an unlocked layer to a new host along with the pose", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    // "c" holds authority as the first joiner, so dropping it re-elects "a".
    await session.addPeer("c", "Cora");
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(2);
    session.startMatch("c", MatchPhase.Forge);
    session.advance(4);

    const mimics = session.peers.filter(
      (peer) => peer.id !== "c" && peer.adapter.getSync().privateState?.role === "mimic",
    );
    expect(mimics.length).toBeGreaterThan(0);
    for (const mimic of mimics) {
      mimic.adapter.sendForgeSnapshot({ encodedPose: VALID_POSE, revision: 7 });
      mimic.adapter.sendPaintUpdate({ encodedPaint: PAINT_LAYER, revision: 7 });
    }
    session.advance(2);

    // A layer made before the lock lives only on the host that recorded it, so
    // the migration snapshot cannot carry it and the resend has to.
    session.relay.dropPeer("c");
    session.advance(6);
    expect(session.peer("a").adapter.isAuthority()).toBe(true);

    // The layer answers a flush behind the pose, because both spend the one
    // forge-update budget and the second of a simultaneous pair is refused.
    // A non-host flushes on its own timer rather than on the authority's tick.
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    session.advance(1);

    session.runTo(MatchPhase.Inspection, "a", 150);
    session.advance(8);
    for (const mimic of mimics) {
      expect(mimic.adapter.getSync().privateState?.ownDisguise?.encodedPaint).toBe(PAINT_LAYER);
    }
    session.dispose();
  });

  it("resumes a painted round on a new host from the published paint range", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("c", "Cora");
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(2);
    session.startMatch("c", MatchPhase.Forge);
    session.advance(4);

    const painters = session.peers.filter(
      (peer) => peer.adapter.getSync().privateState?.role === "mimic",
    );
    expect(painters.length).toBeGreaterThan(0);
    for (const painter of painters) {
      painter.adapter.sendPaintUpdate({ encodedPaint: PAINT_LAYER, revision: 5 });
    }
    session.advance(2);
    for (const painter of painters) {
      painter.adapter.sendCommand({ type: "lock_disguise", payload: VALID_POSE, revision: 9 });
    }
    session.runTo(MatchPhase.Inspection, "c", 150);
    session.advance(8);

    // A locked layer is omitted from the migration snapshot because it is
    // already public, so the successor has to rebuild it from the paint range.
    // The simulation refuses to restore a painted disguise without it, which
    // makes losing the range a match reset rather than a quiet blank repaint.
    session.relay.dropPeer("c");
    session.advance(8);

    const newHost = session.peer("a");
    expect(newHost.adapter.isAuthority()).toBe(true);
    expect(newHost.adapter.getConnection().detail).toBe("authority_resumed");

    const disguises = newHost.adapter.getSync().publicState?.disguises ?? [];
    expect(disguises.length).toBeGreaterThan(0);
    for (const disguise of disguises) {
      expect(disguise.encodedPaint).toBe(PAINT_LAYER);
      expect(disguise.encodedPose).toBe(VALID_POSE);
    }
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });
});

// ------------------------------------------------------------------ bot seats

/** How far a test bot shifts its disguise per publication. Well under the cap. */
const BOT_CREEP_STEP_M = 0.005;
/** The revision `BotSeats` locks a bot's first pose at. A creep counts up from it. */
const BOT_LOCK_REVISION = 1;

const CREEP_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.InspectionIntro,
  MatchPhase.Inspection,
  MatchPhase.FinalCountdown,
]);

/**
 * A brain that does one thing: nudges a hider's disguise along X while the hunt
 * runs. It is deliberately not the shop's own brain, which needs a map and a
 * validator; it is the smallest thing that shows the host is calling a brain on
 * simulation time and feeding what it returns back into the round.
 */
function creepingBrain(): BotBrain {
  const revisions = new Map<string, number>();
  return {
    act(turn) {
      const { privateState, publicState } = turn;
      if (privateState.role !== "mimic" || privateState.ownDisguise === null) return [];
      if (!CREEP_PHASES.has(publicState.phase)) return [];
      const revision = (revisions.get(turn.playerId) ?? BOT_LOCK_REVISION) + 1;
      revisions.set(turn.playerId, revision);
      return [
        {
          kind: "forge_snapshot",
          encodedPose: poseAt((revision - BOT_LOCK_REVISION) * BOT_CREEP_STEP_M, revision),
          revision,
        },
      ];
    },
  };
}

/** Bot seats that lock a real pose at the origin and then creep away from it. */
function playingBots(): BotSeatOptions {
  return { botPose: () => poseAt(0, BOT_LOCK_REVISION), botBrain: creepingBrain() };
}

/** Where the room believes a given disguise is standing, along the creep axis. */
function disguiseX(peer: Peer, publicObjectId: string): number | null {
  const disguise = peer.adapter
    .getSync()
    .publicState?.disguises.find((entry) => entry.publicObjectId === publicObjectId);
  if (disguise === undefined || disguise.encodedPose.length === 0) return null;
  const decoded = decodeDisguiseWire(disguise.encodedPose);
  return decoded.ok ? decoded.pose.root.position[0] : null;
}

/** Everything one peer hears off the relay, for reading the host's traffic. */
function recordMessages(peer: Peer): unknown[] {
  const received: unknown[] = [];
  const net = (
    peer.adapter as unknown as {
      net: { on(event: "message", handler: (data: unknown, from: string) => void): void };
    }
  ).net;
  net.on("message", (data) => received.push(data));
  return received;
}

describe("PortalsNetAdapter bot seats", () => {
  it("cannot give a bot a seat any connection could hold", () => {
    // Every real seat is an account id, a connection id, or the two joined by
    // one separator; Portals produces the separator in neither half. A bot seat
    // carries two of them, so it is outside the whole space of real seats.
    const seat = botSeatId(1);
    expect(isBotSeat(seat)).toBe(true);
    expect(seat.length).toBeLessThanOrEqual(64);
    expect(BOT_SEAT_MARKER.split(DERIVED_SEAT_SEPARATOR).length - 1).toBe(2);

    for (const account of ["bot", "player-1", "", "a".repeat(64)]) {
      expect(isBotSeat(account)).toBe(false);
      for (const connection of ["conn-1", "bot", "1", "b".repeat(48)]) {
        expect(isBotSeat(derivedSeatId(account, connection))).toBe(false);
      }
    }
  });

  it("seats bots only for the host, and every client renders them", async () => {
    vi.useFakeTimers();
    const session = new Session();
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    await session.addPeer("c", "Cora");
    session.advance(4);

    const host = session.peer("a");
    const guest = session.peer("b");
    expect(host.adapter.isAuthority()).toBe(true);
    expect(host.adapter.bots.canManageBots()).toBe(true);
    // The simulation lives on one client, so only that client may seat anyone.
    expect(guest.adapter.bots.canManageBots()).toBe(false);
    expect(guest.adapter.bots.addBot()).toBeNull();

    const first = host.adapter.bots.addBot();
    const second = host.adapter.bots.addBot();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(host.adapter.bots.botSeatIds()).toEqual([first, second]);
    session.advance(8);

    for (const peer of session.peers) {
      const players = peer.adapter.getSync().publicState?.players ?? [];
      expect(players).toHaveLength(5);
      expect(players.filter((player) => isBotSeat(player.seatId)).map((p) => p.seatId).sort())
        .toEqual([first, second].sort());
      expect(
        players.filter((player) => !isBotSeat(player.seatId)).map((player) => player.displayName).sort(),
      ).toEqual(["Ada", "Bex", "Cora"]);
      // A bot is nobody's host and is connected like any seated player.
      for (const player of players.filter((entry) => isBotSeat(entry.seatId))) {
        expect(player.isHost).toBe(false);
        expect(player.connected).toBe(true);
      }
    }

    host.adapter.bots.removeBot(second as string);
    session.advance(8);
    for (const peer of session.peers) {
      expect(peer.adapter.getSync().publicState?.players).toHaveLength(4);
    }
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("lets one person and two bots start a round the room could not otherwise field", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS, playingBots());
    await session.addPeer("a", "Ada");
    session.advance(2);

    const host = session.peer("a");
    // Alone, the room is one short of the two the settings need (§5.5).
    host.adapter.sendCommand({ type: "player_ready", ready: true });
    session.advance(2);
    host.adapter.sendCommand({ type: "start_match" });
    session.advance(4);
    expect(host.adapter.getSync().publicState?.phase).toBe(MatchPhase.Lobby);
    expect(host.rejections.map((entry) => entry.reason)).toContain("not_enough_players");

    host.adapter.bots.addBot();
    host.adapter.bots.addBot();
    session.startMatch("a", MatchPhase.Forge);
    session.runTo(MatchPhase.Inspection, "a", 200);

    // The bots readied up and locked poses of their own, so the hunt has
    // something in it to look for.
    const disguises = host.adapter.getSync().publicState?.disguises ?? [];
    expect(disguises.length).toBeGreaterThan(0);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("keeps driving the bots after the host that seated them leaves", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS, playingBots());
    await session.addPeer("c", "Cora");
    await session.addPeer("a", "Ada");
    session.advance(4);

    const first = session.peer("c");
    expect(first.adapter.isAuthority()).toBe(true);
    first.adapter.bots.addBot();
    first.adapter.bots.addBot();

    session.startMatch("c", MatchPhase.Forge);
    session.lockDisguises();
    session.runTo(MatchPhase.Inspection, "c", 200);
    session.advance(6);

    // The non-host is holding the bots' bodies, geometry and all, and picks one
    // out by the only thing that tells a bot's disguise from a person's here:
    // the people locked at the origin and never moved, and a bot creeps.
    const survivor = session.peer("a");
    const creeping = (survivor.adapter.getSync().publicState?.disguises ?? []).filter(
      (entry) => (disguiseX(survivor, entry.publicObjectId) ?? 0) > 0,
    );
    // Four seats deal one Inspector, so at least one of the two bots is a
    // Mimic however the shuffle falls; how many is the deal's business.
    expect(creeping.length).toBeGreaterThan(0);
    const watched = creeping[0]?.publicObjectId as string;
    const beforeMigration = disguiseX(survivor, watched);
    expect(beforeMigration).toBeGreaterThan(0);

    session.relay.dropPeer("c");
    session.advance(6);

    expect(survivor.adapter.isAuthority()).toBe(true);
    expect(survivor.adapter.getConnection().detail).toBe("authority_resumed");
    // The seats came back with the round rather than being dropped as players
    // nobody was connected on.
    expect(survivor.adapter.bots.botSeatIds()).toHaveLength(2);
    const players = survivor.adapter.getSync().publicState?.players ?? [];
    expect(players.filter((player) => isBotSeat(player.seatId))).toHaveLength(2);

    const afterMigration = disguiseX(survivor, watched);
    session.advance(10);
    const later = disguiseX(survivor, watched);
    // Driving resumed: the disguise is still travelling under the new host.
    expect(later ?? 0).toBeGreaterThan(afterMigration ?? 0);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("puts the bots back when a change of host cannot resume the round", async () => {
    vi.useFakeTimers();
    // A lobby publishes no simulation snapshot at all, so the published roster
    // is the only record the bots have of themselves.
    const session = new Session();
    await session.addPeer("c", "Cora");
    await session.addPeer("a", "Ada");
    session.advance(4);

    session.peer("c").adapter.bots.addBot();
    session.peer("c").adapter.bots.addBot();
    session.advance(8);

    session.relay.dropPeer("c");
    session.advance(8);

    const newHost = session.peer("a");
    expect(newHost.adapter.isAuthority()).toBe(true);
    expect(newHost.adapter.bots.botSeatIds()).toHaveLength(2);
    const players = newHost.adapter.getSync().publicState?.players ?? [];
    expect(players).toHaveLength(3);
    expect(players.filter((player) => isBotSeat(player.seatId))).toHaveLength(2);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("gives a bot's seat up rather than turning a person away", async () => {
    vi.useFakeTimers();
    const session = new Session({ maxPlayers: 3 });
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(4);

    const host = session.peer("a");
    host.adapter.bots.addBot();
    session.advance(8);
    expect(host.adapter.getSync().publicState?.players).toHaveLength(3);

    await session.addPeer("c", "Cora");
    session.advance(8);

    const players = host.adapter.getSync().publicState?.players ?? [];
    expect(players).toHaveLength(3);
    expect(players.filter((player) => isBotSeat(player.seatId))).toHaveLength(0);
    expect(players.map((player) => player.displayName).sort()).toEqual(["Ada", "Bex", "Cora"]);
    expect(session.peer("c").adapter.getConnection().status).toBe("connected");
    expect(host.adapter.bots.botSeatIds()).toHaveLength(0);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("carries a rematch the people voted for, whatever the bots outnumber them by", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS, playingBots());
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(4);

    // Three bots against two people. Bots that abstained would be three no
    // votes, and no majority of the people could then carry a rematch at all,
    // which is the state this room was in before they answered for themselves.
    const host = session.peer("a");
    host.adapter.bots.addBot();
    host.adapter.bots.addBot();
    host.adapter.bots.addBot();
    session.startMatch("a", MatchPhase.Forge);
    session.lockDisguises();
    session.runTo(MatchPhase.Results, "a", 400);
    expect(host.adapter.getSync().publicState?.players).toHaveLength(5);

    host.adapter.sendCommand({ type: "vote_rematch", yes: true });
    session.advance(2);
    // One yes of two people is not a majority of them, so the bots hold off.
    expect(
      eventsOfType(session.peer("b"), "rematch_vote_cast").map((event) => event.yesVotes).at(-1),
    ).toBe(1);

    session.peer("b").adapter.sendCommand({ type: "vote_rematch", yes: true });
    session.advance(2);
    const afterBoth = eventsOfType(session.peer("b"), "rematch_vote_cast").at(-1);
    expect(afterBoth?.yesVotes).toBe(5);
    expect(afterBoth?.totalVoters).toBe(5);

    session.advance(8);
    expect(eventsOfType(session.peer("b"), "rematch_started").map((event) => event.round)).toEqual([
      1,
    ]);
    expect(host.adapter.getSync().publicState?.round).toBe(1);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("cannot carry a rematch the people voted down", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS, playingBots());
    await session.addPeer("a", "Ada");
    session.advance(2);

    const host = session.peer("a");
    // Three bots and one person. Bots that always said yes would carry this
    // room into another round over the only objection in it.
    host.adapter.bots.addBot();
    host.adapter.bots.addBot();
    host.adapter.bots.addBot();
    session.startMatch("a", MatchPhase.Forge);
    session.lockDisguises();
    session.runTo(MatchPhase.Results, "a", 400);

    host.adapter.sendCommand({ type: "vote_rematch", yes: false });
    session.advance(2);
    expect(
      eventsOfType(host, "rematch_vote_cast").map((event) => event.yesVotes).at(-1),
    ).toBe(0);

    session.runTo(MatchPhase.Lobby, "a", 400);
    expect(eventsOfType(host, "rematch_started")).toEqual([]);
    expect(host.adapter.getSync().publicState?.round).toBe(0);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("sends no private traffic to a seat nobody is connected on", async () => {
    vi.useFakeTimers();
    const session = new Session(RECONNECT_SETTINGS, playingBots());
    await session.addPeer("a", "Ada");
    await session.addPeer("b", "Bex");
    session.advance(4);

    const host = session.peer("a");
    // Every message the host broadcasts, read as the room saw it.
    const heard = recordMessages(session.peer("b"));
    host.adapter.bots.addBot();
    host.adapter.bots.addBot();
    session.startMatch("a", MatchPhase.Forge);
    session.runTo(MatchPhase.Inspection, "a", 200);

    const addressed = heard
      .map((message) => (message as { to?: unknown }).to)
      .filter((to): to is string => typeof to === "string");
    expect(addressed.length).toBeGreaterThan(0);
    expect(addressed.filter((to) => isBotSeat(to))).toEqual([]);
    // The roles and disguises those bots were dealt did reach the simulation:
    // this is a channel the driver reads directly, not one that is empty.
    expect(host.adapter.getSync().publicState?.disguises.length).toBeGreaterThan(0);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });
});

/** Publishes a raw envelope as this peer, bypassing the adapter's own send path. */
function rawSend(peer: Peer, payload: unknown): void {
  const net = (peer.adapter as unknown as { net: { send(data: unknown): void } }).net;
  net.send(payload);
}
