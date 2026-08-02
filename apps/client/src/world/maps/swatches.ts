/**
 * Material swatches The Curiosity Shop publishes (bible §7.12, §17.3).
 *
 * A surface declares the swatch it is made of and sampling copies that id, so
 * this catalogue is the complete set of materials a disguise can ever wear in
 * this map. Every §7.12 family is represented, because the Forge's material
 * layer is only interesting when the room offers real choices inside a family
 * as well as across families.
 */

export type SwatchFamily =
  | "wood"
  | "paint"
  | "metal"
  | "fabric"
  | "ceramic"
  | "glass"
  | "paper"
  | "plastic"
  | "stone";

export interface MapSwatch {
  readonly id: string;
  readonly label: string;
  readonly family: SwatchFamily;
  /** sRGB base colour in 0..1, the shape §7.12 publishes on the wire. */
  readonly baseColor: readonly [number, number, number];
  readonly roughness: number;
  readonly metalness: number;
  readonly clearcoat?: number;
  readonly sheen?: number;
  readonly transmission?: number;
  readonly triplanarScale?: number;
  readonly legalForMimic: boolean;
}

function srgb(hex: number): readonly [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/**
 * Every entry is drawn from the §17.3 core palette or from a neutral the
 * palette implies. No saturated primaries: the shop reads as porcelain, amber,
 * walnut, brass, burgundy, oxidized green, midnight blue and moonlit gray.
 */
export const SHOP_SWATCHES: readonly MapSwatch[] = [
  {
    id: "walnut_dark_01",
    label: "Dark walnut",
    family: "wood",
    baseColor: srgb(0x2f1d13),
    roughness: 0.58,
    metalness: 0,
    triplanarScale: 1.4,
    legalForMimic: true,
  },
  {
    id: "walnut_mid_02",
    label: "Walnut",
    family: "wood",
    baseColor: srgb(0x4a2e1c),
    roughness: 0.52,
    metalness: 0,
    triplanarScale: 1.4,
    legalForMimic: true,
  },
  {
    id: "oak_pale_03",
    label: "Pale oak",
    family: "wood",
    baseColor: srgb(0x9a7448),
    roughness: 0.64,
    metalness: 0,
    triplanarScale: 1.6,
    legalForMimic: true,
  },
  /**
   * The three floorboard tones.
   *
   * A shop floor is walked on, so it is lighter and greyer than the cabinet
   * walnut standing on it: the boards were the same stock once and years of
   * traffic took the stain off them. They are their own swatches rather than a
   * reuse of `walnut_*` because the floor fills the bottom of every eye-level
   * frame at giant scale, and a surface that large has to sit in a readable
   * band whatever else the palette does. Sampling has to hand back the colour
   * the player actually sees (§7.12), so a distinct look means a distinct id.
   */
  {
    id: "floorboard_oak_02",
    label: "Oak floorboard",
    family: "wood",
    baseColor: srgb(0x5c3f27),
    roughness: 0.66,
    metalness: 0,
    triplanarScale: 1.4,
    legalForMimic: true,
  },
  {
    id: "floorboard_bleached_03",
    label: "Bleached floorboard",
    family: "wood",
    baseColor: srgb(0x7a5738),
    roughness: 0.72,
    metalness: 0,
    triplanarScale: 1.4,
    legalForMimic: true,
  },
  {
    id: "floorboard_stained_01",
    label: "Stained floorboard",
    family: "wood",
    baseColor: srgb(0x3c2718),
    roughness: 0.6,
    metalness: 0,
    triplanarScale: 1.4,
    legalForMimic: true,
  },
  {
    id: "paint_cream_01",
    label: "Cream plaster",
    family: "paint",
    baseColor: srgb(0xe4d8c3),
    roughness: 0.92,
    metalness: 0,
    triplanarScale: 1.2,
    legalForMimic: true,
  },
  {
    id: "paint_midnight_02",
    label: "Midnight enamel",
    family: "paint",
    baseColor: srgb(0x1b2742),
    roughness: 0.44,
    metalness: 0,
    clearcoat: 0.25,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "paint_verdigris_03",
    label: "Oxidized green",
    family: "paint",
    baseColor: srgb(0x4d7a68),
    roughness: 0.56,
    metalness: 0,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "brass_tarnished_01",
    label: "Tarnished brass",
    family: "metal",
    baseColor: srgb(0xb08a4a),
    roughness: 0.34,
    metalness: 0.92,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "brass_aged_02",
    label: "Aged brass",
    family: "metal",
    baseColor: srgb(0x7a6134),
    roughness: 0.56,
    metalness: 0.84,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "iron_dark_03",
    label: "Blackened iron",
    family: "metal",
    baseColor: srgb(0x2a2724),
    roughness: 0.48,
    metalness: 0.78,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "copper_patina_04",
    label: "Copper patina",
    family: "metal",
    baseColor: srgb(0x5e8c74),
    roughness: 0.5,
    metalness: 0.5,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "velvet_burgundy_01",
    label: "Burgundy velvet",
    family: "fabric",
    baseColor: srgb(0x431122),
    roughness: 0.9,
    metalness: 0,
    sheen: 1,
    triplanarScale: 2.2,
    legalForMimic: true,
  },
  {
    id: "linen_cream_02",
    label: "Cream linen",
    family: "fabric",
    baseColor: srgb(0xe8dcc0),
    roughness: 0.8,
    metalness: 0,
    sheen: 0.4,
    triplanarScale: 2.2,
    legalForMimic: true,
  },
  {
    id: "wool_midnight_03",
    label: "Midnight wool",
    family: "fabric",
    baseColor: srgb(0x232f49),
    roughness: 0.88,
    metalness: 0,
    sheen: 0.3,
    triplanarScale: 2.6,
    legalForMimic: true,
  },
  {
    id: "porcelain_cream_01",
    label: "Porcelain",
    family: "ceramic",
    baseColor: srgb(0xece2d2),
    roughness: 0.28,
    metalness: 0,
    clearcoat: 0.5,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "ceramic_celadon_02",
    label: "Celadon glaze",
    family: "ceramic",
    baseColor: srgb(0x8fb3a2),
    roughness: 0.2,
    metalness: 0,
    clearcoat: 0.75,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "ceramic_oxblood_03",
    label: "Oxblood glaze",
    family: "ceramic",
    baseColor: srgb(0x6b2a24),
    roughness: 0.24,
    metalness: 0,
    clearcoat: 0.7,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    // Refused on a body: a Mimic wearing cabinet glass would read as a hole in
    // the room rather than as an object (§7.12 legality).
    id: "glass_cabinet_01",
    label: "Cabinet glass",
    family: "glass",
    baseColor: srgb(0xc8d6e2),
    roughness: 0.06,
    metalness: 0,
    transmission: 0.9,
    legalForMimic: false,
  },
  {
    id: "glass_bottle_02",
    label: "Bottle glass",
    family: "glass",
    baseColor: srgb(0x4a6b58),
    roughness: 0.12,
    metalness: 0,
    transmission: 0.6,
    legalForMimic: false,
  },
  {
    id: "paper_aged_01",
    label: "Aged paper",
    family: "paper",
    baseColor: srgb(0xdccfb2),
    roughness: 0.88,
    metalness: 0,
    triplanarScale: 1.8,
    legalForMimic: true,
  },
  {
    id: "paper_kraft_02",
    label: "Kraft wrapping",
    family: "paper",
    baseColor: srgb(0xb98f63),
    roughness: 0.85,
    metalness: 0,
    triplanarScale: 1.8,
    legalForMimic: true,
  },
  {
    id: "bakelite_black_01",
    label: "Black bakelite",
    family: "plastic",
    baseColor: srgb(0x241e1c),
    roughness: 0.36,
    metalness: 0,
    clearcoat: 0.4,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "marble_cream_01",
    label: "Cream marble",
    family: "stone",
    baseColor: srgb(0xdcd5c6),
    roughness: 0.22,
    metalness: 0,
    clearcoat: 0.3,
    triplanarScale: 1.2,
    legalForMimic: true,
  },
  {
    id: "slate_grey_02",
    label: "Slate",
    family: "stone",
    baseColor: srgb(0x4a4e52),
    roughness: 0.72,
    metalness: 0,
    triplanarScale: 1.2,
    legalForMimic: true,
  },
];

/**
 * The floorboard tones, in the order the floor draws from them. Kept here
 * rather than in the floor builder because both the builder and the material
 * library have to agree on which swatches wear the plank maps.
 */
export const FLOORBOARD_SWATCH_IDS = [
  "floorboard_oak_02",
  "floorboard_bleached_03",
  "floorboard_stained_01",
] as const;

export type FloorboardSwatchId = (typeof FLOORBOARD_SWATCH_IDS)[number];

const byId = new Map<string, MapSwatch>(SHOP_SWATCHES.map((swatch) => [swatch.id, swatch]));

export function shopSwatch(id: string): MapSwatch | null {
  return byId.get(id) ?? null;
}

export function isShopSwatch(id: string): boolean {
  return byId.has(id);
}

/**
 * Emissive surfaces the map deliberately publishes no swatch for: a lit bulb
 * copied onto a disguise would read as a light source rather than as an object.
 */
export const NON_SAMPLEABLE_MATERIALS = ["bulb_warm", "moon_backdrop"] as const;

export type NonSampleableMaterialId = (typeof NON_SAMPLEABLE_MATERIALS)[number];

/** Every material id a prop may ask for, sampleable or not. */
export type ShopMaterialId = string;
