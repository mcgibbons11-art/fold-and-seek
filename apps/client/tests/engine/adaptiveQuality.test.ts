import { describe, expect, it, vi } from "vitest";

import { AdaptiveQuality, type TierDirection } from "../../src/rendering/AdaptiveQuality";
import { qualitySettingsFor, type QualityTier } from "../../src/rendering/quality";

type Decision =
  | { readonly kind: "scale"; readonly value: number; readonly atMs: number }
  | { readonly kind: "tier"; readonly value: TierDirection; readonly atMs: number };

interface Harness {
  readonly decisions: Decision[];
  readonly controller: AdaptiveQuality;
  now: number;
}

/** Builds a controller that logs every decision together with the time it landed. */
function harness(tier: QualityTier): Harness {
  const state: Harness = {
    decisions: [],
    now: 0,
    controller: undefined as unknown as AdaptiveQuality,
  };
  state.controller = new AdaptiveQuality(qualitySettingsFor(tier), {
    onRenderScale: (value) => state.decisions.push({ kind: "scale", value, atMs: state.now }),
    onTierSuggestion: (value) => state.decisions.push({ kind: "tier", value, atMs: state.now }),
  });
  return state;
}

/** Feeds frames of a fixed cost until the clock reaches `untilMs`. */
function run(state: Harness, frameMs: number, untilMs: number): void {
  while (state.now < untilMs) {
    state.now += frameMs;
    state.controller.update(state.now, frameMs);
  }
}

function scales(decisions: readonly Decision[]): number[] {
  return decisions.filter((decision) => decision.kind === "scale").map((decision) => decision.value);
}

function tiers(decisions: readonly Decision[]): TierDirection[] {
  return decisions.filter((decision) => decision.kind === "tier").map((decision) => decision.value);
}

describe("AdaptiveQuality", () => {
  it("starts at the top of the tier's resolution range", () => {
    expect(new AdaptiveQuality(qualitySettingsFor("medium")).renderScale).toBe(0.9);
    expect(new AdaptiveQuality(qualitySettingsFor("ultra")).renderScale).toBe(1);
  });

  it("holds everything steady while frame time sits inside the budget band", () => {
    const state = harness("high");
    // 16.7 ms budget: 15 ms is neither under 70% (11.7 ms) nor over 120% (20.0 ms).
    run(state, 15, 30000);

    expect(state.decisions).toEqual([]);
    expect(state.controller.renderScale).toBe(1);
  });

  it("walks the resolution ladder all the way down before suggesting a lower tier", () => {
    const state = harness("high");
    // 30 ms against a 16.7 ms budget is 180%, far past the 120% trigger.
    run(state, 30, 45000);

    expect(scales(state.decisions)).toEqual([0.95, 0.9, 0.85, 0.8, 0.75]);
    expect(state.controller.renderScale).toBe(0.75);

    const firstTierAt = state.decisions.find((decision) => decision.kind === "tier")?.atMs;
    const lastScaleAt = state.decisions.filter((decision) => decision.kind === "scale").at(-1)?.atMs;
    expect(firstTierAt).toBeDefined();
    expect(firstTierAt as number).toBeGreaterThan(lastScaleAt as number);
    expect(tiers(state.decisions).every((direction) => direction === "lower")).toBe(true);
  });

  it("gives resolution back before suggesting a higher tier", () => {
    const state = harness("high");
    run(state, 30, 14000);
    const lowered = state.controller.renderScale;
    expect(lowered).toBeLessThan(1);

    const before = state.decisions.length;
    // 8 ms is under 70% of the 16.7 ms budget, so the controller starts giving back.
    run(state, 8, 60000);

    const recovery = state.decisions.slice(before);
    const climb = scales(recovery);
    expect(climb[0]).toBeCloseTo(lowered + 0.05, 10);
    for (let i = 1; i < climb.length; i += 1) {
      expect(climb[i]).toBeGreaterThan(climb[i - 1] as number);
    }
    expect(state.controller.renderScale).toBe(1);

    const firstTierAt = recovery.find((decision) => decision.kind === "tier")?.atMs;
    expect(firstTierAt as number).toBeGreaterThan(recovery.filter((d) => d.kind === "scale").at(-1)?.atMs as number);
    expect(tiers(recovery).every((direction) => direction === "raise")).toBe(true);
  });

  it("keeps at least the cooldown between any two decisions", () => {
    const state = harness("high");
    run(state, 30, 45000);

    expect(state.decisions.length).toBeGreaterThan(2);
    for (let i = 1; i < state.decisions.length; i += 1) {
      const gap = (state.decisions[i] as Decision).atMs - (state.decisions[i - 1] as Decision).atMs;
      expect(gap).toBeGreaterThanOrEqual(5000);
    }
  });

  it("requires the slow window to be sustained, so one long frame changes nothing", () => {
    const state = harness("high");
    run(state, 14, 3000);
    state.now += 200;
    state.controller.update(state.now, 200);
    run(state, 14, 20000);

    expect(state.decisions).toEqual([]);
  });

  it("discards stall-length frames instead of treating them as workload", () => {
    const state = harness("high");
    // A backgrounded tab reporting half a second per frame is not a measurement,
    // and 20 s of it must not demote anything.
    run(state, 500, 20000);

    expect(state.decisions).toEqual([]);
    expect(state.controller.smoothedFrameMs).toBeNull();
  });

  it("stops deciding anything while quality is locked", () => {
    const onRenderScale = vi.fn();
    const onTierSuggestion = vi.fn();
    const controller = new AdaptiveQuality(qualitySettingsFor("high"), { onRenderScale, onTierSuggestion });
    controller.setLocked(true);

    for (let now = 30; now <= 45000; now += 30) {
      controller.update(now, 30);
    }

    expect(onRenderScale).not.toHaveBeenCalled();
    expect(onTierSuggestion).not.toHaveBeenCalled();
    expect(controller.renderScale).toBe(1);
    expect(controller.isLocked).toBe(true);
  });

  it("resets to the top of the new range and waits out a cooldown on a tier change", () => {
    const state = harness("high");
    run(state, 30, 14000);
    expect(state.controller.renderScale).toBeLessThan(1);

    state.controller.applyQuality(qualitySettingsFor("medium"), state.now);
    expect(state.controller.renderScale).toBe(0.9);
    expect(state.controller.smoothedFrameMs).toBeNull();

    const before = state.decisions.length;
    // 30 ms is over the medium budget too, but the cooldown has to expire first.
    const cooldownEnd = state.now + 5000;
    run(state, 30, cooldownEnd - 100);
    expect(state.decisions.length).toBe(before);

    run(state, 30, cooldownEnd + 2000);
    expect(state.decisions.length).toBe(before + 1);
  });

  it("discards measurement history on an explicit reset", () => {
    const state = harness("high");
    run(state, 30, 900);
    state.controller.reset();
    expect(state.controller.smoothedFrameMs).toBeNull();

    // The sustain window restarts from zero, so the pending downgrade is gone.
    run(state, 30, 1500);
    expect(state.decisions).toEqual([]);
  });
});
