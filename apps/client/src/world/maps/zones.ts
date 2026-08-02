/**
 * Floorplan of The Curiosity Shop (bible §10.2). It lives in
 * `@foldseek/map-data` so the dedicated server can read the same room extents,
 * zones and navigation volumes without a graphics device; this file is the
 * client's name for it.
 *
 * Zone and floorplan boxes are `AABB` rather than `THREE.Box3`. Nothing has ever
 * called a Box3 method on one — every reader takes `.min` and `.max` — so the
 * two are interchangeable here, and the plain shape is what makes the data
 * importable in Node.
 */

export {
  floorsAdjacent,
  zoneById,
  CABINET_BLOCKS,
  DOOR_HEIGHT,
  DOOR_MAX_X,
  DOOR_MIN_X,
  FLOOR_PLAN,
  FLOOR_THICKNESS,
  MIN_AISLE_WIDTH,
  NAV_ROUTE_SEGMENTS,
  OFFICE_DOOR_MAX_Z,
  OFFICE_DOOR_MIN_Z,
  OFFICE_MIN_X,
  OFFICE_MIN_Z,
  SECURITY_OFFICE_BOUNDS,
  SHOP_MAX_X,
  SHOP_MAX_Z,
  SHOP_MIN_X,
  SHOP_MIN_Z,
  WALL_HEIGHT,
  WALL_THICKNESS,
  WINDOW_HEAD_Y,
  WINDOW_MAX_X,
  WINDOW_MIN_X,
  WINDOW_SILL_Y,
  ZONES,
  type MapZone,
  type ZoneCamera,
  type ZoneId,
} from "@foldseek/map-data";
