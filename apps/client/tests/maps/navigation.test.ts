import type { Box3 } from "three";
import { describe, expect, it } from "vitest";

import type { AABB, ClimbLink, WalkableSurface } from "../../src/inspector/navData";
import {
  blocksCapsule,
  containsXZ,
  fitsUnder,
  surfaceAt,
  WORLD_SCALE,
} from "../../src/inspector/navData";
import {
  climbRise,
  isElevated,
  MAX_LADDER_RISE,
  MAX_MANTLE_RISE,
  MIN_LEDGE_DEPTH,
  NAV_DATA,
} from "../../src/world/maps/nav";
import { SHOP_PLACEMENTS } from "../../src/world/maps/placements";
import {
  FLOOR_PLAN,
  floorsAdjacent,
  MIN_AISLE_WIDTH,
  NAV_ROUTE_SEGMENTS,
  SHOP_MAX_X,
  SHOP_MAX_Z,
  SHOP_MIN_X,
  SHOP_MIN_Z,
  WALL_HEIGHT,
  ZONES,
} from "../../src/world/maps/zones";

const CEILING = WALL_HEIGHT;

function overlapsInPlan(a: Box3 | AABB, b: Box3 | AABB): boolean {
  return (
    a.min.x < b.max.x - 1e-6 &&
    b.min.x < a.max.x - 1e-6 &&
    a.min.z < b.max.z - 1e-6 &&
    b.min.z < a.max.z - 1e-6
  );
}

/** Walks the floorplan boxes as a graph, treating shared edges as connections. */
function connectedFloorCount(floors: readonly Box3[]): number {
  if (floors.length === 0) {
    return 0;
  }
  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) {
      break;
    }
    const currentBox = floors[current];
    if (currentBox === undefined) {
      continue;
    }
    for (let i = 0; i < floors.length; i += 1) {
      const candidate = floors[i];
      if (seen.has(i) || candidate === undefined) {
        continue;
      }
      if (floorsAdjacent(currentBox, candidate)) {
        seen.add(i);
        queue.push(i);
      }
    }
  }
  return seen.size;
}

const surfacesById = new Map<string, WalkableSurface>(
  NAV_DATA.floors.map((surface) => [surface.id, surface]),
);

function surfaceOrFail(id: string): WalkableSurface {
  const surface = surfacesById.get(id);
  if (surface === undefined) {
    throw new Error(`no walkable surface "${id}"`);
  }
  return surface;
}

/** Surfaces a player can actually occupy: the low crawl spaces are excluded. */
const ENTERABLE = NAV_DATA.floors.filter((surface) => fitsUnder(surface));

describe("Curiosity Shop floorplan", () => {
  it("connects every walkable box into one route", () => {
    expect(connectedFloorCount(FLOOR_PLAN)).toBe(FLOOR_PLAN.length);
  });

  it("keeps the circular route and both cross-connections wide enough for two Inspectors", () => {
    expect(NAV_ROUTE_SEGMENTS.length).toBe(6);
    for (const segment of NAV_ROUTE_SEGMENTS) {
      const width = segment.max.x - segment.min.x;
      const depth = segment.max.z - segment.min.z;
      expect(Math.min(width, depth)).toBeGreaterThanOrEqual(MIN_AISLE_WIDTH);
    }
  });

  it("keeps furniture out of the route", () => {
    for (const blocker of NAV_DATA.blockers) {
      for (const segment of NAV_ROUTE_SEGMENTS) {
        expect(overlapsInPlan(blocker, segment)).toBe(false);
      }
    }
  });
});

