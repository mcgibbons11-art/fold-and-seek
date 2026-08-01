export const DEFAULT_MATCH_SETTINGS = {
  minPlayers: 2,
  maxPlayers: 12,
  idealMaxPlayers: 8,
  mapIntroMs: 5_000,
  roleRevealMs: 4_000,
  baselineScanMs: 12_000,
  forgeMs: 55_000,
  lockGraceMs: 5_000,
  inspectionIntroMs: 4_000,
  inspectionMs: 75_000,
  revealMs: 12_000,
  resultsMs: 15_000,
  rematchVoteMs: 12_000,
  warrantsBonus: 2,
  inspectorMoveSpeed: 2.8,
  /**
   * How fast a locked Mimic may creep, in metres per second. Hiders stay active
   * during the hunt, so root motion is allowed but far slower than an Inspector
   * walks: the disguise has to read as furniture that moved when nobody looked.
   */
  hiderCreepSpeed: 0.6,
  inspectorFocusDistance: 8.0,
  accusationDistance: 5.5,
  accusationHoldMs: 450,
  wrongAccusationCooldownMs: 1_500,
  directLookMinMs: 650,
  directLookBreakMs: 1_000,
  reconnectGraceMs: 30_000,
  serverTickHz: 20,
  movementInputHz: 20,
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
