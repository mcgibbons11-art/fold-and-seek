import * as THREE from "three/webgpu";
import type { PropPlacement } from "../placements";
import { swatchRole, type PropContext } from "./context";
import {
  chamferedBox,
  chamferedSlab,
  lathe,
  makeRandom,
  quantize,
  superellipseColumn,
  type LatheProfile,
} from "./geometry";
import { BULB_MATERIAL, GLASS_PANE_MATERIAL } from "./materials";

/**
 * The repeated small-object families: vessels, books, parcels, frames, clocks,
 * figures, plants and tools. These carry most of the shop's density and almost
 * all of its disguise vocabulary (§10.2), so they are authored as parameterised
 * families rather than as one-off props.
 */

function seedFrom(objectId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < objectId.length; i += 1) {
    hash ^= objectId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sized(base: string, ...values: readonly number[]): string {
  return `${base}#${values.map((value) => value.toFixed(3)).join("x")}`;
}

// ----------------------------------------------------------------- vessels

const VESSEL_PROFILES: Readonly<Record<string, LatheProfile>> = {
  vase_tall: [
    [0, 0],
    [0.075, 0],
    [0.081, 0.014],
    [0.096, 0.08],
    [0.108, 0.2],
    [0.09, 0.32],
    [0.056, 0.4],
    [0.05, 0.45],
    [0.061, 0.472],
    [0.052, 0.474],
    [0, 0.46],
  ],
  vase_round: [
    [0, 0],
    [0.062, 0],
    [0.07, 0.012],
    [0.115, 0.075],
    [0.128, 0.15],
    [0.104, 0.225],
    [0.068, 0.262],
    [0.076, 0.284],
    [0.066, 0.286],
    [0, 0.272],
  ],
  bottle: [
    [0, 0],
    [0.058, 0],
    [0.063, 0.012],
    [0.066, 0.16],
    [0.056, 0.24],
    [0.026, 0.3],
    [0.023, 0.4],
    [0.03, 0.428],
    [0.027, 0.436],
    [0, 0.43],
  ],
  urn: [
    [0, 0],
    [0.058, 0],
    [0.07, 0.03],
    [0.056, 0.07],
    [0.13, 0.155],
    [0.142, 0.24],
    [0.112, 0.32],
    [0.126, 0.35],
    [0.118, 0.362],
    [0, 0.348],
  ],
  bowl: [
    [0, 0],
    [0.05, 0],
    [0.058, 0.012],
    [0.115, 0.06],
    [0.138, 0.105],
    [0.132, 0.112],
    [0.108, 0.07],
    [0.045, 0.026],
    [0, 0.022],
  ],
  teapot: [
    [0, 0],
    [0.048, 0],
    [0.056, 0.014],
    [0.104, 0.06],
    [0.113, 0.12],
    [0.086, 0.175],
    [0.052, 0.192],
    [0.056, 0.206],
    [0.048, 0.212],
    [0.058, 0.226],
    [0, 0.23],
  ],
  kettle: [
    [0, 0],
    [0.072, 0],
    [0.08, 0.016],
    [0.098, 0.07],
    [0.094, 0.16],
    [0.06, 0.21],
    [0.062, 0.232],
    [0.05, 0.238],
    [0, 0.234],
  ],
};

const POURING_VESSELS = new Set(["teapot", "kettle"]);

/** Swatch roles: 0 = body, 1 = rim or fitting. */
export function buildVessel(ctx: PropContext, placement: PropPlacement): void {
  const profile = VESSEL_PROFILES[placement.variant] ?? VESSEL_PROFILES.vase_round;
  if (profile === undefined) {
    throw new Error(`Curiosity Shop: no vessel profile for "${placement.variant}"`);
  }
  const body = ctx.materials.get(swatchRole(placement, 0, "porcelain_cream_01"));
  const fitting = ctx.materials.get(swatchRole(placement, 1, "brass_aged_02"));
  const b = ctx.batcher;

  b.part(ctx.geometry.get(`vessel.${placement.variant}`, () => lathe(profile, 22)), body);

  if (POURING_VESSELS.has(placement.variant)) {
    b.part(
      ctx.geometry.get("vessel.spout", () =>
        lathe(
          [
            [0.026, 0],
            [0.022, 0.06],
            [0.014, 0.12],
            [0.011, 0.14],
            [0, 0.14],
          ],
          10,
        ),
      ),
      body,
      { x: 0.1, y: 0.12, z: 0, rz: -1.05 },
      { shadow: false },
    );
    b.part(
      ctx.geometry.get("vessel.handle", () => new THREE.TorusGeometry(0.056, 0.008, 6, 16, Math.PI * 1.15)),
      fitting,
      { x: -0.1, y: 0.14, ry: Math.PI / 2, rz: -0.4 },
      { shadow: false },
    );
    b.part(ctx.geometry.get("vessel.knob", () => new THREE.SphereGeometry(0.017, 8, 6)), fitting, { y: 0.244 }, { shadow: false });
  }
}

// ------------------------------------------------------------------- books

interface BookSize {
  readonly width: number;
  readonly thickness: number;
  readonly depth: number;
}

const BOOK_SIZES: readonly BookSize[] = [
  { width: 0.24, thickness: 0.055, depth: 0.17 },
  { width: 0.21, thickness: 0.044, depth: 0.15 },
  { width: 0.27, thickness: 0.062, depth: 0.19 },
  { width: 0.19, thickness: 0.038, depth: 0.14 },
];

const BOOK_CLOTHS = [
  "velvet_burgundy_01",
  "wool_midnight_03",
  "paint_verdigris_03",
  "walnut_mid_02",
  "linen_cream_02",
] as const;

function bookCloth(ctx: PropContext, placement: PropPlacement, index: number): THREE.Material {
  const declared = placement.swatchIds[index % Math.max(placement.swatchIds.length, 1)];
  return ctx.materials.get(declared ?? BOOK_CLOTHS[index % BOOK_CLOTHS.length] ?? "wool_midnight_03");
}

/** Horizontal stack. `size` is the book count; swatch ids cycle as cloth colours. */
export function buildBookStack(ctx: PropContext, placement: PropPlacement): void {
  const paper = ctx.materials.get("paper_aged_01");
  const random = makeRandom(seedFrom(placement.objectId));
  const count = Math.max(Math.round(placement.size ?? 4), 2);
  const b = ctx.batcher;
  let height = 0;

  for (let i = 0; i < count; i += 1) {
    const size = BOOK_SIZES[i % BOOK_SIZES.length] ?? BOOK_SIZES[0];
    if (size === undefined) {
      return;
    }
    const yaw = (random() - 0.5) * 0.5;
    const shift = (random() - 0.5) * 0.03;
    b.part(
      ctx.geometry.get(sized("book.cover", size.width, size.thickness, size.depth), () =>
        chamferedBox(size.width, size.thickness, size.depth, 0.006),
      ),
      bookCloth(ctx, placement, i),
      { x: shift, y: height + size.thickness / 2, ry: yaw },
      { shadow: false },
    );
    b.part(
      ctx.geometry.get(sized("book.pages", size.width, size.thickness, size.depth), () =>
        chamferedBox(size.width - 0.022, size.thickness * 0.62, size.depth - 0.018, 0.004),
      ),
      paper,
      { x: shift + 0.007, y: height + size.thickness / 2, ry: yaw },
      { shadow: false },
    );
    height += size.thickness;
  }
}

/** Upright run of books on a shelf. `size` is the run length in metres. */
export function buildBookRow(ctx: PropContext, placement: PropPlacement): void {
  const paper = ctx.materials.get("paper_aged_01");
  const random = makeRandom(seedFrom(placement.objectId));
  const length = quantize(placement.size ?? 0.8, 0.1);
  const b = ctx.batcher;

  let cursor = -length / 2;
  let index = 0;
  while (cursor < length / 2 - 0.03) {
    const size = BOOK_SIZES[index % BOOK_SIZES.length] ?? BOOK_SIZES[0];
    if (size === undefined) {
      return;
    }
    // Quantised so the whole shelf run still collapses into a few instanced
    // buckets: a continuous height would author a new geometry per book.
    const height = size.width * (0.86 + Math.floor(random() * 4) * 0.08);
    const lean = index % 7 === 6 ? 0.22 : 0;
    b.part(
      ctx.geometry.get(sized("bookRow.cover", size.thickness, height, size.depth), () =>
        chamferedBox(size.thickness, height, size.depth, 0.005),
      ),
      bookCloth(ctx, placement, index),
      { x: cursor + size.thickness / 2, y: height / 2, rz: lean },
      { shadow: false },
    );
    b.part(
      ctx.geometry.get(sized("bookRow.pages", size.thickness, height, size.depth), () =>
        chamferedBox(size.thickness * 0.66, height - 0.016, size.depth - 0.016, 0.003),
      ),
      paper,
      { x: cursor + size.thickness / 2, y: height / 2 - 0.004, z: 0.006, rz: lean },
      { shadow: false },
    );
    cursor += size.thickness + 0.004;
    index += 1;
  }
}

// -------------------------------------------------------- boxes and parcels

/** Wrapped parcel. Swatch roles: 0 = paper, 1 = ribbon. `size` is the width. */
export function buildParcel(ctx: PropContext, placement: PropPlacement): void {
  const paper = ctx.materials.get(swatchRole(placement, 0, "paper_kraft_02"));
  const ribbon = ctx.materials.get(swatchRole(placement, 1, "velvet_burgundy_01"));
  const width = quantize(placement.size ?? 0.34, 0.06);
  const height = width * 0.52;
  const depth = width * 0.74;
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get(sized("parcel.body", width, height, depth), () => chamferedBox(width, height, depth, 0.014)),
    paper,
    { y: height / 2 },
  );
  b.part(
    ctx.geometry.get(sized("parcel.strapX", width, height, depth), () =>
      chamferedBox(width + 0.006, height + 0.006, 0.03, 0.004),
    ),
    ribbon,
    { y: height / 2 },
    { shadow: false },
  );
  b.part(
    ctx.geometry.get(sized("parcel.strapZ", width, height, depth), () =>
      chamferedBox(0.03, height + 0.006, depth + 0.006, 0.004),
    ),
    ribbon,
    { y: height / 2 },
    { shadow: false },
  );
}

