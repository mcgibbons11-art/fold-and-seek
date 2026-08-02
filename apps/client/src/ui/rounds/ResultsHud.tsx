import { RESULT_VOTE_CATEGORIES, type ResultVoteCategory } from "@foldseek/game-sim";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import {
  RESULTS_COLUMN_CAUGHT,
  RESULTS_COLUMN_HELD_OUT,
  RESULTS_COLUMN_PLAYER,
  RESULTS_COLUMN_SCORE,
  RESULTS_COLUMN_SEEN_AND_MISSED,
  RESULTS_COLUMN_WARRANTS_SPENT,
  RESULTS_INSPECTOR_HEADING,
  RESULTS_MIMIC_HEADING,
  RESULTS_SPECTATOR_HEADING,
  RESULTS_SURVIVED_NOTE,
  RESULTS_VOTE_BLURB,
  RESULTS_VOTE_HEADING,
  RESULTS_VOTE_LEADER_NOTE,
  RESULTS_VOTE_NOTHING,
  RESULTS_VOTE_YOUR_PICK,
  VOTE_CATEGORY_LABELS,
  roundLabel,
  voteTallyNote,
} from "../../gameplay/copy";
import type {
  ResultRowView,
  RoundViewState,
  VoteCandidateView,
  VoteTallies,
} from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import {
  BRASS,
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
 *
 * The ledger reports two different rounds and so is drawn as two tables. One set
 * of columns for both sides put "SURVIVED 0.0s" against an Inspector who was
 * never hiding, and a permanent pair of zeroes under CORRECT and WRONG against
 * every Mimic, who cannot accuse anybody. A column is drawn where it means
 * something and left out where it does not; the deception column goes further
 * and is dropped when no hider earned anything under it, because a column of
 * zeroes is a question the screen has no answer for.
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

/** One column of a ledger: its heading and how a row fills it. */
interface Column {
  readonly id: string;
  readonly heading: string;
  readonly render: (row: ResultRowView) => ReactNode;
}

function nameCell(row: ResultRowView): ReactNode {
  return (
    <>
      {row.displayName}
      {row.fullRoundSurvival ? (
        <span style={{ ...labelStyle, marginLeft: 8 }}>{RESULTS_SURVIVED_NOTE}</span>
      ) : null}
    </>
  );
}

const PLAYER_COLUMN: Column = {
  id: "player",
  heading: RESULTS_COLUMN_PLAYER,
  render: nameCell,
};

const SCORE_COLUMN: Column = {
  id: "score",
  heading: RESULTS_COLUMN_SCORE,
  render: (row) => row.score,
};

/**
 * What a Mimic's round was. `directLookEscapes` is the count of times an
 * Inspector looked straight at them and moved on, which is the disguise doing
 * its job, so it is worth a column whenever anybody earned one.
 */
function mimicColumns(rows: readonly ResultRowView[]): readonly Column[] {
  const anyEscapes = rows.some((row) => row.directLookEscapes > 0);
  return [
    PLAYER_COLUMN,
    {
      id: "heldOut",
      heading: RESULTS_COLUMN_HELD_OUT,
      render: (row) => `${row.survivalSeconds.toFixed(1)}s`,
    },
    ...(anyEscapes
      ? [
          {
            id: "escapes",
            heading: RESULTS_COLUMN_SEEN_AND_MISSED,
            render: (row: ResultRowView) => row.directLookEscapes,
          },
        ]
      : []),
    SCORE_COLUMN,
  ];
}

/**
 * What an Inspector's round was. Every accusation spends a warrant round
 * whether or not it lands, so the two counts the simulation keeps add up to what
 * was spent, and the correct ones alone are the catches.
 */
const INSPECTOR_COLUMNS: readonly Column[] = [
  PLAYER_COLUMN,
  {
    id: "spent",
    heading: RESULTS_COLUMN_WARRANTS_SPENT,
    render: (row) => row.correctAccusations + row.wrongAccusations,
  },
  { id: "caught", heading: RESULTS_COLUMN_CAUGHT, render: (row) => row.correctAccusations },
  SCORE_COLUMN,
];

function Ledger({
  heading,
  columns,
  rows,
}: {
  readonly heading: string;
  readonly columns: readonly Column[];
  readonly rows: readonly ResultRowView[];
}): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={labelStyle}>{heading}</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                key={column.id}
                style={{ ...(index === 0 ? nameCellStyle : cellStyle), ...labelStyle }}
              >
                {column.heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.publicPlayerId} style={{ borderTop: RULE }}>
              {columns.map((column, index) => (
                <td
                  key={column.id}
                  style={{
                    ...(index === 0 ? nameCellStyle : cellStyle),
                    ...(index === 0 ? { color: row.isSelf ? BRASS_LIT : CREAM } : {}),
                    ...(column.id === "score" ? { color: BRASS_LIT, fontWeight: 600 } : {}),
                  }}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One award. The three of these were previously a heading over a row of plain
 * buttons with no sign that pressing one cast a vote, no sign of which had been
 * pressed once it had been, and no sign of what the room had decided. Each
 * candidate now carries its own running count, the leader is marked, and the
 * player's own pick is named so that a vote reads as spent rather than pending.
 */
function AwardRow({
  category,
  candidates,
  tallies,
  chosen,
  allowed,
  onVote,
}: {
  readonly category: ResultVoteCategory;
  readonly candidates: readonly VoteCandidateView[];
  readonly tallies: VoteTallies;
  readonly chosen: string | null;
  readonly allowed: boolean;
  readonly onVote: (category: ResultVoteCategory, targetPublicObjectId: string) => void;
}): ReactElement {
  const counts = tallies[category];
  const leading = Math.max(0, ...candidates.map((c) => counts[c.publicObjectId] ?? 0));

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1 }}>
          {VOTE_CATEGORY_LABELS[category]}
        </div>
        {chosen === null ? null : (
          <div style={{ ...labelStyle, color: BRASS }}>{RESULTS_VOTE_YOUR_PICK}</div>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
        {candidates.length === 0 ? (
          <span style={{ opacity: 0.55 }}>{RESULTS_VOTE_NOTHING}</span>
        ) : (
          candidates.map((candidate) => {
            const votes = counts[candidate.publicObjectId] ?? 0;
            const selected = chosen === candidate.publicObjectId;
            const isLeader = leading > 0 && votes === leading;
            const pressable = allowed && chosen === null;
            const base = selected ? primaryButtonStyle : buttonStyle;
            return (
              <button
                key={candidate.publicObjectId}
                type="button"
                className={PRESS_CLASS}
                aria-pressed={selected}
                style={{
                  ...(pressable || selected ? base : disabledButtonStyle(base)),
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  textTransform: "none",
                  letterSpacing: "0.04em",
                }}
                disabled={!pressable}
                onClick={() => {
                  onVote(category, candidate.publicObjectId);
                }}
              >
                <span>{candidate.displayName}</span>
                <span
                  style={{
                    fontVariantNumeric: "tabular-nums",
                    opacity: votes === 0 ? 0.45 : 1,
                    color: selected ? undefined : isLeader ? BRASS_LIT : undefined,
                  }}
                >
                  {voteTallyNote(votes)}
                  {isLeader && !selected ? ` · ${RESULTS_VOTE_LEADER_NOTE}` : ""}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export function ResultsHud({ state, onVote, onRematch }: ResultsHudProps): ReactElement | null {
  const results = state.results;
  if (results === null) return null;

  const voteGate = state.actions.voteResult;
  const rematchGate = state.actions.voteRematch;

  const mimicRows = results.rows.filter((row) => row.role === "mimic");
  const inspectorRows = results.rows.filter((row) => row.role === "inspector");
  const otherRows = results.rows.filter(
    (row) => row.role !== "mimic" && row.role !== "inspector",
  );

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

        <Ledger
          heading={RESULTS_MIMIC_HEADING}
          columns={mimicColumns(mimicRows)}
          rows={mimicRows}
        />
        <Ledger
          heading={RESULTS_INSPECTOR_HEADING}
          columns={INSPECTOR_COLUMNS}
          rows={inspectorRows}
        />
        <Ledger
          heading={RESULTS_SPECTATOR_HEADING}
          columns={[PLAYER_COLUMN, SCORE_COLUMN]}
          rows={otherRows}
        />

        <div style={{ marginTop: 20, borderTop: RULE, paddingTop: 14 }}>
          <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1 }}>
            {RESULTS_VOTE_HEADING}
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, margin: "3px 0 12px" }}>
            {RESULTS_VOTE_BLURB}
          </div>
          {RESULT_VOTE_CATEGORIES.map((category) => (
            <AwardRow
              key={category}
              category={category}
              candidates={results.voteCandidates}
              tallies={results.voteTallies}
              chosen={results.myVotes[category]}
              allowed={voteGate.allowed}
              onVote={onVote}
            />
          ))}
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
