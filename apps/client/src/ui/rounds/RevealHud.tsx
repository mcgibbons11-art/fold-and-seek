import type { CSSProperties, ReactElement } from "react";

import type { RevealEntryView, RoundViewState } from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import { BRASS_LIT, CREAM, RULE, labelStyle, overlayStyle, panelStyle } from "./theme";

/**
 * The reveal (§5.14). Names arrive only once geometry has started to unfold, so
 * a row stays anonymous until its disguise reports itself revealed, and the
 * survivors are listed apart from the ones already found.
 */

export interface RevealHudProps {
  readonly state: RoundViewState;
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 14,
  padding: "6px 0",
  borderTop: RULE,
};

function RevealRow({ entry }: { entry: RevealEntryView }): ReactElement {
  // A row stays anonymous until its disguise reports itself revealed (§5.14).
  const name = entry.revealed ? (entry.displayName ?? "Unknown") : "Unknown";
  return (
    <div style={rowStyle}>
      <span style={{ color: entry.caught ? CREAM : BRASS_LIT, opacity: entry.caught ? 0.7 : 1 }}>
        {name}
      </span>
      <span style={labelStyle}>
        {entry.survivalSeconds === null ? "survived" : `${entry.survivalSeconds.toFixed(1)}s`}
      </span>
    </div>
  );
}

export function RevealHud({ state }: RevealHudProps): ReactElement {
  const { survivors, caught } = state.reveal;

  return (
    <div style={overlayStyle}>
      <PhaseTimer timer={state.timer} label={state.phaseLabel} />

      <div style={{ ...panelStyle, bottom: 24, left: "50%", transform: "translateX(-50%)", width: 380, pointerEvents: "none" }}>
        <div style={labelStyle}>Still standing</div>
        {survivors.length === 0 ? (
          <div style={{ padding: "6px 0", opacity: 0.6 }}>None.</div>
        ) : (
          survivors.map((entry) => <RevealRow key={entry.publicObjectId} entry={entry} />)
        )}

        <div style={{ ...labelStyle, marginTop: 14 }}>Found</div>
        {caught.length === 0 ? (
          <div style={{ padding: "6px 0", opacity: 0.6 }}>None.</div>
        ) : (
          caught.map((entry) => <RevealRow key={entry.publicObjectId} entry={entry} />)
        )}
      </div>
    </div>
  );
}
