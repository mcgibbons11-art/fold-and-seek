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

export type CameraSampleInsertion = "accepted" | "reordered" | "duplicate" | "stale";

export interface BufferedCameraFrame {
  readonly sample: CameraSample;
  readonly mode: "held" | "interpolated" | "extrapolated" | "stale";
}

const PRESENTATION_DELAY_MS = 50;
const MAX_EXTRAPOLATION_MS = 100;
const MAX_BUFFERED_SAMPLES = 24;

/**
 * Small timestamp-ordered jitter buffer for remote camera presentation.
 *
 * The relay is allowed to jitter, duplicate, and reorder packets. Keeping a
 * short presentation delay lets a late neighbour land in its proper place
 * instead of yanking the remote body back toward arrival order. A single lost
 * packet is bridged by bounded extrapolation; a longer outage holds the last
 * authoritative pose rather than allowing an avatar to run away forever.
 */
export class CameraSampleInterpolationBuffer {
  private readonly samples: CameraSample[] = [];
  private playheadMs: number | null = null;

  get size(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples.length = 0;
    this.playheadMs = null;
  }

  push(sample: CameraSample): CameraSampleInsertion {
    const duplicate = this.samples.findIndex((entry) => entry.atMs === sample.atMs);
    if (duplicate >= 0) return "duplicate";

    const last = this.samples.at(-1);
    if (
      this.playheadMs !== null &&
      last !== undefined &&
      sample.atMs < this.playheadMs - MAX_EXTRAPOLATION_MS &&
      sample.atMs < last.atMs
    ) {
      return "stale";
    }
    // After a genuine sender pause, the local playhead can be far ahead of the
    // next new timestamp. Re-anchor once to that forward sample; otherwise all
    // future recovery packets would be mistaken for stale history.
    if (
      this.playheadMs !== null &&
      last !== undefined &&
      sample.atMs > last.atMs &&
      sample.atMs < this.playheadMs - MAX_EXTRAPOLATION_MS
    ) {
      this.playheadMs = sample.atMs - PRESENTATION_DELAY_MS;
    }
    const reordered = last !== undefined && sample.atMs < last.atMs;
    const index = this.samples.findIndex((entry) => entry.atMs > sample.atMs);
    if (index < 0) this.samples.push(sample);
    else this.samples.splice(index, 0, sample);

    if (this.playheadMs === null) {
      this.playheadMs = sample.atMs - PRESENTATION_DELAY_MS;
    }
    if (this.samples.length > MAX_BUFFERED_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_BUFFERED_SAMPLES);
    }
    return reordered ? "reordered" : "accepted";
  }

  advance(dtMs: number): BufferedCameraFrame | null {
    if (this.playheadMs === null || this.samples.length === 0) return null;
    this.playheadMs += Math.max(0, dtMs);
    this.pruneConsumedHistory();

    const first = this.samples[0];
    if (first === undefined) return null;
    if (this.playheadMs <= first.atMs) {
      return { sample: first, mode: "held" };
    }

    for (let index = 1; index < this.samples.length; index += 1) {
      const right = this.samples[index];
      const left = this.samples[index - 1];
      if (left === undefined || right === undefined || this.playheadMs > right.atMs) continue;
      const span = Math.max(1, right.atMs - left.atMs);
      return {
        sample: interpolateCameraSample(left, right, (this.playheadMs - left.atMs) / span),
        mode: "interpolated",
      };
    }

    const last = this.samples.at(-1);
    if (last === undefined) return null;
    const previous = this.samples.at(-2);
    const aheadMs = this.playheadMs - last.atMs;
    if (previous !== undefined && aheadMs <= MAX_EXTRAPOLATION_MS) {
      const span = Math.max(1, last.atMs - previous.atMs);
      return {
        sample: interpolateCameraSample(previous, last, 1 + aheadMs / span),
        mode: "extrapolated",
      };
    }
    if (previous !== undefined) {
      const span = Math.max(1, last.atMs - previous.atMs);
      return {
        sample: interpolateCameraSample(
          previous,
          last,
          1 + MAX_EXTRAPOLATION_MS / span,
        ),
        mode: "stale",
      };
    }
    return { sample: last, mode: "stale" };
  }

  private pruneConsumedHistory(): void {
    // Retain one sample behind the playhead: it is the left endpoint for both
    // interpolation and bounded extrapolation.
    const playheadMs = this.playheadMs;
    if (playheadMs === null) return;
    while (this.samples.length > 2 && (this.samples[1]?.atMs ?? Infinity) < playheadMs) {
      this.samples.shift();
    }
  }
}

function interpolateCameraSample(
  left: CameraSample,
  right: CameraSample,
  alpha: number,
): CameraSample {
  const angle = (from: number, to: number): number =>
    from + Math.atan2(Math.sin(to - from), Math.cos(to - from)) * alpha;
  return {
    atMs: left.atMs + (right.atMs - left.atMs) * alpha,
    x: left.x + (right.x - left.x) * alpha,
    y: left.y + (right.y - left.y) * alpha,
    z: left.z + (right.z - left.z) * alpha,
    yaw: angle(left.yaw, right.yaw),
    pitch: angle(left.pitch, right.pitch),
    airborne: alpha < 1 ? left.airborne : right.airborne,
    climbing: alpha < 1 ? left.climbing : right.climbing,
  };
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
