import * as THREE from "three/webgpu";
import { FLOORBOARD_SWATCH_IDS } from "../swatches";
import { buildFloorClutter } from "./clutter";
import type { PropContext } from "./context";
import { chamferedBox, chamferedSlab, makeRandom } from "./geometry";
import { GLASS_PANE_MATERIAL, MOON_BACKDROP_MATERIAL, WALL_PLASTER_MATERIAL } from "./materials";
import { PLANK_TILE_LENGTH_M, WALL_TILE_LENGTH_M } from "./surfaces";
import {
  ANNEX_SCREEN_HEIGHT,
  ANNEX_SCREEN_NORTH,
  ANNEX_SCREEN_WEST,
  CEILING_BEAM_DEPTH,
  CEILING_BEAM_HEIGHT,
  CEILING_BEAM_TOP_Y,
  CEILING_BEAM_ZS,
  DOOR_HEIGHT,
  DOOR_MAX_X,
  DOOR_MIN_X,
  FLOOR_THICKNESS,
  GALLERY_LEGS,
  GALLERY_THICKNESS,
  GALLERY_TOP_Y,
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
  type GalleryLeg,
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
  buildOfficeDoor(ctx);
  buildOfficeStaffBarrier(ctx);
  buildDisplayPlatform(ctx);
  buildGallery(ctx);
  buildAnnexScreens(ctx);
  buildThresholds(ctx);
  buildNightExterior(ctx);
  // Dressing, and the last thing laid down: it scatters over the floor the
  // shell has just established and reads the authored props to keep out of them.
  buildFloorClutter(ctx);
}

/**
 * Projects the plank maps onto a board: u runs along its length in tiles of
 * `PLANK_TILE_LENGTH_M`, v runs from one joint across to the other.
 *
 * The extruder's own UVs come from the profile it was cut from, so every board
 * of a given width received the same coordinates and therefore the same grain
 * down to the texel. Re-projecting here is what lets each board carry its own
 * run of the map, and `uOffset`, `uScale` and `flipV` are what stop the floor
 * from reading as one board printed fifty times.
 */
