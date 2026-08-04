import type { InspectorMoveInput } from "./InspectorController";
import { actionForCode, readStandardGamepad } from "../gameplay/inputBindings";

/**
 * Samples keyboard and mouse into the action set the controller consumes
 * (§25.1). Mouse aim uses ordinary movement over the canvas: the crosshair is
 * visible, the system cursor stays free, and browser pointer lock is never
 * requested. Tab/window focus loss clears held actions so no key can stick.
 *
 * Left mouse fires the gun, right mouse aims down the sights, and space hops.
 */

export interface InspectorInputOptions {
  /** Radians of yaw per pixel of mouse travel. */
  readonly lookSensitivity?: number;
  readonly lookSensitivityX?: number;
  readonly lookSensitivityY?: number;
  readonly invertY?: boolean;
}

export const DEFAULT_LOOK_SENSITIVITY = 0.0022;

const BRISK_KEYS = new Set(["ShiftLeft", "ShiftRight"]);

const MOUSE_BUTTON_FIRE = 0;
const MOUSE_BUTTON_AIM = 2;

export class InspectorInput {
  private readonly element: HTMLElement;
  private sensitivityX: number;
  private sensitivityY: number;
  private invertY: boolean;

  private readonly held = new Set<string>();
  private pendingYaw = 0;
  private pendingPitch = 0;
  private pendingZoom = 0;
  private attached = false;

  /** Right mouse: aim down the sights. Replaces the old focus hold. */
  aimHeld = false;
  /** Left mouse held, for a viewmodel. The gun itself fires on the press edge. */
  fireHeld = false;
  /** Set on the press, cleared by `takeFirePressed`, so one click is one shot. */
  private firePressed = false;
  private grapplePressed = false;
  private gamepadFireHeld = false;
  private gamepadGrappleHeld = false;
  private gamepadAimHeld = false;

  constructor(element: HTMLElement, options: InspectorInputOptions = {}) {
    this.element = element;
    this.sensitivityX = options.lookSensitivityX ?? options.lookSensitivity ?? DEFAULT_LOOK_SENSITIVITY;
    this.sensitivityY = options.lookSensitivityY ?? options.lookSensitivity ?? DEFAULT_LOOK_SENSITIVITY;
    this.invertY = options.invertY ?? false;
  }

  setLookPreferences(sensitivityX: number, sensitivityY: number, invertY: boolean): void {
    this.sensitivityX = sensitivityX;
    this.sensitivityY = sensitivityY;
    this.invertY = invertY;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.element.addEventListener("mousedown", this.onMouseDown);
    this.element.addEventListener("contextmenu", this.onContextMenu);
    this.element.addEventListener("wheel", this.onWheel, { passive: false });
    const doc = this.element.ownerDocument;
    doc.addEventListener("mousemove", this.onMouseMove);
    doc.addEventListener("mouseup", this.onMouseUp);
    doc.addEventListener("keydown", this.onKeyDown);
    doc.addEventListener("keyup", this.onKeyUp);
    doc.defaultView?.addEventListener("blur", this.onBlur);
  }

  dispose(): void {
    if (!this.attached) return;
    this.attached = false;
    this.element.removeEventListener("mousedown", this.onMouseDown);
    this.element.removeEventListener("contextmenu", this.onContextMenu);
    this.element.removeEventListener("wheel", this.onWheel);
    const doc = this.element.ownerDocument;
    doc.removeEventListener("mousemove", this.onMouseMove);
    doc.removeEventListener("mouseup", this.onMouseUp);
    doc.removeEventListener("keydown", this.onKeyDown);
    doc.removeEventListener("keyup", this.onKeyUp);
    doc.defaultView?.removeEventListener("blur", this.onBlur);
    this.clear();
  }

