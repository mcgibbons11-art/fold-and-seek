import type { InnocentReactionId } from "@foldseek/shared";
import type { ZoneId } from "./zones";

/**
 * Authored contents of The Curiosity Shop: one entry per prop, in the order
 * the map builds them.
 *
 * This list is the single source of truth. The prop library reads it to build
 * geometry, the object registry reads it to publish gameplay metadata, and the
 * lighting reads it to find the practicals, so a prop cannot exist visually
 * without also existing for the simulation.
 */

/**
 * Counting families, named after the repetition targets in §10.2:
 * lamp (8+), seat (10+ chairs and stools), vessel (12+ vases and ceramics),
 * container (16+ boxes and parcels), frame (14+ frames and clocks),
 * stand (8+ plants and stands), book (20+ book and bundle arrangements),
 * sculpture (10+ sculptures and mannequins), tool (12+ tools and stands).
 * `furniture`, `textile` and `fixture` carry no minimum.
 */
export type PropFamily =
  | "lamp"
  | "seat"
  | "vessel"
  | "container"
  | "frame"
  | "stand"
  | "book"
  | "sculpture"
  | "tool"
  | "furniture"
  | "textile"
  | "fixture";

export type PropVariant =
  | "floor_lamp"
  | "table_lamp"
  | "wall_sconce"
  | "pendant_lamp"
  | "task_light"
  | "candlestick"
  | "armchair"
  | "footstool"
  | "stool"
  | "ladderback_chair"
  | "side_table"
  | "plinth"
  | "display_cabinet"
  | "wall_shelf"
  | "low_shelf"
  | "shelving_unit"
  | "counter"
  | "back_cabinet"
  | "workbench"
  | "crate"
  | "umbrella_stand"
  | "rug"
  | "ladder"
  | "curtain"
  | "hanging_sign"
  | "display_tray"
  | "monitor_desk"
  | "vase_tall"
  | "vase_round"
  | "bottle"
  | "urn"
  | "bowl"
  | "teapot"
  | "kettle"
  | "book_stack"
  | "book_row"
  | "parcel"
  | "storage_box"
  | "picture_frame"
  | "wall_clock"
  | "mantel_clock"
  | "longcase_clock"
  | "bust"
  | "mannequin"
  | "plant"
  | "register"
  | "bell"
  | "paper_roll"
  | "fabric_roll"
  | "hand_tool"
  | "clamp"
  | "globe"
  | "display_stand"
  | "ornament"
  | "specimen_jar"
  | "indicator_light";

/** A lamp that actually lights the room rather than only reading as one. */
export interface PracticalLight {
  readonly offsetY: number;
  readonly color: number;
  readonly intensity: number;
  readonly distance: number;
  /** Higher wins when a quality tier can only afford some of the practicals. */
  readonly priority: number;
}

export interface PropPlacement {
  readonly objectId: string;
  readonly variant: PropVariant;
  /** Gameplay category the Inspector accuses (§8.3). */
  readonly categoryId: string;
  readonly family: PropFamily;
  readonly zoneId: ZoneId;
  /** World position of the prop origin, which is its footprint centre. */
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  /** Variant-specific scalar: width, height, length or count. */
  readonly size?: number;
  /** Hero props get individual meshes and cast dynamic shadows (§17.5). */
  readonly hero: boolean;
  /** Swatch ids in the variant's documented role order. */
  readonly swatchIds: readonly string[];
  readonly inspectable: boolean;
  readonly baselinePresent: boolean;
  readonly innocentReactionId: InnocentReactionId;
  /** Focus box extents (width, height, depth) measured from the origin (§8.3). */
  readonly focus: readonly [number, number, number];
  readonly practical?: PracticalLight;
  /**
   * True where the prop is low clutter that stops a walk, and `nav.ts` derives
   * its navigation blocker from the focus box above rather than from a hand
   * written box of its own.
   *
   * The shop's furniture is authored the other way round: each blocker is
   * written out in `nav.ts` and spans only the height its prop really occupies,
   * which is what lets a bench block its legs and open its bay. Clutter has no
   * such shape to describe, and it is the one thing in the room a player walks
   * into at ankle height, so the box that stops them and the box they can see
   * come from the same three numbers. It also keeps the prop out of the
   * background layer a weak tier sheds: an obstacle that a quality setting can
   * make invisible is an invisible wall.
   */
  readonly obstacle?: boolean;
}

const REACTION_BY_FAMILY: Readonly<Record<PropFamily, InnocentReactionId>> = {
  lamp: "lamp_turns_on",
  seat: "chair_squeaks",
  vessel: "vase_dust_puff",
  container: "vase_dust_puff",
  frame: "vase_dust_puff",
  stand: "vase_dust_puff",
  book: "vase_dust_puff",
  sculpture: "chair_squeaks",
  tool: "chair_squeaks",
  furniture: "chair_squeaks",
  textile: "vase_dust_puff",
  fixture: "clock_chimes",
};

interface PlacementInput {
  readonly objectId: string;
  readonly variant: PropVariant;
  readonly categoryId: string;
  readonly family: PropFamily;
  readonly zoneId: ZoneId;
  readonly position: readonly [number, number, number];
  readonly rotationY?: number;
  readonly size?: number;
  readonly hero?: boolean;
  readonly swatchIds?: readonly string[];
  readonly inspectable?: boolean;
  readonly baselinePresent?: boolean;
  readonly innocentReactionId?: InnocentReactionId;
  readonly focus: readonly [number, number, number];
  readonly practical?: PracticalLight;
  readonly obstacle?: boolean;
}

function p(input: PlacementInput): PropPlacement {
  return {
    rotationY: 0,
    hero: false,
    swatchIds: [],
    inspectable: true,
    baselinePresent: true,
    innocentReactionId: REACTION_BY_FAMILY[input.family],
    ...input,
  };
}

const WARM = 0xffb066;
const WARM_COOL = 0xffd0a0;

const WEST = Math.PI / 2;
const EAST = -Math.PI / 2;
const SOUTH = Math.PI;

// ------------------------------------------------------- A. Front Window