describe("Curiosity Shop walkable surfaces", () => {
  it("gives every surface a unique id", () => {
    expect(surfacesById.size).toBe(NAV_DATA.floors.length);
  });

  it("keeps every surface inside the shop shell", () => {
    for (const surface of NAV_DATA.floors) {
      const { min, max } = surface.bounds;
      expect(min.x, surface.id).toBeGreaterThanOrEqual(SHOP_MIN_X);
      expect(max.x, surface.id).toBeLessThanOrEqual(SHOP_MAX_X);
      expect(min.z, surface.id).toBeGreaterThanOrEqual(SHOP_MIN_Z);
      expect(max.z, surface.id).toBeLessThanOrEqual(SHOP_MAX_Z);
      expect(max.y, surface.id).toBeLessThan(CEILING);
    }
  });

  it("builds a room with an upstairs rather than one flat floor", () => {
    const elevated = ENTERABLE.filter(isElevated);
    expect(elevated.length).toBeGreaterThanOrEqual(24);
    // Tabletops, counter, shelf ledges, chair seats and the sill all appear.
    const levels = new Set(elevated.map((surface) => surface.level));
    expect(levels.size).toBeGreaterThanOrEqual(4);
    expect(Math.max(...elevated.map((surface) => surface.bounds.max.y))).toBeGreaterThan(2);
  });

  it("spreads elevated ground across the shop rather than into one corner", () => {
    const shopZones = ZONES.filter((zone) => zone.id !== "cabinet_maze");
    for (const zone of shopZones) {
      const inZone = ENTERABLE.filter(
        (surface) =>
          isElevated(surface) &&
          overlapsInPlan(surface.bounds, { min: zone.bounds.min, max: zone.bounds.max }),
      );
      expect(inZone.length, `zone ${zone.letter} elevated ledges`).toBeGreaterThan(0);
    }
  });

  it("makes every ledge at least as wide as the player", () => {
    for (const surface of ENTERABLE.filter(isElevated)) {
      const width = surface.bounds.max.x - surface.bounds.min.x;
      const depth = surface.bounds.max.z - surface.bounds.min.z;
      expect(Math.min(width, depth), surface.id).toBeGreaterThanOrEqual(MIN_LEDGE_DEPTH - 1e-6);
    }
  });

  it("authors crawl spaces under furniture, and refuses the ones that are too low", () => {
    const crawls = NAV_DATA.floors.filter((surface) => surface.clearance !== undefined);
    expect(crawls.length).toBeGreaterThanOrEqual(4);
    expect(crawls.some(fitsUnder)).toBe(true);
    expect(crawls.some((surface) => !fitsUnder(surface))).toBe(true);
    for (const surface of crawls) {
      expect(surface.clearance, surface.id).toBeGreaterThan(0);
    }
  });

  it("keeps all four display bookcases open and gives each three usable shelves", () => {
    const shelves = NAV_DATA.floors.filter((surface) => /^cabinet_\d+_shelf_\d+$/.test(surface.id));
    expect(shelves).toHaveLength(12);

    for (let cabinet = 1; cabinet <= 4; cabinet += 1) {
      const firstShelf = surfaceOrFail(`cabinet_${cabinet}_shelf_1`);
      const x = (firstShelf.bounds.min.x + firstShelf.bounds.max.x) * 0.5;
      const z = (firstShelf.bounds.min.z + firstShelf.bounds.max.z) * 0.5;
      // Floor-level entry into the bottom bay must be open too. Testing only
      // atop the decorative plinth misses the expanded collision shield that
      // used to stop a player before their feet ever reached that height.
      expect(
        blocksCapsule(NAV_DATA.blockers, x, z, 0),
        `cabinet ${cabinet} still has a sealed collision volume`,
      ).toBe(false);
      for (let shelf = 1; shelf <= 3; shelf += 1) {
        expect(surfaceOrFail(`cabinet_${cabinet}_shelf_${shelf}`)).toBeDefined();
      }
    }
  });
});

