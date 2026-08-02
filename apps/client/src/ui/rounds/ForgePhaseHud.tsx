import type { ReactElement, ReactNode } from "react";

import { HIDER_CREEP_HINT } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import { overlayStyle } from "./theme";

/**
 * Phase chrome for the Forge (§5.7, §5.8): the countdown, the FOLD headline,
 * and the locked state. The Forge's own tools render inside `children`, which
 * keeps the authoring surface and the round clock in separate hands.
 *
 * Inspectors spend this phase in the Security Office and see the same clock
 * with none of the tools, which is what the empty children case covers.
 *
 * The lock is reported in the timer's own note rather than in a second panel.
 * The Forge already owns the bottom of the screen for its status line, and two
 * panels anchored bottom-centre draw on top of one another.
 */

export interface ForgePhaseHudProps {
  readonly state: RoundViewState;
  /** The Forge tool HUD, owned elsewhere. */
  readonly children?: ReactNode;
}

function phaseNote(self: RoundViewState["self"]): string | null {
  if (self.role === "inspector") return "Security Office";
  if (!self.disguiseLocked) return null;
  const lock = self.ownDisguise?.autoLocked === true ? "Locked for you" : "Locked";
  return `${lock} · ${HIDER_CREEP_HINT}`;
}

export function ForgePhaseHud({ state, children }: ForgePhaseHudProps): ReactElement {
  return (
    <div style={overlayStyle}>
      <PhaseTimer timer={state.timer} label={state.phaseLabel} note={phaseNote(state.self)} />
      {children}
    </div>
  );
}
