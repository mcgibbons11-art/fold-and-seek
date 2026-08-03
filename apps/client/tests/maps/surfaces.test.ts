import { describe, expect, it } from "vitest";

import { QUALITY_TIER_ORDER } from "../../src/rendering/quality";
import {
  SHOP_SURFACES,
  SURFACE_SCALE_BY_TIER,
  shopTextureBytes,
  surfaceForSwatch,
  surfaceSizeFor,
  type SurfaceId,
  type SurfaceSpec,
} from "../../src/world/maps/props/surfaces";
import { SHOP_SWATCHES } from "../../src/world/maps/swatches";

/**
 * The surfaces are checked as fields rather than as canvases.
 *
 * Building a canvas needs a 2D context and the suite runs without one, but the
 * field is the whole of what a surface *is* — the canvas is only where it is
 * written down — so everything worth pinning is reachable here: that a family
 * shares one map rather than getting one per prop, that a map meets itself at
 * the tile edge, that the grain runs the way the geometry needs it to, and that
 * the result carries real contrast instead of the near-flat noise it replaces.
 */

const SURFACE_IDS = Object.keys(SHOP_SURFACES) as SurfaceId[];

/** The renderer's own transfer function, so the swings below are what it sees. */
function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Every texel of a surface, at a resolution fine enough to find its features. */
function samples(surface: SurfaceSpec, size = 128): number[] {
  const out: number[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      out.push(surface.field((x + 0.5) / size, (y + 0.5) / size));
    }
  }
  return out;
}

/** Sorted once, because every figure below is a position in the same order. */
function sortedSamples(surface: SurfaceSpec, size = 128): number[] {
  return samples(surface, size).sort((a, b) => a - b);
}

function at(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(Math.floor(fraction * sorted.length), sorted.length - 1)] ?? 0;
}

/** Mean absolute difference between neighbours a step apart along one axis. */
function variationAlong(surface: SurfaceSpec, axis: "u" | "v", step: number): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < 64; i += 1) {
    for (let j = 0; j < 64; j += 1) {
      const u = (i + 0.5) / 64;
      const v = (j + 0.5) / 64;
      const here = surface.field(u, v);
      const there = axis === "u" ? surface.field(u + step, v) : surface.field(u, v + step);
      sum += Math.abs(there - here);
      count += 1;
    }
  }
  return sum / count;
}

