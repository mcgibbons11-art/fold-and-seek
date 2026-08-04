import * as THREE from "three/webgpu";

import { LocomotionRig, INSPECTOR_GAIT_PROFILE } from "../forge/LocomotionRig";
import type { LocomotionSample } from "../forge/BodyLanguage";
import { InspectorAvatar } from "./InspectorAvatar";
import { WORLD_SCALE } from "./navData";

/**
 * The Inspector, as everybody else in the shop sees them: a trench coat, boots
 * and a hat, walking about with a warrant gun in the right hand.
 *
 * Until now the Inspector root was an empty group. The player saw a gun and a
 * pair of hands' worth of nothing behind it, and a Mimic watching the hunt come
 * down the aisle saw a revolver drifting through the air at knee height. A
 * hider's whole read of the danger is the silhouette arriving, so the body is a
 * gameplay object rather than decoration.
 *
 * Three rules shape what is below.
 *
 * It is built from primitives in code, like `GunView` and the Mimic, because
 * nothing may be fetched at runtime inside the Portals sandbox. Every dimension
 * is a share of `WORLD_SCALE.playerHeight`, so the giant-scale knob (override 4)
 * still moves the whole character with one number.
 *
 * The gait is not written here. `LocomotionRig` already decides what a walking
 * creature's joints do, and its `update` is a function of speed and footing
 * alone — the Mimic rig only enters at `pose`, which this never calls. So the
 * Inspector and the Mimic walk off exactly the same stride, blend and landing
 * squash, and a change to how one of them walks changes both.
 *
 * The materials deliberately match `GunView`'s: `MeshStandardMaterial`, no
 * texture slots, no vertex colours, opaque, and not receiving shadows. That is
 * the same generated shader source the gun already links, so the whole
 * character joins one existing program family and adds nothing to the census
 * (`tests/world/programCensus.test.ts`). Each part keeps the gun's small warm
 * emissive floor for the same reason the gun does: an Inspector who vanished in
 * an unlit corner would be a hider's problem, not a hider's advantage.
 */

/** The one scale knob. Every length below is a share of it. */
const H = WORLD_SCALE.playerHeight;
const AUTHORED_INSPECTOR_ENABLED = true;

/**
 * Joint heights, as shares of standing height, measured from the floor. They
 * are ordinary human proportions rather than invented ones: the hand hanging at
 * `SHOULDER_Y - ARM_REACH` falls at mid-thigh, which is where an arm ends.
 */
const HIP_Y = 0.47;
const KNEE_Y = 0.3;
const ANKLE_Y = 0.13;
const SHOULDER_Y = 0.74;
const NECK_Y = 0.8;
const HEAD_Y = 0.875;
/**
 * The brim cuts across the head rather than sitting on top of it, so the hat is
 * worn instead of balanced: everything above it is felt and what is left below
 * is a face. Perched clear of the skull the Inspector read as a bald head with
 * a hat hovering over it.
 */
const BRIM_Y = 0.925;

const THIGH_LENGTH = HIP_Y - KNEE_Y;
const SHIN_LENGTH = KNEE_Y - ANKLE_Y;

/** Half the gap between the legs, and between the shoulders. */
const LEG_HALF_SPAN = 0.075;
const SHOULDER_HALF_SPAN = 0.16;

/**
 * Upper arm and forearm. Their sum is the reach every carry point in
 * `GunView` is tuned against: a hand cannot be held further from the shoulder
 * than this, and an arm stretched to its last degree reads as a mannequin, so
 * the carry sits at about four fifths of it.
 */
const UPPER_ARM_LENGTH = 0.19;
const FOREARM_LENGTH = 0.17;
export const ARM_REACH = UPPER_ARM_LENGTH + FOREARM_LENGTH;

/** Where the right arm hangs from, in body-local metres. The gun's anchor. */
export const GUN_SHOULDER = {
  x: SHOULDER_HALF_SPAN * H,
  y: SHOULDER_Y * H,
  z: 0,
} as const;

