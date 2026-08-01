import { Quaternion, Vector3 } from "three";

import {
  BONES,
  BONE_COUNT,
  BONE_REST_OFFSETS,
  boneIndex,
  clampBoneRotation,
  DEG_TO_RAD,
  getBone,
  segmentSlotOfBone,
  SEGMENT_BONES,
  type BoneName,
} from "./rig";
import {
  clampSegmentForm,
  createDefaultSegmentForms,
  createResolvedSegmentForm,
  resolveSegmentForm,
  type ResolvedSegmentForm,
  type SegmentFormState,
} from "./segmentForm";

/**
 * Deterministic constrained pose solver (bible §7.9).
 *
 * Limb chains use FABRIK on joint positions, then retarget those positions back
 * onto bone rotations and clamp every rotation to its joint limit. Because the
 * clamp-then-forward-kinematics step is the last thing that runs, the returned
 * pose always satisfies the joint limits, even when the target is unreachable.
 *
 * The solver never reads the clock or a random source, so identical inputs
 * always produce identical output.
 */

export const MAX_IK_ITERATIONS = 8;

/** Inner FABRIK passes per outer iteration. */
const FABRIK_PASSES = 6;

/**
 * Inner passes per outer iteration for a limb. Aiming the leading bones and
 * solving the analytic tail are coupled, so a couple of cheap repetitions buy
 * most of what extra outer iterations would.
 */
const LIMB_PASSES = 3;

/** Convergence distance in metres. */
export const IK_TOLERANCE = 0.002;

const EPSILON_SQ = 1e-14;

/** Longest chain is shoulder -> upperarm -> forearm; the effector adds one joint. */
const MAX_CHAIN_BONES = 3;

export type IkTargetName =
  | "head"
  | "chest"
  | "pelvis"
  | "hand_L"
  | "hand_R"
  | "foot_L"
  | "foot_R";

export const IK_TARGET_NAMES: readonly IkTargetName[] = [
  "pelvis",
  "chest",
  "head",
  "hand_L",
  "hand_R",
  "foot_L",
  "foot_R",
];

export type IkTargets = { readonly [K in IkTargetName]?: Vector3 };

export interface PoseState {
  readonly rootPosition: Vector3;
  readonly rootRotation: Quaternion;
  /** Local rotation per bone, indexed by bone index. */
  readonly localRotations: readonly Quaternion[];
  /** Editable form per segment, indexed by DisguiseState segment slot. */
  readonly segments: SegmentFormState[];
  /** Derived: authored ranges applied to `segments`. */
  readonly resolvedSegments: readonly ResolvedSegmentForm[];
  /** Derived: rest offsets scaled by the parent segment's form. */
  readonly effectiveOffsets: readonly Vector3[];
  /** Derived: bone tip length scaled by the bone's own form. */
  readonly effectiveLengths: Float64Array;
  /** Derived by `updateWorldTransforms`. */
  readonly worldPositions: readonly Vector3[];
  readonly worldRotations: readonly Quaternion[];
}

export interface IkSolveReport {
  iterations: number;
  converged: boolean;
  maxError: number;
  errors: Partial<Record<IkTargetName, number>>;
}

export interface IkSolveOptions {
  maxIterations?: number;
  tolerance?: number;
  /** Reused across calls to keep interaction-rate solving allocation-free. */
  report?: IkSolveReport;
}

// --- Rig metric helpers -----------------------------------------------------

/**
 * Which local axis a bone's form parameters apply to. A bone stretches along its
 * own long axis; the other two axes carry width and depth. Every rig axis is
 * cardinal, so this is an exact component mapping rather than an approximation.
 */
const AXIS_DOMINANT: readonly number[] = BONES.map((bone) => {
  const absX = Math.abs(bone.axis[0]);
  const absY = Math.abs(bone.axis[1]);
  const absZ = Math.abs(bone.axis[2]);
  if (absX >= absY && absX >= absZ) return 0;
  if (absY >= absZ) return 1;
  return 2;
});

