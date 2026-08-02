import { PLAYER_HEIGHT_M } from "@foldseek/shared";
import { Quaternion, Vector3 } from "three";

/**
 * Mimic rig contract (bible §24.1) plus the joint-limit model used by the pose
 * solver (§7.9). Pure data and math: no scene graph, no renderer.
 *
 * Conventions:
 *  - +Y up, +Z forward, +X to the creature's left.
 *  - `localPosition` is the bone origin in its parent's local frame.
 *  - `axis` is the bone's own long axis in its own local frame, pointing at its
 *    tip. It is also the twist axis for swing/twist limit decomposition.
 *  - Rest pose is the "Upright" arrangement: standing, arms down, legs straight.
 */

export const RIG_VERSION = 1;

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

/** Below this squared magnitude a vector or quaternion vector part is treated as degenerate. */
const EPSILON_SQ = 1e-12;

/**
 * Standing height the bone table below is authored against, in its own units.
 * The proportions read far better at this size than in world metres, so they
 * are written out at creature scale and converted once.
 */
export const RIG_AUTHORED_HEIGHT = 1.1;

/**
 * World metres per authored unit. The shop keeps real furniture dimensions and
 * the player shrinks into it, so a body that stands 1.1 units tall in the table
 * below stands `PLAYER_HEIGHT_M` in the room. Everything that turns rig units
 * into scene geometry multiplies by this: the bone lengths and offsets here,
 * the shell cross-sections in `visual/MimicVisual.ts`, and the panel size range
 * in `panels.ts`. Pose data on the wire is unaffected, because segment forms are
 * unitless multipliers and the root position is already in world metres.
 */
export const RIG_TO_WORLD = PLAYER_HEIGHT_M / RIG_AUTHORED_HEIGHT;