const FRONT_WINDOW: readonly PropPlacement[] = [
  p({
    objectId: "window_mannequin_01",
    variant: "mannequin",
    categoryId: "mannequin",
    family: "sculpture",
    zoneId: "front_window",
    position: [-5.8, 0.34, -4.95],
    rotationY: 0.35,
    hero: true,
    swatchIds: ["linen_cream_02", "walnut_dark_01"],
    focus: [0.5, 1.5, 0.45],
  }),
  p({
    objectId: "window_mannequin_02",
    variant: "mannequin",
    categoryId: "mannequin",
    family: "sculpture",
    zoneId: "front_window",
    position: [-4.4, 0.34, -5.0],
    rotationY: -0.5,
    hero: true,
    swatchIds: ["velvet_burgundy_01", "walnut_dark_01"],
    focus: [0.5, 1.5, 0.45],
  }),
  p({
    objectId: "window_mannequin_03",
    variant: "mannequin",
    categoryId: "mannequin",
    family: "sculpture",
    zoneId: "front_window",
    position: [-2.5, 0.34, -4.85],
    rotationY: 1.0,
    swatchIds: ["wool_midnight_03", "brass_aged_02"],
    focus: [0.5, 1.5, 0.45],
  }),
  p({
    objectId: "window_plinth_01",
    variant: "plinth",
    categoryId: "display_plinth",
    family: "stand",
    zoneId: "front_window",
    position: [-3.45, 0.34, -5.0],
    size: 0.55,
    swatchIds: ["paint_cream_01", "walnut_dark_01"],
    focus: [0.42, 0.55, 0.42],
  }),
  p({
    objectId: "window_plinth_02",
    variant: "plinth",
    categoryId: "display_plinth",
    family: "stand",
    zoneId: "front_window",
    position: [-1.5, 0.34, -4.95],
    size: 0.8,
    swatchIds: ["paint_cream_01", "walnut_dark_01"],
    focus: [0.42, 0.8, 0.42],
  }),
  p({
    objectId: "window_plinth_03",
    variant: "plinth",
    categoryId: "display_plinth",
    family: "stand",
    zoneId: "front_window",
    position: [-1.2, 0.34, -4.55],
    size: 0.45,
    rotationY: 0.4,
    swatchIds: ["marble_cream_01", "walnut_dark_01"],
    focus: [0.42, 0.45, 0.42],
  }),
  p({
    objectId: "window_urn_01",
    variant: "urn",
    categoryId: "urn",
    family: "vessel",
    zoneId: "front_window",
    position: [-3.45, 0.89, -5.0],
    innocentReactionId: "kettle_whistles",
    swatchIds: ["ceramic_celadon_02", "brass_aged_02"],
    focus: [0.3, 0.38, 0.3],
  }),
  p({
    objectId: "window_vase_01",
    variant: "vase_tall",
    categoryId: "vase",
    family: "vessel",
    zoneId: "front_window",
    position: [-1.5, 1.14, -4.95],
    swatchIds: ["ceramic_oxblood_03", "brass_aged_02"],
    focus: [0.24, 0.48, 0.24],
  }),
  p({
    objectId: "window_bowl_01",
    inspectable: false,
    variant: "bowl",
    categoryId: "bowl",
    family: "vessel",
    zoneId: "front_window",
    position: [-1.2, 0.79, -4.55],
    swatchIds: ["porcelain_cream_01", "brass_aged_02"],
    focus: [0.3, 0.14, 0.3],
  }),
  p({
    objectId: "window_floor_lamp_01",
    variant: "floor_lamp",
    categoryId: "floor_lamp",
    family: "lamp",
    zoneId: "front_window",
    position: [-6.35, 0, -4.0],
    hero: true,
    swatchIds: ["brass_tarnished_01"],
    focus: [0.6, 1.75, 0.6],
    practical: { offsetY: 1.5, color: WARM, intensity: 6, distance: 5.5, priority: 9 },
  }),
  p({
    objectId: "window_floor_lamp_02",
    variant: "floor_lamp",
    categoryId: "floor_lamp",
    family: "lamp",
    zoneId: "front_window",
    position: [-0.5, 0, -4.15],
    swatchIds: ["brass_aged_02"],
    focus: [0.6, 1.75, 0.6],
    practical: { offsetY: 1.5, color: WARM, intensity: 5, distance: 5, priority: 7 },
  }),
  p({
    objectId: "window_plant_01",
    variant: "plant",
    categoryId: "potted_plant",
    family: "stand",
    zoneId: "front_window",
    position: [-7.0, 0, -3.9],
    size: 1.15,
    swatchIds: ["ceramic_oxblood_03", "paint_verdigris_03"],
    focus: [0.62, 0.85, 0.62],
  }),
  p({
    objectId: "window_plant_02",
    variant: "plant",
    categoryId: "potted_plant",
    family: "stand",
    zoneId: "front_window",
    position: [2.35, 0, -4.7],
    size: 0.95,
    swatchIds: ["copper_patina_04", "paint_verdigris_03"],
    focus: [0.55, 0.8, 0.55],
  }),
  p({
    objectId: "window_curtain_01",
    variant: "curtain",
    categoryId: "curtain",
    family: "textile",
    zoneId: "front_window",
    position: [-6.85, 0.55, -5.3],
    size: 2.3,
    inspectable: false,
    swatchIds: ["velvet_burgundy_01", "brass_aged_02"],
    focus: [0.7, 2.3, 0.2],
  }),
  p({
    objectId: "window_curtain_02",
    variant: "curtain",
    categoryId: "curtain",
    family: "textile",
    zoneId: "front_window",
    position: [-0.65, 0.55, -5.3],
    size: 2.3,
    inspectable: false,
    swatchIds: ["velvet_burgundy_01", "brass_aged_02"],
    focus: [0.7, 2.3, 0.2],
  }),
  p({
    objectId: "window_sign_01",
    variant: "hanging_sign",
    categoryId: "hanging_sign",
    family: "fixture",
    zoneId: "front_window",
    position: [-4.9, 2.75, -4.75],
    swatchIds: ["paint_midnight_02", "brass_aged_02"],
    focus: [0.7, 0.6, 0.1],
  }),
  p({
    objectId: "window_sign_02",
    variant: "hanging_sign",
    categoryId: "hanging_sign",
    family: "fixture",
    zoneId: "front_window",
    position: [-1.9, 2.8, -4.75],
    rotationY: 0.15,
    swatchIds: ["paint_verdigris_03", "brass_tarnished_01"],
    focus: [0.7, 0.6, 0.1],
  }),
  p({
    objectId: "window_chair_01",
    variant: "ladderback_chair",
    categoryId: "chair",
    family: "seat",
    zoneId: "front_window",
    position: [0.9, 0, -4.0],
    rotationY: 2.2,
    swatchIds: ["oak_pale_03", "linen_cream_02"],
    focus: [0.48, 0.98, 0.46],
  }),
  p({
    objectId: "window_box_01",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "front_window",
    position: [2.9, 0, -5.0],
    size: 0.46,
    swatchIds: ["paint_cream_01", "walnut_mid_02"],
    focus: [0.5, 0.24, 0.4],
  }),
  p({
    objectId: "window_box_02",
    inspectable: false,
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "front_window",
    position: [2.9, 0.21, -5.0],
    rotationY: 0.5,
    size: 0.38,
    swatchIds: ["paint_verdigris_03", "walnut_dark_01"],
    focus: [0.42, 0.2, 0.34],
  }),
  p({
    objectId: "window_books_01",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "front_window",
    position: [2.55, 0, -4.25],
    rotationY: 0.3,
    size: 5,
    focus: [0.3, 0.26, 0.24],
  }),
  p({
    objectId: "window_stand_01",
    variant: "display_stand",
    categoryId: "display_stand",
    family: "stand",
    zoneId: "front_window",
    position: [3.4, 0, -4.55],
    size: 0.34,
    swatchIds: ["walnut_dark_01", "velvet_burgundy_01"],
    focus: [0.24, 0.35, 0.24],
  }),
  p({
    objectId: "window_globe_01",
    variant: "globe",
    categoryId: "globe",
    family: "sculpture",
    zoneId: "front_window",
    position: [3.4, 0.35, -4.55],
    swatchIds: ["paper_aged_01", "brass_aged_02"],
    focus: [0.36, 0.56, 0.36],
  }),
  p({
    objectId: "window_frame_01",
    variant: "picture_frame",
    categoryId: "picture_frame",
    family: "frame",
    zoneId: "front_window",
    position: [2.8, 1.9, -5.42],
    size: 0.5,
    swatchIds: ["walnut_dark_01", "slate_grey_02", "brass_aged_02"],
    focus: [0.6, 0.5, 0.1],
  }),
  p({
    objectId: "window_sconce_01",
    variant: "wall_sconce",
    categoryId: "wall_sconce",
    family: "lamp",
    zoneId: "front_window",
    position: [-0.3, 2.1, -5.42],
    swatchIds: ["brass_aged_02"],
    focus: [0.25, 0.35, 0.3],
    practical: { offsetY: 0.12, color: WARM_COOL, intensity: 2.4, distance: 3.4, priority: 4 },
  }),
  p({
    objectId: "window_parcel_01",
    inspectable: false,
    variant: "parcel",
    categoryId: "parcel",
    family: "container",
    zoneId: "front_window",
    position: [2.05, 0, -3.55],
    rotationY: 0.6,
    size: 0.34,
    swatchIds: ["paper_kraft_02", "velvet_burgundy_01"],
    focus: [0.38, 0.2, 0.3],
  }),
  p({
    objectId: "window_books_02",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "front_window",
    position: [1.6, 0, -3.6],
    rotationY: -0.4,
    size: 4,
    focus: [0.3, 0.22, 0.24],
  }),
];

// --------------------------------------------------------- B. Clock Wall

const CLOCK_WALL_CLOCKS: readonly (readonly [number, number, number])[] = [
  [-2.9, 2.15, 0.17],
  [-2.45, 2.7, 0.13],
  [-2.0, 2.05, 0.2],
  [-1.5, 2.6, 0.12],
  [-1.05, 2.2, 0.16],
  [-0.6, 2.75, 0.14],
  [-0.15, 2.1, 0.18],
  [0.35, 2.6, 0.15],
  [0.8, 2.15, 0.13],
  [1.25, 2.7, 0.19],
  [1.7, 2.2, 0.14],
  [2.05, 2.75, 0.16],
];

const CLOCK_WALL_FRAMES: readonly (readonly [number, number])[] = [
  [-2.6, 0.4],
  [-1.8, 0.34],
  [-0.9, 0.46],
  [0.1, 0.36],
  [1.0, 0.42],
  [1.85, 0.3],
];

const CLOCK_WALL: readonly PropPlacement[] = [
  p({
    objectId: "clockwall_longcase_01",
    variant: "longcase_clock",
    categoryId: "longcase_clock",
    family: "frame",
    zoneId: "clock_wall",
    position: [-7.12, 0, 2.02],
    rotationY: WEST,
    hero: true,
    innocentReactionId: "clock_chimes",
    swatchIds: ["walnut_dark_01", "porcelain_cream_01", "brass_tarnished_01"],
    focus: [0.62, 2.5, 0.42],
  }),
  ...CLOCK_WALL_CLOCKS.map((entry, index) =>
    p({
      objectId: `clockwall_clock_${String(index + 1).padStart(2, "0")}`,
      variant: "wall_clock",
      categoryId: "wall_clock",
      family: "frame",
      zoneId: "clock_wall",
      position: [-7.42, entry[1], entry[0]],
      rotationY: WEST,
      size: entry[2],
      innocentReactionId: "clock_chimes",
      // Above 2.4 m or under 0.14 m radius it is background dressing: a Mimic
      // cannot legally root there and the silhouette is too small to read.
      inspectable: entry[1] < 2.4 && entry[2] >= 0.14,
      swatchIds: [
        index % 3 === 0 ? "walnut_dark_01" : index % 3 === 1 ? "brass_aged_02" : "paint_midnight_02",
        "porcelain_cream_01",
        "iron_dark_03",
      ],
      focus: [entry[2] * 2.2, entry[2] * 2.2, 0.14],
    }),
  ),
  ...CLOCK_WALL_FRAMES.map((entry, index) =>
    p({
      objectId: `clockwall_frame_${String(index + 1).padStart(2, "0")}`,
      variant: "picture_frame",
      categoryId: "picture_frame",
      family: "frame",
      zoneId: "clock_wall",
      position: [-7.42, 1.85, entry[0]],
      rotationY: WEST,
      size: entry[1],
      inspectable: entry[1] >= 0.36,
      swatchIds: [
        index % 2 === 0 ? "walnut_dark_01" : "brass_aged_02",
        index % 3 === 0 ? "wool_midnight_03" : index % 3 === 1 ? "slate_grey_02" : "velvet_burgundy_01",
        "brass_aged_02",
      ],
      focus: [entry[1] * 1.2, entry[1], 0.1],
    }),
  ),
  ...[-2.35, -1.05, 0.65, 1.55].map((z, index) =>
    p({
      objectId: `clockwall_sconce_${String(index + 1).padStart(2, "0")}`,
      variant: "wall_sconce",
      categoryId: "wall_sconce",
      family: "lamp",
      zoneId: "clock_wall",
      position: [-7.4, 2.05, z],
      rotationY: WEST,
      inspectable: false,
      swatchIds: ["brass_aged_02"],
      focus: [0.3, 0.35, 0.25],
      ...(index % 2 === 0
        ? { practical: { offsetY: 0.12, color: WARM_COOL, intensity: 2.6, distance: 3.6, priority: 5 } }
        : {}),
    }),
  ),
  ...[-2.6, -0.4, 1.5].map((z, index) =>
    p({
      objectId: `clockwall_wallshelf_${String(index + 1).padStart(2, "0")}`,
      variant: "wall_shelf",
      categoryId: "wall_shelf",
      family: "furniture",
      zoneId: "clock_wall",
      position: [-7.28, 1.35, z],
      rotationY: WEST,
      size: 1.1,
      inspectable: false,
      swatchIds: ["walnut_mid_02", "iron_dark_03"],
      focus: [0.3, 0.2, 1.1],
    }),
  ),
  ...[-2.6, -0.4, 1.5].map((z, index) =>
    p({
      objectId: `clockwall_bookrow_${String(index + 1).padStart(2, "0")}`,
      variant: "book_row",
      categoryId: "book_row",
      family: "book",
      zoneId: "clock_wall",
      position: [-7.28, 1.37, z],
      rotationY: WEST,
      size: 0.9,
      inspectable: false,
      focus: [0.24, 0.3, 0.9],
    }),
  ),
  ...[-2.5, -0.5, 1.4].map((z, index) =>
    p({
      objectId: `clockwall_lowshelf_${String(index + 1).padStart(2, "0")}`,
      variant: "low_shelf",
      categoryId: "low_shelf",
      family: "furniture",
      zoneId: "clock_wall",
      position: [-7.33, 0, z],
      rotationY: WEST,
      size: 1.4,
      hero: index === 1,
      swatchIds: ["walnut_mid_02", "paint_verdigris_03"],
      focus: [0.4, 1.12, 1.4],
    }),
  ),
  p({
    objectId: "clockwall_books_01",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "clock_wall",
    position: [-7.3, 1.12, -2.8],
    rotationY: WEST,
    size: 4,
    focus: [0.3, 0.22, 0.24],
  }),
  p({
    objectId: "clockwall_books_02",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "clock_wall",
    position: [-7.3, 1.12, -0.2],
    rotationY: WEST,
    size: 3,
    focus: [0.3, 0.18, 0.24],
  }),
  p({
    objectId: "clockwall_books_03",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "clock_wall",
    position: [-7.3, 1.12, 1.7],
    rotationY: WEST,
    size: 5,
    focus: [0.3, 0.28, 0.24],
  }),
  p({
    objectId: "clockwall_vase_01",
    variant: "vase_round",
    categoryId: "vase",
    family: "vessel",
    zoneId: "clock_wall",
    position: [-7.3, 1.12, -2.1],
    swatchIds: ["ceramic_celadon_02", "brass_aged_02"],
    focus: [0.28, 0.3, 0.28],
  }),
  p({
    objectId: "clockwall_bottle_01",
    variant: "bottle",
    categoryId: "bottle",
    family: "vessel",
    zoneId: "clock_wall",
    position: [-7.28, 1.12, -0.85],
    swatchIds: ["glass_bottle_02", "copper_patina_04"],
    focus: [0.16, 0.44, 0.16],
  }),
  p({
    objectId: "clockwall_urn_01",
    variant: "urn",
    categoryId: "urn",
    family: "vessel",
    zoneId: "clock_wall",
    position: [-7.3, 1.12, 1.05],
    innocentReactionId: "kettle_whistles",
    swatchIds: ["ceramic_oxblood_03", "brass_tarnished_01"],
    focus: [0.32, 0.38, 0.32],
  }),
  p({
    objectId: "clockwall_mantelclock_01",
    variant: "mantel_clock",
    categoryId: "mantel_clock",
    family: "frame",
    zoneId: "clock_wall",
    position: [-7.3, 1.12, 0.3],
    rotationY: WEST,
    innocentReactionId: "clock_chimes",
    swatchIds: ["walnut_mid_02", "porcelain_cream_01", "brass_aged_02"],
    focus: [0.34, 0.44, 0.22],
  }),
  p({
    objectId: "clockwall_pendant_01",
    variant: "pendant_lamp",
    categoryId: "pendant_lamp",
    family: "lamp",
    zoneId: "clock_wall",
    position: [-6.0, 3.0, -0.6],
    inspectable: false,
    swatchIds: ["brass_tarnished_01"],
    focus: [0.5, 0.7, 0.5],
    practical: { offsetY: -0.09, color: WARM, intensity: 5.5, distance: 5, priority: 8 },
  }),
  p({
    objectId: "clockwall_stool_01",
    variant: "stool",
    categoryId: "stool",
    family: "seat",
    zoneId: "clock_wall",
    position: [-5.6, 0, 1.9],
    rotationY: 0.4,
    size: 0.48,
    swatchIds: ["walnut_mid_02", "iron_dark_03"],
    focus: [0.4, 0.54, 0.4],
  }),
  p({
    objectId: "clockwall_plant_01",
    variant: "plant",
    categoryId: "potted_plant",
    family: "stand",
    zoneId: "clock_wall",
    position: [-5.2, 0, -2.9],
    size: 1.0,
    swatchIds: ["ceramic_celadon_02", "paint_verdigris_03"],
    focus: [0.58, 0.82, 0.58],
  }),
];

