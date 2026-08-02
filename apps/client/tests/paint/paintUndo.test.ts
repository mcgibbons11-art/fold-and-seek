// @vitest-environment jsdom
import { MAX_PAINT_STROKES } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import {
  createPaintClearCommand,
  createPaintStrokeCommand,
  ForgeCommandStack,
  type PaintHistoryTarget,
} from "../../src/forge/forgeCommands";
import { createDefaultDisguiseState } from "../../src/mimic/disguiseState";
import { createPaintTool, type PaintTool } from "../../src/paint/createPaintTool";
import { PaintLayer, type PaintStroke, type PaintStrokeBatch } from "../../src/paint/PaintLayer";
import { PaintMaterialBinder } from "../../src/paint/PaintMaterialBinder";

/**
 * Ctrl+Z after a brush stroke has to take back the brush stroke.
 *
 * Before this, paint was outside the Forge's history entirely, so an undo after
 * painting silently reverted the previous POSE edit and left the paint on the
 * body: worse than doing nothing, because the player loses work they were not
 * asking to lose. These hold the fixed behaviour, and the first test asserts the
 * old behaviour is gone rather than only that the new one exists.
 *
 * The layer's own atlas is checked as well as its stroke count. Removing a
 * stroke from the log without reprinting the texels it stamped would leave the
 * paint on the body with nothing in the log to explain it, which is exactly the
 * kind of divergence a peer would then fail to reproduce.
 */

const ATLAS = 128;

function makeLayer(): PaintLayer {
  return new PaintLayer({ atlasSize: ATLAS, canvas: null });
}

function stroke(overrides: Partial<PaintStroke> = {}): PaintStroke {
  return {
    segmentId: 2,
    uv: [0.5, 0.5],
    radius: 0.3,
    color: [0.9, 0.2, 0.1],
    opacity: 1,
    kind: "brush",
    continued: false,
    ...overrides,
  };
}

