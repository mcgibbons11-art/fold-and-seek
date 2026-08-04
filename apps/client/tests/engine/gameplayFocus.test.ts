// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { focusGameplayCanvas } from "../../src/engine/gameplayFocus";

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
});
