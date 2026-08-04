import type { AABB } from "./navData";

/**
 * Floorplan of The Curiosity Shop (bible §10.2) as plain data: room extents,
 * the six authored zones plus the Security Office, and the navigation volumes
 * the Inspector controller consumes.
 *
 * Nothing here builds geometry, so the layout, the object registry and the
 * navigation contract can all be checked without a graphics device.
 *
 * Axes: +X east, +Z south, origin at the centre of the sales floor. The shop
 * front and its window face north (-Z) onto the street.
 */

export const SHOP_MIN_X = -7.5;
export const SHOP_MAX_X = 7.5;
export const SHOP_MIN_Z = -5.5;
export const SHOP_MAX_Z = 5.5;
export const WALL_HEIGHT = 3.6;
export const WALL_THICKNESS = 0.18;
export const FLOOR_THICKNESS = 0.08;

/** Shop window bay in the north wall, the only source of moonlight (§10.2). */
export const WINDOW_MIN_X = -6.6;
export const WINDOW_MAX_X = -0.9;
export const WINDOW_SILL_Y = 0.55;
export const WINDOW_HEAD_Y = 2.9;

/** Street door, east of the window bay. */
export const DOOR_MIN_X = 0.3;
export const DOOR_MAX_X = 1.7;
export const DOOR_HEIGHT = 2.35;

/** Partition that makes the Security Office visually separate (§5.7). */
export const OFFICE_MIN_X = 4.8;
export const OFFICE_MIN_Z = 2.2;
export const OFFICE_DOOR_MIN_Z = 3.1;
export const OFFICE_DOOR_MAX_Z = 4.1;

/** Narrowest aisle the navigation contract allows: two Inspectors abreast. */
export const MIN_AISLE_WIDTH = 1.2;

// ---------------------------------------------------------------------------
// The gallery (2026-08-04 room expansion)
// ---------------------------------------------------------------------------

/**
 * Wall-hung mezzanine walkways around the shop at gallery height, the room's
 * second storey. Constants live here because the visual deck (client
 * architecture builder), the walkable surfaces and blockers (`nav.ts`) and the
 * prop placements standing on the deck must all agree on the same numbers.
 *
 * The deck top clears the tallest wall furniture beneath it (the counter's
 * drawer cabinet at 2.1, the workshop rack's 2.3 uprights) while leaving a
 * standing body of headroom below the 3.6 ceiling.
 */
export const GALLERY_TOP_Y = 2.42;
export const GALLERY_THICKNESS = 0.08;

/** Inner faces of the shell the deck legs hang from. */
const WALL_INNER_WEST = SHOP_MIN_X + WALL_THICKNESS;
const WALL_INNER_EAST = SHOP_MAX_X - WALL_THICKNESS;
const WALL_INNER_NORTH = SHOP_MIN_Z + WALL_THICKNESS;
const WALL_INNER_SOUTH = SHOP_MAX_Z - WALL_THICKNESS;

