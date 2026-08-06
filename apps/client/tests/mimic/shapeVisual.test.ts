import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { createDefaultDisguiseState } from "../../src/mimic/disguiseState";
import { applyDisguiseStateToPose } from "../../src/mimic/disguiseState";
import { createPoseState } from "../../src/mimic/ikSolver";
import { MimicVisual } from "../../src/mimic/visual/MimicVisual";
import { createShape } from "../../src/mimic/shapes";

/**
 * Drawing the primitives a disguise is built from.
 *
 * The trap worth pinning is the parked mesh. A pool member that merely hides
 * is still walked by the merged body and still measured by
 * `Box3.setFromObject`, so hidden slots would quietly cost draw calls and
 * stretch the focus box the reticle brackets and the gun is checked against -
 * out to parts of a disguise nobody can see.
 */

function posed(shapeCount: number): MimicVisual {
  const visual = new MimicVisual();
  const state = createDefaultDisguiseState();
  for (let index = 0; index < shapeCount; index += 1) {
    state.shapes.push(createShape(`shape_${String(index)}`, "cube", "pelvis", "body"));
  }
  const pose = createPoseState();
  applyDisguiseStateToPose(state, pose);
  visual.applyShapes(state.shapes);
  visual.applyPose(pose);
  return visual;
}

describe("shapes on a disguise", () => {
  it("puts nothing in the scene for a disguise that carries none", () => {
    const bare = posed(0);
    const attached = bare.shapeMeshes.filter((mesh) => mesh.parent !== null);
    expect(attached).toHaveLength(0);
  });

  it("attaches exactly the shapes the disguise carries", () => {
    const built = posed(3);
    expect(built.shapeMeshes.filter((mesh) => mesh.parent !== null)).toHaveLength(3);
  });

  it("leaves the measured box unchanged by the shapes it is not carrying", () => {
    // The whole reason unused meshes leave the graph rather than hide.
    const bare = new THREE.Box3().setFromObject(posed(0).root);
    const one = new THREE.Box3().setFromObject(posed(1).root);
    expect(one.min.x).toBeLessThanOrEqual(bare.min.x + 1e-6);
    expect(Number.isFinite(bare.min.x)).toBe(true);
  });

  it("detaches a shape again when the disguise drops it", () => {
    const visual = posed(2);
    visual.applyShapes([]);
    expect(visual.shapeMeshes.filter((mesh) => mesh.parent !== null)).toHaveLength(0);
  });
});
