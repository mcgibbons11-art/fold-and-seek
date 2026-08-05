import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";

import {
  STARTER_ARRANGEMENT_IDS,
  starterArrangementLabel,
  type StarterArrangementId,
} from "../mimic/disguiseState";
import { PANEL_PROFILE_IDS, type PanelProfileId } from "../mimic/panels";
import { SEGMENT_PROFILE_IDS, type SegmentProfileId } from "../mimic/segmentForm";
import {
  swatchById,
  type MaterialFamily,
  type MaterialSwatch,
} from "../mimic/visual/materialSwatches";
import { PaintPanel } from "./paint/PaintPanel";
import {
  FORGE_TOOL_MODES,
  FORGE_QUICK_PANELS,
  FORGE_QUICK_SHAPES,
  FORGE_UI_ATTRIBUTE,
  type ForgeController,
  type ForgeHudState,
  type ForgeToolMode,
  type PanelNumericKey,
  type SegmentFormNumericKey,
} from "../forge/ForgeController";
import { BRASS_LIT, CREAM, FONT_DISPLAY, FONT_UI, PRESS_CLASS, keycapStyle, plate } from "./rounds/theme";

/**
 * Forge HUD (bible §12.4). React owns layout and discrete state only: sliders
 * are uncontrolled and call straight into the controller, so dragging one never
 * re-renders the tree. They remount when the disguise revision changes, which
 * is what makes undo and a starter arrangement snap the controls back.
 */

const EDGE = "1px solid rgba(176, 138, 74, 0.30)";

const rootStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  color: CREAM,
  font: `13px/1.5 ${FONT_UI}`,
};

const panelStyle: CSSProperties = {
  position: "absolute",
  ...plate(),
  borderRadius: 10,
  padding: "12px 14px",
  pointerEvents: "auto",
};

const buttonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "linear-gradient(180deg, rgba(232, 221, 205, 0.10), rgba(232, 221, 205, 0.03))",
  color: CREAM,
  border: EDGE,
  borderRadius: 7,
  padding: "7px 10px",
  font: "inherit",
  cursor: "pointer",
  marginBottom: 6,
};

// Both states set the `border` shorthand: swapping a shorthand for a longhand
// across a rerender is what React warns about, and it also loses the width.
const activeButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "linear-gradient(180deg, rgba(194, 151, 79, 0.42), rgba(122, 93, 46, 0.28))",
  border: `1px solid ${BRASS_LIT}`,
  color: "#fff3df",
  boxShadow: "0 0 14px rgba(255, 190, 107, 0.2), inset 0 1px 0 rgba(255, 232, 186, 0.25)",
};

const labelStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontSize: 10,
  opacity: 0.6,
  marginBottom: 2,
};

const sliderStyle: CSSProperties = {
  width: "100%",
  accentColor: BRASS_LIT,
  marginBottom: 8,
  cursor: "ew-resize",
};

const selectStyle: CSSProperties = {
  width: "100%",
  background: "rgba(28, 21, 13, 0.9)",
  color: CREAM,
  border: EDGE,
  borderRadius: 6,
  padding: "5px 7px",
  font: "inherit",
  marginBottom: 10,
};

/** Tells the Forge's pointer handling to keep its hands off this element. */
const hudProps = { [FORGE_UI_ATTRIBUTE]: "" };

/**
 * Where the Forge's fixed panels sit, in one table.
 *
 * The panels used to carry their own offsets, and at the editor's half-width 2p
 * panes three of them landed on each other (measured at 640x660): the context
 * panel grew down through the Preview panel, and the centred status strip ran
 * under both the undo column on its left and the lock panel on its right. Each
 * offset looked reasonable alone, which is the same failure the round HUD's
 * region table was built to end.
 *
 * So the two panels that can grow are bounded by arithmetic instead: the right
 * column reserves the stack beneath it, and the status strip is inset to the gap
 * between the two bottom corners rather than centred on the whole viewport.
 */
const FORGE_LAYOUT = {
  /** Gap from the viewport edge to any panel. */
  edge: 16,
  /** Top of the row under the header. */
  topRow: 74,
  /** The tool column and the undo column, which share a width. */
  leftColumnWidth: 132,
  /** The compact lock/menu panel on the right. */
  rightStackWidth: 176,
  /**
   * How far the top of the Preview panel sits above the bottom of the viewport.
   * It and the lock panel below it are both fixed-height, so this is a constant:
   * the lock panel's 16 from the bottom, the Preview panel's 132, and the
   * Preview panel's own 155 — a heading, three stacked camera buttons at 24 with
   * 5 between them, the anchors line, and the panel's own chrome.
   */
  rightStackTopFromBottom: 156,
  /**
   * How far the top of the bottom row — the status strip and the undo column —
   * sits above the bottom of the viewport. Both are anchored 16 from the bottom
   * and the undo column is the taller of the two at 102.
   */
  bottomRowFromBottom: 156,
  /** Breathing room between two panels that would otherwise touch. */
  gutter: 12,
  /** The status strip stays this narrow even when there is room for more. */
  statusMaxWidth: 620,
  /**
   * Padding and border a panel adds around whatever size it declares. These
   * boxes are content-box, so a `width` of 132 occupies 162 and a `maxHeight`
   * bounds the content rather than the panel. Every inset below has to pay it.
   */
  panelChrome: 14 * 2 + 1 * 2,
} as const;

