import { PLAYER_HEIGHT_M } from "@foldseek/shared";
import { Vector3 } from "three";
import { describe, expect, it } from "vitest";

import {
  boneTipWorld,
  createPoseState,
  IK_TARGET_NAMES,
  MAX_IK_ITERATIONS,
  isPoseFinite,
  refreshRigMetrics,
  solveIK,
  updateWorldTransforms,
  type IkTargetName,
  type PoseState,
} from "../../src/mimic/ikSolver";
import {
  BONE_COUNT,
  boneIndex,
  boneRotationViolation,
  REST_HEIGHT,
  RIG_TO_WORLD,
  SEGMENT_BONES,
} from "../../src/mimic/rig";
import { normalizedFromScale, segmentRange } from "../../src/mimic/segmentForm";
import { createRng, randomLegalRotation, randomUnitVector } from "./testRng";

/** Bones the solver rotates, and therefore the ones a generated target may use. */
const SOLVED_BONES = [
  "pelvis",
  "torso_lower",
  "torso_upper",
  "neck",
  "shoulder_L",
  "upperarm_L",
  "forearm_L",
  "shoulder_R",
  "upperarm_R",
  "forearm_R",
  "thigh_L",
  "shin_L",
  "thigh_R",
  "shin_R",
] as const;

const TARGET_BONES: Readonly<Record<IkTargetName, string>> = {
  pelvis: "pelvis",
  chest: "torso_upper",
  head: "head",
  hand_L: "hand_L",
  hand_R: "hand_R",
  foot_L: "foot_L",
  foot_R: "foot_R",
};

type MutableTargets = { [K in IkTargetName]?: Vector3 };

function captureTargets(pose: PoseState): MutableTargets {
  const targets: MutableTargets = {};
  for (const name of IK_TARGET_NAMES) {
    targets[name] = pose.worldPositions[boneIndex(TARGET_BONES[name])]!.clone();
  }
  return targets;
}

/**
 * A pose the rig can genuinely hit, produced by forward kinematics from legal
 * joints.
 *
 * The pelvis is given no twist. Twisting the pelvis about its own axis swings
 * both hip sockets without moving any of the seven targets, so no point-target
 * solver can recover it, and a reference pose that used it would be asking for
 * something the target set does not determine.
 */
function buildReachablePose(seed: number, fraction: number): PoseState {
  const pose = createPoseState();
  const rng = createRng(seed);
  for (const name of SOLVED_BONES) {
    const index = boneIndex(name);
    const twistFraction = name === "pelvis" ? 0 : fraction;
    randomLegalRotation(index, rng, fraction, pose.localRotations[index]!, twistFraction);
  }
  updateWorldTransforms(pose);
  return pose;
}

function worstJointViolation(pose: PoseState): { bone: number; violation: number } {
  let worst = { bone: -1, violation: 0 };
  for (let i = 1; i < BONE_COUNT; i++) {
    const violation = boneRotationViolation(i, pose.localRotations[i]!);
    if (violation > worst.violation) {
      worst = { bone: i, violation };
    }
  }
  return worst;
}

describe("rest pose", () => {
  it("stands exactly one player height tall with both soles near the floor", () => {
    const pose = createPoseState();
    const tip = new Vector3();
    boneTipWorld(pose, boneIndex("head"), tip);

    // The rig is authored at RIG_AUTHORED_HEIGHT and converted once, so the
    // body a Mimic starts from is the same height as the Inspector beside it.
    expect(REST_HEIGHT).toBeCloseTo(PLAYER_HEIGHT_M, 6);
    expect(tip.y).toBeCloseTo(PLAYER_HEIGHT_M, 6);
    const ankleY = 0.05 * RIG_TO_WORLD;
    expect(pose.worldPositions[boneIndex("foot_L")]!.y).toBeCloseTo(ankleY, 6);
    expect(pose.worldPositions[boneIndex("foot_R")]!.y).toBeCloseTo(ankleY, 6);
    expect(isPoseFinite(pose)).toBe(true);
  });
});

