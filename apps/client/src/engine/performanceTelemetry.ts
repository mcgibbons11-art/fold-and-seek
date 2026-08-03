export interface PerformanceDiagnosticsSnapshot {
  readonly frames: number;
  readonly averageFrameMs: number;
  readonly maxFrameMs: number;
  readonly longFrames: number;
  readonly clampedFrames: number;
  readonly simulationBacklogDrops: number;
  readonly remoteSamplesAccepted: number;
  readonly remoteSamplesReordered: number;
  readonly remoteSamplesDuplicate: number;
  readonly remoteSamplesStale: number;
  readonly remoteInterpolationUnderflows: number;
  readonly remoteExtrapolations: number;
  readonly remoteStaleHolds: number;
  readonly paintFlushes: number;
  readonly paintUploadRegions: number;
  readonly paintUploadPixels: number;
  readonly paintFlushCpuMs: number;
  readonly paintRebuilds: number;
}

export interface PaintPerformanceSample {
  readonly flushes: number;
  readonly rectangles: number;
  readonly pixels: number;
  readonly flushCpuMs: number;
  readonly rebuilds: number;
}

/** Allocation-free counters shared by the frame host and presentation layers. */
export class PerformanceTelemetry {
  private frames = 0;
  private frameMsTotal = 0;
  private maxFrameMs = 0;
  private longFrames = 0;
  private clampedFrames = 0;
  private simulationBacklogDrops = 0;
  private remoteSamplesAccepted = 0;
  private remoteSamplesReordered = 0;
  private remoteSamplesDuplicate = 0;
  private remoteSamplesStale = 0;
  private remoteInterpolationUnderflows = 0;
  private remoteExtrapolations = 0;
  private remoteStaleHolds = 0;
  private paintFlushes = 0;
  private paintUploadRegions = 0;
  private paintUploadPixels = 0;
  private paintFlushCpuMs = 0;
  private paintRebuilds = 0;

  recordFrame(frameMs: number, clampThresholdMs: number): void {
    if (!Number.isFinite(frameMs) || frameMs < 0) return;
    this.frames += 1;
    this.frameMsTotal += frameMs;
    this.maxFrameMs = Math.max(this.maxFrameMs, frameMs);
    if (frameMs > 1000 / 30) this.longFrames += 1;
    if (frameMs > clampThresholdMs) this.clampedFrames += 1;
  }

  recordSimulationBacklogDrop(): void {
    this.simulationBacklogDrops += 1;
  }

  recordRemoteInsertion(result: "accepted" | "reordered" | "duplicate" | "stale"): void {
    if (result === "accepted") this.remoteSamplesAccepted += 1;
    else if (result === "reordered") this.remoteSamplesReordered += 1;
    else if (result === "duplicate") this.remoteSamplesDuplicate += 1;
    else this.remoteSamplesStale += 1;
  }

  recordRemotePresentation(mode: "held" | "interpolated" | "extrapolated" | "stale"): void {
    if (mode === "held") this.remoteInterpolationUnderflows += 1;
    else if (mode === "extrapolated") this.remoteExtrapolations += 1;
    else if (mode === "stale") this.remoteStaleHolds += 1;
  }

  recordPaint(sample: PaintPerformanceSample): void {
    this.paintFlushes = sample.flushes;
    this.paintUploadRegions = sample.rectangles;
    this.paintUploadPixels = sample.pixels;
    this.paintFlushCpuMs = sample.flushCpuMs;
    this.paintRebuilds = sample.rebuilds;
  }

  snapshot(): PerformanceDiagnosticsSnapshot {
    return {
      frames: this.frames,
      averageFrameMs: this.frames > 0 ? this.frameMsTotal / this.frames : 0,
      maxFrameMs: this.maxFrameMs,
      longFrames: this.longFrames,
      clampedFrames: this.clampedFrames,
      simulationBacklogDrops: this.simulationBacklogDrops,
      remoteSamplesAccepted: this.remoteSamplesAccepted,
      remoteSamplesReordered: this.remoteSamplesReordered,
      remoteSamplesDuplicate: this.remoteSamplesDuplicate,
      remoteSamplesStale: this.remoteSamplesStale,
      remoteInterpolationUnderflows: this.remoteInterpolationUnderflows,
      remoteExtrapolations: this.remoteExtrapolations,
      remoteStaleHolds: this.remoteStaleHolds,
      paintFlushes: this.paintFlushes,
      paintUploadRegions: this.paintUploadRegions,
      paintUploadPixels: this.paintUploadPixels,
      paintFlushCpuMs: this.paintFlushCpuMs,
      paintRebuilds: this.paintRebuilds,
    };
  }

  reset(): void {
    this.frames = 0;
    this.frameMsTotal = 0;
    this.maxFrameMs = 0;
    this.longFrames = 0;
    this.clampedFrames = 0;
    this.simulationBacklogDrops = 0;
    this.remoteSamplesAccepted = 0;
    this.remoteSamplesReordered = 0;
    this.remoteSamplesDuplicate = 0;
    this.remoteSamplesStale = 0;
    this.remoteInterpolationUnderflows = 0;
    this.remoteExtrapolations = 0;
    this.remoteStaleHolds = 0;
    this.paintFlushes = 0;
    this.paintUploadRegions = 0;
    this.paintUploadPixels = 0;
    this.paintFlushCpuMs = 0;
    this.paintRebuilds = 0;
  }
}

export const clientPerformanceTelemetry = new PerformanceTelemetry();
