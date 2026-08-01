import { SEGMENT_BONES, type SegmentBoneName } from "./rig";

/**
 * Segment form representation (bible §7.10) and the authored ranges each
 * normalized parameter maps onto. Normalized parameters are the source of
 * truth; transforms are derived from them, never the other way round.
 */

export const SEGMENT_PROFILE_IDS = [
  "capsule",
  "rounded_box",
  "flat_panel",
  "tapered_block",
  "cylinder",
  "cone_frustum",
  "soft_wedge",
] as const;

export type SegmentProfileId = (typeof SEGMENT_PROFILE_IDS)[number];

export interface SegmentFormState {
  /** 0..1 mapped to the segment's authored length range. */
  length: number;
  /** 0..1 mapped to the segment's authored width range. */
  width: number;
  /** 0..1 mapped to the segment's authored depth range. */
  depth: number;
  /** 0..1, squashes depth toward a panel without touching length or width. */
  flatten: number;
  /** -1..1, tip narrower (negative) or flared (positive) relative to the base. */
  taper: number;
  /** 0..1, profile edge softness. */
  roundness: number;
  /** -1..1 mapped to +/- the segment's authored twist range, in degrees. */
  twist: number;
  profileId: SegmentProfileId;
}

/** Authored bounds a segment's normalized parameters resolve against. */
export interface SegmentFormRange {
  readonly minLengthScale: number;
  readonly maxLengthScale: number;
  readonly minWidthScale: number;
  readonly maxWidthScale: number;
  readonly minDepthScale: number;
  readonly maxDepthScale: number;
  readonly maxTwistDeg: number;
  readonly defaultProfileId: SegmentProfileId;
}

/** Depth multiplier at `flatten = 1`. Keeps a flattened panel from reaching zero thickness. */
export const FLATTEN_MIN_DEPTH_SCALE = 0.12;

/** Tip scale offset at `taper = +/-1`, applied on top of the width and depth scales. */
export const TAPER_TIP_RANGE = 0.7;

/** Resolved, unnormalized form used by the solver and (later) the renderer. */
export interface ResolvedSegmentForm {
  lengthScale: number;
  widthScale: number;
  depthScale: number;
  /** Extra multiplier applied to width and depth at the segment tip. */
  tipScale: number;
  roundness: number;
  twistDeg: number;
  profileId: SegmentProfileId;
}

