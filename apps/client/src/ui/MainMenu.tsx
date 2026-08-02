import type { CSSProperties, ReactElement } from "react";

import { ControlsLegend } from "./ControlsLegend";
import { CORE_CONTROL_HINTS } from "./rounds/huntControls";
import {
  ALARM,
  BRASS,
  BRASS_LIT,
  CREAM,
  FONT_DISPLAY,
  FONT_UI,
  PRESS_CLASS,
  SCREEN_WASH,
  buttonStyle,
  disabledButtonStyle,
  labelStyle,
  ornamentRuleStyle,
  plate,
  primaryButtonStyle,
} from "./rounds/theme";

/**
 * The title screen. The reading nook goes on sweeping behind it, so the first
 * thing a player sees is the shop itself with a brass plate laid over it rather
 * than a splash image.
 *
 * It carries the controls. FOLD & SEEK is nobody's second game of this kind, and
 * a player who reaches the shop without knowing that the left button is the
 * camera spends the Forge phase discovering it; the legend costs one panel here
 * and saves that.
 */

const overlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeContent: "center",
  pointerEvents: "none",
  background: SCREEN_WASH,
  color: CREAM,
  font: `14px/1.6 ${FONT_UI}`,
};

const cardStyle: CSSProperties = {
  ...plate(true),
  pointerEvents: "auto",
  borderRadius: 14,
  padding: "30px 34px 26px",
  width: 400,
  maxWidth: "88vw",
  textAlign: "center",
};

const buttonBlock: CSSProperties = { display: "block", width: "100%", marginTop: 10 };

/**
 * The wordmark, set the way the cover art sets it: FOLD in lit brass, SEEK in
 * cream, and the ampersand between them smaller and dimmer so the two words read
 * as a pair rather than a list.
 */
function Wordmark(): ReactElement {
  return (
    <h1
      style={{
        margin: 0,
        font: `600 40px/1.05 ${FONT_DISPLAY}`,
        letterSpacing: "0.1em",
        // Letter-spacing hangs off the final glyph, which throws a centred line
        // to the left by half of it.
        textIndent: "0.1em",
        textShadow: "0 2px 18px rgba(255, 190, 107, 0.28)",
      }}
    >
      <span style={{ color: BRASS_LIT }}>FOLD</span>
      <span style={{ color: BRASS, fontSize: 28, opacity: 0.8, margin: "0 0.14em" }}>&amp;</span>
      <span style={{ color: CREAM, fontWeight: 400 }}>SEEK</span>
    </h1>
  );
}

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
      <div style={cardStyle} className="fs-rise">
        <div className="fs-candle">
          <div style={{ ...labelStyle, opacity: 0.7, marginBottom: 10 }}>The Curiosity Shop</div>
          <Wordmark />
        </div>

        <div style={{ ...ornamentRuleStyle(200), margin: "16px auto 14px" }} aria-hidden />

        <p style={{ margin: "0 0 20px", fontSize: 13, lineHeight: 1.65, opacity: 0.8 }}>
          One of the objects in this room is a person. Fold yourself into the furniture, or hunt
          whatever is lying.
        </p>

        <button
          type="button"
          className={PRESS_CLASS}
          style={{ ...(starting ? disabledButtonStyle(primaryButtonStyle) : primaryButtonStyle), ...buttonBlock }}
          onClick={onPlayRound}
          disabled={starting}
        >
          {starting ? "Opening the shop…" : multiplayer ? "Join the room" : "Play a round"}
        </button>
        <button
          type="button"
          className={PRESS_CLASS}
          style={{ ...(starting ? disabledButtonStyle(buttonStyle) : buttonStyle), ...buttonBlock }}
          onClick={onForgePractice}
          disabled={starting}
        >
          Forge Practice
        </button>

        {notice === null ? null : (
          <div
            role="alert"
            style={{
              marginTop: 14,
              padding: "8px 12px",
              borderRadius: 7,
              borderLeft: `3px solid ${ALARM}`,
              background: "rgba(200, 80, 60, 0.12)",
              color: "#f0b8ab",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            {notice}
          </div>
        )}

        <div style={{ marginTop: 22 }}>
          <ControlsLegend hints={CORE_CONTROL_HINTS} />
        </div>

        <div style={{ ...labelStyle, opacity: 0.4, marginTop: 20, letterSpacing: "0.1em" }}>
          {multiplayer ? "Portals room" : "Solo"} · {backend} · ` for diagnostics
        </div>
      </div>
    </div>
  );
}
