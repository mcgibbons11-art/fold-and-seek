/**
 * Every sound the game ships, as prompts. ElevenLabs turns this list into the
 * bundled files offline; nothing here runs in the client.
 *
 * Two kinds, because they are played by two different things and cost two very
 * different amounts. A `sfx` is a one-shot under two seconds that `AudioPlayer`
 * fires and forgets. A `bed` is a long atmospheric loop that `AmbienceController`
 * holds open and crossfades, so it is generated with the API's own seamless-loop
 * flag and encoded at half the bitrate: a room tone carries no detail that
 * survives 64 kbps anyway, and there are a dozen of them.
 *
 * The whole set is written for GIANT SCALE. The player is a third of a metre
 * tall in a real shop, so everything is close-mic'd and a little oversized: a
 * footstep is a soft creature foot on a board that is enormous underneath it,
 * and a clock two rooms away is weather rather than a clock.
 */

export type SoundKind = "sfx" | "bed";

export interface SoundSpec {
  /** Output id; becomes assets/audio/{sfx,ambience}/<id>.mp3 */
  id: string;
  prompt: string;
  durationSeconds: number;
}

export interface BedSpec extends SoundSpec {
  /**
   * Zone or phase this bed belongs to, for the reader. The client owns the
   * routing; this is documentation, and the parity test does not read it.
   */
  role: string;
}

/**
 * Core SFX per bible §16 (audio identity: porcelain taps, compact servo whirs,
 * brass clicks, tiny spring tension) and §42.7 (first map asset list).
 */
export const CORE_SFX: SoundSpec[] = [
  { id: "ui_click", prompt: "single delicate porcelain tap, tiny ceramic button click, clean and precise, no reverb", durationSeconds: 0.6 },
  { id: "ui_hover", prompt: "extremely subtle soft brass tick, miniature instrument panel hover blip, quiet", durationSeconds: 0.5 },
  { id: "ui_confirm", prompt: "small satisfying brass latch click followed by a soft chime, elegant instrument confirmation", durationSeconds: 0.9 },
  { id: "material_sample", prompt: "soft magical ripple with a tiny glass ding, sampling a surface, delicate and quick", durationSeconds: 0.9 },
  { id: "anchor_snap", prompt: "firm miniature magnetic snap, small metal parts clicking together precisely, satisfying", durationSeconds: 0.7 },
  { id: "panel_snap", prompt: "compact mechanical panel sliding and locking with a crisp snap, small transformer toy fold", durationSeconds: 1.0 },
  { id: "servo_move", prompt: "tiny smooth servo motor whir, small robot joint rotating briefly, soft mechanical", durationSeconds: 0.8 },
  { id: "lock_seal", prompt: "layered mechanical locking sequence: latch release, telescoping rail, final firm click and a soft wax-seal stamp thump", durationSeconds: 1.8 },
  { id: "caught_sting", prompt: "sharp dramatic mechanical caught sting, sudden metallic clamp with a short orchestral hit, game-show reveal accent", durationSeconds: 1.6 },
  { id: "wrong_horn", prompt: "comedic muted wrong-answer horn, two-note sad brass wah wah, playful not harsh", durationSeconds: 1.6 },
  { id: "door_open", prompt: "old shop door opening slowly with a brass bell jingle and wooden creak, theatrical entrance", durationSeconds: 2.4 },
  { id: "footstep_wood", prompt: "single quiet footstep on old polished wooden floor, soft shoe, slight creak", durationSeconds: 0.5 },
  { id: "clock_chime", prompt: "antique shop clock chiming once, warm brass resonance, gentle decay", durationSeconds: 2.5 },
  { id: "lamp_switch", prompt: "vintage lamp pull-chain switch click with a faint filament hum starting, cozy", durationSeconds: 1.0 },
  { id: "unfold_reveal", prompt: "elaborate miniature mechanical transformation: latches releasing in sequence, panels sliding, telescoping rails extending, servo whirs, ending with a bright ceramic chirp, three seconds, toy-like and premium", durationSeconds: 3.5 },
  { id: "vase_dust_puff", prompt: "pathetic tiny dust puff from a ceramic vase, small air poof, comedic and dry", durationSeconds: 0.8 },
  { id: "kettle_whistle", prompt: "small kettle whistle rising briefly then stopping, indignant and comedic", durationSeconds: 1.8 },
  { id: "chair_squeak", prompt: "wooden chair squeaking once, indignant creak, comedic timing", durationSeconds: 0.9 },
];

