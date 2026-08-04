import { GRAPPLE_MIN_RANGE_M } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import { grappleTargetFromRay } from "../../src/inspector/grappleTarget";
import { NAV_DATA } from "../../src/world/maps/nav";
import { box, openNavData } from "./navFixture";

describe("grapple targeting", () => {
  it("ignores the floor so a downward shot cannot tow the player through the map", () => {
    const nav = openNavData();
    expect(grappleTargetFromRay(nav, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 })).toBeNull();
  });

  it("still latches the nearest solid prop", () => {
    const nav = { ...openNavData(), blockers: [box(0.9, 0, -0.5, 1.1, 2, 0.5)] };
    const target = grappleTargetFromRay(nav, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(target).not.toBeNull();
    expect(target?.x).toBeGreaterThan(GRAPPLE_MIN_RANGE_M);
    expect(target?.x).toBeCloseTo(0.9, 6);
  });

  it("latches visual shelf stock without turning it into movement collision", () => {
    const book = box(0.9, 0.7, -0.2, 1.1, 1.1, 0.2);
    const nav = { ...openNavData(), grappleTargets: [book] };
    expect(nav.blockers).toHaveLength(0);

    const target = grappleTargetFromRay(nav, { x: 0, y: 0.9, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(target?.x).toBeCloseTo(0.9, 6);
  });

  it("latches authored shelf books and the thin posts of the centre display cases", () => {
    const shelfBook = grappleTargetFromRay(
      NAV_DATA,
      { x: -5.5, y: 1.8, z: -2.6 },
      { x: -1, y: 0, z: 0 },
    );
    expect(shelfBook).not.toBeNull();
    // The book row is in front of the west wall, proving the ray did not merely
    // continue through the visible books until it found the room shell.
    expect(shelfBook?.x).toBeGreaterThan(-7.4);

    const cabinetCorner = grappleTargetFromRay(
      NAV_DATA,
      { x: -4.2, y: 1, z: -1.77 },
      { x: 1, y: 0, z: 0 },
    );
    expect(cabinetCorner).not.toBeNull();
    expect(cabinetCorner?.x).toBeCloseTo(-3.31, 2);
  });
});
