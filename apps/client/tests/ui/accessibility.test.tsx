// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AtomicLiveRegion,
  useCountdownMilestones,
  useProgressMilestones,
  useScreenEntryFocus,
} from "../../src/ui/accessibility";

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
});

function FocusHarness({ screen, value }: { readonly screen: string; readonly value: number }): ReactElement {
  const entryRef = useScreenEntryFocus<HTMLDivElement>(screen);
  return (
    <div ref={entryRef}>
      <button type="button" data-entry-focus="true">Primary {screen}</button>
      <button type="button">Secondary {String(value)}</button>
    </div>
  );
}

function CountdownHarness({ remainingMs }: { readonly remainingMs: number }): ReactElement {
  const message = useCountdownMilestones("Forge", remainingMs, true);
  return <AtomicLiveRegion message={message} />;
}

function ProgressHarness({ fraction }: { readonly fraction: number }): ReactElement {
  const message = useProgressMilestones("Opening the shop", fraction);
  return <AtomicLiveRegion message={message} />;
}

function liveText(): string {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

describe("screen entry focus", () => {
  it("focuses on entry, ignores live rerenders, and resets for a new screen key", () => {
    act(() => root.render(<FocusHarness screen="alpha" value={1} />));
    expect(document.activeElement?.textContent).toBe("Primary alpha");
    const secondary = [...container.querySelectorAll("button")][1];
    if (!(secondary instanceof HTMLButtonElement)) throw new Error("secondary button missing");
    secondary.focus();

    act(() => root.render(<FocusHarness screen="alpha" value={2} />));
    expect(document.activeElement).toBe(secondary);
    act(() => root.render(<FocusHarness screen="bravo" value={2} />));
    expect(document.activeElement?.textContent).toBe("Primary bravo");
  });
});

describe("atomic milestone announcements", () => {
  it("announces countdown crossings without changing on ordinary seconds", () => {
    act(() => root.render(<CountdownHarness remainingMs={65_000} />));
    expect(liveText()).toBe("Forge");
    act(() => root.render(<CountdownHarness remainingMs={59_000} />));
    expect(liveText()).toBe("Forge: one minute remaining");
    act(() => root.render(<CountdownHarness remainingMs={58_000} />));
    expect(liveText()).toBe("Forge: one minute remaining");
    act(() => root.render(<CountdownHarness remainingMs={29_000} />));
    expect(liveText()).toBe("Forge: 30 seconds remaining");
  });

  it("announces progress only at quarter milestones and is atomic", () => {
    act(() => root.render(<ProgressHarness fraction={0.02} />));
    expect(liveText()).toBe("Opening the shop");
    act(() => root.render(<ProgressHarness fraction={0.24} />));
    expect(liveText()).toBe("Opening the shop");
    act(() => root.render(<ProgressHarness fraction={0.26} />));
    expect(liveText()).toBe("Opening the shop: 25 percent");
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-atomic")).toBe("true");
  });
});
