// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameMenu, REQUEST_LEAVE_MATCH_EVENT } from "../../src/ui/GameMenu";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderMenu(onLeave: () => void | Promise<void> = () => undefined): void {
  act(() => {
    root.render(
      <GameMenu
        qualityTier="high"
        onQualityTierChange={() => undefined}
        onLeave={onLeave}
        role="mimic"
      />,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (match === undefined) throw new Error(`missing button: ${label}`);
  return match;
}

function press(key: string, options: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options }));
  });
}

describe("GameMenu accessibility and leave flow", () => {
  it("autofocuses, traps focus, closes by keyboard, and restores the opener", () => {
    renderMenu();
    const opener = button("Menu");
    opener.focus();
    act(() => opener.click());

    expect(document.activeElement?.textContent).toBe("Resume");
    press("Tab", { shiftKey: true });
    expect(document.activeElement?.textContent).toBe("Leave match and return to menu");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    press("Tab");
    expect(document.activeElement?.textContent).toBe("Resume");
    outside.remove();
    press("Escape");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("requires confirmation and calls leave exactly once while returning", () => {
    const onLeave = vi.fn(() => new Promise<void>(() => undefined));
    renderMenu(onLeave);
    act(() => window.dispatchEvent(new Event(REQUEST_LEAVE_MATCH_EVENT)));

    expect(document.activeElement?.textContent).toBe("Stay in match");
    const confirm = button("Leave match");
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(button("Returning to menuâ€¦").disabled).toBe(true);
    press("Escape");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("supports arrow and native gamepad navigation plus controller back", () => {
    vi.useFakeTimers();
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
    const pad = { connected: true, buttons, axes: [0, 0] } as unknown as Gamepad;
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [pad],
    });
    renderMenu();
    act(() => button("Menu").click());

    press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Settings");

    buttons[13] = { pressed: true };
    act(() => vi.advanceTimersByTime(60));
    expect(document.activeElement?.textContent).toBe("How to play");
    buttons[13] = { pressed: false };
    act(() => vi.advanceTimersByTime(60));
    buttons[1] = { pressed: true };
    act(() => vi.advanceTimersByTime(60));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
