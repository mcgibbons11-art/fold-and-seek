import * as THREE from "three/webgpu";
import type { QualitySettings } from "./quality";
import { RenderPipeline, type PipelineEffect } from "./RenderPipeline";

export type RenderBackend = "webgpu" | "webgl2";

export type RendererInitFailure = "no-backend" | "device-lost" | "unknown";

/**
 * A device loss or an uncaptured backend error, normalized into something the
 * UI can show. A loss is terminal for the renderer; an error usually is not.
 */
export interface DeviceEvent {
  readonly kind: "device-lost" | "device-error";
  readonly api: string;
  readonly message: string;
}

type DeviceEventListener = (event: DeviceEvent) => void;

/**
 * A shader program the driver refused to link. On the WebGL 2 path this is the
 * first event in the chain that kills the context: three logs the failure, binds
 * the unlinked program anyway, and the driver takes the device down a few calls
 * later (see `PRACTICAL_CEILING` in `quality.ts` for the measured chain).
 */
export interface ShaderLinkFailure {
  readonly api: string;
  /** The driver's own account of the failure, which is routinely empty. */
  readonly message: string;
}

type ShaderLinkFailureListener = (failure: ShaderLinkFailure) => void;

/** What a link failure should cost, decided by `ShaderFailurePolicy`. */
export type ShaderFailureResponse = "ignore" | "demote" | "fault";

/**
 * A failure storm arrives as one burst, every material the frame touched failing
 * to link at once, so the burst rather than the individual failure is the unit
 * of decision. Anything inside this window after a decision is the tail of the
 * same storm and buys nothing by demoting the tier again.
 */
const LINK_FAILURE_BURST_MS = 1_500;

/**
 * Bursts tolerated once the tier can go no lower. One is survivable: a single
 * material may be the only thing over the limit, and the demote that preceded it
 * may already have fixed the rest. A second says the floor is not low enough,
 * and the honest answer is the device-fault panel rather than a tab that renders
 * nothing and then dies.
 */
const FLOOR_BURSTS_ALLOWED = 2;

/**
 * Turns link failures into a response. Kept free of the renderer and of the
 * tier table so the policy can be driven directly in a test: the caller reports
 * whether a lower tier still exists and does as it is told.
 */
export class ShaderFailurePolicy {
  private readonly burstMs: number;
  private readonly floorBurstsAllowed: number;
  private quietUntilMs = Number.NEGATIVE_INFINITY;
  private floorBursts = 0;

  constructor(burstMs = LINK_FAILURE_BURST_MS, floorBurstsAllowed = FLOOR_BURSTS_ALLOWED) {
    this.burstMs = burstMs;
    this.floorBurstsAllowed = floorBurstsAllowed;
  }

  record(nowMs: number, canDemote: boolean): ShaderFailureResponse {
    if (nowMs < this.quietUntilMs) {
      return "ignore";
    }
    this.quietUntilMs = nowMs + this.burstMs;
    if (canDemote) {
      // A demote that lands is a fresh start: the floor count exists to describe
      // failures the tier ladder has already been spent on.
      this.floorBursts = 0;
      return "demote";
    }
    this.floorBursts += 1;
    return this.floorBursts >= this.floorBurstsAllowed ? "fault" : "ignore";
  }
}

export type GraphicsRecoveryResponse = "rebuild" | "fallback";

/**
 * Budgets complete renderer rebuilds after a device loss. A new renderer owns
 * a new backend, pipeline, programs, and scene resources; trying to revive the
 * old manager would leave three's internal lost-device flag set forever.
 *
 * The count is consecutive rather than lifetime. Once a rebuilt renderer has
 * drawn stably for a while the budget is restored, so a later unrelated driver
 * reset is still recoverable.
 */
export class GraphicsRecoveryPolicy {
  private attempts = 0;

  constructor(private readonly maxAttempts = 2) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError("graphics recovery needs at least one rebuild attempt");
    }
  }

  requestRebuild(): GraphicsRecoveryResponse {
    if (this.attempts >= this.maxAttempts) return "fallback";
    this.attempts += 1;
    return "rebuild";
  }

  markStable(): void {
    this.attempts = 0;
  }

  get attemptsUsed(): number {
    return this.attempts;
  }

  get exhausted(): boolean {
    return this.attempts >= this.maxAttempts;
  }
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `onDeviceLost` is documented as taking a structured info object, but
 * `onError` is typed as taking a string while the WebGPU backend hands it
 * `{ api, type, message, originalEvent }`. Both shapes, and anything else a
 * future backend invents, have to reduce to a readable line.
 */