/** Limb and coat thicknesses. */
const THIGH_RADIUS = 0.062;
const SHIN_RADIUS = 0.05;
const ARM_RADIUS = 0.052;
const BOOT_WIDTH = 0.11;
const BOOT_HEIGHT = 0.09;
const BOOT_LENGTH = 0.19;
/** How far the boot reaches ahead of the ankle, so the foot has a toe. */
const BOOT_TOE_OFFSET = 0.035;

/**
 * The coat: a torso that tapers into the waist and a skirt that flares out of
 * it. The hem stops above the knee rather than at the calf a real trench coat
 * would reach, because at this scale the stride is the only thing that says the
 * Inspector is walking and a full-length coat hides it entirely.
 */
const COAT_CHEST_RADIUS = 0.2;
const COAT_WAIST_RADIUS = 0.175;
const COAT_HEM_RADIUS = 0.225;
const COAT_HEM_Y = 0.33;
const COLLAR_RADIUS = 0.13;
const COLLAR_HEIGHT = 0.07;

const HEAD_RADIUS = 0.095;
const BRIM_RADIUS = 0.13;
const BRIM_THICKNESS = 0.018;
/** Wider than the head, so the skull is inside the hat rather than through it. */
const CROWN_RADIUS = 0.1;
const CROWN_HEIGHT = 0.062;

/**
 * How much of the look pitch the head carries. All of it would put the hat
 * through the collar at the pitch limit, and none of it leaves the Inspector
 * staring at the horizon while shooting the floor.
 */
const HEAD_PITCH_SHARE = 0.55;

// Idle vocabulary tuning (2026-08-04). Radians are small on purpose: these
// read as life at a glance and vanish the moment the body moves or aims.
const IDLE_BREATH_RATE = 1.7;
const IDLE_BREATH_RAD = 0.012;
const IDLE_FIDGET_PERIOD_S = 7.5;
const IDLE_WATCH_DIP_RAD = 0.22;
const IDLE_WATCH_TWIST_RAD = 0.12;
const IDLE_SHIFT_RATE = 0.35;
const IDLE_WEIGHT_SHIFT_RAD = 0.03;

/** 0 outside the fidget window, easing to 1 through a short dip late in the period. */
function fidgetWindow(phase: number): number {
  const start = 0.72;
  const end = 0.92;
  if (phase < start || phase > end) return 0;
  const t = (phase - start) / (end - start);
  return Math.sin(t * Math.PI);
}

/** Lean into the aim, which is the shoulders coming round behind the gun. */
const AIM_TORSO_PITCH_RAD = 0.1;
const AIM_TORSO_TWIST_RAD = 0.16;

/**
 * The coat's own motion: it trails behind a walk and rolls with the hips. It is
 * cosmetic and small, and it deliberately lags nothing — a spring on a hem is a
 * frame of animation nobody at this scale can resolve.
 */
const COAT_TRAIL_RAD = 0.16;
// 1.6 was the sauce (2026-08-04, user verdict): the coat amplified every
// degree of pelvis roll into a strut. With the roll itself now halved by the
// Inspector's gait profile, the hem follows the hips one-to-one.
const COAT_ROLL_SHARE = 1.0;

/**
 * The shop's palette (§17.3), which the gun already borrows from: midnight blue
 * wool, dark leather, felt, and one warm face under the brim so the head reads
 * as a head rather than as a knob on the coat.
 */
const COAT_COLOR = 0x2f3742;
const LEATHER_COLOR = 0x241a14;
const FELT_COLOR = 0x2b2521;
/**
 * A face under a brim, not a lamp. Bright enough to read as skin against the
 * coat at the distance a hider first sees the Inspector, dark enough that it is
 * the hat and the coat that carry the silhouette.
 */
const FACE_COLOR = 0x9c8062;

/** The same warm floor `GunView` keeps, for the same reason. */
const SELF_LIT_COLOR = 0x2a1a0a;
const SELF_LIT_INTENSITY = 0.55;

/** Rest direction of every limb: bones hang down their own -Y. */
const LIMB_AXIS = new THREE.Vector3(0, 1, 0);
/** Which way the elbow points, in body-local terms: backwards. */
const ELBOW_POLE = new THREE.Vector3(0, 0, 1);

