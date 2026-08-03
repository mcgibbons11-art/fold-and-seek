import { Quaternion, Vector3 } from "three";

import { STRIDE_FACTOR } from "../gameplay/footsteps";
import { HOP_LANDING_SPEED } from "../inspector/CharacterController";
import { WORLD_SCALE } from "../inspector/navData";
import { updateWorldTransforms, type PoseState } from "../mimic/ikSolver";
import { BONES, DEG_TO_RAD } from "../mimic/rig";
import type { LocomotionSample } from "./BodyLanguage";
import { MixamoMotion, type MimicAction } from "./MixamoMotion";

/**
 * The gait: what the creature's limbs do while it travels.
 *
 * `BodyLanguage` carries the whole body — a lean, a bank, a dip — and that is
 * all it ever did, so a Mimic crossing the shop arrived as a rigid statue on a
 * conveyor. This is the other half: hips and knees that swing, arms that swing
 * against them, a pelvis that rolls, a trunk that counters the hips, a tuck in
 * the air, a compression on landing, and a breath while it stands.
 *
 * Two rules shape every line below.
 *
 * The first is that none of it reaches the wire. The angles here are laid over
 * a *copy* of the authored pose, never over the authored pose itself, so
 * `capturePoseToDisguiseState` and the bounds the authority shoots at read
 * exactly what the player folded. A body mid-stride and a body standing still
 * at the same root publish the same bytes, which is the same isolation the
 * cosmetic root transform already relies on.
 *
 * The second is that the authored pose wins wherever the two disagree. Every
 * composed rotation goes through `clampBoneRotation`, so a leg the player has
 * already folded to the limit of its hip cannot be swung past it: the gait
 * fades out by itself as a body folds up, rather than tearing a disguise apart.
 *
 * The phase is driven by ground covered rather than by the clock, so the visible
 * step and the audible footfall land together at any speed, and so a body that
 * stops mid-step and starts again resumes the step it was taking.
 */

/** Metres of travel per footfall, which is half a gait cycle. */
const FOOTFALL_DISTANCE_M = WORLD_SCALE.playerHeight * STRIDE_FACTOR;

/**
 * How much shorter a creeping step is. A creep is not a slow walk: it is a
 * shorter, more frequent shuffle, which is what keeps it reading as an object
 * inching along rather than as the same walk played back at quarter speed.
 */
const CREEP_STEP_SHORTENING = 1.7;

/** Share of the running gait's amplitude a creep keeps. */
const CREEP_GAIT_SHARE = 0.34;

/**
 * The walking pose, at full running speed. Hips and shoulders are quoted as the
 * peak of their swing, so the total excursion of a leg is twice the hip figure.
 *
 * The hip is the number that decides whether the creature reads as walking at
 * all. Under about twenty degrees the legs shuffle; over forty a stubby
 * mechanical body looks like it is doing the splits at every step.
 */
const HIP_SWING_RAD = 31 * DEG_TO_RAD;
/** Knee carried through the whole cycle, and the extra it folds on recovery. */
const KNEE_BASE_RAD = 7 * DEG_TO_RAD;
const KNEE_LIFT_RAD = 46 * DEG_TO_RAD;
const ANKLE_SWING_RAD = 14 * DEG_TO_RAD;
/** Arms swing against the legs, and less far: they carry no weight. */
const ARM_SWING_RAD = 21 * DEG_TO_RAD;
const ELBOW_BASE_RAD = 13 * DEG_TO_RAD;
const ELBOW_SWING_RAD = 16 * DEG_TO_RAD;
/** Trunk twists against the hips; the head holds its heading against the trunk. */
const TORSO_TWIST_RAD = 8 * DEG_TO_RAD;
const HEAD_COUNTER_SHARE = 0.55;
/** The pelvis drops toward whichever leg is off the ground. */
const PELVIS_ROLL_RAD = 5 * DEG_TO_RAD;

/**
 * How far the hips sink at the splayed point of the stride, as a share of body
 * height. Downward only: a bob that also lifted would take the feet off the
 * boards, and there is no foot planting here to put them back.
 */
const GAIT_SINK_BODY_SHARE = 0.035;

