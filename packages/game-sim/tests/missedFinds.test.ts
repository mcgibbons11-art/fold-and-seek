import { describe, expect, it } from "vitest";
import { MatchPhase, SimEventSchema } from "@foldseek/shared";
import {
  MISSED_FINDS_JITTER_MS,
  MISSED_FINDS_POINT_BUCKET,
  MatchSimulation,
  SCORE_MIMIC_PER_LINE_OF_SIGHT_SECOND,
  TAUNT_COOLDOWN_MS,
} from "../src";
import { Harness } from "./harness";

/**
 * The live missed-finds board (docs/MECCHA_RESEARCH.md). It ranks hiders by the
 * deception points they have banked, on a visible cycle, while the hunt runs.
 */

function huntHarness(seed: number, players = 5): Harness {
  const harness = new Harness({ players, seed });
  harness.toInspection();
  return harness;
}

/** Advances the clock the way a host does, in ticks rather than one jump. */
function tickFor(harness: Harness, totalMs: number, stepMs = 250): void {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) harness.tick(stepMs);
}

/** Holds an Inspector's focus on an object for a stretch of the hunt. */
function stare(harness: Harness, objectId: string, forMs: number): void {
  const inspector = harness.inspectorIds()[0] as string;
  harness.command(inspector, { type: "focus", targetObjectId: objectId });
  tickFor(harness, forMs);
  harness.command(inspector, { type: "focus", targetObjectId: null });
}

