import * as THREE from "three/webgpu";

import type { PaintLayer, PaintStroke } from "./PaintLayer";
import { normalizeTargetUv, paintTargetOfObject } from "./paintTargets";

/**
 * Freehand painting on the player's own body (MECCHA port, CLAUDE.md override
 * 3). The pointer is raycast against the Mimic's shells and panels, and the hit
 * arrives with the UV that `writeSegmentShell` wrote, so a stamp lands where the
 * player pointed without any projection of our own.
 *
 * Samples are emitted on movement rather than on every pointer event. The wire
 * carries a bounded stroke log, so a drag that emitted a stamp per frame would
 * spend the whole budget in a few seconds; spacing the samples and letting the
 * layer interpolate between them draws the same line from a tenth of the log.
 */

export interface PaintBrushOptions {
  readonly canvas: HTMLCanvasElement;
  readonly camera: THREE.Camera;
  readonly raycaster: THREE.Raycaster;
  /** The local player's paintable meshes, re-read on every press. */
  readonly getMimicMeshes: () => readonly THREE.Object3D[];
  readonly layer: PaintLayer;
  /** Called for every stamp, in log order, for the caller to publish. */
  readonly onStroke?: (stroke: PaintStroke) => void;
  /** Returns true when something else consumed the press (the eyedropper). */
  readonly interceptPointerDown?: (pointer: THREE.Vector2, event: PointerEvent) => boolean;
  /** False for a press the HUD owns. Defaults to presses landing on the canvas. */
  readonly ownsPointerEvent?: (event: PointerEvent) => boolean;
}

/** Pointer travel, as a fraction of the brush radius, between two samples. */
const SAMPLE_SPACING = 0.5;

export const MIN_BRUSH_RADIUS = 0.015;
export const MAX_BRUSH_RADIUS = 0.35;
export const DEFAULT_BRUSH_RADIUS = 0.06;

export class PaintBrushController {
  private readonly options: PaintBrushOptions;
  private readonly pointerNdc = new THREE.Vector2();

  private color: [number, number, number] = [0.85, 0.27, 0.2];
  private radius = DEFAULT_BRUSH_RADIUS;
  private opacity = 1;
  private eraser = false;

  private active = false;
  private detach: (() => void) | null = null;
  private pointerId = -1;
  private strokeTarget = -1;
  private lastU = 0;
  private lastV = 0;

  constructor(options: PaintBrushOptions) {
    this.options = options;
  }

  get isPainting(): boolean {
    return this.pointerId >= 0;
  }

  setColor(color: readonly [number, number, number]): void {
    this.color = [color[0], color[1], color[2]];
  }

  getColor(): [number, number, number] {
    return [...this.color];
  }

  setBrushSize(radius: number): void {
    this.radius = Math.min(MAX_BRUSH_RADIUS, Math.max(MIN_BRUSH_RADIUS, radius));
  }

  getBrushSize(): number {
    return this.radius;
  }

  setOpacity(opacity: number): void {
    this.opacity = Math.min(1, Math.max(0, opacity));
  }

  setEraser(enabled: boolean): void {
    this.eraser = enabled;
  }

  get isEraser(): boolean {
    return this.eraser;
  }

  activate(): void {
    if (this.active) return;
    this.active = true;

    const onPointerDown = (event: PointerEvent): void => {
      if (!this.owns(event) || event.button !== 0) return;
      this.updatePointer(event);
      if (this.options.interceptPointerDown?.(this.pointerNdc, event) === true) {
        event.preventDefault();
        return;
      }
      const hit = this.pick();
      if (hit === null) return;
      event.preventDefault();
      this.pointerId = event.pointerId;
      this.options.canvas.setPointerCapture(event.pointerId);
      this.strokeTarget = hit.target;
      this.emit(hit.target, hit.u, hit.v, false);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerId !== this.pointerId) return;
      this.updatePointer(event);
      const hit = this.pick();
      if (hit === null) return;

      // Crossing onto another part starts a fresh line: joining a stamp on the
      // forearm to one on the thigh would draw a stripe across neither.
      const continued = hit.target === this.strokeTarget;
      if (continued && !this.movedFarEnough(hit.u, hit.v)) return;
      this.strokeTarget = hit.target;
      this.emit(hit.target, hit.u, hit.v, continued);
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (event.pointerId !== this.pointerId) return;
      if (this.options.canvas.hasPointerCapture(event.pointerId)) {
        this.options.canvas.releasePointerCapture(event.pointerId);
      }
      this.pointerId = -1;
      this.strokeTarget = -1;
    };

    const canvas = this.options.canvas;
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    this.detach = () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    if (this.pointerId >= 0 && this.options.canvas.hasPointerCapture(this.pointerId)) {
      this.options.canvas.releasePointerCapture(this.pointerId);
    }
    this.pointerId = -1;
    this.strokeTarget = -1;
    this.detach?.();
    this.detach = null;
  }

  dispose(): void {
    this.deactivate();
  }

  /** Paints one stamp at a screen point, for a caller driving this by hand. */
  paintAt(clientX: number, clientY: number): PaintStroke | null {
    this.setPointerFromClient(clientX, clientY);
    const hit = this.pick();
    if (hit === null) return null;
    return this.emit(hit.target, hit.u, hit.v, false);
  }

  /** The paint target and UV under a screen point, or null over nothing. */
  pickAt(clientX: number, clientY: number): { target: number; u: number; v: number } | null {
    this.setPointerFromClient(clientX, clientY);
    return this.pick();
  }

  private owns(event: PointerEvent): boolean {
    if (this.options.ownsPointerEvent !== undefined) return this.options.ownsPointerEvent(event);
    return event.target === this.options.canvas;
  }

  private updatePointer(event: PointerEvent): void {
    this.setPointerFromClient(event.clientX, event.clientY);
  }

  private setPointerFromClient(clientX: number, clientY: number): void {
    const rect = this.options.canvas.getBoundingClientRect();
    this.pointerNdc.set(
      rect.width === 0 ? 0 : ((clientX - rect.left) / rect.width) * 2 - 1,
      rect.height === 0 ? 0 : -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
  }

  private pick(): { target: number; u: number; v: number } | null {
    this.options.raycaster.setFromCamera(this.pointerNdc, this.options.camera);
    const hits = this.options.raycaster.intersectObjects([...this.options.getMimicMeshes()], false);
    for (const hit of hits) {
      const target = paintTargetOfObject(hit.object);
      if (target === null || hit.uv === undefined) continue;
      const [u, v] = normalizeTargetUv(target, hit.uv.x, hit.uv.y);
      return { target, u, v };
    }
    return null;
  }

  private movedFarEnough(u: number, v: number): boolean {
    const distance = Math.hypot(u - this.lastU, v - this.lastV);
    return distance >= this.radius * SAMPLE_SPACING;
  }

  private emit(target: number, u: number, v: number, continued: boolean): PaintStroke {
    const stroke: PaintStroke = {
      segmentId: target,
      uv: [u, v],
      radius: this.radius,
      color: [...this.color],
      opacity: this.opacity,
      kind: this.eraser ? "eraser" : "brush",
      continued,
    };
    this.lastU = u;
    this.lastV = v;
    this.options.layer.applyStroke(stroke);
    this.options.onStroke?.(stroke);
    return stroke;
  }
}
