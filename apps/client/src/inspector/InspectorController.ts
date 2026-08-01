import type { MatchSettings } from "@foldseek/shared";

import {
  blocksCapsule,
  surfaceAt,
  BRISK_WALK_MULTIPLIER,
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
 * One frame of Inspector intent, already sampled out of the raw devices (§25.1).
 * The controller never reads a keyboard, which is what lets the movement rules
 * below be tested headlessly.
 */
export interface InspectorMoveInput {
  /** Forward on the aim direction, in [-1, 1]. */
  forward: number;
  /** Strafe to the Inspector's right, in [-1, 1]. */
  strafe: number;
  /** Yaw change for this frame, radians, positive turning left. */
  lookYawDelta: number;
  /** Pitch change for this frame, radians, positive looking up. */
  lookPitchDelta: number;
  brisk: boolean;
}

export function createMoveInput(): InspectorMoveInput {
  return { forward: 0, strafe: 0, lookYawDelta: 0, lookPitchDelta: 0, brisk: false };
}

/** Kept short of vertical so the over-shoulder rig never gimbals (§8.1). */
export const MAX_PITCH_RAD = 1.45;

/** Smallest share of a step an axis may carry before it counts as movement. */
const MIN_AXIS_FRACTION = 1e-6;

/** A climb never resolves instantly, however short the link. */
const MIN_CLIMB_SECONDS = 0.25;

/**
 * Shape of a mantle: the body rises before it travels, so it reads as pulling
 * up over a lip rather than gliding diagonally. These are the share of the
 * climb spent rising and the point at which the horizontal move begins.
 */
const MANTLE_RISE_FRACTION = 0.6;
const MANTLE_TRAVEL_START = 0.35;

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

/**
 * Tiny third-person Inspector character (§8.1, §26.4). A capsule against
 * axis-aligned nav geometry, grounded or falling, with height changes crossed
 * at authored climb links. There is no jump: at this scale a table top is a
 * storey, so the map decides where a body can get up, not the player's timing.
 */
export class InspectorController {
  /** Foot position in world space. Read by the camera rig and the publisher. */
  readonly position = { x: 0, y: 0, z: 0 };

  yaw = 0;
  pitch = 0;

  /** Horizontal speed actually achieved last frame, metres per second. */
  speed = 0;

  grounded = false;
  lastResolution: MoveResolution = "idle";

  /** Surface currently stood on, which is the origin end of any climb link. */
  surfaceId: string | null = null;

  private readonly navData: NavData;
  private readonly settings: MatchSettings;

  private verticalVelocity = 0;
  private climb: MutableClimb | null = null;
  /**
   * The link just travelled. A climb ends standing on its own endpoint, so
   * without this a held forward key would re-enter the link and bounce the
   * player between the two surfaces forever.
   */
  private climbLatch: ClimbLink | null = null;

  constructor(navData: NavData, settings: MatchSettings) {
    this.navData = navData;
    this.settings = settings;
  }

  /** Places the Inspector without collision resolution, for spawn and reveal. */
  teleportTo(pose: SpawnPose): void {
    this.position.x = pose.position.x;
    this.position.y = pose.position.y;
    this.position.z = pose.position.z;
    this.yaw = pose.yaw;
    this.pitch = 0;
    this.speed = 0;
    this.verticalVelocity = 0;
    this.climb = null;
    this.climbLatch = null;
    this.lastResolution = "idle";

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

  /** World height of the eye, the gameplay origin for every focus distance. */
  get eyeY(): number {
    return this.position.y + INSPECTOR_EYE_HEIGHT_M;
  }

  /** The climb in progress, or null while walking or falling. */
  get climbState(): ClimbState | null {
    if (this.climb === null) return null;
    return { link: this.climb.link, ascending: this.climb.ascending, progress: this.climb.progress };
  }

  update(dtSeconds: number, input: InspectorMoveInput): void {
    if (dtSeconds <= 0) return;

    this.yaw = wrapAngle(this.yaw + input.lookYawDelta);
    this.pitch = clamp(this.pitch + input.lookPitchDelta, -MAX_PITCH_RAD, MAX_PITCH_RAD);

    if (this.climb !== null) {
      this.advanceClimb(dtSeconds, input);
      return;
    }

    const startX = this.position.x;
    const startZ = this.position.z;
    this.moveHorizontally(dtSeconds, input);
    this.resolveVertical(dtSeconds);
    if (this.grounded) this.tryStartClimb(input);

    const movedX = this.position.x - startX;
    const movedZ = this.position.z - startZ;
    this.speed = Math.sqrt(movedX * movedX + movedZ * movedZ) / dtSeconds;
  }

  private moveHorizontally(dtSeconds: number, input: InspectorMoveInput): void {
    const speed = this.settings.inspectorMoveSpeed * (input.brisk ? BRISK_WALK_MULTIPLIER : 1);

    // three's convention: yaw 0 faces -Z, so forward is (-sin, -cos) and the
    // Inspector's right is that vector turned a quarter turn clockwise.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let dirX = input.forward * -sin + input.strafe * cos;
    let dirZ = input.forward * -cos + input.strafe * -sin;
    const magnitude = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (magnitude <= 0) {
      this.lastResolution = "idle";
      return;
    }
    if (magnitude > 1) {
      dirX /= magnitude;
      dirZ /= magnitude;
    }

    const step = speed * dtSeconds;
    // A component this small is trigonometric residue from the yaw, not intent.
    // Left in place it would make a wall slide the character by 1e-18 a frame
    // and report a slide where the honest answer is that they are stopped.
    const dx = Math.abs(dirX) < MIN_AXIS_FRACTION ? 0 : dirX * step;
    const dz = Math.abs(dirZ) < MIN_AXIS_FRACTION ? 0 : dirZ * step;

    if (this.tryStep(dx, dz)) {
      this.lastResolution = "free";
    } else if (this.tryStep(dx, 0)) {
      this.lastResolution = "slid";
    } else if (this.tryStep(0, dz)) {
      this.lastResolution = "slid";
    } else {
      this.lastResolution = "stopped";
    }
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
    if (
      surfaceAt(this.navData.floors, x, z, this.position.y + INSPECTOR_STEP_HEIGHT_M) === null
    ) {
      return false;
    }

    this.position.x = x;
    this.position.z = z;
    return true;
  }

  /** Snaps to the surface underfoot, or keeps falling toward the one below. */
  private resolveVertical(dtSeconds: number): void {
    const ceilingY = this.position.y + INSPECTOR_STEP_HEIGHT_M;
    const below = surfaceAt(this.navData.floors, this.position.x, this.position.z, ceilingY);
    if (below === null) {
      this.grounded = false;
      this.surfaceId = null;
      return;
    }

    const top = below.bounds.max.y;
    if (this.verticalVelocity === 0 && this.position.y - top <= WORLD_SCALE.groundSnap) {
      this.position.y = top;
      this.grounded = true;
      this.surfaceId = below.id;
      return;
    }

    this.verticalVelocity = Math.max(
      -WORLD_SCALE.terminalFallSpeed,
      this.verticalVelocity - WORLD_SCALE.gravity * dtSeconds,
    );
    const nextY = this.position.y + this.verticalVelocity * dtSeconds;
    if (nextY <= top) {
      this.position.y = top;
      this.verticalVelocity = 0;
      this.grounded = true;
      this.surfaceId = below.id;
      return;
    }
    this.position.y = nextY;
    this.grounded = false;
    this.surfaceId = null;
  }

  /**
   * Begins a climb when the player presses forward at a link endpoint and is
   * heading toward the far end. A ladder rises in place, so when the two ends
   * share a footprint the heading test is skipped and proximity is enough.
   */
  private tryStartClimb(input: InspectorMoveInput): void {
    const activationSq = WORLD_SCALE.climbActivationRadius * WORLD_SCALE.climbActivationRadius;
    if (this.climbLatch !== null && (input.forward <= 0 || this.leftLink(this.climbLatch, activationSq))) {
      this.climbLatch = null;
    }
    if (input.forward <= 0 || this.surfaceId === null) return;

    const headingX = -Math.sin(this.yaw);
    const headingZ = -Math.cos(this.yaw);

    for (const link of this.navData.climbLinks) {
      if (link === this.climbLatch) continue;
      const ascending = link.from === this.surfaceId;
      if (!ascending && link.to !== this.surfaceId) continue;

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

      const rise = end.y - start.y;
      const distance = Math.sqrt(spanSq + rise * rise);
      const speed = link.kind === "ladder" ? WORLD_SCALE.ladderSpeed : WORLD_SCALE.mantleSpeed;
      this.climb = {
        link,
        ascending,
        progress: 0,
        durationSeconds: Math.max(MIN_CLIMB_SECONDS, distance / speed),
        startX: this.position.x,
        startY: this.position.y,
        startZ: this.position.z,
        endX: end.x,
        endY: end.y,
        endZ: end.z,
      };
      this.speed = 0;
      this.lastResolution = "idle";
      return;
    }
  }

  /**
   * Advances the climb in progress. A ladder only moves while forward is held,
   * so letting go hangs the player where they are. A mantle is committed once
   * it starts, matching the authored vault of §26.4.
   */
  private advanceClimb(dtSeconds: number, input: InspectorMoveInput): void {
    const climb = this.climb;
    if (climb === null) return;

    this.grounded = false;
    this.speed = 0;
    if (climb.link.kind === "ladder" && input.forward <= 0) return;

    climb.progress = Math.min(1, climb.progress + dtSeconds / climb.durationSeconds);

    // Rise first when going up, travel first when coming down, so the body
    // clears the lip in both directions.
    const riseFraction = climb.ascending ? MANTLE_RISE_FRACTION : 1;
    const travelStart = climb.ascending ? MANTLE_TRAVEL_START : 0;
    const verticalT = clamp01(climb.progress / riseFraction);
    const horizontalT = clamp01((climb.progress - travelStart) / (1 - travelStart));

    this.position.x = climb.startX + (climb.endX - climb.startX) * horizontalT;
    this.position.z = climb.startZ + (climb.endZ - climb.startZ) * horizontalT;
    this.position.y = climb.startY + (climb.endY - climb.startY) * verticalT;

    if (climb.progress < 1) return;

    this.position.x = climb.endX;
    this.position.y = climb.endY;
    this.position.z = climb.endZ;
    this.surfaceId = climb.ascending ? climb.link.to : climb.link.from;
    this.grounded = true;
    this.verticalVelocity = 0;
    this.climbLatch = climb.link;
    this.climb = null;
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
  progress: number;
  readonly durationSeconds: number;
  readonly startX: number;
  readonly startY: number;
  readonly startZ: number;
  readonly endX: number;
  readonly endY: number;
  readonly endZ: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function wrapAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = radians % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  return wrapped;
}
