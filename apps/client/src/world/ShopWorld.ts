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
 * the round proceed with lazy compilation.
 *
 * Two minutes, not twenty seconds, and the length is deliberate: on drivers
 * where every program link BLOCKS (measured on this ANGLE/D3D11 Intel path at
 * ~1.4 s per link even under KHR_parallel_shader_compile), bailing early does
 * not save the player anything — the uncompiled remainder links synchronously
 * inside the first frame that draws it, which is the exact multi-minute
 * unresponsive tab the sweep exists to prevent. One completed sweep also
 * populates Chrome's shader disk cache, so every later load of the same build
 * is seconds. A moving progress bar for up to two minutes ONCE beats a dead
 * tab every time.
 *
 * It is checked BETWEEN drawables and is therefore a promise the code can keep.
 */
export const SHOP_PRECOMPILE_DEADLINE_MS = 120_000;

/**
 * Drawables compiled between yields. ONE, because on a blocking driver a
 * single link can take over a second, and a batch of eight stalls the tab in
 * ten-second chunks — long enough for the browser to declare the page
 * unresponsive and for the player to kill it ("it crashes on the shaders").
 * The per-call overhead of a one-drawable render list is a rounding error
 * beside a link on any driver where the batch size matters at all.
 */
export const SHOP_PRECOMPILE_BATCH = 1;

export interface BatchedCompileOptions {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  /** Builds every program one drawable needs. `renderer.compileAsync` in the game. */
  readonly compile: (object: THREE.Object3D) => Promise<void>;
  /**
   * Sweeps exactly these drawables, in this order, instead of collecting and
   * ordering the scene's own. The round hands in the lead set of
   * `planShopCompile`; leaving it out sweeps the whole scene as before.
   */
  readonly drawables?: readonly THREE.Object3D[];
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
 * Drawables that provably need the same shader program.
 *
 * A program in three r185 is keyed on the generated shader SOURCE
 * (`Pipelines.getForRender` looks a stage up by `nodeBuilderState.vertexShader`
 * as a string, and the WebGL fallback contributes nothing else to the pipeline
 * cache key), and the only inputs to generation are the material, the object,
 * the geometry and the scene. Two drawables sharing the same material OBJECT and
 * agreeing on every object and geometry property the generator branches on
 * therefore generate the same text, character for character. That is an argument
 * rather than an audit, which is why the key is the material's identity and not
 * a reading of its properties: a reading can miss a branch, and a missed branch
 * is a program the sweep never built.
 *
 * It splits more finely than the shader really needs: thirty-two materials over
 * fifty-three groups where the shop only generates thirteen distinct programs,
 * because a swatch that differs only in colour is a second material object and
 * the same text. The waste is a node-graph build apiece and no link at all,
 * which is milliseconds against the second-plus a link costs on this driver.
 */
export function compileGroupKey(object: THREE.Object3D): string {
  const mesh = object as THREE.Mesh & {
    isInstancedMesh?: boolean;
    isSkinnedMesh?: boolean;
    isBatchedMesh?: boolean;
    instanceColor?: unknown;
  };
  const material = mesh.material;
  const materialKey = Array.isArray(material)
    ? material.map((entry) => entry.uuid).join("+")
    : (material as THREE.Material | undefined)?.uuid ?? "none";
  const geometry = mesh.geometry as THREE.BufferGeometry | undefined;

  return [
    materialKey,
    // NodeMaterial.setupPosition branches on skinning, instancing and batching;
    // setupDiffuseColor branches again on the instance and batch colour.
    mesh.isSkinnedMesh === true ? "skin" : "-",
    mesh.isInstancedMesh === true ? "inst" : "-",
    mesh.instanceColor !== null && mesh.instanceColor !== undefined ? "icol" : "-",
    mesh.isBatchedMesh === true ? "batch" : "-",
    // Shadow sampling is generated per object.
    mesh.receiveShadow === true ? "recv" : "-",
    // Vertex inputs are declared from the attributes the geometry has, and
    // `vertexColors` only reaches the shader when `color` is one of them.
    geometry === undefined ? "" : Object.keys(geometry.attributes).sort().join("/"),
    geometry === undefined ? "" : Object.keys(geometry.morphAttributes).sort().join("/"),
  ].join("|");
}

/** The sweep the loading screen waits on, and the sweep the lobby finishes. */
export interface ShopCompilePlan {
  /**
   * One drawable per compile group. Building these builds every program the
   * shop can ask for, so no later frame has to link one.
   */
  readonly lead: readonly THREE.Object3D[];
  /**
   * Every other drawable, in the order a frame would submit it. Each one still
   * needs its own node-builder state, because three caches those against a key
   * that includes an InstancedMesh's uuid, but that state generates text the
   * pipeline cache already holds, so none of this links.
   */
  readonly remainder: readonly THREE.Object3D[];
}

/**
 * Splits the shop's drawables into the set the loading screen must wait for and
 * the set the lobby can finish behind the player's back.
 *
 * This is the whole of the load's shape. The sweep it replaces compiled all 281
 * drawables before the round would open, of which 268 built nothing at all: the
 * shop generates thirteen distinct programs, and everything after the first
 * drawable of a group is a cache hit at the pipeline and a graph build at the
 * node layer. Waiting on the thirteen and letting the rest arrive during the
 * lobby is the same work in an order the player is not sitting through.
 */
export function planShopCompile(scene: THREE.Scene, camera: THREE.Camera): ShopCompilePlan {
  scene.updateMatrixWorld();
  const ordered = visibleFirst(collectDrawables(scene, camera), camera);
  const seen = new Set<string>();
  const lead: THREE.Object3D[] = [];
  const remainder: THREE.Object3D[] = [];
  for (const object of ordered) {
    const key = compileGroupKey(object);
    if (seen.has(key)) {
      remainder.push(object);
      continue;
    }
    seen.add(key);
    lead.push(object);
  }
  return { lead, remainder };
}

/**
 * What the lobby still owes after a lead sweep that may have been cut short.
 *
 * Leaders the deadline did not reach go to the FRONT, ahead of every follower.
 * They are the only drawables left with a program still to link, and a link is
 * worth more than a second on this driver where a follower is worth a few
 * milliseconds, so if the lobby only gets through part of the queue, it should
 * be the part that would otherwise stall a frame.
 */
export function queueAfterLead(plan: ShopCompilePlan, compiled: number): THREE.Object3D[] {
  return [...plan.lead.slice(compiled), ...plan.remainder];
}

/**
 * The part of the sweep the loading screen hands to the lobby, drained one
 * drawable per frame.
 *
 * It is a queue rather than a second sweep because the two have opposite
 * shapes: the lead sweep owns the frame and runs to a deadline, and this one
 * borrows a slice of a frame that belongs to the game and must give it straight
 * back. Everything in it is a node-builder state and no link at all, so a
 * drawable left in it when the hunt starts costs a graph build on the frame that
 * first draws it and nothing worse.
 */
export class ShaderQueue {
  private pending: THREE.Object3D[];

