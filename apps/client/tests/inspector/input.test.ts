// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMoveInput } from "../../src/inspector/InspectorController";
import { InspectorInput } from "../../src/inspector/InspectorInput";

describe("Inspector centred mouse-look input", () => {
  let input: InspectorInput | null = null;

  afterEach(() => {
    input?.dispose();
    input = null;
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      value: null,
    });
    document.body.replaceChildren();
  });

  it("moves the head and body only after the centred sight captures the pointer", () => {
    const canvas = document.createElement("canvas");
    const requestPointerLock = vi.fn();
    Object.assign(canvas, { requestPointerLock });
    document.body.append(canvas);
    const lockChanges: boolean[] = [];
    input = new InspectorInput(canvas, { onLockChange: (locked) => lockChanges.push(locked) });
    input.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    const beforeCapture = createMoveInput();
    input.sample(beforeCapture);
    expect(beforeCapture.forward).toBe(0);

    input.requestLock();
    expect(requestPointerLock).toHaveBeenCalledOnce();
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      value: canvas,
    });
    document.dispatchEvent(new Event("pointerlockchange"));

    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    const move = new MouseEvent("mousemove", { bubbles: true });
    Object.defineProperties(move, {
      movementX: { value: 12 },
      movementY: { value: -4 },
    });
    canvas.dispatchEvent(move);

    const sample = createMoveInput();
    input.sample(sample);
    expect(lockChanges).toEqual([true]);
    expect(sample.forward).toBe(1);
    expect(sample.lookYawDelta).not.toBe(0);
    expect(sample.lookPitchDelta).not.toBe(0);
  });
});
