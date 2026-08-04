// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMoveInput } from "../../src/inspector/InspectorController";
import { InspectorInput } from "../../src/inspector/InspectorInput";

describe("Inspector free-pointer input", () => {
  let input: InspectorInput | null = null;

  afterEach(() => {
    input?.dispose();
    input = null;
    document.body.replaceChildren();
  });

  it("moves and aims without ever requesting browser pointer lock", () => {
    const canvas = document.createElement("canvas");
    const requestPointerLock = vi.fn();
    Object.assign(canvas, { requestPointerLock });
    document.body.append(canvas);
    input = new InspectorInput(canvas);
    input.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    const move = new MouseEvent("mousemove", { bubbles: true });
    Object.defineProperties(move, {
      movementX: { value: 12 },
      movementY: { value: -4 },
    });
    canvas.dispatchEvent(move);

    const sample = createMoveInput();
    input.sample(sample);
    expect(requestPointerLock).not.toHaveBeenCalled();
    expect(sample.forward).toBe(1);
    expect(sample.lookYawDelta).not.toBe(0);
    expect(sample.lookPitchDelta).not.toBe(0);
  });
});
