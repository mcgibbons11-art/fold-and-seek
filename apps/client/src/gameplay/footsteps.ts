import type { AudioPlayer, SoundId } from "../forge/AudioPlayer";
import type { AudioPoint } from "../audio/SpatialAudioPlayer";
import { WORLD_SCALE } from "../inspector/navData";

/**
 * What a body sounds like as it moves: footfalls on whatever it is standing on,
 * the hop, the landing, and the grab of a climb.
 *
 * Both roles walk the same `CharacterController` over the same nav data, so
 * both are driven from here. Nothing in this module reads a keyboard or moves
 * anything; it watches motion that has already happened and decides what the
 * player hears, which is what lets the cadence be checked headlessly.
 *
 * Scale: every distance is quoted against `WORLD_SCALE.playerHeight`, so a
 * creature a third of a metre tall takes a stride of about twenty centimetres
 * and its cadence stays its own rather than a human's.
 */

/** The four things the shop can be walked on. */
export type FootstepMaterial = "wood" | "rug" | "metal" | "glass";

/** Three variations per surface, so a run does not machine-gun one sample. */
const FOOTSTEP_VARIATIONS: Readonly<Record<FootstepMaterial, readonly SoundId[]>> = {
  wood: ["footstep_wood", "footstep_wood_2", "footstep_wood_3"],
  rug: ["footstep_rug", "footstep_rug_2", "footstep_rug_3"],
  metal: ["footstep_metal", "footstep_metal_2", "footstep_metal_3"],
  glass: ["footstep_glass", "footstep_glass_2", "footstep_glass_3"],
};

export interface RemoteFootstepEvent {
  readonly kind: "footstep";
  readonly position: AudioPoint;
  readonly material: FootstepMaterial;
  readonly text: string;
}

export interface RemoteFootstepSample {
  readonly position: AudioPoint;
  readonly speedMps: number;
  readonly surfaceId: string | null;
  readonly visible?: boolean;
}

export interface SpatialFootstepSink {
  playAt(
    id: SoundId,
    position: AudioPoint,
    options?: { readonly gain?: number; readonly pitch?: number; readonly minimumGain?: number },
  ): unknown;
}

/**
 * Audible presentation for another Inspector. It consumes the interpolated
 * render position rather than sparse network deltas, so its cadence and source
 * move with the body the player actually sees. Local movement must continue to
 * use `FootstepDriver`; constructing this only for remote seats prevents doubles.
 */
export class RemoteInspectorFootsteps {
  private sinceStepM = 0;
  private nextVariation: Record<FootstepMaterial, number> = { wood: 0, rug: 0, metal: 0, glass: 0 };

  constructor(
    private readonly audio: SpatialFootstepSink,
    private readonly onEvent?: (event: RemoteFootstepEvent) => void,
  ) {}

  update(dtMs: number, sample: RemoteFootstepSample): void {
    const speed = Number.isFinite(sample.speedMps) ? Math.max(0, sample.speedMps) : 0;
    if (sample.visible === false || speed < MIN_SPEED_FACTOR * WORLD_SCALE.playerHeight) {
      // Drop partial travel on a stop: a remote body never emits a delayed step
      // after standing still, and therefore settles within one stride.
      this.sinceStepM = 0;
      return;
    }
    const dtSeconds = Math.min(Math.max(dtMs, 0), 100) / 1_000;
    this.sinceStepM += speed * dtSeconds;
    const strideM = STRIDE_FACTOR * WORLD_SCALE.playerHeight;
    if (this.sinceStepM < strideM) return;
    this.sinceStepM %= strideM;

    const material = footstepMaterial(sample.surfaceId);
    const variations = FOOTSTEP_VARIATIONS[material];
    const index = this.nextVariation[material];
    this.nextVariation[material] = (index + 1) % variations.length;
    const clip = variations[index];
    if (clip === undefined) return;
    this.audio.playAt(clip, sample.position, {
      gain: 0.72,
      pitch: 1 + (((index % 3) - 1) * FOOTSTEP_PITCH_JITTER) / 2,
      minimumGain: 0.035,
    });
    this.onEvent?.({
      kind: "footstep",
      position: { ...sample.position },
      material,
      text: `${material} footsteps`,
    });
  }

  reset(): void {
    this.sinceStepM = 0;
  }
}

