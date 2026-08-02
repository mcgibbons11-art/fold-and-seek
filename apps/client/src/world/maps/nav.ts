/**
 * Navigation for The Curiosity Shop at its true scale (§26.5). It lives in
 * `@foldseek/map-data` so the dedicated Colyseus server can hand the same
 * floors and blockers to its `SpatialValidatorImpl` as the Portals host does;
 * this file is the client's name for it.
 */

export {
  climbRise,
  isElevated,
  CLIMB_LINKS,
  CLUTTER_BLOCKERS,
  MAX_LADDER_RISE,
  MAX_MANTLE_RISE,
  MIMIC_NAV_BLOCKERS,
  MIMIC_NAV_DATA,
  MIN_LEDGE_DEPTH,
  NAV_BLOCKERS,
  NAV_DATA,
  OFFICE_DOOR_BLOCKER,
  SECURITY_OFFICE,
  SPAWN_POINTS,
  WALKABLE_SURFACES,
} from "@foldseek/map-data";
