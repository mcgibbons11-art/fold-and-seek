import { describe, expect, it } from "vitest";

import {
  createMoveInput,
  InspectorController,
  MAX_PITCH_RAD,
  type InspectorMoveInput,
} from "../../src/inspector/InspectorController";
import {
  BRISK_WALK_MULTIPLIER,
  INSPECTOR_RADIUS_M,
  WORLD_SCALE,
} from "../../src/inspector/navData";
import {
  openNavData,
  testNavData,
  testSettings,
  LADDER_TO_SHELF,
  MANTLE_TO_TABLE,
  SHELF_TOP,
  TABLE_TOP,
  WALL,
  YAW_TOWARD_TABLE,
  YAW_TOWARD_WALL,
} from "./navFixture";

const FRAME_SECONDS = 1 / 60;
const OPEN_ROOM = openNavData();

function walk(
  controller: InspectorController,
  frames: number,
  intent: Partial<InspectorMoveInput>,
): void {
  const input = createMoveInput();
  Object.assign(input, intent);
  for (let i = 0; i < frames; i += 1) {
    controller.update(FRAME_SECONDS, input);
  }
}

/** Runs until the predicate holds, so a test never depends on frame counts. */
function walkUntil(
  controller: InspectorController,
  intent: Partial<InspectorMoveInput>,
  done: (controller: InspectorController) => boolean,
  maxFrames = 600,
): number {
  const input = createMoveInput();
  Object.assign(input, intent);
  for (let frame = 0; frame < maxFrames; frame += 1) {
    if (done(controller)) return frame;
    controller.update(FRAME_SECONDS, input);
  }
  throw new Error("walkUntil: condition never held");
}

function spawned(
  navData = testNavData(),
  yaw = YAW_TOWARD_WALL,
  x = 0,
  z = 0,
  y = 0,
): InspectorController {
  const controller = new InspectorController(navData, testSettings());
  controller.teleportTo({ position: { x, y, z }, yaw });
  return controller;
}

/**
 * Long enough for the acceleration curve in `CharacterController` to have run
 * its course, so a test that means to measure the speed cap measures the cap
 * rather than the ramp up to it. The ramp itself is measured in
 * `movementFeel.test.ts`.
 */
const AT_FULL_SPEED_FRAMES = 60;