describe("Curiosity Shop climb links", () => {
  it("names two real surfaces at every link", () => {
    for (const link of NAV_DATA.climbLinks) {
      expect(surfacesById.has(link.from), `${link.from} -> ${link.to} from`).toBe(true);
      expect(surfacesById.has(link.to), `${link.from} -> ${link.to} to`).toBe(true);
      expect(link.from).not.toBe(link.to);
    }
  });

  it("puts both endpoints on the surfaces they claim", () => {
    for (const link of NAV_DATA.climbLinks) {
      const from = surfaceOrFail(link.from);
      const to = surfaceOrFail(link.to);
      const label = `${link.from} -> ${link.to}`;
      expect(containsXZ(from.bounds, link.position.x, link.position.z), `${label} start`).toBe(true);
      expect(containsXZ(to.bounds, link.target.x, link.target.z), `${label} target`).toBe(true);
      expect(link.position.y, `${label} start height`).toBeCloseTo(from.bounds.max.y, 3);
      expect(link.target.y, `${label} target height`).toBeCloseTo(to.bounds.max.y, 3);
    }
  });

  it("stays inside the budget for its kind, and earns its place", () => {
    for (const link of NAV_DATA.climbLinks) {
      const rise = climbRise(link);
      const label = `${link.from} -> ${link.to} (${link.kind})`;
      const budget: number = link.kind === "mantle" ? MAX_MANTLE_RISE : MAX_LADDER_RISE;
      expect(rise, label).toBeLessThanOrEqual(budget);

      // A link exists to cross something the walker cannot: a rise beyond a
      // step, or a gap wider than the body. The armchair-to-side-table hop is
      // the second kind, level but over open floor.
      const span = Math.hypot(
        link.target.x - link.position.x,
        link.target.z - link.position.z,
      );
      const crossesHeight = rise > WORLD_SCALE.stepHeight;
      const crossesGap = span > WORLD_SCALE.playerRadius * 2;
      expect(crossesHeight || crossesGap, `${label} crosses nothing`).toBe(true);
    }
  });

  it("leaves both endpoints standable rather than inside a prop", () => {
    for (const link of NAV_DATA.climbLinks) {
      const label = `${link.from} -> ${link.to}`;
      expect(
        blocksCapsule(NAV_DATA.blockers, link.position.x, link.position.z, link.position.y),
        `${label} start blocked`,
      ).toBe(false);
      expect(
        blocksCapsule(NAV_DATA.blockers, link.target.x, link.target.z, link.target.y),
        `${label} target blocked`,
      ).toBe(false);
    }
  });

  it("reaches every elevated surface from the shop floor", () => {
    const byFrom = new Map<string, string[]>();
    const connect = (a: string, b: string): void => {
      const list = byFrom.get(a);
      if (list === undefined) {
        byFrom.set(a, [b]);
        return;
      }
      list.push(b);
    };
    for (const link of NAV_DATA.climbLinks) {
      // A link is usable from whichever end the player is standing on.
      connect(link.from, link.to);
      connect(link.to, link.from);
    }

    const reached = new Set(ENTERABLE.filter((surface) => surface.level === 0).map((s) => s.id));
    const queue = [...reached];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) {
        break;
      }
      for (const next of byFrom.get(current) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }

    const stranded = ENTERABLE.filter((surface) => !reached.has(surface.id)).map((s) => s.id);
    expect(stranded).toEqual([]);
  });
});

