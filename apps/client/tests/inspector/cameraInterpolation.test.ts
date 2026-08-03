import { describe, expect, it } from "vitest";

import {
  CameraSampleInterpolationBuffer,
  type CameraSample,
} from "../../src/inspector/cameraSamples";

const sample = (atMs: number, x: number): CameraSample => ({
  atMs,
  x,
  y: 1,
  z: 0,
  yaw: 0,
  pitch: 0,
  airborne: false,
  climbing: false,
});

describe("remote camera timestamp buffer", () => {
  it("orders jittered packets by timestamp instead of arrival order", () => {
    const buffer = new CameraSampleInterpolationBuffer();
    expect(buffer.push(sample(0, 0))).toBe("accepted");
    expect(buffer.push(sample(200, 2))).toBe("accepted");
    expect(buffer.push(sample(100, 1))).toBe("reordered");

    expect(buffer.advance(50)?.sample.x).toBeCloseTo(0);
    expect(buffer.advance(50)).toMatchObject({ mode: "interpolated", sample: { x: 0.5 } });
    expect(buffer.advance(50)).toMatchObject({ mode: "interpolated", sample: { x: 1 } });
  });

  it("rejects duplicate and already-consumed stale packets", () => {
    const buffer = new CameraSampleInterpolationBuffer();
    buffer.push(sample(0, 0));
    buffer.push(sample(100, 1));
    expect(buffer.push(sample(100, 9))).toBe("duplicate");
    buffer.advance(300);
    expect(buffer.push(sample(-10, 9))).toBe("stale");
  });

  it("bridges one dropped interval, then holds instead of running away", () => {
    const buffer = new CameraSampleInterpolationBuffer();
    buffer.push(sample(0, 0));
    buffer.push(sample(100, 1));

    expect(buffer.advance(200)).toMatchObject({ mode: "extrapolated", sample: { x: 1.5 } });
    expect(buffer.advance(100)).toMatchObject({ mode: "stale", sample: { x: 2 } });
  });

  it("re-anchors when a sender resumes after a long pause", () => {
    const buffer = new CameraSampleInterpolationBuffer();
    buffer.push(sample(0, 0));
    buffer.push(sample(100, 1));
    buffer.advance(1_000);

    expect(buffer.push(sample(400, 4))).toBe("accepted");
    const recovered = buffer.advance(50);
    expect(recovered?.sample.x).toBeCloseTo(4);
    expect(recovered?.mode).not.toBe("stale");
  });

  it("interpolates wrapped yaw through the short arc", () => {
    const buffer = new CameraSampleInterpolationBuffer();
    buffer.push({ ...sample(0, 0), yaw: Math.PI - 0.1 });
    buffer.push({ ...sample(100, 1), yaw: -Math.PI + 0.1 });
    const frame = buffer.advance(100);
    expect(Math.abs(frame?.sample.yaw ?? 0)).toBeGreaterThan(3);
  });
});
