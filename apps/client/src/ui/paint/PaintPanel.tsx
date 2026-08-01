import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import { FORGE_UI_ATTRIBUTE } from "../../forge/ForgeController";
import { rgbToCss, rgbToHex } from "../../paint/color";
import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from "../../paint/PaintBrushController";
import type { PaintPanelState } from "../../paint/paintStore";
import type { PaintTool } from "../../paint/createPaintTool";
import { BRASS, CREAM, EDGE, INK, labelStyle } from "../rounds/theme";
import { ColorWheel, WHEEL_SIZE } from "./ColorWheel";

/**
 * Body-painting panel (MECCHA port, CLAUDE.md override 3), in the instrument
 * vocabulary the rest of the HUD speaks: cream on lacquer, brass for whatever
 * the player is holding. The reference panel's controls are all here, the wheel
 * and value strip, the recent colours, brush size, the eyedropper, the eraser
 * and the shadow toggle, with a clear that asks before it throws the work away.
 *
 * #root is pointer-events: none, so every control sets its own.
 */

const panelStyle: CSSProperties = {
  position: "absolute",
  left: 16,
  top: 16,
  width: WHEEL_SIZE + 28,
  background: INK,
  border: EDGE,
  borderRadius: 10,
  padding: "12px 14px",
  pointerEvents: "auto",
  backdropFilter: "blur(6px)",
  color: CREAM,
  font: "13px/1.5 system-ui, sans-serif",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 10,
};

const sliderStyle: CSSProperties = {
  width: "100%",
  accentColor: BRASS,
  cursor: "ew-resize",
};

const toggleStyle: CSSProperties = {
  flex: 1,
  background: "rgba(232, 221, 205, 0.06)",
  color: CREAM,
  border: EDGE,
  borderRadius: 7,
  padding: "6px 8px",
  font: "inherit",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  cursor: "pointer",
  pointerEvents: "auto",
};

const activeToggleStyle: CSSProperties = {
  ...toggleStyle,
  background: "rgba(176, 138, 74, 0.28)",
  border: `1px solid ${BRASS}`,
  color: "#fff3df",
};

const swatchRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(8, 1fr)",
  gap: 4,
  marginTop: 8,
};

const hudProps = { [FORGE_UI_ATTRIBUTE]: "" };

interface PaintPanelProps {
  readonly tool: PaintTool;
}

export function PaintPanel(props: PaintPanelProps): ReactElement | null {
  const { tool } = props;
  const [state, setState] = useState<PaintPanelState>(() => tool.getState());
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => tool.store.subscribe(setState), [tool]);

  // F arms the eyedropper while painting, the key MECCHA uses for it. The Forge
  // owns every other key; this one only fires while the paint tool has focus of
  // its own and the player is not typing.
  useEffect(() => {
    if (!state.active) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "f" && event.key !== "F") return;
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      tool.armEyedropper(!tool.getState().eyedropperArmed);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [state.active, tool]);

  if (!state.active) return null;

  const budget = Math.round((state.strokeCount / state.maxStrokes) * 100);

  return (
    <div style={panelStyle} {...hudProps}>
      <ColorWheel hsv={state.hsv} onChange={(hsv) => tool.setHsv(hsv)} />

      <div style={{ ...labelStyle, marginTop: 10 }}>Value</div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={state.hsv.v}
        style={sliderStyle}
        onChange={(event) => {
          tool.setHsv({ ...state.hsv, v: Number(event.target.value) });
        }}
      />

      <div style={rowStyle}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 6,
            border: EDGE,
            background: rgbToCss(state.color),
          }}
        />
        <div>
          <div style={labelStyle}>Current</div>
          <div style={{ fontVariantNumeric: "tabular-nums" }}>{rgbToHex(state.color)}</div>
        </div>
      </div>

      <div style={{ ...labelStyle, marginTop: 10 }}>Recent</div>
      <div style={swatchRowStyle}>
        {Array.from({ length: 8 }, (_, index) => {
          const color = state.recentColors[index];
          return (
            <button
              key={index}
              type="button"
              disabled={color === undefined}
              title={color === undefined ? "Empty" : rgbToHex(color)}
              onClick={() => {
                if (color !== undefined) tool.setColor(color);
              }}
              style={{
                height: 18,
                borderRadius: 4,
                border: EDGE,
                padding: 0,
                cursor: color === undefined ? "default" : "pointer",
                pointerEvents: "auto",
                background: color === undefined ? "rgba(232, 221, 205, 0.06)" : rgbToCss(color),
              }}
            />
          );
        })}
      </div>

      <div style={{ ...labelStyle, marginTop: 10 }}>
        Brush {Math.round(state.brushSize * 100)}
      </div>
      <input
        type="range"
        min={MIN_BRUSH_RADIUS}
        max={MAX_BRUSH_RADIUS}
        step={0.005}
        value={state.brushSize}
        style={sliderStyle}
        onChange={(event) => {
          tool.setBrushSize(Number(event.target.value));
        }}
      />

      <div style={labelStyle}>Flow {Math.round(state.opacity * 100)}</div>
      <input
        type="range"
        min={0.05}
        max={1}
        step={0.05}
        value={state.opacity}
        style={sliderStyle}
        onChange={(event) => {
          tool.setOpacity(Number(event.target.value));
        }}
      />

      <div style={rowStyle}>
        <button
          type="button"
          style={state.eyedropperArmed ? activeToggleStyle : toggleStyle}
          onClick={() => {
            tool.armEyedropper(!state.eyedropperArmed);
          }}
        >
          Dropper F
        </button>
        <button
          type="button"
          style={state.eraser ? activeToggleStyle : toggleStyle}
          onClick={() => {
            tool.setEraser(!state.eraser);
          }}
        >
          Eraser
        </button>
      </div>

      <div style={rowStyle}>
        <button
          type="button"
          style={state.shadow ? activeToggleStyle : toggleStyle}
          onClick={() => {
            tool.setShadow(!state.shadow);
          }}
        >
          Shadow
        </button>
        <button
          type="button"
          style={confirmingClear ? activeToggleStyle : toggleStyle}
          onClick={() => {
            if (confirmingClear) {
              tool.clearAll();
              setConfirmingClear(false);
              return;
            }
            setConfirmingClear(true);
          }}
          onBlur={() => {
            setConfirmingClear(false);
          }}
        >
          {confirmingClear ? "Sure?" : "Clear"}
        </button>
      </div>

      <div style={{ ...labelStyle, marginTop: 10 }}>
        Paint used {budget}%
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{state.status}</div>
    </div>
  );
}