/** What the body needs to know about the frame it is being drawn in. */
export interface InspectorBodyFrame {
  /** Ground speed actually achieved, which is what the stride is measured on. */
  readonly speedMps: number;
  /** Speed cap in force, so the gait knows what share of a full run this is. */
  readonly speedCapMps: number;
  readonly airborne: boolean;
  readonly climbing: boolean;
  /** Downward speed at touchdown, on the one frame the body landed. */
  readonly landingSpeed: number;
  /** Look pitch, which the head carries a share of. */
  readonly pitch: number;
  /** `InspectorCamera.aimAmount`: 0 carried at the hip, 1 up on the sights. */
  readonly aimAmount: number;
}

export class InspectorBody {
  /** Everything that moves with the body, under the caller's Inspector root. */
  private readonly root = new THREE.Group();

  /**
   * Where the gun is held. It lives in world space rather than under the body,
   * because the carry is authored against the eye and the look direction
   * (`GunView`), and the arm is solved to reach whatever it says. Parenting the
   * gun to it is what makes "the Inspector is holding the gun" structural: the
   * two cannot drift apart, whatever either of them is doing.
   */
  readonly hand = new THREE.Group();

  private readonly bob = new THREE.Group();
  private readonly pelvis = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly skirt = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly hipL = new THREE.Group();
  private readonly hipR = new THREE.Group();
  private readonly kneeL = new THREE.Group();
  private readonly kneeR = new THREE.Group();
  private readonly ankleL = new THREE.Group();
  private readonly ankleR = new THREE.Group();
  private readonly shoulderL = new THREE.Group();
  private readonly elbowL = new THREE.Group();
  /** The gun arm, placed from the solved joints rather than swung from angles. */
  private readonly upperArmR: THREE.Mesh;
  private readonly forearmR: THREE.Mesh;

