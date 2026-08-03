import { describe, expect, it } from "vitest";

import {
  MIMIC_DEATH_PLAYBACK_RATE,
  mimicActionPlaybackSeconds,
} from "../../src/forge/MixamoMotion";

describe("Mimic action timing", () => {
  it("collapses through the death take three times faster and holds its last pose", () => {
    const duration = 4.4;
    expect(MIMIC_DEATH_PLAYBACK_RATE).toBe(3);
    expect(mimicActionPlaybackSeconds("death", 0.5, duration)).toBe(1.5);
    expect(mimicActionPlaybackSeconds("death", duration / 3, duration)).toBeCloseTo(duration);
    expect(mimicActionPlaybackSeconds("death", 20, duration)).toBe(duration);
  });

  it("does not speed up the hit or taunt performances", () => {
    expect(mimicActionPlaybackSeconds("hit", 0.5, 2)).toBe(0.5);
    expect(mimicActionPlaybackSeconds("taunt", 0.5, 2)).toBe(0.5);
  });
});
