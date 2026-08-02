import * as THREE from "three/webgpu";

import { DisposalBag } from "../engine/DisposalBag";
import type { ForgeWorkspace } from "../forge/ForgeController";
import type { QualitySettings } from "../rendering/quality";
import type { RenderPipeline } from "../rendering/RenderPipeline";
import { CuriosityShop, type CuriosityShopMap, type ShopBuildStep } from "./maps/CuriosityShop";
import { createShopEnvironment } from "./maps/lighting";
import {
  SHOP_MAX_X,
  SHOP_MAX_Z,
  SHOP_MIN_X,
  SHOP_MIN_Z,
  WALL_HEIGHT,
} from "./maps/zones";

/**
 * The volume a Mimic may be folded inside on this map. It reaches the walls and
 * the ceiling rather than stopping short of them, because mounting on a wall
 * and hanging from a fitting are both legal disguises (§7.15, §7.16). The floor
 * bound sits a hair above zero so nothing is posed inside the boards.
 */
export const SHOP_FORGE_WORKSPACE: ForgeWorkspace = {
  minX: SHOP_MIN_X,
  maxX: SHOP_MAX_X,
  minY: 0.02,
  maxY: WALL_HEIGHT,
  minZ: SHOP_MIN_Z,
  maxZ: SHOP_MAX_Z,
};

/**
 * Longest the loading screen will wait on the shader precompile before letting
 * the round proceed with lazy compilation. Generous for a healthy GPU (the
 * whole-shop compile is seconds there) and a ceiling for a contended one.
 *
 * It is checked BETWEEN batches and is therefore a promise the code can keep. It
 * used to be a `setTimeout` raced against one whole-scene `compileAsync`, which
 * is unenforceable by construction: a timer is a task and cannot interrupt the
 * call it is racing.
 */
export const SHOP_PRECOMPILE_DEADLINE_MS = 20_000;

/**
 * Drawables compiled between yields. Small enough that the deadline is checked
 * often and the loading screen keeps moving, large enough that the per-call
 * overhead of building a render list stays a rounding error beside a link.
 */
export const SHOP_PRECOMPILE_BATCH = 8;

export interface BatchedCompileOptions {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  /** Builds every program one drawable needs. `renderer.compileAsync` in the game. */
  readonly compile: (object: THREE.Object3D) => Promise<void>;
  /** Run after each batch: paint the progress, hand the frame back. */
  readonly onBatch?: (done: number, total: number) => Promise<void> | void;
  readonly deadlineMs?: number;
  readonly batchSize?: number;
  /** Injected so a test can drive the deadline without waiting for one. */
  readonly now?: () => number;
}

export interface BatchedCompileResult {
  readonly compiled: number;
  readonly total: number;
  /** True when the deadline cut the sweep short, leaving the tail to lazy compilation. */
  readonly deadlineHit: boolean;
}

/** Every drawable a frame of this scene would submit, in render-list order. */
function collectDrawables(scene: THREE.Scene, camera: THREE.Camera): THREE.Object3D[] {
  const drawables: THREE.Object3D[] = [];
  // traverseVisible skips a hidden subtree exactly as the render list does, and
  // the layer test is the other half of that rule: the merged Mimic bodies park
  // their source parts on a layer nothing renders, and compiling those would be
  // programs no frame ever binds.
  scene.traverseVisible((object) => {
    const drawable = object as THREE.Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
    if (drawable.isMesh !== true && drawable.isLine !== true && drawable.isPoints !== true && drawable.isSprite !== true) {
      return;
    }
    if (!object.layers.test(camera.layers)) return;
    drawables.push(object);
  });
  return drawables;
}

/**
 * The drawables the camera can see, then everything else.
 *
 * Ordering is what makes the deadline survivable. Whatever the sweep does not
 * reach is compiled lazily, on the frame that first draws it, and on the WebGL 2
 * backend that compilation is synchronous — so the one set that must never be
 * left behind is the set the very next frame submits. Compiling it first means a
 * deadline cuts only the tail the player walks into later, one prop at a time,
 * instead of the whole first frame at once.
 */
function visibleFirst(drawables: readonly THREE.Object3D[], camera: THREE.Camera): THREE.Object3D[] {
  const projection = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  camera.updateMatrixWorld();
  projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projection, camera.coordinateSystem);

  const inView: THREE.Object3D[] = [];
  const rest: THREE.Object3D[] = [];
  for (const object of drawables) {
    (frustum.intersectsObject(object as THREE.Mesh) ? inView : rest).push(object);
  }
  return [...inView, ...rest];
}

/**
 * Compiles a scene one small batch at a time, yielding between batches and
 * stopping at a wall-clock deadline.
 *
 * Frustum culling is turned off for the single object being compiled and put
 * straight back, rather than off across the whole map for the length of the
 * call. That is the structural difference from what this replaced: with culling
 * off globally, one `compileAsync` queues every program in the shop and the
 * backend's completion polling runs them all inside one animation frame, which
 * is how a load became an unbroken 85-second stall with a loading screen frozen
 * on a single number behind it.
 */
