import { PLAYER_HEIGHT_M } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterEach, describe, expect, it } from "vitest";

import { ForgeController } from "../../src/forge/ForgeController";
import { humanMimicSpawn } from "../../src/gameplay/botDisguises";
import { DEFAULT_LOOK_SENSITIVITY } from "../../src/inspector/InspectorInput";
import { applyDisguiseStateToPose, createStarterArrangement } from "../../src/mimic/disguiseState";
import { createPoseState } from "../../src/mimic/ikSolver";
import { boneIndex } from "../../src/mimic/rig";
import { qualitySettingsFor } from "../../src/rendering/quality";
import { NAV_DATA } from "../../src/world/maps/nav";
import { SHOP_FORGE_WORKSPACE } from "../../src/world/ShopWorld";

/**
 * What a hider's camera owes the player: it turns about the creature and never
 * carries the shot away from it.
 *
 * The controls are one left button doing two jobs (CLAUDE.md override 5), so
 * every drag that misses a handle is a turn, and a turn is a rotation about a
 * point on the body. Before this file existed a drag could translate that point
 * instead — a metre off a thirty-five-centimetre creature after two ordinary
 * gestures, with nothing in the game that ever put it back — which is the
 * "shifts the entire screen away from the character" the player reported.
 *
 * Every assertion here is about where the shot ends up rather than how it got
 * there, so the harness drives the real pointer handlers and reads the real
 * camera.
 */

const VIEWPORT = { width: 1280, height: 800 };
const FRAME_MS = 1000 / 60;

/** Long enough for the follow lag to close, which is 0.16 s of chase. */
const SETTLE_FRAMES = 40;

/** The centre of the frame, in normalized device coordinates, to a percent. */
const CENTRED_NDC = 0.02;

const SPAWN = humanMimicSpawn().position;

class Harness {
  readonly controller: ForgeController;
  readonly scene = new THREE.Scene();

  private readonly listeners = new Map<string, ((event: never) => void)[]>();
  private readonly previousWindow: unknown;
  private readonly canvas: unknown;