/** The crouch a creep holds in the knees and hips on top of its short stride. */
const CREEP_KNEE_RAD = 20 * DEG_TO_RAD;
const CREEP_HIP_RAD = 11 * DEG_TO_RAD;

/**
 * The tuck the body takes in the air: knees up, elbows in. It is what turns a
 * hop from a body being translated upward into a body that jumped.
 */
const AIR_HIP_RAD = 26 * DEG_TO_RAD;
const AIR_KNEE_RAD = 58 * DEG_TO_RAD;
const AIR_ARM_RAD = 34 * DEG_TO_RAD;
const AIR_ELBOW_RAD = 41 * DEG_TO_RAD;

/**
 * The climb: both arms reaching above the head, the legs folded under. Read
 * alongside `BodyLanguage`'s climb lean, which hugs the body to the surface.
 */
const CLIMB_REACH_RAD = 96 * DEG_TO_RAD;
const CLIMB_KNEE_RAD = 52 * DEG_TO_RAD;
const CLIMB_HIP_RAD = 30 * DEG_TO_RAD;

/**
 * The launch: the beat between the feet leaving the ground and the knees coming
 * up. The legs drive straight and the arms sweep back, and only once the window
 * has passed does the tuck open.
 *
 * It is a window rather than a spring because the order is the whole point. The
 * tuck is worth about sixty degrees of knee and opens in a tenth of a second,
 * so an extension merely added to it is arithmetic nobody ever sees: the knee
 * still folds on the first airborne frame. Holding the tuck shut for the window
 * is what makes a hop read as a body pushing off rather than a body being
 * lifted.
 */
const LAUNCH_SECONDS = 0.12;
const LAUNCH_HIP_RAD = 16 * DEG_TO_RAD;
const LAUNCH_ARM_RAD = 30 * DEG_TO_RAD;

/**
 * The squash as the feet arrive: an impulse on a spring, so the fold carries
 * through its recovery rather than being one frame nobody sees.
 */
const LANDING_SQUASH_RAD = 38 * DEG_TO_RAD;
const SQUASH_SECONDS = 0.13;
/** Ceiling on how much a heavier arrival deepens the squash. */
const SQUASH_MAX_SCALE = 2;
/** Torso pitch that comes with a squash, as a share of the knee's own fold. */
const SQUASH_TORSO_SHARE = 0.28;

/** The breath a standing creature takes, so it never reads as a prop. */
/** How long the gait, the air tuck and the climb take to blend in and out. */
const BLEND_SECONDS = 0.11;

/**
 * A critically damped step response is within a twentieth of its target at this
 * multiple of its time constant, which turns an authored blend time into the
 * spring's frequency. The same conversion `BodyLanguage` uses.
 */
const SETTLE_TO_OMEGA = 4.74;
const BLEND_OMEGA = SETTLE_TO_OMEGA / BLEND_SECONDS;
/** An impulse response peaks at one time constant, which places the squash. */
const SQUASH_OMEGA = 1 / SQUASH_SECONDS;
const SQUASH_IMPULSE_PER_RAD = SQUASH_OMEGA * Math.E;

/** Below this a blend has arrived and is snapped onto its target exactly. */
const BLEND_EPSILON = 1e-4;
/** Below this an angle moves nothing the eye can resolve: a twentieth of a degree. */
const ANGLE_EPSILON_RAD = 0.05 * DEG_TO_RAD;

/**
 * The rig's output for one frame: an angle per driven joint plus the drop at
 * the root. Signs follow the rig's own conventions (`mimic/rig.ts`): a bone's
 * axis points at its tip, so a positive rotation about X carries a downward
 * axis toward -Z, which is behind the creature.
 */
export interface GaitAngles {
  /** Hip swing about X. Negative carries the leg forward. */
  hipL: number;
  hipR: number;
  /** Knee about X. Positive folds the shin back, which is the only way it bends. */
  kneeL: number;
  kneeR: number;
  /** Ankle about X. */
  ankleL: number;
  ankleR: number;
  /** Upper arm about X. Positive carries the arm behind the body. */
  armL: number;
  armR: number;
  /** Elbow about X. Negative folds the forearm forward, which is its hinge range. */
  elbowL: number;
  elbowR: number;
  /** Pelvis roll about Z, toward the leg that is off the ground. */
  pelvisRoll: number;
  /** Trunk twist about Y, against the hips. */
  torsoTwist: number;
  /** Trunk pitch about X: the breath, and the fold of a landing. */
  torsoPitch: number;
  /** Neck twist about Y and pitch about X, holding the head against the trunk. */
  headTwist: number;
  headPitch: number;
  /** How far the hips sink this frame, in metres. Never negative. */
  sinkM: number;
}

