import type { WatchedLevel } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";

import { getAudioBusGain } from "./AudioMixer";
import { audioRuntime } from "./AudioRuntime";

/**
 * The score, synthesised rather than recorded.
 *
 * Two reasons for generating it. The bundle already carries sixty audio files
 * and the ElevenLabs key the rest of the soundscape was made with has no
 * music permission at all, so there is no recorded score to ship. And the
 * states the music has to cover are not six moods to crossfade between, they
 * are one shop under different pressure: a generated score can change tempo,
 * harmony and density on the next sixteenth instead of fading one recording
 * into another.
 *
 * What that trades away is timbre. Sine partials through an envelope are a
 * music box the way a stick figure is a portrait. That is the honest cost.
 *
 * Everything is drawn from one seven-note collection, A natural minor, so the
 * scenes share a key and moving between them is a change of weight rather than
 * a change of world. The reveal is the same seven notes heard from C, its
 * relative major, which is why the payoff can sound like an arrival without
 * modulating anywhere the ear has to follow.
 */

/** A2. Every pitch in the score is this times a power of two times a scale step. */
const ROOT_HZ = 110;
/** Semitone offsets of the natural minor scale, indexed by scale degree. */
const SCALE = [0, 2, 3, 5, 7, 8, 10] as const;
const STEPS_PER_BAR = 16;

export type MusicScene =
  | "silent"
  | "menu"
  | "forge"
  | "hunt"
  | "watched_low"
  | "watched_high"
  | "reveal";

/**
 * The four voices. `pad` and `bass` carry the harmony, `pluck` is the music box
 * that the shop is full of, and `clock` is the one unpitched layer: a short
 * band of noise standing in for a movement somewhere in the room.
 */
export type MusicLayer = "pad" | "bass" | "pluck" | "clock";

/** The pitched layers, which is every layer whose `hz` is a note. */
export const PITCHED_LAYERS: readonly MusicLayer[] = ["pad", "bass", "pluck"];

interface Scene {
  readonly bpm: number;
  /** Scale degree of the triad in each bar of the loop. */
  readonly bars: readonly number[];
  /** Absolute output peak of each layer, chord and all. Zero silences it. */
  readonly peaks: Readonly<Record<MusicLayer, number>>;
  /** Where the pad's lowpass sits, in Hz. */
  readonly colourHz: number;
  /** Sixteenth-note positions within a bar that each layer plays on. */
  readonly bassSteps: readonly number[];
  readonly pluckSteps: readonly number[];
  readonly clockSteps: readonly number[];
}

/**
 * Bar degrees read as triads of the minor scale, built by stacking scale
 * degrees rather than semitones, so every chord is inside the collection by
 * construction: 0 is i (A minor), 1 is ii diminished (B), 2 is III (C), 4 is v
 * (E minor), 5 is VI (F), 6 is VII (G).
 *
 * - menu waits. Two chords over four bars, no clock, a music-box note twice a
 *   bar, and a tempo slow enough that nothing feels started yet.
 * - forge is exactly twice the menu tempo, so the cut into the fold lands on a
 *   beat the player has already been hearing. It carries no clock layer: the
 *   shop supplies its own ticking, from the clock-wall bed and from the Forge's
 *   tinkering bed, and a second tick over the top of those would be the score
 *   arguing with the room. A beat of half a second is a simple ratio to a
 *   one-second tick rather than a rate close enough to beat slowly against it,
 *   which is as much as can be said without measuring what the beds actually
 *   tick at; the industry is in the density of the plucks, not in the tempo.
 * - hunt drops back to the menu's tempo and takes away the music box: a low
 *   pad, a bass note a bar, and the clock marking the halves. It is the
 *   sparsest scene in the piece.
 * - watched_low and watched_high are the hunt under a hider being looked at.
 *   Same tempo and same register, more events: the lift has to read as pressure
 *   rather than as a different piece starting. The high level is also the only
 *   scene that leans on the diminished chord, which is where the dissonance
 *   comes from without leaving the seven notes.
 * - reveal is the same collection heard from C: III-VI-VII-III is I-IV-V-I in
 *   the relative major, at the one tempo that is neither the menu's nor the
 *   forge's, with the music box on every other sixteenth.
 */
