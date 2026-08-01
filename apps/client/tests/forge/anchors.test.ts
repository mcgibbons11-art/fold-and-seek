import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import {
  ANCHORABLE_BONES,
  anchorForBone,
  anchorResidual,
  anchorTargetName,
  captureAnchor,
  CONTACT_FACE_NORMALS,
  CONTACT_FACE_REVERSIBLE,
  createResolvedAnchor,
  isAnchorableBone,
  isAnchorSatisfied,
  nextAnchorId,
  resolveAnchor,
  solveContactAlignment,
  solvePanelReach,
  withAnchorOnBone,
  type AnchorCapture,
} from "../../src/forge/anchors";
import { createAnchorCommand, ForgeCommandStack } from "../../src/forge/forgeCommands";
import {
  createDefaultDisguiseState,
  validateDisguiseState,
  type AnchorState,
} from "../../src/mimic/disguiseState";

/** A named mesh standing in for a piece of map geometry. */
function surface(name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.name = name;
  return mesh;
}

function capture(
  object: THREE.Object3D,
  point: [number, number, number],
  normal: [number, number, number],
): AnchorCapture {
  return {
    bone: "foot_L",
    object,
    point: new THREE.Vector3(...point),
    normal: new THREE.Vector3(...normal).normalize(),
  };
}

function lookupOf(...objects: THREE.Object3D[]): (id: string) => THREE.Object3D | null {
  const byName = new Map(objects.map((object) => [object.name, object]));
  return (id) => byName.get(id) ?? null;
}

describe("anchor capture and resolve", () => {
  it("round-trips a contact point through the surface frame", () => {
    const floor = surface("floor");
    floor.position.set(2, 0, -1);
    floor.updateMatrixWorld(true);

    const anchor = captureAnchor("a", capture(floor, [2.4, 0.5, -0.7], [0, 1, 0]), 0);
    expect(anchor).not.toBeNull();

    const resolved = createResolvedAnchor();
    expect(resolveAnchor(anchor as AnchorState, lookupOf(floor), resolved)).toBe(true);
    expect(resolved.position.x).toBeCloseTo(2.4, 6);
    expect(resolved.position.y).toBeCloseTo(0.5, 6);
    expect(resolved.position.z).toBeCloseTo(-0.7, 6);
    expect(resolved.normal.y).toBeCloseTo(1, 6);
  });

  it("holds the point in the surface's frame when the surface moves", () => {
    const shelf = surface("shelf");
    shelf.updateMatrixWorld(true);
    const anchor = captureAnchor("a", capture(shelf, [0.2, 0.5, 0.1], [0, 1, 0]), 0);

    shelf.position.set(1, 0.25, -0.5);
    shelf.updateMatrixWorld(true);

    const resolved = createResolvedAnchor();
    expect(resolveAnchor(anchor as AnchorState, lookupOf(shelf), resolved)).toBe(true);
    // The contact rides along with the object it was sealed to.
    expect(resolved.position.x).toBeCloseTo(1.2, 6);
    expect(resolved.position.y).toBeCloseTo(0.75, 6);
    expect(resolved.position.z).toBeCloseTo(-0.4, 6);
  });

  it("keeps the contact in the surface's frame through a rotation", () => {
    const wall = surface("wall");
    wall.updateMatrixWorld(true);
    const anchor = captureAnchor("a", capture(wall, [0.3, 0.4, 0.5], [0, 0, 1]), 0);

    wall.rotation.y = Math.PI / 2;
    wall.updateMatrixWorld(true);

    const resolved = createResolvedAnchor();
    expect(resolveAnchor(anchor as AnchorState, lookupOf(wall), resolved)).toBe(true);
    // Rotating the wall a quarter turn about +Y takes local +Z to world +X.
    expect(resolved.position.x).toBeCloseTo(0.5, 6);
    expect(resolved.position.y).toBeCloseTo(0.4, 6);
    expect(resolved.position.z).toBeCloseTo(-0.3, 6);
    expect(resolved.normal.x).toBeCloseTo(1, 6);
  });

  it("lifts the contact off the surface by the requested gap", () => {
    const floor = surface("floor");
    floor.updateMatrixWorld(true);
    const anchor = captureAnchor("a", capture(floor, [0, 0.5, 0], [0, 1, 0]), 0.05);

    const resolved = createResolvedAnchor();
    resolveAnchor(anchor as AnchorState, lookupOf(floor), resolved);
    expect(resolved.position.y).toBeCloseTo(0.55, 6);
  });

  it("survives a normal parallel to the tangent seed", () => {
    const ceiling = surface("ceiling");
    ceiling.updateMatrixWorld(true);
    // A straight-up normal is the case a naive tangent basis degenerates on.
    const anchor = captureAnchor("a", capture(ceiling, [0.1, 0.5, -0.2], [0, 1, 0]), 0);
    const resolved = createResolvedAnchor();
    expect(resolveAnchor(anchor as AnchorState, lookupOf(ceiling), resolved)).toBe(true);
    expect(resolved.position.x).toBeCloseTo(0.1, 6);
    expect(resolved.position.z).toBeCloseTo(-0.2, 6);
  });

  it("refuses a surface with no stable id", () => {
    const anonymous = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    expect(captureAnchor("a", capture(anonymous, [0, 0, 0], [0, 1, 0]), 0)).toBeNull();
  });

  it("reports an anchor whose object has left the map", () => {
    const table = surface("table");
    table.updateMatrixWorld(true);
    const anchor = captureAnchor("a", capture(table, [0, 0.5, 0], [0, 1, 0]), 0);
    const resolved = createResolvedAnchor();
    expect(resolveAnchor(anchor as AnchorState, () => null, resolved)).toBe(false);
  });

  it("produces state the disguise validator accepts", () => {
    const floor = surface("floor");
    floor.updateMatrixWorld(true);
    const anchor = captureAnchor(nextAnchorId("foot_L"), capture(floor, [0, 0.5, 0], [0, 1, 0]), 0.01);
    const state = createDefaultDisguiseState();
    state.anchors = withAnchorOnBone(state.anchors, "foot_L", anchor);
    expect(validateDisguiseState(state)).toEqual([]);
  });
});

