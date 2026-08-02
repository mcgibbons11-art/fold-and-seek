import { PLAYER_HEIGHT_M } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ForgeController } from "../../src/forge/ForgeController";
import { WORLD_SCALE } from "../../src/inspector/navData";
import { applyDisguiseStateToPose, createStarterArrangement } from "../../src/mimic/disguiseState";
import { createPoseState } from "../../src/mimic/ikSolver";
import { boneIndex } from "../../src/mimic/rig";
import { qualitySettingsFor } from "../../src/rendering/quality";

/**
 * How the workspace presents itself: where the camera stands, whether the player
 * can turn it, and how much of the body the pose handles cover.
 *
 * Both were scale bugs rather than design choices. The opening framing was a
 * world-metre literal left over from before the Mimic shrank to 0.35 m, which
 * put the camera further out than its own zoom range could return to, and the
 * handles were filled discs sized for a body five times larger, so seven of them
 * hid more of the Mimic than the Mimic showed.
 */

const VIEWPORT = { width: 800, height: 600 };

class Harness {
  readonly controller: ForgeController;
  readonly scene = new THREE.Scene();
  readonly origin = new THREE.Vector3(-1.55, 0.075, -1.05);
  readonly canvas: unknown;

  private readonly listeners = new Map<string, ((event: never) => void)[]>();
  private readonly previousWindow: unknown;