function createAngles(): GaitAngles {
  return {
    hipL: 0,
    hipR: 0,
    kneeL: 0,
    kneeR: 0,
    ankleL: 0,
    ankleR: 0,
    armL: 0,
    armR: 0,
    elbowL: 0,
    elbowR: 0,
    pelvisRoll: 0,
    torsoTwist: 0,
    torsoPitch: 0,
    headTwist: 0,
    headPitch: 0,
    sinkM: 0,
  };
}

/** Critically damped spring on one number, implicit so a long frame is safe. */
class Blend {
  value = 0;
  velocity = 0;

  private readonly epsilon: number;

  constructor(epsilon: number) {
    this.epsilon = epsilon;
  }

  step(dtSeconds: number, target: number, omega: number): number {
    const f = 1 + 2 * dtSeconds * omega;
    const oo = omega * omega;
    const hoo = dtSeconds * oo;
    const hhoo = dtSeconds * hoo;
    const detInv = 1 / (f + hhoo);
    const previous = this.value;
    this.value = (f * previous + dtSeconds * this.velocity + hhoo * target) * detInv;
    this.velocity = (this.velocity + hoo * (target - previous)) * detInv;

    if (Math.abs(this.value - target) < this.epsilon && Math.abs(this.velocity) < this.epsilon) {
      this.value = target;
      this.velocity = 0;
    }
    return this.value;
  }

  push(amount: number): void {
    this.velocity += amount;
  }

  reset(): void {
    this.value = 0;
    this.velocity = 0;
  }
}

export class LocomotionRig {
  private readonly live = createAngles();
  private readonly mixamo = new MixamoMotion();

  /**
   * How much of the rig is showing at all. Eased rather than switched, because
   * the handles are laid out on the body as it is drawn: a hard cut to the
   * authored pose would move them out from under a pointer that had just
   * reached one, and the body would flicker between the two as it was swept.
   */
  private readonly active = new Blend(BLEND_EPSILON);
  /** How much of the walking gait is showing, against a body standing still. */
  private readonly gait = new Blend(BLEND_EPSILON);
  private readonly air = new Blend(BLEND_EPSILON);
  private readonly climb = new Blend(BLEND_EPSILON);
  private readonly creep = new Blend(BLEND_EPSILON);
  /** Positive folds the knees under a landing, negative drives them straight. */
  private readonly squash = new Blend(ANGLE_EPSILON_RAD);

  /** Ground covered since the last footfall, which is what places the step. */
  private stridePhase = 0;
  private wasAirborne = false;
  /** Seconds left in the launch window, counted down while the body is rising. */
  private launchLeft = 0;

  /** The overlay pose and the authored pose it was built to shadow. */
  private overlay: PoseState | null = null;
  private overlaySource: PoseState | null = null;

  /** The angles as of the last frame. The object is reused, never reallocated. */
  get angles(): GaitAngles {
    return this.live;
  }

  /**
   * True while every channel is exactly zero, so the body stands precisely as
   * the player posed it. A caller that needs that — a locked disguise, or one
   * being authored — checks this rather than assuming a still body is neutral.
   */
  get neutral(): boolean {
    const a = this.live;
    return (
      a.hipL === 0 &&
      a.hipR === 0 &&
      a.kneeL === 0 &&
      a.kneeR === 0 &&
      a.ankleL === 0 &&
      a.ankleR === 0 &&
      a.armL === 0 &&
      a.armR === 0 &&
      a.elbowL === 0 &&
      a.elbowR === 0 &&
      a.pelvisRoll === 0 &&
      a.torsoTwist === 0 &&
      a.torsoPitch === 0 &&
      a.headTwist === 0 &&
      a.headPitch === 0 &&
      a.sinkM === 0
    );
  }