// ------------------------------------------------------- E. Cabinet Maze

interface ShelfItem {
  readonly variant: PropVariant;
  readonly categoryId: string;
  readonly family: PropFamily;
  readonly offset: readonly [number, number];
  readonly swatchIds: readonly string[];
  readonly focus: readonly [number, number, number];
  readonly innocentReactionId?: InnocentReactionId;
}

const CABINETS: readonly (readonly [string, number, number, number, boolean])[] = [
  ["cabinet_01", -1.975, -1.525, 2.6, true],
  ["cabinet_02", 1.625, -1.525, 1.9, true],
  ["cabinet_03", -1.975, 0.525, 2.6, true],
  ["cabinet_04", 1.625, 0.525, 1.9, false],
];

/** Contents of each cabinet, offset from the cabinet centre on shelf and x. */
const CABINET_CONTENTS: readonly (readonly ShelfItem[])[] = [
  [
    { variant: "vase_round", categoryId: "vase", family: "vessel", offset: [-0.82, 0.69], swatchIds: ["ceramic_celadon_02"], focus: [0.28, 0.3, 0.28] },
    { variant: "ornament", categoryId: "ornament", family: "sculpture", offset: [-0.38, 0.69], swatchIds: ["brass_tarnished_01", "ceramic_celadon_02"], focus: [0.16, 0.2, 0.16] },
    { variant: "bowl", categoryId: "bowl", family: "vessel", offset: [0.08, 0.69], swatchIds: ["porcelain_cream_01"], focus: [0.3, 0.14, 0.3] },
    { variant: "specimen_jar", categoryId: "specimen_jar", family: "vessel", offset: [0.58, 1.16], swatchIds: ["glass_bottle_02", "copper_patina_04"], focus: [0.18, 0.32, 0.18] },
    { variant: "vase_tall", categoryId: "vase", family: "vessel", offset: [-0.62, 1.16], swatchIds: ["ceramic_oxblood_03"], focus: [0.24, 0.48, 0.24] },
    { variant: "bust", categoryId: "bust", family: "sculpture", offset: [0.92, 1.61], swatchIds: ["marble_cream_01", "slate_grey_02"], focus: [0.3, 0.48, 0.24] },
    { variant: "ornament", categoryId: "ornament", family: "sculpture", offset: [-0.22, 1.61], swatchIds: ["brass_aged_02", "ceramic_oxblood_03"], focus: [0.16, 0.2, 0.16] },
    { variant: "bottle", categoryId: "bottle", family: "vessel", offset: [0.32, 1.61], swatchIds: ["glass_bottle_02", "brass_aged_02"], focus: [0.16, 0.44, 0.16] },
  ],
  [
    { variant: "urn", categoryId: "urn", family: "vessel", offset: [-0.62, 0.69], swatchIds: ["ceramic_oxblood_03"], focus: [0.32, 0.38, 0.32], innocentReactionId: "kettle_whistles" },
    { variant: "vase_round", categoryId: "vase", family: "vessel", offset: [-0.12, 0.69], swatchIds: ["porcelain_cream_01"], focus: [0.28, 0.3, 0.28] },
    { variant: "specimen_jar", categoryId: "specimen_jar", family: "vessel", offset: [0.38, 0.69], swatchIds: ["glass_bottle_02", "copper_patina_04"], focus: [0.18, 0.32, 0.18] },
    { variant: "ornament", categoryId: "ornament", family: "sculpture", offset: [-0.52, 1.16], swatchIds: ["brass_tarnished_01", "ceramic_celadon_02"], focus: [0.16, 0.2, 0.16] },
    { variant: "bowl", categoryId: "bowl", family: "vessel", offset: [-0.02, 1.16], swatchIds: ["ceramic_celadon_02"], focus: [0.3, 0.14, 0.3] },
    { variant: "vase_tall", categoryId: "vase", family: "vessel", offset: [0.48, 1.61], swatchIds: ["ceramic_celadon_02"], focus: [0.24, 0.48, 0.24] },
  ],
  [
    { variant: "teapot", categoryId: "teapot", family: "vessel", offset: [-0.82, 0.69], swatchIds: ["porcelain_cream_01", "brass_aged_02"], focus: [0.3, 0.26, 0.24], innocentReactionId: "kettle_whistles" },
    { variant: "bowl", categoryId: "bowl", family: "vessel", offset: [-0.38, 0.69], swatchIds: ["ceramic_oxblood_03"], focus: [0.3, 0.14, 0.3] },
    { variant: "vase_round", categoryId: "vase", family: "vessel", offset: [0.08, 0.69], swatchIds: ["ceramic_celadon_02"], focus: [0.28, 0.3, 0.28] },
    { variant: "ornament", categoryId: "ornament", family: "sculpture", offset: [0.58, 1.16], swatchIds: ["brass_aged_02", "porcelain_cream_01"], focus: [0.16, 0.2, 0.16] },
    { variant: "bust", categoryId: "bust", family: "sculpture", offset: [0.98, 1.61], swatchIds: ["marble_cream_01", "slate_grey_02"], focus: [0.3, 0.48, 0.24] },
    { variant: "specimen_jar", categoryId: "specimen_jar", family: "vessel", offset: [-0.52, 1.61], swatchIds: ["glass_bottle_02", "copper_patina_04"], focus: [0.18, 0.32, 0.18] },
  ],
  [
    { variant: "vase_tall", categoryId: "vase", family: "vessel", offset: [-0.62, 0.69], swatchIds: ["ceramic_oxblood_03"], focus: [0.24, 0.48, 0.24] },
    { variant: "bottle", categoryId: "bottle", family: "vessel", offset: [-0.17, 0.69], swatchIds: ["glass_bottle_02", "brass_aged_02"], focus: [0.16, 0.44, 0.16] },
    { variant: "ornament", categoryId: "ornament", family: "sculpture", offset: [0.28, 1.16], swatchIds: ["brass_tarnished_01", "ceramic_celadon_02"], focus: [0.16, 0.2, 0.16] },
    { variant: "bowl", categoryId: "bowl", family: "vessel", offset: [0.68, 1.61], swatchIds: ["porcelain_cream_01"], focus: [0.3, 0.14, 0.3] },
  ],
];

function cabinetPlacements(): readonly PropPlacement[] {
  const built: PropPlacement[] = [];

  CABINETS.forEach(([id, x, z, width, hero], cabinetIndex) => {
    built.push(
      p({
        objectId: `maze_${id}`,
        variant: "display_cabinet",
        categoryId: "display_cabinet",
        family: "furniture",
        zoneId: "cabinet_maze",
        position: [x, 0, z],
        size: width,
        hero,
        swatchIds: ["walnut_dark_01", "oak_pale_03"],
        focus: [width + 0.1, 1.95, 0.65],
      }),
    );

    const contents = CABINET_CONTENTS[cabinetIndex] ?? [];
    contents.forEach((item, itemIndex) => {
      built.push(
        p({
          objectId: `maze_${id}_item_${String(itemIndex + 1).padStart(2, "0")}`,
          variant: item.variant,
          categoryId: item.categoryId,
          family: item.family,
          zoneId: "cabinet_maze",
          position: [x + item.offset[0], item.offset[1], z],
          rotationY: (itemIndex % 4) * 0.4,
          // Background stock remains non-targetable so the open shelves add
          // hiding space without flooding the Inspector's target registry.
          inspectable: false,
          swatchIds: item.swatchIds,
          focus: item.focus,
          ...(item.innocentReactionId === undefined ? {} : { innocentReactionId: item.innocentReactionId }),
        }),
      );
    });
  });

  return built;
}

