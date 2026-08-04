import {
  GRAPPLE_ARRIVAL_M,
  GRAPPLE_MAX_RANGE_M,
  GRAPPLE_MIN_RANGE_M,
  GRAPPLE_PULL_SPEED_MPS,
  JUMP_HEIGHT_M,
} from "@foldseek/shared";

import {
  blocksCapsule,
  containsXZ,
  surfaceAt,
  INSPECTOR_EYE_HEIGHT_M,
  INSPECTOR_HEIGHT_M,
  INSPECTOR_RADIUS_M,
  INSPECTOR_STEP_HEIGHT_M,
  WORLD_SCALE,
  type ClimbLink,
  type NavData,
  type SpawnPose,
  type Vec3Like,
} from "./navData";

/**
 * The body every character in the shop walks with (§8.1, §26.4): a capsule
 * against axis-aligned nav geometry, grounded or falling, with height changes
 * crossed at authored climb links.
 *
 * A body hops on the jump key, `JUMP_HEIGHT_M` above whatever it is standing
 * on. That is a hop and nothing more: at this scale a table top is a storey, so
 * the map still decides where a body can *get up*, and the authored climb links
 * are still the only route onto furniture. The hop clears a lip and a gap and
 * gives the creature some life; it does not reach the lowest ledge in the shop.
 *
 * Two characters use it. The Inspector hunts with it at `inspectorMoveSpeed`,
 * and a Mimic runs about the shop with it during the Forge and creeps with it
 * during the hunt. They differ only in how fast they go and in whether they may
 * leave the surface they are standing on, so both are constructor arguments
 * rather than subclasses of behaviour.
 */

/**
 * One frame of movement intent, already sampled out of the raw devices (§25.1).
 * The controller never reads a keyboard, which is what lets the movement rules
 * below be tested headlessly.
 */
export interface CharacterMoveInput {
  /** Forward on the aim direction, in [-1, 1]. */
  forward: number;
  /** Strafe to the character's right, in [-1, 1]. */
  strafe: number;
  /** Yaw change for this frame, radians, positive turning left. */
  lookYawDelta: number;
  /** Pitch change for this frame, radians, positive looking up. */
  lookPitchDelta: number;
  brisk: boolean;
  /** Held rather than edged: a body that lands with the key down hops again. */
  jump: boolean;
  /** S/back explicitly lets go of a climb, even while Forward is also held. */
  disengageClimb?: boolean;
}

export function createMoveInput(): CharacterMoveInput {
  return { forward: 0, strafe: 0, lookYawDelta: 0, lookPitchDelta: 0, brisk: false, jump: false };
}

/** Kept short of vertical so the over-shoulder rig never gimbals (§8.1). */
export const MAX_PITCH_RAD = 1.45;

/** Smallest share of a step an axis may carry before it counts as movement. */
const MIN_AXIS_FRACTION = 1e-6;

/** Ensures a released climber enters the fall sweep instead of ground-snapping. */
const CLIMB_RELEASE_DOWN_SPEED = WORLD_SCALE.playerHeight * 0.05;
/** Carries a released body away from the wall seam while gravity takes over. */
const CLIMB_RELEASE_OUTWARD_SPEED = WORLD_SCALE.playerHeight * 0.65;
/** Clearance outside a climbed face. This must exceed the capsule radius. */
const CLIMB_RELEASE_CLEARANCE = INSPECTOR_RADIUS_M * 1.15;
/** Keeps the grapple capsule wholly outside a ledge until its feet clear it. */
const GRAPPLE_LIP_CLEARANCE = INSPECTOR_RADIUS_M * 1.2;
/** Places both feet and capsule centre securely inside the top face. */
const GRAPPLE_TOP_INSET = INSPECTOR_RADIUS_M * 1.08;

/**
 * Shape of a mantle: the body rises before it travels, so it reads as pulling
 * up over a lip rather than gliding diagonally. These are the share of the
 * climb spent rising and the point at which the horizontal move begins.
 */
const CLIMB_RISE_PROGRESS_FRACTION = 0.72;
const MIN_CLIMB_RISE_SECONDS = 0.16;
const MIN_CLIMB_TOPOUT_SECONDS = 0.12;

/** Solids up to roughly two body lengths read as a vault; taller faces are climbed. */
const PROCEDURAL_MANTLE_RISE = INSPECTOR_HEIGHT_M * 2.2;
/** Pulls the arrival point far enough onto a top face that the capsule is not left on its lip. */
const SOLID_TOP_INSET = INSPECTOR_RADIUS_M * 0.8;

/**
 * How long the body takes to reach its speed cap from a standstill, and to come
 * back to rest from the cap. A 0.35 m creature has very little mass to shift, so
 * both are short: the run is up in about a fifth of a second and stops in half
 * that, which reads as weight without ever feeling like the body is wading.
 *
 * They are times rather than accelerations so that every speed the body is
 * capped at — the Inspector's walk, the Forge run, the hunt's creep — takes the
 * same time to reach. The acceleration itself is `cap / seconds`, so a creep
 * ramps as gently as it moves.
 */
export const GROUND_ACCELERATION_SECONDS = 0.1;
export const GROUND_STOP_SECONDS = 0.06;

/**
 * Share of the ground acceleration a body has while it is off the ground. Feet
 * on nothing steer far less than feet on boards, but not so much less that a hop
 * over a kerb becomes a commitment made at takeoff: at 0.8 a body that hits an
 * obstacle and hops from a standstill still crosses it.
 *
 * There is no air braking at all. Releasing the keys in mid-air holds whatever
 * momentum the body left the ground with, which is what makes a hop an arc
 * rather than a thing that stops in the air.
 */
export const AIR_CONTROL_SCALE = 0.8;

/**
 * Gravity is scaled through the two halves of an arc: lighter going up, heavier
 * coming down. This is animation convention rather than physics, and it is the
 * single largest contributor to a jump reading as deliberate — the body lingers
 * at the top where the player is deciding where to land, then drops with weight.
 *
 * The apex is unchanged by it. `JUMP_SPEED` is derived from the rising scale, so
 * the body still tops out at exactly `JUMP_HEIGHT_M` and every invariant that
 * rests on that ceiling — chiefly that a hop reaches nothing in the shop that can
 * be stood on — is untouched. What changes is the time spent getting there.
 */
export const JUMP_RISE_GRAVITY_SCALE = 0.9;
export const JUMP_FALL_GRAVITY_SCALE = 1.15;

/**
 * How long after walking off an edge the body will still answer the jump key,
 * and how long before landing a press is remembered for. Neither is generosity
 * for its own sake: a player who presses jump on the frame their feet leave a
 * counter, or a frame or two before they touch down, meant to jump, and a strict
 * reading of the ground contact turns a correct input into a dropped one.
 *
 * Both are short enough that they cannot be played as a mechanic. Eighty
 * milliseconds is five frames at sixty, well under the reaction time that would
 * let a player use it deliberately as extra air.
 */
export const COYOTE_SECONDS = 0.08;
export const JUMP_BUFFER_SECONDS = 0.1;
/**
 * How fast the body may already be falling and still catch a lip it almost
 * reached (2026-08-04, the upward coyote). A jump that crests just short of a
 * shelf used to become a slide down its face; within this window the held
 * forward + Space still turns into the climb the player was asking for. A
 * third of the launch speed keeps the grab at the top of the arc - a body in
 * free fall gets no such favour.
 */
export const LEDGE_GRAB_FALL_WINDOW_FRACTION = 1 / 3;

/**
 * Takeoff speed that reaches `JUMP_HEIGHT_M` and no higher, from v² = 2gh with
 * the rising half of the arc's gravity. The height is the authored intent and
 * lives in the shared config beside every other body-scaled number; the speed is
 * the physics that delivers it, and it is derived here because gravity is the
 * room's, not the body's.
 */
const JUMP_SPEED = Math.sqrt(2 * WORLD_SCALE.gravity * JUMP_RISE_GRAVITY_SCALE * JUMP_HEIGHT_M);

