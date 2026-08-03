import type { CSSProperties, ReactElement } from "react";

import {
  BRASS_LIT,
  CREAM,
  FONT_DISPLAY,
  FONT_UI,
  PRESS_CLASS,
  SCREEN_WASH,
  labelStyle,
  ornamentRuleStyle,
  primaryButtonStyle,
} from "./rounds/theme";
import { FoldedObjectMark } from "./FoldedObjectMark";
import { useScreenEntryFocus } from "./accessibility";

const screenStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "grid",
  gridTemplateRows: "minmax(0, 1fr)",
  color: CREAM,
  font: `13px/1.5 ${FONT_UI}`,
  background: [
    "linear-gradient(90deg, rgba(7, 5, 3, 0.93) 0%, rgba(10, 7, 4, 0.78) 36%, rgba(8, 6, 4, 0.28) 68%, rgba(8, 6, 4, 0.72) 100%)",
    SCREEN_WASH,
  ].join(", "),
  pointerEvents: "auto",
  overflow: "hidden",
};

export interface StartScreenProps {
  readonly onEnter: () => void;
}

/** The deliberate first input after the renderer has finished loading. */
export function StartScreen({ onEnter }: StartScreenProps): ReactElement {
  const screenRef = useScreenEntryFocus<HTMLDivElement>("start");
  return (
    <div ref={screenRef} style={screenStyle} className="fs-start-screen" aria-label="Fold and Seek start screen">
      <main className="fs-start-content">
        <FoldedObjectMark />
        <div className="fs-rise" style={{ maxWidth: 760 }}>
          <div style={{ ...labelStyle, color: BRASS_LIT, marginBottom: 16, opacity: 0.9 }}>
            A game of impossible objects
          </div>
          <h1
            className="fs-candle"
            style={{
              margin: 0,
              font: `600 clamp(62px, 10vw, 142px)/0.82 ${FONT_DISPLAY}`,
              letterSpacing: "-0.045em",
              textTransform: "uppercase",
              textShadow: "0 10px 50px rgba(0,0,0,.72)",
            }}
          >
            <span style={{ display: "block", color: BRASS_LIT }}>Fold</span>
            <span style={{ display: "block", color: CREAM, fontWeight: 400 }}>&amp; Seek</span>
          </h1>
          <div style={{ ...ornamentRuleStyle("min(520px, 72vw)"), margin: "28px 0 20px" }} />
          <p
            style={{
              maxWidth: 540,
              margin: "0 0 28px",
              font: `18px/1.65 ${FONT_DISPLAY}`,
              color: "rgba(239, 226, 200, .82)",
            }}
          >
            Become the object nobody questions—or enter the shop with a warrant and find what
            does not belong.
          </p>
          <button
            type="button"
            className={`${PRESS_CLASS} fs-start-button`}
            style={{ ...primaryButtonStyle, minWidth: 250, padding: "13px 26px" }}
            onClick={onEnter}
            data-entry-focus="true"
          >
            Enter the shop
          </button>
        </div>
      </main>

    </div>
  );
}
