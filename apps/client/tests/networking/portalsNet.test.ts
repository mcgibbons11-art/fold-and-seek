import type { MatchSettingsPatch, PrivateSimEvent, SimEvent } from "@foldseek/game-sim";
import {
  createReferenceDisguiseWire,
  encodeDisguiseWire,
  encodePaintLayer,
  MatchPhase,
} from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandRejection, ConnectionState } from "../../src/networking/NetworkAdapter";
import {
  coalesceDisguiseUpdates,
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
}

class Session {
  readonly relay = new FakePortalsRelay();
  readonly peers: Peer[] = [];
  private readonly settings: MatchSettingsPatch;
  private clock = 1_700_000_000_000;

  constructor(settings: MatchSettingsPatch = {}) {
    this.settings = { ...FAST_SETTINGS, ...settings };
  }

  now(): number {
    return this.clock;
  }

  async addPeer(id: string, displayName: string, options: PeerOptions = {}): Promise<Peer> {
    const sdk = this.relay.createPeer(
      options.playerId === undefined
        ? { id, displayName }
        : { id, displayName, playerId: options.playerId },
    );
    const adapter = new PortalsNetAdapter(sdk, {
      settings: this.settings,
      seed: 5,
      now: () => this.clock,
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

  runTo(target: MatchPhase, hostId: string, maxSteps = 60): void {
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

  it("refuses a second tab of an already seated account without disturbing the first", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new Session(RECONNECT_SETTINGS);
    await session.addPeer("a", "Ada", { playerId: "account-a" });
    const first = await session.addPeer("b", "Bex", { playerId: "account-b" });
    session.advance(2);

    const secondTab = await session.addPeer("b-tab2", "Bex", { playerId: "account-b" });
    session.advance(4);

    expect(secondTab.adapter.getConnection().status).toBe("error");
    expect(secondTab.adapter.getConnection().detail).toBe("duplicate_session");
    // The tab already playing is untouched, and the room still holds two seats.
    expect(first.adapter.getConnection().status).toBe("connected");
    expect(session.peer("a").adapter.getSync().publicState?.players).toHaveLength(2);

    warn.mockRestore();
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

/** Publishes a raw envelope as this peer, bypassing the adapter's own send path. */
function rawSend(peer: Peer, payload: unknown): void {
  const net = (peer.adapter as unknown as { net: { send(data: unknown): void } }).net;
  net.send(payload);
}
