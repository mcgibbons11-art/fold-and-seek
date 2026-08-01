import { describe, expect, it } from "vitest";

import { FIXED_STEP, MAX_FRAME_DELTA, MAX_STEPS_PER_FRAME } from "../../src/engine/GameHost";
import {
  isQualityTier,
  QUALITY_PRESETS,
  QUALITY_TIER_ORDER,
  qualitySettingsFor,
  type QualitySettings,
} from "../../src/rendering/quality";

/** Every key the renderer, the world, and the adaptive controller read. */
const REQUIRED_KEYS: readonly (keyof QualitySettings)[] = [
  "tier",
  "frameBudgetMs",
  "pixelRatioCap",
  "minRenderScale",
  "maxRenderScale",
  "shadowMapSize",
  "shadowedLocalLights",
  "dynamicShadows",
  "contactShadows",
  "gtao",
  "ssgi",
  "ssr",
  "temporalAA",
  "smaa",
  "fxaa",
  "bloom",
  "volumetrics",
  "motionBlurReveal",
  "maxAnisotropy",
  "textureLodBias",
  "clutterDensity",
  "particleScale",
];

describe("qualitySettingsFor", () => {
  it("returns a complete, self-identifying preset for every tier", () => {
    for (const tier of QUALITY_TIER_ORDER) {
      const settings = qualitySettingsFor(tier);
      expect(settings.tier).toBe(tier);
      for (const key of REQUIRED_KEYS) {
        expect(settings[key], `${tier}.${key}`).toBeDefined();
      }
    }
  });

  it("covers exactly the declared tier order with no extra presets", () => {
    expect(Object.keys(QUALITY_PRESETS).sort()).toEqual([...QUALITY_TIER_ORDER].sort());
  });

  it("keeps a usable render-scale window inside the pixel-ratio cap on every tier", () => {
    for (const tier of QUALITY_TIER_ORDER) {
      const settings = qualitySettingsFor(tier);
      expect(settings.minRenderScale, tier).toBeGreaterThan(0);
      expect(settings.minRenderScale, tier).toBeLessThanOrEqual(settings.maxRenderScale);
      expect(settings.maxRenderScale, tier).toBeLessThanOrEqual(1);
      expect(settings.pixelRatioCap, tier).toBeGreaterThan(0);
    }
  });

  it("relaxes the frame budget monotonically as the tier drops", () => {
    // QUALITY_TIER_ORDER runs weakest to strongest, so budgets must not increase
    // along it: a weaker tier is allowed more milliseconds, never fewer.
    const budgets = QUALITY_TIER_ORDER.map((tier) => qualitySettingsFor(tier).frameBudgetMs);
    for (let i = 1; i < budgets.length; i += 1) {
      expect(budgets[i], QUALITY_TIER_ORDER[i]).toBeLessThanOrEqual(budgets[i - 1] as number);
    }
    expect(budgets[budgets.length - 1]).toBeGreaterThan(0);
  });

  it("tightens the visual budget monotonically as the tier drops", () => {
    let previousShadow = 0;
    let previousAnisotropy = 0;
    let previousClutter = 0;
    for (const tier of QUALITY_TIER_ORDER) {
      const settings = qualitySettingsFor(tier);
      expect(settings.shadowMapSize, tier).toBeGreaterThanOrEqual(previousShadow);
      expect(settings.maxAnisotropy, tier).toBeGreaterThanOrEqual(previousAnisotropy);
      expect(settings.clutterDensity, tier).toBeGreaterThanOrEqual(previousClutter);
      previousShadow = settings.shadowMapSize;
      previousAnisotropy = settings.maxAnisotropy;
      previousClutter = settings.clutterDensity;
    }
  });

  it("recognizes every tier name and rejects anything else", () => {
    for (const tier of QUALITY_TIER_ORDER) {
      expect(isQualityTier(tier)).toBe(true);
    }
    expect(isQualityTier("extreme")).toBe(false);
    expect(isQualityTier("toString")).toBe(false);
  });
});

describe("fixed-step accumulator budget", () => {
  it("clamps a frame to exactly the work the step cap can absorb", () => {
    expect(MAX_FRAME_DELTA).toBeCloseTo(FIXED_STEP * MAX_STEPS_PER_FRAME, 12);
  });

  it("never leaves a backlog after a clamped frame, so no simulated time is dropped", () => {
    let accumulator = 0;
    let steps = 0;
    accumulator += MAX_FRAME_DELTA;
    while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      accumulator -= FIXED_STEP;
      steps += 1;
    }

    expect(steps).toBe(MAX_STEPS_PER_FRAME);
    expect(accumulator).toBeLessThan(FIXED_STEP);
  });

  it("drains a carried remainder within the step cap", () => {
    // Worst case: a full clamped frame arriving on top of an almost-full
    // accumulator still has to fit, or the loop sheds time every long frame.
    let accumulator = FIXED_STEP * 0.999 + MAX_FRAME_DELTA;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      accumulator -= FIXED_STEP;
      steps += 1;
    }

    expect(steps).toBe(MAX_STEPS_PER_FRAME);
    expect(accumulator).toBeLessThan(FIXED_STEP);
  });
});