/** Lidded storage box. Swatch roles: 0 = body, 1 = lid. `size` is the width. */
export function buildStorageBox(ctx: PropContext, placement: PropPlacement): void {
  const body = ctx.materials.get(swatchRole(placement, 0, "paint_cream_01"));
  const lid = ctx.materials.get(swatchRole(placement, 1, "walnut_mid_02"));
  const width = quantize(placement.size ?? 0.4, 0.06);
  const height = width * 0.42;
  const depth = width * 0.8;
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get(sized("box.body", width, height, depth), () => chamferedBox(width, height, depth, 0.012)),
    body,
    { y: height / 2 },
  );
  b.part(
    ctx.geometry.get(sized("box.lid", width, depth), () => chamferedSlab(width + 0.024, 0.05, depth + 0.024, 0.01)),
    lid,
    { y: height + 0.018 },
    { shadow: false },
  );
  b.part(
    ctx.geometry.get("box.label", () => chamferedSlab(0.11, 0.006, 0.07, 0.003)),
    ctx.materials.get("paper_aged_01"),
    { y: height / 2, z: depth / 2 + 0.004, rx: Math.PI / 2 },
    { shadow: false },
  );
}

// -------------------------------------------------------- frames and clocks

/** Picture frame. Swatch roles: 0 = moulding, 1 = art, 2 = plaque. `size` is the width. */
export function buildPictureFrame(ctx: PropContext, placement: PropPlacement): void {
  const moulding = ctx.materials.get(swatchRole(placement, 0, "walnut_dark_01"));
  const art = ctx.materials.get(swatchRole(placement, 1, "paper_aged_01"));
  const plaqueMaterial = ctx.materials.get(swatchRole(placement, 2, "brass_aged_02"));
  const width = quantize(placement.size ?? 0.5, 0.08);
  const height = width * 0.78;
  const b = ctx.batcher;

  const rail = ctx.geometry.get(sized("frame.rail", width), () => chamferedBox(width + 0.09, 0.055, 0.045, 0.01));
  const stile = ctx.geometry.get(sized("frame.stile", height), () => chamferedBox(0.055, height, 0.045, 0.01));
  for (const dy of [-height / 2 - 0.027, height / 2 + 0.027]) {
    b.part(rail, moulding, { y: dy }, { shadow: false });
  }
  for (const dx of [-width / 2 - 0.027, width / 2 + 0.027]) {
    b.part(stile, moulding, { x: dx }, { shadow: false });
  }
  b.part(
    ctx.geometry.get(sized("frame.art", width, height), () => chamferedBox(width, height, 0.018, 0.004)),
    art,
    { z: -0.008 },
    { shadow: false },
  );
  b.part(ctx.geometry.get("frame.plaque", () => chamferedBox(0.13, 0.03, 0.01, 0.003)), plaqueMaterial, {
    y: -height / 2 - 0.027,
    z: 0.03,
  }, { shadow: false });
}

