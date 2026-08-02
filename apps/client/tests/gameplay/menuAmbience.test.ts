import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MenuAmbience } from "../../src/audio/MenuAmbience";
import { setMasterVolume } from "../../src/forge/AudioPlayer";
import type { BedId, BedVoice } from "../../src/gameplay/AmbienceController";

/**
 * The menu's beds, driven on a fake clock with no audio device. `BedVoice`
 * stands in for playback, so what these check is which beds open, how loudly,
 * and — the part that actually matters — that they are all released when the
 * player leaves the menu. A bed left running under a round is two shops at once
 * and nothing in the round would ever close it.
 */

interface FakeVoice extends BedVoice {
  readonly bedId: BedId;
  gain: number;
  stopped: boolean;
}

function harness() {
  const created: FakeVoice[] = [];
  const ambience = new MenuAmbience((bedId) => {
    const voice: FakeVoice = {
      bedId,
      gain: 0,
      stopped: false,
      setGain(gain) {
        voice.gain = gain;
      },
      update() {},
      stop() {
        voice.stopped = true;
      },
    };
    created.push(voice);
    return voice;
  });
  return { ambience, created };
}

beforeEach(() => {
  vi.useFakeTimers();
  setMasterVolume(1);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("menu ambience", () => {
  it("opens the room tone and the candle together", () => {
    const { ambience, created } = harness();
    ambience.start();
    expect(created.map((voice) => voice.bedId)).toEqual([
      "amb_shop_room_tone",
      "amb_candle_flicker",
    ]);
  });

  it("fades in rather than switching on", () => {
    const { ambience, created } = harness();
    ambience.start();
    vi.advanceTimersByTime(100);
    const early = created[0]?.gain ?? 0;
    expect(early).toBeGreaterThan(0);
    // A tenth of a second into a two second fade is a long way from open.
    expect(early).toBeLessThan(0.1);

    vi.advanceTimersByTime(3_000);
    expect(ambience.level0to1).toBe(1);
    expect(created[0]?.gain ?? 0).toBeGreaterThan(0.3);
  });

  it("starting twice does not stack a second set of beds", () => {
    const { ambience, created } = harness();
    ambience.start();
    ambience.start();
    expect(created).toHaveLength(2);
  });

  it("releases every bed once the fade out finishes", () => {
    const { ambience, created } = harness();
    ambience.start();
    vi.advanceTimersByTime(3_000);
    ambience.stop();
    expect(ambience.running).toBe(false);

    vi.advanceTimersByTime(1_000);
    expect(created.every((voice) => voice.stopped)).toBe(true);
    expect(ambience.level0to1).toBe(0);
  });

  it("scales with the master volume the rest of the game uses", () => {
    const { ambience, created } = harness();
    ambience.start();
    vi.advanceTimersByTime(3_000);
    const full = created[0]?.gain ?? 0;

    setMasterVolume(0.5);
    vi.advanceTimersByTime(50);
    expect(created[0]?.gain ?? 0).toBeCloseTo(full / 2, 3);
  });

  it("comes back after being stopped, without leaking the beds it had", () => {
    const { ambience, created } = harness();
    ambience.start();
    vi.advanceTimersByTime(3_000);
    ambience.stop();
    vi.advanceTimersByTime(1_000);

    ambience.start();
    expect(created).toHaveLength(4);
    expect(created.slice(0, 2).every((voice) => voice.stopped)).toBe(true);
    expect(created.slice(2).every((voice) => voice.stopped)).toBe(false);
  });

  it("stops cleanly when disposed mid-fade", () => {
    const { ambience, created } = harness();
    ambience.start();
    vi.advanceTimersByTime(200);
    ambience.dispose();
    expect(created.every((voice) => voice.stopped)).toBe(true);
    // A disposed controller stays closed however often it is asked to open.
    ambience.start();
    expect(created).toHaveLength(2);
  });
});
