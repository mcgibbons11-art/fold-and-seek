import type { MatchSettingsPatch, SimEvent } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotDisguisePayload } from "../../src/gameplay/botDisguises";
import { DisguiseTheatre } from "../../src/gameplay/disguiseTheatre";
import { createPortalsRound, PORTALS_ROUND_CHANNEL, type PortalsRound } from "../../src/gameplay/portalsRound";
import { FLUSH_INTERVAL_MS } from "../../src/networking/PortalsNetAdapter";
import { qualitySettingsFor } from "../../src/rendering/quality";
import { FakePortalsRelay } from "../networking/fakePortals";

/**
 * A whole round played by two clients over the Portals relay, assembled by the
 * shipping `createPortalsRound` rather than by a fixture: the same adapter, the
 * same object registry, the same spatial bridge and the same RoundDirector the
 * app shell hands to GameHost.
 *
 * What it is really asking is whether the authority ends up holding the three
 * things it needs to run the Curiosity Shop — the map's accusable objects, the
 * disguises' bounds, and the Inspector's eye — when the Inspector is a different
 * machine from the host. Each of those was missing before this wiring, and each
 * one fails a different assertion below rather than merely making the round
 * feel wrong.
 */

const FAST_SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 20_000,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
};

const STEP_MS = 100;
/** The hiding place `roundAccusation` shoots at, so the geometry is known good. */
const HIDE_PLAN = 0;

interface Seat {
  readonly id: string;
  readonly round: PortalsRound;
  readonly theatre: DisguiseTheatre;
  readonly events: SimEvent[];
}

class PortalsRoom {
  readonly relay = new FakePortalsRelay();
  readonly seats: Seat[] = [];
  private clock = 1_700_000_000_000;

  async seat(id: string, displayName: string): Promise<Seat> {
    const sdk = this.relay.createPeer({ id, displayName, playerId: id });
    const round = createPortalsRound({
      sdk,
      seed: 5,
      settings: FAST_SETTINGS,
      now: () => this.clock,
    });
    // Every client draws the room's disguises, and it is that drawing which
    // tells its own bridge where they are. On the host this is what turns an
    // accusation into a hit; on everyone else it is what draws the shop.
    const theatre = new DisguiseTheatre(new THREE.Scene(), qualitySettingsFor("high"));
    round.spatial.setDisguiseBounds((objectId) => theatre.boundsOf(objectId));

    const events: SimEvent[] = [];
    round.adapter.onEvent((event) => events.push(event));

    await round.adapter.connect();
    await round.adapter.join(PORTALS_ROUND_CHANNEL, displayName);

    const entry: Seat = { id, round, theatre, events };
    this.seats.push(entry);
    return entry;
  }

  seatOf(id: string): Seat {
    const found = this.seats.find((seat) => seat.id === id);
    if (!found) throw new Error(`no seat ${id}`);
    return found;
  }

  /** The seat whose private state says it is carrying the gun. */
  inspector(): Seat {
    const found = this.seats.find(
      (seat) => seat.round.adapter.getSync().privateState?.role === "inspector",
    );
    if (!found) throw new Error("nobody was dealt the Inspector");
    return found;
  }

  mimic(): Seat {
    const found = this.seats.find(
      (seat) => seat.round.adapter.getSync().privateState?.role === "mimic",
    );
    if (!found) throw new Error("nobody was dealt a Mimic");
    return found;
  }

  /** One authoritative step, with every client's view redrawn from what it holds. */
  advance(steps = 1): void {
    for (let index = 0; index < steps; index += 1) {
      this.clock += STEP_MS;
      for (const seat of this.seats) seat.round.adapter.tick();
      this.syncTheatres();
    }
  }

  /**
   * Runs the outbound flush every client keeps on a timer. A client that is not
   * the host never ticks the simulation, so this is the only thing that carries
   * its eye to whoever is holding it.
   */
  flushClients(): void {
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    this.syncTheatres();
  }

  syncTheatres(): void {
    for (const seat of this.seats) {
      seat.theatre.sync(seat.round.adapter.getSync().publicState?.disguises ?? [], null);
    }
  }

  readyAll(): void {
    for (const seat of this.seats) {
      seat.round.adapter.sendCommand({ type: "player_ready", ready: true });
    }
  }

  runTo(target: MatchPhase, maxSteps = 200): void {
    for (let index = 0; index < maxSteps; index += 1) {
      const phase = this.seats[0]?.round.adapter.getSync().publicState?.phase;
      if (phase === target) return;
      if (phase === MatchPhase.Loading) this.readyAll();
      this.advance();
    }
    throw new Error(`phase ${target} not reached in ${maxSteps} steps`);
  }

