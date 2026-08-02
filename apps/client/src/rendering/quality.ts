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
 * The tier one rung along `QUALITY_TIER_ORDER`, or null when there is none.
 *
 * `ceilingIndex` is the highest tier an automatic change may reach, which is
 * what closes a tier off for the rest of a session. The adaptive controller
 * reads frame time, and a tier whose shader programs the driver refused to link
 * is a *fast* tier, because it draws nothing, so without a ceiling a session
 * pulled out of a compile failure climbs straight back into it.
 */
export function stepQualityTier(
  from: QualityTier,
  direction: "raise" | "lower",
  ceilingIndex: number = QUALITY_TIER_ORDER.length - 1,
): QualityTier | null {
  const index = QUALITY_TIER_ORDER.indexOf(from) + (direction === "raise" ? 1 : -1);
  if (index > ceilingIndex) {
    return null;
  }
  return QUALITY_TIER_ORDER[index] ?? null;
}

/**
 * Live point lights a backend may run, whatever the tier asks for. Both tables
 * are ceilings rather than replacements, so a tier that already asks for less
 * still gets less, and the lamps a map cannot afford to light do not vanish:
 * `ShopLighting` draws them as emissive fixtures over their own light pools.
 *
 * **WebGPU is a frame-rate ceiling.** Three shades every punctual light in a
 * loop per fragment, and its WebGPU node-material path is far weaker at it than
 * the WebGL 2 renderer: measured on a frozen production build, the shop ran
 * 5.4 fps at the high tier on WebGPU against roughly 21 on WebGL 2 with the same
 * seventeen lamps, GPU-bound with no CPU stall.
 *
 * **WebGL 2 is a program-size ceiling**, which is a different problem with the
 * same lever. On an Intel integrated GPU a frozen build lost the graphics device
 * in about half of all rounds, and the log leading into every loss is the same:
 * roughly ten `Shader Error 1282 VALIDATE_STATUS false` link failures whose
 * driver info logs are *empty*, then `uniformBlockBinding: program not linked`,
 * then the context dies. An empty log on a failed link is what a driver reports
 * when a program runs past a resource limit rather than when its GLSL is wrong,
 * and the light loop is unrolled, so every live point light is another inlined
 * block of lighting code in the fragment program. At the medium tier the shop
 * was compiling seventeen of them plus two fill directionals, a hemisphere and a
 * shadowed spot.
 *
 * These numbers are a hypothesis, not a measured driver limit. Forcing the light
 * tier let a round survive where medium died, but that moves the light count,
 * shadows, bloom, GTAO and render scale together, so it isolates nothing. The
 * safety net is `ShaderFailurePolicy`, which demotes the tier on the first link
 * failure rather than waiting for the context to die; re-running the lead's A/B
 * against this table is what would turn the guess into a measurement.
 */
const PRACTICAL_CEILING: Readonly<Record<RenderBackend, Readonly<Record<QualityTier, number>>>> = {
  webgpu: {
    ultra: 6,
    high: 6,
    medium: 5,
    low: 4,
    light: 3,
  },
  webgl2: {
    ultra: 10,
    high: 9,
    medium: 7,
    low: 6,
    light: 4,
  },
};

/**
 * Capped settings are memoised so one tier on one backend is always the same
 * object. Callers compare settings by identity to decide whether a change is
 * worth re-applying down the whole world, so the key has to carry the backend:
 * the two tables cap the same tier to different budgets.
 */
const cappedSettings = new Map<string, QualitySettings>();

export function qualitySettingsFor(tier: QualityTier, backend: RenderBackend = "webgl2"): QualitySettings {
  const preset = QUALITY_PRESETS[tier];
  const ceiling = Math.min(preset.maxPracticalLights, PRACTICAL_CEILING[backend][tier]);
  if (ceiling === preset.maxPracticalLights) {
    return preset;
  }
  const key = `${backend}:${tier}`;
  const existing = cappedSettings.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const capped: QualitySettings = { ...preset, maxPracticalLights: ceiling };
  cappedSettings.set(key, capped);
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
