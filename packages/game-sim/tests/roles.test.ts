import { describe, expect, it } from "vitest";
import { MatchPhase } from "@foldseek/shared";
import { DeterministicRng, assignInspectors, inspectorCountForRoster, type RoleHistory } from "../src";
import { Harness } from "./harness";

interface RotationOutcome {
  readonly picks: string[][];
  readonly counts: Map<string, number>;
}

/** Replays the room's role history exactly as MatchSimulation does. */
function rotate(playerCount: number, rounds: number, seed: number): RotationOutcome {
  const histories = new Map<string, RoleHistory>();
  for (let i = 0; i < playerCount; i += 1) {
    histories.set(`p${i}`, {
      playerId: `p${i}`,
      lastInspectorRound: -1,
      inspectorRounds: 0,
      joinedRound: 0,
    });
  }

  const picks: string[][] = [];
  const counts = new Map<string, number>();
  for (let round = 0; round < rounds; round += 1) {
    const rng = new DeterministicRng(seed + round);
    const chosen = assignInspectors([...histories.values()], rng);
    picks.push(chosen);
    for (const playerId of chosen) {
      const previous = histories.get(playerId) as RoleHistory;
      histories.set(playerId, {
        ...previous,
        lastInspectorRound: round,
        inspectorRounds: previous.inspectorRounds + 1,
      });
      counts.set(playerId, (counts.get(playerId) ?? 0) + 1);
    }
  }
  return { picks, counts };
}

describe("role assignment", () => {
  it("uses one inspector for 2 to 8 players and two for 9 to 12", () => {
    expect(inspectorCountForRoster(1)).toBe(0);
    expect(inspectorCountForRoster(2)).toBe(1);
    expect(inspectorCountForRoster(8)).toBe(1);
    expect(inspectorCountForRoster(9)).toBe(2);
    expect(inspectorCountForRoster(12)).toBe(2);
  });

  it("never repeats an inspector in consecutive rounds over 10 rounds", () => {
    for (const playerCount of [3, 5, 8]) {
      const { picks } = rotate(playerCount, 10, 991);
      for (let round = 1; round < picks.length; round += 1) {
        const previous = new Set(picks[round - 1]);
        expect((picks[round] as string[]).some((playerId) => previous.has(playerId))).toBe(false);
      }
    }
  });

  it("spreads inspector duty evenly over 10 rounds", () => {
    const { counts } = rotate(5, 10, 991);
    expect([...counts.values()].every((value) => value === 2)).toBe(true);

    const dual = rotate(9, 10, 17);
    const values = [...dual.counts.values()];
    expect(values.reduce((sum, value) => sum + value, 0)).toBe(20);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });

  it("assigns two inspectors in a nine player match", () => {
    const harness = new Harness({ players: 9, seed: 61 });
    harness.toForge();
    expect(harness.inspectorIds()).toHaveLength(2);
    expect(harness.mimicIds()).toHaveLength(7);
  });

  it("rotates the inspector between consecutive rounds of a live match", () => {
    const harness = new Harness({ players: 4, seed: 67 });
    harness.toInspection();
    const firstInspector = harness.inspectorIds()[0] as string;

    harness.tickUntil(MatchPhase.RematchVote);
    for (const playerId of harness.playerIds) {
      harness.command(playerId, { type: "vote_rematch", yes: true });
    }
    harness.tickUntil(MatchPhase.BaselineScan);

    expect(harness.sim.getPublicState().round).toBe(1);
    expect(harness.inspectorIds()).toHaveLength(1);
    expect(harness.inspectorIds()).not.toContain(firstInspector);
  });
});
