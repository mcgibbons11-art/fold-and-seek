import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  audioMixer,
  getAudioBusGain,
  getAudioLevels,
  setAudioBusVolume,
} from "../../src/audio/AudioMixer";

class Voice {
  paused = false;
  currentTime = 3;
  pause(): void { this.paused = true; }
}

describe("audio mixer", () => {
  beforeEach(() => {
    setAudioBusVolume("master", 1);
    setAudioBusVolume("music", 1);
    setAudioBusVolume("gameplay", 1);
  });

  it("persists independent category levels and compounds them with master", () => {
    setAudioBusVolume("master", 0.5);
    setAudioBusVolume("music", 0.4);
    expect(getAudioLevels().music).toBe(0.4);
    expect(getAudioBusGain("music")).toBeCloseTo(0.2);
  });

  it("does not let low priority texture steal an important cue", () => {
    const important = new Voice() as unknown as HTMLAudioElement;
    expect(audioMixer.reserve(important, "gameplay", "critical")).toBe(true);
    const textures: HTMLAudioElement[] = [];
    for (let index = 0; index < 15; index += 1) {
      const texture = new Voice() as unknown as HTMLAudioElement;
      textures.push(texture);
      expect(audioMixer.reserve(texture, "gameplay", "low")).toBe(true);
    }
    const rejected = new Voice() as unknown as HTMLAudioElement;
    expect(audioMixer.reserve(rejected, "gameplay", "background")).toBe(false);
    expect(important.paused).toBe(false);
    audioMixer.release(important);
    for (const texture of textures) audioMixer.release(texture);
  });

  it("ducks music temporarily for critical gameplay", () => {
    vi.useFakeTimers();
    const voice = new Voice() as unknown as HTMLAudioElement;
    audioMixer.reserve(voice, "gameplay", "critical");
    expect(getAudioBusGain("music")).toBeCloseTo(0.5);
    vi.advanceTimersByTime(500);
    expect(getAudioBusGain("music")).toBeCloseTo(1);
    audioMixer.release(voice);
    vi.useRealTimers();
  });

  it("caps noisy texture independently from protected weapon voices", () => {
    const weapon = new Voice() as unknown as HTMLAudioElement;
    const textureA = new Voice() as unknown as HTMLAudioElement;
    const textureB = new Voice() as unknown as HTMLAudioElement;
    const textureC = new Voice() as unknown as HTMLAudioElement;
    expect(audioMixer.reserve(weapon, "gameplay", "critical", "weapon")).toBe(true);
    expect(audioMixer.reserve(textureA, "gameplay", "low", "texture")).toBe(true);
    expect(audioMixer.reserve(textureB, "gameplay", "low", "texture")).toBe(true);
    expect(audioMixer.reserve(textureC, "gameplay", "background", "texture")).toBe(false);
    expect(weapon.paused).toBe(false);
    for (const voice of [weapon, textureA, textureB, textureC]) audioMixer.release(voice);
  });
});
