/**
 * The real SpatialValidator the simulation asks about geometry (§28.4, §28.5).
 * It lives in `@foldseek/map-data`, which is what lets the dedicated Colyseus
 * server and the host-elected Portals client run identical code; this file is
 * the client's name for it.
 */

export {
  SpatialValidatorImpl,
  OCCUPANCY_DROP_M,
  OCCUPANCY_PENETRATION_M,
  OCCUPANCY_RISE_M,
  type SpatialRejectionReason,
  type SpatialValidatorDeps,
} from "@foldseek/map-data";
