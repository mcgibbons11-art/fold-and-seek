import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import { FORGE_UI_ATTRIBUTE } from "../../forge/ForgeController";
import { PAINT_SHADOW_LABEL, PAINT_SHADOW_TITLE } from "../../gameplay/copy";
import { hexToRgb, rgbToCss, rgbToHex, sameColorByte, type Rgb } from "../../paint/color";
import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from "../../paint/PaintBrushController";
import type { PaintPanelState } from "../../paint/paintStore";
import type { PaintTool } from "../../paint/createPaintTool";
import { BRASS_LIT, CREAM, FONT_UI, labelStyle, plate } from "../rounds/theme";

/** The paint panel accents with lit brass and rules with the plate edge. */
const BRASS = BRASS_LIT;
const EDGE = "1px solid rgba(176, 138, 74, 0.30)";
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

// Unpositioned on purpose: the Forge places it beside the tool column, and the
// hunt stacks it inside the left region. A panel that placed itself would have
// to be right about both.
const panelStyle: CSSProperties = {
  width: WHEEL_SIZE + 28,
  ...plate(),
  borderRadius: 10,
  padding: "12px 14px",
  pointerEvents: "auto",
  backdropFilter: "blur(6px)",
  color: CREAM,
  font: `13px/1.5 ${FONT_UI}`,
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

const fieldStyle: CSSProperties = {
  background: "rgba(232, 221, 205, 0.08)",
  color: CREAM,
  border: EDGE,
  borderRadius: 6,
  padding: "4px 6px",
  font: "inherit",
  fontVariantNumeric: "tabular-nums",
  pointerEvents: "auto",
};

const hexFieldStyle: CSSProperties = { ...fieldStyle, flex: 1, minWidth: 0 };

const numberFieldStyle: CSSProperties = { ...fieldStyle, width: "100%", boxSizing: "border-box" };

const pinButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: BRASS,
  font: "inherit",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
  padding: 0,
  pointerEvents: "auto",
};

const hudProps = { [FORGE_UI_ATTRIBUTE]: "" };

interface SwatchButtonProps {
  readonly color: Rgb | undefined;
  readonly onPick: (color: Rgb) => void;
}