export const BONE_NAMES = [
  "root",
  "pelvis",
  "torso_lower",
  "torso_upper",
  "neck",
  "head",
  "shoulder_L",
  "upperarm_L",
  "forearm_L",
  "hand_L",
  "shoulder_R",
  "upperarm_R",
  "forearm_R",
  "hand_R",
  "thigh_L",
  "shin_L",
  "foot_L",
  "thigh_R",
  "shin_R",
  "foot_R",
  "panel_socket_01",
  "panel_socket_02",
  "panel_socket_03",
  "panel_socket_04",
  "panel_socket_05",
  "panel_socket_06",
  "panel_socket_07",
  "panel_socket_08",
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

export const BONE_COUNT = BONE_NAMES.length;

/**
 * Panel sockets are parented to the segment they fold out of (§7.4 Layer 3),
 * not to the root. The §24.1 listing shows them under `root` as an example
 * hierarchy, but a panel that stays behind while its parent segment poses would
 * detach visually, which §24.4 forbids.
 */
export const PANEL_SOCKET_NAMES = [
  "panel_socket_01",
  "panel_socket_02",
  "panel_socket_03",
  "panel_socket_04",
  "panel_socket_05",
  "panel_socket_06",
  "panel_socket_07",
  "panel_socket_08",
] as const;

export type PanelSocketName = (typeof PANEL_SOCKET_NAMES)[number];

export const MAX_PANELS = PANEL_SOCKET_NAMES.length;

/** Bones that carry an editable shell, in DisguiseState.segments order. */
export const SEGMENT_BONES = [
  "pelvis",
  "torso_lower",
  "torso_upper",
  "neck",
  "head",
  "shoulder_L",
  "upperarm_L",
  "forearm_L",
  "hand_L",
  "shoulder_R",
  "upperarm_R",
  "forearm_R",
  "hand_R",
  "thigh_L",
  "shin_L",
  "foot_L",
  "thigh_R",
  "shin_R",
  "foot_R",
] as const;

export type SegmentBoneName = (typeof SEGMENT_BONES)[number];

export const SEGMENT_COUNT = SEGMENT_BONES.length;

export type Vector3Tuple = readonly [number, number, number];

/** Swing limited to a cone of `maxSwingDeg` half-angle around the bone axis. */
export interface ConeSwingLimit {
  readonly kind: "cone";
  readonly maxSwingDeg: number;
}

/**
 * Swing limited to a single rotation axis. Off-axis rotation is removed, so a
 * hinge joint ignores the twist range.
 */
export interface HingeSwingLimit {
  readonly kind: "hinge";
  readonly hingeAxis: Vector3Tuple;
  readonly minDeg: number;
  readonly maxDeg: number;
}

export type SwingLimit = ConeSwingLimit | HingeSwingLimit;

export interface JointLimit {
  readonly swing: SwingLimit;
  readonly twistMinDeg: number;
  readonly twistMaxDeg: number;
  /**
   * 0 follows the IK target freely, 1 refuses to move. A bone's stiffness damps
   * the joint its rotation places, so the last bone of a chain carries none: its
   * joint is the end effector, which must reach the target.
   */
  readonly stiffness: number;
}

export interface BoneDef {
  readonly name: BoneName;
  readonly index: number;
  readonly parent: BoneName | null;
  readonly parentIndex: number;
  readonly localPosition: Vector3Tuple;
  readonly axis: Vector3Tuple;
  readonly length: number;
  readonly limit: JointLimit;
}

interface BoneSource {
  readonly name: BoneName;
  readonly parent: BoneName | null;
  readonly localPosition: Vector3Tuple;
  readonly axis: Vector3Tuple;
  readonly length: number;
  readonly limit: JointLimit;
}

function cone(maxSwingDeg: number, twistDeg: number, stiffness: number): JointLimit {
  return {
    swing: { kind: "cone", maxSwingDeg },
    twistMinDeg: -twistDeg,
    twistMaxDeg: twistDeg,
    stiffness,
  };
}

function hinge(hingeAxis: Vector3Tuple, minDeg: number, maxDeg: number): JointLimit {
  return {
    swing: { kind: "hinge", hingeAxis, minDeg, maxDeg },
    twistMinDeg: 0,
    twistMaxDeg: 0,
    stiffness: 0,
  };
}

/**
 * Authored proportions for a ~1.10 m creature. Head pod tip reaches y = 1.10 in
 * the rest pose: compact torso, oversized head, sturdy short limbs.
 *
 * Mirrored bones repeat the left-side numbers with x negated. A rotation about
 * axis a on the left maps to a rotation about (a.x, -a.y, -a.z) on the right, so
 * the pure-X elbow and knee hinges keep their axis and range unchanged.
 */
const BONE_SOURCES: readonly BoneSource[] = [
  {
    name: "root",
    parent: null,
    localPosition: [0, 0, 0],
    axis: [0, 1, 0],
    length: 0.5,
    limit: cone(180, 180, 0),
  },
  {
    name: "pelvis",
    parent: "root",
    localPosition: [0, 0.5, 0],
    axis: [0, 1, 0],
    length: 0.06,
    limit: cone(38, 40, 0.35),
  },
  {
    name: "torso_lower",
    parent: "pelvis",
    localPosition: [0, 0.06, 0],
    axis: [0, 1, 0],
    length: 0.13,
    limit: cone(45, 45, 0),
  },
  {
    name: "torso_upper",
    parent: "torso_lower",
    localPosition: [0, 0.13, 0],
    axis: [0, 1, 0],
    length: 0.17,
    limit: cone(45, 45, 0.25),
  },
  {
    name: "neck",
    parent: "torso_upper",
    localPosition: [0, 0.17, 0],
    axis: [0, 1, 0],
    length: 0.05,
    limit: cone(55, 60, 0),
  },
  {
    name: "head",
    parent: "neck",
    localPosition: [0, 0.05, 0],
    axis: [0, 1, 0],
    length: 0.19,
    limit: cone(45, 50, 0),
  },

  {
    name: "shoulder_L",
    parent: "torso_upper",
    localPosition: [0.05, 0.13, 0],
    axis: [1, 0, 0],
    length: 0.08,
    limit: cone(45, 30, 0.2),
  },
  {
    name: "upperarm_L",
    parent: "shoulder_L",
    localPosition: [0.08, 0, 0],
    axis: [0, -1, 0],
    length: 0.19,
    limit: cone(150, 90, 0),
  },
  {
    name: "forearm_L",
    parent: "upperarm_L",
    localPosition: [0, -0.19, 0],
    axis: [0, -1, 0],
    length: 0.17,
    limit: hinge([1, 0, 0], -150, 2),
  },
  {
    name: "hand_L",
    parent: "forearm_L",
    localPosition: [0, -0.17, 0],
    axis: [0, -1, 0],
    length: 0.09,
    limit: cone(80, 90, 0),
  },

  {
    name: "shoulder_R",
    parent: "torso_upper",
    localPosition: [-0.05, 0.13, 0],
    axis: [-1, 0, 0],
    length: 0.08,
    limit: cone(45, 30, 0.2),
  },
  {
    name: "upperarm_R",
    parent: "shoulder_R",
    localPosition: [-0.08, 0, 0],
    axis: [0, -1, 0],
    length: 0.19,
    limit: cone(150, 90, 0),
  },
  {
    name: "forearm_R",
    parent: "upperarm_R",
    localPosition: [0, -0.19, 0],
    axis: [0, -1, 0],
    length: 0.17,
    limit: hinge([1, 0, 0], -150, 2),
  },
  {
    name: "hand_R",
    parent: "forearm_R",
    localPosition: [0, -0.17, 0],
    axis: [0, -1, 0],
    length: 0.09,
    limit: cone(80, 90, 0),
  },

  {
    name: "thigh_L",
    parent: "pelvis",
    localPosition: [0.085, -0.02, 0],
    axis: [0, -1, 0],
    length: 0.24,
    limit: cone(120, 60, 0),
  },
  {
    name: "shin_L",
    parent: "thigh_L",
    localPosition: [0, -0.24, 0],
    axis: [0, -1, 0],
    length: 0.19,
    limit: hinge([1, 0, 0], -2, 150),
  },
  {
    name: "foot_L",
    parent: "shin_L",
    localPosition: [0, -0.19, 0],
    axis: [0, 0, 1],
    length: 0.13,
    limit: cone(55, 25, 0),
  },

  {
    name: "thigh_R",
    parent: "pelvis",
    localPosition: [-0.085, -0.02, 0],
    axis: [0, -1, 0],
    length: 0.24,
    limit: cone(120, 60, 0),
  },
  {
    name: "shin_R",
    parent: "thigh_R",
    localPosition: [0, -0.24, 0],
    axis: [0, -1, 0],
    length: 0.19,
    limit: hinge([1, 0, 0], -2, 150),
  },
  {
    name: "foot_R",
    parent: "shin_R",
    localPosition: [0, -0.19, 0],
    axis: [0, 0, 1],
    length: 0.13,
    limit: cone(55, 25, 0),
  },

  {
    name: "panel_socket_01",
    parent: "torso_upper",
    localPosition: [0, 0.09, -0.055],
    axis: [0, 0, -1],
    length: 0.02,
    limit: cone(90, 180, 1),
  },
  {
    name: "panel_socket_02",
    parent: "torso_upper",
    localPosition: [0, 0.09, 0.055],
    axis: [0, 0, 1],
    length: 0.02,
    limit: cone(90, 180, 1),
  },
  {
    name: "panel_socket_03",
    parent: "torso_lower",
    localPosition: [0.07, 0.06, 0],
    axis: [1, 0, 0],
    length: 0.02,
    limit: cone(90, 180, 1),
  },
  {
    name: "panel_socket_04",
    parent: "torso_lower",
    localPosition: [-0.07, 0.06, 0],
    axis: [-1, 0, 0],
    length: 0.02,
    limit: cone(90, 180, 1),
  },
  {
    name: "panel_socket_05",
    parent: "thigh_L",
    localPosition: [0.05, -0.12, 0],
    axis: [1, 0, 0],
    length: 0.02,
    limit: cone(90, 180, 1),
  },
  {
    name: "panel_socket_06",
    parent: "thigh_R",
    localPosition: [-0.05, -0.12, 0],
    axis: [-1, 0, 0],
    length: 0.02,
    limit: cone(90, 180, 1),
  },
  {
    name: "panel_socket_07",
    parent: "forearm_L",
    localPosition: [0.04, -0.085, 0],
    axis: [1, 0, 0],
    length: 0.02,
    limit: cone(90, 180, 1),
  },
  {
    name: "panel_socket_08",
    parent: "forearm_R",
    localPosition: [-0.04, -0.085, 0],
    axis: [-1, 0, 0],
    length: 0.02,
    limit: cone(90, 180, 1),
  },
];

const boneIndexByName = new Map<string, number>();
for (let i = 0; i < BONE_NAMES.length; i++) {
  boneIndexByName.set(BONE_NAMES[i]!, i);
}

/** Index of a bone in `BONE_NAMES`, or -1 when the name is not part of the rig. */
export function boneIndex(name: string): number {
  const index = boneIndexByName.get(name);
  return index === undefined ? -1 : index;
}

export function isBoneName(name: string): name is BoneName {
  return boneIndexByName.has(name);
}

export const BONES: readonly BoneDef[] = BONE_SOURCES.map((source, index) => {
  if (source.name !== BONE_NAMES[index]) {
    throw new Error(`Rig bone table out of order at ${index}: ${source.name}`);
  }
  const parentIndex = source.parent === null ? -1 : boneIndex(source.parent);
  if (source.parent !== null && parentIndex >= index) {
    throw new Error(`Bone ${source.name} must appear after its parent ${source.parent}`);
  }
  // The one place authored units become world metres. Angles, axes and limits
  // are dimensionless and pass through untouched.
  return {
    name: source.name,
    index,
    parent: source.parent,
    parentIndex,
    localPosition: [
      source.localPosition[0] * RIG_TO_WORLD,
      source.localPosition[1] * RIG_TO_WORLD,
      source.localPosition[2] * RIG_TO_WORLD,
    ],
    axis: source.axis,
    length: source.length * RIG_TO_WORLD,
    limit: source.limit,
  };
});

export function getBone(index: number): BoneDef {
  const bone = BONES[index];
  if (bone === undefined) {
    throw new Error(`Bone index ${index} out of range`);
  }
  return bone;
}

/** Rest offsets as vectors, ready to be reused without allocating. */
export const BONE_REST_OFFSETS: readonly Vector3[] = BONES.map(
  (bone) => new Vector3(bone.localPosition[0], bone.localPosition[1], bone.localPosition[2]),
);

export const BONE_AXES: readonly Vector3[] = BONES.map((bone) =>
  new Vector3(bone.axis[0], bone.axis[1], bone.axis[2]).normalize(),
);

const HINGE_AXES: readonly Vector3[] = BONES.map((bone) =>
  bone.limit.swing.kind === "hinge"
    ? new Vector3(
        bone.limit.swing.hingeAxis[0],
        bone.limit.swing.hingeAxis[1],
        bone.limit.swing.hingeAxis[2],
      ).normalize()
    : new Vector3(1, 0, 0),
);

/** Children of each bone, in rig declaration order. */
export const BONE_CHILDREN: readonly (readonly number[])[] = (() => {
  const children: number[][] = BONES.map(() => []);
  for (const bone of BONES) {
    if (bone.parentIndex >= 0) {
      children[bone.parentIndex]!.push(bone.index);
    }
  }
  return children;
})();

const segmentSlotByBone = new Int32Array(BONE_COUNT).fill(-1);
export const SEGMENT_BONE_INDICES: readonly number[] = SEGMENT_BONES.map((name, slot) => {
  const index = boneIndex(name);
  segmentSlotByBone[index] = slot;
  return index;
});

/** DisguiseState.segments slot for a bone, or -1 when the bone carries no shell. */
export function segmentSlotOfBone(index: number): number {
  return segmentSlotByBone[index] ?? -1;
}

export function segmentSlotOfBoneName(name: SegmentBoneName): number {
  return segmentSlotOfBone(boneIndex(name));
}

/** Total rest height of the creature, from root to the tip of the head pod. */
export const REST_HEIGHT = (() => {
  let height = 0;
  for (const name of ["pelvis", "torso_lower", "torso_upper", "neck", "head"] as const) {
    const bone = getBone(boneIndex(name));
    height += bone.localPosition[1];
  }
  const head = getBone(boneIndex("head"));
  return height + head.length;
})();

// --- Joint limit math -------------------------------------------------------

const swingScratch = new Quaternion();
const twistScratch = new Quaternion();
const twistInverseScratch = new Quaternion();
const axisScratch = new Vector3();

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Rotation angle of a quaternion in [0, PI], assuming w >= 0. */
function quaternionAngle(q: Quaternion): number {
  const vectorLength = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z);
  return 2 * Math.atan2(vectorLength, q.w);
}

