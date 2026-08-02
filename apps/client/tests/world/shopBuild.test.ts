import { describe, expect, it } from "vitest";

import {
  SHOP_BUILD_RUNS,
  SHOP_BUILD_STEP_COUNT,
} from "../../src/world/maps/CuriosityShop";
import { SHOP_PLACEMENTS } from "../../src/world/maps/placements";
import { ZONES } from "../../src/world/maps/zones";

/**
 * The map is built across several frames so the tab is not stopped for the
 * length of the build. Cutting it into pieces is only safe while the pieces
 * still lay the props down in the authored order: build order is the mesh
 * numbering (§24.6), and a disguise anchored to a surface resolves that surface
 * by the name the build gave it. Regrouping the props to make tidier chunks
 * would rename every hero mesh in the shop.
 *
 * Building the map itself needs a graphics device, so what is checked here is
 * the partition rather than the geometry it produces.
 */
describe("chunked shop build", () => {
  it("lays the props down in exactly the authored order", () => {
    const rebuilt = SHOP_BUILD_RUNS.flatMap((run) => run.placements);

    expect(rebuilt).toHaveLength(SHOP_PLACEMENTS.length);
    expect(rebuilt.map((placement) => placement.objectId)).toEqual(
      SHOP_PLACEMENTS.map((placement) => placement.objectId),
    );
    // Identity, not equality: a run must hand back the authored placement, not
    // a copy of it, or the prop builders are reading a different manifest.
    for (let i = 0; i < rebuilt.length; i += 1) {
      expect(rebuilt[i]).toBe(SHOP_PLACEMENTS[i]);
    }
  });

  it("cuts one run per zone, so a step is something the player can be told", () => {
    expect(SHOP_BUILD_RUNS.length).toBeGreaterThan(1);
    for (const run of SHOP_BUILD_RUNS) {
      expect(run.placements.length).toBeGreaterThan(0);
      expect(run.placements.every((placement) => placement.zoneId === run.zoneId)).toBe(true);
      expect(ZONES.some((zone) => zone.id === run.zoneId)).toBe(true);
    }

    // No zone is split into two runs, which would mean the manifest stopped
    // being written a zone at a time and the labels would repeat.
    const zoneIds = SHOP_BUILD_RUNS.map((run) => run.zoneId);
    expect(new Set(zoneIds).size).toBe(zoneIds.length);
  });

  it("counts the shell and the batcher's finalize alongside the zones", () => {
    expect(SHOP_BUILD_STEP_COUNT).toBe(SHOP_BUILD_RUNS.length + 2);
    // Enough pieces that the frame is handed back often during the build, and
    // few enough that the yields themselves are not the cost.
    expect(SHOP_BUILD_STEP_COUNT).toBeGreaterThanOrEqual(6);
    expect(SHOP_BUILD_STEP_COUNT).toBeLessThanOrEqual(24);
  });
});
