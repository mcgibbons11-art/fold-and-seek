/**
 * Small pooled sound player for Forge and round feedback. Every clip keeps a
 * few `HTMLAudioElement`s so a rapid retrigger overlaps instead of restarting,
 * which is all the mixing the game needs before the audio system proper
 * arrives.
 *
 * An id is the bundled file's own name, so anything named here has to exist in
 * `public/assets/audio/sfx`.
 */

import { audioMixer, getAudioLevels, setAudioBusVolume, type AudioCategory, type AudioPriority } from "../audio/AudioMixer";
import { audioRuntime } from "../audio/AudioRuntime";

const VOICES_PER_CLIP = 3;

/**
 * All AudioPlayer instances share this budget. Forge, movement, weapons, and
 * round feedback each own a player, so a per-instance ceiling still allowed a
 * noisy frame to start dozens of overlapping elements. The oldest transient
 * yields first, keeping current input feedback audible.
 */
export const MAX_ACTIVE_ONE_SHOTS = 16;

function releaseOneShot(element: HTMLAudioElement): void {
  audioMixer.release(element);
}

function reserveOneShot(element: HTMLAudioElement, bus: "gameplay" | "ui", priority: AudioPriority, category: AudioCategory): boolean {
  return audioMixer.reserve(element, bus, priority, category);
}

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
  | "ui_back"
  | "countdown_tick"
  | "countdown_tick_final"
  | "score_tick"
  // Painting (override 3)
  | "paint_stroke"
  | "eyedropper_pick"
  // Hunt beats the simulation broadcasts
  | "taunt_call"
  | "close_pass_riser"
  | "escape_relief"
  // Round turns
  | "role_reveal"
  | "forge_start"
  | "win_sting"
  | "lose_sting";

/**
 * Conservative trims for supplied recordings whose measured transients land
 * close to full scale. Quiet material is deliberately not boosted: a missing
 * footstep is less disruptive than raising its noise floor, while a sharp UI
 * click benefits from predictable headroom when several cues coincide.
 */
const MEASURED_PEAK_TRIM: Partial<Readonly<Record<SoundId, number>>> = {
  ui_click: 0.68,
  ui_confirm: 0.55,
  lock_seal: 0.72,
  score_tick: 0.72,
};

const IMPORTANT_SOUNDS: ReadonlySet<SoundId> = new Set([
  "ui_confirm", "lock_seal", "gun_fire", "door_open", "unfold_reveal", "role_reveal", "forge_start",
  "countdown_tick_final",
]);
const CRITICAL_SOUNDS: ReadonlySet<SoundId> = new Set([
  "caught_sting", "wrong_horn", "hunt_riser", "reveal_swell", "results_resolve", "win_sting", "lose_sting",
]);
const LOW_PRIORITY_SOUNDS: ReadonlySet<SoundId> = new Set([
  "paint_stroke", "creep_slide",
]);

function priorityOf(id: SoundId): AudioPriority {
  if (CRITICAL_SOUNDS.has(id)) return "critical";
  if (IMPORTANT_SOUNDS.has(id)) return "important";
  if (LOW_PRIORITY_SOUNDS.has(id)) return "low";
  return "normal";
}

function categoryOf(id: SoundId, bus: "gameplay" | "ui"): AudioCategory {
  if (bus === "ui") return "ui";
  if (id.startsWith("footstep_")) return "footsteps";
  if (id === "paint_stroke" || id === "servo_move" || id === "creep_slide") return "texture";
  if (id.startsWith("gun_")) return "weapon";
  if (CRITICAL_SOUNDS.has(id) || id === "rematch_tick") return "results";
  return "general";
}

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
const livePlayers = new Set<AudioPlayer>();

export function setMasterVolume(volume: number): void {
  setAudioBusVolume("master", volume);
}

export function getMasterVolume(): number {
  return getAudioLevels().master;
}

export class AudioPlayer {
  private readonly clips = new Map<SoundId, Voices>();
  private readonly baseUrl: string;
  private readonly playbackGains = new WeakMap<HTMLAudioElement, number>();
  private readonly bus: "gameplay" | "ui";
  private readonly unsubscribeMixer: () => void;
  private volume: number;

  constructor(baseUrl: string = import.meta.env.BASE_URL, volume = 0.6, bus: "gameplay" | "ui" = "gameplay") {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.volume = volume;
    this.bus = bus;
    livePlayers.add(this);
    this.unsubscribeMixer = audioMixer.subscribe(() => this.applyVolume());
  }

  setVolume(volume: number): void {
    this.volume = Math.min(Math.max(volume, 0), 1);
    this.applyVolume();
  }

  /** Pushes this player's volume, scaled by the master, onto every element. */
  applyVolume(): void {
    const effective = this.volume * audioMixer.gain(this.bus);
    for (const clip of this.clips.values()) {
      for (const element of clip.elements) {
        element.volume = Math.min(1, effective * (this.playbackGains.get(element) ?? 1));
      }
    }
  }

  /**
   * `gain` scales this one playback on top of the player's own volume, for a
   * sound whose loudness is a property of the moment rather than of the clip —
   * an object reacting across the shop rather than underfoot. It lasts until the
   * pooled element is used again, which is the next time the same clip plays.
   */
  play(id: SoundId, pitchJitter = 0, gain = 1): void {
    const clip = this.load(id);
    const element = clip.elements[clip.next % clip.elements.length];
    clip.next += 1;
    if (element === undefined) {
      return;
    }
    element.currentTime = 0;
    const playbackGain = Math.min(1, Math.max(0, gain * (MEASURED_PEAK_TRIM[id] ?? 1)));
    this.playbackGains.set(element, playbackGain);
    element.volume = Math.min(1, this.volume * audioMixer.gain(this.bus) * playbackGain);
    element.playbackRate = pitchJitter > 0 ? 1 + (Math.random() * 2 - 1) * pitchJitter : 1;
    clip.lastPlayedMs = performance.now();
    const priority = priorityOf(id);
    if (!reserveOneShot(element, this.bus, priority, categoryOf(id, this.bus))) return;
    audioRuntime.play(element, priority === "critical");
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
    this.unsubscribeMixer();
    for (const clip of this.clips.values()) {
      for (const element of clip.elements) {
        releaseOneShot(element);
        audioRuntime.forget(element);
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
      element.volume = this.volume * audioMixer.gain(this.bus);
      this.playbackGains.set(element, 1);
      if (typeof element.addEventListener === "function") {
        element.addEventListener("ended", () => releaseOneShot(element));
      }
      elements.push(element);
    }
    const clip: Voices = { elements, next: 0, lastPlayedMs: 0 };
    this.clips.set(id, clip);
    return clip;
  }
}
