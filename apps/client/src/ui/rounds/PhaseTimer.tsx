import type { CSSProperties, ReactElement } from "react";

import type { PhaseTimerView } from "../../gameplay/roundView";
import { ALARM, BRASS, CREAM, EDGE, INK, formatClock, headlineStyle } from "./theme";

/**
 * Top-centre phase readout: the §41.1 headline for the phase, the countdown,
 * and a brass bar that drains with it. The final ten seconds recolour rather
 * than flash, since §5.13 forbids strobing and demands the room stay readable.
 */

export interface PhaseTimerProps {
  readonly timer: PhaseTimerView;
  /** §41.1 copy for the phase, or null for a phase the deck does not name. */
  readonly label: string | null;
  /** Secondary line, such as the round number or a role reminder. */
  readonly note?: string | null;
}

const containerStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  left: "50%",
  transform: "translateX(-50%)",
  minWidth: 260,
  textAlign: "center",
  background: INK,
  border: EDGE,
  borderRadius: 10,
  padding: "10px 22px 12px",
  backdropFilter: "blur(6px)",
  pointerEvents: "none",
};

const barTrackStyle: CSSProperties = {
  marginTop: 8,
  height: 3,
  borderRadius: 2,
  background: "rgba(232, 221, 205, 0.14)",
  overflow: "hidden",
};

export function PhaseTimer({ timer, label, note }: PhaseTimerProps): ReactElement {
  const accent = timer.finalTen ? ALARM : BRASS;
  const fraction =
    timer.totalMs > 0 ? Math.min(1, Math.max(0, timer.remainingMs / timer.totalMs)) : 0;

  return (
    <div style={containerStyle} role="status" aria-live="polite">
      {label === null ? null : (
        <h2 style={{ ...headlineStyle, color: accent, fontSize: timer.finalTen ? 22 : 18 }}>
          {label}
        </h2>
      )}
      {timer.running ? (
        <div
          style={{
            marginTop: label === null ? 0 : 4,
            font: "600 26px/1.1 system-ui, sans-serif",
            letterSpacing: "0.06em",
            color: CREAM,
          }}
        >
          {formatClock(timer.remainingMs)}
        </div>
      ) : null}
      {note === null || note === undefined ? null : (
        <div style={{ marginTop: 4, fontSize: 11, opacity: 0.65 }}>{note}</div>
      )}
      {timer.running && timer.totalMs > 0 ? (
        <div style={barTrackStyle}>
          <div
            style={{
              height: "100%",
              width: `${(fraction * 100).toFixed(2)}%`,
              background: accent,
              transition: "width 200ms linear",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