  reset(): void {
    this.active.reset();
    this.gait.reset();
    this.air.reset();
    this.climb.reset();
    this.creep.reset();
    this.squash.reset();
    this.stridePhase = 0;
    this.wasAirborne = false;
    this.launchLeft = 0;
    this.mixamo.reset();
    Object.assign(this.live, createAngles());
  }

  /** Plays an authenticated Mixamo performance over the current authored form. */
  playAction(action: MimicAction): void {
    this.mixamo.play(action);
  }

  /**
   * Advances one frame. `speedMetresPerSecond` is the ground the body actually
   * covered, which is what the stride is measured against; `sample.speedFraction`
   * is a share of whatever cap is in force and decides how big the step is.
   *
   * `suppressed` hands the body back to the pose exactly as authored, over the
   * blend time rather than in one frame. Two callers want it: a locked disguise,
   * which must be as still as the vase beside it, and a body under the pointer,
   * which has to be where the player is reaching for it.
   */
  update(
    dtSeconds: number,
    sample: LocomotionSample,
    speedMetresPerSecond: number,
    suppressed = false,
  ): GaitAngles {
    if (dtSeconds <= 0) return this.live;

    const active = this.active.step(dtSeconds, suppressed ? 0 : 1, BLEND_OMEGA);
    const speed = clamp01(sample.speedFraction);
    const airTarget = sample.airborne ? 1 : 0;
    const climbing = this.climb.step(dtSeconds, sample.climbing ? 1 : 0, BLEND_OMEGA);
    const airborne = this.air.step(dtSeconds, airTarget, BLEND_OMEGA);
    const creeping = this.creep.step(dtSeconds, sample.creeping ? 1 : 0, BLEND_OMEGA);
    // On the ground, under way, and not hauling itself up something: only then
    // is there a step to take. The blend is what keeps the legs from snapping
    // out of a tuck the instant the feet touch.
    const walking = this.gait.step(
      dtSeconds,
      speed * (1 - airTarget) * (1 - (sample.climbing ? 1 : 0)),
      BLEND_OMEGA,
    );

    // The frame the feet leave the ground opens the launch window; touching
    // down closes it, so a body that fell off a shelf and one that jumped do
    // not both push off on the way down.
    const justTookOff = sample.airborne && !this.wasAirborne;
    if (justTookOff) this.launchLeft = LAUNCH_SECONDS;
    if (!sample.airborne) this.launchLeft = 0;
    this.wasAirborne = sample.airborne;
    this.launchLeft = Math.max(0, this.launchLeft - dtSeconds);
    // The window itself, undamped: the push-off is a pop, and a pop that eased
    // in over a tenth of a second is a body being lifted again. The tuck takes
    // whatever the window is not using, so the two hand over without a seam.
    const launch = this.launchLeft / LAUNCH_SECONDS;
    const tuck = airborne * (1 - launch);

    if (sample.landingSpeed > 0) this.squash.push(this.landingImpulse(sample.landingSpeed));
    const squash = this.squash.step(dtSeconds, 0, SQUASH_OMEGA);

    // Distance, not time: the step lands where the footfall sounds. A creep
    // covers the same ground in more, shorter steps.
    const stepLength = FOOTFALL_DISTANCE_M / (1 + creeping * (CREEP_STEP_SHORTENING - 1));
    this.stridePhase += (Math.abs(speedMetresPerSecond) * dtSeconds * Math.PI) / stepLength;
    this.stridePhase %= Math.PI * 2;

    const phase = this.stridePhase;
    const swing = Math.sin(phase);
    // The knee folds through the half cycle in which the leg is off the ground
    // and travelling forward, and lies flat through the half it carries weight.
    // Peak fold is a quarter cycle after the leg is furthest back, which is the
    // moment it passes under the body.
    const liftL = Math.max(0, -Math.cos(phase));
    const liftR = Math.max(0, Math.cos(phase));

    const gaitScale = walking * (1 - creeping * (1 - CREEP_GAIT_SHARE));
    const grounded = 1 - airborne;
    const a = this.live;

    a.hipL = -HIP_SWING_RAD * swing * gaitScale;
    a.hipR = HIP_SWING_RAD * swing * gaitScale;
    a.kneeL = (KNEE_BASE_RAD + KNEE_LIFT_RAD * liftL) * gaitScale;
    a.kneeR = (KNEE_BASE_RAD + KNEE_LIFT_RAD * liftR) * gaitScale;
    a.ankleL = ANKLE_SWING_RAD * (liftL - 0.5) * 2 * gaitScale;
    a.ankleR = ANKLE_SWING_RAD * (liftR - 0.5) * 2 * gaitScale;
    a.armL = ARM_SWING_RAD * swing * gaitScale;
    a.armR = -ARM_SWING_RAD * swing * gaitScale;
    a.elbowL = -(ELBOW_BASE_RAD + ELBOW_SWING_RAD * Math.max(0, swing)) * gaitScale;
    a.elbowR = -(ELBOW_BASE_RAD + ELBOW_SWING_RAD * Math.max(0, -swing)) * gaitScale;
    a.pelvisRoll = PELVIS_ROLL_RAD * swing * gaitScale;
    a.torsoTwist = TORSO_TWIST_RAD * swing * gaitScale;
    // Legs together at the top of the sine, splayed at its quarters: the hips
    // are lowest when the stride is widest.
    a.sinkM =
      WORLD_SCALE.playerHeight * GAIT_SINK_BODY_SHARE * (0.5 - 0.5 * Math.cos(2 * phase)) * gaitScale;

    // The crouch a creep holds on top of its shortened stride, and the fold the
    // body takes as it lands. Both are carried whether or not it is stepping.
    const crouch = creeping * grounded;
    a.kneeL += CREEP_KNEE_RAD * crouch + squash;
    a.kneeR += CREEP_KNEE_RAD * crouch + squash;
    a.hipL -= CREEP_HIP_RAD * crouch;
    a.hipR -= CREEP_HIP_RAD * crouch;
    a.torsoPitch = squash * SQUASH_TORSO_SHARE;

    // The launch and then the tuck, both overriding the gait rather than adding
    // to it: a body driving off its toes is not also mid-step, and neither is
    // one with its knees under its chin.
    if (launch > 0) {
      a.hipL = mix(a.hipL, LAUNCH_HIP_RAD, launch);
      a.hipR = mix(a.hipR, LAUNCH_HIP_RAD, launch);
      a.kneeL = mix(a.kneeL, 0, launch);
      a.kneeR = mix(a.kneeR, 0, launch);
      a.ankleL = mix(a.ankleL, ANKLE_SWING_RAD, launch);
      a.ankleR = mix(a.ankleR, ANKLE_SWING_RAD, launch);
      a.armL = mix(a.armL, LAUNCH_ARM_RAD, launch);
      a.armR = mix(a.armR, LAUNCH_ARM_RAD, launch);
      a.sinkM = mix(a.sinkM, 0, launch);
    }
    if (tuck > 0) {
      a.hipL = mix(a.hipL, -AIR_HIP_RAD, tuck);
      a.hipR = mix(a.hipR, -AIR_HIP_RAD, tuck);
      a.kneeL = mix(a.kneeL, AIR_KNEE_RAD, tuck);
      a.kneeR = mix(a.kneeR, AIR_KNEE_RAD, tuck);
      a.ankleL = mix(a.ankleL, 0, tuck);
      a.ankleR = mix(a.ankleR, 0, tuck);
      a.armL = mix(a.armL, -AIR_ARM_RAD, tuck);
      a.armR = mix(a.armR, -AIR_ARM_RAD, tuck);
      a.elbowL = mix(a.elbowL, -AIR_ELBOW_RAD, tuck);
      a.elbowR = mix(a.elbowR, -AIR_ELBOW_RAD, tuck);
      a.sinkM = mix(a.sinkM, 0, tuck);
    }
    if (climbing > 0) {
      // The arms alternate on the climb, which is what reads as hand over hand.
      a.armL = mix(a.armL, -CLIMB_REACH_RAD * (0.75 + 0.25 * swing), climbing);
      a.armR = mix(a.armR, -CLIMB_REACH_RAD * (0.75 - 0.25 * swing), climbing);
      a.elbowL = mix(a.elbowL, -AIR_ELBOW_RAD * 0.6, climbing);
      a.elbowR = mix(a.elbowR, -AIR_ELBOW_RAD * 0.6, climbing);
      a.hipL = mix(a.hipL, -CLIMB_HIP_RAD * (1 - 0.35 * swing), climbing);
      a.hipR = mix(a.hipR, -CLIMB_HIP_RAD * (1 + 0.35 * swing), climbing);
      a.kneeL = mix(a.kneeL, CLIMB_KNEE_RAD, climbing);
      a.kneeR = mix(a.kneeR, CLIMB_KNEE_RAD, climbing);
      a.sinkM = mix(a.sinkM, 0, climbing);
    }

    // The head holds its heading and its horizon against the trunk under it.
    a.headTwist = -a.torsoTwist * HEAD_COUNTER_SHARE;
    a.headPitch = -a.torsoPitch * HEAD_COUNTER_SHARE;

    this.mixamo.update(dtSeconds, {
      active,
      run: gaitScale,
      airborne,
      climbing,
      stridePhase: this.stridePhase,
      justTookOff,
    });

    if (active !== 1) scaleAngles(a, active);
    return a;
  }

