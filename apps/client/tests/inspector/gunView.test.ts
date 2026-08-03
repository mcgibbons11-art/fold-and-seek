import { Group, PerspectiveCamera, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { InspectableSet } from "../../src/inspector/FocusSystem";
import { GunView, MISS_RANGE_M, shotImpactPoint } from "../../src/inspector/GunView";
import { createInspectorSystem } from "../../src/inspector/index";
import { WORLD_SCALE } from "../../src/inspector/navData";
import { openNavData, testSettings } from "./navFixture";

/**
 * What the gun shows, checked without a renderer. Nothing here draws: the
 * assertions are on the scene graph the renderer would have been handed, which
 * is where the warrant count and the shot effects actually live.
 */

const FRAME_MS = 16;

/** The rest frame: standing still, gun at the hip, facing yaw 0, which is -z. */
function restFrame(overrides: Partial<Parameters<GunView["update"]>[1]> = {}) {
  return {
    eye: { x: 0, y: WORLD_SCALE.eyeHeight, z: 0 },
    yaw: 0,
    pitch: 0,
    aimAmount: 0,
    swayScale: 1,
    speedMps: 0,
    ...overrides,
  };
}

function harness(): { gun: GunView; scene: Scene; model: Group } {
  const scene = new Scene();
  const gun = new GunView(scene);
  const model = scene.children.find(
    (child): child is Group => child.name === "inspector-gun",
  );
  if (model === undefined) throw new Error("the gun never reached the scene");
  return { gun, scene, model };
}

/** Runs the gun forward, which is what ages every effect in the air. */
function run(gun: GunView, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
    gun.update(FRAME_MS, restFrame());
  }
}

/**
 * Long enough for the pair of primer effects the gun links its shaders with to
 * have expired, so what is left in the air afterwards came from a trigger.
 */
function settle(gun: GunView): void {
  run(gun, 400);
}

describe("GunView warrants", () => {
  it("chambers one round per warrant and empties them as they are spent", () => {
    const { gun } = harness();
    gun.setWarrants(5, 5);
    expect(gun.liveChambers).toBe(5);

    gun.setWarrants(3, 5);
    expect(gun.liveChambers).toBe(3);

    gun.setWarrants(0, 5);
    expect(gun.liveChambers).toBe(0);
  });

  it("keeps the drum readable when the magazine is larger than it can draw", () => {
    const { gun } = harness();
    gun.setWarrants(12, 12);
    expect(gun.liveChambers).toBe(8);
  });

  it("never shows more rounds than the drum was built with", () => {
    const { gun } = harness();
    gun.setWarrants(9, 4);
    expect(gun.liveChambers).toBe(4);
  });
});

describe("GunView firing", () => {
  it("throws a flash, a trail and a mark for a round that reached something", () => {
    const { gun } = harness();
    settle(gun);
    gun.fire("hit", { x: 2, y: WORLD_SCALE.eyeHeight, z: 0 });
    expect(gun.effectCount).toBeGreaterThan(2);
  });

  it("shows nothing leaving the barrel when the chamber was empty", () => {
    const { gun } = harness();
    settle(gun);
    gun.fire("empty", null);
    expect(gun.effectCount).toBe(0);
  });

  it("marks where a round that hit no object landed", () => {
    const { gun } = harness();
    settle(gun);
    gun.fire("miss", { x: 4, y: WORLD_SCALE.eyeHeight, z: 0 });
    expect(gun.effectCount).toBeGreaterThan(2);
  });

  it("clears every effect once it has run its course", () => {
    const { gun } = harness();
    settle(gun);
    gun.fire("hit", { x: 2, y: WORLD_SCALE.eyeHeight, z: 0 });
    run(gun, 2_000);
    expect(gun.effectCount).toBe(0);
  });

  it("answers a verdict where the round landed and settles afterwards", () => {
    const { gun } = harness();
    settle(gun);
    gun.fire("hit", { x: 2, y: WORLD_SCALE.eyeHeight, z: 0 });
    run(gun, 2_000);

    gun.resolve(true);
    expect(gun.effectCount).toBe(1);
    run(gun, 2_000);
    expect(gun.effectCount).toBe(0);
  });

  it("has nothing to flare when the verdict answers a round that reached nothing", () => {
    const { gun } = harness();
    settle(gun);
    gun.fire("not_shootable", { x: 2, y: WORLD_SCALE.eyeHeight, z: 0 });
    run(gun, 2_000);

    gun.resolve(false);
    expect(gun.effectCount).toBe(0);
  });
});

