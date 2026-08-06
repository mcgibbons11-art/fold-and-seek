import { MatchPhase } from "@foldseek/shared";
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

import { AudioPlayer } from "../forge/AudioPlayer";
import { MAX_CONCURRENT_ROOMS, type RoomListing } from "../networking/roomRegistry";
import type {
  OutgoingRoomJoinRequest,
  PendingRoomJoinRequest,
} from "../networking/PortalsNetAdapter";
import {
  BRASS_LIT,
  CREAM,
  FONT_DISPLAY,
  FONT_UI,
  PRESS_CLASS,
  RULE,
  SCREEN_WASH,
  buttonStyle,
  disabledButtonStyle,
  labelStyle,
  ornamentRuleStyle,
  plate,
  primaryButtonStyle,
} from "./rounds/theme";

/** Compact activity copy for the room list and selected-room briefing. */
function roomStatus(phase: MatchPhase): string {
  switch (phase) {
    case MatchPhase.Lobby:
      return "Waiting";
    case MatchPhase.Loading:
    case MatchPhase.MapIntro:
    case MatchPhase.RoleReveal:
    case MatchPhase.BaselineScan:
      return "Starting";
    case MatchPhase.Forge:
    case MatchPhase.Locking:
      return "Folding";
    case MatchPhase.InspectionIntro:
    case MatchPhase.Inspection:
    case MatchPhase.FinalCountdown:
      return "Hunting";
    default:
      return "Finishing";
  }
}

const screenStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "grid",
  gridTemplateRows: "82px minmax(0, 1fr) 50px",
  background: [
    "linear-gradient(90deg, rgba(8, 6, 4, .94), rgba(13, 9, 5, .68) 55%, rgba(7, 5, 3, .88))",
    SCREEN_WASH,
  ].join(", "),
  color: CREAM,
  font: `13px/1.5 ${FONT_UI}`,
  pointerEvents: "auto",
  textAlign: "left",
  zIndex: 20,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 20,
  padding: "16px 26px",
  borderBottom: RULE,
  background: "linear-gradient(180deg, rgba(20, 15, 10, 0.96), rgba(15, 11, 7, 0.86))",
};

const columnsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(280px, 0.9fr) minmax(380px, 1.35fr) minmax(270px, 0.82fr)",
  gap: 14,
  minHeight: 0,
  padding: 14,
  overflow: "hidden",
};

const columnStyle: CSSProperties = {
  ...plate(),
  minWidth: 0,
  minHeight: 0,
  borderRadius: 10,
  padding: 16,
  overflowY: "auto",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  boxSizing: "border-box",
  padding: "11px 8px",
  color: "inherit",
  font: "inherit",
  textAlign: "left",
  background: "transparent",
  border: 0,
  borderTop: RULE,
  cursor: "pointer",
};

function noticeCategory(notice: string): "Network" | "Room" {
  return /not connected|reconnect|network|transport|shared|publish|advertis|listing|multiplayer is unavailable/i.test(notice)
    ? "Network"
    : "Room";
}

const nameStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  font: `600 13px/1.3 ${FONT_UI}`,
  color: CREAM,
};

const metaStyle: CSSProperties = {
  ...labelStyle,
  opacity: 0.6,
  whiteSpace: "nowrap",
};

const countStyle: CSSProperties = {
  font: `600 13px/1.3 ${FONT_UI}`,
  fontVariantNumeric: "tabular-nums",
  color: BRASS_LIT,
  whiteSpace: "nowrap",
};

const smallButtonStyle: CSSProperties = {
  ...buttonStyle,
  padding: "6px 12px",
  fontSize: 10,
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "rgba(10, 8, 5, 0.62)",
  border: "1px solid rgba(176, 138, 74, 0.38)",
  borderRadius: 7,
  padding: "9px 10px",
  color: CREAM,
  font: `13px/1.3 ${FONT_UI}`,
  pointerEvents: "auto",
};

