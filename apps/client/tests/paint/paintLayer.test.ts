import { MAX_PAINT_STROKES } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import { PaintLayer, type PaintStroke } from "../../src/paint/PaintLayer";
import {
  PAINT_TARGET_COUNT,
  PANEL_TARGET_OFFSET,
  paintTileOf,
  paintTileTransform,
} from "../../src/paint/paintTargets";

/**
 * The paint layer is the one place where two players' screens have to agree, so
 * these check the two properties that guarantee it: the same log always produces
 * the same pixels, and the log survives the wire unchanged.
 *
 * Everything runs without a DOM. The rasterizer works on its own pixel buffer
 * and only the upload needs a canvas, which is why the layers below are built
 * with `canvas: null`.
 */

const ATLAS = 256;

function makeLayer(): PaintLayer {
  return new PaintLayer({ atlasSize: ATLAS, canvas: null });
}

/** FNV-1a over the atlas, so "identical image" is one comparison. */
function hashOf(layer: PaintLayer): number {
  const { data } = layer.pixelSource();
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function stroke(index: number, overrides: Partial<PaintStroke> = {}): PaintStroke {
  return {
    segmentId: index % PAINT_TARGET_COUNT,
    uv: [(index * 0.07) % 1, (index * 0.13) % 1],
    radius: 0.05 + ((index * 0.01) % 0.1),
    color: [(index % 7) / 7, (index % 5) / 5, (index % 3) / 3],
    opacity: 0.5 + ((index % 5) * 0.1),
    kind: index % 11 === 0 ? "eraser" : "brush",
    continued: false,
    ...overrides,
  };
}

function centerPixel(layer: PaintLayer, target: number): [number, number, number] {
  const pixel = layer.readTargetPixel(target, 0.5, 0.5);
  expect(pixel).not.toBeNull();
  return pixel ?? [0, 0, 0];
}

describe("paint layer determinism", () => {
  it("paints identical pixels from identical stroke logs", () => {
    const strokes = Array.from({ length: 60 }, (_, index) => stroke(index));
    const first = makeLayer();
    const second = makeLayer();
    first.applyStrokes(strokes);
    for (const one of strokes) second.applyStroke(one);
    expect(hashOf(second)).toBe(hashOf(first));
  });

  it("paints a different image once a single stroke differs", () => {
    const strokes = Array.from({ length: 20 }, (_, index) => stroke(index));
    const first = makeLayer();
    first.applyStrokes(strokes);
    const second = makeLayer();
    second.applyStrokes([...strokes.slice(0, 19), { ...stroke(19), radius: 0.11 }]);
    expect(hashOf(second)).not.toBe(hashOf(first));
  });

  it("replays a drag the same way it was drawn", () => {
    const drag: PaintStroke[] = [
      stroke(1, { segmentId: 2, uv: [0.2, 0.2], kind: "brush", continued: false }),
      stroke(1, { segmentId: 2, uv: [0.6, 0.75], kind: "brush", continued: true }),
    ];
    const drawn = makeLayer();
    drawn.applyStrokes(drag);

    const replayed = makeLayer();
    expect(replayed.fromWireData(drawn.toDataForWire())).toBe(true);
    expect(hashOf(replayed)).toBe(hashOf(drawn));

    // The join is a line, not two dots: the midpoint is painted too.
    const midpoint = drawn.readTargetPixel(2, 0.4, 0.475) ?? [0, 0, 0];
    const untouched = makeLayer().readTargetPixel(2, 0.4, 0.475) ?? [0, 0, 0];
    expect(midpoint).not.toEqual(untouched);
  });

  it("joins a drag across the seam the short way round", () => {
    // Painting from just before the seam to just after it is half a centimetre
    // of travel on the shell, so the line crosses u = 0 rather than sweeping
    // back across the whole cross-section.
    const layer = makeLayer();
    layer.applyStrokes([
      stroke(1, { segmentId: 0, uv: [0.94, 0.5], kind: "brush", continued: false }),
      stroke(1, { segmentId: 0, uv: [0.06, 0.5], kind: "brush", continued: true }),
    ]);
    const untouched = makeLayer();
    expect(layer.readTargetPixel(0, 0.0, 0.5)).not.toEqual(
      untouched.readTargetPixel(0, 0.0, 0.5),
    );
    expect(layer.readTargetPixel(0, 0.5, 0.5)).toEqual(untouched.readTargetPixel(0, 0.5, 0.5));
  });

  it("clears back to the untouched atlas", () => {
    const layer = makeLayer();
    const empty = hashOf(layer);
    layer.applyStrokes(Array.from({ length: 12 }, (_, index) => stroke(index)));
    expect(hashOf(layer)).not.toBe(empty);
    layer.clear();
    expect(layer.strokeCount).toBe(0);
    expect(hashOf(layer)).toBe(empty);
  });
});

describe("paint layer wire round trip", () => {
  it("renders a decoded log to the same pixels as the painted one", () => {
    const painted = makeLayer();
    painted.applyStrokes(Array.from({ length: 120 }, (_, index) => stroke(index)));

    const received = makeLayer();
    expect(received.fromWireData(painted.toDataForWire())).toBe(true);
    expect(received.strokeCount).toBe(painted.strokeCount);
    expect(hashOf(received)).toBe(hashOf(painted));
  });

  it("refuses a payload that is not a paint layer and keeps what it had", () => {
    const layer = makeLayer();
    layer.applyStroke(stroke(3));
    const before = hashOf(layer);
    expect(layer.fromWireData("not base64 at all")).toBe(false);
    expect(hashOf(layer)).toBe(before);
    expect(layer.strokeCount).toBe(1);
  });
});

describe("paint layer stroke ceiling", () => {
  it("drops the oldest stroke and repaints so the log and the image agree", () => {
    const strokes = Array.from({ length: MAX_PAINT_STROKES + 1 }, (_, index) =>
      stroke(index, { continued: false }),
    );

    const painted = makeLayer();
    painted.applyStrokes(strokes);
    expect(painted.strokeCount).toBe(MAX_PAINT_STROKES);

    // Exactly the surviving log, painted from scratch, is the same image: the
    // atlas was rebuilt rather than left with the dropped stroke baked in.
    const surviving = makeLayer();
    surviving.applyStrokes(strokes.slice(1));
    expect(hashOf(painted)).toBe(hashOf(surviving));

    const roundTripped = makeLayer();
    expect(roundTripped.fromWireData(painted.toDataForWire())).toBe(true);
    expect(hashOf(roundTripped)).toBe(hashOf(painted));
  });
});

describe("paint atlas tile mapping", () => {
  it("gives every paint target its own rectangle", () => {
    const seen = new Set<string>();
    for (let target = 0; target < PAINT_TARGET_COUNT; target++) {
      const tile = paintTileOf(target, ATLAS);
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.x + tile.width).toBeLessThanOrEqual(ATLAS);
      expect(tile.y + tile.height).toBeLessThanOrEqual(ATLAS);
      expect(Number.isInteger(tile.width)).toBe(true);
      expect(Number.isInteger(tile.height)).toBe(true);
      expect(seen.has(`${tile.x},${tile.y}`)).toBe(false);
      seen.add(`${tile.x},${tile.y}`);
    }
  });

  it("matches the UV transform a material would sample with", () => {
    for (let target = 0; target < PAINT_TARGET_COUNT; target++) {
      const tile = paintTileOf(target, ATLAS);
      const transform = paintTileTransform(target);
      // Texture v runs up the image while the tile grid runs down it, so the
      // tile's top edge is the high end of its v range.
      expect(transform.offsetU * ATLAS).toBeCloseTo(tile.x, 6);
      expect((1 - transform.offsetV - transform.repeatV) * ATLAS).toBeCloseTo(tile.y, 6);
      expect(transform.repeatU * ATLAS).toBeCloseTo(tile.width, 6);
      expect(transform.repeatV * ATLAS).toBeCloseTo(tile.height, 6);
    }
  });

  it("keeps a stroke inside the part it was painted on", () => {
    const layer = makeLayer();
    const untouched = makeLayer();
    layer.applyStroke(
      stroke(0, { segmentId: 3, uv: [0.5, 0.5], radius: 0.3, opacity: 1, kind: "brush" }),
    );

    expect(centerPixel(layer, 3)).not.toEqual(centerPixel(untouched, 3));
    for (let target = 0; target < PAINT_TARGET_COUNT; target++) {
      if (target === 3) continue;
      expect(centerPixel(layer, target)).toEqual(centerPixel(untouched, target));
    }
  });

  it("wraps a shell stroke across the UV seam but never a panel one", () => {
    const shell = makeLayer();
    shell.applyStroke(
      stroke(0, { segmentId: 0, uv: [0.99, 0.5], radius: 0.2, opacity: 1, kind: "brush" }),
    );
    const acrossSeam = shell.readTargetPixel(0, 0.03, 0.5) ?? [0, 0, 0];
    expect(acrossSeam).not.toEqual(centerPixel(makeLayer(), 0));

    const panel = makeLayer();
    const panelTarget = PANEL_TARGET_OFFSET;
    panel.applyStroke(
      stroke(0, {
        segmentId: panelTarget,
        uv: [0.99, 0.5],
        radius: 0.2,
        opacity: 1,
        kind: "brush",
      }),
    );
    expect(panel.readTargetPixel(panelTarget, 0.03, 0.5)).toEqual(
      makeLayer().readTargetPixel(panelTarget, 0.03, 0.5),
    );
  });
});

