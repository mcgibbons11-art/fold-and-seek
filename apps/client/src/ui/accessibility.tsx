import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from "react";

const ENTRY_FOCUS_SELECTOR =
  '[data-entry-focus="true"], button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Moves focus once when a screen is entered, never when its live data rerenders.
 * An explicit `data-entry-focus="true"` wins; otherwise the first operable
 * control is used. The key lets a persistent router component mark a new page.
 */
export function useScreenEntryFocus<T extends HTMLElement>(entryKey: unknown): RefObject<T | null> {
  const root = useRef<T | null>(null);

  useLayoutEffect(() => {
    const container = root.current;
    if (container === null) return;
    const target = container.matches(ENTRY_FOCUS_SELECTOR)
      ? container
      : container.querySelector<HTMLElement>(ENTRY_FOCUS_SELECTOR);
    target?.focus({ preventScroll: true });
  }, [entryKey]);

  return root;
}

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function AtomicLiveRegion({
  message,
  assertive = false,
}: {
  readonly message: string;
  readonly assertive?: boolean;
}): ReactElement {
  return (
    <span
      role="status"
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
      style={visuallyHidden}
    >
      {message}
    </span>
  );
}

const COUNTDOWN_MILESTONES = [60, 30, 10, 5, 4, 3, 2, 1, 0] as const;

function countdownCopy(label: string, seconds: number): string {
  if (seconds === 0) return `${label}: time expired`;
  if (seconds === 60) return `${label}: one minute remaining`;
  return `${label}: ${String(seconds)} seconds remaining`;
}

/** Announces phase entry and only meaningful countdown crossings after it. */
export function useCountdownMilestones(
  label: string,
  remainingMs: number,
  running: boolean,
): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const previous = useRef<number | null>(null);
  const previousLabel = useRef(label);
  const [announcement, setAnnouncement] = useState(label);

  useEffect(() => {
    if (previousLabel.current !== label) {
      previousLabel.current = label;
      previous.current = seconds;
      setAnnouncement(label);
      return;
    }
    const before = previous.current;
    previous.current = seconds;
    if (!running || before === null || seconds >= before) return;
    const crossed = COUNTDOWN_MILESTONES.filter(
      (milestone) => before > milestone && seconds <= milestone,
    ).at(-1);
    if (crossed !== undefined) setAnnouncement(countdownCopy(label, crossed));
  }, [label, running, seconds]);

  return announcement;
}

/** Announces loading entry, then quarter marks; intermediate percent updates stay visual. */
export function useProgressMilestones(label: string, fraction: number): string {
  const bounded = Math.min(1, Math.max(0, fraction));
  const milestone = Math.floor(bounded * 4) * 25;
  const previousMilestone = useRef(0);
  const previousLabel = useRef(label);
  const [announcement, setAnnouncement] = useState(label);

  useEffect(() => {
    if (previousLabel.current !== label) {
      previousLabel.current = label;
      previousMilestone.current = milestone;
      setAnnouncement(label);
      return;
    }
    if (milestone <= previousMilestone.current) return;
    previousMilestone.current = milestone;
    setAnnouncement(`${label}: ${String(milestone)} percent`);
  }, [label, milestone]);

  return announcement;
}