function clockFace(ctx: PropContext, radius: number): THREE.BufferGeometry {
  return ctx.geometry.get(sized("clock.face", radius), () => new THREE.CircleGeometry(radius, 24));
}

/** Wall clock. Swatch roles: 0 = case, 1 = dial, 2 = hands. `size` is the case radius. */
export function buildWallClock(ctx: PropContext, placement: PropPlacement): void {
  const caseMaterial = ctx.materials.get(swatchRole(placement, 0, "walnut_dark_01"));
  const dial = ctx.materials.get(swatchRole(placement, 1, "porcelain_cream_01"));
  const hands = ctx.materials.get(swatchRole(placement, 2, "iron_dark_03"));
  const radius = quantize(placement.size ?? 0.17, 0.03);
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get(sized("clock.case", radius), () =>
      lathe(
        [
          [0, 0],
          [radius, 0],
          [radius * 1.04, 0.02],
          [radius * 1.02, 0.06],
          [radius * 0.94, 0.075],
          [radius * 0.9, 0.072],
          [0, 0.07],
        ],
        20,
      ).rotateX(Math.PI / 2),
    ),
    caseMaterial,
    { z: -0.035 },
    { shadow: false },
  );
  b.part(clockFace(ctx, radius * 0.88), dial, { z: 0.037 }, { shadow: false });
  b.part(
    ctx.geometry.get(sized("clock.bezel.wall", radius), () => new THREE.TorusGeometry(radius * 0.92, 0.012, 6, 24)),
    ctx.materials.get("brass_tarnished_01"),
    { z: 0.038 },
    { shadow: false },
  );
  // The pivot sits at the base of the hand: a centred box would sweep through
  // the dial and read as a cross rather than as a clock.
  const hand = ctx.geometry.get("clock.hand", () =>
    chamferedBox(0.012, 0.11, 0.006, 0.002).translate(0, 0.055, 0),
  );
  b.part(hand, hands, { z: 0.045, rz: 0.35 }, { shadow: false });
  b.part(hand, hands, { z: 0.045, rz: -1.9, sy: 0.72 }, { shadow: false });
}

