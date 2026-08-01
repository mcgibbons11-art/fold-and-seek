import type { AABB, MutableVec3, Vec3Like } from "./navData";

/**
 * The small amount of ray and box maths the Inspector system needs. It is kept
 * free of Three.js so the same functions back both the client raycasts and the
 * authoritative SpatialValidator, which runs inside the Colyseus server and the
 * Portals host process where no renderer exists.
 *
 * Every function is allocation-free. Callers that need a temporary vector own a
 * module-level scratch of their own.
 */

const AXES = ["x", "y", "z"] as const;

/** Directions shorter than this are treated as degenerate. */
const MIN_DIRECTION_COMPONENT = 1e-8;

/**
 * Entry parameter of a ray against a box, restricted to [tLo, tHi], or -1 when
 * the ray does not overlap the box inside that range. `dir` must be normalized,
 * so the returned value is a distance. A ray starting inside the box returns
 * `tLo`, which is what makes the same function answer both "how far to the
 * nearest surface" and "does this segment touch the box at all".
 */
export function rayAabbEntry(
  origin: Vec3Like,
  dir: Vec3Like,
  box: AABB,
  tLo: number,
  tHi: number,
): number {
  let tMin = tLo;
  let tMax = tHi;
  for (const axis of AXES) {
    const d = dir[axis];
    const o = origin[axis];
    const lo = box.min[axis];
    const hi = box.max[axis];
    if (Math.abs(d) < MIN_DIRECTION_COMPONENT) {
      if (o < lo || o > hi) return -1;
      continue;
    }
    const inv = 1 / d;
    let near = (lo - o) * inv;
    let far = (hi - o) * inv;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > tMin) tMin = near;
    if (far < tMax) tMax = far;
    if (tMin > tMax) return -1;
  }
  return tMin;
}

/** Entry parameter of a ray against a sphere, restricted to [tLo, tHi], or -1. */
export function raySphereEntry(
  origin: Vec3Like,
  dir: Vec3Like,
  center: Vec3Like,
  radius: number,
  tLo: number,
  tHi: number,
): number {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return -1;
  const root = Math.sqrt(discriminant);
  const far = -b + root;
  if (far < tLo) return -1;
  const near = -b - root;
  const entry = near < tLo ? tLo : near;
  return entry > tHi ? -1 : entry;
}

/** Distance to the nearest blocker along a ray, or -1 when nothing is hit. */
export function nearestBlockerEntry(
  blockers: readonly AABB[],
  origin: Vec3Like,
  dir: Vec3Like,
  tLo: number,
  tHi: number,
): number {
  let nearest = -1;
  for (const blocker of blockers) {
    const t = rayAabbEntry(origin, dir, blocker, tLo, tHi);
    if (t < 0) continue;
    if (nearest < 0 || t < nearest) nearest = t;
  }
  return nearest;
}

/** Closest point of a box to `point`, written into `out`. */
export function closestPointOnAabb(box: AABB, point: Vec3Like, out: MutableVec3): void {
  out.x = Math.min(Math.max(point.x, box.min.x), box.max.x);
  out.y = Math.min(Math.max(point.y, box.min.y), box.max.y);
  out.z = Math.min(Math.max(point.z, box.min.z), box.max.z);
}

export function aabbCenter(box: AABB, out: MutableVec3): void {
  out.x = (box.min.x + box.max.x) * 0.5;
  out.y = (box.min.y + box.max.y) * 0.5;
  out.z = (box.min.z + box.max.z) * 0.5;
}

export function containsPoint(box: AABB, point: Vec3Like): boolean {
  return (
    point.x >= box.min.x &&
    point.x <= box.max.x &&
    point.y >= box.min.y &&
    point.y <= box.max.y &&
    point.z >= box.min.z &&
    point.z <= box.max.z
  );
}

export function distanceBetween(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const segmentDir: MutableVec3 = { x: 0, y: 0, z: 0 };

/**
 * Whether any blocker interrupts the segment from `from` to `to`. Both ends are
 * pulled in by `shrink` so a blocker that merely touches an endpoint, such as
 * the floor under the viewer or the surface of the object being looked at, does
 * not count as occlusion. A blocker containing `ignoreContaining` is skipped,
 * which is how an inspectable that is also its own collider stays visible.
 */
export function segmentBlocked(
  blockers: readonly AABB[],
  from: Vec3Like,
  to: Vec3Like,
  shrink: number,
  ignoreContaining: Vec3Like | null,
): boolean {
  segmentDir.x = to.x - from.x;
  segmentDir.y = to.y - from.y;
  segmentDir.z = to.z - from.z;
  const length = Math.sqrt(
    segmentDir.x * segmentDir.x + segmentDir.y * segmentDir.y + segmentDir.z * segmentDir.z,
  );
  const tHi = length - shrink;
  if (tHi <= shrink) return false;
  segmentDir.x /= length;
  segmentDir.y /= length;
  segmentDir.z /= length;

  for (const blocker of blockers) {
    if (ignoreContaining !== null && containsPoint(blocker, ignoreContaining)) continue;
    if (rayAabbEntry(from, segmentDir, blocker, shrink, tHi) >= 0) return true;
  }
  return false;
}

/** Both ends of a sight line are pulled in by this much before occlusion tests. */
export const SIGHT_LINE_EPSILON_M = 0.02;

const sightNearest: MutableVec3 = { x: 0, y: 0, z: 0 };
const sightCentre: MutableVec3 = { x: 0, y: 0, z: 0 };

/** Metres from `eye` to the nearest point of `bounds`, the gameplay distance. */
export function distanceToBounds(eye: Vec3Like, bounds: AABB): number {
  closestPointOnAabb(bounds, eye, sightNearest);
  return distanceBetween(eye, sightNearest);
}

/**
 * Coarse line of sight from an eye to a target's bounds. The nearest surface
 * point and the centre are each tested against every blocker, and one clear
 * segment is enough: a blocker that fully occludes the target fails both, while
 * a shelf clipping one corner fails neither. A blocker containing the centre is
 * the target's own collider and is discounted.
 *
 * The client reticle and the authoritative validator both call this, so what
 * the HUD offers and what the authority accepts cannot drift apart.
 */
export function boundsVisibleFrom(
  blockers: readonly AABB[],
  eye: Vec3Like,
  bounds: AABB,
  epsilon = SIGHT_LINE_EPSILON_M,
): boolean {
  aabbCenter(bounds, sightCentre);
  closestPointOnAabb(bounds, eye, sightNearest);
  if (!segmentBlocked(blockers, eye, sightNearest, epsilon, sightCentre)) return true;
  return !segmentBlocked(blockers, eye, sightCentre, epsilon, sightCentre);
}