  private readonly gait = new LocomotionRig(INSPECTOR_GAIT_PROFILE);
  private readonly meshList: THREE.Mesh[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly avatar: InspectorAvatar | null;
  /** Resolves true when the authored GLB has replaced the fallback body. */
  readonly authoredReady: Promise<boolean>;

  private readonly sample = {
    speedFraction: 0,
    travelYaw: 0,
    airborne: false,
    climbing: false,
    creeping: false,
    landingSpeed: 0,
  };

  private readonly handLocal = new THREE.Vector3();
  private readonly shoulderPoint = new THREE.Vector3(GUN_SHOULDER.x, 0, 0);
  private readonly chord = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  private readonly elbowPoint = new THREE.Vector3();
  private readonly wristPoint = new THREE.Vector3();
  private readonly segment = new THREE.Vector3();

  constructor(
    parent: THREE.Object3D,
    world: THREE.Object3D,
    castShadow = true,
    onWeaponSocket?: (socket: THREE.Object3D) => void,
  ) {
    this.root.name = "inspector-body";
    this.hand.name = "inspector-hand";
    this.shoulderPoint.y = GUN_SHOULDER.y - HIP_Y * H;

    const coat = this.own(this.standard("inspector-coat", COAT_COLOR, 0.78, 0));
    const leather = this.own(this.standard("inspector-leather", LEATHER_COLOR, 0.48, 0.05));
    const felt = this.own(this.standard("inspector-felt", FELT_COLOR, 0.86, 0));
    const face = this.own(this.standard("inspector-face", FACE_COLOR, 0.7, 0));

    this.buildSkeleton();
    this.buildLegs(coat, leather);
    this.buildCoat(coat, leather);
    this.buildHead(felt, face);
    const arms = this.buildArms(coat, leather);
    this.upperArmR = arms.upper;
    this.forearmR = arms.fore;

    this.setCastShadow(castShadow);
    parent.add(this.root);
    world.add(this.hand);

    // Unit tests deliberately exercise the deterministic primitive fallback.
    // Shipping builds replace it once the authored Blender/Mixamo rig arrives;
    // a failed fetch leaves a complete playable character instead of nothing.
    // The authored rig is preferred in shipping builds. A failed fetch still
    // leaves the complete procedural character available beneath it.
    this.avatar =
      !AUTHORED_INSPECTOR_ENABLED || import.meta.env.MODE === "test"
        ? null
        : new InspectorAvatar(this.root, this.hand, (loaded, socket) => {
            // Do not flash the historical primitive character while the GLB is
            // in flight. It is a recovery presentation, shown only when the
            // authored asset has conclusively failed to load.
            this.bob.visible = !loaded;
            if (socket !== null) onWeaponSocket?.(socket);
          });
    if (this.avatar !== null) this.bob.visible = false;
    this.authoredReady = this.avatar?.load() ?? Promise.resolve(false);
  }

  /** Every drawable in the body, for a test that counts what it costs to draw. */
  get meshes(): readonly THREE.Mesh[] {
    return this.meshList;
  }

  /**
   * Advances the walk and reaches the gun arm to wherever the carry put the
   * hand. `GunView.update` runs first in the frame, so the hand is already
   * where this frame's aim blend and recoil left it.
   */
  /** Seconds the body has been at rest, driving the idle vocabulary. */
  private idleSeconds = 0;

  update(dtSeconds: number, frame: InspectorBodyFrame): void {
    const sample = this.sample;
    sample.speedFraction =
      frame.speedCapMps > 0 ? Math.min(1, frame.speedMps / frame.speedCapMps) : 0;
    sample.airborne = frame.airborne;
    sample.climbing = frame.climbing;
    sample.landingSpeed = frame.landingSpeed;

    const angles = this.gait.update(dtSeconds, sample as LocomotionSample, frame.speedMps);

    this.bob.position.y = -angles.sinkM;
    this.pelvis.rotation.z = angles.pelvisRoll;
    this.hipL.rotation.x = angles.hipL;
    this.hipR.rotation.x = angles.hipR;
    this.kneeL.rotation.x = angles.kneeL;
    this.kneeR.rotation.x = angles.kneeR;
    this.ankleL.rotation.x = angles.ankleL;
    this.ankleR.rotation.x = angles.ankleR;

    // The gait's pitch signs are written for the Mimic's bones, which hang
    // downward from their joints; this trunk stands up out of the pelvis, so
    // the same angle leans the opposite way and is negated. A landing then
    // folds the Inspector forward over the knees rather than backwards off
    // them.
    //
    // Both aim terms bring the shoulder round behind the gun: the trunk squares
    // up and leans into it, which is what a shooter does and, less obviously,
    // what keeps the grip inside the arm's reach at the top of the pitch range.
    const aim = Math.min(1, Math.max(0, frame.aimAmount));
    this.torso.rotation.x = -angles.torsoPitch - AIM_TORSO_PITCH_RAD * aim;
    this.torso.rotation.y = angles.torsoTwist + AIM_TORSO_TWIST_RAD * aim;

    // The left arm is the only one the gait still owns: the right one is
    // holding a gun, and an arm holding a gun does not swing.
    this.shoulderL.rotation.x = angles.armL;
    this.elbowL.rotation.x = angles.elbowL;

    // Positive tips the face up, which is the way the look pitch reads too.
    this.neck.rotation.y = angles.headTwist;
    this.neck.rotation.x = -angles.headPitch + frame.pitch * HEAD_PITCH_SHARE;

    // Idle vocabulary (2026-08-04): a curator standing still is not a statue.
    // A slow breath rides the torso; every few seconds the head dips toward
    // the gun hand - a man checking his pocket watch - and the weight shifts.
    // All of it fades in only when the body is genuinely at rest, and aiming
    // suppresses it: a raised gun holds still.
    const atRest = Math.max(0, 1 - sample.speedFraction * 4) * (1 - aim);
    if (atRest > 0 && !frame.airborne && !frame.climbing) {
      this.idleSeconds += dtSeconds;
      const breath = Math.sin(this.idleSeconds * IDLE_BREATH_RATE) * IDLE_BREATH_RAD;
      this.torso.rotation.x += breath * atRest;
      const fidgetPhase = (this.idleSeconds % IDLE_FIDGET_PERIOD_S) / IDLE_FIDGET_PERIOD_S;
      // A short dip window late in each period: ramp in, hold, ramp out.
      const dip = fidgetWindow(fidgetPhase);
      this.neck.rotation.x += -IDLE_WATCH_DIP_RAD * dip * atRest;
      this.neck.rotation.y += IDLE_WATCH_TWIST_RAD * dip * atRest;
      this.pelvis.rotation.z += IDLE_WEIGHT_SHIFT_RAD * Math.sin(this.idleSeconds * IDLE_SHIFT_RATE) * atRest;
    } else {
      this.idleSeconds = 0;
    }

    // A coat trails the walk and rolls with the hips. Both are read off the
    // gait rather than timed separately, so the hem cannot drift out of phase
    // with the legs under it.
    this.skirt.rotation.x = COAT_TRAIL_RAD * sample.speedFraction;
    this.skirt.rotation.z = angles.pelvisRoll * COAT_ROLL_SHARE;

    this.reachForGun();
    this.avatar?.update(dtSeconds, frame);
  }

  /** Plays the authored trigger performance alongside the warrant-gun recoil. */
  fire(): void {
    this.avatar?.fire();
  }

  /** Plays a non-terminal full-body warrant impact reaction. */
  hit(): void {
    this.avatar?.hit();
  }

  /** Plays and retains the authored terminal pose. */
  death(): void {
    this.avatar?.death();
  }

  /**
   * Two-bone solve from the shoulder to the gun, worked in points rather than
   * in angles.
   *
   * Placing the elbow explicitly is what removes the usual ambiguity: an aim
   * quaternion built from a direction alone leaves the roll about that
   * direction undecided, and the elbow is free to end up in front of the chest
   * or out sideways from one frame to the next. Here the elbow is put on the
   * chord's backward side by construction, which is where an elbow goes.
   *
   * A target beyond the arm's reach is clamped, which straightens the arm and
   * lets the hand fall short. `GunView`'s carry is authored inside `ARM_REACH`
   * so it never happens; the clamp is there because an unreachable target
   * would otherwise put a NaN through the law of cosines and delete the arm.
   */
  private reachForGun(): void {
    this.torso.updateWorldMatrix(true, false);
    this.handLocal.copy(this.hand.getWorldPosition(this.segment));
    this.torso.worldToLocal(this.handLocal);

    this.chord.copy(this.handLocal).sub(this.shoulderPoint);
    const reach = ARM_REACH * H;
    const span = Math.min(
      Math.max(this.chord.length(), Math.abs(UPPER_ARM_LENGTH - FOREARM_LENGTH) * H + 1e-6),
      reach - 1e-6,
    );
    if (span <= 0) return;
    this.chord.normalize();

    // The backward direction, with whatever of it lies along the arm removed:
    // the elbow's offset from the chord, perpendicular by construction.
    this.bend.copy(ELBOW_POLE).addScaledVector(this.chord, -ELBOW_POLE.dot(this.chord));
    if (this.bend.lengthSq() < 1e-8) this.bend.set(0, 0, 1);
    this.bend.normalize();

    const upper = UPPER_ARM_LENGTH * H;
    const fore = FOREARM_LENGTH * H;
    const cosShoulder = (upper * upper + span * span - fore * fore) / (2 * upper * span);
    const shoulderAngle = Math.acos(Math.min(1, Math.max(-1, cosShoulder)));

    this.elbowPoint
      .copy(this.shoulderPoint)
      .addScaledVector(this.chord, upper * Math.cos(shoulderAngle))
      .addScaledVector(this.bend, upper * Math.sin(shoulderAngle));
    // The wrist sits at the clamped span rather than at the hand itself, so an
    // unreachable target leaves the arm whole and short of the gun instead of
    // tearing the forearm off the elbow to keep up with it.
    this.wristPoint.copy(this.shoulderPoint).addScaledVector(this.chord, span);

    this.placeLimb(this.upperArmR, this.shoulderPoint, this.elbowPoint);
    this.placeLimb(this.forearmR, this.elbowPoint, this.wristPoint);
  }

  /** Puts a limb mesh between two points of the torso's frame. */
  private placeLimb(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    this.segment.copy(to).sub(from);
    const length = this.segment.length();
    if (length < 1e-6) return;
    mesh.quaternion.setFromUnitVectors(LIMB_AXIS, this.segment.divideScalar(length));
  }

  /** Casting is the light tier's call; receiving never is, see the header. */
  setCastShadow(enabled: boolean): void {
    for (const mesh of this.meshList) mesh.castShadow = enabled;
    this.avatar?.setCastShadow(enabled);
  }

  /**
   * Hides both halves of the presentation. The articulated body hangs from the
   * caller's root, but the gun hand deliberately lives in world space; changing
   * only one would leave a disembodied warrant gun when a remote Inspector is
   * outside a phase in which their telemetry may be shown.
   */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
    this.hand.visible = visible;
  }