const CABINET_TOPS: readonly PropPlacement[] = [
  p({
    objectId: "maze_top_bust_01",
    inspectable: false,
    variant: "bust",
    categoryId: "bust",
    family: "sculpture",
    zoneId: "cabinet_maze",
    position: [-2.6, 1.95, -1.525],
    rotationY: 0.3,
    swatchIds: ["marble_cream_01", "walnut_dark_01"],
    focus: [0.3, 0.48, 0.24],
  }),
  p({
    objectId: "maze_top_vase_01",
    inspectable: false,
    variant: "vase_tall",
    categoryId: "vase",
    family: "vessel",
    zoneId: "cabinet_maze",
    position: [-1.2, 1.95, -1.525],
    swatchIds: ["ceramic_celadon_02", "brass_aged_02"],
    focus: [0.24, 0.48, 0.24],
  }),
  p({
    objectId: "maze_top_plant_01",
    inspectable: false,
    variant: "plant",
    categoryId: "potted_plant",
    family: "stand",
    zoneId: "cabinet_maze",
    position: [1.3, 1.95, -1.525],
    size: 0.8,
    swatchIds: ["copper_patina_04", "paint_verdigris_03"],
    focus: [0.5, 0.78, 0.5],
  }),
  p({
    objectId: "maze_top_bust_02",
    inspectable: false,
    variant: "bust",
    categoryId: "bust",
    family: "sculpture",
    zoneId: "cabinet_maze",
    position: [-2.4, 1.95, 0.525],
    rotationY: -0.4,
    swatchIds: ["porcelain_cream_01", "slate_grey_02"],
    focus: [0.3, 0.48, 0.24],
  }),
  p({
    objectId: "maze_top_urn_01",
    inspectable: false,
    variant: "urn",
    categoryId: "urn",
    family: "vessel",
    zoneId: "cabinet_maze",
    position: [2.1, 1.95, 0.525],
    innocentReactionId: "kettle_whistles",
    swatchIds: ["ceramic_oxblood_03", "brass_tarnished_01"],
    focus: [0.32, 0.38, 0.32],
  }),
  p({
    objectId: "maze_top_box_01",
    inspectable: false,
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "cabinet_maze",
    position: [0.9, 1.95, -1.525],
    rotationY: 0.25,
    size: 0.42,
    swatchIds: ["paint_cream_01", "walnut_mid_02"],
    focus: [0.46, 0.24, 0.38],
  }),
  p({
    objectId: "maze_top_box_02",
    inspectable: false,
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "cabinet_maze",
    position: [-0.9, 1.95, 0.525],
    size: 0.36,
    swatchIds: ["paper_kraft_02", "walnut_dark_01"],
    focus: [0.4, 0.22, 0.34],
  }),
  p({
    objectId: "maze_top_books_01",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "cabinet_maze",
    position: [0.3, 1.95, 0.525],
    rotationY: 0.2,
    size: 3,
    inspectable: false,
    focus: [0.3, 0.18, 0.24],
  }),
  p({
    objectId: "maze_pendant_01",
    variant: "pendant_lamp",
    categoryId: "pendant_lamp",
    family: "lamp",
    zoneId: "cabinet_maze",
    position: [0, 3.0, -2.4],
    inspectable: false,
    swatchIds: ["brass_tarnished_01"],
    focus: [0.5, 0.7, 0.5],
    practical: { offsetY: -0.09, color: WARM, intensity: 5, distance: 5, priority: 8 },
  }),
  p({
    objectId: "maze_pendant_02",
    variant: "pendant_lamp",
    categoryId: "pendant_lamp",
    family: "lamp",
    zoneId: "cabinet_maze",
    position: [0, 3.0, 0.6],
    inspectable: false,
    swatchIds: ["brass_tarnished_01"],
    focus: [0.5, 0.7, 0.5],
    practical: { offsetY: -0.09, color: WARM, intensity: 5, distance: 5, priority: 8 },
  }),
];

// ------------------------------------------------------ C. Reading Nook

const READING_NOOK: readonly PropPlacement[] = [
  p({
    objectId: "nook_rug_01",
    variant: "rug",
    categoryId: "rug",
    family: "textile",
    zoneId: "reading_nook",
    position: [-5.9, 0.001, 3.9],
    rotationY: 0.15,
    size: 3.4,
    inspectable: false,
    swatchIds: ["wool_midnight_03", "velvet_burgundy_01"],
    focus: [3.4, 0.03, 2.5],
  }),
  p({
    objectId: "nook_armchair_01",
    variant: "armchair",
    categoryId: "armchair",
    family: "seat",
    zoneId: "reading_nook",
    position: [-6.4, 0, 3.5],
    rotationY: 0.65,
    hero: true,
    swatchIds: ["velvet_burgundy_01", "walnut_dark_01"],
    focus: [1.05, 1.15, 1.05],
  }),
  p({
    objectId: "nook_footstool_01",
    variant: "footstool",
    categoryId: "footstool",
    family: "seat",
    zoneId: "reading_nook",
    position: [-5.55, 0, 4.35],
    rotationY: 0.5,
    swatchIds: ["velvet_burgundy_01", "walnut_mid_02"],
    focus: [0.6, 0.36, 0.5],
  }),
  p({
    objectId: "nook_sidetable_01",
    variant: "side_table",
    categoryId: "side_table",
    family: "furniture",
    zoneId: "reading_nook",
    position: [-5.4, 0, 3.5],
    rotationY: -0.3,
    hero: true,
    swatchIds: ["walnut_dark_01", "brass_tarnished_01"],
    focus: [0.7, 0.68, 0.7],
  }),
  p({
    objectId: "nook_table_lamp_01",
    variant: "table_lamp",
    categoryId: "table_lamp",
    family: "lamp",
    zoneId: "reading_nook",
    position: [-5.4, 0.67, 3.5],
    swatchIds: ["brass_aged_02", "ceramic_celadon_02"],
    focus: [0.4, 0.58, 0.4],
    practical: { offsetY: 0.4, color: WARM, intensity: 4.5, distance: 4.2, priority: 9 },
  }),
  p({
    objectId: "nook_books_01",
    inspectable: false,
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "reading_nook",
    position: [-5.58, 0.67, 3.66],
    rotationY: 0.4,
    size: 3,
    focus: [0.3, 0.18, 0.24],
  }),
  p({
    objectId: "nook_teapot_01",
    variant: "teapot",
    categoryId: "teapot",
    family: "vessel",
    zoneId: "reading_nook",
    position: [-5.24, 0.67, 3.36],
    rotationY: -0.5,
    innocentReactionId: "kettle_whistles",
    swatchIds: ["porcelain_cream_01", "brass_aged_02"],
    focus: [0.3, 0.26, 0.24],
  }),
  p({
    objectId: "nook_lowshelf_01",
    variant: "low_shelf",
    categoryId: "low_shelf",
    family: "furniture",
    zoneId: "reading_nook",
    position: [-7.1, 0, 4.85],
    rotationY: WEST,
    size: 1.1,
    swatchIds: ["walnut_mid_02", "velvet_burgundy_01"],
    focus: [0.4, 1.12, 1.1],
  }),
  p({
    objectId: "nook_bookrow_01",
    variant: "book_row",
    categoryId: "book_row",
    family: "book",
    zoneId: "reading_nook",
    position: [-7.1, 1.13, 4.85],
    rotationY: WEST,
    size: 0.9,
    inspectable: false,
    focus: [0.24, 0.3, 0.9],
  }),
  p({
    objectId: "nook_bookrow_02",
    variant: "book_row",
    categoryId: "book_row",
    family: "book",
    zoneId: "reading_nook",
    position: [-7.1, 0.44, 4.85],
    rotationY: WEST,
    size: 0.9,
    inspectable: false,
    focus: [0.24, 0.3, 0.9],
  }),
  p({
    objectId: "nook_books_02",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "reading_nook",
    position: [-7.1, 0.8, 4.6],
    rotationY: WEST,
    size: 4,
    focus: [0.3, 0.22, 0.24],
  }),
  p({
    objectId: "nook_umbrella_stand_01",
    variant: "umbrella_stand",
    categoryId: "umbrella_stand",
    family: "stand",
    zoneId: "reading_nook",
    position: [-4.25, 0, 5.1],
    rotationY: 0.3,
    swatchIds: ["copper_patina_04", "brass_aged_02"],
    focus: [0.42, 1.1, 0.42],
  }),
  p({
    objectId: "nook_floor_lamp_01",
    variant: "floor_lamp",
    categoryId: "floor_lamp",
    family: "lamp",
    zoneId: "reading_nook",
    position: [-6.95, 0, 3.1],
    hero: true,
    swatchIds: ["brass_tarnished_01"],
    focus: [0.6, 1.75, 0.6],
    practical: { offsetY: 1.5, color: WARM, intensity: 6.5, distance: 6, priority: 10 },
  }),
  p({
    objectId: "nook_plant_01",
    variant: "plant",
    categoryId: "potted_plant",
    family: "stand",
    zoneId: "reading_nook",
    position: [-4.6, 0, 4.5],
    size: 1.1,
    swatchIds: ["ceramic_oxblood_03", "paint_verdigris_03"],
    focus: [0.6, 0.84, 0.6],
  }),
  p({
    objectId: "nook_wallshelf_01",
    variant: "wall_shelf",
    categoryId: "wall_shelf",
    family: "furniture",
    zoneId: "reading_nook",
    position: [-2.6, 1.6, 5.42],
    rotationY: SOUTH,
    size: 1.2,
    inspectable: false,
    swatchIds: ["walnut_mid_02", "iron_dark_03"],
    focus: [1.2, 0.2, 0.3],
  }),
  p({
    objectId: "nook_bookrow_03",
    variant: "book_row",
    categoryId: "book_row",
    family: "book",
    zoneId: "reading_nook",
    position: [-2.6, 1.64, 5.42],
    rotationY: SOUTH,
    size: 1.0,
    inspectable: false,
    focus: [1.0, 0.3, 0.24],
  }),
  p({
    objectId: "nook_frame_01",
    variant: "picture_frame",
    categoryId: "picture_frame",
    family: "frame",
    zoneId: "reading_nook",
    position: [-1.2, 1.9, 5.42],
    rotationY: SOUTH,
    size: 0.55,
    swatchIds: ["walnut_dark_01", "wool_midnight_03", "brass_aged_02"],
    focus: [0.66, 0.55, 0.1],
  }),
  p({
    objectId: "nook_frame_02",
    inspectable: false,
    variant: "picture_frame",
    categoryId: "picture_frame",
    family: "frame",
    zoneId: "reading_nook",
    position: [-0.6, 1.75, 5.42],
    rotationY: SOUTH,
    size: 0.35,
    swatchIds: ["brass_aged_02", "velvet_burgundy_01", "brass_tarnished_01"],
    focus: [0.44, 0.35, 0.1],
  }),
  p({
    objectId: "nook_clock_01",
    variant: "wall_clock",
    categoryId: "wall_clock",
    family: "frame",
    zoneId: "reading_nook",
    position: [-3.6, 2.2, 5.42],
    rotationY: SOUTH,
    size: 0.18,
    innocentReactionId: "clock_chimes",
    swatchIds: ["walnut_dark_01", "porcelain_cream_01", "iron_dark_03"],
    focus: [0.4, 0.4, 0.14],
  }),
  p({
    objectId: "nook_books_03",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "reading_nook",
    position: [-3.2, 0, 4.9],
    rotationY: 0.5,
    size: 6,
    focus: [0.32, 0.32, 0.26],
  }),
  p({
    objectId: "nook_books_04",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "reading_nook",
    position: [-3.5, 0, 4.6],
    rotationY: -0.2,
    size: 4,
    focus: [0.3, 0.22, 0.24],
  }),
  p({
    objectId: "nook_candlestick_01",
    inspectable: false,
    variant: "candlestick",
    categoryId: "candlestick",
    family: "lamp",
    zoneId: "reading_nook",
    position: [-7.1, 1.12, 4.35],
    swatchIds: ["brass_tarnished_01", "porcelain_cream_01"],
    focus: [0.16, 0.44, 0.16],
  }),
  p({
    objectId: "nook_box_01",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "reading_nook",
    position: [-4.9, 0, 5.15],
    size: 0.44,
    swatchIds: ["paint_cream_01", "walnut_mid_02"],
    focus: [0.48, 0.24, 0.4],
  }),
  p({
    objectId: "nook_box_02",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "reading_nook",
    position: [-4.9, 0.2, 5.15],
    rotationY: 0.4,
    size: 0.36,
    swatchIds: ["paint_verdigris_03", "walnut_dark_01"],
    focus: [0.4, 0.22, 0.34],
  }),
  p({
    objectId: "nook_stool_01",
    variant: "stool",
    categoryId: "stool",
    family: "seat",
    zoneId: "reading_nook",
    position: [-3.0, 0, 3.4],
    rotationY: 0.2,
    size: 0.5,
    swatchIds: ["oak_pale_03", "iron_dark_03"],
    focus: [0.4, 0.56, 0.4],
  }),
  p({
    objectId: "nook_vase_01",
    variant: "vase_round",
    categoryId: "vase",
    family: "vessel",
    zoneId: "reading_nook",
    position: [-7.1, 1.13, 5.2],
    swatchIds: ["ceramic_celadon_02", "brass_aged_02"],
    focus: [0.28, 0.3, 0.28],
  }),
  p({
    objectId: "nook_mantelclock_01",
    variant: "mantel_clock",
    categoryId: "mantel_clock",
    family: "frame",
    zoneId: "reading_nook",
    position: [-7.1, 1.13, 4.45],
    rotationY: WEST,
    innocentReactionId: "clock_chimes",
    swatchIds: ["walnut_dark_01", "porcelain_cream_01", "brass_tarnished_01"],
    focus: [0.34, 0.44, 0.22],
  }),
  p({
    objectId: "nook_books_05",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "reading_nook",
    position: [-2.9, 0, 3.9],
    rotationY: 0.7,
    size: 3,
    focus: [0.3, 0.18, 0.24],
  }),
  p({
    objectId: "nook_frame_03",
    variant: "picture_frame",
    categoryId: "picture_frame",
    family: "frame",
    zoneId: "reading_nook",
    position: [-7.42, 1.9, 3.4],
    rotationY: WEST,
    size: 0.5,
    swatchIds: ["walnut_dark_01", "velvet_burgundy_01", "brass_aged_02"],
    focus: [0.1, 0.5, 0.6],
  }),
  p({
    objectId: "nook_frame_04",
    variant: "picture_frame",
    categoryId: "picture_frame",
    family: "frame",
    zoneId: "reading_nook",
    position: [-7.42, 1.45, 2.75],
    rotationY: WEST,
    size: 0.34,
    inspectable: false,
    swatchIds: ["brass_aged_02", "slate_grey_02", "brass_tarnished_01"],
    focus: [0.1, 0.34, 0.42],
  }),
  p({
    objectId: "nook_sconce_01",
    variant: "wall_sconce",
    categoryId: "wall_sconce",
    family: "lamp",
    zoneId: "reading_nook",
    position: [-7.4, 2.25, 3.05],
    rotationY: WEST,
    inspectable: false,
    swatchIds: ["brass_aged_02"],
    focus: [0.25, 0.35, 0.3],
    practical: { offsetY: 0.12, color: WARM_COOL, intensity: 2.4, distance: 3.4, priority: 5 },
  }),
];