  /**
   * The pose to draw: the authored one wearing this frame's gait. Returns the
   * authored pose itself while the rig is neutral, so a locked disguise and a
   * body being posed are drawn from exactly the state the player authored.
   *
   * The overlay shares the authored pose's derived arrays — segment forms, bone
   * offsets and lengths — because a form edit has to reach the drawn body and
   * none of it is written here. Only rotations and the root are its own.
   */
  pose(authored: PoseState): PoseState {
    if (this.neutral) return authored;

    const overlay = this.overlayFor(authored);
    for (let i = 0; i < BONES.length; i++) {
      overlay.localRotations[i]!.copy(authored.localRotations[i]!);
    }
    overlay.rootRotation.copy(authored.rootRotation);
    overlay.rootPosition.copy(authored.rootPosition);
    overlay.rootPosition.y -= this.live.sinkM;

    this.mixamo.apply(overlay);

    updateWorldTransforms(overlay);
    return overlay;
  }

  /**
   * Kick that folds the knees by the authored angle for an ordinary hop and
   * proportionally more for a heavier arrival, up to the ceiling.
   * `HOP_LANDING_SPEED` is the arc's own touchdown speed, so the reference
   * weight and the jump it is measured against cannot drift apart.
   */
  private landingImpulse(landingSpeed: number): number {
    const weight = clamp(landingSpeed / HOP_LANDING_SPEED, 0, SQUASH_MAX_SCALE);
    return LANDING_SQUASH_RAD * weight * SQUASH_IMPULSE_PER_RAD;
  }

