import * as THREE from "three/webgpu";
import type { PropContext } from "./context";
import { chamferedBox, chamferedSlab } from "./geometry";
import { GLASS_PANE_MATERIAL, MOON_BACKDROP_MATERIAL } from "./materials";
import {
  DOOR_HEIGHT,
  DOOR_MAX_X,
  DOOR_MIN_X,
  FLOOR_THICKNESS,
  OFFICE_DOOR_MAX_Z,
  OFFICE_DOOR_MIN_Z,
  OFFICE_MIN_X,
  OFFICE_MIN_Z,
  SHOP_MAX_X,
  SHOP_MAX_Z,
  SHOP_MIN_X,
  SHOP_MIN_Z,
  WALL_HEIGHT,
  WALL_THICKNESS,
  WINDOW_HEAD_Y,
  WINDOW_MAX_X,
  WINDOW_MIN_X,
  WINDOW_SILL_Y,
} from "../zones";

/**
 * Shell of the shop: floor, walls, ceiling, the window bay the moonlight comes
 * through, the street door, and the partition that makes the Security Office
 * visually separate (§42.1, §5.7).
 *
 * Walls are hero meshes because they are the shadow casters that shape the
 * moon key; everything repeated (planks, beams, glazing bars) batches.
 */

const WIDTH = SHOP_MAX_X - SHOP_MIN_X;
const DEPTH = SHOP_MAX_Z - SHOP_MIN_Z;
const PLANK_WIDTHS = [0.22, 0.26, 0.2, 0.24, 0.28, 0.22, 0.26, 0.24] as const;

