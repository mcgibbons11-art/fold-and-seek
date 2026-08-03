import { afterEach, describe, expect, it } from "vitest";

import {
  actionForCode,
  getGamepadBindings,
  getInputBindings,
  rebindAction,
  rebindGamepadAction,
  resetGamepadBindings,
  resetInputBindings,
  resolveBindingConflict,
  resolveGamepadBindingConflict,
} from "../../src/gameplay/inputBindings";

afterEach(() => { resetInputBindings(); resetGamepadBindings(); });

describe("player input bindings", () => {
  it("changes the action resolved from a physical key and persists one canonical map", () => {
    expect(actionForCode("KeyW")).toBe("moveForward");
    expect(rebindAction("moveForward", "KeyI")).toEqual({ ok: true });
    expect(actionForCode("KeyW")).toBeNull();
    expect(actionForCode("KeyI")).toBe("moveForward");
    expect(getInputBindings().moveForward).toBe("KeyI");
  });

  it("rejects conflicts instead of silently stealing another action", () => {
    expect(rebindAction("jump", "KeyW")).toEqual({ ok: false, conflict: "moveForward" });
    expect(getInputBindings().jump).toBe("Space");
    expect(getInputBindings().moveForward).toBe("KeyW");
  });

  it("restores every default in one step", () => {
    expect(rebindAction("mirror", "KeyG")).toEqual({ ok: true });
    resetInputBindings();
    expect(getInputBindings().mirror).toBe("KeyM");
  });

  it("resolves a keyboard conflict explicitly by swapping or replacing", () => {
    expect(resolveBindingConflict("jump", "KeyW", "swap")).toBe(true);
    expect(getInputBindings().jump).toBe("KeyW");
    expect(getInputBindings().moveForward).toBe("Space");

    expect(resolveBindingConflict("mirror", "KeyW", "replace")).toBe(true);
    expect(getInputBindings().mirror).toBe("KeyW");
    expect(getInputBindings().jump).toBe("Unbound:jump");
  });

  it("keeps controller bindings unique through swap, replace, and reset", () => {
    expect(rebindGamepadAction("jump", "Button3")).toEqual({ ok: false, conflict: "mirror" });
    expect(resolveGamepadBindingConflict("jump", "Button3", "swap")).toBe(true);
    expect(getGamepadBindings().jump).toBe("Button3");
    expect(getGamepadBindings().mirror).toBe("Button0");

    expect(resolveGamepadBindingConflict("toolPose", "Button3", "replace")).toBe(true);
    expect(getGamepadBindings().toolPose).toBe("Button3");
    expect(getGamepadBindings().jump).toBeNull();
    resetGamepadBindings();
    expect(getGamepadBindings().jump).toBe("Button0");
  });
});