const SCENES: Readonly<Record<Exclude<MusicScene, "silent">, Scene>> = {
  menu: {
    bpm: 60,
    bars: [0, 0, 5, 5],
    peaks: { pad: 0.02, bass: 0.012, pluck: 0.015, clock: 0 },
    colourHz: 820,
    bassSteps: [0],
    pluckSteps: [6, 13],
    clockSteps: [],
  },
  forge: {
    bpm: 120,
    bars: [0, 5, 2, 6],
    peaks: { pad: 0.014, bass: 0.016, pluck: 0.018, clock: 0 },
    colourHz: 1_400,
    bassSteps: [0, 6, 8, 14],
    pluckSteps: [0, 3, 6, 10, 13],
    clockSteps: [],
  },
  hunt: {
    bpm: 60,
    bars: [0, 4],
    peaks: { pad: 0.022, bass: 0.016, pluck: 0, clock: 0.01 },
    colourHz: 460,
    bassSteps: [0],
    pluckSteps: [],
    clockSteps: [0, 8],
  },
  watched_low: {
    bpm: 60,
    bars: [0, 4],
    peaks: { pad: 0.022, bass: 0.018, pluck: 0.012, clock: 0.012 },
    colourHz: 700,
    bassSteps: [0, 8],
    pluckSteps: [12],
    clockSteps: [0, 4, 8, 12],
  },
  watched_high: {
    bpm: 60,
    bars: [0, 1],
    peaks: { pad: 0.022, bass: 0.02, pluck: 0.016, clock: 0.014 },
    colourHz: 1_100,
    bassSteps: [0, 4, 8, 12],
    pluckSteps: [2, 6, 10, 14],
    clockSteps: [0, 2, 4, 6, 8, 10, 12, 14],
  },
  reveal: {
    bpm: 90,
    bars: [2, 5, 6, 2],
    peaks: { pad: 0.018, bass: 0.016, pluck: 0.022, clock: 0 },
    colourHz: 2_400,
    bassSteps: [0, 6, 8, 14],
    pluckSteps: [0, 2, 4, 6, 8, 10, 12, 14],
    clockSteps: [],
  },
};

/** Root, third and fifth: the scale degrees a triad is built from. */
const TRIAD = [0, 2, 4] as const;

/** Scheduler cadence and how far past it notes are placed. */
const TICK_MS = 25;
const LOOKAHEAD_SECONDS = 0.35;
/** Past this the scheduler has been asleep, so it restarts on the next bar. */
const RESYNC_SECONDS = 0.5;
/**
 * How long after a scene change the new scene's first step falls. The switch
 * ducks the bus over roughly this long, so the chord left hanging from the old
 * scene is pulled down rather than chopped.
 */
const SWITCH_LEAD_SECONDS = 0.12;
const SWITCH_DUCK_STRENGTH = 0.9;

/**
 * The whole score's trim, under the ambience beds. The beds are R128-normalised
 * recordings played at channel gains of 0.3 to 0.55; the score is a handful of
 * sine and triangle voices whose absolute peaks are set per layer above, and
 * those peaks are the knob if it turns out to sit wrong against them.
 */
const MUSIC_LEVEL = 0.9;

/** The unpitched clock layer's band, in Hz. */
const CLOCK_BAND_HZ = 2_400;

/** One note the score wants played. Times are on the audio device's clock. */
export interface MusicNote {
  readonly layer: MusicLayer;
  /** The pitch, or for the unpitched clock layer the centre of its band. */
  readonly hz: number;
  readonly at: number;
  readonly seconds: number;
  /** Absolute output peak, summed across whatever partials the voice uses. */
  readonly peak: number;
  /** Where the pad's lowpass sits. The other layers have their own colour. */
  readonly colourHz: number;
}

/**
 * Where the score goes. The engine decides what is played and when; this plays
 * it. Splitting them is what lets the scheduler and the scene table be driven
 * in a test with no audio device, which is the whole of the musical logic.
 */
export interface MusicSink {
  /** Seconds on the audio clock, or null while the device is not running. */
  now(): number | null;
  play(note: MusicNote): void;
  /** The bus level, for the master volume. */
  setLevel(value: number, at: number): void;
  /** Pushes the score down under something louder. 0 is no duck, 1 is full. */
  duck(strength: number, at: number): void;
  stop(): void;
}