interface WallPiece {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function buildArchitecture(ctx: PropContext): void {
  buildFloor(ctx);
  buildWalls(ctx);
  buildCeiling(ctx);
  buildWindowBay(ctx);
  buildStreetDoor(ctx);
  buildOfficePartition(ctx);
  buildDisplayPlatform(ctx);
  buildThresholds(ctx);
  buildNightExterior(ctx);
}

function buildFloor(ctx: PropContext): void {
  const b = ctx.batcher;
  b.begin("shop.floor", [0, 0, 0], 0, false);

  // Two close walnut tones with an occasional pale board. A wider spread reads
  // as stripes rather than as a floor.
  const tonePattern = [
    "walnut_mid_02",
    "walnut_dark_01",
    "walnut_mid_02",
    "walnut_mid_02",
    "walnut_dark_01",
    "walnut_mid_02",
    "walnut_dark_01",
    "walnut_mid_02",
  ];
  const tones = tonePattern.map((id) => ctx.materials.get(id));
  let cursor = SHOP_MIN_Z;
  let index = 0;
  while (cursor < SHOP_MAX_Z - 0.01) {
    const width = PLANK_WIDTHS[index % PLANK_WIDTHS.length] ?? 0.48;
    const depth = Math.min(width, SHOP_MAX_Z - cursor);
    const material = tones[index % tones.length];
    if (material !== undefined) {
      b.part(
        ctx.geometry.get(`floor.plank#${depth.toFixed(3)}`, () =>
          chamferedSlab(WIDTH, FLOOR_THICKNESS, depth - 0.012, 0.008),
        ),
        material,
        { y: -FLOOR_THICKNESS / 2, z: cursor + depth / 2 },
        { shadow: false },
      );
    }
    cursor += depth;
    index += 1;
  }
  b.end();
}

function buildWalls(ctx: PropContext): void {
  const b = ctx.batcher;
  const plaster = ctx.materials.get("paint_cream_01");
  const trim = ctx.materials.get("walnut_dark_01");

  const northZ = SHOP_MIN_Z - WALL_THICKNESS / 2;
  const pierWest = WINDOW_MIN_X - SHOP_MIN_X;
  const pierMid = DOOR_MIN_X - WINDOW_MAX_X;
  const pierEast = SHOP_MAX_X - DOOR_MAX_X;

  const pieces: readonly WallPiece[] = [
    // North wall, pierced by the window bay and the street door.
    { width: pierWest, height: WALL_HEIGHT, depth: WALL_THICKNESS, x: SHOP_MIN_X + pierWest / 2, y: WALL_HEIGHT / 2, z: northZ },
    { width: pierMid, height: WALL_HEIGHT, depth: WALL_THICKNESS, x: WINDOW_MAX_X + pierMid / 2, y: WALL_HEIGHT / 2, z: northZ },
    { width: pierEast, height: WALL_HEIGHT, depth: WALL_THICKNESS, x: DOOR_MAX_X + pierEast / 2, y: WALL_HEIGHT / 2, z: northZ },
    {
      width: WINDOW_MAX_X - WINDOW_MIN_X,
      height: WINDOW_SILL_Y,
      depth: WALL_THICKNESS,
      x: (WINDOW_MIN_X + WINDOW_MAX_X) / 2,
      y: WINDOW_SILL_Y / 2,
      z: northZ,
    },
    {
      width: WINDOW_MAX_X - WINDOW_MIN_X,
      height: WALL_HEIGHT - WINDOW_HEAD_Y,
      depth: WALL_THICKNESS,
      x: (WINDOW_MIN_X + WINDOW_MAX_X) / 2,
      y: (WALL_HEIGHT + WINDOW_HEAD_Y) / 2,
      z: northZ,
    },
    {
      width: DOOR_MAX_X - DOOR_MIN_X,
      height: WALL_HEIGHT - DOOR_HEIGHT,
      depth: WALL_THICKNESS,
      x: (DOOR_MIN_X + DOOR_MAX_X) / 2,
      y: (WALL_HEIGHT + DOOR_HEIGHT) / 2,
      z: northZ,
    },
    // South, west and east walls, each overlapping the corner it meets.
    {
      width: WIDTH + WALL_THICKNESS * 2,
      height: WALL_HEIGHT,
      depth: WALL_THICKNESS,
      x: 0,
      y: WALL_HEIGHT / 2,
      z: SHOP_MAX_Z + WALL_THICKNESS / 2,
    },
    {
      width: WALL_THICKNESS,
      height: WALL_HEIGHT,
      depth: DEPTH + WALL_THICKNESS * 2,
      x: SHOP_MIN_X - WALL_THICKNESS / 2,
      y: WALL_HEIGHT / 2,
      z: 0,
    },
    {
      width: WALL_THICKNESS,
      height: WALL_HEIGHT,
      depth: DEPTH + WALL_THICKNESS * 2,
      x: SHOP_MAX_X + WALL_THICKNESS / 2,
      y: WALL_HEIGHT / 2,
      z: 0,
    },
  ];

  b.begin("shop.walls", [0, 0, 0], 0, true);
  for (const piece of pieces) {
    b.part(
      ctx.geometry.get(`wall#${piece.width.toFixed(2)}x${piece.height.toFixed(2)}x${piece.depth.toFixed(2)}`, () =>
        chamferedBox(piece.width, piece.height, piece.depth, 0.014),
      ),
      plaster,
      { x: piece.x, y: piece.y, z: piece.z },
    );
  }
  b.end();

  b.begin("shop.trim", [0, 0, 0], 0, false);
  const skirting = ctx.geometry.get("trim.skirting", () => chamferedBox(1, 0.19, 0.05, 0.008));
  const runs: readonly (readonly [number, number, number, number])[] = [
    [WIDTH, 0, SHOP_MIN_Z + 0.025, 0],
    [WIDTH, 0, SHOP_MAX_Z - 0.025, 0],
    [DEPTH, SHOP_MIN_X + 0.025, 0, Math.PI / 2],
    [DEPTH, SHOP_MAX_X - 0.025, 0, Math.PI / 2],
  ];
  for (const [length, x, z, ry] of runs) {
    b.part(skirting, trim, { x, y: 0.095, z, ry, sx: length }, { shadow: false });
  }
  b.end();
}

function buildCeiling(ctx: PropContext): void {
  const b = ctx.batcher;
  const boards = ctx.materials.get("walnut_dark_01");
  const beamMaterial = ctx.materials.get("walnut_mid_02");

  // The slab casts: the moon key comes in high and would otherwise light the
  // back rooms straight through the roof.
  b.begin("shop.ceiling", [0, 0, 0], 0, true);
  b.part(
    ctx.geometry.get("ceiling.slab", () =>
      chamferedSlab(WIDTH + WALL_THICKNESS * 2, WALL_THICKNESS, DEPTH + WALL_THICKNESS * 2, 0.014),
    ),
    boards,
    { y: WALL_HEIGHT + WALL_THICKNESS / 2 },
  );
  b.end();

  b.begin("shop.beams", [0, 0, 0], 0, false);
  const beam = ctx.geometry.get("ceiling.beam", () => chamferedBox(WIDTH, 0.26, 0.22, 0.016));
  for (const z of [-3.6, -1.2, 1.2, 3.6]) {
    b.part(beam, beamMaterial, { y: WALL_HEIGHT - 0.13, z }, { shadow: false });
  }
  b.end();
}

function buildWindowBay(ctx: PropContext): void {
  const b = ctx.batcher;
  const wood = ctx.materials.get("walnut_dark_01");
  const glass = ctx.materials.get(GLASS_PANE_MATERIAL);
  const openingWidth = WINDOW_MAX_X - WINDOW_MIN_X;
  const openingHeight = WINDOW_HEAD_Y - WINDOW_SILL_Y;
  const centreX = (WINDOW_MIN_X + WINDOW_MAX_X) / 2;
  const frameZ = SHOP_MIN_Z + 0.02;

  b.begin("shop.window", [0, 0, 0], 0, true);
  b.part(
    ctx.geometry.get("window.sill", () => chamferedSlab(openingWidth + 0.4, 0.1, 0.42, 0.014)),
    wood,
    { x: centreX, y: WINDOW_SILL_Y - 0.05, z: SHOP_MIN_Z + 0.09 },
  );
  b.part(
    ctx.geometry.get("window.head", () => chamferedBox(openingWidth + 0.24, 0.14, 0.24, 0.014)),
    wood,
    { x: centreX, y: WINDOW_HEAD_Y + 0.07, z: frameZ },
  );
  const jamb = ctx.geometry.get("window.jamb", () => chamferedBox(0.12, openingHeight + 0.14, 0.24, 0.014));
  for (const side of [-1, 1]) {
    b.part(jamb, wood, { x: centreX + (side * (openingWidth + 0.12)) / 2, y: (WINDOW_SILL_Y + WINDOW_HEAD_Y) / 2, z: frameZ });
  }
  b.end();

  b.begin("shop.windowBars", [0, 0, 0], 0, false);
  const mullion = ctx.geometry.get("window.mullion", () => chamferedBox(0.055, openingHeight, 0.1, 0.008));
  for (let i = 1; i <= 3; i += 1) {
    b.part(
      mullion,
      wood,
      { x: WINDOW_MIN_X + (openingWidth * i) / 4, y: (WINDOW_SILL_Y + WINDOW_HEAD_Y) / 2, z: frameZ },
      { shadow: false },
    );
  }
  b.part(
    ctx.geometry.get("window.transom", () => chamferedBox(openingWidth, 0.055, 0.1, 0.008)),
    wood,
    { x: centreX, y: WINDOW_SILL_Y + openingHeight * 0.68, z: frameZ },
    { shadow: false },
  );
  b.part(
    ctx.geometry.get("window.glazing", () => new THREE.PlaneGeometry(openingWidth, openingHeight)),
    glass,
    { x: centreX, y: (WINDOW_SILL_Y + WINDOW_HEAD_Y) / 2, z: frameZ + 0.03 },
    { shadow: false, receive: false },
  );
  b.end();
}

function buildStreetDoor(ctx: PropContext): void {
  const b = ctx.batcher;
  const wood = ctx.materials.get("walnut_dark_01");
  const glass = ctx.materials.get(GLASS_PANE_MATERIAL);
  const brass = ctx.materials.get("brass_tarnished_01");
  const width = DOOR_MAX_X - DOOR_MIN_X;
  const centreX = (DOOR_MIN_X + DOOR_MAX_X) / 2;
  const z = SHOP_MIN_Z + 0.03;

  b.begin("shop.door", [centreX, 0, z], 0, false);
  b.part(ctx.geometry.get("door.leaf", () => chamferedBox(width - 0.08, DOOR_HEIGHT - 0.06, 0.06, 0.012)), wood, {
    y: (DOOR_HEIGHT - 0.06) / 2,
  });
  b.part(
    ctx.geometry.get("door.glass", () => new THREE.PlaneGeometry(width - 0.36, DOOR_HEIGHT * 0.42)),
    glass,
    { y: DOOR_HEIGHT * 0.66, z: 0.035 },
    { shadow: false, receive: false },
  );
  b.part(ctx.geometry.get("door.handle", () => new THREE.CylinderGeometry(0.016, 0.016, 0.16, 8)), brass, {
    x: width / 2 - 0.16,
    y: 1.0,
    z: 0.06,
  });
  b.part(
    ctx.geometry.get("door.frame", () => chamferedBox(width + 0.12, DOOR_HEIGHT + 0.08, 0.1, 0.01)),
    wood,
    { y: (DOOR_HEIGHT + 0.08) / 2, z: -0.03 },
    { shadow: false },
  );
  b.end();
}

function buildOfficePartition(ctx: PropContext): void {
  const b = ctx.batcher;
  const panel = ctx.materials.get("paint_midnight_02");
  const trim = ctx.materials.get("walnut_dark_01");
  const glass = ctx.materials.get(GLASS_PANE_MATERIAL);
  const northLength = SHOP_MAX_X - OFFICE_MIN_X;
  const westLength = SHOP_MAX_Z - OFFICE_MIN_Z;

  b.begin("shop.officePartition", [0, 0, 0], 0, true);
  // North face: solid dado, glazed centre, solid header.
  b.part(
    ctx.geometry.get(`partition.dado#${northLength.toFixed(2)}`, () => chamferedBox(northLength, 1.0, 0.1, 0.012)),
    panel,
    { x: OFFICE_MIN_X + northLength / 2, y: 0.5, z: OFFICE_MIN_Z },
  );
  b.part(
    ctx.geometry.get(`partition.header#${northLength.toFixed(2)}`, () => chamferedBox(northLength, 1.0, 0.1, 0.012)),
    panel,
    { x: OFFICE_MIN_X + northLength / 2, y: 3.1, z: OFFICE_MIN_Z },
  );
  // West face, split around the office door.
  const southRun = SHOP_MAX_Z - OFFICE_DOOR_MAX_Z;
  const northRun = OFFICE_DOOR_MIN_Z - OFFICE_MIN_Z;
  b.part(
    ctx.geometry.get(`partition.westA#${northRun.toFixed(2)}`, () => chamferedBox(0.1, WALL_HEIGHT, northRun, 0.012)),
    panel,
    { x: OFFICE_MIN_X, y: WALL_HEIGHT / 2, z: OFFICE_MIN_Z + northRun / 2 },
  );
  b.part(
    ctx.geometry.get(`partition.westB#${southRun.toFixed(2)}`, () => chamferedBox(0.1, WALL_HEIGHT, southRun, 0.012)),
    panel,
    { x: OFFICE_MIN_X, y: WALL_HEIGHT / 2, z: OFFICE_DOOR_MAX_Z + southRun / 2 },
  );
  b.part(
    ctx.geometry.get("partition.doorHead", () =>
      chamferedBox(0.1, WALL_HEIGHT - 2.2, OFFICE_DOOR_MAX_Z - OFFICE_DOOR_MIN_Z, 0.012),
    ),
    panel,
    { x: OFFICE_MIN_X, y: (WALL_HEIGHT + 2.2) / 2, z: (OFFICE_DOOR_MIN_Z + OFFICE_DOOR_MAX_Z) / 2 },
  );
  b.end();

  b.begin("shop.officeGlazing", [0, 0, 0], 0, false);
  b.part(
    ctx.geometry.get(`partition.glass#${northLength.toFixed(2)}`, () => new THREE.PlaneGeometry(northLength, 1.6)),
    glass,
    { x: OFFICE_MIN_X + northLength / 2, y: 1.8, z: OFFICE_MIN_Z },
    { shadow: false, receive: false },
  );
  const bar = ctx.geometry.get("partition.bar", () => chamferedBox(0.05, 1.6, 0.06, 0.008));
  for (let i = 1; i <= 4; i += 1) {
    b.part(bar, trim, { x: OFFICE_MIN_X + (northLength * i) / 5, y: 1.8, z: OFFICE_MIN_Z }, { shadow: false });
  }
  b.part(
    ctx.geometry.get(`partition.rail#${northLength.toFixed(2)}`, () => chamferedBox(northLength, 0.08, 0.14, 0.01)),
    trim,
    { x: OFFICE_MIN_X + northLength / 2, y: 1.0, z: OFFICE_MIN_Z },
    { shadow: false },
  );
  b.part(
    ctx.geometry.get(`partition.westRail#${westLength.toFixed(2)}`, () => chamferedBox(0.14, 0.08, westLength, 0.01)),
    trim,
    { x: OFFICE_MIN_X, y: 1.0, z: OFFICE_MIN_Z + westLength / 2 },
    { shadow: false },
  );
  b.end();
}

/** Raised platform the window display stands on (§10.2 zone A). */
function buildDisplayPlatform(ctx: PropContext): void {
  const b = ctx.batcher;
  const deck = ctx.materials.get("oak_pale_03");
  const fascia = ctx.materials.get("walnut_dark_01");
  const width = WINDOW_MAX_X - WINDOW_MIN_X;
  const depth = 0.9;
  const centreX = (WINDOW_MIN_X + WINDOW_MAX_X) / 2;
  const centreZ = SHOP_MIN_Z + depth / 2 + 0.1;

  b.begin("shop.displayPlatform", [centreX, 0, centreZ], 0, false);
  b.part(ctx.geometry.get("platform.deck", () => chamferedSlab(width, 0.34, depth, 0.014)), deck, { y: 0.17 });
  b.part(ctx.geometry.get("platform.fascia", () => chamferedBox(width + 0.04, 0.1, 0.05, 0.008)), fascia, {
    y: 0.31,
    z: depth / 2,
  }, { shadow: false });
  b.end();
}

/** Brass strips at the zone thresholds, which is where audio and streaming switch. */
function buildThresholds(ctx: PropContext): void {
  const b = ctx.batcher;
  const brass = ctx.materials.get("brass_aged_02");
  b.begin("shop.thresholds", [0, 0, 0], 0, false);

  const strip = ctx.geometry.get("threshold.strip", () => chamferedSlab(1, 0.012, 0.09, 0.004));
  const crossings: readonly (readonly [number, number, number, number])[] = [
    [-4.6, -0.5, Math.PI / 2, 5.4],
    [3.9, -1.6, Math.PI / 2, 7.7],
    [-3.85, 2.2, 0, 7.3],
    [2.3, 2.2, 0, 5.0],
  ];
  for (const [x, z, ry, length] of crossings) {
    b.part(strip, brass, { x, y: 0.006, z, ry, sx: length }, { shadow: false });
  }
  b.end();
}

/**
 * Unlit night street behind the window. Without it the bay reads as a hole
 * punched in the wall rather than as a view onto the street.
 */
function buildNightExterior(ctx: PropContext): void {
  const b = ctx.batcher;
  const backdrop = ctx.materials.get(MOON_BACKDROP_MATERIAL);
  b.begin("shop.exterior", [0, 0, 0], 0, false);

  b.part(
    ctx.geometry.get("exterior.sky", () => new THREE.PlaneGeometry(26, 14)),
    backdrop,
    { x: -3, y: 4.5, z: SHOP_MIN_Z - 9 },
    { shadow: false, receive: false },
  );
  b.part(
    ctx.geometry.get("exterior.street", () => new THREE.PlaneGeometry(26, 9)),
    ctx.materials.get("slate_grey_02"),
    { x: -3, y: -0.05, z: SHOP_MIN_Z - 4.5, rx: -Math.PI / 2 },
    { shadow: false },
  );
  b.end();
}