/**
 * Speed a body touches down at from a hop off level ground, which is what a
 * landing's weight is measured against: one of these is an ordinary hop, and
 * anything more came off something higher.
 */
export const HOP_LANDING_SPEED =
  Math.sqrt(2 * WORLD_SCALE.gravity * JUMP_FALL_GRAVITY_SCALE * JUMP_HEIGHT_M);

/** How the last movement attempt was resolved, for camera sway and for tests. */
export type MoveResolution = "free" | "slid" | "stopped" | "idle";

/** Live climb, exposed so a vault animation can be driven from it later. */
export interface ClimbState {
  readonly link: ClimbLink;
  /** True when travelling from `link.from` to `link.to`, which is upward. */
  readonly ascending: boolean;
  /** 0 at the start of the traversal, 1 on arrival. */
  readonly progress: number;
}

export interface GrappleState {
  readonly anchor: Vec3Like;
  readonly distanceM: number;
}

/** Ground speed in metres per second for the intent of one frame. */
export type SpeedForInput = (input: CharacterMoveInput) => number;

export class CharacterController {
  /** Foot position in world space. Read by the camera rig and the publisher. */
  readonly position = { x: 0, y: 0, z: 0 };

  yaw = 0;
  pitch = 0;

  /** Horizontal speed actually achieved last frame, metres per second. */
  speed = 0;

  grounded = false;
  lastResolution: MoveResolution = "idle";

  /**
   * True for the one update in which the body regained the ground, with the
   * downward speed it arrived at. Together they are the landing: the camera dips
   * on them, the body compresses on them, and the audio driver reads them for
   * whether it was a step down or a drop.
   */
  justLanded = false;
  landingSpeed = 0;

  /** Surface currently stood on, which is the origin end of any climb link. */
  surfaceId: string | null = null;

  /**
   * While this is set the body keeps the height it has: gravity does not run,
   * no climb link starts, and a step is refused unless the destination still
   * stands over the surface the step began on.
   *
   * It is how a creeping Mimic stays inside the authority's speed cap. The
   * simulation measures a straight line in three dimensions against
   * `hiderCreepSpeed`, and a single frame of falling or one snap up a lip
   * covers more ground than a whole second of creeping is allowed; confined to
   * one level surface, the distance travelled is exactly the horizontal step.
   *
   * A hop is still allowed, and it is the one exception: it returns to the
   * exact height it left from rather than to whatever is underfoot on landing,
   * so the body ends the hop where the cap says it may be. See `resolveHop`.
   */
  surfaceLocked = false;

  private readonly navData: NavData;
  private readonly speedFor: SpeedForInput;

  private verticalVelocity = 0;
  /**
   * Horizontal velocity carried between frames, which is what makes the body
   * accelerate rather than snap to its cap. Its magnitude never exceeds the cap
   * the speed function returned, so every rule written against the cap — the
   * authority's creep validation above all — reads exactly as it did when the
   * body reached full speed on its first frame.
   */
  private velocityX = 0;
  private velocityZ = 0;
  /** Seconds of ground contact still owed after walking off an edge. */
  private coyoteSeconds = 0;
  /** Seconds since the jump key was last found down, for the landing buffer. */
  private sinceJumpRequest = Number.POSITIVE_INFINITY;
  /** Height a surface-locked hop took off from, and null while it is resting. */
  private hopBaseY: number | null = null;
  private climb: MutableClimb | null = null;
  private grapple: MutableGrapple | null = null;
  /**
   * The link just travelled. A climb ends standing on its own endpoint, so
   * without this a held forward key would re-enter the link and bounce the
   * player between the two surfaces forever.
   */
  private climbLatch: ClimbLink | null = null;
  /**
   * A climb and a jump consume one Space press. Releasing Space arms the next
   * action. This prevents a held climb press from reattaching at the lip or
   * becoming a surprise hop on the first grounded frame after top-out.
   */
  private jumpActionArmed = true;

  constructor(navData: NavData, speedFor: SpeedForInput) {
    this.navData = navData;
    this.speedFor = speedFor;
  }

  /** Places the character without collision resolution, for spawn and reveal. */
  teleportTo(pose: SpawnPose): void {
    this.reset(pose.position.x, pose.position.y, pose.position.z, pose.yaw);

    const surface = surfaceAt(
      this.navData.floors,
      this.position.x,
      this.position.z,
      this.position.y + INSPECTOR_STEP_HEIGHT_M,
    );
    this.surfaceId = surface?.id ?? null;
    this.grounded = surface !== null;
    if (surface !== null) this.position.y = surface.bounds.max.y;
  }

  /**
   * Adopts a position authored somewhere else, without pulling the body down
   * onto the surface underfoot. A Mimic's root is wherever the Forge has posed
   * it, which may be a wall bracket or a shelf it was dropped onto, and a
   * character that snapped to the floor the moment its owner pressed a walk key
   * would relocate the disguise rather than move it. It falls from there
   * instead, on the ordinary rules.
   */
  placeAt(x: number, y: number, z: number, yaw: number): void {
    this.reset(x, y, z, yaw);

    const surface = surfaceAt(this.navData.floors, x, z, y + INSPECTOR_STEP_HEIGHT_M);
    if (surface === null) {
      this.surfaceId = null;
      this.grounded = false;
      return;
    }

    // A blocker top under the feet is what the body is standing on, and nothing
    // walkable is published there. The Forge can leave a disguise on a crate or
    // on the arm of the armchair, and reading only the floor underneath would
    // report it as hanging in mid-air, which is the one state a creep refuses
    // to move out of.
    const restingOn = this.descentBlockedAt(y, surface.bounds.max.y);
    this.surfaceId = restingOn === null ? surface.id : null;
    this.grounded = y - (restingOn ?? surface.bounds.max.y) <= WORLD_SCALE.groundSnap;
  }

  private reset(x: number, y: number, z: number, yaw: number): void {
    this.position.x = x;
    this.position.y = y;
    this.position.z = z;
    this.yaw = yaw;
    this.pitch = 0;
    this.speed = 0;
    this.verticalVelocity = 0;
    this.velocityX = 0;
    this.velocityZ = 0;
    this.coyoteSeconds = 0;
    this.sinceJumpRequest = Number.POSITIVE_INFINITY;
    this.justLanded = false;
    this.landingSpeed = 0;
    this.hopBaseY = null;
    this.climb = null;
    this.grapple = null;
    this.climbLatch = null;
    this.jumpActionArmed = true;
    this.lastResolution = "idle";
  }

  /** True while the body is off the ground, whether it hopped or fell. */
  get airborne(): boolean {
    return !this.grounded;
  }

  /** World height of the eye, the gameplay origin for every focus distance. */
  get eyeY(): number {
    return this.position.y + INSPECTOR_EYE_HEIGHT_M;
  }

  /** The climb in progress, or null while walking or falling. */
  get climbState(): ClimbState | null {
    if (this.climb === null) return null;
    const progress =
      this.climb.phase === "rise"
        ? this.climb.phaseProgress * CLIMB_RISE_PROGRESS_FRACTION
        : CLIMB_RISE_PROGRESS_FRACTION +
          this.climb.phaseProgress * (1 - CLIMB_RISE_PROGRESS_FRACTION);
    return { link: this.climb.link, ascending: this.climb.ascending, progress };
  }

  /** The live cable pull, exposed for animation, diagnostics and its line renderer. */
  get grappleState(): GrappleState | null {
    const grapple = this.grapple;
    if (grapple === null) return null;
    return {
      anchor: grapple.anchor,
      distanceM: Math.hypot(
        grapple.anchor.x - this.position.x,
        grapple.anchor.y - (this.position.y + INSPECTOR_HEIGHT_M * 0.5),
        grapple.anchor.z - this.position.z,
      ),
    };
  }

