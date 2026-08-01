import { Quaternion, Vector3 } from "three";

import { BONE_AXES, DEG_TO_RAD, getBone } from "../../src/mimic/rig";

/** mulberry32: small, fast, and fully reproducible from a 32-bit seed. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomUnitVector(rng: () => number, out: Vector3): Vector3 {
  const z = rng() * 2 - 1;
  const angle = rng() * Math.PI * 2;
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(radius * Math.cos(angle), radius * Math.sin(angle), z);
}

const swingAxis = new Vector3();
const swingRotation = new Quaternion();
const twistRotation = new Quaternion();

/**
 * A rotation guaranteed to sit inside a bone's joint limit, built by composing a
 * swing and a twist term rather than by clamping an arbitrary rotation.
 * `fraction` scales how far into the legal range the result reaches.
 */
export function randomLegalRotation(
  boneIndex: number,
  rng: () => number,
  fraction: number,
  out: Quaternion,
  twistFraction: number = fraction,
): Quaternion {
  const limit = getBone(boneIndex).limit;

  if (limit.swing.kind === "hinge") {
    const min = limit.swing.minDeg * DEG_TO_RAD;
    const max = limit.swing.maxDeg * DEG_TO_RAD;
    const middle = (min + max) / 2;
    const halfSpan = ((max - min) / 2) * fraction;
    swingAxis
      .set(limit.swing.hingeAxis[0], limit.swing.hingeAxis[1], limit.swing.hingeAxis[2])
      .normalize();
    return out.setFromAxisAngle(swingAxis, middle + (rng() * 2 - 1) * halfSpan);
  }

  const boneAxis = BONE_AXES[boneIndex]!;
  randomUnitVector(rng, swingAxis);
  swingAxis.addScaledVector(boneAxis, -swingAxis.dot(boneAxis));
  if (swingAxis.lengthSq() < 1e-8) {
    swingAxis.set(boneAxis.y, boneAxis.z, boneAxis.x);
    swingAxis.addScaledVector(boneAxis, -swingAxis.dot(boneAxis));
  }
  swingAxis.normalize();

  const swingAngle = rng() * limit.swing.maxSwingDeg * DEG_TO_RAD * fraction;
  const twistSpan = (limit.twistMaxDeg - limit.twistMinDeg) * DEG_TO_RAD;
  const twistAngle =
    limit.twistMinDeg * DEG_TO_RAD + (0.5 + (rng() - 0.5) * twistFraction) * twistSpan;

  swingRotation.setFromAxisAngle(swingAxis, swingAngle);
  twistRotation.setFromAxisAngle(boneAxis, twistAngle);
  return out.copy(swingRotation).multiply(twistRotation);
}
