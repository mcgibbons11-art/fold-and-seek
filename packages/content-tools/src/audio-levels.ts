/**
 * How loud each bundled clip should be, in LUFS.
 *
 * The generator returns whatever level the model felt like: measured across the
 * first set, integrated loudness ran from -4 LUFS (kettle_whistle) to -60
 * (creep_slide), and the three variations of a single footstep surface differed
 * by more than twenty decibels from each other. Variations that alternate have
 * to match or the alternation itself becomes the loudest thing about them, so
 * the levels are decided here and applied by `normalize-audio.ts` rather than
 * left to the generator.
 *
 * These are targets for the file on disk. They are not the mix: `AudioPlayer`
 * scales one-shots by its own volume and `AmbienceController` scales every bed
 * by `CHANNEL_GAIN`, so what a player hears is this times a decision made in the
 * client. Keeping the files even is what lets those decisions mean anything.
 */

/** Everything a one-shot can be, loudest to quietest, with the reason. */
const STINGER = -15;
/** A phase turning over: loud enough to interrupt, short of a stinger. */
const PHASE_OPEN = -19;
/** An object answering a warrant. All five match: the shot is what varies. */
const REACTION = -20;
/** A hunt beat the room broadcasts. */
const HUNT_BEAT = -19;
/** Forge mechanism under the player's hands. */
const MECHANISM = -23;
/** Interface feedback: present, never in front of the room. */
const INTERFACE = -23;
/** A footfall. Every surface and every variation lands here. */
const FOOTSTEP = -27;
/** Body movement other than a footfall. */
const MOVEMENT = -26;
/** Texture that plays continuously under something else. */
const UNDERLAY = -30;

/**
 * Per-clip targets. A clip absent from this table is a bug rather than a
 * default, so `normalize-audio.ts` refuses to run instead of guessing.
 */
export const SFX_TARGET_LUFS: Readonly<Record<string, number>> = {
  // Stingers. The catch and the two outcomes are the loudest things in the game.
  caught_sting: -14,
  win_sting: -14,
  wrong_horn: STINGER,
  lose_sting: -16,
  reveal_swell: -16,
  results_resolve: -17,

  // The warrant gun. The shot outranks the raise by ten decibels: measured on
  // the first set the raise was the louder of the two, which read as the
  // Inspector's own weapon shouting before it did anything.
  gun_fire: -15,
  gun_aim: -25,
  gun_dry_click: -22,

  // Phase openers.
  door_open: PHASE_OPEN,
  hunt_riser: -18,
  forge_start: -20,
  role_reveal: PHASE_OPEN,
  unfold_reveal: PHASE_OPEN,
  lock_seal: PHASE_OPEN,

  // Innocent reactions. Uniform: which object was wrongly accused must not
  // change how loudly the mistake lands.
  lamp_switch: REACTION,
  chair_squeak: REACTION,
  vase_dust_puff: REACTION,
  clock_chime: REACTION,
  kettle_whistle: REACTION,

  // Hunt beats.
  taunt_call: HUNT_BEAT,
  close_pass_riser: -18,
  escape_relief: -20,

  // Forge mechanism.
  anchor_snap: MECHANISM,
  panel_snap: -21,
  material_sample: MECHANISM,
  eyedropper_pick: MECHANISM,
  servo_move: -28,
  paint_stroke: UNDERLAY,

  // Interface.
  ui_click: INTERFACE,
  ui_confirm: -22,
  ui_deny: -22,
  ui_back: -24,
  ui_hover: -30,
  countdown_tick: INTERFACE,
  countdown_tick_final: -20,
  score_tick: -25,
  rematch_tick: -24,

  // Footfalls, all twelve.
  footstep_wood: FOOTSTEP,
  footstep_wood_2: FOOTSTEP,
  footstep_wood_3: FOOTSTEP,
  footstep_rug: FOOTSTEP,
  footstep_rug_2: FOOTSTEP,
  footstep_rug_3: FOOTSTEP,
  footstep_metal: FOOTSTEP,
  footstep_metal_2: FOOTSTEP,
  footstep_metal_3: FOOTSTEP,
  footstep_glass: FOOTSTEP,
  footstep_glass_2: FOOTSTEP,
  footstep_glass_3: FOOTSTEP,

  // Movement.
  jump_takeoff: -25,
  land_soft: -27,
  land_hard: -22,
  climb_grab: MOVEMENT,
  climb_grab_2: MOVEMENT,
  wallstick_attach: MOVEMENT,
  wallstick_release: -27,
  creep_slide: UNDERLAY,
};

/**
 * Every bed lands on one number. The beds crossfade into each other as the
 * player walks, so any difference between two of them is heard as the shop
 * changing volume in a doorway; the balance between channels belongs to
 * `CHANNEL_GAIN` in the client, which is a decision that can be retuned without
 * re-encoding anything.
 */
export const BED_TARGET_LUFS = -30;

/** True-peak ceilings. A one-shot is transient, so it is given more headroom. */
export const SFX_TRUE_PEAK_DB = -1.0;
export const BED_TRUE_PEAK_DB = -1.5;
