import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { compileSceneInBatches } from "../../src/world/ShopWorld";

/**
 * The shader sweep that opens a round.
 *
 * What is under test is the *shape* of the sweep, because that is what the
 * measured failure was. On the WebGL 2 backend, one `compileAsync` over a scene
 * with frustum culling switched off across the map queues every program in the
 * shop at once, and the backend's completion polling then runs the lot inside a
 * single animation frame: 1,098 `getProgramParameter` calls totalling 87.9
 * seconds, one unbroken 85-second gap between frames, and a loading screen
 * frozen on one number behind it. The 20-second deadline it was raced against
 * could not fire, because a timer is a task and cannot interrupt the call it is
 * racing.
 *
 * So the claims here are: the sweep compiles one drawable at a time, it hands
 * the frame back between small batches, the deadline is checked at those seams
 * and actually stops the sweep, and what the camera can see is compiled first,
 * since whatever the deadline cuts is what the frames after it pay for.
 *
 * A real compile needs a graphics device, so `compile` is a stub that counts and
 * can be told how long to take. That is enough: every claim above is about the
 * order and the timing of the calls, not about what a driver does with them.
 */

interface Recorded {
  readonly names: string[];
  readonly batchSizes: number[];
}

/** Drawables strung out in front of the camera, all of them in view. */
function sceneOf(count: number): THREE.Scene {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  for (let index = 0; index < count; index += 1) {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.name = `mesh-${index}`;
    mesh.position.set(0, 0, -2 - index * 0.05);
    scene.add(mesh);
  }
  scene.updateMatrixWorld(true);
  return scene;
}

function cameraLookingDownNegativeZ(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 40);
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function record(): { readonly recorded: Recorded; compile: (object: THREE.Object3D) => Promise<void> } {
  const recorded: Recorded = { names: [], batchSizes: [] };
  return {
    recorded,
    compile: (object) => {
      recorded.names.push(object.name);
      return Promise.resolve();
    },
  };
}

describe("shader sweep batching", () => {
  it("compiles one drawable per call rather than the whole scene at once", async () => {
    const scene = sceneOf(20);
    const { recorded, compile } = record();

    const result = await compileSceneInBatches({
      scene,
      camera: cameraLookingDownNegativeZ(),
      compile,
      batchSize: 4,
      now: () => 0,
    });

    expect(result.total).toBe(20);
    expect(result.compiled).toBe(20);
    expect(result.deadlineHit).toBe(false);
    expect(new Set(recorded.names).size).toBe(20);
  });

  it("hands the frame back between batches, and only between batches", async () => {
    const scene = sceneOf(20);
    const { recorded, compile } = record();
    const yieldedAt: number[] = [];

    await compileSceneInBatches({
      scene,
      camera: cameraLookingDownNegativeZ(),
      compile,
      batchSize: 4,
      now: () => 0,
      onBatch: (done) => {
        yieldedAt.push(done);
      },
    });

    // Five yields for twenty drawables at four a batch, each landing on a batch
    // boundary. A sweep that yielded once at the end would pass the count test
    // above and still freeze the tab, so the boundaries are the assertion.
    expect(yieldedAt).toEqual([4, 8, 12, 16, 20]);
    expect(recorded.names).toHaveLength(20);
  });

  it("stops at the deadline instead of running the sweep out", async () => {
    const scene = sceneOf(40);
    const { recorded, compile } = record();
    // A clock that advances 100 ms every time it is read: the deadline is
    // checked once per batch, so it lands after a whole number of batches.
    let clock = 0;
    const result = await compileSceneInBatches({
      scene,
      camera: cameraLookingDownNegativeZ(),
      compile,
      batchSize: 4,
      deadlineMs: 250,
      now: () => {
        clock += 100;
        return clock;
      },
    });

    expect(result.deadlineHit).toBe(true);
    expect(result.compiled).toBeLessThan(result.total);
    expect(recorded.names).toHaveLength(result.compiled);
  });

  it("compiles what the camera can see before what it cannot", async () => {
    // Whatever the deadline cuts is compiled lazily on a later frame, and on
    // WebGL 2 that compile is synchronous — so the set that must never be cut is
    // the set the very next frame submits.
    //
    // The four behind the camera are added to the scene FIRST, so scene order
    // and the order the sweep should use are opposites: with the visible-first
    // pass removed this test fails rather than passing by accident.
    const scene = new THREE.Scene();
    const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    for (let index = 0; index < 4; index += 1) {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
      mesh.name = `behind-${index}`;
      mesh.position.set(0, 0, 6 + index);
      scene.add(mesh);
    }
    for (let index = 0; index < 6; index += 1) {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
      mesh.name = `ahead-${index}`;
      mesh.position.set(0, 0, -2 - index);
      scene.add(mesh);
    }
    scene.updateMatrixWorld(true);
    const { recorded, compile } = record();

    await compileSceneInBatches({
      scene,
      camera: cameraLookingDownNegativeZ(),
      compile,
      batchSize: 3,
      now: () => 0,
    });

    expect(recorded.names).toHaveLength(10);
    const firstBehind = recorded.names.findIndex((name) => name.startsWith("behind-"));
    const lastAhead = recorded.names.reduce(
      (last, name, index) => (name.startsWith("ahead-") ? index : last),
      -1,
    );
    expect(lastAhead).toBe(5);
    expect(firstBehind).toBe(6);
  });

  it("leaves every frustum-culling flag exactly as it found it", async () => {
    // Culling is switched off for the one object being compiled and put back
    // immediately, rather than off across the map for the length of the sweep.
    // Leaving it off would uncull the whole shop for the rest of the round.
    const scene = sceneOf(6);
    const meshes = scene.children as THREE.Mesh[];
    (meshes[2] as THREE.Mesh).frustumCulled = false;

    await compileSceneInBatches({
      scene,
      camera: cameraLookingDownNegativeZ(),
      compile: (object) => {
        expect(object.frustumCulled).toBe(false);
        return Promise.resolve();
      },
      batchSize: 2,
      now: () => 0,
    });

    expect(meshes.map((mesh) => mesh.frustumCulled)).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
  });

  it("skips what a frame would skip: hidden subtrees and unrendered layers", async () => {
    const scene = sceneOf(6);
    const meshes = scene.children as THREE.Mesh[];
    // A hidden part and a part parked on the layer the merged Mimic bodies use.
    // Compiling either builds a program no frame ever binds.
    (meshes[1] as THREE.Mesh).visible = false;
    (meshes[3] as THREE.Mesh).layers.set(2);
    const { recorded, compile } = record();

    await compileSceneInBatches({
      scene,
      camera: cameraLookingDownNegativeZ(),
      compile,
      batchSize: 2,
      now: () => 0,
    });

    expect(recorded.names).not.toContain("mesh-1");
    expect(recorded.names).not.toContain("mesh-3");
    expect(recorded.names).toHaveLength(4);
  });
});
