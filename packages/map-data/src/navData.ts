/**
 * The navigation contract between the map module and the Inspector character
 * system (§26.5). It is deliberately plain data: axis-aligned boxes and points,
 * no physics engine, no Three.js dependency. The map builds it, the Inspector
 * controller walks and climbs on it, the camera collides against it, and the
 * authoritative SpatialValidator draws its line-of-sight segments through it.
 *
 * `AABB` is structurally satisfied by three's `Box3`, so a map that already
 * holds `Box3` geometry can hand its boxes over unchanged, and a server that
 * only has JSON can supply plain objects.
 *
 * Scale: players are tiny inside a real-dimensioned shop, so a table top is a
 * storey rather than a step. Height differences are crossed at authored climb
 * links rather than by walking up, and every body measurement comes from
 * `WORLD_SCALE` instead of being written into the code.
 */

import { PLAYER_HEIGHT_M } from "@foldseek/shared";

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Mutable counterpart used for reusable scratch values in per-frame code. */
export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/** World-space axis-aligned bounding box. `three.Box3` conforms to this. */
export interface AABB {
  readonly min: Vec3Like;
  readonly max: Vec3Like;
}

/**
 * Every body dimension in one place, in world metres. The shop keeps its real
 * dimensions and the player shrinks, so a 0.75 m table stands more than twice
 * the player's height above the floor.
 *
 * `playerHeight` is the scale knob and it lives in `@foldseek/shared`, because
 * the match settings derive their speeds and distances from the same number and
 * the shared package cannot import client code.
 */
export const WORLD_SCALE = {
  playerHeight: PLAYER_HEIGHT_M,
  /** Half the shoulder width of the Mimic body, which is the same creature. */
  playerRadius: PLAYER_HEIGHT_M * 0.35,
  eyeHeight: PLAYER_HEIGHT_M * 0.9,
  /** Lip a walker crosses without a climb link. Proportional to the body. */
  stepHeight: PLAYER_HEIGHT_M * 0.2,
  /** Drop absorbed without leaving the ground. Anything deeper is a fall. */
  groundSnap: PLAYER_HEIGHT_M * 0.35,
  /**
   * Gravity and the fall cap are properties of the room, not of the body: the
   * shop's ledges are real heights and a body falling off one accelerates at
   * the real rate, so neither is scaled.
   */
  gravity: 9.81,
  terminalFallSpeed: 6,
  /**
   * Along-path speeds for the two climb kinds, in body lengths per second. A
   * vault runs at 2.4 and a ladder at 1.55, both below the walk in
   * `DEFAULT_MATCH_SETTINGS` but quick enough to keep traversal responsive.
   */
  mantleSpeed: PLAYER_HEIGHT_M * 2.4,
  ladderSpeed: PLAYER_HEIGHT_M * 1.55,
  /** How near a link's endpoint the player must be to start climbing. */
  climbActivationRadius: PLAYER_HEIGHT_M * 0.7,
} as const;

export const INSPECTOR_RADIUS_M = WORLD_SCALE.playerRadius;
export const INSPECTOR_HEIGHT_M = WORLD_SCALE.playerHeight;
export const INSPECTOR_EYE_HEIGHT_M = WORLD_SCALE.eyeHeight;
export const INSPECTOR_STEP_HEIGHT_M = WORLD_SCALE.stepHeight;

/** Shift multiplier on `inspectorMoveSpeed`. Brisk walk, never a sprint (§8.1). */
export const BRISK_WALK_MULTIPLIER = 1.4;

/**
 * One standable area. Only the top face is walked on: a player inside the
 * footprint stands on `bounds.max.y`. Overlapping surfaces are allowed, and the
 * highest reachable one wins.
 */
export interface WalkableSurface {
  /** Unique within the map. Climb links refer to surfaces by this id. */
  readonly id: string;
  readonly bounds: AABB;
  /** 0 is the shop floor, 1 the table and shelf tops, and so on upward. */
  readonly level: number;
  /**
   * Headroom above `bounds.max.y`, for a crawl space under furniture. Omit
   * where the space is open. A surface with less clearance than
   * `WORLD_SCALE.playerHeight` cannot be entered, because there is no crouch.
   */
  readonly clearance?: number;
}

export type ClimbKind = "mantle" | "ladder";

/**
 * An authored route between two surfaces, usable in both directions: whichever
 * end the player stands on decides which way they travel. A mantle is a
 * committed vault, a ladder is ridden while the player keeps holding forward.
 */
export interface ClimbLink {
  readonly from: string;
  readonly to: string;
  readonly kind: ClimbKind;
  /** Where the climb starts, standing on `from`. */
  readonly position: Vec3Like;
  /** Where it ends, standing on `to`. Authored, never derived from `position`. */
  readonly target: Vec3Like;
}

