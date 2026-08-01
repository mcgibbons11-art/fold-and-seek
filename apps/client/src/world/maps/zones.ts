import * as THREE from "three/webgpu";

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
  readonly bounds: THREE.Box3;
  /** Framing used by the map viewer and by the baseline scan route. */
  readonly camera: ZoneCamera;
}

function volume(minX: number, minZ: number, maxX: number, maxZ: number, maxY = WALL_HEIGHT): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(minX, 0, minZ), new THREE.Vector3(maxX, maxY, maxZ));
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
export const CABINET_BLOCKS: readonly THREE.Box3[] = [
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
 */
export const NAV_FLOORS: readonly THREE.Box3[] = [
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
export const NAV_ROUTE_SEGMENTS: readonly THREE.Box3[] = NAV_FLOORS.slice(5);

/**
 * Simplified collision proxy for furniture (§10.2). Small clutter is not
 * listed: the Inspector steps around a book stack rather than being blocked by
 * it, and a Mimic is allowed to overlap ordinary props slightly (§10.4).
 */
export const NAV_BLOCKERS: readonly THREE.Box3[] = [
  // A — front window display platform and its east plinth cluster.
  volume(-6.6, -5.4, -0.9, -4.5, 0.35),
  volume(0.4, -5.4, 1.6, -4.6, 1.1),
  // B — clock wall shelf run and the longcase clock.
  volume(-7.4, -3.0, -6.7, 1.8, 2.4),
  volume(-7.4, 1.9, -6.85, 2.15, 2.35),
  // C — armchair, side table, low shelf, umbrella stand.
  volume(-6.9, 3.0, -5.9, 4.0, 1.05),
  volume(-5.7, 3.2, -5.1, 3.8, 0.68),
  volume(-7.4, 4.3, -6.8, 5.4, 1.15),
  volume(-4.4, 4.9, -4.1, 5.3, 0.62),
  // D — counter and back cabinet.
  volume(0.6, 3.6, 3.6, 4.4, 1.08),
  volume(0.4, 5.0, 4.0, 5.4, 2.1),
  // E — the four cabinet blocks.
  ...CABINET_BLOCKS,
  // F — workbench, shelving, crate stack, ladder.
  volume(6.2, -2.0, 7.4, 0.6, 0.95),
  volume(6.6, -4.6, 7.4, -2.6, 2.3),
  volume(4.1, 1.0, 5.1, 2.0, 1.15),
  volume(4.2, -1.4, 4.7, -0.6, 2.2),
  // G — security desk.
  volume(6.4, 3.0, 7.4, 4.4, 0.95),
];

export const SECURITY_OFFICE_BOUNDS: THREE.Box3 = volume(
  OFFICE_MIN_X,
  OFFICE_MIN_Z,
  SHOP_MAX_X - 0.1,
  SHOP_MAX_Z - 0.1,
);

export interface NavSpawnPoints {
  readonly mimic: readonly THREE.Vector3[];
  readonly inspector: readonly THREE.Vector3[];
}

/**
 * Navigation contract shared with the Inspector controller. Boxes only: the
 * blockout deliberately has no navmesh, and the controller resolves movement
 * against walkable floors minus blocked volumes.
 */
export interface NavData {
  readonly floors: readonly THREE.Box3[];
  readonly blockers: readonly THREE.Box3[];
  readonly spawnPoints: NavSpawnPoints;
  /** Inspectors are held here during Forge and may not be entered by a Mimic (§10.4). */
  readonly securityOffice: THREE.Box3;
}

function point(x: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, 0, z);
}

export const NAV_DATA: NavData = {
  floors: NAV_FLOORS,
  blockers: NAV_BLOCKERS,
  spawnPoints: {
    // One legal Mimic start per zone, spread so no two players fold in the
    // same sight line (§5.7).
    mimic: [
      point(-5.5, -3.8),
      point(-6.0, 0.0),
      point(-5.0, 3.6),
      point(2.0, 2.9),
      point(0.0, -0.5),
      point(5.5, -3.0),
    ],
    // Inspection entry points: the street door and the office door approach.
    inspector: [point(1.0, -4.0), point(3.0, 4.6), point(-3.0, 4.6)],
  },
  securityOffice: SECURITY_OFFICE_BOUNDS,
};

/** True when two boxes share interior space or a common edge in the XZ plane. */
export function floorsAdjacent(a: THREE.Box3, b: THREE.Box3, epsilon = 0.001): boolean {
  return (
    a.min.x <= b.max.x + epsilon &&
    b.min.x <= a.max.x + epsilon &&
    a.min.z <= b.max.z + epsilon &&
    b.min.z <= a.max.z + epsilon
  );
}

/** True when a point stands on one of the walkable boxes, ignoring height. */
export function isOnFloor(nav: NavData, x: number, z: number): boolean {
  return nav.floors.some((box) => x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z);
}

/** True when a point is inside a blocked volume, ignoring height. */
export function isBlocked(nav: NavData, x: number, z: number): boolean {
  return nav.blockers.some((box) => x > box.min.x && x < box.max.x && z > box.min.z && z < box.max.z);
}
