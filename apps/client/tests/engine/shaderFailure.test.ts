import { describe, expect, it } from "vitest";

import { QUALITY_TIER_ORDER, stepQualityTier, type QualityTier } from "../../src/rendering/quality";
import { ShaderFailurePolicy, type ShaderFailureResponse } from "../../src/rendering/RendererManager";

/**
 * The failure this encodes, measured on a frozen production build on an Intel
 * integrated GPU: about ten `Shader Error 1282 VALIDATE_STATUS false` link
 * failures with empty driver logs arrive in one burst, then
 * `uniformBlockBinding: program not linked`, then the context dies and the tab
 * renders nothing for the rest of the session. Half of all rounds ended that
 * way. The tier is the only lever that shortens a fragment program from there,
 * so it is spent while the device is still alive.
 *
 * `GameHost` owns the detection hook and the tier ladder; the decision is this
 * policy's, and it is what these drive. The ladder is the real
 * `QUALITY_TIER_ORDER`, so a tier added or removed is exercised here too.
 */

interface Run {
  readonly tier: QualityTier;
  readonly demotions: number;
  readonly faulted: boolean;
  /** Highest tier index automatic changes may still reach afterwards. */
  readonly ceiling: number;
}

/**
 * Replays a sequence of failures through the policy exactly as `GameHost` does:
 * it can demote while a lower tier exists, and it shows the device-fault panel
 * when told to fault.
 */
function drive(failuresAtMs: readonly number[], from: QualityTier = "medium"): Run {
  const policy = new ShaderFailurePolicy();
  let tier = from;
  let ceiling = QUALITY_TIER_ORDER.length - 1;
  let demotions = 0;
  let faulted = false;

  for (const nowMs of failuresAtMs) {
    const index = QUALITY_TIER_ORDER.indexOf(tier);
    ceiling = Math.max(0, Math.min(ceiling, index - 1));
    const response: ShaderFailureResponse = policy.record(nowMs, index > 0);
    if (response === "demote") {
      tier = stepQualityTier(tier, "lower", ceiling) as QualityTier;
      demotions += 1;
    }
    if (response === "fault") faulted = true;
  }

  return { tier, demotions, faulted, ceiling };
}

/** The ten-in-a-frame storm the critic recorded, as one burst of timestamps. */
function storm(startMs: number, count = 10): number[] {
  return Array.from({ length: count }, (_, index) => startMs + index * 0.4);
}

describe("ShaderFailurePolicy", () => {
  it("demotes one tier on the first failure, before the context dies", () => {
    const run = drive([1_000]);
    expect(run.demotions).toBe(1);
    expect(run.tier).toBe("low");
    expect(run.faulted).toBe(false);
  });

  it("spends one tier on a whole burst, not one per failed program", () => {
    // Every material the frame touched fails at once. Ten failures are one piece
    // of news, and demoting ten times would drop straight through the ladder to
    // the fault panel on the first bad frame.
    const run = drive(storm(1_000));
    expect(run.demotions).toBe(1);
    expect(run.tier).toBe("low");
    expect(run.faulted).toBe(false);
  });

  it("walks the ladder down one rung per burst while the failures keep coming", () => {
    // Three bursts from the top of the ladder: ultra, high, medium, low.
    const run = drive([...storm(1_000), ...storm(5_000), ...storm(9_000)], "ultra");
    expect(run.demotions).toBe(3);
    expect(run.tier).toBe("low");
    expect(run.faulted).toBe(false);
  });

  it("reaches the floor tier and stops there rather than faulting at once", () => {
    // Landing on the floor may be enough: the burst that caused the demote is
    // still arriving, and the frame after it gets to compile at the new tier.
    const run = drive([...storm(1_000), ...storm(5_000)], "low");
    expect(run.tier).toBe("light");
    expect(run.demotions).toBe(1);
    expect(run.faulted).toBe(false);
  });

  it("faults once the floor tier cannot link either", () => {
    // Two bursts at the floor with nothing left to trade away. The panel is the
    // honest end state; the alternative is a tab that draws nothing and then
    // loses the device anyway.
    const run = drive([...storm(1_000), ...storm(5_000), ...storm(9_000)], "low");
    expect(run.tier).toBe("light");
    expect(run.faulted).toBe(true);
  });

  it("never faults a session whose failures stop", () => {
    const policy = new ShaderFailurePolicy();
    expect(policy.record(1_000, false)).toBe("ignore");
    // Twenty quiet seconds, then one straggler. A single failure at the floor is
    // survivable however long the session runs, so long as they do not pile up.
    expect(policy.record(21_000, false)).toBe("fault");
  });

  it("closes the tier that failed for the rest of the session", () => {
    // The demote is only half the fix. `AdaptiveQuality` raises the tier when
    // frames are fast, and a tier that draws nothing because its programs never
    // linked is a fast tier, so without a ceiling the session would climb back
    // into the failure it was just pulled out of, over and over.
    const run = drive(storm(1_000), "high");
    expect(run.tier).toBe("medium");
    expect(stepQualityTier(run.tier, "raise", run.ceiling)).toBeNull();
    // The rung below is still available, which is what the next burst spends.
    expect(stepQualityTier(run.tier, "lower", run.ceiling)).toBe("low");
    // And an untouched session is free to climb, so this is the failure closing
    // the tier rather than the ladder being one-way for everybody.
    expect(stepQualityTier("medium", "raise")).toBe("high");
  });

  it("forgets the floor count when a demote lands under it", () => {
    // The count exists to describe failures the ladder has already been spent
    // on. A tier the world was raised back to, then lowered again, starts over.
    const policy = new ShaderFailurePolicy();
    expect(policy.record(1_000, false)).toBe("ignore");
    expect(policy.record(5_000, true)).toBe("demote");
    expect(policy.record(9_000, false)).toBe("ignore");
    expect(policy.record(13_000, false)).toBe("fault");
  });
});
