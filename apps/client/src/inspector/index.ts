import { Group, type Object3D, type PerspectiveCamera } from "three";
import type { MatchCommand } from "@foldseek/game-sim";
import type { MatchSettings } from "@foldseek/shared";

import { ShootingDriver, type ShotOutcome, type WeaponState } from "./ShootingDriver";
import { CameraSamplePublisher, type CameraSample } from "./cameraSamples";
import { FocusSystem, InspectableSet, type FocusMetadata } from "./FocusSystem";
import { nearestBlockerEntry } from "./geometry";
import { GunView, MISS_RANGE_M, shotImpactPoint } from "./GunView";
import { InspectorBody } from "./InspectorBody";
import { InspectorCamera, type InspectorCameraOptions } from "./InspectorCamera";
import { createMoveInput, InspectorController } from "./InspectorController";
import { InspectorInput } from "./InspectorInput";
import { BRISK_WALK_MULTIPLIER, type NavData, type SpawnPose } from "./navData";

export {
  blocksCapsule,
  containsXZ,
  fitsUnder,
  surfaceAt,
  BRISK_WALK_MULTIPLIER,
  INSPECTOR_EYE_HEIGHT_M,
  INSPECTOR_HEIGHT_M,
  INSPECTOR_RADIUS_M,
  INSPECTOR_STEP_HEIGHT_M,
  WORLD_SCALE,
  type AABB,
  type ClimbKind,
  type ClimbLink,
  type MutableVec3,
  type NavData,
  type SpawnPoints,
  type SpawnPose,
  type Vec3Like,
  type WalkableSurface,
} from "./navData";
export {
  FocusSystem,
  InspectableSet,
  type AccusationPolicy,
  type FocusMetadata,
  type FocusPhase,
  type InspectableProxy,
  type PickProxy,
} from "./FocusSystem";
export {
  InspectorController,
  type ClimbState,
  type InspectorMoveInput,
  type MoveResolution,
} from "./InspectorController";
export { InspectorCamera, type TargetFrame } from "./InspectorCamera";
export { InspectorInput } from "./InspectorInput";
export {
  ShootingDriver,
  type AimTarget,
  type ShotOutcome,
  type WeaponPhase,
  type WeaponState,
} from "./ShootingDriver";
export { GunView, shotImpactPoint, type GunFrame } from "./GunView";
export { InspectorBody, ARM_REACH, GUN_SHOULDER, type InspectorBodyFrame } from "./InspectorBody";
export { CameraSamplePublisher, type CameraSample } from "./cameraSamples";
export {
  SpatialValidatorImpl,
  type SpatialRejectionReason,
  type SpatialValidatorDeps,
} from "./SpatialValidatorImpl";

/**
 * Everything the Inspector needs from the rest of the client. GameHost supplies
 * it once, during the integration pass, and this module reaches for nothing
 * else: no store, no renderer, no adapter.
 */
export interface InspectorSystemDeps {
  readonly scene: Object3D;
  readonly camera: PerspectiveCamera;
  readonly navData: NavData;
  readonly inspectables: InspectableSet;
  readonly sendCommand: (command: MatchCommand) => void;
  readonly onFocusChange: (focus: FocusMetadata | null) => void;
  readonly settings: MatchSettings;
  /**
   * Pointer-lock target. Omitted in tests and in any headless run, where the
   * caller drives `update` with its own sampled input instead.
   */
  readonly domElement?: HTMLElement | null;
  readonly onCameraSample?: (sample: CameraSample) => void;
  /** One call per round fired, for the muzzle flash and the impact effect. */
  readonly onShot?: (outcome: ShotOutcome, targetObjectId: string | null) => void;
  /** Gun state for the HUD: aiming, ammo, reticle target, cooldown phase. */
  readonly onWeaponState?: (state: WeaponState) => void;
  readonly onPointerLockChange?: (locked: boolean) => void;
  readonly cameraOptions?: InspectorCameraOptions;
  /**
   * Whether the Inspector's body drops a shadow, which is the light tier's
   * `dynamicShadows`. Defaults to on: at the "light" tier the renderer has no
   * shadow map to draw into and the flag costs nothing either way.
   */
  readonly castShadow?: boolean;
}