describe("InspectorController movement", () => {
  it("walks forward at the configured speed on open floor", () => {
    const controller = spawned(OPEN_ROOM);
    walk(controller, AT_FULL_SPEED_FRAMES, { forward: 1 });

    const from = controller.position.x;
    walk(controller, 4, { forward: 1 });
    const expected = testSettings().inspectorMoveSpeed * FRAME_SECONDS * 4;
    expect(controller.position.x - from).toBeCloseTo(expected, 6);
    expect(controller.position.z).toBeCloseTo(0, 6);
    expect(controller.grounded).toBe(true);
    expect(controller.surfaceId).toBe("floor");
  });

  it("covers the brisk multiple of the walk distance with Shift held", () => {
    const walker = spawned(OPEN_ROOM);
    const brisk = spawned(OPEN_ROOM);
    walk(walker, AT_FULL_SPEED_FRAMES, { forward: 1 });
    walk(brisk, AT_FULL_SPEED_FRAMES, { forward: 1, brisk: true });

    const walkerFrom = walker.position.x;
    const briskFrom = brisk.position.x;
    walk(walker, 4, { forward: 1 });
    walk(brisk, 4, { forward: 1, brisk: true });

    expect(brisk.position.x - briskFrom).toBeCloseTo(
      (walker.position.x - walkerFrom) * BRISK_WALK_MULTIPLIER,
      6,
    );
  });

  it("normalizes diagonal intent so strafing is no faster than walking", () => {
    const straight = spawned(OPEN_ROOM);
    const diagonal = spawned(OPEN_ROOM);
    walk(straight, 4, { forward: 1 });
    walk(diagonal, 4, { forward: 1, strafe: 1 });

    expect(Math.hypot(diagonal.position.x, diagonal.position.z)).toBeCloseTo(
      Math.abs(straight.position.x),
      6,
    );
  });

  it("cannot pass through a blocker however long it pushes", () => {
    const controller = spawned();
    walk(controller, 400, { forward: 1 });

    expect(controller.position.x).toBeLessThan(WALL.min.x - INSPECTOR_RADIUS_M);
    expect(controller.lastResolution).toBe("stopped");
    expect(controller.speed).toBe(0);
  });

  it("slides along a blocker when the movement is diagonal into it", () => {
    const controller = spawned();
    walkUntil(
      controller,
      { forward: 1, strafe: 1 },
      (c) => c.lastResolution === "slid" && c.position.z > 0.5,
    );

    expect(controller.position.x).toBeLessThan(WALL.min.x - INSPECTOR_RADIUS_M);
    expect(controller.position.z).toBeGreaterThan(0.5);
    expect(controller.lastResolution).toBe("slid");
  });

  it("keeps a slide moving at full speed along the free axis", () => {
    const controller = spawned();
    walk(controller, 60, { forward: 1 });
    // The turn into the wall is a change of velocity like any other, so it eases
    // rather than snapping. What is at stake here is where it settles: pressed
    // diagonally into a wall, the free axis carries the whole diagonal component
    // and none of it is lost to the axis that is blocked.
    walk(controller, AT_FULL_SPEED_FRAMES, { forward: 1, strafe: 1 });
    const zBefore = controller.position.z;
    walk(controller, 10, { forward: 1, strafe: 1 });

    const perFrame = (testSettings().inspectorMoveSpeed * FRAME_SECONDS) / Math.SQRT2;
    expect(controller.position.z - zBefore).toBeCloseTo(perFrame * 10, 6);
  });

  it("refuses a step that would leave the map entirely", () => {
    const controller = spawned(OPEN_ROOM, YAW_TOWARD_TABLE);
    walk(controller, 400, { forward: 1 });

    expect(controller.position.x).toBeGreaterThanOrEqual(-5);
    expect(controller.lastResolution).toBe("stopped");
  });

  it("walks into a crawl space it fits in but not into one it does not", () => {
    const openCrawl = spawned(testNavData(), YAW_TOWARD_WALL, 2.5, 0);
    walk(openCrawl, 200, { forward: 1 });
    expect(openCrawl.position.x).toBeGreaterThan(3.5);
    expect(openCrawl.surfaceId).toBe("crawl_open");

    const tightCrawl = spawned(testNavData(), YAW_TOWARD_WALL, 2.5, 3);
    walk(tightCrawl, 200, { forward: 1 });
    expect(tightCrawl.position.x).toBeLessThanOrEqual(3);
    expect(tightCrawl.surfaceId).toBe("floor");
    expect(tightCrawl.lastResolution).toBe("stopped");
  });
});

describe("InspectorController falling", () => {
  it("walks off a table edge and lands on the floor below", () => {
    const controller = spawned(testNavData(), YAW_TOWARD_TABLE, -2.9, 0, 0.75);
    expect(controller.position.y).toBeCloseTo(TABLE_TOP.bounds.max.y, 6);

    walkUntil(controller, { forward: 1 }, (c) => !c.grounded);
    expect(controller.position.x).toBeLessThan(-3);
    expect(controller.grounded).toBe(false);
    expect(controller.position.y).toBeLessThan(TABLE_TOP.bounds.max.y);

    walk(controller, 60, { forward: 0 });
    expect(controller.grounded).toBe(true);
    expect(controller.position.y).toBeCloseTo(0, 6);
    expect(controller.surfaceId).toBe("floor");
  });

  it("accelerates while falling rather than dropping at a fixed rate", () => {
    const controller = spawned(testNavData(), YAW_TOWARD_TABLE, -2.9, 0, 0.75);
    walkUntil(controller, { forward: 1 }, (c) => !c.grounded);

    const first = controller.position.y;
    walk(controller, 3, { forward: 0 });
    const second = controller.position.y;
    walk(controller, 3, { forward: 0 });
    const third = controller.position.y;

    expect(first - second).toBeLessThan(second - third);
  });
});

