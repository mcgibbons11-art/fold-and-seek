// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installUiSounds } from "../../src/audio/uiSounds";

/**
 * The shell's click and hover. jsdom has no audio device, so what is watched is
 * which file each element asks for: `HTMLMediaElement.play` is stubbed and the
 * `src` of the element it was called on is the sound that would have been heard.
 *
 * The point of these is the delegation itself. Nothing in `src/ui` registers a
 * handler, so if the listener stops matching an element the interface goes
 * silent again with no other test noticing.
 */

const played: string[] = [];
let teardown: (() => void) | null = null;

function soundsPlayed(): string[] {
  return played.map((src) => src.replace(/^.*\/([^/]+)\.mp3$/, "$1"));
}

beforeEach(() => {
  played.length = 0;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    played.push(this.src);
    return Promise.resolve();
  });
  teardown = installUiSounds(document);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** jsdom does not implement PointerEvent, and the listener only reads `target`. */
function fire(element: Element, type: "pointerover" | "pointerdown"): void {
  element.dispatchEvent(new Event(type, { bubbles: true }));
}

describe("interface sounds", () => {
  it("clicks a button nobody wired", () => {
    document.body.innerHTML = "<button id='play'>Play a round</button>";
    const button = document.getElementById("play");
    expect(button).not.toBeNull();
    fire(button as Element, "pointerdown");
    expect(soundsPlayed()).toEqual(["ui_click"]);
  });

  it("ticks once on arriving at a control, not on every move across it", () => {
    document.body.innerHTML = "<button id='a'>A</button>";
    const button = document.getElementById("a") as Element;
    fire(button, "pointerover");
    fire(button, "pointerover");
    fire(button, "pointerover");
    expect(soundsPlayed()).toEqual(["ui_hover"]);
  });

  it("says nothing for a press that misses the interface", () => {
    // The canvas is under every panel and has sounds of its own; a press that
    // lands on the shop must not also click.
    document.body.innerHTML = "<canvas id='game-canvas'></canvas>";
    fire(document.getElementById("game-canvas") as Element, "pointerdown");
    expect(soundsPlayed()).toEqual([]);
  });

  it("ignores a control that is disabled", () => {
    document.body.innerHTML = "<button id='b' disabled>Start</button>";
    const button = document.getElementById("b") as Element;
    fire(button, "pointerover");
    fire(button, "pointerdown");
    expect(soundsPlayed()).toEqual([]);
  });

  it("hears a press on something inside a button", () => {
    document.body.innerHTML = "<button id='c'><span id='label'>Forge</span></button>";
    fire(document.getElementById("label") as Element, "pointerdown");
    expect(soundsPlayed()).toEqual(["ui_click"]);
  });

  it("lets an element name its own sound", () => {
    document.body.innerHTML = "<button id='d' data-sound='back'>Leave</button>";
    fire(document.getElementById("d") as Element, "pointerdown");
    expect(soundsPlayed()).toEqual(["ui_back"]);
  });

  it("lets an element opt out entirely", () => {
    document.body.innerHTML = "<button id='e' data-sound='none'>Silent</button>";
    const button = document.getElementById("e") as Element;
    fire(button, "pointerover");
    fire(button, "pointerdown");
    expect(soundsPlayed()).toEqual([]);
  });

  it("treats a role=button div as interface", () => {
    document.body.innerHTML = "<div id='f' role='button'>Tab</div>";
    fire(document.getElementById("f") as Element, "pointerdown");
    expect(soundsPlayed()).toEqual(["ui_click"]);
  });

  it("answers keyboard activation, which never emits a press", () => {
    document.body.innerHTML = "<button id='g'>Go</button>";
    const button = document.getElementById("g") as Element;
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(soundsPlayed()).toEqual(["ui_click"]);
  });

  it("goes quiet once uninstalled", () => {
    document.body.innerHTML = "<button id='h'>H</button>";
    teardown?.();
    teardown = null;
    fire(document.getElementById("h") as Element, "pointerdown");
    expect(soundsPlayed()).toEqual([]);
  });
});