  constructor(drawables: readonly THREE.Object3D[] = []) {
    this.pending = [...drawables];
  }

  get size(): number {
    return this.pending.length;
  }

  clear(): void {
    this.pending = [];
  }

  /**
   * Compiles the next drawable through the scene pass. False when empty.
   *
   * The render target is put back before the promise is awaited rather than
   * after it, which is the difference between this and the lead sweep. Nothing
   * renders during the lead sweep, so holding the scene pass's target across it
   * costs nothing; here a frame is drawn between every call, and a frame drawn
   * while the renderer still points at the scene pass's own texture composites
   * into that texture instead of onto the canvas. Handing it back this early is
   * safe because `Renderer.compileAsync` reads the target synchronously and
   * stores the resulting render context on each work item, and its async tail
   * builds the pipeline against the stored one.
   *
   * Culling is switched off for the one drawable being compiled and put back
   * immediately, for the same reason the lead sweep does it: a flag left off is
   * a prop drawn from every corner of the shop for the rest of the round.
   */
  async next(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    post: RenderPipeline,
    compile: (object: THREE.Object3D, passCamera: THREE.PerspectiveCamera) => Promise<void>,
  ): Promise<boolean> {
    const object = this.pending.shift();
    if (object === undefined) {
      return false;
    }
    const culled = object.frustumCulled;
    object.frustumCulled = false;
    let compiled: Promise<void>;
    try {
      compiled = post.inScenePassContext(scene, camera, (passCamera) => compile(object, passCamera));
    } finally {
      object.frustumCulled = culled;
    }
    await compiled;
    return true;
  }
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
  const ordered =
    options.drawables ?? visibleFirst(collectDrawables(options.scene, options.camera), options.camera);
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
  /** Drawables the lead sweep left for the lobby, oldest first. */
  private queue = new ShaderQueue();

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
   * Builds every shader the shop can ask for before the first frame that draws
   * it, and leaves the rest of the drawables to `compileNextPending`.
   *
   * Three things make this different from calling `renderer.compileAsync` on the
   * whole scene, and each was load-bearing enough to be worth the machinery.
   *
   * It compiles through `post.compileInScenePass`, so the programs it builds are
   * the ones the post chain binds. Without that the sweep builds a shop's worth
   * of programs against the renderer's default target and no MRT, the first
   * frame finds none of them under its own multiple-render-target layout, and
   * links every one again on the main thread with nothing to wait on.
   *
   * It sweeps ONE DRAWABLE PER COMPILE GROUP rather than every drawable. The
   * shop is 281 drawables and 13 distinct programs; the 53 leaders are what the
   * loading screen waits for, and the 228 followers cannot link anything the
   * leaders did not already link, so the player waits for a fifth of the sweep.
   * The followers still each need a node-builder state, which is why they are
   * queued rather than dropped, but that is a graph build and not a link.
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
   * whatever is left joins the pending queue, which is why `visibleFirst`
   * orders the leaders by what the camera can see.
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
    return post.compileInScenePass(this.scene, camera, async (passCamera) => {
      const plan = planShopCompile(this.scene, passCamera);
      const result = await compileSceneInBatches({
        scene: this.scene,
        camera: passCamera,
        drawables: plan.lead,
        compile: (object) => renderer.compileAsync(object, passCamera, this.scene),
        onBatch,
      });
      this.queue = new ShaderQueue(queueAfterLead(plan, result.compiled));
      return result;
    });
  }

  /** Drawables still waiting on a node-builder state. Zero once the shop is warm. */
  get pendingCompiles(): number {
    return this.queue.size;
  }

  /** Gives up on the queue. Its cost is a hitch per drawable, never a failure. */
  dropPendingCompiles(): void {
    this.queue.clear();
  }

  /**
   * Compiles the next queued drawable. False when the queue is empty.
   *
   * Called once per frame while the round is not being hunted, so the lobby and
   * the intro phases absorb what the loading screen no longer waits for.
   */
  async compileNextPending(
    renderer: THREE.WebGPURenderer,
    post: RenderPipeline,
    camera: THREE.PerspectiveCamera,
  ): Promise<boolean> {
    return this.queue.next(this.scene, camera, post, (object, passCamera) =>
      renderer.compileAsync(object, passCamera, this.scene),
    );
  }

  applyQuality(settings: QualitySettings): void {
    this.map.applyQuality(settings);
  }

  dispose(): void {
    this.queue.clear();
    this.map.dispose();
    this.scene.clear();
    this.bag.dispose();
  }
}