/** Left inset for anything that must clear the left-hand columns. */
const LEFT_GUTTER =
  FORGE_LAYOUT.edge + FORGE_LAYOUT.leftColumnWidth + FORGE_LAYOUT.panelChrome + FORGE_LAYOUT.gutter;
/** Right inset for anything that must clear the right-hand stack. */
const RIGHT_GUTTER =
  FORGE_LAYOUT.edge + FORGE_LAYOUT.rightStackWidth + FORGE_LAYOUT.panelChrome + FORGE_LAYOUT.gutter;

/**
 * The tallest the context panel's content may be before it would reach the
 * Preview panel under it.
 */
const CONTEXT_MAX_HEIGHT = `calc(100vh - ${String(
  FORGE_LAYOUT.topRow +
    FORGE_LAYOUT.rightStackTopFromBottom +
    FORGE_LAYOUT.gutter +
    FORGE_LAYOUT.panelChrome,
)}px)`;

/** Where the paint panel's own top edge sits, beside the tool column. */
const PAINT_TOP = 58;

/**
 * The tallest the paint panel's content may be before it would reach the status
 * strip and the undo column along the bottom.
 *
 * It needs one because the panel has no natural bound: a wheel, three material
 * channels, the swatch grid and the stroke controls came to 773 px on a 660 px
 * pane, which put the bottom third of the tool off the screen entirely and drew
 * the rest over the status strip. Scrolling it is what keeps every control
 * reachable on a short viewport.
 */
const PAINT_MAX_HEIGHT = `calc(100vh - ${String(
  PAINT_TOP + FORGE_LAYOUT.bottomRowFromBottom + FORGE_LAYOUT.gutter + FORGE_LAYOUT.panelChrome,
)}px)`;

/**
 * Every key this HUD prints, drawn as the ivory cap the rest of the game prints
 * keys on rather than written into the label with spaces around it.
 *
 * "Enter  Lock disguise" was a string, and HTML collapses runs of whitespace, so
 * what reached the screen was "Enter Lock disguise" — a three-word label whose
 * first word happens to be a key. The cap is what tells them apart.
 */
const FORGE_KEYCAP_FONT = `600 10px/1.5 ${FONT_UI}`;

function Keycap({ children }: { readonly children: string }): ReactElement {
  return (
    <span style={{ ...keycapStyle(FORGE_KEYCAP_FONT), marginRight: 8, verticalAlign: "baseline" }}>
      {children}
    </span>
  );
}

const TOOL_KEYS: Readonly<Record<ForgeToolMode, string>> = {
  pose: "1",
  shape: "2",
  panels: "3",
  material: "4",
  paint: "5",
};

const TOOL_LABELS: Readonly<Record<ForgeToolMode, string>> = {
  pose: "Pose",
  shape: "Shape",
  panels: "Panels",
  material: "Material",
  paint: "Paint",
};

/** The three preview cameras, named in full rather than clipped to fit a row. */
const PREVIEW_BUTTONS: readonly {
  readonly id: "inspector" | "doorway" | "silhouette";
  readonly label: string;
  readonly title: string;
}[] = [
  {
    id: "inspector",
    label: "Inspector's eye",
    title: "See the disguise from the height an Inspector walks at",
  },
  { id: "doorway", label: "From the door", title: "See the disguise from the doorway camera" },
  {
    id: "silhouette",
    label: "Silhouette (V)",
    title: "Flatten the room to outlines, which is what a shape is really read as",
  },
];

interface SliderProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly remountKey: string;
  readonly onInput: (value: number) => void;
  readonly onCommit: () => void;
}

function Slider(props: SliderProps): ReactElement {
  return (
    <label style={{ display: "block" }}>
      <span style={labelStyle}>
        <span>{props.label}</span>
      </span>
      <input
        key={props.remountKey}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        defaultValue={props.value}
        style={sliderStyle}
        onChange={(event) => {
          props.onInput(Number(event.target.value));
        }}
        onPointerUp={props.onCommit}
        onKeyUp={props.onCommit}
        onBlur={props.onCommit}
      />
    </label>
  );
}

function PreviewButton(props: {
  readonly label: string;
  readonly title: string;
  readonly active: boolean;
  readonly onPress: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      onClick={props.onPress}
      style={{
        width: "100%",
        textAlign: "left",
        background: props.active
          ? "linear-gradient(180deg, rgba(194, 151, 79, 0.42), rgba(122, 93, 46, 0.28))"
          : "linear-gradient(180deg, rgba(232, 221, 205, 0.10), rgba(232, 221, 205, 0.03))",
        color: props.active ? "#fff3df" : CREAM,
        border: props.active ? `1px solid ${BRASS_LIT}` : EDGE,
        borderRadius: 7,
        padding: "5px 8px",
        font: "inherit",
        fontSize: 11,
        cursor: "pointer",
      }}
    >
      {props.label}
    </button>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }): ReactElement {
  return (
    <div>
      <div style={{ ...labelStyle, opacity: 1, marginBottom: 8, color: BRASS_LIT, letterSpacing: "0.14em" }}>
        {props.title}
      </div>
      {props.children}
    </div>
  );
}

