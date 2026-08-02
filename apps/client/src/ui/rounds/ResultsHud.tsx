import { RESULT_VOTE_CATEGORIES, type ResultVoteCategory } from "@foldseek/game-sim";
import type { CSSProperties, ReactElement } from "react";

import { VOTE_CATEGORY_LABELS, roundLabel } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import {
  BRASS_LIT,
  CREAM,
  FONT_DISPLAY,
  PRESS_CLASS,
  RULE,
  buttonStyle,
  disabledButtonStyle,
  labelStyle,
  ornamentRuleStyle,
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
  padding: "7px 10px",
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
        <div style={{ textAlign: "center" }}>
          <div style={labelStyle}>{roundLabel(results.round)}</div>
          <h2
            className="fs-candle"
            style={{
              margin: "6px 0 0",
              font: `600 30px/1.15 ${FONT_DISPLAY}`,
              letterSpacing: "0.18em",
              textIndent: "0.18em",
              textTransform: "uppercase",
              color: BRASS_LIT,
              textShadow: "0 2px 20px rgba(255, 190, 107, 0.3)",
            }}
          >
            {results.winner === "inspectors" ? "Inspectors win" : "Mimics win"}
          </h2>
          <div style={{ ...ornamentRuleStyle(190), margin: "12px auto 0" }} aria-hidden />
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
              <tr key={row.publicPlayerId} style={{ borderTop: RULE }}>
                <td style={{ ...nameCellStyle, color: row.isSelf ? BRASS_LIT : CREAM }}>
                  {row.displayName}
                  {row.fullRoundSurvival ? (
                    <span style={{ ...labelStyle, marginLeft: 8 }}>survived</span>
                  ) : null}
                </td>
                <td style={cellStyle}>{row.role}</td>
                <td style={cellStyle}>{row.survivalSeconds.toFixed(1)}s</td>
                <td style={cellStyle}>{row.correctAccusations}</td>
                <td style={cellStyle}>{row.wrongAccusations}</td>
                <td style={{ ...cellStyle, color: BRASS_LIT, fontWeight: 600 }}>{row.score}</td>
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
                          className={PRESS_CLASS}
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
          className={PRESS_CLASS}
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
          className={PRESS_CLASS}
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
