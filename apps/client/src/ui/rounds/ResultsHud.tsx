import { RESULT_VOTE_CATEGORIES, type ResultVoteCategory } from "@foldseek/game-sim";
import type { CSSProperties, ReactElement } from "react";

import { VOTE_CATEGORY_LABELS, roundLabel } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import {
  BRASS,
  CREAM,
  EDGE,
  buttonStyle,
  disabledButtonStyle,
  headlineStyle,
  labelStyle,
  overlayStyle,
  panelStyle,
  primaryButtonStyle,
} from "./theme";

/**
 * Results (§5.15): the winner, what each player did with their round, the three
 * community votes, and the rematch. Deliberately not an experience bar.
 */

export interface ResultsHudProps {
  readonly state: RoundViewState;
  readonly onVote: (category: ResultVoteCategory, targetPublicObjectId: string) => void;
  readonly onRematch: (yes: boolean) => void;
}

const cellStyle: CSSProperties = {
  padding: "6px 10px",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const nameCellStyle: CSSProperties = { ...cellStyle, textAlign: "left" };

export function ResultsHud({ state, onVote, onRematch }: ResultsHudProps): ReactElement | null {
  const results = state.results;
  if (results === null) return null;

  const voteGate = state.actions.voteResult;
  const rematchGate = state.actions.voteRematch;

  return (
    <div style={overlayStyle}>
      <PhaseTimer timer={state.timer} label={state.phaseLabel} />

      <div
        style={{
          ...panelStyle,
          top: 120,
          left: "50%",
          transform: "translateX(-50%)",
          width: 640,
          maxHeight: "62vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <h2 style={{ ...headlineStyle, color: BRASS }}>
            {results.winner === "inspectors" ? "INSPECTORS" : "MIMICS"}
          </h2>
          <span style={labelStyle}>{roundLabel(results.round)}</span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
          <thead>
            <tr>
              <th style={{ ...nameCellStyle, ...labelStyle }}>Player</th>
              <th style={{ ...cellStyle, ...labelStyle }}>Role</th>
              <th style={{ ...cellStyle, ...labelStyle }}>Survived</th>
              <th style={{ ...cellStyle, ...labelStyle }}>Correct</th>
              <th style={{ ...cellStyle, ...labelStyle }}>Wrong</th>
              <th style={{ ...cellStyle, ...labelStyle }}>Score</th>
            </tr>
          </thead>
          <tbody>
            {results.rows.map((row) => (
              <tr key={row.publicPlayerId} style={{ borderTop: EDGE }}>
                <td style={{ ...nameCellStyle, color: row.isSelf ? BRASS : CREAM }}>
                  {row.displayName}
                  {row.fullRoundSurvival ? (
                    <span style={{ ...labelStyle, marginLeft: 8 }}>survived</span>
                  ) : null}
                </td>
                <td style={cellStyle}>{row.role}</td>
                <td style={cellStyle}>{row.survivalSeconds.toFixed(1)}s</td>
                <td style={cellStyle}>{row.correctAccusations}</td>
                <td style={cellStyle}>{row.wrongAccusations}</td>
                <td style={{ ...cellStyle, color: BRASS }}>{row.score}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: 18 }}>
          {RESULT_VOTE_CATEGORIES.map((category) => {
            const chosen = results.myVotes[category];
            return (
              <div key={category} style={{ marginBottom: 10 }}>
                <div style={labelStyle}>{VOTE_CATEGORY_LABELS[category]}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                  {results.voteCandidates.length === 0 ? (
                    <span style={{ opacity: 0.55 }}>Nothing to vote on.</span>
                  ) : (
                    results.voteCandidates.map((candidate) => {
                      const selected = chosen === candidate.publicObjectId;
                      const allowed = voteGate.allowed && chosen === null;
                      const base = selected ? primaryButtonStyle : buttonStyle;
                      return (
                        <button
                          key={candidate.publicObjectId}
                          type="button"
                          style={allowed || selected ? base : disabledButtonStyle(base)}
                          disabled={!allowed}
                          onClick={() => {
                            onVote(category, candidate.publicObjectId);
                          }}
                        >
                          {candidate.displayName}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div
        style={{
          ...panelStyle,
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          type="button"
          style={rematchGate.allowed ? primaryButtonStyle : disabledButtonStyle(primaryButtonStyle)}
          disabled={!rematchGate.allowed}
          onClick={() => {
            onRematch(true);
          }}
        >
          {state.rematch.myVote === true ? "Rematch requested" : "Rematch"}
        </button>
        <button
          type="button"
          style={rematchGate.allowed ? buttonStyle : disabledButtonStyle(buttonStyle)}
          disabled={!rematchGate.allowed}
          onClick={() => {
            onRematch(false);
          }}
        >
          Sit this one out
        </button>
        <span style={labelStyle}>
          {state.rematch.yesVotes} / {state.rematch.totalVoters} in
        </span>
      </div>
    </div>
  );
}
