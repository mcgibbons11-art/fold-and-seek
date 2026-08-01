import type * as THREE from "three/webgpu";

import { PAINT_TARGET_IDS, PANEL_SOCKET_NAMES, RIG_SEGMENT_BONES } from "@foldseek/shared";

import { PANEL_SOCKET_NAMES as RIG_PANEL_SOCKETS, SEGMENT_BONES } from "../mimic/rig";

/**
 * Atlas layout for body painting.
 *
 * The Mimic is not one continuous surface and its shells do not share a UV
 * chart: `mimicGeometry.writeSegmentShell` gives every segment the same
 * cylindrical square, u running once around the cross-section and v running from
 * the bone's base to its tip, so all nineteen shells occupy exactly the same
 * 0..1 space. Painting therefore needs a tile per part rather than one chart,
 * and the atlas is a grid of tiles indexed by the shared PAINT_TARGET_IDS order:
 * the nineteen segments first, then the eight panel sockets.
 *
 * The grid is eight columns by four rows, so at the default 1024 px atlas a tile
 * is 128 px around by 256 px along the bone. Thirty-two slots hold the
 * twenty-seven targets with room for a future part, and every tile edge lands on
 * an integer pixel at any power-of-two atlas size.
 *
 * A stamp is clipped to its own tile, so paint can never bleed onto a
 * neighbouring body part. Segment tiles wrap horizontally instead, because u = 0
 * and u = 1 are the same seam line on the shell and a stroke crossing it would
 * otherwise be cut in half.
 */

export const PAINT_TILE_COLUMNS = 8;
export const PAINT_TILE_ROWS = 4;
export const PAINT_TILE_COUNT = PAINT_TILE_COLUMNS * PAINT_TILE_ROWS;
export const PAINT_TARGET_COUNT = PAINT_TARGET_IDS.length;
export const DEFAULT_ATLAS_SIZE = 1_024;

/** Panel sockets follow the segments in the shared target order. */
export const PANEL_TARGET_OFFSET = RIG_SEGMENT_BONES.length;

if (PAINT_TARGET_COUNT > PAINT_TILE_COUNT) {
  throw new Error("Paint atlas has fewer tiles than the rig has paintable parts");
}

// The wire writes a target as an index, so the client's rig order and the
// shared contract's order have to be the same list. Checking it here turns a
// silent mispaint on a peer's body into a startup failure.
for (let i = 0; i < SEGMENT_BONES.length; i++) {
  if (SEGMENT_BONES[i] !== RIG_SEGMENT_BONES[i]) {
    throw new Error(`Segment order diverged from the rig contract at slot ${i}`);
  }
}
for (let i = 0; i < RIG_PANEL_SOCKETS.length; i++) {
  if (RIG_PANEL_SOCKETS[i] !== PANEL_SOCKET_NAMES[i]) {
    throw new Error(`Panel socket order diverged from the rig contract at slot ${i}`);
  }
}

export interface PaintTile {
  /** Pixel rectangle inside the atlas. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** True for the cylindrical shells, whose u wraps at the seam. */
  readonly wrapU: boolean;
}

export function paintTileOf(targetIndex: number, atlasSize: number): PaintTile {
  const width = atlasSize / PAINT_TILE_COLUMNS;
  const height = atlasSize / PAINT_TILE_ROWS;
  const column = targetIndex % PAINT_TILE_COLUMNS;
  const row = Math.floor(targetIndex / PAINT_TILE_COLUMNS);
  return {
    x: column * width,
    y: row * height,
    width,
    height,
    wrapU: targetIndex < PANEL_TARGET_OFFSET,
  };
}

/** UV offset and repeat that map a target's 0..1 square onto its tile. */
export function paintTileTransform(targetIndex: number): {
  readonly offsetU: number;
  readonly offsetV: number;
  readonly repeatU: number;
  readonly repeatV: number;
} {
  const column = targetIndex % PAINT_TILE_COLUMNS;
  const row = Math.floor(targetIndex / PAINT_TILE_COLUMNS);
  return {
    offsetU: column / PAINT_TILE_COLUMNS,
    // Texture v runs up from the bottom of the image while the tile grid is laid
    // out from the top, so row zero is the topmost band of the atlas.
    offsetV: 1 - (row + 1) / PAINT_TILE_ROWS,
    repeatU: 1 / PAINT_TILE_COLUMNS,
    repeatV: 1 / PAINT_TILE_ROWS,
  };
}

/**
 * Resolves a picked mesh to a paint target. MimicVisual tags every shell with
 * its segment slot and every panel plate with its socket id, which is the only
 * contract this needs from it.
 */
export function paintTargetOfObject(object: THREE.Object3D): number | null {
  const slot = object.userData["segmentSlot"];
  if (typeof slot === "number" && slot >= 0 && slot < PANEL_TARGET_OFFSET) {
    return slot;
  }
  const socket = object.userData["panelSocket"];
  if (typeof socket === "string") {
    const index = PANEL_SOCKET_NAMES.indexOf(socket as (typeof PANEL_SOCKET_NAMES)[number]);
    if (index >= 0) return PANEL_TARGET_OFFSET + index;
  }
  return null;
}

/**
 * Puts a hit's UV into the target's own 0..1 square.
 *
 * Shells already publish 0..1. Panel plates come out of `ExtrudeGeometry`, whose
 * UV generator writes the shape's own coordinates, so a unit plate arrives at
 * roughly -0.5..0.5 and is shifted here. The panel mapping is therefore
 * approximate at the bevelled rim, where the extruder emits side-wall UVs on a
 * different scale; the shells, which are what a player actually paints, are
 * exact.
 */
export function normalizeTargetUv(targetIndex: number, u: number, v: number): [number, number] {
  if (targetIndex < PANEL_TARGET_OFFSET) {
    return [clamp01(u), clamp01(v)];
  }
  return [clamp01(u + 0.5), clamp01(v + 0.5)];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