/**
 * Footfalls, three variations per surface so a run does not machine-gun one
 * sample. `footstep_wood` above is the first wood variation; the numbering
 * carries on from it rather than orphaning a file already in the bundle.
 *
 * A creature this size lands softly and the board under it is huge, so every
 * one of these is a light tap with the surface's own resonance behind it rather
 * than a human bootfall.
 */
export const FOOTSTEP_SFX: SoundSpec[] = [
  { id: "footstep_wood_2", prompt: "single light footfall of a small soft-footed creature on an old waxed oak board, faint wood resonance underneath, close mic, dry", durationSeconds: 0.5 },
  { id: "footstep_wood_3", prompt: "one quiet padded step on aged polished floorboard, tiny creak of the plank answering, intimate and dry", durationSeconds: 0.5 },
  { id: "footstep_rug", prompt: "single muffled footfall on a thick wool rug, soft dusty thud, almost no attack, very close", durationSeconds: 0.5 },
  { id: "footstep_rug_2", prompt: "one soft step pressing into deep old carpet pile, dull muted thump with a whisper of fibre", durationSeconds: 0.5 },
  { id: "footstep_rug_3", prompt: "quiet padded footfall on worn velvet rug, warm dampened thud, no reverb", durationSeconds: 0.5 },
  { id: "footstep_metal", prompt: "single light tap of a tiny foot on a thin painted metal shelf, faint sheet-metal ring and rattle, close mic", durationSeconds: 0.6 },
  { id: "footstep_metal_2", prompt: "one small step on a steel shelf edge, brief metallic tick with a low hollow resonance after it", durationSeconds: 0.6 },
  { id: "footstep_metal_3", prompt: "quiet foot tap on thin metal bracket, short bright ping and a faint wobble, dry and small", durationSeconds: 0.6 },
  { id: "footstep_glass", prompt: "single tiny footstep on a glass cabinet top, delicate high tick with a faint pane ring, crystalline and quiet", durationSeconds: 0.6 },
  { id: "footstep_glass_2", prompt: "one small soft foot on a display case pane, light glassy tap, thin resonance, close and dry", durationSeconds: 0.6 },
  { id: "footstep_glass_3", prompt: "quiet step onto polished glass shelf, crisp tiny click with a short shimmering tail", durationSeconds: 0.6 },
];

/**
 * Everything else a body does. The hop and the landings carry the weight of the
 * creature (light, mechanical, sprung); the climbs and the wall-stick are small
 * hands and small magnets on furniture that is enormous.
 */
export const MOVEMENT_SFX: SoundSpec[] = [
  { id: "jump_takeoff", prompt: "tiny sprung hop, small coiled spring releasing with a soft servo push and a light scuff of departure, quick and light", durationSeconds: 0.6 },
  { id: "land_soft", prompt: "small light landing, padded foot touching down with a faint mechanical settle and one soft creak, gentle", durationSeconds: 0.7 },
  { id: "land_hard", prompt: "heavier small landing, both feet thumping onto old wood with a mechanical rattle of loose panels settling, weighty but tiny", durationSeconds: 0.9 },
  { id: "climb_grab", prompt: "small hand grabbing a wooden ledge, brief scrape of tiny fingers on grain then a firm grip, close mic", durationSeconds: 0.6 },
  { id: "climb_grab_2", prompt: "tiny mechanical hand catching a shelf edge, short scuff and a servo tightening its hold, quiet and precise", durationSeconds: 0.6 },
  { id: "wallstick_attach", prompt: "small magnetic pads clamping onto a vertical surface, quick suction-and-magnet snap, tiny and satisfying", durationSeconds: 0.7 },
  { id: "wallstick_release", prompt: "small magnetic pads peeling off a wall, soft unsticking pop with a faint servo relax, quiet", durationSeconds: 0.7 },
  { id: "creep_slide", prompt: "very quiet slow slide of a small body shifting position on wood, faint sustained scuff, barely audible, tense", durationSeconds: 1.2 },
];

