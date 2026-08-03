import * as THREE from "three/webgpu";

import type { PaintLayer, PaintStroke } from "./PaintLayer";
import { normalizeTargetUv, paintTargetOfObject } from "./paintTargets";

/**
 * Freehand painting on the player's own body (MECCHA port, CLAUDE.md override
 * 3). The pointer is raycast against the Mimic's shells and panels, and the hit
 * arrives with the UV that `writeSegmentShell` wrote, so a stamp lands where the
 * player pointed without any projection of our own.
 *
 * Pointer events only queue the latest real cursor position. The Forge consumes
 * that position once per rendered frame, so a fast mouse cannot flood the CPU
 * atlas with hundreds of synthetic samples. Every sample remains an independent
 * circular dab rather than a UV-space streak, which keeps the spray exactly
 * where the player pointed across shell seams.
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
  /**
   * Called on the press that starts a drag, before its first stamp, and again
   * when that pointer lets go. A drag is one gesture, so it is also one entry in
   * the Forge's history, and these two are the bounds that entry covers.
   */
  readonly onStrokeStart?: () => void;
  readonly onStrokeEnd?: () => void;
  /** Returns true when something else consumed the press (the eyedropper). */
  readonly interceptPointerDown?: (pointer: THREE.Vector2, event: PointerEvent) => boolean;
  /** False for a press the HUD owns. Defaults to presses landing on the canvas. */
  readonly ownsPointerEvent?: (event: PointerEvent) => boolean;
  /** Expands one cursor dab, used by the Forge's live symmetry mode. */
  readonly expandStroke?: (stroke: PaintStroke) => readonly PaintStroke[];
}

export const MIN_BRUSH_RADIUS = 0.025;
export const MAX_BRUSH_RADIUS = 0.45;
export const DEFAULT_BRUSH_RADIUS = 0.12;

export class PaintBrushController {
  private readonly options: PaintBrushOptions;
  private readonly pointerNdc = new THREE.Vector2();

  private color: [number, number, number] = [0.85, 0.27, 0.2];
  private radius = DEFAULT_BRUSH_RADIUS;
  private opacity = 1;
  private metallic = 0;
  private smoothness = 0.35;
  private emissive = 0;
  private eraser = false;

  private active = false;
  private detach: (() => void) | null = null;
  private pointerId = -1;
  private pendingClientX = 0;
  private pendingClientY = 0;
  private hasPendingSample = false;
  private readonly cursor: HTMLDivElement | null;

  constructor(options: PaintBrushOptions) {
    this.options = options;
    this.cursor = this.createCursor();
    this.resizeCursor();
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
    this.resizeCursor();
  }

  getBrushSize(): number {
    return this.radius;
  }

  setOpacity(opacity: number): void {
    this.opacity = Math.min(1, Math.max(0, opacity));
  }

  setMetallic(metallic: number): void {
    this.metallic = Math.min(1, Math.max(0, metallic));
  }

  getMetallic(): number {
    return this.metallic;
  }

  setSmoothness(smoothness: number): void {
    this.smoothness = Math.min(1, Math.max(0, smoothness));
  }

  getSmoothness(): number {
    return this.smoothness;
  }

  setEmissive(emissive: number): void {
    this.emissive = Math.min(1, Math.max(0, emissive));
  }

