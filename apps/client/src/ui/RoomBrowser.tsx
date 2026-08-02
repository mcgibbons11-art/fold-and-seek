import { MatchPhase } from "@foldseek/shared";
import { useState, type CSSProperties, type ReactElement } from "react";

import { MAX_CONCURRENT_ROOMS, type RoomListing } from "../networking/roomRegistry";
import {
  BRASS_LIT,
  CREAM,
  FONT_UI,
  PRESS_CLASS,
  RULE,
  buttonStyle,
  disabledButtonStyle,
  labelStyle,
  ornamentRuleStyle,
  primaryButtonStyle,
} from "./rounds/theme";

/**
 * The rooms in this Portals session, and the three ways into one.
 *
 * A session carries a small fixed number of rooms rather than a directory of
 * them (networking/roomRegistry.ts), so this is a short list on the title card
 * rather than a screen of its own: every room the session can hold is visible at
 * once, and the panel says so when both slots are taken instead of offering a
 * CREATE that would be refused.
 */

/**
 * What a room is doing, in one word a player can scan down a column. The
 * round's own phase headlines are written to be read one at a time in the middle
 * of a match ("THE ROOM CONFESSES"), which is the wrong register for a list.
 */
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

const panelStyle: CSSProperties = {
  marginTop: 18,
  paddingTop: 4,
  textAlign: "left",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "9px 2px",
  borderTop: RULE,
};

const nameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
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
  flex: 1,
  minWidth: 0,
  background: "rgba(10, 8, 5, 0.55)",
  border: "1px solid rgba(176, 138, 74, 0.38)",
  borderRadius: 7,
  padding: "8px 10px",
  color: CREAM,
  font: `13px/1.3 ${FONT_UI}`,
  pointerEvents: "auto",
};

export interface RoomBrowserProps {
  readonly rooms: readonly RoomListing[];
  /** The room this client is already in, so its row reads as the one to return to. */
  readonly currentCode?: string | null;
  readonly onJoin: (code: string) => void;
  readonly onCreate: (name: string) => void;
  readonly onQuickJoin: () => void;
  /** Set while a room is being opened, so nothing is pressed twice. */
  readonly busy?: boolean;
}

export function RoomBrowser({
  rooms,
  currentCode = null,
  onJoin,
  onCreate,
  onQuickJoin,
  busy = false,
}: RoomBrowserProps): ReactElement {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const full = rooms.length >= MAX_CONCURRENT_ROOMS;
  const anyJoinable = rooms.some((room) => room.joinable);

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ ...labelStyle, opacity: 0.7 }}>Rooms</div>
        <div style={{ ...labelStyle, opacity: 0.4 }}>
          {rooms.length} of {MAX_CONCURRENT_ROOMS}
        </div>
      </div>
      <div style={{ ...ornamentRuleStyle("100%"), margin: "8px 0 2px" }} aria-hidden />

      {rooms.length === 0 ? (
        <p style={{ margin: "10px 0 0", fontSize: 12, lineHeight: 1.6, opacity: 0.7 }}>
          Nobody has opened a room yet. Open one and the others in this session will see it.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "2px 0 0", padding: 0 }}>
          {rooms.map((room) => {
            const mine = room.code === currentCode;
            const heads = Math.max(0, room.players - room.bots);
            return (
              <li key={room.code} style={rowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={nameStyle}>{room.name}</div>
                  <div style={metaStyle}>
                    {room.code} · {roomStatus(room.phase)}
                    {room.bots > 0 ? ` · ${room.bots} bot${room.bots === 1 ? "" : "s"}` : ""}
                    {room.seekers > 1 ? " · 2 inspectors" : ""}
                  </div>
                </div>
                <div style={countStyle}>
                  {heads}/{room.maxPlayers}
                </div>
                <button
                  type="button"
                  className={PRESS_CLASS}
                  style={
                    busy || (!room.joinable && !mine)
                      ? disabledButtonStyle(smallButtonStyle)
                      : smallButtonStyle
                  }
                  disabled={busy || (!room.joinable && !mine)}
                  onClick={() => {
                    onJoin(room.code);
                  }}
                >
                  {mine ? "Return" : room.joinable ? "Join" : "Full"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button
          type="button"
          className={PRESS_CLASS}
          style={
            busy || !anyJoinable
              ? disabledButtonStyle({ ...primaryButtonStyle, flex: 1 })
              : { ...primaryButtonStyle, flex: 1 }
          }
          disabled={busy || !anyJoinable}
          onClick={onQuickJoin}
        >
          Quick join
        </button>
        <button
          type="button"
          className={PRESS_CLASS}
          style={busy || full ? disabledButtonStyle(smallButtonStyle) : smallButtonStyle}
          disabled={busy || full}
          onClick={() => {
            setCreating((open) => !open);
          }}
          aria-expanded={creating}
        >
          New room
        </button>
      </div>

      {full ? (
        <p style={{ ...labelStyle, opacity: 0.5, marginTop: 10, letterSpacing: "0.08em" }}>
          This session holds {MAX_CONCURRENT_ROOMS} rooms at once. Join one, or wait for a room to
          empty.
        </p>
      ) : null}

      {creating && !full ? (
        <form
          style={{ display: "flex", gap: 8, marginTop: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            onCreate(name);
            setName("");
            setCreating(false);
          }}
        >
          <input
            style={inputStyle}
            value={name}
            maxLength={24}
            placeholder="Name your room"
            aria-label="Room name"
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <button
            type="submit"
            className={PRESS_CLASS}
            style={busy ? disabledButtonStyle(smallButtonStyle) : smallButtonStyle}
            disabled={busy}
          >
            Open
          </button>
        </form>
      ) : null}
    </div>
  );
}
