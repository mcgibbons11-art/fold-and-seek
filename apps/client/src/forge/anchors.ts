import * as THREE from "three/webgpu";

import type { AnchorState } from "../mimic/disguiseState";
import type { IkTargetName } from "../mimic/ikSolver";

/**
 * Surface contact anchors (bible §7.4 Layer 4, §24.6, §24.7).
 *
 * An anchor stores where a contact point sits on a map surface, in that
 * surface's own local frame, so it survives the object moving and reloads with
 * the map rather than with the camera. §24.6 offers two encodings; this is the
 * analytic `SurfaceFrameAnchor`, read as:
 *
 *   - `localRotation` maps +Y onto the surface normal, in the object's local
 *     frame, and is therefore the frame itself;
 *   - `uv` is the contact point in metres along that frame's two tangents;
 *   - `normalOffset` is the same point's coordinate along the normal, gap
 *     included.
 *
 * Those three fields reconstruct the contact point exactly, which a texture-UV
 * reading could not do on procedural geometry that carries no authored UVs.
 */

/** Contact points that may be anchored: the five IK effectors that touch things. */
export const ANCHORABLE_BONES = ["hand_L", "hand_R", "foot_L", "foot_R", "pelvis"] as const;

export type AnchorableBone = (typeof ANCHORABLE_BONES)[number];

/** Every anchorable bone drives the IK target of the same name. */
export function anchorTargetName(bone: AnchorableBone): IkTargetName {
  return bone;
}

export function isAnchorableBone(bone: string): bone is AnchorableBone {
  return (ANCHORABLE_BONES as readonly string[]).includes(bone);
}

/**
 * The face each contact point presents to a surface, as a unit normal in that
 * bone's own frame. A foot meets the floor with its sole, which the shell puts
 * on the bone's -Y side; a hand meets a wall with the flat of its paddle, which
 * is the panel's ±Z face. The pelvis has no contact face: anchoring it places
 * the body rather than pressing a surface, so it is left out.
 *
 * Both faces of a hand are usable, so the sign is chosen at solve time.
 */
export const CONTACT_FACE_NORMALS: Partial<Record<AnchorableBone, readonly [number, number, number]>> = {
  foot_L: [0, -1, 0],
  foot_R: [0, -1, 0],
  hand_L: [0, 0, 1],
  hand_R: [0, 0, 1],
};

/** True when both sides of the contact face may meet a surface. */
export const CONTACT_FACE_REVERSIBLE: Partial<Record<AnchorableBone, boolean>> = {
  hand_L: true,
  hand_R: true,
};

/** How close a dragged contact point must come to a surface before it snaps. */
export const ANCHOR_SNAP_RADIUS_M = 0.18;

/** How far it must be pulled back before the anchor lets go. */
export const ANCHOR_RELEASE_RADIUS_M = 0.32;

/** Contact points rest this far off the surface, so shells do not z-fight it. */
export const ANCHOR_GAP_M = 0.012;

export const DEFAULT_POSITION_TOLERANCE_M = 0.02;
export const DEFAULT_ANGULAR_TOLERANCE_DEG = 12;

const AXIS_Y = new THREE.Vector3(0, 1, 0);

const localPoint = new THREE.Vector3();
const localNormal = new THREE.Vector3();
const tangent = new THREE.Vector3();
const bitangent = new THREE.Vector3();
const frameRotation = new THREE.Quaternion();
const objectRotation = new THREE.Quaternion();

/**
 * A tangent pair for a normal, chosen the same way every time so capture and
 * resolve agree. Any deterministic rule works; this one only has to avoid the
 * degenerate case where the seed is parallel to the normal.
 */
function tangentBasis(normal: THREE.Vector3, outTangent: THREE.Vector3, outBitangent: THREE.Vector3): void {
  if (Math.abs(normal.y) < 0.9) {
    outTangent.set(0, 1, 0);
  } else {
    outTangent.set(1, 0, 0);
  }
  outTangent.addScaledVector(normal, -outTangent.dot(normal));
  if (outTangent.lengthSq() < 1e-12) {
    outTangent.set(1, 0, 0);
  }
  outTangent.normalize();
  outBitangent.copy(normal).cross(outTangent).normalize();
}

export interface AnchorCapture {
  readonly bone: AnchorableBone;
  readonly object: THREE.Object3D;
  /** World-space contact point on the surface. */
  readonly point: THREE.Vector3;
  /** World-space unit surface normal. */
  readonly normal: THREE.Vector3;
}

/**
 * Turns a surface hit into a storable anchor. Returns null when the surface
 * carries no stable id, because an anchor that cannot be resolved again is
 * worse than no anchor at all.
 */
export function captureAnchor(
  id: string,
  capture: AnchorCapture,
  gapM = ANCHOR_GAP_M,
): AnchorState | null {
  const objectId = capture.object.name;
  if (objectId.length === 0) {
    return null;
  }

  capture.object.updateWorldMatrix(true, false);
  localPoint.copy(capture.point);
  capture.object.worldToLocal(localPoint);

  // A direction transforms by the object's rotation alone.
  capture.object.getWorldQuaternion(objectRotation).invert();
  localNormal.copy(capture.normal).applyQuaternion(objectRotation).normalize();

  tangentBasis(localNormal, tangent, bitangent);
  frameRotation.setFromUnitVectors(AXIS_Y, localNormal);

  return {
    id,
    bone: capture.bone,
    objectId,
    uv: [localPoint.dot(tangent), localPoint.dot(bitangent)],
    normalOffset: localPoint.dot(localNormal) + gapM,
    localRotation: [frameRotation.x, frameRotation.y, frameRotation.z, frameRotation.w],
    positionToleranceM: DEFAULT_POSITION_TOLERANCE_M,
    angularToleranceDeg: DEFAULT_ANGULAR_TOLERANCE_DEG,
  };
}

