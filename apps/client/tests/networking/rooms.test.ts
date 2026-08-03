import type { MatchSettingsPatch, SimEvent } from "@foldseek/game-sim";
import {
  createReferenceDisguiseWire,
  encodeDisguiseWire,
  encodePaintLayer,
  LIMITS,
  MatchPhase,
  MAX_PAINT_STROKES,
  PAINT_WIRE_MAX_BASE64_LENGTH,
} from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortalsNetAdapter } from "../../src/networking/PortalsNetAdapter";
import {
  encodeChunks,
  jsonByteLength,
  MAX_PAYLOAD_BYTES,
  PORTALS_PROTOCOL_VERSION,
} from "../../src/networking/portalsProtocol";
import {
  allRoomStateKeys,
  freeRoomCode,
  isJoinable,
  MAX_CONCURRENT_ROOMS,
  ROOM_AD_STALE_MS,
  ROOM_SLOTS,
  RoomDirectory,
  sanitizeRoomName,
  VACANT_SLOT,
  type RoomAd,
} from "../../src/networking/roomRegistry";
import { FakePortalsRelay } from "./fakePortals";

/**
 * Concurrent rooms over one Portals channel.
 *
 * The budget block is the load-bearing part. Everything about this design is
 * downstream of the relay's 64-key allowance, so those numbers are measured
 * from the wire formats rather than asserted from the slot table: if a paint
 * stroke grows, the room that could no longer publish its disguises fails here
 * instead of going quiet in front of a player.
 */

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

const CHANNEL = "fold-seek-rooms";
const RELAY_KEY_ALLOWANCE = 64;

/** A pose the canonical wire schema accepts, so the simulation keeps it. */
const VALID_POSE = encodeDisguiseWire(createReferenceDisguiseWire(4));

