/**
 * Small pooled sound player for Forge feedback. Every clip keeps a few
 * `HTMLAudioElement`s so a rapid retrigger overlaps instead of restarting, which
 * is all the mixing the editor needs before the audio system proper arrives.
 */

const VOICES_PER_CLIP = 3;

export type ForgeSoundId =
  | "ui_click"
  | "ui_hover"
  | "ui_confirm"
  | "material_sample"
  | "anchor_snap"
  | "panel_snap"
  | "servo_move"
  | "lock_seal";

interface Voices {
  readonly elements: HTMLAudioElement[];
  next: number;
  lastPlayedMs: number;
}

export class AudioPlayer {
  private readonly clips = new Map<ForgeSoundId, Voices>();
  private readonly baseUrl: string;
  private readonly warned = new Set<string>();
  private volume: number;

  constructor(baseUrl: string = import.meta.env.BASE_URL, volume = 0.6) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.volume = volume;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(Math.max(volume, 0), 1);
    for (const clip of this.clips.values()) {
      for (const element of clip.elements) {
        element.volume = this.volume;
      }
    }
  }

  play(id: ForgeSoundId, pitchJitter = 0): void {
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
      // Browsers reject playback until the page has seen a gesture. The Forge
      // only makes sound in response to input, so a rejection here means
      // something else is wrong and is worth saying once per clip.
      if (!this.warned.has(id)) {
        this.warned.add(id);
        console.warn(`Forge audio: ${id} did not play`, error);
      }
    });
  }

  /** Plays at most once every `intervalMs`, for continuous feedback like servos. */
  playThrottled(id: ForgeSoundId, intervalMs: number, pitchJitter = 0): void {
    const clip = this.clips.get(id);
    if (clip !== undefined && performance.now() - clip.lastPlayedMs < intervalMs) {
      return;
    }
    this.play(id, pitchJitter);
  }

  dispose(): void {
    for (const clip of this.clips.values()) {
      for (const element of clip.elements) {
        element.pause();
        element.removeAttribute("src");
      }
    }
    this.clips.clear();
  }

  private load(id: ForgeSoundId): Voices {
    const existing = this.clips.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const elements: HTMLAudioElement[] = [];
    for (let i = 0; i < VOICES_PER_CLIP; i++) {
      const element = new Audio(`${this.baseUrl}assets/audio/sfx/${id}.mp3`);
      element.preload = "auto";
      element.volume = this.volume;
      elements.push(element);
    }
    const clip: Voices = { elements, next: 0, lastPlayedMs: 0 };
    this.clips.set(id, clip);
    return clip;
  }
}