export interface ResolvedAnchor {
  readonly position: THREE.Vector3;
  readonly normal: THREE.Vector3;
}

export function createResolvedAnchor(): ResolvedAnchor {
  return { position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) };
}

/**
 * Rebuilds an anchor's world contact point and normal. Returns false when the
 * object it references is no longer in the map, which the caller should surface
 * rather than silently ignore (§24.7).
 */
export function resolveAnchor(
  anchor: AnchorState,
  lookup: (objectId: string) => THREE.Object3D | null,
  out: ResolvedAnchor,
): boolean {
  const object = lookup(anchor.objectId);
  if (object === null) {
    return false;
  }

  frameRotation.set(
    anchor.localRotation[0],
    anchor.localRotation[1],
    anchor.localRotation[2],
    anchor.localRotation[3],
  );
  localNormal.copy(AXIS_Y).applyQuaternion(frameRotation).normalize();
  tangentBasis(localNormal, tangent, bitangent);

  localPoint
    .copy(tangent)
    .multiplyScalar(anchor.uv[0])
    .addScaledVector(bitangent, anchor.uv[1])
    .addScaledVector(localNormal, anchor.normalOffset);

  object.updateWorldMatrix(true, false);
  out.position.copy(object.localToWorld(localPoint));
  out.normal
    .copy(localNormal)
    .applyQuaternion(object.getWorldQuaternion(objectRotation))
    .normalize();
  return true;
}

/**
 * Distance between where an anchor wants its contact point and where the solved
 * pose actually put it. §24.7: a conflict is reported, never hidden.
 */
export function anchorResidual(resolved: ResolvedAnchor, effectorWorld: THREE.Vector3): number {
  return resolved.position.distanceTo(effectorWorld);
}

export function isAnchorSatisfied(anchor: AnchorState, residual: number): boolean {
  return residual <= Math.max(anchor.positionToleranceM, 1e-4);
}

/**
 * Hinge angle and telescope that bring a panel's tip as close as it can get to a
 * target, given where the panel hinges (§7.4 Layer 3).
 *
 * The tip travels on a circle in the hinge's own plane, so the solve is exact
 * and closed form rather than iterative: the angle is where the target lies
 * around that circle, and the extension is how far along the radius it sits.
 * The component of the target along the hinge axis is unreachable by definition
 * and shows up as the residual the caller reports.
 */
export interface PanelReach {
  /** Total rotation from stowed, in radians, before the deploy amount is removed. */
  readonly angleRad: number;
  /** Telescope travel in metres, before the panel's limit is applied. */
  readonly extensionM: number;
}

export function solvePanelReach(
  hingePosition: THREE.Vector3,
  hingeRotation: THREE.Quaternion,
  target: THREE.Vector3,
  plateHeightM: number,
  out: THREE.Vector3,
): PanelReach {
  out.copy(target).sub(hingePosition);
  frameRotation.copy(hingeRotation).invert();
  out.applyQuaternion(frameRotation);

  // The plate lies in the frame's yz plane and swings about its x axis.
  const radius = Math.hypot(out.y, out.z);
  return {
    angleRad: Math.atan2(out.z, out.y),
    extensionM: radius - plateHeightM,
  };
}

const faceScratch = new THREE.Vector3();
const targetFaceScratch = new THREE.Vector3();
const alignScratch = new THREE.Quaternion();
const parentInverseScratch = new THREE.Quaternion();

/**
 * Local rotation that lays a contact face onto a surface (§7.4 Layer 4).
 *
 * A surface normal points away from the surface, so the face that meets it has
 * to point the opposite way. The result is expressed in the bone's parent frame,
 * ready to be clamped to the joint's limit and written straight into the pose.
 */
export function solveContactAlignment(
  faceLocal: readonly [number, number, number],
  boneWorldRotation: THREE.Quaternion,
  parentWorldRotation: THREE.Quaternion,
  surfaceNormal: THREE.Vector3,
  reversible: boolean,
  out: THREE.Quaternion,
): void {
  faceScratch.set(faceLocal[0], faceLocal[1], faceLocal[2]).applyQuaternion(boneWorldRotation);
  targetFaceScratch.copy(surfaceNormal).negate().normalize();
  if (reversible && faceScratch.dot(targetFaceScratch) < 0) {
    targetFaceScratch.negate();
  }
  alignScratch.setFromUnitVectors(faceScratch, targetFaceScratch);
  parentInverseScratch.copy(parentWorldRotation).invert();
  out.copy(parentInverseScratch).multiply(alignScratch).multiply(boneWorldRotation);
}

let anchorSerial = 0;

export function nextAnchorId(bone: string): string {
  anchorSerial += 1;
  return `${bone}:${anchorSerial}`;
}

/** Replaces the anchor on `bone`, or removes it when `anchor` is null. */
export function withAnchorOnBone(
  anchors: readonly AnchorState[],
  bone: string,
  anchor: AnchorState | null,
): AnchorState[] {
  const next = anchors.filter((entry) => entry.bone !== bone).map((entry) => ({ ...entry }));
  if (anchor !== null) {
    next.push(anchor);
  }
  return next;
}

export function anchorForBone(
  anchors: readonly AnchorState[],
  bone: string,
): AnchorState | null {
  return anchors.find((entry) => entry.bone === bone) ?? null;
}