export interface GalleryLeg {
  readonly id: string;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/**
 * The five deck legs. The west run is split around the longcase clock, whose
 * hood rises through the gallery like a tower through a floor; the south run
 * stops where the counter's drawer cabinet takes over as the high route, and
 * everything keeps clear of the Security Office airspace, which is forbidden
 * to Mimics at every height (§10.4).
 */
export const GALLERY_LEGS: readonly GalleryLeg[] = [
  { id: "gallery_west_a", minX: WALL_INNER_WEST, minZ: -5.3, maxX: WALL_INNER_WEST + 0.42, maxZ: 1.85 },
  { id: "gallery_west_b", minX: WALL_INNER_WEST, minZ: 2.2, maxX: WALL_INNER_WEST + 0.42, maxZ: 4.94 },
  { id: "gallery_south", minX: WALL_INNER_WEST, minZ: WALL_INNER_SOUTH - 0.42, maxX: 0.35, maxZ: WALL_INNER_SOUTH },
  { id: "gallery_north_east", minX: 1.75, minZ: WALL_INNER_NORTH, maxX: WALL_INNER_EAST, maxZ: WALL_INNER_NORTH + 0.44 },
  { id: "gallery_east", minX: WALL_INNER_EAST - 0.42, minZ: -2.55, maxX: WALL_INNER_EAST, maxZ: 2.1 },
];

/**
 * Ceiling beams, lowered from the ceiling slab so a player can stand on them:
 * the top face leaves standing headroom under the 3.6 ceiling, and the beams
 * are the only bridge between the west and east galleries.
 */
export const CEILING_BEAM_ZS = [-3.6, -1.2, 1.2, 3.6] as const;
export const CEILING_BEAM_TOP_Y = 3.13;
export const CEILING_BEAM_HEIGHT = 0.26;
export const CEILING_BEAM_DEPTH = 0.22;

// ---------------------------------------------------------------------------
// The Curio Annex (2026-08-04 room expansion)
// ---------------------------------------------------------------------------

/**
 * A curtained salon alcove in the reading nook's south-east reach: two tall
 * folding screens close its west and north sides against the south wall, the
 * east side stays open behind a drape. The screens are shell architecture
 * (they block movement and sight), so their boxes live here where `nav.ts`
 * and the client builder both read them.
 */
export const ANNEX_SCREEN_HEIGHT = 1.7;
export const ANNEX_SCREEN_WEST: AABB = {
  min: { x: -2.38, y: 0, z: 3.45 },
  max: { x: -2.28, y: ANNEX_SCREEN_HEIGHT, z: WALL_INNER_SOUTH },
};
export const ANNEX_SCREEN_NORTH: AABB = {
  min: { x: -2.28, y: 0, z: 3.4 },
  max: { x: -0.85, y: ANNEX_SCREEN_HEIGHT, z: 3.5 },
};

export type ZoneId =
  | "front_window"
  | "clock_wall"
  | "cabinet_maze"
  | "reading_nook"
  | "collectors_counter"
  | "back_workshop"
  | "security_office";

export interface ZoneCamera {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

export interface MapZone {
  readonly id: ZoneId;
  /** Zone letter used by §10.2 and by the verification screenshots. */
  readonly letter: string;
  readonly label: string;
  /** Landmark the zone is read by from across the room (§10.2 navigation). */
  readonly landmark: string;
  /** Ambience bed id for the audio streaming pass (§16.4). */
  readonly ambienceId: string;
  readonly bounds: AABB;
  /** Framing used by the map viewer and by the baseline scan route. */
  readonly camera: ZoneCamera;
}

function volume(minX: number, minZ: number, maxX: number, maxZ: number, maxY = WALL_HEIGHT): AABB {
  return { min: { x: minX, y: 0, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/**
 * The zones tile the sales floor: every prop falls inside exactly one, which is
 * what lets zone bounds drive streaming, ambience and occlusion culling later.
 */
export const ZONES: readonly MapZone[] = [
  {
    id: "front_window",
    letter: "a",
    label: "Front Window",
    landmark: "lit window bay with three mannequins",
    ambienceId: "amb_street_moon",
    bounds: volume(SHOP_MIN_X, SHOP_MIN_Z, 3.9, -3.2),
    camera: { position: [-4.15, 1.85, 0.2], target: [-4.6, 1.0, -5.0] },
  },
  {
    id: "clock_wall",
    letter: "b",
    label: "Clock Wall",
    landmark: "longcase clock under the sconces",
    ambienceId: "amb_clock_ticks",
    bounds: volume(SHOP_MIN_X, -3.2, -4.6, 2.2),
    camera: { position: [-2.6, 1.85, -0.5], target: [-7.2, 1.5, -0.5] },
  },
  {
    id: "cabinet_maze",
    letter: "e",
    label: "Cabinet Maze",
    landmark: "four lit glass cabinets around a crossing",
    ambienceId: "amb_glass_hum",
    bounds: volume(-4.6, -3.2, 3.9, 2.2),
    camera: { position: [-4.2, 1.9, -3.0], target: [1.2, 1.0, 0.6] },
  },
  {
    id: "reading_nook",
    letter: "c",
    label: "Reading Nook",
    landmark: "burgundy armchair on the midnight rug",
    ambienceId: "amb_nook_settle",
    bounds: volume(SHOP_MIN_X, 2.2, -0.2, SHOP_MAX_Z),
    camera: { position: [-2.2, 1.7, 2.1], target: [-6.2, 0.9, 4.2] },
  },
  {
    id: "collectors_counter",
    letter: "d",
    label: "Collector's Counter",
    landmark: "brass register on the walnut counter",
    ambienceId: "amb_counter_paper",
    bounds: volume(-0.2, 2.2, OFFICE_MIN_X, SHOP_MAX_Z),
    camera: { position: [0.1, 1.75, 1.5], target: [2.6, 1.05, 4.6] },
  },
  {
    id: "back_workshop",
    letter: "f",
    label: "Back Workshop",
    landmark: "workbench under two task lights",
    ambienceId: "amb_workshop_creak",
    bounds: volume(3.9, SHOP_MIN_Z, SHOP_MAX_X, OFFICE_MIN_Z),
    camera: { position: [3.4, 1.9, 2.4], target: [6.6, 1.0, -1.6] },
  },
  {
    id: "security_office",
    letter: "g",
    label: "Security Office",
    landmark: "monitor desk behind the glazed partition",
    ambienceId: "amb_office_hum",
    bounds: volume(OFFICE_MIN_X, OFFICE_MIN_Z, SHOP_MAX_X, SHOP_MAX_Z),
    camera: { position: [5.2, 1.85, 2.9], target: [6.9, 1.0, 4.3] },
  },
];

const zonesById = new Map<ZoneId, MapZone>(ZONES.map((zone) => [zone.id, zone]));

export function zoneById(id: ZoneId): MapZone {
  const zone = zonesById.get(id);
  if (zone === undefined) {
    throw new Error(`Curiosity Shop: unknown zone "${id}"`);
  }
  return zone;
}

/**
 * Cabinet island of zone E. Four blocks around a crossing: the aisles between
 * them are the two cross-connections §10.2 asks for, and the ring around them
 * is the circular main route.
 */
export const CABINET_BLOCKS: readonly AABB[] = [
  volume(-3.3, -1.9, -0.65, -1.15, 2.05),
  volume(0.65, -1.9, 2.6, -1.15, 2.05),
  volume(-3.3, 0.15, -0.65, 0.9, 2.05),
  volume(0.65, 0.15, 2.6, 0.9, 2.05),
];

/**
 * Walkable floor as axis-aligned boxes. The four ring segments plus the two
 * crossing aisles form the circular route; the remaining boxes are the zone
 * rooms the ring connects. Boxes share edges where they meet, so an adjacency
 * walk over the list visits every one.
 *
 * This is the plan only. `nav.ts` turns it into the level-0 surfaces of the
 * navigation contract and adds the elevated topology on top of it.
 */
export const FLOOR_PLAN: readonly AABB[] = [
  // Zone rooms.
  volume(SHOP_MIN_X + 0.1, SHOP_MIN_Z + 0.1, 3.9, -3.2),
  volume(SHOP_MIN_X + 0.1, -3.2, -4.6, 2.2),
  volume(SHOP_MIN_X + 0.1, 2.2, -0.2, SHOP_MAX_Z - 0.1),
  volume(-0.2, 2.2, OFFICE_MIN_X, SHOP_MAX_Z - 0.1),
  volume(3.9, SHOP_MIN_Z + 0.1, SHOP_MAX_X - 0.1, OFFICE_MIN_Z),
  // Circular main route around the cabinet island.
  volume(-4.6, -3.2, 3.9, -1.9),
  volume(-4.6, 0.9, 3.9, 2.2),
  volume(-4.6, -3.2, -3.3, 2.2),
  volume(2.6, -3.2, 3.9, 2.2),
  // Cross-connections through the island.
  volume(-0.65, -1.9, 0.65, 0.9),
  volume(-3.3, -1.15, 2.6, 0.15),
];

/**
 * Ring and crossing segments, kept separately so the aisle-width and
 * keep-clear rules can be asserted against exactly the route that matters.
 */
export const NAV_ROUTE_SEGMENTS: readonly AABB[] = FLOOR_PLAN.slice(5);

export const SECURITY_OFFICE_BOUNDS: AABB = volume(
  OFFICE_MIN_X,
  OFFICE_MIN_Z,
  SHOP_MAX_X - 0.1,
  SHOP_MAX_Z - 0.1,
);

/** True when two boxes share interior space or a common edge in the XZ plane. */
export function floorsAdjacent(a: AABB, b: AABB, epsilon = 0.001): boolean {
  return (
    a.min.x <= b.max.x + epsilon &&
    b.min.x <= a.max.x + epsilon &&
    a.min.z <= b.max.z + epsilon &&
    b.min.z <= a.max.z + epsilon
  );
}