const scaleScratch = new Vector3();

/** Per-axis scale of `bone`'s shell, ordered x, y, z in the bone's local frame. */
function boneAxisScale(form: ResolvedSegmentForm, dominant: number, out: Vector3): Vector3 {
  if (dominant === 0) {
    out.set(form.lengthScale, form.widthScale, form.depthScale);
  } else if (dominant === 1) {
    out.set(form.widthScale, form.lengthScale, form.depthScale);
  } else {
    out.set(form.widthScale, form.depthScale, form.lengthScale);
  }
  return out;
}

/**
 * Recomputes everything the solver derives from segment forms. Call after any
 * form edit; `solveIK` calls it for you.
 */
export function refreshRigMetrics(pose: PoseState): void {
  for (let slot = 0; slot < pose.segments.length; slot++) {
    const bone = SEGMENT_BONES[slot];
    if (bone === undefined) continue;
    const form = pose.segments[slot]!;
    clampSegmentForm(form);
    resolveSegmentForm(bone, form, pose.resolvedSegments[slot]!);
  }

  for (let i = 0; i < BONE_COUNT; i++) {
    const bone = getBone(i);
    const rest = BONE_REST_OFFSETS[i]!;
    const offset = pose.effectiveOffsets[i]!;
    const parentSlot = bone.parentIndex >= 0 ? segmentSlotOfBone(bone.parentIndex) : -1;
    if (parentSlot < 0) {
      offset.copy(rest);
    } else {
      const parentForm = pose.resolvedSegments[parentSlot]!;
      boneAxisScale(parentForm, AXIS_DOMINANT[bone.parentIndex]!, scaleScratch);
      offset.set(rest.x * scaleScratch.x, rest.y * scaleScratch.y, rest.z * scaleScratch.z);
    }

    const ownSlot = segmentSlotOfBone(i);
    pose.effectiveLengths[i] =
      ownSlot < 0 ? bone.length : bone.length * pose.resolvedSegments[ownSlot]!.lengthScale;
  }
}

export function createPoseState(): PoseState {
  const pose: PoseState = {
    rootPosition: new Vector3(),
    rootRotation: new Quaternion(),
    localRotations: BONES.map(() => new Quaternion()),
    segments: createDefaultSegmentForms(),
    resolvedSegments: SEGMENT_BONES.map(() => createResolvedSegmentForm()),
    effectiveOffsets: BONES.map(() => new Vector3()),
    effectiveLengths: new Float64Array(BONE_COUNT),
    worldPositions: BONES.map(() => new Vector3()),
    worldRotations: BONES.map(() => new Quaternion()),
  };
  refreshRigMetrics(pose);
  updateWorldTransforms(pose);
  return pose;
}

/** Forward kinematics for the whole rig. Bones are declared parent-first. */
export function updateWorldTransforms(pose: PoseState): void {
  pose.worldPositions[0]!.copy(pose.rootPosition);
  pose.worldRotations[0]!.copy(pose.rootRotation).multiply(pose.localRotations[0]!);

  for (let i = 1; i < BONE_COUNT; i++) {
    const parentIndex = getBone(i).parentIndex;
    const parentRotation = pose.worldRotations[parentIndex]!;
    pose.worldRotations[i]!.copy(parentRotation).multiply(pose.localRotations[i]!);
    pose.worldPositions[i]!
      .copy(pose.effectiveOffsets[i]!)
      .applyQuaternion(parentRotation)
      .add(pose.worldPositions[parentIndex]!);
  }
}

/** World position of a bone's tip, written into `out`. */
export function boneTipWorld(pose: PoseState, index: number, out: Vector3): Vector3 {
  const bone = getBone(index);
  return out
    .set(bone.axis[0], bone.axis[1], bone.axis[2])
    .multiplyScalar(pose.effectiveLengths[index]!)
    .applyQuaternion(pose.worldRotations[index]!)
    .add(pose.worldPositions[index]!);
}

