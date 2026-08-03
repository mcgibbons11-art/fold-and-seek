import * as THREE from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ForgeController } from "../../src/forge/ForgeController";
import { PANEL_PROFILE_IDS } from "../../src/mimic/panels";
import { createPanelGeometry } from "../../src/mimic/visual/mimicGeometry";
import { qualitySettingsFor } from "../../src/rendering/quality";

/**
 * Painting as the Forge's fifth tool mode.
 *
 * The interesting part is not that the tool exists but that two pointer owners
 * share one canvas: the Forge captures at the window, the brush listens on the
 * canvas, and a Forge handler that stops propagation would starve the brush of
 * every press. These drive the real handlers through a stub window to check the
 * Forge lets go in paint mode and takes the pointer back everywhere else.
 */

type Listener = (event: never) => void;

class ListenerTable {
  private readonly byType = new Map<string, Listener[]>();

  add = (type: string, listener: Listener): void => {
    const list = this.byType.get(type) ?? [];
    list.push(listener);
    this.byType.set(type, list);
  };

  remove = (type: string, listener: Listener): void => {
    const list = this.byType.get(type);
    if (list === undefined) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  };

  count(type: string): number {
    return this.byType.get(type)?.length ?? 0;
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.byType.get(type) ?? [])]) {
      (listener as (event: unknown) => void)(event);
    }
  }
}

interface PointerRecord {
  readonly event: Record<string, unknown>;
  stopped: boolean;
  defaulted: boolean;
}

class Harness {
  readonly controller: ForgeController;
  readonly scene = new THREE.Scene();
  readonly windowListeners = new ListenerTable();
  readonly canvasListeners = new ListenerTable();
  readonly canvas: { style: { cursor: string } };

  private readonly previousWindow: unknown;

  constructor() {
    const canvasListeners = this.canvasListeners;
    const canvas = {
      style: { cursor: "default" },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
      hasPointerCapture: () => false,
      addEventListener: canvasListeners.add,
      removeEventListener: canvasListeners.remove,
    };
    this.canvas = canvas;

    this.previousWindow = (globalThis as Record<string, unknown>)["window"];
    (globalThis as Record<string, unknown>)["window"] = {
      addEventListener: this.windowListeners.add,
      removeEventListener: this.windowListeners.remove,
    };

    this.controller = new ForgeController({
      scene: this.scene,
      canvas: canvas as unknown as HTMLCanvasElement,
      quality: qualitySettingsFor("medium"),
    });
  }

  /**
   * Where a paintable shell sits on screen. Nothing renders under the runner,
   * so the world matrices are brought up to date by hand and the part's centre
   * is projected through the Forge's own camera: a drag aimed here is one the
   * brush's raycast can actually land.
   */
  pointOnBody(): [number, number] | null {
    this.scene.updateMatrixWorld(true);
    this.controller.camera.updateMatrixWorld(true);
    const point = new THREE.Vector3();
    let found: [number, number] | null = null;
    this.scene.traverse((object) => {
      if (found !== null || !(object instanceof THREE.Mesh) || !object.visible) return;
      if (typeof object.userData["segmentSlot"] !== "number") return;
      object.getWorldPosition(point).project(this.controller.camera);
      if (Math.abs(point.x) > 1 || Math.abs(point.y) > 1) return;
      found = [((point.x + 1) / 2) * 800, ((1 - point.y) / 2) * 600];
    });
    return found;
  }

  /** Runs a pointer event through the Forge's window handlers. */
  pointer(type: string, fields: Record<string, unknown> = {}): PointerRecord {
    const record: PointerRecord = { event: {}, stopped: false, defaulted: false };
    Object.assign(record.event, {
      pointerId: 1,
      button: 0,
      shiftKey: false,
      clientX: 400,
      clientY: 300,
      target: this.canvas,
      stopPropagation: () => {
        record.stopped = true;
      },
      preventDefault: () => {
        record.defaulted = true;
      },
      ...fields,
    });
    this.windowListeners.dispatch(type, record.event);
    return record;
  }

  key(key: string, modifiers: Record<string, unknown> = {}): void {
    this.windowListeners.dispatch("keydown", {
      key,
      target: this.canvas,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: () => undefined,
      ...modifiers,
    });
  }

