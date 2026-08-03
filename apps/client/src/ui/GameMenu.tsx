import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import { getMasterVolume, setMasterVolume } from "../forge/AudioPlayer";
import {
  getPlayerPreferences,
  setPlayerPreferences,
  subscribePlayerPreferences,
} from "../gameplay/preferences";
import { QUALITY_TIER_ORDER, type QualityTier } from "../rendering/quality";
import { ControlsLegend } from "./ControlsLegend";
import { HotkeyGuide } from "./HotkeyGuide";
import { KeyBindingPanel } from "./KeyBindingPanel";
import { REPLAY_ONBOARDING_EVENT } from "./FirstRoundGuide";
import {
  CORE_CONTROL_HINTS,
  HIDER_CONTROL_HINTS,
  INSPECTOR_ROLE_HINTS,
} from "./rounds/huntControls";
import {
  BRASS_LIT,
  CREAM,
  FONT_DISPLAY,
  FONT_UI,
  PRESS_CLASS,
  buttonStyle,
  labelStyle,
  plate,
  primaryButtonStyle,
} from "./rounds/theme";

type MenuPage = "root" | "settings" | "howToPlay";

const QUALITY_LABELS: Readonly<Record<QualityTier, string>> = {
  light: "Lightest",
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};

const menuButtonStyle: CSSProperties = {
  ...buttonStyle,
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 120,
  width: "auto",
  margin: 0,
  padding: "7px 12px",
  fontSize: 10,
};

const pageButtonStyle: CSSProperties = { ...buttonStyle, width: "100%", marginBottom: 8 };

export interface GameMenuProps {
  readonly qualityTier: QualityTier;
  readonly onQualityTierChange: (tier: QualityTier) => void;
  readonly onLeave: () => void;
  readonly role: "mimic" | "inspector" | "spectator" | null;
}

