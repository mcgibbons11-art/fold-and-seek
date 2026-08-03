import { useCallback, useSyncExternalStore, type CSSProperties, type ReactElement } from "react";

import type { SoundCaption } from "../audio/soundCaptions";
import { getPlayerPreferences, subscribePlayerPreferences } from "../gameplay/preferences";
import { ALARM, BRASS_LIT, CREAM, FONT_UI, plate } from "./rounds/theme";

export function SoundCaptionHud({ captions }: { readonly captions: readonly SoundCaption[] }): ReactElement | null {
  const preferences = useSyncExternalStore(
    useCallback((listener: () => void) => subscribePlayerPreferences(listener), []),
    getPlayerPreferences,
  );
  captions = preferences.soundCaptionMode === "off"
    ? []
    : preferences.soundCaptionMode === "critical"
      ? captions.filter((caption) => caption.importance === "critical")
      : captions;
  if (captions.length === 0) return null;
  const root: CSSProperties = {
    position: "absolute",
    zIndex: 106,
    left: "50%",
    bottom: 54,
    transform: "translateX(-50%)",
    display: "grid",
    justifyItems: "center",
    gap: 5,
    width: "min(520px, calc(100vw - 28px))",
    pointerEvents: "none",
  };
  return (
    <div role="log" aria-live="polite" aria-label="Sound captions" style={root}>
      {captions.map((caption) => (
        <div
          key={caption.id}
          style={{
            ...plate(),
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderRadius: 7,
            padding: "6px 10px",
            color: caption.importance === "critical" ? ALARM : CREAM,
            font: `600 11px/1.25 ${FONT_UI}`,
            letterSpacing: ".06em",
          }}
        >
          {caption.bearingRad === null ? null : (
            <span
              aria-hidden
              style={{ color: BRASS_LIT, fontSize: 16, transform: `rotate(${caption.bearingRad}rad)` }}
            >
              ↑
            </span>
          )}
          <span>{caption.label}{caption.count > 1 ? ` ×${caption.count}` : ""}</span>
        </div>
      ))}
    </div>
  );
}
