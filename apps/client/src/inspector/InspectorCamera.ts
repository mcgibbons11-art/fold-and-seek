import { Matrix4, Vector3, type PerspectiveCamera } from "three";

import { HOP_LANDING_SPEED } from "./CharacterController";
import { nearestBlockerEntry } from "./geometry";
import type { InspectorController } from "./InspectorController";
import {
  INSPECTOR_EYE_HEIGHT_M,
  WORLD_SCALE,
  type AABB,
  type MutableVec3,
  type NavData,
} from "./navData";

/**
 * Over-the-shoulder Inspector rig (§8.1). The camera sits behind and slightly
 * right of the eye, pulls in when the boom would pass through map geometry, and
 * on aim tightens its field of view while the walk sway settles, which is the
 * "stabilize camera sway" of §5.10 in its aim-down-sights form.
 *
 * Aiming changes the presentation and nothing else. It does not extend the
 * gun's reach, it does not change what can be picked or hit, and it behaves
 * identically whatever the target turns out to be (§8.5).
 */

export interface InspectorCameraOptions {
  readonly baseFovDeg?: number;
  readonly aimFovDeg?: number;
  readonly boomLengthM?: number;
  readonly shoulderOffsetM?: number;
  /** Fraction of the remaining aim blend closed per second. */
  readonly aimResponsePerSecond?: number;
  readonly motionScale?: number;
  readonly shakeScale?: number;
}

/** Screen-space bracket for the reticle, in normalized device coordinates. */
export interface TargetFrame {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** False when nothing was projected, so the HUD draws no brackets. */
  visible: boolean;
}

export const DEFAULT_BASE_FOV_DEG = 62;
export const DEFAULT_AIM_FOV_DEG = 48;

/**
 * Rig distances are a fixed share of body height, so the framing that reads
 * correctly for a human-scale character survives the shrink to a tiny one. At
 * `WORLD_SCALE.playerHeight` of 0.35 m the boom is 84 cm, which keeps the shop
 * towering overhead instead of filling the frame.
 */
const BOOM_PER_BODY_HEIGHT = 2.4;
const SHOULDER_PER_BODY_HEIGHT = 0.3;
const MIN_BOOM_PER_BODY_HEIGHT = 0.26;
const SKIN_PER_BODY_HEIGHT = 0.069;
const BOB_PER_BODY_HEIGHT = 0.0126;

export const DEFAULT_BOOM_LENGTH_M = WORLD_SCALE.playerHeight * BOOM_PER_BODY_HEIGHT;
/** Both third-person rigs may pull back far enough to frame the surrounding aisle. */
export const MAX_BOOM_LENGTH_M = WORLD_SCALE.playerHeight * 9;
export const DEFAULT_SHOULDER_OFFSET_M = WORLD_SCALE.playerHeight * SHOULDER_PER_BODY_HEIGHT;
export const DEFAULT_AIM_RESPONSE = 8;

/** The boom never collapses past this, so the head never fills the screen. */
export const MIN_BOOM_LENGTH_M = WORLD_SCALE.playerHeight * MIN_BOOM_PER_BODY_HEIGHT;

/** Gap kept between the camera and the surface it pulled in against. */
export const CAMERA_SKIN_M = WORLD_SCALE.playerHeight * SKIN_PER_BODY_HEIGHT;

/**
 * Walk bob, small enough to read as breathing rather than head-shake. Exported
 * because the Forge's orbit rig bobs too, and a body that breathes at one rate
 * from behind and another from the eye is two creatures.
 */
export const BOB_AMPLITUDE_M = WORLD_SCALE.playerHeight * BOB_PER_BODY_HEIGHT;
export const BOB_RATE_RAD_PER_M = 4.2;

/**
 * How far the rig sinks on landing, as a share of body height, and how long it
 * takes to get there. The camera echoes the body's own compression rather than
 * inventing a second one: same gesture, seen from behind.
 */
const LANDING_DIP_BODY_SHARE = 0.05;
const LANDING_DIP_SECONDS = 0.12;
const LANDING_DIP_OMEGA = 1 / LANDING_DIP_SECONDS;
const LANDING_DIP_MAX_SCALE = 2;
/** Kick that puts the peak of the impulse response at the authored depth. */
const LANDING_DIP_IMPULSE =
  WORLD_SCALE.playerHeight * LANDING_DIP_BODY_SHARE * LANDING_DIP_OMEGA * Math.E;
/** Under a tenth of a millimetre at this scale, so the dip ends rather than fades. */
const DIP_SETTLE_M = WORLD_SCALE.playerHeight * 3e-4;

