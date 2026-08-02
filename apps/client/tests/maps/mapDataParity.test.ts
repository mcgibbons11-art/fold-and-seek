import {
  CURIOSITY_SHOP_RECORDS,
  NAV_DATA as PACKAGE_NAV_DATA,
  PROP_FOCUS_BOUNDS,
  SHOP_PLACEMENTS as PACKAGE_PLACEMENTS,
  ZONES as PACKAGE_ZONES,
  buildObjectRegistry as packageRegistry,
} from "@foldseek/map-data";
import { describe, expect, it } from "vitest";

import { NAV_DATA } from "../../src/world/maps/nav";
import { SHOP_PLACEMENTS } from "../../src/world/maps/placements";
import {
  CURIOSITY_SHOP_OBJECTS,
  buildObjectRegistry,
} from "../../src/world/maps/registry";
import { ZONES } from "../../src/world/maps/zones";

/**
 * The map now has two faces and one set of numbers.
 *
 * `@foldseek/map-data` holds the shop as plain data, because the dedicated
 * Colyseus server validates shots against it in Node and cannot import Three.js.
 * The client wraps the same records in `Box3` and `Vector3` for the focus system
 * and the renderer. If those two ever disagree, the box an authority refuses a
 * shot outside stops being the box the reticle brackets, and a player is told
 * they are aiming at something the server says they are not.
 *
 * That is the failure this file exists to catch, and it is why the comparison
 * is field by field rather than a spot check.
 */

describe("client and server read one map", () => {
  it("hands both authorities the same props in the same order", () => {
    expect(CURIOSITY_SHOP_OBJECTS).toHaveLength(CURIOSITY_SHOP_RECORDS.length);
    expect(CURIOSITY_SHOP_OBJECTS.map((entry) => entry.objectId)).toEqual(
      CURIOSITY_SHOP_RECORDS.map((entry) => entry.objectId),
    );
  });

  it("gives every prop the same focus box on both faces", () => {
    for (const [index, record] of CURIOSITY_SHOP_RECORDS.entries()) {
      const entry = CURIOSITY_SHOP_OBJECTS[index];
      const label = record.objectId;
      expect(entry, label).toBeDefined();
      if (!entry) continue;

      expect(entry.focusBounds.min.toArray(), `${label} min`).toEqual([
        record.focusBounds.min.x,
        record.focusBounds.min.y,
        record.focusBounds.min.z,
      ]);
      expect(entry.focusBounds.max.toArray(), `${label} max`).toEqual([
        record.focusBounds.max.x,
        record.focusBounds.max.y,
        record.focusBounds.max.z,
      ]);
      expect(entry.position.toArray(), `${label} origin`).toEqual([...record.position]);
    }
  });

  it("carries every other field across untouched", () => {
    // Identity, category, zone, policy, reaction, swatches and LOD group: the
    // client adds a Three.js face to a record and must change nothing else.
    const geometry = new Set(["position", "focusBounds"]);
    const withoutGeometry = (source: object): Record<string, unknown> =>
      Object.fromEntries(Object.entries(source).filter(([key]) => !geometry.has(key)));

    for (const [index, record] of CURIOSITY_SHOP_RECORDS.entries()) {
      const entry = CURIOSITY_SHOP_OBJECTS[index];
      if (!entry) continue;
      expect(withoutGeometry(entry), record.objectId).toEqual(withoutGeometry(record));
    }
  });

  it("looks a prop up by the same box the server's validator will use", () => {
    // PROP_FOCUS_BOUNDS is what `RoomSpatialBridge.boundsOf` answers from, so
    // this is the client's bracket against the server's target, directly.
    for (const entry of CURIOSITY_SHOP_OBJECTS) {
      const bounds = PROP_FOCUS_BOUNDS.get(entry.objectId);
      expect(bounds, entry.objectId).toBeDefined();
      if (!bounds) continue;
      expect(entry.focusBounds.min.toArray(), entry.objectId).toEqual([
        bounds.min.x,
        bounds.min.y,
        bounds.min.z,
      ]);
      expect(entry.focusBounds.max.toArray(), entry.objectId).toEqual([
        bounds.max.x,
        bounds.max.y,
        bounds.max.z,
      ]);
    }
  });

  it("publishes one object registry, whichever side asks for it", () => {
    expect(buildObjectRegistry()).toEqual(packageRegistry());
  });

  it("walks both authorities on the same floors and blockers", () => {
    // Identity rather than equality: the client's `world/maps/nav` is a
    // re-export, so anything that made it a copy would be a second source of
    // truth waiting to drift.
    expect(NAV_DATA).toBe(PACKAGE_NAV_DATA);
    expect(SHOP_PLACEMENTS).toBe(PACKAGE_PLACEMENTS);
    expect(ZONES).toBe(PACKAGE_ZONES);
  });

  it("keeps the zone boxes readable as plain min and max", () => {
    // The zones stopped being `THREE.Box3` when they moved into the package.
    // Nothing ever called a Box3 method on one, and this says so: every reader
    // in the client takes these two fields and nothing else.
    for (const zone of ZONES) {
      for (const corner of [zone.bounds.min, zone.bounds.max]) {
        expect(Number.isFinite(corner.x), zone.id).toBe(true);
        expect(Number.isFinite(corner.y), zone.id).toBe(true);
        expect(Number.isFinite(corner.z), zone.id).toBe(true);
      }
      expect(zone.bounds.max.x).toBeGreaterThan(zone.bounds.min.x);
      expect(zone.bounds.max.z).toBeGreaterThan(zone.bounds.min.z);
    }
  });
});
