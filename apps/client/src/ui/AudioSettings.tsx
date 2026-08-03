import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

import {
  getAudioLevels,
  setAudioBusVolume,
  subscribeAudioMixer,
  type AudioBus,
} from "../audio/AudioMixer";
import {
  getPlayerPreferences,
  setPlayerPreferences,
  subscribePlayerPreferences,
} from "../gameplay/preferences";
import { BRASS_LIT, labelStyle } from "./rounds/theme";

const LABELS: readonly (readonly [AudioBus, string])[] = [
  ["master", "Master"],
  ["music", "Music"],
  ["ambience", "Ambience"],
  ["gameplay", "Gameplay SFX"],
  ["ui", "Interface"],
];

export function AudioSettings(): ReactElement {
  const [levels, setLevels] = useState(getAudioLevels);
  const [preferences, setPreferencesState] = useState(getPlayerPreferences);
  const previousMaster = useRef(levels.master > 0 ? levels.master : 1);
  useEffect(() => subscribeAudioMixer(() => setLevels(getAudioLevels())), []);
  useEffect(() => subscribePlayerPreferences(setPreferencesState), []);
  useEffect(() => {
    if (levels.master > 0) previousMaster.current = levels.master;
  }, [levels.master]);

  return (
    <div role="group" aria-label="Audio mix">
      <div style={{ ...labelStyle, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Audio mix</span>
        <button
          type="button"
          aria-pressed={levels.master === 0}
          onClick={() => setAudioBusVolume("master", levels.master === 0 ? previousMaster.current : 0)}
          style={{ border: 0, background: "transparent", color: BRASS_LIT, cursor: "pointer", font: "inherit" }}
        >
          {levels.master === 0 ? "Unmute all" : "Mute all"}
        </button>
      </div>
      {LABELS.map(([bus, label]) => (
        <label key={bus} style={{ display: "grid", gridTemplateColumns: "88px 1fr 38px", alignItems: "center", gap: 10, marginBottom: 8 } as CSSProperties}>
          <span>{label}</span>
          <input
            aria-label={`${label} volume`}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={levels[bus]}
            onChange={(event) => setAudioBusVolume(bus, Number(event.currentTarget.value))}
            style={{ width: "100%", accentColor: BRASS_LIT }}
          />
          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {Math.round(levels[bus] * 100)}%
          </span>
        </label>
      ))}
      <label style={{ display: "grid", gridTemplateColumns: "88px 1fr", alignItems: "center", gap: 10, marginTop: 12 } as CSSProperties}>
        <span>Captions</span>
        <select
          aria-label="Sound captions"
          value={preferences.soundCaptionMode}
          onChange={(event) => setPlayerPreferences({
            soundCaptionMode: event.currentTarget.value as "off" | "critical" | "gameplay",
          })}
          style={{ background: "#171008", color: BRASS_LIT, border: "1px solid rgba(176,138,74,.45)", borderRadius: 5, padding: "5px 7px" }}
        >
          <option value="off">Off</option>
          <option value="critical">Critical only</option>
          <option value="gameplay">All gameplay</option>
        </select>
      </label>
    </div>
  );
}