/** Aiming damps sway to this fraction of its free-walk amount. */
const AIMED_SWAY_SCALE = 0.15;
const ZOOM_PER_WHEEL_DELTA = 0.0016;

/** Corners nearer than this to the eye plane are treated as behind the camera. */
const MIN_VIEW_DEPTH_M = 0.05;

export class InspectorCamera {
  /** Inspector eye position, the origin of every gameplay distance. */
  readonly eye: MutableVec3 = { x: 0, y: 0, z: 0 };
  /** Normalized camera forward, and therefore the pick ray direction. */
  readonly forward: MutableVec3 = { x: 0, y: 0, z: -1 };
  /** Camera world position, and therefore the pick ray origin. */
  readonly origin: MutableVec3 = { x: 0, y: 0, z: 0 };

  readonly targetFrame: TargetFrame = { minX: 0, minY: 0, maxX: 0, maxY: 0, visible: false };

  private readonly camera: PerspectiveCamera;
  private readonly navData: NavData;
  private baseFovDeg: number;
  private aimFovDeg: number;
  private boomLengthM: number;
  private readonly shoulderOffsetM: number;
  private readonly aimResponse: number;
  private motionScale: number;
  private shakeScale: number;

  private readonly viewMatrix = new Matrix4();
  private readonly corner = new Vector3();
  private readonly pivot: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly boomDirection: MutableVec3 = { x: 0, y: 0, z: 0 };

  private aimAmountValue = 0;
  private bobPhase = 0;
  /** Live landing compression and its rate of change, a critically damped pair. */
  private dipM = 0;
  private dipVelocity = 0;

  constructor(camera: PerspectiveCamera, navData: NavData, options: InspectorCameraOptions = {}) {
    this.camera = camera;
    this.navData = navData;
    this.baseFovDeg = options.baseFovDeg ?? DEFAULT_BASE_FOV_DEG;
    this.aimFovDeg = options.aimFovDeg ?? DEFAULT_AIM_FOV_DEG;
    this.boomLengthM = options.boomLengthM ?? DEFAULT_BOOM_LENGTH_M;
    this.shoulderOffsetM = options.shoulderOffsetM ?? DEFAULT_SHOULDER_OFFSET_M;
    this.aimResponse = options.aimResponsePerSecond ?? DEFAULT_AIM_RESPONSE;
    this.motionScale = options.motionScale ?? 1;
    this.shakeScale = options.shakeScale ?? 1;
    this.camera.rotation.order = "YXZ";
  }

  setViewPreferences(fov: number, motionScale: number, shakeScale: number): void {
    this.baseFovDeg = fov;
    this.aimFovDeg = Math.max(40, fov - 14);
    this.motionScale = Math.min(1, Math.max(0, motionScale));
    this.shakeScale = Math.min(1, Math.max(0, shakeScale));
  }

  /** Mouse-wheel dolly, using the same multiplicative feel as the Mimic orbit. */
  adjustZoom(wheelDeltaY: number): void {
    if (!Number.isFinite(wheelDeltaY) || wheelDeltaY === 0) return;
    this.boomLengthM = Math.min(
      MAX_BOOM_LENGTH_M,
      Math.max(MIN_BOOM_LENGTH_M, this.boomLengthM * (1 + wheelDeltaY * ZOOM_PER_WHEEL_DELTA)),
    );
  }

  /** Blend between hip fire (0) and fully aimed down the sights (1). */
  get aimAmount(): number {
    return this.aimAmountValue;
  }

  /** How much of the walk sway survives the current aim blend. */
  get swayScale(): number {
    return 1 - (1 - AIMED_SWAY_SCALE) * this.aimAmountValue;
  }