/** Mantel clock. Swatch roles: 0 = case, 1 = dial, 2 = feet. */
export function buildMantelClock(ctx: PropContext, placement: PropPlacement): void {
  const caseMaterial = ctx.materials.get(swatchRole(placement, 0, "walnut_mid_02"));
  const dial = ctx.materials.get(swatchRole(placement, 1, "porcelain_cream_01"));
  const feet = ctx.materials.get(swatchRole(placement, 2, "brass_aged_02"));
  const b = ctx.batcher;

  b.part(ctx.geometry.get("mantel.body", () => chamferedBox(0.28, 0.3, 0.15, 0.018)), caseMaterial, { y: 0.19 });
  b.part(
    ctx.geometry.get("mantel.crown", () =>
      lathe(
        [
          [0, 0],
          [0.14, 0],
          [0.136, 0.03],
          [0.11, 0.06],
          [0.06, 0.08],
          [0, 0.084],
        ],
        16,
      ),
    ),
    caseMaterial,
    { y: 0.34, sz: 0.54 },
    { shadow: false },
  );
  b.part(clockFace(ctx, 0.1), dial, { y: 0.2, z: 0.077 }, { shadow: false });
  b.part(
    ctx.geometry.get("clock.bezel.mantel", () => new THREE.TorusGeometry(0.104, 0.012, 6, 24)),
    feet,
    { y: 0.2, z: 0.078 },
    { shadow: false },
  );
  const foot = ctx.geometry.get("mantel.foot", () => new THREE.CylinderGeometry(0.022, 0.028, 0.04, 8));
  for (const dx of [-0.1, 0.1]) {
    for (const dz of [-0.05, 0.05]) {
      b.part(foot, feet, { x: dx, y: 0.02, z: dz }, { shadow: false });
    }
  }
}

