import type { RenderBackend } from "./RendererManager";

export type QualityTier = "ultra" | "high" | "medium" | "low" | "light";

/** Ordered weakest to strongest so the boot heuristic can step by index. */
export const QUALITY_TIER_ORDER: readonly QualityTier[] = ["light", "low", "medium", "high", "ultra"];

export interface QualitySettings {
  readonly tier: QualityTier;
  /** Bible §18.16 frame budget for the tier. The adaptive controller measures against it. */
  readonly frameBudgetMs: number;
  readonly pixelRatioCap: number;
  readonly minRenderScale: number;
  readonly maxRenderScale: number;
  readonly shadowMapSize: number;
  readonly shadowedLocalLights: number;
  readonly dynamicShadows: boolean;
  /** Post effects are limited to what RenderPipeline composes. A new effect earns
   * its field here only once the pipeline actually reads it. */
  readonly gtao: boolean;
  readonly bloom: boolean;
  readonly maxAnisotropy: number;
  readonly clutterDensity: number;
  /**
   * Live point lights a map may run. A map that authors more fixtures than
   * this shows the rest as emissive geometry over its own light pools, so the
   * room keeps its lamps without paying for them (see `world/maps/lighting.ts`).
   */
  readonly maxPracticalLights: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityTier, QualitySettings>> = {
  ultra: {
    tier: "ultra",
    frameBudgetMs: 16.7,
    pixelRatioCap: 2,
    minRenderScale: 0.85,
    maxRenderScale: 1,
    shadowMapSize: 2048,
    shadowedLocalLights: 3,
    dynamicShadows: true,
    gtao: true,
    bloom: true,
    maxAnisotropy: 16,
    clutterDensity: 1,
    maxPracticalLights: 20,
  },
  high: {
    tier: "high",
    frameBudgetMs: 16.7,
    pixelRatioCap: 2,
    minRenderScale: 0.75,
    maxRenderScale: 1,
    shadowMapSize: 2048,
    shadowedLocalLights: 2,
    dynamicShadows: true,
    gtao: true,
    bloom: true,
    maxAnisotropy: 8,
    clutterDensity: 0.85,
    maxPracticalLights: 17,
  },
  medium: {
    tier: "medium",
    frameBudgetMs: 22,
    pixelRatioCap: 1.5,
    minRenderScale: 0.65,
    maxRenderScale: 0.9,
    shadowMapSize: 1024,
    shadowedLocalLights: 1,
    dynamicShadows: true,
    gtao: true,
    bloom: true,
    maxAnisotropy: 4,
    clutterDensity: 0.6,
    maxPracticalLights: 10,
  },
  low: {
    tier: "low",
    frameBudgetMs: 27,
    pixelRatioCap: 1.25,
    minRenderScale: 0.5,
    maxRenderScale: 0.8,
    shadowMapSize: 1024,
    shadowedLocalLights: 0,
    dynamicShadows: true,
    gtao: false,
    bloom: false,
    maxAnisotropy: 2,
    clutterDensity: 0.4,
    maxPracticalLights: 7,
  },
  light: {
    tier: "light",
    frameBudgetMs: 33,
    pixelRatioCap: 1,
    minRenderScale: 0.5,
    maxRenderScale: 0.75,
    shadowMapSize: 512,
    shadowedLocalLights: 0,
    dynamicShadows: false,
    gtao: false,
    bloom: false,
    maxAnisotropy: 1,
    clutterDensity: 0.25,
    maxPracticalLights: 5,
  },
};

export function isQualityTier(value: string): value is QualityTier {
  return Object.prototype.hasOwnProperty.call(QUALITY_PRESETS, value);
}

/**
 * Live point lights the WebGPU path may run, whatever the tier asks for.
 *
 * Three shades every punctual light in a loop per fragment, and its WebGPU
 * node-material path is far weaker at it than the WebGL 2 renderer: measured on
 * a frozen production build, the shop ran 5.4 fps at the high tier on WebGPU
 * against roughly 21 on WebGL 2 with the same seventeen lamps, GPU-bound with
 * no CPU stall. Cutting the live count is the one lever that moved it.
 *
 * This is a ceiling rather than a replacement, so a tier that already asks for
 * less still gets less. The lamps a map cannot afford to light do not vanish;
 * `ShopLighting` draws them as emissive fixtures over their own light pools.
 */
const WEBGPU_PRACTICAL_CEILING: Readonly<Record<QualityTier, number>> = {
  ultra: 6,
  high: 6,
  medium: 5,
  low: 4,
  light: 3,
};

/**
 * Capped settings are memoised so one tier on one backend is always the same
 * object. Callers compare settings by identity to decide whether a change is
 * worth re-applying down the whole world.
 */
const cappedSettings = new Map<QualityTier, QualitySettings>();

export function qualitySettingsFor(tier: QualityTier, backend: RenderBackend = "webgl2"): QualitySettings {
  const preset = QUALITY_PRESETS[tier];
  if (backend !== "webgpu") {
    return preset;
  }
  const ceiling = Math.min(preset.maxPracticalLights, WEBGPU_PRACTICAL_CEILING[tier]);
  if (ceiling === preset.maxPracticalLights) {
    return preset;
  }
  const existing = cappedSettings.get(tier);
  if (existing !== undefined) {
    return existing;
  }
  const capped: QualitySettings = { ...preset, maxPracticalLights: ceiling };
  cappedSettings.set(tier, capped);
  return capped;
}

const PROBE_WARMUP_FRAMES = 24;
const PROBE_DURATION_MS = 1500;
const PROBE_MAX_SAMPLES = 320;
const PROBE_OUTLIER_MS = 250;

/**
 * Rolling frame-time collector used once during boot. Sampling starts only
 * after a warm-up window so shader compilation and first-frame upload cost do
 * not poison the measurement.
 */
export class FrameTimeProbe {
  private readonly samples = new Float64Array(PROBE_MAX_SAMPLES);
  private sampleCount = 0;
  private warmupFrames = 0;
  private startMs = 0;
  private lastMs = 0;
  private finished = false;
  private median: number | null = null;