  update(dtSeconds: number, controller: InspectorController, aiming: boolean): void {
    const target = aiming ? 1 : 0;
    const blend = 1 - Math.exp(-this.aimResponse * Math.max(dtSeconds, 0));
    this.aimAmountValue += (target - this.aimAmountValue) * blend;

    const sinYaw = Math.sin(controller.yaw);
    const cosYaw = Math.cos(controller.yaw);
    const cosPitch = Math.cos(controller.pitch);
    this.forward.x = -sinYaw * cosPitch;
    this.forward.y = Math.sin(controller.pitch);
    this.forward.z = -cosYaw * cosPitch;

    this.eye.x = controller.position.x;
    this.eye.y = controller.position.y + INSPECTOR_EYE_HEIGHT_M;
    this.eye.z = controller.position.z;

    this.bobPhase += controller.speed * dtSeconds * BOB_RATE_RAD_PER_M;
    const bob = Math.sin(this.bobPhase) * BOB_AMPLITUDE_M * this.swayScale * this.motionScale;
    const dip = this.stepLandingDip(dtSeconds, controller) * this.shakeScale;

    // Right of the Inspector, level with the floor, so the shoulder offset does
    // not tilt with pitch.
    const rightX = cosYaw;
    const rightZ = -sinYaw;
    this.pivot.x = this.eye.x + rightX * this.shoulderOffsetM;
    this.pivot.y = this.eye.y + bob - dip;
    this.pivot.z = this.eye.z + rightZ * this.shoulderOffsetM;

    this.boomDirection.x = -this.forward.x;
    this.boomDirection.y = -this.forward.y;
    this.boomDirection.z = -this.forward.z;

    let boom = this.boomLengthM;
    const hit = nearestBlockerEntry(
      this.navData.blockers,
      this.pivot,
      this.boomDirection,
      0,
      this.boomLengthM,
    );
    if (hit >= 0) boom = Math.max(MIN_BOOM_LENGTH_M, hit - CAMERA_SKIN_M);

    this.origin.x = this.pivot.x + this.boomDirection.x * boom;
    this.origin.y = this.pivot.y + this.boomDirection.y * boom;
    this.origin.z = this.pivot.z + this.boomDirection.z * boom;

    this.camera.position.set(this.origin.x, this.origin.y, this.origin.z);
    this.camera.rotation.set(controller.pitch, controller.yaw, 0);

    const fov = this.baseFovDeg + (this.aimFovDeg - this.baseFovDeg) * this.aimAmountValue;
    if (Math.abs(this.camera.fov - fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
    this.viewMatrix.copy(this.camera.matrixWorld).invert();
  }

  /**
   * The rig's share of a landing. The controller reports the touchdown and how
   * hard it was; the impulse it kicks into this spring dips the boom and lets it
   * recover, which is the same gesture the body makes and the reason a drop off
   * the counter lands with more than a change of height to show for it.
   *
   * The eye itself is untouched: every gameplay distance is measured from it, so
   * a dip that moved it would change what the Inspector can reach for a fifth of
   * a second, and camera feel may never do that (§8.5).
   */
  private stepLandingDip(dtSeconds: number, controller: InspectorController): number {
    if (controller.justLanded) {
      const weight = Math.min(controller.landingSpeed / HOP_LANDING_SPEED, LANDING_DIP_MAX_SCALE);
      this.dipVelocity += LANDING_DIP_IMPULSE * weight;
    }
    if (dtSeconds <= 0) return this.dipM;

    const omega = LANDING_DIP_OMEGA;
    const f = 1 + 2 * dtSeconds * omega;
    const hoo = dtSeconds * omega * omega;
    const detInv = 1 / (f + dtSeconds * hoo);
    const previous = this.dipM;
    this.dipM = (f * previous + dtSeconds * this.dipVelocity) * detInv;
    this.dipVelocity = (this.dipVelocity - hoo * previous) * detInv;
    if (Math.abs(this.dipM) < DIP_SETTLE_M && Math.abs(this.dipVelocity) < DIP_SETTLE_M) {
      this.dipM = 0;
      this.dipVelocity = 0;
    }
    return this.dipM;
  }

  /**
   * Projects a target's bounds into the reticle bracket the HUD draws (§8.2).
   * The frame is derived from the authored bounds alone, so its tightness can
   * never hint at what the target is.
   */
  updateTargetFrame(bounds: AABB | null): TargetFrame {
    const frame = this.targetFrame;
    if (bounds === null) {
      frame.visible = false;
      return frame;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let projected = 0;

    for (let i = 0; i < 8; i += 1) {
      this.corner.set(
        (i & 1) === 0 ? bounds.min.x : bounds.max.x,
        (i & 2) === 0 ? bounds.min.y : bounds.max.y,
        (i & 4) === 0 ? bounds.min.z : bounds.max.z,
      );
      this.corner.applyMatrix4(this.viewMatrix);
      if (this.corner.z > -MIN_VIEW_DEPTH_M) continue;
      this.corner.applyMatrix4(this.camera.projectionMatrix);
      projected += 1;
      if (this.corner.x < minX) minX = this.corner.x;
      if (this.corner.x > maxX) maxX = this.corner.x;
      if (this.corner.y < minY) minY = this.corner.y;
      if (this.corner.y > maxY) maxY = this.corner.y;
    }

    if (projected === 0) {
      frame.visible = false;
      return frame;
    }
    frame.minX = minX;
    frame.minY = minY;
    frame.maxX = maxX;
    frame.maxY = maxY;
    frame.visible = true;
    return frame;
  }
}
