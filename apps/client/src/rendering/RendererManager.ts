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

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.pipeline.render(scene, camera);
  }

  setAnimationLoop(callback: ((timeMs: number) => void) | null): void {
    void this.renderer.setAnimationLoop(callback);
  }

  dispose(): void {
    void this.renderer.setAnimationLoop(null);
    this.pipeline.dispose();
    this.deviceListeners.clear();
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
  }
}