const SEGMENT_RANGES: Readonly<Record<SegmentBoneName, SegmentFormRange>> = {
  pelvis: {
    minLengthScale: 0.6,
    maxLengthScale: 2.0,
    minWidthScale: 0.6,
    maxWidthScale: 2.2,
    minDepthScale: 0.6,
    maxDepthScale: 2.2,
    maxTwistDeg: 45,
    defaultProfileId: "rounded_box",
  },
  torso_lower: {
    minLengthScale: 0.7,
    maxLengthScale: 2.2,
    minWidthScale: 0.6,
    maxWidthScale: 2.4,
    minDepthScale: 0.5,
    maxDepthScale: 2.4,
    maxTwistDeg: 60,
    defaultProfileId: "rounded_box",
  },
  torso_upper: {
    minLengthScale: 0.7,
    maxLengthScale: 2.2,
    minWidthScale: 0.6,
    maxWidthScale: 2.4,
    minDepthScale: 0.5,
    maxDepthScale: 2.4,
    maxTwistDeg: 60,
    defaultProfileId: "rounded_box",
  },
  neck: {
    minLengthScale: 0.4,
    maxLengthScale: 3.0,
    minWidthScale: 0.5,
    maxWidthScale: 1.8,
    minDepthScale: 0.5,
    maxDepthScale: 1.8,
    maxTwistDeg: 90,
    defaultProfileId: "cylinder",
  },
  head: {
    minLengthScale: 0.6,
    maxLengthScale: 1.8,
    minWidthScale: 0.6,
    maxWidthScale: 2.0,
    minDepthScale: 0.6,
    maxDepthScale: 2.0,
    maxTwistDeg: 45,
    defaultProfileId: "rounded_box",
  },
  shoulder_L: {
    minLengthScale: 0.5,
    maxLengthScale: 2.0,
    minWidthScale: 0.6,
    maxWidthScale: 1.8,
    minDepthScale: 0.6,
    maxDepthScale: 1.8,
    maxTwistDeg: 45,
    defaultProfileId: "capsule",
  },
  upperarm_L: {
    minLengthScale: 0.6,
    maxLengthScale: 2.4,
    minWidthScale: 0.5,
    maxWidthScale: 2.0,
    minDepthScale: 0.5,
    maxDepthScale: 2.0,
    maxTwistDeg: 60,
    defaultProfileId: "capsule",
  },
  forearm_L: {
    minLengthScale: 0.6,
    maxLengthScale: 2.4,
    minWidthScale: 0.5,
    maxWidthScale: 2.0,
    minDepthScale: 0.5,
    maxDepthScale: 2.0,
    maxTwistDeg: 60,
    defaultProfileId: "capsule",
  },
  hand_L: {
    minLengthScale: 0.5,
    maxLengthScale: 2.5,
    minWidthScale: 0.4,
    maxWidthScale: 3.0,
    minDepthScale: 0.3,
    maxDepthScale: 2.0,
    maxTwistDeg: 90,
    defaultProfileId: "flat_panel",
  },
  shoulder_R: {
    minLengthScale: 0.5,
    maxLengthScale: 2.0,
    minWidthScale: 0.6,
    maxWidthScale: 1.8,
    minDepthScale: 0.6,
    maxDepthScale: 1.8,
    maxTwistDeg: 45,
    defaultProfileId: "capsule",
  },
  upperarm_R: {
    minLengthScale: 0.6,
    maxLengthScale: 2.4,
    minWidthScale: 0.5,
    maxWidthScale: 2.0,
    minDepthScale: 0.5,
    maxDepthScale: 2.0,
    maxTwistDeg: 60,
    defaultProfileId: "capsule",
  },
  forearm_R: {
    minLengthScale: 0.6,
    maxLengthScale: 2.4,
    minWidthScale: 0.5,
    maxWidthScale: 2.0,
    minDepthScale: 0.5,
    maxDepthScale: 2.0,
    maxTwistDeg: 60,
    defaultProfileId: "capsule",
  },
  hand_R: {
    minLengthScale: 0.5,
    maxLengthScale: 2.5,
    minWidthScale: 0.4,
    maxWidthScale: 3.0,
    minDepthScale: 0.3,
    maxDepthScale: 2.0,
    maxTwistDeg: 90,
    defaultProfileId: "flat_panel",
  },
  thigh_L: {
    minLengthScale: 0.6,
    maxLengthScale: 2.2,
    minWidthScale: 0.5,
    maxWidthScale: 2.0,
    minDepthScale: 0.5,
    maxDepthScale: 2.0,
    maxTwistDeg: 60,
    defaultProfileId: "tapered_block",
  },
  shin_L: {
    minLengthScale: 0.6,
    maxLengthScale: 2.2,
    minWidthScale: 0.5,
    maxWidthScale: 2.0,
    minDepthScale: 0.5,
    maxDepthScale: 2.0,
    maxTwistDeg: 60,
    defaultProfileId: "tapered_block",
  },
  foot_L: {
    minLengthScale: 0.5,
    maxLengthScale: 2.5,
    minWidthScale: 0.5,
    maxWidthScale: 2.5,
    minDepthScale: 0.4,
    maxDepthScale: 2.0,
    maxTwistDeg: 45,
    defaultProfileId: "soft_wedge",
  },
  thigh_R: {
    minLengthScale: 0.6,
    maxLengthScale: 2.2,
    minWidthScale: 0.5,
    maxWidthScale: 2.0,
    minDepthScale: 0.5,
    maxDepthScale: 2.0,
    maxTwistDeg: 60,
    defaultProfileId: "tapered_block",
  },
  shin_R: {
    minLengthScale: 0.6,
    maxLengthScale: 2.2,
    minWidthScale: 0.5,
    maxWidthScale: 2.0,
    minDepthScale: 0.5,
    maxDepthScale: 2.0,
    maxTwistDeg: 60,
    defaultProfileId: "tapered_block",
  },
  foot_R: {
    minLengthScale: 0.5,
    maxLengthScale: 2.5,
    minWidthScale: 0.5,
    maxWidthScale: 2.5,
    minDepthScale: 0.4,
    maxDepthScale: 2.0,
    maxTwistDeg: 45,
    defaultProfileId: "soft_wedge",
  },
};

export function segmentRange(bone: SegmentBoneName): SegmentFormRange {
  return SEGMENT_RANGES[bone];
}

