import type {
  AABB,
  ClimbLink,
  NavData,
  SpawnPoints,
  SpawnPose,
  WalkableSurface,
} from "./navData";
import { WORLD_SCALE } from "./navData";
import { focusBoundsFor } from "./objects";
import { SHOP_PLACEMENTS, type PropPlacement } from "./placements";
import {
  CABINET_BLOCKS,
  DOOR_HEIGHT,
  DOOR_MAX_X,
  DOOR_MIN_X,
  FLOOR_PLAN,
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
} from "./zones";

/**
 * Navigation for The Curiosity Shop at its true scale: the shop keeps real
 * furniture dimensions and the player is 0.35 m tall, so a counter is a
 * two-storey climb and the space under a workbench is a hall.
 *
 * That changes what navigation data has to say. A human-scale proxy could treat
 * a table as one solid box from the floor to its top; here the top is a floor of
 * its own, the underside is a ceiling, and the legs are the only obstruction.
 * Every surface below is therefore an authored ledge on a prop that actually
 * exists in `placements.ts`, and every blocker spans only the height its prop
 * really occupies.
 *
 * Heights are quoted from the prop builders in `props/furniture.ts`, so a
 * comment naming a prop is a claim that can be checked against its builder.
 *
 * Two authoring conventions make the data usable rather than merely accurate:
 *
 * 1. A blocker that supports a walkable ledge tops out at exactly that ledge.
 *    `blocksCapsule` ignores any blocker no taller than the walker's feet plus
 *    a step, so a prop blocks approach from the floor and then stops blocking
 *    the moment the player is standing on it.
 * 2. A ledge against a wall is widened to `MIN_LEDGE_DEPTH`, because several
 *    shelves are shallower than the player is wide. The visual slab is
 *    unchanged; only the volume the controller resolves against is generous.
 */

/** Narrowest ledge a player can stand on, slightly over the body diameter. */
export const MIN_LEDGE_DEPTH = 0.28;

/**
 * Tallest rise authored as a vault rather than a climb. The Mimic body is
 * articulated and extends as it folds, so it commits to a hop of roughly twice
 * its standing height; anything above that is a ladder the player rides.
 */
export const MAX_MANTLE_RISE = 0.75;

/** Tallest rise authored as a ladder. Above this the route needs a landing. */
export const MAX_LADDER_RISE = 2.4;

