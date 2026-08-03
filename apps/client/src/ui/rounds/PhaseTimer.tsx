import type { CSSProperties, ReactElement } from "react";

import type { PhaseTimerView } from "../../gameplay/roundView";
import { AtomicLiveRegion, useCountdownMilestones } from "../accessibility";
import {
  ALARM,
  BRASS,
  BRASS_LIT,
  CREAM,
  FONT_NUMERIC,
  formatClock,
  headlineStyle,
  plate,
} from "./theme";

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
  // Bounded so a standing goal line under the clock wraps to a second line
  // rather than stretching the pill across the top of the shop.
  maxWidth: 420,
  textAlign: "center",
  ...plate(),
  borderRadius: 10,
  padding: "10px 22px 12px",
  pointerEvents: "none",
};

const barTrackStyle: CSSProperties = {
  marginTop: 9,
  height: 4,
  borderRadius: 2,
  background: "rgba(8, 6, 4, 0.7)",
  boxShadow: "inset 0 1px 3px rgba(0, 0, 0, 0.6)",
  overflow: "hidden",
};

export function PhaseTimer({ timer, label, note }: PhaseTimerProps): ReactElement {
  const accent = timer.finalTen ? ALARM : BRASS;
  const spokenLabel = label ?? "Round timer";
  const announcement = useCountdownMilestones(spokenLabel, timer.remainingMs, timer.running);
  const fraction =
    timer.totalMs > 0 ? Math.min(1, Math.max(0, timer.remainingMs / timer.totalMs)) : 0;

  return (
    <div style={containerStyle} aria-label={spokenLabel}>
      <AtomicLiveRegion message={announcement} />
      {label === null ? null : (
        <h2 style={{ ...headlineStyle, color: accent, fontSize: timer.finalTen ? 22 : 18 }}>
          {label}
        </h2>
      )}
      {timer.running ? (
        <div
          style={{
            marginTop: label === null ? 0 : 5,
            font: `600 28px/1.1 ${FONT_NUMERIC}`,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "0.08em",
            color: timer.finalTen ? ALARM : CREAM,
            textShadow: timer.finalTen
              ? "0 0 18px rgba(200, 80, 60, 0.5)"
              : "0 0 16px rgba(255, 190, 107, 0.18)",
          }}
        >
          {formatClock(timer.remainingMs)}
        </div>
      ) : null}
      {note === null || note === undefined ? null : (
        <div style={{ marginTop: 5, fontSize: 11, opacity: 0.65 }}>{note}</div>
      )}
      {timer.running && timer.totalMs > 0 ? (
        <div style={barTrackStyle}>
          <div
            style={{
              height: "100%",
              width: `${(fraction * 100).toFixed(2)}%`,
              background: timer.finalTen
                ? ALARM
                : `linear-gradient(90deg, ${BRASS} 0%, ${BRASS_LIT} 100%)`,
              boxShadow: `0 0 10px ${timer.finalTen ? "rgba(200, 80, 60, 0.6)" : "rgba(255, 190, 107, 0.45)"}`,
              transition: "width 200ms linear",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
