import { MatchPhase } from "@foldseek/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { setMasterVolume } from "../../src/forge/AudioPlayer";
import {
  AmbienceController,
  type AmbienceInput,
  type BedId,
  type BedVoice,
} from "../../src/gameplay/AmbienceController";

/**
 * The ambience routing and its fades, driven a frame at a time with no audio
 * device. Playback is the one thing not exercised here: `BedVoice` stands in
 * for it, and what these check is which bed each channel asks for and how
 * loudly, which is the part that decides what the player hears.
 */

interface FakeVoice extends BedVoice {
  readonly bedId: BedId;
  gain: number;
  stopped: boolean;
}

function harness() {
  const created: FakeVoice[] = [];
  const controller = new AmbienceController((bedId) => {
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
  return { controller, created };
}

/** Somewhere inside the clock wall zone, which spans x -7.5..-4.6, z -3.2..2.2. */
const CLOCK_WALL: Pick<AmbienceInput, "listenerX" | "listenerZ"> = {
  listenerX: -6,
  listenerZ: 0,
};
/** Inside the reading nook: x -7.5..-0.2, z 2.2..5.5. */
const READING_NOOK: Pick<AmbienceInput, "listenerX" | "listenerZ"> = {
  listenerX: -4,
  listenerZ: 4,
};

function input(overrides: Partial<AmbienceInput> = {}): AmbienceInput {
  return {
    phase: MatchPhase.Forge,
    watchedLevel: 0,
    ...CLOCK_WALL,
    ...overrides,
  };
}

/** Runs `ms` of frames at 16 ms each, which is what the game loop delivers. */
function run(controller: AmbienceController, ms: number, state: AmbienceInput): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) controller.update(16, state);
}

describe("AmbienceController", () => {
  beforeEach(() => {
    setMasterVolume(1);
  });

  it("stays silent until a gesture has started it", () => {
    const { controller, created } = harness();
    run(controller, 500, input());
    expect(controller.running).toBe(false);
    expect(created).toHaveLength(0);
  });

  it("opens the base tone, the zone bed and the phase bed once started", () => {
    const { controller } = harness();
    controller.start();
    controller.update(16, input());

    expect(controller.wantedBed("base")).toBe("amb_shop_room_tone");
    expect(controller.wantedBed("zone")).toBe("amb_clock_ticks");
    expect(controller.wantedBed("phase")).toBe("amb_forge_tinker");
    expect(controller.wantedBed("tension")).toBeNull();
  });

  it("fades a bed up over the crossfade rather than snapping it on", () => {
    const { controller } = harness();
    controller.start();
    controller.update(16, input());
    const early = controller.gainOf("base");

    run(controller, 2_000, input());
    const settled = controller.gainOf("base");

    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(settled * 0.2);
    expect(settled).toBeGreaterThan(0);
  });

  it("exchanges zone beds when the listener walks between zones", () => {
    const { controller, created } = harness();
    controller.start();
    run(controller, 2_000, input());
    const clockWall = created.find((voice) => voice.bedId === "amb_clock_ticks");

    run(controller, 2_000, input(READING_NOOK));

    expect(controller.wantedBed("zone")).toBe("amb_nook_settle");
    expect(clockWall?.stopped).toBe(true);
    expect(created.some((voice) => voice.bedId === "amb_nook_settle")).toBe(true);
  });

  it("keeps the bed it had when the listener is outside every zone", () => {
    const { controller } = harness();
    controller.start();
    run(controller, 2_000, input());

    run(controller, 200, input({ listenerX: 400, listenerZ: 400 }));

    expect(controller.wantedBed("zone")).toBe("amb_clock_ticks");
  });

  it("raises a heartbeat with the watched level and drops it when unwatched", () => {
    const { controller } = harness();
    controller.start();
    const hunted = { phase: MatchPhase.Inspection } as const;

    run(controller, 600, input({ ...hunted, watchedLevel: 1 }));
    expect(controller.wantedBed("tension")).toBe("amb_watched_low");
    const low = controller.gainOf("tension");

    run(controller, 600, input({ ...hunted, watchedLevel: 2 }));
    expect(controller.wantedBed("tension")).toBe("amb_watched_high");

    run(controller, 600, input({ ...hunted, watchedLevel: 0 }));
    expect(controller.wantedBed("tension")).toBeNull();
    expect(controller.gainOf("tension")).toBe(0);
    expect(low).toBeGreaterThan(0);
  });

  it("does not beat a heartbeat outside the hunt", () => {
    const { controller } = harness();
    controller.start();
    // A watched level left over from the round that just ended.
    run(controller, 600, input({ phase: MatchPhase.Results, watchedLevel: 2 }));
    expect(controller.wantedBed("tension")).toBeNull();
  });

  it("swaps the forge bed for the hunt's rumble when the hunt opens", () => {
    const { controller } = harness();
    controller.start();
    run(controller, 2_000, input());
    expect(controller.wantedBed("phase")).toBe("amb_forge_tinker");

    run(controller, 2_000, input({ phase: MatchPhase.Inspection }));
    expect(controller.wantedBed("phase")).toBe("amb_inspector_near");
  });

  it("falls silent in the lobby", () => {
    const { controller } = harness();
    controller.start();
    run(controller, 2_000, input());

    run(controller, 2_000, input({ phase: MatchPhase.Lobby }));

    expect(controller.wantedBed("base")).toBeNull();
    expect(controller.wantedBed("zone")).toBeNull();
    expect(controller.wantedBed("phase")).toBeNull();
  });

  it("ducks every bed under a stinger and brings them back", () => {
    const { controller } = harness();
    controller.start();
    run(controller, 2_000, input());
    const settled = controller.gainOf("base");

    controller.duckUnderStinger();
    controller.update(16, input());
    const ducked = controller.gainOf("base");

    run(controller, 2_500, input());
    const recovered = controller.gainOf("base");

    expect(ducked).toBeLessThan(settled);
    expect(recovered).toBeCloseTo(settled, 5);
  });

  it("scales every bed by the master volume", () => {
    const { controller } = harness();
    controller.start();
    run(controller, 2_000, input());
    const full = controller.gainOf("base");

    setMasterVolume(0.5);
    controller.update(16, input());

    expect(controller.gainOf("base")).toBeCloseTo(full * 0.5, 5);
  });

  it("stops every voice on dispose", () => {
    const { controller, created } = harness();
    controller.start();
    run(controller, 2_000, input());

    controller.dispose();

    expect(created.length).toBeGreaterThan(0);
    expect(created.every((voice) => voice.stopped)).toBe(true);
    expect(controller.running).toBe(false);
  });

  it("does not stack a third voice when a zone changes mid-crossfade", () => {
    const { controller, created } = harness();
    controller.start();
    run(controller, 2_000, input());
    const before = created.filter((voice) => !voice.stopped).length;

    // Two zone changes inside one crossfade.
    run(controller, 200, input(READING_NOOK));
    run(controller, 200, input());
    run(controller, 2_000, input());

    expect(created.filter((voice) => !voice.stopped).length).toBe(before);
  });
});