describe("panel tip reach", () => {
  const hinge = new THREE.Vector3(0, 1, 0);
  const upright = new THREE.Quaternion();
  const scratch = new THREE.Vector3();

  it("reads a target straight ahead of the hinge as zero angle", () => {
    // The plate lies along +y at angle 0, so a target above needs no rotation.
    const reach = solvePanelReach(hinge, upright, new THREE.Vector3(0, 1.5, 0), 0.3, scratch);
    expect(reach.angleRad).toBeCloseTo(0, 6);
    expect(reach.extensionM).toBeCloseTo(0.2, 6);
  });

  it("turns the hinge a quarter turn for a target square to the side", () => {
    const reach = solvePanelReach(hinge, upright, new THREE.Vector3(0, 1, 0.5), 0.2, scratch);
    expect(reach.angleRad).toBeCloseTo(Math.PI / 2, 6);
    expect(reach.extensionM).toBeCloseTo(0.3, 6);
  });

  it("reports a shortfall as a negative extension rather than pretending to reach", () => {
    const reach = solvePanelReach(hinge, upright, new THREE.Vector3(0, 1.1, 0), 0.4, scratch);
    expect(reach.extensionM).toBeLessThan(0);
  });

  it("measures reach in the hinge's own frame, not the world's", () => {
    // Turn the hinge frame a quarter turn about +y: its local +z now faces +x.
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const reach = solvePanelReach(hinge, turned, new THREE.Vector3(0.5, 1, 0), 0.2, scratch);
    expect(reach.angleRad).toBeCloseTo(Math.PI / 2, 6);
    expect(reach.extensionM).toBeCloseTo(0.3, 6);
  });

  it("ignores the component along the hinge axis, which no angle can reach", () => {
    // Off-axis distance is what the caller reports as the residual.
    const reach = solvePanelReach(hinge, upright, new THREE.Vector3(0.4, 1.5, 0), 0.3, scratch);
    expect(reach.angleRad).toBeCloseTo(0, 6);
    expect(reach.extensionM).toBeCloseTo(0.2, 6);
  });
});

describe("contact alignment", () => {
  const identity = new THREE.Quaternion();
  const out = new THREE.Quaternion();

  /** Where the contact face ends up pointing once `out` is applied. */
  function facingAfter(
    face: readonly [number, number, number],
    boneWorld: THREE.Quaternion,
    parentWorld: THREE.Quaternion,
  ): THREE.Vector3 {
    const worldAfter = parentWorld.clone().multiply(out);
    return new THREE.Vector3(...face).applyQuaternion(worldAfter);
  }

  it("puts a sole face-down on a floor", () => {
    const floorUp = new THREE.Vector3(0, 1, 0);
    // Foot tipped forward, sole pointing part-way at the wall instead of down.
    const boneWorld = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.6);
    solveContactAlignment([0, -1, 0], boneWorld, identity, floorUp, false, out);

    const facing = facingAfter([0, -1, 0], boneWorld, identity);
    expect(facing.y).toBeCloseTo(-1, 6);
  });

  it("leaves an already flat contact alone", () => {
    const floorUp = new THREE.Vector3(0, 1, 0);
    solveContactAlignment([0, -1, 0], identity, identity, floorUp, false, out);
    expect(Math.abs(out.w)).toBeCloseTo(1, 6);
  });

  it("puts a palm flat against a wall", () => {
    const wallNormal = new THREE.Vector3(1, 0, 0);
    const boneWorld = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.9);
    solveContactAlignment([0, 0, 1], boneWorld, identity, wallNormal, true, out);

    const facing = facingAfter([0, 0, 1], boneWorld, identity);
    // Reversible, so either face may meet the wall; it must lie flat on it.
    expect(Math.abs(facing.x)).toBeCloseTo(1, 6);
  });

  it("uses the nearer face of a reversible contact rather than turning right over", () => {
    const wallNormal = new THREE.Vector3(1, 0, 0);
    // Palm already turned away from the wall, so the back of the hand is nearer
    // and the correct answer is to leave the wrist where it is.
    const boneWorld = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    solveContactAlignment([0, 0, 1], boneWorld, identity, wallNormal, true, out);

    const facing = facingAfter([0, 0, 1], boneWorld, identity);
    expect(facing.x).toBeCloseTo(1, 6);
    expect(2 * Math.acos(Math.min(1, Math.abs(out.w)))).toBeCloseTo(Math.PI / 2, 5);
  });

  it("turns a one-sided contact right over when its face points the wrong way", () => {
    const floorUp = new THREE.Vector3(0, 1, 0);
    // Sole pointing at the ceiling: a foot has only one face, so it must flip.
    const boneWorld = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    solveContactAlignment([0, -1, 0], boneWorld, identity, floorUp, false, out);

    const facing = facingAfter([0, -1, 0], boneWorld, identity);
    expect(facing.y).toBeCloseTo(-1, 6);
  });

  it("expresses the result in the parent's frame", () => {
    const floorUp = new THREE.Vector3(0, 1, 0);
    const parentWorld = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.1);
    const boneWorld = parentWorld
      .clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.4));
    solveContactAlignment([0, -1, 0], boneWorld, parentWorld, floorUp, false, out);

    const facing = facingAfter([0, -1, 0], boneWorld, parentWorld);
    expect(facing.y).toBeCloseTo(-1, 6);
  });
});

