export const REBINDABLE_ACTIONS = [
  "moveForward", "moveBack", "moveLeft", "moveRight", "jump",
  "toolPose", "toolShape", "toolPanels", "toolMaterial", "toolPaint",
  "mirror", "eyedropper", "taunt",
] as const;

export type InputAction = (typeof REBINDABLE_ACTIONS)[number];
export type InputBindings = Readonly<Record<InputAction, string>>;
export type BindingConflictResolution = "swap" | "replace" | "cancel";
export type GamepadCode = `Button${number}` | `Axis${number}+` | `Axis${number}-`;
export type GamepadBindings = Readonly<Record<InputAction, GamepadCode | null>>;

export const INPUT_ACTION_LABELS: Readonly<Record<InputAction, string>> = {
  moveForward: "Move forward", moveBack: "Move back", moveLeft: "Move left", moveRight: "Move right",
  jump: "Jump / climb", toolPose: "Pose tool", toolShape: "Shape tool", toolPanels: "Panels tool",
  toolMaterial: "Material tool", toolPaint: "Paint tool", mirror: "Mirror", eyedropper: "Eyedropper", taunt: "Taunt",
};

const DEFAULTS: InputBindings = {
  moveForward: "KeyW", moveBack: "KeyS", moveLeft: "KeyA", moveRight: "KeyD", jump: "Space",
  toolPose: "Digit1", toolShape: "Digit2", toolPanels: "Digit3", toolMaterial: "Digit4", toolPaint: "Digit5",
  mirror: "KeyM", eyedropper: "KeyF", taunt: "KeyT",
};

const GAMEPAD_DEFAULTS: GamepadBindings = {
  moveForward: "Axis1-", moveBack: "Axis1+", moveLeft: "Axis0-", moveRight: "Axis0+",
  jump: "Button0", toolPose: "Button12", toolShape: "Button13", toolPanels: "Button14",
  toolMaterial: "Button15", toolPaint: "Button9", mirror: "Button3", eyedropper: "Button2",
  taunt: "Button1",
};

const STORAGE_KEY = "foldseek.bindings.v1";
const GAMEPAD_STORAGE_KEY = "foldseek.gamepadBindings.v1";
const listeners = new Set<() => void>();

function load(): InputBindings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(REBINDABLE_ACTIONS.map((action) => [action, typeof parsed[action] === "string" ? parsed[action] : DEFAULTS[action]])) as unknown as InputBindings;
  } catch {
    return DEFAULTS;
  }
}

let current = typeof window === "undefined" ? DEFAULTS : load();

function loadGamepad(): GamepadBindings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GAMEPAD_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(REBINDABLE_ACTIONS.map((action) => {
      const value = parsed[action];
      return [action, typeof value === "string" && /^(?:Button\d+|Axis\d+[+-])$/u.test(value)
        ? value as GamepadCode
        : GAMEPAD_DEFAULTS[action]];
    })) as unknown as GamepadBindings;
  } catch {
    return GAMEPAD_DEFAULTS;
  }
}

let gamepadCurrent = typeof window === "undefined" ? GAMEPAD_DEFAULTS : loadGamepad();

export function getInputBindings(): InputBindings { return current; }
export function getGamepadBindings(): GamepadBindings { return gamepadCurrent; }

export function actionForCode(code: string): InputAction | null {
  return REBINDABLE_ACTIONS.find((action) => current[action] === code) ?? null;
}

export function rebindAction(action: InputAction, code: string): { readonly ok: true } | { readonly ok: false; readonly conflict: InputAction } {
  const conflict = REBINDABLE_ACTIONS.find((candidate) => candidate !== action && current[candidate] === code);
  if (conflict !== undefined) return { ok: false, conflict };
  current = { ...current, [action]: code };
  persist();
  return { ok: true };
}

export function resolveBindingConflict(
  action: InputAction,
  code: string,
  resolution: BindingConflictResolution,
): boolean {
  const conflict = REBINDABLE_ACTIONS.find((candidate) => candidate !== action && current[candidate] === code);
  if (resolution === "cancel") return false;
  const previous = current[action];
  current = {
    ...current,
    [action]: code,
    ...(conflict === undefined ? {} : { [conflict]: resolution === "swap" ? previous : `Unbound:${conflict}` }),
  };
  persist();
  return true;
}

