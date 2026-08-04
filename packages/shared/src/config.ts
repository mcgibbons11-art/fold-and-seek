/**
 * Standing height of a player, in world metres. This is the one scale knob the
 * giant-scale design turns: the shop keeps real furniture dimensions and the
 * player shrinks until a table top is a storey, so every speed and every
 * distance below is quoted against this number rather than written out.
 *
 * `WORLD_SCALE` in the client's `inspector/navData.ts` reads this constant, so
 * the character controller, the camera rig and the match settings cannot drift
 * apart.
 */
export const PLAYER_HEIGHT_M = 0.35;

/**
 * Inspector walking speed, in body lengths per second.
 *
 * Legged walkers of different sizes move alike at equal Froude number,
 * v² / (g · L), where L is leg length. A 1.75 m person with a 0.9 m leg breaks
 * from a walk into a run near 2.1 m/s, which is a Froude number of about 0.5.
 * The same Froude number over a 0.35 m body, whose leg is roughly half its
 * standing height, gives sqrt(0.5 · 9.81 · 0.175) = 0.93 m/s. The game goes a
 * little above that at 3.4 body lengths per second (1.19 m/s): enough to make
 * short aisle changes immediate without turning the search into a sprint.
 *
 * The result also sits in the right relation to the climb speeds the map is
 * authored against, `WORLD_SCALE.mantleSpeed` 0.84 m/s and `ladderSpeed`
 * 0.54 m/s: walking is about one and a half times a vault, so taking the shelf
 * route no longer feels like the controls have changed speed classes.
 */
const INSPECTOR_BODY_LENGTHS_PER_SECOND = 3.4;

/**
 * Hider running speed during the Forge, in body lengths per second.
 *
 * A Mimic crossing the shop to find somewhere to hide is running, carries no
 * gun, and is searching for nothing, so it goes a little faster than the
 * Inspector. At 4.2 body lengths per second it covers 1.47 m/s against the
 * Inspector's 1.19: quick enough that the fold phase is spent shaping instead
 * of commuting across the shop, still close enough to read as the same body.
 */
const HIDER_FORGE_BODY_LENGTHS_PER_SECOND = 4.2;

/**
 * How fast a Mimic runs while the Forge is open, in metres per second.
 *
 * This is deliberately not a `MatchSettings` field. No authority reads it: root
 * motion is validated only once the disguise has manifested, against
 * `hiderCreepSpeed`, and the Forge phase has no speed rule of its own. Putting
 * it on the wire would offer a host a number the simulation never checks.
 */
export const HIDER_FORGE_RUN_SPEED = PLAYER_HEIGHT_M * HIDER_FORGE_BODY_LENGTHS_PER_SECOND;

/**
 * How high a body hops on the jump key, as a share of its own standing height.
 *
 * Jump is for hops, gaps and feel. It is deliberately not a way up onto things:
 * the giant-scale rule that the map decides where a body can get up still
 * governs every real climb, and the authored climb links remain the only route
 * onto a shelf or a counter.
 *
 * The band is narrow and both edges are real. Below `WORLD_SCALE.stepHeight`,
 * which is a fifth of body height, a hop would clear nothing a walk does not
 * already cross and would read as a stumble. At or above the lowest ledge the
 * map publishes, minus that same step height, a hop starts mounting furniture
 * and takes the climb links' job.
 *
 * The upper edge is closer than it looks. The lowest thing in the Curiosity
 * Shop that can be stood on is not a table at all but the bottom board of the
 * steel rack, 0.26 m up, so the ceiling on this number is 0.19 m and not the
 * 0.34 m window deck. Nine twentieths of body height is 0.158 m, which reaches
 * 0.228 m with the step lip added: two and a quarter times the lip a walk
 * already crosses, and a comfortable 3 cm under that bottom board.
 * `jump.test.ts` measures both edges against the map's own surfaces rather than
 * trusting this paragraph, so retuning either number fails loudly.
 */
const JUMP_BODY_HEIGHTS = 0.45;

/** Apex of a hop above the surface it left, in world metres. */
export const JUMP_HEIGHT_M = PLAYER_HEIGHT_M * JUMP_BODY_HEIGHTS;

/** Grapple traversal is quick enough to cross an aisle without replacing ordinary running. */
export const GRAPPLE_PULL_SPEED_MPS = PLAYER_HEIGHT_M * 12;
/** A latch closer than this is treated as an accidental click on the player's own cover. */
export const GRAPPLE_MIN_RANGE_M = PLAYER_HEIGHT_M * 0.75;
/** Keeps grapples local to the part of the room the player can actually read. */
export const GRAPPLE_MAX_RANGE_M = PLAYER_HEIGHT_M * 18;
/** Release before the character centre reaches the surface, leaving room for the capsule. */
export const GRAPPLE_ARRIVAL_M = PLAYER_HEIGHT_M * 0.58;
/** Extra authority time for the fall and the final network pose after the cable releases. */
export const GRAPPLE_AUTHORITY_GRACE_MS = 3_000;