describe("the live board", () => {
  it("publishes a ranked board on its cycle during the hunt", () => {
    const harness = huntHarness(4_001);
    const mimicId = harness.mimicIds()[0] as string;
    stare(harness, harness.objectIdOf(mimicId), 30_000);
    tickFor(harness, 30_000);

    const boards = harness.eventsOfType("missed_finds_update");
    expect(boards.length).toBeGreaterThanOrEqual(2);

    const board = boards.at(-1);
    expect(board?.final).toBe(false);
    expect(board?.entries).toHaveLength(harness.mimicIds().length);
    // Ranked highest first.
    const points = board?.entries.map((entry) => entry.points) ?? [];
    expect([...points].sort((a, b) => b - a)).toEqual(points);
    // The hider who was stared at leads it.
    const publicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId;
    expect(board?.entries[0]?.publicPlayerId).toBe(publicId);
  });

  it("names players and never their disguises", () => {
    const harness = huntHarness(4_003);
    const mimicId = harness.mimicIds()[0] as string;
    stare(harness, harness.objectIdOf(mimicId), 25_000);
    tickFor(harness, 20_000);

    const objectIds = harness
      .sim.getPublicState()
      .disguises.map((entry) => entry.publicObjectId);
    const boards = JSON.stringify(harness.eventsOfType("missed_finds_update"));
    expect(boards.length).toBeGreaterThan(2);
    for (const objectId of objectIds) expect(boards).not.toContain(objectId);
    for (const playerId of harness.playerIds) expect(boards).not.toContain(playerId);

    const entry = harness.eventsOfType("missed_finds_update").at(-1)?.entries[0];
    expect(entry?.displayName).toMatch(/^Visitor /);
    expect(entry?.publicPlayerId).toMatch(/^p_/);
  });

  it("counts a truthful countdown to the next board", () => {
    const harness = huntHarness(4_007);
    tickFor(harness, 60_000);

    const boards = harness.eventsOfType("missed_finds_update");
    expect(boards.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i + 1 < boards.length; i += 1) {
      const promised = boards[i]?.nextUpdateAtMs as number;
      const landed = boards[i + 1]?.at as number;
      // The next board lands at the promised time, within one tick step.
      expect(landed).toBeGreaterThanOrEqual(promised);
      expect(landed - promised).toBeLessThan(250);
    }
  });

  it("keeps the cycle inside its jitter window", () => {
    const harness = huntHarness(4_011);
    tickFor(harness, 70_000);

    const boards = harness.eventsOfType("missed_finds_update").filter((board) => !board.final);
    expect(boards.length).toBeGreaterThanOrEqual(3);
    const cycle = harness.sim.getSettings().missedFindsUpdateMs;
    for (let i = 0; i + 1 < boards.length; i += 1) {
      const gap = (boards[i + 1]?.at as number) - (boards[i]?.at as number);
      expect(gap).toBeGreaterThanOrEqual(cycle - MISSED_FINDS_JITTER_MS);
      expect(gap).toBeLessThanOrEqual(cycle + MISSED_FINDS_JITTER_MS + 250);
    }
    // Jitter means the cadence is not a metronome.
    const gaps = boards.slice(1).map((board, i) => board.at - (boards[i]?.at as number));
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it("closes with an exact board at the reveal", () => {
    const harness = huntHarness(4_013);
    const mimicId = harness.mimicIds()[0] as string;
    stare(harness, harness.objectIdOf(mimicId), 21_000);
    harness.tickUntil(MatchPhase.Reveal);

    const final = harness.eventsOfType("missed_finds_update").at(-1);
    expect(final?.final).toBe(true);
    expect(final?.nextUpdateAtMs).toBe(0);

    // 21 s watched is 42, and breaking that stare without shooting is an
    // escape worth 75. Reported exactly rather than bucketed.
    const publicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId;
    const entry = final?.entries.find((row) => row.publicPlayerId === publicId);
    expect(entry?.points).toBe(21 * SCORE_MIMIC_PER_LINE_OF_SIGHT_SECOND + 75);
  });

  it("counts escapes, taunts and close passes as well as being watched", () => {
    const harness = huntHarness(4_017);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    harness.command(inspector, { type: "focus", targetObjectId: objectId });
    harness.command(mimicId, { type: "taunt", tauntId: "rattle" });
    harness.tick(TAUNT_COOLDOWN_MS);
    harness.command(inspector, { type: "focus", targetObjectId: null });
    harness.tick(2_000);
    harness.record(harness.sim.recordClosePass(inspector, objectId, harness.now));
    harness.tickUntil(MatchPhase.Reveal);

    const publicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId;
    const entry = harness
      .eventsOfType("missed_finds_update")
      .at(-1)
      ?.entries.find((row) => row.publicPlayerId === publicId);
    // 5 s watched (10) + one escape (75) + one watched taunt (40) + one close pass (50).
    expect(entry?.points).toBe(10 + 75 + 40 + 50);
  });
});

describe("board anonymity", () => {
  it("cannot tell two unequal stares apart once bucketed", () => {
    // The correlation an Inspector would attempt: stare at one object, wait for
    // the board, read which name moved. Two hiders looked at for four and ten
    // seconds accrue 83 and 95 points, and both floor to the same 75, so the
    // board cannot say which of the two got the longer look.
    const harness = huntHarness(4_019);
    const [first, second] = harness.mimicIds();
    stare(harness, harness.objectIdOf(first as string), 4_000);
    stare(harness, harness.objectIdOf(second as string), 10_000);
    tickFor(harness, 25_000);

    const board = harness.eventsOfType("missed_finds_update").filter((entry) => !entry.final).at(-1);
    expect(board).toBeDefined();

    const pointsFor = (playerId: string): number | undefined => {
      const publicId = harness.sim.getPrivateStateFor(playerId)?.publicPlayerId;
      return board?.entries.find((row) => row.publicPlayerId === publicId)?.points;
    };
    expect(pointsFor(first as string)).toBe(75);
    expect(pointsFor(second as string)).toBe(75);

    // Hiders nobody looked at stay at zero, so the board is not uniformly blank.
    const untouched = harness.mimicIds().filter((id) => id !== first && id !== second);
    expect(untouched.length).toBeGreaterThan(0);
    for (const playerId of untouched) expect(pointsFor(playerId)).toBe(0);
  });

  it("quantizes every mid-round figure to a bucket", () => {
    const harness = huntHarness(4_021);
    const [first, second] = harness.mimicIds();
    stare(harness, harness.objectIdOf(first as string), 31_000);
    stare(harness, harness.objectIdOf(second as string), 17_000);
    tickFor(harness, 20_000);

    const boards = harness.eventsOfType("missed_finds_update").filter((board) => !board.final);
    expect(boards.length).toBeGreaterThan(0);
    for (const board of boards) {
      for (const entry of board.entries) {
        expect(entry.points % MISSED_FINDS_POINT_BUCKET).toBe(0);
      }
    }

    // Bucketing is a floor, so the published figure never overstates.
    const publicId = harness.sim.getPrivateStateFor(first as string)?.publicPlayerId;
    const shown = boards.at(-1)?.entries.find((row) => row.publicPlayerId === publicId)?.points ?? 0;
    harness.tickUntil(MatchPhase.Reveal);
    const exact = harness
      .eventsOfType("missed_finds_update")
      .at(-1)
      ?.entries.find((row) => row.publicPlayerId === publicId)?.points as number;
    expect(shown).toBeLessThanOrEqual(exact);
    expect(exact - shown).toBeLessThan(MISSED_FINDS_POINT_BUCKET);
  });
});

describe("board determinism and migration", () => {
  it("produces the same cycle and figures for one seed", () => {
    const play = (seed: number): string => {
      const harness = huntHarness(seed);
      stare(harness, harness.objectIdOf(harness.mimicIds()[0] as string), 26_000);
      harness.tickUntil(MatchPhase.Reveal);
      return JSON.stringify(harness.eventsOfType("missed_finds_update"));
    };
    expect(play(4_027)).toBe(play(4_027));
    expect(play(4_049)).not.toBe(play(4_027));
  });

  it("carries the cycle across a migration without double-firing", () => {
    const harness = huntHarness(4_051);
    tickFor(harness, 25_000);
    const before = harness.eventsOfType("missed_finds_update").length;
    expect(before).toBeGreaterThan(0);

    const snapshot = harness.sim.snapshot();
    expect(snapshot.mc).toBeGreaterThan(0);
    expect(snapshot.mf).toBeGreaterThan(snapshot.t);

    const restored = MatchSimulation.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    // A fresh host does not immediately republish the board it inherited.
    const soon = restored.tick(snapshot.t + 100);
    expect(soon.public.filter((event) => event.type === "missed_finds_update")).toHaveLength(0);
    // It publishes when the inherited schedule says to.
    const due = restored.tick(snapshot.mf + 10);
    expect(due.public.filter((event) => event.type === "missed_finds_update")).toHaveLength(1);
  });

  it("stops publishing outside the hunt and resets with the round", () => {
    const harness = huntHarness(4_057, 4);
    harness.tickUntil(MatchPhase.RematchVote);
    const duringRound = harness.eventsOfType("missed_finds_update").length;

    for (const playerId of harness.playerIds) {
      harness.command(playerId, { type: "vote_rematch", yes: false });
    }
    expect(harness.phase()).toBe(MatchPhase.Lobby);
    tickFor(harness, 60_000);
    // The lobby publishes no boards at all.
    expect(harness.eventsOfType("missed_finds_update")).toHaveLength(duringRound);
    expect(harness.sim.snapshot().mc).toBe(0);
  });

  it("keeps every board schema-valid", () => {
    const harness = huntHarness(4_063);
    stare(harness, harness.objectIdOf(harness.mimicIds()[0] as string), 22_000);
    harness.tickUntil(MatchPhase.Results);

    const boards = harness.eventsOfType("missed_finds_update");
    expect(boards.length).toBeGreaterThanOrEqual(2);
    for (const event of harness.log) {
      const parsed = SimEventSchema.safeParse(event);
      expect(parsed.success, `${event.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
});
