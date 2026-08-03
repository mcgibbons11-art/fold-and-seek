import { useState, type ReactElement, type ReactNode } from "react";

import type { ForgeController } from "../../forge/ForgeController";
import type { RoundViewState } from "../../gameplay/roundView";
import { ForgeToolPanels } from "../ForgeHud";
import { ActionRail } from "./ActionRail";
import { hiderDensityFor, type ColumnDensity } from "./columnFit";
import { HiderHud } from "./HiderHud";
import {
  boardRailAction,
  inspectorRailActions,
  type RailAction,
} from "./huntControls";
import { HuntStatus } from "./HuntStatus";
import { InspectorSight, InspectorStatusCard, warrantsRemainingOf, type InspectorGunView } from "./InspectorHud";
import { HudLayout, useRegionHeight, type HudLayoutMode, type RegionAssignment } from "./layout";
import { MissedFindsHud } from "./MissedFindsHud";
import { Toast, rejectionToast } from "./Toast";
import { BRASS_LIT, PRESS_CLASS, buttonStyle, figureStyle, labelStyle, plate } from "./theme";

/**
 * The whole hunt in one layout. Every phase HUD before this one placed its own
 * panels, and the hunt is where three of them wanted the same corners at once.
 * Here the screen is divided first and filled second: this component decides
 * which region each piece belongs to and nothing it renders knows where it is.
 *
 * The rail is the hunt's answer to "what can I press". It carries the Forge's
 * tool keys during the hunt, which is why the Forge's own tool column is not
 * rendered here — the same key twice on one screen is how a player learns to
 * distrust the HUD.
 */

export interface HuntHudProps {
  readonly state: RoundViewState;
  readonly gun: InspectorGunView;
  /** The hider's own Forge, still live through the hunt. Null for every other role. */
  readonly forge: ForgeController | null;
  readonly pointerLocked: boolean;
  readonly boardOpen: boolean;
  readonly onToggleBoard: () => void;
  readonly onTaunt: () => void;
  readonly traversal?: "climbing" | "topout" | "airborne" | null;
  readonly dangerBearingRad?: number | null;
}

export function HuntHud(props: HuntHudProps): ReactElement {
  const { state, gun, forge, boardOpen, onToggleBoard, onTaunt } = props;
  const [actionsOpen, setActionsOpen] = useState(false);

  const role = state.self.role;
  const isInspector = role === "inspector";
  const isLiveHider = role === "mimic" && state.self.lifeState === "active";
  const layoutMode: HudLayoutMode = isInspector ? "inspector" : isLiveHider ? "hider" : "spectator";
  const columnHeight = useRegionHeight("leftColumn", layoutMode);
  const traversal = props.traversal ?? null;
  const density = hiderDensityFor(columnHeight, {
    watchedLevel: state.self.watchedLevel,
    finalTen: state.timer.finalTen,
    traversal,
  });

  const board = boardOpen ? <MissedFindsHud state={state} /> : null;

  const rail: readonly RailAction[] = isInspector
    ? inspectorRailActions({ boardOpen, outOfWarrants: warrantsRemainingOf(state) <= 0 })
    : [boardRailAction(boardOpen)];

  const onRailPress = (id: string): void => {
    if (id === "missedFinds") {
      onToggleBoard();
      return;
    }
  };

  const toasts = state.rejections.map((entry) =>
    rejectionToast(entry.id, entry.commandType, entry.reason),
  );

  const regions: RegionAssignment = {
    topCenter: <HuntStatus state={state} />,
    topRight: toasts.length === 0 ? undefined : <Toast entries={toasts} />,
    leftColumn: leftColumn({
      state,
      isInspector,
      isLiveHider,
      forge,
      board,
      density,
      traversal,
      dangerBearingRad: props.dangerBearingRad ?? null,
      boardOpen,
      onToggleBoard,
      onTaunt,
    }),
    rightRail: isLiveHider ? undefined : (
      <ActionsDisclosure
        actions={rail}
        open={actionsOpen}
        onToggle={() => setActionsOpen((open) => !open)}
        onPress={onRailPress}
      />
    ),
    center: isInspector ? <InspectorSight state={state} gun={gun} /> : undefined,
  };

  return <HudLayout regions={regions} mode={layoutMode} />;
}
/** Keeps the full verb/key list one deliberate click away instead of permanently covering the room. */
function ActionsDisclosure({
  actions,
  open,
  onToggle,
  onPress,
}: {
  readonly actions: readonly RailAction[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onPress: (id: string) => void;
}): ReactElement {
  const availableHeight = Math.max(useRegionHeight("rightRail") - 48, 0);
  return (
    <div data-action-rail={open ? "open" : "folded"} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          ...plate(),
          width: 148,
          padding: "8px 10px",
          borderRadius: 8,
          color: BRASS_LIT,
          font: "inherit",
          cursor: "pointer",
          pointerEvents: "auto",
          textAlign: "right",
        }}
      >
        Actions <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open ? <ActionRail actions={actions} onPress={onPress} availableHeight={availableHeight} /> : null}
    </div>
  );
}