  /** Starts a collision-safe pull from the body's centre to a world-space latch. */
  startGrapple(anchor: Vec3Like): boolean {
    const bodyCenterY = this.position.y + INSPECTOR_HEIGHT_M * 0.5;
    const distance = Math.hypot(
      anchor.x - this.position.x,
      anchor.y - bodyCenterY,
      anchor.z - this.position.z,
    );
    if (
      !Number.isFinite(distance) ||
      distance < GRAPPLE_MIN_RANGE_M ||
      distance > GRAPPLE_MAX_RANGE_M ||
      anchor.y < bodyCenterY
    ) {
      return false;
    }
    this.climb = null;
    this.climbLatch = null;
    this.grapple = {
      anchor: { x: anchor.x, y: anchor.y, z: anchor.z },
      // A grapple is an ascent/traverse tool, never a way to tow the capsule
      // through the floor it was standing on. This also fences malformed
      // remote targets that bypass the client's ray filter.
      minFootY: this.position.y,
      landing: this.grappleLandingFor(anchor),
      phase: "pull",
    };
    this.grounded = false;
    this.surfaceId = null;
    this.surfaceLocked = false;
    this.verticalVelocity = 0;
    this.velocityX = 0;
    this.velocityZ = 0;
    this.speed = 0;
    return true;
  }

  /** Releases without snapping; ordinary gravity owns the body again. */
  releaseGrapple(): boolean {
    if (this.grapple === null) return false;
    this.grapple = null;
    this.grounded = false;
    this.surfaceId = null;
    this.surfaceLocked = false;
    this.verticalVelocity = Math.min(this.verticalVelocity, -CLIMB_RELEASE_DOWN_SPEED);
    this.speed = 0;
    return true;
  }

  update(dtSeconds: number, input: CharacterMoveInput): void {
    if (dtSeconds <= 0) {
      this.resolveGroundPlanePenetration();
      return;
    }

    this.justLanded = false;
    // Collision is resolved before any traversal branch. The base floor is a
    // permanent plane, so even a bad transform from an interrupted frame starts
    // this update standing on its top instead of continuing through the void.
    this.resolveGroundPlanePenetration();
    this.sinceJumpRequest = input.jump ? 0 : this.sinceJumpRequest + dtSeconds;
    if (!input.jump && !this.jumpActionArmed) {
      this.jumpActionArmed = true;
      // The press was consumed by traversal. Do not turn its release into a
      // buffered jump on the first grounded frame after a top-out.
      this.sinceJumpRequest = Number.POSITIVE_INFINITY;
      this.coyoteSeconds = 0;
    }

    this.yaw = wrapAngle(this.yaw + input.lookYawDelta);
    this.pitch = clamp(this.pitch + input.lookPitchDelta, -MAX_PITCH_RAD, MAX_PITCH_RAD);

    if (this.grapple !== null && input.disengageClimb === true) this.releaseGrapple();
    if (this.grapple !== null) {
      this.advanceGrapple(dtSeconds);
      return;
    }

    if (this.climb !== null && (input.disengageClimb === true || input.forward < 0)) {
      this.disengageClimb();
    }
    if (this.climb !== null && !input.jump) this.releaseClimbInput();
    if (this.climb !== null) {
      this.advanceClimb(dtSeconds);
      return;
    }

    const startX = this.position.x;
    const startZ = this.position.z;
    this.moveHorizontally(dtSeconds, input);

    // One gesture starts every climb: forward + Space. Authored routes get the
    // first claim; the solid-face fallback handles everything else. Resolving
    // this before an ordinary jump is essential, otherwise an authored ledge
    // turns the body airborne before its link ever gets a chance to attach.
    // The window reaches slightly into the fall (the upward coyote), so a jump
    // that crests just short of the lip still catches it.
    const startedClimb =
      (this.grounded ||
        this.verticalVelocity > -JUMP_SPEED * LEDGE_GRAB_FALL_WINDOW_FRACTION) &&
      input.forward > 0 &&
      input.jump &&
      this.jumpActionArmed &&
      (this.tryStartClimb(input) || this.tryStartSolidClimbForHeading());
    if (startedClimb) {
      this.consumeJump();
      return;
    }
    if (this.surfaceLocked) {
      this.resolveHop(dtSeconds);
    } else {
      if (this.wantsJump()) {
        this.verticalVelocity = JUMP_SPEED;
        this.grounded = false;
        this.consumeJump();
      }
      this.resolveVertical(dtSeconds);
      if (this.grounded) {
        this.coyoteSeconds = COYOTE_SECONDS;
      } else {
        this.coyoteSeconds = Math.max(0, this.coyoteSeconds - dtSeconds);
      }
    }

    const movedX = this.position.x - startX;
    const movedZ = this.position.z - startZ;
    this.speed = Math.sqrt(movedX * movedX + movedZ * movedZ) / dtSeconds;
  }

  /**
   * Whether this frame launches the body. The key is held rather than edged, so
   * a body that lands with it down hops again; the buffer is what catches a
   * press that ended just before the feet touched down, and the coyote credit is
   * what catches one made just after they left an edge. Consuming a jump spends
   * both, so neither can stack into a second launch in mid-air.
   */
  private wantsJump(): boolean {
    if (!this.jumpActionArmed) return false;
    if (this.sinceJumpRequest > JUMP_BUFFER_SECONDS) return false;
    return this.grounded || this.coyoteSeconds > 0;
  }

  private consumeJump(): void {
    this.sinceJumpRequest = Number.POSITIVE_INFINITY;
    this.coyoteSeconds = 0;
  }

  /** Pulls in short substeps so a fast cable cannot tunnel through shelf boards. */
  private advanceGrapple(dtSeconds: number): void {
    const grapple = this.grapple;
    if (grapple === null) return;
    const landing = grapple.landing;
    const target = landing === null
      ? {
          x: grapple.anchor.x,
          y: grapple.anchor.y - INSPECTOR_HEIGHT_M * 0.5,
          z: grapple.anchor.z,
        }
      : grapple.phase === "pull"
        ? { x: landing.lipX, y: landing.surfaceY, z: landing.lipZ }
        : { x: landing.landingX, y: landing.surfaceY, z: landing.landingZ };
    let dx = target.x - this.position.x;
    let dy = target.y - this.position.y;
    let dz = target.z - this.position.z;
    const distance = Math.hypot(dx, dy, dz);
    const arrival = landing === null ? GRAPPLE_ARRIVAL_M : 0.01;
    if (distance <= arrival) {
      if (landing !== null) this.advanceGrappleLanding(grapple);
      else this.releaseGrapple();
      return;
    }
    dx /= distance;
    dy /= distance;
    dz /= distance;
    const travel = Math.min(GRAPPLE_PULL_SPEED_MPS * dtSeconds, Math.max(0, distance - arrival));
    const maxStep = Math.max(0.01, INSPECTOR_RADIUS_M * 0.35);
    const steps = Math.max(1, Math.ceil(travel / maxStep));
    const step = travel / steps;
    const startX = this.position.x;
    const startZ = this.position.z;

    for (let index = 0; index < steps; index += 1) {
      const x = this.position.x + dx * step;
      const y = Math.max(grapple.minFootY, this.position.y + dy * step);
      const z = this.position.z + dz * step;
      if (
        !this.hasWalkableColumn(x, z) ||
        blocksCapsule(
          this.navData.blockers,
          x,
          z,
          y,
          INSPECTOR_RADIUS_M,
          INSPECTOR_HEIGHT_M,
          INSPECTOR_STEP_HEIGHT_M,
        )
      ) {
        this.releaseGrapple();
        break;
      }
      this.position.x = x;
      this.position.y = y;
      this.position.z = z;
    }

    this.grounded = false;
    this.surfaceId = null;
    if (this.grapple !== null) this.verticalVelocity = 0;
    this.velocityX = 0;
    this.velocityZ = 0;
    this.speed = Math.hypot(this.position.x - startX, this.position.z - startZ) / dtSeconds;
    this.lastResolution = "free";
    if (this.grapple !== null && distance - travel <= arrival + 1e-6) {
      if (landing !== null) this.advanceGrappleLanding(grapple);
      else this.releaseGrapple();
    }
  }

