import { useState, type CSSProperties, type ReactElement } from "react";

import { getMasterVolume, setMasterVolume } from "../forge/AudioPlayer";
import { QUALITY_TIER_ORDER, type QualityTier } from "../rendering/quality";
import { ControlsLegend } from "./ControlsLegend";
import { CommandMenu } from "./CommandMenu";
import { HotkeyGuide } from "./HotkeyGuide";
import { RoomBrowser, type RoomBrowserProps } from "./RoomBrowser";
import {
  CORE_CONTROL_HINTS,
  HIDER_CONTROL_HINTS,
  INSPECTOR_ROLE_HINTS,
} from "./rounds/huntControls";
import {
  BRASS_LIT,
  CREAM,
  FONT_UI,
  PRESS_CLASS,
  SCREEN_WASH,
  buttonStyle,
  labelStyle,
  ornamentRuleStyle,
  plate,
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
  position: "fixed",
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
  // The room browser can add several rows to this card, so it scrolls inside
  // itself the way the rules card does rather than running off a short screen.
  maxHeight: "min(88vh, 760px)",
  overflowY: "auto",
};

const buttonBlock: CSSProperties = { display: "block", width: "100%", marginTop: 10 };

/**
 * The rules card is taller than the title card and has to work on a short
 * viewport, so it scrolls inside itself the way the lobby column does — the
 * back button must never sit below the fold.
 */
const rulesCardStyle: CSSProperties = {
  ...cardStyle,
  width: 680,
  textAlign: "left",
  maxHeight: "min(82vh, 720px)",
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
      <ControlsLegend hints={CORE_CONTROL_HINTS} />
      <ControlsLegend hints={HIDER_CONTROL_HINTS} />

      <h3 style={rulesHeadingStyle}>Inspector controls</h3>
      <ControlsLegend hints={INSPECTOR_ROLE_HINTS} />

      <h3 style={rulesHeadingStyle}>Hotkeys</h3>
      <p style={rulesBodyStyle}>
        Fast switching is part of hiding well: use the Forge keys directly instead of reopening
        a panel for every change.
      </p>
      <HotkeyGuide />

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

const QUALITY_TIER_LABELS: Readonly<Record<QualityTier, string>> = {
  light: "Lightest",
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};

const qualityChipStyle: CSSProperties = {
  ...buttonStyle,
  padding: "7px 9px",
  fontSize: 10,
  letterSpacing: "0.08em",
  flex: 1,
};

function Settings({
  tier,
  onTierChange,
  onBack,
}: {
  readonly tier: QualityTier;
  readonly onTierChange: (tier: QualityTier) => void;
  readonly onBack: () => void;
}): ReactElement {
  const [volume, setVolume] = useState(() => getMasterVolume());

  return (
    <div style={{ ...rulesCardStyle, width: 430 }} className="fs-rise">
      <div style={{ textAlign: "center" }}>
        <div style={{ ...labelStyle, opacity: 0.7, marginBottom: 8 }}>Settings</div>
        <div style={{ ...ornamentRuleStyle(180), margin: "0 auto" }} aria-hidden />
      </div>

      <h3 style={rulesHeadingStyle}>Graphics quality</h3>
      <div role="group" aria-label="Graphics quality" style={{ display: "flex", gap: 5 }}>
        {[...QUALITY_TIER_ORDER].reverse().map((value) => (
          <button
            key={value}
            type="button"
            className={PRESS_CLASS}
            aria-pressed={tier === value}
            style={
              tier === value
                ? {
                    ...qualityChipStyle,
                    borderColor: BRASS_LIT,
                    color: "#fff3df",
                    background:
                      "linear-gradient(180deg, rgba(194, 151, 79, 0.45), rgba(122, 93, 46, 0.3))",
                  }
                : qualityChipStyle
            }
            onClick={() => {
              onTierChange(value);
            }}
          >
            {QUALITY_TIER_LABELS[value]}
          </button>
        ))}
      </div>
      <p style={{ ...rulesBodyStyle, marginTop: 8 }}>
        Changes apply immediately. Lightest removes the most expensive room effects.
      </p>

      <h3 style={rulesHeadingStyle}>Master volume</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 12 }}>
        <input
          aria-label="Master volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            setVolume(next);
            setMasterVolume(next);
          }}
          style={{ width: "100%", accentColor: BRASS_LIT }}
        />
        <span style={{ minWidth: 38, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {Math.round(volume * 100)}%
        </span>
      </div>

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

export interface MainMenuProps {
  readonly onPlayRound: () => void;
  readonly qualityTier: QualityTier;
  readonly onQualityTierChange: (tier: QualityTier) => void;
  /** Set while the shop is being unpacked, so the round is not started twice. */
  readonly starting?: boolean;
  /** Why the last attempt did not open a round. Null hides the line. */
  readonly notice?: string | null;
  /**
   * The session's rooms and the ways into one. Present only once this client is
   * in the relay session: until then there is nothing to browse, and the menu
   * offers the single play button it always did.
   */
  readonly browser?: RoomBrowserProps | null;
}

export function MainMenu({
  onPlayRound,
  qualityTier,
  onQualityTierChange,
  starting = false,
  notice = null,
  browser = null,
}: MainMenuProps): ReactElement {
  const [page, setPage] = useState<"main" | "rules" | "settings" | "matchmaking">("main");

  if (page === "matchmaking" && browser !== null) {
    return <RoomBrowser {...browser} onBack={() => {
      browser.onBack?.();
      setPage("main");
    }} />;
  }

  if (page === "rules") {
    return (
      <div style={overlayStyle}>
        <HowToPlay onBack={() => setPage("main")} />
      </div>
    );
  }

  if (page === "settings") {
    return (
      <div style={overlayStyle}>
        <Settings
          tier={qualityTier}
          onTierChange={onQualityTierChange}
          onBack={() => setPage("main")}
        />
      </div>
    );
  }

  return (
    <CommandMenu
      starting={starting}
      notice={notice}
      browser={browser}
      onPlay={onPlayRound}
      onMatchmaking={() => setPage("matchmaking")}
      onHowToPlay={() => setPage("rules")}
      onSettings={() => setPage("settings")}
    />
  );
}