  dispose(): void {
    this.avatar?.dispose();
    this.root.removeFromParent();
    this.hand.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.meshList.length = 0;
  }

  // ------------------------------------------------------------------ build

  private buildSkeleton(): void {
    this.root.add(this.bob);
    this.bob.add(this.pelvis);
    this.pelvis.position.y = HIP_Y * H;
    this.pelvis.add(this.torso);
    this.torso.add(this.skirt);
    this.torso.add(this.neck);
    this.neck.position.y = (NECK_Y - HIP_Y) * H;

    this.hipL.position.set(-LEG_HALF_SPAN * H, 0, 0);
    this.hipR.position.set(LEG_HALF_SPAN * H, 0, 0);
    this.pelvis.add(this.hipL, this.hipR);
    this.kneeL.position.y = -THIGH_LENGTH * H;
    this.kneeR.position.y = -THIGH_LENGTH * H;
    this.hipL.add(this.kneeL);
    this.hipR.add(this.kneeR);
    this.ankleL.position.y = -SHIN_LENGTH * H;
    this.ankleR.position.y = -SHIN_LENGTH * H;
    this.kneeL.add(this.ankleL);
    this.kneeR.add(this.ankleR);

    this.shoulderL.position.set(-SHOULDER_HALF_SPAN * H, (SHOULDER_Y - HIP_Y) * H, 0);
    this.torso.add(this.shoulderL);
    this.elbowL.position.y = -UPPER_ARM_LENGTH * H;
    this.shoulderL.add(this.elbowL);
  }

