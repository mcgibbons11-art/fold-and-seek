/**
 * The Curiosity Shop as plain data, plus the authoritative geometry checks that
 * read it (§26.5, §28.4).
 *
 * It exists because both authorities need the same map and only one of them has
 * a renderer. The host-elected Portals client reaches it through the browser
 * bundle; the dedicated Colyseus server imports it in Node, where there is no
 * DOM, no WebGL context and no Three.js. Nothing here may therefore touch any of
 * those, and the package's own tsconfig omits the DOM lib so that a slip is a
 * compile error rather than a crash on a server nobody is watching.
 *
 * The client keeps its Three.js face on top of this: `world/maps/registry.ts`
 * builds the same objects with `Box3` and `Vector3` for the focus system and the
 * renderer, calling the arithmetic below rather than repeating it.
 */

export {
  blocksCapsule,
  containsXZ,
  fitsUnder,
  surfaceAt,
  BRISK_WALK_MULTIPLIER,
  INSPECTOR_EYE_HEIGHT_M,
  INSPECTOR_HEIGHT_M,
  INSPECTOR_RADIUS_M,
  INSPECTOR_STEP_HEIGHT_M,
  WORLD_SCALE,
  type AABB,
  type ClimbKind,
  type ClimbLink,
  type MutableVec3,
  type NavData,
  type SpawnPoints,
  type SpawnPose,
  type Vec3Like,
  type WalkableSurface,
} from "./navData";

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
} from "./geometry";

export {
  SpatialValidatorImpl,
  OCCUPANCY_DROP_M,
  OCCUPANCY_PENETRATION_M,
  OCCUPANCY_RISE_M,
  type SpatialRejectionReason,
  type SpatialValidatorDeps,
} from "./SpatialValidatorImpl";

export * from "./zones";
export * from "./placements";
export * from "./nav";

export {
  buildMapObjectRecords,
  buildObjectRegistry,
  focusBoundsFor,
  isInSecurityOffice,
  lodGroupFor,
  policyFor,
  CURIOSITY_SHOP_MAP_ID,
  CURIOSITY_SHOP_RECORDS,
  PROP_FOCUS_BOUNDS,
  type AccusationPolicy,
  type LodGroup,
  type MapObjectRecord,
} from "./objects";
