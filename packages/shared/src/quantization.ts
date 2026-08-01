/**
 * Deterministic quantization for network and replay payloads (bible §7.18).
 *
 * Encoders take authoring-space values and produce integers. Decoders reject
 * every malformed input listed in §29.4 (NaN, Infinity, wrong array length,
 * zero quaternion, out-of-range integers) by throwing QuantizationError rather
 * than returning a silently wrong transform.
 */

export class QuantizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuantizationError";
  }
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type Vec3Tuple = readonly [number, number, number];
/** Quaternion component order is x, y, z, w. */
export type QuaternionTuple = readonly [number, number, number, number];

export interface WorldBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Room-sized default. Maps override this with their own authored bounds. */
export const DEFAULT_WORLD_BOUNDS: WorldBounds = {
  min: { x: -32, y: -8, z: -32 },
  max: { x: 32, y: 24, z: 32 },
};

export const INT16_MIN = -32768;
export const INT16_MAX = 32767;
/** Number of representable steps across one axis of the world bounds. */
export const POSITION_STEPS = 65535;
export const UINT8_MAX = 255;
export const UINT12_MAX = 4095;
export const UINT32_MAX = 0xffffffff;

export const SMALLEST_THREE_COMPONENT_BITS = 10;
export const SMALLEST_THREE_COMPONENT_MAX = (1 << SMALLEST_THREE_COMPONENT_BITS) - 1;
const SMALLEST_THREE_LIMIT = Math.SQRT1_2;
const QUATERNION_MIN_LENGTH = 1e-6;

function assertFinite(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new QuantizationError(`${label} must be a finite number, received ${String(value)}`);
  }
}

function assertInteger(value: number, label: string, min: number, max: number): void {
  assertFinite(value, label);
  if (!Number.isInteger(value)) {
    throw new QuantizationError(`${label} must be an integer, received ${value}`);
  }
  if (value < min || value > max) {
    throw new QuantizationError(`${label} must be within [${min}, ${max}], received ${value}`);
  }
}

function assertRange(min: number, max: number, label: string): void {
  assertFinite(min, `${label} minimum`);
  assertFinite(max, `${label} maximum`);
  if (max <= min) {
    throw new QuantizationError(`${label} range is empty: [${min}, ${max}]`);
  }
}

/**
 * Maps a bounded value onto `steps + 1` integer levels starting at zero.
 * Values outside the range clamp to the nearest edge, matching the locking
 * rule in §5.8 that illegal authoring values are clamped rather than rejected.
 */
export function quantizeBounded(value: number, min: number, max: number, steps: number): number {
  assertFinite(value, "value");
  assertRange(min, max, "bounds");
  assertInteger(steps, "steps", 1, UINT32_MAX);
  const normalized = (value - min) / (max - min);
  const clamped = normalized < 0 ? 0 : normalized > 1 ? 1 : normalized;
  return Math.round(clamped * steps);
}

export function dequantizeBounded(quantized: number, min: number, max: number, steps: number): number {
  assertRange(min, max, "bounds");
  assertInteger(steps, "steps", 1, UINT32_MAX);
  assertInteger(quantized, "quantized value", 0, steps);
  return min + (quantized / steps) * (max - min);
}

/** Map-relative signed 16-bit position component. */
export function quantizePositionAxis(value: number, min: number, max: number): number {
  return quantizeBounded(value, min, max, POSITION_STEPS) + INT16_MIN;
}

export function dequantizePositionAxis(quantized: number, min: number, max: number): number {
  assertInteger(quantized, "position component", INT16_MIN, INT16_MAX);
  return dequantizeBounded(quantized - INT16_MIN, min, max, POSITION_STEPS);
}

export function quantizePosition(
  position: Vec3,
  bounds: WorldBounds = DEFAULT_WORLD_BOUNDS,
): [number, number, number] {
  return [
    quantizePositionAxis(position.x, bounds.min.x, bounds.max.x),
    quantizePositionAxis(position.y, bounds.min.y, bounds.max.y),
    quantizePositionAxis(position.z, bounds.min.z, bounds.max.z),
  ];
}

export function dequantizePosition(
  quantized: readonly number[],
  bounds: WorldBounds = DEFAULT_WORLD_BOUNDS,
): Vec3 {
  if (quantized.length !== 3) {
    throw new QuantizationError(`quantized position must have 3 components, received ${quantized.length}`);
  }
  const [qx, qy, qz] = quantized;
  if (qx === undefined || qy === undefined || qz === undefined) {
    throw new QuantizationError("quantized position contains empty slots");
  }
  return {
    x: dequantizePositionAxis(qx, bounds.min.x, bounds.max.x),
    y: dequantizePositionAxis(qy, bounds.min.y, bounds.max.y),
    z: dequantizePositionAxis(qz, bounds.min.z, bounds.max.z),
  };
}

function readQuaternion(input: readonly number[]): [number, number, number, number] {
  if (input.length !== 4) {
    throw new QuantizationError(`quaternion must have 4 components, received ${input.length}`);
  }
  const [x, y, z, w] = input;
  if (x === undefined || y === undefined || z === undefined || w === undefined) {
    throw new QuantizationError("quaternion contains empty slots");
  }
  assertFinite(x, "quaternion x");
  assertFinite(y, "quaternion y");
  assertFinite(z, "quaternion z");
  assertFinite(w, "quaternion w");
  return [x, y, z, w];
}

