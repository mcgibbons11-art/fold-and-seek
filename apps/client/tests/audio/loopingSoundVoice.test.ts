import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoopingSoundVoice } from "../../src/audio/LoopingSoundVoice";

class FakeAudio {
  paused = true;
  currentTime = 0;
  playbackRate = 1;
  volume = 1;
  loop = false;
  preload = "";
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute = vi.fn();
}

describe("LoopingSoundVoice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", FakeAudio);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("holds one looping voice and ends within 80 ms", async () => {
    const voice = new LoopingSoundVoice("paint_stroke");
    voice.start(0.5, 1.1);
    await Promise.resolve();
    expect(voice.active).toBe(true);
    voice.update(0.8, 1.2);
    voice.start(0.7, 1.15);
    voice.stop();
    vi.advanceTimersByTime(55);
    expect(voice.active).toBe(false);
    voice.dispose();
  });
});
