import type { Client } from "@colyseus/core";
import type { MatchSettingsPatch, PrivateSimEvent, SimEvent } from "@foldseek/game-sim";
import { PERMISSIVE_SPATIAL_VALIDATOR } from "@foldseek/game-sim";
import { CURIOSITY_SHOP_RECORDS, buildObjectRegistry } from "@foldseek/map-data";
import {
  createReferenceDisguiseWire,
  encodeDisguiseWire,
  MatchPhase,
  MAX_EYE_REPORTS_PER_SECOND,
} from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import {
  MatchRoom,
  INSPECTOR_EYE_MESSAGE,
  FORGE_SNAPSHOT_MESSAGE,
  SERVER_MESSAGE,
  type MatchRoomOptions,
} from "../src/rooms/MatchRoom";

/**
 * The dedicated server's geometry (§28.4).
 *
 * Every case here failed before the room built itself a validator. A room made
 * with no options ran on `PERMISSIVE_SPATIAL_VALIDATOR`, which accepted an
 * accusation from any distance, through any wall, from a client whose position
 * the room had never been told, and produced no close pass at all. The last
 * case pins that by asking for the permissive validator back and watching the
 * same shot succeed.
 *
 * The fixtures are the shop's own props rather than invented boxes, so what is
 * measured is the map the game ships.
 */

/**
 * The longcase clock of zone B, which stands against the west wall of the shop
 * at x -7.33..-6.91. It is the pair of shots below: from inside the room the
 * clock is 0.35 m away and in the clear, and from the street on the far side of
 * that wall it is the same 0.35 m away and behind the plaster. The two eyes
 * differ in nothing except which side of the wall they stand on.
 */
const CLOCK_ID = "clockwall_longcase_01";

/** Root the test Mimic locks onto: open floor at the centre of the shop. */
const DISGUISE_ROOT: [number, number, number] = [0, 0, 0];

/** Phase lengths short enough that a whole round fits in a handful of steps. */
const FAST_SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 6_000,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
};

interface SentMessage {
  readonly sessionId: string;
  readonly type: string;
  readonly payload: unknown;
}

class TestClient {
  readonly sent: SentMessage[] = [];

  constructor(readonly sessionId: string) {}

  send(type: string | number, payload?: unknown): void {
    this.sent.push({ sessionId: this.sessionId, type: String(type), payload });
  }

  messagesOfType(type: string): unknown[] {
    return this.sent.filter((entry) => entry.type === type).map((entry) => entry.payload);
  }

  asClient(): Client {
    return this as unknown as Client;
  }
}

/**
 * Two players carried to the hunt with the Mimic's disguise locked at a known
 * root, so a shot and a close pass both have something real to measure against.
 */
class HuntRoom {
  readonly room = new MatchRoom();
  readonly broadcasts: SentMessage[] = [];
  readonly clients: TestClient[] = [];
  readonly inspector: TestClient;
  readonly mimic: TestClient;
  /** The public id the Mimic's locked disguise was published under. */
  readonly disguiseId: string;

  private now = 1_700_000_000_000;

  constructor(
    options: Omit<MatchRoomOptions, "settings" | "seed"> = {},
    lockRoot: [number, number, number] = DISGUISE_ROOT,
  ) {
    this.room.setSimulationInterval = () => undefined;
    this.room.broadcast = (type: string | number, payload?: unknown): void => {
      this.broadcasts.push({ sessionId: "*", type: String(type), payload });
    };
    this.room.onCreate({ settings: FAST_SETTINGS, seed: 9, ...options });

    const first = this.join("s1", "Ada");
    const second = this.join("s2", "Bex");
    for (const client of [first, second]) this.ready(client);
    this.room.handleMatchCommand(first.asClient(), "start_match", { type: "start_match" });
    for (const client of [first, second]) this.ready(client);

    this.advanceUntil(() => this.room.state.phase === MatchPhase.Forge);
    this.inspector = roleOf(first) === "inspector" ? first : second;
    this.mimic = this.inspector === first ? second : first;
    if (roleOf(this.inspector) !== "inspector" || roleOf(this.mimic) !== "mimic") {
      throw new Error("this seed no longer deals one Inspector and one Mimic");
    }

    this.room.handleMatchCommand(this.mimic.asClient(), "lock_disguise", {
      type: "lock_disguise",
      payload: poseAt(lockRoot),
      revision: 1,
    });
    const locked = privateEventsOf(this.mimic).find(
      (event) => event.type === "own_disguise_locked",
    );
    if (locked?.type !== "own_disguise_locked") throw new Error("the Mimic never locked");
    this.disguiseId = locked.publicObjectId;

    this.advanceUntil(() => this.room.state.phase === MatchPhase.Inspection);
  }

