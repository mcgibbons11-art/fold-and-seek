import { AdaptiveQuality } from "../rendering/AdaptiveQuality";
import { ForgeController } from "../forge/ForgeController";
import { DiagnosticsOverlay, type DiagnosticsSnapshot } from "../rendering/DiagnosticsOverlay";
import { FrameTimeProbe, pickDefaultTier, QUALITY_TIER_ORDER, qualitySettingsFor, type QualitySettings, type QualityTier } from "../rendering/quality";
import { RendererManager, type DeviceEvent, type RenderBackend } from "../rendering/RendererManager";
import { TestRoom } from "../world/TestRoom";
import { DisposalBag } from "./DisposalBag";

export const FIXED_STEP = 1 / 60;

/**
 * The step cap and the delta clamp describe the same limit from two directions,
 * so they are derived from one number: at most six fixed steps are simulated per
 * frame, and any frame longer than those six steps is clamped rather than
 * accumulated. Letting them disagree, as an 0.1 s clamp against a five step cap
 * did, means every long frame lands in the backlog-drop branch and silently
 * discards a sixtieth of simulated time.
 */
export const MAX_STEPS_PER_FRAME = 6;
export const MAX_FRAME_DELTA = FIXED_STEP * MAX_STEPS_PER_FRAME;
const BOOT_TIER: QualityTier = "high";

export interface GameHostCallbacks {
  onTierChange?: (tier: QualityTier, automatic: boolean) => void;
  onRendererMessage?: (message: string) => void;
  onDeviceEvent?: (event: DeviceEvent) => void;
}

export interface GameHostOptions {
  /** Skips the WebGPU backend so the WebGL 2 path can be exercised on demand. */
  forceWebGL?: boolean;
}

/**
 * The stable imperative owner of everything below React: renderer, world,
 * loop, and diagnostics. Created once per canvas and disposed on teardown.
 */
export class GameHost {
  readonly renderer: RendererManager;

  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: GameHostCallbacks;
  private readonly bag = new DisposalBag();
  private readonly probe = new FrameTimeProbe();

  private world: TestRoom | null = null;
  private forge: ForgeController | null = null;
  private overlay: DiagnosticsOverlay | null = null;
  private settings: QualitySettings = qualitySettingsFor(BOOT_TIER);
  private readonly adaptive: AdaptiveQuality;
  private tierLockedByUser = false;
  private probeApplied = false;
  private running = false;
  private hidden = false;
  private disposed = false;
  private lastTimeMs = 0;
  private accumulator = 0;

  constructor(canvas: HTMLCanvasElement, callbacks: GameHostCallbacks = {}, options: GameHostOptions = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.renderer = new RendererManager(canvas, this.settings, options.forceWebGL === true);
    this.bag.add(this.renderer);
    this.adaptive = new AdaptiveQuality(this.settings, {
      onRenderScale: (scale) => {
        this.renderer.setRenderScale(scale);
      },
      onTierSuggestion: (direction) => {
        this.applyTierSuggestion(direction);
      },
    });
  }

  async initialize(): Promise<void> {
    await this.renderer.initialize();
    // dispose() can land while the backend is still negotiating an adapter.
    // Everything below allocates against a renderer the caller has already
    // given up on, and the disposal bag refuses new registrations once emptied,
    // so the half-built world would be both unreachable and unreleased.
    if (this.disposed) {
      return;
    }

    this.bag.addFn(
      this.renderer.onDeviceEvent((event) => {
        this.callbacks.onDeviceEvent?.(event);
        this.callbacks.onRendererMessage?.(`${event.api}: ${event.message}`);
      }),
    );

    // Settled before the world exists because the room commits its shadow map
    // resolution at construction; only the frame-time part of the heuristic is
    // still outstanding at this point.
    this.applyTier(pickDefaultTier(this.renderer.backend, null), true);

    const world = new TestRoom(this.renderer.renderer, this.settings);
    world.attachInput(this.canvas);
    this.world = this.bag.add(world);

    this.overlay = this.bag.add(new DiagnosticsOverlay(this.canvas.parentElement ?? document.body));

    this.installResizeHandling();
    this.installVisibilityHandling();
    this.syncSize();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastTimeMs = 0;
    this.accumulator = 0;
    this.renderer.setAnimationLoop(this.frame);
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    this.renderer.setSize(width, height, devicePixelRatio);
    this.world?.setViewport(width, height);
    this.forge?.setViewport(width, height);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.exitForgeMode();
    this.world = null;
    this.overlay = null;
    this.bag.dispose();
  }

  /**
   * Hands the room and the pointer to the Mimic Forge. The room stays in the
   * scene as the Forge's workspace; only the camera and the input owner change.
   */
  enterForgeMode(): void {
    const world = this.world;
    if (this.forge !== null || world === null) {
      return;
    }
    this.forge = new ForgeController({
      scene: world.scene,
      canvas: this.canvas,
      quality: this.settings,
    });
    this.syncSize();
  }

  exitForgeMode(): void {
    this.forge?.dispose();
    this.forge = null;
  }

  get forgeController(): ForgeController | null {
    return this.forge;
  }

  get backend(): RenderBackend {
    return this.renderer.backend;
  }

