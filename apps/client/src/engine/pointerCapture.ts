/**
 * Pointer capture can race a canvas ownership transition in an embedded
 * Portals pane. A detached element throws InvalidStateError, but the drag can
 * safely continue through its window listeners without capture.
 */
export function trySetPointerCapture(element: Element, pointerId: number): boolean {
  if (!element.isConnected || !("setPointerCapture" in element)) return false;
  try {
    (element as Element & { setPointerCapture(id: number): void }).setPointerCapture(pointerId);
    return true;
  } catch {
    return false;
  }
}

/** Releases capture if it still belongs to this live element. */
export function tryReleasePointerCapture(element: Element, pointerId: number): void {
  if (!("hasPointerCapture" in element) || !("releasePointerCapture" in element)) return;
  try {
    const target = element as Element & {
      hasPointerCapture(id: number): boolean;
      releasePointerCapture(id: number): void;
    };
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  } catch {
    // A detached canvas has already lost capture; there is nothing to release.
  }
}
