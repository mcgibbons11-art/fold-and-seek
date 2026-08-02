import type { CSSProperties, ReactElement } from "react";

import { ALARM, BRASS, CREAM, FONT_DISPLAY, labelStyle, plate } from "./theme";

/**
 * The stamp stack. Accusation results and command refusals both land here, so
 * the room speaks in one voice and one place instead of three overlays fighting
 * for the same corner.
 */

export type ToastTone = "brass" | "cream" | "alarm";

export interface ToastEntry {
  readonly id: number;
  readonly title: string;
  readonly body?: string | null;
  readonly tone: ToastTone;
}

export interface ToastProps {
  readonly entries: readonly ToastEntry[];
  /** Extra styling for the stack. The region it sits in decides where it is. */
  readonly anchor?: CSSProperties;
}

const TONE_COLORS: Readonly<Record<ToastTone, string>> = {
  brass: BRASS,
  cream: CREAM,
  alarm: ALARM,
};

const stackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  alignItems: "flex-end",
  pointerEvents: "none",
  maxWidth: 280,
};

export function Toast({ entries, anchor }: ToastProps): ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <div style={{ ...stackStyle, ...anchor }} role="log" aria-live="polite">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="fs-rise"
          style={{
            ...plate(),
            // Longhands so the accent edge and the plate's own edge never
            // collide as a shorthand/longhand pair on a rerender.
            borderLeft: `3px solid ${TONE_COLORS[entry.tone]}`,
            borderRadius: 8,
            padding: "9px 13px",
            textAlign: "right",
          }}
        >
          <div
            style={{
              font: `600 14px/1.25 ${FONT_DISPLAY}`,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: TONE_COLORS[entry.tone],
            }}
          >
            {entry.title}
          </div>
          {entry.body === null || entry.body === undefined ? null : (
            <div style={{ ...labelStyle, marginTop: 2, letterSpacing: "0.04em" }}>{entry.body}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Rejections read the same everywhere, so their copy is built in one place. */
export function rejectionToast(id: number, commandType: string, reason: string): ToastEntry {
  return {
    id: -id,
    title: "REFUSED",
    body: `${commandType.replace(/_/g, " ")} · ${reason.replace(/_/g, " ")}`,
    tone: "alarm",
  };
}
