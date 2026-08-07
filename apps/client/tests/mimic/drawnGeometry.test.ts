import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { createDrawnGeometry } from "../../src/mimic/visual/mimicGeometry";

/**
 * The solid a drawn outline becomes, and whether paint can reach all of it.
 *
 * ExtrudeGeometry takes the front and back faces' UVs from the shape's own
 * coordinates, which after centring straddle zero. Everything negative falls
 * outside the paint atlas tile, so a brush covered roughly half the solid and
 * the rest stayed bare however hard the player worked at it.
 */

const square: [number, number][] = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

describe("a drawn solid", () => {
  it("puts every vertex inside the paint atlas tile", () => {
    const geometry = createDrawnGeometry(square);
    const uv = geometry.getAttribute("uv");
    expect(uv).toBeDefined();
    for (let index = 0; index < (uv?.count ?? 0); index += 1) {
      // Outside 0..1 is the half of the solid the brush could never reach.
      expect(uv?.getX(index)).toBeGreaterThanOrEqual(-1e-6);
      expect(uv?.getX(index)).toBeLessThanOrEqual(1 + 1e-6);
      expect(uv?.getY(index)).toBeGreaterThanOrEqual(-1e-6);
      expect(uv?.getY(index)).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it("uses the whole tile rather than a corner of it", () => {
    // A projection that fit inside 0..1 by shrinking would pass the bounds
    // check above while painting a stamp in one corner.
    const uv = createDrawnGeometry(square).getAttribute("uv");
    let minU = Infinity;
    let maxU = -Infinity;
    for (let index = 0; index < (uv?.count ?? 0); index += 1) {
      minU = Math.min(minU, uv?.getX(index) ?? 0);
      maxU = Math.max(maxU, uv?.getX(index) ?? 0);
    }
    expect(minU).toBeLessThan(0.05);
    expect(maxU).toBeGreaterThan(0.95);
  });

  it("gives the extruded sides real UV area, not a stretched line", () => {
    // Projecting every face on X and Y gave the side walls one coordinate from
    // front to back: a zero-area patch of texture smeared along the whole
    // wall, which is what the white streaks were.
    const geometry = createDrawnGeometry(square);
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");

    let sideVertices = 0;
    let spread = 0;
    const seen: number[] = [];
    for (let index = 0; index < position.count; index += 1) {
      // A wall faces sideways rather than front or back.
      if (Math.abs(normal.getZ(index)) > 0.5) continue;
      sideVertices += 1;
      seen.push(uv.getX(index), uv.getY(index));
    }
    expect(sideVertices).toBeGreaterThan(0);
    spread = Math.max(...seen) - Math.min(...seen);
    expect(spread).toBeGreaterThan(0.2);
  });

  it("stands the outline up as a solid with real depth", () => {
    const geometry = createDrawnGeometry(square);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox as THREE.Box3;
    expect(box.max.z - box.min.z).toBeGreaterThan(0);
  });

  it("falls back rather than throwing on a stroke too short to close", () => {
    expect(createDrawnGeometry([[0, 0], [1, 1]])).toBeInstanceOf(THREE.BufferGeometry);
  });
});
