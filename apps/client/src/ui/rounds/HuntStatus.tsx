import type { CSSProperties, ReactElement } from "react";

import { huntStatusLabel } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { ALARM, BRASS, CREAM, EDGE, INK, headlineStyle } from "./theme";

/**
 * The hunt's top-centre row, ported from the original: a rank of hider figures
 * with the caught ones struck through, an hourglass carrying the seconds left,
 * a rank of seeker figures, and the phase named underneath.
 *
 * It says nothing about *which* hider is gone. The row draws one figure per
 * disguise in the room and strikes as many as the round has lost, which is a
 * count and not an attribution, so a caught object cannot be picked out of it.
 */

export interface HuntStatusProps {
  readonly state: RoundViewState;
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
};

const figureRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 3 };

/**
 * One player figure: a head over a body with two arms, the shape the original
 * uses, struck through with a diagonal once that player is out.
 */
function Figure({ color, struck }: { readonly color: string; readonly struck: boolean }): ReactElement {
  return (
    <svg width={13} height={26} viewBox="0 0 13 26" aria-hidden focusable="false">
      <circle cx="6.5" cy="4" r="3.4" fill={color} />
      <rect x="5.3" y="8.4" width="2.4" height="16" rx="1.2" fill={color} />
      <rect x="0.6" y="11.4" width="11.8" height="2.2" rx="1.1" fill={color} />
      {struck ? <path d="M0.5 22 L12.5 4" stroke={color} strokeWidth="1.6" opacity="0.95" /> : null}
    </svg>
  );
}

/** The original's hourglass, with the seconds printed in its lower bulb. */
function Hourglass({ accent, seconds }: { readonly accent: string; readonly seconds: number }): ReactElement {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <svg width={22} height={30} viewBox="0 0 22 30" aria-hidden focusable="false">
        <rect x="3" y="1" width="16" height="2.2" rx="1.1" fill={CREAM} />
        <rect x="3" y="26.8" width="16" height="2.2" rx="1.1" fill={CREAM} />
        <path
          d="M5 3.2 L17 3.2 L12 15 L17 26.8 L5 26.8 L10 15 Z"
          fill="none"
          stroke={CREAM}
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M6.6 25.4 L15.4 25.4 L11 17.6 Z" fill={accent} />
      </svg>
      <span
        style={{
          marginLeft: 3,
          font: "600 13px/1 system-ui, sans-serif",
          color: accent,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {seconds}
      </span>
    </div>
  );
}

export function HuntStatus({ state }: HuntStatusProps): ReactElement {
  const accent = state.timer.finalTen ? ALARM : BRASS;

  // Disguises are the census of hiders this round: one object per Mimic,
  // published from the moment the Forge closes. Before that there is nothing to
  // count but the live figure the authority reports.
  const hiderTotal = Math.max(state.reveal.entries.length, state.mimicsRemaining);
  const hidersLeft = Math.min(state.mimicsRemaining, hiderTotal);
  const seekerTotal = state.roster.filter(
    (player) => player.rolePublicState === "inspector",
  ).length;
  const seekersLeft = state.roster.filter(
    (player) => player.rolePublicState === "inspector" && player.lifeState === "active",
  ).length;

  return (
    <div
      style={{
        background: INK,
        border: EDGE,
        borderRadius: 10,
        padding: "8px 20px 10px",
        backdropFilter: "blur(6px)",
        textAlign: "center",
      }}
      role="status"
      aria-live="polite"
      aria-label={`${hidersLeft} of ${hiderTotal} hiding, ${state.timer.secondsRemaining} seconds left`}
    >
      <div style={rowStyle}>
        <div style={figureRowStyle}>
          {Array.from({ length: hiderTotal }, (_, index) => (
            <Figure key={index} color={CREAM} struck={index >= hidersLeft} />
          ))}
        </div>
        <Hourglass accent={accent} seconds={state.timer.secondsRemaining} />
        <div style={figureRowStyle}>
          {Array.from({ length: seekerTotal }, (_, index) => (
            <Figure key={index} color={ALARM} struck={index >= seekersLeft} />
          ))}
        </div>
      </div>
      <h2 style={{ ...headlineStyle, fontSize: 13, marginTop: 4, color: accent }}>
        {huntStatusLabel(state.phase)}
      </h2>
    </div>
  );
}