/**
 * Signed rotation angle of `q` about `axis`, in (-PI, PI]. This is the twist
 * term of the swing/twist decomposition and is unaffected by the swing term
 * because both share the same scalar part.
 */
function twistAngleAbout(q: Quaternion, axis: Vector3): number {
  const projection = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  return 2 * Math.atan2(projection, q.w);
}

/** Splits `q` (with w >= 0) into `q = swing * twist` about `axis`. */
function decomposeSwingTwist(
  q: Quaternion,
  axis: Vector3,
  swing: Quaternion,
  twist: Quaternion,
): void {
  const projection = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  twist.set(axis.x * projection, axis.y * projection, axis.z * projection, q.w);
  if (twist.lengthSq() < EPSILON_SQ) {
    twist.set(0, 0, 0, 1);
  } else {
    twist.normalize();
  }
  twistInverseScratch.copy(twist).invert();
  swing.copy(q).multiply(twistInverseScratch);
  if (swing.w < 0) {
    swing.set(-swing.x, -swing.y, -swing.z, -swing.w);
  }
}

/** Puts a quaternion in its w >= 0 representative so angle math is single-valued. */
function canonicalize(q: Quaternion): void {
  if (q.w < 0) {
    q.set(-q.x, -q.y, -q.z, -q.w);
  }
}

