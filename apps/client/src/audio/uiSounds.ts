import { AudioPlayer, type SoundId } from "../forge/AudioPlayer";

/**
 * The interface's own voice.
 *
 * Every sound in the game was played from the engine — the Forge, the round,
 * the footstep driver — and the React shell above it made none at all, so the
 * menu, the loading screen, the HUD panels and the paint panel were silent to
 * the touch while the canvas underneath them clicked and whirred.
 *
 * This listens at the document instead of in the components. A button gains its
 * click by being a button, so the shell can be restyled or rebuilt without
 * carrying sound wiring through it, and nothing here has to be kept in step with
 * a component tree it does not import. An element that wants a different sound
 * says so with `data-sound`; everything else is inferred from what it is.
 */

/** What a `data-sound` attribute may ask for. */
const NAMED_SOUNDS: Readonly<Record<string, SoundId>> = {
  click: "ui_click",
  confirm: "ui_confirm",
  back: "ui_back",
  deny: "ui_deny",
  hover: "ui_hover",
  none: "ui_click",
};

/** Elements that are interface whatever they are made of. */
const INTERACTIVE = 'button, a[href], select, summary, [role="button"], [role="tab"], [data-sound]';

/**
 * Hover is per element rather than per event: a pointer crossing a button emits
 * a stream of them, and one tick belongs to arriving rather than to moving.
 * A rapid sweep across a row of buttons is still throttled on top of that.
 */
const HOVER_THROTTLE_MS = 90;

/** Interface sits under the room rather than over it. */
const UI_VOLUME = 0.5;

function soundFor(element: Element, event: "hover" | "press"): SoundId | null {
  const named = element.getAttribute("data-sound");
  if (named === "none") return null;
  if (event === "hover") return "ui_hover";
  if (named !== null) return NAMED_SOUNDS[named] ?? "ui_click";
  // A link or a form submission is the player committing to something; a plain
  // button is an adjustment. The confirm is the more emphatic of the two and is
  // what the Forge already uses for applying a material.
  //
  // `type` is not the test for a submission. A `<button>` with no type
  // attribute reports "submit" whether or not it is in a form, so reading the
  // property alone makes every unadorned button in the shell emphatic — which
  // is every button the menu has.
  if (element instanceof HTMLAnchorElement) return "ui_confirm";
  if (element instanceof HTMLButtonElement && element.form !== null && element.type === "submit") {
    return "ui_confirm";
  }
  return "ui_click";
}

function isDisabled(element: Element): boolean {
  if (element.getAttribute("aria-disabled") === "true") return true;
  return (
    (element instanceof HTMLButtonElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLInputElement) &&
    element.disabled
  );
}

/**
 * Starts playing the interface. Returns the teardown, so a caller that mounts
 * this in an effect can hand it straight back.
 */
export function installUiSounds(target: Document = document): () => void {
  const audio = new AudioPlayer(undefined, UI_VOLUME);
  let hovered: Element | null = null;
  let lastHoverMs = 0;

  const interactiveUnder = (event: Event): Element | null => {
    const node = event.target;
    if (!(node instanceof Element)) return null;
    const element = node.closest(INTERACTIVE);
    if (element === null || isDisabled(element)) return null;
    return element;
  };

  const onPointerOver = (event: Event): void => {
    const element = interactiveUnder(event);
    if (element === null) {
      hovered = null;
      return;
    }
    if (element === hovered) return;
    hovered = element;
    const now = performance.now();
    if (now - lastHoverMs < HOVER_THROTTLE_MS) return;
    lastHoverMs = now;
    const sound = soundFor(element, "hover");
    if (sound !== null) audio.play(sound);
  };

  const onPointerDown = (event: Event): void => {
    // A press that never reaches an interactive element is the player grabbing
    // the shop behind the interface, which has its own sounds and must not
    // gain a click from passing under a panel.
    const element = interactiveUnder(event);
    if (element === null) return;
    const sound = soundFor(element, "press");
    if (sound !== null) audio.play(sound);
  };

  // Keyboard activation reaches `click` without ever emitting a press, so a
  // player driving the menu on Enter or Space hears the same thing as a mouse.
  const onKeyActivate = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.repeat) return;
    const element = interactiveUnder(event);
    if (element === null) return;
    const sound = soundFor(element, "press");
    if (sound !== null) audio.play(sound);
  };

  target.addEventListener("pointerover", onPointerOver, true);
  target.addEventListener("pointerdown", onPointerDown, true);
  target.addEventListener("keydown", onKeyActivate as EventListener, true);

  return () => {
    target.removeEventListener("pointerover", onPointerOver, true);
    target.removeEventListener("pointerdown", onPointerDown, true);
    target.removeEventListener("keydown", onKeyActivate as EventListener, true);
    audio.dispose();
  };
}
