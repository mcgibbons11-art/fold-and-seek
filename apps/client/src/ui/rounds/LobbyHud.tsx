import { inspectorCountFor, type MatchSettingsPatch } from "@foldseek/game-sim";
import type { MatchSettings } from "@foldseek/shared";
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

import { AudioPlayer } from "../../forge/AudioPlayer";
import type { RoundViewState } from "../../gameplay/roundView";
import { useScreenEntryFocus } from "../accessibility";
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
  /** Moves the settled party into the room's own channel. Portals only. */
  readonly onLaunch?: () => void;
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
  minWidth: 0,
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

const NARROW_LOBBY_QUERY = "(max-width: 760px)";

/** Keeps the compact Portals layout semantic, instead of only visually reordering it. */
function useNarrowLobby(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? false
      : window.matchMedia(NARROW_LOBBY_QUERY).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(NARROW_LOBBY_QUERY);
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return narrow;
}

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
  onLaunch,
  onCopyRoomCode,
  settings,
  onSettingsChange,
  onAddBot,
  onRemoveBot,
}: LobbyHudProps): ReactElement {
  const screenRef = useScreenEntryFocus<HTMLDivElement>("lobby");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const narrowLobby = useNarrowLobby();
  const [briefingOpen, setBriefingOpen] = useState(false);
  const lobbyAudio = useRef<AudioPlayer | null>(null);
  const previousRoster = useRef<ReadonlyMap<string, boolean> | null>(null);
  // A remote player's command has to visit the host before the authoritative
  // ready flag comes back. Keep the button tactile during that round trip: the
  // old control looked as though it had missed the click for every non-host.
  const [readyIntent, setReadyIntent] = useState<boolean | null>(null);
  const startGate = state.actions.startMatch;
  const readyGate = state.actions.ready;
  const displayedReady = readyIntent ?? state.self.ready;
  const readyCount = state.roster.filter((player) => player.ready).length;
  const bots = state.botSeats;
  // Offered to the host of a transport that can hold bot seats, and to nobody
  // else: everyone in the room sees the bots, and one person seats them.
  const showBotSeats = bots.supported && bots.canManage && onAddBot !== undefined;
  const roomIsFull = state.roster.length >= bots.maxSeats;
  const blockedCopy = startGate.reason === null ? null : (START_BLOCKED_COPY[startGate.reason] ?? null);
  const canEditSettings = state.self.isHost && onSettingsChange !== undefined;

  useEffect(() => {
    lobbyAudio.current = new AudioPlayer(undefined, 0.45, "ui");
    return () => lobbyAudio.current?.dispose();
  }, []);

  useEffect(() => {
    const next = new Map(state.roster.map((player) => [player.seatId, player.ready]));
    const previous = previousRoster.current;
    previousRoster.current = next;
    if (previous === null) return;

    const departed = [...previous.keys()].some((id) => !next.has(id));
    const newlyReady = state.roster.filter(
      (player) => player.ready && previous.get(player.seatId) === false,
    );
    const wasStartable = previous.size >= 2 && [...previous.values()].every(Boolean);
    const isStartable = next.size >= 2 && [...next.values()].every(Boolean);

    if (departed) lobbyAudio.current?.play("ui_back");
    if (!wasStartable && isStartable) lobbyAudio.current?.play("ui_confirm");
    else if (newlyReady.length > 0) lobbyAudio.current?.play("rematch_tick", 0.03);
  }, [state.roster]);

  useEffect(() => {
    if (readyIntent === state.self.ready) setReadyIntent(null);
  }, [readyIntent, state.self.ready]);

  useEffect(() => {
    setReadyIntent(null);
  }, [state.phase, state.self.transportId]);

  useEffect(() => {
    if (readyIntent === null) return undefined;
    // A refusal or lost host must not leave a locally-lit button stuck forever.
    const timeout = window.setTimeout(() => setReadyIntent(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [readyIntent]);

  return (
    <div ref={screenRef} style={overlayStyle}>
      <div className="fs-lobby-grid" style={columnStyle}>
        <div
          className="fs-lobby-header"
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
          className="fs-lobby-staging"
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
          <div className="fs-lobby-actions" style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              className={PRESS_CLASS}
              style={
                readyGate.allowed
                  ? displayedReady
                    ? primaryButtonStyle
                    : buttonStyle
                  : disabledButtonStyle(buttonStyle)
              }
              disabled={!readyGate.allowed}
              aria-pressed={displayedReady}
              aria-busy={readyIntent !== null}
              data-entry-focus="true"
              onClick={() => {
                const next = !displayedReady;
                setReadyIntent(next);
                onReady(next);
              }}
            >
              {displayedReady ? "Ready" : "Ready up"}
            </button>
            {state.self.isHost && onLaunch !== undefined ? (
              <button
                type="button"
                className={PRESS_CLASS}
                style={buttonStyle}
                onClick={onLaunch}
              >
                Move everyone in
              </button>
            ) : null}
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
          className="fs-lobby-briefing"
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
          <button
            type="button"
            className={`${PRESS_CLASS} fs-lobby-briefing-toggle`}
            style={{ ...buttonStyle, display: narrowLobby ? "block" : "none", width: "100%" }}
            aria-expanded={briefingOpen}
            aria-controls="lobby-operation-briefing"
            onClick={() => setBriefingOpen((open) => !open)}
          >
            {briefingOpen ? "Hide briefing" : "Operation briefing"}
          </button>
          <div
            id="lobby-operation-briefing"
            className="fs-lobby-briefing-content"
            hidden={narrowLobby && !briefingOpen}
          >
            <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1 }}>Operation briefing</div>
            <h3
              className="fs-candle"
              style={{
                margin: "10px 0 8px",
                font: `600 31px/1.1 ${FONT_DISPLAY}`,
                textShadow: "0 2px 18px rgba(255, 190, 107, 0.2)",
              }}
            >
              Blend into the Curiosity Shop
            </h3>
            <div style={{ width: 160, height: 1, background: "rgba(176,138,74,.4)", margin: "2px 0 4px" }} aria-hidden />
            <p style={{ margin: 0, maxWidth: 520, opacity: 0.74, lineHeight: 1.7 }}>
              Mimics forge a convincing object and choose a hiding place. Inspectors wait in Security, then spend limited warrants finding the players.
            </p>
            <div className="fs-lobby-briefing-steps" style={{ margin: "auto 0", display: "grid", gap: 10, padding: "24px 0" }}>
            {[
              ["01", "Get ready", "Inspectors can move around the Security Office."],
              ["02", "Forge", "Mimics shape, panel, pose, and paint."],
              ["03", "Hunt", "Every wrong accusation burns a warrant."],
            ].map(([number, title, copy]) => (
              <div key={number} style={{ display: "grid", gridTemplateColumns: "38px 82px 1fr", gap: 10, alignItems: "baseline", paddingTop: 9, borderTop: RULE }}>
                <span style={{ color: BRASS_LIT, font: `600 19px/1 ${FONT_DISPLAY}`, opacity: 0.9 }}>{number}</span>
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
        </div>

        {settings === undefined ? null : (
          <div className="fs-lobby-settings" style={{ ...plateStyle, gridArea: "settings", width: "auto", padding: "12px 18px" }}>
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
                <SettingRow label="Extra warrants">
                  <select
                    aria-label="Extra warrants"
                    style={settingSelectStyle}
                    value={settings.warrantsBonus}
                    disabled={!canEditSettings}
                    onChange={(event) => {
                      onSettingsChange?.({ warrantsBonus: Number(event.target.value) });
                    }}
                  >
                    {[0, 1, 2, 3, 4].map((bonus) => (
                      <option key={bonus} value={bonus}>
                        {bonus === 0 ? "None" : `+${String(bonus)} each`}
                      </option>
                    ))}
                  </select>
                </SettingRow>
                <div style={{ ...labelStyle, marginTop: 10, opacity: 0.72 }}>
                  {roleSplitCopy(state.roster.length, settings.seekerCount)}
                </div>
              </div>
            ) : null}
          </div>
        )}

        <div className="fs-lobby-roster" style={{ ...plateStyle, ...rosterPlateStyle, gridArea: "roster" }}>
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