function aabb(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): AABB {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/**
 * A standable ledge given by its footprint and the height of its top face. The
 * box is given a little thickness downward so it reads as a slab rather than as
 * a zero-height plane.
 */
function ledge(
  id: string,
  topY: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  level: number,
  clearance?: number,
): WalkableSurface {
  const bounds = aabb(minX, topY - 0.02, minZ, maxX, topY, maxZ);
  return clearance === undefined ? { id, bounds, level } : { id, bounds, level, clearance };
}

/** Square ledge centred on a prop origin, for round and small-footprint props. */
function pad(
  id: string,
  topY: number,
  x: number,
  z: number,
  halfExtent: number,
  level: number,
): WalkableSurface {
  return ledge(id, topY, x - halfExtent, z - halfExtent, x + halfExtent, z + halfExtent, level);
}

// ---------------------------------------------------------------------------
// Level 0: the sales floor, the Security Office, and the spaces under furniture
// ---------------------------------------------------------------------------

/** The shop floor, taken straight from the floorplan boxes in `zones.ts`. */
const FLOOR_SURFACES: readonly WalkableSurface[] = FLOOR_PLAN.map((box, index) =>
  ledge(`floor_${String(index).padStart(2, "0")}`, 0, box.min.x, box.min.z, box.max.x, box.max.z, 0),
);

/**
 * The Inspector's entry room (§5.9). It is walkable so the Inspector can be
 * staged inside it before the door opens; Mimic spawns are kept out of it by
 * the spawn table rather than by removing the floor.
 *
 * Its west edge crosses the partition line rather than stopping short of it.
 * The sales floor ends at `OFFICE_MIN_X` and this room used to begin a tenth of
 * a metre east of that, so a strip the width of the doorway had nothing
 * published underneath: `surfaceAt` answers null there, a step onto null is
 * refused as walking off the map, and the Inspector's one route out of the room
 * they are staged in ran straight through it. The role spent whole hunts walking
 * into a doorway it could not cross. Overlapping the two floors is what closes
 * it; the partition's own blockers still stop a body anywhere but the doorway.
 */
const OFFICE_FLOOR = ledge(
  "floor_office",
  0,
  OFFICE_MIN_X - 0.05,
  OFFICE_MIN_Z + 0.1,
  SHOP_MAX_X - 0.28,
  SHOP_MAX_Z - 0.28,
  0,
);

/**
 * Headroom under the legged furniture. At this scale these are rooms, not gaps,
 * and the two low ones are quoted so `fitsUnder` refuses them rather than
 * letting a player walk into a solid prop.
 */
const CRAWL_SURFACES: readonly WalkableSurface[] = [
  // Workbench top slab underside sits at 0.836; the four legs are the only
  // obstruction, so the whole bay under the bench is open.
  ledge("crawl_workbench", 0, 6.38, -1.85, 7.22, 0.45, 0, 0.836),
  // Office desk top underside at 0.72.
  ledge("crawl_office_desk", 0, 6.57, 2.97, 7.23, 4.43, 0, 0.72),
  // Ladderback chair in the window: seat underside at 0.448.
  ledge("crawl_window_chair", 0, 0.72, -4.18, 1.08, -3.82, 0, 0.448),
  // Steel shelving: the bottom board underside is 0.22, below the 0.35 body,
  // so the rack cannot be walked into at floor level.
  ledge("crawl_shelving", 0, 6.8, -4.57, 7.3, -2.63, 0, 0.22),
  // Armchair skirt underside at 0.23. Also too low to enter.
  ledge("crawl_armchair", 0, -6.85, 3.06, -5.95, 3.94, 0, 0.23),
];

// ---------------------------------------------------------------------------
// Elevated ledges, by zone. Every entry names the prop it stands on.
// ---------------------------------------------------------------------------

/** Zone A, the front window. The display deck is the map's largest mezzanine. */
const ZONE_A_LEDGES: readonly WalkableSurface[] = [
  // shop.displayPlatform: 0.34 deck across the whole window bay.
  ledge("window_platform", 0.34, WINDOW_MIN_X, -5.4, WINDOW_MAX_X, -4.5, 1),
  // shop.window sill slab, top face at WINDOW_SILL_Y.
  ledge("window_sill", WINDOW_SILL_Y, WINDOW_MIN_X - 0.1, -5.5, WINDOW_MAX_X + 0.1, -5.22, 1),
  // window_chair_01 ladderback seat pad, top at 0.528.
  pad("window_chair_seat", 0.528, 0.9, -4.0, 0.16, 1),
  // window_plinth_01, size 0.55 quantized to 0.6, standing on the 0.34 deck.
  pad("window_plinth_low", 0.94, -3.45, -5.0, 0.15, 2),
  // window_plinth_03, size 0.45 quantized to 0.5.
  pad("window_plinth_mid", 0.84, -1.2, -4.55, 0.15, 2),
  // window_plinth_02, size 0.8, the tallest of the three.
  pad("window_plinth_high", 1.14, -1.5, -4.95, 0.15, 3),
];

/**
 * Zone B, the clock wall. Three open bookcases stand under three wall shelves,
 * which makes the west wall a two-stage climb the whole length of the zone.
 */
const CLOCK_WALL_SHELF_Z: readonly (readonly [string, number, number])[] = [
  ["01", -2.5, -2.6],
  ["02", -0.5, -0.4],
  ["03", 1.4, 1.5],
];

const ZONE_B_LEDGES: readonly WalkableSurface[] = [
  // clockwall_stool_01, seat height 0.48 plus the 0.047 lathe.
  pad("clockwall_stool_seat", 0.527, -5.6, 1.9, 0.14, 1),
  // The three low bookcases are shallow against the west wall, so their
  // navigation tops extend east by one body radius just like the nook shelf.
  // This gives the capsule somewhere honest to finish a climb without moving
  // the visible furniture or standing its centre inside the plaster.
  ...CLOCK_WALL_SHELF_Z.map(([id, lowZ]) =>
    ledge(`clockwall_lowshelf_${id}`, 1.12, -7.27, lowZ - 0.7, -6.93, lowZ + 0.7, 2),
  ),
];

/**
 * The wall shelves above the low bookcases remain decorative. They are hung
 * high enough to leave a full player body above the climbable case tops.
 */

/** Zone C, the reading nook. Footstool to armchair to side table. */
const ZONE_C_LEDGES: readonly WalkableSurface[] = [
  // nook_footstool_01: top block centred at 0.265, 0.17 thick.
  ledge("nook_footstool", 0.35, -5.79, 4.16, -5.31, 4.54, 1),
  // nook_armchair_01 seat cushion, 0.2 thick centred at 0.51.
  ledge("nook_armchair_seat", 0.61, -6.76, 3.15, -6.04, 3.85, 1),
  // nook_sidetable_01 lathe top face at 0.67.
  pad("nook_sidetable_top", 0.67, -5.4, 3.5, 0.22, 1),
  // nook_lowshelf_01, same 1.12 carcass as the clock wall, facing east.
  ledge("nook_lowshelf", 1.12, -7.27, 4.35, -6.93, 5.35, 2),
  // nook_stool_01, size 0.5 quantized to 0.48.
  pad("nook_stool_seat", 0.527, -3.0, 3.4, 0.14, 1),
];

/** Zone D, the counter. The stools are the only way up onto the marble. */
const ZONE_D_LEDGES: readonly WalkableSurface[] = [
  // counter_stool_01/02, size 0.68 quantized to 0.66.
  pad("counter_stool_west", 0.707, 1.3, 3.05, 0.14, 1),
  pad("counter_stool_east", 0.707, 2.5, 3.0, 0.14, 1),
  // counter_desk_01: 1.05 to the top of the marble slab, 3.0 by 0.8.
  ledge("counter_top", 1.05, 0.62, 3.62, 3.58, 4.38, 2),
  // counter_backcabinet_01, 2.1 tall against the south wall.
  ledge("back_cabinet_top", 2.1, 0.45, 5.02, 3.95, 5.38, 4),
  // counter_crate_01, size 0.62 quantized to 0.64, body 0.86 of the edge.
  pad("counter_crate_top", 0.55, 4.4, 2.7, 0.24, 1),
];

/** The open ground bay and three shelves inside each former glass cabinet. */
const CABINET_SHELF_TOPS = [0.693, 1.163, 1.613] as const;
const ZONE_E_BASES: readonly WalkableSurface[] = CABINET_BLOCKS.map((block, cabinetIndex) => {
  return ledge(
    `cabinet_${cabinetIndex + 1}_base`,
    0,
    block.min.x,
    block.min.z,
    block.max.x,
    block.max.z,
    0,
  );
});
const ZONE_E_LEDGES: readonly WalkableSurface[] = CABINET_BLOCKS.flatMap((block, cabinetIndex) => {
  const centerZ = (block.min.z + block.max.z) * 0.5;
  return CABINET_SHELF_TOPS.map((topY, shelfIndex) =>
    ledge(
      `cabinet_${cabinetIndex + 1}_shelf_${shelfIndex + 1}`,
      topY,
      block.min.x + 0.06,
      centerZ - 0.225,
      block.max.x - 0.06,
      centerZ + 0.225,
      shelfIndex + 1,
    ),
  );
});

/**
 * Zone F, the back workshop. The steel rack is a four-storey climb and the
 * leaning ladder is the express route to its top board.
 */
const SHELVING_BOARD_Y: readonly number[] = [0.26, 0.84, 1.42, 2.0];

const ZONE_F_LEDGES: readonly WalkableSurface[] = [
  ...SHELVING_BOARD_Y.map((topY, index) =>
    // workshop_shelving_01 boards, 0.04 thick at 0.24, 0.82, 1.4 and 1.98.
    ledge(`shelving_board_${String(index + 1)}`, topY, 6.82, -4.55, 7.28, -2.65, index === 0 ? 1 : index + 1),
  ),
  // workshop_bench_01 top slab, 0.92 to the top face.
  ledge("workbench_top", 0.92, 6.38, -1.85, 7.22, 0.45, 2),
  // workshop_stool_01/02, size 0.6; workshop_stool_03, size 0.48.
  pad("workshop_stool_north", 0.647, 5.9, -1.2, 0.14, 1),
  pad("workshop_stool_south", 0.647, 5.85, 0.3, 0.14, 1),
  pad("workshop_stool_west", 0.527, 4.6, -2.4, 0.14, 1),
  // workshop_crate_03 stands beside the stack and is the step up onto it.
  pad("workshop_crate_step", 0.55, 4.9, 1.85, 0.24, 1),
  // workshop_crate_02, stacked on workshop_crate_01 at 0.54.
  pad("workshop_crate_high", 0.953, 4.5, 1.35, 0.18, 2),
];

/** Zone G, the Security Office. */
const ZONE_G_LEDGES: readonly WalkableSurface[] = [
  // office_stool_01, size 0.55 quantized to 0.54.
  pad("office_stool_seat", 0.587, 6.1, 3.7, 0.14, 1),
  // office_desk_01 top slab at 0.78, turned so the 1.5 run lies along Z.
  ledge("office_desk_top", 0.78, 6.57, 2.97, 7.23, 4.43, 2),
];

export const WALKABLE_SURFACES: readonly WalkableSurface[] = [
  ...FLOOR_SURFACES,
  OFFICE_FLOOR,
  ...CRAWL_SURFACES,
  ...ZONE_A_LEDGES,
  ...ZONE_B_LEDGES,
  ...ZONE_C_LEDGES,
  ...ZONE_D_LEDGES,
  ...ZONE_E_BASES,
  ...ZONE_E_LEDGES,
  ...ZONE_F_LEDGES,
  ...ZONE_G_LEDGES,
];

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

/**
 * The shell. Walls were absent from the human-scale proxy because the floor
 * boxes simply stopped at them, but the accusation line of sight is traced
 * through this list, so the shop has to be enclosed.
 *
 * The window bay is left open between the sill and the head, which is what lets
 * a player stand on the sill instead of inside a wall.
 */
const SHELL_BLOCKERS: readonly AABB[] = [
  // North wall, in bands around the window bay and the street door.
  aabb(SHOP_MIN_X, 0, SHOP_MIN_Z, WINDOW_MIN_X, WALL_HEIGHT, SHOP_MIN_Z + WALL_THICKNESS),
  aabb(WINDOW_MIN_X, 0, SHOP_MIN_Z, WINDOW_MAX_X, WINDOW_SILL_Y, SHOP_MIN_Z + WALL_THICKNESS),
  aabb(WINDOW_MIN_X, WINDOW_HEAD_Y, SHOP_MIN_Z, WINDOW_MAX_X, WALL_HEIGHT, SHOP_MIN_Z + WALL_THICKNESS),
  aabb(WINDOW_MAX_X, 0, SHOP_MIN_Z, DOOR_MIN_X, WALL_HEIGHT, SHOP_MIN_Z + WALL_THICKNESS),
  aabb(DOOR_MIN_X, DOOR_HEIGHT, SHOP_MIN_Z, DOOR_MAX_X, WALL_HEIGHT, SHOP_MIN_Z + WALL_THICKNESS),
  aabb(DOOR_MAX_X, 0, SHOP_MIN_Z, SHOP_MAX_X, WALL_HEIGHT, SHOP_MIN_Z + WALL_THICKNESS),
  // South, west and east walls.
  aabb(SHOP_MIN_X, 0, SHOP_MAX_Z - WALL_THICKNESS, SHOP_MAX_X, WALL_HEIGHT, SHOP_MAX_Z),
  aabb(SHOP_MIN_X, 0, SHOP_MIN_Z, SHOP_MIN_X + WALL_THICKNESS, WALL_HEIGHT, SHOP_MAX_Z),
  aabb(SHOP_MAX_X - WALL_THICKNESS, 0, SHOP_MIN_Z, SHOP_MAX_X, WALL_HEIGHT, SHOP_MAX_Z),
  // Security Office partition, with the doorway left open (§5.7).
  aabb(OFFICE_MIN_X, 0, OFFICE_MIN_Z, OFFICE_MIN_X + 0.12, WALL_HEIGHT, OFFICE_DOOR_MIN_Z),
  aabb(OFFICE_MIN_X, 0, OFFICE_DOOR_MAX_Z, OFFICE_MIN_X + 0.12, WALL_HEIGHT, SHOP_MAX_Z),
  aabb(OFFICE_MIN_X, 0, OFFICE_MIN_Z, SHOP_MAX_X, WALL_HEIGHT, OFFICE_MIN_Z + 0.12),
];

/**
 * Furniture, each box spanning only the height its prop occupies. Where a prop
 * carries a walkable ledge its blocker stops at that ledge, so the prop blocks
 * approach from below and releases the player who has climbed onto it.
 */
const FURNITURE_BLOCKERS: readonly AABB[] = [
  // A — display deck, the three plinths standing on it, and the mannequin bases.
  aabb(WINDOW_MIN_X, 0, -5.4, WINDOW_MAX_X, 0.34, -4.5),
  aabb(-3.6, 0.34, -5.15, -3.3, 0.94, -4.85),
  aabb(-1.65, 0.34, -5.1, -1.35, 1.14, -4.8),
  aabb(-1.35, 0.34, -4.7, -1.05, 0.84, -4.4),
  aabb(0.4, 0, -5.4, 1.6, 1.1, -4.6),
  // A — the ladderback chair: seat slab and back, with the legs left open.
  aabb(0.69, 0.448, -4.2, 1.11, 0.528, -3.8),
  aabb(0.69, 0.528, -4.2, 1.11, 0.95, -4.16),

  // B — three open bookcases, the wall shelves above them, the longcase clock.
  ...CLOCK_WALL_SHELF_Z.flatMap(([, lowZ, wallZ]) => [
    aabb(SHOP_MIN_X, 0, lowZ - 0.7, -7.16, 1.12, lowZ + 0.7),
    aabb(SHOP_MIN_X, 1.63, wallZ - 0.55, -7.15, 1.668, wallZ + 0.55),
  ]),
  aabb(-7.4, 0, 1.9, -6.85, 2.35, 2.15),
  aabb(-5.74, 0.48, 1.76, -5.46, 0.527, 2.04),

  // C — armchair base and back, footstool, side table, bookcase, umbrella stand.
  aabb(-6.9, 0, 3.0, -5.9, 0.61, 4.0),
  aabb(-6.9, 0.61, 3.0, -5.9, 1.32, 3.32),
  aabb(-5.82, 0, 4.13, -5.28, 0.35, 4.57),
  aabb(-5.74, 0, 3.16, -5.06, 0.67, 3.84),
  aabb(-7.4, 0, 4.3, -6.93, 1.12, 5.4),
  aabb(-4.4, 0, 4.9, -4.1, 0.62, 5.3),
  aabb(-3.14, 0.48, 3.26, -2.86, 0.527, 3.54),

  // D — counter, back cabinet, two stools, one crate.
  aabb(0.56, 0, 3.6, 3.64, 1.05, 4.4),
  aabb(0.4, 0, 5.0, 4.0, 2.1, 5.4),
  aabb(1.16, 0.66, 2.91, 1.44, 0.707, 3.19),
  aabb(2.36, 0.66, 2.86, 2.64, 0.707, 3.14),
  aabb(4.08, 0, 2.38, 4.72, 0.55, 3.02),

  // E — four open display bookcases: shelf boards only. The decorative plinth
  // cannot be a movement blocker: growing even that low slab by the capsule's
  // step clearance creates an invisible shield across the entire bottom bay.
  ...CABINET_BLOCKS.flatMap((block) => {
    const centerZ = (block.min.z + block.max.z) * 0.5;
    const minZ = centerZ - 0.275;
    const maxZ = centerZ + 0.275;
    return [
      ...CABINET_SHELF_TOPS.map((topY) =>
        aabb(
          block.min.x + 0.05,
          topY - 0.026,
          minZ + 0.05,
          block.max.x - 0.05,
          topY,
          maxZ - 0.05,
        ),
      ),
      // The slim visual posts are deliberately non-colliding. Growing four
      // 6 cm posts by the player's capsule radius narrowed every side exit
      // into an invisible slot and recreated the glass wall we removed.
    ];
  }),

  // F — workbench slab and legs, with the bay beneath left open.
  aabb(6.38, 0.836, -1.85, 7.22, 0.92, 0.45),
  aabb(6.44, 0, -1.79, 6.55, 0.836, -1.68),
  aabb(7.05, 0, -1.79, 7.16, 0.836, -1.68),
  aabb(6.44, 0, 0.28, 6.55, 0.836, 0.39),
  aabb(7.05, 0, 0.28, 7.16, 0.836, 0.39),
  // F — steel rack: four boards and four uprights.
  ...SHELVING_BOARD_Y.map((topY) => aabb(6.8, topY - 0.04, -4.57, 7.3, topY, -2.63)),
  aabb(6.8, 0, -4.6, 6.85, 2.3, -4.55),
  aabb(7.25, 0, -4.6, 7.3, 2.3, -4.55),
  aabb(6.8, 0, -2.65, 6.85, 2.3, -2.6),
  aabb(7.25, 0, -2.65, 7.3, 2.3, -2.6),
  // F — crate stack, three loose crates, three stools, the leaning ladder.
  aabb(4.18, 0, 1.03, 4.82, 0.55, 1.67),
  aabb(4.19, 0.55, 1.04, 4.81, 0.953, 1.66),
  aabb(4.58, 0, 1.53, 5.22, 0.55, 2.17),
  aabb(5.28, 0, -5.12, 5.92, 0.55, -4.48),
  aabb(5.76, 0.6, -1.34, 6.04, 0.647, -1.06),
  aabb(5.71, 0.6, 0.16, 5.99, 0.647, 0.44),
  aabb(4.46, 0.48, -2.54, 4.74, 0.527, -2.26),
  aabb(6.42, 0, -3.25, 6.5, 2.2, -2.75),

  // G — monitor desk slab and legs, and the office stool.
  aabb(6.57, 0.72, 2.97, 7.23, 0.78, 4.43),
  aabb(6.62, 0, 3.06, 6.7, 0.72, 3.14),
  aabb(7.1, 0, 3.06, 7.18, 0.72, 3.14),
  aabb(6.62, 0, 4.26, 6.7, 0.72, 4.34),
  aabb(7.1, 0, 4.26, 7.18, 0.72, 4.34),
  aabb(5.96, 0.54, 3.56, 6.24, 0.587, 3.84),
];

/**
 * Ankle-height clutter, the one thing in the shop a hop is a route past.
 *
 * The furniture above is written out box by box because each prop needs a shape
 * describing it: a bench blocks its legs and opens its bay, a rack blocks its
 * boards and leaves the gaps between them. Clutter has nothing to describe. It
 * is a small solid lump on the floor, so its blocker is taken from the prop's
 * own footprint in `placements.ts` and the two cannot drift apart — which
 * matters more here than anywhere else in the map, because this is the only
 * obstacle a player meets below the knee.
 *
 * Every one of them stands above `WORLD_SCALE.stepHeight` and below the hop's
 * reach, so a walk is stopped and a hop is not. `jump.test.ts` derives both
 * bounds from this list rather than restating them.
 */
function clutterBlocker(placement: PropPlacement): AABB {
  const [width, height, depth] = placement.focus;
  const [x, , z] = placement.position;
  // The footprint is authored in the prop's own frame, so a turned crate is
  // taken as the rectangle it is before the axis-aligned box is measured.
  const cos = Math.abs(Math.cos(placement.rotationY));
  const sin = Math.abs(Math.sin(placement.rotationY));
  const halfX = (width * cos + depth * sin) / 2;
  const halfZ = (width * sin + depth * cos) / 2;
  return aabb(x - halfX, 0, z - halfZ, x + halfX, height, z + halfZ);
}

export const CLUTTER_BLOCKERS: readonly AABB[] = SHOP_PLACEMENTS.filter(
  (placement) => placement.obstacle === true,
).map(clutterBlocker);

/**
 * Grapple-only geometry. Books and the open cabinet frames are intentionally
 * absent from movement collision, but the cable still needs a truthful solid
 * point where their visible geometry sits.
 */
const BOOK_GRAPPLE_TARGETS: readonly AABB[] = SHOP_PLACEMENTS.filter(
  (placement) => placement.family === "book",
).map(focusBoundsFor);

const CABINET_GRAPPLE_TARGETS: readonly AABB[] = CABINET_BLOCKS.flatMap((block) => {
  const centreZ = (block.min.z + block.max.z) * 0.5;
  const postZ = [centreZ - 0.245, centreZ + 0.245] as const;
  const postX = [block.min.x + 0.03, block.max.x - 0.03] as const;
  const posts = postX.flatMap((x) =>
    postZ.map((z) => aabb(x - 0.04, 0.16, z - 0.04, x + 0.04, 1.95, z + 0.04)),
  );
  // Procedural stock on these shelves is visual dressing rather than a
  // placement record. Shallow bands make those visible books latchable while
  // leaving the shelf openings physically traversable.
  const stock = CABINET_SHELF_TOPS.map((topY) =>
    aabb(
      block.min.x + 0.12,
      topY,
      centreZ - 0.18,
      block.max.x - 0.12,
      Math.min(topY + 0.3, 1.94),
      centreZ + 0.18,
    ),
  );
  return [...posts, ...stock];
});

export const GRAPPLE_TARGETS: readonly AABB[] = [
  ...BOOK_GRAPPLE_TARGETS,
  ...CABINET_GRAPPLE_TARGETS,
];

export const NAV_BLOCKERS: readonly AABB[] = [
  ...SHELL_BLOCKERS,
  ...FURNITURE_BLOCKERS,
  ...CLUTTER_BLOCKERS,
];

/**
 * The office door itself, filling the gap the partition leaves. It is not in
 * `NAV_BLOCKERS`, because the Inspector walks through the doorway the moment the
 * hunt opens and the accusation sight lines are traced with it standing open.
 *
 * A Mimic never has that moment. §10.4 keeps them out of the Security Office for
 * the whole round, and the map used to enforce it by accident: the doorway had
 * no floor published under it, so nobody could cross. Now that the boards are
 * there for the Inspector, the rule needs stating, and this is it.
 */
export const OFFICE_DOOR_BLOCKER: AABB = aabb(
  OFFICE_MIN_X,
  0,
  OFFICE_DOOR_MIN_Z,
  OFFICE_MIN_X + 0.12,
  WALL_HEIGHT,
  OFFICE_DOOR_MAX_Z,
);

export const MIMIC_NAV_BLOCKERS: readonly AABB[] = [...NAV_BLOCKERS, OFFICE_DOOR_BLOCKER];

// ---------------------------------------------------------------------------
// Climb links
// ---------------------------------------------------------------------------

function mantle(
  from: string,
  to: string,
  position: readonly [number, number, number],
  target: readonly [number, number, number],
): ClimbLink {
  return {
    from,
    to,
    kind: "mantle",
    position: { x: position[0], y: position[1], z: position[2] },
    target: { x: target[0], y: target[1], z: target[2] },
  };
}

function ladder(
  from: string,
  to: string,
  position: readonly [number, number, number],
  target: readonly [number, number, number],
): ClimbLink {
  return {
    from,
    to,
    kind: "ladder",
    position: { x: position[0], y: position[1], z: position[2] },
    target: { x: target[0], y: target[1], z: target[2] },
  };
}

const CABINET_FLOOR_NEIGHBOURS = [
  { north: "floor_05", south: "floor_10", west: "floor_07", east: "floor_09" },
  { north: "floor_05", south: "floor_10", west: "floor_09", east: "floor_08" },
  { north: "floor_10", south: "floor_06", west: "floor_07", east: "floor_09" },
  { north: "floor_10", south: "floor_06", west: "floor_09", east: "floor_08" },
] as const;

const CABINET_CLIMB_LINKS: readonly ClimbLink[] = CABINET_BLOCKS.flatMap(
  (block, cabinetIndex) => {
    const x = (block.min.x + block.max.x) * 0.5;
    const z = (block.min.z + block.max.z) * 0.5;
    const entryGap = WORLD_SCALE.playerRadius + 0.03;
    const laneXs = [block.min.x + 0.16, block.max.x - 0.16] as const;
    const laneZs = [z - 0.1, z + 0.1] as const;
    const neighbours = CABINET_FLOOR_NEIGHBOURS[cabinetIndex];
    if (neighbours === undefined) return [];
    const baseName = `cabinet_${cabinetIndex + 1}_base`;
    const names = CABINET_SHELF_TOPS.map(
      (_top, shelfIndex) => `cabinet_${cabinetIndex + 1}_shelf_${shelfIndex + 1}`,
    );
    const firstShelf = names[0] as string;
    const faceLadders: ClimbLink[] = [
      ...laneXs.map((laneX) =>
        ladder(
          neighbours.north,
          firstShelf,
          [laneX, 0, block.min.z - entryGap],
          [laneX, CABINET_SHELF_TOPS[0], z - 0.1],
        ),
      ),
      ...laneXs.map((laneX) =>
        ladder(
          neighbours.south,
          firstShelf,
          [laneX, 0, block.max.z + entryGap],
          [laneX, CABINET_SHELF_TOPS[0], z + 0.1],
        ),
      ),
      ...laneZs.map((laneZ) =>
        ladder(
          neighbours.west,
          firstShelf,
          [block.min.x - entryGap, 0, laneZ],
          [block.min.x + 0.16, CABINET_SHELF_TOPS[0], laneZ],
        ),
      ),
      ...laneZs.map((laneZ) =>
        ladder(
          neighbours.east,
          firstShelf,
          [block.max.x + entryGap, 0, laneZ],
          [block.max.x - 0.16, CABINET_SHELF_TOPS[0], laneZ],
        ),
      ),
    ];
    const cornerShafts: ClimbLink[] = laneXs.flatMap((laneX) =>
      laneZs.flatMap((laneZ) => [
        ladder(
          names[0] as string,
          names[1] as string,
          [laneX, CABINET_SHELF_TOPS[0], laneZ],
          [laneX, CABINET_SHELF_TOPS[1], laneZ],
        ),
        ladder(
          names[1] as string,
          names[2] as string,
          [laneX, CABINET_SHELF_TOPS[1], laneZ],
          [laneX, CABINET_SHELF_TOPS[2], laneZ],
        ),
      ]),
    );
    return [
      // Each visible corner post has a real ladder lane from every exposed
      // face. The old single centre trigger made the posts look climbable while
      // requiring the player to abandon them and hunt for an invisible point.
      ...faceLadders,
      mantle(baseName, names[0] as string, [x, 0, z], [x, CABINET_SHELF_TOPS[0], z]),
      ...cornerShafts,
    ];
  },
);

/**
 * Every route between levels, usable in both directions. Ladders are reserved
 * for props whose geometry really offers rungs: the open bookcases, the brass
 * foot rail on the counter, the cabinet of drawers, and the leaning ladder.
 */
export const CLIMB_LINKS: readonly ClimbLink[] = [
  // A — up onto the display deck, along it, and out onto the sill.
  mantle("floor_00", "window_platform", [-3.75, 0, -4.32], [-3.75, 0.34, -4.85]),
  mantle("floor_00", "window_platform", [-5.9, 0, -4.32], [-5.9, 0.34, -4.85]),
  mantle("window_platform", "window_sill", [-3.75, 0.34, -5.18], [-3.75, 0.55, -5.38]),
  mantle("window_platform", "window_plinth_low", [-3.45, 0.34, -4.68], [-3.45, 0.94, -5.0]),
  mantle("window_platform", "window_plinth_mid", [-1.05, 0.34, -4.86], [-1.2, 0.84, -4.55]),
  mantle("window_plinth_mid", "window_plinth_high", [-1.3, 0.84, -4.66], [-1.5, 1.14, -4.95]),
  mantle("floor_00", "window_chair_seat", [0.9, 0, -3.58], [0.9, 0.528, -3.95]),

  // B — only the stool, for the reason given beside ZONE_B_LEDGES.
  mantle("floor_01", "clockwall_stool_seat", [-5.6, 0, 1.56], [-5.6, 0.527, 1.9]),
  ...CLOCK_WALL_SHELF_Z.map(([id, lowZ]) =>
    ladder("floor_01", `clockwall_lowshelf_${id}`, [-6.72, 0, lowZ], [-7.06, 1.12, lowZ]),
  ),

  // C — footstool to armchair to side table, and the bookcase in the corner.
  mantle("floor_02", "nook_footstool", [-5.55, 0, 4.75], [-5.55, 0.35, 4.35]),
  mantle("nook_footstool", "nook_armchair_seat", [-5.75, 0.35, 4.2], [-6.4, 0.61, 3.7]),
  mantle("nook_armchair_seat", "nook_sidetable_top", [-6.06, 0.61, 3.5], [-5.5, 0.67, 3.5]),
  ladder("floor_02", "nook_lowshelf", [-6.73, 0, 4.85], [-7.06, 1.12, 4.85]),
  mantle("floor_02", "nook_stool_seat", [-3.0, 0, 3.06], [-3.0, 0.527, 3.4]),

  // D — the stools are the route onto the counter; the drawers reach the cabinet.
  mantle("floor_03", "counter_stool_west", [1.3, 0, 2.71], [1.3, 0.707, 3.05]),
  mantle("floor_03", "counter_stool_east", [2.5, 0, 2.66], [2.5, 0.707, 3.0]),
  mantle("counter_stool_west", "counter_top", [1.3, 0.707, 3.16], [1.3, 1.05, 3.75]),
  mantle("counter_stool_east", "counter_top", [2.5, 0.707, 3.11], [2.5, 1.05, 3.72]),
  ladder("floor_03", "back_cabinet_top", [2.2, 0, 4.82], [2.2, 2.1, 5.16]),
  mantle("floor_03", "counter_crate_top", [3.88, 0, 2.7], [4.3, 0.55, 2.7]),

  // E — the open bookcases: enter from the cross aisle, then climb shelfwise.
  ...CABINET_CLIMB_LINKS,

  // F — the rack climbs board by board, with the ladder as the express route.
  mantle("floor_04", "shelving_board_1", [6.6, 0, -3.6], [6.95, 0.26, -3.6]),
  mantle("shelving_board_1", "shelving_board_2", [6.95, 0.26, -3.6], [6.95, 0.84, -3.6]),
  mantle("shelving_board_2", "shelving_board_3", [6.95, 0.84, -3.6], [6.95, 1.42, -3.6]),
  mantle("shelving_board_3", "shelving_board_4", [6.95, 1.42, -3.6], [6.95, 2.0, -3.6]),
  ladder("floor_04", "shelving_board_4", [6.28, 0, -3.0], [6.95, 2.0, -3.0]),
  mantle("floor_04", "workshop_stool_north", [5.9, 0, -1.54], [5.9, 0.647, -1.2]),
  mantle("floor_04", "workshop_stool_south", [5.85, 0, -0.04], [5.85, 0.647, 0.3]),
  mantle("workshop_stool_north", "workbench_top", [5.98, 0.647, -1.2], [6.55, 0.92, -1.2]),
  mantle("workshop_stool_south", "workbench_top", [5.93, 0.647, 0.3], [6.55, 0.92, 0.3]),
  mantle("floor_04", "workshop_stool_west", [4.6, 0, -2.06], [4.6, 0.527, -2.4]),
  mantle("floor_04", "workshop_crate_step", [5.4, 0, 1.85], [5.0, 0.55, 1.87]),
  mantle("workshop_crate_step", "workshop_crate_high", [5.0, 0.55, 1.9], [4.6, 0.953, 1.45]),

  // G — the office stool onto the monitor desk.
  mantle("floor_office", "office_stool_seat", [6.1, 0, 3.36], [6.1, 0.587, 3.7]),
  mantle("office_stool_seat", "office_desk_top", [6.22, 0.587, 3.7], [6.7, 0.78, 3.7]),
];

// ---------------------------------------------------------------------------
// Spawns
// ---------------------------------------------------------------------------

function pose(x: number, y: number, z: number, yaw: number): SpawnPose {
  return { position: { x, y, z }, yaw };
}

const NORTH = Math.PI;
const SOUTH = 0;
const EAST = -Math.PI / 2;
const WEST = Math.PI / 2;

/**
 * Mimics start spread across the six shop zones and across three levels, so the
 * first thing a player sees is that the room has an upstairs. None of them is
 * in the Security Office, which a Mimic may never enter (§10.4).
 */
const MIMIC_SPAWNS: readonly SpawnPose[] = [
  pose(-5.5, 0, -3.8, SOUTH),
  pose(-6.0, 0, 0.0, EAST),
  pose(-4.4, 0, 3.6, NORTH),
  pose(2.0, 0, 2.9, SOUTH),
  pose(0.0, 0, -0.5, WEST),
  pose(5.5, 0, -3.0, WEST),
  // Elevated starts: the window deck, the counter, and the workbench.
  pose(-4.6, 0.34, -4.9, SOUTH),
  pose(1.9, 1.05, 4.0, NORTH),
  pose(6.8, 0.92, -0.7, WEST),
];

/** Centre of the office door gap in the x=4.8 partition (blockers above). */
const OFFICE_DOOR = { x: 4.8, z: 3.6 };

/**
 * Yaw that faces (x, z) toward the target. Forward is (-sin yaw, -cos yaw):
 * yaw 0 is SOUTH (-Z) and pi is NORTH (+Z), matching the compass constants.
 */
function yawToward(x: number, z: number, target: { x: number; z: number }): number {
  return Math.atan2(-(target.x - x), -(target.z - z));
}

/**
 * Inspectors stage inside the office and step out through its door (§5.9),
 * so every spawn FACES the door. The round-5 critic proved the cost of
 * getting this wrong: all three spawns faced walls, W walked into plaster,
 * and the Inspector role was unplayable for a full 75-second hunt.
 */
const INSPECTOR_SPAWNS: readonly SpawnPose[] = [
  pose(6.6, 0, 4.9, yawToward(6.6, 4.9, OFFICE_DOOR)),
  pose(5.4, 0, 4.9, yawToward(5.4, 4.9, OFFICE_DOOR)),
  pose(5.2, 0, 3.6, WEST),
];

export const SPAWN_POINTS: SpawnPoints = {
  inspectors: INSPECTOR_SPAWNS,
  mimics: MIMIC_SPAWNS,
};

export const SECURITY_OFFICE: AABB = aabb(
  OFFICE_MIN_X,
  0,
  OFFICE_MIN_Z,
  SHOP_MAX_X,
  WALL_HEIGHT,
  SHOP_MAX_Z,
);

/**
 * Permanent physics ground beneath the whole shop shell. This is deliberately
 * separate from walkable surfaces, blockers, and grapple targets: it catches a
 * downward collision from either side, but no ray can select or latch onto it.
 */
export const SHOP_GROUND_PLANE: AABB = aabb(
  SHOP_MIN_X,
  -0.1,
  SHOP_MIN_Z,
  SHOP_MAX_X,
  0,
  SHOP_MAX_Z,
);

export const NAV_DATA: NavData = {
  floors: WALKABLE_SURFACES,
  groundPlane: SHOP_GROUND_PLANE,
  blockers: NAV_BLOCKERS,
  grappleTargets: GRAPPLE_TARGETS,
  climbLinks: CLIMB_LINKS,
  spawnPoints: SPAWN_POINTS,
  securityOffice: SECURITY_OFFICE,
};

/**
 * The same shop with the office door shut, which is the map a Mimic walks. It
 * differs from `NAV_DATA` in exactly one box: everything else a hider runs,
 * climbs and hides on is the room the Inspector hunts through.
 */
export const MIMIC_NAV_DATA: NavData = {
  ...NAV_DATA,
  blockers: MIMIC_NAV_BLOCKERS,
};

/** Rise a link crosses, which the authoring rules above are stated against. */
export function climbRise(link: ClimbLink): number {
  return Math.abs(link.target.y - link.position.y);
}

/** True when the surface is a ledge above the shop floor rather than the floor. */
export function isElevated(surface: WalkableSurface): boolean {
  return surface.bounds.max.y > WORLD_SCALE.stepHeight;
}
