import type { ReactElement, ReactNode } from "react";

import { DECEPTION_TITLE, deceptionLabel, HIDER_CREEP_HINT } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { ALARM, BRASS, EDGE, INK, labelStyle } from "./theme";

/**
 * What a disguised Mimic reads while the Inspectors hunt. The disguise is not a
 * cage: the hider can still creep and still bait, and movement is exactly what
 * gives them away, which is the tension the phase runs on.
 *
 * This is a card, not a screen. `RoundHud` puts it in the left column beside the
 * board and the hider's own tool panels; the taunt, the clock and the control
 * hints belong to the regions that own those parts of the screen, so none of it
 * is placed from here.
 */

/**
 * The three tension readings the simulation can report (§5.12). The wording is
 * the contract's own: level 1 is the Inspector's cone, level 2 is being held at
 * close range.
 */
const WATCHED_COPY = ["Unobserved", "In the cone", "Held at close range"] as const;

export interface HiderStatusCardProps {
  readonly state: RoundViewState;
}

const cardStyle = {
  background: INK,
  border: EDGE,
  borderRadius: 10,
  padding: "12px 14px",
  backdropFilter: "blur(6px)",
  width: "100%",
  boxSizing: "border-box" as const,
  pointerEvents: "none" as const,
};

export function HiderStatusCard({ state }: HiderStatusCardProps): ReactElement {
  const level = state.self.watchedLevel;
  const caught = state.self.lifeState !== "active";
  const accent = level === 2 ? ALARM : BRASS;
  // Only ever this hider's own score: the director fills it in for the owner of
  // the disguise and for nobody else, which is what keeps it from being a hint.
  const deception = state.deception;
  const latest = deception.recent[0];

  return (
    <div style={cardStyle}>
      <div style={labelStyle}>{caught ? "Status" : "In the room"}</div>
      <div style={{ marginTop: 4, opacity: 0.85 }}>
        {caught ? "OBJECT STATUS REVOKED" : HIDER_CREEP_HINT}
      </div>

      <div style={{ ...labelStyle, marginTop: 14 }}>Being watched</div>
      <div
        style={{ display: "flex", gap: 4, marginTop: 6 }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={2}
        aria-valuenow={level}
        aria-valuetext={WATCHED_COPY[level]}
      >
        {[1, 2].map((segment) => (
          <div
            key={segment}
            style={{
              flex: 1,
              height: 6,
              borderRadius: 3,
              background: level >= segment ? accent : "rgba(232, 221, 205, 0.14)",
              transition: "background 120ms linear",
            }}
          />
        ))}
      </div>
      <div style={{ ...labelStyle, marginTop: 4, color: level === 2 ? ALARM : undefined }}>
        {WATCHED_COPY[level]}
      </div>

      {deception.points > 0 ? (
        <>
          <div style={{ ...labelStyle, marginTop: 14 }}>{DECEPTION_TITLE}</div>
          <div style={{ font: "600 22px/1.2 system-ui, sans-serif", color: BRASS }}>
            {deception.points}
          </div>
          {latest === undefined ? null : (
            <div style={{ ...labelStyle, marginTop: 2, color: BRASS }}>
              {deceptionLabel(latest.kind)} +{latest.points}
            </div>
          )}
          <div style={{ ...labelStyle, marginTop: 4 }}>
            {deception.directLookEscapes} seen · {deception.closePasses} passed
          </div>
        </>
      ) : null}
    </div>
  );
}

export interface HiderHudProps {
  readonly state: RoundViewState;
  /** The board and the hider's tool panels, stacked under the status card. */
  readonly children?: ReactNode;
}

/** The whole of a hider's left column, in the order it reads top to bottom. */
export function HiderHud({ state, children }: HiderHudProps): ReactElement {
  return (
    <>
      <HiderStatusCard state={state} />
      {children}
    </>
  );
}
