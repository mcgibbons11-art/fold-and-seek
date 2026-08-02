/**
 * The navigation contract between the map module and the Inspector character
 * system (§26.5). It now lives in `@foldseek/map-data`, because the dedicated
 * Colyseus server needs the same boxes and cannot import anything out of a
 * browser bundle. This file is the client's name for it, so every existing
 * import path still resolves.
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
} from "@foldseek/map-data";
