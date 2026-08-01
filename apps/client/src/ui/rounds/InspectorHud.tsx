import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import {
  AMMO_COOLDOWN_PROMPT,
  AMMO_EMPTY_PROMPT,
  AMMO_LABEL,
  AMMO_NO_TARGET_PROMPT,
  AMMO_OUT_OF_RANGE_PROMPT,
  AMMO_READY_PROMPT,
} from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { PhaseTimer } from "./PhaseTimer";
import { Toast, rejectionToast, type ToastEntry } from "./Toast";
import { ALARM, BRASS, CREAM, EDGE, INK, labelStyle, overlayStyle, panelStyle } from "./theme";

/**
 * Inspector HUD (§5.9). The Inspector carries a warrant gun, so time,
 * ammunition and the reticle are the whole instrument: how many warrant rounds
 * are left, whether the thing in the sights can be shot from here, and what the
 * last shot turned out to be.
 *
 * Nothing here outlines a prop for the player. §8.7 wants the room looked at
 * rather than scanned, so the reticle only reports what is already under it.
 */

/** Mirrors the firing driver's phase in the inspector module. */
export type GunAimState = "idle" | "aiming" | "holding" | "pending" | "cooldown";

/**
 * Local gun state, owned by the inspector controller. Ammunition appears here
 * only as the driver's own belief; what the HUD counts is the authority's
 * warrant count in RoundViewState, which is the number that can be spent.
 */
export interface InspectorGunView {
  readonly state: GunAimState;
  readonly targetObjectId: string | null;
  /** Metres to the target, for the range read. Null without a target. */
  readonly targetDistanceM: number | null;
  /** True when the target is close enough and legal to fire on. */
  readonly targetInRange: boolean;
  /** Trigger hold, 0 to 1. */
  readonly triggerProgress: number;
  readonly cooldownRemainingMs: number;
  readonly roundsChambered?: number;
}

export interface InspectorHudProps {
  readonly state: RoundViewState;
  readonly gun: InspectorGunView;
}

type ReticleState = "normal" | "on_target" | "out_of_range" | "cooldown";

/** How long a shot's result holds the middle of the screen. */
const HIT_CALLOUT_MS = 1_600;
/** The recolour on firing, kept brief and dim: §5.13 forbids strobing. */
const FLASH_MS = 220;

const RETICLE_COLORS: Readonly<Record<ReticleState, string>> = {
  normal: "rgba(232, 221, 205, 0.55)",
  on_target: BRASS,
  out_of_range: "rgba(232, 221, 205, 0.28)",
  cooldown: ALARM,
};

function reticleStateOf(gun: InspectorGunView, outOfAmmo: boolean): ReticleState {
  if (outOfAmmo || gun.state === "cooldown" || gun.cooldownRemainingMs > 0) return "cooldown";
  if (gun.targetObjectId === null) return "normal";
  return gun.targetInRange ? "on_target" : "out_of_range";
}

/**
 * One warrant round: a brass-capped shell that empties as it is spent, so the
 * magazine can be read without counting digits.
 */
function AmmoRounds({ total, remaining }: { total: number; remaining: number }): ReactElement {
  return (
    <div style={{ display: "flex", gap: 5, marginTop: 6 }} aria-hidden>
      {Array.from({ length: total }, (_, index) => {
        const spent = index >= remaining;
        return (
          <div
            key={index}
            style={{
              width: 10,
              height: 28,
              borderRadius: "2px 2px 4px 4px",
              border: `1px solid ${spent ? "rgba(232, 221, 205, 0.22)" : BRASS}`,
              background: spent
                ? "transparent"
                : `linear-gradient(180deg, ${BRASS} 0 9px, rgba(176, 138, 74, 0.42) 9px 100%)`,
            }}
          />
        );
      })}
    </div>
  );
}

