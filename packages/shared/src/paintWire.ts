import { PANEL_SOCKET_NAMES, RIG_SEGMENT_BONES } from "./config";

/**
 * Wire form of a body-painting layer (MECCHA port, CLAUDE.md override 3).
 *
 * A paint layer is a log of brush stamps in texture space, never an image: a
 * bitmap large enough to be worth painting on would not fit a Portals broadcast,
 * and a stroke log replays to exactly the same pixels on every client because
 * the rasterizer in apps/client/src/paint/PaintLayer.ts is integer software
 * compositing rather than a browser canvas primitive.
 *
 * Every stroke is nine bytes and the whole layer travels as base64 text, so a
 * full layer is a bounded ASCII payload the same way an encoded pose is.
 */

/**
 * Paintable surfaces, in the order their indices are written to the wire: the
 * nineteen rig segments first, then the eight panel sockets. Appending is safe;
 * reordering is a wire break and needs PAINT_WIRE_VERSION bumped.
 */
export const PAINT_TARGET_IDS = [...RIG_SEGMENT_BONES, ...PANEL_SOCKET_NAMES] as const;

export type PaintTargetId = (typeof PAINT_TARGET_IDS)[number];

export const PAINT_WIRE_VERSION = 1;

/**
 * Ceiling on a layer's stroke log. Older strokes are dropped, never refused.
 *
 * A full log is 6,915 bytes, which is 9,220 base64 characters: more than one
 * relay value holds, so a paint layer always travels on a chunked key range of
 * its own and never inside an encoded pose.
 */
export const MAX_PAINT_STROKES = 768;

export const PAINT_STROKE_BYTES = 9;
export const PAINT_WIRE_HEADER_BYTES = 3;

export const PAINT_WIRE_MAX_BYTES =
  PAINT_WIRE_HEADER_BYTES + MAX_PAINT_STROKES * PAINT_STROKE_BYTES;

/** Base64 grows three bytes into four characters, padded to a multiple of four. */
export const PAINT_WIRE_MAX_BASE64_LENGTH = Math.ceil(PAINT_WIRE_MAX_BYTES / 3) * 4;

/** Quantization grids: twelve bits across each UV axis, six bits of radius. */
const UV_STEPS = 4_095;
const RADIUS_STEPS = 63;
const BYTE_STEPS = 255;

const ERASE_FLAG = 0b10;
const CONTINUED_FLAG = 0b01;

/**
 * One brush stamp. `u`/`v` are the hit point in the target's own UV square,
 * `radius` is a fraction of that square, and `color` is sRGB in 0..1 to match
 * what the colour wheel publishes and what the atlas stores.
 *
 * `continued` marks a stamp sampled while the pointer was already down on the
 * same target, which is what lets a replay draw the connecting line rather than
 * a row of separate dots. Without it a fast drag would replay as beads.
 */
export interface PaintStrokeWire {
  readonly target: number;
  readonly u: number;
  readonly v: number;
  readonly radius: number;
  readonly color: readonly [number, number, number];
  readonly opacity: number;
  readonly erase: boolean;
  readonly continued: boolean;
}

export interface PaintLayerWire {
  readonly version: number;
  readonly strokes: readonly PaintStrokeWire[];
}

export type PaintLayerDecoding =
  | { readonly ok: true; readonly layer: PaintLayerWire }
  | { readonly ok: false; readonly issue: string };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function quantize(value: number, steps: number): number {
  return Math.round(clamp01(value) * steps);
}

function dequantize(raw: number, steps: number): number {
  return raw / steps;
}

/**
 * Snaps a stroke onto the wire grid. Encoding and decoding are exactly the
 * identity on an already-quantized stroke, which is what makes a round-trip
 * testable without a tolerance.
 */
export function quantizePaintStroke(stroke: PaintStrokeWire): PaintStrokeWire {
  return {
    target: Math.max(0, Math.min(PAINT_TARGET_IDS.length - 1, Math.trunc(stroke.target))),
    u: dequantize(quantize(stroke.u, UV_STEPS), UV_STEPS),
    v: dequantize(quantize(stroke.v, UV_STEPS), UV_STEPS),
    radius: dequantize(quantize(stroke.radius, RADIUS_STEPS), RADIUS_STEPS),
    color: [
      dequantize(quantize(stroke.color[0], BYTE_STEPS), BYTE_STEPS),
      dequantize(quantize(stroke.color[1], BYTE_STEPS), BYTE_STEPS),
      dequantize(quantize(stroke.color[2], BYTE_STEPS), BYTE_STEPS),
    ],
    opacity: dequantize(quantize(stroke.opacity, BYTE_STEPS), BYTE_STEPS),
    erase: stroke.erase,
    continued: stroke.continued,
  };
}

export function writePaintStroke(
  bytes: Uint8Array,
  offset: number,
  stroke: PaintStrokeWire,
): void {
  const u = quantize(stroke.u, UV_STEPS);
  const v = quantize(stroke.v, UV_STEPS);
  bytes[offset] = Math.max(0, Math.min(PAINT_TARGET_IDS.length - 1, Math.trunc(stroke.target)));
  bytes[offset + 1] = u >> 4;
  bytes[offset + 2] = ((u & 0x0f) << 4) | (v >> 8);
  bytes[offset + 3] = v & 0xff;
  bytes[offset + 4] = quantize(stroke.color[0], BYTE_STEPS);
  bytes[offset + 5] = quantize(stroke.color[1], BYTE_STEPS);
  bytes[offset + 6] = quantize(stroke.color[2], BYTE_STEPS);
  bytes[offset + 7] = quantize(stroke.opacity, BYTE_STEPS);
  bytes[offset + 8] =
    (quantize(stroke.radius, RADIUS_STEPS) << 2) |
    (stroke.erase ? ERASE_FLAG : 0) |
    (stroke.continued ? CONTINUED_FLAG : 0);
}