describe("solveIK reachability", () => {
  it("reaches forward-kinematic targets within 2 cm in at most 8 iterations", () => {
    let worstError = 0;
    let worstIterations = 0;

    for (let seed = 1; seed <= 300; seed++) {
      const reference = buildReachablePose(seed, 0.6);
      const targets = captureTargets(reference);

      const pose = createPoseState();
      const report = solveIK(pose, targets);

      expect(isPoseFinite(pose)).toBe(true);
      expect(report.iterations).toBeLessThanOrEqual(MAX_IK_ITERATIONS);
      worstIterations = Math.max(worstIterations, report.iterations);
      worstError = Math.max(worstError, report.maxError);
      expect(report.maxError, `seed ${seed}`).toBeLessThan(0.02);
    }

    expect(worstIterations).toBeLessThanOrEqual(MAX_IK_ITERATIONS);
    expect(worstError).toBeLessThan(0.02);
  });

  it("holds a target it is already sitting on", () => {
    const pose = createPoseState();
    const targets = captureTargets(pose);
    const before = pose.worldPositions.map((position) => position.clone());

    const report = solveIK(pose, targets);

    expect(report.maxError).toBeLessThan(1e-6);
    for (let i = 0; i < BONE_COUNT; i++) {
      expect(pose.worldPositions[i]!.distanceTo(before[i]!)).toBeLessThan(1e-6);
    }
  });

  it("produces identical output for identical input", () => {
    const targets = captureTargets(buildReachablePose(7, 0.7));

    const first = createPoseState();
    const second = createPoseState();
    solveIK(first, targets);
    solveIK(second, targets);

    for (let i = 0; i < BONE_COUNT; i++) {
      expect(first.localRotations[i]!.x).toBe(second.localRotations[i]!.x);
      expect(first.localRotations[i]!.y).toBe(second.localRotations[i]!.y);
      expect(first.localRotations[i]!.z).toBe(second.localRotations[i]!.z);
      expect(first.localRotations[i]!.w).toBe(second.localRotations[i]!.w);
    }
  });
});

describe("solveIK with unreachable targets", () => {
  it("stretches toward a far target without producing NaN", () => {
    const pose = createPoseState();
    const farAway = new Vector3(9, 4, -6);
    const report = solveIK(pose, { hand_L: farAway });

    expect(isPoseFinite(pose)).toBe(true);
    expect(Number.isFinite(report.maxError)).toBe(true);
    expect(report.converged).toBe(false);

    const shoulder = pose.worldPositions[boneIndex("shoulder_L")]!;
    const wrist = pose.worldPositions[boneIndex("hand_L")]!;
    const reach = shoulder.distanceTo(wrist);
    const maximumReach =
      pose.effectiveOffsets[boneIndex("upperarm_L")]!.length() +
      pose.effectiveOffsets[boneIndex("forearm_L")]!.length() +
      pose.effectiveOffsets[boneIndex("hand_L")]!.length();

    expect(reach).toBeGreaterThan(maximumReach * 0.9);

    const toTarget = farAway.clone().sub(shoulder).normalize();
    const armDirection = wrist.clone().sub(shoulder).normalize();
    expect(armDirection.dot(toTarget)).toBeGreaterThan(0.9);
  });

  it("stays finite and legal for every end effector pushed far out", () => {
    const pose = createPoseState();
    solveIK(pose, {
      pelvis: new Vector3(0, 30, 0),
      chest: new Vector3(-20, -14, 8),
      head: new Vector3(18, -9, -11),
      hand_L: new Vector3(-25, 25, 25),
      hand_R: new Vector3(25, -25, 25),
      foot_L: new Vector3(0, 40, 0),
      foot_R: new Vector3(0, -40, 0),
    });

    expect(isPoseFinite(pose)).toBe(true);
    expect(worstJointViolation(pose).violation).toBeLessThan(1e-4);
  });

  it("survives targets placed exactly on the chain root", () => {
    const pose = createPoseState();
    const shoulder = pose.worldPositions[boneIndex("shoulder_L")]!.clone();
    const hip = pose.worldPositions[boneIndex("thigh_L")]!.clone();

    solveIK(pose, { hand_L: shoulder, foot_L: hip });

    expect(isPoseFinite(pose)).toBe(true);
    expect(worstJointViolation(pose).violation).toBeLessThan(1e-4);
  });
});

