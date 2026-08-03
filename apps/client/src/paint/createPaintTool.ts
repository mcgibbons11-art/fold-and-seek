import * as THREE from "three/webgpu";

import type { PaintStrokeWire } from "@foldseek/shared";

import { PAINT_INSTRUCTION } from "../gameplay/copy";
import { Eyedropper } from "./Eyedropper";
import { PaintBrushController, DEFAULT_BRUSH_RADIUS } from "./PaintBrushController";
import { PaintLayer, type PaintStroke, type PaintStrokeBatch } from "./PaintLayer";
import { PaintMaterialBinder } from "./PaintMaterialBinder";
import { PaintStore, type PaintPanelState } from "./paintStore";
import type { Hsv, Rgb } from "./color";

/**
 * The whole body-painting tool behind one factory, so the Forge can adopt it as
 * a fifth tool mode with a handful of calls and no knowledge of atlases,
 * material clones or wire encoding.
 *
 * Painting survives leaving paint mode: `deactivate` only stops taking the
 * pointer. The atlas stays on the body until the tool is disposed, which is what
 * the player expects from paint.
 */

export interface PaintToolDeps {
  readonly canvas: HTMLCanvasElement;
  readonly camera: THREE.Camera;
  readonly raycaster: THREE.Raycaster;
  /** The local player's paintable meshes: MimicVisual.segmentMeshes + panelMeshes. */
  readonly getMimicMeshes: () => readonly THREE.Object3D[];
  /** Everything the eyedropper may sample. Defaults to the Mimic alone. */
  readonly getPickTargets?: () => readonly THREE.Object3D[];
  readonly onStroke?: (stroke: PaintStroke) => void;
  readonly onStrokeStart?: () => void;
  readonly onStrokeUpdate?: (speedPxPerSecond: number) => void;
  readonly onStrokeEnd?: () => void;
  /**
   * The eyedropper fired, and whether it found anything. Both routes to a
   * sample — the armed click the brush intercepts and the direct `sampleAt` —
   * pass through one place inside, so a caller that wants to answer a pick
   * cannot miss half of them.
   */
  readonly onSample?: (picked: boolean) => void;
  /**
   * One completed drag, for a caller that keeps a history. Fired on pointer-up
   * rather than per stamp, because a drag is one thing the player did and so
   * one thing an undo should take back.
   */
  readonly onStrokeBatch?: (batch: PaintStrokeBatch) => void;
  /** The whole log as it stood before `clearAll` threw it away. */
  readonly onClear?: (cleared: readonly PaintStrokeWire[]) => void;
  /** Wired to MimicVisual.setCastShadow for the panel's shadow toggle. */
  readonly setCastShadow?: (enabled: boolean) => void;
  /** False for a pointer event the HUD owns. */
  readonly ownsPointerEvent?: (event: PointerEvent) => boolean;
  readonly atlasSize?: number;
  /** Expands one circular dab, for example onto a mirrored body target. */
  readonly expandStroke?: (stroke: PaintStroke) => readonly PaintStroke[];
}

export interface PaintTool {
  readonly layer: PaintLayer;
  readonly store: PaintStore;
  activate(): void;
  deactivate(): void;
  /** Per frame: rebinds materials the Mimic swapped and uploads new pixels. */
  update(): void;
  setColor(color: Rgb): void;
  setHsv(hsv: Hsv): void;
  setBrushSize(radius: number): void;
  setOpacity(opacity: number): void;
  setMetallic(metallic: number): void;
  setSmoothness(smoothness: number): void;
  setEmissive(emissive: number): void;
  setEraser(enabled: boolean): void;
  /** Puts a reverted batch back on the body, for the history's redo. */
  reapplyBatch(batch: PaintStrokeBatch): void;
  /** Takes a batch off the body, for the history's undo. */
  revertBatch(batch: PaintStrokeBatch): void;
  /** Restores a whole log, for undoing a clear. */
  restoreLog(strokes: readonly PaintStrokeWire[]): void;
  /** Clears without telling `onClear`, for a history replaying its own clear. */
  clearSilently(): void;
  /** Pins or unpins the current colour on the quick-swap row. */
  toggleSavedColor(): void;
  setShadow(enabled: boolean): void;
  /** The MECCHA F key: the next click copies a colour instead of painting. */
  armEyedropper(armed: boolean): void;
  /** Samples immediately at a screen point, for a key press with no click. */
  sampleAt(clientX: number, clientY: number): boolean;
  clearAll(): void;
  getState(): PaintPanelState;
  dispose(): void;
}

