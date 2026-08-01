export interface SoundSpec {
  /** Output id; becomes assets/audio/sfx/<id>.mp3 */
  id: string;
  prompt: string;
  durationSeconds: number;
}

/**
 * Core SFX set per bible §16 (audio identity: porcelain taps, compact servo
 * whirs, brass clicks, tiny spring tension) and §42.7 (first map asset list).
 * Generated offline via ElevenLabs into the client bundle.
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