// ------------------------------------------------ D. Collector's Counter

const COUNTER: readonly PropPlacement[] = [
  p({
    objectId: "counter_desk_01",
    variant: "counter",
    categoryId: "shop_counter",
    family: "furniture",
    zoneId: "collectors_counter",
    position: [2.1, 0, 4.0],
    size: 3.0,
    hero: true,
    swatchIds: ["walnut_dark_01", "marble_cream_01", "brass_tarnished_01"],
    focus: [3.1, 1.08, 0.9],
  }),
  p({
    objectId: "counter_backcabinet_01",
    variant: "back_cabinet",
    categoryId: "drawer_cabinet",
    family: "furniture",
    zoneId: "collectors_counter",
    position: [2.2, 0, 5.2],
    rotationY: SOUTH,
    size: 3.4,
    hero: true,
    swatchIds: ["walnut_dark_01", "oak_pale_03", "brass_tarnished_01"],
    focus: [3.5, 2.15, 0.5],
  }),
  p({
    objectId: "counter_register_01",
    variant: "register",
    categoryId: "register",
    family: "tool",
    zoneId: "collectors_counter",
    position: [1.2, 1.05, 3.95],
    rotationY: 0.2,
    hero: true,
    innocentReactionId: "clock_chimes",
    swatchIds: ["brass_tarnished_01", "bakelite_black_01", "paper_aged_01"],
    focus: [0.5, 0.55, 0.42],
  }),
  p({
    objectId: "counter_bell_01",
    variant: "bell",
    categoryId: "counter_bell",
    family: "tool",
    zoneId: "collectors_counter",
    position: [2.6, 1.05, 3.8],
    innocentReactionId: "clock_chimes",
    swatchIds: ["brass_tarnished_01", "walnut_dark_01"],
    focus: [0.16, 0.1, 0.16],
  }),
  p({
    objectId: "counter_parcel_01",
    variant: "parcel",
    categoryId: "parcel",
    family: "container",
    zoneId: "collectors_counter",
    position: [2.95, 1.05, 4.12],
    rotationY: 0.3,
    size: 0.3,
    swatchIds: ["paper_kraft_02", "velvet_burgundy_01"],
    focus: [0.34, 0.18, 0.28],
  }),
  p({
    objectId: "counter_parcel_02",
    inspectable: false,
    variant: "parcel",
    categoryId: "parcel",
    family: "container",
    zoneId: "collectors_counter",
    position: [3.2, 1.05, 3.88],
    rotationY: -0.4,
    size: 0.26,
    swatchIds: ["paper_aged_01", "wool_midnight_03"],
    focus: [0.3, 0.16, 0.24],
  }),
  p({
    objectId: "counter_parcel_03",
    variant: "parcel",
    categoryId: "parcel",
    family: "container",
    zoneId: "collectors_counter",
    position: [0.85, 1.05, 4.15],
    size: 0.34,
    swatchIds: ["paper_kraft_02", "paint_verdigris_03"],
    focus: [0.38, 0.2, 0.3],
  }),
  p({
    objectId: "counter_parcel_04",
    inspectable: false,
    variant: "parcel",
    categoryId: "parcel",
    family: "container",
    zoneId: "collectors_counter",
    position: [0.85, 1.23, 4.15],
    rotationY: 0.5,
    size: 0.28,
    swatchIds: ["paper_aged_01", "velvet_burgundy_01"],
    focus: [0.32, 0.16, 0.26],
  }),
  p({
    objectId: "counter_tray_01",
    inspectable: false,
    variant: "display_tray",
    categoryId: "display_tray",
    family: "container",
    zoneId: "collectors_counter",
    position: [1.75, 1.05, 4.15],
    rotationY: 0.1,
    swatchIds: ["walnut_mid_02", "velvet_burgundy_01"],
    focus: [0.48, 0.12, 0.34],
  }),
  p({
    objectId: "counter_paperroll_01",
    variant: "paper_roll",
    categoryId: "paper_roll",
    family: "tool",
    zoneId: "collectors_counter",
    position: [4.15, 0, 3.9],
    size: 0.8,
    swatchIds: ["paper_kraft_02", "walnut_mid_02"],
    focus: [0.2, 0.85, 0.2],
  }),
  p({
    objectId: "counter_paperroll_02",
    inspectable: false,
    variant: "paper_roll",
    categoryId: "paper_roll",
    family: "tool",
    zoneId: "collectors_counter",
    position: [4.35, 0, 4.2],
    rotationY: 0.3,
    size: 0.7,
    swatchIds: ["paper_aged_01", "walnut_dark_01"],
    focus: [0.2, 0.75, 0.2],
  }),
  p({
    objectId: "counter_stool_01",
    variant: "stool",
    categoryId: "stool",
    family: "seat",
    zoneId: "collectors_counter",
    position: [1.3, 0, 3.05],
    size: 0.68,
    swatchIds: ["walnut_dark_01", "brass_aged_02"],
    focus: [0.4, 0.74, 0.4],
  }),
  p({
    objectId: "counter_stool_02",
    variant: "stool",
    categoryId: "stool",
    family: "seat",
    zoneId: "collectors_counter",
    position: [2.5, 0, 3.0],
    rotationY: 0.6,
    size: 0.68,
    swatchIds: ["walnut_dark_01", "brass_aged_02"],
    focus: [0.4, 0.74, 0.4],
  }),
  p({
    objectId: "counter_pendant_01",
    variant: "pendant_lamp",
    categoryId: "pendant_lamp",
    family: "lamp",
    zoneId: "collectors_counter",
    position: [2.1, 3.0, 3.9],
    inspectable: false,
    swatchIds: ["brass_tarnished_01"],
    focus: [0.5, 0.7, 0.5],
    practical: { offsetY: -0.09, color: WARM, intensity: 6, distance: 5.5, priority: 9 },
  }),
  p({
    objectId: "counter_table_lamp_01",
    variant: "table_lamp",
    categoryId: "table_lamp",
    family: "lamp",
    zoneId: "collectors_counter",
    position: [3.45, 1.05, 4.25],
    swatchIds: ["brass_aged_02", "ceramic_oxblood_03"],
    focus: [0.4, 0.58, 0.4],
    practical: { offsetY: 0.4, color: WARM, intensity: 3.5, distance: 3.6, priority: 6 },
  }),
  p({
    objectId: "counter_box_01",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "collectors_counter",
    position: [0.9, 2.14, 5.2],
    size: 0.4,
    inspectable: false,
    swatchIds: ["paint_cream_01", "walnut_mid_02"],
    focus: [0.44, 0.24, 0.36],
  }),
  p({
    objectId: "counter_box_02",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "collectors_counter",
    position: [1.5, 2.14, 5.2],
    rotationY: 0.3,
    size: 0.34,
    inspectable: false,
    swatchIds: ["paper_kraft_02", "walnut_dark_01"],
    focus: [0.38, 0.2, 0.32],
  }),
  p({
    objectId: "counter_box_03",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "collectors_counter",
    position: [3.4, 2.14, 5.2],
    size: 0.42,
    inspectable: false,
    swatchIds: ["paint_verdigris_03", "walnut_mid_02"],
    focus: [0.46, 0.24, 0.38],
  }),
  p({
    objectId: "counter_box_04",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "collectors_counter",
    position: [3.9, 2.14, 5.2],
    rotationY: -0.2,
    size: 0.3,
    inspectable: false,
    swatchIds: ["paint_cream_01", "walnut_dark_01"],
    focus: [0.34, 0.18, 0.3],
  }),
  p({
    objectId: "counter_books_01",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "collectors_counter",
    position: [2.9, 2.14, 5.2],
    rotationY: 0.2,
    size: 4,
    inspectable: false,
    focus: [0.3, 0.22, 0.24],
  }),
  p({
    objectId: "counter_vase_01",
    variant: "vase_tall",
    categoryId: "vase",
    family: "vessel",
    zoneId: "collectors_counter",
    position: [2.3, 2.14, 5.2],
    inspectable: false,
    swatchIds: ["ceramic_celadon_02", "brass_aged_02"],
    focus: [0.24, 0.48, 0.24],
  }),
  p({
    objectId: "counter_frame_01",
    variant: "picture_frame",
    categoryId: "picture_frame",
    family: "frame",
    zoneId: "collectors_counter",
    position: [0.2, 1.85, 5.42],
    rotationY: SOUTH,
    size: 0.5,
    swatchIds: ["walnut_dark_01", "slate_grey_02", "brass_aged_02"],
    focus: [0.6, 0.5, 0.1],
  }),
  p({
    objectId: "counter_clock_01",
    variant: "wall_clock",
    categoryId: "wall_clock",
    family: "frame",
    zoneId: "collectors_counter",
    position: [0.9, 2.4, 5.42],
    rotationY: SOUTH,
    size: 0.16,
    innocentReactionId: "clock_chimes",
    inspectable: false,
    swatchIds: ["brass_aged_02", "porcelain_cream_01", "iron_dark_03"],
    focus: [0.36, 0.36, 0.14],
  }),
  p({
    objectId: "counter_mantelclock_01",
    variant: "mantel_clock",
    categoryId: "mantel_clock",
    family: "frame",
    zoneId: "collectors_counter",
    position: [0.6, 1.05, 4.05],
    rotationY: -0.3,
    innocentReactionId: "clock_chimes",
    swatchIds: ["walnut_mid_02", "porcelain_cream_01", "brass_aged_02"],
    focus: [0.34, 0.44, 0.22],
  }),
  p({
    objectId: "counter_plant_01",
    variant: "plant",
    categoryId: "potted_plant",
    family: "stand",
    zoneId: "collectors_counter",
    position: [0.1, 0, 3.0],
    size: 1.0,
    swatchIds: ["ceramic_celadon_02", "paint_verdigris_03"],
    focus: [0.58, 0.82, 0.58],
  }),
  p({
    objectId: "counter_crate_01",
    variant: "crate",
    categoryId: "crate",
    family: "container",
    zoneId: "collectors_counter",
    position: [4.4, 0, 2.7],
    rotationY: 0.4,
    size: 0.6,
    swatchIds: ["oak_pale_03", "iron_dark_03"],
    focus: [0.66, 0.55, 0.66],
  }),
  p({
    objectId: "counter_books_02",
    inspectable: false,
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "collectors_counter",
    position: [1.6, 1.05, 3.85],
    rotationY: -0.3,
    size: 3,
    focus: [0.3, 0.18, 0.24],
  }),
  p({
    objectId: "counter_sign_01",
    variant: "hanging_sign",
    categoryId: "hanging_sign",
    family: "fixture",
    zoneId: "collectors_counter",
    position: [2.1, 2.9, 3.2],
    inspectable: false,
    swatchIds: ["paint_midnight_02", "brass_tarnished_01"],
    focus: [0.7, 0.6, 0.1],
  }),
  p({
    objectId: "counter_bowl_01",
    inspectable: false,
    variant: "bowl",
    categoryId: "bowl",
    family: "vessel",
    zoneId: "collectors_counter",
    position: [3.5, 1.05, 3.82],
    swatchIds: ["porcelain_cream_01", "brass_aged_02"],
    focus: [0.3, 0.14, 0.3],
  }),
];

