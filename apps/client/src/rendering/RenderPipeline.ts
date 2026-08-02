import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import * as THREE from "three/webgpu";
import {
  clamp,
  emissive,
  mrt,
  normalView,
  output,
  pass,
  screenSize,
  screenUV,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { QualitySettings } from "./quality";

/** Effects the pipeline can compose today. Bible §22.3 adds the rest in order. */
export type PipelineEffect = "gtao" | "bloom";

export const PIPELINE_EFFECTS: readonly PipelineEffect[] = ["gtao", "bloom"];

// Bloom reads the emissive render target rather than the beauty buffer, so the
// threshold only has to reject dim glow (the lamp shade) and keep the bright
// practicals (bulb, candle flame). Bible §18.5: bloom only from intentional
// emissives.
const BLOOM_STRENGTH = 1.1;
const BLOOM_RADIUS = 0.85;
const BLOOM_THRESHOLD = 0.25;

// Half-resolution AO is the standard cost/quality trade and is what the node's
// own documentation recommends for anything but a still frame.
const GTAO_RESOLUTION_SCALE = 0.5;
const GTAO_RADIUS_M = 0.4;
const GTAO_SAMPLES = 16;

/**
 * Unsharp coefficient per unit of missing resolution.
 *
 * The adaptive controller answers a slow frame by drawing into a smaller
 * backing store — `RendererManager.applySize` implements the render scale as
 * `setPixelRatio(capped * scale)` — and the *browser* then stretches that store
 * to the canvas' CSS size with a bilinear filter. That filter is the softness
 * the round-6 critic photographed at 0.55–0.70 on integrated GPUs. It is not a
 * tonemap problem and no contrast curve reaches it, because the detail is gone
 * before the pixels are shown.
 *
 * So the sharpen is scaled by how much resolution the frame is actually
 * missing: a full-scale frame gets a coefficient of exactly zero and is
 * untouched, and the 0.5 floor every tier shares gets half of this.
 */
const SHARPEN_PER_MISSING_SCALE = 1;

/**
 * How far a sharpen may move a pixel, as a share of the pixel's own value.
 *
 * The limit has to be relative rather than absolute because the chain is still
 * in linear HDR here: a 20.0 bulb beside a 0.05 shadow has a raw undershoot far
 * larger than the shadow pixel itself, so an unlimited unsharp would print a
 * black ring around every practical in the shop. Half is enough headroom for
 * grain, weave and edge wear — which sit within a stop of their neighbours —
 * and nowhere near enough to ring a light fixture.
 */
const SHARPEN_HALO_LIMIT = 0.5;

type PassNodeHandle = ReturnType<typeof pass>;
type BloomNodeHandle = ReturnType<typeof bloom>;
type GtaoNodeHandle = ReturnType<typeof ao>;

/**
 * Post-processing graph built on three's TSL `RenderPipeline`, which compiles
 * to both WGSL and GLSL so the WebGPU and WebGL 2 backends run the same chain.
 *
 * The graph is rebuilt, not reconfigured, whenever the enabled effect set
 * changes: the multiple-render-target layout of the scene pass depends on which
 * effects consume it, and a node graph is cheap to rebuild but cannot be
 * rewired in place. When nothing is enabled the pipeline holds no resources at
 * all and `render` falls through to `renderer.render`, so the low and light
 * tiers pay nothing for the machinery.
 */
export class RenderPipeline {
  private readonly renderer: THREE.WebGPURenderer;
  private readonly overrides = new Map<PipelineEffect, boolean>();

  /**
   * The only camera the graph is ever built against.
   *
   * Both `pass()` and `ao()` bind to the camera OBJECT handed to them — the pass
   * renders through `this.camera`, and the AO node holds
   * `uniform(camera.projectionMatrix)` and `reference('near', 'float', camera)`.
   * Keying the graph on camera identity therefore rebuilt it at every phase
   * transition, because the Forge, the survey and the Inspector each own a
   * camera. A rebuilt pass allocates a new render target, a render context in
   * three r185 is keyed on the render target and the MRT, and a render object is
   * cached against its context: the whole shop's programs were orphaned and
   * relinked on the next frame, ~103 of them per round.
   *
   * The gameplay cameras are untouched and go on being owned by whoever owns
   * them. This one is copied from whichever of them is drawing, so the graph's
   * view of "the camera" never changes identity and the compiled programs
   * survive every phase.
   */
  private readonly passCamera = new THREE.PerspectiveCamera();

  /**
   * Sharpen strength for the frame, held as a uniform rather than baked into
   * the graph.
   *
   * The render scale moves whenever the adaptive controller answers a slow
   * frame, which on a weak GPU is exactly when the shop can least afford a
   * rebuild: a rebuilt pass allocates a new render target, and a render context
   * in three r185 is keyed on the render target, so every compiled program in
   * the shop would be orphaned and relinked. That is the defect this class was
   * rewritten to remove. A uniform costs one upload and no rebuild at all, so
   * the sharpen is in every graph that gets built and simply does nothing at a
   * coefficient of zero.
   */
  private readonly sharpenStrength = uniform(0);

  private settings: QualitySettings;
  private pipeline: THREE.RenderPipeline | null = null;
  private scenePass: PassNodeHandle | null = null;
  private aoNode: GtaoNodeHandle | null = null;
  private bloomNode: BloomNodeHandle | null = null;
  private boundScene: THREE.Scene | null = null;
  /** Effect set the current graph was built for; null while nothing is built. */
  private builtKey: string | null = null;
  private builds = 0;

  constructor(renderer: THREE.WebGPURenderer, settings: QualitySettings) {
    this.renderer = renderer;
    this.settings = settings;
    // The pass camera is driven by a world matrix copied whole, never by its own
    // position and quaternion, so nothing may recompose it from them.
    this.passCamera.matrixAutoUpdate = false;
  }

  /** False while the direct `renderer.render` path is in use. */
  get isActive(): boolean {
    return this.pipeline !== null;
  }

  /** What the built graph actually runs, which is not always what is enabled yet. */
  get activeEffects(): readonly PipelineEffect[] {
    const key = this.builtKey;
    return key === null ? [] : PIPELINE_EFFECTS.filter((_, index) => key[index] === "1");
  }

  /**
   * How many times the node graph has been built. A change of scene or of effect
   * set moves it; a change of camera must not, which is the whole of the
   * relink defect and is otherwise invisible from outside.
   */
  get graphBuilds(): number {
    return this.builds;
  }

  /** Sharpen coefficient the graph is running at, 0 while nothing is upscaled. */
  get sharpenAmount(): number {
    return this.sharpenStrength.value;
  }

  /**
   * Tells the graph what share of the display's own pixels the frame is drawn
   * at, which is the only thing the sharpen is a function of.
   *
   * It takes the ACHIEVED share rather than the one the adaptive controller
   * asked for. `RendererManager` floors the pixel ratio at `MIN_PIXEL_RATIO`
   * and caps it at the tier's own ceiling, so a request for 0.4 on a device
   * that will not go under half is a frame that is only half soft, and
   * sharpening it for 0.4 would over-correct.
   */
  setRenderScale(scale: number): void {
    const missing = Math.min(Math.max(1 - scale, 0), 1);
    this.sharpenStrength.value = SHARPEN_PER_MISSING_SCALE * missing;
  }

  isEnabled(effect: PipelineEffect): boolean {
    const override = this.overrides.get(effect);
    return override ?? this.settings[effect];
  }

  /** A tier change drops any manual toggles: the new tier defines the baseline. */
  applyQuality(settings: QualitySettings): void {
    this.settings = settings;
    this.overrides.clear();
  }

  setEffectEnabled(effect: PipelineEffect, enabled: boolean): void {
    this.overrides.set(effect, enabled);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.bind(scene, camera);
    if (this.pipeline === null) {
      this.renderer.render(scene, camera);
      return;
    }
    this.pipeline.render();
  }

  /**
   * Points the graph at this scene and camera without drawing anything, so a
   * precompile can run against the pipeline the frames will actually use.
   *
   * The graph is a function of the scene and the effect set and nothing else. A
   * tier change that happens to keep the same effects (a shadow or anisotropy
   * change, say) reuses the compiled shaders and the allocated targets, and so
   * does a change of camera, which the pass camera absorbs instead.
   */
  bind(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.syncPassCamera(camera);
    const rebound = scene !== this.boundScene;
    if (rebound) {
      this.boundScene = scene;
    }
    if (rebound || this.builtKey !== this.effectKey()) {
      this.rebuild();
    }
  }

  /**
   * Copies whichever camera the frame is drawing from onto the pass camera.
   *
   * `PassNode.updateBefore` reads `near`, `far` and `layers` and then calls
   * `renderer.render(scene, camera)`, which culls and draws through
   * `projectionMatrix` and `matrixWorldInverse`. The source's world matrix is
   * brought up to date first under exactly three's own rule, because the copy
   * happens before the point at which the pass would have done it.
   *
   * The view matrix is handed over as `matrix` and turned into a world matrix
   * and its inverse by three rather than by hand. `Camera.updateMatrixWorld`
   * strips scale before inverting, so an inverse computed here would differ from
   * a real camera's in the last place for no reason at all.
   *
   * The projection is recomputed rather than copied. `updateProjectionMatrix`
   * writes in place into the same `projectionMatrix` and `projectionMatrixInverse`
   * that `GTAONode` holds through `uniform()`, and a `Matrix4NodeUniform` reads
   * its node's value and re-uploads on an element-wise difference, so the AO
   * node tracks a changed projection without being rebuilt. Copying the matrix
   * across would instead take the source's depth convention, which is the
   * renderer's to decide and which it decides on this camera.
   */
  private syncPassCamera(source: THREE.PerspectiveCamera): void {
    const pass = this.passCamera;
    if (source === pass) {
      return;
    }

    if (source.parent === null && source.matrixWorldAutoUpdate) {
      source.updateMatrixWorld();
    }
    pass.matrix.copy(source.matrixWorld);
    pass.matrixWorldNeedsUpdate = true;
    pass.updateMatrixWorld();

    // No gameplay camera masks a layer today, and the merged Mimic bodies park
    // their source parts out of sight by moving the PARTS rather than the mask.
    // It travels anyway because the shader sweep now selects drawables through
    // this camera: a mask that stayed behind would compile a different set from
    // the one the frames draw, which is the failure this whole change is about.
    pass.layers.mask = source.layers.mask;

    pass.fov = source.fov;
    pass.aspect = source.aspect;
    pass.near = source.near;
    pass.far = source.far;
    pass.updateProjectionMatrix();
  }

  /**
   * Runs `compile` with the renderer aimed at the scene pass's own target and
   * multiple-render-target layout, then puts both back.
   *
   * This is the difference between a precompile that helps and one that is pure
   * waste. A render object is cached against its render context, and the context
   * is keyed on the render target and the MRT; the post chain draws the scene
   * into `pass.renderTarget` under an MRT of output, emissive and normal, which
   * is a different context and a different fragment shader from the one a bare
   * `renderer.compileAsync(scene, camera)` builds. Compiling without this
   * wrapper builds a whole shop's worth of programs the game then never binds,
   * and the first real frame links every one of them again — synchronously,
   * because the render path has no promise to wait on.
   *
   * Falls straight through when no post chain is active, which is exactly right:
   * there the frames do go through `renderer.render` and its own context.
   */
  async compileInScenePass<T>(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    compile: (passCamera: THREE.PerspectiveCamera) => Promise<T>,
  ): Promise<T> {
    this.bind(scene, camera);
    const scenePass = this.scenePass;
    if (scenePass === null) {
      return compile(this.passCamera);
    }
    const previousTarget = this.renderer.getRenderTarget();
    const previousMrt = this.renderer.getMRT();
    this.renderer.setRenderTarget(scenePass.renderTarget);
    this.renderer.setMRT(scenePass.getMRT());
    try {
      return await compile(this.passCamera);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setMRT(previousMrt);
    }
  }

  /**
   * The same aim, held only for the duration of a SYNCHRONOUS call.
   *
   * `compileInScenePass` keeps the renderer pointed at the scene pass until its
   * callback's promise settles, which is right for the load, where nothing is
   * drawn in between. It is wrong for a compile that runs one drawable per frame
   * during the lobby: `THREE.RenderPipeline.render` composites into whatever
   * target the renderer currently holds, so a frame drawn while the aim is still
   * borrowed lands in the scene pass's own texture instead of on the canvas.
   *
   * Handing the target back before the promise settles is safe because
   * `Renderer.compileAsync` reads the render target and the MRT synchronously,
   * before it ever suspends, and stores the resulting render context on each
   * work item; the async tail that builds the node graph and the pipeline uses
   * the stored context and never looks at the renderer again.
   */
  inScenePassContext<T>(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    run: (passCamera: THREE.PerspectiveCamera) => T,
  ): T {
    this.bind(scene, camera);
    const scenePass = this.scenePass;
    if (scenePass === null) {
      return run(this.passCamera);
    }
    const previousTarget = this.renderer.getRenderTarget();
    const previousMrt = this.renderer.getMRT();
    this.renderer.setRenderTarget(scenePass.renderTarget);
    this.renderer.setMRT(scenePass.getMRT());
    try {
      return run(this.passCamera);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setMRT(previousMrt);
    }
  }

  dispose(): void {
    this.teardown();
    this.boundScene = null;
  }

  private effectKey(): string {
    return PIPELINE_EFFECTS.map((effect) => (this.isEnabled(effect) ? "1" : "0")).join("");
  }

  private rebuild(): void {
    this.teardown();
    this.builds += 1;
    this.builtKey = this.effectKey();

    const scene = this.boundScene;
    const camera = this.passCamera;
    if (scene === null) {
      return;
    }

    const wantGtao = this.isEnabled("gtao");
    const wantBloom = this.isEnabled("bloom");
    if (!wantGtao && !wantBloom) {
      return;
    }

    const scenePass = pass(scene, camera);
    // Only the targets an enabled effect consumes are allocated; each extra
    // attachment costs a full-resolution half-float buffer of bandwidth.
    const targets: Record<string, THREE.Node> = { output };
    if (wantBloom) {
      targets.emissive = emissive;
    }
    if (wantGtao) {
      targets.normal = normalView;
    }
    scenePass.setMRT(mrt(targets));

    let composed: THREE.Node<"vec4"> = this.sharpened(scenePass.getTextureNode("output"));

    if (wantGtao) {
      const aoNode = ao(scenePass.getTextureNode("depth"), scenePass.getTextureNode("normal"), camera);
      aoNode.resolutionScale = GTAO_RESOLUTION_SCALE;
      aoNode.radius.value = GTAO_RADIUS_M;
      aoNode.samples.value = GTAO_SAMPLES;
      this.aoNode = aoNode;
      // Occlusion multiplies the lit beauty buffer before bloom is added, so a
      // glowing emissive is never darkened by the crease it sits in.
      composed = composed.mul(vec4(vec3(aoNode.getTextureNode().r), 1));
    }

    if (wantBloom) {
      const bloomNode = bloom(
        scenePass.getTextureNode("emissive"),
        BLOOM_STRENGTH,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD,
      );
      this.bloomNode = bloomNode;
      composed = composed.add(bloomNode);
    }

    this.scenePass = scenePass;
    // RenderPipeline reads renderer.toneMapping and renderer.outputColorSpace
    // and appends the transform itself, so the chain stays in linear HDR up to
    // this point and the existing ACES exposure still applies.
    this.pipeline = new THREE.RenderPipeline(this.renderer, composed);
  }

  /**
   * A five-tap unsharp over the beauty buffer, limited so it cannot ring.
   *
   * **Why it is applied here rather than to the fully composed frame.** Reading
   * the composed node's neighbours means either re-evaluating the whole
   * expression at four more coordinates — five bloom fetches and five occlusion
   * fetches for nothing — or wrapping it in `rtt()`, which allocates a second
   * full-resolution half-float target and runs an extra fullscreen pass. Both
   * are paid on the weakest GPUs, which are the only ones that ever upscale.
   * Neither buys anything: the occlusion is drawn at half resolution and the
   * bloom is a wide blur, so both terms are low frequency by construction and
   * carry no detail for a sharpen to recover. Every high frequency in the frame
   * is in the buffer this samples, and the browser's upscale is applied to all
   * of it equally, so pre-compensating here compensates the whole frame.
   *
   * **Why not three's own `sharpen()`.** r185 does ship one — AMD's RCAS, in
   * `addons/tsl/display/SharpenNode.js` — and it is a better sharpen than this.
   * It is not usable here for two reasons. It is a `TempNode` with its own
   * render target and its own quad pass, so it costs exactly the target and
   * bandwidth the paragraph above is spent avoiding. And its contrast limiter
   * reads `1.0 - max(neighbours, centre)`, which assumes a signal already in
   * [0, 1]; this chain stays in linear HDR until `THREE.RenderPipeline` appends
   * the tone map, where a lamp is well over 1 and that limiter is outside its
   * domain. The relative clamp below is scale-free and is correct in HDR.
   */
  private sharpened(source: ReturnType<PassNodeHandle["getTextureNode"]>): THREE.Node<"vec4"> {
    const texel = vec2(1, 1).div(screenSize);
    const north = source.sample(screenUV.add(vec2(0, texel.y)));
    const south = source.sample(screenUV.sub(vec2(0, texel.y)));
    const east = source.sample(screenUV.add(vec2(texel.x, 0)));
    const west = source.sample(screenUV.sub(vec2(texel.x, 0)));

    // The centre less the mean of its four neighbours is the local detail the
    // upscale is about to lose; adding a share of it back is the sharpen.
    const detail = source.rgb
      .mul(4)
      .sub(north.rgb.add(south.rgb).add(east.rgb).add(west.rgb))
      .mul(0.25);
    const room = source.rgb.mul(SHARPEN_HALO_LIMIT);
    const change = clamp(detail.mul(this.sharpenStrength), room.negate(), room);
    return vec4(source.rgb.add(change), source.a);
  }

  private teardown(): void {
    this.builtKey = null;
    this.pipeline?.dispose();
    this.pipeline = null;
    this.bloomNode?.dispose();
    this.bloomNode = null;
    this.aoNode?.dispose();
    this.aoNode = null;
    this.scenePass?.dispose();
    this.scenePass = null;
  }
}
