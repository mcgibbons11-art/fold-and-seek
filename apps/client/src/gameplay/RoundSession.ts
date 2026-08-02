import type { MatchCommand, SimEvent } from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, MatchPhase, type MatchSettings } from "@foldseek/shared";
import * as THREE from "three/webgpu";

import { AudioPlayer, type SoundId } from "../forge/AudioPlayer";
import { ForgeController } from "../forge/ForgeController";
import { SHOP_FORGE_WORKSPACE } from "../world/ShopWorld";
import {
  createInspectorSystem,
  InspectableSet,
  type FocusMetadata,
  type InspectableProxy,
  type InspectorSystem,
} from "../inspector";
import { NAV_DATA } from "../world/maps/nav";
import { WORLD_SCALE } from "../inspector/navData";
import { CURIOSITY_SHOP_OBJECTS } from "../world/maps/registry";
import { encodeDisguiseState } from "../mimic/poseWire";
import type { NetworkAdapter, Unsubscribe } from "../networking/NetworkAdapter";
import { Signal } from "../networking/signal";
import type { QualitySettings } from "../rendering/quality";
import type { InspectorGunView } from "../ui/rounds/InspectorHud";
import { humanMimicSpawn } from "./botDisguises";
import { DisguiseTheatre, TAUNT_PITCH_JITTER } from "./disguiseTheatre";
import { CATCH_SOUND, ReactionTheatre, TAUNT_SOUND, WRONG_ACCUSATION_SOUND } from "./huntCues";
import { RoundActions } from "./RoundActions";
import type { RoundDirector } from "./RoundDirector";
import type { RoundSpatialBridge } from "./roundSpatial";
import type { RoundViewState } from "./roundView";

/**
 * The engine half of a round. It watches the one RoundViewState the director
 * publishes and gives the player whatever that phase says they should be
 * holding: the Forge while they fold, the Inspector rig and gun while they
 * hunt, and a slow survey of the shop the rest of the time.
 *
 * It owns no React and no renderer. GameHost drives `update` from the frame
 * loop and renders `camera`; the HUD reads `engineState` through `subscribe`.
 */

export type RoundCameraMode = "survey" | "forge" | "inspect";

/** What the HUD needs that the authority does not know about. */
export interface RoundEngineState {
  readonly cameraMode: RoundCameraMode;
  /** The player's own Forge while they have one, for the tool HUD. */
  readonly forge: ForgeController | null;
  readonly gun: InspectorGunView;
  /** False while the Inspector's pointer is free, which is when to prompt. */
  readonly pointerLocked: boolean;
}

/** Phases in which the authority accepts a pose from a Mimic (§5.8, override 2). */
const POSE_PUBLISH_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.Forge,
  MatchPhase.Locking,
  MatchPhase.InspectionIntro,
  MatchPhase.Inspection,
  MatchPhase.FinalCountdown,
]);

const INSPECTION_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.InspectionIntro,
  MatchPhase.Inspection,
  MatchPhase.FinalCountdown,
]);

/**
 * How often a Mimic's working pose goes to the room. It is a snapshot of
 * authoring state, not one message per drag, and it stays well inside
 * `maxForgeCommandHz`.
 */
const POSE_PUBLISH_INTERVAL_MS = 500;

/** Survey camera: a slow turn about the middle of the sales floor. */
const SURVEY_TARGET = new THREE.Vector3(-0.5, 0.8, 0);
const SURVEY_RADIUS_M = 4.6;
const SURVEY_HEIGHT_M = 2.35;
const SURVEY_RAD_PER_SECOND = 0.06;
const SURVEY_FOV_DEG = 55;

/** What the Forge says once the disguise is standing in the room (override 2). */
const HUNT_EDIT_HINT = "Your disguise is in the room. Keep shaping it, and creep slowly.";

/** The shop door, opened once as the Inspector is let in. */
const DOOR_SOUND: SoundId = "door_open";
/** One footfall per this share of body height travelled. */
const FOOTSTEP_STRIDE_FACTOR = 0.62;
/** Below this share of body height per second, nobody is walking. */
const MIN_FOOTSTEP_SPEED_FACTOR = 0.3;
const FOOTSTEP_PITCH_JITTER = 0.12;

const IDLE_GUN: InspectorGunView = {
  state: "idle",
  targetObjectId: null,
  targetDistanceM: null,
  targetInRange: false,
  triggerProgress: 0,
  cooldownRemainingMs: 0,
};