// ------------------------------------------------------ F. Back Workshop

const WORKSHOP: readonly PropPlacement[] = [
  p({
    objectId: "workshop_bench_01",
    variant: "workbench",
    categoryId: "workbench",
    family: "furniture",
    zoneId: "back_workshop",
    position: [6.8, 0, -0.7],
    rotationY: WEST,
    size: 2.4,
    hero: true,
    swatchIds: ["oak_pale_03", "walnut_mid_02", "iron_dark_03"],
    focus: [1.0, 0.95, 2.5],
  }),
  p({
    objectId: "workshop_shelving_01",
    variant: "shelving_unit",
    categoryId: "shelving_unit",
    family: "furniture",
    zoneId: "back_workshop",
    position: [7.05, 0, -3.6],
    rotationY: WEST,
    size: 2.0,
    hero: true,
    swatchIds: ["iron_dark_03", "oak_pale_03"],
    focus: [0.6, 2.3, 2.1],
  }),
  p({
    objectId: "workshop_ladder_01",
    variant: "ladder",
    categoryId: "ladder",
    family: "tool",
    zoneId: "back_workshop",
    position: [6.45, 0, -3.0],
    rotationY: WEST,
    size: 2.2,
    swatchIds: ["oak_pale_03", "walnut_mid_02"],
    focus: [0.55, 2.25, 0.3],
  }),
  p({
    objectId: "workshop_tasklight_01",
    variant: "task_light",
    categoryId: "task_light",
    family: "lamp",
    zoneId: "back_workshop",
    position: [6.95, 0.92, -1.6],
    rotationY: -1.4,
    swatchIds: ["iron_dark_03"],
    focus: [0.4, 0.85, 0.6],
    practical: { offsetY: 0.7, color: WARM_COOL, intensity: 4, distance: 3.8, priority: 8 },
  }),
  p({
    objectId: "workshop_tasklight_02",
    variant: "task_light",
    categoryId: "task_light",
    family: "lamp",
    zoneId: "back_workshop",
    position: [6.95, 0.92, 0.2],
    rotationY: -1.9,
    swatchIds: ["iron_dark_03"],
    focus: [0.4, 0.85, 0.6],
    practical: { offsetY: 0.7, color: WARM_COOL, intensity: 3.6, distance: 3.4, priority: 7 },
  }),
  p({
    objectId: "workshop_stool_01",
    variant: "stool",
    categoryId: "stool",
    family: "seat",
    zoneId: "back_workshop",
    position: [5.9, 0, -1.2],
    rotationY: 0.3,
    size: 0.6,
    swatchIds: ["oak_pale_03", "iron_dark_03"],
    focus: [0.4, 0.66, 0.4],
  }),
  p({
    objectId: "workshop_stool_02",
    variant: "stool",
    categoryId: "stool",
    family: "seat",
    zoneId: "back_workshop",
    position: [5.85, 0, 0.3],
    rotationY: -0.4,
    size: 0.6,
    swatchIds: ["oak_pale_03", "iron_dark_03"],
    focus: [0.4, 0.66, 0.4],
  }),
  p({
    objectId: "workshop_stool_03",
    variant: "stool",
    categoryId: "stool",
    family: "seat",
    zoneId: "back_workshop",
    position: [4.6, 0, -2.4],
    size: 0.48,
    swatchIds: ["walnut_mid_02", "iron_dark_03"],
    focus: [0.4, 0.54, 0.4],
  }),
  p({
    objectId: "workshop_crate_01",
    variant: "crate",
    categoryId: "crate",
    family: "container",
    zoneId: "back_workshop",
    position: [4.5, 0, 1.35],
    size: 0.62,
    swatchIds: ["oak_pale_03", "iron_dark_03"],
    focus: [0.68, 0.56, 0.68],
  }),
  p({
    objectId: "workshop_crate_02",
    variant: "crate",
    categoryId: "crate",
    family: "container",
    zoneId: "back_workshop",
    position: [4.5, 0.54, 1.35],
    rotationY: 0.4,
    size: 0.48,
    swatchIds: ["walnut_mid_02", "iron_dark_03"],
    focus: [0.54, 0.44, 0.54],
  }),
  p({
    objectId: "workshop_crate_03",
    variant: "crate",
    categoryId: "crate",
    family: "container",
    zoneId: "back_workshop",
    position: [4.9, 0, 1.85],
    rotationY: -0.3,
    size: 0.55,
    swatchIds: ["oak_pale_03", "iron_dark_03"],
    focus: [0.6, 0.5, 0.6],
  }),
  p({
    objectId: "workshop_fabricroll_01",
    variant: "fabric_roll",
    categoryId: "fabric_roll",
    family: "tool",
    zoneId: "back_workshop",
    position: [7.2, 0, 1.4],
    rotationY: 0.1,
    size: 0.9,
    swatchIds: ["velvet_burgundy_01", "walnut_mid_02"],
    focus: [0.24, 0.95, 0.24],
  }),
  p({
    objectId: "workshop_fabricroll_02",
    inspectable: false,
    variant: "fabric_roll",
    categoryId: "fabric_roll",
    family: "tool",
    zoneId: "back_workshop",
    position: [7.05, 0, 1.62],
    size: 0.8,
    swatchIds: ["wool_midnight_03", "walnut_mid_02"],
    focus: [0.24, 0.85, 0.24],
  }),
  p({
    objectId: "workshop_fabricroll_03",
    variant: "fabric_roll",
    categoryId: "fabric_roll",
    family: "tool",
    zoneId: "back_workshop",
    position: [6.85, 0, 1.78],
    rotationY: -0.2,
    size: 1.0,
    swatchIds: ["linen_cream_02", "walnut_dark_01"],
    focus: [0.24, 1.05, 0.24],
  }),
  p({
    objectId: "workshop_tool_01",
    inspectable: false,
    variant: "hand_tool",
    categoryId: "hand_tool",
    family: "tool",
    zoneId: "back_workshop",
    position: [6.9, 0.93, -1.4],
    rotationY: 0.5,
    swatchIds: ["iron_dark_03", "oak_pale_03"],
    focus: [0.42, 0.08, 0.14],
  }),
  p({
    objectId: "workshop_tool_02",
    inspectable: false,
    variant: "hand_tool",
    categoryId: "hand_tool",
    family: "tool",
    zoneId: "back_workshop",
    position: [6.75, 0.93, -0.9],
    rotationY: -0.3,
    swatchIds: ["brass_aged_02", "walnut_mid_02"],
    focus: [0.42, 0.08, 0.14],
  }),
  p({
    objectId: "workshop_tool_03",
    inspectable: false,
    variant: "hand_tool",
    categoryId: "hand_tool",
    family: "tool",
    zoneId: "back_workshop",
    position: [6.9, 0.93, 0.1],
    rotationY: 1.2,
    swatchIds: ["iron_dark_03", "walnut_dark_01"],
    focus: [0.42, 0.08, 0.14],
  }),
  p({
    objectId: "workshop_clamp_01",
    inspectable: false,
    variant: "clamp",
    categoryId: "clamp",
    family: "tool",
    zoneId: "back_workshop",
    position: [6.6, 0.93, -0.3],
    rotationY: 0.8,
    swatchIds: ["iron_dark_03", "oak_pale_03"],
    focus: [0.36, 0.2, 0.12],
  }),
  p({
    objectId: "workshop_clamp_02",
    inspectable: false,
    variant: "clamp",
    categoryId: "clamp",
    family: "tool",
    zoneId: "back_workshop",
    position: [6.55, 0.93, 0.35],
    rotationY: -0.5,
    swatchIds: ["brass_aged_02", "oak_pale_03"],
    focus: [0.36, 0.2, 0.12],
  }),
  p({
    objectId: "workshop_kettle_01",
    variant: "kettle",
    categoryId: "kettle",
    family: "vessel",
    zoneId: "back_workshop",
    position: [7.05, 0.86, -3.2],
    innocentReactionId: "kettle_whistles",
    swatchIds: ["copper_patina_04", "brass_tarnished_01"],
    focus: [0.28, 0.28, 0.24],
  }),
  p({
    objectId: "workshop_box_01",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "back_workshop",
    position: [7.05, 0.28, -4.2],
    size: 0.42,
    swatchIds: ["paint_cream_01", "walnut_mid_02"],
    focus: [0.46, 0.24, 0.38],
  }),
  p({
    objectId: "workshop_box_02",
    inspectable: false,
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "back_workshop",
    position: [7.05, 0.28, -3.5],
    rotationY: 0.3,
    size: 0.38,
    swatchIds: ["paper_kraft_02", "walnut_dark_01"],
    focus: [0.42, 0.22, 0.34],
  }),
  p({
    objectId: "workshop_box_03",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "back_workshop",
    position: [7.05, 0.86, -4.3],
    size: 0.34,
    inspectable: false,
    swatchIds: ["paint_verdigris_03", "walnut_mid_02"],
    focus: [0.38, 0.2, 0.32],
  }),
  p({
    objectId: "workshop_box_04",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "back_workshop",
    position: [7.05, 1.44, -3.9],
    size: 0.4,
    inspectable: false,
    swatchIds: ["paint_cream_01", "walnut_dark_01"],
    focus: [0.44, 0.24, 0.36],
  }),
  p({
    objectId: "workshop_books_01",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "back_workshop",
    position: [7.05, 1.44, -3.2],
    rotationY: 0.4,
    size: 3,
    inspectable: false,
    focus: [0.3, 0.18, 0.24],
  }),
  p({
    objectId: "workshop_bottle_01",
    variant: "bottle",
    categoryId: "bottle",
    family: "vessel",
    zoneId: "back_workshop",
    position: [7.05, 2.02, -3.6],
    inspectable: false,
    swatchIds: ["glass_bottle_02", "copper_patina_04"],
    focus: [0.16, 0.44, 0.16],
  }),
  p({
    objectId: "workshop_paperroll_01",
    variant: "paper_roll",
    categoryId: "paper_roll",
    family: "tool",
    zoneId: "back_workshop",
    position: [5.2, 0, -4.6],
    rotationY: 0.2,
    size: 0.85,
    swatchIds: ["paper_kraft_02", "walnut_mid_02"],
    focus: [0.2, 0.9, 0.2],
  }),
  p({
    objectId: "workshop_plant_01",
    variant: "plant",
    categoryId: "potted_plant",
    family: "stand",
    zoneId: "back_workshop",
    position: [4.3, 0, -4.9],
    size: 0.85,
    swatchIds: ["copper_patina_04", "paint_verdigris_03"],
    focus: [0.52, 0.78, 0.52],
  }),
  p({
    objectId: "workshop_pendant_01",
    variant: "pendant_lamp",
    categoryId: "pendant_lamp",
    family: "lamp",
    zoneId: "back_workshop",
    position: [5.5, 3.0, -3.0],
    inspectable: false,
    swatchIds: ["iron_dark_03"],
    focus: [0.5, 0.7, 0.5],
    practical: { offsetY: -0.09, color: WARM, intensity: 4.5, distance: 4.5, priority: 6 },
  }),
  p({
    objectId: "workshop_sconce_01",
    variant: "wall_sconce",
    categoryId: "wall_sconce",
    family: "lamp",
    zoneId: "back_workshop",
    position: [7.42, 2.1, 0.9],
    rotationY: EAST,
    inspectable: false,
    swatchIds: ["brass_aged_02"],
    focus: [0.3, 0.35, 0.25],
  }),
  p({
    objectId: "workshop_frame_01",
    variant: "picture_frame",
    categoryId: "picture_frame",
    family: "frame",
    zoneId: "back_workshop",
    position: [7.42, 1.7, -1.2],
    rotationY: EAST,
    size: 0.4,
    swatchIds: ["walnut_mid_02", "slate_grey_02", "brass_aged_02"],
    focus: [0.5, 0.4, 0.1],
  }),
  p({
    objectId: "workshop_clock_01",
    variant: "wall_clock",
    categoryId: "wall_clock",
    family: "frame",
    zoneId: "back_workshop",
    position: [7.42, 2.3, -2.2],
    rotationY: EAST,
    size: 0.15,
    innocentReactionId: "clock_chimes",
    inspectable: false,
    swatchIds: ["iron_dark_03", "porcelain_cream_01", "iron_dark_03"],
    focus: [0.34, 0.34, 0.14],
  }),
  p({
    objectId: "workshop_crate_04",
    variant: "crate",
    categoryId: "crate",
    family: "container",
    zoneId: "back_workshop",
    position: [5.6, 0, -4.8],
    rotationY: -0.2,
    size: 0.68,
    swatchIds: ["oak_pale_03", "iron_dark_03"],
    focus: [0.74, 0.62, 0.74],
  }),
  p({
    objectId: "workshop_box_05",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "back_workshop",
    position: [5.6, 0.6, -4.8],
    rotationY: 0.35,
    size: 0.44,
    swatchIds: ["paint_cream_01", "walnut_mid_02"],
    focus: [0.48, 0.24, 0.4],
  }),
  p({
    objectId: "workshop_tray_01",
    inspectable: false,
    variant: "display_tray",
    categoryId: "display_tray",
    family: "container",
    zoneId: "back_workshop",
    position: [6.7, 0.93, -0.4],
    rotationY: 1.4,
    swatchIds: ["walnut_mid_02", "linen_cream_02"],
    focus: [0.48, 0.12, 0.34],
  }),
  p({
    objectId: "workshop_books_02",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "back_workshop",
    position: [5.3, 0, 1.9],
    rotationY: -0.4,
    size: 3,
    focus: [0.3, 0.18, 0.24],
  }),
  p({
    objectId: "workshop_books_03",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "back_workshop",
    position: [7.05, 0.86, -3.9],
    rotationY: -0.3,
    size: 3,
    inspectable: false,
    focus: [0.3, 0.18, 0.24],
  }),
];

