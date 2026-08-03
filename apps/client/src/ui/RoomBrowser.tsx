import { MatchPhase } from "@foldseek/shared";
import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

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
  overflowX: "auto",
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
  padding: "11px 8px",
  borderTop: RULE,
  cursor: "pointer",
};

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
  readonly onCreate: (name: string) => void;
  readonly onQuickJoin: () => void;
  readonly onForgePractice?: () => void;
  readonly busy?: boolean;
  readonly notice?: string | null;
  readonly onAcceptRequest?: (connectionId: string) => void;
  readonly onDeclineRequest?: (connectionId: string) => void;
  readonly onCancelRequest?: () => void;
  /** Returns to the title without dropping the shared directory session. */
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
  onAcceptRequest,
  onDeclineRequest,
  onCancelRequest,
  onBack,
}: RoomBrowserProps): ReactElement {
  const [name, setName] = useState("");
  const [selectedCode, setSelectedCode] = useState<string | null>(rooms[0]?.code ?? null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (pendingRequests.length === 0 && outgoingRequest === null) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [outgoingRequest, pendingRequests.length]);

  useEffect(() => {
    if (rooms.length === 0) {
      setSelectedCode(null);
    } else if (!rooms.some((room) => room.code === selectedCode)) {
      setSelectedCode(rooms[0]?.code ?? null);
    }
  }, [rooms, selectedCode]);

  const full = rooms.length >= MAX_CONCURRENT_ROOMS;
  const anyJoinable = rooms.some((room) => room.joinable);
  const selected = rooms.find((room) => room.code === selectedCode) ?? rooms[0] ?? null;
  const secondsLeft = (expiresAt: number): string => {
    const seconds = Math.max(0, Math.ceil((expiresAt - nowMs) / 1_000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const submitRoom = (): void => {
    if (busy || full || currentCode !== null || outgoingRequest !== null) return;
    onCreate(name);
    setName("");
  };

  return (
    <div style={screenStyle} className="fs-matchmaking-screen" aria-label="Matchmaking lobby">
      <header style={headerStyle} className="fs-matchmaking-header">
        <div>
          <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 0.85 }}>
            Online · Matchmaking
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
              Return to title
            </button>
          )}
        </div>
      </header>

      <main style={columnsStyle} className="fs-matchmaking-columns">
        <section style={columnStyle} aria-label="Open rooms">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <h2 style={{ margin: 0, font: `600 18px/1.2 ${FONT_DISPLAY}` }}>Open rooms</h2>
            <span style={metaStyle}>{rooms.length} found</span>
          </div>
          <div style={{ ...ornamentRuleStyle("100%"), margin: "10px 0 4px" }} aria-hidden />
          {rooms.length === 0 ? (
            <p style={{ margin: "14px 2px", fontSize: 12, lineHeight: 1.7, opacity: 0.7 }}>
              Nobody has opened a room yet. Open one and everyone in this Portals session will see it here.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {rooms.map((room) => {
                const mine = room.code === currentCode;
                const humans = Math.max(0, room.players - room.bots);
                const selectedRow = room.code === selected?.code;
                return (
                  <li
                    key={room.code}
                    style={{
                      ...rowStyle,
                      background: selectedRow ? "rgba(176, 138, 74, 0.14)" : "transparent",
                      borderLeft: selectedRow ? `3px solid ${BRASS_LIT}` : "3px solid transparent",
                    }}
                    onClick={() => {
                      setSelectedCode(room.code);
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={nameStyle}>{room.name}</div>
                      <div style={metaStyle}>
                        {room.code} · {roomStatus(room.phase)}
                      </div>
                    </div>
                    <div style={countStyle}>
                      {humans}/{room.maxPlayers}
                    </div>
                    <button
                      type="button"
                      className={PRESS_CLASS}
                      style={
                        busy || mine || outgoingRequest !== null || !room.joinable
                          ? disabledButtonStyle(smallButtonStyle)
                          : smallButtonStyle
                      }
                      disabled={busy || mine || outgoingRequest !== null || !room.joinable}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!mine) onJoin(room.code);
                      }}
                    >
                      {mine
                        ? "Hosting"
                        : outgoingRequest?.roomCode === room.code
                          ? "Pending"
                          : room.joinable
                            ? "Request"
                            : "Full"}
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
                              onClick={() => onAcceptRequest?.(request.id)}
                            >
                              Accept player
                            </button>
                            <button
                              type="button"
                              className={PRESS_CLASS}
                              style={{ ...smallButtonStyle, flex: 1 }}
                              onClick={() => onDeclineRequest?.(request.id)}
                            >
                              Not now
                            </button>
                          </div>
                        </div>
                      ))
                    )}
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
                {busy ? "Opening…" : selected.joinable ? "Request to join" : "Room full"}
              </button>
              )}
            </>
          )}
        </section>

        <section style={columnStyle} aria-label="Matchmaking actions">
          <h2 style={{ margin: 0, font: `600 18px/1.2 ${FONT_DISPLAY}` }}>Matchmaking</h2>
          <div style={{ ...ornamentRuleStyle("100%"), margin: "10px 0 14px" }} aria-hidden />
          <button
            type="button"
            className={PRESS_CLASS}
            style={
              busy || outgoingRequest !== null || currentCode !== null || !anyJoinable
                ? disabledButtonStyle({ ...primaryButtonStyle, width: "100%" })
                : { ...primaryButtonStyle, width: "100%" }
            }
            disabled={busy || outgoingRequest !== null || currentCode !== null || !anyJoinable}
            onClick={onQuickJoin}
          >
            Quick join
          </button>

          <div
            style={{ marginTop: 22, paddingTop: 16, borderTop: RULE }}
          >
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
          </div>

          {onForgePractice === undefined ? null : (
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

          {notice === null ? null : (
            <p
              role="alert"
              style={{ margin: "16px 0 0", color: "#e6a08e", fontSize: 12, lineHeight: 1.5 }}
            >
              {notice}
            </p>
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
