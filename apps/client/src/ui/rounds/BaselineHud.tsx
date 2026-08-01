import type { ReactElement } from "react";

import type { RoundViewState } from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import { labelStyle, overlayStyle, panelStyle } from "./theme";

/**
 * Baseline scan (§5.6). The room is empty of people and the clock is the whole
 * interface: anything else on screen now is something the player is not
 * looking at the room with.
 */

export interface BaselineHudProps {
  readonly state: RoundViewState;
}

export function BaselineHud({ state }: BaselineHudProps): ReactElement {
  const isInspector = state.self.role === "inspector";

  return (
    <div style={overlayStyle}>
      <PhaseTimer timer={state.timer} label={state.phaseLabel} />
      <div
        style={{
          ...panelStyle,
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          pointerEvents: "none",
          textAlign: "center",
          maxWidth: 520,
        }}
      >
        <div style={labelStyle}>{isInspector ? "Inspector" : "Mimic"}</div>
        <div style={{ marginTop: 4, opacity: 0.85 }}>
          {isInspector
            ? "Walk the room and count what belongs in it."
            : "Watch what the room already contains. You will have to belong in it."}
        </div>
      </div>
    </div>
  );
}