/** Scale degrees are diatonic, so a degree of 7 is the octave, not the fifth. */
export function degreeHz(degree: number): number {
  const octave = Math.floor(degree / SCALE.length);
  const step = SCALE[degree - octave * SCALE.length] ?? 0;
  return ROOT_HZ * 2 ** (octave + step / 12);
}

/** True when a frequency is a note of the collection, in any octave. */
export function isInCollection(hz: number): boolean {
  const semitones = Math.round(12 * Math.log2(hz / ROOT_HZ));
  const step = ((semitones % 12) + 12) % 12;
  return (SCALE as readonly number[]).includes(step);
}

/** Seconds a bar of a scene lasts, which a test needs to count a bar's events. */
export function sceneBarSeconds(scene: Exclude<MusicScene, "silent">): number {
  return (60 / SCENES[scene].bpm / 4) * STEPS_PER_BAR;
}

/** Phases the shop is being hunted through. */
const HUNT_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.InspectionIntro,
  MatchPhase.Inspection,
  MatchPhase.FinalCountdown,
]);

/** Phases at the workbench. */
const FORGE_PHASES: ReadonlySet<MatchPhase> = new Set([MatchPhase.Forge, MatchPhase.Locking]);

/** Phases after the hunt, which the payoff plays under. */
const PAYOFF_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.Reveal,
  MatchPhase.Results,
  MatchPhase.RematchVote,
]);

/** The hunt scene for each level of the Being Watched meter. */
const WATCHED_SCENES: Readonly<Record<WatchedLevel, MusicScene>> = {
  0: "hunt",
  1: "watched_low",
  2: "watched_high",
};

/**
 * What the score should be doing, given where the match is. Lives here rather
 * than in the round so the mapping can be tested without a browser, and so the
 * menu and the round cannot disagree about what a phase sounds like.
 *
 * The watched level only reaches the music during the hunt: a level left over
 * from the round that just ended must not press on the payoff.
 */
export function musicSceneForPhase(phase: MatchPhase, watchedLevel: WatchedLevel): MusicScene {
  if (FORGE_PHASES.has(phase)) return "forge";
  if (HUNT_PHASES.has(phase)) return WATCHED_SCENES[watchedLevel];
  if (PAYOFF_PHASES.has(phase)) return "reveal";
  if (phase === MatchPhase.Disposed) return "silent";
  return "menu";
}

/**
 * The scheduler. Nothing here touches the audio device: it works out which
 * notes fall in the next third of a second and hands them to the sink, which is
 * why every musical decision in the piece is reachable from a test.
 */
export class MusicEngine {
  private readonly sink: MusicSink;
  private current: MusicScene = "silent";
  private pending: MusicScene | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stepIndex = 0;
  private nextStepTime = 0;
  private appliedLevel = -1;

  constructor(sink: MusicSink) {
    this.sink = sink;
  }

  get scene(): MusicScene {
    return this.pending ?? this.current;
  }

  /**
   * Points the score at a scene. Asking for what is already playing is a no-op,
   * which matters because the round calls this every frame; only a change
   * starts a switch.
   */
  setScene(scene: MusicScene): void {
    if (scene === this.scene) return;
    this.pending = scene;
    if (scene !== "silent" && this.timer === null) {
      this.timer = setInterval(() => {
        this.tick();
      }, TICK_MS);
    }
  }

  /**
   * Pushes the score down so a stinger owns its moment. Taking the deeper of
   * the two means a second hit inside the first ducks further rather than
   * releasing early, which is left to the sink.
   */
  duck(strength: number): void {
    const now = this.sink.now();
    if (now === null || this.current === "silent") return;
    this.sink.duck(strength, now);
  }

