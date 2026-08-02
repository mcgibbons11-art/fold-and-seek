import { describe, expect, it } from "vitest";
import { MatchPhase } from "@foldseek/shared";
import {
  CLOSE_PASS_COOLDOWN_MS,
  CLOSE_PASS_DWELL_MS,
  PERMISSIVE_SPATIAL_VALIDATOR,
  SCORE_MIMIC_PER_CLOSE_PASS,
  type SpatialValidator,
} from "../src";
import { Harness, testPose } from "./harness";

/**
 * Close passes (§6.4), found by the simulation from the geometry seam.
 *
 * The rule has three parts and each is tested against a validator whose answers
 * a test moves by hand, so what is measured is the simulation's arithmetic
 * rather than any map's boxes: proximity has to hold for `CLOSE_PASS_DWELL_MS`
 * before it pays, one inspector/object pair pays at most once per
 * `CLOSE_PASS_COOLDOWN_MS`, and separating drops whatever dwell had accrued.
 *
 * Nothing here reports a pass to the simulation. `recordClosePass` is called in
 * exactly one test below, to hold the pushed-in path that predates the detector,
 * and every other assertion comes from ticking a hunt in which the Inspector
 * merely happens to be standing somewhere.
 */

/** Proximity a test drives directly, keyed inspector-then-object. */
class Proximity implements SpatialValidator {
  private readonly near = new Set<string>();

  canAccuse = PERMISSIVE_SPATIAL_VALIDATOR.canAccuse;
  canObserve = PERMISSIVE_SPATIAL_VALIDATOR.canObserve;
  canOccupy = PERMISSIVE_SPATIAL_VALIDATOR.canOccupy;

  isNearby(inspectorId: string, targetObjectId: string) {
    return this.near.has(`${inspectorId}|${targetObjectId}`)
      ? { ok: true }
      : { ok: false, reason: "out_of_range" };
  }

  approach(inspectorId: string, targetObjectId: string): void {
    this.near.add(`${inspectorId}|${targetObjectId}`);
  }

  withdraw(inspectorId: string, targetObjectId: string): void {
    this.near.delete(`${inspectorId}|${targetObjectId}`);
  }
}

const STEP_MS = 100;

interface Hunt {
  readonly harness: Harness;
  readonly proximity: Proximity;
  readonly inspector: string;
  readonly mimic: string;
  readonly objectId: string;
  /**
   * Walks the Inspector up to the disguise and ticks once, which is the tick
   * the authority first sees them there. The dwell is counted from that
   * observation, so every `advance` after this one is time spent alongside.
   */
  arrive(): void;
  /** Ticks the hunt forward. Returns how many close passes the room has seen. */
  advance(ms: number): number;
  passes(): number;
}

function hunt(seed: number): Hunt {
  const proximity = new Proximity();
  const harness = new Harness({
    players: 4,
    seed,
    spatial: proximity,
    settings: { inspectionMs: 120_000 },
  });
  harness.toInspection();
  const inspector = harness.inspectorIds()[0] as string;
  const mimic = harness.mimicIds()[0] as string;
  const objectId = harness.objectIdOf(mimic);

  const passes = (): number => harness.eventsOfType("close_pass").length;
  const advance = (ms: number): number => {
    for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) harness.tick(STEP_MS);
    return passes();
  };
  return {
    harness,
    proximity,
    inspector,
    mimic,
    objectId,
    arrive() {
      proximity.approach(inspector, objectId);
      advance(STEP_MS);
    },
    advance,
    passes,
  };
}