export interface ForgeHudProps {
  readonly controller: ForgeController;
  readonly onExit: () => void;
  /** What leaving means here. Practice leaves the Forge; a round leaves the round. */
  readonly exitLabel?: string;
  /**
   * The "FORGE · POSE" banner. Practice owns the whole screen and needs it; in a
   * round the phase HUD already owns the top of the screen, and two panels
   * anchored top-centre draw on top of one another.
   */
  readonly showHeader?: boolean;
}

export function ForgeHud({
  controller,
  onExit,
  exitLabel,
  showHeader = true,
}: ForgeHudProps): ReactElement {
  const [state, setState] = useState<ForgeHudState>(() => controller.snapshot());
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [panelsExpanded, setPanelsExpanded] = useState(true);

  useEffect(() => controller.subscribe(setState), [controller]);

  const commit = (): void => {
    controller.commitEdits();
  };

  // Paint has no context panel of its own, so the whole right column stands
  // down for it and the paint panel has the width to itself on a narrow pane.
  const showContextPanel = state.activeMode !== null && state.activeMode !== "paint";

  return (
    <div className="fs-forge" data-sound-scope="semantic" style={rootStyle}>
      {showHeader ? (
        <div
          {...hudProps}
          style={{
            ...panelStyle,
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            textAlign: "center",
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            font: `600 13px/1.3 ${FONT_DISPLAY}`,
            padding: "9px 20px",
          }}
        >
          <span style={{ color: state.locked ? BRASS_LIT : CREAM }}>
            {state.locked
              ? "Disguise locked"
              : state.activeMode === null
                ? "Forge · tools stowed"
                : `Forge · ${state.activeMode}`}
          </span>
          {state.mirror ? <span style={{ color: BRASS_LIT, marginLeft: 12 }}>mirror</span> : null}
        </div>
      ) : null}

      {!panelsExpanded ? (
        <button
          {...hudProps}
          type="button"
          className={PRESS_CLASS}
          data-forge-panel-toggle="collapsed"
          aria-label="Expand Forge tools"
          title="Expand Forge tools"
          aria-expanded={false}
          onClick={() => setPanelsExpanded(true)}
          style={{
            ...buttonStyle,
            position: "absolute",
            zIndex: 11,
            top: FORGE_LAYOUT.topRow,
            left: 0,
            width: 30,
            minHeight: 142,
            margin: 0,
            padding: "9px 5px",
            borderRadius: "0 8px 8px 0",
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            textAlign: "center",
            // The HUD root is pointer-transparent and the panels opt back in;
            // this button floats alone outside every panel, so without its own
            // opt-in each click fell through to the canvas and the collapse
            // was permanent (live-play bug, 2026-08-05).
            pointerEvents: "auto",
          }}
        >
          Expand Forge tools <span aria-hidden>▶</span>
        </button>
      ) : null}

      <div
        {...hudProps}
        className="fs-forge-tools"
        style={{
          ...panelStyle,
          top: FORGE_LAYOUT.topRow,
          left: FORGE_LAYOUT.edge,
          width: FORGE_LAYOUT.leftColumnWidth,
          display: panelsExpanded ? undefined : "none",
        }}
      >
        <button
          type="button"
          className={PRESS_CLASS}
          data-forge-panel-toggle="expanded"
          aria-label="Collapse Forge tools"
          title="Collapse Forge tools"
          aria-expanded={true}
          style={{ ...buttonStyle, margin: "0 0 6px", textAlign: "right" }}
          onClick={() => {
            controller.deactivateTools();
            setPanelsExpanded(false);
          }}
        >
          Collapse Forge tools <span aria-hidden>◀</span>
        </button>
        {FORGE_TOOL_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={PRESS_CLASS}
            aria-pressed={state.activeMode === mode}
            style={state.activeMode === mode ? activeButtonStyle : buttonStyle}
            onClick={() => {
              controller.setToolMode(mode);
            }}
          >
            <Keycap>{TOOL_KEYS[mode]}</Keycap>
            {TOOL_LABELS[mode]}
          </button>
        ))}
        <button
          type="button"
          className={PRESS_CLASS}
          style={state.mirror ? activeButtonStyle : buttonStyle}
          onClick={() => {
            controller.setMirror(!state.mirror);
          }}
        >
          <Keycap>M</Keycap>
          Mirror
        </button>
        <div className="fs-forge-history" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, paddingTop: 4, borderTop: EDGE }}>
          <button
            type="button"
            aria-label={state.undoLabel === null ? "Undo" : `Undo ${state.undoLabel}`}
            disabled={!state.canUndo}
            style={{ ...buttonStyle, margin: 0, padding: 6, textAlign: "center", opacity: state.canUndo ? 1 : 0.4 }}
            onClick={() => controller.undo()}
          >
            {state.undoLabel?.startsWith("arrangement ") ? "Undo preset" : "Undo"}
          </button>
          <button
            type="button"
            aria-label="Redo"
            disabled={!state.canRedo}
            style={{ ...buttonStyle, margin: 0, padding: 6, textAlign: "center", opacity: state.canRedo ? 1 : 0.4 }}
            onClick={() => controller.redo()}
          >
            Redo
          </button>
        </div>
      </div>

      {/* The paint panel places itself at 16/16 and draws nothing unless the
          paint tool is active. The wrapper is what puts that origin beside the
          tool column instead of on top of it. */}
      <div
        className="fs-forge-paint"
        style={{
          position: "absolute",
          left: LEFT_GUTTER,
          top: PAINT_TOP,
          maxHeight: PAINT_MAX_HEIGHT,
          overflowY: "auto",
          pointerEvents: "auto",
          display: panelsExpanded ? undefined : "none",
        }}
      >
        <PaintPanel tool={controller.paint} />
      </div>

      {showContextPanel && panelsExpanded ? (
        <div
          {...hudProps}
          className="fs-forge-context"
          style={{
            ...panelStyle,
            top: FORGE_LAYOUT.topRow,
            right: FORGE_LAYOUT.edge,
            width: 236,
            // Stops above the Preview and lock panels rather than growing
            // through them, which is what `70vh` did on a short pane.
            maxHeight: CONTEXT_MAX_HEIGHT,
            overflowY: "auto",
          }}
        >
          <ContextPanel controller={controller} state={state} onCommit={commit} />
        </div>
      ) : null}

      <div
        {...hudProps}
        style={{
          ...panelStyle,
          bottom: FORGE_LAYOUT.edge,
          // Inset to the gap between the two bottom corners and centred inside
          // it by the auto margins, so a narrow pane shrinks the strip instead
          // of sliding it under the panels either side.
          left: LEFT_GUTTER,
          right: RIGHT_GUTTER,
          maxWidth: FORGE_LAYOUT.statusMaxWidth,
          marginLeft: "auto",
          marginRight: "auto",
          textAlign: "center",
          opacity: 0.9,
          display: panelsExpanded ? undefined : "none",
        }}
      >
        {state.status}
      </div>

      {optionsOpen ? (
        <div
          {...hudProps}
          role="dialog"
          aria-label="Forge options"
          style={{
            ...panelStyle,
            top: "50%",
            left: "50%",
            width: "min(380px, calc(100vw - 48px))",
            maxHeight: "calc(100vh - 48px)",
            overflowY: "auto",
            transform: "translate(-50%, -50%)",
            boxSizing: "border-box",
            boxShadow: "0 22px 70px rgba(0, 0, 0, 0.62)",
            zIndex: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
            <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1, margin: 0 }}>Forge options</div>
            <button type="button" style={{ ...buttonStyle, width: "auto", margin: 0 }} onClick={() => setOptionsOpen(false)}>
              Close
            </button>
          </div>

          <div style={{ ...labelStyle, color: BRASS_LIT, marginBottom: 6 }}>History</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 14 }}>
            <button
              type="button"
              style={{ ...buttonStyle, margin: 0, opacity: state.canUndo ? 1 : 0.4 }}
              onClick={() => controller.undo()}
            >
              ⟲ Undo{state.undoLabel === null ? "" : ` ${state.undoLabel}`}
            </button>
            <button
              type="button"
              style={{ ...buttonStyle, margin: 0, opacity: state.canRedo ? 1 : 0.4 }}
              onClick={() => controller.redo()}
            >
              ⟳ Redo
            </button>
          </div>

          <div style={{ ...labelStyle, color: BRASS_LIT, marginBottom: 6 }}>Preview</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 12 }}>
            {PREVIEW_BUTTONS.map((preview) => (
              <PreviewButton
                key={preview.id}
                label={preview.label}
                title={preview.title}
                active={preview.id === "silhouette" ? state.silhouette : state.preview === preview.id}
                onPress={() => {
                  if (preview.id === "silhouette") controller.setSilhouette(!state.silhouette);
                  else controller.setPreview(state.preview === preview.id ? "none" : preview.id);
                }}
              />
            ))}
          </div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>
            {state.anchoredBones.length === 0 ? "No contact anchors" : `${state.anchoredBones.length} anchored`}
            {state.unsatisfiedAnchors.length > 0 ? (
              <span style={{ color: "#e0785f" }}> · {state.unsatisfiedAnchors.join(", ")} out of reach</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div
        {...hudProps}
        style={{
          ...panelStyle,
          bottom: FORGE_LAYOUT.edge,
          right: FORGE_LAYOUT.edge,
          width: FORGE_LAYOUT.rightStackWidth,
        }}
      >
        {!state.locked ? <LockReadiness state={state} /> : null}
        <button
          type="button"
          style={state.locked ? activeButtonStyle : buttonStyle}
          onClick={() => {
            if (state.locked) {
              controller.unlock();
            } else {
              controller.lock();
            }
          }}
        >
          <Keycap>{state.locked ? "Esc" : "Enter"}</Keycap>
          {state.locked ? "Unlock" : "Lock disguise"}
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => setOptionsOpen((open) => !open)}
        >
          Forge options
        </button>
        <button
          type="button"
          style={{ ...buttonStyle, marginBottom: 0 }}
          onClick={onExit}
        >
          {exitLabel ?? "Leave the Forge"}
        </button>
      </div>
    </div>
  );
}

