import { describe, expect, it } from "vitest";

import { SoundCaptionLedger } from "../../src/audio/soundCaptions";

describe("SoundCaptionLedger", () => {
  it("merges repeated footsteps instead of flooding the HUD", () => {
    const captions = new SoundCaptionLedger();
    captions.push({ label: "Footsteps", bearingRad: -1 });
    captions.push({ label: "Footsteps", bearingRad: -0.8 });
    expect(captions.current).toHaveLength(1);
    expect(captions.current[0]).toMatchObject({ count: 2, bearingRad: -0.8 });
  });

  it("keeps critical captions when critical-only mode is selected", () => {
    const captions = new SoundCaptionLedger();
    captions.push({ label: "Footsteps" });
    captions.push({ label: "Warrant fired", importance: "critical" });
    expect(captions.visible("critical").map((caption) => caption.label)).toEqual(["Warrant fired"]);
  });

  it("expires captions and caps simultaneous messages", () => {
    const captions = new SoundCaptionLedger();
    for (let index = 0; index < 5; index += 1) captions.push({ label: `Event ${index}` });
    expect(captions.current).toHaveLength(3);
    expect(captions.update(3_000)).toBe(true);
    expect(captions.current).toHaveLength(0);
  });
});