  /** Writes this frame's intent and consumes the accumulated look delta. */
  sample(out: InspectorMoveInput, dtSeconds = 1 / 60): void {
    const gamepad = readStandardGamepad();
    out.forward = actionAxis(this.held, "moveForward", "moveBack") + -(gamepad?.moveY ?? 0);
    out.strafe = actionAxis(this.held, "moveRight", "moveLeft") + (gamepad?.moveX ?? 0);
    out.forward = Math.max(-1, Math.min(1, out.forward));
    out.strafe = Math.max(-1, Math.min(1, out.strafe));
    out.brisk = hasAny(this.held, BRISK_KEYS);
    out.jump = actionHeld(this.held, "jump") || (gamepad?.jump ?? false);
    out.disengageClimb = actionHeld(this.held, "moveBack");
    out.lookYawDelta = this.pendingYaw - (gamepad?.lookX ?? 0) * 2.5 * dtSeconds;
    const gamepadPitch = (gamepad?.lookY ?? 0) * 2.2 * dtSeconds;
    out.lookPitchDelta = this.pendingPitch + (this.invertY ? gamepadPitch : -gamepadPitch);
    const mouseAimHeld = this.aimHeld && !this.gamepadAimHeld;
    this.gamepadAimHeld = gamepad?.aim ?? false;
    this.aimHeld = mouseAimHeld || this.gamepadAimHeld;
    const gamepadFire = gamepad?.fire ?? false;
    if (gamepadFire && !this.gamepadFireHeld) this.firePressed = true;
    this.gamepadFireHeld = gamepadFire;
    const gamepadGrapple = gamepad?.grapple ?? false;
    if (gamepadGrapple && !this.gamepadGrappleHeld) this.grapplePressed = true;
    this.gamepadGrappleHeld = gamepadGrapple;
    this.pendingYaw = 0;
    this.pendingPitch = 0;
  }

  /**
   * Consumes the trigger press. A shot is edge-triggered, so a click that
   * arrives between two frames still fires exactly once, and a held button
   * never fires twice.
   */
  takeFirePressed(): boolean {
    if (!this.firePressed) return false;
    this.firePressed = false;
    this.gamepadFireHeld = false;
    this.gamepadAimHeld = false;
    return true;
  }

  takeGrapplePressed(): boolean {
    if (!this.grapplePressed) return false;
    this.grapplePressed = false;
    return true;
  }

  /** Consumes wheel travel accumulated since the previous rendered frame. */
  takeZoomDelta(): number {
    const delta = this.pendingZoom;
    this.pendingZoom = 0;
    return delta;
  }

  private clear(): void {
    this.held.clear();
    this.aimHeld = false;
    this.fireHeld = false;
    this.firePressed = false;
    this.grapplePressed = false;
    this.pendingYaw = 0;
    this.pendingPitch = 0;
    this.pendingZoom = 0;
    this.gamepadFireHeld = false;
    this.gamepadAimHeld = false;
    this.gamepadGrappleHeld = false;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isEditingControl(event.target)) return;
    this.held.add(event.code);
    if (!event.repeat && actionForCode(event.code) === "grapple") this.grapplePressed = true;
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.target !== this.element) return;
    if (event.button === MOUSE_BUTTON_AIM) this.aimHeld = true;
    if (event.button === MOUSE_BUTTON_FIRE) {
      this.fireHeld = true;
      this.firePressed = true;
    }
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button === MOUSE_BUTTON_AIM) this.aimHeld = false;
    if (event.button === MOUSE_BUTTON_FIRE) this.fireHeld = false;
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (event.target !== this.element) return;
    this.pendingYaw -= event.movementX * this.sensitivityX;
    const pitchDelta = event.movementY * this.sensitivityY;
    this.pendingPitch += this.invertY ? pitchDelta : -pitchDelta;
  };

  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.target !== this.element) return;
    event.preventDefault();
    this.pendingZoom += event.deltaY;
  };

  private readonly onBlur = (): void => {
    this.clear();
  };
}

function isEditingControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.matches("input, textarea, select, [contenteditable='true']");
}

function actionAxis(held: ReadonlySet<string>, positive: Parameters<typeof actionHeld>[1], negative: Parameters<typeof actionHeld>[1]): number {
  const up = actionHeld(held, positive) ? 1 : 0;
  const down = actionHeld(held, negative) ? 1 : 0;
  return up - down;
}

function actionHeld(held: ReadonlySet<string>, action: "moveForward" | "moveBack" | "moveLeft" | "moveRight" | "jump"): boolean {
  for (const code of held) if (actionForCode(code) === action) return true;
  return false;
}

function hasAny(held: ReadonlySet<string>, codes: ReadonlySet<string>): boolean {
  for (const code of codes) {
    if (held.has(code)) return true;
  }
  return false;
}