/** A body-paint layer the wire decoder accepts. */
const PAINT_LAYER = encodePaintLayer(
  Array.from({ length: 24 }, (_, index) => ({
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

afterEach(() => {
  vi.useRealTimers();
});

describe("room key budget", () => {
  it("fits every room the session can hold inside the relay's key allowance", () => {
    const keys = allRoomStateKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeLessThanOrEqual(RELAY_KEY_ALLOWANCE);
    expect(ROOM_SLOTS).toHaveLength(MAX_CONCURRENT_ROOMS);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(128);

    console.log(
      `${ROOM_SLOTS.length} rooms (${ROOM_SLOTS.map((slot) => slot.maxPlayers).join(" + ")} seats) use ${keys.length} of ${RELAY_KEY_ALLOWANCE} keys`,
    );
  });

  it("holds every slot's worst case of body paint and locked poses", () => {
    // A room always fields at least one Inspector, so the most disguises it can
    // carry is one short of its seats. Each of them is at the wire's ceiling:
    // a full stroke log, which is already larger than a single relay value.
    const layer = encodePaintLayer(
      Array.from({ length: MAX_PAINT_STROKES }, (_, index) => ({
        target: index % 19,
        u: (index % 64) / 64,
        v: (index % 32) / 32,
        radius: 0.25,
        color: [0.8, 0.2, 0.4] as const,
        opacity: 1,
        erase: false,
        continued: index % 4 !== 0,
      })),
    );
    expect(layer.length).toBe(PAINT_WIRE_MAX_BASE64_LENGTH);
    const pose = "p".repeat(LIMITS.encodedPoseLength);

    for (const slot of ROOM_SLOTS) {
      const disguises = slot.maxPlayers - 1;
      const paintBook: Record<string, string> = {};
      const poseBook: Record<string, string> = {};
      for (let index = 0; index < disguises; index += 1) {
        paintBook[`obj_${index}`] = layer;
        poseBook[`obj_${index}`] = pose;
      }

      const paintChunks = encodeChunks(paintBook, 1, slot.keys.paint.length);
      const poseChunks = encodeChunks(poseBook, 1, slot.keys.pose.length);
      expect(paintChunks, `slot ${slot.index} paint`).not.toBeNull();
      expect(poseChunks, `slot ${slot.index} pose`).not.toBeNull();
      for (const chunk of [...(paintChunks ?? []), ...(poseChunks ?? [])]) {
        expect(jsonByteLength(chunk)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      }

      // A range with no spare key is one wire change away from going silent for
      // a whole room, so each one carries more keys than its worst case needs.
      expect((paintChunks ?? []).length, `slot ${slot.index} paint headroom`).toBeLessThan(
        slot.keys.paint.length,
      );
      expect((poseChunks ?? []).length, `slot ${slot.index} pose headroom`).toBeLessThan(
        slot.keys.pose.length,
      );

      console.log(
        `slot ${slot.index}: ${disguises} disguises need ${(paintChunks ?? []).length}/${slot.keys.paint.length} paint keys and ${(poseChunks ?? []).length}/${slot.keys.pose.length} pose keys`,
      );
    }
  });
});

describe("room registry", () => {
  const advertise = (overrides: Partial<RoomAd> = {}): RoomAd => ({
    v: PORTALS_PROTOCOL_VERSION,
    code: "ABCD",
    name: "The Attic",
    host: "seat-a",
    slot: 0,
    players: 2,
    bots: 0,
    maxPlayers: 12,
    seekers: 1,
    phase: MatchPhase.Lobby,
    beat: 1,
    ...overrides,
  });

  it("retires a room whose heartbeat stops and keeps one whose beat moves", () => {
    const directory = new RoomDirectory();
    const key = ROOM_SLOTS[0]?.adKey as string;

    directory.observe(key, advertise(), 1_000);
    expect(directory.list(1_000)).toHaveLength(1);
    // Read again with the same beat: the host has written nothing new, so the
    // room ages from when the counter last moved rather than from this reading.
    directory.observe(key, advertise(), 1_000 + ROOM_AD_STALE_MS - 1);
    expect(directory.list(1_000 + ROOM_AD_STALE_MS - 1)).toHaveLength(1);
    expect(directory.list(1_000 + ROOM_AD_STALE_MS)).toHaveLength(0);

    directory.observe(key, advertise({ beat: 2 }), 1_000 + ROOM_AD_STALE_MS);
    expect(directory.list(1_000 + ROOM_AD_STALE_MS)).toHaveLength(1);
    expect(directory.list(1_000 + ROOM_AD_STALE_MS * 2)).toHaveLength(0);
  });

  it("frees a slot the host wrote a vacancy over", () => {
    const directory = new RoomDirectory();
    const key = ROOM_SLOTS[0]?.adKey as string;
    directory.observe(key, advertise(), 1_000);
    expect(directory.freeSlot(1_000)?.index).toBe(1);

    directory.observe(key, VACANT_SLOT, 1_100);
    expect(directory.list(1_100)).toHaveLength(0);
    expect(directory.freeSlot(1_100)?.index).toBe(0);
  });

  it("refuses a slot to a new room once every slot is advertised", () => {
    const directory = new RoomDirectory();
    ROOM_SLOTS.forEach((slot, index) => {
      directory.observe(
        slot.adKey,
        advertise({ slot: slot.index, code: `RM0${index}`, maxPlayers: slot.maxPlayers }),
        1_000,
      );
    });
    expect(directory.list(1_000)).toHaveLength(MAX_CONCURRENT_ROOMS);
    expect(directory.freeSlot(1_000)).toBeNull();
  });

  it("sends quick join to the fullest room that has not started", () => {
    const directory = new RoomDirectory();
    const [first, second] = ROOM_SLOTS;
    if (first === undefined || second === undefined) throw new Error("two slots expected");

    directory.observe(first.adKey, advertise({ code: "AAAA", players: 2, slot: 0 }), 1_000);
    directory.observe(
      second.adKey,
      advertise({ code: "BBBB", players: 5, slot: 1, maxPlayers: second.maxPlayers }),
      1_000,
    );
    expect(directory.quickJoinTarget(1_000)?.code).toBe("BBBB");

    // A round already under way is the last resort, however full it is: a
    // player who wanted a game would rather wait in a lobby than watch one.
    directory.observe(
      second.adKey,
      advertise({
        code: "BBBB",
        players: 5,
        slot: 1,
        maxPlayers: second.maxPlayers,
        phase: MatchPhase.Inspection,
        beat: 2,
      }),
      1_000,
    );
    expect(directory.quickJoinTarget(1_000)?.code).toBe("AAAA");
  });

  it("passes over a full room and one whose round is over", () => {
    expect(isJoinable(advertise({ players: 12, maxPlayers: 12 }))).toBe(false);
    expect(isJoinable(advertise({ phase: MatchPhase.Results }))).toBe(false);
    expect(isJoinable(advertise({ phase: MatchPhase.Forge }))).toBe(true);
  });

  it("never hands out a code a live room is already using", () => {
    const directory = new RoomDirectory();
    directory.observe(ROOM_SLOTS[0]?.adKey as string, advertise({ code: "AAAA" }), 1_000);
    // A generator that only ever offers the taken code still has to produce
    // something else, because a duplicate code makes two rooms indistinguishable.
    const code = freeRoomCode(directory, 1_000, () => 0);
    expect(code).not.toBe("AAAA");
  });

  it("keeps a room's name printable and never empty", () => {
    expect(sanitizeRoomName("   ", "Ada's room")).toBe("Ada's room");
    expect(sanitizeRoomName("  The   Attic  ", "x")).toBe("The Attic");
    expect(sanitizeRoomName("y".repeat(80), "x")).toHaveLength(24);
  });
});

/* --------------------------------------------------------- live sessions --- */

interface RoomPeer {
  readonly id: string;
  readonly adapter: PortalsNetAdapter;
  readonly events: SimEvent[];
}

class RoomSession {
  readonly relay = new FakePortalsRelay();
  readonly peers: RoomPeer[] = [];
  private readonly settings: MatchSettingsPatch;
  private clock = 1_700_000_000_000;

  constructor(settings: MatchSettingsPatch = {}) {
    this.settings = { ...FAST_SETTINGS, ...settings };
  }

  now(): number {
    return this.clock;
  }

  /** Joins the channel and stops there, which is where the browser is shown. */
  async browse(id: string, displayName: string): Promise<RoomPeer> {
    const sdk = this.relay.createPeer({ id, displayName });
    const adapter = new PortalsNetAdapter(sdk, {
      settings: this.settings,
      seed: 5,
      now: () => this.clock,
      joinRetryDelayMs: 0,
    });
    const events: SimEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.connect();
    await adapter.joinSession(CHANNEL, displayName);
    const peer: RoomPeer = { id, adapter, events };
    this.peers.push(peer);
    return peer;
  }

  /** The whole of the old flow: join the channel and land in a room. */
  async play(id: string, displayName: string): Promise<RoomPeer> {
    const sdk = this.relay.createPeer({ id, displayName });
    const adapter = new PortalsNetAdapter(sdk, {
      settings: this.settings,
      seed: 5,
      now: () => this.clock,
      joinRetryDelayMs: 0,
    });
    const events: SimEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.connect();
    await adapter.join(CHANNEL, displayName);
    const peer: RoomPeer = { id, adapter, events };
    this.peers.push(peer);
    return peer;
  }

  peer(id: string): RoomPeer {
    const found = this.peers.find((entry) => entry.id === id);
    if (!found) throw new Error(`no peer ${id}`);
    return found;
  }

  advance(steps = 1): void {
    for (let index = 0; index < steps; index += 1) {
      this.clock += 100;
      for (const peer of this.peers) peer.adapter.tick();
    }
  }

  /** Readies one room's players and starts its round from that room's host. */
  startMatch(ids: readonly string[], hostId: string): void {
    for (const id of ids) {
      this.peer(id).adapter.sendCommand({ type: "player_ready", ready: true });
    }
    this.advance(2);
    this.peer(hostId).adapter.sendCommand({ type: "start_match" });
    this.advance(2);
    // Ready flags clear on entering Loading, so re-arm them there.
    for (let index = 0; index < 40; index += 1) {
      const phase = this.peer(hostId).adapter.getSync().publicState?.phase;
      if (phase === MatchPhase.Forge) return;
      if (phase === MatchPhase.Loading) {
        for (const id of ids) {
          this.peer(id).adapter.sendCommand({ type: "player_ready", ready: true });
        }
      }
      this.advance();
    }
    throw new Error("the forge was not reached");
  }

  /**
   * Every Mimic locks a real pose and a real paint layer, which is what puts
   * both key ranges on the wire at their published size.
   */
  lockAndPaint(ids: readonly string[]): void {
    for (const id of ids) {
      const peer = this.peer(id);
      if (peer.adapter.getSync().privateState?.role !== "mimic") continue;
      peer.adapter.sendPaintUpdate({ encodedPaint: PAINT_LAYER, revision: 8 });
      peer.adapter.sendCommand({ type: "lock_disguise", payload: VALID_POSE, revision: 9 });
    }
    this.advance(2);
  }

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

describe("rooms over one channel", () => {
  it("retries an accepted matchmaking decision after host send saturation", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    const host = await session.browse("a", "Ada");
    const guest = await session.browse("b", "Bex");
    const opened = host.adapter.createRoom("The Attic");
    if (!opened.ok) throw new Error(opened.reason);
    session.advance(2);

    let accepted = false;
    guest.adapter.onRoomDecision((decision) => { accepted = decision.accepted; });
    expect(guest.adapter.requestRoom(opened.code).ok).toBe(true);
    const request = host.adapter.pendingJoinRequests()[0];
    if (request === undefined) throw new Error("request was not delivered");

    const window = (host.adapter as unknown as {
      sendWindow: { tryConsume(nowMs: number): boolean };
    }).sendWindow;
    while (window.tryConsume(session.now())) { /* saturate */ }
    expect(host.adapter.acceptRoomRequest(request.id).ok).toBe(true);
    expect(accepted).toBe(false);

    session.advance(11);
    expect(accepted).toBe(true);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("keeps a requester outside until the host explicitly accepts", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    const ada = await session.browse("a", "Ada");
    const bex = await session.browse("b", "Bex");
    const opened = ada.adapter.createRoom("The Attic");
    if (!opened.ok) throw new Error(opened.reason);
    session.advance(2);

    let acceptedCode: string | null = null;
    bex.adapter.onRoomDecision((decision) => {
      if (decision.accepted) acceptedCode = decision.roomCode;
    });
    expect(bex.adapter.requestRoom(opened.code).ok).toBe(true);

    expect(bex.adapter.getRoomCode()).toBeNull();
    expect(ada.adapter.getRoster().map((entry) => entry.displayName)).toEqual(["Ada"]);
    const request = ada.adapter.pendingJoinRequests()[0];
    expect(request?.displayName).toBe("Bex");

    if (request === undefined) throw new Error("host never received the request");
    expect(ada.adapter.acceptRoomRequest(request.id).ok).toBe(true);
    expect(acceptedCode).toBe(opened.code);
    expect(bex.adapter.enterRoom(acceptedCode as string).ok).toBe(true);
    session.advance(4);

    expect(bex.adapter.getRoomCode()).toBe(opened.code);
    expect(ada.adapter.getRoster().map((entry) => entry.displayName).sort()).toEqual(["Ada", "Bex"]);

    // Ready is a public change, but the button reads the player's own private
    // slice as well. The accepted guest must receive that refreshed slice
    // after its command travels through the host.
    expect(bex.adapter.getSync().privateState?.ready).toBe(false);
    bex.adapter.sendCommand({ type: "player_ready", ready: true });
    session.advance(6);
    expect(bex.adapter.getSync().privateState?.ready).toBe(true);
    expect(
      bex.adapter.getSync().publicState?.players.find(
        (player) => player.seatId === bex.adapter.getSelfId(),
      )?.ready,
    ).toBe(true);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("lists a new room for creator and peers when state callbacks are missing", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    session.relay.deliverStateEvents = false;
    const ada = await session.browse("a", "Ada");
    const bex = await session.browse("b", "Bex");

    const opened = ada.adapter.createRoom("The Attic");
    if (!opened.ok) throw new Error(opened.reason);

    expect(ada.adapter.listRooms().map((room) => room.code)).toEqual([opened.code]);
    expect(bex.adapter.listRooms().map((room) => room.code)).toEqual([opened.code]);
    expect(session.relay.stateSnapshot()[ROOM_SLOTS[0]?.adKey as string]).toBeDefined();
    expect(session.relay.violations).toEqual([]);

    session.dispose();
  });

  it("leaves a client in no room until it picks one", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    const ada = await session.browse("a", "Ada");

    expect(ada.adapter.getRoomCode()).toBeNull();
    expect(ada.adapter.listRooms()).toHaveLength(0);
    expect(ada.adapter.isAuthority()).toBe(false);
    expect(ada.adapter.getConnection().status).toBe("connected");

    const opened = ada.adapter.createRoom("The Attic");
    expect(opened.ok).toBe(true);
    expect(ada.adapter.isAuthority()).toBe(true);
    expect(ada.adapter.listRooms()[0]?.name).toBe("The Attic");

    session.dispose();
  });

  it("shows one client's room to another and seats it on entry", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    const ada = await session.browse("a", "Ada");
    const bex = await session.browse("b", "Bex");

    const opened = ada.adapter.createRoom("The Attic");
    if (!opened.ok) throw new Error(opened.reason);
    session.advance(2);

    // Bex sees the room without being in it, and is in nobody's roster yet.
    expect(bex.adapter.listRooms().map((room) => room.code)).toEqual([opened.code]);
    expect(ada.adapter.getRoster()).toHaveLength(1);

    expect(bex.adapter.enterRoom(opened.code).ok).toBe(true);
    session.advance(4);

    expect(bex.adapter.getRoomCode()).toBe(opened.code);
    expect(ada.adapter.getRoster().map((entry) => entry.displayName).sort()).toEqual(["Ada", "Bex"]);
    expect(bex.adapter.getRoster().map((entry) => entry.displayName).sort()).toEqual(["Ada", "Bex"]);
    expect(ada.adapter.listRooms()[0]?.players).toBe(2);
    expect(session.relay.violations).toEqual([]);

    session.dispose();
  });

  it("relays sparse Inspector camera samples to other players in the room", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    const ada = await session.browse("a", "Ada");
    const bex = await session.browse("b", "Bex");
    const opened = ada.adapter.createRoom("The Attic");
    if (!opened.ok) throw new Error(opened.reason);
    bex.adapter.enterRoom(opened.code);
    session.advance(2);

    const received: Array<{
      seatId: string;
      x: number | null;
      airborne: boolean | null;
      climbing: boolean | null;
    }> = [];
    bex.adapter.onCameraSample((seatId, sample) => {
      received.push({
        seatId,
        x: sample?.x ?? null,
        airborne: sample?.airborne ?? null,
        climbing: sample?.climbing ?? null,
      });
    });
    ada.adapter.sendCameraSample({
      atMs: 100,
      x: 1.25,
      y: 0.3,
      z: -2,
      yaw: 0.4,
      pitch: 0.1,
      airborne: true,
      climbing: false,
    });
    ada.adapter.sendCameraSample(null);
    session.advance(1);

    expect(received).toEqual([
      { seatId: ada.adapter.getSelfId(), x: null, airborne: null, climbing: null },
    ]);
    expect(session.relay.violations).toEqual([]);
    session.dispose();
  });

  it("runs two rooms at once without either seeing the other", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    const ada = await session.browse("a", "Ada");
    const bex = await session.browse("b", "Bex");
    const cal = await session.browse("c", "Cal");
    const dot = await session.browse("d", "Dot");

    const attic = ada.adapter.createRoom("The Attic");
    const cellar = cal.adapter.createRoom("The Cellar");
    if (!attic.ok || !cellar.ok) throw new Error("both rooms should open");
    expect(attic.code).not.toBe(cellar.code);
    session.advance(2);

    expect(bex.adapter.enterRoom(attic.code).ok).toBe(true);
    expect(dot.adapter.enterRoom(cellar.code).ok).toBe(true);
    session.advance(4);

    // Each room's roster is its own two players, and each host is authoritative
    // over its own room only.
    expect(ada.adapter.getRoster().map((entry) => entry.displayName).sort()).toEqual(["Ada", "Bex"]);
    expect(cal.adapter.getRoster().map((entry) => entry.displayName).sort()).toEqual(["Cal", "Dot"]);
    expect(ada.adapter.isAuthority()).toBe(true);
    expect(cal.adapter.isAuthority()).toBe(true);
    expect(bex.adapter.isAuthority()).toBe(false);

    // A command in one room produces events in that room and silence in the
    // other, which is the whole point of the partition.
    const cellarEventsBefore = cal.events.length;
    ada.adapter.sendCommand({ type: "player_ready", ready: true });
    bex.adapter.sendCommand({ type: "player_ready", ready: true });
    session.advance(3);

    const atticReady = ada.events.filter((event) => event.type === "player_ready_changed");
    expect(atticReady.length).toBeGreaterThan(0);
    expect(
      cal.events.slice(cellarEventsBefore).some((event) => event.type === "player_ready_changed"),
    ).toBe(false);
    expect(dot.events.some((event) => event.type === "player_ready_changed")).toBe(false);

    // Both rooms publish, and the two of them together stay inside the relay's
    // key allowance rather than merely fitting one at a time.
    expect(session.relay.violations).toEqual([]);
    expect(Object.keys(session.relay.stateSnapshot()).length).toBeLessThanOrEqual(
      RELAY_KEY_ALLOWANCE,
    );

    session.dispose();
  });

  it("refuses a room the session has no slot for, and frees the slot on leaving", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    const ada = await session.browse("a", "Ada");
    const bex = await session.browse("b", "Bex");
    const cal = await session.browse("c", "Cal");

    expect(ada.adapter.createRoom("One").ok).toBe(true);
    expect(bex.adapter.createRoom("Two").ok).toBe(true);
    session.advance(2);

    const refused = cal.adapter.createRoom("Three");
    expect(refused).toEqual({ ok: false, reason: "session_full" });
    expect(cal.adapter.getRoomCode()).toBeNull();

    // The last player out of a room retires its advertisement, so the slot is
    // available again at once rather than after the heartbeat times out.
    bex.adapter.leaveRoom();
    session.advance(2);
    expect(bex.adapter.getRoomCode()).toBeNull();
    expect(cal.adapter.listRooms()).toHaveLength(1);
    expect(cal.adapter.createRoom("Three").ok).toBe(true);

    session.dispose();
  });

  it("frees the seat when a player leaves a room for the browser", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    const ada = await session.browse("a", "Ada");
    const bex = await session.browse("b", "Bex");

    const opened = ada.adapter.createRoom("The Attic");
    if (!opened.ok) throw new Error(opened.reason);
    session.advance(2);
    bex.adapter.enterRoom(opened.code);
    session.advance(4);
    expect(ada.adapter.getRoster()).toHaveLength(2);

    bex.adapter.leaveRoom();
    session.advance(4);

    expect(ada.adapter.getRoster().map((entry) => entry.displayName)).toEqual(["Ada"]);
    expect(ada.adapter.listRooms()[0]?.players).toBe(1);
    // Bex is still in the session and can see the room it left.
    expect(bex.adapter.getConnection().status).toBe("connected");
    expect(bex.adapter.listRooms()).toHaveLength(1);

    session.dispose();
  });

  it("puts a plain join in the one room, exactly as it did before rooms", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    const ada = await session.play("a", "Ada");
    const bex = await session.play("b", "Bex");
    const cal = await session.play("c", "Cal");
    session.advance(4);

    const code = ada.adapter.getRoomCode();
    expect(code).not.toBeNull();
    expect(bex.adapter.getRoomCode()).toBe(code);
    expect(cal.adapter.getRoomCode()).toBe(code);
    expect(session.peer("a").adapter.listRooms()).toHaveLength(1);
    expect(ada.adapter.getRoster()).toHaveLength(3);
    expect(ada.adapter.isAuthority()).toBe(true);
    // The first room takes the original key range, so a lone room publishes on
    // the keys it always did.
    const written = Object.keys(session.relay.stateSnapshot());
    expect(written).toContain("match");
    expect(written.some((key) => key.startsWith("bmatch"))).toBe(false);

    session.dispose();
  });

  it("carries two rounds at once inside the relay's key and size limits", async () => {
    vi.useFakeTimers();
    // A long inspection so both rounds are still hunting when the wire is
    // measured, rather than one of them having already run through to results.
    const session = new RoomSession({ inspectionMs: 20_000 });
    const ada = await session.browse("a", "Ada");
    const bex = await session.browse("b", "Bex");
    const cal = await session.browse("c", "Cal");
    const dot = await session.browse("d", "Dot");

    const attic = ada.adapter.createRoom("The Attic");
    const cellar = cal.adapter.createRoom("The Cellar");
    if (!attic.ok || !cellar.ok) throw new Error("both rooms should open");
    session.advance(2);
    bex.adapter.enterRoom(attic.code);
    dot.adapter.enterRoom(cellar.code);
    session.advance(4);

    // Both rooms run a real round to the inspection, so both are publishing a
    // public state, a simulation snapshot, locked poses and body paint at the
    // same time. This is the case the slot table exists for: the arithmetic in
    // the budget tests above says it fits, and this is the wire saying so.
    session.startMatch(["a", "b"], "a");
    session.startMatch(["c", "d"], "c");
    session.lockAndPaint(["a", "b", "c", "d"]);
    session.runTo(MatchPhase.Inspection, "a");
    session.runTo(MatchPhase.Inspection, "c");
    session.advance(4);

    expect(ada.adapter.getSync().publicState?.phase).toBe(MatchPhase.Inspection);
    expect(cal.adapter.getSync().publicState?.phase).toBe(MatchPhase.Inspection);

    const written = Object.keys(session.relay.stateSnapshot());
    expect(session.relay.violations).toEqual([]);
    expect(written.length).toBeLessThanOrEqual(RELAY_KEY_ALLOWANCE);
    // Each room published on its own range and neither wrote into the other's.
    expect(written.some((key) => key.startsWith("bmatch"))).toBe(true);
    expect(written).toContain("match");

    console.log(
      `two live rounds occupy ${written.length} of ${RELAY_KEY_ALLOWANCE} keys: ${written.sort().join(" ")}`,
    );

    session.dispose();
  });

  it("sends quick join into the room that is already filling up", async () => {
    vi.useFakeTimers();
    const session = new RoomSession();
    const ada = await session.browse("a", "Ada");
    const bex = await session.browse("b", "Bex");
    const cal = await session.browse("c", "Cal");
    const dot = await session.browse("d", "Dot");

    const quiet = ada.adapter.createRoom("Quiet");
    const busy = bex.adapter.createRoom("Busy");
    if (!quiet.ok || !busy.ok) throw new Error("both rooms should open");
    session.advance(2);
    cal.adapter.enterRoom(busy.code);
    session.advance(4);

    expect(dot.adapter.quickJoin().ok).toBe(true);
    expect(dot.adapter.getRoomCode()).toBe(busy.code);

    session.dispose();
  });
});
