import { MatchPhase, DEFAULT_MATCH_SETTINGS } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import {
  CLOSE_PASS_COOLDOWN_MS,
  CLOSE_PASS_JACKPOT_COUNT,
  PERMISSIVE_SPATIAL_VALIDATOR,
  SCORE_MIMIC_CLOSE_PASS_JACKPOT,
  SCORE_MIMIC_TAUNT_STREAK_CAP,
  SCORE_MIMIC_TAUNT_STREAK_STEP,
  scoreMimic,
  TAUNT_COOLDOWN_MS,
  type SpatialValidator,
} from "../src";
import { Harness } from "./harness";

/**
 * The 2026-08-04 gameplay beats: the bait streak, the close-pass jackpot, the
 * midpoint hunt hint, and the gallery warrant restock. Each is exercised
 * through the same command and tick surface every transport drives.
 */

function huntHarness(seed: number, spatial?: SpatialValidator): Harness {
  const harness = new Harness({ players: 4, seed, spatial });
  harness.toInspection();
  return harness;
}

describe("the bait streak", () => {
  it("counts consecutive watched taunts and resets on one into empty air", () => {
    const harness = huntHarness(9_001);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    harness.command(inspector, { type: "focus", targetObjectId: objectId });
    for (let i = 0; i < 3; i += 1) {
      expect(harness.command(mimicId, { type: "taunt", tauntId: "rattle" }).accepted).toBe(true);
      harness.tick(TAUNT_COOLDOWN_MS + 100);
    }
    // The streak the hider's own HUD hears climbs 1, 2, 3.
    const climbs = harness
      .privateEventsOfType(mimicId, "taunt_streak")
      .map((event) => event.streak);
    expect(climbs).toEqual([1, 2, 3]);

    // Looking away makes the next taunt land unwatched, which resets the run.
    harness.command(inspector, { type: "focus", targetObjectId: null });
    expect(harness.command(mimicId, { type: "taunt", tauntId: "rattle" }).accepted).toBe(true);
    const all = harness
      .privateEventsOfType(mimicId, "taunt_streak")
      .map((event) => event.streak);
    expect(all).toEqual([1, 2, 3, 0]);
  });

  it("pays the streak bonus through the score formula, capped", () => {
    const base = scoreMimic({
      survivalSeconds: 0,
      directLookEscapes: 0,
      closePasses: 0,
      fullRoundSurvival: false,
      peerStyleVotes: 0,
    });
    const streaked = scoreMimic({
      survivalSeconds: 0,
      directLookEscapes: 0,
      closePasses: 0,
      fullRoundSurvival: false,
      peerStyleVotes: 0,
      tauntStreakBest: 3,
    });
    expect(streaked - base).toBe(2 * SCORE_MIMIC_TAUNT_STREAK_STEP);

    const capped = scoreMimic({
      survivalSeconds: 0,
      directLookEscapes: 0,
      closePasses: 0,
      fullRoundSurvival: false,
      peerStyleVotes: 0,
      tauntStreakBest: 40,
    });
    expect(capped - base).toBe(SCORE_MIMIC_TAUNT_STREAK_CAP * SCORE_MIMIC_TAUNT_STREAK_STEP);
  });
});

describe("the close-pass jackpot", () => {
  it("pays the hider once when the same seeker passes a third time", () => {
    const harness = huntHarness(9_003);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    for (let pass = 0; pass < CLOSE_PASS_JACKPOT_COUNT + 1; pass += 1) {
      harness.record(harness.sim.recordClosePass(inspector, objectId, harness.now));
      harness.now += CLOSE_PASS_COOLDOWN_MS + 100;
    }

    const jackpots = harness.privateEventsOfType(mimicId, "close_pass_jackpot");
    expect(jackpots).toHaveLength(1);

    // And it is worth exactly the advertised bonus in the formula.
    const with_ = scoreMimic({
      survivalSeconds: 0,
      directLookEscapes: 0,
      closePasses: 0,
      fullRoundSurvival: false,
      peerStyleVotes: 0,
      closePassJackpots: 1,
    });
    const without = scoreMimic({
      survivalSeconds: 0,
      directLookEscapes: 0,
      closePasses: 0,
      fullRoundSurvival: false,
      peerStyleVotes: 0,
    });
    expect(with_ - without).toBe(SCORE_MIMIC_CLOSE_PASS_JACKPOT);
  });
});