/** FNV-1a over every atlas the layer holds, the same measure of "same image". */
function hashOf(layer: PaintLayer): number {
  let hash = 0x811c9dc5;
  for (const source of [
    layer.pixelSource(),
    layer.materialPixelSource(),
    layer.emissivePixelSource(),
  ]) {
    if (source === null) continue;
    for (let i = 0; i < source.data.length; i++) {
      hash ^= source.data[i] ?? 0;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

function historyOf(layer: PaintLayer): PaintHistoryTarget {
  return {
    reapplyBatch: (batch) => {
      layer.reapplyStrokeBatch(batch);
    },
    revertBatch: (batch) => {
      layer.revertStrokeBatch(batch);
    },
    restoreLog: (strokes) => {
      layer.restoreStrokeLog(strokes);
    },
    clearPaint: () => {
      layer.clear();
    },
  };
}

/** One drag: opens a batch, lays `count` stamps, closes it. */
function drag(layer: PaintLayer, count: number, overrides: Partial<PaintStroke> = {}): PaintStrokeBatch {
  layer.beginStrokeBatch();
  for (let i = 0; i < count; i++) {
    layer.applyStroke(stroke({ uv: [0.2 + i * 0.1, 0.5], continued: i > 0, ...overrides }));
  }
  const batch = layer.endStrokeBatch();
  expect(batch).not.toBeNull();
  return batch ?? { added: [], evicted: [] };
}

describe("paint undo", () => {
  it("undoes the paint, not the pose edit that came before it", () => {
    const layer = makeLayer();
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();

    // A pose edit, then a drag. The old behaviour was that this undo reverted
    // the pose command and left every stamp on the body.
    const before = state.root.position[1];
    stack.push(
      {
        id: "pose",
        issuedAt: 0,
        label: "pose",
        apply: (target) => {
          target.root.position = [0, 1, 0];
        },
        revert: (target) => {
          target.root.position = [0, before, 0];
        },
      },
      state,
    );
    expect(state.root.position[1]).toBe(1);

    const empty = hashOf(layer);
    const batch = drag(layer, 4);
    stack.pushApplied(createPaintStrokeCommand(historyOf(layer), batch, 1), state);

    const undone = stack.undo(state);
    expect(undone?.label).toBe("paint stroke");
    expect(layer.strokeCount).toBe(0);
    expect(hashOf(layer)).toBe(empty);
    // The pose is untouched: the paint undo did not reach past itself.
    expect(state.root.position[1]).toBe(1);

    // Only the next undo takes the pose back.
    expect(stack.undo(state)?.label).toBe("pose");
    expect(state.root.position[1]).toBe(before);
  });

  it("takes back exactly one drag, however many stamps it laid", () => {
    const layer = makeLayer();
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const history = historyOf(layer);

    const first = drag(layer, 3);
    stack.pushApplied(createPaintStrokeCommand(history, first, 1), state);
    const afterFirst = hashOf(layer);
    const countAfterFirst = layer.strokeCount;

    const second = drag(layer, 5, { segmentId: 6 });
    stack.pushApplied(createPaintStrokeCommand(history, second, 2), state);
    expect(layer.strokeCount).toBe(countAfterFirst + 5);

    stack.undo(state);
    expect(layer.strokeCount).toBe(countAfterFirst);
    expect(hashOf(layer)).toBe(afterFirst);
  });

  it("redoes a drag to exactly the image it undid", () => {
    const layer = makeLayer();
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();

    const batch = drag(layer, 4);
    const painted = hashOf(layer);
    const count = layer.strokeCount;
    stack.pushApplied(createPaintStrokeCommand(historyOf(layer), batch, 1), state);

    stack.undo(state);
    stack.redo(state);
    expect(layer.strokeCount).toBe(count);
    expect(hashOf(layer)).toBe(painted);
  });

  it("restores the whole log when a clear is undone", () => {
    const layer = makeLayer();
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const history = historyOf(layer);

    drag(layer, 3);
    drag(layer, 3, { segmentId: 8, emissive: 1 });
    const painted = hashOf(layer);
    const count = layer.strokeCount;

    const cleared = layer.captureStrokeLog();
    layer.clear();
    stack.pushApplied(createPaintClearCommand(history, cleared, 1), state);
    expect(layer.strokeCount).toBe(0);

    const undone = stack.undo(state);
    expect(undone?.label).toBe("clear paint");
    expect(layer.strokeCount).toBe(count);
    // Including the glow: restoring a log has to bring the emissive atlas back
    // with it, or a cleared glow would never return.
    expect(layer.hasEmissive).toBe(true);
    expect(hashOf(layer)).toBe(painted);

    stack.redo(state);
    expect(layer.strokeCount).toBe(0);
  });

  it("refuses to revert a batch that is no longer the end of the log", () => {
    // The history is last in, first out, so this cannot happen while the two
    // agree. If they ever stop agreeing, undoing would erase strokes belonging
    // to something else, which is worth a crash rather than a wrong body.
    const layer = makeLayer();
    const batch = drag(layer, 2);
    drag(layer, 2, { segmentId: 9 });
    expect(() => {
      layer.revertStrokeBatch(batch);
    }).toThrow(/does not match the end/);
  });

  it("puts back the strokes the ceiling dropped to make room for a drag", () => {
    // At the ceiling every new stamp evicts the oldest one. An undo that only
    // popped the new stamps would leave the body permanently short of its first
    // marks, so the batch carries what was evicted and restores that too.
    const layer = makeLayer();
    for (let i = 0; i < MAX_PAINT_STROKES; i++) {
      layer.applyStroke(stroke({ segmentId: i % 19, uv: [(i % 10) / 10, ((i % 7) + 1) / 10] }));
    }
    expect(layer.strokeCount).toBe(MAX_PAINT_STROKES);
    const before = hashOf(layer);

    const batch = drag(layer, 3, { segmentId: 11 });
    expect(batch.evicted).toHaveLength(3);
    expect(layer.strokeCount).toBe(MAX_PAINT_STROKES);

    layer.revertStrokeBatch(batch);
    expect(layer.strokeCount).toBe(MAX_PAINT_STROKES);
    expect(hashOf(layer)).toBe(before);
  });

  it("redoes a drag that overflowed the ceiling to the same image again", () => {
    const layer = makeLayer();
    for (let i = 0; i < MAX_PAINT_STROKES; i++) {
      layer.applyStroke(stroke({ segmentId: i % 19, uv: [(i % 10) / 10, ((i % 7) + 1) / 10] }));
    }
    const batch = drag(layer, 3, { segmentId: 11 });
    const painted = hashOf(layer);

    layer.revertStrokeBatch(batch);
    layer.reapplyStrokeBatch(batch);
    expect(layer.strokeCount).toBe(MAX_PAINT_STROKES);
    expect(hashOf(layer)).toBe(painted);
  });
});

describe("paint tool history seams", () => {
  function makeTool(onBatch: (batch: PaintStrokeBatch) => void): {
    tool: PaintTool;
    mesh: THREE.Mesh;
  } {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshPhysicalMaterial({ color: 0x336699, roughness: 0.5, metalness: 0.1 }),
    );
    mesh.userData["segmentSlot"] = 2;
    const tool = createPaintTool({
      canvas: document.createElement("canvas"),
      camera: new THREE.PerspectiveCamera(),
      raycaster: new THREE.Raycaster(),
      getMimicMeshes: () => [mesh],
      onStrokeBatch: onBatch,
      atlasSize: ATLAS,
    });
    return { tool, mesh };
  }

  it("reports one batch per drag and reverts it on demand", () => {
    const batches: PaintStrokeBatch[] = [];
    const { tool } = makeTool((batch) => batches.push(batch));

    tool.layer.beginStrokeBatch();
    tool.layer.applyStroke(stroke());
    tool.layer.applyStroke(stroke({ uv: [0.6, 0.5], continued: true }));
    const batch = tool.layer.endStrokeBatch();
    expect(batch?.added).toHaveLength(2);
    expect(tool.getState().strokeCount).toBe(0);

    // Going through the tool keeps the panel's stroke counter in step, which is
    // what the "paint used" readout is drawn from.
    if (batch !== null) tool.revertBatch(batch);
    expect(tool.getState().strokeCount).toBe(0);
    if (batch !== null) tool.reapplyBatch(batch);
    expect(tool.getState().strokeCount).toBe(2);
    tool.dispose();
  });

  it("hands the cleared log to onClear and clears silently for a redo", () => {
    let cleared: readonly unknown[] | null = null;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshPhysicalMaterial({ color: 0x336699 }),
    );
    mesh.userData["segmentSlot"] = 2;
    const tool = createPaintTool({
      canvas: document.createElement("canvas"),
      camera: new THREE.PerspectiveCamera(),
      raycaster: new THREE.Raycaster(),
      getMimicMeshes: () => [mesh],
      onClear: (log) => {
        cleared = log;
      },
      atlasSize: ATLAS,
    });

    tool.layer.applyStroke(stroke());
    tool.layer.applyStroke(stroke({ uv: [0.7, 0.3] }));
    tool.clearAll();
    expect(cleared).toHaveLength(2);
    expect(tool.getState().strokeCount).toBe(0);

    tool.restoreLog(cleared ?? []);
    expect(tool.getState().strokeCount).toBe(2);

    // The silent clear is what a redo replays; it must not report itself again.
    cleared = null;
    tool.clearSilently();
    expect(cleared).toBeNull();
    expect(tool.getState().strokeCount).toBe(0);
    tool.dispose();
  });

  it("binds the glow atlas to the material only once a stroke glows", () => {
    // Needs a DOM: the atlas texture is a canvas, so this is the one check that
    // the map actually reaches the material rather than resolving to null.
    const layer = new PaintLayer({ atlasSize: ATLAS });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshPhysicalMaterial({ color: 0x336699, roughness: 0.5, metalness: 0.1 }),
    );
    mesh.userData["segmentSlot"] = 2;
    const binder = new PaintMaterialBinder(layer, () => [mesh]);

    binder.sync();
    const plain = mesh.material as THREE.MeshPhysicalMaterial;
    expect(plain.map).not.toBeNull();
    expect(plain.roughnessMap).not.toBeNull();
    expect(plain.emissiveMap).toBeNull();

    layer.applyStroke(stroke({ segmentId: 2, emissive: 1 }));
    binder.sync();
    const glowing = mesh.material as THREE.MeshPhysicalMaterial;
    expect(glowing.emissiveMap).not.toBeNull();
    expect(glowing.emissiveMap?.image).toBe(layer.getEmissiveTexture()?.image);
    expect(glowing.map).not.toBeNull();

    binder.dispose();
    layer.dispose();
  });
});