export interface RoundSessionOptions {
  readonly scene: THREE.Scene;
  readonly canvas: HTMLCanvasElement;
  readonly adapter: NetworkAdapter;
  readonly director: RoundDirector;
  readonly spatial: RoundSpatialBridge;
  readonly quality: QualitySettings;
}

/** Focus proxies for the shop itself, which never change during a round. */
const PROP_PROXIES: readonly InspectableProxy[] = CURIOSITY_SHOP_OBJECTS.map((entry) => ({
  objectId: entry.objectId,
  categoryId: entry.categoryId,
  bounds: entry.focusBounds,
  pickProxy: { kind: "box", box: entry.focusBounds },
  accusationPolicy: entry.accusationPolicy,
}));

export class RoundSession {
  readonly actions: RoundActions;

  /** Survey and Inspector share one camera; the Forge brings its own. */
  private readonly viewCamera: THREE.PerspectiveCamera;
  private readonly options: RoundSessionOptions;
  private readonly audio = new AudioPlayer();
  private readonly theatre: DisguiseTheatre;
  private readonly reactions: ReactionTheatre;
  private readonly changed = new Signal<RoundEngineState>();
  private readonly subscriptions: Unsubscribe[] = [];

  private quality: QualitySettings;
  private mode: RoundCameraMode = "survey";
  private forge: ForgeController | null = null;
  private forgeSubscription: Unsubscribe | null = null;
  private forgeLocked = false;
  private inspector: InspectorSystem | null = null;
  private focus: FocusMetadata | null = null;
  private pointerLocked = false;
  private inspectablesRevision = -1;

  private surveyAngle = 0.6;
  private publishedRevision = -1;
  private sincePublishMs = 0;
  private lastPhase: MatchPhase | null = null;
  private engine: RoundEngineState;
  private engineSignature = "";

  constructor(options: RoundSessionOptions) {
    this.options = options;
    this.quality = options.quality;
    this.actions = new RoundActions(options.adapter, options.director);
    this.theatre = new DisguiseTheatre(options.scene, options.quality, this.audio);
    this.reactions = new ReactionTheatre(options.scene, this.audio);
    options.spatial.setDisguiseBounds((objectId) => this.theatre.boundsOf(objectId));

    this.viewCamera = new THREE.PerspectiveCamera(SURVEY_FOV_DEG, 1, 0.01, 60);
    this.engine = { cameraMode: "survey", forge: null, gun: IDLE_GUN, pointerLocked: false };

    this.subscriptions.push(
      options.adapter.onEvent((event) => {
        this.presentEvent(event);
      }),
      options.adapter.onRejection((rejection) => {
        this.inspector?.handleRejection(rejection);
      }),
    );
    this.options.canvas.addEventListener("click", this.onCanvasClick);
  }

  get engineState(): RoundEngineState {
    return this.engine;
  }

  subscribe(listener: (state: RoundEngineState) => void): Unsubscribe {
    return this.changed.subscribe(listener);
  }

  update(dtMs: number, nowMs: number): void {
    const state = this.state();
    // The host can widen or narrow the room's reach in the lobby, and the
    // authority checks every accusation against it, so the geometry seam has to
    // follow rather than keep the numbers it was built with.
    this.options.spatial.applySettings(this.settings());
    this.applyPhase(state);
    // The viewer's own disguise is left out only while the Forge is drawing it.
    // Once the Forge closes, at the reveal or on being caught, the theatre has
    // to stand it up like everybody else's or its owner watches an empty room.
    this.theatre.sync(
      this.options.adapter.getSync().publicState?.disguises ?? [],
      this.forge === null ? null : (state.self.ownDisguise?.publicObjectId ?? null),
    );
    // After the sync, which puts every body back where its pose says it stands.
    this.theatre.update(dtMs);
    this.reactions.update(dtMs);

    switch (this.mode) {
      case "forge":
        this.forge?.update();
        break;
      case "inspect":
        this.driveInspector(dtMs, nowMs, state);
        break;
      case "survey":
        this.driveSurvey(dtMs);
        break;
    }

    this.publishPose(dtMs, state);
    this.publishEngineState();
  }

  setViewport(width: number, height: number): void {
    this.viewCamera.aspect = Math.max(width, 1) / Math.max(height, 1);
    this.viewCamera.updateProjectionMatrix();
    this.forge?.setViewport(width, height);
  }

  applyQuality(settings: QualitySettings): void {
    this.quality = settings;
    this.forge?.applyQuality(settings);
    this.theatre.applyQuality(settings);
  }