  advance(steps = 1, stepMs = 100): void {
    for (let index = 0; index < steps; index += 1) {
      this.now += stepMs;
      dateNow(this.now, () => {
        this.room.step();
      });
    }
  }

  /** Steps until `ready` holds, so a test names a phase rather than a step count. */
  advanceUntil(ready: () => boolean, limit = 60): void {
    for (let index = 0; index < limit && !ready(); index += 1) this.advance(1);
    if (!ready()) throw new Error(`condition not reached in ${limit} steps`);
  }

  /** The room's answer to one accusation: null when it was accepted. */
  accuse(targetObjectId: string): { reason: string; detail?: string } | null {
    const before = this.inspector.messagesOfType(SERVER_MESSAGE.commandRejected).length;
    this.room.handleMatchCommand(this.inspector.asClient(), "accuse", {
      type: "accuse",
      targetObjectId,
    });
    const rejections = this.inspector.messagesOfType(SERVER_MESSAGE.commandRejected);
    if (rejections.length === before) return null;
    return rejections.at(-1) as { reason: string; detail?: string };
  }

  reportEye(eye: [number, number, number] | null): void {
    this.room.handleInspectorEye(this.inspector.asClient(), { eye });
  }

  broadcastEvents(): SimEvent[] {
    return this.broadcasts
      .filter((entry) => entry.type === SERVER_MESSAGE.simEvents)
      .flatMap((entry) => entry.payload as SimEvent[]);
  }

  private join(sessionId: string, displayName: string): TestClient {
    const client = new TestClient(sessionId);
    this.clients.push(client);
    (this.room.clients as unknown as TestClient[]).push(client);
    this.room.onJoin(client.asClient(), { displayName });
    return client;
  }

  private ready(client: TestClient): void {
    this.room.handleMatchCommand(client.asClient(), "player_ready", {
      type: "player_ready",
      ready: true,
    });
  }
}

/** Runs `body` with Date.now() pinned, since the room reads the wall clock. */
function dateNow<T>(value: number, body: () => T): T {
  const original = Date.now;
  Date.now = () => value;
  try {
    return body();
  } finally {
    Date.now = original;
  }
}

function privateEventsOf(client: TestClient): PrivateSimEvent[] {
  return (client.messagesOfType(SERVER_MESSAGE.privateEvents) as PrivateSimEvent[][]).flat();
}

function roleOf(client: TestClient): string {
  const states = client.messagesOfType(SERVER_MESSAGE.privateState) as { role: string }[];
  return states.at(-1)?.role ?? "unassigned";
}

function poseAt(root: [number, number, number], revision = 1): string {
  const pose = createReferenceDisguiseWire(revision);
  pose.root.position = [...root];
  return encodeDisguiseWire(pose);
}

function clockBounds() {
  const record = CURIOSITY_SHOP_RECORDS.find((entry) => entry.objectId === CLOCK_ID);
  if (!record) throw new Error(`${CLOCK_ID} is no longer in the map`);
  return record.focusBounds;
}