/**
 * Surfaces that are not the bare boards. The map publishes walkable ledges by
 * id and says what prop each one is, but it carries no material field, so the
 * handful that are not wood are named here and everything else falls through to
 * wood. Adding a ledge therefore gives it a plausible sound rather than silence.
 *
 * `floor_02` is the reading nook's floor box, and the nook is the one carpeted
 * zone (its landmark is the armchair on the midnight rug). Treating the whole
 * box as rug is an approximation: the rug is a prop and does not cover every
 * corner of the zone, but a footfall in the nook reading as carpet is closer
 * than every footfall in the nook reading as bare board.
 */
const SURFACE_MATERIAL: Readonly<Record<string, FootstepMaterial>> = {
  floor_02: "rug",
  nook_armchair_seat: "rug",
  nook_footstool: "rug",
  // The counter is a marble slab and the back cabinet is glazed. Neither is
  // wood, and the glass tick is the nearer of the four to a hard stone tap.
  counter_top: "glass",
  back_cabinet_top: "glass",
};

/** Families named by prefix, for surfaces generated in a run. */
const PREFIX_MATERIAL: readonly (readonly [string, FootstepMaterial])[] = [
  // The workshop rack is steel; its four boards are `shelving_board_1..4`.
  ["shelving_board_", "metal"],
];

export function footstepMaterial(surfaceId: string | null): FootstepMaterial {
  if (surfaceId === null) return "wood";
  const exact = SURFACE_MATERIAL[surfaceId];
  if (exact !== undefined) return exact;
  for (const [prefix, material] of PREFIX_MATERIAL) {
    if (surfaceId.startsWith(prefix)) return material;
  }
  return "wood";
}

/**
 * One footfall per this share of body height travelled. Exported because the
 * gait is measured against it too (`forge/LocomotionRig.ts`): the visible step
 * and the audible one have to land together, and they cannot if each carries
 * its own number.
 */
export const STRIDE_FACTOR = 0.62;
/** Below this share of body height per second, nobody is walking. */
const MIN_SPEED_FACTOR = 0.3;
const FOOTSTEP_PITCH_JITTER = 0.12;

/** Airborne longer than this and the landing has weight behind it. */
const HARD_LANDING_MS = 380;
/** A hop is a departure that gained height; anything else is walking off a ledge. */
const RISING_EPSILON_M = 1e-4;
/** How often a ladder gives up another hand-grab while it is being ridden. */
const LADDER_GRAB_INTERVAL_MS = 520;
/** How often a creeping body scrapes, which is its footstep during the hunt. */
const CREEP_SLIDE_INTERVAL_MS = 900;

const CLIMB_GRABS: readonly SoundId[] = ["climb_grab", "climb_grab_2"];

/**
 * The motion this driver listens to. `CharacterController` satisfies it as it
 * stands, so the Inspector's controller and the Mimic's locomotion are both
 * passed in directly rather than adapted.
 */
export interface MotionSample {
  /** Horizontal speed actually achieved last frame, metres per second. */
  readonly speed: number;
  readonly grounded: boolean;
  readonly position: { readonly y: number };
  readonly surfaceId: string | null;
  readonly climbState: { readonly link: { readonly kind: string } } | null;
}

/** Anything that can make a noise. Narrow enough for a test to stand in for. */
export type FootstepSink = Pick<AudioPlayer, "play">;

export class FootstepDriver {
  private readonly audio: FootstepSink;

  /** Metres travelled since the last footfall. */
  private sinceStepM = 0;
  private wasGrounded = true;
  private lastY = 0;
  private airborneMs = 0;
  private wasClimbing = false;
  private climbPeakY = 0;
  private sinceClimbGrabMs = 0;
  private sinceCreepMs = 0;
  private nextVariation: Record<FootstepMaterial, number> = {
    wood: 0,
    rug: 0,
    metal: 0,
    glass: 0,
  };
  private nextGrab = 0;

  constructor(audio: FootstepSink) {
    this.audio = audio;
  }

