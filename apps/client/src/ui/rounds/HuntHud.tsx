import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import type { ForgeController, ForgeHudState, ForgeToolMode } from "../../forge/ForgeController";
import type { RoundViewState } from "../../gameplay/roundView";
import { ForgeToolPanels } from "../ForgeHud";
import { ActionRail } from "./ActionRail";
import { columnDensityFor, forgePanelsOpenByDefault, type ColumnDensity } from "./columnFit";
import { ControlStrip, ModeNote } from "./ControlStrip";
import { HiderHud } from "./HiderHud";
import {
  HIDER_CONTROL_HINTS,
  INSPECTOR_CONTROL_HINTS,
  boardRailAction,
  hiderRailActions,
  inspectorRailActions,
  type ControlHint,
  type RailAction,
} from "./huntControls";
import { HuntStatus } from "./HuntStatus";
import { InspectorSight, InspectorStatusCard, warrantsRemainingOf, type InspectorGunView } from "./InspectorHud";
import { HudLayout, REGION_GAP, useRegionHeight, type RegionAssignment } from "./layout";
import { MissedFindsHud } from "./MissedFindsHud";
import { Toast, rejectionToast } from "./Toast";
import { BRASS, EDGE, INK, labelStyle } from "./theme";

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

/** The rail's ids for the Forge tools, decoded back into a tool mode. */
const TOOL_ID_PREFIX = "tool:";

export interface HuntHudProps {
  readonly state: RoundViewState;
  readonly gun: InspectorGunView;
  /** The hider's own Forge, still live through the hunt. Null for every other role. */
  readonly forge: ForgeController | null;
  readonly pointerLocked: boolean;
  readonly boardOpen: boolean;
  readonly onToggleBoard: () => void;
  readonly onTaunt: () => void;
}

/** Follows the Forge so the rail can show which tool is selected. */
function useForgeState(controller: ForgeController | null): ForgeHudState | null {
  const [state, setState] = useState<ForgeHudState | null>(() => controller?.snapshot() ?? null);

  useEffect(() => {
    if (controller === null) {
      setState(null);
      return undefined;
    }
    setState(controller.snapshot());
    return controller.subscribe(setState);
  }, [controller]);

  return state;
}

/**
 * Whether the Forge's tool panels are unfolded. They start folded wherever the
 * column cannot hold them whole, and unfold on any deliberate change of tool, so
 * a hider who presses a tool key is never left pressing it at a folded panel.
 */
function useForgePanelsOpen(columnHeight: number, mode: ForgeToolMode | null): {
  readonly open: boolean;
  toggle: () => void;
} {
  const [open, setOpen] = useState(() => forgePanelsOpenByDefault(columnHeight));
  const lastMode = useRef(mode);

  useEffect(() => {
    setOpen(forgePanelsOpenByDefault(columnHeight));
  }, [columnHeight]);

  useEffect(() => {
    if (mode !== null && lastMode.current !== null && mode !== lastMode.current) setOpen(true);
    lastMode.current = mode;
  }, [mode]);

  return {
    open,
    toggle: () => {
      setOpen((current) => !current);
    },
  };
}

export function HuntHud(props: HuntHudProps): ReactElement {
  const { state, gun, forge, pointerLocked, boardOpen, onToggleBoard, onTaunt } = props;
  const forgeState = useForgeState(forge);
  const columnHeight = useRegionHeight("leftColumn");
  const density = columnDensityFor(columnHeight);
  const panels = useForgePanelsOpen(columnHeight, forgeState?.mode ?? null);

  const role = state.self.role;
  const isInspector = role === "inspector";
  const isLiveHider = role === "mimic" && state.self.lifeState === "active";

  const board = boardOpen ? <MissedFindsHud state={state} /> : null;

  const rail: readonly RailAction[] = isInspector
    ? inspectorRailActions({ boardOpen, outOfWarrants: warrantsRemainingOf(state) <= 0 })
    : isLiveHider
      ? hiderRailActions({
          tauntSupported: state.capabilities.taunt,
          tauntAllowed: state.actions.taunt.allowed,
          tauntCooldownSeconds: Math.ceil(state.self.tauntCooldownMs / 1_000),
          toolMode: forgeState?.mode ?? null,
          mirror: forgeState?.mirror ?? false,
          boardOpen,
        })
      : [boardRailAction(boardOpen)];

  const hints: readonly ControlHint[] = isInspector ? INSPECTOR_CONTROL_HINTS : HIDER_CONTROL_HINTS;

  const onRailPress = (id: string): void => {
    if (id === "missedFinds") {
      onToggleBoard();
      return;
    }
    if (id === "taunt") {
      onTaunt();
      return;
    }
    if (forge === null) return;
    if (id === "mirror") {
      forge.setMirror(!(forgeState?.mirror ?? false));
      return;
    }
    if (id.startsWith(TOOL_ID_PREFIX)) {
      forge.setToolMode(id.slice(TOOL_ID_PREFIX.length) as ForgeToolMode);
    }
  };

  const toasts = state.rejections.map((entry) =>
    rejectionToast(entry.id, entry.commandType, entry.reason),
  );

  const regions: RegionAssignment = {
    topCenter: <HuntStatus state={state} />,
    topRight: toasts.length === 0 ? undefined : <Toast entries={toasts} />,
    leftColumn: leftColumn({ state, isInspector, isLiveHider, forge, board, density, panels }),
    rightRail: <ActionRail actions={rail} onPress={onRailPress} />,
    bottomCenter:
      isInspector && !pointerLocked ? <PointerLockPrompt /> : <ControlStrip hints={hints} />,
    bottomRight: role === null ? undefined : <ModeNote role={role} />,
    center: isInspector ? <InspectorSight state={state} gun={gun} /> : undefined,
  };

  return <HudLayout regions={regions} />;
}