/**
 * The warrant gun (override 1). The shot is a stamp rather than a firearm: this
 * is an inspector serving papers, so the fire is a heavy brass press with a
 * pneumatic bark and the dry click is an empty warrant chamber.
 */
export const GUN_SFX: SoundSpec[] = [
  { id: "gun_aim", prompt: "brass instrument raising into position, smooth mechanical lift with a small spring tensioning and a soft click at the top, quick", durationSeconds: 0.7 },
  { id: "gun_fire", prompt: "warrant stamp firing, heavy brass press with a short pneumatic bark and a paper snap, authoritative not violent, no gunpowder", durationSeconds: 0.9 },
  { id: "gun_dry_click", prompt: "empty chamber dry click, hollow brass mechanism cycling with nothing in it, small disappointed clack", durationSeconds: 0.5 },
];

/**
 * Phase transitions. No music is generated (the key has no music permission and
 * the design does not want a score), so the reveal and the results are built out
 * of chimes, swells and mechanism the same way every other sound here is.
 */
export const PHASE_SFX: SoundSpec[] = [
  { id: "hunt_riser", prompt: "tension riser, low bowed strings and a rising glass harmonic swelling over three seconds into a soft cutoff, cozy dread not horror", durationSeconds: 3.5 },
  { id: "reveal_swell", prompt: "layered reveal flourish: soft brass chimes cascading upward, a warm bell swell and a music-box shimmer resolving, celebratory and handmade", durationSeconds: 3.5 },
  { id: "results_resolve", prompt: "warm settling resolution, low wooden chime and a soft brass sigh coming to rest, satisfied and cozy, gentle decay", durationSeconds: 3.0 },
  { id: "rematch_tick", prompt: "small brass ratchet advancing one notch, single crisp mechanical tick, anticipatory", durationSeconds: 0.5 },
];

/** The remaining interface sounds the existing three did not cover. */
export const UI_SFX: SoundSpec[] = [
  { id: "ui_deny", prompt: "soft refusal, muted wooden thunk with a small dull buzz, polite negative, no harshness", durationSeconds: 0.6 },
  // 0.5 s is the generator's floor; a shorter tick has to be trimmed, not asked for.
  { id: "countdown_tick", prompt: "single antique clock escapement tick, dry brass, precise and quiet", durationSeconds: 0.5 },
  { id: "countdown_tick_final", prompt: "urgent clock tick, harder brass escapement strike with a faint metallic ring, tense", durationSeconds: 0.5 },
  { id: "score_tick", prompt: "tiny brass counter wheel advancing, light mechanical tally click, quick and bright", durationSeconds: 0.5 },
];

/** Every one-shot, in the order it is generated. */
export const ALL_SFX: readonly SoundSpec[] = [
  ...CORE_SFX,
  ...FOOTSTEP_SFX,
  ...MOVEMENT_SFX,
  ...GUN_SFX,
  ...PHASE_SFX,
  ...UI_SFX,
];

/**
 * Ambience beds. The first is the whole shop's base layer and plays under
 * everything; the next seven are the zone beds already named by `ambienceId` in
 * the client's `world/maps/zones.ts`, and the ids match that file exactly, so a
 * zone gains its bed by existing rather than by being registered twice.
 *
 * The last four are not places. The Forge bed is a phase, and the three tension
 * loops are states the hunt puts a player into.
 *
 * Every prompt describes a continuous texture with no beginning and no event
 * that would draw attention to the seam, because these are generated with the
 * API's seamless-loop flag and then looped for as long as a phase lasts.
 */
