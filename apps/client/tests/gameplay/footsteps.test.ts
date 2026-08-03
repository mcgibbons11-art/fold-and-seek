import { describe, expect, it } from "vitest";

import type { SoundId } from "../../src/forge/AudioPlayer";
import { WORLD_SCALE } from "../../src/inspector/navData";
import {
  FootstepDriver,
  RemoteInspectorFootsteps,
  footstepMaterial,
  type MotionSample,
} from "../../src/gameplay/footsteps";

/**
 * The footstep driver watches motion that has already happened, so every one of
 * these hands it a sequence of frames and asks what the player would have heard.
 */

function recorder() {
  const played: SoundId[] = [];
  return {
    sink: {
      play(id: SoundId) {
        played.push(id);
      },
    },
    played,
  };
}

function motion(overrides: Partial<MotionSample> = {}): MotionSample {
  return {
    speed: 0,
    grounded: true,
    position: { y: 0 },
    surfaceId: "floor_00",
    climbState: null,
    ...overrides,
  };
}

/** A comfortable walk: well above the driver's own standing-still threshold. */
const WALK_SPEED = WORLD_SCALE.playerHeight * 1.5;

describe("footstepMaterial", () => {
  it("reads the bare boards as wood", () => {
    expect(footstepMaterial("floor_00")).toBe("wood");
    expect(footstepMaterial("workbench_top")).toBe("wood");
  });

  it("reads the reading nook and its upholstery as rug", () => {
    expect(footstepMaterial("floor_02")).toBe("rug");
    expect(footstepMaterial("nook_armchair_seat")).toBe("rug");
  });

  it("reads the workshop rack boards as metal", () => {
    expect(footstepMaterial("shelving_board_1")).toBe("metal");
    expect(footstepMaterial("shelving_board_4")).toBe("metal");
  });

  it("reads the glazed cabinet and the marble counter as glass", () => {
    expect(footstepMaterial("back_cabinet_top")).toBe("glass");
    expect(footstepMaterial("counter_top")).toBe("glass");
  });

  it("falls back to wood for a surface it has never heard of", () => {
    expect(footstepMaterial("some_new_ledge")).toBe("wood");
    expect(footstepMaterial(null)).toBe("wood");
  });
});