// ------------------------------------------------------ G. Security Office

const SECURITY_OFFICE: readonly PropPlacement[] = [
  p({
    objectId: "office_desk_01",
    variant: "monitor_desk",
    categoryId: "monitor_desk",
    family: "furniture",
    zoneId: "security_office",
    position: [6.9, 0, 3.7],
    rotationY: EAST,
    hero: true,
    inspectable: false,
    swatchIds: ["slate_grey_02", "bakelite_black_01", "iron_dark_03"],
    focus: [0.8, 1.2, 1.6],
  }),
  p({
    objectId: "office_stool_01",
    variant: "stool",
    categoryId: "stool",
    family: "seat",
    zoneId: "security_office",
    position: [6.1, 0, 3.7],
    size: 0.55,
    inspectable: false,
    swatchIds: ["bakelite_black_01", "iron_dark_03"],
    focus: [0.4, 0.6, 0.4],
  }),
  p({
    objectId: "office_indicator_01",
    variant: "indicator_light",
    categoryId: "indicator_light",
    family: "fixture",
    zoneId: "security_office",
    position: [4.9, 2.6, 3.6],
    inspectable: false,
    swatchIds: ["iron_dark_03"],
    focus: [0.1, 0.12, 0.1],
  }),
  p({
    objectId: "office_box_01",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "security_office",
    position: [5.3, 0, 5.1],
    size: 0.45,
    inspectable: false,
    swatchIds: ["paint_cream_01", "slate_grey_02"],
    focus: [0.5, 0.24, 0.4],
  }),
  p({
    objectId: "office_box_02",
    variant: "storage_box",
    categoryId: "storage_box",
    family: "container",
    zoneId: "security_office",
    position: [5.3, 0.2, 5.1],
    rotationY: 0.4,
    size: 0.38,
    inspectable: false,
    swatchIds: ["paper_kraft_02", "slate_grey_02"],
    focus: [0.42, 0.22, 0.34],
  }),
  p({
    objectId: "office_books_01",
    variant: "book_stack",
    categoryId: "book_stack",
    family: "book",
    zoneId: "security_office",
    position: [6.9, 0.79, 3.2],
    rotationY: 0.3,
    size: 3,
    inspectable: false,
    focus: [0.3, 0.18, 0.24],
  }),
  p({
    objectId: "office_clock_01",
    variant: "wall_clock",
    categoryId: "wall_clock",
    family: "frame",
    zoneId: "security_office",
    position: [7.42, 2.2, 4.8],
    rotationY: EAST,
    size: 0.14,
    innocentReactionId: "clock_chimes",
    inspectable: false,
    swatchIds: ["bakelite_black_01", "porcelain_cream_01", "iron_dark_03"],
    focus: [0.32, 0.32, 0.14],
  }),
  p({
    objectId: "office_plant_01",
    variant: "plant",
    categoryId: "potted_plant",
    family: "stand",
    zoneId: "security_office",
    position: [5.2, 0, 2.6],
    size: 0.8,
    inspectable: false,
    swatchIds: ["slate_grey_02", "paint_verdigris_03"],
    focus: [0.5, 0.76, 0.5],
  }),
  p({
    objectId: "office_pendant_01",
    variant: "pendant_lamp",
    categoryId: "pendant_lamp",
    family: "lamp",
    zoneId: "security_office",
    position: [6.2, 3.0, 3.7],
    inspectable: false,
    swatchIds: ["iron_dark_03"],
    focus: [0.5, 0.7, 0.5],
    // The Security Office holds the Inspectors for the whole Forge phase, so
    // it keeps its light on every tier (§5.7).
    practical: { offsetY: -0.09, color: WARM_COOL, intensity: 4.5, distance: 4.5, priority: 11 },
  }),
  p({
    objectId: "office_kettle_01",
    variant: "kettle",
    categoryId: "kettle",
    family: "vessel",
    zoneId: "security_office",
    position: [6.9, 0.79, 4.2],
    innocentReactionId: "kettle_whistles",
    inspectable: false,
    swatchIds: ["porcelain_cream_01", "brass_aged_02"],
    focus: [0.28, 0.28, 0.24],
  }),
];