export function enforceJointLimits(pose: PoseState): void {
  for (let i = 1; i < BONE_COUNT; i++) {
    clampBoneRotation(i, pose.localRotations[i]!);
  }
}

// --- Chain definitions ------------------------------------------------------

interface IkChain {
  readonly id: string;
  readonly target: IkTargetName;
  /** Rotating bones, root first. Each bone's parent is the previous entry. */
  readonly bones: readonly number[];
  /** Bone whose origin is driven onto the target. Its parent is the last chain bone. */
  readonly effector: number;
  /**
   * Solve the last two bones analytically. Required wherever the middle joint is
   * a hinge: FABRIK picks a bend plane freely, and clamping that back onto a
   * single hinge axis throws away most of the solution.
   */
  readonly analyticTail: boolean;
}

function chain(
  id: string,
  target: IkTargetName,
  boneNames: readonly BoneName[],
  effector: BoneName,
  analyticTail: boolean,
): IkChain {
  const bones = boneNames.map((name) => boneIndex(name));
  const effectorIndex = boneIndex(effector);
  const ordered = [...bones, effectorIndex];
  for (let k = 1; k < ordered.length; k++) {
    const child = getBone(ordered[k]!);
    if (child.parentIndex !== ordered[k - 1]) {
      throw new Error(`IK chain ${id} is not contiguous at ${child.name}`);
    }
  }
  return {
    id,
    target,
    bones,
    effector: effectorIndex,
    analyticTail,
  };
}

/**
 * Fixed solve order: the spine settles before the limbs that hang off it, and
 * left always precedes right, so the result never depends on iteration order.
 */
export const IK_CHAINS: readonly IkChain[] = [
  chain("spine_lower", "chest", ["pelvis", "torso_lower"], "torso_upper", false),
  chain("spine_upper", "head", ["torso_upper", "neck"], "head", false),
  chain("arm_L", "hand_L", ["shoulder_L", "upperarm_L", "forearm_L"], "hand_L", true),
  chain("arm_R", "hand_R", ["shoulder_R", "upperarm_R", "forearm_R"], "hand_R", true),
  chain("leg_L", "foot_L", ["thigh_L", "shin_L"], "foot_L", true),
  chain("leg_R", "foot_R", ["thigh_R", "shin_R"], "foot_R", true),
];

// --- Solver scratch ---------------------------------------------------------

const jointPositions: Vector3[] = [];
const previousPositions: Vector3[] = [];
const fallbackDirections: Vector3[] = [];
for (let i = 0; i <= MAX_CHAIN_BONES; i++) {
  jointPositions.push(new Vector3());
  previousPositions.push(new Vector3());
  fallbackDirections.push(new Vector3(0, 1, 0));
}
const linkLengths = new Float64Array(MAX_CHAIN_BONES);

const chainBase = new Vector3();
const dirScratch = new Vector3();
const reverseFallback = new Vector3();
const linkFirst = new Vector3();
const linkSecond = new Vector3();
const hingeAxis = new Vector3();
const hingeCross = new Vector3();
const tailVector = new Vector3();
const localDirScratch = new Vector3();
const currentDirScratch = new Vector3();
const desiredDirScratch = new Vector3();
const deltaRotation = new Quaternion();
const worldRotationScratch = new Quaternion();
const localRotationScratch = new Quaternion();
const parentInverse = new Quaternion();
const pelvisOffsetScratch = new Vector3();

/** Normalizes `v` in place, substituting `fallback` when it is degenerate. */
function safeNormalize(v: Vector3, fallback: Vector3): Vector3 {
  const lengthSq = v.lengthSq();
  if (!Number.isFinite(lengthSq) || lengthSq < EPSILON_SQ) {
    return v.copy(fallback);
  }
  return v.multiplyScalar(1 / Math.sqrt(lengthSq));
}

