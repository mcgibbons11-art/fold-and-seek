import { audioMixer, type AudioPriority } from "./AudioMixer";
import { audioRuntime } from "./AudioRuntime";

export interface LoopingSoundVoiceOptions {
  readonly baseUrl?: string;
  readonly bus?: "gameplay" | "ui";
  readonly volume?: number;
  readonly priority?: AudioPriority;
}

/** A single gapless, bounded texture for a held gesture such as spray or drag. */
export class LoopingSoundVoice {
  private readonly element: HTMLAudioElement;
  private readonly bus: "gameplay" | "ui";
  private readonly volume: number;
  private readonly priority: AudioPriority;
  private readonly unsubscribe: () => void;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private requestedGain = 0;

  constructor(id: string, options: LoopingSoundVoiceOptions = {}) {
    const base = options.baseUrl ?? import.meta.env.BASE_URL;
    const prefix = base.endsWith("/") ? base : `${base}/`;
    this.element = new Audio(`${prefix}assets/audio/sfx/${id}.mp3`);
    this.element.preload = "auto";
    this.element.loop = true;
    this.bus = options.bus ?? "gameplay";
    this.volume = Math.min(1, Math.max(0, options.volume ?? 0.45));
    this.priority = options.priority ?? "low";
    this.unsubscribe = audioMixer.subscribe(() => this.applyGain());
  }

  get active(): boolean {
    return !this.element.paused;
  }

  start(gain = 1, playbackRate = 1): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.requestedGain = Math.min(1, Math.max(0, gain));
    this.element.playbackRate = Math.min(1.35, Math.max(0.75, playbackRate));
    this.applyGain();
    if (!this.element.paused) return;
    if (!audioMixer.reserve(this.element, this.bus, this.priority, "texture")) return;
    audioRuntime.play(this.element);
  }

  update(gain: number, playbackRate: number): void {
    this.requestedGain = Math.min(1, Math.max(0, gain));
    this.element.playbackRate = Math.min(1.35, Math.max(0.75, playbackRate));
    this.applyGain();
  }

  /** A very short tail removes the release click and still ends inside 80 ms. */
  stop(): void {
    if (this.stopTimer !== null || this.element.paused) return;
    this.element.volume = 0;
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      this.element.pause();
      this.element.currentTime = 0;
      audioMixer.release(this.element);
    }, 55);
  }

  dispose(): void {
    if (this.stopTimer !== null) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    audioMixer.release(this.element);
    audioRuntime.forget(this.element);
    this.element.pause();
    this.element.removeAttribute("src");
    this.unsubscribe();
  }

  private applyGain(): void {
    this.element.volume = Math.min(1, this.volume * this.requestedGain * audioMixer.gain(this.bus));
  }
}
