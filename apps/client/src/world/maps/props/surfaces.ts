import type { QualityTier } from "../../../rendering/quality";
import { FLOORBOARD_SWATCH_IDS, type MapSwatch } from "../swatches";

/**
 * The shop's procedural surfaces: what each material family is made of, as a
 * field rather than as an image.
 *
 * Every map in the room is generated into a canvas at load, because the Portals
 * bundle carries no texture files and a runtime fetch is blocked outright. What
 * lives here is the part of that generation with no DOM in it — the fields, the
 * tiling, and the byte count — so the room's surfaces can be measured headlessly
 * and `materials.ts` is left holding only the canvas work and the binding.
 *
 * A field is a pure `(u, v) -> 0..1`, where 1 is the surface at its cleanest and
 * 0 is the darkest a grain line, a vein, a leaf edge or a patch of grime takes
 * it. One field drives both the colour map and the roughness map of its surface,
 * which is deliberate: two uncorrelated noises read as dirt on the lens, whereas
 * one field reads as a surface, because the places a floor darkens are the
 * places it has been polished by feet.
 *
 * ## How a field reaches a prop
 *
 * `ExtrudeGeometry` gives every extruded part **object-space metre** texture
 * coordinates — three's own `WorldUVGenerator` returns the shape's `x, y` on a
 * cap and `x`-or-`y` with `1 - z` on a side wall, all of them raw model units.
 * So `repeat` below is *wraps per metre* and a feature authored here is that
 * many centimetres wide wherever it lands, however large the prop is. The two
 * exceptions are the floorboards and the walls, which are re-projected by their
 * builders into their own space and therefore carry `repeat` 1.
 *
 * That also fixes the one axis a shared texture cannot adapt to. Grain runs
 * along `u`, which is the long axis of every board, slab, panel, drawer front
 * and carcass face in the room, and is across the narrow axis of an upright
 * post. Posts are 5 cm of the room and boards are most of it.
 */

// --------------------------------------------------------------- noise fields

/** Deterministic 0..1 source: the same map must build identically every run. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Tileable value noise: grid indices wrap, so a repeated map shows no seam. */
function tileableNoise(size: number, baseCells: number, octaves: number, seed: number): Float32Array {
  const field = new Float32Array(size * size);
  const random = makeRandom(seed);
  let amplitude = 1;
  let amplitudeSum = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    const cells = baseCells * (1 << octave);
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i += 1) {
      grid[i] = random();
    }

    const scale = cells / size;
    for (let y = 0; y < size; y += 1) {
      const gy = y * scale;
      const gy0 = Math.floor(gy);
      const fy = smoothStep(gy - gy0);
      const row0 = (((gy0 % cells) + cells) % cells) * cells;
      const row1 = ((((gy0 + 1) % cells) + cells) % cells) * cells;

      for (let x = 0; x < size; x += 1) {
        const gx = x * scale;
        const gx0 = Math.floor(gx);
        const fx = smoothStep(gx - gx0);
        const col0 = ((gx0 % cells) + cells) % cells;
        const col1 = (((gx0 + 1) % cells) + cells) % cells;

        const v00 = grid[row0 + col0] ?? 0;
        const v10 = grid[row0 + col1] ?? 0;
        const v01 = grid[row1 + col0] ?? 0;
        const v11 = grid[row1 + col1] ?? 0;
        const top = v00 + (v10 - v00) * fx;
        const bottom = v01 + (v11 - v01) * fx;
        field[y * size + x] = (field[y * size + x] ?? 0) + (top + (bottom - top) * fy) * amplitude;
      }
    }

    amplitudeSum += amplitude;
    amplitude *= 0.5;
  }

  for (let i = 0; i < field.length; i += 1) {
    field[i] = (field[i] ?? 0) / amplitudeSum;
  }
  return field;
}

const NOISE_GRID = 128;

/**
 * A tileable noise as a continuous `(u, v) -> 0..1`, sampled bilinearly and
 * wrapping in both axes.
 *
 * Nearest sampling would print the noise's own cell grid onto the surface as
 * blocks, which at this scale is a chequerboard rather than a material. The
 * field is built once when the sampler is made, so a texel costs four reads.
 */
