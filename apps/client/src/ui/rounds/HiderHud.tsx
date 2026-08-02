import type { CSSProperties, ReactElement, ReactNode } from "react";

import { DECEPTION_TITLE, deceptionLabel, HIDER_CREEP_HINT } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { COLUMN_DENSITIES, type ColumnDensity } from "./columnFit";
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
  /** Geometry for the viewport this column is being drawn into. */
  readonly density?: ColumnDensity;
}

/**
 * The card takes its height from the density rather than from what its text
 * measures, and clips whatever outgrows it, which is the rule the rail's chips
 * and the regions themselves already follow. Without a declared height there is
 * no arithmetic for `hudLayout.test.ts` to check the column against.
 */
function cardStyle(density: ColumnDensity, scored: boolean): CSSProperties {
  return {
    background: INK,
    border: EDGE,
    borderRadius: 10,
    padding: density.cardPadding,
    height: scored ? density.statusScoredHeight : density.statusHeight,
    overflow: "hidden",
    backdropFilter: "blur(6px)",
    width: "100%",
    boxSizing: "border-box",
    pointerEvents: "none",
  };
}

export function HiderStatusCard({
  state,
  density = COLUMN_DENSITIES[0] as ColumnDensity,
}: HiderStatusCardProps): ReactElement {
  const level = state.self.watchedLevel;
  const caught = state.self.lifeState !== "active";
  const accent = level === 2 ? ALARM : BRASS;
  // Only ever this hider's own score: the director fills it in for the owner of
  // the disguise and for nobody else, which is what keeps it from being a hint.
  const deception = state.deception;
  const latest = deception.recent[0];
  const scored = deception.points > 0;
  const hintStyle: CSSProperties = density.wrapHint
    ? { marginTop: 4, opacity: 0.85 }
    : { marginTop: 4, opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

  return (
    <div style={cardStyle(density, scored)}>
      <div style={labelStyle}>{caught ? "Status" : "In the room"}</div>
      <div style={hintStyle}>{caught ? "OBJECT STATUS REVOKED" : HIDER_CREEP_HINT}</div>

      <div style={{ ...labelStyle, marginTop: density.headingGap }}>Being watched</div>
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

      {scored ? (
        <>
          <div style={{ ...labelStyle, marginTop: density.headingGap }}>{DECEPTION_TITLE}</div>
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
  readonly density?: ColumnDensity;
  /** The board and the hider's tool panels, stacked under the status card. */
  readonly children?: ReactNode;
}

/** The whole of a hider's left column, in the order it reads top to bottom. */
export function HiderHud({ state, density, children }: HiderHudProps): ReactElement {
  return (
    <>
      <HiderStatusCard state={state} density={density} />
      {children}
    </>
  );
}