export function readPaintStroke(bytes: Uint8Array, offset: number): PaintStrokeWire {
  const target = bytes[offset] ?? 0;
  const uHigh = bytes[offset + 1] ?? 0;
  const middle = bytes[offset + 2] ?? 0;
  const vLow = bytes[offset + 3] ?? 0;
  const flags = bytes[offset + 8] ?? 0;
  return {
    target,
    u: dequantize((uHigh << 4) | (middle >> 4), UV_STEPS),
    v: dequantize(((middle & 0x0f) << 8) | vLow, UV_STEPS),
    radius: dequantize(flags >> 2, RADIUS_STEPS),
    color: [
      dequantize(bytes[offset + 4] ?? 0, BYTE_STEPS),
      dequantize(bytes[offset + 5] ?? 0, BYTE_STEPS),
      dequantize(bytes[offset + 6] ?? 0, BYTE_STEPS),
    ],
    opacity: dequantize(bytes[offset + 7] ?? 0, BYTE_STEPS),
    erase: (flags & ERASE_FLAG) !== 0,
    continued: (flags & CONTINUED_FLAG) !== 0,
  };
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_REVERSE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Base64 over bytes. Written out rather than reached for through `Buffer` or
 * `btoa` because this module runs unchanged in the browser, in Node, and inside
 * the Portals sandbox, and only one of those has each of those two.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const triple = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      BASE64_ALPHABET[(triple >> 18) & 63]! +
      BASE64_ALPHABET[(triple >> 12) & 63]! +
      BASE64_ALPHABET[(triple >> 6) & 63]! +
      BASE64_ALPHABET[triple & 63]!;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = (bytes[i] ?? 0) << 16;
    out += BASE64_ALPHABET[(chunk >> 18) & 63]! + BASE64_ALPHABET[(chunk >> 12) & 63]! + "==";
  } else if (remaining === 2) {
    const chunk = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out +=
      BASE64_ALPHABET[(chunk >> 18) & 63]! +
      BASE64_ALPHABET[(chunk >> 12) & 63]! +
      BASE64_ALPHABET[(chunk >> 6) & 63]! +
      "=";
  }
  return out;
}

/** Returns null on anything that is not well-formed base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  let padding = 0;
  if (text.endsWith("==")) padding = 2;
  else if (text.endsWith("=")) padding = 1;

  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let out = 0;
  for (let i = 0; i < text.length; i += 4) {
    let chunk = 0;
    for (let j = 0; j < 4; j++) {
      const code = text.charCodeAt(i + j);
      if (code === 61 /* = */ && i + 4 >= text.length && j >= 4 - padding) {
        chunk = chunk << 6;
        continue;
      }
      const value = code < 128 ? (BASE64_REVERSE[code] ?? -1) : -1;
      if (value < 0) return null;
      chunk = (chunk << 6) | value;
    }
    if (out < bytes.length) bytes[out++] = (chunk >> 16) & 0xff;
    if (out < bytes.length) bytes[out++] = (chunk >> 8) & 0xff;
    if (out < bytes.length) bytes[out++] = chunk & 0xff;
  }
  return bytes;
}

/**
 * Encodes a layer. Strokes past the ceiling are dropped from the front, which
 * is the same rule the client's PaintLayer applies to its own log, so what the
 * painter sees and what the wire carries never diverge.
 */
export function encodePaintLayer(strokes: readonly PaintStrokeWire[]): string {
  const kept = strokes.length > MAX_PAINT_STROKES ? strokes.slice(-MAX_PAINT_STROKES) : strokes;
  const bytes = new Uint8Array(PAINT_WIRE_HEADER_BYTES + kept.length * PAINT_STROKE_BYTES);
  bytes[0] = PAINT_WIRE_VERSION;
  bytes[1] = (kept.length >> 8) & 0xff;
  bytes[2] = kept.length & 0xff;
  for (let i = 0; i < kept.length; i++) {
    const stroke = kept[i];
    if (stroke === undefined) continue;
    writePaintStroke(bytes, PAINT_WIRE_HEADER_BYTES + i * PAINT_STROKE_BYTES, stroke);
  }
  return bytesToBase64(bytes);
}

/** Parses an encoded layer, reporting the reason instead of throwing. */
export function decodePaintLayer(payload: string): PaintLayerDecoding {
  if (payload.length > PAINT_WIRE_MAX_BASE64_LENGTH) {
    return { ok: false, issue: "paint_payload_too_large" };
  }
  const bytes = base64ToBytes(payload);
  if (bytes === null) return { ok: false, issue: "paint_payload_not_base64" };
  if (bytes.length < PAINT_WIRE_HEADER_BYTES) return { ok: false, issue: "paint_payload_truncated" };

  const version = bytes[0] ?? 0;
  if (version !== PAINT_WIRE_VERSION) return { ok: false, issue: "paint_version_mismatch" };

  const count = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  if (count > MAX_PAINT_STROKES) return { ok: false, issue: "paint_stroke_count_over_ceiling" };
  if (bytes.length !== PAINT_WIRE_HEADER_BYTES + count * PAINT_STROKE_BYTES) {
    return { ok: false, issue: "paint_payload_length_mismatch" };
  }

  const strokes: PaintStrokeWire[] = [];
  for (let i = 0; i < count; i++) {
    const stroke = readPaintStroke(bytes, PAINT_WIRE_HEADER_BYTES + i * PAINT_STROKE_BYTES);
    if (stroke.target >= PAINT_TARGET_IDS.length) {
      return { ok: false, issue: "paint_stroke_target_unknown" };
    }
    strokes.push(stroke);
  }
  return { ok: true, layer: { version, strokes } };
}