describe("Curiosity Shop procedural surfaces", () => {
  it("dresses every swatch in the room from one map per family", () => {
    // The point of the catalogue: a bookcase, a cabinet frame, a drawer front
    // and a ceiling beam are the same timber and share one pair of canvases.
    // A map per prop would be the same pixels uploaded thirty times.
    const used = new Set<SurfaceId>();
    let dressed = 0;
    for (const swatch of SHOP_SWATCHES) {
      const id = surfaceForSwatch(swatch);
      if (id === null) {
        continue;
      }
      expect(SHOP_SURFACES[id], `${swatch.id} names an unbuilt surface`).toBeDefined();
      used.add(id);
      dressed += 1;
    }

    // Wood and fabric are the families that repeat hardest, and each is one map.
    const woodSwatches = SHOP_SWATCHES.filter((swatch) => surfaceForSwatch(swatch) === "wood_grain");
    expect(woodSwatches.length).toBeGreaterThanOrEqual(3);
    const fabricSwatches = SHOP_SWATCHES.filter((swatch) => surfaceForSwatch(swatch) === "weave");
    expect(fabricSwatches.length).toBeGreaterThanOrEqual(3);

    expect(dressed).toBeGreaterThan(used.size);
    expect(used.size).toBeLessThanOrEqual(SURFACE_IDS.length);
  });

  it("leaves glass, metal and the glazes smooth on purpose", () => {
    // These are the families with nothing to carve: a pane has no tooth, the
    // room's metals are spun or cast, and a glaze is a glaze.
    for (const family of ["glass", "metal", "ceramic", "plastic"] as const) {
      for (const swatch of SHOP_SWATCHES.filter((entry) => entry.family === family)) {
        expect(surfaceForSwatch(swatch), swatch.id).toBeNull();
      }
    }
  });

  it("keys every spec by its own id, so the catalogue cannot drift", () => {
    for (const id of SURFACE_IDS) {
      expect(SHOP_SURFACES[id].id).toBe(id);
    }
  });

  it("stays inside the texture budget, and reports what it spends", () => {
    const full = shopTextureBytes(1);
    console.log(
      `shop surfaces: ${(full / 1048576).toFixed(2)} MB at full resolution, ` +
        QUALITY_TIER_ORDER.map(
          (tier) => `${tier} ${(shopTextureBytes(SURFACE_SCALE_BY_TIER[tier]) / 1048576).toFixed(2)}`,
        ).join(", "),
    );
    expect(full).toBeLessThan(24 * 1024 * 1024);

    // A weak tier pays less, and never more than the tier above it.
    let previous = 0;
    for (const tier of QUALITY_TIER_ORDER) {
      const bytes = shopTextureBytes(SURFACE_SCALE_BY_TIER[tier]);
      expect(bytes, tier).toBeGreaterThanOrEqual(previous);
      previous = bytes;
    }
    expect(shopTextureBytes(SURFACE_SCALE_BY_TIER.light)).toBeLessThan(full);
    for (const id of SURFACE_IDS) {
      const small = surfaceSizeFor(SHOP_SURFACES[id], SURFACE_SCALE_BY_TIER.light);
      expect(small.width, id).toBeGreaterThanOrEqual(32);
      expect(small.height, id).toBeGreaterThanOrEqual(32);
    }
  });

  it("carries real contrast rather than the flat noise it replaces", () => {
    // The gap this pass exists to close: every surface read as a solid colour
    // with a PBR response.
    //
    // What is measured is the multiplier the *swatch* ends up wearing, because
    // that is what a player sees. The colour map only darkens and the material
    // divides its base colour by the map's linear mean to land back on the
    // published swatch, so a texel's real effect is its linear level over that
    // mean: 1.0 is exactly the swatch, and the spread either side is the whole
    // of what "textured" means here.
    for (const id of SURFACE_IDS) {
      const surface = SHOP_SURFACES[id];
      const values = sortedSamples(surface);
      const albedoOf = (value: number): number => srgbToLinear(surface.albedoFloor + value * (1 - surface.albedoFloor));
      const linearMean = values.reduce((sum, value) => sum + albedoOf(value), 0) / values.length;
      const swing = (value: number): number => albedoOf(value) / linearMean;
      const low = at(values, 0.02);
      const high = at(values, 0.98);
      const darkest = at(values, 0);
      const cleanest = at(values, 1);
      const roughnessOf = (value: number): number =>
        surface.roughnessFloor + (1 - value) * (1 - surface.roughnessFloor);

      console.log(
        `${id.padEnd(16)} field p2..p98 ${low.toFixed(3)}..${high.toFixed(3)}` +
          ` | colour x${swing(low).toFixed(2)}..${swing(high).toFixed(2)} of swatch` +
          ` (full x${swing(darkest).toFixed(2)}..${swing(cleanest).toFixed(2)})` +
          ` | roughness x${roughnessOf(high).toFixed(2)}..${roughnessOf(low).toFixed(2)} of swatch`,
      );

      expect(darkest, id).toBeGreaterThanOrEqual(0);
      expect(cleanest, id).toBeLessThanOrEqual(1);

      // Flatness is asserted twice, on purpose, and both bars have to hold.
      //
      // The field's own excursion between the second and ninety-eighth centile
      // is the first, and it is the check `paper_fibre` and `painted_plaster`
      // were each caught failing while this pass was being written. It says
      // nothing about how the field is mapped, though: the same 0.16 through an
      // albedo floor of 0.95 is invisible and through a floor of 0.4 is a
      // material, so on its own it can be satisfied by a surface a player still
      // reads as a solid colour.
      expect(high - low, `${id} field is too flat to read`).toBeGreaterThan(0.16);

      // The second closes exactly that hole by measuring what the *swatch* ends
      // up wearing after the floor and the mean compensation, which is what a
      // player actually sees. A third of its own brightness between the same
      // two centiles; below roughly that the map is a sheen on a solid colour.
      expect(swing(high) / swing(low), `${id} is too flat to read`).toBeGreaterThan(1.33);

      // And the lift must not carry a swatch's own brightest channel far past
      // what an albedo can physically be. How much headroom a surface has
      // depends on what wears it: dark walnut takes the floorboards' 1.6 with
      // room to spare, and cream plaster has almost none, so the bound is the
      // product rather than the swing on its own.
      const brightest = Math.max(
        0,
        ...SHOP_SWATCHES.filter((swatch) => surfaceForSwatch(swatch) === id).map((swatch) =>
          Math.max(...swatch.baseColor.map(srgbToLinear)),
        ),
      );
      expect(brightest * swing(cleanest), `${id} would blow out where it is clean`).toBeLessThan(1.25);
    }
  });

  it("meets itself at every tile edge it is asked to repeat across", () => {
    // A seam is the one failure a tiled map cannot hide, and the band and leaf
    // indices are taken modulo their counts precisely so the wrap lands on the
    // same band. Removing either modulo puts a hard line through the room.
    //
    // 0 and 1 are the *same point* of a periodic field, so this asks for
    // equality rather than nearness: comparing two samples either side of the
    // edge would only measure the field's own gradient over the gap, which on
    // a plaster tooth is larger than any tolerance worth setting.
    for (const id of SURFACE_IDS) {
      const surface = SHOP_SURFACES[id];
      for (let i = 0; i < 40; i += 1) {
        const t = (i + 0.5) / 40;
        expect(surface.field(0, t), `${id} u seam at v=${t.toFixed(2)}`).toBeCloseTo(surface.field(1, t), 6);
        if (!surface.clampV) {
          expect(surface.field(t, 0), `${id} v seam at u=${t.toFixed(2)}`).toBeCloseTo(
            surface.field(t, 1),
            6,
          );
        }
      }
    }
  });

  it("runs the wood grain along u, which is the long axis of a board", () => {
    // `ExtrudeGeometry` hands out object-space metres, so u is the width of
    // every slab, panel, drawer front and carcass face in the shop. Grain that
    // varied fastest along u would be running across those pieces.
    const wood = SHOP_SURFACES.wood_grain;
    expect(variationAlong(wood, "v", 0.01)).toBeGreaterThan(variationAlong(wood, "u", 0.01) * 3);
  });

  it("stacks the page leaves along u, which is a book's thickness either way up", () => {
    // Upright on a shelf the page block's visible face is the extruder's cap,
    // whose u is the thickness; lying in a stack it is a side wall, whose u is
    // the thickness again. One direction serves both, and it is not v.
    const paper = SHOP_SURFACES.paper_leaf;
    expect(variationAlong(paper, "u", 0.004)).toBeGreaterThan(variationAlong(paper, "v", 0.004) * 3);
  });

  it("keeps the marble veins thin", () => {
    // A vein set that covers the top is a pattern rather than stone: the dark
    // is meant to be a few per cent of the surface with the rest clean cream.
    const values = samples(SHOP_SURFACES.marble, 192);
    const veined = values.filter((value) => value < 0.75).length / values.length;
    expect(veined).toBeGreaterThan(0.005);
    expect(veined).toBeLessThan(0.12);
  });

  it("weaves the cloth rather than mottling it", () => {
    // A plain weave alternates which thread is on top, so two cells a thread
    // apart shade on opposite axes. Noise would give the same answer to both.
    const weave = SHOP_SURFACES.weave;
    const cell = 1 / 16;
    // Sampled from the gap between threads to the crown of one, not either side
    // of the crown, which is the same height twice.
    const acrossWarp = Math.abs(weave.field(0.04 * cell, 0.5 * cell) - weave.field(0.5 * cell, 0.5 * cell));
    const acrossWeft = Math.abs(weave.field(1.04 * cell, 0.5 * cell) - weave.field(1.5 * cell, 0.5 * cell));
    // The warp cell varies across u and its neighbour, showing weft, does not.
    expect(acrossWarp).toBeGreaterThan(acrossWeft * 2);
  });

  it("darkens the wall at the skirting and nowhere else", () => {
    // The grime ramp is the reason the walls are re-projected into wall space
    // at all. Averaged along the run, the bottom of the wall has to sit clearly
    // below its middle, and the middle and the top have to sit together.
    const wall = SHOP_SURFACES.wall_plaster;
    const bandMean = (v: number): number => {
      let sum = 0;
      for (let i = 0; i < 96; i += 1) {
        sum += wall.field((i + 0.5) / 96, v);
      }
      return sum / 96;
    };
    const skirting = bandMean(0.02);
    const middle = bandMean(0.5);
    const head = bandMean(0.95);
    expect(skirting).toBeLessThan(middle - 0.1);
    expect(Math.abs(middle - head)).toBeLessThan(0.08);
    expect(wall.clampV).toBe(true);
  });
});
