import { describe, expect, it } from "vitest";

import {
  base64ToBytes,
  bytesToBase64,
  decodePaintLayer,
  encodePaintLayer,
  MAX_PAINT_STROKES,
  PAINT_STROKE_BYTES,
  PAINT_TARGET_IDS,
  PAINT_WIRE_HEADER_BYTES,
  PAINT_WIRE_MAX_BASE64_LENGTH,
  PAINT_WIRE_MAX_BYTES,
  PAINT_WIRE_VERSION,
  quantizePaintStroke,
  type PaintStrokeWire,
} from "../src/paintWire";
import { decodePaintLayerWire, PaintLayerWireSchema } from "../src/schemas";

function stroke(index: number): PaintStrokeWire {
  return quantizePaintStroke({
    target: index % PAINT_TARGET_IDS.length,
    u: (index * 0.017) % 1,
    v: (index * 0.031) % 1,
    radius: 0.02 + ((index * 0.003) % 0.2),
    color: [(index % 256) / 255, ((index * 7) % 256) / 255, ((index * 13) % 256) / 255],
    opacity: 0.2 + ((index * 0.011) % 0.8),
    metallic: ((index * 17) % 256) / 255,
    smoothness: ((index * 23) % 256) / 255,
    emissive: ((index * 29) % 256) / 255,
    erase: index % 5 === 0,
    continued: index % 3 !== 0,
  });
}

describe("paint wire base64", () => {
  it("round-trips byte arrays at every padding length", () => {
    for (let length = 0; length < 32; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length) % 256;
      const text = bytesToBase64(bytes);
      expect(text.length % 4).toBe(0);
      expect(base64ToBytes(text)).toEqual(bytes);
    }
  });

  it("refuses text that is not base64", () => {
    expect(base64ToBytes("abc")).toBeNull();
    expect(base64ToBytes("ab*d")).toBeNull();
  });
});