  /**
   * Finds the elevated walkable top associated with a latch. The cable first
   * takes the body to a point just outside its lip, then pulls horizontally
   * onto an inset landing. That prevents a successful grapple from ending as
   * an immediate fall or leaving the capsule balanced on a shelf edge.
   */
  private grappleLandingFor(anchor: Vec3Like): GrappleLanding | null {
    const minimumTop = this.position.y + INSPECTOR_STEP_HEIGHT_M + 1e-4;
    const maximumTop = anchor.y + INSPECTOR_STEP_HEIGHT_M;
    const maximumHorizontalGap = INSPECTOR_RADIUS_M * 1.75;
    let best: NavData["floors"][number] | null = null;
    let bestTop = Number.NEGATIVE_INFINITY;
    let bestGap = Number.POSITIVE_INFINITY;

    for (const surface of this.navData.floors) {
      const top = surface.bounds.max.y;
      if (top < minimumTop || top > maximumTop) continue;
      const width = surface.bounds.max.x - surface.bounds.min.x;
      const depth = surface.bounds.max.z - surface.bounds.min.z;
      if (width < GRAPPLE_TOP_INSET * 2 || depth < GRAPPLE_TOP_INSET * 2) continue;
      const nearestX = clamp(anchor.x, surface.bounds.min.x, surface.bounds.max.x);
      const nearestZ = clamp(anchor.z, surface.bounds.min.z, surface.bounds.max.z);
      const gap = Math.hypot(anchor.x - nearestX, anchor.z - nearestZ);
      if (gap > maximumHorizontalGap) continue;
      if (top > bestTop + 1e-6 || (Math.abs(top - bestTop) <= 1e-6 && gap < bestGap)) {
        best = surface;
        bestTop = top;
        bestGap = gap;
      }
    }
    if (best === null) return null;

    const bounds = best.bounds;
    const insetMinX = bounds.min.x + GRAPPLE_TOP_INSET;
    const insetMaxX = bounds.max.x - GRAPPLE_TOP_INSET;
    const insetMinZ = bounds.min.z + GRAPPLE_TOP_INSET;
    const insetMaxZ = bounds.max.z - GRAPPLE_TOP_INSET;
    const landingX = clamp(anchor.x, insetMinX, insetMaxX);
    const landingZ = clamp(anchor.z, insetMinZ, insetMaxZ);
    const sides = [
      { distance: Math.abs(this.position.x - bounds.min.x), side: "minX" as const },
      { distance: Math.abs(this.position.x - bounds.max.x), side: "maxX" as const },
      { distance: Math.abs(this.position.z - bounds.min.z), side: "minZ" as const },
      { distance: Math.abs(this.position.z - bounds.max.z), side: "maxZ" as const },
    ];
    if (this.position.x < bounds.min.x) sides[0]!.distance = 0;
    else if (this.position.x > bounds.max.x) sides[1]!.distance = 0;
    if (this.position.z < bounds.min.z) sides[2]!.distance = 0;
    else if (this.position.z > bounds.max.z) sides[3]!.distance = 0;
    sides.sort((a, b) => a.distance - b.distance);

    for (const candidate of sides) {
      let lipX = landingX;
      let lipZ = landingZ;
      let topX = landingX;
      let topZ = landingZ;
      if (candidate.side === "minX") {
        lipX = bounds.min.x - GRAPPLE_LIP_CLEARANCE;
        topX = insetMinX;
      } else if (candidate.side === "maxX") {
        lipX = bounds.max.x + GRAPPLE_LIP_CLEARANCE;
        topX = insetMaxX;
      } else if (candidate.side === "minZ") {
        lipZ = bounds.min.z - GRAPPLE_LIP_CLEARANCE;
        topZ = insetMinZ;
      } else {
        lipZ = bounds.max.z + GRAPPLE_LIP_CLEARANCE;
        topZ = insetMaxZ;
      }
      if (!this.hasWalkableColumn(lipX, lipZ)) continue;
      if (blocksCapsule(this.navData.blockers, lipX, lipZ, bestTop)) continue;
      if (blocksCapsule(this.navData.blockers, topX, topZ, bestTop)) continue;
      return {
        surfaceId: best.id,
        surfaceY: bestTop,
        lipX,
        lipZ,
        landingX: topX,
        landingZ: topZ,
      };
    }
    return null;
  }

  private advanceGrappleLanding(grapple: MutableGrapple): void {
    const landing = grapple.landing;
    if (landing === null) return;
    if (grapple.phase === "pull") {
      this.position.x = landing.lipX;
      this.position.y = landing.surfaceY;
      this.position.z = landing.lipZ;
      grapple.phase = "topout";
      return;
    }
    this.position.x = landing.landingX;
    this.position.y = landing.surfaceY;
    this.position.z = landing.landingZ;
    this.grapple = null;
    this.surfaceId = landing.surfaceId;
    this.surfaceLocked = false;
    this.land();
    this.velocityX = 0;
    this.velocityZ = 0;
    this.speed = 0;
  }

  /**
   * Steers the horizontal velocity toward what the keys are asking for, at a
   * rate the body can manage, and moves by whatever velocity survives. The cap
   * is the same cap it always was — the velocity is clamped to it every frame —
   * so nothing downstream that measures distance against a speed limit can tell
   * this from the instant version, except that the body now spends its first
   * fifth of a second under the limit rather than at it.
   */
  private moveHorizontally(dtSeconds: number, input: CharacterMoveInput): void {
    const cap = this.speedFor(input);

    // three's convention: yaw 0 faces -Z, so forward is (-sin, -cos) and the
    // character's right is that vector turned a quarter turn clockwise.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let dirX = input.forward * -sin + input.strafe * cos;
    let dirZ = input.forward * -cos + input.strafe * -sin;
    const magnitude = Math.sqrt(dirX * dirX + dirZ * dirZ);
    const steering = magnitude > 0;
    if (magnitude > 1) {
      dirX /= magnitude;
      dirZ /= magnitude;
    }

    // One rule covers three things the body has to do: build up to speed, come
    // back down to a stop, and turn. A change of direction is a change of
    // velocity like any other, so easing toward the new one is exactly the turn
    // smoothing a body needs and costs no separate machinery.
    const seconds = steering ? GROUND_ACCELERATION_SECONDS : GROUND_STOP_SECONDS;
    let rate = cap / seconds;
    if (!this.grounded) rate *= AIR_CONTROL_SCALE;
    if (!this.grounded && !steering) rate = 0;

    const targetX = steering ? dirX * cap : 0;
    const targetZ = steering ? dirZ * cap : 0;
    let toTargetX = targetX - this.velocityX;
    let toTargetZ = targetZ - this.velocityZ;
    const gap = Math.sqrt(toTargetX * toTargetX + toTargetZ * toTargetZ);
    const reach = rate * dtSeconds;
    if (gap > reach) {
      toTargetX *= reach / gap;
      toTargetZ *= reach / gap;
    }
    this.velocityX += toTargetX;
    this.velocityZ += toTargetZ;

    // A cap that just dropped — the hunt closing over a Mimic that was running —
    // leaves the body above it for one frame. Bring it down rather than letting
    // the authority see a step it never agreed to.
    const speed = Math.sqrt(this.velocityX * this.velocityX + this.velocityZ * this.velocityZ);
    if (speed > cap && speed > 0) {
      this.velocityX *= cap / speed;
      this.velocityZ *= cap / speed;
    }

    // A component this small is trigonometric residue from the yaw, not intent.
    // Left in place it would make a wall slide the character by 1e-18 a frame
    // and report a slide where the honest answer is that they are stopped.
    const dx = Math.abs(this.velocityX) < MIN_AXIS_FRACTION ? 0 : this.velocityX * dtSeconds;
    const dz = Math.abs(this.velocityZ) < MIN_AXIS_FRACTION ? 0 : this.velocityZ * dtSeconds;
    if (dx === 0 && dz === 0) {
      this.lastResolution = "idle";
      return;
    }

    if (this.tryStep(dx, dz)) {
      this.lastResolution = "free";
      return;
    }
    // A slide keeps its velocity. The wall absorbs the blocked component every
    // frame without the body ever having built it up or lost it, which is what
    // lets a player pressed diagonally against a shelf travel along it at the
    // same speed they would cross open floor.
    if (this.tryStep(dx, 0) || this.tryStep(0, dz)) {
      this.lastResolution = "slid";
      return;
    }
    // Square into it, though, and the body has stopped: the momentum went into
    // the wall, and turning away starts again from rest.
    this.velocityX = 0;
    this.velocityZ = 0;
    this.lastResolution = "stopped";
  }