/** Longcase clock, the Clock Wall landmark. Swatch roles: 0 = case, 1 = dial, 2 = pendulum. */
export function buildLongcaseClock(ctx: PropContext, placement: PropPlacement): void {
  const caseMaterial = ctx.materials.get(swatchRole(placement, 0, "walnut_dark_01"));
  const dial = ctx.materials.get(swatchRole(placement, 1, "porcelain_cream_01"));
  const brass = ctx.materials.get(swatchRole(placement, 2, "brass_tarnished_01"));
  const b = ctx.batcher;

  b.part(ctx.geometry.get("longcase.base", () => chamferedBox(0.52, 0.62, 0.32, 0.022)), caseMaterial, { y: 0.31 });
  b.part(ctx.geometry.get("longcase.waist", () => chamferedBox(0.4, 1.15, 0.26, 0.018)), caseMaterial, { y: 1.2 });
  b.part(ctx.geometry.get("longcase.hood", () => chamferedBox(0.5, 0.6, 0.32, 0.02)), caseMaterial, { y: 2.08 });
  b.part(ctx.geometry.get("longcase.cornice", () => chamferedSlab(0.58, 0.07, 0.38, 0.014)), caseMaterial, { y: 2.4 });
  b.part(
    ctx.geometry.get("longcase.pediment", () =>
      lathe(
        [
          [0, 0],
          [0.24, 0],
          [0.22, 0.05],
          [0.15, 0.1],
          [0, 0.12],
        ],
        14,
      ),
    ),
    caseMaterial,
    { y: 2.43, sz: 0.6 },
    { shadow: false },
  );
  b.part(clockFace(ctx, 0.17), dial, { y: 2.12, z: 0.163 }, { shadow: false });
  b.part(
    ctx.geometry.get("clock.bezel.longcase", () => new THREE.TorusGeometry(0.176, 0.014, 6, 26)),
    brass,
    { y: 2.12, z: 0.164 },
    { shadow: false },
  );
  b.part(
    ctx.geometry.get("longcase.glass", () => new THREE.PlaneGeometry(0.24, 0.9)),
    ctx.materials.get(GLASS_PANE_MATERIAL),
    { y: 1.25, z: 0.132 },
    { shadow: false, receive: false },
  );
  b.part(ctx.geometry.get("longcase.rod", () => new THREE.CylinderGeometry(0.007, 0.007, 0.78, 6)), brass, {
    y: 1.35,
    z: 0.06,
  }, { shadow: false });
  b.part(
    ctx.geometry.get("longcase.bob", () =>
      lathe(
        [
          [0, 0],
          [0.075, 0.006],
          [0.082, 0.03],
          [0.075, 0.055],
          [0, 0.062],
        ],
        18,
      ).rotateX(Math.PI / 2),
    ),
    brass,
    { y: 0.98, z: 0.06 },
    { shadow: false },
  );
  const hand = ctx.geometry.get("clock.hand", () =>
    chamferedBox(0.012, 0.11, 0.006, 0.002).translate(0, 0.055, 0),
  );
  b.part(hand, ctx.materials.get("iron_dark_03"), { y: 2.12, z: 0.172, rz: -0.5 }, { shadow: false });
  b.part(hand, ctx.materials.get("iron_dark_03"), { y: 2.12, z: 0.172, rz: 1.3, sy: 0.7 }, { shadow: false });
}

// -------------------------------------------------------- figures and plants

/** Sculpted bust. Swatch roles: 0 = stone, 1 = socle. */
export function buildBust(ctx: PropContext, placement: PropPlacement): void {
  const stone = ctx.materials.get(swatchRole(placement, 0, "marble_cream_01"));
  const socle = ctx.materials.get(swatchRole(placement, 1, "slate_grey_02"));
  const b = ctx.batcher;

  b.part(ctx.geometry.get("bust.socle", () => chamferedSlab(0.2, 0.06, 0.17, 0.01)), socle, { y: 0.03 });
  b.part(
    ctx.geometry.get("bust.shoulders", () =>
      lathe(
        [
          [0, 0.06],
          [0.085, 0.062],
          [0.115, 0.1],
          [0.12, 0.16],
          [0.09, 0.22],
          [0.055, 0.25],
          [0, 0.252],
        ],
        18,
      ),
    ),
    stone,
    { sx: 1.25 },
  );
  b.part(
    ctx.geometry.get("bust.neck", () => new THREE.CylinderGeometry(0.036, 0.048, 0.07, 12)),
    stone,
    { y: 0.28 },
    { shadow: false },
  );
  b.part(ctx.geometry.get("bust.head", () => new THREE.SphereGeometry(0.078, 16, 12)), stone, {
    y: 0.38,
    sz: 0.92,
    sy: 1.14,
  });
}

/** Tailor's mannequin. Swatch roles: 0 = torso, 1 = stand. */
export function buildMannequin(ctx: PropContext, placement: PropPlacement): void {
  const torso = ctx.materials.get(swatchRole(placement, 0, "linen_cream_02"));
  const stand = ctx.materials.get(swatchRole(placement, 1, "walnut_dark_01"));
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("mannequin.base", () =>
      lathe(
        [
          [0, 0],
          [0.17, 0],
          [0.178, 0.016],
          [0.15, 0.035],
          [0.04, 0.05],
          [0, 0.05],
        ],
        18,
      ),
    ),
    stand,
  );
  b.part(ctx.geometry.get("mannequin.pole", () => new THREE.CylinderGeometry(0.022, 0.028, 0.62, 10)), stand, {
    y: 0.36,
  });
  b.part(
    ctx.geometry.get("mannequin.torso", () =>
      lathe(
        [
          [0, 0.62],
          [0.09, 0.63],
          [0.17, 0.72],
          [0.2, 0.86],
          [0.168, 1.0],
          [0.152, 1.09],
          [0.19, 1.2],
          [0.196, 1.29],
          [0.15, 1.36],
          [0.075, 1.38],
          [0, 1.375],
        ],
        20,
      ),
    ),
    torso,
    { sx: 1.16 },
  );
  b.part(ctx.geometry.get("mannequin.knob", () => new THREE.SphereGeometry(0.045, 12, 9)), stand, {
    y: 1.43,
    sy: 1.2,
  });
}

