import type { CSSProperties, ReactElement } from "react";

import type { RoundViewState } from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import {
  BRASS,
  CREAM,
  EDGE,
  buttonStyle,
  disabledButtonStyle,
  labelStyle,
  overlayStyle,
  panelStyle,
  primaryButtonStyle,
} from "./theme";

/**
 * Spectator chrome (§9.1). Who is being watched, how far behind live this feed
 * runs, and the guess buttons of public spectator mode.
 *
 * What a spectator may *see* is an engine question: identity outlines, the
 * focus cone, and the x-ray treatment are all rendered in the room, not here.
 * This component draws the frame around them and nothing that would leak a
 * hider's position on its own, which is why the guess list names objects the
 * room already shows rather than players.
 */

export interface SpectatorTarget {
  /** Object the spectator camera is following, if it is following one. */
  readonly publicObjectId: string | null;
  /** Who the camera is on. Null while the director is on a wide shot. */
  readonly displayName: string | null;
}

export interface SpectatorHudProps {
  readonly state: RoundViewState;
  readonly target: SpectatorTarget;
  /**
   * Seconds this feed trails live play (§9.1 streamer delay). Null for an
   * eliminated player watching their own room, who is not delayed.
   */
  readonly delaySeconds: number | null;
  /**
   * Guesses are cosmetic: they are recorded for the results screen and change
   * nothing about the round (§9.1). No command carries them yet, so this is a
   * placeholder the host wires when one exists.
   */
  readonly onGuess?: (publicObjectId: string) => void;
  readonly guessedObjectIds?: readonly string[];
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  padding: "6px 0",
  borderTop: EDGE,
};

export function SpectatorHud({
  state,
  target,
  delaySeconds,
  onGuess,
  guessedObjectIds = [],
}: SpectatorHudProps): ReactElement {
  const guessed = new Set(guessedObjectIds);
  // A spectator may guess at anything still standing; a resolved disguise has
  // already answered the question.
  const guessable = state.reveal.entries.filter((entry) => !entry.caught);

  return (
    <div style={overlayStyle}>
      <PhaseTimer
        timer={state.timer}
        label={state.phaseLabel}
        note={state.self.lifeState === "caught" ? "You were found" : "Spectating"}
      />

      <div style={{ ...panelStyle, top: 16, left: 16, pointerEvents: "none", minWidth: 180 }}>
        <div style={labelStyle}>Watching</div>
        <div style={{ marginTop: 4, color: target.displayName === null ? CREAM : BRASS }}>
          {target.displayName ?? "The room"}
        </div>
        {delaySeconds === null ? null : (
          <div style={{ ...labelStyle, marginTop: 10 }}>
            Delayed by {delaySeconds}s
          </div>
        )}
        <div style={{ ...labelStyle, marginTop: 10 }}>Mimics remaining</div>
        <div style={{ font: "600 22px/1.2 system-ui, sans-serif", color: BRASS }}>
          {state.mimicsRemaining}
        </div>
      </div>

      {onGuess === undefined || guessable.length === 0 ? null : (
        <div
          style={{
            ...panelStyle,
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            width: 340,
            maxHeight: "40vh",
            overflowY: "auto",
          }}
        >
          <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between" }}>
            <span>Call it</span>
            <span>Cosmetic</span>
          </div>
          {guessable.map((entry) => {
            const already = guessed.has(entry.publicObjectId);
            return (
              <div key={entry.publicObjectId} style={rowStyle}>
                <span>{entry.revealed ? (entry.displayName ?? "Unknown") : "Unknown"}</span>
                <button
                  type="button"
                  style={already ? primaryButtonStyle : buttonStyle}
                  disabled={already}
                  onClick={() => {
                    onGuess(entry.publicObjectId);
                  }}
                >
                  {already ? "Called" : "Mimic"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {onGuess === undefined ? (
        <div
          style={{
            ...panelStyle,
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            pointerEvents: "none",
          }}
        >
          <button type="button" style={disabledButtonStyle(buttonStyle)} disabled>
            Guesses unavailable
          </button>
        </div>
      ) : null}
    </div>
  );
}