/**
 * The Forge's authoring panels with no position of their own: the controls for
 * whichever tool is selected, the paint panel when it is painting, and undo.
 *
 * A hider goes on shaping the disguise all through the hunt (CLAUDE.md override
 * 2), but the hunt HUD owns the screen by then. This is the part of the Forge
 * the hunt takes with it, dropped into whatever region the layout gives it. The
 * tool buttons are deliberately absent, because the hunt's action rail carries
 * them and the same key must not appear twice on screen.
 */
export function ForgeToolPanels({
  controller,
  width = 236,
  embedded = false,
  expanded,
  onExpandedChange,
}: {
  readonly controller: ForgeController;
  readonly width?: number | string;
  /** Draw inside the hunt's single persistent dock instead of making sub-plates. */
  readonly embedded?: boolean;
  /** Optional owner state lets the entire hider dock leave the screen with the tools. */
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
}): ReactElement {
  const [state, setState] = useState<ForgeHudState>(() => controller.snapshot());
  const [localExpanded, setLocalExpanded] = useState(true);
  const panelsExpanded = expanded ?? localExpanded;

  useEffect(() => controller.subscribe(setState), [controller]);

  const commit = (): void => {
    controller.commitEdits();
  };

  const togglePanels = (): void => {
    const next = !panelsExpanded;
    if (!next) controller.deactivateTools();
    if (expanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(next);
  };

  const cardStyle: CSSProperties = {
    ...(embedded ? {} : plate()),
    borderRadius: 10,
    padding: embedded ? "10px 4px" : "12px 14px",
    pointerEvents: "auto",
    width: "100%",
    boxSizing: "border-box",
    ...(embedded ? { borderTop: EDGE } : {}),
  };

  return (
    <div
      data-sound-scope="semantic"
      data-forge-command-owner="hider-dock"
      data-forge-panels={panelsExpanded ? "expanded" : "collapsed"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: embedded ? 0 : 10,
        width: panelsExpanded ? (embedded ? "100%" : width) : 30,
        alignSelf: "flex-start",
        transition: "width 140ms ease",
      }}
    >
      <button
        {...hudProps}
        type="button"
        className={PRESS_CLASS}
        aria-label={panelsExpanded ? "Collapse Forge tools" : "Expand Forge tools"}
        title={panelsExpanded ? "Collapse Forge tools" : "Expand Forge tools"}
        aria-expanded={panelsExpanded}
        onClick={togglePanels}
        style={{
          ...buttonStyle,
          margin: 0,
          width: panelsExpanded ? "100%" : 30,
          minHeight: panelsExpanded ? undefined : 142,
          padding: panelsExpanded ? (embedded ? "7px 8px" : "8px 10px") : "9px 5px",
          textAlign: "center",
          borderRadius: panelsExpanded ? 8 : "0 8px 8px 0",
          writingMode: panelsExpanded ? undefined : "vertical-rl",
          textOrientation: panelsExpanded ? undefined : "mixed",
        }}
      >
        {panelsExpanded ? "Collapse Forge tools" : "Expand Forge tools"}{" "}
        <span aria-hidden>{panelsExpanded ? "\u25c0" : "\u25b6"}</span>
      </button>

      {panelsExpanded ? <>
      <div
        {...hudProps}
        role="group"
        aria-label="Forge tools"
        style={{ ...cardStyle, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
      >
        {FORGE_TOOL_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={state.activeMode === mode}
            className={PRESS_CLASS}
            style={{
              ...(state.activeMode === mode ? activeButtonStyle : buttonStyle),
              marginBottom: 0,
              padding: "7px 8px",
            }}
            onClick={() => controller.setToolMode(mode)}
          >
            <Keycap>{TOOL_KEYS[mode]}</Keycap>
            {TOOL_LABELS[mode]}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={state.mirror}
          className={PRESS_CLASS}
          style={{
            ...(state.mirror ? activeButtonStyle : buttonStyle),
            marginBottom: 0,
            padding: "7px 8px",
          }}
          onClick={() => controller.setMirror(!state.mirror)}
        >
          <Keycap>M</Keycap>
          Mirror
        </button>
      </div>

      {state.activeMode === null || state.activeMode === "paint" ? null : (
        <div {...hudProps} style={cardStyle}>
          <ContextPanel controller={controller} state={state} onCommit={commit} />
        </div>
      )}

      <div {...hudProps} style={{ pointerEvents: "auto" }}>
        <PaintPanel tool={controller.paint} />
      </div>

      <div {...hudProps} style={{ ...cardStyle, display: "flex", gap: 6 }}>
        <button
          type="button"
          style={{ ...buttonStyle, marginBottom: 0, opacity: state.canUndo ? 1 : 0.4 }}
          onClick={() => {
            controller.undo();
          }}
        >
          ⟲ Undo
        </button>
        <button
          type="button"
          style={{ ...buttonStyle, marginBottom: 0, opacity: state.canRedo ? 1 : 0.4 }}
          onClick={() => {
            controller.redo();
          }}
        >
          ⟳ Redo
        </button>
      </div>
      </> : null}
    </div>
  );
}

interface ContextPanelProps {
  readonly controller: ForgeController;
  readonly state: ForgeHudState;
  readonly onCommit: () => void;
}

/**
 * The controls for whichever tool is selected.
 *
 * Paint has none here. It used to carry a "Body paint" card whose whole content
 * was a third wording of the instruction the paint panel and the status strip
 * were already both giving, on the one screen where a second panel is also
 * competing for the width. The paint panel is the tool; this returns nothing and
 * both callers leave the space to it.
 */
function ContextPanel({ controller, state, onCommit }: ContextPanelProps): ReactElement | null {
  if (state.mode === "shape") {
    return <ShapePanel controller={controller} state={state} onCommit={onCommit} />;
  }
  if (state.mode === "panels") {
    return <PanelPanel controller={controller} state={state} onCommit={onCommit} />;
  }
  if (state.mode === "material") {
    return <MaterialPanel controller={controller} state={state} />;
  }
  if (state.mode === "paint") {
    return null;
  }
  return <ArrangementPanel controller={controller} state={state} />;
}

function ArrangementPanel({
  controller,
  state,
}: {
  readonly controller: ForgeController;
  readonly state: ForgeHudState;
}): ReactElement {
  return (
    <Section title="Starter arrangements">
      <div style={{ opacity: 0.65, marginBottom: 10 }}>
        A starting point, not a disguise. Drag the handles from here.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {STARTER_ARRANGEMENT_IDS.map((id: StarterArrangementId) => (
          <button
            key={id}
            type="button"
            aria-label={`Preview ${starterArrangementLabel(id)} arrangement`}
            style={{
              ...(state.previewArrangementId === id || state.arrangementId === id ? activeButtonStyle : buttonStyle),
              margin: 0,
              padding: "7px 6px",
              textAlign: "center",
            }}
            onPointerEnter={() => controller.beginArrangementPreview(id)}
            onPointerLeave={() => controller.cancelArrangementPreview()}
            onFocus={() => controller.beginArrangementPreview(id)}
            onBlur={() => controller.cancelArrangementPreview()}
            onClick={() => controller.commitArrangementPreview(id)}
          >
            <ArrangementThumbnail id={id} />
            <span style={{ display: "block", marginTop: 3, fontSize: 10 }}>{starterArrangementLabel(id)}</span>
          </button>
        ))}
      </div>
      {state.undoLabel?.startsWith("arrangement ") ? (
        <button type="button" style={{ ...buttonStyle, marginTop: 8, marginBottom: 0 }} onClick={() => controller.undo()}>
          Undo preset
        </button>
      ) : null}
    </Section>
  );
}

const FORM_SLIDERS: readonly { readonly key: SegmentFormNumericKey; readonly label: string; readonly min: number }[] = [
  { key: "length", label: "Length", min: 0 },
  { key: "width", label: "Width", min: 0 },
  { key: "depth", label: "Depth", min: 0 },
  { key: "flatten", label: "Flatten", min: 0 },
  { key: "taper", label: "Taper", min: -1 },
  { key: "roundness", label: "Roundness", min: 0 },
  { key: "twist", label: "Twist", min: -1 },
];

function ShapePanel({ controller, state, onCommit }: ContextPanelProps): ReactElement {
  const segment = state.segment;
  if (segment === null) {
    return (
      <Section title="Shape">
        <div style={{ opacity: 0.65 }}>Click a body part to stretch it.</div>
      </Section>
    );
  }
  return (
    <Section
      title={
        state.selectedCount > 1
          ? `${String(state.selectedCount)} parts`
          : segment.bone.replace(/_/g, " ")
      }
    >
      <div style={{ opacity: 0.65, marginBottom: 8 }}>
        Drag the red, green, and blue arrows on the part to resize it — width, length, and depth.
        Shift-click other parts to resize them together. Mirror repeats every change.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5, marginBottom: 12 }}>
        {FORGE_QUICK_SHAPES.map((preset) => (
          <button
            key={preset.label}
            type="button"
            style={{ ...buttonStyle, textAlign: "center", padding: "6px 4px", margin: 0 }}
            onClick={() => controller.applySegmentFormPreset(preset.values, preset.profileId)}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          style={{ ...buttonStyle, textAlign: "center", padding: "6px 4px", margin: 0 }}
          onClick={() => controller.resetSelectedSegmentForm()}
        >
          Reset
        </button>
      </div>
      <details style={{ borderTop: EDGE, paddingTop: 8 }}>
        <summary style={{ cursor: "pointer", color: BRASS_LIT, marginBottom: 8 }}>Surface shaping</summary>
        {FORM_SLIDERS.filter((slider) => !["length", "width", "depth"].includes(slider.key)).map((slider) => (
          <Slider
            key={slider.key}
            label={slider.label}
            min={slider.min}
            max={1}
            step={0.01}
            value={segment.form[slider.key]}
            remountKey={`${segment.slot}:${slider.key}:${state.formEpoch}`}
            onInput={(value) => controller.setSegmentFormValue(slider.key, value)}
            onCommit={onCommit}
          />
        ))}
        <span style={labelStyle}><span>Profile</span></span>
        <select
          style={selectStyle}
          value={segment.form.profileId}
          onChange={(event) => {
            controller.setSegmentProfile(event.target.value as SegmentProfileId);
            controller.commitEdits();
          }}
        >
          {SEGMENT_PROFILE_IDS.map((id) => (
            <option key={id} value={id} style={{ color: "#14100c" }}>{id.replace(/_/g, " ")}</option>
          ))}
        </select>
      </details>
    </Section>
  );
}

const ARRANGEMENT_GLYPHS: Readonly<Record<StarterArrangementId, string>> = {
  upright: "│",
  compact: "●",
  wide: "↔",
  tall: "↕",
  tripod: "△",
  wall_mount: "╫",
  shelf_bundle: "≡",
  hanging: "✣",
};

function ArrangementThumbnail({ id }: { readonly id: StarterArrangementId }): ReactElement {
  return (
    <span
      aria-hidden
      style={{
        display: "grid",
        placeItems: "center",
        width: "100%",
        height: 29,
        borderRadius: 5,
        background: "radial-gradient(circle, rgba(216,173,99,0.18), rgba(8,6,4,0.36))",
        color: BRASS_LIT,
        font: `600 24px/1 ${FONT_DISPLAY}`,
      }}
    >
      {ARRANGEMENT_GLYPHS[id]}
    </span>
  );
}

function LockReadiness({ state }: { readonly state: ForgeHudState }): ReactElement {
  const valid = state.lockIssues.length === 0;
  const anchorsStable = state.unsatisfiedAnchors.length === 0;
  const rows = [
    ["Legal shape", valid],
    ["Contacts stable", anchorsStable],
    ["Ready to deploy", valid && anchorsStable],
  ] as const;
  return (
    <div aria-label="Disguise readiness" aria-live="polite" style={{ marginBottom: 9 }}>
      <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1, marginBottom: 5 }}>Lock readiness</div>
      {rows.map(([label, ready]) => (
        <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10, color: ready ? CREAM : "#e0785f" }}>
          <span>{label}</span><span>{ready ? "✓" : "!"}</span>
        </div>
      ))}
      {valid ? null : <div style={{ marginTop: 5, fontSize: 10, color: "#e0785f" }}>{state.lockIssues[0]}</div>}
      {anchorsStable ? null : <div style={{ marginTop: 3, fontSize: 10, color: "#e0785f" }}>Adjust: {state.unsatisfiedAnchors.join(", ")}</div>}
    </div>
  );
}