// -------------------------------------------------- Hoppable floor clutter

/**
 * Ankle-height clutter on the shop floor: two-book stacks, a small packing
 * crate, a shallow storage box. Every piece stands taller than the 0.07 m lip a
 * walk crosses and lower than a hop's reach, so this is the one thing in the
 * room the jump is a route past rather than only a flourish. Before it, the
 * lowest blocker in the Curiosity Shop was the 0.26 m bottom board of the steel
 * rack and no hop cleared anything at all.
 *
 * The pieces are deliberately not accusable. A Mimic is 0.35 m tall and these
 * are a third of that, so nothing could be hiding in one, and publishing them
 * to the registry would only spend an Inspector's warrants on targets that can
 * never be a player. `obstacle: true` is what keeps them drawn anyway.
 *
 * The Cabinet Maze gets none. Its floor is the circular route and the two
 * crossings almost end to end, and the navigation contract keeps those clear
 * for two Inspectors abreast.
 */
interface HopClutterInput {
  readonly objectId: string;
  readonly variant: Extract<PropVariant, "book_stack" | "crate" | "storage_box">;
  readonly zoneId: ZoneId;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly size: number;
  readonly focus: readonly [number, number, number];
}

function hopClutter(input: HopClutterInput): PropPlacement {
  const family: PropFamily = input.variant === "book_stack" ? "book" : "container";
  return p({
    objectId: input.objectId,
    variant: input.variant,
    categoryId: input.variant,
    family,
    zoneId: input.zoneId,
    position: input.position,
    rotationY: input.rotationY,
    size: input.size,
    swatchIds:
      input.variant === "crate"
        ? ["oak_pale_03", "iron_dark_03"]
        : input.variant === "storage_box"
          ? ["paint_cream_01", "walnut_mid_02"]
          : ["velvet_burgundy_01", "wool_midnight_03"],
    inspectable: false,
    focus: input.focus,
    obstacle: true,
  });
}

/**
 * Heights are the top of the geometry the builder actually makes, quoted so a
 * comment naming one is a claim that can be checked: a two-book stack is
 * 0.055 + 0.044 m of covers, a 0.16 m crate is 0.66 of its edge plus half a
 * 0.07 m board, and a 0.24 m storage box is 0.42 of its width plus the lid.
 */
const HOP_CLUTTER: readonly PropPlacement[] = [
  // A — the window bay, on the boards in front of the display deck.
  hopClutter({
    objectId: "window_clutter_books_01",
    variant: "book_stack",
    zoneId: "front_window",
    position: [-4.3, 0, -3.9],
    rotationY: 0.4,
    size: 2,
    focus: [0.3, 0.1, 0.25],
  }),
  hopClutter({
    objectId: "window_clutter_crate_01",
    variant: "crate",
    zoneId: "front_window",
    position: [-2.2, 0, -4.3],
    rotationY: -0.25,
    size: 0.16,
    focus: [0.19, 0.15, 0.19],
  }),
  hopClutter({
    objectId: "window_clutter_box_01",
    variant: "storage_box",
    zoneId: "front_window",
    position: [2.2, 0, -3.6],
    rotationY: 0.15,
    size: 0.24,
    focus: [0.27, 0.15, 0.22],
  }),

  // B — the clock wall, along the run under the bookcases.
  hopClutter({
    objectId: "clockwall_clutter_books_01",
    variant: "book_stack",
    zoneId: "clock_wall",
    position: [-6.6, 0, -2.0],
    rotationY: -0.2,
    size: 2,
    focus: [0.3, 0.1, 0.25],
  }),
  hopClutter({
    objectId: "clockwall_clutter_books_02",
    variant: "book_stack",
    zoneId: "clock_wall",
    position: [-5.2, 0, -0.9],
    rotationY: 0.55,
    size: 2,
    focus: [0.3, 0.1, 0.25],
  }),
  hopClutter({
    objectId: "clockwall_clutter_box_01",
    variant: "storage_box",
    zoneId: "clock_wall",
    position: [-6.3, 0, 0.9],
    rotationY: -0.35,
    size: 0.24,
    focus: [0.27, 0.15, 0.22],
  }),

  // C — the reading nook, between the armchair and the way in.
  hopClutter({
    objectId: "nook_clutter_books_01",
    variant: "book_stack",
    zoneId: "reading_nook",
    position: [-2.0, 0, 4.4],
    rotationY: 0.3,
    size: 2,
    focus: [0.3, 0.1, 0.25],
  }),
  hopClutter({
    objectId: "nook_clutter_crate_01",
    variant: "crate",
    zoneId: "reading_nook",
    position: [-4.9, 0, 2.7],
    rotationY: 0.2,
    size: 0.16,
    focus: [0.19, 0.15, 0.19],
  }),
  hopClutter({
    objectId: "nook_clutter_books_02",
    variant: "book_stack",
    zoneId: "reading_nook",
    position: [-6.5, 0, 2.6],
    rotationY: -0.5,
    size: 2,
    focus: [0.3, 0.1, 0.25],
  }),

  // D — the counter, on the customer side and behind it.
  hopClutter({
    objectId: "counter_clutter_books_01",
    variant: "book_stack",
    zoneId: "collectors_counter",
    position: [0.3, 0, 2.7],
    rotationY: 0.45,
    size: 2,
    focus: [0.3, 0.1, 0.25],
  }),
  hopClutter({
    objectId: "counter_clutter_crate_01",
    variant: "crate",
    zoneId: "collectors_counter",
    position: [3.4, 0, 4.75],
    rotationY: -0.4,
    size: 0.16,
    focus: [0.19, 0.15, 0.19],
  }),
  hopClutter({
    objectId: "counter_clutter_box_01",
    variant: "storage_box",
    zoneId: "collectors_counter",
    position: [0.6, 0, 4.7],
    rotationY: 0.1,
    size: 0.24,
    focus: [0.27, 0.15, 0.22],
  }),

  // F — the back workshop, where a shop this untidy would really keep it.
  hopClutter({
    objectId: "workshop_clutter_crate_01",
    variant: "crate",
    zoneId: "back_workshop",
    position: [4.4, 0, -0.9],
    rotationY: 0.3,
    size: 0.16,
    focus: [0.19, 0.15, 0.19],
  }),
  hopClutter({
    objectId: "workshop_clutter_box_01",
    variant: "storage_box",
    zoneId: "back_workshop",
    position: [6.3, 0, 1.3],
    rotationY: -0.2,
    size: 0.24,
    focus: [0.27, 0.15, 0.22],
  }),
  hopClutter({
    objectId: "workshop_clutter_books_01",
    variant: "book_stack",
    zoneId: "back_workshop",
    position: [4.9, 0, -3.9],
    rotationY: -0.6,
    size: 2,
    focus: [0.3, 0.1, 0.25],
  }),
];

/** The clutter of one zone, in the authored order, for splicing into its run. */
function hopClutterIn(zoneId: ZoneId): readonly PropPlacement[] {
  return HOP_CLUTTER.filter((placement) => placement.zoneId === zoneId);
}

export const SHOP_PLACEMENTS: readonly PropPlacement[] = [
  ...FRONT_WINDOW,
  ...hopClutterIn("front_window"),
  ...CLOCK_WALL,
  ...hopClutterIn("clock_wall"),
  ...cabinetPlacements(),
  ...CABINET_TOPS,
  ...READING_NOOK,
  ...hopClutterIn("reading_nook"),
  ...COUNTER,
  ...hopClutterIn("collectors_counter"),
  ...WORKSHOP,
  ...hopClutterIn("back_workshop"),
  ...SECURITY_OFFICE,
];

/** Props that light the room, strongest first. */
export const PRACTICAL_PLACEMENTS: readonly PropPlacement[] = SHOP_PLACEMENTS.filter(
  (placement) => placement.practical !== undefined,
).sort((a, b) => (b.practical?.priority ?? 0) - (a.practical?.priority ?? 0));

export function countByFamily(placements: readonly PropPlacement[] = SHOP_PLACEMENTS): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const placement of placements) {
    counts[placement.family] = (counts[placement.family] ?? 0) + 1;
  }
  return counts;
}