  /**
   * Applies one candidate displacement. Walking off an edge is legal and starts
   * a fall, so the only refusals are a blocker, a space too low to stand in, and
   * leaving the map entirely. Returning false leaves the controller untouched,
   * which is what makes the caller's axis fallback a slide.
   */
  private tryStep(dx: number, dz: number): boolean {
    if (dx === 0 && dz === 0) return false;
    const x = this.position.x + dx;
    const z = this.position.z + dz;

    if (
      blocksCapsule(
        this.navData.blockers,
        x,
        z,
        this.position.y,
        INSPECTOR_RADIUS_M,
        INSPECTOR_HEIGHT_M,
        INSPECTOR_STEP_HEIGHT_M,
      )
    ) {
      return false;
    }

    // Somewhere to stand or somewhere to land, at any depth below. Nothing at
    // all means the destination is off the map, which is never walkable. A
    // surface too low to stand under is filtered out by `surfaceAt`, so a crawl
    // space the body does not fit into reads exactly like a wall.
    const destination = surfaceAt(
      this.navData.floors,
      x,
      z,
      this.position.y + INSPECTOR_STEP_HEIGHT_M,
    );
    if (destination === null) {
      // Contextual climbs may finish on a blocker top that is intentionally
      // absent from the authored floor graph. Let a grounded body traverse that
      // flat top; once its centre clears the footprint, the ordinary floor
      // below becomes the destination and vertical resolution performs the
      // drop. A surface-locked Hider can cross the same top but still cannot
      // step down to a different published surface below.
      if (!this.grounded || this.supportingBlockerTopAt(x, z) === null) return false;
      this.position.x = x;
      this.position.z = z;
      return true;
    }
    // A creep may not step off the surface it settled on, in either direction:
    // an edge it would fall from and a lip it would rise onto both move the body
    // vertically, and vertical distance spends the same budget as horizontal.
    if (this.surfaceLocked && destination.id !== this.surfaceId) {
      // The shop floor is tiled into authored navigation regions. Crossing a
      // seam between two regions at the exact same height is still movement on
      // one plane; treating the changed id as a ledge made invisible walls at
      // cabinet corners and room-zone boundaries during the hunt.
      const lockedBaseY = this.hopBaseY ?? this.position.y;
      if (Math.abs(destination.bounds.max.y - lockedBaseY) <= 1e-4) {
        this.surfaceId = destination.id;
      } else {
      // A body standing on an un-authored blocker top has to be able to cross
      // its lip onto the real floor below. That explicit dismount ends the
      // initial hiding-surface lock; ordinary floor-to-floor creep stays
      // protected until a climb/top-out or this edge crossing occurs.
        if (this.supportingBlockerTopAt(this.position.x, this.position.z) === null) return false;
        this.surfaceLocked = false;
      }
    }

    this.position.x = x;
    this.position.z = z;
    return true;
  }

  /**
   * The one vertical move a creep can afford. A surface-locked body holds its
   * height, so a hop is measured against the height it left rather than against
   * whatever `surfaceAt` reports on the way down: it goes up `JUMP_HEIGHT_M`
   * and comes back to exactly where it took off from.
   *
   * That is what keeps a hunt-phase hop legal. The authority measures a
   * straight line from the last pose it accepted, so a hop that landed on the
   * surface top instead — a centimetre or two from where the disguise was
   * resting — would spend creep budget the hop never earned. Landing on the
   * takeoff height makes a hop in place cost nothing at all, and a hop that
   * travels costs exactly its horizontal distance, which `moveHorizontally` has
   * already capped.
   */
  private resolveHop(dtSeconds: number): void {
    let baseY = this.hopBaseY;
    if (baseY === null) {
      if (!this.wantsJump()) return;
      baseY = this.position.y;
      this.hopBaseY = baseY;
      this.verticalVelocity = JUMP_SPEED;
      this.grounded = false;
      this.consumeJump();
    }

    this.applyGravity(dtSeconds);
    const nextY = this.position.y + this.verticalVelocity * dtSeconds;
    if (this.verticalVelocity <= 0 && nextY <= baseY) {
      const below = surfaceAt(
        this.navData.floors,
        this.position.x,
        this.position.z,
        baseY + INSPECTOR_STEP_HEIGHT_M,
      );
      const floorY = below?.bounds.max.y;
      this.position.y =
        floorY !== undefined && baseY - floorY <= WORLD_SCALE.groundSnap
          ? floorY
          : baseY;
      this.hopBaseY = null;
      this.land();
      return;
    }
    this.position.y = nextY;
  }

  /** Snaps to the surface underfoot, or keeps falling toward the one below. */
  private resolveVertical(dtSeconds: number): void {
    const groundY = this.groundPlaneYAt(this.position.x, this.position.z);
    const ceilingY = this.position.y + INSPECTOR_STEP_HEIGHT_M;
    const below = surfaceAt(this.navData.floors, this.position.x, this.position.z, ceilingY);
    if (below === null) {
      // A procedural top has no published walkable surface of its own. While
      // the body is still over that blocker's footprint, the room floor below
      // also fails `surfaceAt`'s headroom test. Null therefore does not mean
      // gravity stops: sweep the blocker top exactly as the ordinary descent
      // path does, then keep falling once the body clears its edge.
      this.applyGravity(dtSeconds);
      const nextY = this.position.y + this.verticalVelocity * dtSeconds;
      const landedOn = this.descentBlockedAt(this.position.y, nextY);
      if (landedOn !== null) {
        this.position.y = landedOn;
        this.land();
        this.surfaceId = null;
        return;
      }
      if (groundY !== null && nextY <= groundY) {
        this.landOnGroundPlane(groundY);
        return;
      }
      this.position.y = nextY;
      this.grounded = false;
      this.surfaceId = null;
      return;
    }

    const floorTop = below.bounds.max.y;
    if (this.verticalVelocity === 0) {
      // A blocker the feet already rest on holds the body up exactly as a
      // walkable surface does. Without this the body would micro-fall off a
      // crate top and be caught again on every single frame it stood there.
      const restingOn = this.descentBlockedAt(this.position.y, floorTop);
      const top = restingOn ?? floorTop;
      if (this.position.y - top <= WORLD_SCALE.groundSnap) {
        this.position.y = top;
        this.grounded = true;
        this.surfaceId = restingOn === null ? below.id : null;
        return;
      }
    }

    this.applyGravity(dtSeconds);
    const nextY = this.position.y + this.verticalVelocity * dtSeconds;
    const landedOn = this.descentBlockedAt(this.position.y, Math.max(nextY, floorTop));
    if (landedOn !== null) {
      this.position.y = landedOn;
      this.land();
      // Nothing walkable is published at a blocker top, so no authored climb
      // link may claim to start from one: `tryStartClimb` stands down on a null
      // surface, which is what keeps a body that dropped onto the back of the
      // armchair from vaulting a link it is merely standing over.
      this.surfaceId = null;
      return;
    }
    if (nextY <= floorTop) {
      this.position.y = floorTop;
      this.separateLandingFromBlockers(floorTop);
      this.land();
      this.surfaceId = surfaceAt(
        this.navData.floors,
        this.position.x,
        this.position.z,
        floorTop + INSPECTOR_STEP_HEIGHT_M,
      )?.id ?? below.id;
      return;
    }
    this.position.y = nextY;
    this.grounded = false;
    this.surfaceId = null;
  }