function projectPlankUv(
  geometry: THREE.BufferGeometry,
  length: number,
  width: number,
  uOffset: number,
  uScale: number,
  flipV: boolean,
): THREE.BufferGeometry {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  if (position === undefined || uv === undefined) {
    return geometry;
  }
  for (let i = 0; i < position.count; i += 1) {
    const u = ((position.getX(i) + length / 2) / PLANK_TILE_LENGTH_M) * uScale + uOffset;
    const across = (position.getZ(i) + width / 2) / width;
    uv.setXY(i, u, flipV ? 1 - across : across);
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * The floorboards.
 *
 * At giant scale the floor is a landscape rather than a surface: it occupies
 * the bottom of nearly every eye-level frame, so each board is built as its own
 * geometry carrying its own slice of the plank map. That costs one cached
 * geometry per board and no draw calls at all — a board appears once, which
 * puts every bucket under the merge threshold, so the whole floor bakes down to
 * one static mesh per tone.
 *
 * Tones are drawn rather than cycled. The old fixed eight-board pattern put a
 * dark board every third board exactly, which the eye reads as stripes; a
 * deterministic draw gives runs and singletons the way sorted stock does.
 */
function buildFloor(ctx: PropContext): void {
  const b = ctx.batcher;
  b.begin("shop.floor", [0, 0, 0], 0, false, 1, "standard", true);

  const [oakId, bleachedId, stainedId] = FLOORBOARD_SWATCH_IDS;
  const oak = ctx.materials.get(oakId);
  const bleached = ctx.materials.get(bleachedId);
  const stained = ctx.materials.get(stainedId);
  const random = makeRandom(9137);

  let cursor = SHOP_MIN_Z;
  let index = 0;
  while (cursor < SHOP_MAX_Z - 0.01) {
    const width = PLANK_WIDTHS[index % PLANK_WIDTHS.length] ?? 0.48;
    const depth = Math.min(width, SHOP_MAX_Z - cursor);
    const board = depth - 0.012;

    const tone = random();
    const material = tone < 0.58 ? oak : tone < 0.85 ? stained : bleached;
    const uOffset = random() * 7;
    const uScale = 0.93 + random() * 0.14;
    const flipV = random() > 0.5;

    b.part(
      ctx.geometry.get(`floor.plank#${String(index)}`, () =>
        projectPlankUv(
          chamferedSlab(WIDTH, FLOOR_THICKNESS, board, 0.008),
          WIDTH,
          board,
          uOffset,
          uScale,
          flipV,
        ),
      ),
      material,
      { y: -FLOOR_THICKNESS / 2, z: cursor + depth / 2 },
      { shadow: false },
    );

    cursor += depth;
    index += 1;
  }
  b.end();
}

/**
 * Projects the plaster map onto a wall piece: u runs along the wall's own run in
 * tiles of `WALL_TILE_LENGTH_M`, v runs from the skirting at 0 to the ceiling
 * at 1 **across the whole room** rather than across the piece.
 *
 * The room-wide v is the load-bearing half. The map carries grime rising off
 * the floor, so a piece mapped 0 to 1 in its own height would print that grime
 * along the top of the spandrel above the window as a dark band hanging in mid
 * air. Taking v from the piece's world height instead means the spandrel simply
 * shows the clean upper reach of the same wall.
 */
function projectWallUv(
  geometry: THREE.BufferGeometry,
  alongZ: boolean,
  centreY: number,
  uOffset: number,
): THREE.BufferGeometry {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  if (position === undefined || uv === undefined) {
    return geometry;
  }
  for (let i = 0; i < position.count; i += 1) {
    const along = alongZ ? position.getZ(i) : position.getX(i);
    uv.setXY(i, along / WALL_TILE_LENGTH_M + uOffset, (centreY + position.getY(i)) / WALL_HEIGHT);
  }
  uv.needsUpdate = true;
  return geometry;
}

function buildWalls(ctx: PropContext): void {
  const b = ctx.batcher;
  const plaster = ctx.materials.get(WALL_PLASTER_MATERIAL);
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

  b.begin("shop.walls", [0, 0, 0], 0, true, 1, "standard", true);
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    if (piece === undefined) {
      continue;
    }
    // The long horizontal axis is Z on the side walls and X on the rest, and
    // the offset keeps two pieces of the same size from showing the same run.
    const alongZ = piece.depth > piece.width;
    const uOffset = i * 0.37;
    const key =
      `wall#${piece.width.toFixed(2)}x${piece.height.toFixed(2)}x${piece.depth.toFixed(2)}` +
      `@${piece.y.toFixed(2)}+${uOffset.toFixed(2)}`;
    b.part(
      ctx.geometry.get(key, () =>
        projectWallUv(chamferedBox(piece.width, piece.height, piece.depth, 0.014), alongZ, piece.y, uOffset),
      ),
      plaster,
      { x: piece.x, y: piece.y, z: piece.z },
    );
  }
  b.end();

  b.begin("shop.trim", [0, 0, 0], 0, false, 1, "standard", true);
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
  b.begin("shop.ceiling", [0, 0, 0], 0, true, 1, "standard", true);
  b.part(
    ctx.geometry.get("ceiling.slab", () =>
      chamferedSlab(WIDTH + WALL_THICKNESS * 2, WALL_THICKNESS, DEPTH + WALL_THICKNESS * 2, 0.014),
    ),
    boards,
    { y: WALL_HEIGHT + WALL_THICKNESS / 2 },
  );
  b.end();

  // The beams hang below the slab at standing headroom: they are walkable
  // bridges since the 2026-08-04 expansion, and their heights live in
  // `zones.ts` because the navigation contract stands players on them.
  b.begin("shop.beams", [0, 0, 0], 0, false, 1, "standard", true);
  const beam = ctx.geometry.get("ceiling.beam", () =>
    chamferedBox(WIDTH, CEILING_BEAM_HEIGHT, CEILING_BEAM_DEPTH, 0.016),
  );
  const hanger = ctx.geometry.get("ceiling.beamHanger", () => chamferedBox(0.08, 0.5, 0.08, 0.01));
  for (const z of CEILING_BEAM_ZS) {
    b.part(beam, beamMaterial, { y: CEILING_BEAM_TOP_Y - CEILING_BEAM_HEIGHT / 2, z }, { shadow: false });
    // Iron drop rods tie each beam back to the slab so the lowered beams read
    // as hung, not floating.
    for (const x of [-6.2, -2.1, 2.1, 6.2]) {
      b.part(hanger, ctx.materials.get("iron_dark_03"), { x, y: CEILING_BEAM_TOP_Y + 0.22, z }, { shadow: false });
    }
  }
  b.end();
}

/**
 * The gallery: wall-hung mezzanine walkways at 2.42 with turned balusters and
 * a brass handrail, the room's second storey (2026-08-04 expansion). The deck
 * boxes come from `zones.ts`, where the navigation contract reads the same
 * numbers, so the floor a player stands on and the slab the map draws cannot
 * drift apart.
 *
 * The support posts under the deck are visual only, exactly like the display
 * cabinets' corner posts: growing 6 cm posts by the capsule radius would strew
 * invisible pillars through the aisles below.
 */
function buildGallery(ctx: PropContext): void {
  const b = ctx.batcher;
  const deckMaterial = ctx.materials.get("walnut_mid_02");
  const fascia = ctx.materials.get("walnut_dark_01");
  const rail = ctx.materials.get("brass_tarnished_01");
  const balusterMaterial = ctx.materials.get("iron_dark_03");

  const baluster = ctx.geometry.get("gallery.baluster", () => new THREE.CylinderGeometry(0.016, 0.02, 0.3, 7));
  const post = ctx.geometry.get("gallery.post", () =>
    chamferedBox(0.07, GALLERY_TOP_Y - GALLERY_THICKNESS, 0.07, 0.012),
  );

  const railFor = (length: number): THREE.BufferGeometry =>
    ctx.geometry.get(`gallery.rail#${length.toFixed(2)}`, () => new THREE.CylinderGeometry(0.022, 0.022, length, 8));
  const deckFor = (leg: GalleryLeg): THREE.BufferGeometry =>
    ctx.geometry.get(`gallery.deck#${leg.id}`, () =>
      chamferedSlab(leg.maxX - leg.minX, GALLERY_THICKNESS, leg.maxZ - leg.minZ, 0.014),
    );
  const fasciaFor = (length: number): THREE.BufferGeometry =>
    ctx.geometry.get(`gallery.fascia#${length.toFixed(2)}`, () => chamferedBox(length, 0.12, 0.04, 0.008));

  b.begin("shop.gallery", [0, 0, 0], 0, true, 1, "standard", true);
  for (const leg of GALLERY_LEGS) {
    const centreX = (leg.minX + leg.maxX) / 2;
    const centreZ = (leg.minZ + leg.maxZ) / 2;
    const width = leg.maxX - leg.minX;
    const depth = leg.maxZ - leg.minZ;
    b.part(deckFor(leg), deckMaterial, { x: centreX, y: GALLERY_TOP_Y - GALLERY_THICKNESS / 2, z: centreZ });

    // The open edge: fascia board, brass handrail, and a run of balusters.
    // Wall legs open toward the room on x; the north and south runs open on z.
    const alongX = width > depth;
    const openEdge =
      leg.id === "gallery_south"
        ? { x: centreX, z: leg.minZ + 0.02 }
        : leg.id === "gallery_north_east"
          ? { x: centreX, z: leg.maxZ - 0.02 }
          : leg.id === "gallery_east"
            ? { x: leg.minX + 0.02, z: centreZ }
            : { x: leg.maxX - 0.02, z: centreZ };
    const runLength = alongX ? width : depth;
    const railY = GALLERY_TOP_Y + 0.3;

    b.part(
      fasciaFor(runLength),
      fascia,
      { x: openEdge.x, y: GALLERY_TOP_Y - 0.02, z: openEdge.z, ry: alongX ? 0 : Math.PI / 2 },
      { shadow: false },
    );
    b.part(
      railFor(runLength),
      rail,
      { x: openEdge.x, y: railY, z: openEdge.z, rz: alongX ? Math.PI / 2 : 0, rx: alongX ? 0 : Math.PI / 2 },
      { shadow: false },
    );
    const balusters = Math.max(Math.round(runLength / 0.45), 2);
    for (let i = 0; i < balusters; i += 1) {
      const t = (i + 0.5) / balusters - 0.5;
      b.part(
        baluster,
        balusterMaterial,
        {
          x: openEdge.x + (alongX ? t * runLength : 0),
          y: GALLERY_TOP_Y + 0.15,
          z: openEdge.z + (alongX ? 0 : t * runLength),
        },
        { shadow: false },
      );
    }

    // Support posts down to the floor, spaced along the open edge.
    const posts = Math.max(Math.round(runLength / 2.4), 1);
    for (let i = 0; i < posts; i += 1) {
      const t = (i + 0.5) / posts - 0.5;
      b.part(
        post,
        fascia,
        {
          x: openEdge.x + (alongX ? t * runLength : 0),
          y: (GALLERY_TOP_Y - GALLERY_THICKNESS) / 2,
          z: openEdge.z + (alongX ? 0 : t * runLength),
        },
        { shadow: false },
      );
    }
  }
  b.end();
}

/**
 * The Curio Annex screens: two tall folding panels that close the salon
 * alcove against the south wall (2026-08-04 expansion). Their boxes come from
 * `zones.ts`, where the navigation contract blocks movement and sight with
 * the same volumes.
 */
function buildAnnexScreens(ctx: PropContext): void {
  const b = ctx.batcher;
  const panel = ctx.materials.get("paint_midnight_02");
  const trim = ctx.materials.get("walnut_dark_01");

  b.begin("shop.annexScreens", [0, 0, 0], 0, true, 1, "standard", true);
  for (const screen of [ANNEX_SCREEN_WEST, ANNEX_SCREEN_NORTH]) {
    const width = screen.max.x - screen.min.x;
    const depth = screen.max.z - screen.min.z;
    const centreX = (screen.min.x + screen.max.x) / 2;
    const centreZ = (screen.min.z + screen.max.z) / 2;
    const alongZ = depth > width;
    const run = alongZ ? depth : width;
    // Three hinged panels, each turned a touch, read as a folding screen where
    // one flat slab reads as a wall.
    const panels = 3;
    for (let i = 0; i < panels; i += 1) {
      const t = (i + 0.5) / panels - 0.5;
      const lean = (i % 2 === 0 ? 1 : -1) * 0.06;
      b.part(
        ctx.geometry.get(`annex.panel#${(run / panels).toFixed(2)}`, () =>
          chamferedBox(run / panels - 0.03, ANNEX_SCREEN_HEIGHT - 0.08, 0.05, 0.012),
        ),
        panel,
        {
          x: centreX + (alongZ ? 0 : t * run),
          y: (ANNEX_SCREEN_HEIGHT - 0.08) / 2,
          z: centreZ + (alongZ ? t * run : 0),
          ry: (alongZ ? Math.PI / 2 : 0) + lean,
        },
      );
      b.part(
        ctx.geometry.get(`annex.cap#${(run / panels).toFixed(2)}`, () =>
          chamferedBox(run / panels - 0.01, 0.06, 0.07, 0.01),
        ),
        trim,
        {
          x: centreX + (alongZ ? 0 : t * run),
          y: ANNEX_SCREEN_HEIGHT - 0.05,
          z: centreZ + (alongZ ? t * run : 0),
          ry: (alongZ ? Math.PI / 2 : 0) + lean,
        },
        { shadow: false },
      );
    }
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

  b.begin("shop.window", [0, 0, 0], 0, true, 1, "standard", true);
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

  b.begin("shop.windowBars", [0, 0, 0], 0, false, 1, "standard", true);
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

  b.begin("shop.door", [centreX, 0, z], 0, false, 1, "standard", true);
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

/**
 * The Security Office door, which is the one moving part of the shell.
 *
 * The Inspector is staged inside the office while the Mimics fold (§5.9), and
 * before this the room had a doorway and no door: the waiting Inspector looked
 * straight down it at a shop full of people choosing hiding places. Shut, the
 * leaf is the whole of that fix — the partition is solid to a metre and the
 * player is 0.35 m tall, so a closed door leaves nothing to see. It opens on the
 * hunt, over the `door_open` cue the phase already plays.
 *
 * Every part is authored around the hinge: the geometry carries the offset and
 * each mesh sits at the hinge itself with no rotation of its own, so a caller
 * swings the door by writing one angle onto the group's children and nothing
 * else has to know how the leaf was built. It is a hero prop for the same
 * reason — a batched part is baked into a shared mesh and cannot move.
 */
/**
 * The leaf overlaps the opening rather than fitting inside it, on both axes and
 * at the head. A door hung to the exact size of its gap leaves a slit down the
 * closing edge, and at this scale a two-centimetre slit is a hand's width of
 * shop floor: the first shot taken through the shut door showed shelving
 * through it. Overlapping costs nothing, because the leaf swings clear into the
 * office rather than into its own frame.
 */
export const OFFICE_DOOR_LEAF_WIDTH_M = OFFICE_DOOR_MAX_Z - OFFICE_DOOR_MIN_Z + 0.1;
export const OFFICE_DOOR_LEAF_HEIGHT_M = 2.22;
/** Where the leaf hangs, so the swing and the nav blocker agree on the gap. */
export const OFFICE_DOOR_HINGE: readonly [number, number, number] = [
  OFFICE_MIN_X,
  0,
  OFFICE_DOOR_MIN_Z - 0.05,
];
export const OFFICE_DOOR_NAME = "shop.officeDoor";
export const OFFICE_STAFF_BARRIER_NAME = "shop.officeStaffOnlyChain";

function buildOfficeDoor(ctx: PropContext): void {
  const b = ctx.batcher;
  const panel = ctx.materials.get("paint_midnight_02");
  const brass = ctx.materials.get("brass_tarnished_01");
  const width = OFFICE_DOOR_LEAF_WIDTH_M;
  const height = OFFICE_DOOR_LEAF_HEIGHT_M;

  b.begin(OFFICE_DOOR_NAME, OFFICE_DOOR_HINGE, 0, true, 1, "standard", true);
  b.part(
    ctx.geometry.get(`officeDoor.leaf#${width.toFixed(2)}`, () => {
      const leaf = chamferedBox(0.06, height, width, 0.012);
      leaf.translate(0, height / 2 + 0.02, width / 2);
      return leaf;
    }),
    panel,
    {},
  );
  b.part(
    ctx.geometry.get(`officeDoor.handle#${width.toFixed(2)}`, () => {
      const handle = chamferedBox(0.05, 0.2, 0.05, 0.008);
      handle.translate(0.055, 0.95, width - 0.12);
      return handle;
    }),
    brass,
    {},
  );
  b.end();
}

/**
 * Fiction for the office's permanent Mimic exclusion. The door swings open for
 * the hunt, but this low brass rope remains across the threshold so a hiding
 * player meets a visible boundary instead of an invisible wall.
 */
function buildOfficeStaffBarrier(ctx: PropContext): void {
  const b = ctx.batcher;
  const brass = ctx.materials.get("brass_tarnished_01");
  const plaque = ctx.materials.get("paint_midnight_02");
  const z0 = OFFICE_DOOR_MIN_Z + 0.03;
  const z1 = OFFICE_DOOR_MAX_Z - 0.03;
  const midZ = (z0 + z1) * 0.5;
  const x = OFFICE_MIN_X - 0.075;

  b.begin(OFFICE_STAFF_BARRIER_NAME, [0, 0, 0], 0, true, 1, "standard", false);
  b.part(
    ctx.geometry.get("officeStaffBarrier.rope", () => {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, 0.48, z0),
        new THREE.Vector3(x, 0.36, midZ),
        new THREE.Vector3(x, 0.48, z1),
      ]);
      return new THREE.TubeGeometry(curve, 24, 0.018, 6, false);
    }),
    brass,
    {},
  );
  b.part(
    ctx.geometry.get("officeStaffBarrier.plaque", () => chamferedBox(0.038, 0.15, 0.34, 0.009)),
    plaque,
    { x: x - 0.01, y: 0.33, z: midZ },
  );
  // Two ivory-brass bars make the hanging plaque read as official signage at
  // Mimic eye height without introducing a texture/material shader variant.
  const mark = ctx.geometry.get("officeStaffBarrier.mark", () => chamferedBox(0.012, 0.082, 0.024, 0.003));
  for (const dz of [-0.055, 0, 0.055]) {
    b.part(mark, brass, { x: x - 0.034, y: 0.33, z: midZ + dz }, { shadow: false });
  }
  b.end();
}

function buildOfficePartition(ctx: PropContext): void {
  const b = ctx.batcher;
  const panel = ctx.materials.get("paint_midnight_02");
  const trim = ctx.materials.get("walnut_dark_01");
  const glass = ctx.materials.get(GLASS_PANE_MATERIAL);
  const northLength = SHOP_MAX_X - OFFICE_MIN_X;
  const westLength = SHOP_MAX_Z - OFFICE_MIN_Z;

  b.begin("shop.officePartition", [0, 0, 0], 0, true, 1, "standard", true);
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

  b.begin("shop.officeGlazing", [0, 0, 0], 0, false, 1, "standard", true);
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
  b.begin("shop.thresholds", [0, 0, 0], 0, false, 1, "standard", true);

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
