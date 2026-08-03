import { DEFAULT_MATCH_SETTINGS, HIDER_FORGE_RUN_SPEED, JUMP_HEIGHT_M } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import { HiderLocomotion } from "../../src/forge/HiderLocomotion";
import {
  CharacterController,
  createMoveInput,
  JUMP_FALL_GRAVITY_SCALE,
  JUMP_RISE_GRAVITY_SCALE,
} from "../../src/inspector/CharacterController";
import { InspectorController } from "../../src/inspector/InspectorController";
import {
  WORLD_SCALE,
  type AABB,
  type MutableVec3,
  type NavData,
} from "../../src/inspector/navData";
import { CLIMB_LINKS, CLUTTER_BLOCKERS, NAV_DATA, WALKABLE_SURFACES } from "../../src/world/maps/nav";
import { box, openNavData, surface, testSettings, SHOP_FLOOR } from "../inspector/navFixture";

/**
 * The jump (CLAUDE.md override 6, a reversal of the rule the rest of this
 * movement code was written under). Two claims are load-bearing and both are
 * measured against the map rather than asserted from the design intent: a hop
 * clears an obstacle a walk cannot, while Forward + Jump at a solid face asks
 * the contextual climbing path to take over.
 */

const FRAME_SECONDS = 1 / 60;
const FACING_NORTH = 0;

/** How high the feet get with the step lip added, which is what mounts a ledge. */
const HOP_REACH_M = JUMP_HEIGHT_M + WORLD_SCALE.stepHeight;

/**
 * How far a hop carries the body, which is what decides whether a ledge beside
 * a crate is within reach of one taken off its top. The airtime is the rise
 * under the light half of the arc plus the fall under the heavy half, the body
 * covers it at the Forge run, and the player radius is added because a capsule
 * mounts a ledge as soon as its own edge reaches it rather than its centre.
 */
const HOP_TRAVEL_M =
  (Math.sqrt((2 * JUMP_HEIGHT_M) / (WORLD_SCALE.gravity * JUMP_RISE_GRAVITY_SCALE)) +
    Math.sqrt((2 * JUMP_HEIGHT_M) / (WORLD_SCALE.gravity * JUMP_FALL_GRAVITY_SCALE))) *
    HIDER_FORGE_RUN_SPEED +
  WORLD_SCALE.playerRadius;

/** Distance between two footprints in the XZ plane, zero where they overlap. */
function footprintGap(a: AABB, b: AABB): number {
  const dx = Math.max(a.min.x - b.max.x, b.min.x - a.max.x, 0);
  const dz = Math.max(a.min.z - b.max.z, b.min.z - a.max.z, 0);
  return Math.hypot(dx, dz);
}

/**
 * The workshop's small packing crate, which is the obstacle these traversal
 * claims are made against. It is a real prop with a real blocker rather than a
 * fixture: the Curiosity Shop used to have nothing a hop could cross, so the
 * only way to prove the jump was a route past anything was to build a kerb for
 * it, and that proved the physics without proving the map.
 */
const CRATE: AABB = (() => {
  const found = CLUTTER_BLOCKERS.find(
    (blocker) => blocker.min.x > 4.2 && blocker.max.x < 4.7 && blocker.min.z > -1.1,
  );
  if (found === undefined) throw new Error("the map no longer has the workshop clutter crate");
  return found;
})();

/** Straight at the crate from the south, on the open boards of zone F. */
const CRATE_APPROACH_X = (CRATE.min.x + CRATE.max.x) / 2;
const CRATE_APPROACH_Z = CRATE.max.z + 0.5;

function at(x: number, y: number, z: number): MutableVec3 {
  return { x, y, z };
}

/**
 * The apex of a hop is a frame lower than the height it was authored at, and
 * always lower rather than sometimes higher. The controller decrements the
 * velocity before it integrates, so the discrete arc undershoots the analytic
 * one by about half a frame's worth of takeoff speed. That is the safe
 * direction — `JUMP_HEIGHT_M` is a true ceiling on how high a body gets, which
 * is what the "cannot mount" invariant below relies on.
 */
const APEX_SLACK_M = Math.sqrt(2 * WORLD_SCALE.gravity * JUMP_HEIGHT_M) * FRAME_SECONDS;

/**
 * Holds the keys for `seconds`, then lets go and runs on until the body is back
 * at rest. Every claim here is about where a hop ends up, so a run that stopped
 * with the key still down would be measuring a body in mid-air.
 */