describe("GunView carriage", () => {
  it("parents the weapon to a scaled rig socket without shrinking it", () => {
    const { gun, scene, model } = harness();
    const scaledRig = new Group();
    scaledRig.scale.setScalar(0.2);
    const socket = new Group();
    socket.name = "WeaponSocket_R";
    scaledRig.add(socket);
    scene.add(scaledRig);
    scene.updateMatrixWorld(true);

    gun.attachToSocket(socket);
    scene.updateMatrixWorld(true);

    expect(model.parent).toBe(socket);
    expect(model.getWorldScale(new Vector3()).distanceTo(new Vector3(1, 1, 1))).toBeLessThan(1e-9);
    expect(model.position.length()).toBe(0);
  });

  it("carries the gun to the right of and below the eye, ahead of the body", () => {
    const { gun, model } = harness();
    settle(gun);

    // Facing yaw 0 is -z in three, so "ahead" is negative z and "right" is +x.
    expect(model.position.x).toBeGreaterThan(0);
    expect(model.position.y).toBeLessThan(WORLD_SCALE.eyeHeight);
    expect(model.position.z).toBeLessThan(0);
  });

  it("brings the gun towards the sight line as the aim closes", () => {
    const { gun, model } = harness();
    settle(gun);
    const hip = model.position.clone();

    gun.update(FRAME_MS, restFrame({ aimAmount: 1 }));
    expect(model.position.x).toBeLessThan(hip.x);
    expect(model.position.y).toBeGreaterThan(hip.y);
    expect(model.position.z).toBeLessThan(hip.z);
  });

  it("kicks on a shot and recovers the carry within a moment", () => {
    // Against a gun nobody fired, run frame for frame alongside it: the idle
    // drift both of them breathe with then cancels, and what is left is the
    // kick.
    const fired = harness();
    const held = harness();
    settle(fired.gun);
    settle(held.gun);

    fired.gun.fire("hit", { x: 2, y: WORLD_SCALE.eyeHeight, z: 0 });
    fired.gun.update(FRAME_MS, restFrame());
    held.gun.update(FRAME_MS, restFrame());
    const kick = fired.model.position.distanceTo(held.model.position);
    expect(kick).toBeGreaterThan(1e-3);

    run(fired.gun, 2_000);
    run(held.gun, 2_000);
    expect(fired.model.position.distanceTo(held.model.position)).toBeLessThan(kick / 100);
  });

  it("takes the whole rig out of the scene when the hunt ends", () => {
    const { gun, scene } = harness();
    settle(gun);
    gun.fire("hit", { x: 2, y: WORLD_SCALE.eyeHeight, z: 0 });

    gun.dispose();
    expect(scene.children).toHaveLength(0);
  });
});

describe("the Inspector carries the gun", () => {
  function inspector() {
    return createInspectorSystem({
      scene: new Scene(),
      camera: new PerspectiveCamera(),
      navData: openNavData(),
      inspectables: new InspectableSet(),
      sendCommand: () => undefined,
      onFocusChange: () => undefined,
      settings: testSettings(),
    });
  }

  it("loads the drum from the authority's warrant count", () => {
    const system = inspector();
    system.spawnAt({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });

    system.setAmmo(4, 4);
    expect(system.gun.liveChambers).toBe(4);

    system.setAmmo(1, 4);
    expect(system.gun.liveChambers).toBe(1);
  });

  it("keeps a rejoiner's drum at the fullest magazine it has been told about", () => {
    const system = inspector();
    system.setAmmo(2);
    expect(system.gun.liveChambers).toBe(2);
  });

  it("takes the gun with it when the hunt ends", () => {
    const system = inspector();
    system.spawnAt({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });
    system.update(FRAME_MS, 0);

    system.dispose();
    expect(system.gun.effectCount).toBe(0);
  });
});

describe("shotImpactPoint", () => {
  const eye = { x: 0, y: 1, z: 0 };
  const forward = { x: 1, y: 0, z: 0 };

  it("stops the round at the object under the reticle", () => {
    expect(shotImpactPoint(eye, forward, 2.5, 9)).toEqual(new Vector3(2.5, 1, 0));
  });

  it("stops a round that found no object at the first wall in its way", () => {
    expect(shotImpactPoint(eye, forward, null, 4)).toEqual(new Vector3(4, 1, 0));
  });

  it("carries a round that meets nothing at all out to its own range", () => {
    expect(shotImpactPoint(eye, forward, null, -1)).toEqual(new Vector3(MISS_RANGE_M, 1, 0));
  });
});
