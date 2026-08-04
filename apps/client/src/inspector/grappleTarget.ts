import { GRAPPLE_MAX_RANGE_M, GRAPPLE_MIN_RANGE_M } from "@foldseek/shared";

import { rayAabbEntry } from "./geometry";
import type { NavData, Vec3Like } from "./navData";

/** Finds the first solid prop, visual latch, or wall under a ray. Floors are not latches. */
export function grappleTargetFromRay(
  navData: NavData,
  origin: Vec3Like,
  direction: Vec3Like,
): Vec3Like | null {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length < 1e-8) return null;
  const dir = {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
  let nearest = Number.POSITIVE_INFINITY;
  for (const targets of [navData.blockers, navData.grappleTargets ?? []]) {
    for (const target of targets) {
      const entry = rayAabbEntry(origin, dir, target, GRAPPLE_MIN_RANGE_M, GRAPPLE_MAX_RANGE_M);
      if (entry >= GRAPPLE_MIN_RANGE_M && entry < nearest) nearest = entry;
    }
  }
  if (!Number.isFinite(nearest)) return null;
  return {
    x: origin.x + dir.x * nearest,
    y: origin.y + dir.y * nearest,
    z: origin.z + dir.z * nearest,
  };
}