export interface InspectorSystem {
  /** Follows the Inspector, for a body mesh or an accent light to parent to. */
  readonly root: Group;
  readonly controller: InspectorController;
  readonly cameraRig: InspectorCamera;
  readonly focusSystem: FocusSystem;
  readonly weapon: ShootingDriver;
  /** The gun the player can see: model, sway, recoil, and what a round leaves behind. */
  readonly gun: GunView;
  /** The Inspector everyone else sees, with the gun in its right hand. */
  readonly body: InspectorBody;
  /** Null when no DOM element was supplied. */
  readonly input: InspectorInput | null;
  /** False freezes movement and the trigger, for the reveal of §5.14. */
  enabled: boolean;
  update(dtMs: number, nowMs: number): void;
  spawnAt(pose: SpawnPose): void;
  setInspectables(inspectables: InspectableSet): void;
  /**
   * Warrants remaining, which is the gun's magazine. The total is what the drum
   * is built with; left out, the drum takes the fullest magazine it has seen,
   * which is right for anyone who was there when the hunt opened.
   */
  setAmmo(warrantsRemaining: number, warrantsTotal?: number): void;
  /** Outcome of this client's own shot, from `accusation_resolved`. */
  handleAccusationResolved(correct: boolean): void;
  /** A refusal from the adapter's `onRejection`, of any command type. */
  handleRejection(rejection: { readonly type: string; readonly reason: string }): void;
  requestPointerLock(): void;
  dispose(): void;
}

/**
 * Gaze commands report where the Inspector is looking, not every flicker of the
 * reticle across a crowded shelf, so target changes are coalesced to this rate.
 */
export const FOCUS_COMMAND_MIN_INTERVAL_MS = 250;

