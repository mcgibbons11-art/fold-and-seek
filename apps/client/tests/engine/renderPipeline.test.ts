import type * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { PIPELINE_EFFECTS, RenderPipeline } from "../../src/rendering/RenderPipeline";
import { qualitySettingsFor } from "../../src/rendering/quality";

/**
 * Effect resolution and the direct-render decision are pure bookkeeping, so
 * they are exercised without a graphics device. Building the node graph needs a
 * real backend and is covered by the in-browser verification instead.
 */
function pipelineFor(tier: Parameters<typeof qualitySettingsFor>[0]): RenderPipeline {
  return new RenderPipeline({} as THREE.WebGPURenderer, qualitySettingsFor(tier));
}

describe("RenderPipeline effect resolution", () => {
  it("takes its defaults from the tier", () => {
    const ultra = pipelineFor("ultra");
    expect(ultra.isEnabled("gtao")).toBe(true);
    expect(ultra.isEnabled("bloom")).toBe(true);

    const light = pipelineFor("light");
    expect(light.isEnabled("gtao")).toBe(false);
    expect(light.isEnabled("bloom")).toBe(false);
  });

  it("lets each effect be overridden on its own", () => {
    const pipeline = pipelineFor("ultra");
    pipeline.setEffectEnabled("bloom", false);

    expect(pipeline.isEnabled("bloom")).toBe(false);
    expect(pipeline.isEnabled("gtao")).toBe(true);
  });

  it("turns an effect on for a tier that does not ship it", () => {
    const pipeline = pipelineFor("low");
    pipeline.setEffectEnabled("bloom", true);

    expect(pipeline.isEnabled("bloom")).toBe(true);
    expect(pipeline.isEnabled("gtao")).toBe(false);
  });

  it("drops overrides on a tier change so the new tier defines the baseline", () => {
    const pipeline = pipelineFor("ultra");
    for (const effect of PIPELINE_EFFECTS) {
      pipeline.setEffectEnabled(effect, false);
    }
    pipeline.applyQuality(qualitySettingsFor("high"));

    for (const effect of PIPELINE_EFFECTS) {
      expect(pipeline.isEnabled(effect), effect).toBe(true);
    }
  });

  it("reports no active effects until a scene has been rendered through it", () => {
    // activeEffects describes the graph that exists, not the graph that would
    // be built, so an unbound pipeline is honestly empty.
    expect(pipelineFor("ultra").activeEffects).toEqual([]);
    expect(pipelineFor("ultra").isActive).toBe(false);
  });

  it("disposes cleanly before it ever built a graph", () => {
    const pipeline = pipelineFor("ultra");
    expect(() => {
      pipeline.dispose();
    }).not.toThrow();
  });
});