function runKeys(
  locomotion: HiderLocomotion,
  keys: readonly string[],
  seconds: number,
  root: MutableVec3,
  yaw = FACING_NORTH,
): { readonly apexY: number } {
  for (const key of keys) locomotion.press(key);
  let apexY = root.y;
  const frames = Math.round(seconds / FRAME_SECONDS);
  for (let frame = 0; frame < frames; frame += 1) {
    locomotion.update(FRAME_SECONDS, yaw, root);
    apexY = Math.max(apexY, root.y);
  }

  locomotion.releaseAll();
  for (let frame = 0; frame < frames + 120 && locomotion.airborne; frame += 1) {
    locomotion.update(FRAME_SECONDS, yaw, root);
    apexY = Math.max(apexY, root.y);
  }
  if (locomotion.airborne) throw new Error("runKeys: the body never came down");
  return { apexY };
}

describe("the hop", () => {
  it("rises to the authored height, within a frame of it, and comes back down", () => {
    const locomotion = new HiderLocomotion(openNavData());
    const root = at(0, 0, 0);
    const { apexY } = runKeys(locomotion, [" "], 1, root);

    expect(apexY).toBeGreaterThan(JUMP_HEIGHT_M - APEX_SLACK_M);
    expect(apexY).toBeLessThanOrEqual(JUMP_HEIGHT_M);
    expect(root.y).toBeCloseTo(0, 6);
  });

  it("crosses a crate on the shop's own floor that stops a walk", () => {
    const walked = at(CRATE_APPROACH_X, 0, CRATE_APPROACH_Z);
    runKeys(new HiderLocomotion(NAV_DATA), ["w"], 3, walked);
    // Travelling north, the walk is held a player radius south of the crate's
    // own face and gets no further however long the key is held.
    expect(walked.z).toBeGreaterThan(CRATE.max.z + WORLD_SCALE.playerRadius - 0.01);
    // And it was the crate that stopped it, rather than the walk never starting
    // or something else in the shop getting in the way first.
    expect(walked.z).toBeLessThan(CRATE.max.z + WORLD_SCALE.playerRadius + 0.02);

    // The same approach with space held. A hop is not a vault: the body is
    // clear of the blocker only while its feet are above the crate's top less a
    // step, which is a fraction of a second, so it crosses in a few hops rather
    // than in one bound. What matters is that it crosses at all and that it is
    // standing on the floor when it does.
    const hopped = at(CRATE_APPROACH_X, 0, CRATE_APPROACH_Z);
    runKeys(new HiderLocomotion(NAV_DATA), ["w", " "], 3, hopped);
    expect(hopped.z).toBeLessThan(CRATE.min.z - WORLD_SCALE.playerRadius);
    expect(hopped.y).toBeCloseTo(0, 6);
  });

  it("gives every piece of map clutter a height a hop crosses and a walk does not", () => {
    // The band the clutter is authored into, taken from the map rather than
    // restated: retuning the hop or a crate fails here rather than quietly
    // turning a hoppable obstacle into a wall or into a lip.
    expect(CLUTTER_BLOCKERS.length).toBeGreaterThanOrEqual(12);
    for (const blocker of CLUTTER_BLOCKERS) {
      const where = `clutter at ${blocker.min.x.toFixed(2)},${blocker.min.z.toFixed(2)}`;
      expect(blocker.min.y, where).toBe(0);
      expect(blocker.max.y, where).toBeGreaterThan(WORLD_SCALE.stepHeight);
      expect(blocker.max.y, where).toBeLessThan(HOP_REACH_M);
    }
  });

  it("opens no route off the clutter that the climb links do not already offer", () => {
    // A fall now resolves onto a blocker top instead of dropping through it, so
    // a body can come to rest on a crate and hop from there — a takeoff height
    // that did not exist when the only way onto clutter was to pass through it.
    // The giant-scale rule is that the map decides where a body can get up, so
    // what has to hold is not that the move is impossible but that everything
    // it reaches was already reachable by an authored route.
    const inBand: string[] = [];
    for (const clutter of CLUTTER_BLOCKERS) {
      for (const ledge of WALKABLE_SURFACES) {
        const top = ledge.bounds.max.y;
        if (top <= clutter.max.y + WORLD_SCALE.stepHeight) continue;
        if (top > clutter.max.y + HOP_REACH_M) continue;
        inBand.push(ledge.id);
        if (footprintGap(clutter, ledge.bounds) > HOP_TRAVEL_M) continue;
        expect(
          CLIMB_LINKS.some((link) => link.to === ledge.id),
          `${ledge.id} is within a hop of the clutter at ${clutter.min.x.toFixed(2)},${clutter.min.z.toFixed(2)} and has no authored way up`,
        ).toBe(true);
      }
    }

    // Not a vacuous pass: the shop really does stand clutter under ledges that a
    // hop off it would reach, so the loop above had something to judge.
    expect(inBand.length).toBeGreaterThan(0);
  });

  it("reaches nothing in the shop that can be stood on", () => {
    // The invariant, taken from the map: no walkable surface a body could climb
    // onto is within a hop's reach of the floor it would hop from. Retuning
    // either the hop or the map's lowest ledge fails here rather than quietly
    // handing the player a shortcut past the climb links.
    const elevated = WALKABLE_SURFACES.filter(
      (entry) => entry.bounds.max.y > WORLD_SCALE.stepHeight,
    );
    expect(elevated.length).toBeGreaterThan(20);

    const lowest = Math.min(...elevated.map((entry) => entry.bounds.max.y));
    expect(HOP_REACH_M).toBeLessThan(lowest);
    // And it is a hop rather than a stumble: more than the lip a walk crosses.
    expect(JUMP_HEIGHT_M).toBeGreaterThan(WORLD_SCALE.stepHeight * 2);
  });

  it("turns a held Forward + Jump at the steel rack into a contextual climb", () => {
    const board = WALKABLE_SURFACES.find((entry) => entry.id === "shelving_board_1");
    if (board === undefined) throw new Error("the map no longer has shelving_board_1");

    // Standing on the floor at the board's south edge, hopping straight at it.
    const locomotion = new HiderLocomotion(NAV_DATA);
    const root = at(
      (board.bounds.min.x + board.bounds.max.x) / 2,
      0,
      board.bounds.max.z + WORLD_SCALE.playerRadius * 2,
    );
    locomotion.press("w");
    locomotion.press(" ");
    let apexY = root.y;
    for (let frame = 0; frame < 4 / FRAME_SECONDS; frame += 1) {
      locomotion.update(FRAME_SECONDS, Math.PI, root);
      apexY = Math.max(apexY, root.y);
      if (root.y >= board.bounds.max.y && locomotion.motion.climbState === null) break;
    }
    locomotion.releaseAll();

    expect(apexY).toBeGreaterThan(board.bounds.max.y);
    // The rack's frame is a taller solid than its first published board. The
    // contextual route takes the actual solid top, not the lower nav shelf.
    expect(root.y).toBeCloseTo(apexY, 5);
  });

  it("does not launch a second time in mid-air", () => {
    const locomotion = new HiderLocomotion(openNavData());
    const root = at(0, 0, 0);
    // Space held throughout, so the body hops again each time it lands. No
    // single hop may stack onto the last and turn into a climb.
    const { apexY } = runKeys(locomotion, [" "], 3, root);
    expect(apexY).toBeLessThanOrEqual(JUMP_HEIGHT_M);
  });
});

