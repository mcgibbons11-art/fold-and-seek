import type { ReactElement, ReactNode } from "react";

import {
  HIDER_CREEP_HINT,
  INSPECTOR_FORGE_GOAL,
  INSPECTOR_FORGE_LABEL,
  INSPECTOR_FORGE_PLACE,
} from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import { overlayStyle } from "./theme";

/**
 * Phase chrome for the Forge (§5.7, §5.8): the countdown, the phase headline,
 * and the locked state. The Forge's own tools render inside `children`, which
 * keeps the authoring surface and the round clock in separate hands.
 *
 * Inspectors spend this phase shut in the Security Office with none of the
 * tools, so it is their phase that this component has the most to say about.
 * §41.1 headlines it FOLD, which is a verb they have nothing to do; for them it
 * is MEMORIZE, and the goal stands under the clock for the whole minute rather
 * than being said once at the role card and taken away.
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

function phaseLabel(state: RoundViewState): string | null {
  return state.self.role === "inspector" ? INSPECTOR_FORGE_LABEL : state.phaseLabel;
}

function phaseNote(self: RoundViewState["self"]): string | null {
  if (self.role === "inspector") return `${INSPECTOR_FORGE_PLACE} · ${INSPECTOR_FORGE_GOAL}`;
  if (!self.disguiseLocked) return null;
  const lock = self.ownDisguise?.autoLocked === true ? "Locked for you" : "Locked";
  return `${lock} · ${HIDER_CREEP_HINT}`;
}

export function ForgePhaseHud({ state, children }: ForgePhaseHudProps): ReactElement {
  return (
    <div style={overlayStyle}>
      <PhaseTimer timer={state.timer} label={phaseLabel(state)} note={phaseNote(state.self)} />
      {children}
    </div>
  );
}
