import type { CSSProperties, ReactElement } from "react";

import type { RoundLoadProgress } from "../engine/GameHost";
import { BRASS, CREAM, EDGE, headlineStyle, INK, labelStyle } from "./rounds/theme";

/**
 * What the player looks at while a round opens.
 *
 * The shop is built a zone at a time and every zone yields the frame back, so
 * this both animates and tells the truth: the bar is the real fraction of the
 * build that has finished, and the line under it names the piece that was just
 * put in. It sits over the menu room, which goes on rendering underneath until
 * the shop is ready to take its place.
 */

const backdropStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeContent: "center",
  justifyItems: "center",
  gap: 18,
  padding: 32,
  background: "rgba(8, 7, 6, 0.72)",
  backdropFilter: "blur(3px)",
  color: CREAM,
  font: "13px/1.6 system-ui, sans-serif",
  pointerEvents: "auto",
};

const trackStyle: CSSProperties = {
  width: "min(420px, 70vw)",
  height: 6,
  borderRadius: 3,
  background: INK,
  border: EDGE,
  overflow: "hidden",
};

export interface LoadingScreenProps {
  readonly progress: RoundLoadProgress;
}

export function LoadingScreen({ progress }: LoadingScreenProps): ReactElement {
  const percent = Math.round(Math.min(Math.max(progress.fraction, 0), 1) * 100);
  return (
    <div style={backdropStyle} role="status" aria-live="polite">
      <h1 style={headlineStyle}>Opening the shop</h1>
      <div
        style={trackStyle}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          style={{
            width: `${String(percent)}%`,
            height: "100%",
            background: BRASS,
            transition: "width 120ms linear",
          }}
        />
      </div>
      <div style={{ ...labelStyle, opacity: 0.75 }}>
        {percent}% · {progress.label}
      </div>
    </div>
  );
}