  /**
   * Highest blocker top the feet cross on the way from `feetY` down to `lowY`,
   * or null when that descent is clear.
   *
   * A fall used to consult `surfaceAt` alone, so a body that ran off a ledge
   * dropped straight through whatever furniture stood under it and landed on
   * the floor *inside* the armchair. Sweeping the descent rather than sampling
   * its end is what makes it a fix: a frame at terminal speed covers 0.1 m,
   * which is the whole of a packing crate, so a test done only at `nextY`
   * tunnels through exactly the obstacles this is about.
   *
   * **A blocker top is standing.** Every box in the nav data is axis-aligned
   * with a flat top, so a fall onto a crate lands on the crate and a fall onto
   * the arm of the armchair lands on the arm. The alternative — pushing the
   * body sideways to the nearest free column — has no answer when every
   * neighbour is occupied, and it would still have to put the body somewhere.
   * Landing is never a trap either: `blocksCapsule` ignores a blocker whose top
   * is within a step of the feet, so a body standing on one can walk off it in
   * any direction and fall from there on the ordinary rules.
   *
   * The footprint is tested as a point rather than as the capsule's radius, and
   * that is deliberate: `surfaceAt` puts the body in the air the moment its
   * centre passes a ledge edge, so a blocker top has to release it at the same
   * moment. Growing this by the radius would leave a body hovering a radius
   * past the edge of every crate in the shop.
   */
  private descentBlockedAt(feetY: number, lowY: number): number | null {
    let top: number | null = null;
    for (const blocker of this.navData.blockers) {
      const blockerTop = blocker.max.y;
      // Above the feet it is a wall beside the body rather than ground beneath
      // it, and `blocksCapsule` is what keeps the body out of those.
      if (blockerTop > feetY || blockerTop <= lowY) continue;
      if (!containsXZ(blocker, this.position.x, this.position.z)) continue;
      if (top === null || blockerTop > top) top = blockerTop;
    }
    return top;
  }

  /**
   * Resolves the capsule outward when a ledge fall lands beside the support it
   * just left. The centre clears a shelf before the whole capsule does; without
   * this separation the lower base becomes a wall around an already-overlapping
   * body and every subsequent WASD step is refused forever.
   */
  private separateLandingFromBlockers(feetY: number): void {
    const epsilon = 1e-4;
    for (let pass = 0; pass < 4; pass += 1) {
      if (
        !blocksCapsule(
          this.navData.blockers,
          this.position.x,
          this.position.z,
          feetY,
          INSPECTOR_RADIUS_M,
          INSPECTOR_HEIGHT_M,
          INSPECTOR_STEP_HEIGHT_M,
        )
      ) return;

      let best: { x: number; z: number; distanceSq: number } | null = null;
      for (const blocker of this.navData.blockers) {
        if (blocker.max.y <= feetY + INSPECTOR_STEP_HEIGHT_M) continue;
        if (blocker.min.y >= feetY + INSPECTOR_HEIGHT_M) continue;
        if (!containsXZ(blocker, this.position.x, this.position.z, INSPECTOR_RADIUS_M)) continue;
        const candidates = [
          { x: blocker.min.x - INSPECTOR_RADIUS_M - epsilon, z: this.position.z },
          { x: blocker.max.x + INSPECTOR_RADIUS_M + epsilon, z: this.position.z },
          { x: this.position.x, z: blocker.min.z - INSPECTOR_RADIUS_M - epsilon },
          { x: this.position.x, z: blocker.max.z + INSPECTOR_RADIUS_M + epsilon },
        ];
        for (const candidate of candidates) {
          const ground = surfaceAt(
            this.navData.floors,
            candidate.x,
            candidate.z,
            feetY + INSPECTOR_STEP_HEIGHT_M,
          );
          if (ground === null || Math.abs(ground.bounds.max.y - feetY) > WORLD_SCALE.groundSnap) continue;
          if (
            blocksCapsule(
              this.navData.blockers,
              candidate.x,
              candidate.z,
              feetY,
              INSPECTOR_RADIUS_M,
              INSPECTOR_HEIGHT_M,
              INSPECTOR_STEP_HEIGHT_M,
            )
          ) continue;
          const dx = candidate.x - this.position.x;
          const dz = candidate.z - this.position.z;
          const distanceSq = dx * dx + dz * dz;
          if (best === null || distanceSq < best.distanceSq) best = { ...candidate, distanceSq };
        }
      }
      if (best === null) return;
      this.position.x = best.x;
      this.position.z = best.z;
    }
  }

  /**
   * Lets go immediately. Above the lip the body completes its top-out; below
   * it, the current position is retained and ordinary gravity takes over.
   */
  releaseClimbInput(): void {
    const climb = this.climb;
    if (climb === null) return;
    if (climb.phase === "topout") {
      this.finishClimb(climb);
      return;
    }
    this.dropClimb(climb);
  }

  /**
   * Explicit bail-out used by either role pressing S. This never reverses or
   * snaps to an endpoint: the body lets go where it is and falls.
   */
  disengageClimb(): boolean {
    const climb = this.climb;
    if (climb === null) return false;
    this.jumpActionArmed = false;
    this.dropClimb(climb);
    return true;
  }

  /** A flat blocker top at the body's current standing height, if one exists. */
  private supportingBlockerTopAt(x: number, z: number): number | null {
    let top: number | null = null;
    for (const blocker of this.navData.blockers) {
      if (!containsXZ(blocker, x, z)) continue;
      if (Math.abs(blocker.max.y - this.position.y) > WORLD_SCALE.groundSnap) continue;
      if (top === null || blocker.max.y > top) top = blocker.max.y;
    }
    return top;
  }

  /**
   * The two halves of the arc. Rising is light and falling is heavy, so the body
   * hangs a moment at the top and comes down with intent; the apex is unaffected,
   * because the takeoff speed was derived from the rising half.
   */
  private applyGravity(dtSeconds: number): void {
    const scale = this.verticalVelocity > 0 ? JUMP_RISE_GRAVITY_SCALE : JUMP_FALL_GRAVITY_SCALE;
    this.verticalVelocity = Math.max(
      -WORLD_SCALE.terminalFallSpeed,
      this.verticalVelocity - WORLD_SCALE.gravity * scale * dtSeconds,
    );
  }

  /** Puts the body back on its feet and reports how hard it arrived. */
  private land(): void {
    this.landingSpeed = Math.max(0, -this.verticalVelocity);
    this.justLanded = !this.grounded;
    this.verticalVelocity = 0;
    this.grounded = true;
  }

  /** The permanent room-ground height under an XZ point, or null outside it. */
  private groundPlaneYAt(x: number, z: number): number | null {
    return containsXZ(this.navData.groundPlane, x, z) ? this.navData.groundPlane.max.y : null;
  }

  /**
   * Resolves an already-penetrating body against the base plane in place. This
   * is collision correction, not checkpoint recovery: X/Z and yaw are retained,
   * and the feet move only to the surface they penetrated.
   */
  private resolveGroundPlanePenetration(): boolean {
    const groundY = this.groundPlaneYAt(this.position.x, this.position.z);
    if (groundY === null || this.position.y >= groundY) return false;

    this.grapple = null;
    this.climb = null;
    this.climbLatch = null;
    this.position.y = groundY;
    this.separateLandingFromBlockers(groundY);
    this.land();
    this.surfaceId = surfaceAt(
      this.navData.floors,
      this.position.x,
      this.position.z,
      groundY + INSPECTOR_STEP_HEIGHT_M,
    )?.id ?? null;
    return true;
  }

  /** Lands on the permanent base plane after a downward sweep crosses it. */
  private landOnGroundPlane(groundY: number): void {
    this.position.y = groundY;
    this.separateLandingFromBlockers(groundY);
    this.land();
    this.surfaceId = surfaceAt(
      this.navData.floors,
      this.position.x,
      this.position.z,
      groundY + INSPECTOR_STEP_HEIGHT_M,
    )?.id ?? null;
  }

  /** True when the permanent ground or another walkable surface occupies this column. */
  private hasWalkableColumn(x: number, z: number): boolean {
    return (
      this.groundPlaneYAt(x, z) !== null ||
      surfaceAt(this.navData.floors, x, z, Number.POSITIVE_INFINITY) !== null
    );
  }