export interface RoomBrowserProps {
  readonly rooms: readonly RoomListing[];
  readonly currentCode?: string | null;
  readonly pendingRequests?: readonly PendingRoomJoinRequest[];
  readonly outgoingRequest?: OutgoingRoomJoinRequest | null;
  readonly onJoin: (code: string) => void;
  /** `open` hosts a room whose joiners are admitted without approval. */
  readonly onCreate: (name: string, open: boolean) => void;
  readonly onQuickJoin: () => void;
  readonly onForgePractice?: () => void;
  readonly busy?: boolean;
  readonly notice?: string | null;
  /** Repeats the last room action after a recoverable refusal. */
  readonly onRetryNotice?: () => void;
  /** Rebuilds the live Portals room directory after a transport failure. */
  readonly onReconnect?: () => void;
  /** Clears the current notice without changing rooms. */
  readonly onDismissNotice?: () => void;
  readonly onAcceptRequest?: (connectionId: string) => void;
  readonly onDeclineRequest?: (connectionId: string) => void;
  readonly onCancelRequest?: () => void;
  /** Retires this client's advertised room and declines any waiting guests. */
  readonly onCancelHostedRoom?: () => void;
  /** Returns to the main menu and closes any room/request owned by this client. */
  readonly onBack?: () => void;
}

