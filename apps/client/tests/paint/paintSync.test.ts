import { MAX_PAINT_STROKES, quantizePaintStroke, type PaintStrokeWire } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import { PaintLayer, type PaintStroke } from "../../src/paint/PaintLayer";
import {
  applyPaintSyncUpdate,
  decodePaintSyncUpdate,
  encodePaintSyncUpdate,
  PaintSnapshotBookkeeper,
  type PaintRevisionState,
} from "../../src/paint/paintSync";
import { paintTileOf } from "../../src/paint/paintTargets";

const ATLAS = 64;

function stroke(index: number, target = 2): PaintStroke {
  return {
    segmentId: target,
    uv: [((index * 17) % 97) / 96, ((index * 29) % 89) / 88],
    radius: 0.08,
    color: [0.9, 0.2, 0.1],
    opacity: 1,
    metallic: 0,
    smoothness: 0.35,
    emissive: 0,
    kind: "brush",
    continued: false,
  };
}

function wire(index: number): PaintStrokeWire {
  return quantizePaintStroke({
    target: index % 9,
    u: (index % 17) / 16,
    v: (index % 13) / 12,
    radius: 0.1,
    color: [0.1, 0.5, 0.9],
    opacity: 1,
    metallic: 0,
    smoothness: 0.35,
    emissive: 0,
    erase: false,
    continued: false,
  });
}

describe("paint revision sync", () => {
  it("publishes one checkpoint, then compact deltas only for new revisions", () => {
    const layer = new PaintLayer({ atlasSize: ATLAS, canvas: null });
    const book = new PaintSnapshotBookkeeper();
    layer.restoreStrokeLog(Array.from({ length: 40 }, (_, index) => wire(index)));

    const first = book.capture(layer);
    expect(first?.update.kind).toBe("checkpoint");
    expect(book.capture(layer)).toBeNull();

    layer.applyStroke(stroke(41));
    const next = book.capture(layer);
    expect(next?.update.kind).toBe("delta");
    expect(next?.encoded.length).toBeLessThan(encodePaintSyncUpdate({
      kind: "checkpoint",
      revision: layer.revision,
      encodedPaint: layer.toDataForWire(),
    }).length);
  });

  it("round-trips and applies append, undo-style prepend, and cap eviction", () => {
    const source = new PaintLayer({ atlasSize: ATLAS, canvas: null });
    const book = new PaintSnapshotBookkeeper({ checkpointInterval: 100 });
    const checkpoint = book.capture(source);
    expect(checkpoint).not.toBeNull();
    let receiver = applyPaintSyncUpdate(null, checkpoint!.update);

    source.restoreStrokeLog(Array.from({ length: MAX_PAINT_STROKES }, (_, index) => wire(index)));
    const full = book.capture(source, true);
    receiver = applyPaintSyncUpdate(receiver, full!.update);
    expect(receiver?.strokes).toEqual(source.strokeLog);

    source.applyStroke(stroke(999, 4));
    const delta = book.capture(source);
    expect(delta?.update.kind).toBe("delta");
    const decoded = decodePaintSyncUpdate(delta!.encoded);
    expect(decoded).toEqual(delta!.update);
    receiver = applyPaintSyncUpdate(receiver, decoded!);
    expect(receiver?.revision).toBe(source.revision);
    expect(receiver?.strokes).toEqual(source.strokeLog);

    const restored = [wire(0), ...(receiver?.strokes.slice(0, -1) ?? [])];
    source.restoreStrokeLog(restored);
    const undoDelta = book.capture(source);
    receiver = applyPaintSyncUpdate(receiver, undoDelta!.update);
    expect(receiver?.strokes).toEqual(source.strokeLog);
  });

  it("rejects malformed, stale, and out-of-order deltas without changing state", () => {
    const state: PaintRevisionState = { revision: 4, strokes: [wire(1)] };
    expect(decodePaintSyncUpdate("pd1.4.5.0.999.nope.nope")).toBeNull();
    expect(applyPaintSyncUpdate(state, {
      kind: "delta",
      baseRevision: 3,
      revision: 5,
      retainStart: 0,
      retainCount: 0,
      encodedPrepend: "AwAA",
      encodedAppend: "AwAA",
    })).toBeNull();
    expect(state.strokes).toHaveLength(1);
  });

  it("forces a periodic recovery checkpoint after a bounded delta chain", () => {
    const layer = new PaintLayer({ atlasSize: ATLAS, canvas: null });
    layer.restoreStrokeLog(Array.from({ length: 40 }, (_, index) => wire(index)));
    const book = new PaintSnapshotBookkeeper({ checkpointInterval: 3 });
    expect(book.capture(layer)?.update.kind).toBe("checkpoint");

    for (let index = 0; index < 3; index++) {
      layer.applyStroke(stroke(100 + index));
      expect(book.capture(layer)?.update.kind).toBe("delta");
    }
    layer.applyStroke(stroke(104));
    expect(book.capture(layer)?.update.kind).toBe("checkpoint");
  });
});

