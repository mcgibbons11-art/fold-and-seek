import { ao } from "three/addons/tsl/display/GTAONode.js";
import { pass } from "three/tsl";
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { PIPELINE_EFFECTS, RenderPipeline } from "../../src/rendering/RenderPipeline";
import { qualitySettingsFor } from "../../src/rendering/quality";

/**
 * Effect resolution and the direct-render decision are pure bookkeeping, so
 * they are exercised without a graphics device. Building the node graph needs a
 * real backend and is covered by the in-browser verification instead.
 */
function pipelineFor(tier: Parameters<typeof qualitySettingsFor>[0]): RenderPipeline {
  return new RenderPipeline({} as THREE.WebGPURenderer, qualitySettingsFor(tier));
}

/**
 * Everything `RenderPipeline` asks of the renderer while it builds a graph and
 * wraps a compile. Nothing here needs a device: `pass()`, `ao()`, `bloom()` and
 * three's own `RenderPipeline` allocate render targets and node materials on the
 * CPU and touch the backend only once a frame is submitted through them.
 *
 * `setRenderTarget` is what makes the scene pass observable from outside.
 * `compileInScenePass` aims the renderer at the pass's own render target, and
 * that target is the thing a render context is keyed on in three r185 — so a
 * target that survives a phase change is the compiled programs surviving it.
 */
function stubRenderer(): { renderer: THREE.WebGPURenderer; passTargets: unknown[] } {
  const passTargets: unknown[] = [];
  const renderer = {
    getRenderTarget: () => null,
    getMRT: () => null,
    setRenderTarget: (target: unknown) => {
      if (target !== null) passTargets.push(target);
    },
    setMRT: () => undefined,
    render: () => undefined,
  };
  return { renderer: renderer as unknown as THREE.WebGPURenderer, passTargets };
}

