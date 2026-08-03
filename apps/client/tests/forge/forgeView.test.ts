import { PLAYER_HEIGHT_M } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ForgeController, type ForgeWorkspace } from "../../src/forge/ForgeController";
import { humanMimicSpawn } from "../../src/gameplay/botDisguises";
import { DisguiseTheatre } from "../../src/gameplay/disguiseTheatre";
import { MIMIC_BODY_TAG } from "../../src/mimic/visual/MimicVisual";
import { WORLD_SCALE, type NavData } from "../../src/inspector/navData";
import { NAV_DATA } from "../../src/world/maps/nav";
import { SHOP_FORGE_WORKSPACE } from "../../src/world/ShopWorld";
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

interface HarnessOptions {
  readonly origin?: THREE.Vector3;
  readonly navData?: NavData;
  readonly workspace?: ForgeWorkspace;
  /**
   * Runs against the scene before the controller is built, for the things the
   * Forge captures once at construction: the room it may anchor to, and the
   * room it may sample a colour from.
   */
  readonly prepareScene?: (scene: THREE.Scene) => void;
}

class Harness {
  readonly controller: ForgeController;
  readonly scene = new THREE.Scene();
  readonly origin: THREE.Vector3;
  readonly canvas: unknown;

  private readonly listeners = new Map<string, ((event: never) => void)[]>();
  private readonly previousWindow: unknown;

