import type { CSSProperties, ReactElement } from "react";

import type { RoundViewState } from "../../gameplay/roundView";
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
  overlayStyle,
  panelStyle,
  primaryButtonStyle,
} from "./theme";

/**
 * Lobby (§5.3): who is here, who is ready, the code that brings other people
 * here, and the host's start control. Everything it knows arrives as one
 * RoundViewState, including whether the start button may be pressed at all.
 *
 * Why the start gate is printed rather than left in a tooltip: a guest staring
 * at a dead brass button has no way to discover that they are waiting on the
 * host, and a tooltip is not an answer on a machine with no pointer hovering.
 *
 * NOTHING HERE IS PINNED TO THE BOTTOM OF THE VIEWPORT, and that is a rule
 * rather than a preference. Ready and Start sat on `bottom: 24` until the
 * Portals editor's own preview-debug drawer — 180 px tall, pinned to the bottom
 * of the preview and painted over the game's iframe — was measured (2026-08-02)
 * covering exactly that band: the plate was visible through the gap above the
 * drawer and every click on it went to the editor instead. Nobody could ready
 * up or start a round, while the bot controls a hundred pixels higher worked,
 * which is what made it read as a broken button rather than a covered one. A
 * mobile browser's toolbar takes the same band. So the whole lobby is one
 * column from the top edge, and it scrolls inside itself when a full room
 * outgrows a short viewport.
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

/**
 * The one column the lobby stacks into, anchored to the top edge and centred.
 *
 * It scrolls rather than growing past the viewport, because a full room's
 * roster is taller than a preview pane: a plate pushed off the bottom is a
 * control nobody can reach, which is the failure this layout exists to avoid.
 */
const columnStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  left: "50%",
  transform: "translateX(-50%)",
  maxHeight: "calc(100% - 32px)",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  // The room keeps the pointer between the plates; each plate opts itself back
  // in through `panelStyle`, exactly as the rest of the HUD does.
  pointerEvents: "none",
};

/** A lobby plate: the shop's panel, placed by the column rather than by itself. */
const plateStyle: CSSProperties = {
  ...panelStyle,
  position: "relative",
  flexShrink: 0,
};

/**
 * The roster is the one plate that grows with the room, so it is the one that
 * gives way: it scrolls inside a fixed box rather than pushing the controls
 * above it down the screen. Ready and Start therefore sit at the same height in
 * an empty room and in a full one, which is what keeps them clear of whatever a
 * host page has parked along the bottom edge.
 */
const rosterPlateStyle: CSSProperties = {
  width: 380,
  padding: "14px 18px",
  maxHeight: 340,
  overflowY: "auto",
};

const rosterRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 0",
  borderTop: RULE,
};

const tagStyle: CSSProperties = {
  ...labelStyle,
  marginLeft: 8,
  opacity: 0.55,
  padding: "1px 5px",
  borderRadius: 3,
  border: `1px solid rgba(176, 138, 74, 0.34)`,
};

const START_BLOCKED_COPY: Readonly<Record<string, string>> = {
  not_host: "Only the host can start the round.",
  not_enough_players: "Waiting for more people.",
  players_not_ready: "Waiting for everyone to ready up.",
  not_connected: "Not connected.",
  wrong_phase: "A round is already running.",
};

/** A lit brass pip for a player who has readied, an empty socket for one who has not. */
function ReadyPip({ ready, away }: { readonly ready: boolean; readonly away: boolean }): ReactElement {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: "50%",
        marginRight: 7,
        background: ready ? BRASS_LIT : "transparent",
        border: `1px solid ${ready ? BRASS_LIT : "rgba(232, 221, 205, 0.3)"}`,
        boxShadow: ready ? "0 0 8px rgba(255, 190, 107, 0.6)" : "none",
        opacity: away ? 0.35 : 1,
      }}
    />
  );
}

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
  const blockedCopy = startGate.reason === null ? null : (START_BLOCKED_COPY[startGate.reason] ?? null);

  return (
    <div style={overlayStyle}>
      <div style={columnStyle}>
        <div
          style={{
            ...plateStyle,
            padding: "12px 28px",
            textAlign: "center",
          }}
        >
          <h2
            style={{
              margin: 0,
              font: `600 22px/1.15 ${FONT_DISPLAY}`,
              letterSpacing: "0.2em",
              textIndent: "0.2em",
            }}
          >
            <span style={{ color: BRASS_LIT }}>FOLD</span>
            <span style={{ color: BRASS, opacity: 0.8 }}> &amp; </span>
            <span style={{ color: CREAM, fontWeight: 400 }}>SEEK</span>
          </h2>
          {roomCode === "" ? null : (
            <div
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
              }}
            >
              <span style={labelStyle}>Room</span>
              <span
                style={{
                  letterSpacing: "0.3em",
                  font: `600 16px/1 ${FONT_DISPLAY}`,
                  color: BRASS_LIT,
                }}
              >
                {roomCode}
              </span>
              {onCopyRoomCode === undefined ? null : (
                <button type="button" className={PRESS_CLASS} style={buttonStyle} onClick={onCopyRoomCode}>
                  Copy
                </button>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            ...plateStyle,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              className={PRESS_CLASS}
              style={
                readyGate.allowed
                  ? state.self.ready
                    ? primaryButtonStyle
                    : buttonStyle
                  : disabledButtonStyle(buttonStyle)
              }
              disabled={!readyGate.allowed}
              onClick={() => {
                onReady(!state.self.ready);
              }}
            >
              {state.self.ready ? "Ready" : "Ready up"}
            </button>
            <button
              type="button"
              className={PRESS_CLASS}
              style={startGate.allowed ? primaryButtonStyle : disabledButtonStyle(primaryButtonStyle)}
              disabled={!startGate.allowed}
              onClick={onStart}
            >
              Start the round
            </button>
          </div>
          {startGate.allowed || blockedCopy === null ? null : (
            <div style={{ ...labelStyle, opacity: 0.7, letterSpacing: "0.08em" }}>{blockedCopy}</div>
          )}
        </div>

        <div style={{ ...plateStyle, ...rosterPlateStyle }}>
          <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between" }}>
            <span>Roster</span>
            <span style={{ color: BRASS_LIT }}>
              {readyCount} / {state.roster.length} ready
            </span>
          </div>
          {state.roster.map((player) => (
            <div key={player.publicPlayerId} style={rosterRowStyle}>
              <span
                style={{
                  color: player.isSelf ? BRASS_LIT : CREAM,
                  opacity: player.connected ? 1 : 0.4,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <ReadyPip ready={player.ready} away={!player.connected} />
                {player.displayName}
                {player.isHost ? <span style={tagStyle}>host</span> : null}
                {player.isBot ? <span style={tagStyle}>bot</span> : null}
              </span>
              <span
                style={{
                  ...labelStyle,
                  color: player.ready ? BRASS_LIT : CREAM,
                  opacity: player.connected ? (player.ready ? 1 : 0.6) : 0.4,
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
                  className={PRESS_CLASS}
                  style={bots.count > 0 ? buttonStyle : disabledButtonStyle(buttonStyle)}
                  disabled={bots.count === 0}
                  onClick={onRemoveBot}
                >
                  &minus;
                </button>
                <span
                  style={{
                    color: BRASS_LIT,
                    minWidth: 16,
                    textAlign: "center",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {bots.count}
                </span>
                <button
                  type="button"
                  aria-label="Add a bot"
                  className={PRESS_CLASS}
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
      </div>
    </div>
  );
}
