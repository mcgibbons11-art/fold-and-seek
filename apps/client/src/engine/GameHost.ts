import { AdaptiveQuality } from "../rendering/AdaptiveQuality";
import { ForgeController } from "../forge/ForgeController";
import { DiagnosticsOverlay, type DiagnosticsSnapshot } from "../rendering/DiagnosticsOverlay";
import { FrameTimeProbe, pickDefaultTier, QUALITY_TIER_ORDER, qualitySettingsFor, stepQualityTier, type QualitySettings, type QualityTier } from "../rendering/quality";
import {
  RendererManager,
  ShaderFailurePolicy,
  type DeviceEvent,
  type RenderBackend,
  type ShaderLinkFailure,
} from "../rendering/RendererManager";
import { PREWARM_BODY_COUNT } from "../gameplay/disguiseTheatre";
import { RoundSession } from "../gameplay/RoundSession";
import type { RoundDirector } from "../gameplay/RoundDirector";
import type { RoundSpatialBridge } from "../gameplay/roundSpatial";
import type { NetworkAdapter } from "../networking/NetworkAdapter";
import { ShopWorld } from "../world/ShopWorld";
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

/**
 * Work the round still has after the map is built: the hunt's bodies, and the
 * shader pass over the finished scene. Counted so the progress a player is shown
 * does not sit at 100% through the longest wait of the load.
 */
const LOAD_TAIL_STEPS = 2;

/** What a loading screen is told while a round opens. */
export interface RoundLoadProgress {
  /** Names what was just finished, in the player's language. */
  readonly label: string;
  /** 0 to 1. */
  readonly fraction: number;
}

