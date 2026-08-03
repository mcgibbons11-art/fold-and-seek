import type { MatchCommand, SimEvent } from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, MatchPhase, type MatchSettings } from "@foldseek/shared";
import * as THREE from "three/webgpu";

import { getMusicEngine, musicSceneForPhase } from "../audio/music";
import { SoundCaptionLedger, type SoundCaption } from "../audio/soundCaptions";
import { SpatialAudioPlayer, getSpatialAudioRuntime } from "../audio/SpatialAudioPlayer";
import { WorldAmbienceEmitters } from "../audio/WorldAmbienceEmitters";
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
import { DEFAULT_LOOK_SENSITIVITY } from "../inspector/InspectorInput";
import { INSPECTOR_RADIUS_M, INSPECTOR_STEP_HEIGHT_M, surfaceAt, type AABB } from "../inspector/navData";
import { MIMIC_NAV_DATA, NAV_DATA } from "../world/maps/nav";
import { OFFICE_DOOR_NAME } from "../world/maps/props";
import { CURIOSITY_SHOP_OBJECTS, mapObject } from "../world/maps/registry";
import { SECURITY_OFFICE_BOUNDS } from "../world/maps/zones";
import { encodeDisguiseState } from "../mimic/poseWire";
import { PaintSnapshotBookkeeper, type PaintUploadStatsSink } from "../paint";
import { clientPerformanceTelemetry } from "../engine/performanceTelemetry";
import type {
  InspectorCameraSample,
  NetworkAdapter,
  Unsubscribe,
} from "../networking/NetworkAdapter";
import { Signal } from "../networking/signal";
import type { QualitySettings } from "../rendering/quality";
import type { InspectorGunView } from "../ui/rounds/InspectorHud";
import { AmbienceController, domBedVoices } from "./AmbienceController";
import { humanMimicSpawn } from "./botDisguises";
import { DisguiseTheatre, TAUNT_PITCH_JITTER } from "./disguiseTheatre";
import { FootstepDriver, RemoteInspectorFootsteps } from "./footsteps";
import {
  CATCH_SOUND,
  CLOSE_PASS_SOUND,
  ESCAPE_SOUND,
  LOSE_SOUND,
  PHASE_SOUNDS,
  REACTION_SOUNDS,
  ReactionTheatre,
  TAUNT_SOUND,
  WIN_SOUND,
  WRONG_ACCUSATION_SOUND,
} from "./huntCues";
import { RoundActions } from "./RoundActions";
import { isPlayerFacingRejection, type RoundDirector } from "./RoundDirector";
import { getPlayerPreferences, subscribePlayerPreferences, type PlayerPreferences } from "./preferences";
import { RemoteInspectorPresentation } from "./RemoteInspectorPresentation";
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
  readonly hiderTraversal: "climbing" | "topout" | "airborne" | null;
  /** Inspector direction relative to the current camera, radians; private/local only. */
  readonly dangerBearingRad: number | null;
  /** Semantic gameplay audio exposed visually when captions are enabled. */
  readonly soundCaptions: readonly SoundCaption[];
}

/** Phases in which the authority accepts a pose from a Mimic (§5.8, override 2). */
const POSE_PUBLISH_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.Forge,
  MatchPhase.Locking,
  MatchPhase.InspectionIntro,
  MatchPhase.Inspection,
  MatchPhase.FinalCountdown,
]);

export const INSPECTION_PHASES: ReadonlySet<MatchPhase> = new Set([
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
/** Paint feels immediate without competing with pose packets for the authority budget. */
const PAINT_PUBLISH_INTERVAL_MS = 150;

/** Survey camera: a slow turn about the middle of the sales floor. */
const SURVEY_TARGET = new THREE.Vector3(-0.5, 0.8, 0);
const SURVEY_RADIUS_M = 4.6;
const SURVEY_HEIGHT_M = 2.35;
const SURVEY_RAD_PER_SECOND = 0.06;
const SURVEY_FOV_DEG = 55;
/**
 * The survey is DRIVABLE: holding the left button swings it, at the same
 * sensitivity every other camera turns at. USER DIRECTIVE (2026-08-02): "i
 * can't turn my camera as a hider once the round starts" — the old survey
 * ran a fixed orbit, and a camera the player cannot turn
 * reads as a camera that is broken, whatever the cinematic intent was. The
 * sweep resumes on its own once the pointer has been still a moment.
 */
const SURVEY_RESUME_MS = 2500;

/**
 * Where the Inspector waits out the fold: inside the Security Office, on the
 * same slow turn, behind a shut door (§5.9).
 *
 * The sales-floor survey used to run for every role in every phase, which meant
 * the one player who must not know where anybody is spent the whole of the Forge
 * looking down on the shop while the Mimics chose their places. The office is
 * the room the fiction already puts them in, and the map makes it work without
 * a curtain or a blindfold: the partition is solid to a metre, the player is
 * 0.35 m tall, and the only opening is the doorway the door now fills.
 */
const OFFICE_VIGIL_CENTRE = new THREE.Vector3(5.9, 0, 3.7);
const OFFICE_VIGIL_TARGET = new THREE.Vector3(4.95, 0.35, 3.6);
const OFFICE_VIGIL_RADIUS_M = 0.55;
/**
 * Eye height for the vigil, and the number that does the work.
 *
 * The office partition is solid to a metre and glazed above it, onto the back
 * workshop where a Mimic may well be folding. Held below the dado and tilted
 * down at the door, the frame never reaches the glass, so what keeps the shop
 * out of the shot is the geometry rather than a promise about the camera path.
 */
const OFFICE_VIGIL_HEIGHT_M = 0.7;

/**
 * When the Inspector is shut in. New rounds move directly from role reveal to
 * Forge, so the office closes before any Mimic begins editing or moving.
 */
const OFFICE_VIGIL_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.Forge,
  MatchPhase.Locking,
]);

/** Phases in which the office door stands open, which is the hunt and after. */
const DOOR_OPEN_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.InspectionIntro,
  MatchPhase.Inspection,
  MatchPhase.FinalCountdown,
  MatchPhase.Reveal,
  MatchPhase.Results,
  MatchPhase.RematchVote,
]);