  constructor(options: HarnessOptions = {}) {
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

    this.origin = options.origin ?? new THREE.Vector3(-1.55, 0.075, -1.05);
    options.prepareScene?.(this.scene);
    this.controller = new ForgeController({
      scene: this.scene,
      canvas: canvas as unknown as HTMLCanvasElement,
      quality: qualitySettingsFor("medium"),
      origin: this.origin,
      ...(options.navData === undefined ? {} : { navData: options.navData }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    });
    this.controller.setViewport(VIEWPORT.width, VIEWPORT.height);
  }

  /** One key event through the same window listener the browser would use. */
  key(type: "keydown" | "keyup", key: string): void {
    const event = {
      key,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      target: this.canvas,
      preventDefault: () => undefined,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      (listener as (event: unknown) => void)(event);
    }
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
  it("moves the opposite limb immediately while Mirror is on", () => {
    const before = createPoseState();
    applyDisguiseStateToPose(harness.controller.disguise, before);
    const beforeLeft = before.worldPositions[boneIndex("hand_L")]!.clone();
    const beforeRight = before.worldPositions[boneIndex("hand_R")]!.clone();

    harness.controller.setMirror(true);
    harness.layout();
    const grip = harness.screenPointOf("hand_L");
    harness.pointer("pointerdown", grip);
    harness.pointer("pointermove", { ...grip, clientX: grip.clientX + 34, clientY: grip.clientY - 12 });
    harness.pointer("pointerup", { ...grip, clientX: grip.clientX + 34, clientY: grip.clientY - 12 });

    const after = createPoseState();
    applyDisguiseStateToPose(harness.controller.disguise, after);
    expect(after.worldPositions[boneIndex("hand_L")]!.distanceTo(beforeLeft)).toBeGreaterThan(0.002);
    expect(after.worldPositions[boneIndex("hand_R")]!.distanceTo(beforeRight)).toBeGreaterThan(0.002);
  });

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

/**
 * Locomotion inside the Forge. The rules of how the body moves are proved
 * headlessly in `hiderLocomotion.test.ts`; what is at stake here is the seam —
 * that walking writes the same root a handle drag writes, and therefore travels
 * the same publication path, and that a whole walk is one undo entry rather
 * than one per frame.
 */
describe("running the Mimic about the room", () => {
  let walker: Harness;
  const SPAWN = humanMimicSpawn().position;
  const FRAME_MS = 1000 / 60;

  function walk(frames: number): void {
    for (let frame = 0; frame < frames; frame += 1) walker.controller.update(FRAME_MS);
  }

  beforeEach(() => {
    walker = new Harness({
      origin: new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z),
      navData: NAV_DATA,
      workspace: SHOP_FORGE_WORKSPACE,
    });
  });

  afterEach(() => {
    walker.dispose();
  });

  it("moves the root on the walk keys and advances the revision that publishes", () => {
    const before = walker.controller.disguise;

    walker.key("keydown", "w");
    walk(30);
    const during = walker.controller.disguise;

    const travelled = Math.hypot(
      (during.root.position[0] ?? 0) - (before.root.position[0] ?? 0),
      (during.root.position[2] ?? 0) - (before.root.position[2] ?? 0),
    );
    expect(travelled).toBeGreaterThan(PLAYER_HEIGHT_M);
    expect(during.revision).toBeGreaterThan(before.revision);
  });

  it("stops where the keys were let go and stays there", () => {
    walker.key("keydown", "w");
    walk(30);
    walker.key("keyup", "w");
    walk(30);
    const settled = walker.controller.disguise.root.position;

    walk(60);
    expect(walker.controller.disguise.root.position).toEqual(settled);
  });

  it("takes the whole walk back in one undo", () => {
    const start = [...walker.controller.disguise.root.position];
    expect(walker.controller.snapshot().canUndo).toBe(false);

    walker.key("keydown", "w");
    walk(30);
    walker.key("keyup", "w");
    walk(10);

    expect(walker.controller.snapshot().undoLabel).toBe("walk");
    walker.controller.undo();
    const returned = walker.controller.disguise.root.position;
    for (let axis = 0; axis < 3; axis += 1) {
      expect(returned[axis]).toBeCloseTo(start[axis] ?? 0, 6);
    }
    expect(walker.controller.snapshot().canUndo).toBe(false);
  });

  it("carries the camera with the body rather than leaving it behind", () => {
    walker.layout();
    const before = walker.controller.camera.position.clone();
    const framing = before.distanceTo(walker.origin);

    walker.key("keydown", "w");
    walk(30);
    walker.key("keyup", "w");
    // The shot chases the body rather than being welded to it, so it arrives a
    // beat after the body stops. A settle of half a second is several times the
    // authored catch-up time, and the framing below is what it settles to.
    walk(30);

    const root = walker.controller.disguise.root.position;
    const after = walker.controller.camera.position;
    expect(after.distanceTo(before)).toBeGreaterThan(PLAYER_HEIGHT_M);
    // Same shot, somewhere else: the orbit travelled with the body and the
    // player's own angle and zoom were left alone.
    expect(
      after.distanceTo(new THREE.Vector3(root[0], root[1], root[2])),
    ).toBeCloseTo(framing, 3);
  });

  it("lets the shot trail the body while it runs, and catches up when it stops", () => {
    walker.layout();
    const framing = walker.controller.camera.position.distanceTo(walker.origin);

    walker.key("keydown", "w");
    walk(30);
    const root = walker.controller.disguise.root.position;
    const running = walker.controller.camera.position.distanceTo(
      new THREE.Vector3(root[0], root[1], root[2]),
    );
    // Mid-run the camera is behind where a rigid rig would put it, by enough to
    // be felt and far less than the body's own height.
    expect(running).toBeGreaterThan(framing + PLAYER_HEIGHT_M / 100);
    expect(running).toBeLessThan(framing + PLAYER_HEIGHT_M);

    walker.key("keyup", "w");
    walk(30);
    const settled = walker.controller.disguise.root.position;
    expect(
      walker.controller.camera.position.distanceTo(
        new THREE.Vector3(settled[0], settled[1], settled[2]),
      ),
    ).toBeCloseTo(framing, 3);
  });

  it("leaves the body alone once the disguise is locked", () => {
    walker.controller.lock();
    const locked = walker.controller.disguise.root.position;

    walker.key("keydown", "w");
    walk(30);
    expect(walker.controller.disguise.root.position).toEqual(locked);
  });
});

describe("walking a body that has already been posed", () => {
  let walker: Harness;
  const SPAWN = humanMimicSpawn().position;

  beforeEach(() => {
    walker = new Harness({
      origin: new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z),
      navData: NAV_DATA,
      workspace: SHOP_FORGE_WORKSPACE,
    });
  });

  afterEach(() => {
    walker.dispose();
  });

  it("carries the pose with it rather than being solved back to it", () => {
    // Pose the head, which pins its IK target at a world position.
    walker.layout();
    const grip = walker.screenPointOf("head");
    walker.pointer("pointerdown", grip);
    walker.pointer("pointermove", { ...grip, clientX: grip.clientX + 30 });
    walker.pointer("pointerup", { ...grip, clientX: grip.clientX + 30 });

    expect(walker.controller.snapshot().canUndo).toBe(true);
    const before = walker.controller.disguise;
    const posedHead = headOffsetInRootSpace(walker);

    walker.key("keydown", "w");
    for (let frame = 0; frame < 60; frame += 1) walker.controller.update(1000 / 60);
    walker.key("keyup", "w");
    walker.controller.update(1000 / 60);

    const after = walker.controller.disguise;
    const travelled = Math.hypot(
      (after.root.position[0] ?? 0) - (before.root.position[0] ?? 0),
      (after.root.position[2] ?? 0) - (before.root.position[2] ?? 0),
    );
    // A pinned target left behind would have hauled the root back toward it.
    expect(travelled).toBeGreaterThan(PLAYER_HEIGHT_M * 2);

    // And the pose the player authored is still the pose it is wearing: the
    // head stands in the same place relative to the body it belongs to.
    const walkedHead = headOffsetInRootSpace(walker);
    expect(walkedHead.distanceTo(posedHead)).toBeLessThan(PLAYER_HEIGHT_M / 100);
  });
});

/**
 * Where the head sits relative to the root, which is what a stale IK target
 * corrupts: the target is a world position, so a body that walked away from one
 * has its neck solved back toward where it was standing.
 */
function headOffsetInRootSpace(harnessed: Harness): THREE.Vector3 {
  const state = harnessed.controller.disguise;
  const pose = createPoseState();
  applyDisguiseStateToPose(state, pose);
  const head = pose.worldPositions[boneIndex("head")];
  if (head === undefined) throw new Error("no head bone");
  const [x = 0, y = 0, z = 0] = state.root.position;
  const [qx = 0, qy = 0, qz = 0, qw = 1] = state.root.rotation;
  return new THREE.Vector3(head.x - x, head.y - y, head.z - z).applyQuaternion(
    new THREE.Quaternion(qx, qy, qz, qw).invert(),
  );
}

/**
 * The control scheme of CLAUDE.md override 5, checked with locomotion live:
 * WASD moves the body and a left-click hold turns the camera, with no mode
 * between them. The left button doing two jobs is the part that could have been
 * broken by adding a second way to move, so it is asserted here rather than
 * assumed from the gesture's own test in the default harness.
 */
describe("moving and looking at the same time", () => {
  let walker: Harness;
  const SPAWN = humanMimicSpawn().position;

  beforeEach(() => {
    walker = new Harness({
      origin: new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z),
      navData: NAV_DATA,
      workspace: SHOP_FORGE_WORKSPACE,
    });
  });

  afterEach(() => {
    walker.dispose();
  });

  it("turns the camera on a left hold over empty space, and leaves the body alone", () => {
    walker.layout();
    const before = walker.controller.camera.position.clone();
    const standing = [...walker.controller.disguise.root.position];

    // Top right corner: no part of the Mimic is under it.
    walker.pointer("pointerdown", { clientX: 780, clientY: 30 });
    walker.pointer("pointermove", { clientX: 620, clientY: 90 });
    walker.pointer("pointerup", { clientX: 620, clientY: 90 });
    walker.controller.update(1000 / 60);

    expect(walker.controller.camera.position.distanceTo(before)).toBeGreaterThan(0.05);
    expect(walker.controller.disguise.root.position).toEqual(standing);
    expect(walker.controller.snapshot().canUndo).toBe(false);
  });

  it("keeps walking while the camera is being turned", () => {
    walker.key("keydown", "w");
    for (let frame = 0; frame < 10; frame += 1) walker.controller.update(1000 / 60);
    const beforeDrag = [...walker.controller.disguise.root.position];

    walker.pointer("pointerdown", { clientX: 780, clientY: 30 });
    for (let frame = 0; frame < 10; frame += 1) {
      walker.pointer("pointermove", { clientX: 780 - frame * 8, clientY: 30 });
      walker.controller.update(1000 / 60);
    }
    walker.pointer("pointerup", { clientX: 700, clientY: 30 });

    const afterDrag = walker.controller.disguise.root.position;
    expect(afterDrag).not.toEqual(beforeDrag);
  });

  it("steers by the camera, so turning it turns where the walk keys go", () => {
    walker.key("keydown", "w");
    for (let frame = 0; frame < 20; frame += 1) walker.controller.update(1000 / 60);
    const first = walker.controller.disguise.root.position;
    const firstHeading = Math.atan2(
      (first[0] ?? 0) - SPAWN.x,
      (first[2] ?? 0) - SPAWN.z,
    );

    // A long left-hold drag turns the orbit a good way round.
    walker.pointer("pointerdown", { clientX: 780, clientY: 300 });
    walker.pointer("pointermove", { clientX: 380, clientY: 300 });
    walker.pointer("pointerup", { clientX: 380, clientY: 300 });

    const pivot = walker.controller.disguise.root.position;
    for (let frame = 0; frame < 20; frame += 1) walker.controller.update(1000 / 60);
    const second = walker.controller.disguise.root.position;
    const secondHeading = Math.atan2(
      (second[0] ?? 0) - (pivot[0] ?? 0),
      (second[2] ?? 0) - (pivot[2] ?? 0),
    );

    expect(Math.abs(secondHeading - firstHeading)).toBeGreaterThan(0.3);
  });
});