  /** Stops scheduling. Notes already placed play out under the closing bus. */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.current = "silent";
    this.pending = null;
    this.appliedLevel = -1;
    this.sink.stop();
  }

  /**
   * One pass of the scheduler. Called by the engine's own timer; a test drives
   * it directly, which is why it is not private.
   */
  tick(): void {
    // Nothing is scheduled against a device that is not running: its clock is
    // frozen, so every note would land at the same instant and arrive as one
    // chord the moment the player finally touches the page.
    const now = this.sink.now();
    if (now === null) return;

    if (this.pending !== null) this.switch(now);
    if (this.current === "silent") return;

    const scene = SCENES[this.current];
    const stepSeconds = 60 / scene.bpm / 4;

    // Asleep in a background tab, or resumed after an interruption: start again
    // at the top of a bar instead of firing every step it slept through.
    if (this.nextStepTime < now - RESYNC_SECONDS) {
      this.nextStepTime = now + TICK_MS / 1_000;
      this.stepIndex = Math.ceil(this.stepIndex / STEPS_PER_BAR) * STEPS_PER_BAR;
    }
    if (this.nextStepTime < now) this.nextStepTime = now;

    while (this.nextStepTime < now + LOOKAHEAD_SECONDS) {
      this.step(this.stepIndex, this.nextStepTime, scene, stepSeconds);
      this.stepIndex += 1;
      this.nextStepTime += stepSeconds;
    }

    const level = MUSIC_LEVEL * getAudioBusGain("music");
    if (Math.abs(level - this.appliedLevel) > 1e-4) {
      this.appliedLevel = level;
      this.sink.setLevel(level, now);
    }
  }

  private switch(now: number): void {
    const next = this.pending ?? "silent";
    this.pending = null;
    this.current = next;
    if (next === "silent") {
      this.stop();
      return;
    }
    // The cut lands on a bar line of the new tempo, and the bus dips through it
    // rather than the old scene's chord being chopped where it stands.
    this.stepIndex = 0;
    this.nextStepTime = now + SWITCH_LEAD_SECONDS;
    this.sink.duck(SWITCH_DUCK_STRENGTH, now);
    this.sink.setLevel(MUSIC_LEVEL * getAudioBusGain("music"), now);
    this.appliedLevel = MUSIC_LEVEL * getAudioBusGain("music");
  }

  private step(index: number, at: number, scene: Scene, stepSeconds: number): void {
    const bar = Math.floor(index / STEPS_PER_BAR) % scene.bars.length;
    const position = index % STEPS_PER_BAR;
    const root = scene.bars[bar] ?? 0;

    if (position === 0 && scene.peaks.pad > 0) {
      // The chord is three notes rather than one note the sink stacks a triad
      // over, because a triad is built from scale degrees and not from a fixed
      // pattern of semitones: the same shape over F is a major third and over A
      // a minor one. Sending the degrees keeps every pitch in the collection by
      // construction and leaves the sink with nothing to work out.
      const seconds = stepSeconds * STEPS_PER_BAR;
      for (const interval of TRIAD) {
        this.emit("pad", degreeHz(root + 7 + interval), at, seconds, scene, scene.peaks.pad / TRIAD.length);
      }
    }
    if (scene.peaks.bass > 0 && scene.bassSteps.includes(position)) {
      // At the root octave rather than below it: an A1 bass is inaudible on the
      // laptop speakers most of this is going to be heard through.
      this.emit("bass", degreeHz(root), at, stepSeconds * 1.8, scene, scene.peaks.bass);
    }
    if (scene.peaks.pluck > 0 && scene.pluckSteps.includes(position)) {
      // Walk the triad rather than repeating the root, so a music box on every
      // other sixteenth reads as an arpeggio.
      const tone = TRIAD[Math.floor(index / 2) % TRIAD.length] ?? 0;
      this.emit("pluck", degreeHz(root + 14 + tone), at, 1.1, scene, scene.peaks.pluck);
    }
    if (scene.peaks.clock > 0 && scene.clockSteps.includes(position)) {
      this.emit("clock", CLOCK_BAND_HZ, at, 0.08, scene, scene.peaks.clock);
    }
  }

  private emit(
    layer: MusicLayer,
    hz: number,
    at: number,
    seconds: number,
    scene: Scene,
    peak: number,
  ): void {
    this.sink.play({ layer, hz, at, seconds, peak, colourHz: scene.colourHz });
  }
}

// ---------------------------------------------------------------------------
// The WebAudio sink
// ---------------------------------------------------------------------------