/**
 * Projects `q` onto the legal range of a bone's joint, in place. Cone joints
 * keep their twist within range and their swing within the cone; hinge joints
 * collapse to a single-axis rotation with a clamped angle.
 */
export function clampBoneRotation(index: number, q: Quaternion): void {
  const limit = getBone(index).limit;
  q.normalize();
  canonicalize(q);

  if (limit.swing.kind === "hinge") {
    const hingeAxis = HINGE_AXES[index]!;
    const angle = clamp(
      twistAngleAbout(q, hingeAxis),
      limit.swing.minDeg * DEG_TO_RAD,
      limit.swing.maxDeg * DEG_TO_RAD,
    );
    q.setFromAxisAngle(hingeAxis, angle);
    return;
  }

  const boneAxis = BONE_AXES[index]!;
  decomposeSwingTwist(q, boneAxis, swingScratch, twistScratch);

  const maxSwing = limit.swing.maxSwingDeg * DEG_TO_RAD;
  const swingAngle = quaternionAngle(swingScratch);
  if (swingAngle > maxSwing) {
    axisScratch.set(swingScratch.x, swingScratch.y, swingScratch.z);
    if (axisScratch.lengthSq() > EPSILON_SQ) {
      axisScratch.normalize();
      swingScratch.setFromAxisAngle(axisScratch, maxSwing);
    } else {
      swingScratch.identity();
    }
  }

  const twistAngle = twistAngleAbout(twistScratch, boneAxis);
  const clampedTwist = clamp(
    twistAngle,
    limit.twistMinDeg * DEG_TO_RAD,
    limit.twistMaxDeg * DEG_TO_RAD,
  );
  if (clampedTwist !== twistAngle) {
    twistScratch.setFromAxisAngle(boneAxis, clampedTwist);
  }

  q.copy(swingScratch).multiply(twistScratch).normalize();
}