function Reticle({
  reticle,
  triggerProgress,
  flash,
}: {
  readonly reticle: ReticleState;
  readonly triggerProgress: number;
  readonly flash: "hit" | "miss" | null;
}): ReactElement {
  const color = flash === null ? RETICLE_COLORS[reticle] : flash === "hit" ? BRASS : ALARM;
  const spread = reticle === "on_target" ? 9 : 15;
  const progress = Math.min(1, Math.max(0, triggerProgress));

  const tick = (rotation: number): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: "50%",
    width: 2,
    height: 9,
    marginLeft: -1,
    background: color,
    transform: `rotate(${rotation}deg) translateY(-${spread + 5}px)`,
    transformOrigin: "50% 50%",
    transition: "transform 90ms ease-out, background 90ms linear",
  });

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: 72,
        height: 72,
        transform: "translate(-50%, -50%)",
        pointerEvents: "none",
      }}
    >
      <div style={tick(0)} />
      <div style={tick(90)} />
      <div style={tick(180)} />
      <div style={tick(270)} />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 3,
          height: 3,
          marginLeft: -1.5,
          marginTop: -1.5,
          borderRadius: "50%",
          background: color,
        }}
      />
      {progress > 0 ? (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: -4,
            width: 44,
            marginLeft: -22,
            height: 3,
            borderRadius: 2,
            background: "rgba(232, 221, 205, 0.16)",
            overflow: "hidden",
          }}
        >
          <div
            style={{ height: "100%", width: `${(progress * 100).toFixed(1)}%`, background: color }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Holds the newest shot result in the middle of the screen for a beat, then
 * lets it go. Keyed on the accusation's sequence number, so a repeat of the
 * same stamp still re-triggers.
 */
function useShotResult(
  latestId: number | null,
  correct: boolean,
): { flash: "hit" | "miss" | null; showCallout: boolean } {
  const [flash, setFlash] = useState<"hit" | "miss" | null>(null);
  const [showCallout, setShowCallout] = useState(false);

  useEffect(() => {
    if (latestId === null) return;
    setFlash(correct ? "hit" : "miss");
    setShowCallout(true);
    const clearFlash = setTimeout(() => {
      setFlash(null);
    }, FLASH_MS);
    const clearCallout = setTimeout(() => {
      setShowCallout(false);
    }, HIT_CALLOUT_MS);
    return () => {
      clearTimeout(clearFlash);
      clearTimeout(clearCallout);
    };
  }, [latestId, correct]);

  return { flash, showCallout };
}

export function InspectorHud({ state, gun }: InspectorHudProps): ReactElement {
  const warrantsRemaining = state.self.warrantsRemaining ?? state.warrantsRemaining ?? 0;
  // The magazine keeps its length as rounds are spent, so spent casings stay
  // visible next to the live ones.
  const warrantTotal = Math.max(warrantsRemaining, state.warrantsTotal ?? warrantsRemaining);
  const outOfAmmo = warrantsRemaining <= 0;
  const reticle = reticleStateOf(gun, outOfAmmo);
  const accent = state.timer.finalTen ? ALARM : BRASS;

  const latest = state.accusations[0] ?? null;
  const { flash, showCallout } = useShotResult(latest?.id ?? null, latest?.correct ?? false);

  const prompt = outOfAmmo
    ? AMMO_EMPTY_PROMPT
    : reticle === "cooldown"
      ? AMMO_COOLDOWN_PROMPT
      : reticle === "out_of_range"
        ? AMMO_OUT_OF_RANGE_PROMPT
        : reticle === "on_target"
          ? AMMO_READY_PROMPT
          : AMMO_NO_TARGET_PROMPT;

  // The newest shot owns the middle of the screen, so the stack behind it
  // carries only the older ones and any refusal.
  const toasts: ToastEntry[] = [
    ...state.accusations.slice(1).map((entry) => ({
      id: entry.id,
      title: entry.stamp,
      body: entry.correct ? (entry.revealedDisplayName ?? null) : null,
      tone: entry.correct ? ("brass" as const) : ("cream" as const),
    })),
    ...state.rejections.map((entry) => rejectionToast(entry.id, entry.commandType, entry.reason)),
  ];

  return (
    <div style={overlayStyle}>
      <PhaseTimer
        timer={state.timer}
        label={state.timer.finalTen ? state.phaseLabel : null}
        note={state.timer.finalTen ? null : `${state.mimicsRemaining} unaccounted for`}
      />

      <div style={{ ...panelStyle, top: 16, left: 16, pointerEvents: "none", minWidth: 150 }}>
        <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span>{AMMO_LABEL}</span>
          <span style={{ color: outOfAmmo ? ALARM : BRASS }}>
            {warrantsRemaining} / {warrantTotal}
          </span>
        </div>
        <AmmoRounds total={warrantTotal} remaining={warrantsRemaining} />
        <div style={{ ...labelStyle, marginTop: 12 }}>Mimics remaining</div>
        <div style={{ font: "600 22px/1.2 system-ui, sans-serif", color: accent }}>
          {state.mimicsRemaining}
        </div>
      </div>

      <Reticle reticle={reticle} triggerProgress={gun.triggerProgress} flash={flash} />

      {gun.targetObjectId === null || gun.targetDistanceM === null ? null : (
        <div
          style={{
            position: "absolute",
            top: "calc(50% + 52px)",
            left: "50%",
            transform: "translateX(-50%)",
            pointerEvents: "none",
            ...labelStyle,
            color: gun.targetInRange ? CREAM : "rgba(232, 221, 205, 0.4)",
          }}
        >
          {gun.targetDistanceM.toFixed(1)} m
        </div>
      )}

      {showCallout && latest !== null ? (
        <div
          style={{
            position: "absolute",
            top: "calc(50% - 96px)",
            left: "50%",
            transform: "translateX(-50%)",
            pointerEvents: "none",
            textAlign: "center",
            background: INK,
            border: EDGE,
            borderRadius: 8,
            padding: "8px 18px",
            backdropFilter: "blur(6px)",
          }}
          role="status"
          aria-live="assertive"
        >
          <div
            style={{
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              fontSize: 17,
              fontWeight: 600,
              color: latest.correct ? BRASS : CREAM,
            }}
          >
            {latest.stamp}
          </div>
          <div style={{ ...labelStyle, marginTop: 3, letterSpacing: "0.06em" }}>
            {latest.correct
              ? (latest.revealedDisplayName ?? "")
              : `${latest.warrantsRemaining} round${latest.warrantsRemaining === 1 ? "" : "s"} left`}
          </div>
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          background: INK,
          border: EDGE,
          borderRadius: 8,
          padding: "7px 14px",
          pointerEvents: "none",
          ...labelStyle,
          color: outOfAmmo ? ALARM : CREAM,
          opacity: reticle === "on_target" ? 0.9 : 0.5,
        }}
      >
        {prompt}
      </div>

      <Toast entries={toasts} />
    </div>
  );
}
