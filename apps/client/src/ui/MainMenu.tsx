import { useState, type CSSProperties, type ReactElement } from "react";

import { type QualityTier } from "../rendering/quality";
import { loadPlayerProfile, summarizePlayerProfile } from "../gameplay/playerProfile";
import { CommandMenu } from "./CommandMenu";
import { HotkeyGuide } from "./HotkeyGuide";
import { PlayerSettingsPanel } from "./PlayerSettingsPanel";
import { RoomBrowser, type RoomBrowserProps } from "./RoomBrowser";
import { useScreenEntryFocus } from "./accessibility";
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

      <p style={{ ...rulesBodyStyle, marginTop: 16 }}>
        One Inspector hunts the Mimics hidden among the shop clutter. Roles rotate each round,
        and the four sections below let you learn only what you need next.
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

function Settings({
  tier,
  onTierChange,
  onBack,
}: {
  readonly tier: QualityTier;
  readonly onTierChange: (tier: QualityTier) => void;
  readonly onBack: () => void;
}): ReactElement {
  return (
    <div style={{ ...rulesCardStyle, width: 430 }} className="fs-rise">
      <div style={{ textAlign: "center" }}>
        <div style={{ ...labelStyle, opacity: 0.7, marginBottom: 8 }}>Settings</div>
        <div style={{ ...ornamentRuleStyle(180), margin: "0 auto" }} aria-hidden />
      </div>

      <PlayerSettingsPanel qualityTier={tier} onQualityTierChange={onTierChange} />

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

const AWARD_LABELS = {
  best_disguise: "Best disguise",
  funniest_attempt: "Funniest attempt",
  most_audacious: "Most audacious",
} as const;

function PlayerProfileCard({ onBack }: { readonly onBack: () => void }): ReactElement {
  const profile = loadPlayerProfile();
  const summary = summarizePlayerProfile(profile);
  return (
    <div style={{ ...rulesCardStyle, width: 620 }} className="fs-rise">
      <div style={{ textAlign: "center" }}>
        <div style={{ ...labelStyle, opacity: 0.7, marginBottom: 8 }}>Player profile</div>
        <div style={{ ...ornamentRuleStyle(180), margin: "0 auto" }} aria-hidden />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 18 }}>
        {[
          ["Rounds", summary.gamesPlayed],
          ["Wins", summary.wins],
          ["Awards", summary.totalAwards],
        ].map(([label, value]) => (
          <div key={label} style={{ ...plate(), padding: 12, textAlign: "center" }}>
            <div style={{ ...labelStyle, color: BRASS_LIT }}>{label}</div>
            <div style={{ marginTop: 4, fontSize: 24 }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 18, ...labelStyle, color: BRASS_LIT }}>Award cabinet</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 8 }}>
        {Object.entries(AWARD_LABELS).map(([category, label]) => (
          <div key={category} style={{ ...plate(), padding: 10 }}>
            <div style={{ fontSize: 11, opacity: 0.75 }}>{label}</div>
            <div style={{ marginTop: 3, color: BRASS_LIT }}>{summary.awards[category as keyof typeof AWARD_LABELS]}×</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 18, ...labelStyle, color: BRASS_LIT }}>Recent games</div>
      <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
        {profile.games.length === 0 ? (
          <div style={{ opacity: 0.65 }}>Completed rounds will appear here.</div>
        ) : profile.games.slice(0, 10).map((game) => (
          <div
            key={game.id}
            style={{
              display: "grid",
              gridTemplateColumns: "92px 1fr auto auto",
              gap: 12,
              alignItems: "center",
              padding: "8px 10px",
              borderBottom: "1px solid rgba(176,138,74,.16)",
            }}
          >
            <span style={{ opacity: 0.58 }}>{new Date(game.playedAt).toLocaleDateString()}</span>
            <span>{game.role === "mimic" ? "Mimic" : "Inspector"}</span>
            <span style={{ color: game.won ? BRASS_LIT : CREAM }}>{game.won ? "Win" : "Loss"}</span>
            <span>{game.score} pts · {game.awards.length} award{game.awards.length === 1 ? "" : "s"}</span>
          </div>
        ))}
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
  const [page, setPage] = useState<"main" | "rules" | "settings" | "profile" | "matchmaking">("main");
  const pageRef = useScreenEntryFocus<HTMLDivElement>(page);

  if (page === "matchmaking" && browser !== null) {
    return (
      <div ref={pageRef} style={{ display: "contents" }}>
        <RoomBrowser {...browser} onBack={() => {
          browser.onBack?.();
          setPage("main");
        }} />
      </div>
    );
  }

  if (page === "rules") {
    return (
      <div ref={pageRef} style={overlayStyle}>
        <HowToPlay onBack={() => setPage("main")} />
      </div>
    );
  }

  if (page === "settings") {
    return (
      <div ref={pageRef} style={overlayStyle}>
        <Settings
          tier={qualityTier}
          onTierChange={onQualityTierChange}
          onBack={() => setPage("main")}
        />
      </div>
    );
  }

  if (page === "profile") {
    return (
      <div ref={pageRef} style={overlayStyle}>
        <PlayerProfileCard onBack={() => setPage("main")} />
      </div>
    );
  }

  return (
    <div ref={pageRef} style={{ display: "contents" }}>
      <CommandMenu
        starting={starting}
        notice={notice}
        browser={browser}
        onPlay={onPlayRound}
        onMatchmaking={() => setPage("matchmaking")}
        onProfile={() => setPage("profile")}
        onHowToPlay={() => setPage("rules")}
        onSettings={() => setPage("settings")}
      />
    </div>
  );
}