function leftColumn({
  state,
  isInspector,
  isLiveHider,
  forge,
  board,
  density,
  traversal,
  dangerBearingRad,
  boardOpen,
  onToggleBoard,
  onTaunt,
}: {
  readonly state: RoundViewState;
  readonly isInspector: boolean;
  readonly isLiveHider: boolean;
  readonly forge: ForgeController | null;
  readonly board: ReactNode;
  readonly density: ColumnDensity;
  readonly traversal: "climbing" | "topout" | "airborne" | null;
  readonly dangerBearingRad: number | null;
  readonly boardOpen: boolean;
  readonly onToggleBoard: () => void;
  readonly onTaunt: () => void;
}): ReactNode {
  if (isInspector) {
    return (
      <>
        <InspectorStatusCard state={state} />
        {board}
      </>
    );
  }
  if (isLiveHider) {
    return (
      <HiderHud state={state} density={density} traversal={traversal} dangerBearingRad={dangerBearingRad}>
        {forge === null ? null : <ForgeToolPanels controller={forge} width="100%" embedded />}
        <HiderDockUtilities
          state={state}
          boardOpen={boardOpen}
          onToggleBoard={onToggleBoard}
          onTaunt={onTaunt}
        />
        {board}
      </HiderHud>
    );
  }
  return (
    <>
      <SpectatorStatusCard state={state} />
      {board}
    </>
  );
}

/** Low-frequency utilities stay in the dock; Forge tools never reappear on a rail. */
function HiderDockUtilities({
  state,
  boardOpen,
  onToggleBoard,
  onTaunt,
}: {
  readonly state: RoundViewState;
  readonly boardOpen: boolean;
  readonly onToggleBoard: () => void;
  readonly onTaunt: () => void;
}): ReactElement {
  const tauntEnabled = state.capabilities.taunt && state.actions.taunt.allowed;
  return (
    <div
      role="group"
      aria-label="Hider utilities"
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "8px 4px 2px" }}
    >
      <button
        type="button"
        className={PRESS_CLASS}
        disabled={!tauntEnabled}
        onClick={onTaunt}
        style={{ ...buttonStyle, margin: 0, padding: "7px 8px", opacity: tauntEnabled ? 1 : 0.45 }}
      >
        T · {tauntEnabled ? "Taunt" : `${Math.ceil(state.self.tauntCooldownMs / 1_000)}s`}
      </button>
      <button
        type="button"
        className={PRESS_CLASS}
        aria-pressed={boardOpen}
        onClick={onToggleBoard}
        style={{ ...buttonStyle, margin: 0, padding: "7px 8px" }}
      >
        6 · Missed spots
      </button>
    </div>
  );
}

/**
 * A caught hider or a player sitting the round out. They keep the board and the
 * clock, because watching the room give somebody else away is the rest of their
 * round.
 */
function SpectatorStatusCard({ state }: { readonly state: RoundViewState }): ReactElement {
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
      <div style={labelStyle}>
        {state.self.lifeState === "caught" ? "You were found" : "Spectating"}
      </div>
      <div style={{ ...labelStyle, marginTop: 10 }}>Still standing</div>
      <div style={figureStyle}>{state.mimicsRemaining}</div>
    </div>
  );
}