function describeDeviceInfo(info: unknown, fallbackApi: string): { api: string; message: string } {
  if (typeof info === "string") {
    return { api: fallbackApi, message: info };
  }
  if (info === null || typeof info !== "object") {
    return { api: fallbackApi, message: String(info) };
  }

  const source = info as Record<string, unknown>;
  const parts = [readString(source, "type"), readString(source, "message"), readString(source, "reason")];
  const message = parts.filter((part): part is string => part !== null).join(" — ");
  return {
    api: readString(source, "api") ?? fallbackApi,
    message: message.length > 0 ? message : "Unknown graphics device failure",
  };
}

export class RendererInitError extends Error {
  readonly failure: RendererInitFailure;

  constructor(failure: RendererInitFailure, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RendererInitError";
    this.failure = failure;
  }
}

const MIN_PIXEL_RATIO = 0.5;
const TONE_MAPPING_EXPOSURE = 1.15;

function detectBackend(backend: THREE.Backend): RenderBackend {
  return (backend as Partial<THREE.WebGPUBackend>).isWebGPUBackend === true ? "webgpu" : "webgl2";
}

/**
 * Owns the Three.js renderer and everything that depends on the drawing
 * surface. WebGPURenderer installs its own WebGL 2 backend fallback, so the
 * backend is only known after init() resolves.
 */
export class RendererManager {
  readonly renderer: THREE.WebGPURenderer;

  private readonly pipeline: RenderPipeline;
  private readonly deviceListeners = new Set<DeviceEventListener>();
  private readonly shaderListeners = new Set<ShaderLinkFailureListener>();
  private settings: QualitySettings;
  private backendName: RenderBackend = "webgl2";
  private initialized = false;
  private deviceLost = false;
  private scale = 1;
  private cssWidth = 1;
  private cssHeight = 1;
  private devicePixelRatio = 1;
  private readonly drawingBuffer = new THREE.Vector2(1, 1);