describe("contact faces", () => {
  it("gives each foot and hand a face to present, and the pelvis none", () => {
    expect(CONTACT_FACE_NORMALS.foot_L).toEqual([0, -1, 0]);
    expect(CONTACT_FACE_NORMALS.hand_R).toEqual([0, 0, 1]);
    expect(CONTACT_FACE_NORMALS.pelvis).toBeUndefined();
  });

  it("lets a hand present either side but a sole only its underside", () => {
    expect(CONTACT_FACE_REVERSIBLE.hand_L).toBe(true);
    expect(CONTACT_FACE_REVERSIBLE.foot_L).toBeUndefined();
  });

  it("keeps every declared face a unit vector", () => {
    for (const face of Object.values(CONTACT_FACE_NORMALS)) {
      if (face === undefined) continue;
      expect(new THREE.Vector3(...face).length()).toBeCloseTo(1, 6);
    }
  });
});

describe("anchor bookkeeping", () => {
  it("names every anchorable contact point after its IK target", () => {
    for (const bone of ANCHORABLE_BONES) {
      expect(anchorTargetName(bone)).toBe(bone);
      expect(isAnchorableBone(bone)).toBe(true);
    }
    expect(isAnchorableBone("torso_upper")).toBe(false);
  });

  it("keeps one anchor per contact point", () => {
    const floor = surface("floor");
    floor.updateMatrixWorld(true);
    const first = captureAnchor("a", capture(floor, [0, 0.5, 0], [0, 1, 0]), 0);
    const second = captureAnchor("b", capture(floor, [0.3, 0.5, 0], [0, 1, 0]), 0);

    let anchors = withAnchorOnBone([], "foot_L", first);
    anchors = withAnchorOnBone(anchors, "foot_L", second);
    expect(anchors).toHaveLength(1);
    expect(anchorForBone(anchors, "foot_L")?.id).toBe("b");

    anchors = withAnchorOnBone(anchors, "foot_L", null);
    expect(anchorForBone(anchors, "foot_L")).toBeNull();
  });

  it("calls an anchor unsatisfied once the pose cannot reach it", () => {
    const floor = surface("floor");
    floor.updateMatrixWorld(true);
    const anchor = captureAnchor("a", capture(floor, [0, 0.5, 0], [0, 1, 0]), 0) as AnchorState;
    const resolved = createResolvedAnchor();
    resolveAnchor(anchor, lookupOf(floor), resolved);

    const onTarget = anchorResidual(resolved, new THREE.Vector3(0, 0.5, 0));
    const adrift = anchorResidual(resolved, new THREE.Vector3(0, 0.9, 0));
    expect(isAnchorSatisfied(anchor, onTarget)).toBe(true);
    expect(isAnchorSatisfied(anchor, adrift)).toBe(false);
    expect(adrift).toBeCloseTo(0.4, 6);
  });

  it("seals and releases through the undo stack", () => {
    const floor = surface("floor");
    floor.updateMatrixWorld(true);
    const anchor = captureAnchor("a", capture(floor, [0, 0.5, 0], [0, 1, 0]), 0);
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();

    stack.push(createAnchorCommand("foot_L", null, anchor, 0), state);
    expect(state.anchors).toHaveLength(1);

    stack.push(createAnchorCommand("foot_L", anchor, null, 1), state);
    expect(state.anchors).toHaveLength(0);

    stack.undo(state);
    expect(anchorForBone(state.anchors, "foot_L")?.id).toBe("a");

    stack.undo(state);
    expect(state.anchors).toHaveLength(0);
  });
});