export function RoomBrowser({
  rooms,
  currentCode = null,
  pendingRequests = [],
  outgoingRequest = null,
  onJoin,
  onCreate,
  onQuickJoin,
  onForgePractice,
  busy = false,
  notice = null,
  onRetryNotice,
  onReconnect,
  onDismissNotice,
  onAcceptRequest,
  onDeclineRequest,
  onCancelRequest,
  onCancelHostedRoom,
  onBack,
}: RoomBrowserProps): ReactElement {
  const [name, setName] = useState("");
  /** Host an open door (no approval step) or vet each arrival. */
  const [hostOpenDoor, setHostOpenDoor] = useState(false);
  const [selectedCode, setSelectedCode] = useState<string | null>(rooms[0]?.code ?? null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [customOpen, setCustomOpen] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const requestAudio = useRef<AudioPlayer | null>(null);
  const recoveryPendingRef = useRef(false);
  const dismissalHandledRef = useRef(false);
  const roomRowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const noticeActionRef = useRef<HTMLButtonElement | null>(null);
  const seenRequests = useRef(new Set<string>());
  const previousCurrentCode = useRef(currentCode);
  const previousNotice = useRef(notice);

  useEffect(() => {
    requestAudio.current = new AudioPlayer(undefined, 0.5, "ui");
    return () => requestAudio.current?.dispose();
  }, []);

  useEffect(() => {
    for (const request of pendingRequests) {
      if (seenRequests.current.has(request.id)) continue;
      seenRequests.current.add(request.id);
      requestAudio.current?.play("ui_confirm");
    }
  }, [pendingRequests]);

  useEffect(() => {
    if (previousCurrentCode.current === null && currentCode !== null) {
      requestAudio.current?.play("ui_confirm");
    }
    previousCurrentCode.current = currentCode;
  }, [currentCode]);

  useEffect(() => {
    if (notice === null || notice === previousNotice.current) return;
    requestAudio.current?.play(/declin|expir|cancel|fail|unavailable/i.test(notice) ? "ui_deny" : "ui_confirm");
    previousNotice.current = notice;
  }, [notice]);

  useEffect(() => {
    recoveryPendingRef.current = false;
    dismissalHandledRef.current = false;
    setRecoveryPending(false);
    if (notice !== dismissedNotice) setDismissedNotice(null);
    if (notice === null) return;
    window.requestAnimationFrame(() => noticeActionRef.current?.focus());
  }, [notice]);

  useEffect(() => {
    if (pendingRequests.length === 0 && outgoingRequest === null) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [outgoingRequest, pendingRequests.length]);

  useEffect(() => {
    if (rooms.length === 0) {
      setSelectedCode(null);
    } else if (currentCode !== null && rooms.some((room) => room.code === currentCode)) {
      // Hosting is an active state, not merely another directory result. Keep
      // its controls in reach even when an older room happened to be selected
      // before this room advertisement arrived from the relay.
      setSelectedCode(currentCode);
    } else if (!rooms.some((room) => room.code === selectedCode)) {
      setSelectedCode(rooms[0]?.code ?? null);
    }
  }, [currentCode, rooms, selectedCode]);

  useEffect(() => {
    if (onBack === undefined) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  const full = rooms.length >= MAX_CONCURRENT_ROOMS;
  const selected = rooms.find((room) => room.code === selectedCode) ?? rooms[0] ?? null;
  const visibleNotice = notice === dismissedNotice ? null : notice;
  const recoveryKind = visibleNotice === null ? null : noticeCategory(visibleNotice);
  const secondsLeft = (expiresAt: number): string => {
    const seconds = Math.max(0, Math.ceil((expiresAt - nowMs) / 1_000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const submitRoom = (): void => {
    if (busy || full || currentCode !== null || outgoingRequest !== null) return;
    onCreate(name, hostOpenDoor);
    setName("");
  };
  const moveRoomFocus = (index: number, direction: -1 | 1): void => {
    if (rooms.length === 0) return;
    const nextIndex = (index + direction + rooms.length) % rooms.length;
    const next = rooms[nextIndex];
    if (next === undefined) return;
    setSelectedCode(next.code);
    roomRowRefs.current[nextIndex]?.focus();
  };
  const recover = (action: (() => void) | undefined): void => {
    if (recoveryPendingRef.current || action === undefined) return;
    recoveryPendingRef.current = true;
    setRecoveryPending(true);
    action();
  };
  const dismissNotice = (): void => {
    if (visibleNotice === null || dismissalHandledRef.current) return;
    dismissalHandledRef.current = true;
    setDismissedNotice(visibleNotice);
    onDismissNotice?.();
    window.requestAnimationFrame(() => {
      const selectedIndex = rooms.findIndex((room) => room.code === selected?.code);
      roomRowRefs.current[Math.max(0, selectedIndex)]?.focus();
    });
  };

  return (
    <div style={screenStyle} className="fs-matchmaking-screen" aria-label="Matchmaking lobby">
      <header style={headerStyle} className="fs-matchmaking-header">
        <div>
          <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 0.85 }}>
            Online · Matchmaking · tonight’s shops
          </div>
          <div
            style={{
              marginTop: 3,
              font: `600 23px/1 ${FONT_DISPLAY}`,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            The Curiosity Shop
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ ...labelStyle, opacity: 0.55 }}>
            {rooms.length} of {MAX_CONCURRENT_ROOMS} rooms live
          </div>
          {onBack === undefined ? null : (
            <button type="button" className={PRESS_CLASS} style={smallButtonStyle} onClick={onBack}>
              Return to main menu
            </button>
          )}
        </div>
      </header>

      <main style={columnsStyle} className="fs-matchmaking-columns">
        <section style={columnStyle} className="fs-matchmaking-room-list" aria-label="Open rooms">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <h2 style={{ margin: 0, font: `600 18px/1.2 ${FONT_DISPLAY}` }}>Open rooms</h2>
            <span style={metaStyle}>{rooms.length} found</span>
          </div>
          <div style={{ ...ornamentRuleStyle("100%"), margin: "10px 0 4px" }} aria-hidden />
          {rooms.length === 0 ? (
            <div
              style={{
                margin: "18px 2px",
                padding: "18px 14px",
                borderRadius: 10,
                border: "1px dashed rgba(176, 138, 74, 0.35)",
                textAlign: "center",
              }}
            >
              <div style={{ font: `600 26px/1 ${FONT_DISPLAY}`, color: BRASS_LIT, opacity: 0.7 }} aria-hidden>
                ❖
              </div>
              <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.7, opacity: 0.72 }}>
                Nobody has opened a room yet. Open one and everyone in this
                Portals session will see it listed here within a breath.
              </div>
            </div>
          ) : (
            <ul role="listbox" aria-label="Available rooms" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {rooms.map((room, index) => {
                const mine = room.code === currentCode;
                const humans = Math.max(0, room.players - room.bots);
                const selectedRow = room.code === selected?.code;
                return (
                  <li key={room.code} role="presentation">
                    <button
                      ref={(node) => {
                        roomRowRefs.current[index] = node;
                      }}
                      type="button"
                      role="option"
                      aria-selected={selectedRow}
                      tabIndex={selectedRow ? 0 : -1}
                      aria-label={`${room.name}, ${humans} of ${room.maxPlayers}, ${room.joinable ? roomStatus(room.phase) : "Full"}`}
                      data-room-code={room.code}
                      style={{
                        ...rowStyle,
                        background: selectedRow ? "rgba(176, 138, 74, 0.14)" : "transparent",
                        borderLeft: selectedRow ? `3px solid ${BRASS_LIT}` : "3px solid transparent",
                      }}
                      onFocus={() => setSelectedCode(room.code)}
                      onClick={() => setSelectedCode(room.code)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedCode(room.code);
                        } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                          event.preventDefault();
                          moveRoomFocus(index, 1);
                        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                          event.preventDefault();
                          moveRoomFocus(index, -1);
                        } else if (event.key === "Home" || event.key === "End") {
                          event.preventDefault();
                          const targetIndex = event.key === "Home" ? 0 : rooms.length - 1;
                          const target = rooms[targetIndex];
                          if (target !== undefined) {
                            setSelectedCode(target.code);
                            roomRowRefs.current[targetIndex]?.focus();
                          }
                        }
                      }}
                    >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={nameStyle}>{room.name}</div>
                      <div style={metaStyle}>
                        {room.code} · {roomStatus(room.phase)}
                        {room.open === true ? " · open door" : ""}
                      </div>
                    </div>
                    <div style={countStyle}>
                      {humans}/{room.maxPlayers}
                    </div>
                    {mine || outgoingRequest?.roomCode === room.code || !room.joinable ? (
                      <span style={{ ...metaStyle, color: mine || outgoingRequest?.roomCode === room.code ? BRASS_LIT : undefined }}>
                        {mine ? "Hosting" : outgoingRequest?.roomCode === room.code ? "Pending" : "Full"}
                      </span>
                    ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section
          style={{
            ...columnStyle,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            background:
              "radial-gradient(100% 70% at 50% 36%, rgba(114, 78, 34, 0.28), rgba(18, 13, 8, 0.92)), linear-gradient(178deg, rgba(41, 30, 19, 0.9), rgba(13, 10, 7, 0.94))",
          }}
          className="fs-matchmaking-selected"
          aria-label="Selected room"
        >
          {selected === null ? (
            <div style={{ margin: "auto", textAlign: "center", maxWidth: 330 }}>
              <div style={{ ...labelStyle, color: BRASS_LIT }}>Waiting for a room</div>
              <h2 style={{ font: `600 28px/1.15 ${FONT_DISPLAY}`, margin: "10px 0" }}>
                Be the first host
              </h2>
              <p style={{ margin: 0, opacity: 0.72 }}>
                Name a room on the right. Its listing is shared immediately with the other players.
              </p>
            </div>
          ) : (
            <>
              <div>
                <div style={{ ...labelStyle, color: BRASS_LIT }}>
                  Selected room · {selected.code}
                </div>
                <h2 style={{ font: `600 34px/1.1 ${FONT_DISPLAY}`, margin: "12px 0 8px" }}>
                  {selected.name}
                </h2>
                <p style={{ margin: 0, opacity: 0.72 }}>
                  {roomStatus(selected.phase)} · {selected.seekers} Inspector
                  {selected.seekers === 1 ? "" : "s"} · {selected.bots} bot
                  {selected.bots === 1 ? "" : "s"}
                </p>
              </div>
              <div style={{ margin: "auto 0", padding: "28px 0" }}>
                <div style={{ ...labelStyle, marginBottom: 9 }}>Lobby occupancy</div>
                <div style={{ display: "flex", gap: 5 }}>
                  {Array.from({ length: selected.maxPlayers }, (_, index) => (
                    <span
                      key={index}
                      aria-hidden
                      style={{
                        height: 7,
                        flex: 1,
                        maxWidth: 28,
                        borderRadius: 2,
                        background:
                          index < selected.players ? BRASS_LIT : "rgba(232, 221, 205, 0.12)",
                      }}
                    />
                  ))}
                </div>
                <div style={{ ...metaStyle, marginTop: 8 }}>
                  {selected.players} of {selected.maxPlayers} seats occupied
                </div>
                {selected.code === currentCode ? (
                  <div style={{ marginTop: 24 }}>
                    <div style={{ ...labelStyle, marginBottom: 8 }}>
                      Join requests · {pendingRequests.length}
                    </div>
                    {pendingRequests.length === 0 ? (
                      <p style={{ margin: 0, opacity: 0.68 }}>
                        Your room is live. Waiting for another player to request entry.
                      </p>
                    ) : (
                      pendingRequests.map((request) => (
                        <div
                          key={request.id}
                          style={{ ...plate(true), borderRadius: 8, padding: 12, marginTop: 8 }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                            <strong>{request.displayName}</strong>
                            <span style={countStyle}>{secondsLeft(request.expiresAt)}</span>
                          </div>
                          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                            <button
                              type="button"
                              className={PRESS_CLASS}
                              style={{ ...primaryButtonStyle, flex: 1, padding: "8px 12px" }}
                              onClick={() => {
                                requestAudio.current?.play("ui_confirm");
                                onAcceptRequest?.(request.id);
                              }}
                              data-sound="none"
                            >
                              Accept player
                            </button>
                            <button
                              type="button"
                              className={PRESS_CLASS}
                              style={{ ...smallButtonStyle, flex: 1 }}
                              onClick={() => {
                                requestAudio.current?.play("ui_back");
                                onDeclineRequest?.(request.id);
                              }}
                              data-sound="none"
                            >
                              Not now
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                    <button
                      type="button"
                      className={PRESS_CLASS}
                      style={{
                        ...smallButtonStyle,
                        width: "100%",
                        marginTop: 14,
                        borderColor: "rgba(205, 93, 72, 0.7)",
                        color: "#ffd4ca",
                      }}
                      onClick={onCancelHostedRoom}
                    >
                      Cancel hosted room
                    </button>
                  </div>
                ) : outgoingRequest?.roomCode === selected.code ? (
                  <div style={{ ...plate(true), borderRadius: 8, padding: 14, marginTop: 24 }}>
                    <div style={{ ...labelStyle, color: BRASS_LIT }}>Request sent</div>
                    <p style={{ margin: "7px 0 12px", opacity: 0.75 }}>
                      Waiting for the host · {secondsLeft(outgoingRequest.expiresAt)}
                    </p>
                    <button
                      type="button"
                      className={PRESS_CLASS}
                      style={{ ...buttonStyle, width: "100%" }}
                      onClick={onCancelRequest}
                    >
                      Cancel request
                    </button>
                  </div>
                ) : null}
              </div>
              {selected.code === currentCode || outgoingRequest !== null ? null : (
              <button
                type="button"
                className={PRESS_CLASS}
                style={
                  busy || !selected.joinable
                    ? disabledButtonStyle({ ...primaryButtonStyle, width: "100%" })
                    : { ...primaryButtonStyle, width: "100%", padding: "12px 18px" }
                }
                disabled={busy || !selected.joinable}
                onClick={() => {
                  onJoin(selected.code);
                }}
              >
                {busy
                  ? "Opening…"
                  : !selected.joinable
                    ? "Room full"
                    : selected.open === true
                      ? "Join"
                      : "Request to join"}
              </button>
              )}
            </>
          )}
        </section>

        <section style={columnStyle} className="fs-matchmaking-actions" aria-label="Matchmaking actions">
          <h2 style={{ margin: 0, font: `600 18px/1.2 ${FONT_DISPLAY}` }}>Matchmaking</h2>
          <div style={{ ...ornamentRuleStyle("100%"), margin: "10px 0 14px" }} aria-hidden />
          <button
            type="button"
            className={PRESS_CLASS}
            style={
              busy || outgoingRequest !== null || currentCode !== null
                ? disabledButtonStyle({ ...primaryButtonStyle, width: "100%" })
                : { ...primaryButtonStyle, width: "100%" }
            }
            disabled={busy || outgoingRequest !== null || currentCode !== null}
            onClick={onQuickJoin}
          >
            Quick Match
          </button>
          <p style={{ margin: "9px 0 0", fontSize: 11, lineHeight: 1.55, opacity: 0.68 }}>
            Join the best open room, or host automatically when none are available.
          </p>

          <button
            type="button"
            className={PRESS_CLASS}
            aria-expanded={customOpen}
            style={{ ...buttonStyle, width: "100%", marginTop: 22 }}
            onClick={() => setCustomOpen((open) => !open)}
          >
            {customOpen ? "Hide custom options" : "Custom room and training"}
          </button>

          {customOpen ? <div style={{ marginTop: 12, paddingTop: 12, borderTop: RULE }}>
            <div style={{ ...labelStyle, marginBottom: 8 }}>Host a room</div>
            <input
              style={inputStyle}
              value={name}
              maxLength={24}
              placeholder="Name your room"
              aria-label="Room name"
              onChange={(event) => {
                setName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                submitRoom();
              }}
            />
            <button
              type="button"
              className={PRESS_CLASS}
              aria-pressed={hostOpenDoor}
              style={{
                ...buttonStyle,
                width: "100%",
                marginTop: 9,
                borderColor: hostOpenDoor ? BRASS_LIT : undefined,
              }}
              onClick={() => setHostOpenDoor((value) => !value)}
            >
              {hostOpenDoor ? "Open door · friends walk straight in" : "Vetted door · approve each arrival"}
            </button>
            <button
              type="button"
              className={PRESS_CLASS}
              style={
                busy || full || currentCode !== null || outgoingRequest !== null
                  ? disabledButtonStyle({ ...buttonStyle, width: "100%", marginTop: 9 })
                  : { ...buttonStyle, width: "100%", marginTop: 9 }
              }
              disabled={busy || full || currentCode !== null || outgoingRequest !== null}
              onClick={submitRoom}
            >
              {currentCode === null ? "New room" : "Room open"}
            </button>
          </div> : null}

          {!customOpen || onForgePractice === undefined ? null : (
            <div style={{ marginTop: 22, paddingTop: 16, borderTop: RULE }}>
              <div style={{ ...labelStyle, marginBottom: 8 }}>Training</div>
              <p style={{ margin: "0 0 10px", fontSize: 12, lineHeight: 1.55, opacity: 0.68 }}>
                Learn folding, painting, mirroring, and copying without a round timer.
              </p>
              <button
                type="button"
                className={PRESS_CLASS}
                style={
                  currentCode !== null || outgoingRequest !== null
                    ? disabledButtonStyle({ ...buttonStyle, width: "100%" })
                    : { ...buttonStyle, width: "100%" }
                }
                disabled={currentCode !== null || outgoingRequest !== null}
                onClick={onForgePractice}
              >
                Forge practice
              </button>
            </div>
          )}

          {visibleNotice === null ? null : (
            <div
              role="alert"
              aria-label={`${recoveryKind ?? "Room"} error`}
              className="fs-matchmaking-recovery"
              style={{ ...plate(true), marginTop: 16, padding: 12, borderRadius: 8 }}
            >
              <div style={{ ...labelStyle, color: "#e6a08e" }}>{recoveryKind} error</div>
              <p style={{ margin: "6px 0 10px", color: "#f2c4b8", fontSize: 12, lineHeight: 1.5 }}>
                {visibleNotice}
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {recoveryKind === "Network" && onReconnect !== undefined ? (
                  <button
                    ref={noticeActionRef}
                    type="button"
                    className={PRESS_CLASS}
                    style={smallButtonStyle}
                    disabled={recoveryPending}
                    onClick={() => recover(onReconnect)}
                  >
                    {recoveryPending ? "Reconnecting…" : "Reconnect"}
                  </button>
                ) : onRetryNotice !== undefined ? (
                  <button
                    ref={noticeActionRef}
                    type="button"
                    className={PRESS_CLASS}
                    style={smallButtonStyle}
                    disabled={recoveryPending}
                    onClick={() => recover(onRetryNotice)}
                  >
                    {recoveryPending ? "Retrying…" : "Retry"}
                  </button>
                ) : null}
                <button
                  ref={onReconnect === undefined && onRetryNotice === undefined ? noticeActionRef : undefined}
                  type="button"
                  className={PRESS_CLASS}
                  style={smallButtonStyle}
                  onClick={dismissNotice}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {full ? (
            <p style={{ ...labelStyle, opacity: 0.6, marginTop: 16, letterSpacing: "0.08em" }}>
              This session holds {MAX_CONCURRENT_ROOMS} rooms at once. Join one or wait for a slot.
            </p>
          ) : null}
        </section>
      </main>

      <footer
        className="fs-matchmaking-footer"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0 26px",
          borderTop: RULE,
          background: "rgba(12, 9, 6, 0.9)",
        }}
      >
        <span style={metaStyle}>Rooms update live across this Portals session</span>
        <span style={{ ...labelStyle, color: BRASS_LIT }}>Fold & Seek Online</span>
      </footer>
    </div>
  );
}
