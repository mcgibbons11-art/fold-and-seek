import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

import {
  AMMO_COOLDOWN_PROMPT,
  AMMO_EMPTY_PROMPT,
  AMMO_LABEL,
  AMMO_OUT_OF_RANGE_PROMPT,
  AMMO_READY_PROMPT,
} from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import type { ShotOutcome } from "../../inspector/ShootingDriver";
import { ALARM, BRASS, BRASS_LIT, CREAM, FONT_DISPLAY, figureStyle, labelStyle, plate } from "./theme";

/**
 * Inspector HUD (§5.9). The Inspector carries a warrant gun, so time,
 * ammunition and the reticle are the whole instrument: how many warrant rounds
 * are left, whether the thing in the sights can be shot from here, and what the
 * last shot turned out to be.
 *
 * Nothing here outlines a prop for the player. §8.7 wants the room looked at
 * rather than scanned, so the reticle only reports what is already under it.
 *
 * The two halves are separate because they live in different screen regions:
 * the magazine reads in the left column, and everything that answers "can I
 * shoot this" stays at the centre where the player is already looking.
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
  /**
   * Count of rounds that never became an accusation. It only ever goes up, and
   * the reticle kicks whenever it does: a trigger pull the authority never
   * hears about has nothing else on screen to say it happened.
   */
  readonly dryFires: number;
  readonly blockedFires?: number;
  readonly lastShotOutcome?: ShotOutcome | null;
}

type ReticleState = "normal" | "on_target" | "out_of_range" | "cooldown";

/** How long a shot's result holds the middle of the screen. */
const HIT_CALLOUT_MS = 1_600;
/** The recolour on firing, kept brief and dim: §5.13 forbids strobing. */
const FLASH_MS = 220;
/** How far the reticle ticks are thrown outward by that kick, in pixels. */
const DRY_FIRE_KICK_SPREAD = 9;

/**
 * The reticle's four states, and the whole of what tells them apart.
 *
 * Colour alone was doing this job at 0.55 opacity cream over a shop that is
 * itself cream, and the round-1 critic could not find the reticle at all in a
 * 1080p screenshot — the state was being read off the grey words "NO TARGET"
 * underneath instead, which is a caption doing an instrument's work. So each
 * state now differs in three ways at once: colour, how far the ticks stand off
 * the middle, and whether the ring around them is drawn. Every mark carries a
 * dark outline so none of it depends on what is behind it.
 */
const RETICLE_COLORS: Readonly<Record<ReticleState, string>> = {
  normal: "rgba(240, 232, 218, 0.92)",
  on_target: BRASS_LIT,
  out_of_range: "rgba(232, 221, 205, 0.55)",
  cooldown: ALARM,
};

/** How far the ticks stand off centre, which closes when there is something to shoot. */
const RETICLE_SPREAD: Readonly<Record<ReticleState, number>> = {
  normal: 15,
  on_target: 8,
  out_of_range: 13,
  cooldown: 17,
};

/** The dark edge every mark carries, so the reticle never sinks into the room. */
const RETICLE_OUTLINE = "0 0 0 1px rgba(10, 7, 4, 0.75), 0 0 6px rgba(10, 7, 4, 0.6)";

function reticleStateOf(gun: InspectorGunView, outOfAmmo: boolean): ReticleState {
  if (outOfAmmo || gun.state === "cooldown" || gun.cooldownRemainingMs > 0) return "cooldown";
  if (gun.targetObjectId === null) return "normal";
  return gun.targetInRange ? "on_target" : "out_of_range";
}

export function warrantsRemainingOf(state: RoundViewState): number {
  return state.self.warrantsRemaining ?? state.warrantsRemaining ?? 0;
}

/**
 * The magazine one Inspector was issued. Warrants are held per seeker, so in a
 * two-seeker round the room's total is twice what this player can fire and
 * drawing it would show a partner's rounds as their own.
 */
export function warrantAllowanceOf(state: RoundViewState): number {
  return state.warrantsPerInspector ?? state.warrantsTotal ?? 0;
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
              border: `1px solid ${spent ? "rgba(232, 221, 205, 0.2)" : BRASS_LIT}`,
              background: spent
                ? "rgba(0, 0, 0, 0.25)"
                : `linear-gradient(180deg, ${BRASS_LIT} 0 9px, ${BRASS} 9px 13px, rgba(120, 92, 46, 0.55) 13px 100%)`,
              boxShadow: spent
                ? "inset 0 1px 3px rgba(0, 0, 0, 0.5)"
                : "0 0 8px rgba(255, 190, 107, 0.3), inset 0 1px 0 rgba(255, 240, 205, 0.55)",
            }}
          />
        );
      })}
    </div>
  );
}