describe("Curiosity Shop spawns", () => {
  const allSpawns = [
    ...NAV_DATA.spawnPoints.mimics.map((spawn) => ["mimic", spawn] as const),
    ...NAV_DATA.spawnPoints.inspectors.map((spawn) => ["inspector", spawn] as const),
  ];

  it("fields enough starts for a full lobby", () => {
    expect(NAV_DATA.spawnPoints.mimics.length).toBeGreaterThanOrEqual(8);
    expect(NAV_DATA.spawnPoints.inspectors.length).toBeGreaterThanOrEqual(2);
  });

  it("stands every player on a real surface, clear of props", () => {
    for (const [role, spawn] of allSpawns) {
      const label = `${role} ${spawn.position.x},${spawn.position.y},${spawn.position.z}`;
      const surface = surfaceAt(
        NAV_DATA.floors,
        spawn.position.x,
        spawn.position.z,
        spawn.position.y + 1e-3,
      );
      expect(surface, `${label} has ground`).not.toBeNull();
      expect(surface?.bounds.max.y, `${label} stands on its surface`).toBeCloseTo(
        spawn.position.y,
        3,
      );
      expect(
        blocksCapsule(NAV_DATA.blockers, spawn.position.x, spawn.position.z, spawn.position.y),
        `${label} blocked`,
      ).toBe(false);
      expect(Number.isFinite(spawn.yaw), `${label} yaw`).toBe(true);
    }
  });

  it("starts Mimics on the floor and on the furniture", () => {
    const heights = NAV_DATA.spawnPoints.mimics.map((spawn) => spawn.position.y);
    expect(heights.some((y) => y === 0)).toBe(true);
    expect(heights.filter((y) => y > WORLD_SCALE.stepHeight).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps Mimics out of the Security Office and stages Inspectors inside it", () => {
    for (const spawn of NAV_DATA.spawnPoints.mimics) {
      expect(
        containsXZ(NAV_DATA.securityOffice, spawn.position.x, spawn.position.z),
        `mimic at ${spawn.position.x},${spawn.position.z}`,
      ).toBe(false);
    }
    const staged = NAV_DATA.spawnPoints.inspectors.filter((spawn) =>
      containsXZ(NAV_DATA.securityOffice, spawn.position.x, spawn.position.z),
    );
    expect(staged.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Curiosity Shop zones", () => {
  it("places every prop inside the bounds of the zone it declares", () => {
    for (const placement of SHOP_PLACEMENTS) {
      const zone = ZONES.find((candidate) => candidate.id === placement.zoneId);
      expect(zone, placement.objectId).toBeDefined();
      if (zone === undefined) {
        continue;
      }
      const [x, y, z] = placement.position;
      expect(x, `${placement.objectId} x`).toBeGreaterThanOrEqual(zone.bounds.min.x);
      expect(x, `${placement.objectId} x`).toBeLessThanOrEqual(zone.bounds.max.x);
      expect(z, `${placement.objectId} z`).toBeGreaterThanOrEqual(zone.bounds.min.z);
      expect(z, `${placement.objectId} z`).toBeLessThanOrEqual(zone.bounds.max.z);
      expect(y, `${placement.objectId} y`).toBeGreaterThanOrEqual(zone.bounds.min.y);
      expect(y, `${placement.objectId} y`).toBeLessThanOrEqual(zone.bounds.max.y);
    }
  });

  it("covers the whole sales floor with the six shop zones plus the office", () => {
    expect(ZONES.length).toBe(7);
    const area = ZONES.reduce(
      (total, zone) =>
        total + (zone.bounds.max.x - zone.bounds.min.x) * (zone.bounds.max.z - zone.bounds.min.z),
      0,
    );
    const shellArea = (SHOP_MAX_X - SHOP_MIN_X) * (SHOP_MAX_Z - SHOP_MIN_Z);
    expect(area).toBeCloseTo(shellArea, 2);
  });

  it("gives every zone a camera, a landmark and an ambience bed", () => {
    for (const zone of ZONES) {
      expect(zone.landmark.length).toBeGreaterThan(0);
      expect(zone.ambienceId.length).toBeGreaterThan(0);
      expect(zone.camera.position).toHaveLength(3);
      expect(zone.camera.target).toHaveLength(3);
    }
  });
});

/** Guards the one assumption the whole climb graph rests on. */
describe("Curiosity Shop scale", () => {
  it("keeps the player small enough that furniture is architecture", () => {
    expect(WORLD_SCALE.playerHeight).toBeLessThan(0.5);
    const counter = surfaceOrFail("counter_top");
    expect(counter.bounds.max.y / WORLD_SCALE.playerHeight).toBeGreaterThan(2);
  });
});

/** Type-level guard: the map must satisfy the Inspector's contract exactly. */
const _contract: readonly ClimbLink[] = NAV_DATA.climbLinks;
void _contract;
