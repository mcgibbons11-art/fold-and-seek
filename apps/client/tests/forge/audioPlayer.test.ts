import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AudioPlayer,
  MAX_ACTIVE_ONE_SHOTS,
  setMasterVolume,
  type SoundId,
} from "../../src/forge/AudioPlayer";

class FakeAudio {
  static readonly instances: FakeAudio[] = [];

  readonly src: string;
  preload = "";
  volume = 1;
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  pauseCalls = 0;

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  addEventListener(): void {}

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.pauseCalls += 1;
  }

  removeAttribute(): void {}
}

const IDS: readonly SoundId[] = [
  "ui_click",
  "ui_hover",
  "ui_confirm",
  "material_sample",
  "anchor_snap",
  "panel_snap",
  "servo_move",
  "lock_seal",
  "door_open",
  "unfold_reveal",
  "caught_sting",
  "wrong_horn",
  "lamp_switch",
  "chair_squeak",
  "vase_dust_puff",
  "clock_chime",
  "kettle_whistle",
];

describe("AudioPlayer", () => {
  beforeEach(() => {
    FakeAudio.instances.length = 0;
    vi.stubGlobal("Audio", FakeAudio);
    setMasterVolume(1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps concurrent one-shots inside one global voice budget", () => {
    const player = new AudioPlayer("/", 1);
    for (const id of IDS) player.play(id);

    const played = FakeAudio.instances.filter((element) => element.playbackRate > 0 && !element.paused);
    expect(played).toHaveLength(MAX_ACTIVE_ONE_SHOTS);
    expect(FakeAudio.instances[0]?.pauseCalls).toBe(1);

    player.dispose();
  });

  it("retains per-play trim when master volume changes", () => {
    const player = new AudioPlayer("/", 1);
    player.play("ui_confirm");
    const voice = FakeAudio.instances[0];

    expect(voice?.volume).toBeCloseTo(0.55);
    setMasterVolume(0.5);
    expect(voice?.volume).toBeCloseTo(0.275);

    player.dispose();
  });
});