/** Potted plant. Swatch roles: 0 = pot, 1 = foliage. `size` scales the foliage. */
export function buildPlant(ctx: PropContext, placement: PropPlacement): void {
  const pot = ctx.materials.get(swatchRole(placement, 0, "ceramic_oxblood_03"));
  const leaf = ctx.materials.get(swatchRole(placement, 1, "paint_verdigris_03"));
  const spread = placement.size ?? 1;
  const random = makeRandom(seedFrom(placement.objectId));
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("plant.pot", () =>
      lathe(
        [
          [0, 0],
          [0.1, 0],
          [0.108, 0.014],
          [0.132, 0.16],
          [0.146, 0.24],
          [0.138, 0.252],
          [0.122, 0.244],
          [0.112, 0.03],
          [0, 0.026],
        ],
        20,
      ),
    ),
    pot,
  );
  b.part(
    ctx.geometry.get("plant.soil", () => new THREE.CylinderGeometry(0.12, 0.115, 0.02, 16)),
    ctx.materials.get("slate_grey_02"),
    { y: 0.235 },
    { shadow: false },
  );

  const blade = ctx.geometry.get("plant.blade", () =>
    lathe(
      [
        [0, 0],
        [0.03, 0.08],
        [0.042, 0.26],
        [0.03, 0.44],
        [0, 0.52],
      ],
      6,
    ).scale(1, 1, 0.22),
  );
  const blades = 7;
  for (let i = 0; i < blades; i += 1) {
    const angle = (i / blades) * Math.PI * 2 + random() * 0.4;
    const tilt = 0.28 + random() * 0.3;
    b.part(
      blade,
      leaf,
      {
        x: Math.sin(angle) * 0.05,
        y: 0.24,
        z: Math.cos(angle) * 0.05,
        ry: angle,
        rx: Math.cos(angle) * tilt,
        rz: -Math.sin(angle) * tilt,
        sx: spread,
        sy: 0.85 + random() * 0.4,
        sz: spread,
      },
      { shadow: false },
    );
  }
}

// ---------------------------------------------------------- counter and shop

/** Brass register. Swatch roles: 0 = body, 1 = keys, 2 = flag. */
export function buildRegister(ctx: PropContext, placement: PropPlacement): void {
  const body = ctx.materials.get(swatchRole(placement, 0, "brass_tarnished_01"));
  const keys = ctx.materials.get(swatchRole(placement, 1, "bakelite_black_01"));
  const flag = ctx.materials.get(swatchRole(placement, 2, "paper_aged_01"));
  const b = ctx.batcher;

  b.part(ctx.geometry.get("register.body", () => chamferedBox(0.42, 0.3, 0.34, 0.02)), body, { y: 0.15 });
  b.part(ctx.geometry.get("register.drawer", () => chamferedBox(0.4, 0.1, 0.3, 0.012)), ctx.materials.get("walnut_dark_01"), {
    y: 0.05,
    z: 0.03,
  });
  b.part(
    ctx.geometry.get("register.crown", () =>
      lathe(
        [
          [0, 0],
          [0.2, 0],
          [0.19, 0.05],
          [0.13, 0.1],
          [0, 0.12],
        ],
        14,
      ),
    ),
    body,
    { y: 0.3, sz: 0.85 },
    { shadow: false },
  );
  b.part(ctx.geometry.get("register.flag", () => chamferedBox(0.14, 0.09, 0.008, 0.004)), flag, { y: 0.46 }, { shadow: false });

  const key = ctx.geometry.get("register.key", () => new THREE.CylinderGeometry(0.014, 0.014, 0.03, 8));
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      b.part(
        key,
        keys,
        { x: -0.09 + column * 0.06, y: 0.31 - row * 0.005, z: 0.06 + row * 0.055 },
        { shadow: false },
      );
    }
  }
}

/** Counter bell. Swatch roles: 0 = dome, 1 = base. */
export function buildBell(ctx: PropContext, placement: PropPlacement): void {
  const dome = ctx.materials.get(swatchRole(placement, 0, "brass_tarnished_01"));
  const base = ctx.materials.get(swatchRole(placement, 1, "walnut_dark_01"));
  const b = ctx.batcher;

  b.part(ctx.geometry.get("bell.base", () => chamferedSlab(0.13, 0.022, 0.13, 0.006)), base, { y: 0.011 });
  b.part(
    ctx.geometry.get("bell.dome", () =>
      lathe(
        [
          [0, 0.022],
          [0.052, 0.024],
          [0.055, 0.04],
          [0.045, 0.065],
          [0.026, 0.078],
          [0, 0.08],
        ],
        16,
      ),
    ),
    dome,
  );
  b.part(ctx.geometry.get("bell.button", () => new THREE.SphereGeometry(0.012, 8, 6)), dome, { y: 0.088 }, { shadow: false });
}

