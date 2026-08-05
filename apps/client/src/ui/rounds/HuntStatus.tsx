import type { CSSProperties, ReactElement } from "react";

import { huntStatusLabel } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { AtomicLiveRegion, useCountdownMilestones } from "../accessibility";
import { ALARM, BRASS, CREAM, FONT_NUMERIC, formatClock, headlineStyle, labelStyle, plate } from "./theme";

/**
 * The hunt's top-centre row: how many hiders are still unaccounted for, how long
 * is left to find them, and the phase named underneath.
 *
 * It was previously a rank of small figures either side of an hourglass, ported
 * from the original. At the sizes the row actually draws at — 13x26 px per
 * figure — the round-1 critic read the result as "†††⧗42†", which is a fair
 * description of what those glyphs look like when they are too small to resolve
 * into people. So the count is written out, and the clock is the whole of the
 * middle rather than a picture with a number beside it.
 *
 * What it must not say is *which* hider is gone: this is a count and never an
 * attribution, so a caught object cannot be picked out of it.
 */

export interface HuntStatusProps {
  readonly state: RoundViewState;
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
};

/** A clock face, large enough at 20 px to read as one. */
function ClockFace({ accent }: { readonly accent: string }): ReactElement {
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" aria-hidden focusable="false">
      <circle cx="10" cy="10" r="8.4" fill="none" stroke={accent} strokeWidth="1.5" />
      <path d="M10 5.2 L10 10.4 L13.4 12.4" fill="none" stroke={accent} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function HuntStatus({ state }: HuntStatusProps): ReactElement {
  const accent = state.timer.finalTen ? ALARM : BRASS;

  // Disguises are the census of hiders this round: one object per Mimic,
  // published from the moment the Forge closes. Before that there is nothing to
  // count but the live figure the authority reports.
  const hiderTotal = Math.max(state.reveal.entries.length, state.mimicsRemaining);
  const hidersLeft = Math.min(state.mimicsRemaining, hiderTotal);
  const found = hiderTotal - hidersLeft;
  const countdownAnnouncement = useCountdownMilestones(
    huntStatusLabel(state.phase),
    state.timer.remainingMs,
    state.timer.running,
  );

  return (
    <div
      data-persistent-plate="hunt-status"
      style={{
        ...plate(),
        borderRadius: 10,
        padding: "8px 22px 10px",
        textAlign: "center",
      }}
      aria-label={`${hidersLeft} still hidden, ${state.timer.secondsRemaining} seconds left`}
    >
      <AtomicLiveRegion
        message={`${String(hidersLeft)} ${hidersLeft === 1 ? "Mimic" : "Mimics"} still hidden`}
      />
      <AtomicLiveRegion message={countdownAnnouncement} />
      <div style={rowStyle}>
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              font: `600 15px/1.1 ${FONT_NUMERIC}`,
              letterSpacing: "0.06em",
              color: CREAM,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {hidersLeft} STILL HIDDEN
          </div>
          {found > 0 ? (
            <div style={{ ...labelStyle, marginTop: 1 }}>{found} found</div>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ClockFace accent={accent} />
          <span
            style={{
              font: `600 20px/1 ${FONT_NUMERIC}`,
              color: accent,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "0.04em",
              textShadow: `0 0 12px ${accent === ALARM ? "rgba(200, 80, 60, 0.5)" : "rgba(255, 190, 107, 0.4)"}`,
            }}
          >
            {formatClock(state.timer.remainingMs)}
          </span>
        </div>
      </div>
      <h2 style={{ ...headlineStyle, fontSize: 13, marginTop: 6, color: accent }}>
        {huntStatusLabel(state.phase)}
      </h2>
    </div>
  );
}