export function createPaintTool(deps: PaintToolDeps): PaintTool {
  const layer = new PaintLayer(
    deps.atlasSize === undefined ? {} : { atlasSize: deps.atlasSize },
  );
  const store = new PaintStore(DEFAULT_BRUSH_RADIUS);
  const binder = new PaintMaterialBinder(layer, deps.getMimicMeshes);
  const pointerNdc = new THREE.Vector2();

  const eyedropper = new Eyedropper({
    raycaster: deps.raycaster,
    camera: deps.camera,
    // Every tile view shares the atlas canvas, so one image comparison catches
    // a sample taken off the painter's own body, where a cached read-back would
    // be a frame out of date the moment the brush moved.
    getPixelSource: (texture) => {
      const atlas = layer.getTexture();
      return atlas !== null && texture.image === atlas.image ? layer.pixelSource() : null;
    },
  });

  const pickTargets = deps.getPickTargets ?? deps.getMimicMeshes;

  const takeSample = (pointer: THREE.Vector2): boolean => {
    const sample = eyedropper.sample(pointer, pickTargets());
    if (sample === null) {
      store.patch({ eyedropperArmed: false, status: "Nothing under the cursor to sample." });
      deps.onSample?.(false);
      return false;
    }
    store.setColor(sample.color);
    // The panel reads from the store, but strokes read from the brush's own
    // hot-path state. Keeping only the former made the swatch visibly change
    // while every following dab remained the constructor's default red.
    brush.setColor(store.getState().color);
    brush.setEraser(false);
    store.patch({ eyedropperArmed: false, status: "Colour copied. Drag to paint with it." });
    deps.onSample?.(true);
    return true;
  };

  const brush = new PaintBrushController({
    canvas: deps.canvas,
    camera: deps.camera,
    raycaster: deps.raycaster,
    getMimicMeshes: deps.getMimicMeshes,
    layer,
    ...(deps.expandStroke === undefined ? {} : { expandStroke: deps.expandStroke }),
    ...(deps.ownsPointerEvent === undefined ? {} : { ownsPointerEvent: deps.ownsPointerEvent }),
    interceptPointerDown: (pointer) => {
      if (!store.getState().eyedropperArmed) return false;
      takeSample(pointer);
      return true;
    },
    onStroke: (stroke) => {
      if (stroke.continued !== true) {
        store.rememberColor([stroke.color[0], stroke.color[1], stroke.color[2]]);
      }
      store.patch({ strokeCount: layer.strokeCount });
      deps.onStroke?.(stroke);
    },
    onStrokeStart: () => {
      layer.beginStrokeBatch();
      deps.onStrokeStart?.();
    },
    onStrokeUpdate: deps.onStrokeUpdate,
    onStrokeEnd: () => {
      const batch = layer.endStrokeBatch();
      if (batch !== null) deps.onStrokeBatch?.(batch);
      deps.onStrokeEnd?.();
    },
  });

  brush.setColor(store.getState().color);
  brush.setBrushSize(store.getState().brushSize);

  return {
    layer,
    store,

    activate(): void {
      binder.sync();
      brush.activate();
      store.patch({ active: true, status: PAINT_INSTRUCTION });
    },

    deactivate(): void {
      brush.deactivate();
      store.patch({ active: false, eyedropperArmed: false });
    },

    update(): void {
      binder.sync();
      brush.update();
      layer.flush();
    },

    setColor(color: Rgb): void {
      store.setColor(color);
      brush.setColor(store.getState().color);
      brush.setEraser(false);
    },

    setHsv(hsv: Hsv): void {
      store.setHsv(hsv);
      brush.setColor(store.getState().color);
      brush.setEraser(false);
    },

    setBrushSize(radius: number): void {
      brush.setBrushSize(radius);
      store.patch({ brushSize: brush.getBrushSize() });
    },

    setOpacity(opacity: number): void {
      brush.setOpacity(opacity);
      store.patch({ opacity: Math.min(1, Math.max(0, opacity)) });
    },

    setMetallic(metallic: number): void {
      brush.setMetallic(metallic);
      store.patch({ metallic: brush.getMetallic() });
    },

    setSmoothness(smoothness: number): void {
      brush.setSmoothness(smoothness);
      store.patch({ smoothness: brush.getSmoothness() });
    },

    setEmissive(emissive: number): void {
      brush.setEmissive(emissive);
      store.patch({ emissive: brush.getEmissive() });
    },

    reapplyBatch(batch: PaintStrokeBatch): void {
      layer.reapplyStrokeBatch(batch);
      store.patch({ strokeCount: layer.strokeCount });
    },

    revertBatch(batch: PaintStrokeBatch): void {
      layer.revertStrokeBatch(batch);
      store.patch({ strokeCount: layer.strokeCount });
    },

    restoreLog(strokes: readonly PaintStrokeWire[]): void {
      layer.restoreStrokeLog(strokes);
      store.patch({ strokeCount: layer.strokeCount });
    },

    toggleSavedColor(): void {
      store.toggleSavedColor(store.getState().color);
    },

    setEraser(enabled: boolean): void {
      brush.setEraser(enabled);
      store.patch({ eraser: enabled, eyedropperArmed: false });
    },

    setShadow(enabled: boolean): void {
      deps.setCastShadow?.(enabled);
      store.patch({ shadow: enabled });
    },

    armEyedropper(armed: boolean): void {
      store.patch({
        eyedropperArmed: armed,
        status: armed ? "Click any surface to copy its colour." : "Eyedropper off.",
      });
    },

    sampleAt(clientX: number, clientY: number): boolean {
      const rect = deps.canvas.getBoundingClientRect();
      pointerNdc.set(
        rect.width === 0 ? 0 : ((clientX - rect.left) / rect.width) * 2 - 1,
        rect.height === 0 ? 0 : -(((clientY - rect.top) / rect.height) * 2 - 1),
      );
      return takeSample(pointerNdc);
    },

    clearAll(): void {
      const cleared = layer.captureStrokeLog();
      layer.clear();
      store.patch({ strokeCount: 0, status: "Paint cleared." });
      deps.onClear?.(cleared);
    },

    clearSilently(): void {
      layer.clear();
      store.patch({ strokeCount: 0 });
    },

    getState(): PaintPanelState {
      return store.getState();
    },

    dispose(): void {
      brush.dispose();
      eyedropper.dispose();
      binder.dispose();
      layer.dispose();
    },
  };
}