  private overlayFor(authored: PoseState): PoseState {
    const existing = this.overlay;
    if (existing !== null && this.overlaySource === authored) return existing;
    const overlay: PoseState = {
      rootPosition: new Vector3(),
      rootRotation: new Quaternion(),
      localRotations: BONES.map(() => new Quaternion()),
      // Shared, never written: a form edit reaches the drawn body through these
      // without the overlay having to be told about it.
      segments: authored.segments,
      resolvedSegments: authored.resolvedSegments,
      effectiveOffsets: authored.effectiveOffsets,
      effectiveLengths: authored.effectiveLengths,
      worldPositions: BONES.map(() => new Vector3()),
      worldRotations: BONES.map(() => new Quaternion()),
    };
    this.overlay = overlay;
    this.overlaySource = authored;
    return overlay;
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function mix(from: number, to: number, weight: number): number {
  return from + (to - from) * weight;
}

/**
 * Fades the whole rig by one factor. At zero every channel is exactly zero, so
 * `neutral` reports the pose is the authored one rather than nearly it.
 */
function scaleAngles(angles: GaitAngles, factor: number): void {
  angles.hipL *= factor;
  angles.hipR *= factor;
  angles.kneeL *= factor;
  angles.kneeR *= factor;
  angles.ankleL *= factor;
  angles.ankleR *= factor;
  angles.armL *= factor;
  angles.armR *= factor;
  angles.elbowL *= factor;
  angles.elbowR *= factor;
  angles.pelvisRoll *= factor;
  angles.torsoTwist *= factor;
  angles.torsoPitch *= factor;
  angles.headTwist *= factor;
  angles.headPitch *= factor;
  angles.sinkM *= factor;
}