describe("InspectorController climbing", () => {
  it("mantles from the floor onto the table and reports progress on the way", () => {
    const controller = spawned(testNavData(), YAW_TOWARD_TABLE, -0.9, 0);
    walk(controller, 1, { forward: 1 });

    expect(controller.climbState?.link).toBe(MANTLE_TO_TABLE);
    expect(controller.climbState?.ascending).toBe(true);

    walk(controller, 2, { forward: 1 });
    const progress = controller.climbState?.progress ?? 0;
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(1);

    walkUntil(controller, { forward: 1 }, (c) => c.climbState === null && c.surfaceId === "table");
    expect(controller.surfaceId).toBe("table");
    expect(controller.grounded).toBe(true);
    expect(controller.position.x).toBeCloseTo(MANTLE_TO_TABLE.target.x, 6);
    expect(controller.position.y).toBeCloseTo(MANTLE_TO_TABLE.target.y, 6);
  });

  it("climbs back down the same link from the surface above", () => {
    const controller = spawned(testNavData(), YAW_TOWARD_WALL, -1.3, 0, 0.75);
    expect(controller.surfaceId).toBe("table");

    walkUntil(controller, { forward: 1 }, (c) => c.surfaceId === "floor");
    expect(controller.position.y).toBeCloseTo(0, 6);
  });

  it("does not start a climb without forward intent or without facing the link", () => {
    const idle = spawned(testNavData(), YAW_TOWARD_TABLE, -0.9, 0);
    walk(idle, 30, { forward: 0 });
    expect(idle.climbState).toBeNull();
    expect(idle.surfaceId).toBe("floor");

    const facingAway = spawned(testNavData(), YAW_TOWARD_WALL, -0.9, 0);
    walk(facingAway, 1, { forward: 1 });
    expect(facingAway.climbState).toBeNull();
  });

  it("rides a ladder up while forward is held and hangs when it is released", () => {
    const controller = spawned(testNavData(), YAW_TOWARD_WALL, -4.25, 2.5);
    walk(controller, 1, { forward: 1 });
    expect(controller.climbState?.link).toBe(LADDER_TO_SHELF);

    walk(controller, 20, { forward: 1 });
    const heightWhenReleased = controller.position.y;
    expect(heightWhenReleased).toBeGreaterThan(0);

    walk(controller, 60, { forward: 0 });
    expect(controller.position.y).toBeCloseTo(heightWhenReleased, 6);
    expect(controller.climbState).not.toBeNull();

    walkUntil(controller, { forward: 1 }, (c) => c.climbState === null);
    expect(controller.surfaceId).toBe("shelf");
    expect(controller.position.y).toBeCloseTo(SHELF_TOP.bounds.max.y, 6);
  });

  it("takes a ladder more slowly than a mantle", () => {
    const mantle = spawned(testNavData(), YAW_TOWARD_TABLE, -0.9, 0);
    const ladder = spawned(testNavData(), YAW_TOWARD_WALL, -4.25, 2.5);
    walk(mantle, 2, { forward: 1 });
    walk(ladder, 2, { forward: 1 });

    const mantleRise = (mantle.climbState?.progress ?? 0) * MANTLE_TO_TABLE.target.y;
    const ladderRise = (ladder.climbState?.progress ?? 0) * LADDER_TO_SHELF.target.y;
    expect(ladderRise).toBeLessThan(mantleRise);
    expect(WORLD_SCALE.ladderSpeed).toBeLessThan(WORLD_SCALE.mantleSpeed);
  });
});

describe("InspectorController look", () => {
  it("clamps pitch short of vertical and keeps yaw wrapped", () => {
    const controller = spawned(OPEN_ROOM);
    walk(controller, 100, { lookPitchDelta: 0.1 });
    expect(controller.pitch).toBeCloseTo(MAX_PITCH_RAD, 6);

    walk(controller, 100, { lookPitchDelta: -0.5 });
    expect(controller.pitch).toBeCloseTo(-MAX_PITCH_RAD, 6);

    walk(controller, 100, { lookYawDelta: 0.5 });
    expect(controller.yaw).toBeGreaterThanOrEqual(-Math.PI);
    expect(controller.yaw).toBeLessThanOrEqual(Math.PI);
  });
});
