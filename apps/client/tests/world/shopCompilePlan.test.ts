import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { shouldPumpShaderQueue } from "../../src/engine/GameHost";
import { RenderPipeline } from "../../src/rendering/RenderPipeline";
import { qualitySettingsFor } from "../../src/rendering/quality";
import {
  compileGroupKey,
  compileSceneInBatches,
  planShopCompile,
  queueAfterLead,
  ShaderQueue,
} from "../../src/world/ShopWorld";
import { MatchPhase } from "@foldseek/shared";

/**
 * The shape of the load, which is what the load's length actually is.
 *
 * The sweep this replaced compiled all 281 of the shop's drawables before the
 * round would open. The shop generates thirteen distinct shader programs, and
 * three keys a program on the generated source, so 268 of those calls linked
 * nothing: they built a node-builder state, hit the pipeline cache, and cost the
 * player a frame apiece. The load is now the 53 drawables that could possibly
 * carry a new program, and the lobby finishes the rest a frame at a time.
 *
 * A real compile needs a graphics device, so `compile` is a stub throughout.
 * That is enough, because every claim here is about which drawables are chosen
 * and in what order, not about what a driver does with them.
 */

function meshAt(z: number, material: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), material);
  mesh.name = name;
  mesh.position.set(0, 0, z);
  return mesh;
}

function cameraLookingDownNegativeZ(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 40);
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

describe("compile groups", () => {
  it("merges two drawables that provably generate the same shader", () => {
    // Same material object, and geometries that differ in their vertices but
    // not in which attributes they carry. Nothing the generator reads differs,
    // so one compile covers both — this is the merge the whole pass rests on.
    const material = new THREE.MeshStandardMaterial();
    const one = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    const two = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 9), material);

    expect(compileGroupKey(one)).toBe(compileGroupKey(two));
  });

  it("splits on every object property the generator branches on", () => {
    const material = new THREE.MeshStandardMaterial();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const plain = new THREE.Mesh(geometry, material);

    const instanced = new THREE.InstancedMesh(geometry, material, 4);
    expect(compileGroupKey(instanced)).not.toBe(compileGroupKey(plain));

    const shadowed = new THREE.Mesh(geometry, material);
    shadowed.receiveShadow = true;
    expect(compileGroupKey(shadowed)).not.toBe(compileGroupKey(plain));

    const coloured = new THREE.Mesh(geometry.clone(), material);
    coloured.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(1), 3),
    );
    expect(compileGroupKey(coloured)).not.toBe(compileGroupKey(plain));
  });

  it("splits on material identity rather than on a reading of its properties", () => {
    // Two materials configured identically are one program, and this key still
    // separates them. That is deliberate: identity is a guarantee and a reading
    // is an audit, and an audit that misses a branch is a program the loading
    // screen never builds and the first frame links instead. The cost of the
    // extra group is a node-graph build, which is milliseconds against a link.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const one = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.5 }));
    const two = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.5 }));

    expect(compileGroupKey(one)).not.toBe(compileGroupKey(two));
  });
});