/** Any unit vector perpendicular to `v`, written into `out`. */
function perpendicularTo(v: Vector3, out: Vector3): Vector3 {
  if (Math.abs(v.y) < 0.9) {
    out.set(0, 1, 0);
  } else {
    out.set(1, 0, 0);
  }
  out.addScaledVector(v, -out.dot(v));
  const lengthSq = out.lengthSq();
  if (lengthSq < EPSILON_SQ) {
    return out.set(1, 0, 0);
  }
  return out.multiplyScalar(1 / Math.sqrt(lengthSq));
}

function solveFabrik(jointCount: number, target: Vector3, tolerance: number): void {
  const last = jointCount - 1;
  for (let pass = 0; pass < FABRIK_PASSES; pass++) {
    if (jointPositions[last]!.distanceToSquared(target) < tolerance * tolerance) {
      return;
    }

    jointPositions[last]!.copy(target);
    for (let k = last - 1; k >= 0; k--) {
      dirScratch.copy(jointPositions[k]!).sub(jointPositions[k + 1]!);
      reverseFallback.copy(fallbackDirections[k]!).negate();
      safeNormalize(dirScratch, reverseFallback);
      jointPositions[k]!.copy(jointPositions[k + 1]!).addScaledVector(dirScratch, linkLengths[k]!);
    }

    jointPositions[0]!.copy(chainBase);
    for (let k = 1; k < jointCount; k++) {
      dirScratch.copy(jointPositions[k]!).sub(jointPositions[k - 1]!);
      safeNormalize(dirScratch, fallbackDirections[k - 1]!);
      jointPositions[k]!.copy(jointPositions[k - 1]!).addScaledVector(dirScratch, linkLengths[k - 1]!);
    }
  }
}

/** Wraps an angle into (-PI, PI]. */
function wrapAngle(angle: number): number {
  const wrapped = angle % (2 * Math.PI);
  if (wrapped > Math.PI) return wrapped - 2 * Math.PI;
  if (wrapped <= -Math.PI) return wrapped + 2 * Math.PI;
  return wrapped;
}

/**
 * Analytic solve for the last two bones of a limb, working in rotation space.
 *
 * Solving this pair as positions and retargeting afterwards does not work when
 * the middle joint is a hinge: the bend plane a position solve picks is not the
 * plane the hinge axis defines, so clamping moves the effector off target. Here
 * the hinge angle is solved directly from the reach equation, and the parent
 * bone is then aimed so the resulting two-link vector points at the target. The
 * effector lands exactly on a reachable target and the hinge is legal by
 * construction.
 */
