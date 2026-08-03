import type { CSSProperties, ReactElement } from "react";

import type { RoomBrowserProps } from "./RoomBrowser";
import { FoldedObjectMark } from "./FoldedObjectMark";
import {
  ALARM,
  BRASS_LIT,
  CREAM,
  FONT_DISPLAY,
  FONT_UI,
  PRESS_CLASS,
  SCREEN_WASH,
  disabledButtonStyle,
  labelStyle,
  ornamentRuleStyle,
  plate,
  primaryButtonStyle,
} from "./rounds/theme";

const screenStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "grid",
  gridTemplateRows: "76px minmax(0, 1fr) 48px",
  pointerEvents: "auto",
  color: CREAM,
  font: `13px/1.5 ${FONT_UI}`,
  background: [
    "linear-gradient(90deg, rgba(7, 5, 3, .96) 0%, rgba(10, 7, 4, .86) 31%, rgba(9, 7, 5, .43) 62%, rgba(8, 6, 4, .83) 100%)",
    SCREEN_WASH,
  ].join(", "),
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 24,
  padding: "0 clamp(24px, 4vw, 68px)",
  borderBottom: "1px solid rgba(176, 138, 74, .22)",
  background: "rgba(8, 6, 4, .48)",
};

const navButtonStyle: CSSProperties = {
  width: "100%",
  padding: "13px 0 13px 17px",
  borderTop: 0,
  borderRight: 0,
  borderBottom: "1px solid rgba(176, 138, 74, .16)",
  borderLeft: "2px solid transparent",
  background: "transparent",
  color: "rgba(232, 221, 205, .66)",
  textAlign: "left",
  font: `600 12px/1.25 ${FONT_UI}`,
  letterSpacing: ".17em",
  textTransform: "uppercase",
  cursor: "pointer",
};

const featureStyle: CSSProperties = {
  ...plate(),
  padding: "clamp(20px, 2.5vw, 34px)",
  borderRadius: 2,
  minWidth: 0,
  background:
    "linear-gradient(155deg, rgba(79, 53, 25, .54), rgba(18, 13, 8, .9) 60%), radial-gradient(circle at 86% 10%, rgba(216, 173, 99, .2), transparent 36%)",
};

export interface CommandMenuProps {
  readonly multiplayer: boolean;
  readonly starting: boolean;
  readonly notice: string | null;
  readonly browser: RoomBrowserProps | null;
  readonly onPlay: () => void;
  readonly onMatchmaking: () => void;
  readonly onHowToPlay: () => void;
  readonly onSettings: () => void;
}