/**
 * Smallest-three encoding into 32 bits: a 2-bit index of the dropped (largest
 * magnitude) component followed by three 10-bit components. The quaternion is
 * normalized first, and negated when the dropped component is negative so the
 * decoder can always reconstruct it as a positive root.
 */
export function quantizeQuaternion(quaternion: readonly number[]): number {
  const components = readQuaternion(quaternion);
  const length = Math.hypot(components[0], components[1], components[2], components[3]);
  if (length < QUATERNION_MIN_LENGTH) {
    throw new QuantizationError("quaternion has zero or near-zero length");
  }

  let largestIndex = 0;
  for (let i = 1; i < 4; i += 1) {
    if (Math.abs(components[i] as number) > Math.abs(components[largestIndex] as number)) {
      largestIndex = i;
    }
  }

  const sign = (components[largestIndex] as number) < 0 ? -1 : 1;
  let encoded = largestIndex;
  for (let i = 0; i < 4; i += 1) {
    if (i === largestIndex) continue;
    const normalized = ((components[i] as number) * sign) / length;
    const quantized = quantizeBounded(
      normalized,
      -SMALLEST_THREE_LIMIT,
      SMALLEST_THREE_LIMIT,
      SMALLEST_THREE_COMPONENT_MAX,
    );
    encoded = (encoded << SMALLEST_THREE_COMPONENT_BITS) | quantized;
  }
  return encoded >>> 0;
}

export function dequantizeQuaternion(encoded: number): [number, number, number, number] {
  assertInteger(encoded, "encoded quaternion", 0, UINT32_MAX);
  const largestIndex = (encoded >>> 30) & 0b11;
  const values: number[] = [];
  for (let shift = 2; shift >= 0; shift -= 1) {
    const raw = (encoded >>> (shift * SMALLEST_THREE_COMPONENT_BITS)) & SMALLEST_THREE_COMPONENT_MAX;
    values.push(
      dequantizeBounded(raw, -SMALLEST_THREE_LIMIT, SMALLEST_THREE_LIMIT, SMALLEST_THREE_COMPONENT_MAX),
    );
  }

  const result: [number, number, number, number] = [0, 0, 0, 0];
  let cursor = 0;
  let sumOfSquares = 0;
  for (let i = 0; i < 4; i += 1) {
    if (i === largestIndex) continue;
    const value = values[cursor] as number;
    cursor += 1;
    result[i] = value;
    sumOfSquares += value * value;
  }
  if (sumOfSquares > 1) {
    throw new QuantizationError("encoded quaternion components exceed unit length");
  }
  result[largestIndex] = Math.sqrt(1 - sumOfSquares);
  return result;
}

/** Normalized 0..1 authoring value, 8-bit channel. */
export function quantizeUnit8(value: number): number {
  return quantizeBounded(value, 0, 1, UINT8_MAX);
}

export function dequantizeUnit8(quantized: number): number {
  return dequantizeBounded(quantized, 0, 1, UINT8_MAX);
}

/** Normalized 0..1 authoring value, 12-bit channel (segment form, hinge, scale). */
export function quantizeUnit12(value: number): number {
  return quantizeBounded(value, 0, 1, UINT12_MAX);
}

export function dequantizeUnit12(quantized: number): number {
  return dequantizeBounded(quantized, 0, 1, UINT12_MAX);
}

/** Bytes charged to each element of a serialized disguise state (§29.2). */
export const DISGUISE_BYTE_COSTS = {
  /** version + rigVersion + mapVersion + revision */
  header: 8,
  /** int16 position triple plus a packed quaternion */
  root: 10,
  /** joint index plus a packed quaternion */
  joint: 5,
  /** segment index plus five 12-bit form channels */
  segment: 9,
  /** panel index plus 12-bit hinge and state bits */
  panel: 3,
  /** anchor index, surface index, int16 position triple, packed normal */
  anchor: 11,
  /** target index plus a 16-bit swatch id */
  material: 3,
} as const;

const UINT16_COUNT_LIMIT = 65535;

export interface DisguiseElementCounts {
  readonly joints: number;
  readonly segments: number;
  readonly panels: number;
  readonly anchors: number;
  readonly materials: number;
}

/** Upper-bound byte size of one quantized disguise, used for transport budgeting. */
export function estimateDisguiseByteSize(counts: DisguiseElementCounts): number {
  assertInteger(counts.joints, "joints", 0, UINT16_COUNT_LIMIT);
  assertInteger(counts.segments, "segments", 0, UINT16_COUNT_LIMIT);
  assertInteger(counts.panels, "panels", 0, UINT16_COUNT_LIMIT);
  assertInteger(counts.anchors, "anchors", 0, UINT16_COUNT_LIMIT);
  assertInteger(counts.materials, "materials", 0, UINT16_COUNT_LIMIT);
  return (
    DISGUISE_BYTE_COSTS.header +
    DISGUISE_BYTE_COSTS.root +
    counts.joints * DISGUISE_BYTE_COSTS.joint +
    counts.segments * DISGUISE_BYTE_COSTS.segment +
    counts.panels * DISGUISE_BYTE_COSTS.panel +
    counts.anchors * DISGUISE_BYTE_COSTS.anchor +
    counts.materials * DISGUISE_BYTE_COSTS.material
  );
}