  get tier(): QualityTier {
    return this.settings.tier;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Manual selection wins over the boot probe and over automatic tier changes
   * for the rest of the session. Resolution still adapts inside the chosen
   * tier, which is the cheaper lever and the one Bible §22.6 asks for first.
   */
  setQualityTier(tier: QualityTier): void {
    this.tierLockedByUser = true;
    this.applyTier(tier, false);
  }

  /** Full manual control: stops the adaptive controller touching resolution too. */
  setQualityLocked(locked: boolean): void {
    this.adaptive.setLocked(locked);
  }

  get renderScale(): number {
    return this.renderer.renderScale;
  }

  private applyTier(tier: QualityTier, automatic: boolean): void {
    if (this.settings.tier === tier) {
      return;
    }
    this.settings = qualitySettingsFor(tier);
    this.renderer.applyQuality(this.settings);
    this.world?.applyQuality(this.settings);
    this.forge?.applyQuality(this.settings);
    this.adaptive.applyQuality(this.settings, performance.now());
    this.callbacks.onTierChange?.(tier, automatic);
  }

  private applyTierSuggestion(direction: "raise" | "lower"): void {
    if (this.tierLockedByUser) {
      return;
    }
    const index = QUALITY_TIER_ORDER.indexOf(this.settings.tier);
    const next = QUALITY_TIER_ORDER[index + (direction === "raise" ? 1 : -1)];
    if (next !== undefined) {
      this.applyTier(next, true);
    }
  }

  private readonly frame = (timeMs: number): void => {
    const world = this.world;
    if (world === null) {
      return;
    }

    if (this.lastTimeMs === 0) {
      this.lastTimeMs = timeMs;
    }
    const rawDelta = (timeMs - this.lastTimeMs) / 1000;
    this.lastTimeMs = timeMs;
    const delta = Math.min(Math.max(rawDelta, 0), MAX_FRAME_DELTA);

    const forge = this.forge;
    if (!this.hidden) {
      if (forge === null) {
        this.accumulator += delta;
        let steps = 0;
        while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
          world.simulate(FIXED_STEP);
          this.accumulator -= FIXED_STEP;
          steps += 1;
        }
        // A backlog past the step cap means the frame was long enough that
        // catching up would only make the next frame longer. Drop it instead.
        if (steps === MAX_STEPS_PER_FRAME && this.accumulator >= FIXED_STEP) {
          this.accumulator = 0;
        }
        world.interpolate(this.accumulator / FIXED_STEP);
      } else {
        // The Forge is driven by input, not by a fixed step: the room's own
        // camera sweep would only fight the player's orbit.
        forge.update();
      }
    }

    this.renderer.render(world.scene, forge === null ? world.camera : forge.camera);
    this.overlay?.update(timeMs, rawDelta * 1000, this.snapshot);

    if (!this.probeApplied) {
      this.probe.record(timeMs);
      if (this.probe.complete) {
        this.probeApplied = true;
        if (!this.tierLockedByUser) {
          this.applyTier(pickDefaultTier(this.renderer.backend, this.probe.medianFrameMs), true);
        }
        // Whatever the probe decided, it measured a boot: shader compilation,
        // texture upload, and any competing load that happened to be running.
        // Handing the tier to the adaptive controller from here means a session
        // demoted by transient contention climbs back out on its own instead of
        // staying pinned for the rest of the session.
        this.adaptive.applyQuality(this.settings, timeMs);
      }
      return;
    }

    if (!this.hidden) {
      this.adaptive.update(timeMs, rawDelta * 1000);
    }
  };

  private readonly snapshot = (): DiagnosticsSnapshot => {
    const info = this.renderer.renderer.info;
    const resolution = this.renderer.resolution;
    return {
      backend: this.renderer.backend,
      tier: this.settings.tier,
      drawCalls: info.render.drawCalls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      renderTargets: info.memory.renderTargets,
      programs: info.memory.programs,
      pixelRatio: this.renderer.pixelRatio,
      renderScale: this.renderer.renderScale,
      widthPx: Math.round(resolution.x),
      heightPx: Math.round(resolution.y),
      meshCount: this.world?.stats.meshCount ?? 0,
      effects: this.renderer.post.activeEffects,
    };
  };

  private syncSize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : window.innerWidth;
    const height = rect.height > 0 ? rect.height : window.innerHeight;
    this.resize(width, height, window.devicePixelRatio);
  }

  private installResizeHandling(): void {
    const observer = new ResizeObserver(() => {
      this.syncSize();
    });
    observer.observe(this.canvas);
    this.bag.addFn(() => {
      observer.disconnect();
    });

    // ResizeObserver does not fire when only the device pixel ratio changes,
    // which happens on browser zoom and on a move between monitors.
    const onWindowResize = (): void => {
      this.syncSize();
    };
    window.addEventListener("resize", onWindowResize);
    this.bag.addFn(() => {
      window.removeEventListener("resize", onWindowResize);
    });
  }

  private installVisibilityHandling(): void {
    const onVisibilityChange = (): void => {
      this.hidden = document.hidden;
      if (!this.hidden) {
        this.lastTimeMs = 0;
        this.accumulator = 0;
        // Bible §22.4: a resumed tab's first frames say nothing about workload.
        this.adaptive.reset();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    this.bag.addFn(() => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    });
  }
}
