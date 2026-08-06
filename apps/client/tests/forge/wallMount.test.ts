import * as THREE from "three/webgpu";
import { beforeEach, describe, expect, it } from "vitest";

import { ForgeController, type ForgeWorkspace } from "../../src/forge/ForgeController";
import { applyDisguiseStateToPose } from "../../src/mimic/disguiseState";
import { createPoseState } from "../../src/mimic/ikSolver";
import { boneIndex } from "../../src/mimic/rig";
import { qualitySettingsFor } from "../../src/rendering/quality";

/**
 * Mounting a body on a wall must never put it through the wall.
 *
 * Three reports a face's own normal, and a wall struck from inside a room
 * reports the one pointing out of it - nothing flips it for a backface hit.
 * Read as "which way is the room", that normal mounts the body on the far side
 * of the plaster, where there is no floor under it. Pressing the arrangement
 * again searches from out there and marches it further out still, which is how
 * this reached a player as "hold pose near a wall and fall through the world".
 */

/** The room: a floor and one wall, both tagged the way map structure is. */
function room(): THREE.Object3D[] {
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(4, 3, 0.2),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  wall.name = "wall_north";
  wall.position.set(0, 1.5, 1.5);
  wall.userData["surfaceKind"] = "structure";

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(4, 0.2, 4),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  floor.name = "floor";
  floor.position.set(0, -0.1, 0);
  floor.userData["surfaceKind"] = "structure";

  for (const mesh of [wall, floor]) mesh.updateMatrixWorld(true);
  return [wall, floor];
}

/** Generous enough that the workspace clamp cannot mask a bad placement. */
const WORKSPACE: ForgeWorkspace = {
  minX: -8,
  maxX: 8,
  minY: 0,
  maxY: 4,
  minZ: -8,
  maxZ: 8,
};

function controller(): ForgeController {
  const scene = new THREE.Scene();
  for (const mesh of room()) scene.add(mesh);

  const listeners = new Map<string, (event: unknown) => void>();
  const canvas = {
    width: 1280,
    height: 720,
    clientWidth: 1280,
    clientHeight: 720,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler);
    },
    removeEventListener: () => undefined,
    style: {},
  };

  const forge = new ForgeController({
    scene,
    canvas: canvas as unknown as HTMLCanvasElement,
    quality: qualitySettingsFor("medium"),
    // Just inside the wall, which is where a player stands when they reach for
    // a wall arrangement at all.
    origin: new THREE.Vector3(0, 0, 1.0),
    workspace: WORKSPACE,
  });
  forge.setViewport(1280, 720);
  return forge;
}

/** Where the wall's inner face is; anything past it is inside the plaster. */
const WALL_INNER_Z = 1.4;

/** The handful of browser globals the controller touches on construction. */
beforeEach(() => {
  const globals = globalThis as Record<string, unknown>;
  globals["HTMLInputElement"] ??= class {};
  globals["HTMLTextAreaElement"] ??= class {};
  globals["Element"] ??= class {};
  globals["window"] ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  globals["Audio"] ??= class {
    volume = 1;
    preload = "";
    currentTime = 0;
    playbackRate = 1;
    play(): Promise<void> {
      return Promise.resolve();
    }
    pause(): void {}
    removeAttribute(): void {}
  };
});

describe("mounting a Mimic on a wall", () => {
  it("keeps the body on the room's side of the wall, however often it is applied", () => {
    const forge = controller();
    const pelvisIndex = boneIndex("pelvis");

    // Applied repeatedly, which is exactly the reported reproduction: a player
    // pressing the same arrangement while standing near a wall.
    const depths: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      forge.applyArrangement("wall_mount");
      const pose = createPoseState();
      applyDisguiseStateToPose(forge.disguise, pose);
      const pelvis = pose.worldPositions[pelvisIndex];
      expect(pelvis).toBeDefined();
      depths.push(pelvis?.z ?? Number.NaN);
    }

    for (const z of depths) {
      expect(Number.isFinite(z)).toBe(true);
      // Inside the room is smaller z than the wall's inner face.
      expect(z).toBeLessThan(WALL_INNER_Z);
    }

    // And it must settle rather than creep: repeated presses of the same
    // arrangement against the same wall land in the same place.
    const [first] = depths;
    for (const z of depths) expect(Math.abs(z - (first ?? 0))).toBeLessThan(0.05);
  });
});