/** Roll of wrapping paper or bolt of cloth. Swatch roles: 0 = roll, 1 = core. `size` is the length. */
export function buildRoll(ctx: PropContext, placement: PropPlacement): void {
  const surface = ctx.materials.get(swatchRole(placement, 0, "paper_kraft_02"));
  const core = ctx.materials.get(swatchRole(placement, 1, "walnut_mid_02"));
  const length = quantize(placement.size ?? 0.72, 0.1);
  const radius = placement.variant === "fabric_roll" ? 0.1 : 0.065;
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get(sized("roll.body", radius, length), () =>
      new THREE.CylinderGeometry(radius, radius, length, 16),
    ),
    surface,
    { y: length / 2 },
  );
  b.part(
    ctx.geometry.get(sized("roll.core", length), () => new THREE.CylinderGeometry(0.017, 0.017, length + 0.09, 8)),
    core,
    { y: length / 2 },
    { shadow: false },
  );
  b.part(
    ctx.geometry.get(sized("roll.edge", radius), () => new THREE.TorusGeometry(radius, 0.008, 6, 20)),
    surface,
    { y: length - 0.02, rx: Math.PI / 2 },
    { shadow: false },
  );
}

/** Hand tool on a bench or a rack. Swatch roles: 0 = head, 1 = handle. */
export function buildHandTool(ctx: PropContext, placement: PropPlacement): void {
  const head = ctx.materials.get(swatchRole(placement, 0, "iron_dark_03"));
  const handle = ctx.materials.get(swatchRole(placement, 1, "oak_pale_03"));
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("tool.handle", () => new THREE.CylinderGeometry(0.017, 0.021, 0.24, 8)),
    handle,
    { y: 0.021, rz: Math.PI / 2 },
    { shadow: false },
  );
  b.part(ctx.geometry.get("tool.ferrule", () => new THREE.CylinderGeometry(0.022, 0.022, 0.03, 8)), head, {
    x: 0.11,
    y: 0.021,
    rz: Math.PI / 2,
  }, { shadow: false });
  b.part(ctx.geometry.get("tool.head", () => chamferedBox(0.11, 0.038, 0.038, 0.008)), head, { x: 0.18, y: 0.021 }, { shadow: false });
}

/** Bench clamp. Swatch roles: 0 = frame, 1 = pads. */
export function buildClamp(ctx: PropContext, placement: PropPlacement): void {
  const frame = ctx.materials.get(swatchRole(placement, 0, "iron_dark_03"));
  const pad = ctx.materials.get(swatchRole(placement, 1, "oak_pale_03"));
  const b = ctx.batcher;

  b.part(ctx.geometry.get("clamp.bar", () => chamferedBox(0.32, 0.028, 0.02, 0.005)), frame, { y: 0.014 }, { shadow: false });
  const jaw = ctx.geometry.get("clamp.jaw", () => chamferedBox(0.028, 0.14, 0.05, 0.008));
  b.part(jaw, frame, { x: -0.13, y: 0.084 }, { shadow: false });
  b.part(jaw, frame, { x: 0.06, y: 0.084 }, { shadow: false });
  b.part(ctx.geometry.get("clamp.screw", () => new THREE.CylinderGeometry(0.009, 0.009, 0.16, 6)), frame, {
    x: 0.13,
    y: 0.12,
    rz: Math.PI / 2,
  }, { shadow: false });
  b.part(ctx.geometry.get("clamp.pad", () => chamferedBox(0.02, 0.06, 0.05, 0.006)), pad, { x: -0.11, y: 0.11 }, { shadow: false });
}

/** Terrestrial globe on a stand. Swatch roles: 0 = sphere, 1 = meridian and stand. */
export function buildGlobe(ctx: PropContext, placement: PropPlacement): void {
  const sphere = ctx.materials.get(swatchRole(placement, 0, "paper_aged_01"));
  const metal = ctx.materials.get(swatchRole(placement, 1, "brass_aged_02"));
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("globe.foot", () =>
      lathe(
        [
          [0, 0],
          [0.11, 0],
          [0.115, 0.014],
          [0.05, 0.04],
          [0.026, 0.07],
          [0, 0.07],
        ],
        16,
      ),
    ),
    metal,
  );
  b.part(ctx.geometry.get("globe.stem", () => new THREE.CylinderGeometry(0.014, 0.018, 0.18, 8)), metal, { y: 0.15 });
  b.part(ctx.geometry.get("globe.sphere", () => new THREE.SphereGeometry(0.15, 20, 14)), sphere, { y: 0.4 });
  b.part(
    ctx.geometry.get("globe.meridian", () => new THREE.TorusGeometry(0.168, 0.009, 6, 28, Math.PI * 1.35)),
    metal,
    { y: 0.4, ry: Math.PI / 2, rz: 0.4 },
    { shadow: false },
  );
}

