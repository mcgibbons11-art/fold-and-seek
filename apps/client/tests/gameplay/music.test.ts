import { MatchPhase } from "@foldseek/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  degreeHz,
  isInCollection,
  MusicEngine,
  musicSceneForPhase,
  PITCHED_LAYERS,
  sceneBarSeconds,
  type MusicNote,
  type MusicScene,
  type MusicSink,
} from "../../src/audio/music";
import { setMasterVolume } from "../../src/forge/AudioPlayer";

/**
 * The score's musical logic, driven with no audio device. `MusicSink` stands in
 * for the synthesis, so what these check is which notes the engine decides on
 * and when it places them, which is the whole of the composition. The timbre —
 * whether a music box sounds like a music box — is not reachable from here and
 * is not claimed to be.
 */

interface Recorder extends MusicSink {
  readonly notes: MusicNote[];
  readonly ducks: { strength: number; at: number }[];
  readonly levels: number[];
  clock: number;
  running: boolean;
}

function harness(): { engine: MusicEngine; sink: Recorder } {
  const sink: Recorder = {
    notes: [],
    ducks: [],
    levels: [],
    clock: 100,
    running: true,
    now: () => (sink.running ? sink.clock : null),
    play: (note) => sink.notes.push(note),
    setLevel: (value) => sink.levels.push(value),
    duck: (strength, at) => sink.ducks.push({ strength, at }),
    stop: () => {
      sink.running = false;
    },
  };
  return { engine: new MusicEngine(sink), sink };
}

/**
 * Runs the scheduler over `seconds` of audio clock the way its own timer would,
 * at the same 25 ms cadence.
 */
function run(engine: MusicEngine, sink: Recorder, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.025) {
    engine.tick();
    sink.clock += 0.025;
  }
}

const HUNT_LEVELS: readonly MusicScene[] = ["hunt", "watched_low", "watched_high"];

describe("music scene mapping", () => {
  it("gives the forge, the hunt and the payoff their own scenes", () => {
    expect(musicSceneForPhase(MatchPhase.Lobby, 0)).toBe("menu");
    expect(musicSceneForPhase(MatchPhase.Forge, 0)).toBe("forge");
    expect(musicSceneForPhase(MatchPhase.Locking, 0)).toBe("forge");
    expect(musicSceneForPhase(MatchPhase.Inspection, 0)).toBe("hunt");
    expect(musicSceneForPhase(MatchPhase.Reveal, 0)).toBe("reveal");
    expect(musicSceneForPhase(MatchPhase.Results, 0)).toBe("reveal");
    expect(musicSceneForPhase(MatchPhase.Disposed, 0)).toBe("silent");
  });

  it("lifts the hunt with the watched meter", () => {
    expect(musicSceneForPhase(MatchPhase.Inspection, 1)).toBe("watched_low");
    expect(musicSceneForPhase(MatchPhase.FinalCountdown, 2)).toBe("watched_high");
  });

  it("leaves the payoff alone whatever the meter last read", () => {
    // A watched level left over from the hunt that just ended must not press on
    // the results.
    expect(musicSceneForPhase(MatchPhase.Results, 2)).toBe("reveal");
    expect(musicSceneForPhase(MatchPhase.RematchVote, 2)).toBe("reveal");
  });
});

describe("the collection", () => {
  it("maps a diatonic degree rather than a semitone", () => {
    // Seven degrees is the octave, not the fifth.
    expect(degreeHz(0)).toBeCloseTo(110, 6);
    expect(degreeHz(7)).toBeCloseTo(220, 6);
    expect(degreeHz(2)).toBeCloseTo(110 * 2 ** (3 / 12), 6);
  });

  it("rejects a pitch outside the seven notes", () => {
    expect(isInCollection(degreeHz(4))).toBe(true);
    // C sharp, the one degree A natural minor does not contain.
    expect(isInCollection(110 * 2 ** (4 / 12))).toBe(false);
  });
});