function noiseField(cells: number, octaves: number, seed: number): (u: number, v: number) => number {
  const grid = tileableNoise(NOISE_GRID, cells, octaves, seed);
  return (u, v) => {
    const x = u * NOISE_GRID - 0.5;
    const y = v * NOISE_GRID - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const wrap = (i: number): number => ((i % NOISE_GRID) + NOISE_GRID) % NOISE_GRID;
    const cx0 = wrap(x0);
    const cx1 = wrap(x0 + 1);
    const ry0 = wrap(y0) * NOISE_GRID;
    const ry1 = wrap(y0 + 1) * NOISE_GRID;

    const v00 = grid[ry0 + cx0] ?? 0.5;
    const v10 = grid[ry0 + cx1] ?? 0.5;
    const v01 = grid[ry1 + cx0] ?? 0.5;
    const v11 = grid[ry1 + cx1] ?? 0.5;
    const top = v00 + (v10 - v00) * fx;
    const bottom = v01 + (v11 - v01) * fx;
    return top + (bottom - top) * fy;
  };
}

/** Stable 0..1 value per band index, so a grain band or a leaf keeps its character. */
function hashBand(band: number, salt: number): number {
  const raw = Math.sin(band * 12.9898 + salt * 78.233) * 43758.5453;
  return raw - Math.floor(raw);
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

// ------------------------------------------------------------------ the floor

/**
 * Length of floorboard one wrap of the plank texture covers. `buildFloor`
 * scales the board's UVs against this, so a feature in the map is this many
 * metres long however wide or long the board it lands on is.
 */
export const PLANK_TILE_LENGTH_M = 2;

const PLANK_GRAIN_LINES = 15;
/** How far the band count drifts along the board, which is what makes figure. */
const PLANK_GRAIN_SPREAD = 1.8;
const PLANK_GRAIN_WAVE = 0.62;
const PLANK_EDGE_WIDTH = 0.085;
const PLANK_EDGE_DEPTH = 0.72;
const PLANK_KNOTS: readonly (readonly [number, number, number])[] = [
  // u, v, radius. Placed off the board's centre line, as knots in sawn stock are.
  [0.21, 0.33, 0.052],
  [0.68, 0.64, 0.041],
];
/** Heel scuffs per two-metre wrap, and how far each spreads across the board. */
const PLANK_SCUFF_COUNT = 5;
const PLANK_SCUFF_HALF_WIDTH = 0.016;

/**
 * One value per texel describing a floorboard at that point.
 *
 * The field is periodic in u so a long board shows no seam, and clamped in v
 * because v runs across a single board and its two edges are features.
 */
function plankField(): (u: number, v: number) => number {
  const traffic = noiseField(3, 3, 71);
  return (u, v) => {
    // Periodic in u, so the grain still lines up where the tile wraps.
    const wander =
      0.55 * Math.sin(2 * Math.PI * u + 0.9) +
      0.28 * Math.sin(4 * Math.PI * u + 2.3) +
      0.14 * Math.sin(6 * Math.PI * u + 5.1);
    // The band count drifts along the board, so bands converge and merge the
    // way figure does in sawn timber rather than running as parallel ribs.
    const lines = PLANK_GRAIN_LINES + PLANK_GRAIN_SPREAD * Math.sin(2 * Math.PI * u + 1.7);
    const t = v * lines + wander * PLANK_GRAIN_WAVE;

    // Each band carries its own width and darkness. Uniform bands are what
    // made the first pass read as corrugated sheet rather than as a board.
    const band = Math.floor(t);
    const width = 0.24 + 0.32 * hashBand(band, 1);
    const depth = 0.34 + 0.46 * hashBand(band, 2);
    const offset = Math.abs(t - band - 0.5) / width;
    const stripe = offset < 1 ? (1 - offset * offset) ** 1.4 : 0;
    let value = 1 - depth * stripe;

    for (const [ku, kv, radius] of PLANK_KNOTS) {
      const rawU = Math.abs(u - ku);
      // Wrapped, so a knot near the tile edge is one knot rather than two halves.
      const du = Math.min(rawU, 1 - rawU) / 0.42;
      const dv = v - kv;
      const distance = Math.hypot(du, dv) / radius;
      if (distance < 1) {
        const falloff = (1 - distance) ** 2;
        const rings = 0.82 + 0.18 * Math.sin(distance * 26);
        value *= 1 - 0.72 * falloff * rings;
      }
    }

    const toEdge = Math.min(v, 1 - v);
    if (toEdge < PLANK_EDGE_WIDTH) {
      const depth = 1 - toEdge / PLANK_EDGE_WIDTH;
      value *= 1 - PLANK_EDGE_DEPTH * depth * depth;
    }

    // Traffic. Stretched across the board, because feet travel along it.
    value *= 0.74 + 0.26 * traffic(u, v * 0.3);

    // Wear (2026-08-05): heel scuffs where the finish has rubbed through -
    // short bright drags along the board, brighter at their middle, the
    // micro-detail pass the reference dioramas carry on every walked floor.
    for (let scuff = 0; scuff < PLANK_SCUFF_COUNT; scuff += 1) {
      const su = hashBand(scuff, 9.1);
      const sv = 0.14 + 0.72 * hashBand(scuff, 9.7);
      const length = 0.05 + 0.09 * hashBand(scuff, 10.3);
      const rawU = Math.abs(u - su);
      const du = Math.min(rawU, 1 - rawU);
      const dv = Math.abs(v - sv);
      if (du < length && dv < PLANK_SCUFF_HALF_WIDTH) {
        const along = 1 - du / length;
        const across = 1 - dv / PLANK_SCUFF_HALF_WIDTH;
        value += (1 - value) * 0.4 * along * across * across;
      }
    }

    return clamp01(value);
  };
}

// ------------------------------------------------------------------ the walls

/**
 * Length of wall one wrap of the plaster map covers. `buildWalls` re-projects
 * each piece against this and against the wall height, so v runs from the
 * skirting to the ceiling across the whole room rather than across one piece.
 */
export const WALL_TILE_LENGTH_M = 3.2;

/**
 * Lime plaster on a shop wall, in wall space: u wraps along the run, v is 0 at
 * the skirting and 1 at the ceiling.
 *
 * Three scales, and each answers a different distance. The tooth is what a
 * player standing against the wall sees, the tonal patches are what carries a
 * wall that fills half the frame, and the grime rising off the skirting is what
 * stops the bottom two feet from reading as the same paint as the top.
 */
function wallPlasterField(): (u: number, v: number) => number {
  const tooth = noiseField(40, 2, 17);
  const mottle = noiseField(5, 3, 23);
  const sweep = noiseField(2, 2, 31);
  const dirtEdge = noiseField(7, 2, 37);
  return (u, v) => {
    // Trowel sweeps drag the tooth sideways, which is what keeps the stipple
    // from reading as an even sprayed texture.
    const drag = 0.035 * (sweep(u, v) - 0.5);
    const stipple = tooth(u + drag, v);
    let value = 1 - 0.32 * (1 - stipple) ** 1.5;
    value -= 0.26 * (1 - mottle(u, v));
    value -= 0.12 * (1 - sweep(u, v));

    // Grime off the floor, uneven along the run so it reads as dirt rather
    // than as a painted band.
    const GRIME_HEIGHT = 0.17;
    if (v < GRIME_HEIGHT) {
      const ramp = (1 - v / GRIME_HEIGHT) ** 2;
      value -= 0.24 * ramp * (0.5 + 0.5 * (1 - dirtEdge(u * 2, v)));
    }

    return clamp01(value);
  };
}

/**
 * The same plaster on painted joinery — box lids, partitions, shelf backs.
 *
 * It tiles small and carries no grime ramp, because a painted box has no floor
 * to be dirty against and would otherwise wear a shadow along one edge.
 */
function paintedPlasterField(): (u: number, v: number) => number {
  const tooth = noiseField(34, 2, 43);
  const mottle = noiseField(6, 3, 53);
  return (u, v) => {
    let value = 1 - 0.3 * (1 - tooth(u, v)) ** 1.6;
    value -= 0.26 * (1 - mottle(u, v));
    return clamp01(value);
  };
}

// ------------------------------------------------------------------- the wood

/** Grain bands across one wrap of the wood map. Integer, so v wraps cleanly. */
const WOOD_GRAIN_LINES = 11;
/** Pore lines inside the bands, the detail a player sees from arm's length. */
const WOOD_PORE_LINES = 47;

/**
 * Sawn hardwood for the joinery: bookcases, cabinet frames, the counter body,
 * the workshop bench, drawer fronts, beams.
 *
 * Grain runs along u and the bands wrap in v, which is what separates this from
 * `plankField`. A board has two joints and the map may end at them; a cabinet
 * side is one face of a much larger piece of stock and has to tile in both axes,
 * so the band index is taken modulo the line count rather than clamped.
 */
function woodGrainField(): (u: number, v: number) => number {
  const tone = noiseField(3, 2, 61);
  const fleck = noiseField(11, 2, 67);
  return (u, v) => {
    // Periodic in u: bands wander along the grain and converge into figure.
    const wander =
      0.42 * Math.sin(2 * Math.PI * u + 0.7) +
      0.21 * Math.sin(4 * Math.PI * u + 2.9) +
      0.11 * Math.sin(6 * Math.PI * u + 4.4);

    const t = v * WOOD_GRAIN_LINES + wander;
    const cell = Math.floor(t);
    const band = ((cell % WOOD_GRAIN_LINES) + WOOD_GRAIN_LINES) % WOOD_GRAIN_LINES;
    const width = 0.2 + 0.3 * hashBand(band, 1);
    const depth = 0.3 + 0.4 * hashBand(band, 2);
    const offset = Math.abs(t - cell - 0.5) / width;
    const stripe = offset < 1 ? (1 - offset * offset) ** 1.4 : 0;
    let value = 1 - depth * stripe;

    // Pores: the fine dark lines inside a band, wandering with it so they read
    // as the same piece of timber rather than as a screen over it.
    const p = v * WOOD_PORE_LINES + wander * 4;
    const pCell = Math.floor(p);
    const pBand = ((pCell % WOOD_PORE_LINES) + WOOD_PORE_LINES) % WOOD_PORE_LINES;
    const pore = Math.abs(p - pCell - 0.5) < 0.16 ? 1 : 0;
    value -= 0.13 * pore * hashBand(pBand, 5);

    // Ray fleck: short light streaks lying across the grain in quartersawn stock.
    const ray = fleck(u * 3, v);
    if (ray > 0.78) {
      value += 0.1 * (ray - 0.78) / 0.22;
    }

    // Slow tonal drift, so one board is not the same brown end to end.
    value *= 0.86 + 0.14 * tone(u, v);

    // Wear (2026-08-05): the marks of handling. Two fine scratches lying at
    // shallow angles across the grain, and a soft rubbed patch where hands
    // have polished the finish a shade lighter.
    for (const [phase, slope, sv, depth] of WOOD_SCRATCHES) {
      const line = v - sv - slope * Math.sin(2 * Math.PI * (u + phase));
      const dv = Math.abs(((line % 1) + 1) % 1 - 0.5);
      if (dv > 0.494) value -= depth;
    }
    // Offset, never rescaled: a fractional scale would break the tile wrap
    // the suite pins.
    const rub = fleck(u + 0.31, v + 0.67);
    if (rub > 0.82) {
      value += 0.07 * ((rub - 0.82) / 0.18);
    }

    return clamp01(value);
  };
}

/** Handling scratches: sine phase, slope, band centre, and darkness. */
const WOOD_SCRATCHES: readonly (readonly [number, number, number, number])[] = [
  [0.13, 0.02, 0.27, 0.09],
  [0.61, 0.035, 0.71, 0.07],
];

// ----------------------------------------------------------------- the marble

/**
 * Cream marble for the counter top.
 *
 * Two vein sets crossing at different angles, both domain-warped, because a
 * single set reads as a printed pattern. The coefficients on u and v inside the
 * sines are whole numbers so the veins meet themselves at the tile edge.
 */
function marbleField(): (u: number, v: number) => number {
  const warpA = noiseField(2, 3, 71);
  const warpB = noiseField(3, 3, 79);
  const cloud = noiseField(4, 3, 83);
  return (u, v) => {
    const a = warpA(u, v) - 0.5;
    const b = warpB(u, v) - 0.5;

    const primary = Math.abs(Math.sin(2 * Math.PI * (u + 2 * v) + 4.1 * a + 1.7 * b));
    const secondary = Math.abs(Math.sin(2 * Math.PI * (2 * u - v) + 5.3 * b));

    let value = 1;
    value -= 0.36 * (1 - primary) ** 7;
    value -= 0.17 * (1 - secondary) ** 12;
    value -= 0.07 * (1 - cloud(u, v));

    // Wear (2026-08-05): the counter is worked at. Two faint cup rings and a
    // low smudge cloud where things are set down and slid, none of it strong
    // enough to compete with the veining.
    for (const [cu, cv, radius] of MARBLE_RINGS) {
      const distance = Math.hypot(u - cu, v - cv);
      const band = Math.abs(distance - radius);
      if (band < MARBLE_RING_WIDTH) {
        value -= 0.06 * (1 - band / MARBLE_RING_WIDTH);
      }
    }
    const smudge = cloud(u * 2 + 0.41, v * 2 + 0.13);
    if (smudge > 0.74) {
      value -= 0.05 * ((smudge - 0.74) / 0.26);
    }

    return clamp01(value);
  };
}

/** Cup rings on the counter map: centre u, centre v, ring radius. */
const MARBLE_RINGS: readonly (readonly [number, number, number])[] = [
  [0.31, 0.62, 0.052],
  [0.72, 0.24, 0.041],
];
const MARBLE_RING_WIDTH = 0.006;

// ------------------------------------------------------------------ the paper

/** Leaves across one wrap of the page-block map. Integer, so u wraps cleanly. */
const PAPER_LEAVES = 26;

/**
 * The cut edge of a block of pages, which is what a shelf of books is mostly
 * made of once the spines are turned away.
 *
 * The leaves stack along u in both places a page block is built: on an upright
 * book the visible face is the extruder's cap, whose u is the book's thickness,
 * and on a book lying in a stack the visible face is a side wall, whose u is
 * again the thickness. One direction therefore serves both.
 */
function paperLeafField(): (u: number, v: number) => number {
  const wobble = noiseField(3, 2, 89);
  const foxing = noiseField(6, 3, 97);
  return (u, v) => {
    // Leaves are cut together and still do not line up perfectly.
    const t = u * PAPER_LEAVES + 0.22 * (wobble(u, v) - 0.5);
    const cell = Math.floor(t);
    const leaf = ((cell % PAPER_LEAVES) + PAPER_LEAVES) % PAPER_LEAVES;
    const across = Math.abs(t - cell - 0.5) * 2;
    const line = across ** 3;
    let value = 1 - (0.24 + 0.3 * hashBand(leaf, 3)) * line;

    // Signatures: every few leaves the block is gathered and sits a touch
    // proud, so the shadow between gatherings is deeper than between leaves.
    if (leaf % 6 === 0) {
      value -= 0.14 * line;
    }

    // Foxing, which is what makes aged paper cream rather than white.
    value -= 0.16 * (1 - foxing(u, v));
    return clamp01(value);
  };
}

/** Kraft wrapping and labels: fibre and a little grubbiness, and no leaves. */
function paperFibreField(): (u: number, v: number) => number {
  const mottle = noiseField(5, 3, 101);
  const fibre = noiseField(28, 1, 103);
  return (u, v) => {
    // Stretched four to one, so the fibres lie along the sheet rather than
    // reading as sand. The scale is whole-numbered or the tile would not meet.
    let value = 1 - 0.26 * (1 - fibre(u, v * 4)) ** 1.4;
    value -= 0.34 * (1 - mottle(u, v));
    return clamp01(value);
  };
}

// ----------------------------------------------------------------- the fabric

/** Threads across one wrap of the weave map, in each axis. Integer for tiling. */
const WEAVE_THREADS = 16;

/**
 * Plain weave for the rug, the armchair and the curtains.
 *
 * A cell is one crossing: the thread on top is lit across its own width and the
 * one beneath is only the shadow between them. Alternating which of the two is
 * on top is what makes a weave rather than a grid, and it is the reason this is
 * built cell by cell instead of out of noise.
 */
function weaveField(): (u: number, v: number) => number {
  const pile = noiseField(5, 3, 107);
  return (u, v) => {
    const cu = u * WEAVE_THREADS;
    const cv = v * WEAVE_THREADS;
    const iu = Math.floor(cu);
    const iv = Math.floor(cv);
    const fu = cu - iu;
    const fv = cv - iv;

    const warpOnTop = (((iu + iv) % 2) + 2) % 2 === 0;
    // The visible thread runs perpendicular to the axis its shading varies on.
    const ridge = warpOnTop ? Math.sin(Math.PI * fu) : Math.sin(Math.PI * fv);
    let value = 0.6 + 0.4 * ridge ** 0.65;

    // Slubs: a thread now and then is spun thicker and takes the light harder.
    const thread = warpOnTop
      ? ((iu % WEAVE_THREADS) + WEAVE_THREADS) % WEAVE_THREADS
      : ((iv % WEAVE_THREADS) + WEAVE_THREADS) % WEAVE_THREADS;
    value *= 0.9 + 0.2 * hashBand(thread, warpOnTop ? 7 : 11);

    // Pile: how flat the nap lies, which is the only thing at rug scale.
    value *= 0.88 + 0.12 * pile(u, v);
    return clamp01(value);
  };
}

// -------------------------------------------------------------- the catalogue

export type SurfaceId =
  | "plank"
  | "wall_plaster"
  | "painted_plaster"
  | "wood_grain"
  | "marble"
  | "paper_leaf"
  | "paper_fibre"
  | "weave";

export interface SurfaceSpec {
  readonly id: SurfaceId;
  /** Canvas size at full resolution. A weak tier scales both down together. */
  readonly width: number;
  readonly height: number;
  /**
   * `texture.repeat`. For a surface riding the extruder's own coordinates this
   * is wraps per metre; for the two that are re-projected by their builder — the
   * floorboards and the walls — the projection has already done the scaling and
   * this is 1.
   */
  readonly repeat: readonly [number, number];
  /** v clamps where its two edges are features rather than something to tile. */
  readonly clampV: boolean;
  /** Darkest the colour map takes the surface, as a fraction of the swatch. */
  readonly albedoFloor: number;
  /**
   * Least the roughness map scales the swatch's roughness, reached where the
   * surface is at its cleanest.
   *
   * The roughness runs opposite to the colour, because the two are opposite in
   * every material here: the grain line, the tooth, the vein and the gap
   * between threads are all the darker part *and* the rougher one. The swatch's
   * own roughness is still the ceiling, so what a sample publishes is still the
   * roughest the surface ever gets (§7.12).
   */
  readonly roughnessFloor: number;
  readonly bumpScale: number;
  readonly field: (u: number, v: number) => number;
}

function spec(
  id: SurfaceId,
  width: number,
  height: number,
  repeat: readonly [number, number],
  albedoFloor: number,
  roughnessFloor: number,
  bumpScale: number,
  field: () => (u: number, v: number) => number,
  clampV = false,
): SurfaceSpec {
  return { id, width, height, repeat, clampV, albedoFloor, roughnessFloor, bumpScale, field: field() };
}

/**
 * Every procedural surface in the shop, one entry per material family rather
 * than one per prop: a bookcase, a cabinet frame and a drawer front are the
 * same timber and share the same two canvases.
 *
 * The tile lengths are stated as comments in metres because that is the number
 * that decides whether a feature reads at giant scale, and `repeat` is its
 * reciprocal rather than a figure anyone should tune directly.
 */
export const SHOP_SURFACES: Readonly<Record<SurfaceId, SurfaceSpec>> = {
  // Re-projected per board by `buildFloor`; one wrap is PLANK_TILE_LENGTH_M.
  // The roughness floor is higher than the rest so that flipping the polarity
  // of the map left the floor no glossier anywhere than it was before: its
  // clean board now sits at 0.74 of the swatch where its grain used to.
  plank: spec("plank", 512, 128, [1, 1], 0.38, 0.74, 0.11, plankField, true),
  // Re-projected per piece by `buildWalls`; one wrap is WALL_TILE_LENGTH_M
  // along the run and the full wall height up it.
  wall_plaster: spec("wall_plaster", 512, 512, [1, 1], 0.52, 0.62, 0.075, wallPlasterField, true),
  // 0.5 m tile.
  painted_plaster: spec("painted_plaster", 256, 256, [2, 2], 0.55, 0.7, 0.05, paintedPlasterField),
  // 1.4 m along the grain, 0.35 m across it: a square 2.7 mm texel either way.
  wood_grain: spec("wood_grain", 512, 128, [1 / 1.4, 1 / 0.35], 0.52, 0.7, 0.07, woodGrainField),
  // 2.4 m tile, so a three-metre counter top carries a vein set and a bit. The
  // roughness barely moves: the whole top is polished and only the vein is not.
  marble: spec("marble", 512, 512, [1 / 2.4, 1 / 2.4], 0.45, 0.85, 0.03, marbleField),
  // 0.062 m across the leaves — about 2.4 mm a leaf — by 0.32 m along the page.
  paper_leaf: spec("paper_leaf", 256, 256, [1 / 0.062, 1 / 0.32], 0.5, 0.72, 0.045, paperLeafField),
  // 0.3 m tile.
  paper_fibre: spec("paper_fibre", 128, 128, [1 / 0.3, 1 / 0.3], 0.5, 0.76, 0.035, paperFibreField),
  // 0.12 m tile over sixteen threads: a 7.5 mm thread at giant scale.
  weave: spec("weave", 256, 256, [1 / 0.12, 1 / 0.12], 0.56, 0.7, 0.03, weaveField),
};

const FLOORBOARD_IDS = new Set<string>(FLOORBOARD_SWATCH_IDS);
/**
 * Stone that is polished and veined rather than quarry-faced. Slate is stone
 * too and a vein set across it would be a different rock.
 */
const MARBLE_IDS = new Set<string>(["marble_cream_01"]);
/** The paper that is a block of leaves rather than a wrapped sheet. */
const LEAF_PAPER_IDS = new Set<string>(["paper_aged_01"]);

/**
 * Which surface a swatch is made of, or null where the family is deliberately
 * left smooth — glass has no tooth to give it, and the room's metals are
 * turned, cast or spun rather than grained.
 */
export function surfaceForSwatch(swatch: MapSwatch): SurfaceId | null {
  if (FLOORBOARD_IDS.has(swatch.id)) {
    return "plank";
  }
  if (MARBLE_IDS.has(swatch.id)) {
    return "marble";
  }
  if (LEAF_PAPER_IDS.has(swatch.id)) {
    return "paper_leaf";
  }
  switch (swatch.family) {
    case "wood":
      return "wood_grain";
    case "paint":
    case "stone":
      return "painted_plaster";
    case "paper":
      return "paper_fibre";
    case "fabric":
      return "weave";
    default:
      return null;
  }
}

/**
 * How far a surface's canvases are scaled down for a tier.
 *
 * This is decided once, from the tier the map is built at, and never revisited:
 * regenerating every field to answer an adaptive tier change would cost more of
 * a frame than the memory is worth, and the maps are bound into materials that
 * would all have to be re-bound with them.
 */
export const SURFACE_SCALE_BY_TIER: Readonly<Record<QualityTier, number>> = {
  ultra: 1,
  high: 1,
  medium: 0.75,
  low: 0.5,
  light: 0.5,
};

/** Canvas size a tier builds a surface at, never below a usable 32 texels. */
export function surfaceSizeFor(surface: SurfaceSpec, scale: number): { width: number; height: number } {
  return {
    width: Math.max(Math.round(surface.width * scale), 32),
    height: Math.max(Math.round(surface.height * scale), 32),
  };
}

/**
 * Video memory every surface in the shop costs at a given scale, in bytes.
 *
 * Each surface is two RGBA canvases — a colour map and a shared roughness and
 * bump map — and three uploads both with a full mip chain, which is the four
 * thirds. This is what the texture budget is measured against.
 */
export function shopTextureBytes(scale: number): number {
  let bytes = 0;
  for (const surface of Object.values(SHOP_SURFACES)) {
    const { width, height } = surfaceSizeFor(surface, scale);
    bytes += width * height * 4 * 2;
  }
  return Math.round((bytes * 4) / 3);
}