export function rebindGamepadAction(action: InputAction, code: GamepadCode):
  { readonly ok: true } | { readonly ok: false; readonly conflict: InputAction } {
  const conflict = REBINDABLE_ACTIONS.find(
    (candidate) => candidate !== action && gamepadCurrent[candidate] === code,
  );
  if (conflict !== undefined) return { ok: false, conflict };
  gamepadCurrent = { ...gamepadCurrent, [action]: code };
  persistGamepad();
  return { ok: true };
}

export function resolveGamepadBindingConflict(
  action: InputAction,
  code: GamepadCode,
  resolution: BindingConflictResolution,
): boolean {
  const conflict = REBINDABLE_ACTIONS.find(
    (candidate) => candidate !== action && gamepadCurrent[candidate] === code,
  );
  if (resolution === "cancel") return false;
  const previous = gamepadCurrent[action];
  gamepadCurrent = {
    ...gamepadCurrent,
    [action]: code,
    ...(conflict === undefined ? {} : { [conflict]: resolution === "swap" ? previous : null }),
  };
  persistGamepad();
  return true;
}

export function resetInputBindings(): void {
  current = { ...DEFAULTS };
  persist();
}

export function resetGamepadBindings(): void {
  gamepadCurrent = { ...GAMEPAD_DEFAULTS };
  persistGamepad();
}

export function subscribeInputBindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function persist(): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* optional */ }
  for (const listener of listeners) listener();
}

function persistGamepad(): void {
  try { window.localStorage.setItem(GAMEPAD_STORAGE_KEY, JSON.stringify(gamepadCurrent)); } catch { /* optional */ }
  for (const listener of listeners) listener();
}

export interface StandardGamepadState {
  readonly moveX: number; readonly moveY: number; readonly lookX: number; readonly lookY: number;
  readonly jump: boolean; readonly fire: boolean; readonly aim: boolean;
  readonly previousTool: boolean; readonly nextTool: boolean; readonly mirror: boolean;
  readonly toolAction: Extract<InputAction, "toolPose" | "toolShape" | "toolPanels" | "toolMaterial" | "toolPaint"> | null;
}

const DEAD_ZONE = 0.16;
function axis(value: number | undefined): number {
  const raw = value ?? 0;
  if (Math.abs(raw) < DEAD_ZONE) return 0;
  return Math.sign(raw) * (Math.abs(raw) - DEAD_ZONE) / (1 - DEAD_ZONE);
}


export function gamepadCodeValue(pad: Gamepad, code: GamepadCode | null): number {
  if (code === null) return 0;
  const button = /^Button(\d+)$/u.exec(code);
  if (button !== null) return pad.buttons[Number(button[1])]?.value ?? 0;
  const axisCode = /^Axis(\d+)([+-])$/u.exec(code);
  if (axisCode === null) return 0;
  const value = axis(pad.axes[Number(axisCode[1])]);
  return axisCode[2] === "+" ? Math.max(0, value) : Math.max(0, -value);
}

function gamepadActionValue(pad: Gamepad, action: InputAction): number {
  return gamepadCodeValue(pad, gamepadCurrent[action]);
}

export function readStandardGamepad(): StandardGamepadState | null {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return null;
  const pad = [...navigator.getGamepads()].find((candidate) => candidate?.connected);
  if (pad == null) return null;
  const toolAction = (["toolPose", "toolShape", "toolPanels", "toolMaterial", "toolPaint"] as const)
    .find((action) => gamepadActionValue(pad, action) > 0.45) ?? null;
  return {
    moveX: gamepadActionValue(pad, "moveRight") - gamepadActionValue(pad, "moveLeft"),
    moveY: gamepadActionValue(pad, "moveBack") - gamepadActionValue(pad, "moveForward"),
    lookX: axis(pad.axes[2]), lookY: axis(pad.axes[3]),
    jump: gamepadActionValue(pad, "jump") > 0.45, fire: (pad.buttons[7]?.value ?? 0) > 0.45,
    aim: (pad.buttons[6]?.value ?? 0) > 0.45, previousTool: pad.buttons[4]?.pressed ?? false,
    nextTool: pad.buttons[5]?.pressed ?? false, mirror: gamepadActionValue(pad, "mirror") > 0.45,
    toolAction,
  };
}

export function displayCode(code: string): string {
  if (code.startsWith("Unbound:")) return "Unbound";
  return code
    .replace(/^Key/, "")
    .replace(/^Digit/, "")
    .replace(/^Button/, "Button ")
    .replace(/^Axis(\d+)([+-])$/u, "Stick $1 $2");
}