/** One quiet entry point for help, settings, and leaving instead of three permanent HUD buttons. */
export function GameMenu(props: GameMenuProps): ReactElement {
  const [page, setPage] = useState<MenuPage | null>(null);
  const [volume, setVolume] = useState(() => getMasterVolume());
  const [preferences, setPreferencesState] = useState(() => getPlayerPreferences());

  useEffect(() => subscribePlayerPreferences(setPreferencesState), []);

  const open = (): void => {
    if (document.pointerLockElement !== null) void document.exitPointerLock();
    setPage("root");
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "F1") {
        event.preventDefault();
        if (page === null) open();
        else setPage(null);
      } else if (event.key === "Escape" && page !== null) {
        event.preventDefault();
        setPage(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [page]);

  return (
    <>
      <button type="button" className={PRESS_CLASS} style={menuButtonStyle} onClick={open}>
        Menu
      </button>
      {page === null ? null : (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Game menu"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            display: "grid",
            placeItems: "center",
            padding: 20,
            boxSizing: "border-box",
            pointerEvents: "auto",
            background: "rgba(8, 6, 4, 0.72)",
            color: CREAM,
            font: `13px/1.55 ${FONT_UI}`,
          }}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setPage(null);
          }}
        >
          <div
            style={{
              ...plate(true),
              width: "min(470px, calc(100vw - 40px))",
              maxHeight: "min(720px, calc(100vh - 40px))",
              overflowY: "auto",
              boxSizing: "border-box",
              padding: "24px 26px",
              borderRadius: 14,
              boxShadow: "0 28px 90px rgba(0, 0, 0, 0.65)",
            }}
          >
            <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1, marginBottom: 5 }}>Fold & Seek</div>
            <div style={{ font: `600 25px/1.15 ${FONT_DISPLAY}`, marginBottom: 20 }}>
              {page === "root" ? "Game menu" : page === "settings" ? "Settings" : "How to play"}
            </div>

            {page === "root" ? (
              <>
                <button type="button" className={PRESS_CLASS} style={primaryButtonStyle} onClick={() => setPage(null)}>
                  Resume
                </button>
                <button type="button" className={PRESS_CLASS} style={pageButtonStyle} onClick={() => setPage("settings")}>
                  Settings
                </button>
                <button type="button" className={PRESS_CLASS} style={pageButtonStyle} onClick={() => setPage("howToPlay")}>
                  How to play
                </button>
                <button
                  type="button"
                  className={PRESS_CLASS}
                  style={{ ...pageButtonStyle, marginTop: 18, color: "#ffc0a8" }}
                  onClick={props.onLeave}
                >
                  Leave match and return to menu
                </button>
              </>
            ) : null}

            {page === "settings" ? (
              <>
                <div style={{ ...labelStyle, marginBottom: 8 }}>Graphics quality</div>
                <div role="group" aria-label="Graphics quality" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 5 }}>
                  {[...QUALITY_TIER_ORDER].reverse().map((tier) => (
                    <button
                      key={tier}
                      type="button"
                      className={PRESS_CLASS}
                      aria-pressed={props.qualityTier === tier}
                      style={{
                        ...buttonStyle,
                        margin: 0,
                        padding: "7px 4px",
                        textAlign: "center",
                        fontSize: 9,
                        borderColor: props.qualityTier === tier ? BRASS_LIT : undefined,
                        color: props.qualityTier === tier ? "#fff3df" : CREAM,
                      }}
                      onClick={() => props.onQualityTierChange(tier)}
                    >
                      {QUALITY_LABELS[tier]}
                    </button>
                  ))}
                </div>
                <p style={{ opacity: 0.68, margin: "10px 0 20px" }}>Quality changes apply immediately.</p>
                <div style={{ ...labelStyle, marginBottom: 8 }}>Master volume</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 12, marginBottom: 20 }}>
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
                <div style={{ ...labelStyle, color: BRASS_LIT, margin: "18px 0 8px" }}>Camera and aiming</div>
                <PreferenceSlider label="Horizontal sensitivity" value={preferences.sensitivityX} min={0.25} max={2.5} step={0.05} onChange={(sensitivityX) => setPlayerPreferences({ sensitivityX })} />
                <PreferenceSlider label="Vertical sensitivity" value={preferences.sensitivityY} min={0.25} max={2.5} step={0.05} onChange={(sensitivityY) => setPlayerPreferences({ sensitivityY })} />
                <PreferenceSlider label="Field of view" value={preferences.fov} min={50} max={90} step={1} suffix="°" onChange={(fov) => setPlayerPreferences({ fov })} />
                <PreferenceSlider label="Camera motion" value={preferences.cameraMotion} min={0} max={1} step={0.05} percent onChange={(cameraMotion) => setPlayerPreferences({ cameraMotion })} />
                <PreferenceSlider label="Impact shake" value={preferences.shake} min={0} max={1} step={0.05} percent onChange={(shake) => setPlayerPreferences({ shake })} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, margin: "10px 0 20px" }}>
                  <button
                    type="button"
                    className={PRESS_CLASS}
                    aria-pressed={preferences.invertY}
                    style={{ ...buttonStyle, borderColor: preferences.invertY ? BRASS_LIT : undefined }}
                    onClick={() => setPlayerPreferences({ invertY: !preferences.invertY })}
                  >
                    Invert Y {preferences.invertY ? "on" : "off"}
                  </button>
                  <button
                    type="button"
                    className={PRESS_CLASS}
                    aria-pressed={preferences.reducedMotion}
                    style={{ ...buttonStyle, borderColor: preferences.reducedMotion ? BRASS_LIT : undefined }}
                    onClick={() => setPlayerPreferences({ reducedMotion: !preferences.reducedMotion })}
                  >
                    Reduced motion {preferences.reducedMotion ? "on" : "off"}
                  </button>
                </div>
                <button
                  type="button"
                  className={PRESS_CLASS}
                  aria-pressed={preferences.showDiagnostics}
                  style={{ ...buttonStyle, width: "100%", marginBottom: 20, borderColor: preferences.showDiagnostics ? BRASS_LIT : undefined }}
                  onClick={() => setPlayerPreferences({ showDiagnostics: !preferences.showDiagnostics })}
                >
                  Network diagnostics {preferences.showDiagnostics ? "shown" : "hidden"}
                </button>
                <button type="button" className={PRESS_CLASS} style={pageButtonStyle} onClick={() => setPage("root")}>
                  Back
                </button>
              </>
            ) : null}

            {page === "howToPlay" ? (
              <>
                <p style={{ opacity: 0.82, marginTop: 0 }}>
                  Mimics reshape, panel, and paint themselves to blend into the room. The Inspector spends a limited warrant with every shot, so accuse only what does not belong.
                </p>
                <div style={{ ...labelStyle, color: BRASS_LIT, margin: "16px 0 7px" }}>
                  {props.role === "inspector" ? "Inspector controls" : "Mimic controls"}
                </div>
                <ControlsLegend hints={props.role === "inspector" ? INSPECTOR_ROLE_HINTS : CORE_CONTROL_HINTS} />
                {props.role === "inspector" ? null : <ControlsLegend hints={HIDER_CONTROL_HINTS} />}
                <HotkeyGuide />
                <KeyBindingPanel />
                <button
                  type="button"
                  className={PRESS_CLASS}
                  style={{ ...pageButtonStyle, marginTop: 18 }}
                  onClick={() => {
                    window.dispatchEvent(new Event(REPLAY_ONBOARDING_EVENT));
                    setPage(null);
                  }}
                >
                  Replay first-round guide
                </button>
                <button type="button" className={PRESS_CLASS} style={pageButtonStyle} onClick={() => setPage("root")}>
                  Back
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function PreferenceSlider({
  label,
  value,
  min,
  max,
  step,
  suffix = "×",
  percent = false,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly suffix?: string;
  readonly percent?: boolean;
  readonly onChange: (value: number) => void;
}): ReactElement {
  const reading = percent ? `${Math.round(value * 100)}%` : `${value.toFixed(step < 1 ? 2 : 0)}${suffix}`;
  return (
    <label style={{ display: "grid", gridTemplateColumns: "1fr 54px", gap: 10, marginBottom: 10 }}>
      <span style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "space-between", fontSize: 11 }}>
        <span>{label}</span><span style={{ color: BRASS_LIT }}>{reading}</span>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ gridColumn: "1 / -1", width: "100%", accentColor: BRASS_LIT }}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}