function SwatchButton(props: SwatchButtonProps): ReactElement {
  const { color, onPick } = props;
  return (
    <button
      type="button"
      disabled={color === undefined}
      title={color === undefined ? "Empty" : rgbToHex(color)}
      onClick={() => {
        if (color !== undefined) onPick(color);
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
}

interface PaintPanelProps {
  readonly tool: PaintTool;
}

export function PaintPanel(props: PaintPanelProps): ReactElement | null {
  const { tool } = props;
  const [state, setState] = useState<PaintPanelState>(() => tool.getState());
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /**
   * Held only while the field has focus. Without it, typing "#f" would be
   * rewritten to the full hex of whatever that parsed to on every keystroke.
   */
  const [hexDraft, setHexDraft] = useState<string | null>(null);

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
  const isSaved = state.savedColors.some((entry) => sameColorByte(entry, state.color));

  return (
    <div
      style={panelStyle}
      {...hudProps}
      data-paint-stroke-count={state.strokeCount}
      data-paint-active={state.active ? "true" : "false"}
    >
      <div style={{ ...labelStyle, marginBottom: 6 }}>Spray colour</div>
      <div style={{ display: "flex", gap: 7 }}>
        <input
          type="color"
          aria-label="Spray colour"
          value={rgbToHex(state.color)}
          style={{ width: 42, height: 32, padding: 2, border: EDGE, borderRadius: 6, background: "transparent" }}
          onChange={(event) => {
            const parsed = hexToRgb(event.target.value);
            if (parsed !== null) tool.setColor(parsed);
          }}
        />
        <input
          value={hexDraft ?? rgbToHex(state.color)}
          spellCheck={false}
          aria-label="Hex colour"
          style={hexFieldStyle}
          onChange={(event) => {
            const text = event.target.value;
            setHexDraft(text);
            const parsed = hexToRgb(text);
            if (parsed !== null) tool.setColor(parsed);
          }}
          onBlur={() => {
            setHexDraft(null);
          }}
        />
      </div>

      {/* The brush comes before the material channels and the swatch grids.
          At 1280x720 the panel is 773 px of content in a 502 px box, and in the
          old order everything below RECENT — the brush, the flow, the dropper
          and the eraser, which is the whole of how you actually paint — was
          under the fold. Frequency of use is the order now. */}
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

      <button
        type="button"
        aria-expanded={advancedOpen}
        aria-controls="advanced-paint-controls"
        style={{ ...toggleStyle, width: "100%", marginTop: 10 }}
        onClick={() => setAdvancedOpen((open) => !open)}
      >
        {advancedOpen ? "Hide advanced" : "Advanced paint"}
      </button>

      {advancedOpen ? (
        <div id="advanced-paint-controls" style={{ paddingTop: 12, borderTop: EDGE, marginTop: 10 }}>
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

          <div style={{ ...labelStyle, marginTop: 10 }}>RGB 0-255</div>
          <div style={{ display: "flex", gap: 6 }}>
            {(["R", "G", "B"] as const).map((channel, index) => (
              <label key={channel} style={{ flex: 1 }}>
                <input
                  type="number"
                  min={0}
                  max={255}
                  aria-label={`${channel} 0 to 255`}
                  value={Math.round((state.color[index] ?? 0) * 255)}
                  style={numberFieldStyle}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    const next: [number, number, number] = [state.color[0], state.color[1], state.color[2]];
                    next[index] = Math.min(255, Math.max(0, Math.round(value))) / 255;
                    tool.setColor(next);
                  }}
                />
              </label>
            ))}
          </div>

      <div style={{ ...labelStyle, marginTop: 10 }}>
        Metallic {Math.round(state.metallic * 100)}
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={state.metallic}
        style={sliderStyle}
        onChange={(event) => {
          tool.setMetallic(Number(event.target.value));
        }}
      />

      <div style={labelStyle}>Smoothness {Math.round(state.smoothness * 100)}</div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={state.smoothness}
        style={sliderStyle}
        onChange={(event) => {
          tool.setSmoothness(Number(event.target.value));
        }}
      />

      {/* A stroke glows in its own colour, so this is a strength and not a
          second colour to pick. Bloom reads the emissive buffer, which is why a
          marking painted up here reads as a lit sign rather than a pale one. */}
      <div style={labelStyle}>Emissive {Math.round(state.emissive * 100)}</div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        aria-label="Emissive"
        value={state.emissive}
        style={sliderStyle}
        onChange={(event) => {
          tool.setEmissive(Number(event.target.value));
        }}
      />

      <div style={{ ...labelStyle, marginTop: 10, display: "flex", justifyContent: "space-between" }}>
        <span>Saved</span>
        <button
          type="button"
          aria-label={isSaved ? "Unpin colour" : "Pin colour"}
          style={pinButtonStyle}
          onClick={() => {
            tool.toggleSavedColor();
          }}
        >
          {isSaved ? "unpin" : "pin"}
        </button>
      </div>
      <div style={swatchRowStyle}>
        {Array.from({ length: 8 }, (_, index) => (
          <SwatchButton
            key={index}
            color={state.savedColors[index]}
            onPick={(color) => {
              tool.setColor(color);
            }}
          />
        ))}
      </div>

      <div style={{ ...labelStyle, marginTop: 10 }}>Recent</div>
      <div style={swatchRowStyle}>
        {Array.from({ length: 8 }, (_, index) => (
          <SwatchButton
            key={index}
            color={state.recentColors[index]}
            onPick={(color) => {
              tool.setColor(color);
            }}
          />
        ))}
      </div>

      <div style={rowStyle}>
        {/* Not a paint channel: it turns the Mimic's own cast shadow off. It sat
            here labelled "Shadow" beside Eraser and Clear, where it read as one. */}
        <button
          type="button"
          title={PAINT_SHADOW_TITLE}
          style={state.shadow ? activeToggleStyle : toggleStyle}
          onClick={() => {
            tool.setShadow(!state.shadow);
          }}
        >
          {PAINT_SHADOW_LABEL}
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
        </div>
      ) : null}

      <div style={{ ...labelStyle, marginTop: 10 }}>
        Paint used {budget}%
      </div>
      {/* The panel's one line of prose, and the only place the instruction is
          given. It opens on `PAINT_INSTRUCTION` and the eyedropper and the
          clear replace it with what they just did, so this is a live line
          rather than a caption. */}
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{state.status}</div>
    </div>
  );
}