function solveTwoBoneTail(pose: PoseState, ik: IkChain, target: Vector3, start: number): void {
  const boneCount = ik.bones.length;
  const parentBone = ik.bones[start]!;
  const hingeBone = ik.bones[start + 1]!;
  const tipBone = start + 2 < boneCount ? ik.bones[start + 2]! : ik.effector;

  const upper = pose.effectiveOffsets[hingeBone]!.length();
  const lower = pose.effectiveOffsets[tipBone]!.length();
  if (upper < 1e-9 || lower < 1e-9) return;

  linkFirst.copy(pose.effectiveOffsets[hingeBone]!).multiplyScalar(1 / upper);
  linkSecond.copy(pose.effectiveOffsets[tipBone]!).multiplyScalar(1 / lower);

  const limit = getBone(hingeBone).limit.swing;
  if (limit.kind === "hinge") {
    hingeAxis.set(limit.hingeAxis[0], limit.hingeAxis[1], limit.hingeAxis[2]).normalize();
  } else {
    // A cone middle joint has no preferred plane; bend it about the axis
    // perpendicular to both links, which reproduces the classic elbow plane.
    hingeAxis.copy(linkFirst).cross(linkSecond);
    if (hingeAxis.lengthSq() < EPSILON_SQ) {
      perpendicularTo(linkFirst, hingeAxis);
    } else {
      hingeAxis.normalize();
    }
  }

  // |first * upper + R(theta) * second * lower| = distance expands to
  // (A - C) cos(theta) + B sin(theta) = K, a single sinusoid in theta.
  const distance = target.distanceTo(pose.worldPositions[parentBone]!);
  hingeCross.copy(hingeAxis).cross(linkSecond);
  const a = linkFirst.dot(linkSecond);
  const b = linkFirst.dot(hingeCross);
  const c = linkFirst.dot(hingeAxis) * hingeAxis.dot(linkSecond);
  const amplitude = Math.hypot(a - c, b);
  const phase = Math.atan2(b, a - c);
  const requested = (distance * distance - upper * upper - lower * lower) / (2 * upper * lower) - c;

  const current = currentHingeAngle(pose, hingeBone, hingeAxis);
  let angle = current;
  if (amplitude > 1e-9) {
    const offset = Math.acos(Math.min(1, Math.max(-1, requested / amplitude)));
    angle = chooseHingeAngle(
      wrapAngle(phase + offset),
      wrapAngle(phase - offset),
      current,
      hingeBone,
    );
  }

  pose.localRotations[hingeBone]!.setFromAxisAngle(hingeAxis, angle);
  clampBoneRotation(hingeBone, pose.localRotations[hingeBone]!);

  // Aim the parent bone so the two-link vector points at the target.
  tailVector
    .copy(linkSecond)
    .multiplyScalar(lower)
    .applyQuaternion(pose.localRotations[hingeBone]!)
    .addScaledVector(linkFirst, upper);
  const tailLength = tailVector.length();
  if (tailLength < 1e-9) return;
  tailVector.multiplyScalar(1 / tailLength);

  desiredDirScratch.copy(target).sub(pose.worldPositions[parentBone]!);
  safeNormalize(desiredDirScratch, fallbackDirections[start]!);
  currentDirScratch.copy(tailVector).applyQuaternion(pose.worldRotations[parentBone]!);

  const parentIndex = getBone(parentBone).parentIndex;
  const parentRotation = pose.worldRotations[parentIndex]!;
  deltaRotation.setFromUnitVectors(currentDirScratch, desiredDirScratch);
  worldRotationScratch.copy(deltaRotation).multiply(pose.worldRotations[parentBone]!);
  parentInverse.copy(parentRotation).invert();
  localRotationScratch.copy(parentInverse).multiply(worldRotationScratch);
  clampBoneRotation(parentBone, localRotationScratch);
  pose.localRotations[parentBone]!.copy(localRotationScratch);
}

/** Signed rotation of a bone's current local quaternion about `axis`. */
function currentHingeAngle(pose: PoseState, bone: number, axis: Vector3): number {
  const rotation = pose.localRotations[bone]!;
  const sign = rotation.w < 0 ? -1 : 1;
  const projection =
    (rotation.x * axis.x + rotation.y * axis.y + rotation.z * axis.z) * sign;
  return 2 * Math.atan2(projection, rotation.w * sign);
}

/**
 * The reach equation has two roots, mirror images across the bend plane. Prefer
 * the one the joint can legally hold, then the one nearest the current angle so
 * the limb does not flip between frames.
 */
function chooseHingeAngle(
  first: number,
  second: number,
  current: number,
  bone: number,
): number {
  const limit = getBone(bone).limit.swing;
  if (limit.kind !== "hinge") {
    return Math.abs(first - current) <= Math.abs(second - current) ? first : second;
  }
  const min = limit.minDeg * DEG_TO_RAD;
  const max = limit.maxDeg * DEG_TO_RAD;
  const firstExcess = Math.max(min - first, first - max, 0);
  const secondExcess = Math.max(min - second, second - max, 0);
  if (firstExcess !== secondExcess) {
    return firstExcess < secondExcess ? first : second;
  }
  return Math.abs(first - current) <= Math.abs(second - current) ? first : second;
}

/**
 * Turns solved joint positions back into bone rotations. Each bone gets the
 * minimal swing that aims it at the next joint, applied on top of its current
 * rotation so any existing twist survives, and is then clamped to its limit.
 */
