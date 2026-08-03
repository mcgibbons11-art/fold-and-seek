import { afterEach, describe, expect, it } from "vitest";

import {
  actionForCode,
  getInputBindings,
  rebindAction,
  resetInputBindings,
} from "../../src/gameplay/inputBindings";

afterEach(() => resetInputBindings());

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
});
