import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";

import {
  STARTER_ARRANGEMENT_IDS,
  starterArrangementLabel,
  type StarterArrangementId,
} from "../mimic/disguiseState";
import { PANEL_PROFILE_IDS, type PanelProfileId } from "../mimic/panels";
import { SEGMENT_PROFILE_IDS, type SegmentProfileId } from "../mimic/segmentForm";
import { swatchById } from "../mimic/visual/materialSwatches";
import { PaintPanel } from "./paint/PaintPanel";
import {
  FORGE_TOOL_MODES,
  FORGE_UI_ATTRIBUTE,
  type ForgeController,
  type ForgeHudState,
  type ForgeToolMode,
  type PanelNumericKey,
  type SegmentFormNumericKey,
} from "../forge/ForgeController";

/**
 * Forge HUD (bible §12.4). React owns layout and discrete state only: sliders
 * are uncontrolled and call straight into the controller, so dragging one never
 * re-renders the tree. They remount when the disguise revision changes, which
 * is what makes undo and a starter arrangement snap the controls back.
 */

const CREAM = "#e8ddcd";
const BRASS = "#b08a4a";
const INK = "rgba(10, 9, 8, 0.82)";
const EDGE = "1px solid rgba(232, 221, 205, 0.16)";

const rootStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  color: CREAM,
  font: "13px/1.5 system-ui, sans-serif",
};

const panelStyle: CSSProperties = {
  position: "absolute",
  background: INK,
  border: EDGE,
  borderRadius: 10,
  padding: "12px 14px",
  pointerEvents: "auto",
  backdropFilter: "blur(6px)",
};

const buttonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "rgba(232, 221, 205, 0.06)",
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
  background: "rgba(176, 138, 74, 0.28)",
  border: `1px solid ${BRASS}`,
  color: "#fff3df",
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
  accentColor: BRASS,
  marginBottom: 8,
  cursor: "ew-resize",
};

const selectStyle: CSSProperties = {
  width: "100%",
  background: "rgba(232, 221, 205, 0.08)",
  color: CREAM,
  border: EDGE,
  borderRadius: 6,
  padding: "5px 7px",
  font: "inherit",
  marginBottom: 10,
};

/** Tells the Forge's pointer handling to keep its hands off this element. */
const hudProps = { [FORGE_UI_ATTRIBUTE]: "" };

const TOOL_LABELS: Readonly<Record<ForgeToolMode, string>> = {
  pose: "1  Pose",
  shape: "2  Shape",
  panels: "3  Panels",
  material: "4  Material",
  paint: "5  Paint",
};

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
      onClick={props.onPress}
      style={{
        flex: 1,
        background: props.active ? "rgba(176, 138, 74, 0.28)" : "rgba(232, 221, 205, 0.06)",
        color: props.active ? "#fff3df" : CREAM,
        border: props.active ? `1px solid ${BRASS}` : EDGE,
        borderRadius: 7,
        padding: "5px 0",
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
      <div style={{ ...labelStyle, opacity: 0.8, marginBottom: 8, color: BRASS }}>{props.title}</div>
      {props.children}
    </div>
  );
}

export interface ForgeHudProps {
  readonly controller: ForgeController;
  readonly onExit: () => void;
  /** What leaving means here. Practice leaves the Forge; a round leaves the round. */
  readonly exitLabel?: string;
}

export function ForgeHud({ controller, onExit, exitLabel }: ForgeHudProps): ReactElement {
  const [state, setState] = useState<ForgeHudState>(() => controller.snapshot());

  useEffect(() => controller.subscribe(setState), [controller]);

  const commit = (): void => {
    controller.commitEdits();
  };

  return (
    <div style={rootStyle}>
      <div
        {...hudProps}
        style={{
          ...panelStyle,
          top: 16,
          left: "50%",
          transform: "translateX(-50%)",
          textAlign: "center",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          fontSize: 11,
          padding: "8px 18px",
        }}
      >
        <span style={{ color: state.locked ? BRASS : CREAM }}>
          {state.locked ? "Disguise locked" : `Forge · ${state.mode}`}
        </span>
        {state.mirror ? <span style={{ color: BRASS, marginLeft: 12 }}>mirror</span> : null}
      </div>

      <div {...hudProps} style={{ ...panelStyle, top: 74, left: 16, width: 132 }}>
        {FORGE_TOOL_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            style={state.mode === mode ? activeButtonStyle : buttonStyle}
            onClick={() => {
              controller.setToolMode(mode);
            }}
          >
            {TOOL_LABELS[mode]}
          </button>
        ))}
        <button
          type="button"
          style={state.mirror ? activeButtonStyle : buttonStyle}
          onClick={() => {
            controller.setMirror(!state.mirror);
          }}
        >
          M  Mirror
        </button>
      </div>

      {/* The paint panel places itself at 16/16 and draws nothing unless the
          paint tool is active. The wrapper is what puts that origin beside the
          tool column instead of on top of it. */}
      <div style={{ position: "absolute", left: 148, top: 58 }}>
        <PaintPanel tool={controller.paint} />
      </div>

      <div {...hudProps} style={{ ...panelStyle, top: 74, right: 16, width: 236, maxHeight: "70vh", overflowY: "auto" }}>
        <ContextPanel controller={controller} state={state} onCommit={commit} />
      </div>

      <div
        {...hudProps}
        style={{
          ...panelStyle,
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
          maxWidth: 620,
          textAlign: "center",
          opacity: 0.9,
        }}
      >
        {state.status}
      </div>

      <div {...hudProps} style={{ ...panelStyle, bottom: 16, left: 16, width: 132 }}>
        <button
          type="button"
          style={{ ...buttonStyle, opacity: state.canUndo ? 1 : 0.4 }}
          onClick={() => {
            controller.undo();
          }}
        >
          ⟲ Undo{state.undoLabel === null ? "" : ` ${state.undoLabel}`}
        </button>
        <button
          type="button"
          style={{ ...buttonStyle, opacity: state.canRedo ? 1 : 0.4, marginBottom: 0 }}
          onClick={() => {
            controller.redo();
          }}
        >
          ⟳ Redo
        </button>
      </div>

      <div {...hudProps} style={{ ...panelStyle, bottom: 132, right: 16, width: 176 }}>
        <div style={{ ...labelStyle, color: BRASS, marginBottom: 6 }}>Preview</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <PreviewButton
            label="Eye"
            title="Inspector eye height (hold Space)"
            active={state.preview === "inspector"}
            onPress={() => {
              controller.setPreview(state.preview === "inspector" ? "none" : "inspector");
            }}
          />
          <PreviewButton
            label="Door"
            title="Doorway camera"
            active={state.preview === "doorway"}
            onPress={() => {
              controller.setPreview(state.preview === "doorway" ? "none" : "doorway");
            }}
          />
          <PreviewButton
            label="Sil"
            title="Silhouette view (V)"
            active={state.silhouette}
            onPress={() => {
              controller.setSilhouette(!state.silhouette);
            }}
          />
        </div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>
          {state.anchoredBones.length === 0
            ? "No contact anchors"
            : `${state.anchoredBones.length} anchored`}
          {state.unsatisfiedAnchors.length > 0 ? (
            <span style={{ color: "#e0785f" }}>
              {" "}
              · {state.unsatisfiedAnchors.join(", ")} out of reach
            </span>
          ) : null}
        </div>
      </div>

      <div {...hudProps} style={{ ...panelStyle, bottom: 16, right: 16, width: 176 }}>
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
          {state.locked ? "Esc  Unlock" : "Enter  Lock disguise"}
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