describe("hopping while the hunt's creep cap is on", () => {
  const CREEP_SPEED = DEFAULT_MATCH_SETTINGS.hiderCreepSpeed;

  function creeper(navData: NavData = openNavData()): HiderLocomotion {
    const locomotion = new HiderLocomotion(navData);
    locomotion.setCreepLimit(CREEP_SPEED);
    return locomotion;
  }

  it("lands back on the height it left, so a hop in place costs no ground", () => {
    const locomotion = creeper();
    // Deliberately resting above the floor rather than on it, but still within
    // ground snap: a locked disguise sits where the Forge posed it, and landing
    // on whatever is underfoot instead would spend creep budget the hop never
    // earned. The offset is under `groundSnap`, so the body counts as standing.
    const restY = WORLD_SCALE.groundSnap / 2;
    const root = at(0, restY, 0);
    const { apexY } = runKeys(locomotion, [" "], 1, root);

    expect(apexY).toBeGreaterThan(restY + JUMP_HEIGHT_M - APEX_SLACK_M);
    expect(apexY).toBeLessThanOrEqual(restY + JUMP_HEIGHT_M);
    expect(root.y).toBe(restY);
    expect(root.x).toBe(0);
    expect(root.z).toBe(0);
  });

  it("never travels faster than the cap, hop included", () => {
    const locomotion = creeper();
    const root = at(0, 0, 0);
    const start = { ...root };
    locomotion.press("w");
    locomotion.press(" ");
    let elapsed = 0;
    for (let frame = 0; frame < 2 / FRAME_SECONDS; frame += 1) {
      locomotion.update(FRAME_SECONDS, FACING_NORTH, root);
      elapsed += FRAME_SECONDS;
    }
    locomotion.releaseAll();
    while (locomotion.airborne && elapsed < 4) {
      locomotion.update(FRAME_SECONDS, FACING_NORTH, root);
      elapsed += FRAME_SECONDS;
    }
    // Two seconds of holding both keys. The authority measures the straight
    // line between published poses, and both are taken on the ground, so what
    // matters is that the horizontal is capped and the height came back.
    expect(root.y).toBe(0);
    expect(Math.hypot(root.x - start.x, root.z - start.z)).toBeLessThanOrEqual(CREEP_SPEED * elapsed + 1e-6);
  });

  it("reports itself airborne so the round holds the pose until it lands", () => {
    const locomotion = creeper();
    const root = at(0, 0, 0);
    expect(locomotion.airborne).toBe(false);

    locomotion.press(" ");
    locomotion.update(FRAME_SECONDS, FACING_NORTH, root);
    expect(locomotion.airborne).toBe(true);

    locomotion.releaseAll();
    for (let frame = 0; frame < 120 && locomotion.airborne; frame += 1) {
      locomotion.update(FRAME_SECONDS, FACING_NORTH, root);
    }
    expect(locomotion.airborne).toBe(false);
    expect(root.y).toBe(0);
  });
});