describe("FootstepDriver", () => {
  it("says nothing while the body stands still", () => {
    const { sink, played } = recorder();
    const driver = new FootstepDriver(sink);
    for (let i = 0; i < 60; i++) driver.update(16, motion());
    expect(played).toHaveLength(0);
  });

  it("plays one footfall per stride travelled", () => {
    const { sink, played } = recorder();
    const driver = new FootstepDriver(sink);
    const strideM = 0.62 * WORLD_SCALE.playerHeight;
    // Exactly four strides' worth of walking, in 100 ms frames.
    const seconds = (strideM * 4) / WALK_SPEED;
    const frames = Math.round((seconds * 1_000) / 100);
    for (let i = 0; i < frames; i++) driver.update(100, motion({ speed: WALK_SPEED }));

    expect(played).toHaveLength(4);
  });

  it("cycles through the variations of the surface underfoot", () => {
    const { sink, played } = recorder();
    const driver = new FootstepDriver(sink);
    for (let i = 0; i < 200; i++) driver.update(100, motion({ speed: WALK_SPEED }));

    expect(new Set(played)).toEqual(
      new Set(["footstep_wood", "footstep_wood_2", "footstep_wood_3"]),
    );
    // Never the same sample twice running, which is the point of having three.
    for (let i = 1; i < played.length; i++) expect(played[i]).not.toBe(played[i - 1]);
  });

  it("changes the sample when the body walks onto another material", () => {
    const { sink, played } = recorder();
    const driver = new FootstepDriver(sink);
    for (let i = 0; i < 30; i++) {
      driver.update(100, motion({ speed: WALK_SPEED, surfaceId: "shelving_board_2" }));
    }
    expect(played.every((id) => id.startsWith("footstep_metal"))).toBe(true);
  });

  it("hops on a departure that gained height, and not on one that lost it", () => {
    const { sink: hopSink, played: hopped } = recorder();
    const hopper = new FootstepDriver(hopSink);
    hopper.update(16, motion());
    hopper.update(16, motion({ grounded: false, position: { y: 0.05 } }));

    const { sink: fallSink, played: fell } = recorder();
    const faller = new FootstepDriver(fallSink);
    faller.update(16, motion());
    faller.update(16, motion({ grounded: false, position: { y: -0.05 } }));

    expect(hopped).toEqual(["jump_takeoff"]);
    expect(fell).toEqual([]);
  });

  it("lands softly after a short drop and heavily after a long one", () => {
    const { sink, played } = recorder();
    const driver = new FootstepDriver(sink);
    driver.update(16, motion());
    driver.update(16, motion({ grounded: false, position: { y: 0.05 } }));
    for (let i = 0; i < 4; i++) driver.update(16, motion({ grounded: false }));
    driver.update(16, motion());
    expect(played).toEqual(["jump_takeoff", "land_soft"]);

    const { sink: hardSink, played: hard } = recorder();
    const long = new FootstepDriver(hardSink);
    long.update(16, motion());
    long.update(16, motion({ grounded: false, position: { y: -0.05 } }));
    for (let i = 0; i < 40; i++) long.update(16, motion({ grounded: false }));
    long.update(16, motion());
    expect(hard).toEqual(["land_hard"]);
  });

  it("scrapes instead of walking while the hunt's creep cap is on", () => {
    const { sink, played } = recorder();
    const driver = new FootstepDriver(sink);
    for (let i = 0; i < 40; i++) driver.update(100, motion({ speed: WALK_SPEED }), true);

    expect(played.length).toBeGreaterThan(0);
    expect(played.every((id) => id === "creep_slide")).toBe(true);
  });

  it("grabs once as a mantle starts and repeatedly up a ladder", () => {
    const { sink: mantleSink, played: mantle } = recorder();
    const vaulting = new FootstepDriver(mantleSink);
    for (let i = 0; i < 40; i++) {
      vaulting.update(100, motion({ climbState: { link: { kind: "mantle" } } }));
    }
    expect(mantle).toEqual(["wallstick_attach", "climb_grab"]);

    const { sink: ladderSink, played: ladder } = recorder();
    const climbing = new FootstepDriver(ladderSink);
    for (let i = 0; i < 40; i++) {
      climbing.update(100, motion({ climbState: { link: { kind: "ladder" } } }));
    }
    expect(ladder.length).toBeGreaterThan(1);
    expect(ladder[0]).toBe("wallstick_attach");
    expect(ladder.slice(1).every((id) => id === "climb_grab" || id === "climb_grab_2")).toBe(true);
  });

  it("releases and settles exactly once after topping out", () => {
    const { sink, played } = recorder();
    const driver = new FootstepDriver(sink);
    driver.update(100, motion({ grounded: false, position: { y: 0.4 }, climbState: { link: { kind: "mantle" } } }));
    driver.update(100, motion({ grounded: false, position: { y: 0.7 }, climbState: { link: { kind: "mantle" } } }));
    driver.update(100, motion({ grounded: true, position: { y: 0.7 }, climbState: null }));
    driver.update(100, motion({ grounded: true, position: { y: 0.7 }, climbState: null }));
    expect(played.filter((id) => id === "wallstick_release")).toHaveLength(1);
    expect(played.filter((id) => id === "land_soft")).toHaveLength(1);
  });

  it("does not burst a run of footfalls after one long frame", () => {
    const { sink, played } = recorder();
    const driver = new FootstepDriver(sink);
    // A single second-long stall, which is many strides' worth of distance.
    driver.update(1_000, motion({ speed: WALK_SPEED }));
    expect(played).toHaveLength(1);
  });
});

describe("RemoteInspectorFootsteps", () => {
  it("places surface-specific steps at the interpolated remote position", () => {
    const played: Array<{ id: SoundId; x: number }> = [];
    const events: string[] = [];
    const driver = new RemoteInspectorFootsteps(
      {
        playAt(id, position) {
          played.push({ id, x: position.x });
        },
      },
      (event) => events.push(event.text),
    );
    const position = { x: 3.25, y: 0, z: -1 };
    for (let i = 0; i < 20; i++) {
      driver.update(50, {
        position,
        speedMps: WALK_SPEED,
        surfaceId: "shelving_board_2",
      });
    }

    expect(played.length).toBeGreaterThan(0);
    expect(played.every((entry) => entry.id.startsWith("footstep_metal"))).toBe(true);
    expect(played[0]?.x).toBe(3.25);
    expect(events).toEqual(played.map(() => "metal footsteps"));
  });

  it("drops a partial stride when the remote body stops or becomes hidden", () => {
    const played: SoundId[] = [];
    const driver = new RemoteInspectorFootsteps({
      playAt(id) {
        played.push(id);
      },
    });
    const sample = {
      position: { x: 0, y: 0, z: 0 },
      speedMps: WALK_SPEED,
      surfaceId: "floor_00",
    };
    driver.update(200, sample);
    driver.update(16, { ...sample, speedMps: 0 });
    driver.update(200, sample);
    expect(played).toHaveLength(0);

    driver.update(1_000, { ...sample, visible: false });
    expect(played).toHaveLength(0);
  });
});