/** Eye 0.35 m east of the clock, standing in the shop. */
function eyeInTheRoom(): [number, number, number] {
  const box = clockBounds();
  return [box.max.x + 0.35, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
}

/** Eye 0.35 m west of the clock, standing in the street beyond the wall. */
function eyeInTheStreet(): [number, number, number] {
  const box = clockBounds();
  return [box.min.x - 0.35, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
}

describe("MatchRoom accusation geometry", () => {
  it("refuses a shot from an Inspector whose position it has never heard", () => {
    const hunt = new HuntRoom();

    // No eye has been reported, so the room cannot say where the shot came
    // from. It refuses rather than assuming the Inspector was close enough.
    expect(hunt.accuse(CLOCK_ID)).toEqual({
      type: "accuse",
      reason: "spatial_rejected",
      detail: "inspector_position_unknown",
    });
  });

  it("accepts the same shot once the Inspector has reported a legal eye", () => {
    const hunt = new HuntRoom();
    hunt.reportEye(eyeInTheRoom());

    expect(hunt.accuse(CLOCK_ID)).toBeNull();
  });

  it("refuses a shot taken from out of range", () => {
    const hunt = new HuntRoom();
    const box = clockBounds();
    // Ten metres away, against an accusation reach of about one.
    hunt.reportEye([box.max.x + 10, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2]);

    expect(hunt.accuse(CLOCK_ID)).toEqual({
      type: "accuse",
      reason: "spatial_rejected",
      detail: "out_of_range",
    });
  });

  it("refuses a shot through the wall the clock stands against", () => {
    const hunt = new HuntRoom();
    const inTheRoom = eyeInTheRoom();
    const inTheStreet = eyeInTheStreet();

    // The fixture's whole claim: the two eyes are the same distance from the
    // clock, so whatever separates them is the wall in between.
    const box = clockBounds();
    expect(inTheRoom[0] - box.max.x).toBeCloseTo(box.min.x - inTheStreet[0], 6);

    hunt.reportEye(inTheStreet);
    expect(hunt.accuse(CLOCK_ID)).toEqual({
      type: "accuse",
      reason: "spatial_rejected",
      detail: "no_line_of_sight",
    });

    hunt.reportEye(inTheRoom);
    expect(hunt.accuse(CLOCK_ID)).toBeNull();
  });

  it("takes the map's registry, so an unpublished prop is not a target", () => {
    const hunt = new HuntRoom();
    hunt.reportEye(eyeInTheRoom());

    // The Security Office's contents stand in the shop but are kept out of the
    // registry, so naming one is refused before geometry is consulted at all.
    const registered = new Set(buildObjectRegistry().objects.map((entry) => entry.objectId));
    const office = CURIOSITY_SHOP_RECORDS.find((entry) => entry.zoneId === "security_office");
    expect(office).toBeDefined();
    expect(registered.has(office?.objectId ?? "")).toBe(false);
    expect(hunt.accuse(office?.objectId ?? "")?.reason).toBe("target_unknown");
  });

  it("reproduces the defect: a permissive room takes the through-wall shot", () => {
    // This is the room as it shipped. Every case above passes only because the
    // room now builds geometry for itself, and this one says so by asking for
    // the old behaviour back and watching the same shot land.
    const hunt = new HuntRoom({ spatial: PERMISSIVE_SPATIAL_VALIDATOR });

    expect(hunt.accuse(CLOCK_ID)).toBeNull();
  });
});

describe("MatchRoom eye reports", () => {
  it("forgets an Inspector's eye when they report that they have stopped looking", () => {
    // One shot per room, because a wrong accusation spends the warrant that
    // ends the hunt, and a shot refused for the phase would look like a shot
    // refused for the eye.
    const held = new HuntRoom();
    held.reportEye(eyeInTheRoom());
    expect(held.accuse(CLOCK_ID)).toBeNull();

    // A null report is what a client sends when it stops being an Inspector.
    // The last position it held is not where anybody is standing.
    const forgotten = new HuntRoom();
    forgotten.reportEye(eyeInTheRoom());
    forgotten.reportEye(null);
    expect(forgotten.accuse(CLOCK_ID)?.detail).toBe("inspector_position_unknown");
  });

  it("caps eye reports per sender and drops the overflow in silence", () => {
    const hunt = new HuntRoom();
    const legal = eyeInTheRoom();
    const far: [number, number, number] = [legal[0] + 10, legal[1], legal[2]];

    // Spend the whole allowance standing far away, then step into range. The
    // report that would have moved the eye back is the one over the cap.
    const rejectionsBefore = hunt.inspector.messagesOfType(
      SERVER_MESSAGE.commandRejected,
    ).length;
    for (let index = 0; index < MAX_EYE_REPORTS_PER_SECOND; index += 1) hunt.reportEye(far);
    hunt.reportEye(legal);

    // Nothing is answered: the client sends these continuously and cannot act
    // on a refusal, so replying would spend a message to say nothing.
    expect(hunt.inspector.messagesOfType(SERVER_MESSAGE.commandRejected).length).toBe(
      rejectionsBefore,
    );
    // The dropped report never landed, so the room still has the far eye.
    expect(hunt.accuse(CLOCK_ID)?.detail).toBe("out_of_range");

    // The control: that same report is accepted when it is inside the cap, so
    // what refused the shot above was the allowance and not the position.
    const within = new HuntRoom();
    within.reportEye(far);
    within.reportEye(legal);
    expect(within.accuse(CLOCK_ID)).toBeNull();
  });

  it("refuses a malformed eye, which is a client fault rather than a flood", () => {
    const hunt = new HuntRoom();
    hunt.room.handleInspectorEye(hunt.inspector.asClient(), { eye: ["a", 0, 0] });

    expect(hunt.inspector.messagesOfType(SERVER_MESSAGE.commandRejected).at(-1)).toEqual({
      type: INSPECTOR_EYE_MESSAGE,
      reason: "invalid_payload",
    });
  });

  it("spends its own allowance rather than the sender's command budget", () => {
    const hunt = new HuntRoom();
    const legal = eyeInTheRoom();

    // An eye arrives on a movement cadence. A client paying for it out of the
    // same twenty commands a second would have to choose between reporting
    // where it is standing and firing from there.
    for (let index = 0; index < MAX_EYE_REPORTS_PER_SECOND; index += 1) hunt.reportEye(legal);

    expect(hunt.accuse(CLOCK_ID)).toBeNull();
  });
});

describe("MatchRoom close passes", () => {
  it("finds one when an Inspector loiters beside a locked disguise", () => {
    const hunt = new HuntRoom();
    const closePasses = () =>
      hunt.broadcastEvents().filter((event) => event.type === "close_pass");

    // Standing well clear of the disguise earns nothing however long it lasts.
    hunt.reportEye([DISGUISE_ROOT[0] + 3, DISGUISE_ROOT[1] + 0.3, DISGUISE_ROOT[2]]);
    hunt.advance(10);
    expect(closePasses()).toHaveLength(0);

    // Two body heights away, held past the dwell, is the beat §6.4 pays for.
    hunt.reportEye([DISGUISE_ROOT[0] + 0.2, DISGUISE_ROOT[1] + 0.3, DISGUISE_ROOT[2]]);
    hunt.advance(10);

    const passes = closePasses();
    expect(passes.length).toBeGreaterThan(0);
    expect(passes[0]?.type === "close_pass" && passes[0].publicObjectId).toBe(hunt.disguiseId);
  });

  it("produces none at all without geometry, which is how it shipped", () => {
    const hunt = new HuntRoom({ spatial: PERMISSIVE_SPATIAL_VALIDATOR });
    hunt.reportEye([DISGUISE_ROOT[0] + 0.2, DISGUISE_ROOT[1] + 0.3, DISGUISE_ROOT[2]]);
    hunt.advance(20);

    expect(hunt.broadcastEvents().filter((event) => event.type === "close_pass")).toHaveLength(0);
  });
});

/**
 * A disguise tucked against the west face of the cabinet island of zone E,
 * whose footprint runs from x 0.65 eastward. The creep below is 0.12 m due
 * east, which walks the body into the cabinet.
 */
const BESIDE_CABINET: [number, number, number] = [0.6, 0.3, 0.5];
const INTO_CABINET: [number, number, number] = [0.72, 0.3, 0.5];
const ALONG_THE_AISLE: [number, number, number] = [0.48, 0.3, 0.5];

describe("MatchRoom creep destinations", () => {
  /** Creeps the room's Mimic and returns the refusal, or null when accepted. */
  function creepTo(hunt: HuntRoom, root: [number, number, number]): { reason: string } | null {
    // A creep is paid for out of an allowance that accrues from the last
    // accepted pose, so the clock is run on before the body moves. Without
    // this the move is refused for its speed and never reaches the geometry.
    hunt.advance(10);
    const before = hunt.mimic.messagesOfType(SERVER_MESSAGE.commandRejected).length;
    hunt.room.handleForgeSnapshot(hunt.mimic.asClient(), {
      revision: 2,
      encodedPose: poseAt(root, 2),
    });
    const rejections = hunt.mimic.messagesOfType(SERVER_MESSAGE.commandRejected);
    if (rejections.length === before) return null;
    const last = rejections.at(-1) as { type: string; reason: string };
    expect(last.type).toBe(FORGE_SNAPSHOT_MESSAGE);
    return last;
  }

  it("refuses a creep that walks the body into the cabinet island", () => {
    const hunt = new HuntRoom({}, BESIDE_CABINET);

    expect(creepTo(hunt, INTO_CABINET)?.reason).toBe("outside_play_volume");
  });

  it("accepts the same creep along the aisle, so it is the walls and not the speed", () => {
    const hunt = new HuntRoom({}, BESIDE_CABINET);
    // The mirror image of the move above: the same distance from the same
    // start, away from the cabinet instead of into it.
    expect(INTO_CABINET[0] - BESIDE_CABINET[0]).toBeCloseTo(
      BESIDE_CABINET[0] - ALONG_THE_AISLE[0],
      6,
    );

    expect(creepTo(hunt, ALONG_THE_AISLE)).toBeNull();
  });

  it("accepts both without geometry, which is how it shipped", () => {
    const hunt = new HuntRoom({ spatial: PERMISSIVE_SPATIAL_VALIDATOR }, BESIDE_CABINET);

    expect(creepTo(hunt, INTO_CABINET)).toBeNull();
  });
});