describe("joint limits after solve", () => {
  it("never exceeds a joint limit across 200 random target sets", () => {
    const rng = createRng(20260801);
    const scratch = new Vector3();
    const centre = new Vector3(0, 0.6, 0);
    let worst = 0;

    for (let trial = 0; trial < 200; trial++) {
      const pose = createPoseState();
      const targets: MutableTargets = {};
      for (const name of IK_TARGET_NAMES) {
        randomUnitVector(rng, scratch);
        const radius = rng() * 1.5;
        targets[name] = centre.clone().addScaledVector(scratch, radius);
      }

      solveIK(pose, targets);

      expect(isPoseFinite(pose), `trial ${trial} produced a non-finite pose`).toBe(true);
      const { bone, violation } = worstJointViolation(pose);
      if (violation > worst) worst = violation;
      expect(violation, `trial ${trial} violated bone ${bone}`).toBeLessThan(1e-4);
    }

    expect(worst).toBeLessThan(1e-4);
  });
});

describe("segment form drives the skeleton", () => {
  it("moves the children of a stretched torso", () => {
    const pose = createPoseState();
    const baselineHead = pose.worldPositions[boneIndex("head")]!.y;
    const baselineShoulder = pose.worldPositions[boneIndex("shoulder_L")]!.y;

    const slot = SEGMENT_BONES.indexOf("torso_lower");
    const range = segmentRange("torso_lower");
    pose.segments[slot]!.length = normalizedFromScale(
      range.maxLengthScale,
      range.minLengthScale,
      range.maxLengthScale,
    );
    refreshRigMetrics(pose);
    updateWorldTransforms(pose);

    // torso_lower is authored 0.13 units long, which is that in world metres.
    const stretchedOffset = pose.effectiveOffsets[boneIndex("torso_upper")]!.length();
    expect(stretchedOffset).toBeCloseTo(0.13 * RIG_TO_WORLD * range.maxLengthScale, 6);
    expect(pose.worldPositions[boneIndex("shoulder_L")]!.y).toBeGreaterThan(baselineShoulder);
    expect(pose.worldPositions[boneIndex("head")]!.y).toBeGreaterThan(
      baselineHead + 0.1 * RIG_TO_WORLD,
    );
  });

  it("keeps solving to reachable targets after the body is re-proportioned", () => {
    const pose = createPoseState();
    for (const bone of ["torso_lower", "torso_upper", "thigh_L", "thigh_R"] as const) {
      const slot = SEGMENT_BONES.indexOf(bone);
      const range = segmentRange(bone);
      pose.segments[slot]!.length = normalizedFromScale(
        1.8,
        range.minLengthScale,
        range.maxLengthScale,
      );
      pose.segments[slot]!.width = normalizedFromScale(
        1.5,
        range.minWidthScale,
        range.maxWidthScale,
      );
    }
    refreshRigMetrics(pose);
    updateWorldTransforms(pose);

    const targets = captureTargets(pose);
    targets.hand_L!.add(new Vector3(0.05, 0.12, 0.1));
    targets.foot_R!.add(new Vector3(0, 0.06, 0.12));

    const report = solveIK(pose, targets);

    expect(isPoseFinite(pose)).toBe(true);
    expect(report.maxError).toBeLessThan(0.02);
    expect(worstJointViolation(pose).violation).toBeLessThan(1e-4);
  });
});
