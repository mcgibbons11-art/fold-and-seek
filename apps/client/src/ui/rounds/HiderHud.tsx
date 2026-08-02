import type { ReactElement, ReactNode } from "react";

import {
  DECEPTION_TITLE,
  deceptionLabel,
  HIDER_CREEP_HINT,
  TAUNT_LABEL,
} from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import {
  ALARM,
  BRASS,
  buttonStyle,
  disabledButtonStyle,
  labelStyle,
  overlayStyle,
  panelStyle,
  primaryButtonStyle,
} from "./theme";

/**
 * What a disguised Mimic sees while the Inspectors hunt. The disguise is not a
 * cage: the hider can still creep and still bait, and movement is exactly what
 * gives them away, which is the tension the phase runs on.
 *
 * The Forge tools stay with their owner and render through `children`.
 */

/**
 * The three tension readings the simulation can report (§5.12). The wording is
 * the contract's own: level 1 is the Inspector's cone, level 2 is being held at
 * close range. Until the Phase 3 geometry lands the authority only ever reports
 * 0 or 2, so the middle state is built but rarely seen.
 */
const WATCHED_COPY = ["Unobserved", "In the cone", "Held at close range"] as const;

export interface HiderHudProps {
  readonly state: RoundViewState;
  readonly onTaunt: () => void;
  /** The hider's own tools, owned elsewhere. */
  readonly children?: ReactNode;
}

export function HiderHud({ state, onTaunt, children }: HiderHudProps): ReactElement {
  const level = state.self.watchedLevel;
  const caught = state.self.lifeState !== "active";
  const accent = level === 2 ? ALARM : BRASS;
  const tauntGate = state.actions.taunt;
  const cooldownSeconds = Math.ceil(state.self.tauntCooldownMs / 1_000);
  // Only ever this hider's own score: the director fills it in for the owner of
  // the disguise and for nobody else, which is what keeps it from being a hint.
  const deception = state.deception;
  const latest = deception.recent[0];

  return (
    <div style={overlayStyle}>
      <PhaseTimer
        timer={state.timer}
        label={state.timer.finalTen ? state.phaseLabel : null}
        note={caught ? "Found" : null}
      />
      {children}

      <div style={{ ...panelStyle, top: 16, left: 16, pointerEvents: "none", width: 200 }}>
        <div style={labelStyle}>{caught ? "Status" : "In the room"}</div>
        <div style={{ marginTop: 4, opacity: 0.85 }}>
          {caught ? "OBJECT STATUS REVOKED" : HIDER_CREEP_HINT}
        </div>

        <div style={{ ...labelStyle, marginTop: 14 }}>Being watched</div>
        <div
          style={{ display: "flex", gap: 4, marginTop: 6 }}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={2}
          aria-valuenow={level}
          aria-valuetext={WATCHED_COPY[level]}
        >
          {[1, 2].map((segment) => (
            <div
              key={segment}
              style={{
                flex: 1,
                height: 6,
                borderRadius: 3,
                background: level >= segment ? accent : "rgba(232, 221, 205, 0.14)",
                transition: "background 120ms linear",
              }}
            />
          ))}
        </div>
        <div style={{ ...labelStyle, marginTop: 4, color: level === 2 ? ALARM : undefined }}>
          {WATCHED_COPY[level]}
        </div>

        {deception.points > 0 ? (
          <>
            <div style={{ ...labelStyle, marginTop: 14 }}>{DECEPTION_TITLE}</div>
            <div style={{ font: "600 22px/1.2 system-ui, sans-serif", color: BRASS }}>
              {deception.points}
            </div>
            {latest === undefined ? null : (
              <div style={{ ...labelStyle, marginTop: 2, color: BRASS }}>
                {deceptionLabel(latest.kind)} +{latest.points}
              </div>
            )}
            <div style={{ ...labelStyle, marginTop: 4 }}>
              {deception.directLookEscapes} seen · {deception.closePasses} passed
            </div>
          </>
        ) : null}
      </div>

      {state.capabilities.taunt ? (
        <div
          style={{
            ...panelStyle,
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <button
            type="button"
            style={tauntGate.allowed ? primaryButtonStyle : disabledButtonStyle(buttonStyle)}
            disabled={!tauntGate.allowed}
            onClick={onTaunt}
          >
            {TAUNT_LABEL}
          </button>
          <span style={labelStyle}>
            {tauntGate.reason === "taunt_cooldown"
              ? `${cooldownSeconds}s`
              : "Bait them into wasting a round."}
          </span>
        </div>
      ) : null}

      <div style={{ ...panelStyle, bottom: 24, left: 16, pointerEvents: "none" }}>
        <div style={labelStyle}>Still standing</div>
        <div style={{ font: "600 22px/1.2 system-ui, sans-serif", color: BRASS }}>
          {state.mimicsRemaining}
        </div>
      </div>
    </div>
  );
}
