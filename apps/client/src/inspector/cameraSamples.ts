/**
 * Throttled camera telemetry. §6.4 scores gaze, and §9 shows an Inspector focus
 * cone to spectators, both of which need where the Inspector was looking rather
 * than a per-frame stream. `cameraSampleHz` from the match settings sets the
 * rate, which is an order of magnitude below the frame rate.
 */

export interface CameraSample {
  readonly atMs: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly airborne: boolean;
  readonly climbing: boolean;
}

/** A stall longer than this many intervals is dropped rather than burst-sent. */
const MAX_CATCH_UP_INTERVALS = 2;

export class CameraSamplePublisher {
  private readonly intervalMs: number;
  private readonly publish: (sample: CameraSample) => void;
  private accumulatorMs = 0;

  constructor(hz: number, publish: (sample: CameraSample) => void) {
    this.intervalMs = hz > 0 ? 1000 / hz : Number.POSITIVE_INFINITY;
    this.publish = publish;
  }

  reset(): void {
    this.accumulatorMs = 0;
  }

  update(
    dtMs: number,
    atMs: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    airborne: boolean,
    climbing: boolean,
  ): void {
    if (!Number.isFinite(this.intervalMs)) return;
    this.accumulatorMs += dtMs;
    if (this.accumulatorMs < this.intervalMs) return;
    if (this.accumulatorMs > this.intervalMs * MAX_CATCH_UP_INTERVALS) {
      this.accumulatorMs = 0;
    } else {
      this.accumulatorMs -= this.intervalMs;
    }
    this.publish({ atMs, x, y, z, yaw, pitch, airborne, climbing });
  }
}
