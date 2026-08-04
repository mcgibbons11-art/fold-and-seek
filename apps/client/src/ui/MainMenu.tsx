import { useState, type CSSProperties, type ReactElement } from "react";
import {
  SCORE_INSPECTOR_PER_CORRECT,
  SCORE_INSPECTOR_PER_FOCUSED_OBJECT,
  SCORE_INSPECTOR_PER_SECOND_REMAINING_ON_WIN,
  SCORE_INSPECTOR_PER_WRONG,
  SCORE_MIMIC_CLOSE_PASS_JACKPOT,
  SCORE_MIMIC_FULL_ROUND_SURVIVAL,
  SCORE_MIMIC_PER_CLOSE_PASS,
  SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE,
  SCORE_MIMIC_PER_OBSERVED_TAUNT,
  SCORE_MIMIC_PER_PEER_STYLE_VOTE,
  SCORE_MIMIC_PER_SURVIVAL_SECOND,
  SCORE_MIMIC_TAUNT_STREAK_STEP,
} from "@foldseek/game-sim";

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
  RULE,
  FONT_DISPLAY,
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

/** The big serif title every menu card opens with, kicker above, rule below. */
function CardMasthead({ kicker, title }: { readonly kicker: string; readonly title: string }): ReactElement {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 0.85, marginBottom: 6 }}>{kicker}</div>
      <h2
        className="fs-candle"
        style={{
          margin: "0 0 10px",
          font: `600 30px/1.1 ${FONT_DISPLAY}`,
          letterSpacing: "0.14em",
          textIndent: "0.14em",
          textTransform: "uppercase",
          color: CREAM,
          textShadow: "0 2px 18px rgba(255, 190, 107, 0.22)",
        }}
      >
        {title}
      </h2>
      <div style={{ ...ornamentRuleStyle(200), margin: "0 auto" }} aria-hidden />
    </div>
  );
}

/** One line of the tariff: what a deed pays, printed from the real weights. */
function ScoreRow({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0", borderTop: RULE }}>
      <span style={{ opacity: 0.78 }}>{label}</span>
      <span style={{ color: BRASS_LIT, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

/** The rules, told in the order a first round meets them. */
function HowToPlay({ onBack }: { readonly onBack: () => void }): ReactElement {
  return (
    <div style={{ ...rulesCardStyle, width: 860 }} className="fs-rise">
      <CardMasthead kicker="Field manual" title="How to Play" />

      <p style={{ ...rulesBodyStyle, marginTop: 16, textAlign: "center", maxWidth: 560, marginLeft: "auto", marginRight: "auto" }}>
        One Inspector hunts the Mimics hidden among the shop clutter. Roles rotate each round,
        and the sections below let you learn only what you need next.
      </p>

      <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1, marginTop: 22, textAlign: "center" }}>
        The tariff · what every deed pays
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 12,
          marginTop: 10,
        }}
      >
        <div style={{ ...plate(), borderRadius: 10, padding: "12px 16px" }}>
          <div style={{ font: `600 15px/1.3 ${FONT_DISPLAY}`, color: CREAM, marginBottom: 6 }}>
            Hiding pays for nerve
          </div>
          <div style={rulesBodyStyle}>
            <ScoreRow label="Every second you survive" value={`+${SCORE_MIMIC_PER_SURVIVAL_SECOND}`} />
            <ScoreRow label="Stared at directly and still missed" value={`+${SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE}`} />
            <ScoreRow label="A seeker brushes right past you" value={`+${SCORE_MIMIC_PER_CLOSE_PASS}`} />
            <ScoreRow label={`… a third pass by the same seeker`} value={`+${SCORE_MIMIC_CLOSE_PASS_JACKPOT} once`} />
            <ScoreRow label="A taunt performed while watched" value={`+${SCORE_MIMIC_PER_OBSERVED_TAUNT}`} />
            <ScoreRow label={`… each consecutive watched taunt`} value={`+${SCORE_MIMIC_TAUNT_STREAK_STEP} extra`} />
            <ScoreRow label="Never caught at the final bell" value={`+${SCORE_MIMIC_FULL_ROUND_SURVIVAL}`} />
            <ScoreRow label="Each style award vote" value={`+${SCORE_MIMIC_PER_PEER_STYLE_VOTE}`} />
          </div>
        </div>
        <div style={{ ...plate(), borderRadius: 10, padding: "12px 16px" }}>
          <div style={{ font: `600 15px/1.3 ${FONT_DISPLAY}`, color: CREAM, marginBottom: 6 }}>
            Hunting pays for judgement
          </div>
          <div style={rulesBodyStyle}>
            <ScoreRow label="Each Mimic exposed" value={`+${SCORE_INSPECTOR_PER_CORRECT}`} />
            <ScoreRow label="Each warrant wasted on furniture" value={`−${SCORE_INSPECTOR_PER_WRONG}`} />
            <ScoreRow label="Every second left on a win" value={`+${SCORE_INSPECTOR_PER_SECOND_REMAINING_ON_WIN}`} />
            <ScoreRow label="Each distinct object examined" value={`+${SCORE_INSPECTOR_PER_FOCUSED_OBJECT}`} />
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.6, lineHeight: 1.6 }}>
              A wrong shot also loses the warrant, and the hunt ends on the
              clock — hiders win whatever ammunition remains.
            </div>
          </div>
        </div>
      </div>

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
      <CardMasthead kicker="The back room" title="Settings" />

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
      <CardMasthead kicker="The ledger" title="Profile & History" />
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
