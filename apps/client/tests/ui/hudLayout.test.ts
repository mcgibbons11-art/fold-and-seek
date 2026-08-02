import { describe, expect, it } from "vitest";

import { RAIL_SIZES, railHeight, railSizeFor } from "../../src/ui/rounds/ActionRail";
import { hiderRailActions, inspectorRailActions } from "../../src/ui/rounds/huntControls";
import {
  HUD_REGIONS,
  REGION_RULES,
  rectsOverlap,
  regionRect,
  regionStyle,
  type HudRegion,
} from "../../src/ui/rounds/layout";

/**
 * The point of the region table is that no two pieces of the HUD can land on
 * each other, so that is what is checked here, arithmetically, at the two
 * viewport sizes the game is played at. `regionStyle` is derived from the same
 * rules `regionRect` resolves, so a box proved disjoint here is the box the
 * browser lays out.
 */

const VIEWPORTS = [
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1920x1080", width: 1920, height: 1080 },
] as const;

describe("HUD region table", () => {
  it("names every rule exactly once", () => {
    expect(new Set(HUD_REGIONS).size).toBe(HUD_REGIONS.length);
    expect(Object.keys(REGION_RULES).sort()).toEqual([...HUD_REGIONS].sort());
  });

  for (const viewport of VIEWPORTS) {
    describe(`at ${viewport.name}`, () => {
      it("gives every region a box inside the viewport", () => {
        for (const region of HUD_REGIONS) {
          const rect = regionRect(region, viewport.width, viewport.height);
          expect(rect.right, `${region} width`).toBeGreaterThan(rect.left);
          expect(rect.bottom, `${region} height`).toBeGreaterThan(rect.top);
          expect(rect.left, `${region} left edge`).toBeGreaterThanOrEqual(0);
          expect(rect.top, `${region} top edge`).toBeGreaterThanOrEqual(0);
          expect(rect.right, `${region} right edge`).toBeLessThanOrEqual(viewport.width);
          expect(rect.bottom, `${region} bottom edge`).toBeLessThanOrEqual(viewport.height);
        }
      });

      it("keeps every pair of regions apart", () => {
        const collisions: string[] = [];
        for (let i = 0; i < HUD_REGIONS.length; i += 1) {
          for (let j = i + 1; j < HUD_REGIONS.length; j += 1) {
            const a = HUD_REGIONS[i] as HudRegion;
            const b = HUD_REGIONS[j] as HudRegion;
            const rectA = regionRect(a, viewport.width, viewport.height);
            const rectB = regionRect(b, viewport.width, viewport.height);
            if (rectsOverlap(rectA, rectB)) collisions.push(`${a} over ${b}`);
          }
        }
        expect(collisions).toEqual([]);
      });
    });
  }

  it("resolves a rule the same way in CSS as in the rect", () => {
    // A spot check that the two derivations have not drifted apart: the rail is
    // right-anchored and vertically stretched, so it exercises both forms.
    const style = regionStyle("rightRail");
    const rect = regionRect("rightRail", 1280, 720);
    expect(style.right).toBe(12);
    expect(style.width).toBe(176);
    expect(rect.right - rect.left).toBe(176);
    expect(1280 - rect.right).toBe(12);
    expect(style.top).toBe(144);
    expect(rect.top).toBe(144);
    expect(style.bottom).toBe(156);
    expect(720 - rect.bottom).toBe(156);
  });

  it("centres a centred region with calc rather than a transform", () => {
    // Both axes of the reticle region centre, and one transform cannot carry two
    // independent offsets, which is why neither axis may use one.
    const style = regionStyle("center");
    expect(style.transform).toBeUndefined();
    expect(style.left).toBe("calc(50% - 150px)");
    expect(style.top).toBe("calc(50% - 150px)");
  });

  it("fits a live hider's eight-chip rail inside the rail region at every size", () => {
    // The roster that overflowed at 720p: taunt, five Forge tools, mirror, and
    // the board, with the taunt carrying a cooldown note. Both the top chip and
    // the bottom one were off screen.
    const actions = hiderRailActions({
      tauntSupported: true,
      tauntAllowed: false,
      tauntCooldownSeconds: 8,
      toolMode: "pose",
      mirror: false,
      boardOpen: false,
    });
    expect(actions).toHaveLength(8);

    for (const viewport of VIEWPORTS) {
      const rect = regionRect("rightRail", viewport.width, viewport.height);
      const available = rect.bottom - rect.top;
      const size = railSizeFor(actions, available);
      expect(railHeight(actions, size), `rail at ${viewport.name}`).toBeLessThanOrEqual(available);
    }
  });

  it("fits the rail at 720p even when every chip carries a note", () => {
    // Notes are per-chip and nothing stops several appearing at once, so the
    // smallest size has to hold the worst roster rather than the likely one.
    const actions = hiderRailActions({
      tauntSupported: true,
      tauntAllowed: false,
      tauntCooldownSeconds: 8,
      toolMode: "pose",
      mirror: false,
      boardOpen: false,
    }).map((action) => ({ ...action, note: "wait" }));

    const rect = regionRect("rightRail", 1280, 720);
    const smallest = RAIL_SIZES[RAIL_SIZES.length - 1];
    expect(railHeight(actions, smallest)).toBeLessThanOrEqual(rect.bottom - rect.top);
  });

  it("leaves the Inspector's short rail at the roomy size", () => {
    // Shrinking is for the roster that needs it. Three chips must not be made
    // small because eight of them would have been.
    const actions = inspectorRailActions({ boardOpen: false, outOfWarrants: false });
    const rect = regionRect("rightRail", 1280, 720);
    expect(railSizeFor(actions, rect.bottom - rect.top).id).toBe("roomy");
  });

  it("clips or scrolls every region so content cannot leave its box", () => {
    for (const region of HUD_REGIONS) {
      const style = regionStyle(region);
      expect(["hidden", "auto"], `${region} overflowY`).toContain(style.overflowY);
      expect(style.overflowX, `${region} overflowX`).toBe("hidden");
    }
  });
});
