import { describe, expect, it } from "vitest";
import { MatchPhase } from "@foldseek/shared";
import { DeterministicRng, mulberry32 } from "../src";
import { Harness } from "./harness";

/** Plays an identical scripted round so two runs can be compared event by event. */
function playScriptedRound(seed: number): Harness {
  const harness = new Harness({ players: 5, seed });
  harness.toInspection();

  const inspector = harness.inspectorIds()[0] as string;
  const mimics = harness.mimicIds();
  harness.tick(3_000);
  harness.command(inspector, { type: "accuse", targetObjectId: "prop-lamp" });
  harness.tick(4_000);
  harness.command(inspector, {
    type: "accuse",
    targetObjectId: harness.objectIdOf(mimics[0] as string),
  });
  harness.command(inspector, { type: "focus", targetObjectId: "prop-clock" });
  harness.tickUntil(MatchPhase.RematchVote);
  for (const playerId of harness.playerIds) {
    harness.command(playerId, { type: "vote_rematch", yes: true });
  }
  harness.tickUntil(MatchPhase.Forge);
  return harness;
}

/** Both streams together, so determinism covers private deliveries as well. */
function bothStreams(harness: Harness): string {
  return JSON.stringify({
    public: harness.log,
    private: [...harness.privateLog.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  });
}

describe("determinism", () => {
  it("produces identical event logs for the same seed and command stream", () => {
    const first = playScriptedRound(4_242);
    const second = playScriptedRound(4_242);
    expect(JSON.stringify(second.log)).toBe(JSON.stringify(first.log));
  });

  it("produces identical private deliveries for the same seed and command stream", () => {
    const first = playScriptedRound(4_242);
    const second = playScriptedRound(4_242);
    expect(bothStreams(second)).toBe(bothStreams(first));
    expect(first.allPrivateEvents().length).toBeGreaterThan(5);
  });

  it("diverges for a different seed", () => {
    const first = playScriptedRound(4_242);
    const other = playScriptedRound(9_001);
    expect(JSON.stringify(other.log)).not.toBe(JSON.stringify(first.log));
    expect(bothStreams(other)).not.toBe(bothStreams(first));
  });

  it("keeps public state identical across two runs of the same seed", () => {
    const first = playScriptedRound(555);
    const second = playScriptedRound(555);
    expect(JSON.stringify(second.sim.getPublicState())).toBe(
      JSON.stringify(first.sim.getPublicState()),
    );
  });

  it("gives mulberry32 a stable stream in the unit interval", () => {
    const a = mulberry32(12_345);
    const b = mulberry32(12_345);
    const samples = Array.from({ length: 32 }, () => a());
    expect(samples).toEqual(Array.from({ length: 32 }, () => b()));
    expect(samples.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(samples).size).toBe(samples.length);
  });

  it("shuffles and picks deterministically without losing elements", () => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const shuffled = new DeterministicRng(99).shuffle(items);
    expect(shuffled).not.toEqual(items);
    expect([...shuffled].sort()).toEqual([...items].sort());
    expect(new DeterministicRng(99).shuffle(items)).toEqual(shuffled);
    expect(items).toEqual(["a", "b", "c", "d", "e", "f"]);

    const rng = new DeterministicRng(5);
    const picks = Array.from({ length: 20 }, () => rng.pick(items));
    expect(picks.every((value) => items.includes(value))).toBe(true);
    expect(() => new DeterministicRng(5).int(0)).toThrow();
  });

  it("refuses a non-finite tick time and ignores backwards clocks", () => {
    const harness = new Harness({ players: 3, seed: 1 });
    expect(() => harness.sim.tick(Number.NaN)).toThrow();

    harness.tick(1_000);
    harness.sim.tick(10);
    expect(harness.sim.getPublicState().now).toBe(1_000);
  });
});