  /**
   * Begins a climb when the player presses forward at a link endpoint and is
   * heading toward the far end. A ladder rises in place, so when the two ends
   * share a footprint the heading test is skipped and proximity is enough.
   */
  private tryStartClimb(input: CharacterMoveInput): boolean {
    const activationSq = WORLD_SCALE.climbActivationRadius * WORLD_SCALE.climbActivationRadius;
    if (this.climbLatch !== null && (input.forward <= 0 || this.leftLink(this.climbLatch, activationSq))) {
      this.climbLatch = null;
    }
    if (input.forward <= 0) return false;

    const headingX = -Math.sin(this.yaw);
    const headingZ = -Math.cos(this.yaw);

    if (this.surfaceId !== null) {
      for (const link of this.navData.climbLinks) {
        if (link === this.climbLatch) continue;
        // Climbing down is not an input in Fold & Seek. A body standing on a
        // shelf leaves it by walking/falling off its edge; allowing the upper
        // endpoint here made a held W auto-grab the ladder during that fall and
        // strand the Hider in climb mode.
        if (link.from !== this.surfaceId) continue;
        const ascending = true;

        const start = ascending ? link.position : link.target;
        const end = ascending ? link.target : link.position;
        const toStartX = start.x - this.position.x;
        const toStartZ = start.z - this.position.z;
        if (toStartX * toStartX + toStartZ * toStartZ > activationSq) continue;

        const spanX = end.x - start.x;
        const spanZ = end.z - start.z;
        const spanSq = spanX * spanX + spanZ * spanZ;
        const vertical = spanSq < MIN_AXIS_FRACTION;
        if (!vertical && headingX * spanX + headingZ * spanZ <= 0) continue;

        return this.beginClimb(link, ascending, end);
      }
    }
    return false;
  }

  private tryStartSolidClimbForHeading(): boolean {
    const activation = WORLD_SCALE.climbActivationRadius + INSPECTOR_RADIUS_M;
    return this.tryStartSolidClimb(
      -Math.sin(this.yaw),
      -Math.cos(this.yaw),
      activation * activation,
    );
  }

  /**
   * Turns the face of any blocker into a contextual climb. Authored links still
   * win where the map supplies one; this fallback is what makes an unlisted
   * crate, cabinet, or wall respond when the player runs directly into it.
   */
  private tryStartSolidClimb(headingX: number, headingZ: number, activationSq: number): boolean {
    const candidates: Array<{
      index: number;
      distanceSq: number;
      faceX: number;
      faceZ: number;
    }> = [];
    for (let index = 0; index < this.navData.blockers.length; index += 1) {
      const blocker = this.navData.blockers[index];
      if (blocker === undefined) continue;
      const rise = blocker.max.y - this.position.y;
      if (rise <= INSPECTOR_STEP_HEIGHT_M) continue;

      const headY = this.position.y + INSPECTOR_HEIGHT_M;
      const overheadGap = blocker.min.y - headY;
      const directlyOverhead =
        containsXZ(blocker, this.position.x, this.position.z) &&
        overheadGap >= 0 &&
        overheadGap <= WORLD_SCALE.climbActivationRadius;
      if (blocker.min.y > headY && !directlyOverhead) continue;

      const faceX = clamp(this.position.x, blocker.min.x, blocker.max.x);
      const faceZ = clamp(this.position.z, blocker.min.z, blocker.max.z);
      const dx = faceX - this.position.x;
      const dz = faceZ - this.position.z;
      const distanceSq = dx * dx + dz * dz;
      if (directlyOverhead) {
        candidates.push({
          index,
          distanceSq: 0,
          faceX: this.position.x,
          faceZ: this.position.z,
        });
        continue;
      }
      // A zero distance means the feet are over this solid (usually standing
      // on it), not approaching one of its faces.
      if (distanceSq < MIN_AXIS_FRACTION || distanceSq > activationSq) continue;
      const distance = Math.sqrt(distanceSq);
      // A broad forward hemisphere is intentional: third-person camera aim is
      // imprecise at this scale, and forcing a near-normal approach made valid
      // shelf faces feel randomly unresponsive.
      if ((headingX * dx + headingZ * dz) / distance < 0.15) continue;

      candidates.push({ index, distanceSq, faceX, faceZ });
    }
    candidates.sort((a, b) => a.distanceSq - b.distanceSq);

    // Dense furniture is made from several overlapping boxes. The geometrically
    // nearest one may be a narrow post whose top cannot hold the capsule. Keep
    // looking for the first nearby face with a real, collision-free landing
    // instead of attaching to the post and discovering the dead end at its lip.
    for (const candidate of candidates) {
      const blocker = this.navData.blockers[candidate.index];
      if (blocker === undefined) continue;
      const width = blocker.max.x - blocker.min.x;
      const depth = blocker.max.z - blocker.min.z;
      const insetX = Math.min(SOLID_TOP_INSET, width * 0.5);
      const insetZ = Math.min(SOLID_TOP_INSET, depth * 0.5);
      const targetX = clamp(
        candidate.faceX + headingX * SOLID_TOP_INSET,
        blocker.min.x + insetX,
        blocker.max.x - insetX,
      );
      const targetZ = clamp(
        candidate.faceZ + headingZ * SOLID_TOP_INSET,
        blocker.min.z + insetZ,
        blocker.max.z - insetZ,
      );
      const safeTarget = this.safeSolidTopTarget(
        blocker,
        targetX,
        targetZ,
        headingX,
        headingZ,
        insetX,
        insetZ,
      );
      if (safeTarget === null) continue;
      const rise = blocker.max.y - this.position.y;
      const link: ClimbLink = {
        from: this.surfaceId ?? `solid_start_${candidate.index}`,
        to: `solid_top_${candidate.index}`,
        kind: rise <= PROCEDURAL_MANTLE_RISE ? "mantle" : "ladder",
        position: { x: this.position.x, y: this.position.y, z: this.position.z },
        target: { x: safeTarget.x, y: blocker.max.y, z: safeTarget.z },
      };
      if (this.beginClimb(link, true, link.target)) return true;
    }
    return false;
  }

  /**
   * Moves a procedural arrival away from an adjacent cabinet's grown capsule
   * footprint. Multi-box furniture such as the steel rack may have no point on
   * a narrow top that passes this conservative probe; in that case its authored
   * target remains valid and the ordinary movement resolver handles the frame.
   */
  private safeSolidTopTarget(
    blocker: NavData["blockers"][number],
    targetX: number,
    targetZ: number,
    headingX: number,
    headingZ: number,
    insetX: number,
    insetZ: number,
  ): { x: number; z: number } | null {
    const sideX = -headingZ;
    const sideZ = headingX;
    const step = INSPECTOR_RADIUS_M * 0.9;
    const offsets = [
      [0, 0],
      [step, 0],
      [step * 2, 0],
      [step, step],
      [step, -step],
      [0, step],
      [0, -step],
    ] as const;
    for (const [forward, side] of offsets) {
      const x = clamp(
        targetX + headingX * forward + sideX * side,
        blocker.min.x + insetX,
        blocker.max.x - insetX,
      );
      const z = clamp(
        targetZ + headingZ * forward + sideZ * side,
        blocker.min.z + insetZ,
        blocker.max.z - insetZ,
      );
      if (
        !blocksCapsule(
          this.navData.blockers,
          x,
          z,
          blocker.max.y,
          INSPECTOR_RADIUS_M,
          INSPECTOR_HEIGHT_M,
          INSPECTOR_STEP_HEIGHT_M,
        )
      ) {
        return { x, z };
      }
    }
    return null;
  }

