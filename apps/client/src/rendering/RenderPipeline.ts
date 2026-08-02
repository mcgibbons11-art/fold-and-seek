import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import * as THREE from "three/webgpu";
import { emissive, mrt, normalView, output, pass, vec3, vec4 } from "three/tsl";
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

  private settings: QualitySettings;
  private pipeline: THREE.RenderPipeline | null = null;
  private scenePass: PassNodeHandle | null = null;
  private aoNode: GtaoNodeHandle | null = null;
  private bloomNode: BloomNodeHandle | null = null;
  private boundScene: THREE.Scene | null = null;
  private boundCamera: THREE.Camera | null = null;
  /** Effect set the current graph was built for; null while nothing is built. */
  private builtKey: string | null = null;

  constructor(renderer: THREE.WebGPURenderer, settings: QualitySettings) {
    this.renderer = renderer;
    this.settings = settings;
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

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.bind(scene, camera);
    if (this.pipeline === null) {
      this.renderer.render(scene, camera);
      return;
    }
    this.pipeline.render();
  }

  /**
   * Builds the graph for this scene and camera without drawing anything, so a
   * precompile can run against the pipeline the frames will actually use.
   *
   * The graph is a function of the scene, the camera, and the effect set and
   * nothing else, so a tier change that happens to keep the same effects (a
   * shadow or anisotropy change, say) reuses the compiled shaders and the
   * allocated targets instead of paying to rebuild them.
   */
  bind(scene: THREE.Scene, camera: THREE.Camera): void {
    const rebound = scene !== this.boundScene || camera !== this.boundCamera;
    if (rebound) {
      this.boundScene = scene;
      this.boundCamera = camera;
    }
    if (rebound || this.builtKey !== this.effectKey()) {
      this.rebuild();
    }
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
    camera: THREE.Camera,
    compile: () => Promise<T>,
  ): Promise<T> {
    this.bind(scene, camera);
    const scenePass = this.scenePass;
    if (scenePass === null) {
      return compile();
    }
    const previousTarget = this.renderer.getRenderTarget();
    const previousMrt = this.renderer.getMRT();
    this.renderer.setRenderTarget(scenePass.renderTarget);
    this.renderer.setMRT(scenePass.getMRT());
    try {
      return await compile();
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setMRT(previousMrt);
    }
  }

  dispose(): void {
    this.teardown();
    this.boundScene = null;
    this.boundCamera = null;
  }

  private effectKey(): string {
    return PIPELINE_EFFECTS.map((effect) => (this.isEnabled(effect) ? "1" : "0")).join("");
  }

  private rebuild(): void {
    this.teardown();
    this.builtKey = this.effectKey();

    const scene = this.boundScene;
    const camera = this.boundCamera;
    if (scene === null || camera === null) {
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

    let composed: THREE.Node<"vec4"> = scenePass.getTextureNode("output");

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
