import type { CSSProperties, ReactElement } from "react";

import type { RoundLoadProgress } from "../engine/GameHost";
import { loadingLabel } from "../gameplay/copy";
import {
  BRASS,
  BRASS_LIT,
  CREAM,
  FONT_UI,
  PRESS_CLASS,
  SCREEN_WASH,
  buttonStyle,
  headlineStyle,
  labelStyle,
  ornamentRuleStyle,
} from "./rounds/theme";

/**
 * What the player looks at while a round opens.
 *
 * The shop is built a zone at a time and every zone yields the frame back, so
 * this both animates and tells the truth: the bar is the real fraction of the
 * build that has finished, and the line under it names the piece that was just
 * put in. It sits over the menu room, which goes on rendering underneath until
 * the shop is ready to take its place.
 *
 * The percentage, the bar's width and the announced value are all the one
 * reported fraction. The sheen inside the filled bar is the only thing here that
 * is not measured, and it is inside the fill precisely so it cannot suggest
 * progress the build has not made.
 */

const backdropStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeContent: "center",
  justifyItems: "center",
  gap: 16,
  padding: 32,
  background: SCREEN_WASH,
  backdropFilter: "blur(3px)",
  color: CREAM,
  font: `13px/1.6 ${FONT_UI}`,
  pointerEvents: "auto",
};

const trackStyle: CSSProperties = {
  width: "min(420px, 70vw)",
  height: 8,
  borderRadius: 4,
  background: "rgba(8, 6, 4, 0.75)",
  border: "1px solid rgba(176, 138, 74, 0.34)",
  boxShadow: "inset 0 2px 5px rgba(0, 0, 0, 0.6)",
  overflow: "hidden",
};

export interface LoadingScreenProps {
  readonly progress: RoundLoadProgress;
  /** Stops the pending join/build and returns to the room browser or menu. */
  readonly onCancel?: () => void;
}

export function LoadingScreen({ progress, onCancel }: LoadingScreenProps): ReactElement {
  const percent = Math.round(Math.min(Math.max(progress.fraction, 0), 1) * 100);
  return (
    <div style={backdropStyle} role="status" aria-live="polite">
      <h1 style={{ ...headlineStyle, fontSize: 22 }} className="fs-candle">
        Opening the shop
      </h1>
      <div style={ornamentRuleStyle(160)} aria-hidden />
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
            background: `linear-gradient(180deg, ${BRASS_LIT} 0%, ${BRASS} 60%, #8a6a34 100%)`,
            boxShadow: "0 0 12px rgba(255, 190, 107, 0.45)",
            transition: "width 120ms linear",
          }}
        >
          <div className="fs-sheen" style={{ width: "100%", height: "100%" }} />
        </div>
      </div>
      <div style={{ ...labelStyle, opacity: 0.8 }}>
        <span style={{ color: BRASS_LIT, fontVariantNumeric: "tabular-nums" }}>{percent}%</span>
        {" · "}
        {/* The engine names its own steps, and two of them are named after the
            graphics pipeline rather than the shop. `loadingLabel` is where they
            are said in the room's words instead. */}
        {loadingLabel(progress.label)}
      </div>
      {onCancel === undefined ? null : (
        <button
          type="button"
          className={PRESS_CLASS}
          style={{ ...buttonStyle, marginTop: 6 }}
          onClick={onCancel}
        >
          Return to menu
        </button>
      )}
    </div>
  );
}
