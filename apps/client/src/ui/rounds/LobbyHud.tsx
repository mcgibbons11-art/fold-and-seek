import { inspectorCountFor, type MatchSettingsPatch } from "@foldseek/game-sim";
import type { MatchSettings } from "@foldseek/shared";
import { useState, type CSSProperties, type ReactElement } from "react";

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
  /** Present in a live round; omitted by small isolated HUD fixtures. */
  readonly settings?: MatchSettings;
  readonly onSettingsChange?: (settings: MatchSettingsPatch) => void;
  /** Bot seats. Both are offered to the host only, on transports that hold them. */
  readonly onAddBot?: () => void;
  readonly onRemoveBot?: () => void;
}

/**
 * The joined-room screen uses the same full-width staging hierarchy as the
 * browser: roster left, briefing centre, host controls right.
 *
 * It scrolls rather than growing past the viewport, because a full room's
 * roster is taller than a preview pane: a plate pushed off the bottom is a
 * control nobody can reach, which is the failure this layout exists to avoid.
 */
const columnStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  right: 16,
  height: "calc(100% - 32px)",
  maxHeight: "calc(100% - 32px)",
  minWidth: 900,
  overflow: "auto",
  display: "grid",
  gridTemplateAreas: '"header header header" "roster briefing staging" "roster briefing settings"',
  gridTemplateColumns: "minmax(250px, 0.85fr) minmax(360px, 1.35fr) minmax(260px, 0.8fr)",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
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
  width: "auto",
  padding: "14px 18px",
  minHeight: 0,
  maxHeight: "none",
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

const settingSelectStyle: CSSProperties = {
  ...buttonStyle,
  padding: "5px 8px",
  minWidth: 112,
  textTransform: "none",
  letterSpacing: "0.04em",
  backgroundColor: "#171008",
};