/** Full-screen command layer between the title and a selected game mode. */
export function CommandMenu({
  multiplayer,
  starting,
  notice,
  browser,
  onPlay,
  onMatchmaking,
  onHowToPlay,
  onSettings,
}: CommandMenuProps): ReactElement {
  const joinable = browser?.rooms.filter((room) => room.joinable).length ?? 0;
  const primary = browser === null ? onPlay : onMatchmaking;
  return (
    <div style={screenStyle} aria-label="Main menu">
      <header style={headerStyle}>
        <h1
          style={{
            margin: 0,
            font: `600 28px/1 ${FONT_DISPLAY}`,
            letterSpacing: ".12em",
            textTransform: "uppercase",
          }}
        >
          <span style={{ color: BRASS_LIT }}>Fold</span>
          <span style={{ opacity: 0.55 }}> &amp; </span>
          <span style={{ fontWeight: 400 }}>Seek</span>
        </h1>
        <div style={{ textAlign: "right" }}>
          <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 0.84 }}>Curator console</div>
          <div style={{ ...labelStyle, marginTop: 4, opacity: 0.42 }}>
            {multiplayer ? "Portals network online" : "Solo session"}
          </div>
        </div>
      </header>

      <main className="fs-command-grid">
        <nav className="fs-command-nav" aria-label="Main navigation">
          <div style={{ ...labelStyle, color: BRASS_LIT, margin: "0 0 16px 17px" }}>Play</div>
          <button
            type="button"
            className="fs-menu-nav-button"
            style={{ ...navButtonStyle, borderLeftColor: BRASS_LIT, color: CREAM }}
            onClick={primary}
            disabled={starting}
          >
            {browser === null ? "Start game" : "Matchmaking"}
          </button>
          <button type="button" className="fs-menu-nav-button" style={navButtonStyle} onClick={onHowToPlay}>
            How to play
          </button>
          <button type="button" className="fs-menu-nav-button" style={navButtonStyle} onClick={onSettings}>
            Settings
          </button>
          <div
            style={{
              marginTop: "auto",
              padding: "18px 17px",
              borderTop: "1px solid rgba(176,138,74,.16)",
            }}
          >
            <div style={{ ...labelStyle, opacity: 0.45 }}>Session</div>
            <div style={{ marginTop: 7, color: BRASS_LIT }}>
              {browser === null ? (starting ? "Connecting…" : "Solo ready") : `${browser.rooms.length} rooms live`}
            </div>
          </div>
        </nav>

        <section className="fs-command-hero fs-rise">
          <FoldedObjectMark />
          <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 0.9 }}>Featured operation</div>
          <h2
            style={{
              maxWidth: 760,
              margin: "12px 0 14px",
              font: `600 clamp(42px, 6vw, 86px)/.96 ${FONT_DISPLAY}`,
              letterSpacing: "-.025em",
              textShadow: "0 8px 34px rgba(0,0,0,.7)",
            }}
          >
            Hide in a room full of alibis.
          </h2>
          <p style={{ maxWidth: 590, margin: "0 0 28px", fontSize: 15, lineHeight: 1.75, opacity: 0.76 }}>
            Fold a mechanical body into the shop’s clutter, or hunt the one object whose story
            does not hold up. Every round changes who hides and who carries the warrants.
          </p>
          <button
            type="button"
            className={PRESS_CLASS}
            style={
              starting
                ? disabledButtonStyle({ ...primaryButtonStyle, minWidth: 245, padding: "12px 24px" })
                : { ...primaryButtonStyle, minWidth: 245, padding: "12px 24px" }
            }
            onClick={primary}
            disabled={starting}
          >
            {starting ? "Connecting…" : browser === null ? "Begin solo round" : "Find a lobby"}
          </button>
        </section>

        <aside style={featureStyle} className="fs-command-feature">
          <div style={{ ...labelStyle, color: BRASS_LIT }}>Network briefing</div>
          <h3 style={{ margin: "10px 0 8px", font: `600 26px/1.1 ${FONT_DISPLAY}` }}>
            {browser === null ? "Private opening" : "Public rooms"}
          </h3>
          <p style={{ margin: 0, opacity: 0.66, lineHeight: 1.65 }}>
            {browser === null
              ? "Open a local shop with bots while the network is unavailable."
              : `${joinable} joinable room${joinable === 1 ? "" : "s"} are advertising now.`}
          </p>
          <div style={{ ...ornamentRuleStyle("100%"), margin: "22px 0" }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={labelStyle}>Roles</div>
              <div style={{ marginTop: 5 }}>Mimic / Inspector</div>
            </div>
            <div>
              <div style={labelStyle}>Players</div>
              <div style={{ marginTop: 5 }}>2–12</div>
            </div>
          </div>
          {notice === null ? null : (
            <div
              role="alert"
              style={{
                marginTop: 22,
                padding: "10px 12px",
                borderLeft: `3px solid ${ALARM}`,
                background: "rgba(200, 80, 60, 0.12)",
                color: "#f0b8ab",
                fontSize: 12,
              }}
            >
              {notice}
            </div>
          )}
        </aside>
      </main>

      <footer style={{ ...headerStyle, borderBottom: 0, borderTop: "1px solid rgba(176,138,74,.18)" }}>
        <span style={{ ...labelStyle, opacity: 0.36 }}>The Curiosity Shop</span>
        <span style={{ ...labelStyle, color: BRASS_LIT, opacity: 0.62 }}>Fold &amp; Seek</span>
      </footer>
    </div>
  );
}