describe("paint upload invalidation", () => {
  it("uses dirty putImageData rectangles instead of copying the full canvas", () => {
    const originalImageData = globalThis.ImageData;
    const copies: number[][] = [];
    class TestImageData {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    }
    globalThis.ImageData = TestImageData as unknown as typeof ImageData;
    try {
      const context = {
        putImageData: (...args: unknown[]) => copies.push(args.slice(3) as number[]),
      } as unknown as CanvasRenderingContext2D;
      const canvas = {
        width: ATLAS,
        height: ATLAS,
        getContext: () => context,
      } as unknown as HTMLCanvasElement;
      const layer = new PaintLayer({ atlasSize: ATLAS, canvas });
      layer.flush();
      copies.length = 0;
      layer.applyStroke(stroke(1, 3));
      layer.flush();

      const tile = paintTileOf(3, ATLAS);
      expect(copies).toEqual([[tile.x, tile.y, tile.width, tile.height]]);
    } finally {
      globalThis.ImageData = originalImageData;
    }
  });

  it("copies only a changed target tile and keeps the cap path target-local", () => {
    const layer = new PaintLayer({ atlasSize: ATLAS, canvas: null });
    layer.flush();
    const initial = layer.uploadStats;

    layer.applyStroke(stroke(1, 3));
    layer.flush();
    const oneTarget = layer.uploadStats;
    const tile = paintTileOf(3, ATLAS);
    expect(oneTarget.targets - initial.targets).toBe(1);
    expect(oneTarget.pixels - initial.pixels).toBe(tile.width * tile.height);
    expect(oneTarget.pixels - initial.pixels).toBeLessThan(ATLAS * ATLAS);

    const capped = new PaintLayer({ atlasSize: ATLAS, canvas: null });
    capped.restoreStrokeLog(Array.from({ length: MAX_PAINT_STROKES }, (_, index) => wire(index)));
    capped.flush();
    const before = capped.uploadStats;
    capped.applyStroke(stroke(999, 10));
    capped.flush();
    const after = capped.uploadStats;
    // One runway can span the nine fixture targets plus the new target, but it
    // still avoids rebuilding all 27 body tiles. The separate sustained-spray
    // test verifies that this bounded replay happens only once per runway.
    expect(after.targets - before.targets).toBeLessThanOrEqual(10);
    expect(after.pixels - before.pixels).toBeLessThanOrEqual(ATLAS * ATLAS);
    expect(after.rasterizedStrokes - before.rasterizedStrokes).toBeLessThanOrEqual(
      MAX_PAINT_STROKES,
    );
    expect(after.rebuilds - before.rebuilds).toBe(1);
    expect(after.rebuiltTargets - before.rebuiltTargets).toBeLessThanOrEqual(10);
    expect(after.flushCpuMs).toBeGreaterThanOrEqual(before.flushCpuMs);

    const sink = {
      flushes: 0,
      rectangles: 0,
      pixels: 0,
      targets: 0,
      rasterizedStrokes: 0,
      flushCpuMs: 0,
      rebuilds: 0,
      rebuiltTargets: 0,
    };
    expect(capped.readUploadStats(sink)).toBe(sink);
    expect(sink).toEqual(after);
  });

  it("invalidates only the texture view worn by the painted target", () => {
    const canvas = {
      width: ATLAS,
      height: ATLAS,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    const layer = new PaintLayer({ atlasSize: ATLAS, canvas });
    const painted = layer.getTargetTexture(3);
    const untouched = layer.getTargetTexture(4);
    expect(painted).not.toBeNull();
    expect(untouched).not.toBeNull();
    const paintedVersion = painted!.version;
    const untouchedVersion = untouched!.version;

    layer.applyStroke(stroke(2, 3));
    layer.flush();
    expect(painted!.version).toBe(paintedVersion + 1);
    expect(untouched!.version).toBe(untouchedVersion);
  });
});
