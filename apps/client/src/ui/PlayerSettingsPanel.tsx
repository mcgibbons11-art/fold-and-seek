import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import {
  getPlayerPreferences,
  setPlayerPreferences,
  subscribePlayerPreferences,
} from "../gameplay/preferences";
import { QUALITY_TIER_ORDER, type QualityTier } from "../rendering/quality";
import { AudioSettings } from "./AudioSettings";
import { KeyBindingPanel } from "./KeyBindingPanel";
import { BRASS_LIT, CREAM, PRESS_CLASS, buttonStyle, labelStyle, RULE } from "./rounds/theme";

const QUALITY_LABELS: Readonly<Record<QualityTier, string>> = {
  light: "Lightest", low: "Low", medium: "Medium", high: "High", ultra: "Ultra",
};

const summaryStyle: CSSProperties = {
  ...labelStyle,
  color: BRASS_LIT,
  opacity: 1,
  cursor: "pointer",
  padding: "12px 0 9px",
};

export interface PlayerSettingsPanelProps {
  readonly qualityTier: QualityTier;
  readonly onQualityTierChange: (tier: QualityTier) => void;
}

/** Shared five-category settings surface for title and live game menus. */
export function PlayerSettingsPanel({ qualityTier, onQualityTierChange }: PlayerSettingsPanelProps): ReactElement {
  const [preferences, setPreferencesState] = useState(() => getPlayerPreferences());
  useEffect(() => subscribePlayerPreferences(setPreferencesState), []);

  return (
    <div className="fs-settings-categories">
      <details open style={{ borderBottom: RULE }}>
        <summary style={summaryStyle}>Gameplay</summary>
        <Toggle label="Network diagnostics" active={preferences.showDiagnostics}
          onClick={() => setPlayerPreferences({ showDiagnostics: !preferences.showDiagnostics })} />
      </details>

      <details style={{ borderBottom: RULE }}>
        <summary style={summaryStyle}>Controls</summary>
        <Slider label="Horizontal sensitivity" value={preferences.sensitivityX} min={0.25} max={2.5} step={0.05} onChange={(sensitivityX) => setPlayerPreferences({ sensitivityX })} />
        <Slider label="Vertical sensitivity" value={preferences.sensitivityY} min={0.25} max={2.5} step={0.05} onChange={(sensitivityY) => setPlayerPreferences({ sensitivityY })} />
        <Toggle label="Invert Y" active={preferences.invertY} onClick={() => setPlayerPreferences({ invertY: !preferences.invertY })} />
        <KeyBindingPanel />
      </details>

      <details style={{ borderBottom: RULE }}>
        <summary style={summaryStyle}>Video</summary>
        <div role="group" aria-label="Graphics quality" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 5 }}>
          {[...QUALITY_TIER_ORDER].reverse().map((tier) => (
            <button key={tier} type="button" className={PRESS_CLASS} aria-pressed={qualityTier === tier}
              style={{ ...buttonStyle, padding: "7px 3px", fontSize: 9, borderColor: qualityTier === tier ? BRASS_LIT : undefined }}
              onClick={() => onQualityTierChange(tier)}>{QUALITY_LABELS[tier]}</button>
          ))}
        </div>
        <Slider label="Field of view" value={preferences.fov} min={50} max={90} step={1} onChange={(fov) => setPlayerPreferences({ fov })} />
        <Slider label="Camera motion" value={preferences.cameraMotion} min={0} max={1} step={0.05} onChange={(cameraMotion) => setPlayerPreferences({ cameraMotion })} />
        <Slider label="Impact shake" value={preferences.shake} min={0} max={1} step={0.05} onChange={(shake) => setPlayerPreferences({ shake })} />
      </details>

      <details style={{ borderBottom: RULE }}>
        <summary style={summaryStyle}>Audio</summary>
        <AudioSettings />
      </details>

      <details style={{ borderBottom: RULE }}>
        <summary style={summaryStyle}>Accessibility</summary>
        <Slider label="HUD scale" value={preferences.hudScale} min={0.85} max={1.25} step={0.05} percent onChange={(hudScale) => setPlayerPreferences({ hudScale })} />
        <Slider label="Text and caption size" value={preferences.textScale} min={0.9} max={1.3} step={0.05} percent onChange={(textScale) => setPlayerPreferences({ textScale })} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <Toggle label="Reduced motion" active={preferences.reducedMotion} onClick={() => setPlayerPreferences({ reducedMotion: !preferences.reducedMotion })} />
          <Toggle label="High contrast HUD" active={preferences.highContrastHud} onClick={() => setPlayerPreferences({ highContrastHud: !preferences.highContrastHud })} />
        </div>
        <p style={{ margin: "8px 0 0", color: CREAM, opacity: 0.72 }}>
          Ready, watched, warning, and error states always include text or a pattern; color is never the only signal.
        </p>
      </details>
    </div>
  );
}

function Toggle({ label, active, onClick }: { readonly label: string; readonly active: boolean; readonly onClick: () => void }): ReactElement {
  return <button type="button" className={PRESS_CLASS} aria-pressed={active}
    style={{ ...buttonStyle, width: "100%", marginBottom: 8, borderColor: active ? BRASS_LIT : undefined }}
    onClick={onClick}>{label} {active ? "on" : "off"}</button>;
}

function Slider({ label, value, min, max, step, percent = false, onChange }: {
  readonly label: string; readonly value: number; readonly min: number; readonly max: number;
  readonly step: number; readonly percent?: boolean; readonly onChange: (value: number) => void;
}): ReactElement {
  const reading = percent ? `${Math.round(value * 100)}%` : step >= 1 ? String(Math.round(value)) : value.toFixed(2);
  return <label style={{ display: "block", margin: "7px 0 10px" }}>
    <span style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}><span>{label}</span><span style={{ color: BRASS_LIT }}>{reading}</span></span>
    <input aria-label={label} type="range" min={min} max={max} step={step} value={value}
      onChange={(event) => onChange(Number(event.currentTarget.value))} style={{ width: "100%", accentColor: BRASS_LIT }} />
  </label>;
}
