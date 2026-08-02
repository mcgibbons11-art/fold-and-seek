import { useState, type CSSProperties, type ReactElement } from "react";

import { ControlsLegend } from "./ControlsLegend";
import {
  CORE_CONTROL_HINTS,
  HIDER_CONTROL_HINTS,
  INSPECTOR_ROLE_HINTS,
} from "./rounds/huntControls";
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
 * The rules card is taller than the title card and has to work on a short
 * viewport, so it scrolls inside itself the way the lobby column does — the
 * back button must never sit below the fold.
 */
const rulesCardStyle: CSSProperties = {
  ...cardStyle,
  width: 460,
  textAlign: "left",
  maxHeight: "min(78vh, 640px)",
  overflowY: "auto",
};

const rulesHeadingStyle: CSSProperties = {
  margin: "18px 0 6px",
  font: `600 13px/1.3 ${FONT_UI}`,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: BRASS_LIT,
};

const rulesBodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.65,
  opacity: 0.85,
};

/** The rules, told in the order a first round meets them. */
function HowToPlay({ onBack }: { readonly onBack: () => void }): ReactElement {
  return (
    <div style={rulesCardStyle} className="fs-rise">
      <div style={{ textAlign: "center" }}>
        <div style={{ ...labelStyle, opacity: 0.7, marginBottom: 8 }}>How to play</div>
        <div style={{ ...ornamentRuleStyle(180), margin: "0 auto" }} aria-hidden />
      </div>

      <h3 style={rulesHeadingStyle}>The setup</h3>
      <p style={rulesBodyStyle}>
        Each round, one player is the Inspector. Everyone else is a Mimic: a small mechanical
        body loose in a shop full of clutter, whose only defence is looking like it belongs
        there.
      </p>

      <h3 style={rulesHeadingStyle}>The forge</h3>
      <p style={rulesBodyStyle}>
        While the Inspector waits behind the office door, Mimics have a few minutes to build a
        disguise. Drag your limbs to fold into the shape of something on the shelves, stretch
        and reshape your parts, then paint yourself to match — the eyedropper copies any colour
        in the room, and the brush covers you in it. Lock your disguise before the timer runs
        out, and stand where a thing like you would stand.
      </p>

      <h3 style={rulesHeadingStyle}>The hunt</h3>
      <p style={rulesBodyStyle}>
        The office door opens and the Inspector steps out carrying a gun and a handful of
        warrants. Every shot is an accusation: hit a hiding Mimic and they are caught, hit an
        innocent object and a warrant is gone. Mimics are not frozen — you can creep between
        hiding spots, climb the shelves, and taunt the Inspector for the nerve of it. Move only
        while unwatched. Movement is how they catch you.
      </p>

      <h3 style={rulesHeadingStyle}>Winning</h3>
      <p style={rulesBodyStyle}>
        Mimics score for surviving the inspection, for every sweep that passes them by, and for
        bold taunts. The Inspector scores for each catch and keeps points for unspent warrants.
        Roles rotate, so everyone gets a turn with the gun.
      </p>

      <h3 style={rulesHeadingStyle}>Mimic controls</h3>
      <ControlsLegend hints={HIDER_CONTROL_HINTS} />

      <h3 style={rulesHeadingStyle}>Inspector controls</h3>
      <ControlsLegend hints={INSPECTOR_ROLE_HINTS} />

      <button
        type="button"
        className={PRESS_CLASS}
        style={{ ...buttonStyle, ...buttonBlock, marginTop: 20 }}
        onClick={onBack}
      >
        Back
      </button>
    </div>
  );
}

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
  onPlayRound,
  onForgePractice,
  starting = false,
  multiplayer = false,
  notice = null,
}: MainMenuProps): ReactElement {
  const [showRules, setShowRules] = useState(false);

  if (showRules) {
    return (
      <div style={overlayStyle}>
        <HowToPlay onBack={() => setShowRules(false)} />
      </div>
    );
  }

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
          {starting ? "Opening the shop…" : multiplayer ? "Join the room" : "Start game"}
        </button>
        <button
          type="button"
          className={PRESS_CLASS}
          style={{ ...(starting ? disabledButtonStyle(buttonStyle) : buttonStyle), ...buttonBlock }}
          onClick={() => setShowRules(true)}
          disabled={starting}
        >
          How to play
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

        {/* Which room this is, and nothing else. The line used to read
            "SOLO · WEBGL2 · ` FOR DIAGNOSTICS": the graphics backend and the
            key that shows it are both already in the diagnostics overlay that
            backquote opens, and neither is anything a player is being asked to
            decide. */}
        <div style={{ ...labelStyle, opacity: 0.4, marginTop: 20, letterSpacing: "0.1em" }}>
          {multiplayer ? "Portals room" : "Playing solo"}
        </div>
      </div>
    </div>
  );
}