  private buildLegs(coat: THREE.Material, leather: THREE.Material): void {
    for (const [side, knee, ankle] of [
      ["L", this.kneeL, this.ankleL],
      ["R", this.kneeR, this.ankleR],
    ] as const) {
      const parent = knee.parent;
      if (parent === null) continue;

      const thigh = this.mesh(
        new THREE.CylinderGeometry(THIGH_RADIUS * H, SHIN_RADIUS * 1.1 * H, THIGH_LENGTH * H, 8),
        coat,
        `thigh-${side}`,
      );
      thigh.position.y = (-THIGH_LENGTH * H) / 2;
      parent.add(thigh);

      const shin = this.mesh(
        new THREE.CylinderGeometry(SHIN_RADIUS * H, SHIN_RADIUS * 0.85 * H, SHIN_LENGTH * H, 8),
        coat,
        `shin-${side}`,
      );
      shin.position.y = (-SHIN_LENGTH * H) / 2;
      knee.add(shin);

      const boot = this.mesh(
        new THREE.BoxGeometry(BOOT_WIDTH * H, BOOT_HEIGHT * H, BOOT_LENGTH * H),
        leather,
        `boot-${side}`,
      );
      boot.position.set(0, (-BOOT_HEIGHT * H) / 2, -BOOT_TOE_OFFSET * H);
      ankle.add(boot);
    }
  }

