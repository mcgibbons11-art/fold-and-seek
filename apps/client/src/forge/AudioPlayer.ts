/**
 * Small pooled sound player for Forge and round feedback. Every clip keeps a
 * few `HTMLAudioElement`s so a rapid retrigger overlaps instead of restarting,
 * which is all the mixing the game needs before the audio system proper
 * arrives.
 *
 * An id is the bundled file's own name, so anything named here has to exist in
 * `public/assets/audio/sfx`.
 */

const VOICES_PER_CLIP = 3;

export type SoundId =
  // Forge
  | "ui_click"
  | "ui_hover"
  | "ui_confirm"
  | "material_sample"
  | "anchor_snap"
  | "panel_snap"
  | "servo_move"
  | "lock_seal"
  // Hunt
  | "door_open"
  | "unfold_reveal"
  | "caught_sting"
  | "wrong_horn"
  | "lamp_switch"
  | "chair_squeak"
  | "vase_dust_puff"
  | "clock_chime"
  | "kettle_whistle"
  // Footfalls, three variations per surface (see `FOOTSTEP_VARIATIONS`)
  | "footstep_wood"
  | "footstep_wood_2"
  | "footstep_wood_3"
  | "footstep_rug"
  | "footstep_rug_2"
  | "footstep_rug_3"
  | "footstep_metal"
  | "footstep_metal_2"
  | "footstep_metal_3"
  | "footstep_glass"
  | "footstep_glass_2"
  | "footstep_glass_3"
  // Movement
  | "jump_takeoff"
  | "land_soft"
  | "land_hard"
  | "climb_grab"
  | "climb_grab_2"
  | "wallstick_attach"
  | "wallstick_release"
  | "creep_slide"
  // Warrant gun (override 1)
  | "gun_aim"
  | "gun_fire"
  | "gun_dry_click"
  // Phase transitions
  | "hunt_riser"
  | "reveal_swell"
  | "results_resolve"
  | "rematch_tick"
  // Interface
  | "ui_deny"
  | "countdown_tick"
  | "countdown_tick_final"
  | "score_tick";

interface Voices {
  readonly elements: HTMLAudioElement[];
  next: number;
  lastPlayedMs: number;
}

/**
 * One gain over everything the game plays. There is more than one `AudioPlayer`
 * alive at once (the Forge keeps its own, the round keeps another) and the
 * ambience beds are a third voice again, so a single setting has to reach all of
 * them rather than living on any one. Every live player registers here and is
 * told when the number changes.
 */
let masterVolume = 1;
const livePlayers = new Set<AudioPlayer>();

export function setMasterVolume(volume: number): void {
  masterVolume = Math.min(Math.max(volume, 0), 1);
  for (const player of livePlayers) player.applyVolume();
}

export function getMasterVolume(): number {
  return masterVolume;
}

export class AudioPlayer {
  private readonly clips = new Map<SoundId, Voices>();
  private readonly baseUrl: string;
  private readonly warned = new Set<string>();
  private volume: number;

  constructor(baseUrl: string = import.meta.env.BASE_URL, volume = 0.6) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.volume = volume;
    livePlayers.add(this);
  }

  setVolume(volume: number): void {
    this.volume = Math.min(Math.max(volume, 0), 1);
    this.applyVolume();
  }

  /** Pushes this player's volume, scaled by the master, onto every element. */
  applyVolume(): void {
    const effective = this.volume * masterVolume;
    for (const clip of this.clips.values()) {
      for (const element of clip.elements) {
        element.volume = effective;
      }
    }
  }

  play(id: SoundId, pitchJitter = 0): void {
    const clip = this.load(id);
    const element = clip.elements[clip.next % clip.elements.length];
    clip.next += 1;
    if (element === undefined) {
      return;
    }
    element.currentTime = 0;
    element.playbackRate = pitchJitter > 0 ? 1 + (Math.random() * 2 - 1) * pitchJitter : 1;
    clip.lastPlayedMs = performance.now();
    void element.play().catch((error: unknown) => {
      // Browsers reject playback until the page has seen a gesture. Nothing
      // here plays before the player has clicked their way into a round, so a
      // rejection means something else is wrong and is worth saying once.
      if (!this.warned.has(id)) {
        this.warned.add(id);
        console.warn(`audio: ${id} did not play`, error);
      }
    });
  }

  /** Plays at most once every `intervalMs`, for continuous feedback like servos. */
  playThrottled(id: SoundId, intervalMs: number, pitchJitter = 0): void {
    const clip = this.clips.get(id);
    if (clip !== undefined && performance.now() - clip.lastPlayedMs < intervalMs) {
      return;
    }
    this.play(id, pitchJitter);
  }

  dispose(): void {
    livePlayers.delete(this);
    for (const clip of this.clips.values()) {
      for (const element of clip.elements) {
        element.pause();
        element.removeAttribute("src");
      }
    }
    this.clips.clear();
  }

  private load(id: SoundId): Voices {
    const existing = this.clips.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const elements: HTMLAudioElement[] = [];
    for (let i = 0; i < VOICES_PER_CLIP; i++) {
      const element = new Audio(`${this.baseUrl}assets/audio/sfx/${id}.mp3`);
      element.preload = "auto";
      element.volume = this.volume * masterVolume;
      elements.push(element);
    }
    const clip: Voices = { elements, next: 0, lastPlayedMs: 0 };
    this.clips.set(id, clip);
    return clip;
  }
}