export const AMBIENCE_BEDS: readonly BedSpec[] = [
  {
    id: "amb_shop_room_tone",
    role: "global base layer, always playing",
    prompt: "continuous quiet night room tone of an old curiosity shop interior, deep still air, occasional distant wood settling and a very faint clock somewhere far off, warm and cozy, no melody, no events, seamless",
    durationSeconds: 30,
  },
  {
    id: "amb_street_moon",
    role: "zone front_window",
    prompt: "continuous night street heard through thick old shop glass, muffled wind, faint distant traffic hum, occasional soft rain speckle on the pane, lonely and cold outside a warm room, no events, seamless",
    durationSeconds: 30,
  },
  {
    id: "amb_clock_ticks",
    role: "zone clock_wall",
    prompt: "continuous wall of antique clocks ticking out of phase with each other, many small brass escapements, warm wooden cases resonating, steady and hypnotic, no chimes, seamless",
    durationSeconds: 30,
  },
  {
    id: "amb_glass_hum",
    role: "zone cabinet_maze",
    prompt: "continuous quiet hum of small display-cabinet lamps, faint electrical buzz and a thin glass resonance, occasional tiny tink of glass settling, cool and still, seamless",
    durationSeconds: 30,
  },
  {
    id: "amb_nook_settle",
    role: "zone reading_nook",
    prompt: "continuous soft carpeted room tone, deeply dampened air, old paper and leather settling faintly, an occasional low wooden creak, very warm and hushed, seamless",
    durationSeconds: 30,
  },
  {
    id: "amb_counter_paper",
    role: "zone collectors_counter",
    prompt: "continuous quiet shop counter tone, faint brass register ticking over, soft paper and ledger rustle, low still air, orderly and warm, seamless",
    durationSeconds: 30,
  },
  {
    id: "amb_workshop_creak",
    role: "zone back_workshop",
    prompt: "continuous back workshop tone, small heater ticking and a faint kettle hiss in the corner, tools settling on a bench, dry wood creaking slowly, cozy and cluttered, seamless",
    durationSeconds: 30,
  },
  {
    id: "amb_office_hum",
    role: "zone security_office",
    prompt: "continuous small office hum, old monitor whine, fluorescent ballast buzz and an occasional faint relay tick, cold and clinical against a warm shop, seamless",
    durationSeconds: 30,
  },
  {
    id: "amb_forge_tinker",
    role: "phase Forge",
    prompt: "continuous workshop tinkering tone, tiny servo whirs and small brass parts being set down, delicate clockwork ticking, focused and unhurried, no melody, seamless",
    durationSeconds: 30,
  },
  {
    id: "amb_inspector_near",
    role: "tension, inspector proximity",
    prompt: "continuous low ominous rumble, deep sub drone with a slow uneasy swell, distant heavy footfalls felt rather than heard, dread building, no melody, seamless",
    durationSeconds: 12,
  },
  {
    id: "amb_watched_low",
    role: "tension, watched level 1",
    prompt: "continuous slow calm heartbeat, muffled deep thump about seventy beats a minute, felt from inside a small chest, soft and steady, no other sound, seamless",
    durationSeconds: 12,
  },
  {
    id: "amb_watched_high",
    role: "tension, watched level 2",
    prompt: "continuous fast panicked heartbeat, hard deep double thump about a hundred and thirty beats a minute, pressure and blood rush behind it, seamless",
    durationSeconds: 12,
  },
];

/** Ids only, which is what the client's parity test compares against. */
export const SFX_IDS: readonly string[] = ALL_SFX.map((spec) => spec.id);
export const BED_IDS: readonly string[] = AMBIENCE_BEDS.map((spec) => spec.id);
