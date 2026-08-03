import { DEFAULT_MATCH_SETTINGS, HIDER_FORGE_RUN_SPEED } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import { CharacterController } from "../../src/inspector/CharacterController";
import {
  createMoveInput,
  InspectorController,
  MAX_PITCH_RAD,
  type InspectorMoveInput,
} from "../../src/inspector/InspectorController";
import {
  blocksCapsule,
  surfaceAt,
  BRISK_WALK_MULTIPLIER,
  INSPECTOR_RADIUS_M,
  WORLD_SCALE,
  type NavData,
} from "../../src/inspector/navData";
import { CLUTTER_BLOCKERS, MIMIC_NAV_DATA, NAV_DATA } from "../../src/world/maps/nav";
import {
  OFFICE_DOOR_MAX_Z,
  OFFICE_DOOR_MIN_Z,
  OFFICE_MIN_X,
  WALL_HEIGHT,
} from "../../src/world/maps/zones";
import {
  box,
  openNavData,
  testNavData,
  testSettings,
  LADDER_TO_SHELF,
  MANTLE_TO_TABLE,
  SHELF_TOP,
  SHOP_FLOOR,
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
  for (const hz of [30, 60, 144]) {
    it(`terminates authored, ladder and procedural climbs after release at ${hz} Hz`, () => {
      const dt = 1 / hz;
      const forward = createMoveInput();
      forward.forward = 1;

      const mantle = spawned(testNavData(), YAW_TOWARD_TABLE, -0.9, 0);
      mantle.update(dt, forward);
      expect(mantle.climbState?.link).toBe(MANTLE_TO_TABLE);
      const released = createMoveInput();
      for (let frame = 0; frame < hz * 8 && mantle.climbState !== null; frame += 1) {
        mantle.update(dt, released);
      }
      expect(mantle.climbState).toBeNull();
      expect(mantle.grounded).toBe(true);

      const ladder = spawned(testNavData(), YAW_TOWARD_WALL, -4.25, 2.5);
      ladder.update(dt, forward);
      expect(ladder.climbState?.link).toBe(LADDER_TO_SHELF);
      ladder.releaseClimbInput();
      expect(ladder.climbState).toBeNull();

      const procedural = spawned(testNavData({ climbLinks: [] }), YAW_TOWARD_WALL, 0.78, 0);
      const climb = createMoveInput();
      climb.forward = 1;
      climb.jump = true;
      procedural.update(dt, climb);
      expect(procedural.climbState?.link.to).toBe("solid_top_0");
      procedural.releaseClimbInput();
      expect(procedural.climbState).toBeNull();
    });
  }

  it("climbs an unlinked solid face when Forward and Jump are held", () => {
    const controller = spawned(testNavData({ climbLinks: [] }), YAW_TOWARD_WALL, 0.78, 0);
    walk(controller, 1, { forward: 1, jump: true });

    expect(controller.climbState?.link.to).toBe("solid_top_0");
    expect(controller.climbState?.link.kind).toBe("ladder");
    walkUntil(controller, { forward: 1, jump: true }, (current) => current.climbState === null);
    expect(controller.position.y).toBeCloseTo(WALL.max.y, 6);
    expect(controller.surfaceId).toBe("solid_top_0");
  });

  it("stays out of climb mode after a procedural top-out until Jump is released", () => {
    const controller = spawned(testNavData({ climbLinks: [] }), YAW_TOWARD_WALL, 0.78, 0);
    walkUntil(
      controller,
      { forward: 1, jump: true },
      (current) => current.surfaceId === "solid_top_0" && current.climbState === null,
    );

    const topY = controller.position.y;
    walk(controller, 1, { jump: true });
    expect(controller.position.y).toBeCloseTo(topY, 6);
    expect(controller.grounded).toBe(true);
    walk(controller, 1, { jump: false });
    expect(controller.position.y).toBeCloseTo(topY, 6);
    expect(controller.grounded).toBe(true);

    walk(controller, 120, { forward: 1, jump: true });
    expect(controller.climbState).toBeNull();
    // Forward remains live after the dismount; the player walks off the far
    // side rather than being pinned to the lip in an invisible climb state.
    expect(controller.position.y).toBeLessThan(WALL.max.y);
  });

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

  it("does not auto-grab a climb link downward from the surface above", () => {
    const controller = spawned(testNavData(), YAW_TOWARD_WALL, -1.3, 0, 0.75);
    expect(controller.surfaceId).toBe("table");

    walk(controller, 1, { forward: 1 });
    expect(controller.climbState).toBeNull();
    expect(controller.surfaceId).toBe("table");
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

  it("lets go below a ladder lip instead of getting stuck in climbing mode", () => {
    const controller = spawned(testNavData(), YAW_TOWARD_WALL, -4.25, 2.5);
    walk(controller, 1, { forward: 1 });
    expect(controller.climbState?.link).toBe(LADDER_TO_SHELF);

    walk(controller, 20, { forward: 1 });
    expect(controller.position.y).toBeGreaterThan(0);

    const releasedAt = controller.position.y;
    walk(controller, 1, { forward: 0 });
    expect(controller.position.y).toBeCloseTo(releasedAt, 6);
    expect(controller.climbState).toBeNull();
    expect(controller.grounded).toBe(false);
    walk(controller, 1, { forward: 0 });
    expect(controller.position.y).toBeLessThan(releasedAt);
    walkUntil(controller, {}, (current) => current.grounded);
    expect(controller.position.y).toBeCloseTo(0, 6);
  });

  it("uses S to drop an Inspector in place even while Forward and Space remain held", () => {
    const controller = spawned(testNavData({ climbLinks: [] }), YAW_TOWARD_WALL, 0.78, 0);
    walk(controller, 1, { forward: 1, jump: true });
    walkUntil(
      controller,
      { forward: 1, jump: true },
      (current) => (current.climbState?.progress ?? 0) > 0.15,
    );
    const releasedAt = controller.position.y;

    walk(controller, 1, { forward: 1, jump: true, disengageClimb: true });
    expect(controller.climbState).toBeNull();
    expect(controller.position.y).toBeLessThanOrEqual(releasedAt);
    expect(controller.position.y).toBeGreaterThan(0);
    expect(controller.grounded).toBe(false);

    walkUntil(controller, { jump: false }, (current) => current.grounded);
    expect(controller.position.y).toBeCloseTo(0, 6);
  });

  it("falls from its current height when an Inspector releases Space mid-climb", () => {
    const controller = spawned(testNavData({ climbLinks: [] }), YAW_TOWARD_WALL, 0.78, 0);
    walk(controller, 1, { forward: 1, jump: true });
    walkUntil(
      controller,
      { forward: 1, jump: true },
      (current) => (current.climbState?.progress ?? 0) > 0.15,
    );
    const releasedAt = controller.position.y;

    walk(controller, 1, { forward: 1, jump: false });
    expect(controller.climbState).toBeNull();
    expect(controller.position.y).toBeLessThan(releasedAt);
    expect(controller.position.y).toBeGreaterThan(0);
    expect(controller.grounded).toBe(false);
  });

  it("steps onto the top when forward is released after clearing the ladder lip", () => {
    const controller = spawned(testNavData(), YAW_TOWARD_WALL, -4.25, 2.5);
    walk(controller, 1, { forward: 1 });
    walkUntil(
      controller,
      { forward: 1 },
      (current) => (current.climbState?.progress ?? 0) >= 0.6,
    );

    walk(controller, 1, { forward: 0 });
    expect(controller.climbState).toBeNull();
    expect(controller.surfaceId).toBe("shelf");
    expect(controller.grounded).toBe(true);
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

/**
 * The fall path, against the Curiosity Shop rather than against a fixture.
 *
 * A step has always been checked against the blockers and a fall never was, so
 * a body that ran off a ledge consulted the walkable surfaces alone on the way
 * down and came to rest on the floor *inside* whatever furniture stood under
 * it. These measure the descent instead: what it stops on, that it cannot
 * tunnel through a crate in one long frame, and that having landed on something
 * the map does not publish as walkable the body can still get off it.
 */
describe("CharacterController falling through the shop", () => {
  /** The workshop's small packing crate, the map's own hoppable obstacle. */
  const CRATE = (() => {
    const found = CLUTTER_BLOCKERS.find(
      (blocker) => blocker.min.x > 4.2 && blocker.max.x < 4.7 && blocker.min.z > -1.1,
    );
    if (found === undefined) throw new Error("the map no longer has the workshop clutter crate");
    return found;
  })();

  const CRATE_X = (CRATE.min.x + CRATE.max.x) / 2;
  const CRATE_Z = (CRATE.min.z + CRATE.max.z) / 2;

  /**
   * A point on the armchair that carries no walkable ledge: the seat cushion is
   * published as a surface, the arms around it are not, and both are the same
   * blocker to the controller.
   */
  const ARMCHAIR_ARM_X = -5.95;
  const ARMCHAIR_ARM_Z = 3.5;
  const ARMCHAIR_TOP_Y = 0.61;

  /** Drops a still body and runs until it is standing again. */
  function drop(x: number, y: number, z: number, dtSeconds = FRAME_SECONDS): CharacterController {
    const controller = new CharacterController(NAV_DATA, () => 0);
    controller.placeAt(x, y, z, 0);
    const input = createMoveInput();
    for (let frame = 0; frame < 600 && !controller.grounded; frame += 1) {
      controller.update(dtSeconds, input);
    }
    if (!controller.grounded) throw new Error("drop: the body never landed");
    return controller;
  }

  /** Height of the only thing the map publishes as walkable at (x, z). */
  function walkableTopAt(x: number, z: number): number | null {
    const surface = surfaceAt(NAV_DATA.floors, x, z, WALL_HEIGHT);
    return surface?.bounds.max.y ?? null;
  }

  it("lands on the crate rather than on the floor inside it", () => {
    // Nothing walkable is published at the crate's own height, so the landing
    // height can only have come from the blocker.
    expect(walkableTopAt(CRATE_X, CRATE_Z)).toBe(0);

    const controller = drop(CRATE_X, 1, CRATE_Z);

    expect(controller.position.y).toBeCloseTo(CRATE.max.y, 6);
    expect(controller.grounded).toBe(true);
    // And the map does not name what it is standing on, so no authored climb
    // link may be started from it.
    expect(controller.surfaceId).toBeNull();
  });

  it("catches a blocker the whole of one long frame passed over", () => {
    // A shelf slab standing clear of the floor with nothing walkable on it, and
    // a fifth of a second a step — a stalled main thread, where the body covers
    // most of a metre between samples and the whole slab falls inside one of
    // them. Asking only where the feet ENDED drops straight through this; the
    // descent has to be swept.
    //
    // It takes a fixture rather than the shop because every thin raised blocker
    // in the Curiosity Shop carries a walkable ledge at its own top — a rack
    // board, the workbench slab, a stool seat — and those are caught by the
    // floors alone. The shop cannot tell the two implementations apart, so it
    // would not be measuring anything.
    const slab = box(-1, 0.8, -1, 1, 0.84, 1);
    const navData: NavData = {
      floors: [SHOP_FLOOR],
      blockers: [slab],
      climbLinks: [],
      spawnPoints: { inspectors: [], mimics: [] },
      securityOffice: box(-9, 0, -9, -8, 1, -8),
    };

    const controller = new CharacterController(navData, () => 0);
    controller.placeAt(0, 1.5, 0, 0);
    const input = createMoveInput();
    for (let frame = 0; frame < 40 && !controller.grounded; frame += 1) {
      controller.update(0.2, input);
    }

    expect(controller.position.y).toBeCloseTo(slab.max.y, 6);
  });

  it("rests on the arm of the armchair instead of dropping into it", () => {
    expect(walkableTopAt(ARMCHAIR_ARM_X, ARMCHAIR_ARM_Z)).toBe(0);

    const controller = drop(ARMCHAIR_ARM_X, 1.4, ARMCHAIR_ARM_Z);

    expect(controller.position.y).toBeCloseTo(ARMCHAIR_TOP_Y, 6);
    expect(
      blocksCapsule(NAV_DATA.blockers, controller.position.x, controller.position.z, controller.position.y),
    ).toBe(false);
  });

  it("stays standing on the crate rather than sinking a frame at a time", () => {
    const controller = drop(CRATE_X, 1, CRATE_Z);
    const input = createMoveInput();
    for (let frame = 0; frame < 120; frame += 1) controller.update(FRAME_SECONDS, input);

    expect(controller.position.y).toBeCloseTo(CRATE.max.y, 6);
    // A body caught and re-caught every frame would report a landing on each of
    // them, and the camera dips on that flag.
    expect(controller.justLanded).toBe(false);
  });

  it("walks off what it landed on, so a landing is never a trap", () => {
    const controller = new CharacterController(NAV_DATA, () => HIDER_FORGE_RUN_SPEED);
    controller.placeAt(CRATE_X, 1, CRATE_Z, 0);
    const input = createMoveInput();
    for (let frame = 0; frame < 600 && !controller.grounded; frame += 1) {
      controller.update(FRAME_SECONDS, input);
    }
    expect(controller.position.y).toBeCloseTo(CRATE.max.y, 6);

    // Yaw 0 walks along -Z, which leaves the crate by its north face.
    input.forward = 1;
    for (let frame = 0; frame < 60; frame += 1) controller.update(FRAME_SECONDS, input);

    expect(controller.position.z).toBeLessThan(CRATE.min.z);
    expect(controller.position.y).toBe(0);
    expect(controller.surfaceId).not.toBeNull();
  });
});

/**
 * The Inspector is staged inside the Security Office and steps out through its
 * door when the hunt opens (§5.9). Live play found that step refused: the floor
 * plan stops at the partition line and the office floor starts a tenth of a
 * metre east of it, so `surfaceAt` reported nothing underfoot in the doorway and
 * the walk-out was a wall the whole hunt.
 */
describe("the Security Office doorway", () => {
  const DOORWAY_Z = (OFFICE_DOOR_MIN_Z + OFFICE_DOOR_MAX_Z) / 2;

  it("carries walkable floor across the partition line", () => {
    for (let x = OFFICE_MIN_X - 0.2; x <= OFFICE_MIN_X + 0.2; x += 0.01) {
      expect(surfaceAt(NAV_DATA.floors, x, DOORWAY_Z, WORLD_SCALE.stepHeight), `x=${x.toFixed(2)}`)
        .not.toBeNull();
    }
  });

  it("lets an Inspector walk out of the office onto the sales floor", () => {
    const controller = new CharacterController(
      NAV_DATA,
      () => DEFAULT_MATCH_SETTINGS.inspectorMoveSpeed,
    );
    controller.teleportTo({ position: { x: 5.2, y: 0, z: DOORWAY_Z }, yaw: Math.PI / 2 });
    const input = createMoveInput();
    input.forward = 1;
    for (let frame = 0; frame < 600; frame += 1) controller.update(FRAME_SECONDS, input);

    expect(controller.position.x).toBeLessThan(OFFICE_MIN_X - 0.3);
  });

  it("keeps a Mimic out of the office, which is the Inspector's room alone", () => {
    const controller = new CharacterController(MIMIC_NAV_DATA, () => HIDER_FORGE_RUN_SPEED);
    controller.teleportTo({ position: { x: 4.3, y: 0, z: DOORWAY_Z }, yaw: -Math.PI / 2 });
    const input = createMoveInput();
    input.forward = 1;
    for (let frame = 0; frame < 600; frame += 1) controller.update(FRAME_SECONDS, input);

    expect(controller.position.x).toBeLessThan(OFFICE_MIN_X);
  });
});