const PANEL_SLIDERS: readonly {
  readonly key: PanelNumericKey;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}[] = [
  { key: "deployed", label: "Deploy", min: 0, max: 1, step: 0.01 },
  { key: "hingeAngle", label: "Hinge", min: -180, max: 180, step: 1 },
  { key: "extension", label: "Extension", min: 0, max: 1, step: 0.01 },
  { key: "width", label: "Width", min: 0, max: 1, step: 0.01 },
  { key: "height", label: "Height", min: 0, max: 1, step: 0.01 },
];

function PanelPanel({ controller, state, onCommit }: ContextPanelProps): ReactElement {
  const selection = state.panel;
  if (selection === null || selection.panel === null) {
    return (
      <Section title="Panels">
        <div style={{ opacity: 0.65 }}>
          Click a brass stud on the body to fold a panel out of that socket.
        </div>
      </Section>
    );
  }
  const panel = selection.panel;
  return (
    <Section title={selection.socketId.replace("panel_socket_", "panel ")}>
      <div style={{ opacity: 0.65, marginBottom: 8 }}>
        Pick a panel shape, then drag its glowing tip in the world to place it.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 12 }}>
        {FORGE_QUICK_PANELS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            style={{ ...buttonStyle, textAlign: "center", margin: 0 }}
            onClick={() => controller.applyPanelPreset(preset.values, preset.profileId)}
          >
            {preset.label}
          </button>
        ))}
      </div>
      {PANEL_SLIDERS.filter((slider) => ["deployed", "width", "height"].includes(slider.key)).map((slider) => (
        <Slider
          key={slider.key}
          label={slider.label}
          min={slider.min}
          max={slider.max}
          step={slider.step}
          value={panel[slider.key]}
          remountKey={`${selection.socketId}:${slider.key}:${state.formEpoch}`}
          onInput={(value) => {
            controller.setPanelValue(slider.key, value);
          }}
          onCommit={onCommit}
        />
      ))}
      <details style={{ borderTop: EDGE, paddingTop: 8, marginBottom: 8 }}>
        <summary style={{ cursor: "pointer", color: BRASS_LIT, marginBottom: 8 }}>Hinge and profile</summary>
        {PANEL_SLIDERS.filter((slider) => ["hingeAngle", "extension"].includes(slider.key)).map((slider) => (
          <Slider
            key={slider.key}
            label={slider.label}
            min={slider.min}
            max={slider.max}
            step={slider.step}
            value={panel[slider.key]}
            remountKey={`${selection.socketId}:${slider.key}:${state.formEpoch}`}
            onInput={(value) => controller.setPanelValue(slider.key, value)}
            onCommit={onCommit}
          />
        ))}
        <span style={labelStyle}><span>Profile</span></span>
        <select
          style={selectStyle}
          value={panel.profileId}
          onChange={(event) => {
            controller.setPanelProfile(event.target.value as PanelProfileId);
            controller.commitEdits();
          }}
        >
          {PANEL_PROFILE_IDS.map((id) => (
            <option key={id} value={id} style={{ color: "#14100c" }}>{id.replace(/_/g, " ")}</option>
          ))}
        </select>
      </details>
      <button
        type="button"
        style={{ ...buttonStyle, marginBottom: 0 }}
        onClick={() => {
          controller.removePanel(selection.socketId);
        }}
      >
        Stow this panel
      </button>
    </Section>
  );
}

