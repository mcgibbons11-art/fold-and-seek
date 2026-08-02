import type { CSSProperties, ReactElement } from "react";

/**
 * Boot menu. The reading nook keeps sweeping behind it, so the first thing a
 * player sees is the art direction rather than a splash screen.
 */

const CREAM = "#e8ddcd";
const BRASS = "#b08a4a";

const overlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeContent: "center",
  pointerEvents: "none",
  color: CREAM,
  font: "14px/1.6 system-ui, sans-serif",
};

const cardStyle: CSSProperties = {
  pointerEvents: "auto",
  background: "rgba(10, 9, 8, 0.78)",
  border: "1px solid rgba(232, 221, 205, 0.16)",
  borderRadius: 14,
  padding: "28px 34px",
  minWidth: 320,
  backdropFilter: "blur(8px)",
  textAlign: "center",
};

const buttonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  background: "rgba(176, 138, 74, 0.24)",
  color: "#fff3df",
  border: `1px solid ${BRASS}`,
  borderRadius: 9,
  padding: "11px 14px",
  font: "inherit",
  letterSpacing: "0.08em",
  cursor: "pointer",
  marginTop: 10,
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "rgba(232, 221, 205, 0.05)",
  color: CREAM,
  border: "1px solid rgba(232, 221, 205, 0.16)",
  opacity: 0.45,
  cursor: "not-allowed",
};

export interface MainMenuProps {
  readonly backend: string;
  readonly onPlayRound: () => void;
  readonly onForgePractice: () => void;
  /** Set while the shop is being unpacked, so the round is not started twice. */
  readonly starting?: boolean;
  /**
   * True inside a Portals room, where the round is played with whoever else is
   * there rather than against this tab's bots.
   */
  readonly multiplayer?: boolean;
  /** Why the last attempt did not open a round. Null hides the line. */
  readonly notice?: string | null;
}

export function MainMenu({
  backend,
  onPlayRound,
  onForgePractice,
  starting = false,
  multiplayer = false,
  notice = null,
}: MainMenuProps): ReactElement {
  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>
        <h1 style={{ letterSpacing: "0.28em", fontSize: 20, marginBottom: 4 }}>FOLD &amp; SEEK</h1>
        <div style={{ opacity: 0.6, fontSize: 11, letterSpacing: "0.16em", marginBottom: 18 }}>
          THE CURIOSITY SHOP
        </div>
        <button
          type="button"
          style={starting ? disabledButtonStyle : buttonStyle}
          onClick={onPlayRound}
          disabled={starting}
        >
          {starting ? "Opening the shop…" : multiplayer ? "Join the room" : "Play a round"}
        </button>
        <button type="button" style={buttonStyle} onClick={onForgePractice} disabled={starting}>
          Forge Practice
        </button>
        {notice === null ? null : (
          <div style={{ color: "#e6a06a", fontSize: 12, marginTop: 14 }}>{notice}</div>
        )}
        <div style={{ opacity: 0.5, fontSize: 11, marginTop: 18 }}>
          {multiplayer ? "portals room" : "solo"} · backend {backend} · ` for diagnostics
        </div>
      </div>
    </div>
  );
}
