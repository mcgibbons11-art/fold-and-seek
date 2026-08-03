import { DEFAULT_MATCH_SETTINGS, HIDER_FORGE_RUN_SPEED, PLAYER_HEIGHT_M } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import { HiderLocomotion, isHiderMoveKey } from "../../src/forge/HiderLocomotion";
import {
  containsXZ,
  surfaceAt,
  WORLD_SCALE,
  type MutableVec3,
  type NavData,
} from "../../src/inspector/navData";
import { NAV_DATA } from "../../src/world/maps/nav";
import { openNavData, testNavData, MANTLE_TO_TABLE, TABLE_TOP } from "../inspector/navFixture";

/**
 * A Mimic on its feet. The claim under test is that a hider has the same body
 * the Inspector has — stopped by the same furniture, up onto the same shelves by
 * the same authored links — and that during the hunt it stays inside the speed
 * the authority will accept, so the body a player steers is never ahead of the
 * body the room has. The hop is measured separately, in `jump.test.ts`.
 */

const FRAME_SECONDS = 1 / 60;
/** Yaw 0 faces -Z in three's convention, so W walks along -Z. */
const FACING_NORTH = 0;
const CREEP_SPEED = DEFAULT_MATCH_SETTINGS.hiderCreepSpeed;
/**
 * Room for the rounding a few hundred additions of `speed / 60` leave behind.
 * A millimetre-thousandth is nowhere near the 5% the authority allows, so a cap
 * that had actually slipped would still be caught.
 */
const ROUNDING_M = 1e-6;

function at(x: number, y: number, z: number): MutableVec3 {
  return { x, y, z };
}