describe("the lead sweep and what it leaves behind", () => {
  it("leads with one drawable per group and queues every other one", () => {
    const scene = new THREE.Scene();
    const walnut = new THREE.MeshStandardMaterial();
    const brass = new THREE.MeshStandardMaterial();
    for (let index = 0; index < 5; index += 1) {
      scene.add(meshAt(-2 - index, walnut, `walnut-${index}`));
    }
    for (let index = 0; index < 3; index += 1) {
      scene.add(meshAt(-8 - index, brass, `brass-${index}`));
    }
    scene.updateMatrixWorld(true);

    const plan = planShopCompile(scene, cameraLookingDownNegativeZ());

    expect(plan.lead.map((object) => object.name)).toEqual(["walnut-0", "brass-0"]);
    expect(plan.remainder).toHaveLength(6);
    // Disjoint and complete: nothing is compiled twice and nothing is dropped.
    const all = [...plan.lead, ...plan.remainder].map((object) => object.name);
    expect(new Set(all).size).toBe(8);
    // Every group has a leader, which is the claim that makes the sweep safe.
    const leadKeys = new Set(plan.lead.map(compileGroupKey));
    for (const object of plan.remainder) {
      expect(leadKeys.has(compileGroupKey(object))).toBe(true);
    }
  });

  it("skips what a frame would skip: hidden subtrees and unrendered layers", () => {
    const scene = new THREE.Scene();
    const materials = [0, 1, 2].map(() => new THREE.MeshStandardMaterial());
    const meshes = materials.map((material, index) => meshAt(-2 - index, material, `mesh-${index}`));
    for (const mesh of meshes) scene.add(mesh);
    (meshes[1] as THREE.Mesh).visible = false;
    (meshes[2] as THREE.Mesh).layers.set(2);
    scene.updateMatrixWorld(true);

    const plan = planShopCompile(scene, cameraLookingDownNegativeZ());

    expect([...plan.lead, ...plan.remainder].map((object) => object.name)).toEqual(["mesh-0"]);
  });

  it("compiles exactly the drawables it is handed, and only those", async () => {
    const scene = new THREE.Scene();
    const material = new THREE.MeshStandardMaterial();
    const meshes = [0, 1, 2, 3].map((index) => meshAt(-2 - index, material, `mesh-${index}`));
    for (const mesh of meshes) scene.add(mesh);
    scene.updateMatrixWorld(true);
    const compiled: string[] = [];

    const result = await compileSceneInBatches({
      scene,
      camera: cameraLookingDownNegativeZ(),
      drawables: [meshes[2] as THREE.Mesh, meshes[0] as THREE.Mesh],
      compile: (object) => {
        compiled.push(object.name);
        return Promise.resolve();
      },
      now: () => 0,
    });

    expect(compiled).toEqual(["mesh-2", "mesh-0"]);
    expect(result.total).toBe(2);
    expect(result.compiled).toBe(2);
  });

  it("puts leaders the deadline never reached at the front of the lobby's queue", () => {
    // A leader still has a program to link and a follower cannot, so a lobby
    // that only gets partway through the queue should spend that time on the
    // leaders. Reversing the two halves here fails the assertion.
    const lead = [new THREE.Object3D(), new THREE.Object3D(), new THREE.Object3D()];
    const remainder = [new THREE.Object3D()];
    lead.forEach((object, index) => (object.name = `lead-${index}`));
    remainder.forEach((object, index) => (object.name = `rest-${index}`));

    const queued = queueAfterLead({ lead, remainder }, 1);

    expect(queued.map((object) => object.name)).toEqual(["lead-1", "lead-2", "rest-0"]);
  });
});

/**
 * Everything the pipeline asks of a renderer while it aims at the scene pass.
 * The aim is what a render context is keyed on in three r185, so the sequence of
 * targets is the only thing about this that matters from outside.
 */
function stubRenderer(): { renderer: THREE.WebGPURenderer; targets: unknown[] } {
  const targets: unknown[] = [];
  let current: unknown = null;
  const renderer = {
    getRenderTarget: () => current,
    getMRT: () => null,
    setRenderTarget: (target: unknown) => {
      current = target;
      targets.push(target);
    },
    setMRT: () => undefined,
    render: () => undefined,
  };
  return { renderer: renderer as unknown as THREE.WebGPURenderer, targets };
}