function retargetChain(pose: PoseState, ik: IkChain): void {
  const boneCount = ik.bones.length;
  for (let k = 0; k < boneCount; k++) {
    const bone = ik.bones[k]!;
    const next = k + 1 < boneCount ? ik.bones[k + 1]! : ik.effector;
    const parentIndex = getBone(bone).parentIndex;
    const parentRotation = pose.worldRotations[parentIndex]!;

    desiredDirScratch.copy(jointPositions[k + 1]!).sub(jointPositions[k]!);
    if (desiredDirScratch.lengthSq() >= EPSILON_SQ) {
      desiredDirScratch.normalize();
      localDirScratch.copy(pose.effectiveOffsets[next]!);
      safeNormalize(localDirScratch, fallbackDirections[k]!);
      currentDirScratch.copy(localDirScratch).applyQuaternion(pose.worldRotations[bone]!);

      deltaRotation.setFromUnitVectors(currentDirScratch, desiredDirScratch);
      worldRotationScratch.copy(deltaRotation).multiply(pose.worldRotations[bone]!);
      parentInverse.copy(parentRotation).invert();
      localRotationScratch.copy(parentInverse).multiply(worldRotationScratch);
      clampBoneRotation(bone, localRotationScratch);
      pose.localRotations[bone]!.copy(localRotationScratch);
    }

    pose.worldRotations[bone]!.copy(parentRotation).multiply(pose.localRotations[bone]!);
    pose.worldPositions[next]!
      .copy(pose.effectiveOffsets[next]!)
      .applyQuaternion(pose.worldRotations[bone]!)
      .add(pose.worldPositions[bone]!);
  }
}

/** Chain joint that follows bone `k`: the next chain bone, or the end effector. */
function nextJointBone(ik: IkChain, k: number): number {
  return k + 1 < ik.bones.length ? ik.bones[k + 1]! : ik.effector;
}

/** Current world direction from chain joint `k` to joint `k + 1`. */
function refreshFallbackDirection(pose: PoseState, ik: IkChain, k: number): void {
  const next = nextJointBone(ik, k);
  fallbackDirections[k]!.copy(pose.worldPositions[next]!).sub(pose.worldPositions[ik.bones[k]!]!);
  const lengthSq = fallbackDirections[k]!.lengthSq();
  if (lengthSq < EPSILON_SQ) {
    fallbackDirections[k]!.set(0, 1, 0);
  } else {
    fallbackDirections[k]!.multiplyScalar(1 / Math.sqrt(lengthSq));
  }
}

/** Recomputes the world transforms a change to chain bone `k` invalidates. */
function commitChainBone(pose: PoseState, ik: IkChain, k: number): void {
  const bone = ik.bones[k]!;
  const next = nextJointBone(ik, k);
  pose.worldRotations[bone]!
    .copy(pose.worldRotations[getBone(bone).parentIndex]!)
    .multiply(pose.localRotations[bone]!);
  pose.worldPositions[next]!
    .copy(pose.effectiveOffsets[next]!)
    .applyQuaternion(pose.worldRotations[bone]!)
    .add(pose.worldPositions[bone]!);
}

/** Total link length from chain joint `k + 1` to the end effector. */
function remainingReach(pose: PoseState, ik: IkChain, k: number): number {
  let total = 0;
  for (let j = k + 1; j < ik.bones.length; j++) {
    total += pose.effectiveOffsets[nextJointBone(ik, j)]!.length();
  }
  return total;
}

/**
 * Points chain bone `k` straight at the target. The bone's tip travels on a
 * sphere around its own origin, so aiming at the target is exactly the rotation
 * that brings the rest of the chain as close to the target as this bone can.
 *
 * A shoulder only does this for a hand the arm cannot otherwise reach. While the
 * target is inside the rest of the limb's reach the bone holds still, which
 * keeps a loaded pose from snapping the moment it is solved with its own
 * targets. Stiffness holds back part of whatever rotation does apply.
 */
