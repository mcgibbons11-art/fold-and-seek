import { INNOCENT_REACTION_IDS } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import { SHOP_PLACEMENTS } from "../../src/world/maps/placements";
import {
  buildObjectRegistry,
  CURIOSITY_SHOP_MAP_ID,
  CURIOSITY_SHOP_OBJECTS,
  mapObject,
} from "../../src/world/maps/registry";
import { SECURITY_OFFICE_BOUNDS, ZONES } from "../../src/world/maps/zones";

const REACTIONS = new Set<string>(INNOCENT_REACTION_IDS);
const ZONE_IDS = new Set(ZONES.map((zone) => zone.id));

describe("Curiosity Shop object registry", () => {
  it("gives every prop a unique id", () => {
    const ids = new Set(SHOP_PLACEMENTS.map((placement) => placement.objectId));
    expect(ids.size).toBe(SHOP_PLACEMENTS.length);
  });

  it("declares a valid reaction, category and zone for every object", () => {
    for (const entry of CURIOSITY_SHOP_OBJECTS) {
      expect(REACTIONS.has(entry.innocentReactionId), `${entry.objectId} reaction`).toBe(true);
      expect(entry.categoryId.length, `${entry.objectId} category`).toBeGreaterThan(0);
      expect(ZONE_IDS.has(entry.zoneId), `${entry.objectId} zone`).toBe(true);
    }
  });

  it("keeps the inspectable set inside the §10.2 target of 70 to 110", () => {
    const inspectable = CURIOSITY_SHOP_OBJECTS.filter((entry) => entry.inspectable);
    expect(inspectable.length).toBeGreaterThanOrEqual(70);
    expect(inspectable.length).toBeLessThanOrEqual(110);
  });

  it("gives every object focus bounds that contain its origin and have volume", () => {
    for (const entry of CURIOSITY_SHOP_OBJECTS) {
      const { min, max } = entry.focusBounds;
      expect(max.x - min.x, `${entry.objectId} focus width`).toBeGreaterThan(0);
      expect(max.y - min.y, `${entry.objectId} focus height`).toBeGreaterThan(0);
      expect(max.z - min.z, `${entry.objectId} focus depth`).toBeGreaterThan(0);
      expect(entry.focusBounds.containsPoint(entry.position), `${entry.objectId} contains origin`).toBe(true);
    }
  });

  it("blocks accusation inside the Security Office and outside the inspectable set", () => {
    for (const entry of CURIOSITY_SHOP_OBJECTS) {
      const inOffice =
        entry.position.x >= SECURITY_OFFICE_BOUNDS.min.x &&
        entry.position.x <= SECURITY_OFFICE_BOUNDS.max.x &&
        entry.position.z >= SECURITY_OFFICE_BOUNDS.min.z &&
        entry.position.z <= SECURITY_OFFICE_BOUNDS.max.z;
      if (inOffice) {
        expect(entry.accusationPolicy, `${entry.objectId}`).toBe("blocked");
      } else if (!entry.inspectable) {
        expect(entry.accusationPolicy, `${entry.objectId}`).toBe("decorative_only");
      } else {
        expect(entry.accusationPolicy, `${entry.objectId}`).toBe("allowed");
      }
    }
  });

  it("publishes only accusable objects to the simulation registry", () => {
    const registry = buildObjectRegistry();
    expect(registry.mapId).toBe(CURIOSITY_SHOP_MAP_ID);
    expect(registry.objects.length).toBe(
      CURIOSITY_SHOP_OBJECTS.filter((entry) => entry.accusationPolicy === "allowed").length,
    );

    const ids = new Set(registry.objects.map((entry) => entry.objectId));
    expect(ids.size).toBe(registry.objects.length);

    for (const entry of registry.objects) {
      expect(entry.innocentReactionIds.length).toBe(1);
      for (const reaction of entry.innocentReactionIds) {
        expect(REACTIONS.has(reaction)).toBe(true);
      }
      expect(mapObject(entry.objectId)).not.toBeNull();
    }
  });

  it("keeps every prop in the baseline so the dossier has a complete before state", () => {
    expect(CURIOSITY_SHOP_OBJECTS.every((entry) => entry.baselinePresent)).toBe(true);
  });
});