function leftColumn({
  state,
  isInspector,
  isLiveHider,
  forge,
  board,
  density,
  panels,
}: {
  readonly state: RoundViewState;
  readonly isInspector: boolean;
  readonly isLiveHider: boolean;
  readonly forge: ForgeController | null;
  readonly board: ReactNode;
  readonly density: ColumnDensity;
  readonly panels: { readonly open: boolean; readonly toggle: () => void };
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
      <HiderHud state={state} density={density}>
        {board}
        {forge === null ? null : (
          <ForgePanelsDisclosure density={density} open={panels.open} onToggle={panels.toggle}>
            <ForgeToolPanels controller={forge} width={288} />
          </ForgePanelsDisclosure>
        )}
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

/**
 * The Forge's tool panels, folded behind their own header where the column
 * cannot hold them whole. At 1280x720 the hider's column was drawing 661 px of
 * content into a 558 px region and the status card — the one part that has to be
 * readable at a glance — was behind a scrollbar because of it.
 *
 * The header is a button rather than a caption, and it declares its height, so
 * the folded column is an arithmetic `hudLayout.test.ts` can check. It adds no
 * scroll container of its own: the region's is the only one in the column.
 */
function ForgePanelsDisclosure({
  density,
  open,
  onToggle,
  children,
}: {
  readonly density: ColumnDensity;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div
      data-forge-panels={open ? "open" : "folded"}
      style={{ display: "flex", flexDirection: "column", gap: REGION_GAP, width: "100%" }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: density.disclosureHeight,
          width: "100%",
          boxSizing: "border-box",
          overflow: "hidden",
          padding: density.cardPadding,
          background: INK,
          border: EDGE,
          borderRadius: 10,
          backdropFilter: "blur(6px)",
          color: BRASS,
          font: "inherit",
          cursor: "pointer",
          pointerEvents: "auto",
        }}
      >
        <span style={{ ...labelStyle, opacity: 1 }}>Forge tools</span>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open ? children : null}
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
        background: INK,
        border: EDGE,
        borderRadius: 10,
        padding: "12px 14px",
        backdropFilter: "blur(6px)",
        width: "100%",
        boxSizing: "border-box",
        pointerEvents: "none",
      }}
    >
      <div style={labelStyle}>
        {state.self.lifeState === "caught" ? "You were found" : "Spectating"}
      </div>
      <div style={{ ...labelStyle, marginTop: 10 }}>Still standing</div>
      <div style={{ font: "600 22px/1.2 system-ui, sans-serif", color: BRASS }}>
        {state.mimicsRemaining}
      </div>
    </div>
  );
}

/**
 * Pointer lock can only be taken from a gesture, so the Inspector is told to
 * click rather than having the browser refuse the request on their behalf. It
 * stands in for the control strip, because until the room has the mouse none of
 * those controls do anything.
 */
function PointerLockPrompt(): ReactElement {
  return (
    <div
      style={{
        background: INK,
        border: EDGE,
        borderRadius: 10,
        padding: "10px 18px",
        backdropFilter: "blur(6px)",
        textAlign: "center",
        pointerEvents: "none",
      }}
    >
      <div style={{ ...labelStyle, color: BRASS, opacity: 1 }}>Click to take the room</div>
      <div style={{ marginTop: 4, opacity: 0.8 }}>
        WASD to walk · right mouse to aim · left mouse to fire a warrant
      </div>
    </div>
  );
}
