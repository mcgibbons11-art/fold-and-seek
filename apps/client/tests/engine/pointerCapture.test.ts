// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { tryReleasePointerCapture, trySetPointerCapture } from "../../src/engine/pointerCapture";

describe("safe pointer capture", () => {
  it("absorbs the InvalidStateError raised during a canvas ownership race", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const capture = vi.fn(() => {
      throw new DOMException("detached", "InvalidStateError");
    });
    Object.defineProperty(canvas, "setPointerCapture", { value: capture });

    expect(trySetPointerCapture(canvas, 7)).toBe(false);
    expect(capture).toHaveBeenCalledWith(7);
  });

  it("does not ask a disconnected canvas to capture or release", () => {
    const canvas = document.createElement("canvas");
    const capture = vi.fn();
    Object.defineProperty(canvas, "setPointerCapture", { value: capture });

    expect(trySetPointerCapture(canvas, 4)).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(() => tryReleasePointerCapture(canvas, 4)).not.toThrow();
  });
});