function distance(a: MutableVec3, b: MutableVec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Holds the given keys for `seconds` and hands back where the body ended up. */
function hold(
  locomotion: HiderLocomotion,
  keys: readonly string[],
  seconds: number,
  root: MutableVec3,
  yaw = FACING_NORTH,
): MutableVec3 {
  for (const key of keys) locomotion.press(key);
  const frames = Math.round(seconds / FRAME_SECONDS);
  for (let frame = 0; frame < frames; frame += 1) {
    locomotion.update(FRAME_SECONDS, yaw, root);
  }
  return root;
}

/** Holds the keys until the predicate holds, so no test counts frames. */
function holdUntil(
  locomotion: HiderLocomotion,
  keys: readonly string[],
  root: MutableVec3,
  yaw: number,
  done: (root: MutableVec3) => boolean,
  maxSeconds = 8,
): void {
  for (const key of keys) locomotion.press(key);
  const frames = Math.round(maxSeconds / FRAME_SECONDS);
  for (let frame = 0; frame < frames; frame += 1) {
    if (done(root)) return;
    locomotion.update(FRAME_SECONDS, yaw, root);
  }
  throw new Error("holdUntil: the body never got there");
}

/**
 * True while the body's own column stands inside a blocker rather than beside
 * it, which is what "walked into the furniture" actually means.
 *
 * `blocksCapsule` is the wrong question here even though it is the right one
 * for a step. It grows every box by the player radius, because it answers
 * whether a step may END somewhere; a body dropping cleanly past the side of
 * the counter is within a radius of it for the whole fall and would read as
 * blocked by it. So the fall is measured on the body's own column instead: its
 * centre inside the footprint, and its 0.35 m of height overlapping the box.
 */
function insideFurniture(root: MutableVec3): boolean {
  return NAV_DATA.blockers.some(
    (blocker) =>
      containsXZ(blocker, root.x, root.z) &&
      root.y < blocker.max.y - 1e-6 &&
      root.y + PLAYER_HEIGHT_M > blocker.min.y + 1e-6,
  );
}

/** Releases everything and runs on until the body has come to rest. */
function settle(locomotion: HiderLocomotion, root: MutableVec3, seconds = 3): void {
  locomotion.releaseAll();
  const frames = Math.round(seconds / FRAME_SECONDS);
  for (let frame = 0; frame < frames && locomotion.moving; frame += 1) {
    locomotion.update(FRAME_SECONDS, FACING_NORTH, root);
  }
}

describe("running the Mimic during the Forge", () => {
  it("faces achieved travel for cardinal and diagonal WASD intent", () => {
    const cases = [
      ["w"], ["s"], ["a"], ["d"],
      ["w", "a"], ["w", "d"], ["s", "a"], ["s", "d"],
    ] as const;

    for (const keys of cases) {
      const locomotion = new HiderLocomotion(openNavData());
      const root = at(0, 0, 0);
      for (const key of keys) locomotion.press(key);
      for (let frame = 0; frame < 20; frame += 1) {
        const before = { ...root };
        locomotion.update(FRAME_SECONDS, 0, root);
        const dx = root.x - before.x;
        const dz = root.z - before.z;
        const speed = Math.hypot(dx, dz) / FRAME_SECONDS;
        if (speed <= 0.1) continue;
        const travelX = dx / Math.hypot(dx, dz);
        const travelZ = dz / Math.hypot(dx, dz);
        const facingX = -Math.sin(locomotion.sample.travelYaw);
        const facingZ = -Math.cos(locomotion.sample.travelYaw);
        expect(facingX * travelX + facingZ * travelZ, keys.join("+")).toBeGreaterThanOrEqual(0.95);
      }
    }
  });

  it("covers the derived run speed over open floor", () => {
    const locomotion = new HiderLocomotion(openNavData());
    const root = at(0, 0, 0);
    // The first second is spent adopting the position and accelerating up to the
    // cap; the second is spent at it, and that is the one this measures.
    hold(locomotion, ["w"], 1, root);
    const start = { ...root };
    const end = hold(locomotion, ["w"], 1, root);

    expect(distance(start, end)).toBeCloseTo(HIDER_FORGE_RUN_SPEED, 2);
    expect(HIDER_FORGE_RUN_SPEED).toBeGreaterThan(DEFAULT_MATCH_SETTINGS.inspectorMoveSpeed);
  });

  it("steers relative to the camera rather than to the world", () => {
    const west = hold(new HiderLocomotion(openNavData()), ["w"], 0.5, at(0, 0, 0), Math.PI / 2);
    const north = hold(new HiderLocomotion(openNavData()), ["w"], 0.5, at(0, 0, 0), FACING_NORTH);

    // Yaw 0 faces -Z and a quarter turn faces -X, so the same key takes the
    // body a quarter turn round.
    expect(north.z).toBeLessThan(-0.1);
    expect(Math.abs(north.x)).toBeLessThan(1e-6);
    expect(west.x).toBeLessThan(-0.1);
    expect(Math.abs(west.z)).toBeLessThan(1e-6);
  });

  it("climbs the authored link it walks into", () => {
    const locomotion = new HiderLocomotion(testNavData());
    const start = MANTLE_TO_TABLE.position;
    const root = at(start.x + 0.5, 0, start.z);

    // Yaw +π/2 faces -X, which is straight at the mantle's floor endpoint.
    holdUntil(locomotion, ["w"], root, Math.PI / 2, (body) => body.y >= TABLE_TOP.bounds.max.y);
    expect(root.y).toBeCloseTo(TABLE_TOP.bounds.max.y, 3);

    // That link is the only way onto the table. Space hops, but a hop reaches
    // nothing that can be stood on, which `jump.test.ts` measures against the
    // shop's own surfaces.
    expect(isHiderMoveKey(" ")).toBe(true);
  });

  it("uses S to let go of a climb instead of climbing downward", () => {
    const locomotion = new HiderLocomotion(testNavData());
    const start = MANTLE_TO_TABLE.position;
    const root = at(start.x + 0.5, 0, start.z);

    locomotion.press("w");
    holdUntil(
      locomotion,
      [],
      root,
      Math.PI / 2,
      () => locomotion.motion.climbState !== null && root.y > 0.05,
    );
    const releasedAt = root.y;

    locomotion.release("w");
    locomotion.press("s");
    expect(locomotion.motion.climbState).toBeNull();

    for (let frame = 0; frame < 30; frame += 1) {
      locomotion.update(FRAME_SECONDS, Math.PI / 2, root);
      expect(locomotion.motion.climbState).toBeNull();
    }
    expect(root.y).toBeLessThan(releasedAt);
  });

  it("publishes a gravity-driven drop when S is pressed while W remains held", () => {
    const locomotion = new HiderLocomotion(testNavData());
    const start = MANTLE_TO_TABLE.position;
    const root = at(start.x + 0.5, 0, start.z);

    locomotion.press("w");
    holdUntil(
      locomotion,
      [],
      root,
      Math.PI / 2,
      () => locomotion.motion.climbState !== null && root.y > 0.05,
    );
    expect(root.y).toBeGreaterThan(0.05);

    const releasedAt = root.y;
    // W is deliberately still down. W+S cancels horizontal intent, but the
    // visible/published root must still leave traversal and fall from here.
    locomotion.press("s");
    expect(locomotion.motion.climbState).toBeNull();
    expect(locomotion.update(FRAME_SECONDS, Math.PI / 2, root)).toBe(true);
    expect(root.y).toBeLessThan(releasedAt);
    expect(root.y).toBeGreaterThan(0);
    expect(locomotion.motion.grounded).toBe(false);
    for (let frame = 0; frame < 180 && !locomotion.motion.grounded; frame += 1) {
      locomotion.update(FRAME_SECONDS, Math.PI / 2, root);
    }
    expect(root.y).toBeCloseTo(0, 6);
    expect(locomotion.motion.grounded).toBe(true);
  });

  it("falls off the surface it runs off, and stops when it lands", () => {
    // Standing on the workbench top, running north off the front edge.
    const locomotion = new HiderLocomotion(NAV_DATA);
    const root = at(6.8, 0.92, -0.7);
    hold(locomotion, ["w"], 2, root);
    settle(locomotion, root);

    expect(root.y).toBeLessThan(0.92);
    expect(locomotion.moving).toBe(false);
    const landed = surfaceAt(NAV_DATA.floors, root.x, root.z, root.y + WORLD_SCALE.stepHeight);
    expect(landed?.bounds.max.y).toBeCloseTo(root.y, 3);
  });

  it("stays out of the shop's furniture whichever way it is pointed", () => {
    let anythingBlocked = false;
    const freeRun = HIDER_FORGE_RUN_SPEED * 2;
    // Every spawn, the elevated ones included. They used to be left out, and
    // the reason was a real gap rather than a scoping choice: a body that ran
    // off the window deck was airborne, and the fall consulted the walkable
    // surfaces alone, so it came down through whatever furniture stood under
    // it. `CharacterController` now sweeps the descent against the blockers
    // too, which is what lets a run off the counter be measured here at all.
    const spawns = NAV_DATA.spawnPoints.mimics;
    expect(spawns.filter((spawn) => spawn.position.y > 0).length).toBeGreaterThan(2);

    for (const spawn of spawns) {
      for (let step = 0; step < 8; step += 1) {
        const locomotion = new HiderLocomotion(NAV_DATA);
        const start = at(spawn.position.x, spawn.position.y, spawn.position.z);
        const root = { ...start };
        const yaw = (step * Math.PI) / 4;

        locomotion.press("w");
        for (let frame = 0; frame < 120; frame += 1) {
          locomotion.update(FRAME_SECONDS, yaw, root);
          // A climb is exempt, and it has to be: a mantle down off the window
          // deck travels through the deck's own supporting box on the way to
          // the boards, which is what climbing down the edge of a thing looks
          // like. The claim is about where walking and falling leave the body.
          if (locomotion.motion.climbState !== null) continue;
          expect(
            insideFurniture(root),
            `ended up inside furniture from ${JSON.stringify(spawn.position)}`,
          ).toBe(false);
          expect(
            surfaceAt(NAV_DATA.floors, root.x, root.z, root.y + WORLD_SCALE.stepHeight),
          ).not.toBeNull();
        }
        if (distance(start, root) < freeRun * 0.9) anythingBlocked = true;
      }
    }

    // Otherwise the sweep above proves only that the shop is empty.
    expect(anythingBlocked).toBe(true);
  });
});

describe("creeping during the hunt", () => {
  function creeper(navData: NavData = openNavData()): HiderLocomotion {
    const locomotion = new HiderLocomotion(navData);
    locomotion.setCreepLimit(CREEP_SPEED);
    return locomotion;
  }

  it("holds the authority's cap over a two second hold", () => {
    const start = at(0, 0, 0);
    const end = hold(creeper(), ["w"], 2, { ...start });
    const travelled = distance(start, end);

    expect(travelled).toBeLessThanOrEqual(CREEP_SPEED * 2 + ROUNDING_M);
    expect(travelled).toBeGreaterThan(CREEP_SPEED * 1.9);
    // Starting the hunt no longer cuts WASD to the historical one-fifth crawl.
    expect(CREEP_SPEED).toBe(HIDER_FORGE_RUN_SPEED);
  });

  it("never spends more than the cap in a single frame, in any direction", () => {
    const locomotion = creeper();
    const root = at(0, 0, 0);
    locomotion.press("w");
    locomotion.press("d");

    let previous = { ...root };
    for (let frame = 0; frame < 240; frame += 1) {
      locomotion.update(FRAME_SECONDS, 0.8, root);
      // The authority measures a straight line from the last pose it accepted
      // against the time since. Capping each frame bounds every such line,
      // because a straight line is never longer than the path that drew it.
      expect(distance(previous, root)).toBeLessThanOrEqual(CREEP_SPEED * FRAME_SECONDS + ROUNDING_M);
      previous = { ...root };
    }
  });

  it("can run off a hiding surface and dismount during the hunt", () => {
    // Hunt movement must not strand a Hider on the workbench they locked on.
    const locomotion = creeper(NAV_DATA);
    const root = at(6.8, 0.92, -0.7);
    hold(locomotion, ["w"], 6, root);

    expect(root.y).toBeLessThan(0.92);
    expect(locomotion.motion.grounded).toBe(true);
    expect(surfaceAt(NAV_DATA.floors, root.x, root.z, root.y + WORLD_SCALE.stepHeight)).not.toBeNull();
  });

  it("does not creep a disguise that is standing on nothing", () => {
    // A wall mount hangs at chest height over the shop floor. There is nothing
    // underfoot to creep along, so the keys do nothing rather than dropping it.
    const locomotion = creeper(NAV_DATA);
    const root = at(-5.5, PLAYER_HEIGHT_M * 4, -3.8);
    const start = { ...root };
    hold(locomotion, ["w"], 2, root);

    expect(root).toEqual(start);
    expect(locomotion.moving).toBe(false);
  });

  it("re-reads the ground when the cap changes", () => {
    // Mid-run when the hunt opens: the walk ends and the next press starts a
    // creep, rather than the body carrying its Forge momentum into the hunt.
    const locomotion = new HiderLocomotion(openNavData());
    const root = at(0, 0, 0);
    hold(locomotion, ["w"], 0.5, root);
    expect(locomotion.moving).toBe(true);

    locomotion.setCreepLimit(CREEP_SPEED);
    expect(locomotion.moving).toBe(false);
    expect(locomotion.speed).toBe(CREEP_SPEED);

    const afterCap = { ...root };
    hold(locomotion, ["w"], 1, root);
    expect(distance(afterCap, root)).toBeLessThanOrEqual(CREEP_SPEED + ROUNDING_M);
  });
});

describe("settling", () => {
  it("comes to a stop a short coast after the keys are let go, and stays there", () => {
    const locomotion = new HiderLocomotion(openNavData());
    const root = at(0, 0, 0);
    hold(locomotion, ["w"], 1, root);
    const released = { ...root };

    settle(locomotion, root);
    expect(locomotion.moving).toBe(false);
    // A body with momentum does not stop on the frame the key comes up. It
    // decelerates, and at this size that is a coast of a few centimetres rather
    // than a slide: well under one body length, and forward, never backward.
    const coast = distance(released, root);
    expect(coast).toBeGreaterThan(0);
    expect(coast).toBeLessThan(PLAYER_HEIGHT_M);
    expect(root.z).toBeLessThan(released.z);

    // And nothing drifts once it is at rest, however long the frame loop runs.
    const stopped = { ...root };
    for (let frame = 0; frame < 120; frame += 1) {
      expect(locomotion.update(FRAME_SECONDS, FACING_NORTH, root)).toBe(false);
    }
    expect(root).toEqual(stopped);
  });

  it("drops every held key when the window loses focus", () => {
    const locomotion = new HiderLocomotion(openNavData());
    const root = at(0, 0, 0);
    hold(locomotion, ["w", "d"], 0.5, root);

    locomotion.releaseAll();
    settle(locomotion, root);
    const stopped = { ...root };
    for (let frame = 0; frame < 60; frame += 1) {
      locomotion.update(FRAME_SECONDS, FACING_NORTH, root);
    }
    expect(root).toEqual(stopped);
  });
});