export async function compileSceneInBatches(
  options: BatchedCompileOptions,
): Promise<BatchedCompileResult> {
  const batchSize = Math.max(1, options.batchSize ?? SHOP_PRECOMPILE_BATCH);
  const deadlineMs = options.deadlineMs ?? SHOP_PRECOMPILE_DEADLINE_MS;
  const now = options.now ?? (() => performance.now());

  options.scene.updateMatrixWorld();
  const ordered = visibleFirst(collectDrawables(options.scene, options.camera), options.camera);
  const startedAt = now();
  let compiled = 0;

  for (let index = 0; index < ordered.length; index += batchSize) {
    if (now() - startedAt >= deadlineMs) {
      return { compiled, total: ordered.length, deadlineHit: true };
    }
    for (const object of ordered.slice(index, index + batchSize)) {
      const culled = object.frustumCulled;
      object.frustumCulled = false;
      try {
        await options.compile(object);
      } finally {
        object.frustumCulled = culled;
      }
      compiled += 1;
    }
    await options.onBatch?.(compiled, ordered.length);
  }

  return { compiled, total: ordered.length, deadlineHit: false };
}

/**
 * The scene a round is played in: The Curiosity Shop and the environment that
 * lights it, and nothing else. It deliberately owns no camera, because during a
 * round the camera belongs to whichever system has the player, the Forge orbit,
 * the Inspector rig, or the survey view between phases.
 */
export class ShopWorld {
  readonly scene: THREE.Scene;
  readonly map: CuriosityShopMap;

  private readonly bag = new DisposalBag();

  constructor(renderer: THREE.WebGPURenderer, settings: QualitySettings, map?: CuriosityShopMap) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08070a);
    this.scene.environment = this.bag.add(createShopEnvironment(renderer));
    this.scene.environmentIntensity = 0.55;

    this.map = map ?? new CuriosityShop().build(settings);
    this.scene.add(this.map.root);
  }

  /**
   * Builds the map across several turns, handing each finished piece back so a
   * caller can yield to the browser between them, and wraps the result.
   *
   * The environment map is generated first because it is one prefiltered render
   * and there is nothing to divide; everything after it is the shop itself.
   */
  static async createIncremental(
    renderer: THREE.WebGPURenderer,
    settings: QualitySettings,
    onStep: (step: ShopBuildStep) => Promise<void>,
  ): Promise<ShopWorld> {
    const steps = new CuriosityShop().buildSteps(settings);
    let step = steps.next();
    while (step.done !== true) {
      await onStep(step.value);
      step = steps.next();
    }
    return new ShopWorld(renderer, settings, step.value);
  }

  /**
   * Builds every shader the shop needs before the first frame that draws it,
   * a batch at a time, into the render context the frames will actually use.
   *
   * Two things make this different from calling `renderer.compileAsync` on the
   * whole scene, and both were load-bearing enough to be worth the machinery.
   *
   * It compiles through `post.compileInScenePass`, so the programs it builds are
   * the ones the post chain binds. Without that the sweep builds a shop's worth
   * of programs against the renderer's default target and no MRT, the first
   * frame finds none of them under its own multiple-render-target layout, and
   * links every one again on the main thread with nothing to wait on.
   *
   * And it yields between small batches, so the deadline below is a promise the
   * code can keep and the loading screen goes on moving while it runs.
   *
   * Shadow passes are still not covered: three builds those pipelines from the
   * shadow camera on the first frame that casts, and there is no public
   * precompile for them.
   *
   * The sweep is BEST-EFFORT, not a gate. Measured in the Portals editor's 2p
   * preview on an integrated GPU, two panes compiling the whole shop at once sat
   * at "95% · the shaders" for minutes — a loading screen that never ends is
   * worse than the hitches it prevents. Past the deadline the load proceeds and
   * whatever is left is built lazily on the frames that first draw it, which is
   * why `visibleFirst` puts the camera's own view at the front of the queue.
   */
  async precompile(
    renderer: THREE.WebGPURenderer,
    post: RenderPipeline,
    camera: THREE.PerspectiveCamera,
    onBatch?: (done: number, total: number) => Promise<void> | void,
  ): Promise<BatchedCompileResult> {
    // The sweep compiles through the pass's own camera rather than the one the
    // round happens to be holding, because that is the camera every later frame
    // binds: the post chain builds its graph once, against a camera of its own,
    // and copies whichever gameplay camera is drawing onto it.
    return post.compileInScenePass(this.scene, camera, (passCamera) =>
      compileSceneInBatches({
        scene: this.scene,
        camera: passCamera,
        compile: (object) => renderer.compileAsync(object, passCamera, this.scene),
        onBatch,
      }),
    );
  }

  applyQuality(settings: QualitySettings): void {
    this.map.applyQuality(settings);
  }

  dispose(): void {
    this.map.dispose();
    this.scene.clear();
    this.bag.dispose();
  }
}