  /** The camera the renderer should draw from this frame. */
  get camera(): THREE.PerspectiveCamera {
    return this.mode === "forge" && this.forge !== null ? this.forge.camera : this.viewCamera;
  }

  dispose(): void {
    this.options.canvas.removeEventListener("click", this.onCanvasClick);
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
    this.closeForge();
    this.closeInspector();
    this.theatre.dispose();
    this.reactions.dispose();
    this.audio.dispose();
    this.options.spatial.setDisguiseBounds(() => null);
    this.changed.clear();
  }

  // -------------------------------------------------------------- presentation

  /**
   * Gives the hunt's public events a body and a voice. Every one of these is
   * broadcast to the whole room, so the presentation is the same for everybody:
   * a taunt is performed by the object, an innocent object answers a wasted
   * warrant where it stands, and a catch and a miss each have their own sting.
   *
   * `disguise_updated` is deliberately absent. It carries no geometry, only the
   * news that some object changed; the pose and the paint travel in public
   * state, which `update` re-reads every frame, so a creep and a brushstroke
   * already reach the screen without anything here listening for them.
   */
  private presentEvent(event: SimEvent): void {
    switch (event.type) {
      case "taunt_performed":
        // A hider's own disguise is drawn by their Forge rather than by the
        // theatre, so their own taunt has no body here and only the sound
        // reaches them.
        if (!this.theatre.taunt(event.publicObjectId, event.tauntId, event.seed)) {
          this.audio.play(TAUNT_SOUND, TAUNT_PITCH_JITTER);
        }
        break;

      case "innocent_reaction":
        this.reactions.play(event.objectId, event.reactionId);
        break;

      case "accusation_resolved":
        this.audio.play(event.correct ? CATCH_SOUND : WRONG_ACCUSATION_SOUND);
        // The recoil and the reticle belong to the Inspector who fired.
        if (event.inspectorPublicId === this.state().self.publicPlayerId) {
          this.inspector?.handleAccusationResolved(event.correct);
        }
        break;

      default:
        break;
    }
  }

  // ------------------------------------------------------------------ phases

  private state(): RoundViewState {
    return this.options.director.getState();
  }

  private settings(): MatchSettings {
    return this.options.adapter.getSync().publicState?.settings ?? DEFAULT_MATCH_SETTINGS;
  }

  private applyPhase(state: RoundViewState): void {
    const phase = state.phase;
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.onPhaseEntered(phase, state);
    }

    const desired = this.desiredMode(state);
    if (desired === this.mode) return;