describe("the midpoint hunt hint", () => {
  it("tells each seeker, once, how many live hiders they brushed past", () => {
    const harness = huntHarness(9_005);
    const inspector = harness.inspectorIds()[0] as string;
    const first = harness.mimicIds()[0] as string;
    const second = harness.mimicIds()[1] as string;

    harness.record(harness.sim.recordClosePass(inspector, harness.objectIdOf(first), harness.now));
    harness.record(harness.sim.recordClosePass(inspector, harness.objectIdOf(second), harness.now));

    // Run the hunt past its midpoint.
    const half = DEFAULT_MATCH_SETTINGS.inspectionMs / 2 + 500;
    harness.tick(half);
    harness.tick(250);

    const hints = harness.privateEventsOfType(inspector, "hunt_hint");
    expect(hints).toHaveLength(1);
    expect(hints[0]?.closePasses).toBe(2);

    // Never a second one, however long the hunt runs.
    harness.tick(1_000);
    expect(harness.privateEventsOfType(inspector, "hunt_hint")).toHaveLength(1);
  });
});

describe("the warrant restock", () => {
  const atCase: SpatialValidator = {
    ...PERMISSIVE_SPATIAL_VALIDATOR,
    canClaimRestock: () => ({ ok: true }),
  };

  it("refills one warrant, once, and only in the hunt's second half", () => {
    const harness = huntHarness(9_007, atCase);
    const inspector = harness.inspectorIds()[0] as string;

    expect(harness.command(inspector, { type: "claim_restock" }).reason).toBe(
      "restock_unavailable",
    );

    harness.tick(DEFAULT_MATCH_SETTINGS.inspectionMs / 2 + 500);
    const before = harness.sim.getPrivateStateFor(inspector)?.warrantsRemaining ?? 0;
    expect(harness.command(inspector, { type: "claim_restock" }).accepted).toBe(true);
    expect(harness.sim.getPrivateStateFor(inspector)?.warrantsRemaining).toBe(before + 1);
    expect(harness.eventsOfType("warrant_restock")).toHaveLength(1);

    // The case is empty for the rest of the round.
    expect(harness.command(inspector, { type: "claim_restock" }).reason).toBe(
      "restock_unavailable",
    );
  });

  it("refuses a seeker whose validator does not place them at the case", () => {
    const harness = huntHarness(9_009);
    const inspector = harness.inspectorIds()[0] as string;
    harness.tick(DEFAULT_MATCH_SETTINGS.inspectionMs / 2 + 500);
    const result = harness.command(inspector, { type: "claim_restock" });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("restock_unavailable");
  });

  it("refuses everyone who is not a seeker", () => {
    const harness = huntHarness(9_011, atCase);
    const mimicId = harness.mimicIds()[0] as string;
    harness.tick(DEFAULT_MATCH_SETTINGS.inspectionMs / 2 + 500);
    expect(harness.command(mimicId, { type: "claim_restock" }).reason).toBe("wrong_role");
  });

  it("survives a host migration without refilling twice", () => {
    const harness = huntHarness(9_013, atCase);
    const inspector = harness.inspectorIds()[0] as string;
    harness.tick(DEFAULT_MATCH_SETTINGS.inspectionMs / 2 + 500);
    expect(harness.command(inspector, { type: "claim_restock" }).accepted).toBe(true);

    const snapshot = harness.sim.snapshot();
    const restored = harness.sim.constructor as typeof import("../src").MatchSimulation;
    const sim = restored.restore(snapshot, { spatial: atCase });
    const result = sim.handleCommand(inspector, { type: "claim_restock" });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("restock_unavailable");
  });
});

describe("the hunt still ends the way it always did", () => {
  it("keeps the clock as the hunt's end, restock or not", () => {
    const harness = huntHarness(9_015);
    harness.tickUntil(MatchPhase.Reveal);
    expect(harness.phase()).toBe(MatchPhase.Reveal);
  });
});
