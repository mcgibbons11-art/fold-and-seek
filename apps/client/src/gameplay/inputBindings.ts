export const REBINDABLE_ACTIONS = [
  "moveForward", "moveBack", "moveLeft", "moveRight", "jump",
  "toolPose", "toolShape", "toolPanels", "toolMaterial", "toolPaint",
  "mirror", "eyedropper", "taunt",
] as const;

export type InputAction = (typeof REBINDABLE_ACTIONS)[number];
export type InputBindings = Readonly<Record<InputAction, string>>;

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

const STORAGE_KEY = "foldseek.bindings.v1";
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

export function getInputBindings(): InputBindings { return current; }

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

export function resetInputBindings(): void {
  current = { ...DEFAULTS };
  persist();
}

export function subscribeInputBindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function persist(): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* optional */ }
  for (const listener of listeners) listener();
}

export interface StandardGamepadState {
  readonly moveX: number; readonly moveY: number; readonly lookX: number; readonly lookY: number;
  readonly jump: boolean; readonly fire: boolean; readonly aim: boolean;
  readonly previousTool: boolean; readonly nextTool: boolean; readonly mirror: boolean;
}

const DEAD_ZONE = 0.16;
function axis(value: number | undefined): number {
  const raw = value ?? 0;
  if (Math.abs(raw) < DEAD_ZONE) return 0;
  return Math.sign(raw) * (Math.abs(raw) - DEAD_ZONE) / (1 - DEAD_ZONE);
}

export function readStandardGamepad(): StandardGamepadState | null {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return null;
  const pad = [...navigator.getGamepads()].find((candidate) => candidate?.connected);
  if (pad == null) return null;
  return {
    moveX: axis(pad.axes[0]), moveY: axis(pad.axes[1]), lookX: axis(pad.axes[2]), lookY: axis(pad.axes[3]),
    jump: pad.buttons[0]?.pressed ?? false, fire: (pad.buttons[7]?.value ?? 0) > 0.45,
    aim: (pad.buttons[6]?.value ?? 0) > 0.45, previousTool: pad.buttons[14]?.pressed ?? false,
    nextTool: pad.buttons[15]?.pressed ?? false, mirror: pad.buttons[3]?.pressed ?? false,
  };
}

export function displayCode(code: string): string {
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace("Space", "Space");
}