  private beginClimb(
    link: ClimbLink,
    ascending: boolean,
    end: Vec3Like,
  ): boolean {
    // A bad authored destination must fail before traversal takes ownership.
    // Starting anyway means the only possible outcome is an embedded capsule
    // or a fall from the lip, both of which feel like the controls broke.
    if (
      blocksCapsule(
        this.navData.blockers,
        end.x,
        end.z,
        end.y,
        INSPECTOR_RADIUS_M,
        INSPECTOR_HEIGHT_M,
        INSPECTOR_STEP_HEIGHT_M,
      )
    ) {
      return false;
    }
    const dx = end.x - this.position.x;
    const dy = end.y - this.position.y;
    const dz = end.z - this.position.z;
    let speed = link.kind === "ladder" ? WORLD_SCALE.ladderSpeed : WORLD_SCALE.mantleSpeed;
    if (this.surfaceLocked) {
      speed = Math.min(
        speed,
        this.speedFor({
          forward: 1,
          strafe: 0,
          lookYawDelta: 0,
          lookPitchDelta: 0,
          brisk: false,
          jump: true,
        }),
      );
    }
    this.climb = {
      link,
      ascending,
      phase: "rise",
      phaseProgress: 0,
      riseDurationSeconds: Math.max(MIN_CLIMB_RISE_SECONDS, Math.abs(dy) / speed),
      topoutDurationSeconds: Math.max(MIN_CLIMB_TOPOUT_SECONDS, Math.hypot(dx, dz) / speed),
      startX: this.position.x,
      startY: this.position.y,
      startZ: this.position.z,
      endX: end.x,
      endY: end.y,
      endZ: end.z,
    };
    this.jumpActionArmed = false;
    this.speed = 0;
    this.velocityX = 0;
    this.velocityZ = 0;
    this.lastResolution = "idle";
    return true;
  }

  /**
   * Advances the climb in progress. Releasing below a ladder lip lets go;
   * releasing after clearing it completes the dismount. A mantle is committed once
   * it starts, matching the authored vault of §26.4.
   */
  private advanceClimb(dtSeconds: number): void {
    const climb = this.climb;
    if (climb === null) return;

    this.grounded = false;
    this.speed = 0;

    if (climb.phase === "rise") {
      climb.phaseProgress = Math.min(
        1,
        climb.phaseProgress + dtSeconds / climb.riseDurationSeconds,
      );
      // The collision capsule stays at its known-safe attachment point until
      // its feet clear the lip. The former diagonal interpolation entered the
      // blocker halfway up, making every early release an embedded exit.
      this.position.x = climb.startX;
      this.position.z = climb.startZ;
      this.position.y = climb.startY + (climb.endY - climb.startY) * climb.phaseProgress;
      if (climb.phaseProgress < 1) return;
      climb.phase = "topout";
      climb.phaseProgress = 0;
    }

    climb.phaseProgress = Math.min(
      1,
      climb.phaseProgress + dtSeconds / climb.topoutDurationSeconds,
    );
    this.position.x = climb.startX + (climb.endX - climb.startX) * climb.phaseProgress;
    this.position.z = climb.startZ + (climb.endZ - climb.startZ) * climb.phaseProgress;
    this.position.y = climb.endY;
    if (climb.phaseProgress >= 1) this.finishClimb(climb);
  }

  private finishClimb(climb: MutableClimb): void {
    // The destination can become invalid after traversal starts. Snapping into
    // it traps the capsule inside the lip; releasing from the current point
    // gives the ordinary fall/collision path a chance to recover instead.
    if (
      blocksCapsule(
        this.navData.blockers,
        climb.endX,
        climb.endZ,
        climb.endY,
        INSPECTOR_RADIUS_M,
        INSPECTOR_HEIGHT_M,
        INSPECTOR_STEP_HEIGHT_M,
      )
    ) {
      this.fallFromAttachment(climb);
      return;
    }
    this.position.x = climb.endX;
    this.position.y = climb.endY;
    this.position.z = climb.endZ;
    this.surfaceId = climb.ascending ? climb.link.to : climb.link.from;
    // A hiding body begins the hunt surface-locked to keep ordinary hops on
    // their take-off plane. Once it explicitly climbs, that safety must yield:
    // otherwise the newly reached top is treated as a foreign surface and the
    // player cannot cross or step off it.
    if (climb.ascending) this.surfaceLocked = false;
    this.grounded = true;
    this.verticalVelocity = 0;
    this.climbLatch = climb.link;
    this.climb = null;
  }

  /** Releases a traversal in place and hands vertical motion back to gravity. */
  private dropClimb(climb: MutableClimb): void {
    let awayX = climb.startX - climb.endX;
    let awayZ = climb.startZ - climb.endZ;
    let length = Math.hypot(awayX, awayZ);
    if (length < MIN_AXIS_FRACTION) {
      // A vertical ladder has no horizontal span. Backward from the facing
      // direction is the side the body approached from.
      awayX = Math.sin(this.yaw);
      awayZ = Math.cos(this.yaw);
      length = 1;
    }
    awayX /= length;
    awayZ /= length;
    // During the rise the exact attachment point is the last position proven
    // collision-free. During top-out the feet have already cleared the solid,
    // so completing onto the validated destination is safer than dropping from
    // a point halfway across the lip.
    if (climb.phase === "topout") {
      this.finishClimb(climb);
      return;
    }
    this.position.x = climb.startX + awayX * CLIMB_RELEASE_CLEARANCE;
    this.position.z = climb.startZ + awayZ * CLIMB_RELEASE_CLEARANCE;
    if (
      blocksCapsule(
        this.navData.blockers,
        this.position.x,
        this.position.z,
        this.position.y,
        INSPECTOR_RADIUS_M,
        INSPECTOR_HEIGHT_M,
        INSPECTOR_STEP_HEIGHT_M,
      )
    ) {
      // The attachment point itself was accepted by ordinary movement before
      // the climb began, so it is the deterministic fallback at dense corners.
      this.position.x = climb.startX;
      this.position.z = climb.startZ;
    }
    this.enterClimbFall(climb, awayX, awayZ);
  }

  /** Aborts an invalid top-out at the last position known to be outside solids. */
  private fallFromAttachment(climb: MutableClimb): void {
    this.position.x = climb.startX;
    this.position.z = climb.startZ;
    let awayX = climb.startX - climb.endX;
    let awayZ = climb.startZ - climb.endZ;
    const length = Math.hypot(awayX, awayZ);
    if (length > MIN_AXIS_FRACTION) {
      awayX /= length;
      awayZ /= length;
    } else {
      awayX = Math.sin(this.yaw);
      awayZ = Math.cos(this.yaw);
    }
    this.enterClimbFall(climb, awayX, awayZ);
  }

  private enterClimbFall(climb: MutableClimb, awayX: number, awayZ: number): void {
    this.climb = null;
    this.climbLatch = climb.link;
    this.surfaceId = null;
    this.grounded = false;
    this.surfaceLocked = false;
    this.jumpActionArmed = false;
    this.verticalVelocity = -CLIMB_RELEASE_DOWN_SPEED;
    this.velocityX = awayX * CLIMB_RELEASE_OUTWARD_SPEED;
    this.velocityZ = awayZ * CLIMB_RELEASE_OUTWARD_SPEED;
    this.speed = 0;
    this.lastResolution = "idle";
  }

  /** True once the player has stepped clear of both ends of the link. */
  private leftLink(link: ClimbLink, activationSq: number): boolean {
    return (
      horizontalDistanceSq(this.position, link.position) > activationSq &&
      horizontalDistanceSq(this.position, link.target) > activationSq
    );
  }
}

function horizontalDistanceSq(a: { x: number; z: number }, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

interface MutableClimb {
  readonly link: ClimbLink;
  readonly ascending: boolean;
  phase: "rise" | "topout";
  phaseProgress: number;
  readonly riseDurationSeconds: number;
  readonly topoutDurationSeconds: number;
  readonly startX: number;
  readonly startY: number;
  readonly startZ: number;
  readonly endX: number;
  readonly endY: number;
  readonly endZ: number;
}

interface MutableGrapple {
  readonly anchor: Vec3Like;
  readonly minFootY: number;
  readonly landing: GrappleLanding | null;
  phase: "pull" | "topout";
}

interface GrappleLanding {
  readonly surfaceId: string;
  readonly surfaceY: number;
  readonly lipX: number;
  readonly lipZ: number;
  readonly landingX: number;
  readonly landingZ: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function wrapAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = radians % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  return wrapped;
}
