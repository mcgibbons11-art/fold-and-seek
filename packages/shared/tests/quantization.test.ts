import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORLD_BOUNDS,
  DISGUISE_BYTE_COSTS,
  QuantizationError,
  dequantizeBounded,
  dequantizePosition,
  dequantizeQuaternion,
  dequantizeUnit12,
  dequantizeUnit8,
  estimateDisguiseByteSize,
  quantizePosition,
  quantizeQuaternion,
  quantizeUnit12,
  quantizeUnit8,
  type QuaternionTuple,
} from "../src";

/** Half the width of one int16 step across the widest default axis. */
const POSITION_TOLERANCE = 64 / 65535;

function normalize(q: QuaternionTuple): QuaternionTuple {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

describe("position quantization", () => {
  it("round-trips positions inside the world bounds", () => {
    const samples = [
      { x: 0, y: 0, z: 0 },
      { x: 1.25, y: 2.5, z: -3.75 },
      { x: -31.9, y: 23.9, z: 31.9 },
      { x: 0.001, y: -0.001, z: 0.5 },
    ];
    for (const sample of samples) {
      const decoded = dequantizePosition(quantizePosition(sample));
      expect(decoded.x).toBeCloseTo(sample.x, 2);
      expect(decoded.y).toBeCloseTo(sample.y, 2);
      expect(decoded.z).toBeCloseTo(sample.z, 2);
      expect(Math.abs(decoded.x - sample.x)).toBeLessThanOrEqual(POSITION_TOLERANCE);
    }
  });

  it("encodes into the signed 16-bit range and clamps out-of-bounds input", () => {
    const encoded = quantizePosition({ x: 500, y: -500, z: 0 });
    expect(encoded[0]).toBe(32767);
    expect(encoded[1]).toBe(-32768);
    expect(encoded.every((value) => Number.isInteger(value))).toBe(true);

    const decoded = dequantizePosition(encoded);
    expect(decoded.x).toBeCloseTo(DEFAULT_WORLD_BOUNDS.max.x, 3);
    expect(decoded.y).toBeCloseTo(DEFAULT_WORLD_BOUNDS.min.y, 3);
  });

  it("rejects malformed encoded positions", () => {
    expect(() => dequantizePosition([0, 0])).toThrow(QuantizationError);
    expect(() => dequantizePosition([0, 0, 0, 0])).toThrow(QuantizationError);
    expect(() => dequantizePosition([0, 0, Number.NaN])).toThrow(QuantizationError);
    expect(() => dequantizePosition([0, 0, Number.POSITIVE_INFINITY])).toThrow(QuantizationError);
    expect(() => dequantizePosition([0, 0, 40_000])).toThrow(QuantizationError);
    expect(() => dequantizePosition([0, 0, 1.5])).toThrow(QuantizationError);
    expect(() => quantizePosition({ x: Number.NaN, y: 0, z: 0 })).toThrow(QuantizationError);
  });
});

describe("quaternion quantization", () => {
  it("round-trips unit quaternions within smallest-three precision", () => {
    const samples: QuaternionTuple[] = [
      [0, 0, 0, 1],
      normalize([0.5, 0.5, 0.5, 0.5]),
      normalize([0.1, -0.2, 0.3, 0.9]),
      normalize([-0.7, 0.1, 0.05, -0.7]),
      normalize([0, Math.SQRT1_2, 0, Math.SQRT1_2]),
    ];
    for (const sample of samples) {
      const decoded = dequantizeQuaternion(quantizeQuaternion(sample));
      // Sign is not preserved, so compare the rotation rather than components.
      const dot = Math.abs(
        sample[0] * decoded[0] + sample[1] * decoded[1] + sample[2] * decoded[2] + sample[3] * decoded[3],
      );
      expect(dot).toBeGreaterThan(0.9999);
      expect(Math.hypot(...decoded)).toBeCloseTo(1, 5);
    }
  });

  it("fits the encoding in 32 unsigned bits", () => {
    const encoded = quantizeQuaternion(normalize([0.2, 0.3, 0.1, 0.9]));
    expect(Number.isInteger(encoded)).toBe(true);
    expect(encoded).toBeGreaterThanOrEqual(0);
    expect(encoded).toBeLessThanOrEqual(0xffffffff);
    expect(quantizeQuaternion([0, 0, 0, -1])).toBe(quantizeQuaternion([0, 0, 0, 1]));
  });

  it("rejects zero, non-finite and wrong-length quaternions", () => {
    expect(() => quantizeQuaternion([0, 0, 0, 0])).toThrow(QuantizationError);
    expect(() => quantizeQuaternion([0, 0, 1])).toThrow(QuantizationError);
    expect(() => quantizeQuaternion([0, 0, 0, 1, 0])).toThrow(QuantizationError);
    expect(() => quantizeQuaternion([Number.NaN, 0, 0, 1])).toThrow(QuantizationError);
    expect(() => quantizeQuaternion([Number.POSITIVE_INFINITY, 0, 0, 1])).toThrow(QuantizationError);
  });

  it("rejects malformed encoded quaternions", () => {
    expect(() => dequantizeQuaternion(-1)).toThrow(QuantizationError);
    expect(() => dequantizeQuaternion(1.5)).toThrow(QuantizationError);
    expect(() => dequantizeQuaternion(Number.NaN)).toThrow(QuantizationError);
    expect(() => dequantizeQuaternion(0x1_0000_0000)).toThrow(QuantizationError);
  });
});

describe("normalized channels", () => {
  it("round-trips 8-bit and 12-bit unit values within one step", () => {
    for (const value of [0, 0.25, 0.5, 0.751, 1]) {
      expect(Math.abs(dequantizeUnit8(quantizeUnit8(value)) - value)).toBeLessThanOrEqual(1 / 255);
      expect(Math.abs(dequantizeUnit12(quantizeUnit12(value)) - value)).toBeLessThanOrEqual(1 / 4095);
    }
    expect(quantizeUnit8(0)).toBe(0);
    expect(quantizeUnit8(1)).toBe(255);
    expect(quantizeUnit12(1)).toBe(4095);
  });

  it("clamps out-of-range input and rejects malformed decodes", () => {
    expect(quantizeUnit8(2)).toBe(255);
    expect(quantizeUnit8(-2)).toBe(0);
    expect(() => dequantizeUnit8(256)).toThrow(QuantizationError);
    expect(() => dequantizeUnit12(-1)).toThrow(QuantizationError);
    expect(() => dequantizeUnit8(Number.NaN)).toThrow(QuantizationError);
    expect(() => dequantizeBounded(5, 1, 0, 10)).toThrow(QuantizationError);
  });
});

describe("disguise size estimation", () => {
  it("adds up the per-element byte costs", () => {
    const counts = { joints: 2, segments: 1, panels: 1, anchors: 1, materials: 1 };
    const expected =
      DISGUISE_BYTE_COSTS.header +
      DISGUISE_BYTE_COSTS.root +
      2 * DISGUISE_BYTE_COSTS.joint +
      DISGUISE_BYTE_COSTS.segment +
      DISGUISE_BYTE_COSTS.panel +
      DISGUISE_BYTE_COSTS.anchor +
      DISGUISE_BYTE_COSTS.material;
    expect(estimateDisguiseByteSize(counts)).toBe(expected);
  });

  it("keeps a full twelve-player room inside the 8 KB Portals broadcast budget", () => {
    const perPlayer = estimateDisguiseByteSize({
      joints: 24,
      segments: 12,
      panels: 6,
      anchors: 4,
      materials: 8,
    });
    expect(perPlayer * 12).toBeLessThan(8_192);
  });

  it("rejects non-integer element counts", () => {
    expect(() =>
      estimateDisguiseByteSize({ joints: 1.5, segments: 0, panels: 0, anchors: 0, materials: 0 }),
    ).toThrow(QuantizationError);
  });
});