  /**
   * One frame. `creeping` is the hunt's speed cap being in force, which turns a
   * hider's footfalls into the scrape of a body shifting where it stands: a
   * disguise that walked audibly across the shop would give itself away for a
   * reason the player never chose.
   */
  update(dtMs: number, motion: MotionSample, creeping = false): void {
    const climbing = motion.climbState !== null;
    if (climbing) {
      this.stepClimb(dtMs, motion);
      this.wasGrounded = true;
      this.lastY = motion.position.y;
      this.sinceStepM = 0;
      return;
    }
    if (this.wasClimbing) {
      this.wasClimbing = false;
      this.audio.play("wallstick_release", 0.04);
      // Reaching a supported ledge is a top-out, not a fall. Give it one
      // positive settle here; `stepAir` sees `wasGrounded` and cannot double it.
      if (motion.grounded && motion.position.y >= this.climbPeakY - WORLD_SCALE.stepHeight) {
        this.audio.play("land_soft", 0.04);
      }
    }

    this.stepAir(dtMs, motion);

    if (!motion.grounded) {
      this.sinceStepM = 0;
      return;
    }
    if (creeping) {
      this.stepCreep(dtMs, motion);
      return;
    }
    this.stepWalk(dtMs, motion);
  }

  /** The hop and the landing, told apart by whether the body gained height. */
  private stepAir(dtMs: number, motion: MotionSample): void {
    if (this.wasGrounded && !motion.grounded) {
      this.airborneMs = 0;
      // A hop leaves the ground going up. Walking off the end of the counter
      // leaves it going down, and that is a fall rather than a jump.
      if (motion.position.y > this.lastY + RISING_EPSILON_M) this.audio.play("jump_takeoff", 0.08);
    } else if (!motion.grounded) {
      this.airborneMs += dtMs;
    } else if (!this.wasGrounded) {
      this.audio.play(this.airborneMs > HARD_LANDING_MS ? "land_hard" : "land_soft", 0.07);
      this.airborneMs = 0;
    }
    this.wasGrounded = motion.grounded;
    this.lastY = motion.position.y;
  }

  /**
   * Footfalls by distance rather than by clock. A stride is a length, so a body
   * that slows down takes fewer steps over the same second without anything
   * having to know what speed it was going.
   */
  private stepWalk(dtMs: number, motion: MotionSample): void {
    this.sinceCreepMs = 0;
    if (motion.speed < MIN_SPEED_FACTOR * WORLD_SCALE.playerHeight) {
      this.sinceStepM = 0;
      return;
    }
    this.sinceStepM += motion.speed * (dtMs / 1_000);
    const strideM = STRIDE_FACTOR * WORLD_SCALE.playerHeight;
    if (this.sinceStepM < strideM) return;
    // Carry the remainder rather than clearing it, or every footfall loses up to
    // a frame's travel and the cadence drifts slower than the stride it is
    // quoted from. A frame long enough to have covered several strides is a
    // stall rather than a sprint, so its surplus is dropped instead of queueing
    // a burst of footfalls the body never took.
    this.sinceStepM -= strideM;
    if (this.sinceStepM > strideM) this.sinceStepM = 0;

    const material = footstepMaterial(motion.surfaceId);
    const variations = FOOTSTEP_VARIATIONS[material];
    const index = this.nextVariation[material];
    this.nextVariation[material] = (index + 1) % variations.length;
    const clip = variations[index];
    if (clip !== undefined) this.audio.play(clip, FOOTSTEP_PITCH_JITTER);
  }

  /** A capped hider shifting position, which is a scrape and not a footfall. */
  private stepCreep(dtMs: number, motion: MotionSample): void {
    this.sinceStepM = 0;
    if (motion.speed <= 0) {
      this.sinceCreepMs = 0;
      return;
    }
    this.sinceCreepMs += dtMs;
    if (this.sinceCreepMs < CREEP_SLIDE_INTERVAL_MS) return;
    this.sinceCreepMs = 0;
    this.audio.play("creep_slide", 0.1);
  }

  /** A grab as the climb starts, and another every so often up a ladder. */
  private stepClimb(dtMs: number, motion: MotionSample): void {
    if (!this.wasClimbing) {
      this.wasClimbing = true;
      this.climbPeakY = motion.position.y;
      this.sinceClimbGrabMs = 0;
      this.audio.play("wallstick_attach", 0.04);
      this.grab();
      return;
    }
    this.climbPeakY = Math.max(this.climbPeakY, motion.position.y);
    if (motion.climbState?.link.kind !== "ladder") return;
    this.sinceClimbGrabMs += dtMs;
    if (this.sinceClimbGrabMs < LADDER_GRAB_INTERVAL_MS) return;
    this.sinceClimbGrabMs = 0;
    this.grab();
  }

  private grab(): void {
    const clip = CLIMB_GRABS[this.nextGrab % CLIMB_GRABS.length];
    this.nextGrab += 1;
    if (clip !== undefined) this.audio.play(clip, 0.1);
  }
}