const DURATION_OPTIONS = [30_000, 45_000, 60_000, 75_000, 90_000, 120_000] as const;

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
  settings,
  onSettingsChange,
  onAddBot,
  onRemoveBot,
}: LobbyHudProps): ReactElement {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const startGate = state.actions.startMatch;
  const readyGate = state.actions.ready;
  const readyCount = state.roster.filter((player) => player.ready).length;
  const bots = state.botSeats;
  // Offered to the host of a transport that can hold bot seats, and to nobody
  // else: everyone in the room sees the bots, and one person seats them.
  const showBotSeats = bots.supported && bots.canManage && onAddBot !== undefined;
  const roomIsFull = state.roster.length >= bots.maxSeats;
  const blockedCopy = startGate.reason === null ? null : (START_BLOCKED_COPY[startGate.reason] ?? null);
  const canEditSettings = state.self.isHost && onSettingsChange !== undefined;

  return (
    <div style={overlayStyle}>
      <div style={columnStyle}>
        <div
          style={{
            ...plateStyle,
            gridArea: "header",
            padding: "14px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 24,
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
          {roomCode === "" ? (
            <div style={{ ...labelStyle, opacity: 0.55 }}>Private practice lobby</div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
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
            gridArea: "staging",
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

        <div
          style={{
            ...plateStyle,
            gridArea: "briefing",
            minHeight: 0,
            padding: "24px 26px",
            display: "flex",
            flexDirection: "column",
            background:
              "radial-gradient(100% 80% at 50% 38%, rgba(118, 82, 38, 0.26), rgba(16, 12, 8, 0.94))",
          }}
        >
          <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1 }}>Operation briefing</div>
          <h3 style={{ margin: "10px 0 8px", font: `600 31px/1.1 ${FONT_DISPLAY}` }}>
            Blend into the Curiosity Shop
          </h3>
          <p style={{ margin: 0, maxWidth: 520, opacity: 0.74, lineHeight: 1.7 }}>
            Mimics forge a convincing object and hide in plain sight. Inspectors memorize the untouched room, then spend limited warrants finding what changed.
          </p>
          <div style={{ margin: "auto 0", display: "grid", gap: 10, padding: "24px 0" }}>
            {[
              ["01", "Memorize", "Inspectors study the untouched shop."],
              ["02", "Forge", "Mimics shape, panel, pose, and paint."],
              ["03", "Hunt", "Every wrong accusation burns a warrant."],
            ].map(([number, title, copy]) => (
              <div key={number} style={{ display: "grid", gridTemplateColumns: "38px 82px 1fr", gap: 10, alignItems: "baseline", paddingTop: 9, borderTop: RULE }}>
                <span style={{ color: BRASS_LIT, font: `600 15px/1 ${FONT_DISPLAY}` }}>{number}</span>
                <span style={{ color: CREAM, fontWeight: 600 }}>{title}</span>
                <span style={{ opacity: 0.62 }}>{copy}</span>
              </div>
            ))}
          </div>
          <div style={{ ...labelStyle, color: BRASS_LIT }}>
            {settings === undefined
              ? `${readyCount} of ${state.roster.length} players ready`
              : roleSplitCopy(state.roster.length, settings.seekerCount)}
          </div>
        </div>

        {settings === undefined ? null : (
          <div style={{ ...plateStyle, gridArea: "settings", width: "auto", padding: "12px 18px" }}>
            <button
              type="button"
              className={PRESS_CLASS}
              style={{ ...buttonStyle, width: "100%" }}
              aria-expanded={settingsOpen}
              onClick={() => {
                setSettingsOpen((open) => !open);
              }}
            >
              Room settings
            </button>
            {settingsOpen ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ ...labelStyle, marginBottom: 9 }}>
                  {canEditSettings ? "Host controls" : "Host controls · read only"}
                </div>
                <SettingRow label="Inspectors">
                  <select
                    aria-label="Inspector count"
                    style={settingSelectStyle}
                    value={settings.seekerCount}
                    disabled={!canEditSettings}
                    onChange={(event) => {
                      onSettingsChange?.({ seekerCount: Number(event.target.value) });
                    }}
                  >
                    <option value={1}>1 Inspector</option>
                    <option value={2}>2 Inspectors</option>
                  </select>
                </SettingRow>
                <SettingRow label="Forge time">
                  <DurationSelect
                    label="Forge time"
                    value={settings.forgeMs}
                    disabled={!canEditSettings}
                    onChange={(forgeMs) => onSettingsChange?.({ forgeMs })}
                  />
                </SettingRow>
                <SettingRow label="Hunt time">
                  <DurationSelect
                    label="Hunt time"
                    value={settings.inspectionMs}
                    disabled={!canEditSettings}
                    onChange={(inspectionMs) => onSettingsChange?.({ inspectionMs })}
                  />
                </SettingRow>
                <div style={{ ...labelStyle, marginTop: 10, opacity: 0.72 }}>
                  {roleSplitCopy(state.roster.length, settings.seekerCount)}
                </div>
              </div>
            ) : null}
          </div>
        )}

        <div style={{ ...plateStyle, ...rosterPlateStyle, gridArea: "roster" }}>
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

function SettingRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "7px 0",
        borderTop: RULE,
      }}
    >
      <span style={{ fontSize: 12, color: CREAM }}>{label}</span>
      {children}
    </label>
  );
}

function DurationSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}): ReactElement {
  const options = DURATION_OPTIONS.includes(value as (typeof DURATION_OPTIONS)[number])
    ? DURATION_OPTIONS
    : ([...DURATION_OPTIONS, value].sort((a, b) => a - b) as readonly number[]);
  return (
    <select
      aria-label={label}
      style={settingSelectStyle}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        onChange(Number(event.target.value));
      }}
    >
      {options.map((duration) => (
        <option key={duration} value={duration}>
          {duration / 1_000} seconds
        </option>
      ))}
    </select>
  );
}

function roleSplitCopy(rosterSize: number, requestedInspectors: number): string {
  const inspectors = inspectorCountFor(rosterSize, requestedInspectors);
  const mimics = Math.max(0, rosterSize - inspectors);
  if (rosterSize < 2) return "Role preview · waiting for another player";
  return `Role preview · ${inspectors} Inspector${inspectors === 1 ? "" : "s"} · ${mimics} Mimic${mimics === 1 ? "" : "s"}`;
}