  constructor() {
    const add = (type: string, listener: (event: never) => void): void => {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    };
    const canvas = {
      style: { cursor: "default" },
      getBoundingClientRect: () => ({ left: 0, top: 0, ...VIEWPORT }),
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
      hasPointerCapture: () => false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    this.canvas = canvas;

    this.previousWindow = (globalThis as Record<string, unknown>)["window"];
    (globalThis as Record<string, unknown>)["window"] = {
      addEventListener: add,
      removeEventListener: () => undefined,
    };

    this.controller = new ForgeController({
      scene: this.scene,
      canvas: canvas as unknown as HTMLCanvasElement,
      quality: qualitySettingsFor("medium"),
      origin: this.origin,
    });
    this.controller.setViewport(VIEWPORT.width, VIEWPORT.height);
  }

  pointer(type: string, fields: Record<string, unknown> = {}): void {
    const event = {
      pointerId: 1,
      button: 0,
      shiftKey: false,
      clientX: VIEWPORT.width / 2,
      clientY: VIEWPORT.height / 2,
      target: this.canvas,
      stopPropagation: () => undefined,
      preventDefault: () => undefined,
      ...fields,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      (listener as (event: unknown) => void)(event);
    }
  }

  wheel(deltaY: number): void {
    this.pointer("wheel", { deltaY });
  }

  /**
   * One frame's worth of bookkeeping. The renderer does this every frame in the
   * app, and picking needs it: a handle whose world matrix has never been
   * computed sits at the origin as far as the raycaster is concerned.
   */
  layout(): void {
    this.controller.update();
    this.controller.camera.updateMatrixWorld(true);
    this.scene.updateMatrixWorld(true);
  }

  /**
   * Viewport coordinates of a bone, so a press can be aimed at the handle on it
   * rather than at wherever the middle of the frame happens to land. The pose is
   * rebuilt here from the same starter arrangement and the same origin the
   * controller was given, so it is the body actually on screen.
   */
  screenPointOf(bone: string): { clientX: number; clientY: number } {
    const state = createStarterArrangement("upright");
    state.root.position = [this.origin.x, this.origin.y, this.origin.z];
    const pose = createPoseState();
    applyDisguiseStateToPose(state, pose);
    const world = pose.worldPositions[boneIndex(bone)];
    if (world === undefined) throw new Error(`no bone "${bone}"`);
    const ndc = new THREE.Vector3(world.x, world.y, world.z).project(this.controller.camera);
    return {
      clientX: ((ndc.x + 1) / 2) * VIEWPORT.width,
      clientY: ((1 - ndc.y) / 2) * VIEWPORT.height,
    };
  }

  /** World radius of a named part of a handle, after a layout pass. */
  radiusOf(name: string): number {
    this.layout();
    const mesh = this.scene.getObjectByName(name);
    if (mesh === undefined) throw new Error(`no handle part "${name}"`);
    return mesh.getWorldScale(new THREE.Vector3()).x;
  }

  dispose(): void {
    this.controller.dispose();
    (globalThis as Record<string, unknown>)["window"] = this.previousWindow;
  }
}

let harness: Harness;

beforeEach(() => {
  const globals = globalThis as Record<string, unknown>;
  globals["HTMLInputElement"] ??= class {};
  globals["HTMLTextAreaElement"] ??= class {};
  globals["Element"] ??= class {};
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
  harness = new Harness();
});

afterEach(() => {
  harness.dispose();
});

describe("the workspace camera", () => {
  it("opens inside its own zoom range rather than beyond it", () => {
    const opening = harness.controller.camera.position.clone();

    // Zooming all the way out and back in has to be able to return to roughly
    // the opening shot. It could not while the start was outside the clamp.
    for (let i = 0; i < 40; i++) harness.wheel(120);
    const farthest = harness.controller.camera.position.distanceTo(harness.origin);
    for (let i = 0; i < 40; i++) harness.wheel(-120);
    const nearest = harness.controller.camera.position.distanceTo(harness.origin);

    expect(farthest).toBeGreaterThan(opening.distanceTo(harness.origin));
    expect(nearest).toBeLessThan(opening.distanceTo(harness.origin));
  });

  it("frames the body rather than the room around it", () => {
    // Close enough to fill the frame at a 40 degree field of view, far enough to
    // see the whole body: a handful of body heights, not a handful of metres.
    const distance = harness.controller.camera.position.distanceTo(harness.origin);
    expect(distance).toBeGreaterThan(PLAYER_HEIGHT_M);
    expect(distance).toBeLessThan(PLAYER_HEIGHT_M * 4);
    // And looking at the middle of the body, not down at its feet.
    expect(harness.controller.camera.position.y).toBeGreaterThan(harness.origin.y);
  });

  it("orbits on a left drag over empty space and leaves the pose alone", () => {
    const before = harness.controller.camera.position.clone();

    harness.layout();
    // Top right corner of the viewport: nothing of the Mimic is under it.
    harness.pointer("pointerdown", { clientX: 780, clientY: 30 });
    harness.pointer("pointermove", { clientX: 620, clientY: 90 });
    harness.pointer("pointerup", { clientX: 620, clientY: 90 });

    expect(harness.controller.camera.position.distanceTo(before)).toBeGreaterThan(0.05);
    expect(harness.controller.snapshot().canUndo).toBe(false);
  });

  it("gives the same drag to the handle when there is one under it", () => {
    // The fallback must not cost the Forge its own tool.
    const before = harness.controller.camera.position.clone();
    harness.layout();
    const grip = harness.screenPointOf("head");

    harness.pointer("pointerdown", grip);
    harness.pointer("pointermove", { ...grip, clientX: grip.clientX + 40 });
    harness.pointer("pointerup", { ...grip, clientX: grip.clientX + 40 });

    expect(harness.controller.camera.position.distanceTo(before)).toBe(0);
    expect(harness.controller.snapshot().canUndo).toBe(true);
  });

  it("keeps a preview at a player's eye height, not at a person's", () => {
    for (const preview of ["inspector", "doorway"] as const) {
      harness.controller.setPreview(preview);
      expect(harness.controller.camera.position.y, preview).toBeCloseTo(WORLD_SCALE.eyeHeight, 6);
      harness.controller.setPreview("none");
    }
  });
});

describe("the pose handles", () => {
  it("draws a grip far smaller than the body it is attached to", () => {
    const ring = harness.radiusOf("forge_handle_ring_head");
    const grip = harness.radiusOf("forge_handle_grip_head");

    // Seven of these sit on a 0.35 m body at once. The outline is the widest
    // part and still spans under a twelfth of the body's height.
    expect(ring * 2).toBeLessThan(PLAYER_HEIGHT_M / 12);
    expect(grip).toBeLessThan(ring);
  });

  it("keeps the pointer target generous even though the grip shrank", () => {
    const ring = harness.radiusOf("forge_handle_ring_head");
    const pick = harness.radiusOf("forge_handle_pick_head");
    expect(pick).toBeGreaterThan(ring * 2);
  });

  it("stays faint until it is hovered", () => {
    harness.layout();
    const ring = harness.scene.getObjectByName("forge_handle_ring_head");
    const material = (ring as THREE.Mesh | undefined)?.material;
    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((material as THREE.MeshBasicMaterial).opacity).toBeLessThan(0.5);
  });
});
