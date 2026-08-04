import { MatchPhase, type PlayerRole } from "@foldseek/shared";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { FORGE_UI_ATTRIBUTE, type ForgeController } from "../forge/ForgeController";
import type { RoundViewState } from "../gameplay/roundView";
import type { InspectorGunView } from "./rounds/InspectorHud";
import { BRASS_LIT, CREAM, FONT_UI, PRESS_CLASS, buttonStyle, labelStyle, plate } from "./rounds/theme";

export const REPLAY_ONBOARDING_EVENT = "foldseek:replay-onboarding";

interface FirstRoundGuideProps {
  readonly state: RoundViewState;
  readonly forge: ForgeController | null;
  readonly gun: InspectorGunView;
  readonly pointerLocked: boolean;
}

interface GuideStep {
  readonly title: string;
  readonly instruction: string;
}

const MIMIC_STEPS: readonly GuideStep[] = [
  { title: "Move", instruction: "WASD moves · Space hops/climbs · S drops a climb." },
  { title: "Shape", instruction: "Choose a preset or change your disguise." },
  { title: "Paint", instruction: "Press 5, then spray one quick mark." },
  { title: "Lock", instruction: "Press Enter when the disguise is convincing." },
];

const INSPECTOR_STEPS: readonly GuideStep[] = [
  { title: "Take control", instruction: "Click the room · move the mouse to look and aim · Esc releases the cursor." },
  { title: "Acquire", instruction: "Aim at an object until the reticle responds." },
  { title: "Get close", instruction: "WASD moves · Space hops · move inside warrant range." },
  { title: "Accuse", instruction: "Click to fire. Every shot spends a warrant." },
];

function guidePhase(role: PlayerRole, phase: MatchPhase): boolean {
  if (role === "mimic") {
    return phase === MatchPhase.Forge || phase === MatchPhase.Locking || phase === MatchPhase.InspectionIntro || phase === MatchPhase.Inspection;
  }
  return role === "inspector" && (phase === MatchPhase.InspectionIntro || phase === MatchPhase.Inspection || phase === MatchPhase.FinalCountdown);
}

/** A small checklist that advances from real gameplay actions, never from Next buttons. */
export function FirstRoundGuide({ state, forge, gun, pointerLocked }: FirstRoundGuideProps): ReactElement | null {
  const role = state.self.role;
  // Shown at the start of every NEW game, per role, and never between rematch
  // rounds (2026-08-04, user verdict). It used to write a permanent
  // localStorage flag, so one Skip months ago hid it forever; the flag is
  // gone, and the dismissal now lives only as long as the match does.
  const [dismissed, setDismissed] = useState(false);
  const [moved, setMoved] = useState(false);
  const [edited, setEdited] = useState(false);
  const [painted, setPainted] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [acquired, setAcquired] = useState(false);
  const [inRange, setInRange] = useState(false);
  const initialShots = useRef({ accusations: state.accusations.length, dryFires: gun.dryFires });

  useEffect(() => {
    const replay = (): void => setDismissed(false);
    window.addEventListener(REPLAY_ONBOARDING_EVENT, replay);
    return () => window.removeEventListener(REPLAY_ONBOARDING_EVENT, replay);
  }, []);

  // A fresh deal re-arms the guide for the next game. Rematch rounds keep it
  // away through the round guard below rather than through this reset.
  useEffect(() => {
    if (state.round === 0) setDismissed(false);
  }, [state.round]);

  useEffect(() => {
    if (role !== "mimic" || dismissed) return undefined;
    const key = (event: KeyboardEvent): void => {
      if (["w", "a", "s", "d"].includes(event.key.toLowerCase())) setMoved(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [dismissed, role]);

  useEffect(() => {
    if (role !== "mimic" || forge === null || dismissed) return undefined;
    const update = (): void => {
      const snapshot = forge.snapshot();
      if (snapshot.canUndo || snapshot.formEpoch > 0) setEdited(true);
      if (forge.paint.getState().strokeCount > 0) setPainted(true);
    };
    update();
    const unsubscribeForge = forge.subscribe(update);
    const unsubscribePaint = forge.paint.store.subscribe(update);
    return () => {
      unsubscribeForge();
      unsubscribePaint();
    };
  }, [dismissed, forge, role]);

  useEffect(() => {
    if (pointerLocked) setCaptured(true);
    if (gun.targetObjectId !== null) setAcquired(true);
    if (gun.targetInRange) setInRange(true);
  }, [gun.targetInRange, gun.targetObjectId, pointerLocked]);

  const progress = useMemo(() => {
    if (role === "mimic") return [moved, edited, painted, state.self.disguiseLocked];
    return [captured, acquired, inRange, state.accusations.length > initialShots.current.accusations || gun.dryFires > initialShots.current.dryFires];
  }, [acquired, captured, edited, gun.dryFires, inRange, moved, painted, role, state.accusations.length, state.self.disguiseLocked]);

  const complete = progress.every(Boolean);
  useEffect(() => {
    if (!complete || role === null || dismissed) return;
    const timeout = window.setTimeout(() => setDismissed(true), 1_400);
    return () => window.clearTimeout(timeout);
  }, [complete, dismissed, role]);

  // Round 0 is the start of a game; every later round is a rematch of it.
  if (state.round > 0) return null;
  if (role === null || role === "spectator" || dismissed || !guidePhase(role, state.phase)) return null;
  const steps = role === "mimic" ? MIMIC_STEPS : INSPECTOR_STEPS;
  const activeIndex = progress.findIndex((done) => !done);

  return (
    <aside
      {...{ [FORGE_UI_ATTRIBUTE]: "true" }}
      aria-label={`${role === "mimic" ? "Mimic" : "Inspector"} first-round guide`}
      style={{
        position: "absolute",
        zIndex: 105,
        left: "50%",
        bottom: 112,
        transform: "translateX(-50%)",
        width: "min(520px, calc(100vw - 32px))",
        boxSizing: "border-box",
        ...plate(),
        borderRadius: 10,
        padding: "10px 12px",
        pointerEvents: "auto",
        color: CREAM,
        font: `12px/1.4 ${FONT_UI}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1 }}>{complete ? "Training complete" : "First round"}</div>
        <button
          type="button"
          className={PRESS_CLASS}
          style={{ ...buttonStyle, padding: "4px 8px", fontSize: 9 }}
          onClick={() => {
            setDismissed(true);
          }}
        >
          Skip
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: 8 }}>
        {steps.map((step, index) => (
          <div key={step.title} style={{ opacity: progress[index] ? 0.48 : index === activeIndex ? 1 : 0.62 }}>
            <div style={{ color: progress[index] || index === activeIndex ? BRASS_LIT : CREAM, fontWeight: 700 }}>
              {progress[index] ? "✓ " : `${index + 1}. `}{step.title}
            </div>
            <div style={{ marginTop: 2 }}>{step.instruction}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
