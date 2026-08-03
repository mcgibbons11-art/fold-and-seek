import { describe, expect, it } from "vitest";

import { PerformanceTelemetry } from "../../src/engine/performanceTelemetry";

describe("structured performance telemetry", () => {
  it("counts frame pressure and remote interpolation outcomes", () => {
    const telemetry = new PerformanceTelemetry();
    telemetry.recordFrame(16, 100);
    telemetry.recordFrame(40, 100);
    telemetry.recordFrame(120, 100);
    telemetry.recordSimulationBacklogDrop();
    telemetry.recordRemoteInsertion("accepted");
    telemetry.recordRemoteInsertion("reordered");
    telemetry.recordRemoteInsertion("duplicate");
    telemetry.recordRemoteInsertion("stale");
    telemetry.recordRemotePresentation("held");
    telemetry.recordRemotePresentation("interpolated");
    telemetry.recordRemotePresentation("extrapolated");
    telemetry.recordRemotePresentation("stale");
    telemetry.recordPaint({
      flushes: 4,
      rectangles: 6,
      pixels: 2048,
      flushCpuMs: 1.25,
      rebuilds: 1,
    });

    expect(telemetry.snapshot()).toEqual({
      frames: 3,
      averageFrameMs: 176 / 3,
      maxFrameMs: 120,
      longFrames: 2,
      clampedFrames: 1,
      simulationBacklogDrops: 1,
      remoteSamplesAccepted: 1,
      remoteSamplesReordered: 1,
      remoteSamplesDuplicate: 1,
      remoteSamplesStale: 1,
      remoteInterpolationUnderflows: 1,
      remoteExtrapolations: 1,
      remoteStaleHolds: 1,
      paintFlushes: 4,
      paintUploadRegions: 6,
      paintUploadPixels: 2048,
      paintFlushCpuMs: 1.25,
      paintRebuilds: 1,
    });
  });

  it("resets every counter for deterministic diagnostics runs", () => {
    const telemetry = new PerformanceTelemetry();
    telemetry.recordFrame(50, 20);
    telemetry.recordRemoteInsertion("stale");
    telemetry.reset();
    expect(telemetry.snapshot().frames).toBe(0);
    expect(telemetry.snapshot().remoteSamplesStale).toBe(0);
  });
});
