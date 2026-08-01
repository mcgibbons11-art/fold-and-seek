import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import {
  BONES,
  BONE_AXES,
  BONE_CHILDREN,
  BONE_COUNT,
  BONE_NAMES,
  boneIndex,
  boneRotationViolation,
  clampBoneRotation,
  DEG_TO_RAD,
  getBone,
  MAX_PANELS,
  PANEL_SOCKET_NAMES,
  SEGMENT_BONES,
  segmentSlotOfBoneName,
} from "../../src/mimic/rig";
import { createRng, randomUnitVector } from "./testRng";

describe("rig contract", () => {
  it("declares every bone required by §24.1", () => {
    for (const required of [
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
    ]) {
      expect(boneIndex(required)).toBeGreaterThanOrEqual(0);
    }
    expect(PANEL_SOCKET_NAMES).toHaveLength(MAX_PANELS);
    expect(BONE_NAMES).toHaveLength(BONE_COUNT);
  });

  it("declares parents before children so forward kinematics is a single pass", () => {
    for (const bone of BONES) {
      expect(bone.parentIndex, bone.name).toBeLessThan(bone.index);
    }
    expect(getBone(0).parentIndex).toBe(-1);
    expect(BONE_CHILDREN[boneIndex("pelvis")]).toContain(boneIndex("thigh_L"));
  });

  it("mirrors the left and right sides", () => {
    const pairs: readonly (readonly [string, string])[] = [
      ["shoulder_L", "shoulder_R"],
      ["upperarm_L", "upperarm_R"],
      ["forearm_L", "forearm_R"],
      ["hand_L", "hand_R"],
      ["thigh_L", "thigh_R"],
      ["shin_L", "shin_R"],
      ["foot_L", "foot_R"],
    ];
    for (const [left, right] of pairs) {
      const a = getBone(boneIndex(left));
      const b = getBone(boneIndex(right));
      expect(b.localPosition[0], right).toBeCloseTo(-a.localPosition[0], 10);
      expect(b.localPosition[1], right).toBeCloseTo(a.localPosition[1], 10);
      expect(b.localPosition[2], right).toBeCloseTo(a.localPosition[2], 10);
      expect(b.length, right).toBeCloseTo(a.length, 10);
      expect(b.limit.swing.kind, right).toBe(a.limit.swing.kind);
    }
  });

  it("gives every shell bone a segment slot and no others", () => {
    expect(SEGMENT_BONES).toHaveLength(19);
    for (const bone of SEGMENT_BONES) {
      expect(segmentSlotOfBoneName(bone), bone).toBeGreaterThanOrEqual(0);
    }
    for (const socket of PANEL_SOCKET_NAMES) {
      expect(SEGMENT_BONES).not.toContain(socket);
    }
  });

  it("uses unit bone axes", () => {
    for (let i = 0; i < BONE_COUNT; i++) {
      expect(BONE_AXES[i]!.length(), BONE_NAMES[i]).toBeCloseTo(1, 12);
    }
  });

  it("hinges the elbows and knees in opposite directions", () => {
    const elbow = getBone(boneIndex("forearm_L")).limit.swing;
    const knee = getBone(boneIndex("shin_L")).limit.swing;
    expect(elbow.kind).toBe("hinge");
    expect(knee.kind).toBe("hinge");
    if (elbow.kind === "hinge" && knee.kind === "hinge") {
      expect(elbow.minDeg).toBeLessThan(-90);
      expect(knee.maxDeg).toBeGreaterThan(90);
    }
  });
});

describe("joint limit math", () => {
  it("leaves a legal rotation untouched", () => {
    const index = boneIndex("upperarm_L");
    const axis = new Vector3(0, 0, 1);
    const rotation = new Quaternion().setFromAxisAngle(axis, 60 * DEG_TO_RAD);
    const before = rotation.clone();

    expect(boneRotationViolation(index, rotation)).toBeLessThan(1e-9);
    clampBoneRotation(index, rotation);
    expect(rotation.angleTo(before)).toBeLessThan(1e-9);
  });

  it("clamps a swing beyond the cone back to the cone edge", () => {
    const index = boneIndex("pelvis");
    const maxSwing = 38 * DEG_TO_RAD;
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 120 * DEG_TO_RAD);

    expect(boneRotationViolation(index, rotation)).toBeGreaterThan(0.1);
    clampBoneRotation(index, rotation);

    const swung = new Vector3(0, 1, 0).applyQuaternion(rotation);
    expect(swung.angleTo(new Vector3(0, 1, 0))).toBeCloseTo(maxSwing, 6);
    expect(boneRotationViolation(index, rotation)).toBeLessThan(1e-9);
  });

  it("clamps twist without disturbing a legal swing", () => {
    const index = boneIndex("head");
    const swing = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 30 * DEG_TO_RAD);
    const twist = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 170 * DEG_TO_RAD);
    const rotation = swing.clone().multiply(twist);

    clampBoneRotation(index, rotation);

    const swungAxis = new Vector3(0, 1, 0).applyQuaternion(rotation);
    expect(swungAxis.angleTo(new Vector3(0, 1, 0))).toBeCloseTo(30 * DEG_TO_RAD, 6);
    expect(boneRotationViolation(index, rotation)).toBeLessThan(1e-9);
  });

  it("collapses a hinge joint onto its axis", () => {
    const index = boneIndex("shin_L");
    const rotation = new Quaternion().setFromAxisAngle(
      new Vector3(0.3, 0.9, 0.2).normalize(),
      100 * DEG_TO_RAD,
    );

    expect(boneRotationViolation(index, rotation)).toBeGreaterThan(0.01);
    clampBoneRotation(index, rotation);

    expect(Math.abs(rotation.y)).toBeLessThan(1e-9);
    expect(Math.abs(rotation.z)).toBeLessThan(1e-9);
    expect(boneRotationViolation(index, rotation)).toBeLessThan(1e-9);
  });

  it("clamps a hinge past its range back into range", () => {
    const index = boneIndex("forearm_L");
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 90 * DEG_TO_RAD);
    clampBoneRotation(index, rotation);

    const angle = 2 * Math.atan2(rotation.x, rotation.w);
    expect(angle / DEG_TO_RAD).toBeCloseTo(2, 6);
  });

  it("leaves any clamped rotation legal, for every bone", () => {
    const rng = createRng(4242);
    const axis = new Vector3();
    const rotation = new Quaternion();

    for (let i = 1; i < BONE_COUNT; i++) {
      for (let trial = 0; trial < 60; trial++) {
        randomUnitVector(rng, axis);
        rotation.setFromAxisAngle(axis, (rng() * 2 - 1) * Math.PI);
        clampBoneRotation(i, rotation);
        expect(Math.abs(rotation.length() - 1), BONE_NAMES[i]).toBeLessThan(1e-6);
        expect(boneRotationViolation(i, rotation), BONE_NAMES[i]).toBeLessThan(1e-6);
      }
    }
  });

  it("is idempotent", () => {
    const rng = createRng(99);
    const axis = new Vector3();
    const rotation = new Quaternion();

    for (let i = 1; i < BONE_COUNT; i++) {
      randomUnitVector(rng, axis);
      rotation.setFromAxisAngle(axis, (rng() * 2 - 1) * Math.PI);
      clampBoneRotation(i, rotation);
      const once = rotation.clone();
      clampBoneRotation(i, rotation);
      expect(rotation.angleTo(once), BONE_NAMES[i]).toBeLessThan(1e-6);
    }
  });
});
