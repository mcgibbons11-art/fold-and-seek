import { describe, expect, it, vi } from "vitest";

import {
  WORLD_AMBIENCE_LANDMARKS,
  WorldAmbienceEmitters,
} from "../../src/audio/WorldAmbienceEmitters";
import type { SpatialVoice } from "../../src/audio/SpatialAudioPlayer";

describe("WorldAmbienceEmitters", () => {
  it("starts only the four directional landmarks and tears every loop down", async () => {
    const stopped: number[] = [];
    const voices: SpatialVoice[] = WORLD_AMBIENCE_LANDMARKS.map((_, index) => ({
      ended: Promise.resolve(),
      setPosition: vi.fn(),
      setGain: vi.fn(),
      stop: (fadeMs = 0) => stopped.push(fadeMs + index),
    }));
    const playAt = vi.fn(async (_id, _position, _options) => voices[playAt.mock.calls.length - 1]);
    const emitters = new WorldAmbienceEmitters({ playAt });

    await emitters.start();
    expect(playAt).toHaveBeenCalledTimes(4);
    expect(playAt.mock.calls.map((call) => call[0])).toEqual([
      "amb_clock_ticks",
      "amb_glass_hum",
      "amb_counter_paper",
      "amb_workshop_creak",
    ]);
    expect(playAt.mock.calls.every((call) => call[2]?.loop === true)).toBe(true);

    emitters.stop(150);
    expect(stopped).toHaveLength(4);
  });
});