function MaterialPanel({
  controller,
  state,
}: {
  readonly controller: ForgeController;
  readonly state: ForgeHudState;
}): ReactElement {
  const held = state.sampledSwatchId === null ? null : swatchById(state.sampledSwatchId);
  return (
    <Section title="Material">
      <div style={{ opacity: 0.65, marginBottom: 10 }}>
        Pick a swatch below, or press F and click anything — the room or your own
        parts — to copy its swatch. Then click a body part to paint it.
      </div>
      <button
        type="button"
        className={PRESS_CLASS}
        aria-pressed={state.materialDropperArmed}
        style={{
          ...buttonStyle,
          width: "100%",
          marginBottom: 10,
          borderColor: state.materialDropperArmed ? BRASS_LIT : undefined,
        }}
        onClick={() => controller.setMaterialDropperArmed(!state.materialDropperArmed)}
      >
        Dropper F{state.materialDropperArmed ? " · click to copy" : ""}
      </button>
      {/* The tray scrolls inside itself: at 720p a full family list ran on
          under the lock panel, and a swatch nobody can reach is not offered. */}
      <div style={{ maxHeight: "38vh", overflowY: "auto", paddingRight: 4, marginBottom: 2 }}>
      {MATERIAL_FAMILY_ORDER.map((family) => {
        const row = controller.swatches.filter((swatch) => swatch.family === family);
        if (row.length === 0) return null;
        return (
          <div key={family} style={{ marginBottom: 8 }}>
            <div
              style={{
                fontSize: 9,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: BRASS_LIT,
                opacity: 0.8,
                marginBottom: 4,
              }}
            >
              {MATERIAL_FAMILY_LABELS[family]}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {row.map((swatch) => {
                const selected = state.sampledSwatchId === swatch.id;
                return (
                  <button
                    key={swatch.id}
                    type="button"
                    title={swatch.label}
                    aria-label={swatch.label}
                    aria-pressed={selected}
                    onClick={() => {
                      controller.selectSwatch(swatch.id);
                    }}
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 7,
                      cursor: "pointer",
                      border: selected ? `2px solid ${BRASS_LIT}` : EDGE,
                      boxShadow: selected
                        ? "0 0 12px rgba(255, 190, 107, 0.45)"
                        : "inset 0 1px 0 rgba(255, 255, 255, 0.12)",
                      background: swatchChipBackground(swatch),
                    }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          margin: "10px 0",
          padding: "7px 9px",
          border: EDGE,
          borderRadius: 8,
          borderColor: held === null ? undefined : BRASS_LIT,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            flexShrink: 0,
            border: EDGE,
            background: held === null ? "transparent" : swatchChipBackground(held),
          }}
        />
        <span style={{ minWidth: 0 }}>
          {held === null ? (
            <span style={{ opacity: 0.6 }}>Nothing held — pick or sample a swatch.</span>
          ) : (
            <>
              <span style={{ color: BRASS_LIT }}>{held.label}</span>
              <span style={{ opacity: 0.55 }}> · {MATERIAL_FAMILY_LABELS[held.family]}</span>
            </>
          )}
        </span>
      </div>
      <button
        type="button"
        className={PRESS_CLASS}
        disabled={held === null}
        style={{ ...buttonStyle, opacity: held === null ? 0.5 : 1 }}
        onClick={() => {
          controller.assignSwatch("body");
        }}
      >
        Apply to whole body
      </button>
      <div style={{ opacity: 0.6, fontSize: 11 }}>
        Body swatch: {swatchById(state.bodySwatchId)?.label ?? state.bodySwatchId}
      </div>
    </Section>
  );
}

/** Tray order and tray names for the swatch families a Mimic may wear. */
const MATERIAL_FAMILY_ORDER: readonly MaterialFamily[] = [
  "wood",
  "metal",
  "ceramic",
  "paint",
  "fabric",
  "paper",
  "stone",
  "glass",
  "plastic",
];
const MATERIAL_FAMILY_LABELS: Readonly<Record<MaterialFamily, string>> = {
  wood: "Woods",
  metal: "Metals",
  ceramic: "Ceramics",
  paint: "Painted",
  fabric: "Cloth",
  paper: "Paper",
  stone: "Stone",
  glass: "Glass",
  plastic: "Bakelite",
};

/**
 * A chip wears its material, not only its colour: metals catch a diagonal
 * highlight and polished finishes a top sheen, so the tray reads as finishes
 * rather than as a paint palette (which is the other tool).
 */
function swatchChipBackground(swatch: MaterialSwatch): string {
  const rgb = `rgb(${swatch.baseColor.map((value) => Math.round(value * 255)).join(",")})`;
  if (swatch.metalness > 0.5) {
    return `linear-gradient(135deg, rgba(255,255,255,0.5), rgba(255,255,255,0) 45%), ${rgb}`;
  }
  if (swatch.roughness < 0.25) {
    return `linear-gradient(180deg, rgba(255,255,255,0.32), rgba(255,255,255,0) 38%), ${rgb}`;
  }
  return rgb;
}
