import { HOP_LANDING_SPEED } from "../inspector/CharacterController";
import { WORLD_SCALE } from "../inspector/navData";

/**
 * How the Mimic's body carries itself while it moves: a lean into the run, a
 * bank into a turn, a gait sway, a crouch while it creeps, and the compression
 * of a landing.
 *
 * None of this is the disguise. It is a transform laid over the authored pose at
 * the body root, and the pose that goes on the wire is read from the authored
 * state rather than from here, so a running body and a standing one at the same
 * root publish byte-for-byte the same disguise. That separation is the whole
 * reason this module produces numbers rather than touching the rig: a cosmetic
 * that leaked into `capturePoseToDisguiseState` would spend a Mimic's command
 * budget on a wobble nobody asked to see.
 *
 * Everything here is deterministic. The sway is a sine of accumulated frame
 * time, and there is no randomness anywhere, so two clients running the same
 * frames produce the same posture.
 */

const DEG = Math.PI / 180;

/**
 * Lean into travel at full speed, and the two other gaits' share of it. A few
 * degrees is the whole budget: this is a body leaning into a run, and at ten the
 * creature stops reading as walking and starts reading as falling forward. A
 * creep barely leans at all, because a disguise shifting position is trying not
 * to look like it is going anywhere.
 */
const RUN_LEAN_RAD = 7 * DEG;
const CREEP_LEAN_RAD = 2 * DEG;

/**
 * Lean into the surface during a climb. Larger than the run, because a body
 * pulling itself up a shelf edge is hugging the thing it is climbing, and that
 * reach is the only part of a mantle the player can see from behind.
 */
const CLIMB_LEAN_RAD = 13 * DEG;

/**
 * Bank into a turn, and the rate of heading change that earns all of it. Three
 * radians a second is a body swinging round in about a second, which is as fast
 * as the walk keys can turn it; anything sharper is the camera being spun, and
 * the bank saturates rather than snapping over.
 */
const TURN_BANK_RAD = 5 * DEG;
const TURN_RATE_FOR_FULL_BANK = 3;

/**
 * Side-to-side sway, standing and at full speed, with the rate each is swayed
 * at. Standing, it is a slow breath that keeps the creature from reading as a
 * prop; running, it is the gait. Both are the same oscillator with the amplitude
 * and the rate blended by speed, so there is no seam where one hands over to the
 * other.
 */
const RUN_SWAY_RAD = 2.6 * DEG;
const RUN_SWAY_RATE = 7.5;

/** Creeping slows the gait as well as shortening it: the hunt is not a walk. */
const CREEP_GAIT_SCALE = 0.55;

/**
 * How far the body sinks while it creeps, as a share of its standing height.
 * Six percent is 2 cm on a 35 cm creature: enough to read as a crouch from the
 * Inspector's eye, small enough that it never lifts a disguise off the surface
 * it was sealed to or pushes it through one.
 */
const CREEP_CROUCH_BODY_SHARE = 0.06;

/**
 * Landing compression: how deep the knees go on an ordinary hop, and how long
 * the dip takes to reach its lowest point. The spring recovers over roughly
 * twice that again, so the whole gesture is about a third of a second.
 */
const LANDING_DIP_BODY_SHARE = 0.08;
const LANDING_DIP_SECONDS = 0.12;

/**
 * Ceiling on how much a heavier landing deepens the dip. A body that came off
 * the top of the shelving is arriving at several times a hop's speed, and
 * without a limit the compression would put its head through the boards.
 */
const LANDING_DIP_MAX_SCALE = 2;

/** How long the lean, the bank and the crouch take to reach a new posture. */
const POSTURE_SETTLE_SECONDS = 0.13;

/**
 * A critically damped step response is within a twentieth of its target at this
 * multiple of its time constant, which is what turns an authored settle time
 * into the spring's frequency.
 */
const SETTLE_TO_OMEGA = 4.74;

/**
 * Below this the spring has arrived and is snapped onto its target exactly.
 * Without it a posture only ever approaches rest, and "the body is back at the
 * height the player authored" would be a claim no test could make. The angle
 * threshold is a twentieth of a degree and the length one a tenth of a
 * millimetre at this scale: both far under anything the eye resolves.
 */
const SETTLE_EPSILON_RAD = 0.05 * DEG;
const SETTLE_EPSILON_M = WORLD_SCALE.playerHeight * 3e-4;

/** What the body is doing this frame, as the locomotion already resolved it. */
export interface LocomotionSample {
  /** Ground speed as a share of whatever cap is currently in force, 0 to 1. */
  readonly speedFraction: number;
  /** Heading the body is travelling on, radians, three's yaw convention. */
  readonly travelYaw: number;
  readonly airborne: boolean;
  readonly climbing: boolean;
  /** True while the hunt's creep cap is in force. */
  readonly creeping: boolean;
  /** Downward speed at touchdown, on the one frame the body landed. */
  readonly landingSpeed: number;
}

/** The transform to lay over the authored pose, about the body's own root. */
export interface BodyPosture {
  /** Tip into the direction of travel, positive forward. */
  readonly leanRad: number;
  /** Roll about the direction of travel: the turn bank and the gait sway. */
  readonly bankRad: number;
  /** How far the root is lowered. Never moves the root the wire carries. */
  readonly dipM: number;
}

/**
 * Critically damped spring on one number. Implicit, so a long frame cannot make
 * it explode, and snapped onto its target once it has effectively arrived.
 */