export function createInspectorSystem(deps: InspectorSystemDeps): InspectorSystem {
  const root = new Group();
  root.name = "inspector-root";
  deps.scene.add(root);

  const controller = new InspectorController(deps.navData, deps.settings);
  const cameraRig = new InspectorCamera(deps.camera, deps.navData, deps.cameraOptions ?? {});
  const focusSystem = new FocusSystem(deps.inspectables, {
    focusDistance: deps.settings.inspectorFocusDistance,
    accusationDistance: deps.settings.accusationDistance,
    blockers: deps.navData.blockers,
    onChange: deps.onFocusChange,
  });
  const weapon = new ShootingDriver({
    settings: deps.settings,
    sendCommand: deps.sendCommand,
    onShot: deps.onShot,
    onStateChange: deps.onWeaponState,
  });
  const gun = new GunView(deps.scene);
  // The body hangs off the root, which is already carried to the controller's
  // feet and turned to its heading every frame; the hand it holds the gun in
  // lives in the scene, because the carry is authored against the eye.
  const body = new InspectorBody(root, deps.scene, deps.castShadow ?? true);
  gun.attachToHand(body.hand);
  const onCameraSample = deps.onCameraSample;
  const samples = new CameraSamplePublisher(
    onCameraSample === undefined ? 0 : deps.settings.cameraSampleHz,
    onCameraSample ?? noopSample,
  );

  const input =
    deps.domElement != null
      ? new InspectorInput(deps.domElement, { onLockChange: deps.onPointerLockChange })
      : null;
  input?.attach();

  const moveInput = createMoveInput();
  let inspectables = deps.inspectables;
  let sentFocusId: string | null = null;
  let lastFocusCommandAtMs = Number.NEGATIVE_INFINITY;
  /** Rounds the gun has already shown. The weapon's own counter is the trigger. */
  let shownShots = 0;
  let warrantsSeen = 0;

  /**
   * Where the round that just left the muzzle stopped. A shot with something
   * under the reticle stops at that object, at the distance the focus system
   * measured; anything else carries on until the map's own geometry takes it.
   */
  function impactPoint(focus: FocusMetadata | null) {
    const focusDistance = focus !== null && focus.visible ? focus.distanceM : null;
    const wall =
      focusDistance !== null
        ? -1
        : nearestBlockerEntry(deps.navData.blockers, cameraRig.eye, cameraRig.forward, 0, MISS_RANGE_M);
    return shotImpactPoint(cameraRig.eye, cameraRig.forward, focusDistance, wall);
  }

  const system: InspectorSystem = {
    root,
    controller,
    cameraRig,
    focusSystem,
    weapon,
    gun,
    body,
    input,
    enabled: true,

    update(dtMs: number, nowMs: number): void {
      const dtSeconds = dtMs / 1000;

      if (this.enabled && input !== null) {
        input.sample(moveInput);
      } else {
        moveInput.forward = 0;
        moveInput.strafe = 0;
        moveInput.lookYawDelta = 0;
        moveInput.lookPitchDelta = 0;
        moveInput.brisk = false;
      }
      const aiming = this.enabled && (input?.aimHeld ?? false);
      const firePressed = (input?.takeFirePressed() ?? false) && this.enabled;

      controller.update(dtSeconds, moveInput);
      root.position.set(controller.position.x, controller.position.y, controller.position.z);
      root.rotation.y = controller.yaw;

      cameraRig.update(dtSeconds, controller, aiming);
      focusSystem.update(dtMs, cameraRig.origin, cameraRig.forward, cameraRig.eye, aiming);

      const focus = focusSystem.current;
      const target = focus === null ? null : inspectables.get(focus.objectId);
      cameraRig.updateTargetFrame(target?.bounds ?? null);

      weapon.update(dtMs, focus, firePressed, aiming);

      // Placed before the shot is shown, so the muzzle a round leaves from is
      // where the gun is this frame rather than where it was last one.
      gun.update(dtMs, {
        eye: cameraRig.eye,
        yaw: controller.yaw,
        pitch: controller.pitch,
        aimAmount: cameraRig.aimAmount,
        swayScale: cameraRig.swayScale,
        speedMps: controller.speed,
      });

      // After the gun and never before it: the arm is solved to reach the hand
      // the carry above has just placed, so a body updated first would spend
      // every frame reaching for where the gun was last one.
      body.update(dtSeconds, {
        speedMps: controller.speed,
        speedCapMps: deps.settings.inspectorMoveSpeed * (moveInput.brisk ? BRISK_WALK_MULTIPLIER : 1),
        airborne: controller.airborne,
        climbing: controller.climbState !== null,
        landingSpeed: controller.justLanded ? controller.landingSpeed : 0,
        pitch: controller.pitch,
        aimAmount: cameraRig.aimAmount,
      });

      // A round is shown from the weapon's own count rather than from the
      // trigger, so a shot the driver refused (cooling, still pending) never
      // flashes, and one it took always does.
      const state = weapon.state;
      if (state.shotsFired > shownShots) {
        shownShots = state.shotsFired;
        body.fire();
        gun.fire(
          state.lastShot ?? "miss",
          state.lastShot === "empty" ? null : impactPoint(focus),
        );
      }

      // Losing the target is reported at once: a stale "still looking at it" is
      // the direction that would misinform the gaze scoring of §6.3, whereas a
      // late "now looking at something else" only delays a gain.
      // Local focus also brackets decorative scenery. The simulation registers
      // only legal accusation targets, so those local-only ids must collapse to
      // null on the wire instead of filling the rejection feed with
      // `focus target_unknown` and delaying the real target that follows.
      const focusId = target?.accusationPolicy === "allowed" ? target.objectId : null;
      const dueAt = focusId === null ? lastFocusCommandAtMs : lastFocusCommandAtMs + FOCUS_COMMAND_MIN_INTERVAL_MS;
      if (focusId !== sentFocusId && nowMs >= dueAt) {
        sentFocusId = focusId;
        lastFocusCommandAtMs = nowMs;
        deps.sendCommand({ type: "focus", targetObjectId: focusId });
      }

      samples.update(
        dtMs,
        nowMs,
        cameraRig.eye.x,
        cameraRig.eye.y,
        cameraRig.eye.z,
        controller.yaw,
        controller.pitch,
      );
    },

    spawnAt(pose: SpawnPose): void {
      controller.teleportTo(pose);
      weapon.cancel();
      samples.reset();
      sentFocusId = null;
      lastFocusCommandAtMs = Number.NEGATIVE_INFINITY;
      shownShots = weapon.state.shotsFired;
    },

    setInspectables(next: InspectableSet): void {
      inspectables = next;
      focusSystem.setInspectables(next);
    },

    setAmmo(warrantsRemaining: number, warrantsTotal?: number): void {
      weapon.setAmmo(warrantsRemaining);
      warrantsSeen = Math.max(warrantsSeen, warrantsTotal ?? warrantsRemaining);
      gun.setWarrants(warrantsRemaining, warrantsSeen);
    },

    handleAccusationResolved(correct: boolean): void {
      weapon.handleResolved(correct);
      gun.resolve(correct);
    },

    handleRejection(rejection: { readonly type: string; readonly reason: string }): void {
      if (rejection.type !== "accuse") return;
      weapon.handleRejection(rejection.reason);
    },

    requestPointerLock(): void {
      input?.requestLock();
    },

    dispose(): void {
      input?.dispose();
      gun.dispose();
      body.dispose();
      root.removeFromParent();
    },
  };

  return system;
}

function noopSample(): void {
  // Never called: with no telemetry consumer the publisher runs at 0 Hz.
}
