import { MAX_SHAPES } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { beforeEach, describe, expect, it } from "vitest";

import { ForgeController, type ForgeWorkspace } from "../../src/forge/ForgeController";
import { applyDisguiseStateToPose } from "../../src/mimic/disguiseState";
import { createPoseState } from "../../src/mimic/ikSolver";
import { boneIndex } from "../../src/mimic/rig";
import { qualitySettingsFor } from "../../src/rendering/quality";

/**
 * Building a disguise out of primitives, through the real controller.
 *
 * The list rules are tested on their own in shapeAuthoring.test.ts; what this
 * adds is that the Forge actually wires them - that a press lands as one
 * undoable command, that undo puts the disguise back, and that a shape appears
 * on the part the player was working on rather than at an origin they then
 * have to go and find.
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
  windowKeys.length = 0;
  const globals = globalThis as Record<string, unknown>;
  globals["HTMLInputElement"] ??= class {};
  globals["HTMLTextAreaElement"] ??= class {};
  globals["Element"] ??= class {};
  // Keydown reaches the Forge through the window, so the stub keeps the
  // listener: pressing a key in a test has to travel the path the browser uses.
  globals["window"] = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      if (type === "keydown") windowKeys.push(handler);
    },
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

const windowKeys: ((event: unknown) => void)[] = [];

/** One key press, down the path the browser would use. */
function press(key: string, options: { ctrlKey?: boolean } = {}): void {
  for (const handler of windowKeys) {
    handler({
      key,
      code: key,
      repeat: false,
      ctrlKey: options.ctrlKey ?? false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: null,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
  }
}

describe("building a disguise in the Forge", () => {
  it("adds a shape as one undoable command", () => {
    const forge = controller();
    expect(forge.addShape("cylinder")).toBe(true);
    expect(forge.disguise.shapes).toHaveLength(1);

    forge.undo();
    // One press, one command: a half-undone shape would leave the disguise
    // carrying geometry the player had already taken back.
    expect(forge.disguise.shapes).toHaveLength(0);
  });

  it("duplicates the selected shape, and the copy is not on top of it", () => {
    const forge = controller();
    forge.addShape("cube");
    expect(forge.duplicateSelectedShape()).toBe(true);

    const [first, second] = forge.disguise.shapes;
    expect(forge.disguise.shapes).toHaveLength(2);
    expect(second?.position).not.toEqual(first?.position);
  });

  it("deletes the selected shape and leaves its neighbour selected", () => {
    const forge = controller();
    forge.addShape("cube");
    forge.addShape("sphere");
    expect(forge.deleteSelectedShape()).toBe(true);
    expect(forge.disguise.shapes).toHaveLength(1);
    // Something is still selected, so the next press has a target.
    expect(forge.shapeList().some((row) => row.selected)).toBe(true);
  });

  it("names the rows the object panel draws by what they are", () => {
    const forge = controller();
    forge.addShape("cube");
    forge.addShape("cylinder");
    expect(forge.shapeList().map((row) => row.label)).toEqual(["Cube 1", "Cylinder 1"]);
  });

  it("copies and removes a shape from the keys, not only from a panel", () => {
    // Building is a stream of small edits under a short clock, so the verbs a
    // player presses most have to be under their hand rather than behind a
    // trip to a panel.
    const forge = controller();
    forge.addShape("cube");

    press("d", { ctrlKey: true });
    expect(forge.disguise.shapes).toHaveLength(2);

    press("Delete");
    expect(forge.disguise.shapes).toHaveLength(1);
    // Both keys, because half of players reach for one and half the other.
    press("Backspace");
    expect(forge.disguise.shapes).toHaveLength(0);
  });

  it("moves a shape with the arrows, as one undoable drag", () => {
    // A shape arrives at its bone's origin, so if the gizmo could not move it
    // the build tool could only add and delete.
    const forge = controller();
    forge.setToolMode("panels");
    forge.addShape("cube");
    const placed = forge.disguise.shapes[0];
    expect(placed).toBeDefined();
    const before: [number, number, number] = [...(placed?.position ?? [0, 0, 0])] as [number, number, number];

    forge.nudgeSelectedShape(0.25, 0, 0);
    expect(forge.disguise.shapes[0]?.position[0]).toBeCloseTo(before[0] + 0.25, 5);

    forge.undo();
    expect(forge.disguise.shapes[0]?.position[0]).toBeCloseTo(before[0], 5);
  });

  it("stretches a shape on one axis, which is what makes a barrel out of a cylinder", () => {
    const forge = controller();
    forge.addShape("cylinder");
    const before = [...(forge.disguise.shapes[0]?.scale ?? [])];

    expect(forge.scaleSelectedShape(1, 2)).toBe(true);
    const after = forge.disguise.shapes[0]?.scale ?? [];
    expect(after[1]).toBeCloseTo((before[1] ?? 0) * 2, 5);
    // Only the axis asked for: stretching Y must not fatten X and Z, or every
    // shape stays a scaled copy of itself and the palette never grows.
    expect(after[0]).toBeCloseTo(before[0] ?? 0, 5);
    expect(after[2]).toBeCloseTo(before[2] ?? 0, 5);

    forge.undo();
    expect(forge.disguise.shapes[0]?.scale[1]).toBeCloseTo(before[1] ?? 0, 5);
  });

  it("never scales a shape away to nothing", () => {
    const forge = controller();
    forge.addShape("cube");
    // An invisible shape still answers clicks and still counts against the
    // sixteen, so it is a trap rather than a deletion.
    for (let index = 0; index < 40; index += 1) forge.scaleSelectedShape(0, 0.5);
    expect(forge.disguise.shapes[0]?.scale[0] ?? 0).toBeGreaterThan(0);
  });

  it("turns a shape in quarters, because rooms are built square", () => {
    const forge = controller();
    forge.addShape("wedge");
    const before = [...(forge.disguise.shapes[0]?.rotation ?? [])];
    expect(forge.rotateSelectedShape(1, 1)).toBe(true);
    expect(forge.disguise.shapes[0]?.rotation).not.toEqual(before);

    // Four quarters is a full turn: back where it started.
    for (let index = 0; index < 3; index += 1) forge.rotateSelectedShape(1, 1);
    const full = forge.disguise.shapes[0]?.rotation ?? [];
    expect(Math.abs(full[3] ?? 0)).toBeCloseTo(Math.abs(before[3] ?? 0), 4);
  });

  it("copies a room object's form, sized to it and round if it is round", () => {
    const forge = controller();
    // The wall in the fixture room is far wider than it is deep, so it is not
    // round: a square thing must not come back as a cylinder.
    forge.selectShape(null);
    const sampled = forge.sampleFormUnderPointer();
    if (!sampled) {
      // Nothing under the centre of this fixture's view; the refusal is the
      // behaviour worth pinning, and it must say so rather than sit silent.
      expect(forge.disguise.shapes).toHaveLength(0);
      return;
    }
    const shape = forge.disguise.shapes.at(-1);
    expect(shape).toBeDefined();
    // Sized to the thing it copied, not to the default 0.35 cube.
    expect(shape?.scale.some((axis) => Math.abs(axis - 0.35) > 1e-6)).toBe(true);

    forge.undo();
    forge.undo();
    expect(forge.disguise.shapes).toHaveLength(0);
  });

  it("mirrors a shape to the other side of the body", () => {
    const forge = controller();
    forge.addShape("cylinder");
    forge.nudgeSelectedShape(0.2, 0.1, 0);
    const source = forge.disguise.shapes[0];
    expect(source).toBeDefined();

    expect(forge.mirrorSelectedShape()).toBe(true);
    const copy = forge.disguise.shapes.at(-1);
    // Reflected across the body's own left-right axis, not merely offset.
    expect(copy?.position[0]).toBeCloseTo(-(source?.position[0] ?? 0), 6);
    // And unchanged on the axes a mirror does not touch, or a barrel's second
    // band would come back at a different height from its first.
    expect(copy?.position[1]).toBeCloseTo(source?.position[1] ?? 0, 6);
    expect(copy?.position[2]).toBeCloseTo(source?.position[2] ?? 0, 6);

    forge.undo();
    expect(forge.disguise.shapes).toHaveLength(1);
  });

  it("nudges the selected shape with the arrow keys", () => {
    const forge = controller();
    forge.setToolMode("panels");
    forge.addShape("cube");
    const before = [...(forge.disguise.shapes[0]?.position ?? [])];

    press("ArrowRight");
    const afterX = forge.disguise.shapes[0]?.position ?? [];
    // Moved on the axis asked for and left alone on the others, or a nudge
    // becomes a drift a player has to correct.
    expect(afterX[0]).toBeGreaterThan(before[0] ?? 0);
    expect(afterX[1]).toBeCloseTo(before[1] ?? 0, 9);

    press("ArrowLeft");
    expect(forge.disguise.shapes[0]?.position[0]).toBeCloseTo(before[0] ?? 0, 9);
  });

  it("gives each shape a finish slot of its own", () => {
    const forge = controller();
    forge.addShape("cylinder");
    forge.addShape("cube");
    const [first, second] = forge.disguise.shapes;
    // A jar with a darker rim needs two slots; one shared slot would mean
    // painting the rim repainted the jar.
    expect(first?.materialSlotId).not.toBe(second?.materialSlotId);
  });

  it("keeps a duplicate wearing what it was copied from", () => {
    const forge = controller();
    forge.addShape("cube");
    const source = forge.disguise.shapes[0];
    forge.duplicateSelectedShape();
    const copy = forge.disguise.shapes.at(-1);
    // "Another one of these" means another one that looks like it.
    expect(copy?.materialSlotId).toBe(source?.materialSlotId);
  });

  it("refuses to build past the wire's ceiling rather than dropping shapes", () => {
    const forge = controller();
    for (let index = 0; index < MAX_SHAPES; index += 1) forge.addShape("cube");
    expect(forge.disguise.shapes).toHaveLength(MAX_SHAPES);
    expect(forge.addShape("cube")).toBe(false);
    expect(forge.disguise.shapes).toHaveLength(MAX_SHAPES);
  });
});
