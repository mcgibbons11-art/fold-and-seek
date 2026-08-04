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
