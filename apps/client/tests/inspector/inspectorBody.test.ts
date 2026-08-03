import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { MAX_PITCH_RAD } from "../../src/inspector/CharacterController";
import { InspectableSet } from "../../src/inspector/FocusSystem";
import { GunView } from "../../src/inspector/GunView";
import { ARM_REACH, GUN_SHOULDER, InspectorBody } from "../../src/inspector/InspectorBody";
import { createInspectorSystem } from "../../src/inspector/index";
import { WORLD_SCALE } from "../../src/inspector/navData";
import { programStructureKey } from "../world/programStructure";
import { openNavData, testSettings } from "./navFixture";

/**
 * The Inspector's body, checked without a renderer.
 *
 * Two of these are load bearing rather than cosmetic. The gun has to stay in
 * the hand through every pose the hunt puts the body in — that is the whole
 * reason the body exists — and the body has to stay out of the reticle's sight
 * line, because an Inspector who cannot see what they are shooting at is worse
 * off than one with no body at all.
 */

const H = WORLD_SCALE.playerHeight;
const FRAME_MS = 16;
const FRAME_S = FRAME_MS / 1000;

/** A walk at the settings' own Inspector speed, which is what the gait scales against. */
const WALK_SPEED = testSettings().inspectorMoveSpeed;

function standing(overrides: Partial<Parameters<InspectorBody["update"]>[1]> = {}) {
  return {
    speedMps: 0,
    speedCapMps: WALK_SPEED,
    airborne: false,
    climbing: false,
    landingSpeed: 0,
    pitch: 0,
    aimAmount: 0,
    ...overrides,
  };
}

/**
 * The Inspector, its gun and the root that carries them, wired exactly as
 * `createInspectorSystem` wires them: body under a root at the feet, hand in
 * the world, gun in the hand.
 */
function harness() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const gun = new GunView(scene);
  const body = new InspectorBody(root, scene);
  gun.attachToHand(body.hand);

  /** One frame at a position and heading, gun first and body second. */
  function step(
    position: { x: number; y: number; z: number },
    yaw: number,
    frame: Partial<Parameters<InspectorBody["update"]>[1]> = {},
  ): void {
    root.position.set(position.x, position.y, position.z);
    root.rotation.y = yaw;
    const body3 = standing(frame);
    gun.update(FRAME_MS, {
      eye: { x: position.x, y: position.y + WORLD_SCALE.eyeHeight, z: position.z },
      yaw,
      pitch: body3.pitch,
      aimAmount: body3.aimAmount,
      swayScale: 1,
      speedMps: body3.speedMps,
    });
    body.update(FRAME_S, body3);
    scene.updateMatrixWorld(true);
  }

  return { scene, root, gun, body, step };
}

/**
 * The far end of a limb mesh, which for the forearm is the wrist. Limbs are
 * placed with their +Y toward the joint they end at, so this is the end that
 * should be holding the gun.
 */
function limbTip(mesh: THREE.Mesh): THREE.Vector3 {
  const height = (mesh.geometry as THREE.CylinderGeometry).parameters.height;
  mesh.updateWorldMatrix(true, false);
  return mesh.localToWorld(new THREE.Vector3(0, height / 2, 0));
}

function meshNamed(body: InspectorBody, name: string): THREE.Mesh {
  const found = body.meshes.find((mesh) => mesh.name === `inspector-${name}`);
  if (found === undefined) throw new Error(`no ${name} in the body`);
  return found;
}

