// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LoadingScreen } from "../../src/ui/LoadingScreen";

/**
 * The screen a player looks at while the shop is built. It exists because
 * clicking "Play a round" used to stop the tab with nothing on screen, so the
 * one thing it must not do is show a number that is not the real progress.
 */

declare global {
  // eslint-disable-next-line no-var
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
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(label: string, fraction: number): string {
  act(() => {
    root.render(<LoadingScreen progress={{ label, fraction }} />);
  });
  return container.textContent ?? "";
}

/** The filled part of the bar, as the percentage the style actually carries. */
function barWidth(): string {
  const filled = container.querySelector('[role="progressbar"] > div');
  return filled instanceof HTMLElement ? filled.style.width : "";
}

/** The same figure as the bar reports to a screen reader. */
function announcedPercent(): string | null {
  return container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") ?? null;
}

describe("LoadingScreen", () => {
  it("names the piece that was just built and shows its share of the whole", () => {
    const text = render("the clock wall", 0.25);

    expect(text).toContain("the clock wall");
    expect(text).toContain("25%");
    expect(barWidth()).toBe("25%");
    expect(announcedPercent()).toBe("25");
  });

  it("moves as the build reports, so the bar is the build and not an animation", () => {
    render("the walls and the floor", 0.1);
    expect(barWidth()).toBe("10%");

    render("the counter", 0.6);
    expect(barWidth()).toBe("60%");

    render("the shop", 1);
    expect(barWidth()).toBe("100%");
  });

  it("never draws past either end of its track", () => {
    render("the shop", 1.4);
    expect(barWidth()).toBe("100%");

    render("the shop", -0.2);
    expect(barWidth()).toBe("0%");
  });

  it("announces itself, since the room behind it is not what to read", () => {
    render("the lights", 0.8);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-live")).toBe("polite");
  });
});
