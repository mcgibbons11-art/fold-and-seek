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
    expect(PAINT_WIRE_MAX_BYTES).toBe(6_915);
    expect(PAINT_WIRE_MAX_BASE64_LENGTH).toBe(9_220);
    expect(encodePaintLayer(strokes).length).toBe(9_220);
    // One relay value holds 8,192 bytes, so a full layer needs two chunks, and
    // a full room of twelve needs a key range wider than the twelve-key default.
    expect(PAINT_WIRE_MAX_BASE64_LENGTH).toBeGreaterThan(8_192);
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
