import { PAINT_TARGET_IDS } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { PANEL_SOCKET_NAMES, SEGMENT_BONES } from "../../src/mimic/rig";
import {
  normalizeTargetUv,
  PAINT_TARGET_COUNT,
  PANEL_TARGET_OFFSET,
  paintTargetOfObject,
} from "../../src/paint/paintTargets";

/**
 * The wire names a paint target by index, so the client's idea of which part is
 * index 7 has to be the contract's. These pin the mapping from the tags
 * MimicVisual writes on its meshes through to that index.
 */

describe("paint target identity", () => {
  it("covers every shell and every panel socket exactly once", () => {
    expect(PAINT_TARGET_COUNT).toBe(SEGMENT_BONES.length + PANEL_SOCKET_NAMES.length);
    expect(PANEL_TARGET_OFFSET).toBe(SEGMENT_BONES.length);
    expect(new Set(PAINT_TARGET_IDS).size).toBe(PAINT_TARGET_COUNT);
    expect(PAINT_TARGET_IDS[0]).toBe(SEGMENT_BONES[0]);
    expect(PAINT_TARGET_IDS[PANEL_TARGET_OFFSET]).toBe(PANEL_SOCKET_NAMES[0]);
  });

  it("resolves a shell from the segment slot MimicVisual tags it with", () => {
    for (let slot = 0; slot < SEGMENT_BONES.length; slot++) {
      const mesh = new THREE.Mesh();
      mesh.userData["segmentSlot"] = slot;
      expect(paintTargetOfObject(mesh)).toBe(slot);
    }
  });

  it("resolves a panel plate from its socket id", () => {
    for (let index = 0; index < PANEL_SOCKET_NAMES.length; index++) {
      const mesh = new THREE.Mesh();
      mesh.userData["panelSocket"] = PANEL_SOCKET_NAMES[index];
      expect(paintTargetOfObject(mesh)).toBe(PANEL_TARGET_OFFSET + index);
    }
  });

  it("refuses anything that is not a paintable part", () => {
    expect(paintTargetOfObject(new THREE.Mesh())).toBeNull();
    const stray = new THREE.Mesh();
    stray.userData["panelSocket"] = "panel_socket_99";
    expect(paintTargetOfObject(stray)).toBeNull();
    const bellows = new THREE.Mesh();
    bellows.userData["segmentSlot"] = SEGMENT_BONES.length;
    expect(paintTargetOfObject(bellows)).toBeNull();
  });
});

describe("paint target uv normalization", () => {
  it("passes a shell's own uv through untouched", () => {
    expect(normalizeTargetUv(0, 0.25, 0.75)).toEqual([0.25, 0.75]);
    expect(normalizeTargetUv(PANEL_TARGET_OFFSET - 1, 0, 1)).toEqual([0, 1]);
  });

  it("passes a panel plate's own uv through as well", () => {
    // createPanelGeometry writes the plate's unit square itself, so there is no
    // longer an extruder offset to undo here.
    expect(normalizeTargetUv(PANEL_TARGET_OFFSET, 0, 1)).toEqual([0, 1]);
    expect(normalizeTargetUv(PANEL_TARGET_OFFSET, 0.5, 0.5)).toEqual([0.5, 0.5]);
  });

  it("keeps a hit inside the square whatever arrives", () => {
    expect(normalizeTargetUv(0, -3, 4)).toEqual([0, 1]);
    expect(normalizeTargetUv(0, Number.NaN, Number.POSITIVE_INFINITY)).toEqual([0, 0]);
  });
});
