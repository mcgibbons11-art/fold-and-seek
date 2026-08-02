import type { CSSProperties, ReactElement } from "react";

import type { RoundViewState } from "../../gameplay/roundView";
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
 * Lobby (§5.3): who is here, who is ready, the code that brings other people
 * here, and the host's start control. Everything it knows arrives as one
 * RoundViewState, including whether the start button may be pressed at all.
 */

export interface LobbyHudProps {
  readonly state: RoundViewState;
  /** Room code or link the host shares. Empty hides the plate. */
  readonly roomCode: string;
  readonly onReady: (ready: boolean) => void;
  readonly onStart: () => void;
  readonly onCopyRoomCode?: () => void;
  /** Bot seats. Both are offered to the host only, on transports that hold them. */
  readonly onAddBot?: () => void;
  readonly onRemoveBot?: () => void;
}

const rosterRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "7px 0",
  borderTop: EDGE,
};

const START_BLOCKED_COPY: Readonly<Record<string, string>> = {
  not_host: "Only the host can start the round.",
  not_enough_players: "Waiting for more people.",
  players_not_ready: "Waiting for everyone to ready up.",
  not_connected: "Not connected.",
  wrong_phase: "A round is already running.",
};

export function LobbyHud({
  state,
  roomCode,
  onReady,
  onStart,
  onCopyRoomCode,
  onAddBot,
  onRemoveBot,
}: LobbyHudProps): ReactElement {
  const startGate = state.actions.startMatch;
  const readyGate = state.actions.ready;
  const readyCount = state.roster.filter((player) => player.ready).length;
  const bots = state.botSeats;
  // Offered to the host of a transport that can hold bot seats, and to nobody
  // else: everyone in the room sees the bots, and one person seats them.
  const showBotSeats = bots.supported && bots.canManage && onAddBot !== undefined;
  const roomIsFull = state.roster.length >= bots.maxSeats;

  return (
    <div style={overlayStyle}>
      <div style={{ ...panelStyle, top: 16, left: "50%", transform: "translateX(-50%)", padding: "10px 24px" }}>
        <h2 style={{ ...headlineStyle, textAlign: "center" }}>FOLD &amp; SEEK</h2>
        {roomCode === "" ? null : (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={labelStyle}>Room</span>
            <span style={{ letterSpacing: "0.3em", fontSize: 16, color: BRASS }}>{roomCode}</span>
            {onCopyRoomCode === undefined ? null : (
              <button type="button" style={buttonStyle} onClick={onCopyRoomCode}>
                Copy
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ ...panelStyle, top: 110, left: "50%", transform: "translateX(-50%)", width: 360 }}>
        <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between" }}>
          <span>Roster</span>
          <span>
            {readyCount} / {state.roster.length} ready
          </span>
        </div>
        {state.roster.map((player) => (
          <div key={player.publicPlayerId} style={rosterRowStyle}>
            <span style={{ color: player.isSelf ? BRASS : CREAM }}>
              {player.displayName}
              {player.isHost ? <span style={{ ...labelStyle, marginLeft: 8 }}>host</span> : null}
              {player.isBot ? <span style={{ ...labelStyle, marginLeft: 8 }}>bot</span> : null}
            </span>
            <span
              style={{
                ...labelStyle,
                color: player.ready ? BRASS : CREAM,
                opacity: player.connected ? 1 : 0.4,
              }}
            >
              {player.connected ? (player.ready ? "ready" : "waiting") : "away"}
            </span>
          </div>
        ))}
        {showBotSeats ? (
          <div style={{ ...rosterRowStyle, marginTop: 4 }}>
            <span style={labelStyle}>Fill seats with bots</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                aria-label="Remove a bot"
                style={bots.count > 0 ? buttonStyle : disabledButtonStyle(buttonStyle)}
                disabled={bots.count === 0}
                onClick={onRemoveBot}
              >
                &minus;
              </button>
              <span style={{ color: BRASS, minWidth: 16, textAlign: "center" }}>{bots.count}</span>
              <button
                type="button"
                aria-label="Add a bot"
                style={roomIsFull ? disabledButtonStyle(buttonStyle) : buttonStyle}
                disabled={roomIsFull}
                onClick={onAddBot}
                title={roomIsFull ? "The room is full." : ""}
              >
                +
              </button>
            </span>
          </div>
        ) : null}
      </div>

      <div
        style={{
          ...panelStyle,
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          gap: 10,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          style={readyGate.allowed ? (state.self.ready ? primaryButtonStyle : buttonStyle) : disabledButtonStyle(buttonStyle)}
          disabled={!readyGate.allowed}
          onClick={() => {
            onReady(!state.self.ready);
          }}
        >
          {state.self.ready ? "Ready" : "Ready up"}
        </button>
        <button
          type="button"
          style={startGate.allowed ? primaryButtonStyle : disabledButtonStyle(primaryButtonStyle)}
          disabled={!startGate.allowed}
          onClick={onStart}
          title={startGate.reason === null ? "" : (START_BLOCKED_COPY[startGate.reason] ?? "")}
        >
          Start the round
        </button>
      </div>
    </div>
  );
}