describe("the Inspector's gun stays in the Inspector's hand", () => {
  it("holds the gun at the hand, not near it, standing still", () => {
    const { body, gun, step } = harness();
    step({ x: 0, y: 0, z: 0 }, 0);

    const hand = body.hand.getWorldPosition(new THREE.Vector3());
    const held = gun.gripWorldPosition();
    expect(held.distanceTo(hand)).toBeLessThan(1e-9);
  });

  it("keeps the wrist on the gun through a whole walk cycle", () => {
    const { body, step } = harness();
    const wrist = meshNamed(body, "forearm-R");

    // Two seconds of walking in a straight line, which is several strides at
    // this body's `FOOTFALL_DISTANCE_M`, sampled every frame rather than at the
    // end: an arm that reaches the gun only when the gait passes through zero
    // would pass an end-state check and fail a player.
    let worst = 0;
    for (let frame = 0; frame < 125; frame += 1) {
      const z = -WALK_SPEED * frame * FRAME_S;
      step({ x: 0, y: 0, z }, 0, { speedMps: WALK_SPEED });
      const hand = body.hand.getWorldPosition(new THREE.Vector3());
      worst = Math.max(worst, limbTip(wrist).distanceTo(hand));
    }

    // A tenth of a millimetre at this scale. The arm is solved to the hand, so
    // the only slack is the wrist's own clamp, and it never engages.
    expect(worst).toBeLessThan(H * 3e-4);
  });

  it("keeps the wrist on the gun at every pitch the player can aim through", () => {
    // The whole pitch range at both ends of the aim blend, and turning as it
    // goes. This is the sweep that found the carry leaving the arm behind:
    // pitching the offsets about the eye by the full look angle swings the grip
    // out past the shoulder's reach near the top of the range.
    const { body, step } = harness();
    const wrist = meshNamed(body, "forearm-R");
    let worst = 0;

    for (const aim of [0, 0.5, 1]) {
      for (let sample = -20; sample <= 20; sample += 1) {
        const pitch = (sample / 20) * MAX_PITCH_RAD;
        step({ x: 0, y: 0, z: 0 }, (sample / 20) * Math.PI, { aimAmount: aim, pitch });
        const hand = body.hand.getWorldPosition(new THREE.Vector3());
        worst = Math.max(worst, limbTip(wrist).distanceTo(hand));
      }
    }

    expect(worst).toBeLessThan(H * 3e-4);
  });

  it("carries the gun inside the arm it is held with", () => {
    // The reason the two above pass. Every carry `GunView` authors has to stay
    // within reach of the shoulder at every pitch and aim, and this is that
    // claim stated where a retune of either file trips over it, with the worst
    // case named so the retune knows which end it broke.
    const { body, step } = harness();
    const shoulder = new THREE.Vector3(GUN_SHOULDER.x, GUN_SHOULDER.y, GUN_SHOULDER.z);
    let furthest = 0;
    let worstCase = "";

    for (const aim of [0, 0.25, 0.5, 0.75, 1]) {
      for (let sample = -20; sample <= 20; sample += 1) {
        const pitch = (sample / 20) * MAX_PITCH_RAD;
        step({ x: 0, y: 0, z: 0 }, 0, { aimAmount: aim, pitch });
        const reach = body.hand.getWorldPosition(new THREE.Vector3()).distanceTo(shoulder);
        if (reach > furthest) {
          furthest = reach;
          worstCase = `aim ${aim}, pitch ${pitch.toFixed(2)}: ${(reach / (ARM_REACH * H)).toFixed(3)} of the arm`;
        }
      }
    }

    expect(furthest, worstCase).toBeLessThan(ARM_REACH * H);
  });
});

describe("the Inspector's body walks", () => {
  it("swings the legs while walking and stands still while standing", () => {
    const { body, step } = harness();
    const boot = meshNamed(body, "boot-L");

    step({ x: 0, y: 0, z: 0 }, 0);
    const still = boot.getWorldPosition(new THREE.Vector3());
    for (let frame = 0; frame < 30; frame += 1) step({ x: 0, y: 0, z: 0 }, 0);
    expect(boot.getWorldPosition(new THREE.Vector3()).distanceTo(still)).toBeLessThan(H * 0.01);

    let swing = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      step({ x: 0, y: 0, z: -WALK_SPEED * frame * FRAME_S }, 0, { speedMps: WALK_SPEED });
      // Measured in the body's own frame, so travelling does not count as a stride.
      swing = Math.max(swing, Math.abs(boot.getWorldPosition(new THREE.Vector3()).z + WALK_SPEED * frame * FRAME_S));
    }
    expect(swing).toBeGreaterThan(H * 0.05);
  });
});