/**
 * How far the office door swings and how long it takes. The angle lays the leaf
 * back along the inside of the partition, out of the walk-out; the duration is
 * the length of the `door_open` cue the hunt opens on, so the sound and the
 * movement are one event.
 */
const OFFICE_DOOR_OPEN_RAD = 1.5;
const OFFICE_DOOR_SWING_SECONDS = 1.1;

/** What the Forge says once the disguise is standing in the room (override 2). */
const HUNT_EDIT_HINT = "Your disguise is in the room. Keep shaping it, and creep slowly.";

/** Seconds left at which the countdown stops ticking and starts insisting. */
const URGENT_TICK_SECONDS = 3;

/** Anything that counts as the gesture a browser wants before it will play audio. */
const GESTURE_EVENTS = ["pointerdown", "keydown"] as const;

const IDLE_GUN: InspectorGunView = {
  state: "idle",
  targetObjectId: null,
  targetDistanceM: null,
  targetInRange: false,
  triggerProgress: 0,
  cooldownRemainingMs: 0,
  dryFires: 0,
  blockedFires: 0,
  lastShotOutcome: null,
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
  private readonly ambience = new AmbienceController(domBedVoices());
  /** Shared with the menu, so a round and a menu never play two scores at once. */
  private readonly music = getMusicEngine();
  private readonly footsteps = new FootstepDriver(this.audio);
  private readonly theatre: DisguiseTheatre;
  private readonly reactions: ReactionTheatre;
  private readonly changed = new Signal<RoundEngineState>();
  private readonly captions = new SoundCaptionLedger();
  private readonly spatialRuntime = getSpatialAudioRuntime();
  private readonly spatialAudio = this.spatialRuntime === null ? null : new SpatialAudioPlayer(this.spatialRuntime);
  private readonly worldAmbience = this.spatialAudio === null ? null : new WorldAmbienceEmitters(this.spatialAudio);
  private readonly listenerForward = new THREE.Vector3();
  private readonly subscriptions: Unsubscribe[] = [];

  private quality: QualitySettings;
  private mode: RoundCameraMode = "survey";
  private forge: ForgeController | null = null;
  private forgeSubscription: Unsubscribe | null = null;
  private forgeLocked = false;
  private inspector: InspectorSystem | null = null;
  /** Full-body presentations for other human Inspectors in a two-seeker room. */
  private readonly remoteInspectors = new Map<string, RemoteInspectorPresentation>();
  private focus: FocusMetadata | null = null;
  private pointerLocked = false;
  private inspectablesRevision = -1;

  private surveyAngle = 0.6;
  /** Pointer id steering the survey, or null while it sweeps on its own. */
  private surveyPointerId: number | null = null;
  private surveyLastX = 0;
  /** Milliseconds since the player last steered; gates the auto-sweep. */
  private surveyIdleMs = Infinity;
  /** The office door leaf, resolved from the map once and cached. */
  private officeDoor: THREE.Object3D | null = null;
  private officeDoorSearched = false;
  private officeDoorAngleRad = 0;
  private publishedRevision = -1;
  private sincePublishMs = 0;
  private publishedPaintRevision = 0;
  private readonly paintBookkeeper = new PaintSnapshotBookkeeper();
  private readonly paintStats: PaintUploadStatsSink = {
    flushes: 0,
    rectangles: 0,
    pixels: 0,
    targets: 0,
    rasterizedStrokes: 0,
    flushCpuMs: 0,
    rebuilds: 0,
    rebuiltTargets: 0,
  };
  private sincePaintPublishMs = 0;
  private lastPhase: MatchPhase | null = null;
  /** Countdown second last ticked, so one tick is heard per second and no more. */
  private lastTickSecond = -1;
  /** Gun state last heard, for the raise and the shot. */
  private lastGunState: InspectorGunView["state"] = "idle";
  private gunCycleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Newest deception event already tallied, so only fresh points tick. */
  private lastDeceptionId = -1;
  private engine: RoundEngineState;
  private engineSignature = "";
  private preferences = getPlayerPreferences();
  private previousHiderClimbing = false;
  private topoutFeedbackMs = 0;
  /** The disguise the theatre is not drawing, because the Forge is. */
  private omittedObjectId: string | null = null;

  constructor(options: RoundSessionOptions) {
    this.options = options;
    this.quality = options.quality;
    this.actions = new RoundActions(options.adapter, options.director);
    // The ear is wherever the frame is drawn from, which is the Inspector's eye
    // during the hunt and the Mimic's orbit point in the Forge, so both roles
    // hear the room from where they are actually standing in it. Passed as a
    // getter rather than a position: the camera is swapped when the mode
    // changes, and a captured vector would leave the listener behind.
    const listener = (): THREE.Vector3 => this.camera.position;
    // The Web Audio path owns world position. Distance-only DOM audio remains
    // the fallback for browsers without it, never a second layer on top.
    const worldFallback = this.spatialAudio === null ? this.audio : null;
    this.theatre = new DisguiseTheatre(options.scene, options.quality, worldFallback, listener);
    this.reactions = new ReactionTheatre(options.scene, worldFallback, listener);
    void this.worldAmbience?.start().catch(() => {
      // Web Audio can be absent in a constrained preview; the broad DOM beds
      // remain the safe fallback and the round continues without a warning.
    });
    options.spatial.setDisguiseBounds((objectId) => this.theatre.boundsOf(objectId));
    options.spatial.setOwnDisguiseBounds((objectId) => this.ownDisguiseBoundsOf(objectId));

    this.viewCamera = new THREE.PerspectiveCamera(SURVEY_FOV_DEG, 1, 0.01, 60);
    this.engine = { cameraMode: "survey", forge: null, gun: IDLE_GUN, pointerLocked: false, hiderTraversal: null, dangerBearingRad: null, soundCaptions: [] };

    this.subscriptions.push(
      options.adapter.onEvent((event) => {
        this.presentEvent(event);
      }),
      options.adapter.onRejection((rejection) => {
        this.inspector?.handleRejection(rejection);
        // An Inspector who pulls the trigger with no warrants left gets an empty
        // chamber; everything else the authority refuses is a flat deny.
        //
        // "unsupported" is the exception and is silent: that is the client
        // probing an older authority for a verb it may not know, not the player
        // asking for anything, and answering a capability check with a refusal
        // noise would deny something nobody tried to do.
        if (
          rejection.reason !== "unsupported" &&
          isPlayerFacingRejection(rejection, this.state().phase)
        ) {
          this.audio.play(rejection.reason === "no_warrants" ? "gun_dry_click" : "ui_deny");
        }
      }),
    );
    this.subscriptions.push(
      subscribePlayerPreferences((preferences) => {
        this.applyPlayerPreferences(preferences);
      }),
    );
    const unsubscribeCamera = options.adapter.onCameraSample?.((seatId, sample) => {
      this.receiveInspectorCamera(seatId, sample);
    });
    if (unsubscribeCamera !== undefined) this.subscriptions.push(unsubscribeCamera);
    this.options.canvas.addEventListener("click", this.onCanvasClick);
    this.options.canvas.addEventListener("pointerdown", this.onSurveyPointerDown);
    this.options.canvas.addEventListener("pointermove", this.onSurveyPointerMove);
    this.options.canvas.addEventListener("pointerup", this.onSurveyPointerUp);
    this.options.canvas.addEventListener("pointercancel", this.onSurveyPointerUp);
    // Browsers refuse playback until the page has seen a gesture, and the beds
    // are the one thing that would otherwise try to start without one. Both a
    // press and a key count, because a hider who joins a round and walks off on
    // the keys would otherwise play in silence until they happened to click.
    for (const event of GESTURE_EVENTS) window.addEventListener(event, this.onFirstGesture);
  }

  get engineState(): RoundEngineState {
    return this.engine;
  }

  /** Phase last published by the authority, or null before the first state. */
  get phase(): MatchPhase | null {
    return this.lastPhase;
  }

  subscribe(listener: (state: RoundEngineState) => void): Unsubscribe {
    return this.changed.subscribe(listener);
  }

  /** Current authority-published room options for lobby controls. */
  get matchSettings(): MatchSettings {
    return this.settings();
  }

  /** Shareable code for the room lobby; local and dedicated sessions omit it. */
  get roomCode(): string {
    return this.options.adapter.getRoomCode?.() ?? "";
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
    // Whatever the theatre is told to leave out is exactly what the Forge is
    // drawing, and therefore exactly what `ownDisguiseBoundsOf` has to answer
    // for. Deriving both from one value is what keeps them complements: a
    // disguise no source knows about is one nobody can shoot.
    this.omittedObjectId =
      this.forge === null ? null : (state.self.ownDisguise?.publicObjectId ?? null);
    this.theatre.sync(
      this.options.adapter.getSync().publicState?.disguises ?? [],
      this.omittedObjectId,
    );
    // After the sync, which puts every body back where its pose says it stands.
    this.theatre.update(dtMs);
    this.reactions.update(dtMs);
    this.updateRemoteInspectors(dtMs, state);

    switch (this.mode) {
      case "forge":
        this.driveForge(dtMs, state);
        break;
      case "inspect":
        this.driveInspector(dtMs, nowMs, state);
        break;
      case "survey":
        this.driveSurvey(dtMs, state);
        break;
    }

    const camera = this.camera;
    camera.getWorldDirection(this.listenerForward);
    this.spatialRuntime?.setListener({
      position: camera.position,
      forward: this.listenerForward,
      up: camera.up,
    });

    this.stepOfficeDoor(dtMs, state);

    this.captions.update(dtMs);
    this.publishPose(dtMs, state);
    this.publishPaint(dtMs, state);
    this.publishEngineState(dtMs, state);
    this.stepCountdown(state);
    this.stepDeceptionTally(state);
    this.stepAmbience(dtMs, state);
  }

  /**
   * The room's own voice. The listener is wherever the camera is, which is the
   * Inspector's eye during the hunt and the Mimic's orbit point in the Forge, so
   * both roles hear the zone they are actually standing in.
   *
   * The score reads the same two numbers and is asked for its scene every frame
   * rather than on the phase change, because the watched meter moves inside the
   * hunt and the lift that answers it is a scene of its own. Asking for what is
   * already playing costs a comparison.
   */
  private stepAmbience(dtMs: number, state: RoundViewState): void {
    const listener = this.camera.position;
    this.ambience.update(dtMs, {
      phase: state.phase,
      watchedLevel: state.self.watchedLevel,
      listenerX: listener.x,
      listenerZ: listener.z,
    });
    this.music.setScene(musicSceneForPhase(state.phase, state.self.watchedLevel));
  }

  /**
   * Pushes the room and the score down so an event sits on top of them. The
   * beds and the music duck together because they are one mix: a stinger that
   * only cleared the beds would still arrive over a chord.
   */
  private duckUnderStinger(): void {
    this.ambience.duckUnderStinger();
    this.music.duck(1);
  }

  /** One tick a second through the final countdown, harder at the very end. */
  private stepCountdown(state: RoundViewState): void {
    const { timer } = state;
    if (!timer.finalTen || !timer.running || timer.secondsRemaining <= 0) {
      this.lastTickSecond = -1;
      return;
    }
    if (timer.secondsRemaining === this.lastTickSecond) return;
    this.lastTickSecond = timer.secondsRemaining;
    this.audio.play(
      timer.secondsRemaining <= URGENT_TICK_SECONDS ? "countdown_tick_final" : "countdown_tick",
    );
    if (timer.secondsRemaining <= URGENT_TICK_SECONDS) {
      this.captions.push({
        label: `${timer.secondsRemaining} seconds`,
        importance: "critical",
        durationMs: 900,
      });
    }
  }

  /**
   * A tick for every point the viewer's own disguise just earned. The deception
   * feed is filled in for a hider and left empty for everybody else, so this is
   * silent for an Inspector without having to ask what role is playing.
   */
  private stepDeceptionTally(state: RoundViewState): void {
    const newest = state.deception.recent[0];
    if (newest === undefined) return;
    if (newest.id === this.lastDeceptionId) return;
    // Only the newest entry is read, so however many events arrived at once this
    // is one tick. A player rejoining mid-round hears a single stale one, which
    // is a better trade than swallowing the first point they actually earn.
    this.lastDeceptionId = newest.id;
    this.audio.play("score_tick", 0.08);
  }

  /**
   * Builds the hunt's bodies and their shaders while the round is still loading.
   * See `DisguiseTheatre.prewarm`: a disguise only becomes public at the lock,
   * so without this every body in the room is new at the transition into the
   * hunt, which is the one moment nothing can be spared for it.
   */
  prewarmDisguises(bodies: number, compile: () => Promise<void>): Promise<void> {
    return this.theatre.prewarm(bodies, compile);
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
    this.options.canvas.removeEventListener("pointerdown", this.onSurveyPointerDown);
    this.options.canvas.removeEventListener("pointermove", this.onSurveyPointerMove);
    this.options.canvas.removeEventListener("pointerup", this.onSurveyPointerUp);
    this.options.canvas.removeEventListener("pointercancel", this.onSurveyPointerUp);
    for (const event of GESTURE_EVENTS) window.removeEventListener(event, this.onFirstGesture);
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
    this.closeForge();
    this.closeInspector();
    for (const remote of this.remoteInspectors.values()) remote.dispose();
    this.remoteInspectors.clear();
    this.theatre.dispose();
    this.reactions.dispose();
    this.ambience.dispose();
    this.worldAmbience?.dispose();
    if (this.gunCycleTimer !== null) clearTimeout(this.gunCycleTimer);
    this.gunCycleTimer = null;
    // The score is deliberately left alone. It outlives the round — the menu
    // shares the one engine — and the shell decides what plays once there is no
    // round to ask, which is the only way a single writer owns it at a time.
    this.audio.dispose();
    this.options.spatial.setDisguiseBounds(() => null);
    this.changed.clear();
  }

  // -------------------------------------------------------------- presentation

  /**
   * Gives the hunt's public events a body and a voice. Most of these are
   * broadcast to the whole room, so the presentation is the same for everybody:
   * a taunt is performed by the object, an innocent object answers a wasted
   * warrant where it stands, and a catch and a miss each have their own sting.
   *
   * Two of them are broadcast but heard by one player. A close pass and a
   * survived look both name a disguise, and they are that hider's own near miss:
   * the whole room learning which object an Inspector nearly caught would give
   * away the thing the round is about. They are checked against the viewer's own
   * disguise and are silent for everybody else.
   *
   * `disguise_updated` is deliberately absent. It carries no geometry, only the
   * news that some object changed; the pose and the paint travel in public
   * state, which `update` re-reads every frame, so a creep and a brushstroke
   * already reach the screen without anything here listening for them.
   *
   * `mimic_caught` drives the physical collapse only. Its sting already arrives
   * as `accusation_resolved`, so the animation path stays silent and cannot
   * double the hit sound.
   */
  private presentEvent(event: SimEvent): void {
    switch (event.type) {
      case "taunt_performed":
        // A hider's own disguise is drawn by their Forge rather than by the
        // theatre, so their own taunt has no body here and only the sound
        // reaches them.
        if (this.spatialAudio !== null) {
          this.theatre.taunt(event.publicObjectId, event.tauntId, event.seed);
          this.playAtObject(TAUNT_SOUND, event.publicObjectId, 0.85);
        } else if (!this.theatre.taunt(event.publicObjectId, event.tauntId, event.seed)) {
          this.audio.play(TAUNT_SOUND, TAUNT_PITCH_JITTER);
        }
        this.captionAtObject("Mechanical taunt", event.publicObjectId);
        break;

      case "innocent_reaction":
        this.reactions.play(event.objectId, event.reactionId);
        this.playAtObject(REACTION_SOUNDS[event.reactionId], event.objectId, 0.9);
        this.captionAtObject("Object reaction", event.objectId);
        break;

      case "accusation_resolved": {
        const shooter = this.state().roster.find(
          (player) => player.publicPlayerId === event.inspectorPublicId,
        );
        const remoteInspector =
          shooter === undefined ? undefined : this.remoteInspectors.get(shooter.seatId);
        if (event.inspectorPublicId !== this.state().self.publicPlayerId) {
          remoteInspector?.fire(event.seq);
        }
        if (this.spatialAudio === null) {
          this.audio.play(event.correct ? CATCH_SOUND : WRONG_ACCUSATION_SOUND);
        } else {
          const remoteEye = remoteInspector?.eye ?? null;
          if (
            event.inspectorPublicId !== this.state().self.publicPlayerId &&
            remoteEye !== null
          ) {
            void this.spatialAudio.playAt("gun_fire", remoteEye, { gain: 0.72 });
            window.setTimeout(() => {
              if (this.spatialAudio !== null) void this.spatialAudio.playAt("panel_snap", remoteEye, { gain: 0.35 });
            }, 110);
          }
          this.playAtObject(event.correct ? CATCH_SOUND : WRONG_ACCUSATION_SOUND, event.targetObjectId, 1);
        }
        this.captionAtObject(
          event.correct ? "Mimic caught" : "Wrong accusation",
          event.targetObjectId,
          "critical",
        );
        this.duckUnderStinger();
        // The recoil and the reticle belong to the Inspector who fired.
        if (event.inspectorPublicId === this.state().self.publicPlayerId) {
          this.inspector?.handleAccusationResolved(event.correct);
        }
        break;
      }

      case "close_pass":
        if (this.ownsDisguise(event.publicObjectId)) {
          this.audio.play(CLOSE_PASS_SOUND);
          this.duckUnderStinger();
        }
        break;

      case "direct_look_escape":
        if (this.ownsDisguise(event.publicObjectId)) this.audio.play(ESCAPE_SOUND);
        break;

      case "mimic_caught":
        this.theatre.playCatch(event.publicObjectId);
        break;

      case "match_ended": {
        // The results screen settles on `results_resolve` for everybody a moment
        // later; this is the half-second before it that says which way it went.
        const role = this.state().self.role;
        if (role === "mimic" || role === "inspector") {
          const won = event.winner === (role === "mimic" ? "mimics" : "inspectors");
          this.audio.play(won ? WIN_SOUND : LOSE_SOUND);
          this.captions.push({ label: won ? "Round won" : "Round lost", importance: "critical" });
          this.duckUnderStinger();
        }
        break;
      }

      default:
        break;
    }
  }

  /** True when a named disguise is the one this player is wearing. */
  private ownsDisguise(publicObjectId: string): boolean {
    return this.state().self.ownDisguise?.publicObjectId === publicObjectId;
  }

  private captionAtObject(
    label: string,
    objectId: string,
    importance: "gameplay" | "critical" = "gameplay",
  ): void {
    const centre = this.positionOfObject(objectId);
    this.captions.push({
      label,
      importance,
      bearingRad: centre === null ? null : this.bearingTo(centre),
    });
  }

  private playAtObject(sound: SoundId, objectId: string, gain: number): void {
    const position = this.positionOfObject(objectId);
    if (position === null || this.spatialAudio === null) return;
    void this.spatialAudio.playAt(sound, position, { gain, minimumGain: 0.04 });
  }

  private positionOfObject(objectId: string): THREE.Vector3 | null {
    const bounds = this.theatre.boundsOf(objectId) ?? mapObject(objectId)?.focusBounds ?? null;
    return bounds === null
      ? null
      : new THREE.Vector3(
          (bounds.min.x + bounds.max.x) / 2,
          (bounds.min.y + bounds.max.y) / 2,
          (bounds.min.z + bounds.max.z) / 2,
        );
  }

  private bearingTo(position: THREE.Vector3): number {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const cameraYaw = Math.atan2(forward.x, forward.z);
    const sourceYaw = Math.atan2(
      position.x - this.camera.position.x,
      position.z - this.camera.position.z,
    );
    return Math.atan2(Math.sin(sourceYaw - cameraYaw), Math.cos(sourceYaw - cameraYaw));
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
    if (
      self.role === "inspector" &&
      (OFFICE_VIGIL_PHASES.has(phase) || INSPECTION_PHASES.has(phase))
    ) {
      return "inspect";
    }
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
    const opening = PHASE_SOUNDS[phase];
    if (opening !== undefined) {
      for (const sound of opening) this.audio.play(sound);
      // A phase change is the loudest thing that happens all round; the beds
      // step back under it and come up again behind whatever it announced.
      this.duckUnderStinger();
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
      // The same walkable geometry the Inspector hunts over, so a Mimic runs
      // for its hiding place on the shop's own floors, blockers and climbs —
      // with the office door shut, which is the one square metre of the shop a
      // Mimic may never stand in (§10.4).
      navData: MIMIC_NAV_DATA,
    });
    this.forge = forge;
    this.forgeLocked = false;
    this.publishedRevision = -1;
    this.publishedPaintRevision = 0;
    this.paintBookkeeper.reset();
    this.sincePaintPublishMs = 0;
    this.forgeSubscription = forge.subscribe((hud) => {
      if (hud.locked === this.forgeLocked) return;
      this.forgeLocked = hud.locked;
      if (hud.locked) this.sendLock();
    });
  }

  /**
   * The Forge's own frame, plus the one thing about it that the phase decides.
   * A Mimic keeps its full run after the disguise manifests. The historical
   * `hiderCreepSpeed` field carries that same speed on client and authority so
   * prediction never gets ahead of the room.
   */
  private driveForge(dtMs: number, state: RoundViewState): void {
    const forge = this.forge;
    if (forge === null) return;
    const creeping = INSPECTION_PHASES.has(state.phase);
    forge.setCreepLimit(creeping ? this.settings().hiderCreepSpeed : null);
    // Reconnects can land directly inside the hunt without observing the phase
    // edge that normally unlocks the Forge. Editing and WASD are core hider
    // controls here, so enforce the live state rather than trusting one event.
    if (creeping && forge.snapshot().locked) forge.unlock(HUNT_EDIT_HINT);
    forge.update(dtMs);
    forge.paintLayer.readUploadStats(this.paintStats);
    clientPerformanceTelemetry.recordPaint(this.paintStats);

    // A Mimic on its feet walks the same controller the Inspector does, so it
    // gets the same boards underfoot. The quieter hunt footstep mix preserves
    // the hide-and-seek read without making the movement itself sluggish.
    const motion = forge.bodyMotion;
    if (motion !== null) this.footsteps.update(dtMs, motion, creeping);
  }

  private closeForge(): void {
    this.forgeSubscription?.();
    this.forgeSubscription = null;
    this.forge?.dispose();
    this.forge = null;
    this.forgeLocked = false;
  }

  /**
   * Publishes the disguise the Forge just froze. Paint is published by the
   * coalescer below, after the lock, so it cannot collide with a pose packet
   * sent just before the button press. The authority accepts post-lock paint.
   */
  private sendLock(): void {
    const locked = this.forge?.lockedDisguise ?? null;
    if (locked === null || this.state().self.disguiseLocked) return;

    this.actions.lockDisguise(encodeDisguiseState(locked.disguise), locked.disguise.revision);
    this.publishedRevision = locked.disguise.revision;
  }

  private applyPlayerPreferences(preferences: PlayerPreferences): void {
    this.preferences = preferences;
    const motion = preferences.reducedMotion ? 0 : preferences.cameraMotion;
    const shake = preferences.reducedMotion ? 0 : preferences.shake;
    this.inspector?.setViewPreferences({
      sensitivityX: DEFAULT_LOOK_SENSITIVITY * preferences.sensitivityX,
      sensitivityY: DEFAULT_LOOK_SENSITIVITY * preferences.sensitivityY,
      invertY: preferences.invertY,
      fov: preferences.fov,
      cameraMotion: motion,
      shake,
    });
  }

  /**
   * Sends no paint for an untouched body and one coalesced layer for actual
   * brush work. Pose and paint share the authority limiter, so either send
   * resets the other's clock instead of racing two packets into one window.
   */
  private publishPaint(dtMs: number, state: RoundViewState): void {
    const forge = this.forge;
    if (forge === null || state.self.role !== "mimic" || state.self.lifeState !== "active") return;
    if (!POSE_PUBLISH_PHASES.has(state.phase)) return;

    this.sincePaintPublishMs += dtMs;
    if (forge.paintRevision <= this.publishedPaintRevision) return;
    if (this.sincePaintPublishMs < PAINT_PUBLISH_INTERVAL_MS) return;
    const paint = forge.paintSnapshot;
    const publication = this.paintBookkeeper.capture(forge.paintLayer);

    this.publishedPaintRevision = paint.revision;
    this.sincePaintPublishMs = 0;
    this.sincePublishMs = 0;
    this.options.adapter.sendPaintUpdate({
      encodedPaint: paint.encodedPaint,
      revision: paint.revision,
      ...(publication === null ? {} : { encodedSync: publication.encoded }),
    });
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
    // A body in mid-air has no pose worth recording: it is a moment rather than
    // a place, and during the hunt the apex of a hop is further from the last
    // accepted pose than `hiderCreepSpeed` allows over the same interval, so
    // publishing one would be refused for a position the body is about to leave
    // anyway. The interval keeps running, so the pose goes out on landing.
    if (forge.bodyAirborne) return;
    this.sincePublishMs = 0;

    const disguise = forge.disguise;
    if (disguise.revision <= this.publishedRevision) return;
    this.publishedRevision = disguise.revision;
    this.sincePaintPublishMs = 0;
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
      castShadow: this.options.quality.dynamicShadows,
      inputOptions: {
        lookSensitivityX: DEFAULT_LOOK_SENSITIVITY * this.preferences.sensitivityX,
        lookSensitivityY: DEFAULT_LOOK_SENSITIVITY * this.preferences.sensitivityY,
        invertY: this.preferences.invertY,
      },
      cameraOptions: {
        baseFovDeg: this.preferences.fov,
        aimFovDeg: Math.max(40, this.preferences.fov - 14),
        motionScale: this.preferences.reducedMotion ? 0 : this.preferences.cameraMotion,
        shakeScale: this.preferences.reducedMotion ? 0 : this.preferences.shake,
      },
      sendCommand: this.sendInspectorCommand,
      onFocusChange: (focus) => {
        this.focus = focus;
      },
      onPointerLockChange: (locked) => {
        this.pointerLocked = locked;
      },
      onCameraSample: (sample) => {
        this.options.adapter.sendCameraSample?.(sample);
      },
      onEye: (eye) => {
        const selfId = this.options.adapter.getSelfId();
        if (selfId !== null) this.options.spatial.setInspectorEye(selfId, eye);
      },
      // A round that never becomes an accusation is heard here and nowhere
      // else. The report of a real shot is played from the weapon's own state
      // in `stepGun`, so this is only the trigger clicking on nothing: no
      // target, out of range, a decorative object, or an empty magazine.
      onShot: (outcome) => {
        if (outcome === "hit") return;
        this.audio.play("gun_dry_click");
      },
    });
    this.inspector = inspector;
    this.inspectablesRevision = this.theatre.revision;

    const spawn = NAV_DATA.spawnPoints.inspectors[0];
    if (spawn !== undefined) inspector.spawnAt(spawn);
    this.loadWarrants(inspector, state);

    // The authority refuses an accusation from an Inspector whose eye it has
    // never been told, so the spawn is reported before the first frame runs.
    inspector.cameraRig.update(0, inspector.controller, false);
    const selfId = this.options.adapter.getSelfId();
    if (selfId !== null) this.options.spatial.setInspectorEye(selfId, inspector.cameraRig.eye);
  }

  private closeInspector(): void {
    this.options.adapter.sendCameraSample?.(null);
    const selfId = this.options.adapter.getSelfId();
    if (selfId !== null) this.options.spatial.setInspectorEye(selfId, null);
    this.inspector?.dispose();
    this.inspector = null;
    this.focus = null;
    this.pointerLocked = false;
    this.inspectablesRevision = -1;
  }

  /** Creates, updates, or retires one peer's visual-only Inspector body. */
  private receiveInspectorCamera(
    seatId: string,
    sample: InspectorCameraSample | null,
  ): void {
    if (seatId === this.options.adapter.getSelfId()) return;
    if (sample === null) {
      this.remoteInspectors.get(seatId)?.dispose();
      this.remoteInspectors.delete(seatId);
      return;
    }
    let remote = this.remoteInspectors.get(seatId);
    if (remote === undefined) {
      remote = new RemoteInspectorPresentation(
        this.options.scene,
        seatId,
        this.options.quality.dynamicShadows,
      );
      if (this.spatialAudio !== null) {
        remote.attachFootsteps(
          new RemoteInspectorFootsteps(this.spatialAudio, (event) => {
            this.captions.push({
              label: event.text,
              importance: "gameplay",
              bearingRad: this.bearingTo(new THREE.Vector3(event.position.x, event.position.y, event.position.z)),
            });
          }),
          (x, y, z) => surfaceAt(NAV_DATA.floors, x, z, y + INSPECTOR_STEP_HEIGHT_M)?.id ?? null,
        );
      }
      this.remoteInspectors.set(seatId, remote);
    }
    remote.push(sample);
  }

  private updateRemoteInspectors(dtMs: number, state: RoundViewState): void {
    const visible = INSPECTION_PHASES.has(state.phase);
    for (const remote of this.remoteInspectors.values()) {
      remote.setVisible(visible);
      remote.update(dtMs);
    }
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
    this.loadWarrants(inspector, state);
    inspector.update(dtMs, nowMs);
    if (OFFICE_VIGIL_PHASES.has(state.phase)) {
      // The pre-game Inspector can walk and look normally, but the shut door is
      // also a gameplay boundary: never let collision interpolation squeeze the
      // capsule through it before the hunt opens.
      const position = inspector.controller.position;
      position.x = Math.min(
        SECURITY_OFFICE_BOUNDS.max.x - INSPECTOR_RADIUS_M,
        Math.max(SECURITY_OFFICE_BOUNDS.min.x + INSPECTOR_RADIUS_M, position.x),
      );
      position.z = Math.min(
        SECURITY_OFFICE_BOUNDS.max.z - INSPECTOR_RADIUS_M,
        Math.max(SECURITY_OFFICE_BOUNDS.min.z + INSPECTOR_RADIUS_M, position.z),
      );
      inspector.root.position.set(position.x, position.y, position.z);
    }
    // The Inspector never creeps: the cap belongs to a disguised hider.
    this.footsteps.update(dtMs, inspector.controller, false);
    this.stepGun();

    // The eye is published inside InspectorSystem immediately after its camera
    // follows this frame's movement and before its weapon can send a shot. Do
    // not move that report back here: a remote authority would otherwise judge
    // the command against the previous telemetry flush.
  }


  /**
   * Warrants into the gun. The total is what the drum is built with and the
   * remainder is what is still in it, so the chambered rounds on the model and
   * the magazine in the HUD are the same two numbers.
   */
  private loadWarrants(inspector: InspectorSystem, state: RoundViewState): void {
    const remaining = state.self.warrantsRemaining ?? state.warrantsRemaining ?? 0;
    // This seeker's own allowance: with two hunters the room's total is twice
    // the drum, and building the gun from it would chamber a partner's rounds.
    inspector.setAmmo(remaining, state.warrantsPerInspector ?? state.warrantsTotal ?? remaining);
  }

  /**
   * The warrant gun (override 1), heard from the state the weapon publishes
   * rather than from the input that drove it: the raise as it comes up, the
   * stamp as it goes off. The empty chamber is not here, because a trigger with
   * no warrants behind it never reaches the weapon; it comes back as a refusal
   * and is played from there.
   */
  private stepGun(): void {
    const state = this.gunView().state;
    if (state === this.lastGunState) return;
    const previous = this.lastGunState;
    this.lastGunState = state;
    if (state === "aiming" && previous === "idle") this.audio.play("gun_aim");
    if (state === "pending") {
      this.audio.play("gun_fire");
      this.captions.push({ label: "Warrant fired", importance: "critical" });
      if (this.gunCycleTimer !== null) clearTimeout(this.gunCycleTimer);
      this.gunCycleTimer = setTimeout(() => {
        this.gunCycleTimer = null;
        this.audio.play("panel_snap", 0.03, 0.4);
      }, 110);
      this.duckUnderStinger();
    }
  }

  /**
   * Bounds for the one disguise the theatre is not drawing: the viewer's own,
   * while their Forge holds it. Everything else answers `null` here and is found
   * through the theatre, so a body is never described by two sources at once.
   *
   * This is what makes a hider shootable while they are still editing, which
   * override 2 means is the whole hunt. Without it the authority refuses every
   * accusation against them for want of a box, and under Portals — where the
   * host is an ordinary player running the simulation — a host who drew Mimic
   * would be immune for as long as they held authority.
   */
  private ownDisguiseBoundsOf(objectId: string): AABB | null {
    if (objectId !== this.omittedObjectId) return null;
    return this.forge?.bodyBounds ?? null;
  }

  private buildInspectables(): InspectableSet {
    return new InspectableSet([...PROP_PROXIES, ...this.theatre.proxies()]);
  }

  private readonly sendInspectorCommand = (command: MatchCommand): void => {
    if (command.type === "accuse") {
      const outcome = this.actions.accuse(command.targetObjectId);
      if (!outcome.sent) {
        // A local gate refusal never reaches the adapter's rejection stream.
        // Feed it back into the weapon immediately so the gun cannot sit in a
        // five-second pending state after a command that was never sent.
        this.inspector?.handleRejection({ type: "accuse", reason: outcome.reason });
        this.audio.play(outcome.reason === "no_warrants" ? "gun_dry_click" : "ui_deny");
      }
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

  /**
   * Steering for the survey and the vigil. Only the left button, and only in
   * survey mode: the Forge and the Inspector rigs route their own pointers,
   * and a press that lands while one of them owns the camera is theirs.
   */
  private readonly onSurveyPointerDown = (event: PointerEvent): void => {
    if (this.mode !== "survey" || event.button !== 0) return;
    this.surveyPointerId = event.pointerId;
    this.surveyLastX = event.clientX;
    this.surveyIdleMs = 0;
    this.options.canvas.setPointerCapture?.(event.pointerId);
  };

  private readonly onSurveyPointerMove = (event: PointerEvent): void => {
    if (this.surveyPointerId !== event.pointerId) return;
    if (this.mode !== "survey") {
      this.surveyPointerId = null;
      return;
    }
    // The same radians-per-pixel every other camera turns at, negated because
    // dragging right should swing the view right (the orbit runs the other way).
    this.surveyAngle -=
      (event.clientX - this.surveyLastX) * DEFAULT_LOOK_SENSITIVITY * this.preferences.sensitivityX;
    this.surveyLastX = event.clientX;
    this.surveyIdleMs = 0;
  };

  private readonly onSurveyPointerUp = (event: PointerEvent): void => {
    if (this.surveyPointerId !== event.pointerId) return;
    this.surveyPointerId = null;
    this.surveyIdleMs = 0;
  };

  /** The gesture the beds have been waiting for. Unbinds itself once it lands. */
  private readonly onFirstGesture = (): void => {
    this.ambience.start();
    for (const event of GESTURE_EVENTS) window.removeEventListener(event, this.onFirstGesture);
  };

  // ------------------------------------------------------------------ survey

  /**
   * The between-phases camera, and the one thing about it the role decides.
   *
   * Everybody else turns slowly over the sales floor. An Inspector who has not
   * been let out yet turns just as slowly inside the Security Office, because
   * the sales floor is what they are not allowed to see: the Mimics are out
   * there choosing hiding places, and a round the seeker watched being set up is
   * no longer a round. Once the hunt has opened the office is behind them and
   * the shop is theirs, so the reveal and the results run the ordinary survey.
   */
  private driveSurvey(dtMs: number, state: RoundViewState): void {
    const vigil = this.waitingInTheOffice(state);
    // The survey turns about whatever it is looking at; the vigil turns about
    // the middle of the office and keeps looking at the door, because the door
    // is the thing the Inspector is waiting on.
    const centre = vigil ? OFFICE_VIGIL_CENTRE : SURVEY_TARGET;
    const target = vigil ? OFFICE_VIGIL_TARGET : SURVEY_TARGET;
    const radius = vigil ? OFFICE_VIGIL_RADIUS_M : SURVEY_RADIUS_M;
    const height = vigil ? OFFICE_VIGIL_HEIGHT_M : SURVEY_HEIGHT_M;

    // The sweep yields to the player's hand and takes over again once the
    // pointer has been still a moment, so the camera is never uncontrollable
    // and never needs controlling.
    this.surveyIdleMs += dtMs;
    if (this.surveyPointerId === null && this.surveyIdleMs >= SURVEY_RESUME_MS) {
      this.surveyAngle += (dtMs / 1000) * SURVEY_RAD_PER_SECOND;
    }
    this.viewCamera.position.set(
      centre.x + Math.sin(this.surveyAngle) * radius,
      height,
      centre.z + Math.cos(this.surveyAngle) * radius,
    );
    this.viewCamera.lookAt(target);
    const preferredFov = this.preferences.fov;
    if (Math.abs(this.viewCamera.fov - preferredFov) > 1e-3) {
      this.viewCamera.fov = preferredFov;
      this.viewCamera.updateProjectionMatrix();
    }
  }

  /** True while this client is the Inspector and the Mimics are folding. */
  private waitingInTheOffice(state: RoundViewState): boolean {
    return state.self.role === "inspector" && OFFICE_VIGIL_PHASES.has(state.phase);
  }

  /**
   * Swings the office door. It is shut for as long as the Inspector is behind
   * it and opens on the hunt, over roughly the length of the cue that announces
   * it, so the sound the whole room hears has something to have happened.
   *
   * The leaf is a hero prop whose parts all sit on the hinge, so writing one
   * angle onto each of them is the whole of the animation. Nothing in the
   * navigation data moves with it: the Inspector's map has the doorway open
   * because they only ever walk it during the hunt, and a Mimic's has it shut
   * for the whole round because §10.4 never lets them in.
   */
  private stepOfficeDoor(dtMs: number, state: RoundViewState): void {
    const door = this.resolveOfficeDoor();
    if (door === null) return;

    const wanted = DOOR_OPEN_PHASES.has(state.phase) ? OFFICE_DOOR_OPEN_RAD : 0;
    if (this.officeDoorAngleRad !== wanted) {
      const step = ((dtMs / 1000) * OFFICE_DOOR_OPEN_RAD) / OFFICE_DOOR_SWING_SECONDS;
      const gap = wanted - this.officeDoorAngleRad;
      this.officeDoorAngleRad += Math.abs(gap) <= step ? gap : Math.sign(gap) * step;
    }
    for (const part of door.children) part.rotation.y = this.officeDoorAngleRad;
  }

  private resolveOfficeDoor(): THREE.Object3D | null {
    if (this.officeDoorSearched) return this.officeDoor;
    this.officeDoorSearched = true;
    this.officeDoor = this.options.scene.getObjectByName(OFFICE_DOOR_NAME) ?? null;
    return this.officeDoor;
  }

  // ---------------------------------------------------------------- HUD feed

  private publishEngineState(dtMs: number, state: RoundViewState): void {
    const gun = this.gunView();
    const hiderTraversal = this.hiderTraversalView(dtMs);
    const dangerBearingRad = state.self.watchedLevel > 0 ? this.dangerBearing() : null;
    const signature = [
      this.mode,
      this.forge === null ? "-" : "forge",
      gun.state,
      gun.targetObjectId ?? "-",
      gun.targetInRange ? "1" : "0",
      Math.ceil(gun.cooldownRemainingMs / 100),
      gun.dryFires,
      gun.blockedFires ?? 0,
      this.pointerLocked ? "1" : "0",
      hiderTraversal ?? "-",
      dangerBearingRad === null ? "-" : Math.round(dangerBearingRad * 20),
      this.captions.current
        .map((caption) => `${caption.id}:${Math.ceil(caption.remainingMs / 100)}`)
        .join(","),
    ].join("|");
    if (signature === this.engineSignature) return;
    this.engineSignature = signature;
    this.engine = {
      cameraMode: this.mode,
      forge: this.forge,
      gun,
      pointerLocked: this.pointerLocked,
      hiderTraversal,
      dangerBearingRad,
      soundCaptions: this.captions.current,
    };
    this.changed.emit(this.engine);
  }

  private hiderTraversalView(dtMs: number): RoundEngineState["hiderTraversal"] {
    const motion = this.forge?.bodyMotion ?? null;
    if (motion === null) {
      this.previousHiderClimbing = false;
      this.topoutFeedbackMs = 0;
      return null;
    }
    const climbing = motion.climbState !== null;
    if (this.previousHiderClimbing && !climbing && motion.grounded && motion.position.y > 0.15) {
      this.topoutFeedbackMs = 1_400;
    }
    this.previousHiderClimbing = climbing;
    this.topoutFeedbackMs = Math.max(0, this.topoutFeedbackMs - dtMs);
    if (climbing) return "climbing";
    if (this.topoutFeedbackMs > 0) return "topout";
    if (!motion.grounded) return "airborne";
    return null;
  }

  private dangerBearing(): number | null {
    const forge = this.forge;
    if (forge === null) return null;
    const origin = forge.disguise.root.position;
    let nearest: Readonly<THREE.Vector3> | null = null;
    let nearestDistance = Infinity;
    for (const remote of this.remoteInspectors.values()) {
      const eye = remote.eye;
      if (eye === null) continue;
      const distance = Math.hypot(eye.x - (origin[0] ?? 0), eye.z - (origin[2] ?? 0));
      if (distance < nearestDistance) {
        nearest = eye;
        nearestDistance = distance;
      }
    }
    if (nearest === null) return null;
    const worldBearing = Math.atan2(
      nearest.x - (origin[0] ?? 0),
      -(nearest.z - (origin[2] ?? 0)),
    );
    const cameraYaw = forge.camera.rotation.y;
    return Math.atan2(Math.sin(worldBearing - cameraYaw), Math.cos(worldBearing - cameraYaw));
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
      dryFires: published.dryFires,
      blockedFires: weapon.blockedFires,
      lastShotOutcome: published.lastShot,
      roundsChambered: Number.isFinite(published.ammo) ? published.ammo : undefined,
    };
  }
}
