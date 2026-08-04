/** True while a HUD control intentionally owns keyboard input. */
function isEditingControl(element: Element | null): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

/**
 * Returns keyboard ownership to the game after a lobby/phase transition.
 * Portals embeds the game in an iframe, so leaving focus on the Ready/Start
 * button can make the first WASD press belong to stale lobby chrome. Inputs are
 * respected because a phase tick must not interrupt a colour or slider edit.
 */
export function focusGameplayCanvas(canvas: HTMLCanvasElement): boolean {
  if (!canvas.isConnected || isEditingControl(canvas.ownerDocument.activeElement)) return false;
  canvas.tabIndex = -1;
  try {
    canvas.focus({ preventScroll: true });
  } catch {
    return false;
  }
  return canvas.ownerDocument.activeElement === canvas;
}

/**
 * React removes the lobby/results controls after the phase callback runs. A
 * focused button can therefore reclaim focus later in that same render. Keep
 * the hand-off alive for two paint frames so a rematch always starts with WASD
 * owned by the canvas. The returned function invalidates any pending frame.
 */
export function settleGameplayCanvasFocus(
  canvas: HTMLCanvasElement,
  stillGameplay: () => boolean = () => true,
): () => void {
  let cancelled = false;
  // A few headless engine fixtures use a structural canvas stub with no DOM.
  // Focus restoration is a browser concern, so those fixtures are a no-op.
  const ownerDocument = canvas.ownerDocument;
  if (ownerDocument === undefined || ownerDocument === null) return () => undefined;
  const view = ownerDocument.defaultView;
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;

  const refocus = (): void => {
    if (!cancelled && stillGameplay()) focusGameplayCanvas(canvas);
  };

  refocus();
  if (view !== null && typeof view.requestAnimationFrame === "function") {
    firstFrame = view.requestAnimationFrame(() => {
      refocus();
      secondFrame = view.requestAnimationFrame(refocus);
    });
  }

  return () => {
    cancelled = true;
    if (view === null || typeof view.cancelAnimationFrame !== "function") return;
    if (firstFrame !== null) view.cancelAnimationFrame(firstFrame);
    if (secondFrame !== null) view.cancelAnimationFrame(secondFrame);
  };
}