/**
 * Hands the frame back to the browser. Everything the round build does is main
 * thread work, so without this the tab is frozen from the click to the first
 * frame of the shop, whatever a loading screen has been asked to show.
 */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        resolve();
      });
      return;
    }
    setTimeout(resolve, 0);
  });
}

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
  private readonly shaderFailures = new ShaderFailurePolicy();

  private world: TestRoom | null = null;
  private shop: ShopWorld | null = null;
  private session: RoundSession | null = null;
  private forge: ForgeController | null = null;
  private overlay: DiagnosticsOverlay | null = null;
  private settings: QualitySettings = qualitySettingsFor(BOOT_TIER);
  private readonly adaptive: AdaptiveQuality;
  private tierLockedByUser = false;
  /** Highest tier index automatic changes may reach; lowered by link failures. */
  private tierCeiling = QUALITY_TIER_ORDER.length - 1;
  private probeApplied = false;
  private running = false;
  private hidden = false;
  private disposed = false;
  private lastTimeMs = 0;
  private accumulator = 0;
  /** Identifies the round currently opening, so a stale build can stand down. */
  private roundToken = 0;

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
        this.reportDeviceEvent(event);
      }),
    );
    this.bag.addFn(
      this.renderer.onShaderLinkFailure((failure) => {
        this.handleShaderLinkFailure(failure);
      }),
    );

    // Settled before the world exists because the room commits its shadow map
    // resolution at construction; only the frame-time part of the heuristic is
    // still outstanding at this point.
    this.applyTier(pickDefaultTier(this.renderer.backend, null), true);

    this.buildMenuRoom();
    // Held through a closure rather than as a bag entry, because entering a
    // round releases the menu room early and a bag has no way to forget it.
    this.bag.addFn(() => {
      this.world?.dispose();
      this.world = null;
    });

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
    this.session?.setViewport(width, height);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.exitForgeMode();
    this.exitRoundMode();
    this.overlay = null;
    this.bag.dispose();
  }

  /**
   * Swaps the menu room for The Curiosity Shop and hands the round its engine.
   * The session decides what the player is holding from phase to phase; this
   * only owns the scene it happens in and the frame that drives it.
   *
   * Everything here used to run inside the click that started the round, which
   * on a weak device meant the tab stopped for a minute with nothing to say why.
   * It now builds the shop a zone at a time, yielding between them, warms the
   * hunt's bodies and every shader the scene needs, and only then takes the menu
   * room down. The menu keeps drawing behind the loading screen until that swap,
   * so there is no point at which the player is looking at a dead frame.
   *
   * Resolves null when the round was abandoned while it was still opening, which
   * `exitRoundMode` and `dispose` both do.
   */
  async enterRoundMode(
    adapter: NetworkAdapter,
    director: RoundDirector,
    spatial: RoundSpatialBridge,
    onProgress: (progress: RoundLoadProgress) => void = () => undefined,
  ): Promise<RoundSession | null> {
    if (this.session !== null) return this.session;

    this.exitForgeMode();
    const token = (this.roundToken += 1);
    const abandoned = (): boolean => this.disposed || this.roundToken !== token;

    let tail = LOAD_TAIL_STEPS;
    const shop = await ShopWorld.createIncremental(
      this.renderer.renderer,
      this.settings,
      async (step) => {
        if (abandoned()) return;
        tail = step.total + LOAD_TAIL_STEPS;
        onProgress({ label: step.label, fraction: step.done / tail });
        await nextFrame();
      },
    );
    if (abandoned()) {
      shop.dispose();
      return null;
    }

    const session = new RoundSession({
      scene: shop.scene,
      canvas: this.canvas,
      adapter,
      director,
      spatial,
      quality: this.settings,
    });

    try {
      onProgress({ label: "the mimics", fraction: (tail - 1) / tail });
      await session.prewarmDisguises(PREWARM_BODY_COUNT, async () => {
        onProgress({ label: "the shaders", fraction: (tail - 0.5) / tail });
        await nextFrame();
        await shop.precompile(this.renderer.renderer, session.camera);
      });
    } catch (error) {
      // Neither is installed yet, so nothing else will ever release them: a
      // shop lost here is the whole map's worth of GPU memory.
      session.dispose();
      shop.dispose();
      throw error;
    }

    if (abandoned()) {
      session.dispose();
      shop.dispose();
      return null;
    }

    // Last, so the menu is on screen for the whole load and the first frame of
    // the shop is a frame whose shaders already exist.
    this.world?.dispose();
    this.world = null;
    this.shop = shop;
    this.session = session;
    this.bag.addFn(() => {
      this.shop?.dispose();
      this.shop = null;
    });
    this.syncSize();
    // One real frame while the loading screen is still up. `compileAsync` walks
    // the beauty pass only: the shadow pipelines come from the shadow camera and
    // the post chain from its own passes, and both are built by the first frame
    // that needs them. Paying for that frame here means the player is looking at
    // a loading screen for it rather than at a stalled first second of play.
    this.renderer.render(shop.scene, session.camera);
    onProgress({ label: "the shop", fraction: 1 });
    return session;
  }

  /** Ends the round and puts the menu room back behind the main menu. */
  exitRoundMode(): void {
    // Bumping the token abandons a round that is still opening, so its build
    // releases what it has instead of installing a shop nobody asked for.
    this.roundToken += 1;
    this.session?.dispose();
    this.session = null;
    this.shop?.dispose();
    this.shop = null;
    if (this.disposed) {
      return;
    }
    this.buildMenuRoom();
    this.syncSize();
  }

  private buildMenuRoom(): void {
    if (this.world !== null) {
      return;
    }
    const world = new TestRoom(this.renderer.renderer, this.settings);
    world.attachInput(this.canvas);
    this.world = world;
  }

  get roundSession(): RoundSession | null {
    return this.session;
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
    // The backend is only known once the renderer exists, and it changes the
    // live light budget, so the boot tier's settings are stale even when the
    // heuristic lands back on the tier the field was initialised with.
    const next = qualitySettingsFor(tier, this.renderer.backend);
    if (this.settings === next) {
      return;
    }
    this.settings = next;
    this.renderer.applyQuality(this.settings);
    this.world?.applyQuality(this.settings);
    this.shop?.applyQuality(this.settings);
    this.session?.applyQuality(this.settings);
    this.forge?.applyQuality(this.settings);
    this.adaptive.applyQuality(this.settings, performance.now());
    this.callbacks.onTierChange?.(tier, automatic);
  }

  private applyTierSuggestion(direction: "raise" | "lower"): void {
    if (this.tierLockedByUser) {
      return;
    }
    this.stepTier(direction);
  }

  /** One rung of the tier ladder. False when there is no rung that way. */
  private stepTier(direction: "raise" | "lower"): boolean {
    const next = stepQualityTier(this.settings.tier, direction, this.tierCeiling);
    if (next === null) {
      return false;
    }
    this.applyTier(next, true);
    return true;
  }

  /**
   * A program the driver refused to link is the first event in the chain that
   * takes the WebGL 2 context down, and the tier is the only lever that shortens
   * a fragment program from here, so it is spent before the device dies rather
   * than after. Unlike a frame-budget suggestion this ignores a manual tier
   * lock: the player's choice was about how the game should look, and this is
   * about whether it can be drawn at all.
   *
   * Once the ladder is spent, `ShaderFailurePolicy` calls it, and the player is
   * shown the device-fault panel. That panel is the honest end state, since
   * nothing further can be traded away, so the fatal report is delivered as a
   * device loss, which is what it becomes within a few draw calls in any case.
   */
  private handleShaderLinkFailure(failure: ShaderLinkFailure): void {
    const index = QUALITY_TIER_ORDER.indexOf(this.settings.tier);
    // A tier whose programs the driver refused is closed for the session, so a
    // stretch of fast frames cannot climb back into it. It is set from the
    // failing tier before the demote, so a later raise cannot undo it.
    this.tierCeiling = Math.max(0, Math.min(this.tierCeiling, index - 1));
    const response = this.shaderFailures.record(performance.now(), index > 0);
    if (response === "demote") {
      this.stepTier("lower");
      this.callbacks.onRendererMessage?.(
        `${failure.api}: a shader failed to link, dropping to the ${this.settings.tier} quality tier`,
      );
      return;
    }
    if (response === "fault") {
      this.reportDeviceEvent({
        kind: "device-lost",
        api: failure.api,
        message: `Shader programs are failing to link at the lowest quality setting (${failure.message}). This device cannot draw the scene.`,
      });
    }
  }

  private reportDeviceEvent(event: DeviceEvent): void {
    this.callbacks.onDeviceEvent?.(event);
    this.callbacks.onRendererMessage?.(`${event.api}: ${event.message}`);
  }

  private readonly frame = (timeMs: number): void => {
    const world = this.world;
    const session = this.session;
    const shop = this.shop;
    if (world === null && session === null) {
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
      if (session !== null) {
        // A round is paced by the authority, not by this loop: the session
        // reads the phase and drives whichever system currently has the player.
        session.update(delta * 1000, timeMs);
      } else if (world !== null && forge === null) {
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
      } else if (forge !== null) {
        // The Forge is driven by input, not by a fixed step: the room's own
        // camera sweep would only fight the player's orbit.
        forge.update();
      }
    }

    if (session !== null && shop !== null) {
      this.renderer.render(shop.scene, session.camera);
    } else if (world !== null) {
      this.renderer.render(world.scene, forge === null ? world.camera : forge.camera);
    }
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
      meshCount: this.world?.stats.meshCount ?? this.shopMeshCount(),
      effects: this.renderer.post.activeEffects,
    };
  };

  /** Meshes the shop actually submits, in the same units TestRoom reports. */
  private shopMeshCount(): number {
    const stats = this.shop?.map.stats;
    if (stats === undefined) {
      return 0;
    }
    return stats.heroMeshes + stats.instancedMeshes + stats.mergedMeshes;
  }

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