/** Display stand for a single object: a turned column with a felt top. */
export function buildDisplayStand(ctx: PropContext, placement: PropPlacement): void {
  const column = ctx.materials.get(swatchRole(placement, 0, "walnut_dark_01"));
  const felt = ctx.materials.get(swatchRole(placement, 1, "velvet_burgundy_01"));
  const height = quantize(placement.size ?? 0.32, 0.06);
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get(sized("stand.column", height), () =>
      lathe(
        [
          [0, 0],
          [0.11, 0],
          [0.116, 0.016],
          [0.07, 0.04],
          [0.045, height * 0.45],
          [0.052, height - 0.05],
          [0.095, height - 0.02],
          [0.1, height],
          [0, height],
        ],
        18,
      ),
    ),
    column,
  );
  b.part(
    ctx.geometry.get(sized("stand.felt", height), () => new THREE.CylinderGeometry(0.092, 0.092, 0.008, 18)),
    felt,
    { y: height + 0.004 },
    { shadow: false },
  );
}

/** Small mechanical curiosity: a brass orrery-like ornament for cabinet shelves. */
export function buildOrnament(ctx: PropContext, placement: PropPlacement): void {
  const metal = ctx.materials.get(swatchRole(placement, 0, "brass_tarnished_01"));
  const accent = ctx.materials.get(swatchRole(placement, 1, "ceramic_celadon_02"));
  const b = ctx.batcher;

  b.part(ctx.geometry.get("ornament.base", () => new THREE.CylinderGeometry(0.06, 0.07, 0.025, 14)), metal, { y: 0.012 });
  b.part(ctx.geometry.get("ornament.stem", () => new THREE.CylinderGeometry(0.008, 0.01, 0.12, 6)), metal, { y: 0.085 });
  b.part(ctx.geometry.get("ornament.ring", () => new THREE.TorusGeometry(0.055, 0.006, 6, 20)), metal, {
    y: 0.14,
    rx: 0.6,
  }, { shadow: false });
  b.part(ctx.geometry.get("ornament.bead", () => new THREE.SphereGeometry(0.022, 10, 8)), accent, { y: 0.16 }, { shadow: false });
}

/** Sealed jar of specimens, the cabinet maze's odd note. Swatch roles: 0 = glass, 1 = lid. */
export function buildSpecimenJar(ctx: PropContext, placement: PropPlacement): void {
  const glass = ctx.materials.get(swatchRole(placement, 0, "glass_bottle_02"));
  const lid = ctx.materials.get(swatchRole(placement, 1, "copper_patina_04"));
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("jar.body", () =>
      lathe(
        [
          [0, 0],
          [0.072, 0],
          [0.078, 0.014],
          [0.08, 0.2],
          [0.062, 0.24],
          [0.06, 0.26],
          [0, 0.26],
        ],
        18,
      ),
    ),
    glass,
    {},
    { shadow: false },
  );
  b.part(ctx.geometry.get("jar.lid", () => new THREE.CylinderGeometry(0.066, 0.062, 0.03, 16)), lid, { y: 0.272 }, { shadow: false });
  b.part(
    ctx.geometry.get("jar.contents", () => superellipseColumn(0.07, 0.05, 0.12, 2.6, 0.01)),
    ctx.materials.get("ceramic_celadon_02"),
    { y: 0.03 },
    { shadow: false },
  );
}

/** Emissive stub for the shop's night-light in the office window (§5.7). */
export function buildIndicatorLight(ctx: PropContext, placement: PropPlacement): void {
  const housing = ctx.materials.get(swatchRole(placement, 0, "iron_dark_03"));
  const b = ctx.batcher;
  b.part(ctx.geometry.get("indicator.housing", () => new THREE.CylinderGeometry(0.035, 0.04, 0.06, 10)), housing, {}, { shadow: false });
  b.part(ctx.geometry.get("indicator.lens", () => new THREE.SphereGeometry(0.028, 10, 8)), ctx.materials.get(BULB_MATERIAL), { y: 0.04 }, { shadow: false, receive: false });
}