  getEmissive(): number {
    return this.emissive;
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
      this.hasPendingSample = false;
      this.options.onStrokeStart?.();
      this.emit(hit.target, hit.u, hit.v, false);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerId !== this.pointerId) return;
      // The event itself is the browser's newest pointer position. Replaying
      // coalesced history here made one frame perform dozens of raycasts and
      // software atlas stamps, which is exactly the lag a spray tool must avoid.
      this.pendingClientX = event.clientX;
      this.pendingClientY = event.clientY;
      this.hasPendingSample = true;
      this.positionCursor(event.clientX, event.clientY);
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (event.pointerId !== this.pointerId) return;
      this.flushPendingSample();
      if (this.options.canvas.hasPointerCapture(event.pointerId)) {
        this.options.canvas.releasePointerCapture(event.pointerId);
      }
      this.pointerId = -1;
      this.options.onStrokeEnd?.();
    };

    const onHover = (event: PointerEvent): void => {
      this.positionCursor(event.clientX, event.clientY);
    };
    const onLeave = (): void => {
      if (this.pointerId < 0) this.hideCursor();
    };

    const canvas = this.options.canvas;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onHover);
    canvas.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    this.detach = () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onHover);
      canvas.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    const wasPainting = this.pointerId >= 0;
    if (wasPainting) this.flushPendingSample();
    if (wasPainting && this.options.canvas.hasPointerCapture(this.pointerId)) {
      this.options.canvas.releasePointerCapture(this.pointerId);
    }
    this.pointerId = -1;
    this.hideCursor();
    this.detach?.();
    this.detach = null;
    // Leaving paint mode mid-drag still ends the drag, so the gesture reaches
    // the history rather than staying open behind an inactive tool.
    if (wasPainting) this.options.onStrokeEnd?.();
  }

  dispose(): void {
    this.deactivate();
    this.cursor?.remove();
  }

  /** Commits no more than the newest queued cursor position each render frame. */
  update(): void {
    if (this.pointerId >= 0) this.flushPendingSample();
  }

  /** Paints one stamp at a screen point, for a caller driving this by hand. */
  paintAt(clientX: number, clientY: number): PaintStroke | null {
    this.setPointerFromClient(clientX, clientY);
    const hit = this.pick();
    if (hit === null) return null;
    this.options.onStrokeStart?.();
    const stroke = this.emit(hit.target, hit.u, hit.v, false);
    this.options.onStrokeEnd?.();
    return stroke;
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
    this.positionCursor(event.clientX, event.clientY);
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

  private flushPendingSample(): void {
    if (!this.hasPendingSample) return;
    this.hasPendingSample = false;
    this.setPointerFromClient(this.pendingClientX, this.pendingClientY);
    const hit = this.pick();
    if (hit !== null) this.emit(hit.target, hit.u, hit.v, false);
  }

  private emit(target: number, u: number, v: number, continued: boolean): PaintStroke {
    const stroke: PaintStroke = {
      segmentId: target,
      uv: [u, v],
      radius: this.radius,
      color: [...this.color],
      opacity: this.opacity,
      metallic: this.metallic,
      smoothness: this.smoothness,
      emissive: this.emissive,
      kind: this.eraser ? "eraser" : "brush",
      continued,
    };
    const expanded = this.options.expandStroke?.(stroke) ?? [stroke];
    for (const dab of expanded) this.options.layer.applyStroke(dab);
    this.options.onStroke?.(stroke);
    return stroke;
  }

  private createCursor(): HTMLDivElement | null {
    if (typeof document === "undefined") return null;
    const cursor = document.createElement("div");
    cursor.dataset["paintCursor"] = "true";
    Object.assign(cursor.style, {
      position: "fixed",
      left: "0",
      top: "0",
      border: "1px solid rgba(255, 244, 218, 0.95)",
      borderRadius: "50%",
      boxShadow: "0 0 0 1px rgba(16, 10, 5, 0.75), inset 0 0 8px rgba(255, 190, 107, 0.22)",
      transform: "translate(-50%, -50%)",
      pointerEvents: "none",
      zIndex: "200",
      display: "none",
    });
    document.body.append(cursor);
    return cursor;
  }

  private resizeCursor(): void {
    if (this.cursor === null) return;
    const diameter = Math.round(12 + (this.radius / MAX_BRUSH_RADIUS) * 76);
    this.cursor.style.width = `${diameter}px`;
    this.cursor.style.height = `${diameter}px`;
  }

  private positionCursor(clientX: number, clientY: number): void {
    if (this.cursor === null || !this.active) return;
    this.cursor.style.left = `${clientX}px`;
    this.cursor.style.top = `${clientY}px`;
    this.cursor.style.display = "block";
  }

  private hideCursor(): void {
    if (this.cursor !== null) this.cursor.style.display = "none";
  }
}