  record(nowMs: number): void {
    if (this.finished) {
      return;
    }
    if (this.warmupFrames < PROBE_WARMUP_FRAMES) {
      this.warmupFrames += 1;
      this.lastMs = nowMs;
      this.startMs = nowMs;
      return;
    }

    const delta = nowMs - this.lastMs;
    this.lastMs = nowMs;
    if (delta > 0 && delta < PROBE_OUTLIER_MS && this.sampleCount < PROBE_MAX_SAMPLES) {
      this.samples[this.sampleCount] = delta;
      this.sampleCount += 1;
    }

    if (nowMs - this.startMs >= PROBE_DURATION_MS || this.sampleCount >= PROBE_MAX_SAMPLES) {
      this.finished = true;
    }
  }

  get complete(): boolean {
    return this.finished;
  }

  get medianFrameMs(): number | null {
    if (!this.finished || this.sampleCount === 0) {
      return null;
    }
    if (this.median === null) {
      const sorted = Array.from(this.samples.subarray(0, this.sampleCount)).sort((a, b) => a - b);
      this.median = sorted[sorted.length >> 1] ?? null;
    }
    return this.median;
  }

  reset(): void {
    this.sampleCount = 0;
    this.warmupFrames = 0;
    this.finished = false;
    this.median = null;
  }
}

interface NavigatorWithDeviceMemory extends Navigator {
  readonly deviceMemory?: number;
}

function deviceMemoryGb(): number | null {
  const memory = (navigator as NavigatorWithDeviceMemory).deviceMemory;
  return typeof memory === "number" && memory > 0 ? memory : null;
}

/**
 * Boot heuristic: start from the backend, nudge by coarse device capability,
 * then demote on measured frame time. Frame time never promotes a tier because
 * the probe renders under vsync, so a strong GPU and an adequate one both
 * report roughly the display interval.
 */
export function pickDefaultTier(backend: RenderBackend, medianFrameMs: number | null): QualityTier {
  let index = QUALITY_TIER_ORDER.indexOf(backend === "webgpu" ? "high" : "medium");

  const cores = navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4;
  const memory = deviceMemoryGb();

  if (backend === "webgpu" && cores >= 8 && (memory === null || memory >= 8)) {
    index += 1;
  }
  if (cores <= 2 || (memory !== null && memory <= 2)) {
    index -= 1;
  }

  if (medianFrameMs !== null) {
    if (medianFrameMs > 28) {
      index -= 2;
    } else if (medianFrameMs > 19) {
      index -= 1;
    }
  }

  const clamped = Math.min(Math.max(index, 0), QUALITY_TIER_ORDER.length - 1);
  return QUALITY_TIER_ORDER[clamped] ?? "medium";
}