const violationScratch = new Quaternion();

/**
 * Radians by which `q` exceeds the bone's joint limit, or 0 when legal. For a
 * hinge this includes any rotation that leaves the hinge axis.
 */
export function boneRotationViolation(index: number, q: Quaternion): number {
  const limit = getBone(index).limit;
  violationScratch.copy(q).normalize();
  canonicalize(violationScratch);

  if (limit.swing.kind === "hinge") {
    const hingeAxis = HINGE_AXES[index]!;
    decomposeSwingTwist(violationScratch, hingeAxis, swingScratch, twistScratch);
    const offAxis = quaternionAngle(swingScratch);
    const angle = twistAngleAbout(twistScratch, hingeAxis);
    const minRad = limit.swing.minDeg * DEG_TO_RAD;
    const maxRad = limit.swing.maxDeg * DEG_TO_RAD;
    const rangeExcess = Math.max(minRad - angle, angle - maxRad, 0);
    return Math.max(offAxis, rangeExcess);
  }

  const boneAxis = BONE_AXES[index]!;
  decomposeSwingTwist(violationScratch, boneAxis, swingScratch, twistScratch);
  const swingExcess = quaternionAngle(swingScratch) - limit.swing.maxSwingDeg * DEG_TO_RAD;
  const twistAngle = twistAngleAbout(twistScratch, boneAxis);
  const twistExcess = Math.max(
    limit.twistMinDeg * DEG_TO_RAD - twistAngle,
    twistAngle - limit.twistMaxDeg * DEG_TO_RAD,
    0,
  );
  return Math.max(swingExcess, twistExcess, 0);
}