describe("close passes", () => {
  it("pays nothing while the Inspector is elsewhere", () => {
    const round = hunt(301);
    expect(round.harness.phase()).toBe(MatchPhase.Inspection);

    expect(round.advance(10_000)).toBe(0);
  });

  it("pays once the Inspector has been alongside for the dwell", () => {
    const round = hunt(307);
    round.arrive();

    // The dwell is a real gate, not a formality: standing there for a moment
    // short of it is worth nothing.
    expect(round.advance(CLOSE_PASS_DWELL_MS - STEP_MS)).toBe(0);
    expect(round.advance(STEP_MS)).toBe(1);

    const event = round.harness.eventsOfType("close_pass")[0];
    expect(event?.publicObjectId).toBe(round.objectId);
    const inspectorPublicId = round.harness.sim
      .getPublicState()
      .players.find((player) => player.seatId === round.inspector)?.publicPlayerId;
    expect(event?.inspectorPublicId).toBe(inspectorPublicId);
  });

  it("ignores an eye that is beside a disguise for a single sample", () => {
    const round = hunt(311);

    // One tick beside it and gone again, which is what a teleport, a rejoin or
    // a camera cut looks like from the authority's side.
    round.proximity.approach(round.inspector, round.objectId);
    round.advance(STEP_MS);
    round.proximity.withdraw(round.inspector, round.objectId);

    expect(round.advance(10_000)).toBe(0);
  });

  it("restarts the dwell when the pair separates", () => {
    const round = hunt(313);
    const nearlyThere = CLOSE_PASS_DWELL_MS - STEP_MS;

    round.arrive();
    expect(round.advance(nearlyThere)).toBe(0);
    round.proximity.withdraw(round.inspector, round.objectId);
    round.advance(STEP_MS);

    // Two near-misses do not add up to a pass.
    round.arrive();
    expect(round.advance(nearlyThere)).toBe(0);
    expect(round.advance(STEP_MS)).toBe(1);
  });

  it("pays a lingering Inspector once per cooldown rather than every tick", () => {
    const round = hunt(317);
    const lingerMs = 30_000;
    round.arrive();

    const passes = round.advance(lingerMs);
    // First at the dwell, then one per cooldown for the rest of the stay. Ticks
    // land on both boundaries exactly, so this is a count and not an estimate.
    const expected = 1 + Math.floor((lingerMs - CLOSE_PASS_DWELL_MS) / CLOSE_PASS_COOLDOWN_MS);
    expect(passes).toBe(expected);
    // 300 ticks stood next to the same object, and it paid eight times.
    expect(passes).toBeLessThan(lingerMs / STEP_MS);
  });

  it("credits the hider who is wearing the object, at the §6.2 weight", () => {
    const round = hunt(319);
    round.arrive();
    round.advance(CLOSE_PASS_DWELL_MS);
    round.proximity.withdraw(round.inspector, round.objectId);
    expect(round.passes()).toBe(1);

    round.harness.tickUntil(MatchPhase.Results, 1_000, 5_000);
    const results = round.harness.sim.getPublicState().results;
    const owner = round.harness.sim.getPublicState().players.find(
      (player) => player.seatId === round.mimic,
    )?.publicPlayerId;
    const scored = results?.players.find((entry) => entry.publicPlayerId === owner);
    expect(scored?.closePasses).toBe(1);
    // Every other mimic was alone all round, so the difference between them is
    // the close pass and nothing else.
    const untouched = results?.players.find(
      (entry) => entry.role === "mimic" && entry.publicPlayerId !== owner,
    );
    expect(scored?.score).toBe((untouched?.score ?? 0) + SCORE_MIMIC_PER_CLOSE_PASS);
  });

  it("stops paying for a disguise that has been caught", () => {
    const round = hunt(323);
    round.arrive();
    expect(round.advance(CLOSE_PASS_DWELL_MS)).toBe(1);

    round.harness.command(round.inspector, { type: "accuse", targetObjectId: round.objectId });
    expect(round.harness.eventsOfType("mimic_caught")).toHaveLength(1);

    // The Inspector is standing over the body they just found. There is no
    // nerve left in that, and the player behind it is out of the round.
    expect(round.advance(30_000)).toBe(1);
  });

  it("finds nothing outside the hunt", () => {
    const proximity = new Proximity();
    const harness = new Harness({ players: 4, seed: 331, spatial: proximity });
    harness.toForge();
    const inspector = harness.inspectorIds()[0] as string;
    for (const [index, mimicId] of harness.mimicIds().entries()) {
      harness.command(mimicId, { type: "lock_disguise", payload: testPose(index), revision: 1 });
    }

    // Whatever the geometry says during the fold, the phase decides. The
    // Inspector is not hunting yet, so nobody is being walked past.
    const objectId = harness.objectIdOf(harness.mimicIds()[0] as string);
    proximity.approach(inspector, objectId);
    for (let step = 0; step < 20; step += 1) harness.tick(STEP_MS);
    expect(harness.eventsOfType("close_pass")).toHaveLength(0);
  });

  it("still accepts a pass reported from outside", () => {
    const round = hunt(337);
    round.harness.record(round.harness.sim.recordClosePass(round.inspector, round.objectId));
    expect(round.passes()).toBe(1);

    // And the detector's cooldown is the same clock the reported one moved, so
    // walking up immediately afterwards does not pay twice: the dwell is
    // satisfied well before the window on that pair reopens.
    round.arrive();
    expect(round.advance(CLOSE_PASS_DWELL_MS)).toBe(1);
    expect(round.advance(CLOSE_PASS_COOLDOWN_MS)).toBe(2);
  });
});