export function segmentRangeForSlot(slot: number): SegmentFormRange {
  const bone = SEGMENT_BONES[slot];
  if (bone === undefined) {
    throw new Error(`Segment slot ${slot} out of range`);
  }
  return SEGMENT_RANGES[bone];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function sanitize(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Maps a normalized 0..1 parameter onto a scale range geometrically, so equal
 * slider steps halve and double symmetrically instead of crowding the small end.
 */
function scaleFromNormalized(normalized: number, min: number, max: number): number {
  return min * Math.pow(max / min, clamp(sanitize(normalized, 0.5), 0, 1));
}

/** Normalized value that reproduces `scale`; the inverse of `scaleFromNormalized`. */
export function normalizedFromScale(scale: number, min: number, max: number): number {
  return clamp(Math.log(scale / min) / Math.log(max / min), 0, 1);
}

export function isSegmentProfileId(value: string): value is SegmentProfileId {
  return (SEGMENT_PROFILE_IDS as readonly string[]).includes(value);
}

/** The authored rest shape: every scale resolves to exactly 1. */
export function createDefaultSegmentForm(bone: SegmentBoneName): SegmentFormState {
  const range = SEGMENT_RANGES[bone];
  return {
    length: normalizedFromScale(1, range.minLengthScale, range.maxLengthScale),
    width: normalizedFromScale(1, range.minWidthScale, range.maxWidthScale),
    depth: normalizedFromScale(1, range.minDepthScale, range.maxDepthScale),
    flatten: 0,
    taper: 0,
    roundness: 0.5,
    twist: 0,
    profileId: range.defaultProfileId,
  };
}

export function createDefaultSegmentForms(): SegmentFormState[] {
  return SEGMENT_BONES.map((bone) => createDefaultSegmentForm(bone));
}

export function cloneSegmentForm(form: SegmentFormState): SegmentFormState {
  return {
    length: form.length,
    width: form.width,
    depth: form.depth,
    flatten: form.flatten,
    taper: form.taper,
    roundness: form.roundness,
    twist: form.twist,
    profileId: form.profileId,
  };
}

/**
 * Forces a form into its legal ranges in place, replacing non-finite values with
 * the neutral setting for that parameter.
 */
export function clampSegmentForm(form: SegmentFormState): SegmentFormState {
  form.length = clamp(sanitize(form.length, 0.5), 0, 1);
  form.width = clamp(sanitize(form.width, 0.5), 0, 1);
  form.depth = clamp(sanitize(form.depth, 0.5), 0, 1);
  form.flatten = clamp(sanitize(form.flatten, 0), 0, 1);
  form.taper = clamp(sanitize(form.taper, 0), -1, 1);
  form.roundness = clamp(sanitize(form.roundness, 0.5), 0, 1);
  form.twist = clamp(sanitize(form.twist, 0), -1, 1);
  if (!isSegmentProfileId(form.profileId)) {
    form.profileId = "capsule";
  }
  return form;
}

export function isValidSegmentForm(form: SegmentFormState): boolean {
  return (
    Number.isFinite(form.length) &&
    form.length >= 0 &&
    form.length <= 1 &&
    Number.isFinite(form.width) &&
    form.width >= 0 &&
    form.width <= 1 &&
    Number.isFinite(form.depth) &&
    form.depth >= 0 &&
    form.depth <= 1 &&
    Number.isFinite(form.flatten) &&
    form.flatten >= 0 &&
    form.flatten <= 1 &&
    Number.isFinite(form.taper) &&
    form.taper >= -1 &&
    form.taper <= 1 &&
    Number.isFinite(form.roundness) &&
    form.roundness >= 0 &&
    form.roundness <= 1 &&
    Number.isFinite(form.twist) &&
    form.twist >= -1 &&
    form.twist <= 1 &&
    isSegmentProfileId(form.profileId)
  );
}

/**
 * Resolves normalized parameters against a segment's authored range. Writes into
 * `out` so interaction-rate callers do not allocate.
 */
export function resolveSegmentForm(
  bone: SegmentBoneName,
  form: SegmentFormState,
  out: ResolvedSegmentForm,
): ResolvedSegmentForm {
  const range = SEGMENT_RANGES[bone];
  const flatten = clamp(sanitize(form.flatten, 0), 0, 1);
  out.lengthScale = scaleFromNormalized(form.length, range.minLengthScale, range.maxLengthScale);
  out.widthScale = scaleFromNormalized(form.width, range.minWidthScale, range.maxWidthScale);
  out.depthScale =
    scaleFromNormalized(form.depth, range.minDepthScale, range.maxDepthScale) *
    (1 + (FLATTEN_MIN_DEPTH_SCALE - 1) * flatten);
  out.tipScale = 1 + clamp(sanitize(form.taper, 0), -1, 1) * TAPER_TIP_RANGE;
  out.roundness = clamp(sanitize(form.roundness, 0.5), 0, 1);
  out.twistDeg = clamp(sanitize(form.twist, 0), -1, 1) * range.maxTwistDeg;
  out.profileId = isSegmentProfileId(form.profileId) ? form.profileId : range.defaultProfileId;
  return out;
}

export function createResolvedSegmentForm(): ResolvedSegmentForm {
  return {
    lengthScale: 1,
    widthScale: 1,
    depthScale: 1,
    tipScale: 1,
    roundness: 0.5,
    twistDeg: 0,
    profileId: "capsule",
  };
}