  /**
   * A brush drag on the body: a press on the canvas, a move, and a release.
   * The brush listens on the canvas for the press and on the window for the
   * rest, which is why this dispatches through both tables.
   */
  drag(points: readonly (readonly [number, number])[]): void {
    const [first, ...rest] = points;
    if (first === undefined) return;
    const make = (x: number, y: number): Record<string, unknown> => ({
      pointerId: 7,
      button: 0,
      shiftKey: false,
      clientX: x,
      clientY: y,
      target: this.canvas,
      stopPropagation: () => undefined,
      preventDefault: () => undefined,
    });
    this.canvasListeners.dispatch("pointerdown", make(first[0], first[1]));
    for (const [x, y] of rest) {
      this.windowListeners.dispatch("pointermove", make(x, y));
    }
    this.windowListeners.dispatch("pointerup", make(first[0], first[1]));
  }

  dispose(): void {
    this.controller.dispose();
    (globalThis as Record<string, unknown>)["window"] = this.previousWindow;
  }
}

let harness: Harness;

beforeEach(() => {
  // The Forge's own key handling type-tests the event target, and its audio
  // pool builds elements on the first sound. Neither exists under the runner.
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

describe("paint as a forge tool mode", () => {
  it("is reachable from key 5 and takes the pointer only while selected", () => {
    expect(harness.controller.paint.getState().active).toBe(false);
    expect(harness.canvasListeners.count("pointerdown")).toBe(0);

    harness.key("5");

    expect(harness.controller.snapshot().mode).toBe("paint");
    expect(harness.controller.paint.getState().active).toBe(true);
    expect(harness.canvasListeners.count("pointerdown")).toBe(1);

    harness.key("1");

    expect(harness.controller.snapshot().mode).toBe("pose");
    expect(harness.controller.paint.getState().active).toBe(false);
    expect(harness.canvasListeners.count("pointerdown")).toBe(0);
  });

  it("leaves a left press alone in paint mode and consumes it everywhere else", () => {
    const posed = harness.pointer("pointerdown");
    expect(posed.stopped).toBe(true);
    expect(posed.defaulted).toBe(true);

    harness.controller.setToolMode("paint");

    const painted = harness.pointer("pointerdown");
    expect(painted.stopped).toBe(false);
    expect(painted.defaulted).toBe(false);
    expect(harness.pointer("pointermove").stopped).toBe(false);
    expect(harness.pointer("pointerup").stopped).toBe(false);
  });

  it("still orbits on a right drag while painting", () => {
    harness.controller.setToolMode("paint");
    const before = harness.controller.camera.position.clone();

    expect(harness.pointer("pointerdown", { button: 2 }).stopped).toBe(true);
    // The drag owns the pointer until it is released, so the move belongs to the
    // camera rather than to the brush.
    expect(harness.pointer("pointermove", { clientX: 520 }).stopped).toBe(true);
    expect(harness.controller.camera.position.distanceTo(before)).toBeGreaterThan(0.01);

    harness.pointer("pointerup", { button: 2 });
    expect(harness.pointer("pointermove", { clientX: 400 }).stopped).toBe(false);
  });

  it("gives F to the eyedropper in paint mode and to swatch sampling elsewhere", () => {
    harness.controller.setToolMode("material");
    harness.key("f");
    expect(harness.controller.snapshot().status).toBe("Nothing under the cursor to sample.");

    harness.controller.setToolMode("paint");
    const status = harness.controller.snapshot().status;
    harness.key("f");
    expect(harness.controller.snapshot().status).toBe(status);
  });
});

describe("paint in the forge history", () => {
  /** One drag on the body, through the real pointer handlers. */
  function paintOnce(): void {
    harness.controller.setToolMode("paint");
    const at = harness.pointOnBody();
    expect(at).not.toBeNull();
    const [x, y] = at ?? [0, 0];
    const before = harness.controller.paint.layer.strokeCount;
    harness.drag([
      [x, y],
      [x + 14, y + 9],
      [x + 28, y + 18],
    ]);
    expect(harness.controller.paint.layer.strokeCount).toBeGreaterThan(before);
    // The revised spray is a trail of cursor-centred circles. It never asks the
    // atlas to bridge two UV points, which was the source of long seam streaks.
    expect(harness.controller.paint.layer.strokeLog.every((stroke) => !stroke.continued)).toBe(true);
  }

  it("offers an undo for the drag rather than for the pose before it", () => {
    // The regression: with paint outside the history, this undo reverted the
    // last POSE command and left every stamp on the body.
    harness.controller.applyArrangement("compact");
    const poseLabel = harness.controller.snapshot().undoLabel;
    expect(poseLabel).not.toBe("paint stroke");

    paintOnce();
    const painted = harness.controller.paint.layer.strokeCount;

    const snapshot = harness.controller.snapshot();
    expect(snapshot.canUndo).toBe(true);
    expect(snapshot.undoLabel).toBe("paint stroke");

    harness.controller.undo();
    expect(harness.controller.paint.layer.strokeCount).toBe(0);
    expect(harness.controller.snapshot().status).toBe("Undid paint stroke.");
    // The pose command is still there, untouched, and is what the next undo takes.
    expect(harness.controller.snapshot().undoLabel).toBe(poseLabel);

    harness.controller.redo();
    expect(harness.controller.paint.layer.strokeCount).toBe(painted);
  });

  it("records one entry per drag, not one per stamp", () => {
    paintOnce();
    const stamps = harness.controller.paint.layer.strokeCount;
    expect(stamps).toBeGreaterThan(1);

    harness.controller.undo();
    expect(harness.controller.paint.layer.strokeCount).toBe(0);
    expect(harness.controller.snapshot().canUndo).toBe(false);
  });

  it("puts the whole layer back when a clear is undone", () => {
    paintOnce();
    const painted = harness.controller.paint.layer.toDataForWire();

    harness.controller.paint.clearAll();
    expect(harness.controller.paint.layer.strokeCount).toBe(0);
    expect(harness.controller.snapshot().undoLabel).toBe("clear paint");

    harness.controller.undo();
    expect(harness.controller.paint.layer.toDataForWire()).toBe(painted);
  });
});

describe("locking a painted disguise", () => {
  it("carries the paint layer beside the pose", () => {
    const layer = harness.controller.paint.layer;
    const unpainted = layer.toDataForWire();

    layer.applyStroke({
      segmentId: 0,
      uv: [0.5, 0.5],
      radius: 0.2,
      color: [0.9, 0.2, 0.1],
      opacity: 1,
      kind: "brush",
    });

    harness.controller.lock();

    const locked = harness.controller.lockedDisguise;
    expect(locked).not.toBeNull();
    expect(locked?.disguise.joints.length).toBeGreaterThan(0);
    expect(locked?.encodedPaint).toBe(layer.toDataForWire());
    expect(locked?.encodedPaint).not.toBe(unpainted);
  });

  it("stops taking the pointer once locked and takes it back on unlock", () => {
    harness.controller.setToolMode("paint");
    harness.controller.lock();

    expect(harness.controller.paint.getState().active).toBe(false);
    expect(harness.canvasListeners.count("pointerdown")).toBe(0);

    harness.controller.unlock();

    expect(harness.controller.paint.getState().active).toBe(true);
    expect(harness.canvasListeners.count("pointerdown")).toBe(1);
  });
});

describe("panel plate uvs", () => {
  it("publishes the unit square the paint atlas maps tiles onto", () => {
    for (const profileId of PANEL_PROFILE_IDS) {
      const geometry = createPanelGeometry(profileId, 0.018);
      const uv = geometry.getAttribute("uv");
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (let i = 0; i < uv.count; i++) {
        minU = Math.min(minU, uv.getX(i));
        maxU = Math.max(maxU, uv.getX(i));
        minV = Math.min(minV, uv.getY(i));
        maxV = Math.max(maxV, uv.getY(i));
      }
      expect(minU).toBeCloseTo(0, 5);
      expect(maxU).toBeCloseTo(1, 5);
      expect(minV).toBeCloseTo(0, 5);
      expect(maxV).toBeCloseTo(1, 5);
      geometry.dispose();
    }
  });
});