describe("MusicEngine", () => {
  // The engine drives itself on an interval once a scene is set. These drive
  // `tick` by hand against a clock they own, so the real one is held still.
  beforeEach(() => {
    vi.useFakeTimers();
    setMasterVolume(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules nothing while the device is not running", () => {
    const { engine, sink } = harness();
    sink.running = false;
    engine.setScene("forge");
    run(engine, sink, 2);

    expect(sink.notes).toHaveLength(0);
  });

  it("plays only pitches from the collection, in every scene", () => {
    for (const scene of ["menu", "forge", "hunt", "watched_low", "watched_high", "reveal"] as const) {
      const { engine, sink } = harness();
      engine.setScene(scene);
      run(engine, sink, 20);

      const pitched = sink.notes.filter((note) => PITCHED_LAYERS.includes(note.layer));
      expect(pitched.length).toBeGreaterThan(0);
      for (const note of pitched) {
        expect(isInCollection(note.hz), `${scene} played ${note.hz} Hz on ${note.layer}`).toBe(true);
      }
    }
  });

  it("places every note inside the lookahead and never in the past", () => {
    const { engine, sink } = harness();
    engine.setScene("forge");
    const start = sink.clock;
    run(engine, sink, 4);

    expect(sink.notes.length).toBeGreaterThan(0);
    for (const note of sink.notes) {
      expect(note.at).toBeGreaterThanOrEqual(start);
      expect(note.at).toBeLessThanOrEqual(sink.clock + 0.4);
    }
  });

  it("lands a scene change on the new scene's own step grid", () => {
    const { engine, sink } = harness();
    engine.setScene("hunt");
    run(engine, sink, 3);
    const switchAt = sink.clock;
    sink.notes.length = 0;

    engine.setScene("reveal");
    run(engine, sink, 6);

    const stepSeconds = 60 / 90 / 4;
    const first = sink.notes[0];
    expect(first).toBeDefined();
    // Nothing from the new scene arrives before the dip that covers the cut.
    expect(first?.at).toBeGreaterThan(switchAt);
    for (const note of sink.notes) {
      const steps = ((note.at ?? 0) - (first?.at ?? 0)) / stepSeconds;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
    }
  });

  it("ducks the bus through a scene change", () => {
    const { engine, sink } = harness();
    engine.setScene("forge");
    run(engine, sink, 1);
    sink.ducks.length = 0;

    engine.setScene("hunt");
    run(engine, sink, 0.5);

    expect(sink.ducks).toHaveLength(1);
    expect(sink.ducks[0]?.strength).toBeGreaterThan(0.5);
  });

  it("raises the density of the hunt with each step of the watched meter", () => {
    const counts = HUNT_LEVELS.map((scene) => {
      const { engine, sink } = harness();
      const start = sink.clock;
      engine.setScene(scene);
      // Four bars, so a two-bar loop is counted whole and the count is honest.
      const window = sceneBarSeconds(scene) * 4;
      run(engine, sink, window + 1);
      return sink.notes.filter((note) => note.at < start + window).length;
    });

    expect(counts[0]).toBeLessThan(counts[1] ?? 0);
    expect(counts[1]).toBeLessThan(counts[2] ?? 0);
  });

  it("brings the music box in as the meter rises and never takes it away", () => {
    const plucks = HUNT_LEVELS.map((scene) => {
      const { engine, sink } = harness();
      engine.setScene(scene);
      run(engine, sink, 20);
      return sink.notes.filter((note) => note.layer === "pluck").length;
    });

    expect(plucks[0]).toBe(0);
    expect(plucks[1]).toBeGreaterThan(0);
    expect(plucks[2]).toBeGreaterThan(plucks[1] ?? 0);
  });

  it("restarts on a bar line after the tab has been asleep", () => {
    const { engine, sink } = harness();
    engine.setScene("watched_high");
    run(engine, sink, 2);
    const before = sink.notes.length;

    // Thirty seconds of frozen scheduler, which is a backgrounded tab.
    sink.clock += 30;
    engine.tick();

    // One lookahead's worth of notes, not thirty seconds of them fired at once.
    expect(sink.notes.length - before).toBeLessThan(20);
    const late = sink.notes.slice(before);
    for (const note of late) expect(note.at).toBeGreaterThanOrEqual(sink.clock);
  });

  it("carries the master volume onto the bus", () => {
    const { engine, sink } = harness();
    engine.setScene("menu");
    run(engine, sink, 0.5);
    const full = sink.levels.at(-1) ?? 0;

    setMasterVolume(0.5);
    run(engine, sink, 0.5);

    expect(full).toBeGreaterThan(0);
    expect(sink.levels.at(-1)).toBeCloseTo(full * 0.5, 6);
  });

  it("holds the bus level steady rather than re-writing it every tick", () => {
    const { engine, sink } = harness();
    engine.setScene("menu");
    run(engine, sink, 2);

    // One for the scene change and nothing after it, because nothing changed.
    expect(sink.levels).toHaveLength(1);
  });

  it("stops scheduling when the score is silenced", () => {
    const { engine, sink } = harness();
    engine.setScene("forge");
    run(engine, sink, 2);
    expect(sink.notes.length).toBeGreaterThan(0);

    engine.setScene("silent");
    engine.tick();
    const after = sink.notes.length;
    run(engine, sink, 4);

    expect(engine.scene).toBe("silent");
    expect(sink.notes).toHaveLength(after);
  });
});