  constructor() {
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

    // The Forge reads the DOM classes its key handler guards on, and plays
    // audio. Neither exists in the headless environment these tests run in.
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

    this.previousWindow = globals["window"];
    globals["window"] = {
      addEventListener: (type: string, listener: (event: never) => void): void => {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      },
      removeEventListener: () => undefined,
    };

    this.controller = new ForgeController({
      scene: this.scene,
      canvas: canvas as unknown as HTMLCanvasElement,
      quality: qualitySettingsFor("medium"),
      origin: new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z),
      workspace: SHOP_FORGE_WORKSPACE,
      navData: NAV_DATA,
    });
    this.controller.setViewport(VIEWPORT.width, VIEWPORT.height);
    this.settle();
  }

  /** Viewport coordinates of the pelvis grip, which is the handle that moves the root. */
  pelvisOnScreen(): readonly [number, number] {
    const state = createStarterArrangement("upright");
    state.root.position = [...this.controller.disguise.root.position];
    const pose = createPoseState();
    applyDisguiseStateToPose(state, pose);
    const world = pose.worldPositions[boneIndex("pelvis")];
    if (world === undefined) throw new Error("the rig has no pelvis");
    const ndc = new THREE.Vector3(world.x, world.y, world.z).project(this.controller.camera);
    return [((ndc.x + 1) / 2) * VIEWPORT.width, ((1 - ndc.y) / 2) * VIEWPORT.height];
  }

  dispatchPointer(type: string, fields: Record<string, unknown>): void {
    this.dispatch(type, fields);
  }

  private dispatch(type: string, fields: Record<string, unknown>): void {
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

  /**
   * A press, a run of moves and a release, on empty space well clear of the
   * body so the press finds no handle and belongs to the camera.
   */
  drag(dx: number, dy: number, button = 0, shiftKey = false): void {
    // A frame runs between the pointer events, as it does in the game: picking
    // reads the camera's world matrix, and a press tested against the matrix of
    // a camera that has since turned hits whatever used to be there.
    this.settle(1);
    const [fromX, fromY] = this.emptyPoint();
    this.dispatch("pointerdown", { button, shiftKey, clientX: fromX, clientY: fromY });
    for (let step = 1; step <= 10; step += 1) {
      this.dispatch("pointermove", {
        button,
        shiftKey,
        clientX: fromX + (dx * step) / 10,
        clientY: fromY + (dy * step) / 10,
      });
      this.settle(1);
    }
    this.dispatch("pointerup", { button, shiftKey, clientX: fromX + dx, clientY: fromY + dy });
  }

  /**
   * The corner of the viewport furthest from the creature, so a press there
   * finds no pose handle and belongs to the camera. The creature is wherever
   * the last drag left it on screen, which is the whole point of the file, so
   * the point cannot be a constant.
   */
  private emptyPoint(): readonly [number, number] {
    const chest = this.chestOnScreen();
    const bodyX = ((chest.x + 1) / 2) * VIEWPORT.width;
    const bodyY = ((1 - chest.y) / 2) * VIEWPORT.height;
    const x = bodyX > VIEWPORT.width / 2 ? 60 : VIEWPORT.width - 60;
    const y = bodyY > VIEWPORT.height / 2 ? 60 : VIEWPORT.height - 60;
    return [x, y];
  }

  key(type: "keydown" | "keyup", key: string): void {
    this.dispatch(type, { key, ctrlKey: false, metaKey: false, shiftKey: false });
  }

  settle(frames = SETTLE_FRAMES): void {
    for (let frame = 0; frame < frames; frame += 1) this.controller.update(FRAME_MS);
    this.controller.camera.updateMatrixWorld(true);
    // The handles are picked against their world matrices, which the renderer
    // would have computed by now and nothing in a headless frame does.
    this.scene.updateMatrixWorld(true);
  }

  /** Where the creature's chest lands on screen, in normalized device coordinates. */
  chestOnScreen(): THREE.Vector3 {
    const root = this.controller.disguise.root.position;
    return new THREE.Vector3(
      root[0],
      root[1] + PLAYER_HEIGHT_M * 0.55,
      root[2],
    ).project(this.controller.camera);
  }

  /** How far the camera stands from the point it is looking at. */
  boomLength(): number {
    const chest = new THREE.Vector3(
      this.controller.disguise.root.position[0],
      this.controller.disguise.root.position[1] + PLAYER_HEIGHT_M * 0.55,
      this.controller.disguise.root.position[2],
    );
    return this.controller.camera.position.distanceTo(chest);
  }

  dispose(): void {
    this.controller.dispose();
    (globalThis as Record<string, unknown>)["window"] = this.previousWindow;
  }
}

let harness: Harness | null = null;

function open(): Harness {
  harness = new Harness();
  return harness;
}

afterEach(() => {
  harness?.dispose();
  harness = null;
});