export interface InspectorStatusCardProps {
  readonly state: RoundViewState;
}

/** The magazine and the count of objects still unaccounted for. */
export function InspectorStatusCard({ state }: InspectorStatusCardProps): ReactElement {
  const warrantsRemaining = warrantsRemainingOf(state);
  // The magazine keeps its length as rounds are spent, so spent casings stay
  // visible next to the live ones.
  const warrantTotal = Math.max(warrantsRemaining, warrantAllowanceOf(state));
  const outOfAmmo = warrantsRemaining <= 0;
  const accent = state.timer.finalTen ? ALARM : BRASS;

  return (
    <div
      style={{
        ...plate(),
        borderRadius: 10,
        padding: "12px 14px",
        width: "100%",
        boxSizing: "border-box",
        pointerEvents: "none",
      }}
    >
      <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span>{AMMO_LABEL}</span>
        <span style={{ color: outOfAmmo ? ALARM : BRASS_LIT, fontVariantNumeric: "tabular-nums" }}>
          {warrantsRemaining} / {warrantTotal}
        </span>
      </div>
      <AmmoRounds total={warrantTotal} remaining={warrantsRemaining} />
      <div style={{ ...labelStyle, marginTop: 12 }}>Unaccounted for</div>
      <div style={{ ...figureStyle, color: accent }}>{state.mimicsRemaining}</div>
    </div>
  );
}

function Reticle({
  reticle,
  triggerProgress,
  flash,
  kicked,
}: {
  readonly reticle: ReticleState;
  readonly triggerProgress: number;
  readonly flash: "hit" | "miss" | null;
  /** A round that hit nothing: the ticks are thrown open and tinted for a beat. */
  readonly kicked: boolean;
}): ReactElement {
  const color =
    flash === null ? (kicked ? ALARM : RETICLE_COLORS[reticle]) : flash === "hit" ? BRASS_LIT : ALARM;
  const spread = RETICLE_SPREAD[reticle] + (kicked ? DRY_FIRE_KICK_SPREAD : 0);
  const progress = Math.min(1, Math.max(0, triggerProgress));
  // The ring is the "there is something here" mark. It is drawn only when the
  // gun has a target, so the difference between an object and empty air is a
  // shape appearing rather than a shade of cream changing.
  const ringDiameter = spread * 2 + 6;

  const tick = (rotation: number): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: "50%",
    width: 2,
    height: 10,
    marginLeft: -1,
    background: color,
    boxShadow: RETICLE_OUTLINE,
    transform: `rotate(${rotation}deg) translateY(-${spread + 6}px)`,
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
      data-reticle={reticle}
    >
      {reticle === "normal" ? null : (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: ringDiameter,
            height: ringDiameter,
            marginLeft: -ringDiameter / 2,
            marginTop: -ringDiameter / 2,
            borderRadius: "50%",
            border: `1px solid ${color}`,
            boxShadow: RETICLE_OUTLINE,
            opacity: reticle === "on_target" ? 0.95 : 0.5,
            transition: "width 90ms ease-out, height 90ms ease-out, border-color 90ms linear",
          }}
        />
      )}
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
          boxShadow: RETICLE_OUTLINE,
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

/**
 * True for a beat after the dry-fire count goes up.
 *
 * A local miss reaches the authority as nothing at all — no command is sent, no
 * warrant is spent and no event comes back — so unlike `useShotResult` there is
 * no accusation to key on. The weapon's own counter is the whole signal, which
 * is why it counts rather than flags: two misses in a row must read as two.
 */
function useTriggerFeedback(
  dryFires: number,
  blockedFires: number,
  outcome: ShotOutcome | null,
  hasTarget: boolean,
): { readonly kicked: boolean; readonly callout: string | null } {
  const [kicked, setKicked] = useState(false);
  const [callout, setCallout] = useState<string | null>(null);
  const seen = useRef({ dryFires, blockedFires });

  useEffect(() => {
    if (dryFires === seen.current.dryFires && blockedFires === seen.current.blockedFires) return undefined;
    const blocked = blockedFires !== seen.current.blockedFires;
    seen.current = { dryFires, blockedFires };
    const next = blocked
      ? "WAIT"
      : outcome === "out_of_range"
        ? "OUT OF RANGE"
        : outcome === "not_shootable"
          ? "OBSTRUCTED"
          : outcome === "empty"
            ? "NO WARRANTS"
            : hasTarget
              ? "MISS"
              : "NO TARGET";
    setKicked(true);
    setCallout(next);
    const clear = setTimeout(() => {
      setKicked(false);
      setCallout(null);
    }, 900);
    return () => {
      clearTimeout(clear);
    };
  }, [blockedFires, dryFires, hasTarget, outcome]);

  return { kicked, callout };
}

