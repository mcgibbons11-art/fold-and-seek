import type { CSSProperties, ReactElement, ReactNode } from "react";

import { DECEPTION_TITLE, deceptionLabel, HIDER_CREEP_HINT } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { COLUMN_DENSITIES, type ColumnDensity } from "./columnFit";
import { ALARM, BRASS_LIT, CREAM, figureStyle, labelStyle, plate } from "./theme";

/**
 * What a disguised Mimic reads while the Inspectors hunt. The disguise is not a
 * cage: the hider can still creep and still bait, and movement is exactly what
 * gives them away, which is the tension the phase runs on.
 *
 * This is a card, not a screen. `RoundHud` puts it in the left column beside the
 * board and the hider's own tool panels; the taunt, the clock and the control
 * hints belong to the regions that own those parts of the screen, so none of it
 * is placed from here.
 */

/**
 * The three tension readings the simulation can report (§5.12). The wording is
 * the contract's own: level 1 is the Inspector's cone, level 2 is being held at
 * close range.
 */
const WATCHED_COPY = ["Unobserved", "In the cone", "Held at close range"] as const;

export interface HiderStatusCardProps {
  readonly state: RoundViewState;
  /** Geometry for the viewport this column is being drawn into. */
  readonly density?: ColumnDensity;
  readonly embedded?: boolean;
  readonly traversal?: "climbing" | "topout" | "airborne" | null;
  readonly dangerBearingRad?: number | null;
}

/**
 * The card takes its height from the density rather than from what its text
 * measures, and clips whatever outgrows it, which is the rule the rail's chips
 * and the regions themselves already follow. Without a declared height there is
 * no arithmetic for `hudLayout.test.ts` to check the column against.
 */
function cardStyle(density: ColumnDensity, scored: boolean, embedded: boolean): CSSProperties {
  return {
    ...(embedded ? {} : plate()),
    borderRadius: 10,
    padding: density.cardPadding,
    height: scored ? density.statusScoredHeight : density.statusHeight,
    overflow: "hidden",
    width: "100%",
    boxSizing: "border-box",
    pointerEvents: "none",
  };
}

export function HiderStatusCard({
  state,
  density = COLUMN_DENSITIES[0] as ColumnDensity,
  embedded = false,
  traversal = null,
  dangerBearingRad = null,
}: HiderStatusCardProps): ReactElement {
  const level = state.self.watchedLevel;
  const caught = state.self.lifeState !== "active";
  const accent = level === 2 ? ALARM : BRASS_LIT;
  // Only ever this hider's own score: the director fills it in for the owner of
  // the disguise and for nobody else, which is what keeps it from being a hint.
  const deception = state.deception;
  const latest = deception.recent[0];
  const scored = deception.points > 0;
  const hintStyle: CSSProperties = density.wrapHint
    ? { marginTop: 4, opacity: 0.85 }
    : { marginTop: 4, opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
  const urgency = hiderUrgencyCopy(state, traversal);

  return (
    <div
      style={cardStyle(density, scored, embedded)}
      data-hider-density={density.id}
      data-hider-urgency={urgency.kind}
    >
      <div style={labelStyle}>{caught ? "Status" : "In the room"}</div>
      <div style={{ ...hintStyle, color: urgency.kind === "danger" ? ALARM : undefined }}>
        {dangerBearingRad === null || state.self.watchedLevel === 0 ? null : (
          <span
            aria-label="Inspector direction"
            style={{
              display: "inline-block",
              marginRight: 6,
              color: state.self.watchedLevel === 2 ? ALARM : BRASS_LIT,
              transform: `rotate(${dangerBearingRad}rad)`,
            }}
          >
            ↑
          </span>
        )}
        {caught ? "OBJECT STATUS REVOKED" : urgency.copy}
      </div>

      <div style={{ ...labelStyle, marginTop: density.headingGap }}>Being watched</div>
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
              background: level >= segment ? accent : "rgba(8, 6, 4, 0.6)",
              boxShadow:
                level >= segment
                  ? `0 0 10px ${level === 2 ? "rgba(200, 80, 60, 0.6)" : "rgba(255, 190, 107, 0.5)"}`
                  : "inset 0 1px 2px rgba(0, 0, 0, 0.6)",
              transition: "background 120ms linear, box-shadow 120ms linear",
            }}
          />
        ))}
      </div>
      <div style={{ ...labelStyle, marginTop: 4, color: level === 2 ? ALARM : undefined }}>
        {WATCHED_COPY[level]}
      </div>

      {scored && urgency.kind === "calm" ? (
        <>
          <div style={{ ...labelStyle, marginTop: density.headingGap }}>{DECEPTION_TITLE}</div>
          <div style={figureStyle}>{deception.points}</div>
          {latest === undefined ? null : (
            <div style={{ ...labelStyle, marginTop: 2, color: BRASS_LIT, opacity: 0.9 }}>
              {deceptionLabel(latest.kind)} +{latest.points}
            </div>
          )}
          <div style={{ ...labelStyle, marginTop: 4 }}>
            {deception.directLookEscapes} seen · {deception.closePasses} passed
          </div>
        </>
      ) : null}
    </div>
  );
}

export interface HiderHudProps {
  readonly state: RoundViewState;
  readonly density?: ColumnDensity;
  /** The board and the hider's tool panels, stacked under the status card. */
  readonly children?: ReactNode;
  readonly traversal?: "climbing" | "topout" | "airborne" | null;
  readonly dangerBearingRad?: number | null;
  readonly forgeToolsExpanded?: boolean;
}

function hiderUrgencyCopy(
  state: RoundViewState,
  traversal: "climbing" | "topout" | "airborne" | null,
): { readonly kind: "calm" | "time" | "traversal" | "danger"; readonly copy: string } {
  if (state.self.watchedLevel === 2) return { kind: "danger", copy: "Freeze — the Inspector is holding you in sight." };
  if (traversal === "topout") return { kind: "traversal", copy: "Top reached — release Space to dismount." };
  if (traversal === "climbing") return { kind: "traversal", copy: "Climbing — keep forward held to top out." };
  if (state.self.watchedLevel === 1) return { kind: "danger", copy: "Watched — break sight before reshaping." };
  if (state.timer.finalTen) return { kind: "time", copy: "Final seconds — hold your disguise." };
  return { kind: "calm", copy: HIDER_CREEP_HINT };
}

/** One persistent dock: status, urgent cue, authoring controls, then utilities. */
export function HiderHud({
  state,
  density,
  children,
  traversal,
  dangerBearingRad,
  forgeToolsExpanded = true,
}: HiderHudProps): ReactElement {
  return (
    <div
      data-hider-forge-dock="persistent"
      data-persistent-plate="hider-forge"
      style={{
        ...plate(),
        width: forgeToolsExpanded ? "100%" : 30,
        boxSizing: "border-box",
        borderRadius: 10,
        padding: forgeToolsExpanded ? 8 : 0,
        color: CREAM,
        pointerEvents: "auto",
      }}
    >
      {forgeToolsExpanded ? (
        <HiderStatusCard
          state={state}
          density={density}
          embedded
          traversal={traversal}
          dangerBearingRad={dangerBearingRad}
        />
      ) : null}
      {children}
    </div>
  );
}
