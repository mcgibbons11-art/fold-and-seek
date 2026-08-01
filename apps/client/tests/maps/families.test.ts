import { describe, expect, it } from "vitest";

import { countByFamily, SHOP_PLACEMENTS, type PropFamily } from "../../src/world/maps/placements";
import { PROP_BUILDERS } from "../../src/world/maps/props";
import { isShopSwatch, SHOP_SWATCHES } from "../../src/world/maps/swatches";

/** Object-family repetition minimums, §10.2. */
const MINIMUMS: Readonly<Record<string, number>> = {
  lamp: 8,
  seat: 10,
  vessel: 12,
  container: 16,
  frame: 14,
  stand: 8,
  book: 20,
  sculpture: 10,
  tool: 12,
};

describe("Curiosity Shop prop families", () => {
  it("reaches the blockout density target", () => {
    expect(SHOP_PLACEMENTS.length).toBeGreaterThanOrEqual(120);
  });

  it("meets every §10.2 family minimum", () => {
    const counts = countByFamily();
    for (const [family, minimum] of Object.entries(MINIMUMS)) {
      expect(counts[family] ?? 0, `family ${family}`).toBeGreaterThanOrEqual(minimum);
    }
  });

  it("spreads props across all seven zones", () => {
    const zones = new Set(SHOP_PLACEMENTS.map((placement) => placement.zoneId));
    expect(zones.size).toBe(7);
  });

  it("resolves every authored swatch id against the published catalogue", () => {
    for (const placement of SHOP_PLACEMENTS) {
      for (const swatchId of placement.swatchIds) {
        expect(isShopSwatch(swatchId), `${placement.objectId} wears ${swatchId}`).toBe(true);
      }
    }
  });

  it("covers all nine §7.12 material families with at least fourteen swatches", () => {
    expect(SHOP_SWATCHES.length).toBeGreaterThanOrEqual(14);
    const families = new Set(SHOP_SWATCHES.map((swatch) => swatch.family));
    expect(families).toEqual(
      new Set(["wood", "paint", "metal", "fabric", "ceramic", "glass", "paper", "plastic", "stone"]),
    );
    const ids = new Set(SHOP_SWATCHES.map((swatch) => swatch.id));
    expect(ids.size).toBe(SHOP_SWATCHES.length);
  });

  it("has a builder for every authored variant", () => {
    for (const placement of SHOP_PLACEMENTS) {
      expect(typeof PROP_BUILDERS[placement.variant], placement.variant).toBe("function");
    }
  });

  it("marks a hero set small enough to stay inside the shadow budget", () => {
    const heroes = SHOP_PLACEMENTS.filter((placement) => placement.hero);
    expect(heroes.length).toBeGreaterThan(0);
    expect(heroes.length).toBeLessThanOrEqual(20);
  });

  it("declares practical lights only on the lamp family", () => {
    const lit = SHOP_PLACEMENTS.filter((placement) => placement.practical !== undefined);
    expect(lit.length).toBeGreaterThanOrEqual(8);
    for (const placement of lit) {
      const family: PropFamily = placement.family;
      expect(family, placement.objectId).toBe("lamp");
    }
  });
});