/** Floor for the exponential ramps, which cannot reach zero. */
const SILENT_GAIN = 0.0001;
/** Two voices a few cents apart, which is what stops a pad sounding like a beep. */
const PAD_DETUNE = [0.997, 1.003] as const;
/**
 * A music box's partials. The fourth is what makes it a music box rather than a
 * bell, and the slight stretch on it is what stops the three sines fusing into
 * one tone. Amplitudes are relative and are normalised against their own sum,
 * so the note's peak means the same thing it does for every other layer.
 */
const PLUCK_PARTIALS: readonly { readonly ratio: number; readonly amp: number; readonly decay: number }[] =
  [
    { ratio: 1, amp: 1, decay: 1 },
    { ratio: 2, amp: 0.42, decay: 0.55 },
    { ratio: 4.02, amp: 0.16, decay: 0.3 },
  ];
const PLUCK_AMP_SUM = PLUCK_PARTIALS.reduce((sum, partial) => sum + partial.amp, 0);

const DUCK_DEPTH = 0.55;
const DUCK_ATTACK_SECONDS = 0.03;
const DUCK_RELEASE_SECONDS = 0.45;
const LEVEL_GLIDE_SECONDS = 0.05;
const NOISE_SECONDS = 0.3;

class WebAudioMusicSink implements MusicSink {
  private readonly context: AudioContext;
  private readonly bus: GainNode;
  private readonly ducker: GainNode;
  private readonly level: GainNode;
  private readonly delay: DelayNode;
  private readonly send: GainNode;
  private noise: AudioBuffer | null = null;

  constructor(context: AudioContext) {
    this.context = context;
    audioRuntime.registerContext(context);
    this.bus = context.createGain();
    this.ducker = context.createGain();
    this.level = context.createGain();
    this.level.gain.value = 0;
    this.bus.connect(this.ducker).connect(this.level).connect(context.destination);

    // A dotted-eighth feedback delay under the music box. It is the only thing
    // in the graph doing the job the shop's own reverberation would.
    this.delay = context.createDelay(1);
    this.delay.delayTime.value = 0.28;
    this.send = context.createGain();
    this.send.gain.value = 0.3;
    const regeneration = context.createGain();
    regeneration.gain.value = 0.26;
    const damping = context.createBiquadFilter();
    damping.type = "lowpass";
    damping.frequency.value = 2_600;
    this.send.connect(this.delay);
    this.delay.connect(damping).connect(regeneration).connect(this.delay);
    this.delay.connect(this.ducker);
  }

  now(): number | null {
    if (this.context.state === "running") return this.context.currentTime;
    return null;
  }

  setLevel(value: number, at: number): void {
    this.level.gain.setTargetAtTime(Math.max(0, value), at, LEVEL_GLIDE_SECONDS);
  }

  duck(strength: number, at: number): void {
    const floor = 1 - DUCK_DEPTH * Math.min(Math.max(strength, 0), 1);
    const gain = this.ducker.gain;
    gain.cancelScheduledValues(at);
    // The deeper of the two, so a second hit inside the release of the first
    // ducks further rather than releasing early.
    gain.setValueAtTime(Math.min(gain.value, floor), at);
    gain.linearRampToValueAtTime(floor, at + DUCK_ATTACK_SECONDS);
    gain.linearRampToValueAtTime(1, at + DUCK_ATTACK_SECONDS + DUCK_RELEASE_SECONDS);
  }

  play(note: MusicNote): void {
    if (note.peak <= 0) return;
    switch (note.layer) {
      case "pad":
        this.pad(note);
        break;
      case "bass":
        this.bass(note);
        break;
      case "pluck":
        this.pluck(note);
        break;
      case "clock":
        this.clock(note);
        break;
    }
  }

  /**
   * Closes the bus over the notes already placed. The graph survives it: the
   * score is silenced between a round and the menu many times in a session, and
   * a sink that could only be stopped once would leave the menu quiet for the
   * rest of the page's life.
   */
  stop(): void {
    this.level.gain.setTargetAtTime(0, this.context.currentTime, 0.06);
  }