describe("the Inspector's body is cheap to draw and cheap to link", () => {
  it("costs no shader program the gun does not already need", () => {
    // The census in `tests/world/programCensus.test.ts` counts the shop. This
    // is the same measurement for the character: every body material has to
    // generate source the gun's materials already generate, or the Inspector
    // arrives with a family of its own and the load pays for it.
    const scene = new THREE.Scene();
    const gun = new GunView(scene);
    const body = new InspectorBody(new THREE.Group(), scene);

    const gunStructures = new Set<string>();
    gun.model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh === true) gunStructures.add(programStructureKey(mesh, scene));
    });

    const offenders = body.meshes
      .map((mesh) => ({ mesh, key: programStructureKey(mesh, scene) }))
      .filter((entry) => !gunStructures.has(entry.key))
      .map((entry) => `${entry.mesh.name}: ${entry.key}`);

    expect(offenders.join("\n")).toBe("");
  });

  it("draws the whole character in a bounded number of meshes", () => {
    const { body } = harness();
    expect(body.meshes.length).toBeLessThanOrEqual(18);
  });

  it("takes itself out of the scene when the hunt ends", () => {
    const { scene, root, gun, body } = harness();
    gun.dispose();
    body.dispose();
    // The root the harness added is all that is left: no body, no hand, no gun.
    expect(scene.children).toHaveLength(1);
    expect(scene.children[0]).toBe(root);
    expect(root.children).toHaveLength(0);
  });
});

/**
 * How steeply the sight line stays clear of the body, in radians either side of
 * level. The rig's pick ray passes through the camera pivot by construction, so
 * a part near the pivot blocks the reticle at every pitch at once; that is why
 * this is measured against the real camera rather than judged by eye.
 *
 * Measured 2026-08-02: the coat's bounding sphere first touches the ray at 1.07
 * rad and the overlap grows to 15 mm at the 1.45 rad pitch limit. That is the
 * boom passing lengthwise through the character rather than anything about the
 * body's shape — at 1.07 rad the camera is most of the way above the hat — so
 * it is the camera rig's to solve, and the guard here is the band a player
 * actually shoots in. Sixty degrees down from a 0.35 m eye is the floor a fifth
 * of a metre in front of the boots.
 */
const CLEAR_SIGHT_PITCH_RAD = 1;

describe("the Inspector's body never blocks the reticle", () => {
  it("keeps every part of the body off the camera's pick ray", () => {
    const system = createInspectorSystem({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      navData: openNavData(),
      inspectables: new InspectableSet(),
      sendCommand: () => undefined,
      onFocusChange: () => undefined,
      settings: testSettings(),
    });
    system.spawnAt({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });

    const range = testSettings().inspectorFocusDistance;
    const blocked: string[] = [];

    for (let sample = -10; sample <= 10; sample += 1) {
      system.controller.pitch = (sample / 10) * CLEAR_SIGHT_PITCH_RAD;
      system.update(FRAME_MS, sample * FRAME_MS);
      system.root.updateMatrixWorld(true);

      const origin = new THREE.Vector3(
        system.cameraRig.origin.x,
        system.cameraRig.origin.y,
        system.cameraRig.origin.z,
      );
      const direction = new THREE.Vector3(
        system.cameraRig.forward.x,
        system.cameraRig.forward.y,
        system.cameraRig.forward.z,
      ).normalize();
      for (const mesh of system.body.meshes) {
        mesh.geometry.computeBoundingSphere();
        const sphere = mesh.geometry.boundingSphere;
        if (sphere === null) continue;
        const world = sphere.clone().applyMatrix4(mesh.matrixWorld);
        // Nearest point on the segment the reticle actually reads along, which
        // stops at the focus distance rather than running to infinity.
        const along = Math.min(
          Math.max(world.center.clone().sub(origin).dot(direction), 0),
          range,
        );
        const nearest = origin.clone().addScaledVector(direction, along);
        if (nearest.distanceTo(world.center) < world.radius) {
          blocked.push(`${mesh.name} at pitch ${system.controller.pitch.toFixed(2)}`);
        }
      }
    }

    expect([...new Set(blocked)].join("\n")).toBe("");
    system.dispose();
  });
});
