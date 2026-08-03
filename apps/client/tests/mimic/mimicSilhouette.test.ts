import { PLAYER_HEIGHT_M } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { applyDisguiseStateToPose, createStarterArrangement } from "../../src/mimic/disguiseState";
import { createPoseState } from "../../src/mimic/ikSolver";
import { SEGMENT_BONES, type SegmentBoneName } from "../../src/mimic/rig";
import { MimicVisual } from "../../src/mimic/visual/MimicVisual";

/**
 * The Mimic is the object the whole game is about, and a player has to be able
 * to tell a head from a hand at a glance before painting or posing one means
 * anything. What follows measures the standing body and checks the relations
 * that make it read as a creature: a head that is the widest thing above the
 * chest, arms that stand clear of the trunk instead of disappearing into it,
 * legs that do not merge, and a trunk that is one form rather than a stack of
 * beads.
 *
 * Every figure is in world metres off a real `MimicVisual`, so these fail the
 * moment the rig conversion or the authored cross-sections drift.
 */

const state = createStarterArrangement("upright");
const pose = createPoseState();
applyDisguiseStateToPose(state, pose);
const visual = new MimicVisual();
visual.applyForms(pose);
visual.applyPanels(state.panels);
visual.applyPose(pose);
visual.root.updateMatrixWorld(true);

/** World bounding box of one shell, which is what the silhouette is made of. */
function shell(bone: SegmentBoneName): THREE.Box3 {
  const slot = SEGMENT_BONES.indexOf(bone);
  const mesh = visual.segmentMeshes[slot];
  if (mesh === undefined) throw new Error(`no shell for ${bone}`);
  return new THREE.Box3().setFromObject(mesh);
}

function width(bone: SegmentBoneName): number {
  const box = shell(bone);
  return box.max.x - box.min.x;
}

function length(bone: SegmentBoneName): number {
  const box = shell(bone);
  return box.max.y - box.min.y;
}

/** Diameter of the dark bellows bridging a bone to its parent. */
function bellowsDiameter(bone: SegmentBoneName): number {
  const mesh = visual.root.getObjectByName(`mimic_bellows_${bone}`);
  if (mesh === undefined) throw new Error(`no bellows for ${bone}`);
  const box = new THREE.Box3().setFromObject(mesh);
  return box.max.x - box.min.x;
}

describe("the standing Mimic reads as a body", () => {
  it("puts the head above a neck narrower than it and shoulders wider", () => {
    expect(width("head")).toBeGreaterThan(width("neck") * 1.5);
    // Shoulder to shoulder, measured across both stubs.
    const shoulderSpan = shell("shoulder_L").max.x - shell("shoulder_R").min.x;
    expect(shoulderSpan).toBeGreaterThan(width("head") * 1.2);
    expect(width("head")).toBeLessThan(width("torso_upper"));
  });

  it("hangs each arm clear of the trunk it stands beside", () => {
    // The arm is the segment most easily lost in the chest: it hangs at the
    // shoulder's own offset, so a chest any wider swallows it and the body
    // becomes one blank slab from armpit to hip.
    for (const [arm, side] of [
      ["upperarm_L", 1],
      ["upperarm_R", -1],
    ] as const) {
      const armEdge = side > 0 ? shell(arm).max.x : -shell(arm).min.x;
      const chestEdge = side > 0 ? shell("torso_upper").max.x : -shell("torso_upper").min.x;
      const clearance = armEdge - chestEdge;
      expect(clearance, `${arm} is buried in the chest`).toBeGreaterThan(width(arm) * 0.3);
    }
  });

  it("tapers the trunk from hips to waist to chest", () => {
    expect(width("torso_lower")).toBeLessThan(width("pelvis"));
    expect(width("torso_lower")).toBeLessThan(width("torso_upper"));
  });

  it("leaves daylight between the legs and puts the feet out in front", () => {
    expect(shell("thigh_L").min.x).toBeGreaterThan(shell("thigh_R").max.x);
    // A foot is a foot because it points somewhere the shin does not.
    expect(shell("foot_L").max.z).toBeGreaterThan(shell("shin_L").max.z * 2);
  });

  it("ends each arm in a flat hand rather than in more forearm", () => {
    const handDepth = shell("hand_L").max.z - shell("hand_L").min.z;
    const forearmDepth = shell("forearm_L").max.z - shell("forearm_L").min.z;
    expect(handDepth).toBeLessThan(forearmDepth * 0.6);
  });

  it("welds the trunk into one form and leaves the limb joints articulated", () => {
    // Every shell closes to a point at both ends. Four of them end to end pinch
    // four times, which is what made the body read as a stack of beads, so each
    // trunk shell is drawn past its bone tip into the next one.
    const trunk = [
      ["pelvis", "torso_lower"],
      ["torso_lower", "torso_upper"],
      ["torso_upper", "neck"],
      ["neck", "head"],
    ] as const;
    for (const [parent, child] of trunk) {
      const overlap = shell(parent).max.y - shell(child).min.y;
      expect(overlap, `${parent} does not reach into ${child}`).toBeGreaterThan(
        length(child) * 0.12,
      );
    }

    // The arm hangs downward, so its joints are where one shell's floor meets
    // the next one's ceiling. They abut and never overlap: the pinch at an elbow
    // is the articulation, and burying it would cost the arm its joint.
    expect(shell("upperarm_L").min.y).toBeGreaterThanOrEqual(shell("forearm_L").max.y - 1e-9);
    expect(shell("forearm_L").min.y).toBeGreaterThanOrEqual(shell("hand_L").max.y - 1e-9);
    expect(shell("thigh_L").min.y).toBeGreaterThanOrEqual(shell("shin_L").max.y - 1e-9);
  });

  it("stands a dark seam proud at the elbow and the knee, and tucks it in the neck", () => {
    expect(bellowsDiameter("forearm_L")).toBeGreaterThan(width("forearm_L"));
    expect(bellowsDiameter("shin_L")).toBeGreaterThan(width("shin_L"));
    // The trunk is meant to read as one surface, so its own seams stay inside.
    expect(bellowsDiameter("neck")).toBeLessThan(width("neck"));
  });

  it("still stands exactly one player height, overruns and all", () => {
    const box = new THREE.Box3().setFromObject(visual.root);
    expect(box.max.y).toBeCloseTo(PLAYER_HEIGHT_M, 6);
    // The crown is the head shell's own tip: nothing else may overrun past it.
    expect(shell("head").max.y).toBeCloseTo(box.max.y, 6);
  });

  it("carries the authored brass face and shoulder identity without changing its bounds", () => {
    const decorated = new MimicVisual();
    decorated.applyForms(pose);
    decorated.applyPanels(state.panels);
    decorated.applyMaterials(state.materials);
    decorated.applyPose(pose);
    decorated.root.updateMatrixWorld(true);

    expect(decorated.root.getObjectByName("mimic_eye_bezel_L")).toBeDefined();
    expect(decorated.root.getObjectByName("mimic_crown_ring")).toBeDefined();
    const shoulder = decorated.segmentMeshes[SEGMENT_BONES.indexOf("shoulder_L")];
    expect((shoulder?.material as THREE.Material | undefined)?.name).toBe("mimic_socket_brass");
    expect(new THREE.Box3().setFromObject(decorated.root).max.y).toBeCloseTo(PLAYER_HEIGHT_M, 6);

    decorated.applyMaterials([
      ...state.materials,
      { slotId: "shoulder_L", swatchId: "wood_walnut" },
    ]);
    expect((shoulder?.material as THREE.Material | undefined)?.name).toBe("swatch:wood_walnut");
    decorated.dispose();
  });
});