interface ContextPanelProps {
  readonly controller: ForgeController;
  readonly state: ForgeHudState;
  readonly onCommit: () => void;
}

function ContextPanel({ controller, state, onCommit }: ContextPanelProps): ReactElement {
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
    return (
      <Section title="Body paint">
        <div style={{ opacity: 0.65 }}>
          Drag on the Mimic to paint it. The wheel, the brush and the dropper are on the left.
        </div>
      </Section>
    );
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
      {STARTER_ARRANGEMENT_IDS.map((id: StarterArrangementId) => (
        <button
          key={id}
          type="button"
          style={state.arrangementId === id ? activeButtonStyle : buttonStyle}
          onClick={() => {
            controller.applyArrangement(id);
          }}
        >
          {starterArrangementLabel(id)}
        </button>
      ))}
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
    <Section title={segment.bone.replace(/_/g, " ")}>
      {FORM_SLIDERS.map((slider) => (
        <Slider
          key={slider.key}
          label={slider.label}
          min={slider.min}
          max={1}
          step={0.01}
          value={segment.form[slider.key]}
          remountKey={`${segment.slot}:${slider.key}:${state.formEpoch}`}
          onInput={(value) => {
            controller.setSegmentFormValue(slider.key, value);
          }}
          onCommit={onCommit}
        />
      ))}
      <span style={labelStyle}>
        <span>Profile</span>
      </span>
      <select
        style={selectStyle}
        value={segment.form.profileId}
        onChange={(event) => {
          controller.setSegmentProfile(event.target.value as SegmentProfileId);
          controller.commitEdits();
        }}
      >
        {SEGMENT_PROFILE_IDS.map((id) => (
          <option key={id} value={id} style={{ color: "#14100c" }}>
            {id.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </Section>
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
      {PANEL_SLIDERS.map((slider) => (
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
      <span style={labelStyle}>
        <span>Profile</span>
      </span>
      <select
        style={selectStyle}
        value={panel.profileId}
        onChange={(event) => {
          controller.setPanelProfile(event.target.value as PanelProfileId);
          controller.commitEdits();
        }}
      >
        {PANEL_PROFILE_IDS.map((id) => (
          <option key={id} value={id} style={{ color: "#14100c" }}>
            {id.replace(/_/g, " ")}
          </option>
        ))}
      </select>
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
        Point at the room and press F to sample it, or pick a swatch below. Then click a body part.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {controller.swatches.map((swatch) => {
          const selected = state.sampledSwatchId === swatch.id;
          return (
            <button
              key={swatch.id}
              type="button"
              title={swatch.label}
              onClick={() => {
                controller.selectSwatch(swatch.id);
              }}
              style={{
                width: 34,
                height: 34,
                borderRadius: 7,
                cursor: "pointer",
                border: selected ? `2px solid ${BRASS}` : EDGE,
                background: `rgb(${swatch.baseColor.map((value) => Math.round(value * 255)).join(",")})`,
              }}
            />
          );
        })}
      </div>
      <div style={{ marginBottom: 10 }}>
        Holding: <span style={{ color: BRASS }}>{held?.label ?? "nothing"}</span>
      </div>
      <button
        type="button"
        style={buttonStyle}
        onClick={() => {
          controller.assignSwatch("body");
        }}
      >
        Paint the whole body
      </button>
      <div style={{ opacity: 0.6, fontSize: 11 }}>
        Body swatch: {swatchById(state.bodySwatchId)?.label ?? state.bodySwatchId}
      </div>
    </Section>
  );
}