class Spring {
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

  /** Kicks the spring, which is how a landing becomes a dip and a recovery. */
  push(amount: number): void {
    this.velocity += amount;
  }

  reset(): void {
    this.value = 0;
    this.velocity = 0;
  }
}

const POSTURE_OMEGA = SETTLE_TO_OMEGA / POSTURE_SETTLE_SECONDS;
/** Peak of an impulse response falls at one time constant, so this places it. */
const DIP_OMEGA = 1 / LANDING_DIP_SECONDS;
/** Kick that puts the peak of that response at the authored depth. */
const DIP_IMPULSE_PER_METRE = DIP_OMEGA * Math.E;

export class BodyLanguage {
  private readonly lean = new Spring(SETTLE_EPSILON_RAD);
  private readonly bank = new Spring(SETTLE_EPSILON_RAD);
  private readonly dip = new Spring(SETTLE_EPSILON_M);
  /** How much of the gait survives: nothing while the feet are off the ground. */
  private readonly footing = new Spring(1e-4);

  private swayPhase = 0;
  private lastTravelYaw = 0;
  private started = false;

  private readonly live = { leanRad: 0, bankRad: 0, dipM: 0 };

  /** The posture as of the last frame. The object is reused, never reallocated. */
  get posture(): BodyPosture {
    return this.live;
  }

  /**
   * True while the lean and the dip sit exactly on their resting values, which
   * is the state in which the body stands at the height and attitude the player
   * authored. The sway is excluded on purpose: it is a rotation about the root
   * and so moves no part of the authored root, and it never stops, because a
   * creature that stops breathing reads as a prop.
   */
  get atRest(): boolean {
    return this.lean.value === 0 && this.dip.value === 0;
  }

  /**
   * True while the posture is exactly nothing, so the transform built from it is
   * the identity. Distinct from `atRest` because of the sway: a resting body is
   * still breathing, and a caller that needs the creature to stand precisely as
   * posed — a locked disguise, or one being authored — needs the breath gone too
   * rather than frozen wherever the last frame left it.
   */
  get neutral(): boolean {
    return this.live.leanRad === 0 && this.live.bankRad === 0 && this.live.dipM === 0;
  }

  reset(): void {
    this.lean.reset();
    this.bank.reset();
    this.dip.reset();
    this.footing.reset();
    this.swayPhase = 0;
    this.started = false;
    this.live.leanRad = 0;
    this.live.bankRad = 0;
    this.live.dipM = 0;
  }

  update(dtSeconds: number, sample: LocomotionSample): BodyPosture {
    if (dtSeconds <= 0) return this.live;

    const speed = clamp01(sample.speedFraction);
    // The first frame has no previous heading to differ from, so a body that
    // spawned facing anywhere but north would bank hard on its first step.
    const turnRate = this.started
      ? shortestAngle(sample.travelYaw - this.lastTravelYaw) / dtSeconds
      : 0;
    this.lastTravelYaw = sample.travelYaw;
    this.started = true;

    const gait = this.footing.step(dtSeconds, sample.airborne ? 0 : 1, POSTURE_OMEGA);

    let leanTarget: number;
    if (sample.climbing) {
      leanTarget = CLIMB_LEAN_RAD;
    } else if (sample.creeping) {
      leanTarget = CREEP_LEAN_RAD * speed;
    } else {
      leanTarget = RUN_LEAN_RAD * speed;
    }
    const lean = this.lean.step(dtSeconds, leanTarget, POSTURE_OMEGA);

    const bankTarget =
      TURN_BANK_RAD * clamp(turnRate / TURN_RATE_FOR_FULL_BANK, -1, 1) * gait;
    const bank = this.bank.step(dtSeconds, bankTarget, POSTURE_OMEGA);

    const gaitScale = sample.creeping ? CREEP_GAIT_SCALE : 1;
    // Automatic idle motion gives the Inspector a free tell. Only movement
    // drives the sway, so a stationary disguise stays visually motionless.
    this.swayPhase += dtSeconds * gaitScale * RUN_SWAY_RATE * speed;
    const swayAmplitude = RUN_SWAY_RAD * speed * gait;
    const sway = Math.sin(this.swayPhase) * swayAmplitude * gaitScale;

    if (sample.landingSpeed > 0) this.dip.push(this.landingImpulse(sample.landingSpeed));
    const crouch = sample.creeping ? WORLD_SCALE.playerHeight * CREEP_CROUCH_BODY_SHARE : 0;
    const dip = this.dip.step(dtSeconds, crouch, DIP_OMEGA);

    this.live.leanRad = lean;
    this.live.bankRad = bank + sway;
    this.live.dipM = dip;
    return this.live;
  }

  /**
   * Kick that compresses the body by its authored share of body height for an
   * ordinary hop, and proportionally more for a drop that arrived faster, up to
   * the ceiling. `HOP_LANDING_SPEED` is the arc's own touchdown speed, so the
   * reference weight and the jump it is measured against cannot drift apart.
   */
  private landingImpulse(landingSpeed: number): number {
    const weight = clamp(landingSpeed / HOP_LANDING_SPEED, 0, LANDING_DIP_MAX_SCALE);
    return WORLD_SCALE.playerHeight * LANDING_DIP_BODY_SHARE * weight * DIP_IMPULSE_PER_METRE;
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Heading difference taken the short way round, so ±π does not read as a spin. */
function shortestAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = radians % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  return wrapped;
}