  /** `forceWebGL` exists so the WebGL 2 path stays testable on WebGPU hardware. */
  constructor(canvas: HTMLCanvasElement, settings: QualitySettings, forceWebGL = false) {
    this.settings = settings;

    // MSAA stands in for the temporal/SMAA passes that arrive with the post
    // pipeline. It is fixed at construction: the WebGPU swap chain sample count
    // cannot be changed on a live renderer, so a tier switch does not touch it.
    this.renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      forceWebGL,
    });

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
    // Left enabled for the life of the renderer. Toggling it at runtime leaves
    // three's shadow nodes holding a released shadow map and the next frame
    // throws; tiers switch dynamic shadows off through light.castShadow instead.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(1);

    this.pipeline = new RenderPipeline(this.renderer, settings);
    this.chainDeviceHandlers();
    this.installShaderErrorHook();
  }

  /**
   * three's own handlers are what set the internal device-lost flag that stops
   * every later submission, so they have to keep running. Replacing them, which
   * is the obvious way to get a notification, leaves the renderer cheerfully
   * submitting work to a dead device for the rest of the session.
   */
  private chainDeviceHandlers(): void {
    const threeOnDeviceLost = this.renderer.onDeviceLost;
    const threeOnError = this.renderer.onError as (info: unknown) => void;

    this.renderer.onDeviceLost = (info) => {
      threeOnDeviceLost.call(this.renderer, info);
      this.deviceLost = true;
      this.emitDeviceEvent({ kind: "device-lost", ...describeDeviceInfo(info, "GPU") });
    };

    this.renderer.onError = ((info: unknown) => {
      threeOnError.call(this.renderer, info);
      this.emitDeviceEvent({ kind: "device-error", ...describeDeviceInfo(info, "GPU") });
    }) as THREE.WebGPURenderer["onError"];
  }

  /**
   * `debug.onShaderError` fires on the WebGL 2 backend for every program the
   * driver refuses to link, which is the last point at which anything can be
   * done about it: three carries on and binds the unlinked program. Taking the
   * hook replaces three's own console report, so the driver's logs are written
   * out here instead — losing them would make the next one of these harder to
   * diagnose, not easier. The WebGPU backend never calls it.
   */
  private installShaderErrorHook(): void {
    this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      const logs = [
        gl.getProgramInfoLog(program),
        gl.getShaderInfoLog(vertexShader),
        gl.getShaderInfoLog(fragmentShader),
      ]
        .map((log) => (log ?? "").trim())
        .filter((log) => log.length > 0);
      // An empty log is the interesting case and the common one on the drivers
      // this fires on, so it is named rather than left as a blank line.
      const message =
        logs.length > 0 ? logs.join(" — ") : "the driver linked no program and reported no reason";
      // Program size is logged with it because the standing hypothesis for the
      // empty-log failures is that the unrolled light loop runs the fragment
      // program past a driver limit, and this is the number that would show it.
      const fragmentChars = (gl.getShaderSource(fragmentShader) ?? "").length;
      console.error(
        `[renderer] shader program failed to link (fragment source ${String(fragmentChars)} chars):`,
        message,
      );
      this.emitShaderLinkFailure({ api: this.backendName, message });
    };
  }

  private emitShaderLinkFailure(failure: ShaderLinkFailure): void {
    for (const listener of this.shaderListeners) {
      listener(failure);
    }
  }

  private emitDeviceEvent(event: DeviceEvent): void {
    for (const listener of this.deviceListeners) {
      listener(event);
    }
  }

  /** Subscribes to device loss and uncaptured backend errors. Returns an unsubscribe. */
  onDeviceEvent(listener: DeviceEventListener): () => void {
    this.deviceListeners.add(listener);
    return () => {
      this.deviceListeners.delete(listener);
    };
  }

  /** Subscribes to program link failures. Returns an unsubscribe. */
  onShaderLinkFailure(listener: ShaderLinkFailureListener): () => void {
    this.shaderListeners.add(listener);
    return () => {
      this.shaderListeners.delete(listener);
    };
  }

  get isDeviceLost(): boolean {
    return this.deviceLost;
  }

  async initialize(): Promise<void> {
    try {
      await this.renderer.init();
    } catch (error) {
      throw new RendererInitError(
        "no-backend",
        "Neither the WebGPU nor the WebGL 2 backend could start on this device.",
        error,
      );
    }

    this.backendName = detectBackend(this.renderer.backend);
    this.initialized = true;
    this.applySize();
  }

  get backend(): RenderBackend {
    return this.backendName;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get maxAnisotropy(): number {
    return this.initialized ? this.renderer.getMaxAnisotropy() : 1;
  }

  get quality(): QualitySettings {
    return this.settings;
  }

  /** Current drawing-buffer size in physical pixels; the returned vector is reused. */
  get resolution(): THREE.Vector2 {
    return this.renderer.getDrawingBufferSize(this.drawingBuffer);
  }

  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  get renderScale(): number {
    return this.scale;
  }

  /** The post chain, exposed so effects stay individually toggleable at runtime. */
  get post(): RenderPipeline {
    return this.pipeline;
  }

  applyQuality(settings: QualitySettings): void {
    this.settings = settings;
    // A tier change resets the resolution ladder to the top of the new range;
    // carrying a reduced scale across tiers would make an upgrade look like a
    // downgrade until the adaptive controller happened to climb back.
    this.scale = settings.maxRenderScale;
    this.pipeline.applyQuality(settings);
    this.applySize();
  }

  setRenderScale(scale: number): void {
    this.scale = Math.min(Math.max(scale, this.settings.minRenderScale), this.settings.maxRenderScale);
    this.applySize();
  }

  setEffectEnabled(effect: PipelineEffect, enabled: boolean): void {
    this.pipeline.setEffectEnabled(effect, enabled);
  }

  setSize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.cssWidth = Math.max(cssWidth, 1);
    this.cssHeight = Math.max(cssHeight, 1);
    this.devicePixelRatio = devicePixelRatio > 0 ? devicePixelRatio : 1;
    this.applySize();
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.pipeline.render(scene, camera);
  }

  setAnimationLoop(callback: ((timeMs: number) => void) | null): void {
    void this.renderer.setAnimationLoop(callback);
  }

  dispose(): void {
    void this.renderer.setAnimationLoop(null);
    this.pipeline.dispose();
    this.deviceListeners.clear();
    this.shaderListeners.clear();
    this.renderer.debug.onShaderError = null;
    this.renderer.dispose();
    this.initialized = false;
  }

  private applySize(): void {
    if (!this.initialized) {
      return;
    }
    const capped = Math.min(this.devicePixelRatio, this.settings.pixelRatioCap);
    const ratio = Math.min(Math.max(capped * this.scale, MIN_PIXEL_RATIO), this.settings.pixelRatioCap);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    // A ratio under `capped` is a backing store smaller than the pixels the
    // display has, and the browser stretches it to the canvas with a bilinear
    // filter. The post chain's sharpen answers for that filter, so what it is
    // told is the share actually achieved rather than the share asked for: the
    // floor and the tier ceiling above both move it.
    this.pipeline.setRenderScale(ratio / capped);
  }
}
