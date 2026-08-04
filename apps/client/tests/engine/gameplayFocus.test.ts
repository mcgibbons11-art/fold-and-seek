// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { focusGameplayCanvas, settleGameplayCanvasFocus } from "../../src/engine/gameplayFocus";

describe("gameplay keyboard focus", () => {
  it("takes focus back from a stale lobby button", () => {
    const button = document.createElement("button");
    const canvas = document.createElement("canvas");
    document.body.append(button, canvas);
    button.focus();

    expect(focusGameplayCanvas(canvas)).toBe(true);
    expect(document.activeElement).toBe(canvas);
    expect(canvas.tabIndex).toBe(-1);
  });

  it("does not interrupt an input the player is editing", () => {
    const input = document.createElement("input");
    const canvas = document.createElement("canvas");
    document.body.append(input, canvas);
    input.focus();

    expect(focusGameplayCanvas(canvas)).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("reclaims focus after stale round UI finishes rendering", () => {
    const callbacks: FrameRequestCallback[] = [];
    const originalRequest = window.requestAnimationFrame;
    const originalCancel = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => undefined) as typeof window.cancelAnimationFrame;

    const button = document.createElement("button");
    const canvas = document.createElement("canvas");
    document.body.append(button, canvas);
    settleGameplayCanvasFocus(canvas);
    button.focus();
    callbacks.shift()?.(0);

    expect(document.activeElement).toBe(canvas);
    window.requestAnimationFrame = originalRequest;
    window.cancelAnimationFrame = originalCancel;
  });

  it("forces a stale lobby input to yield when a playable phase mounts", () => {
    const input = document.createElement("input");
    const canvas = document.createElement("canvas");
    document.body.append(input, canvas);
    input.focus();

    settleGameplayCanvasFocus(canvas);

    expect(document.activeElement).toBe(canvas);
  });
});
