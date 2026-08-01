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
      scene: new THREE.Scene(),
      canvas: canvas as unknown as HTMLCanvasElement,
      quality: qualitySettingsFor("medium"),
    });
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

  key(key: string): void {
    this.windowListeners.dispatch("keydown", {
      key,
      target: this.canvas,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: () => undefined,
    });
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