describe("the lobby's share of the sweep", () => {
  function queueOf(count: number): { queue: ShaderQueue; meshes: THREE.Mesh[] } {
    const material = new THREE.MeshStandardMaterial();
    const meshes = Array.from({ length: count }, (_, index) => meshAt(-2 - index, material, `mesh-${index}`));
    return { queue: new ShaderQueue(meshes), meshes };
  }

  const { renderer, targets } = stubRenderer();
  const post = new RenderPipeline(renderer, qualitySettingsFor("high"));
  const scene = new THREE.Scene();
  const camera = cameraLookingDownNegativeZ();

  it("drains one drawable per call, in order, and reports when it is spent", async () => {
    const { queue } = queueOf(3);
    const compiled: string[] = [];
    const compile = (object: THREE.Object3D): Promise<void> => {
      compiled.push(object.name);
      return Promise.resolve();
    };

    // Eight frames for three drawables: the queue must go quiet, not wrap.
    const answers: boolean[] = [];
    for (let frame = 0; frame < 8; frame += 1) {
      answers.push(await queue.next(scene, camera, post, compile));
    }

    expect(compiled).toEqual(["mesh-0", "mesh-1", "mesh-2"]);
    expect(answers).toEqual([true, true, true, false, false, false, false, false]);
    expect(queue.size).toBe(0);
  });

  it("uncalls culling for the one drawable it compiles and puts the flag back", async () => {
    const { queue, meshes } = queueOf(2);
    (meshes[1] as THREE.Mesh).frustumCulled = false;
    const seen: boolean[] = [];

    while (await queue.next(scene, camera, post, (object) => {
      seen.push(object.frustumCulled);
      return Promise.resolve();
    })) {
      // drains
    }

    expect(seen).toEqual([false, false]);
    expect(meshes.map((mesh) => mesh.frustumCulled)).toEqual([true, false]);
  });

  it("hands the render target back before it waits on the compile", async () => {
    // A frame is drawn between every one of these calls, and a frame drawn while
    // the renderer still points at the scene pass's own texture composites into
    // that texture instead of onto the canvas. The compile is still ISSUED under
    // the pass's aim, which is what makes its programs the ones the game binds.
    const { queue } = queueOf(1);
    targets.length = 0;
    let aimedDuringCompile: unknown = "never ran";
    let release: (() => void) | null = null;

    const pending = queue.next(scene, camera, post, () => {
      aimedDuringCompile = renderer.getRenderTarget();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    expect(aimedDuringCompile).not.toBeNull();
    expect(aimedDuringCompile).not.toBe("never ran");
    // Back to the canvas already, with the compile still outstanding.
    expect(renderer.getRenderTarget()).toBeNull();
    release?.();
    await pending;
    expect(renderer.getRenderTarget()).toBeNull();
  });

  it("never rebuilds the post graph, however many frames it runs across", async () => {
    // A rebuilt graph allocates a new scene-pass render target, a render context
    // in three r185 is keyed on that target, and a render object is cached
    // against its context — so one rebuild throws away every program the load
    // just paid for. The queue borrows the aim; it must not re-aim anything.
    const { queue } = queueOf(6);
    const before = post.graphBuilds;

    while (await queue.next(scene, camera, post, () => Promise.resolve())) {
      // one drawable per simulated frame
    }

    expect(post.graphBuilds).toBe(before);
  });

  it("gives up the whole queue when it is cleared", async () => {
    const { queue } = queueOf(4);
    queue.clear();
    expect(queue.size).toBe(0);
    expect(await queue.next(scene, camera, post, () => Promise.resolve())).toBe(false);
  });
});

describe("when the lobby's sweep may run", () => {
  it("runs before the hunt and stops for it", () => {
    for (const phase of [MatchPhase.Lobby, MatchPhase.MapIntro, MatchPhase.RoleReveal, MatchPhase.Forge]) {
      expect(shouldPumpShaderQueue(10, false, phase), phase).toBe(true);
    }
    for (const phase of [MatchPhase.InspectionIntro, MatchPhase.Inspection, MatchPhase.FinalCountdown]) {
      expect(shouldPumpShaderQueue(10, false, phase), phase).toBe(false);
    }
  });

  it("never starts a second compile over the top of one in flight", () => {
    expect(shouldPumpShaderQueue(10, true, MatchPhase.Lobby)).toBe(false);
  });

  it("does nothing once the queue is spent", () => {
    expect(shouldPumpShaderQueue(0, false, MatchPhase.Lobby)).toBe(false);
  });

  it("runs before the authority has said what phase it is", () => {
    // The round opens before the first state arrives, and that is exactly the
    // window the queue exists to use.
    expect(shouldPumpShaderQueue(10, false, null)).toBe(true);
  });
});
