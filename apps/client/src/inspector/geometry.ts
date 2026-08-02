/**
 * The small amount of ray and box maths the Inspector system needs. It lives in
 * `@foldseek/map-data` so the client raycasts and the authoritative
 * `SpatialValidator` on the dedicated server run the same functions; this file
 * is the client's name for it.
 */

export {
  aabbCenter,
  boundsVisibleFrom,
  closestPointOnAabb,
  containsPoint,
  distanceBetween,
  distanceToBounds,
  nearestBlockerEntry,
  rayAabbEntry,
  raySphereEntry,
  segmentBlocked,
  SIGHT_LINE_EPSILON_M,
} from "@foldseek/map-data";
