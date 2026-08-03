export type AudioBus = "master" | "music" | "ambience" | "gameplay" | "ui";

export type AudioLevels = Readonly<Record<AudioBus, number>>;

export type AudioPriority = "background" | "low" | "normal" | "important" | "critical";
export type AudioCategory = "general" | "footsteps" | "texture" | "weapon" | "results" | "ui";

const STORAGE_KEY = "foldseek.audio.v2";
const DEFAULT_LEVELS: AudioLevels = {
  master: 1,
  music: 0.8,
  ambience: 0.9,
  gameplay: 1,
  ui: 0.9,
};

const PRIORITY_VALUE: Readonly<Record<AudioPriority, number>> = {
  background: 0,
  low: 20,
  normal: 40,
  important: 70,
  critical: 100,
};

const BUS_BUDGET: Readonly<Record<Exclude<AudioBus, "master" | "music" | "ambience">, number>> = {
  gameplay: 16,
  ui: 5,
};

const CATEGORY_BUDGET: Readonly<Record<AudioCategory, number>> = {
  general: 8,
  footsteps: 6,
  texture: 2,
  weapon: 4,
  results: 3,
  ui: 5,
};

interface Voice {
  readonly element: HTMLAudioElement;
  readonly bus: "gameplay" | "ui";
  readonly priority: number;
  readonly order: number;
  readonly category: AudioCategory;
}

function clamp(value: unknown, fallback = 1): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

export function resolveStoredAudioLevels(
  savedRaw: string | null | undefined,
  legacyRaw: string | null | undefined,
): AudioLevels {
  try {
    // Number(null) is zero. Treating a missing legacy preference as that number
    // silently muted every fresh profile, including a new Portals iframe.
    const legacy = legacyRaw === null || legacyRaw === undefined ? Number.NaN : Number(legacyRaw);
    const saved = savedRaw === null || savedRaw === undefined
      ? {}
      : JSON.parse(savedRaw) as Partial<AudioLevels>;
    return {
      master: clamp(saved.master, Number.isFinite(legacy) ? legacy : DEFAULT_LEVELS.master),
      music: clamp(saved.music, DEFAULT_LEVELS.music),
      ambience: clamp(saved.ambience, DEFAULT_LEVELS.ambience),
      gameplay: clamp(saved.gameplay, DEFAULT_LEVELS.gameplay),
      ui: clamp(saved.ui, DEFAULT_LEVELS.ui),
    };
  } catch {
    return DEFAULT_LEVELS;
  }
}

function loadLevels(): AudioLevels {
  try {
    return resolveStoredAudioLevels(
      globalThis.localStorage?.getItem(STORAGE_KEY),
      globalThis.localStorage?.getItem("foldseek.masterVolume"),
    );
  } catch {
    return DEFAULT_LEVELS;
  }
}

/** Shared bus state and transient voice policy for every audio backend. */
class AudioMixer {
  private levels = loadLevels();
  private readonly listeners = new Set<() => void>();
  private readonly voices: Voice[] = [];
  private order = 0;
  private readonly duck = { music: 1, ambience: 1 };
  private readonly duckTimers: Partial<Record<"music" | "ambience", ReturnType<typeof setTimeout>>> = {};

  getLevels(): AudioLevels {
    return { ...this.levels };
  }

  setLevel(bus: AudioBus, value: number): void {
    this.levels = { ...this.levels, [bus]: clamp(value) };
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.levels));
      if (bus === "master") globalThis.localStorage?.setItem("foldseek.masterVolume", String(this.levels.master));
    } catch {
      // Embedded Portals rooms can deny storage. The live mix still updates.
    }
    this.notify();
  }

  gain(bus: Exclude<AudioBus, "master">): number {
    const duck = bus === "music" || bus === "ambience" ? this.duck[bus] : 1;
    return this.levels.master * this.levels[bus] * duck;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reserves a one-shot slot. A more important cue may steal the oldest lower
   * priority voice; low-value texture never cuts off a weapon or result cue.
   */
  reserve(
    element: HTMLAudioElement,
    bus: "gameplay" | "ui",
    priority: AudioPriority,
    category: AudioCategory = bus === "ui" ? "ui" : "general",
  ): boolean {
    this.release(element);
    const numericPriority = PRIORITY_VALUE[priority];
    const onBus = this.voices.filter((voice) => voice.bus === bus);
    const busFull = onBus.length >= BUS_BUDGET[bus];
    const categoryFull = this.voices.filter((voice) => voice.category === category).length >= CATEGORY_BUDGET[category];
    if (categoryFull || busFull || this.voices.length >= 16) {
      const candidates = this.voices
        .filter((voice) =>
          (!busFull || voice.bus === bus) &&
          (!categoryFull || voice.category === category) &&
          voice.priority <= numericPriority,
        )
        .sort((left, right) => left.priority - right.priority || left.order - right.order);
      const victim = candidates[0];
      if (victim === undefined) return false;
      victim.element.pause();
      victim.element.currentTime = 0;
      this.release(victim.element);
    }
    this.voices.push({ element, bus, priority: numericPriority, order: this.order++, category });
    if (bus === "gameplay" && numericPriority >= PRIORITY_VALUE.important) {
      this.requestDuck("music", numericPriority >= PRIORITY_VALUE.critical ? 0.5 : 0.3, 500);
      this.requestDuck("ambience", 0.18, 350);
    }
    return true;
  }

  release(element: HTMLAudioElement): void {
    const index = this.voices.findIndex((voice) => voice.element === element);
    if (index >= 0) this.voices.splice(index, 1);
  }

  requestDuck(bus: "music" | "ambience", depth: number, durationMs: number): void {
    this.duck[bus] = Math.min(this.duck[bus], 1 - clamp(depth, 0));
    const previous = this.duckTimers[bus];
    if (previous !== undefined) clearTimeout(previous);
    this.duckTimers[bus] = setTimeout(() => {
      this.duck[bus] = 1;
      delete this.duckTimers[bus];
      this.notify();
    }, Math.max(0, durationMs));
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const audioMixer = new AudioMixer();

export function getAudioLevels(): AudioLevels {
  return audioMixer.getLevels();
}

export function setAudioBusVolume(bus: AudioBus, value: number): void {
  audioMixer.setLevel(bus, value);
}

export function getAudioBusGain(bus: Exclude<AudioBus, "master">): number {
  return audioMixer.gain(bus);
}

export function subscribeAudioMixer(listener: () => void): () => void {
  return audioMixer.subscribe(listener);
}
