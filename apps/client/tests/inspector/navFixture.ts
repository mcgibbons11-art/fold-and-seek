import { DEFAULT_MATCH_SETTINGS, type MatchSettings } from "@foldseek/shared";

import type { AABB, ClimbLink, NavData, WalkableSurface } from "../../src/inspector/navData";

/**
 * A shop corner at true scale with a tiny player in it: a floor, one wall, a
 * table that towers more than twice the player's height, a shelf above that,
 * and a crawl space too low to stand in. Every nav test uses it, so the
 * expected geometry is stated once.
 */

export function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): AABB {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

export function surface(
  id: string,
  bounds: AABB,
  level: number,
  clearance?: number,
): WalkableSurface {
  return clearance === undefined ? { id, bounds, level } : { id, bounds, level, clearance };
}

/** The shop floor stops at x = 3, so the crawl spaces are the only way past. */
export const SHOP_FLOOR = surface("floor", box(-5, -0.1, -5, 3, 0, 5), 0);
export const TABLE_TOP = surface("table", box(-3, 0.7, -1, -1, 0.75, 1), 1);
export const SHELF_TOP = surface("shelf", box(-4.5, 1.15, 2, -4, 1.2, 3), 2);

/** Headroom under the furniture, which a 0.35 m player clears easily. */
export const OPEN_CRAWL = surface("crawl_open", box(3, -0.1, -1, 4.5, 0, 1), 0, 0.5);
/** Too low to stand in, and there is no crouch, so it may as well be a wall. */
export const TIGHT_CRAWL = surface("crawl_tight", box(3, -0.1, 2, 4.5, 0, 4), 0, 0.2);

export const WALL = box(1, 0, -5, 1.2, 2.4, 5);
/** The table's top slab. A tiny player walks underneath it, never into it. */
export const TABLE_SLAB = box(-3, 0.7, -1, -1, 0.75, 1);

export const MANTLE_TO_TABLE: ClimbLink = {
  from: "floor",
  to: "table",
  kind: "mantle",
  position: { x: -1, y: 0, z: 0 },
  target: { x: -1.3, y: 0.75, z: 0 },
};

/** Rises in place, so it is usable whichever way the player happens to face. */
export const LADDER_TO_SHELF: ClimbLink = {
  from: "floor",
  to: "shelf",
  kind: "ladder",
  position: { x: -4.25, y: 0, z: 2.5 },
  target: { x: -4.25, y: 1.2, z: 2.5 },
};

export function testNavData(overrides: Partial<NavData> = {}): NavData {
  return {
    floors: [SHOP_FLOOR, TABLE_TOP, SHELF_TOP, OPEN_CRAWL, TIGHT_CRAWL],
    groundPlane: SHOP_FLOOR.bounds,
    blockers: [WALL, TABLE_SLAB],
    climbLinks: [MANTLE_TO_TABLE, LADDER_TO_SHELF],
    spawnPoints: {
      inspectors: [{ position: { x: 0, y: 0, z: 0 }, yaw: 0 }],
      mimics: [{ position: { x: -3, y: 0, z: -3 }, yaw: 0 }],
    },
    securityOffice: box(-5, 0, -5, -3, 2.4, -3),
    ...overrides,
  };
}

/** Nothing to bump into, for the movement tests that measure raw distance. */
export function openNavData(): NavData {
  return testNavData({ floors: [SHOP_FLOOR], blockers: [], climbLinks: [] });
}

export function testSettings(overrides: Partial<MatchSettings> = {}): MatchSettings {
  return { ...DEFAULT_MATCH_SETTINGS, ...overrides };
}

/** Yaw that points the Inspector along +X, which is straight at the wall. */
export const YAW_TOWARD_WALL = -Math.PI / 2;
/** Yaw that points the Inspector along -X, which is toward the table. */
export const YAW_TOWARD_TABLE = Math.PI / 2;