describe("the Inspector hops on the same key with the same physics", () => {
  it("reaches the same height as a Mimic and lands on the floor it left", () => {
    const controller = new InspectorController(openNavData(), testSettings());
    controller.teleportTo({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });

    const input = createMoveInput();
    input.jump = true;
    let apexY = controller.position.y;
    for (let frame = 0; frame < 12; frame += 1) {
      controller.update(FRAME_SECONDS, input);
      apexY = Math.max(apexY, controller.position.y);
    }
    input.jump = false;
    for (let frame = 0; frame < 120 && !controller.grounded; frame += 1) {
      controller.update(FRAME_SECONDS, input);
      apexY = Math.max(apexY, controller.position.y);
    }

    expect(apexY).toBeGreaterThan(JUMP_HEIGHT_M - APEX_SLACK_M);
    expect(apexY).toBeLessThanOrEqual(JUMP_HEIGHT_M);
    expect(controller.position.y).toBeCloseTo(0, 6);
    expect(controller.grounded).toBe(true);
  });

  it("still cannot reach a ledge it has no climb link to", () => {
    // A shelf one hop's reach above the floor plus a millimetre.
    const shelf = surface(
      "shelf",
      box(-1, HOP_REACH_M + 0.001, -2, 1, HOP_REACH_M + 0.051, 0),
      1,
    );
    const navData: NavData = {
      floors: [SHOP_FLOOR, shelf],
      blockers: [],
      climbLinks: [],
      spawnPoints: { inspectors: [], mimics: [] },
      securityOffice: box(-9, 0, -9, -8, 1, -8),
    };

    const controller = new InspectorController(navData, testSettings());
    controller.teleportTo({ position: { x: 0, y: 0, z: 1 }, yaw: 0 });
    const input = createMoveInput();
    input.jump = true;
    input.forward = 1;
    for (let frame = 0; frame < 240; frame += 1) controller.update(FRAME_SECONDS, input);
    input.jump = false;
    for (let frame = 0; frame < 120 && !controller.grounded; frame += 1) {
      controller.update(FRAME_SECONDS, input);
    }

    expect(controller.surfaceId).toBe("floor");
    expect(controller.position.y).toBeCloseTo(0, 6);
  });
});

describe("the shared controller", () => {
  it("gives both roles the same hop, because there is only one body", () => {
    const forHider = new CharacterController(openNavData(), () => 0);
    const forInspector = new CharacterController(openNavData(), () => 0);
    const input = createMoveInput();
    input.jump = true;

    for (const controller of [forHider, forInspector]) {
      controller.teleportTo({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });
    }
    for (let frame = 0; frame < 30; frame += 1) {
      forHider.update(FRAME_SECONDS, input);
      forInspector.update(FRAME_SECONDS, input);
      expect(forHider.position.y).toBe(forInspector.position.y);
    }
    expect(forHider.position.y).toBeGreaterThan(0);
  });
});