export interface InspectorSightProps {
  readonly state: RoundViewState;
  readonly gun: InspectorGunView;
}

/**
 * Everything that answers "can I shoot this, and what happened when I did":
 * reticle, range, the gun's own word, and the newest stamp above it. All of it
 * sits inside the centre region and is measured from that region's middle.
 */
export function InspectorSight({ state, gun }: InspectorSightProps): ReactElement {
  const outOfAmmo = warrantsRemainingOf(state) <= 0;
  const reticle = reticleStateOf(gun, outOfAmmo);
  const latest = state.accusations[0] ?? null;
  const { flash, showCallout } = useShotResult(latest?.id ?? null, latest?.correct ?? false);
  const triggerFeedback = useTriggerFeedback(
    gun.dryFires,
    gun.blockedFires ?? 0,
    gun.lastShotOutcome ?? null,
    gun.targetObjectId !== null,
  );

  // Nothing is printed for an empty sight. "NO TARGET" under a reticle that is
  // already drawn in its no-target state is the instrument being explained
  // rather than read, and it was the only thing on screen a player could find.
  const prompt = outOfAmmo
    ? AMMO_EMPTY_PROMPT
    : reticle === "cooldown"
      ? AMMO_COOLDOWN_PROMPT
      : reticle === "out_of_range"
        ? AMMO_OUT_OF_RANGE_PROMPT
        : reticle === "on_target"
          ? AMMO_READY_PROMPT
          : null;

  return (
    <div
      style={{ position: "relative", width: "100%", height: "100%", pointerEvents: "none" }}
      data-target-object-id={gun.targetObjectId ?? ""}
      data-target-in-range={gun.targetObjectId === null ? undefined : String(gun.targetInRange)}
    >
      <Reticle
        reticle={reticle}
        triggerProgress={gun.triggerProgress}
        flash={flash}
        kicked={triggerFeedback.kicked}
      />

      {triggerFeedback.callout === null ? null : (
        <div
          role="status"
          aria-live="assertive"
          style={{
            position: "absolute",
            top: "calc(50% - 76px)",
            left: 0,
            right: 0,
            textAlign: "center",
            font: `600 16px/1.2 ${FONT_DISPLAY}`,
            letterSpacing: "0.16em",
            color: ALARM,
            textShadow: "0 1px 5px rgba(0,0,0,0.9)",
          }}
        >
          {triggerFeedback.callout}
        </div>
      )}

      {gun.targetObjectId === null || gun.targetDistanceM === null ? null : (
        <div
          style={{
            position: "absolute",
            top: "calc(50% + 46px)",
            left: 0,
            right: 0,
            textAlign: "center",
            ...labelStyle,
            color: gun.targetInRange ? CREAM : "rgba(232, 221, 205, 0.4)",
          }}
        >
          {gun.targetDistanceM.toFixed(1)} m
        </div>
      )}

      {prompt === null ? null : (
        <div
          style={{
            position: "absolute",
            top: "calc(50% + 66px)",
            left: 0,
            right: 0,
            textAlign: "center",
            ...labelStyle,
            color: outOfAmmo ? ALARM : CREAM,
            opacity: reticle === "on_target" ? 0.9 : 0.7,
          }}
        >
          {prompt}
        </div>
      )}

      {showCallout && latest !== null ? (
        <div
          style={{
            position: "absolute",
            top: "calc(50% - 106px)",
            left: "50%",
            transform: "translateX(-50%)",
            textAlign: "center",
            whiteSpace: "nowrap",
            ...plate(),
            borderRadius: 8,
            padding: "9px 20px",
          }}
          className="fs-rise"
          role="status"
          aria-live="assertive"
        >
          <div
            style={{
              font: `600 19px/1.2 ${FONT_DISPLAY}`,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: latest.correct ? BRASS_LIT : CREAM,
              textShadow: latest.correct ? "0 0 16px rgba(255, 190, 107, 0.4)" : "none",
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
    </div>
  );
}