  private buildCoat(coat: THREE.Material, leather: THREE.Material): void {
    const bodyHeight = (SHOULDER_Y - HIP_Y) * H;
    const body = this.mesh(
      new THREE.CylinderGeometry(COAT_CHEST_RADIUS * H, COAT_WAIST_RADIUS * H, bodyHeight, 10),
      coat,
      "coat",
    );
    body.position.y = bodyHeight / 2;
    this.torso.add(body);

    const skirtHeight = (HIP_Y - COAT_HEM_Y) * H;
    const hem = this.mesh(
      new THREE.CylinderGeometry(COAT_WAIST_RADIUS * H, COAT_HEM_RADIUS * H, skirtHeight, 10, 1, true),
      coat,
      "coat-skirt",
    );
    hem.position.y = -skirtHeight / 2;
    this.skirt.add(hem);

    // An upturned collar, which is most of what says "inspector" from behind.
    const collar = this.mesh(
      new THREE.CylinderGeometry(COLLAR_RADIUS * H, COLLAR_RADIUS * 0.72 * H, COLLAR_HEIGHT * H, 10, 1, true),
      leather,
      "collar",
    );
    collar.position.y = (NECK_Y - HIP_Y) * H - (COLLAR_HEIGHT * H) / 2;
    this.torso.add(collar);
  }

  private buildHead(felt: THREE.Material, face: THREE.Material): void {
    const head = this.mesh(new THREE.SphereGeometry(HEAD_RADIUS * H, 10, 8), face, "head");
    head.position.y = (HEAD_Y - NECK_Y) * H;
    this.neck.add(head);

    const brim = this.mesh(
      new THREE.CylinderGeometry(BRIM_RADIUS * H, BRIM_RADIUS * H, BRIM_THICKNESS * H, 12),
      felt,
      "hat-brim",
    );
    brim.position.y = (BRIM_Y - NECK_Y) * H;
    this.neck.add(brim);

    const crown = this.mesh(
      new THREE.CylinderGeometry(CROWN_RADIUS * 0.9 * H, CROWN_RADIUS * H, CROWN_HEIGHT * H, 10),
      felt,
      "hat-crown",
    );
    crown.position.y = (BRIM_Y - NECK_Y) * H + (CROWN_HEIGHT * H) / 2;
    this.neck.add(crown);
  }

  private buildArms(
    coat: THREE.Material,
    leather: THREE.Material,
  ): { upper: THREE.Mesh; fore: THREE.Mesh } {
    const sleeve = this.mesh(
      new THREE.CylinderGeometry(ARM_RADIUS * H, ARM_RADIUS * 0.9 * H, UPPER_ARM_LENGTH * H, 8),
      coat,
      "upperarm-L",
    );
    sleeve.position.y = (-UPPER_ARM_LENGTH * H) / 2;
    this.shoulderL.add(sleeve);

    const cuff = this.mesh(
      new THREE.CylinderGeometry(ARM_RADIUS * 0.9 * H, ARM_RADIUS * 0.8 * H, FOREARM_LENGTH * H, 8),
      leather,
      "forearm-L",
    );
    cuff.position.y = (-FOREARM_LENGTH * H) / 2;
    this.elbowL.add(cuff);

    // The gun arm's two bones are placed from solved points every frame, so
    // they hang off the torso rather than off each other.
    const upper = this.mesh(
      new THREE.CylinderGeometry(ARM_RADIUS * H, ARM_RADIUS * 0.9 * H, UPPER_ARM_LENGTH * H, 8),
      coat,
      "upperarm-R",
    );
    const fore = this.mesh(
      new THREE.CylinderGeometry(ARM_RADIUS * 0.9 * H, ARM_RADIUS * 0.8 * H, FOREARM_LENGTH * H, 8),
      leather,
      "forearm-R",
    );
    this.torso.add(upper, fore);
    return { upper, fore };
  }

  private standard(
    name: string,
    color: number,
    roughness: number,
    metalness: number,
  ): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      name,
      color,
      roughness,
      metalness,
      emissive: SELF_LIT_COLOR,
      emissiveIntensity: SELF_LIT_INTENSITY,
    });
  }

  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.Mesh {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `inspector-${name}`;
    this.meshList.push(mesh);
    return mesh;
  }

  private own<T extends THREE.Material>(material: T): T {
    this.materials.push(material);
    return material;
  }
}
