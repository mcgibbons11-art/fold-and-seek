import type { CSSProperties, ReactElement } from "react";

import {
  MISSED_FINDS_AWAITING,
  MISSED_FINDS_TITLE,
  MISSED_FINDS_TOGGLE_HINT,
  missedFindsCountdown,
} from "../../gameplay/copy";
import type { MissedFindsRowView, RoundViewState } from "../../gameplay/roundView";
import { BRASS, CREAM, EDGE, INK, labelStyle } from "./theme";

/**
 * The missed-finds board, the original's Missed-Spot Ranking on key 6. Both
 * roles read it: an Inspector learns which hider is quietly earning points off
 * them, a hider learns where they stand, and that shared visibility is what
 * makes being seen worth playing for.
 *
 * It ranks players, never disguises. Which object somebody is stays secret
 * until the reveal, so a row carries a name and a number and nothing else.
 */

export interface MissedFindsHudProps {
  readonly state: RoundViewState;
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  padding: "5px 0",
  borderTop: EDGE,
};

function MissedFindsRow({ row }: { row: MissedFindsRowView }): ReactElement {
  return (
    <div style={rowStyle}>
      <span style={{ ...labelStyle, width: 18, opacity: 0.5 }}>{row.rank}</span>
      <span
        style={{
          flex: 1,
          color: row.isSelf ? BRASS : CREAM,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.displayName}
      </span>
      <span style={{ font: "600 15px/1.2 system-ui, sans-serif", color: BRASS }}>{row.points}</span>
    </div>
  );
}

export function MissedFindsHud({ state }: MissedFindsHudProps): ReactElement {
  const board = state.missedFinds;

  return (
    <div
      style={{
        background: INK,
        border: EDGE,
        borderRadius: 10,
        padding: "12px 14px",
        backdropFilter: "blur(6px)",
        width: "100%",
        boxSizing: "border-box",
        pointerEvents: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={labelStyle}>{MISSED_FINDS_TITLE}</div>
        <div style={{ ...labelStyle, opacity: 0.4 }}>{MISSED_FINDS_TOGGLE_HINT}</div>
      </div>

      {board.received ? (
        board.rows.map((row) => <MissedFindsRow key={row.publicPlayerId} row={row} />)
      ) : (
        <div style={{ padding: "6px 0", opacity: 0.6 }}>{MISSED_FINDS_AWAITING}</div>
      )}

      <div style={{ ...labelStyle, marginTop: 8 }}>
        {board.received ? missedFindsCountdown(board.secondsToNextUpdate) : ""}
      </div>
    </div>
  );
}