    this.mode = desired;
    if (desired !== "forge") this.closeForge();
    if (desired !== "inspect") this.closeInspector();
    if (desired === "forge") this.openForge();
    if (desired === "inspect") this.openInspector(state);
  }

  /**
   * A Mimic keeps the Forge for the whole round: the disguise manifests at the
   * end of the fold, but its owner goes on shaping and creeping it through the
   * hunt (override 2). An Inspector only takes the rig once the hunt opens.
   */
  private desiredMode(state: RoundViewState): RoundCameraMode {
    const { phase, self } = state;
    if (self.role === "mimic" && self.lifeState === "active") {
      if (phase === MatchPhase.Forge || phase === MatchPhase.Locking) return "forge";
      if (INSPECTION_PHASES.has(phase)) return "forge";
    }
    if (self.role === "inspector" && INSPECTION_PHASES.has(phase)) return "inspect";
    return "survey";
  }

  private onPhaseEntered(phase: MatchPhase, state: RoundViewState): void {
    if (phase === MatchPhase.Loading) {

      // Loading clears the lobby's ready flags and waits for everyone to say
      // they have the map. This client already has it, so it says so rather
      // than asking the player to press the same button a second time.
      this.actions.ready(true);
    }
    if (phase === MatchPhase.Locking && this.forge !== null && !state.self.disguiseLocked) {
      // Whatever is on the workbench when the shutters come down is what the
      // room gets. The authority auto-locks a Mimic who sends nothing, so this
      // only decides whether it locks the authored pose or the recovered one.
      this.forge.lock();
    }
    if (phase === MatchPhase.InspectionIntro) {
      // The shop door. Every role hears it, because it is the moment the room
      // stops being a workshop and becomes a hunt, and a hider hearing the
      // Inspector let in is the whole tension of the phase opening.
      this.audio.play(DOOR_SOUND);
    }
    if (phase === MatchPhase.InspectionIntro && this.forge !== null && this.forge.snapshot().locked) {
      // The disguise is already the room's; the editor goes back to editable so
      // its owner can keep working and creep (override 2).
      this.forge.unlock(HUNT_EDIT_HINT);
    }
  }

  // ------------------------------------------------------------------- forge

  private openForge(): void {
    if (this.forge !== null) return;
    const spawn = humanMimicSpawn();
    const forge = new ForgeController({
      scene: this.options.scene,
      canvas: this.options.canvas,
      quality: this.quality,
      origin: new THREE.Vector3(spawn.position.x, spawn.position.y, spawn.position.z),
      // Without the map's own volume the Forge would clamp the body back into
      // the practice room's eight metre box, dragging a Mimic off any far wall.
      workspace: SHOP_FORGE_WORKSPACE,
    });
    this.forge = forge;
    this.forgeLocked = false;
    this.publishedRevision = -1;
    this.forgeSubscription = forge.subscribe((hud) => {
      if (hud.locked === this.forgeLocked) return;
      this.forgeLocked = hud.locked;
      if (hud.locked) this.sendLock();
    });
  }

  private closeForge(): void {
    this.forgeSubscription?.();
    this.forgeSubscription = null;
    this.forge?.dispose();
    this.forge = null;
    this.forgeLocked = false;
  }

  /**
   * Publishes the disguise the Forge just froze. Paint travels first so the
   * authority carries it onto the record it is about to create; the lock itself
   * is what makes the object appear in the room.
   */
  private sendLock(): void {
    const locked = this.forge?.lockedDisguise ?? null;
    if (locked === null || this.state().self.disguiseLocked) return;

    if (locked.encodedPaint.length > 0) {
      this.options.adapter.sendPaintUpdate({ encodedPaint: locked.encodedPaint, revision: 1 });
    }
    this.actions.lockDisguise(encodeDisguiseState(locked.disguise), locked.disguise.revision);
    this.publishedRevision = locked.disguise.revision;
  }

  /**
   * The working pose, coalesced. Before the lock this is the recovery pose of
   * §5.8; after it, it is a creep or a reshape the authority validates against
   * the speed cap and the play volume.
   */
  private publishPose(dtMs: number, state: RoundViewState): void {
    const forge = this.forge;
    if (forge === null || state.self.role !== "mimic" || state.self.lifeState !== "active") return;
    if (!POSE_PUBLISH_PHASES.has(state.phase)) return;

    this.sincePublishMs += dtMs;
    if (this.sincePublishMs < POSE_PUBLISH_INTERVAL_MS) return;
    this.sincePublishMs = 0;

    const disguise = forge.disguise;
    if (disguise.revision <= this.publishedRevision) return;
    this.publishedRevision = disguise.revision;
    this.options.adapter.sendForgeSnapshot({
      encodedPose: encodeDisguiseState(disguise),
      revision: disguise.revision,
    });
  }

  // --------------------------------------------------------------- inspector

  private openInspector(state: RoundViewState): void {
    if (this.inspector !== null) return;
    const settings = this.settings();
    const inspector = createInspectorSystem({
      scene: this.options.scene,
      camera: this.viewCamera,
      navData: NAV_DATA,
      inspectables: this.buildInspectables(),
      settings,
      domElement: this.options.canvas,
      sendCommand: this.sendInspectorCommand,
      onFocusChange: (focus) => {
        this.focus = focus;
      },
      onPointerLockChange: (locked) => {
        this.pointerLocked = locked;
      },
    });
    this.inspector = inspector;
    this.inspectablesRevision = this.theatre.revision;

    const spawn = NAV_DATA.spawnPoints.inspectors[0];
    if (spawn !== undefined) inspector.spawnAt(spawn);
    inspector.setAmmo(state.self.warrantsRemaining ?? state.warrantsRemaining ?? 0);

    // The authority refuses an accusation from an Inspector whose eye it has
    // never been told, so the spawn is reported before the first frame runs.
    inspector.cameraRig.update(0, inspector.controller, false);
    const selfId = this.options.adapter.getSelfId();
    if (selfId !== null) this.options.spatial.setInspectorEye(selfId, inspector.cameraRig.eye);
  }

  private closeInspector(): void {
    const selfId = this.options.adapter.getSelfId();
    if (selfId !== null) this.options.spatial.setInspectorEye(selfId, null);
    this.inspector?.dispose();
    this.inspector = null;
    this.focus = null;
    this.pointerLocked = false;
    this.inspectablesRevision = -1;
  }

  private driveInspector(dtMs: number, nowMs: number, state: RoundViewState): void {
    const inspector = this.inspector;
    if (inspector === null) return;

    if (this.theatre.revision !== this.inspectablesRevision) {
      this.inspectablesRevision = this.theatre.revision;
      inspector.setInspectables(this.buildInspectables());
    }
    // Nothing may be shot during the walk-out, and the reveal ends the hunt.
    inspector.enabled = state.phase !== MatchPhase.InspectionIntro;
    inspector.setAmmo(state.self.warrantsRemaining ?? state.warrantsRemaining ?? 0);
    inspector.update(dtMs, nowMs);
    this.stepFootsteps(inspector);

    // The authority checks range and line of sight itself, and the eye it
    // checks from is this one: without it every accusation is refused.
    const selfId = this.options.adapter.getSelfId();
    if (selfId !== null) this.options.spatial.setInspectorEye(selfId, inspector.cameraRig.eye);
  }

  /**
   * The Inspector's own boards underfoot. The cadence comes from the speed the
   * controller actually achieved and from a stride quoted against player height,
   * so it neither drums at a standstill nor keeps a human cadence for a body
   * this size. Below a crawl there is no footfall to play.
   */
  private stepFootsteps(inspector: InspectorSystem): void {
    const { speed, grounded } = inspector.controller;
    if (!grounded || speed < MIN_FOOTSTEP_SPEED_FACTOR * WORLD_SCALE.playerHeight) return;
    const strideM = FOOTSTEP_STRIDE_FACTOR * WORLD_SCALE.playerHeight;
    this.audio.playThrottled("footstep_wood", (strideM / speed) * 1_000, FOOTSTEP_PITCH_JITTER);
  }

  private buildInspectables(): InspectableSet {
    return new InspectableSet([...PROP_PROXIES, ...this.theatre.proxies()]);
  }

  private readonly sendInspectorCommand = (command: MatchCommand): void => {
    if (command.type === "accuse") {
      this.actions.accuse(command.targetObjectId);
      return;
    }
    if (command.type === "focus") {
      this.actions.focus(command.targetObjectId);
      return;
    }
    this.options.adapter.sendCommand(command);
  };

  private readonly onCanvasClick = (): void => {
    if (this.mode === "inspect" && !this.pointerLocked) this.inspector?.requestPointerLock();
  };

  // ------------------------------------------------------------------ survey

  private driveSurvey(dtMs: number): void {
    this.surveyAngle += (dtMs / 1000) * SURVEY_RAD_PER_SECOND;
    this.viewCamera.position.set(
      SURVEY_TARGET.x + Math.sin(this.surveyAngle) * SURVEY_RADIUS_M,
      SURVEY_HEIGHT_M,
      SURVEY_TARGET.z + Math.cos(this.surveyAngle) * SURVEY_RADIUS_M,
    );
    this.viewCamera.lookAt(SURVEY_TARGET);
    if (Math.abs(this.viewCamera.fov - SURVEY_FOV_DEG) > 1e-3) {
      this.viewCamera.fov = SURVEY_FOV_DEG;
      this.viewCamera.updateProjectionMatrix();
    }
  }

  // ---------------------------------------------------------------- HUD feed

  private publishEngineState(): void {
    const gun = this.gunView();
    const signature = [
      this.mode,
      this.forge === null ? "-" : "forge",
      gun.state,
      gun.targetObjectId ?? "-",
      gun.targetInRange ? "1" : "0",
      Math.ceil(gun.cooldownRemainingMs / 100),
      this.pointerLocked ? "1" : "0",
    ].join("|");
    if (signature === this.engineSignature) return;
    this.engineSignature = signature;
    this.engine = {
      cameraMode: this.mode,
      forge: this.forge,
      gun,
      pointerLocked: this.pointerLocked,
    };
    this.changed.emit(this.engine);
  }

  private gunView(): InspectorGunView {
    const inspector = this.inspector;
    if (inspector === null) return IDLE_GUN;
    const weapon = inspector.weapon;
    const published = weapon.state;
    const phase =
      published.phase === "pending"
        ? "pending"
        : published.phase === "cooling"
          ? "cooldown"
          : published.aiming
            ? "aiming"
            : "idle";
    return {
      state: phase,
      targetObjectId: this.focus?.objectId ?? null,
      targetDistanceM: this.focus?.distanceM ?? null,
      targetInRange: published.target === "in_range",
      triggerProgress: 0,
      cooldownRemainingMs: weapon.cooldownRemainingMs,
      roundsChambered: Number.isFinite(published.ammo) ? published.ammo : undefined,
    };
  }
}