/**
 * Reticle reach and gun reach, in body heights, measured from the eye to the
 * nearest point of the target's bounds.
 *
 * Six body heights is 2.1 m, which is what a 1.75 m person sees object detail
 * at from 10.5 m: far enough to pick a suspicious shape out of the next aisle,
 * well short of the 15 m the Curiosity Shop runs end to end. The gun reaches
 * half as far again, so noticing something always costs a walk toward it and no
 * shot ever crosses the room. The previous 8.0 m focus was twenty-three body
 * heights, a human-scale equivalent of 40 m, which made most of the shop
 * inspectable from wherever the Inspector happened to be standing.
 */
const FOCUS_BODY_HEIGHTS = 6;
const ACCUSATION_BODY_HEIGHTS = 3;

/**
 * How near an Inspector's eye must come to a disguise for the pass to count as
 * a close one (§6.4), in body heights, measured the same way the two distances
 * above are: eye to the nearest point of the target's bounds.
 *
 * Two body heights is 0.7 m, which is two thirds of the 1.05 m gun reach. That
 * relation is the point of the number. A close pass is the beat where the
 * Inspector was near enough to take the shot and walked on instead, so it has
 * to sit inside `accusationDistance` rather than merely inside the 2.1 m
 * reticle, where being noticed at range would pay the same as being brushed
 * past. It is also well clear of the body itself: a 0.35 m creature folded into
 * a prop is credited when the hunter comes within two of its own standing
 * heights, not when the two are touching.
 *
 * Scaled up to a 1.75 m person this is 3.5 m in a 75 m shop, the width of an
 * aisle you could cross by leaning.
 */
const CLOSE_PASS_BODY_HEIGHTS = 2;

/** Proximity that earns a close pass, in world metres. */
export const CLOSE_PASS_DISTANCE_M = PLAYER_HEIGHT_M * CLOSE_PASS_BODY_HEIGHTS;

/**
 * Most seekers a host may ask for. Two hunters is the ceiling the round is
 * balanced around: a third would leave a small room with more seekers than
 * hiders, and the warrant economy is written per seeker, so every extra hunter
 * multiplies the ammunition in the shop.
 */
export const MAX_SEEKER_COUNT = 2;

/**
 * Seats a room needs before a second seeker may be dealt. Two seekers and two
 * hiders is the smallest round that still plays as hide and seek; below it the
 * hunters would outnumber the hidden. Bot seats count, because a bot fills a
 * seat exactly as a person does.
 */
export const DUAL_SEEKER_MIN_SEATS = 4;

export const DEFAULT_MATCH_SETTINGS = {
  minPlayers: 2,
  maxPlayers: 12,
  /**
   * Seekers the host asks for, one or two. It is a floor rather than the final
   * count: a roster too small to support a second seeker gets one anyway, and
   * the roster rule of §5.5 still deals two hunters to a room of nine or more
   * however this is set.
   */
  seekerCount: 1,
  // Start goes straight to the Inspector/Mimic card. The old five-second
  // generic countdown delayed the only information players were waiting for.
  mapIntroMs: 0,
  roleRevealMs: 4_000,
  // Kept on the wire for old snapshots only. New rounds go directly from the
  // role reveal to Forge; the old memorize-the-room phase is gone.
  baselineScanMs: 0,
  forgeMs: 55_000,
  lockGraceMs: 5_000,
  inspectionIntroMs: 4_000,
  inspectionMs: 75_000,
  revealMs: 12_000,
  resultsMs: 15_000,
  rematchVoteMs: 12_000,
  warrantsBonus: 2,
  inspectorMoveSpeed: PLAYER_HEIGHT_M * INSPECTOR_BODY_LENGTHS_PER_SECOND,
  /**
   * How fast a live Mimic may move during the hunt. Hiders keep the same agile
   * run they use while forging; starting the hunt must not silently turn WASD
   * into a crawl. The historical field name remains for wire compatibility.
   */
  hiderCreepSpeed: HIDER_FORGE_RUN_SPEED,
  /**
   * Cycle for the live missed-finds board during the hunt. The original shows
   * a visible countdown to the next update on roughly this period.
   */
  missedFindsUpdateMs: 20_000,
  inspectorFocusDistance: PLAYER_HEIGHT_M * FOCUS_BODY_HEIGHTS,
  accusationDistance: PLAYER_HEIGHT_M * ACCUSATION_BODY_HEIGHTS,
  wrongAccusationCooldownMs: 1_500,
  directLookMinMs: 650,
  directLookBreakMs: 1_000,
  reconnectGraceMs: 30_000,
  serverTickHz: 20,
  cameraSampleHz: 10,
  maxForgeCommandHz: 15,
} as const;

/** Community vote categories on the results screen (§5.15). */
export const RESULT_VOTE_CATEGORIES = ["best_disguise", "funniest_attempt", "most_audacious"] as const;