describe("paint layer materials", () => {
  it("clears a tile to its part's own colour", () => {
    const layer = makeLayer();
    layer.setBaseColor(4, [0.2, 0.4, 0.6]);
    const pixel = centerPixel(layer, 4);
    expect(pixel[0]).toBeCloseTo(0.2, 2);
    expect(pixel[1]).toBeCloseTo(0.4, 2);
    expect(pixel[2]).toBeCloseTo(0.6, 2);
    // Only that part moved.
    expect(centerPixel(layer, 5)).toEqual(centerPixel(makeLayer(), 5));
  });

  it("erases back to the base colour rather than to a hole", () => {
    const layer = makeLayer();
    layer.setBaseColor(6, [0.2, 0.4, 0.6]);
    const base = centerPixel(layer, 6);

    layer.applyStroke(
      stroke(0, { segmentId: 6, uv: [0.5, 0.5], radius: 0.3, opacity: 1, kind: "brush" }),
    );
    expect(centerPixel(layer, 6)).not.toEqual(base);

    layer.applyStroke(
      stroke(0, { segmentId: 6, uv: [0.5, 0.5], radius: 0.3, opacity: 1, kind: "eraser" }),
    );
    const erased = centerPixel(layer, 6);
    expect(erased[0]).toBeCloseTo(base[0], 2);
    expect(erased[1]).toBeCloseTo(base[1], 2);
    expect(erased[2]).toBeCloseTo(base[2], 2);
  });

  it("repaints existing strokes over a new base colour", () => {
    const painted = makeLayer();
    painted.applyStroke(
      stroke(0, { segmentId: 7, uv: [0.5, 0.5], radius: 0.2, opacity: 1, kind: "brush" }),
    );
    painted.setBaseColor(7, [0.1, 0.1, 0.1]);

    const rebuilt = makeLayer();
    rebuilt.setBaseColor(7, [0.1, 0.1, 0.1]);
    rebuilt.applyStroke(
      stroke(0, { segmentId: 7, uv: [0.5, 0.5], radius: 0.2, opacity: 1, kind: "brush" }),
    );

    expect(hashOf(painted)).toBe(hashOf(rebuilt));
  });
});