/** A gameplay camera: its own object, its own framing, its own place to stand. */
function gameplayCamera(fovDeg: number, x: number, yaw: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(fovDeg, 16 / 9, 0.05, 60);
  camera.position.set(x, 1.6, 2.5);
  camera.rotation.set(-0.2, yaw, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** Reads back the camera the graph was built against, through the public seam. */
async function boundPassCamera(
  pipeline: RenderPipeline,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): Promise<THREE.PerspectiveCamera> {
  let bound: THREE.PerspectiveCamera | null = null;
  await pipeline.compileInScenePass(scene, camera, (passCamera) => {
    bound = passCamera;
    return Promise.resolve();
  });
  if (bound === null) throw new Error("compileInScenePass never ran its callback");
  return bound;
}

describe("RenderPipeline effect resolution", () => {
  it("takes its defaults from the tier", () => {
    const ultra = pipelineFor("ultra");
    expect(ultra.isEnabled("gtao")).toBe(true);
    expect(ultra.isEnabled("bloom")).toBe(true);

    const light = pipelineFor("light");
    expect(light.isEnabled("gtao")).toBe(false);
    expect(light.isEnabled("bloom")).toBe(false);
  });

  it("lets each effect be overridden on its own", () => {
    const pipeline = pipelineFor("ultra");
    pipeline.setEffectEnabled("bloom", false);

    expect(pipeline.isEnabled("bloom")).toBe(false);
    expect(pipeline.isEnabled("gtao")).toBe(true);
  });

  it("turns an effect on for a tier that does not ship it", () => {
    const pipeline = pipelineFor("low");
    pipeline.setEffectEnabled("bloom", true);

    expect(pipeline.isEnabled("bloom")).toBe(true);
    expect(pipeline.isEnabled("gtao")).toBe(false);
  });

  it("drops overrides on a tier change so the new tier defines the baseline", () => {
    const pipeline = pipelineFor("ultra");
    for (const effect of PIPELINE_EFFECTS) {
      pipeline.setEffectEnabled(effect, false);
    }
    pipeline.applyQuality(qualitySettingsFor("high"));

    for (const effect of PIPELINE_EFFECTS) {
      expect(pipeline.isEnabled(effect), effect).toBe(true);
    }
  });

  it("reports no active effects until a scene has been rendered through it", () => {
    // activeEffects describes the graph that exists, not the graph that would
    // be built, so an unbound pipeline is honestly empty.
    expect(pipelineFor("ultra").activeEffects).toEqual([]);
    expect(pipelineFor("ultra").isActive).toBe(false);
  });

  it("disposes cleanly before it ever built a graph", () => {
    const pipeline = pipelineFor("ultra");
    expect(() => {
      pipeline.dispose();
    }).not.toThrow();
  });
});

/**
 * The relink defect, and the invariant that closes it.
 *
 * The game's own diagnostics counted GPU pipelines climbing 437 → 539 → 646
 * across three rounds of one loaded shop, and instrumentation counted ~103
 * program relinks at each Forge entry. The cause was here: the graph was keyed
 * on the bound camera OBJECT, and a round swaps camera instances every phase —
 * the Forge owns one, the survey and the Inspector share another. Rebuilding
 * allocates a new scene-pass render target, a render context in three r185 is
 * keyed on the render target and the MRT, and a render object is cached against
 * its context, so every compiled program in the shop was orphaned at every
 * phase transition and linked again on the next frame.
 *
 * So the claim under test is not that the pictures match. It is that a change of
 * camera moves nothing the GPU has cached: the graph is built once, the scene
 * pass keeps its render target, and the frames the Forge draws bind the programs
 * the loading screen paid for.
 */
describe("RenderPipeline camera stability", () => {
  it("binds a second camera object without rebuilding the graph", () => {
    const { renderer } = stubRenderer();
    const pipeline = new RenderPipeline(renderer, qualitySettingsFor("ultra"));
    const scene = new THREE.Scene();

    pipeline.bind(scene, gameplayCamera(60, 0, 0));
    expect(pipeline.isActive).toBe(true);
    const afterFirst = pipeline.graphBuilds;

    pipeline.bind(scene, gameplayCamera(40, 3, 1.2));
    pipeline.bind(scene, gameplayCamera(75, -2, -0.6));

    expect(pipeline.graphBuilds).toBe(afterFirst);
    expect(pipeline.isActive).toBe(true);
    pipeline.dispose();
  });

  it("keeps one scene-pass render target across three phase swaps", async () => {
    const { renderer, passTargets } = stubRenderer();
    const pipeline = new RenderPipeline(renderer, qualitySettingsFor("ultra"));
    const scene = new THREE.Scene();
    // Survey, Forge, survey, Inspector: the sequence one round actually walks.
    const survey = gameplayCamera(58, 0, 0);
    const forge = gameplayCamera(40, 1.5, 0.9);
    const inspector = gameplayCamera(62, -1, 2.1);

    for (const camera of [survey, forge, survey, inspector]) {
      await boundPassCamera(pipeline, scene, camera);
    }

    expect(passTargets).toHaveLength(4);
    for (const target of passTargets) {
      expect(target).toBe(passTargets[0]);
    }
    expect(pipeline.graphBuilds).toBe(1);
    pipeline.dispose();
  });

  it("rebuilds exactly once when the effect set changes", () => {
    const { renderer } = stubRenderer();
    const pipeline = new RenderPipeline(renderer, qualitySettingsFor("ultra"));
    const scene = new THREE.Scene();

    pipeline.bind(scene, gameplayCamera(60, 0, 0));
    const afterFirst = pipeline.graphBuilds;

    // The MRT layout depends on which effects consume the pass, so this one has
    // to rebuild — and having rebuilt, it must settle.
    pipeline.setEffectEnabled("bloom", false);
    pipeline.bind(scene, gameplayCamera(40, 1, 0.5));
    expect(pipeline.graphBuilds).toBe(afterFirst + 1);
    expect(pipeline.activeEffects).toEqual(["gtao"]);

    pipeline.bind(scene, gameplayCamera(70, 2, 1));
    expect(pipeline.graphBuilds).toBe(afterFirst + 1);
    pipeline.dispose();
  });

  it("still rebuilds when the scene changes, because the pass holds the scene", () => {
    const { renderer } = stubRenderer();
    const pipeline = new RenderPipeline(renderer, qualitySettingsFor("ultra"));
    const camera = gameplayCamera(60, 0, 0);

    pipeline.bind(new THREE.Scene(), camera);
    const afterFirst = pipeline.graphBuilds;
    pipeline.bind(new THREE.Scene(), camera);

    expect(pipeline.graphBuilds).toBe(afterFirst + 1);
    pipeline.dispose();
  });

  it("draws from the gameplay camera's own view and projection", async () => {
    const { renderer } = stubRenderer();
    const pipeline = new RenderPipeline(renderer, qualitySettingsFor("ultra"));
    const scene = new THREE.Scene();
    const forge = gameplayCamera(40, 1.5, 0.9);

    const passCamera = await boundPassCamera(pipeline, scene, forge);

    // Not the gameplay camera, but indistinguishable to the renderer: culling and
    // drawing read matrixWorldInverse and projectionMatrix and nothing else.
    expect(passCamera).not.toBe(forge);
    expect(passCamera.matrixWorldInverse.elements).toEqual(
      Array.from(forge.matrixWorldInverse.elements),
    );
    const reference = new THREE.PerspectiveCamera(forge.fov, forge.aspect, forge.near, forge.far);
    reference.updateProjectionMatrix();
    expect(passCamera.projectionMatrix.elements).toEqual(
      Array.from(reference.projectionMatrix.elements),
    );
    // The sweep picks the drawables it compiles through this camera's mask, so a
    // mask left behind would compile a different set from the one drawn.
    forge.layers.enable(3);
    await boundPassCamera(pipeline, scene, forge);
    expect(passCamera.layers.mask).toBe(forge.layers.mask);
    pipeline.dispose();
  });

  it("follows a projection change onto the same matrix, without rebuilding", async () => {
    const { renderer } = stubRenderer();
    const pipeline = new RenderPipeline(renderer, qualitySettingsFor("ultra"));
    const scene = new THREE.Scene();

    const passCamera = await boundPassCamera(pipeline, scene, gameplayCamera(40, 0, 0));
    const projection = passCamera.projectionMatrix;
    const narrow = projection.elements[5];
    const builds = pipeline.graphBuilds;

    // A wider field of view, which is what the Inspector's own camera carries and
    // what a resize does through `aspect`. The AO node holds this exact Matrix4
    // through `uniform()`, so it has to be the object that changes.
    const again = await boundPassCamera(pipeline, scene, gameplayCamera(75, 0, 0));

    expect(again).toBe(passCamera);
    expect(passCamera.projectionMatrix).toBe(projection);
    expect(passCamera.fov).toBe(75);
    expect(projection.elements[5]).toBeLessThan(narrow);
    expect(pipeline.graphBuilds).toBe(builds);
    pipeline.dispose();
  });

  it("builds the pass and the AO node against that one camera, rebuild or not", async () => {
    const { renderer } = stubRenderer();
    const pipeline = new RenderPipeline(renderer, qualitySettingsFor("ultra"));
    const scene = new THREE.Scene();
    // Reaching into the graph is the point: the pass renders through the camera
    // it was constructed with and the AO node references that same object for
    // `near`, so "the graph is built against the pass camera" is the claim, and
    // it is not observable any other way.
    const graph = pipeline as unknown as {
      scenePass: { camera: THREE.Camera } | null;
      aoNode: { _cameraNear: { object: THREE.Camera } } | null;
    };

    const passCamera = await boundPassCamera(pipeline, scene, gameplayCamera(40, 0, 0));
    expect(graph.scenePass?.camera).toBe(passCamera);
    expect(graph.aoNode?._cameraNear.object).toBe(passCamera);

    // A rebuild the effect set genuinely asks for still lands on the same camera,
    // so the precompile the loading screen paid for is not stranded by one.
    pipeline.setEffectEnabled("bloom", false);
    pipeline.bind(scene, gameplayCamera(70, 2, 1));
    expect(graph.scenePass?.camera).toBe(passCamera);
    expect(graph.aoNode?._cameraNear.object).toBe(passCamera);
    pipeline.dispose();
  });

  it("brings a stale source camera's world matrix up to date before copying it", async () => {
    const { renderer } = stubRenderer();
    const pipeline = new RenderPipeline(renderer, qualitySettingsFor("ultra"));
    const scene = new THREE.Scene();
    const camera = gameplayCamera(60, 0, 0);

    // The Forge camera is moved by the player's orbit and only reaches three's
    // own `updateMatrixWorld` inside the render it is passed to. The copy happens
    // before that, so it has to do the update itself or draw a frame behind.
    camera.position.set(9, 4, -7);
    const passCamera = await boundPassCamera(pipeline, scene, camera);

    expect(passCamera.matrixWorld.elements[12]).toBeCloseTo(9, 6);
    expect(passCamera.matrixWorld.elements[14]).toBeCloseTo(-7, 6);
    expect(passCamera.matrixWorldInverse.elements).toEqual(
      Array.from(camera.matrixWorldInverse.elements),
    );
    pipeline.dispose();
  });
});

/**
 * The assumption the whole fix rests on, checked against three itself rather
 * than reasoned about: `GTAONode` binds `uniform(camera.projectionMatrix)` to
 * the camera it was constructed with, and the fix keeps that camera alive and
 * mutates it. If that uniform snapshotted the matrix instead of holding the
 * object, a field-of-view change would silently stop reaching the AO pass and
 * the node would have to be rebuilt on every projection change after all.
 */
describe("GTAONode camera binding", () => {
  it("holds the camera's own projection matrix rather than a copy of it", () => {
    const scene = new THREE.Scene();
    const camera = gameplayCamera(40, 0, 0);
    const scenePass = pass(scene, camera);
    const aoNode = ao(
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("normal"),
      camera,
    );
    const bound = aoNode as unknown as {
      _cameraProjectionMatrix: { value: THREE.Matrix4 };
      _cameraNear: { property: string; object: THREE.Camera };
    };

    expect(bound._cameraProjectionMatrix.value).toBe(camera.projectionMatrix);
    expect(bound._cameraNear.object).toBe(camera);

    const before = camera.projectionMatrix.elements[5];
    camera.fov = 75;
    camera.updateProjectionMatrix();

    expect(bound._cameraProjectionMatrix.value).toBe(camera.projectionMatrix);
    expect(bound._cameraProjectionMatrix.value.elements[5]).toBeLessThan(before);

    aoNode.dispose();
    scenePass.dispose();
  });
});