export type ResultVoteCategory = (typeof RESULT_VOTE_CATEGORIES)[number];

/** Responses an innocent object gives to a wrong accusation (§5.10). */
export const INNOCENT_REACTION_IDS = [
  "lamp_turns_on",
  "clock_chimes",
  "kettle_whistles",
  "chair_squeaks",
  "vase_dust_puff",
] as const;

export type InnocentReactionId = (typeof INNOCENT_REACTION_IDS)[number];

/**
 * Gestures a disguised Mimic can perform to bait an Inspector. The object
 * performs the taunt, never the player, so anonymity survives it. Content owns
 * the final list and its animations; the simulation only needs a closed set to
 * validate against.
 */
export const TAUNT_IDS = [
  "shudder",
  "rattle",
  "tick_tock",
  "settle_creak",
  "puff",
] as const;

export type TauntId = (typeof TAUNT_IDS)[number];

/**
 * Rig contract shared by the Forge authoring code and every validator that sees
 * a disguise on the wire (§7.16, §29.2). The bone and segment lists are ordered,
 * and a serialized pose must present them in exactly this order.
 */
export const RIG_CONTRACT_VERSION = 1;

/** Version of the serialized disguise envelope itself, bumped on shape changes. */
export const DISGUISE_WIRE_VERSION = 1;

export const RIG_BONE_NAMES = [
  "root",
  "pelvis",
  "torso_lower",
  "torso_upper",
  "neck",
  "head",
  "shoulder_L",
  "upperarm_L",
  "forearm_L",
  "hand_L",
  "shoulder_R",
  "upperarm_R",
  "forearm_R",
  "hand_R",
  "thigh_L",
  "shin_L",
  "foot_L",
  "thigh_R",
  "shin_R",
  "foot_R",
  "panel_socket_01",
  "panel_socket_02",
  "panel_socket_03",
  "panel_socket_04",
  "panel_socket_05",
  "panel_socket_06",
  "panel_socket_07",
  "panel_socket_08",
] as const;

export type RigBoneName = (typeof RIG_BONE_NAMES)[number];

/** Bones that carry a shapeable segment. Panel sockets and the root do not. */
export const RIG_SEGMENT_BONES = [
  "pelvis",
  "torso_lower",
  "torso_upper",
  "neck",
  "head",
  "shoulder_L",
  "upperarm_L",
  "forearm_L",
  "hand_L",
  "shoulder_R",
  "upperarm_R",
  "forearm_R",
  "hand_R",
  "thigh_L",
  "shin_L",
  "foot_L",
  "thigh_R",
  "shin_R",
  "foot_R",
] as const;

export type RigSegmentBoneName = (typeof RIG_SEGMENT_BONES)[number];

export const PANEL_SOCKET_NAMES = [
  "panel_socket_01",
  "panel_socket_02",
  "panel_socket_03",
  "panel_socket_04",
  "panel_socket_05",
  "panel_socket_06",
  "panel_socket_07",
  "panel_socket_08",
] as const;

export type PanelSocketName = (typeof PANEL_SOCKET_NAMES)[number];

/** One panel per socket, so the socket list is also the panel ceiling. */
export const MAX_PANELS = PANEL_SOCKET_NAMES.length;

export const PANEL_PROFILE_IDS = ["rectangle", "rounded_rect", "triangle"] as const;

export type PanelProfileId = (typeof PANEL_PROFILE_IDS)[number];

export const SEGMENT_PROFILE_IDS = [
  "capsule",
  "rounded_box",
  "flat_panel",
  "tapered_block",
  "cylinder",
  "cone_frustum",
  "soft_wedge",
] as const;

export type SegmentProfileId = (typeof SEGMENT_PROFILE_IDS)[number];

export const PANEL_MIN_HINGE_DEG = -180;
export const PANEL_MAX_HINGE_DEG = 180;

/** Starting poses offered in the Forge (§7.15). */
export const STARTER_ARRANGEMENT_IDS = [
  "upright",
  "compact",
  "wide",
  "tall",
  "tripod",
  "wall_mount",
  "shelf_bundle",
  "hanging",
] as const;

export type StarterArrangementId = (typeof STARTER_ARRANGEMENT_IDS)[number];

/**
 * Arrangement a Mimic locks into when the Forge deadline arrives and no valid
 * pose was ever recorded for them (§5.8). It is a real disguise, not a standing
 * person, which is what §5.8 forbids.
 */
export const DEFAULT_ARRANGEMENT_ID: StarterArrangementId = "upright";

/**
 * Tunable copy of the defaults. Every value is widened to `number` and made
 * writable so hosts can adjust round pacing (§5.3); the defaults object itself
 * stays frozen at the type level.
 */
export type MatchSettings = {
  -readonly [K in keyof typeof DEFAULT_MATCH_SETTINGS]: number;
};