function aimBoneAtTarget(pose: PoseState, ik: IkChain, k: number, target: Vector3): void {
  const bone = ik.bones[k]!;
  const next = nextJointBone(ik, k);
  if (pose.worldPositions[next]!.distanceTo(target) <= remainingReach(pose, ik, k)) return;

  const parentRotation = pose.worldRotations[getBone(bone).parentIndex]!;
  refreshFallbackDirection(pose, ik, k);
  desiredDirScratch.copy(target).sub(pose.worldPositions[bone]!);
  if (desiredDirScratch.lengthSq() < EPSILON_SQ) return;
  desiredDirScratch.normalize();

  localDirScratch.copy(pose.effectiveOffsets[next]!);
  safeNormalize(localDirScratch, fallbackDirections[k]!);
  currentDirScratch.copy(localDirScratch).applyQuaternion(pose.worldRotations[bone]!);

  deltaRotation.setFromUnitVectors(currentDirScratch, desiredDirScratch);
  worldRotationScratch.copy(deltaRotation).multiply(pose.worldRotations[bone]!);
  parentInverse.copy(parentRotation).invert();
  localRotationScratch.copy(parentInverse).multiply(worldRotationScratch);
  clampBoneRotation(bone, localRotationScratch);

  const stiffness = getBone(bone).limit.stiffness;
  if (stiffness > 0) {
    localRotationScratch.slerp(pose.localRotations[bone]!, stiffness);
    clampBoneRotation(bone, localRotationScratch);
  }
  pose.localRotations[bone]!.copy(localRotationScratch);
  commitChainBone(pose, ik, k);
}

/**
 * Drives one chain onto its target.
 *
 * A limb ends in an analytic two-bone tail, and any bone in front of it is aimed
 * at the target. Running FABRIK over the leading bones instead makes the chain
 * oscillate: FABRIK places the elbow on the assumption that it controls it, the
 * tail then overrides the elbow, and the next pass re-plans from a configuration
 * FABRIK never chose. The spine has no hinge, so it uses FABRIK throughout.
 */
function solveChain(pose: PoseState, ik: IkChain, target: Vector3, tolerance: number): void {
  const boneCount = ik.bones.length;

  if (ik.analyticTail) {
    const tailStart = boneCount - 2;
    for (let pass = 0; pass < LIMB_PASSES; pass++) {
      for (let k = 0; k < tailStart; k++) {
        aimBoneAtTarget(pose, ik, k, target);
      }
      refreshFallbackDirection(pose, ik, tailStart);
      solveTwoBoneTail(pose, ik, target, tailStart);
      for (let k = tailStart; k < boneCount; k++) {
        commitChainBone(pose, ik, k);
      }
      if (pose.worldPositions[ik.effector]!.distanceToSquared(target) < tolerance * tolerance) {
        break;
      }
    }
    return;
  }

  const jointCount = boneCount + 1;
  for (let k = 0; k < boneCount; k++) {
    linkLengths[k] = pose.effectiveOffsets[nextJointBone(ik, k)]!.length();
    jointPositions[k]!.copy(pose.worldPositions[ik.bones[k]!]!);
    refreshFallbackDirection(pose, ik, k);
  }
  jointPositions[boneCount]!.copy(pose.worldPositions[ik.effector]!);
  for (let k = 0; k < jointCount; k++) {
    previousPositions[k]!.copy(jointPositions[k]!);
  }

  chainBase.copy(jointPositions[0]!);
  solveFabrik(jointCount, target, tolerance);

  // Stabilization: a stiff bone keeps part of the previous position of the joint
  // it places, then one forward pass restores the link lengths the blend broke.
  let blended = false;
  for (let k = 1; k < boneCount; k++) {
    const stiffness = getBone(ik.bones[k - 1]!).limit.stiffness;
    if (stiffness > 0) {
      jointPositions[k]!.lerp(previousPositions[k]!, stiffness);
      blended = true;
    }
  }
  if (blended) {
    jointPositions[0]!.copy(chainBase);
    for (let k = 1; k < jointCount; k++) {
      dirScratch.copy(jointPositions[k]!).sub(jointPositions[k - 1]!);
      safeNormalize(dirScratch, fallbackDirections[k - 1]!);
      jointPositions[k]!
        .copy(jointPositions[k - 1]!)
        .addScaledVector(dirScratch, linkLengths[k - 1]!);
    }
  }

  retargetChain(pose, ik);
}