  dispose(): void {
    for (const seat of this.seats) {
      seat.theatre.dispose();
      seat.round.dispose();
    }
  }
}

/** A point just outside a disguise, level with it, to shoot from. */
function eyeBeside(bounds: THREE.Box3, metres: number): { x: number; y: number; z: number } {
  const centre = bounds.getCenter(new THREE.Vector3());
  return { x: centre.x + metres, y: centre.y, z: centre.z };
}

/** Two seats, readied, started, and carried to the hunt with a disguise standing. */
async function huntingRoom(): Promise<PortalsRoom> {
  const room = new PortalsRoom();
  await room.seat("peer-a", "Ada");
  await room.seat("peer-b", "Bela");

  room.readyAll();
  room.advance(2);
  room.seats[0]?.round.adapter.sendCommand({ type: "start_match" });
  room.advance(2);
  room.runTo(MatchPhase.Forge);

  room.mimic().round.adapter.sendCommand({
    type: "lock_disguise",
    payload: createBotDisguisePayload(HIDE_PLAN),
    revision: 9,
  });
  room.advance(2);
  room.runTo(MatchPhase.Inspection);

  // The whole point of these cases is an Inspector that is not the authority,
  // and which seat gets the gun comes off a shuffle. Stated rather than hoped
  // for: if a retune of the deal ever puts the gun on the host seat, these
  // tests would go on passing while proving nothing, so they fail instead.
  if (room.inspector().round.adapter.isAuthority()) {
    room.dispose();
    throw new Error("the fixture dealt the gun to the host; pick a seed that does not");
  }
  return room;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a Portals round", () => {
  it("seats both clients, elects one host, and runs the phase machine for both", async () => {
    vi.useFakeTimers();
    const room = new PortalsRoom();
    const ada = await room.seat("peer-a", "Ada");
    const bela = await room.seat("peer-b", "Bela");

    // Authority is the lowest seat id, which every client works out for itself
    // from the same roster rather than being told.
    expect(ada.round.adapter.isAuthority()).toBe(true);
    expect(bela.round.adapter.isAuthority()).toBe(false);
    expect(ada.round.adapter.getRoster()).toHaveLength(2);
    expect(bela.round.adapter.getRoster()).toHaveLength(2);
    expect(bela.round.adapter.getRoster().find((entry) => entry.isSelf)?.displayName).toBe("Bela");

    room.readyAll();
    room.advance(2);
    // Only the host may start, and the view state each client reads says so.
    expect(bela.round.director.getState().actions.startMatch.allowed).toBe(false);
    expect(ada.round.director.getState().actions.startMatch.allowed).toBe(true);

    ada.round.adapter.sendCommand({ type: "start_match" });
    room.advance(2);
    room.runTo(MatchPhase.Forge);

    // Both clients are in the same phase, and each was dealt exactly one role.
    for (const seat of room.seats) {
      expect(seat.round.director.getState().phase).toBe(MatchPhase.Forge);
    }
    const roles = room.seats.map((seat) => seat.round.adapter.getSync().privateState?.role);
    expect([...roles].sort()).toEqual(["inspector", "mimic"]);

    room.dispose();
  });

  it("publishes a locked disguise to the other client, geometry and all", async () => {
    vi.useFakeTimers();
    const room = await huntingRoom();

    // The publication strips the pose and carries it on its own key range, so
    // a disguise arriving with its geometry proves both halves crossed.
    for (const seat of room.seats) {
      const disguises = seat.round.adapter.getSync().publicState?.disguises ?? [];
      expect(disguises).toHaveLength(1);
      expect(disguises[0]?.encodedPose.length).toBeGreaterThan(0);
      expect(seat.theatre.boundsOf(disguises[0]?.publicObjectId ?? "")).not.toBeNull();
    }
    expect(room.relay.violations).toEqual([]);

    room.dispose();
  });

  it("resolves an accusation the Inspector fires from another machine", async () => {
    vi.useFakeTimers();
    const room = await huntingRoom();
    const inspector = room.inspector();
    expect(inspector.round.adapter.isAuthority()).toBe(false);
    expect(inspector.round.adapter.getSync().privateState?.warrantsRemaining).toBeGreaterThan(0);
    const objectId =
      inspector.round.adapter.getSync().publicState?.disguises[0]?.publicObjectId ?? "";
    expect(objectId).not.toBe("");

    // The Inspector aims at the body its own client is drawing, which is the
    // only one it can see. The host judges the shot against the body it is
    // drawing, so this passes only if the two agree.
    const bounds = inspector.theatre.boundsOf(objectId);
    expect(bounds).not.toBeNull();
    const selfId = inspector.round.adapter.getSelfId() ?? "";
    inspector.round.spatial.setInspectorEye(selfId, eyeBeside(bounds as THREE.Box3, 0.4));
    room.flushClients();

    inspector.round.adapter.sendCommand({ type: "accuse", targetObjectId: objectId });
    room.advance(2);

    const resolved = inspector.events.filter((event) => event.type === "accusation_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ correct: true, targetObjectId: objectId });
    expect(inspector.events.some((event) => event.type === "mimic_caught")).toBe(true);
    // The far client saw it too: a catch is public.
    expect(room.mimic().events.some((event) => event.type === "mimic_caught")).toBe(true);

    room.dispose();
  });

  it("resolves a direct shot before the next telemetry flush", async () => {
    vi.useFakeTimers();
    const room = await huntingRoom();
    const inspector = room.inspector();
    expect(inspector.round.adapter.isAuthority()).toBe(false);
    const objectId =
      inspector.round.adapter.getSync().publicState?.disguises[0]?.publicObjectId ?? "";
    const bounds = inspector.theatre.boundsOf(objectId);
    expect(bounds).not.toBeNull();
    const selfId = inspector.round.adapter.getSelfId() ?? "";

    // A real trigger can land between the relay's 100 ms telemetry flushes.
    // Publishing the current eye and firing in the same frame must not make a
    // direct hit race the older eye sample to the authority.
    inspector.round.spatial.setInspectorEye(selfId, eyeBeside(bounds as THREE.Box3, 0.4));
    inspector.round.adapter.sendCommand({ type: "accuse", targetObjectId: objectId });
    room.advance(2);

    expect(
      inspector.events.filter((event) => event.type === "accusation_resolved"),
    ).toHaveLength(1);
    expect(inspector.events.some((event) => event.type === "mimic_caught")).toBe(true);

    room.dispose();
  });

  it("refuses the same shot when the Inspector's eye never reaches the host", async () => {
    vi.useFakeTimers();
    const room = await huntingRoom();
    const inspector = room.inspector();
    const objectId =
      inspector.round.adapter.getSync().publicState?.disguises[0]?.publicObjectId ?? "";
    const bounds = inspector.theatre.boundsOf(objectId);
    const selfId = inspector.round.adapter.getSelfId() ?? "";

    // Written straight into the local validator, which is exactly what the
    // round did before the eye was given a way across the wire. On the host
    // that is enough; from anywhere else the authority has never heard of it.
    inspector.round.spatial.acceptInspectorEye(selfId, eyeBeside(bounds as THREE.Box3, 0.4));
    inspector.round.adapter.sendCommand({ type: "accuse", targetObjectId: objectId });
    room.advance(2);

    expect(inspector.events.filter((event) => event.type === "accusation_resolved")).toEqual([]);
    expect(inspector.events.some((event) => event.type === "mimic_caught")).toBe(false);

    room.dispose();
  });

  it("keeps the eye channel inside its share of the relay's send budget", async () => {
    vi.useFakeTimers();
    const room = await huntingRoom();
    const inspector = room.inspector();
    const selfId = inspector.round.adapter.getSelfId() ?? "";
    const before = room.relay.sendCount.get(inspector.id) ?? 0;

    // A whole second of a camera that never moves: the round writes the eye on
    // every frame and none of those writes is worth a message.
    for (let frame = 0; frame < 60; frame += 1) {
      inspector.round.spatial.setInspectorEye(selfId, { x: 1, y: 1.2, z: 1 });
    }
    for (let flush = 0; flush < 10; flush += 1) room.flushClients();
    expect((room.relay.sendCount.get(inspector.id) ?? 0) - before).toBe(1);

    // A second of walking, sampled at the flush cadence, costs one message a
    // flush and no more.
    const walking = room.relay.sendCount.get(inspector.id) ?? 0;
    for (let flush = 0; flush < 10; flush += 1) {
      inspector.round.spatial.setInspectorEye(selfId, { x: 1 + flush * 0.2, y: 1.2, z: 1 });
      room.flushClients();
    }
    expect((room.relay.sendCount.get(inspector.id) ?? 0) - walking).toBeLessThanOrEqual(10);
    expect(room.relay.violations).toEqual([]);

    room.dispose();
  });
});