describe("what the Forge will let an anchor name", () => {
  /**
   * An anchor stores the surface it is sealed to by that object's name and
   * resolves it again the next time the disguise is loaded, so the index behind
   * that lookup has to hold map surfaces and nothing else.
   *
   * `DisguiseTheatre` builds the hunt's bodies during the load and parks them
   * twenty metres under the boards, which puts four named Mimics in the scene
   * before the Forge captures its room. Every part of one is called `mimic_`
   * something, and a saved anchor naming one would resolve against whichever
   * body happened to be holding that name — or, parked, against nothing.
   */
  it("indexes the room but not the bodies a theatre parked in it", async () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, qualitySettingsFor("medium"));
    await theatre.prewarm(4, () => Promise.resolve());

    // The parked bodies really are in the room the Forge is about to capture.
    const mimicParts = scene.children.filter((child) => child.userData[MIMIC_BODY_TAG] === true);
    expect(mimicParts.length).toBe(4);

    const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.3));
    shelf.name = "test_shelf";
    scene.add(shelf);

    // The same objects, not copies of them, moved into the room the Forge is
    // built against.
    const anchored = new Harness({
      prepareScene: (target) => {
        for (const child of [...scene.children]) target.add(child);
      },
    });
    const surfaces = anchored.controller.anchorSurfaceIds;

    expect(surfaces).toContain("test_shelf");
    expect(surfaces.filter((id) => id.startsWith("mimic_"))).toEqual([]);

    anchored.dispose();
    theatre.dispose();
  });
});