  private pad(note: MusicNote): void {
    // Two detuned oscillators sum into one envelope, so the envelope carries
    // half the note's peak and `peak` means what it does for every other layer.
    const peak = note.peak / PAD_DETUNE.length;
    const attack = Math.min(0.6, note.seconds * 0.35);
    const release = note.seconds * 0.4;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(SILENT_GAIN, note.at);
    envelope.gain.exponentialRampToValueAtTime(peak, note.at + attack);
    envelope.gain.setValueAtTime(peak, note.at + note.seconds);
    envelope.gain.exponentialRampToValueAtTime(SILENT_GAIN, note.at + note.seconds + release);
    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = note.colourHz;
    filter.Q.value = 0.7;
    envelope.connect(filter).connect(this.bus);

    for (const ratio of PAD_DETUNE) {
      const oscillator = this.context.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.value = note.hz * ratio;
      oscillator.connect(envelope);
      oscillator.start(note.at);
      oscillator.stop(note.at + note.seconds + release + 0.05);
    }
  }

  private bass(note: MusicNote): void {
    const oscillator = this.context.createOscillator();
    // Triangle rather than a sawtooth: the shop is felt and wood, and a saw
    // through the same filter reads as a synthesiser in a room that has none.
    oscillator.type = "triangle";
    oscillator.frequency.value = note.hz;
    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(900, note.at);
    filter.frequency.exponentialRampToValueAtTime(180, note.at + note.seconds);
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(SILENT_GAIN, note.at);
    envelope.gain.exponentialRampToValueAtTime(note.peak, note.at + 0.02);
    envelope.gain.exponentialRampToValueAtTime(SILENT_GAIN, note.at + note.seconds);
    oscillator.connect(filter).connect(envelope).connect(this.bus);
    oscillator.start(note.at);
    oscillator.stop(note.at + note.seconds + 0.02);
  }

  private pluck(note: MusicNote): void {
    for (const partial of PLUCK_PARTIALS) {
      const peak = (note.peak * partial.amp) / PLUCK_AMP_SUM;
      const oscillator = this.context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = note.hz * partial.ratio;
      const seconds = note.seconds * partial.decay;
      const envelope = this.context.createGain();
      envelope.gain.setValueAtTime(SILENT_GAIN, note.at);
      envelope.gain.exponentialRampToValueAtTime(peak, note.at + 0.004);
      envelope.gain.exponentialRampToValueAtTime(SILENT_GAIN, note.at + seconds);
      oscillator.connect(envelope);
      envelope.connect(this.bus);
      envelope.connect(this.send);
      oscillator.start(note.at);
      oscillator.stop(note.at + seconds + 0.02);
    }
  }

  private clock(note: MusicNote): void {
    this.noise ??= this.createNoise();
    const source = this.context.createBufferSource();
    source.buffer = this.noise;
    const filter = this.context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = note.hz;
    filter.Q.value = 6;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(SILENT_GAIN, note.at);
    envelope.gain.exponentialRampToValueAtTime(note.peak, note.at + 0.003);
    envelope.gain.exponentialRampToValueAtTime(SILENT_GAIN, note.at + note.seconds);
    source.connect(filter).connect(envelope).connect(this.bus);
    source.start(note.at);
    source.stop(note.at + note.seconds + 0.02);
  }

  private createNoise(): AudioBuffer {
    const frames = Math.floor(this.context.sampleRate * NOISE_SECONDS);
    const buffer = this.context.createBuffer(1, frames, this.context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < frames; index += 1) samples[index] = Math.random() * 2 - 1;
    return buffer;
  }
}

/** What the engine runs on where there is no audio device, which is every test. */
const SILENT_SINK: MusicSink = {
  now: () => null,
  play: () => {},
  setLevel: () => {},
  duck: () => {},
  stop: () => {},
};

let engine: MusicEngine | null = null;

/**
 * The one score. There is a menu and a round and each of them decides what the
 * music should be doing, and two engines running at once would be two pieces
 * playing over each other, so the instance is shared the way the master volume
 * already is rather than owned by either of them.
 */
export function getMusicEngine(): MusicEngine {
  if (engine !== null) return engine;
  const Context: typeof AudioContext | undefined =
    typeof window === "undefined" ? undefined : window.AudioContext;
  engine = new MusicEngine(Context === undefined ? SILENT_SINK : new WebAudioMusicSink(new Context()));
  return engine;
}
