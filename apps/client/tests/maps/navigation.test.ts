import type { Box3 } from "three";
import { describe, expect, it } from "vitest";

import { SHOP_PLACEMENTS } from "../../src/world/maps/placements";
import {
  floorsAdjacent,
  isBlocked,
  isOnFloor,
  MIN_AISLE_WIDTH,
  NAV_DATA,
  NAV_ROUTE_SEGMENTS,
  SHOP_MAX_X,
  SHOP_MAX_Z,
  SHOP_MIN_X,
  SHOP_MIN_Z,
  ZONES,
} from "../../src/world/maps/zones";

function overlapsInPlan(a: Box3, b: Box3): boolean {
  return (
    a.min.x < b.max.x - 1e-6 &&
    b.min.x < a.max.x - 1e-6 &&
    a.min.z < b.max.z - 1e-6 &&
    b.min.z < a.max.z - 1e-6
  );
}

/** Walks the floor boxes as a graph, treating shared edges as connections. */
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

describe("Curiosity Shop navigation data", () => {
  it("connects every walkable box into one route", () => {
    expect(connectedFloorCount(NAV_DATA.floors)).toBe(NAV_DATA.floors.length);
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

  it("spawns every player on open floor", () => {
    const spawns = [...NAV_DATA.spawnPoints.mimic, ...NAV_DATA.spawnPoints.inspector];
    expect(NAV_DATA.spawnPoints.mimic.length).toBeGreaterThanOrEqual(6);
    expect(NAV_DATA.spawnPoints.inspector.length).toBeGreaterThanOrEqual(2);
    for (const spawn of spawns) {
      expect(isOnFloor(NAV_DATA, spawn.x, spawn.z), `${spawn.x},${spawn.z} on floor`).toBe(true);
      expect(isBlocked(NAV_DATA, spawn.x, spawn.z), `${spawn.x},${spawn.z} blocked`).toBe(false);
    }
  });

  it("keeps Mimic spawns out of the Security Office", () => {
    for (const spawn of NAV_DATA.spawnPoints.mimic) {
      expect(NAV_DATA.securityOffice.containsPoint(spawn)).toBe(false);
    }
    expect(NAV_DATA.floors.some((floor) => overlapsInPlan(floor, NAV_DATA.securityOffice))).toBe(false);
  });

  it("keeps every walkable box inside the shop shell", () => {
    for (const floor of NAV_DATA.floors) {
      expect(floor.min.x).toBeGreaterThanOrEqual(SHOP_MIN_X);
      expect(floor.max.x).toBeLessThanOrEqual(SHOP_MAX_X);
      expect(floor.min.z).toBeGreaterThanOrEqual(SHOP_MIN_Z);
      expect(floor.max.z).toBeLessThanOrEqual(SHOP_MAX_Z);
    }
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
