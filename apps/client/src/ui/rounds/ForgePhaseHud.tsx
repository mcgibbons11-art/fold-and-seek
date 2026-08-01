import type { ReactElement, ReactNode } from "react";

import { HIDER_CREEP_HINT } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import { BRASS, labelStyle, overlayStyle, panelStyle } from "./theme";

/**
 * Phase chrome for the Forge (§5.7, §5.8): the countdown, the FOLD headline,
 * and the locked state. The Forge's own tools render inside `children`, which
 * keeps the authoring surface and the round clock in separate hands.
 *
 * Inspectors spend this phase in the Security Office and see the same clock
 * with none of the tools, which is what the empty children case covers.
 */

export interface ForgePhaseHudProps {
  readonly state: RoundViewState;
  /** The Forge tool HUD, owned elsewhere. */
  readonly children?: ReactNode;
}

export function ForgePhaseHud({ state, children }: ForgePhaseHudProps): ReactElement {
  const { self } = state;
  const note =
    self.role === "inspector"
      ? "Security Office"
      : self.disguiseLocked
        ? "Disguise locked"
        : null;

  return (
    <div style={overlayStyle}>
      <PhaseTimer timer={state.timer} label={state.phaseLabel} note={note} />
      {children}
      {self.disguiseLocked && self.role === "mimic" ? (
        <div
          style={{
            ...panelStyle,
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            pointerEvents: "none",
            textAlign: "center",
          }}
        >
          <div style={{ ...labelStyle, color: BRASS }}>
            {self.ownDisguise?.autoLocked === true ? "Locked for you" : "Locked"}
          </div>
          <div style={{ marginTop: 4, opacity: 0.85 }}>{HIDER_CREEP_HINT}</div>
        </div>
      ) : null}
    </div>
  );
}
