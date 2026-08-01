import type { QualitySettings } from "./quality";

export type TierDirection = "raise" | "lower";

export interface AdaptiveQualityCallbacks {
  /** Fired with the new internal render scale, already clamped to the tier range. */
  readonly onRenderScale?: (scale: number) => void;
  /** Fired when the resolution ladder is exhausted and only a tier move is left. */
  readonly onTierSuggestion?: (direction: TierDirection) => void;
}

/** Weight of a single frame in the running average, giving a ~10 frame time constant. */
const SMOOTHING = 0.1;
/** Sustained fraction of the budget below which the controller starts giving quality back. */
const RAISE_BUDGET_FRACTION = 0.7;
/** Sustained fraction of the budget above which the controller starts taking quality away. */
const LOWER_BUDGET_FRACTION = 1.2;
const RAISE_SUSTAIN_MS = 3000;
const LOWER_SUSTAIN_MS = 1000;
/** No two changes inside this window, which is what keeps the ladder from ringing. */
const CHANGE_COOLDOWN_MS = 5000;
const SCALE_STEP = 0.05;
/**
 * A frame this long is a stall (tab switch, shader compile, garbage collection),
 * not a workload measurement, and feeding it to the average would trigger a
 * downgrade for something that will never recur.
 */
const STALL_SAMPLE_MS = 250;

function roundScale(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Dynamic resolution and tier controller, Bible §18.14 and §22.6.
 *
 * Frame time is exponentially smoothed and compared against the tier's budget
 * with separate thresholds and dwell times in each direction, so a brief spike
 * cannot trigger a downgrade and a brief lull cannot trigger an upgrade. Render
 * scale always moves first: the controller only suggests a tier change once the
 * resolution ladder is at the end of its range. Every accepted change arms a
 * cooldown and discards the smoothed history, because the change itself
 * invalidates the measurement that produced it.
 *
 * The raise path is what recovers a session that was demoted at boot by a
 * transient competing GPU load: once frames settle under 70% of the budget the
 * controller climbs the scale back to the tier maximum and then suggests the
 * tier the boot probe took away.
 */
export class AdaptiveQuality {
  private readonly callbacks: AdaptiveQualityCallbacks;

  private settings: QualitySettings;
  private scale: number;
  private smoothedMs: number | null = null;
  private fastSinceMs: number | null = null;
  private slowSinceMs: number | null = null;
  private cooldownUntilMs = 0;
  private locked = false;

  constructor(settings: QualitySettings, callbacks: AdaptiveQualityCallbacks = {}) {
    this.settings = settings;
    this.callbacks = callbacks;
    this.scale = settings.maxRenderScale;
  }

  get renderScale(): number {
    return this.scale;
  }

  get smoothedFrameMs(): number | null {
    return this.smoothedMs;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Manual quality selection: stop measuring and stop suggesting. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) {
      this.clearHistory();
    }
  }

  /**
   * A tier change resets the ladder to the top of the new range and starts a
   * cooldown, so the controller measures the new tier before judging it.
   */
  applyQuality(settings: QualitySettings, nowMs = 0): void {
    this.settings = settings;
    this.scale = settings.maxRenderScale;
    this.clearHistory();
    this.cooldownUntilMs = nowMs + CHANGE_COOLDOWN_MS;
  }

  /** Discards measurement history after an event that invalidates it (tab resume, teleport). */
  reset(): void {
    this.clearHistory();
  }

  update(nowMs: number, frameMs: number): void {
    if (this.locked || frameMs <= 0) {
      return;
    }
    if (frameMs >= STALL_SAMPLE_MS) {
      this.clearHistory();
      return;
    }

    this.smoothedMs = this.smoothedMs === null ? frameMs : this.smoothedMs + (frameMs - this.smoothedMs) * SMOOTHING;

    if (nowMs < this.cooldownUntilMs) {
      this.fastSinceMs = null;
      this.slowSinceMs = null;
      return;
    }

    const budget = this.settings.frameBudgetMs;
    if (this.smoothedMs > budget * LOWER_BUDGET_FRACTION) {
      this.fastSinceMs = null;
      this.slowSinceMs ??= nowMs;
      if (nowMs - this.slowSinceMs >= LOWER_SUSTAIN_MS) {
        this.step(-SCALE_STEP, "lower", nowMs);
      }
      return;
    }

    if (this.smoothedMs < budget * RAISE_BUDGET_FRACTION) {
      this.slowSinceMs = null;
      this.fastSinceMs ??= nowMs;
      if (nowMs - this.fastSinceMs >= RAISE_SUSTAIN_MS) {
        this.step(SCALE_STEP, "raise", nowMs);
      }
      return;
    }

    this.fastSinceMs = null;
    this.slowSinceMs = null;
  }

  private step(delta: number, direction: TierDirection, nowMs: number): void {
    const limit = delta < 0 ? this.settings.minRenderScale : this.settings.maxRenderScale;
    const next = roundScale(delta < 0 ? Math.max(this.scale + delta, limit) : Math.min(this.scale + delta, limit));

    if (next !== this.scale) {
      this.scale = next;
      this.callbacks.onRenderScale?.(next);
    } else {
      this.callbacks.onTierSuggestion?.(direction);
    }

    this.clearHistory();
    this.cooldownUntilMs = nowMs + CHANGE_COOLDOWN_MS;
  }

  private clearHistory(): void {
    this.smoothedMs = null;
    this.fastSinceMs = null;
    this.slowSinceMs = null;
  }
}