export interface SpawnPose {
  /** Foot position: the y is the surface the character stands on, not the eye. */
  readonly position: Vec3Like;
  /** Facing in radians about +Y, matching three's object rotation convention. */
  readonly yaw: number;
}

export interface SpawnPoints {
  readonly inspectors: readonly SpawnPose[];
  readonly mimics: readonly SpawnPose[];
}

export interface NavData {
  readonly floors: readonly WalkableSurface[];
  /**
   * The room's permanent base collision slab. Unlike `floors`, this is not a
   * candidate gameplay target and it never disappears because a body crossed
   * below its top between frames. The character solver uses only its top face
   * and XZ footprint as the final ground boundary.
   */
  readonly groundPlane: AABB;
  /**
   * Walls, furniture, and blocked volumes. These stop movement, pull the camera
   * in, and occlude accusation line of sight. Inspectable pick proxies are a
   * separate list (see `FocusSystem`), exactly as §26.5 requires.
   */
  readonly blockers: readonly AABB[];
  /**
   * Small visual latch surfaces that must not become movement blockers: books,
   * cabinet posts and other thin details a grapple can visibly catch.
   */
  readonly grappleTargets?: readonly AABB[];
  readonly climbLinks: readonly ClimbLink[];
  readonly spawnPoints: SpawnPoints;
  /** The Inspector's entry room (§5.9), for staging the theatrical door. */
  readonly securityOffice: AABB;
}

/** True when (x, z) lies inside the box footprint, grown by `margin`. */
export function containsXZ(box: AABB, x: number, z: number, margin = 0): boolean {
  return (
    x >= box.min.x - margin &&
    x <= box.max.x + margin &&
    z >= box.min.z - margin &&
    z <= box.max.z + margin
  );
}

/** True when the surface has the headroom a standing player needs. */
export function fitsUnder(surface: WalkableSurface): boolean {
  return surface.clearance === undefined || surface.clearance >= WORLD_SCALE.playerHeight;
}

/**
 * Highest surface at (x, z) whose top is no higher than `ceilingY`, ignoring
 * any the player cannot fit beneath. Returns null when there is nothing there
 * at all, which means the position is off the map rather than in the air.
 */
export function surfaceAt(
  floors: readonly WalkableSurface[],
  x: number,
  z: number,
  ceilingY: number,
): WalkableSurface | null {
  let best: WalkableSurface | null = null;
  for (const surface of floors) {
    if (!containsXZ(surface.bounds, x, z)) continue;
    if (surface.bounds.max.y > ceilingY) continue;
    if (!fitsUnder(surface)) continue;
    if (best === null || surface.bounds.max.y > best.bounds.max.y) best = surface;
  }
  return best;
}

/**
 * Whether an upright capsule standing at (x, feetY, z) intersects any blocker.
 * The capsule is approximated by its bounding box in XZ, which is why the test
 * is a point against each blocker grown by the capsule radius. Blockers whose
 * top is within step height are ignored: those are lips, not walls.
 */
export function blocksCapsule(
  blockers: readonly AABB[],
  x: number,
  z: number,
  feetY: number,
  radius = INSPECTOR_RADIUS_M,
  height = INSPECTOR_HEIGHT_M,
  stepHeight = INSPECTOR_STEP_HEIGHT_M,
  /**
   * Where the body is moving FROM, when the caller knows it.
   *
   * A blocker the body is already standing inside does not block it. Without
   * this the test is a trap rather than a wall: every destination inside the
   * box is refused, in every direction including upwards, so a body that ends
   * up in there by any means cannot walk out and cannot jump out either. It
   * can still be pushed in no further, because a blocker it is NOT already
   * inside goes on blocking normally.
   */
  origin?: { readonly x: number; readonly z: number; readonly feetY: number },
): boolean {
  const headY = feetY + height;
  const stepY = feetY + stepHeight;
  for (const blocker of blockers) {
    if (blocker.max.y <= stepY) continue;
    if (blocker.min.y >= headY) continue;
    if (!containsXZ(blocker, x, z, radius)) continue;
    if (origin !== undefined && alreadyInside(blocker, origin, radius, height, stepHeight)) {
      continue;
    }
    return true;
  }
  return false;
}

/** Whether a capsule at `origin` is already within this blocker. */
function alreadyInside(
  blocker: AABB,
  origin: { readonly x: number; readonly z: number; readonly feetY: number },
  radius: number,
  height: number,
  stepHeight: number,
): boolean {
  if (blocker.max.y <= origin.feetY + stepHeight) return false;
  if (blocker.min.y >= origin.feetY + height) return false;
  return containsXZ(blocker, origin.x, origin.z, radius);
}