describe("the shot turns about the creature", () => {
  it("keeps the body in the middle of the frame through drags in every direction", () => {
    const forge = open();
    const opening = forge.boomLength();
    expect(Math.abs(forge.chestOnScreen().x)).toBeLessThan(CENTRED_NDC);

    for (const [dx, dy] of [
      [900, 0],
      [-900, 0],
      [0, 400],
      [0, -400],
      [700, 300],
      [-700, -300],
    ]) {
      forge.drag(dx ?? 0, dy ?? 0);
      forge.settle();
      const chest = forge.chestOnScreen();
      expect(Math.abs(chest.x)).toBeLessThan(CENTRED_NDC);
      expect(Math.abs(chest.y)).toBeLessThan(CENTRED_NDC);
      // In front of the camera rather than behind it.
      expect(chest.z).toBeLessThan(1);
    }

    // The zoom was never touched, so the shot stands where it started. It may
    // have been pulled in by a blocker along the way, never pushed out.
    expect(forge.boomLength()).toBeLessThanOrEqual(opening + 1e-6);
    expect(forge.boomLength()).toBeGreaterThan(PLAYER_HEIGHT_M * 0.5);
  });

  it("turns at the Inspector's own look rate, the same on both axes", () => {
    const forge = open();
    const before = forge.controller.camera.position.clone();
    const chest = new THREE.Vector3(
      forge.controller.disguise.root.position[0],
      forge.controller.disguise.root.position[1] + PLAYER_HEIGHT_M * 0.55,
      forge.controller.disguise.root.position[2],
    );

    const pixels = 300;
    forge.drag(pixels, 0);
    forge.settle();
    const after = forge.controller.camera.position.clone();

    const turned = Math.atan2(before.x - chest.x, before.z - chest.z)
      - Math.atan2(after.x - chest.x, after.z - chest.z);
    expect(Math.abs(turned)).toBeCloseTo(pixels * DEFAULT_LOOK_SENSITIVITY, 3);
  });

  it("comes back onto a body the pelvis handle dragged across the room", () => {
    const forge = open();
    const grip = forge.pelvisOnScreen();

    forge.dispatchPointer("pointerdown", { clientX: grip[0], clientY: grip[1] });
    for (let step = 1; step <= 20; step += 1) {
      forge.dispatchPointer("pointermove", {
        clientX: grip[0] + step * 18,
        clientY: grip[1] - step * 6,
      });
      forge.settle(1);
    }
    forge.dispatchPointer("pointerup", { clientX: grip[0] + 360, clientY: grip[1] - 120 });
    forge.settle();

    const start = new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z);
    const root = forge.controller.disguise.root.position;
    expect(start.distanceTo(new THREE.Vector3(root[0], root[1], root[2]))).toBeGreaterThan(
      PLAYER_HEIGHT_M * 0.5,
    );

    const chest = forge.chestOnScreen();
    expect(Math.abs(chest.x)).toBeLessThan(CENTRED_NDC);
    expect(Math.abs(chest.y)).toBeLessThan(CENTRED_NDC);
  });

  it("carries the shot with a body that walks away", () => {
    const forge = open();
    forge.key("keydown", "w");
    forge.settle(90);
    forge.key("keyup", "w");
    forge.settle();

    const start = new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z);
    const root = forge.controller.disguise.root.position;
    const travelled = start.distanceTo(new THREE.Vector3(root[0], root[1], root[2]));
    expect(travelled).toBeGreaterThan(PLAYER_HEIGHT_M);

    const chest = forge.chestOnScreen();
    expect(Math.abs(chest.x)).toBeLessThan(CENTRED_NDC);
    expect(Math.abs(chest.y)).toBeLessThan(CENTRED_NDC);
  });

  it("has no gesture that translates the shot off the body", () => {
    const forge = open();
    // The two presses that used to pan: the middle button, and a left drag with
    // shift held, which is what a player reaching for the run key while looking
    // around produces. Ten of each, so a drift of even a centimetre a gesture
    // would show.
    // Locked, so no press can pose the body and every drag is the camera's.
    // What is being measured is the gesture, not the editing it competes with.
    forge.controller.lock();
    expect(forge.controller.snapshot().locked).toBe(true);
    const before = [...forge.controller.disguise.root.position];

    for (let round = 0; round < 10; round += 1) {
      forge.drag(600, 250, 1);
      forge.drag(-500, 200, 0, true);
    }
    forge.settle();

    expect(forge.controller.disguise.root.position).toEqual(before);
    const chest = forge.chestOnScreen();
    expect(Math.abs(chest.x)).toBeLessThan(CENTRED_NDC);
    expect(Math.abs(chest.y)).toBeLessThan(CENTRED_NDC);
  });
});