function applyPelvisTarget(pose: PoseState, target: Vector3): void {
  pose.worldRotations[0]!.copy(pose.rootRotation).multiply(pose.localRotations[0]!);
  const pelvis = boneIndex("pelvis");
  pelvisOffsetScratch.copy(pose.effectiveOffsets[pelvis]!).applyQuaternion(pose.worldRotations[0]!);
  pose.rootPosition.copy(target).sub(pelvisOffsetScratch);
}

export function createSolveReport(): IkSolveReport {
  return { iterations: 0, converged: false, maxError: 0, errors: {} };
}

const effectorBoneByTarget: Readonly<Record<IkTargetName, number>> = {
  pelvis: boneIndex("pelvis"),
  chest: boneIndex("torso_upper"),
  head: boneIndex("head"),
  hand_L: boneIndex("hand_L"),
  hand_R: boneIndex("hand_R"),
  foot_L: boneIndex("foot_L"),
  foot_R: boneIndex("foot_R"),
};

/**
 * Drives the pose toward the supplied end-effector targets. Absent targets leave
 * their chain alone. Mutates `pose` and returns the solve report.
 */
export function solveIK(
  pose: PoseState,
  targets: IkTargets,
  options?: IkSolveOptions,
): IkSolveReport {
  const maxIterations = options?.maxIterations ?? MAX_IK_ITERATIONS;
  const tolerance = options?.tolerance ?? IK_TOLERANCE;
  const report = options?.report ?? createSolveReport();

  refreshRigMetrics(pose);
  if (targets.pelvis !== undefined) {
    applyPelvisTarget(pose, targets.pelvis);
  }
  updateWorldTransforms(pose);

  let iterations = 0;
  let maxError = 0;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    iterations = iteration + 1;
    for (const ik of IK_CHAINS) {
      const target = targets[ik.target];
      if (target !== undefined) {
        solveChain(pose, ik, target, tolerance);
      }
    }
    enforceJointLimits(pose);
    updateWorldTransforms(pose);

    maxError = 0;
    for (const name of IK_TARGET_NAMES) {
      const target = targets[name];
      if (target === undefined) continue;
      const error = pose.worldPositions[effectorBoneByTarget[name]]!.distanceTo(target);
      if (error > maxError) maxError = error;
    }
    if (maxError <= tolerance) break;
  }

  for (const name of IK_TARGET_NAMES) {
    const target = targets[name];
    if (target === undefined) {
      delete report.errors[name];
    } else {
      report.errors[name] = pose.worldPositions[effectorBoneByTarget[name]]!.distanceTo(target);
    }
  }
  report.iterations = iterations;
  report.maxError = maxError;
  report.converged = maxError <= tolerance;
  return report;
}

function isVectorFinite(v: Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function isUnitQuaternion(q: Quaternion): boolean {
  if (
    !Number.isFinite(q.x) ||
    !Number.isFinite(q.y) ||
    !Number.isFinite(q.z) ||
    !Number.isFinite(q.w)
  ) {
    return false;
  }
  return Math.abs(q.length() - 1) <= 1e-3;
}

/** True when every transform in the pose is finite and every quaternion is unit. */
export function isPoseFinite(pose: PoseState): boolean {
  if (!isVectorFinite(pose.rootPosition) || !isUnitQuaternion(pose.rootRotation)) return false;
  for (let i = 0; i < BONE_COUNT; i++) {
    if (!isVectorFinite(pose.worldPositions[i]!)) return false;
    if (!isVectorFinite(pose.effectiveOffsets[i]!)) return false;
    if (!isUnitQuaternion(pose.localRotations[i]!)) return false;
    if (!isUnitQuaternion(pose.worldRotations[i]!)) return false;
    if (!Number.isFinite(pose.effectiveLengths[i]!)) return false;
  }
  return true;
}