describe("paint layer encoding", () => {
  it("round-trips a quantized stroke log exactly", () => {
    const strokes = Array.from({ length: 200 }, (_, index) => stroke(index));
    const decoded = decodePaintLayer(encodePaintLayer(strokes));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.layer.version).toBe(PAINT_WIRE_VERSION);
    expect(decoded.layer.strokes).toEqual(strokes);
  });

  it("encodes an empty layer", () => {
    const decoded = decodePaintLayer(encodePaintLayer([]));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.layer.strokes).toEqual([]);
  });

  it("keeps the newest strokes when the log is over the ceiling", () => {
    const strokes = Array.from({ length: MAX_PAINT_STROKES + 40 }, (_, index) => stroke(index));
    const decoded = decodePaintLayer(encodePaintLayer(strokes));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.layer.strokes).toHaveLength(MAX_PAINT_STROKES);
    expect(decoded.layer.strokes[0]).toEqual(strokes[40]);
    expect(decoded.layer.strokes.at(-1)).toEqual(strokes.at(-1));
  });

  it("stays inside the declared payload ceiling at a full log", () => {
    const strokes = Array.from({ length: MAX_PAINT_STROKES }, (_, index) => stroke(index));
    const payload = encodePaintLayer(strokes);
    expect(PAINT_WIRE_MAX_BYTES).toBe(
      PAINT_WIRE_HEADER_BYTES + MAX_PAINT_STROKES * PAINT_STROKE_BYTES,
    );
    expect(payload.length).toBe(PAINT_WIRE_MAX_BASE64_LENGTH);
  });

  it("pins the transported size a full log actually costs", () => {
    // Absolute figures, not the derived constants, so that widening a stroke
    // field shows up here as a failing number rather than as a relay write the
    // transport quietly skips. Base64 is ASCII, so characters are bytes.
    const strokes = Array.from({ length: MAX_PAINT_STROKES }, (_, index) => stroke(index));
    expect(MAX_PAINT_STROKES).toBe(768);
    expect(PAINT_STROKE_BYTES).toBe(12);
    expect(PAINT_WIRE_MAX_BYTES).toBe(9_219);
    expect(PAINT_WIRE_MAX_BASE64_LENGTH).toBe(12_292);
    expect(encodePaintLayer(strokes).length).toBe(12_292);
    // One relay value holds 8,192 bytes, so a full layer needs two chunks, and
    // a full room of twelve needs twenty keys rather than the twelve a pose
    // book uses. Raising this without widening PAINT_STATE_KEYS would make the
    // transport skip the write instead of rejecting it.
    expect(PAINT_WIRE_MAX_BASE64_LENGTH).toBeGreaterThan(8_192);
    expect(Math.ceil((PAINT_WIRE_MAX_BASE64_LENGTH * 12) / 8_192)).toBeLessThanOrEqual(20);
  });

  it("carries the material response through the wire byte for byte", () => {
    const strokes = [
      quantizePaintStroke({
        target: 3,
        u: 0.5,
        v: 0.5,
        radius: 0.1,
        color: [1, 0, 0],
        opacity: 1,
        metallic: 1,
        smoothness: 0,
        emissive: 0,
        erase: false,
        continued: false,
      }),
      quantizePaintStroke({
        target: 3,
        u: 0.25,
        v: 0.75,
        radius: 0.1,
        color: [0, 1, 0],
        opacity: 1,
        metallic: 0,
        smoothness: 1,
        emissive: 0,
        erase: false,
        continued: true,
      }),
    ];
    const decoded = decodePaintLayer(encodePaintLayer(strokes));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.layer.strokes[0]?.metallic).toBe(1);
    expect(decoded.layer.strokes[0]?.smoothness).toBe(0);
    expect(decoded.layer.strokes[1]?.metallic).toBe(0);
    expect(decoded.layer.strokes[1]?.smoothness).toBe(1);
    expect(decoded.layer.strokes).toEqual(strokes);
  });

  it("carries emissive through the wire, and leaves an unlit stroke unlit", () => {
    const glowing = quantizePaintStroke({
      target: 5,
      u: 0.4,
      v: 0.6,
      radius: 0.08,
      color: [0.2, 0.9, 1],
      opacity: 1,
      metallic: 0,
      smoothness: 0.5,
      emissive: 1,
      erase: false,
      continued: false,
    });
    const matt = { ...glowing, u: 0.6, emissive: 0 };
    const half = { ...glowing, v: 0.2, emissive: quantizePaintStroke({ ...glowing, emissive: 0.5 }).emissive };

    const decoded = decodePaintLayer(encodePaintLayer([glowing, matt, half]));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.layer.strokes[0]?.emissive).toBe(1);
    expect(decoded.layer.strokes[1]?.emissive).toBe(0);
    expect(decoded.layer.strokes[2]?.emissive).toBeCloseTo(0.5, 2);
    // Emissive is the last byte of the stroke, so a wrong stride would show up
    // as the next stroke's target rather than as a wrong glow.
    expect(decoded.layer.strokes).toEqual([glowing, matt, half]);
  });

  it("refuses an older layer version outright", () => {
    // A v2 stroke was eleven bytes and carried no emissive. Reading one as v3
    // would silently reinterpret the next stroke's bytes as this one's glow, so
    // the version check has to come first.
    const v2 = new Uint8Array(3 + 11);
    v2[0] = 2;
    v2[2] = 1;
    expect(decodePaintLayer(bytesToBase64(v2))).toEqual({
      ok: false,
      issue: "paint_version_mismatch",
    });
    // A v1 stroke was nine bytes and carried no material response at all.
    const v1 = new Uint8Array(3 + 9);
    v1[0] = 1;
    v1[2] = 1;
    expect(decodePaintLayer(bytesToBase64(v1))).toEqual({
      ok: false,
      issue: "paint_version_mismatch",
    });
    expect(PAINT_WIRE_VERSION).toBe(3);
  });

  it("reports why a bad payload was refused", () => {
    expect(decodePaintLayer("!".repeat(8))).toEqual({
      ok: false,
      issue: "paint_payload_not_base64",
    });
    expect(decodePaintLayer("A".repeat(PAINT_WIRE_MAX_BASE64_LENGTH + 4))).toEqual({
      ok: false,
      issue: "paint_payload_too_large",
    });
    // Header claims two strokes, body carries none.
    expect(decodePaintLayer(bytesToBase64(new Uint8Array([PAINT_WIRE_VERSION, 0, 2])))).toEqual({
      ok: false,
      issue: "paint_payload_length_mismatch",
    });
    expect(decodePaintLayer(bytesToBase64(new Uint8Array([PAINT_WIRE_VERSION + 1, 0, 0])))).toEqual({
      ok: false,
      issue: "paint_version_mismatch",
    });
  });

  it("refuses a stroke naming a target outside the rig", () => {
    const bytes = new Uint8Array(PAINT_WIRE_HEADER_BYTES + PAINT_STROKE_BYTES);
    bytes[0] = PAINT_WIRE_VERSION;
    bytes[2] = 1;
    bytes[PAINT_WIRE_HEADER_BYTES] = PAINT_TARGET_IDS.length;
    expect(decodePaintLayer(bytesToBase64(bytes))).toEqual({
      ok: false,
      issue: "paint_stroke_target_unknown",
    });
  });
});

describe("paint layer schema", () => {
  it("accepts a decoded layer", () => {
    const strokes = Array.from({ length: 12 }, (_, index) => stroke(index));
    const decoded = decodePaintLayerWire(encodePaintLayer(strokes));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.layer.strokes).toEqual(strokes);
  });

  it("refuses a layer with an unknown key or an out-of-range field", () => {
    expect(PaintLayerWireSchema.safeParse({ version: PAINT_WIRE_VERSION }).success).toBe(false);
    expect(
      PaintLayerWireSchema.safeParse({
        version: PAINT_WIRE_VERSION,
        strokes: [{ ...stroke(1), u: 1.4 }],
      }).success,
    ).toBe(false);
    expect(
      PaintLayerWireSchema.safeParse({
        version: PAINT_WIRE_VERSION,
        strokes: [{ ...stroke(1), extra: true }],
      }).success,
    ).toBe(false);
  });

  it("refuses a stroke log longer than the ceiling", () => {
    const strokes = Array.from({ length: MAX_PAINT_STROKES + 1 }, (_, index) => stroke(index));
    expect(PaintLayerWireSchema.safeParse({ version: PAINT_WIRE_VERSION, strokes }).success).toBe(
      false,
    );
  });
});
