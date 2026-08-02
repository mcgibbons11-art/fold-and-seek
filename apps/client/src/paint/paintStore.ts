import { MAX_PAINT_STROKES } from "@foldseek/shared";

import { hsvToRgb, rgbToHsv, sameColorByte, type Hsv, type Rgb } from "./color";

/**
 * Discrete state the paint HUD renders (bible §12.4 pattern): the panel
 * subscribes, the controller pushes. Continuous work stays out of React, the
 * same way the Forge keeps its sliders uncontrolled, so dragging the brush never
 * re-renders the tree.
 */

export const RECENT_COLOR_COUNT = 8;

/** MECCHA's quick-swap row: colours the player pinned, not ones they happened to use. */
export const SAVED_COLOR_COUNT = 8;

export interface PaintPanelState {
  readonly active: boolean;
  readonly hsv: Hsv;
  readonly color: Rgb;
  /** The colour in the brush when the panel last committed a stroke, for comparison. */
  readonly previousColor: Rgb;
  readonly brushSize: number;
  readonly opacity: number;
  readonly metallic: number;
  readonly smoothness: number;
  /** How much the brush glows, in its own colour. */
  readonly emissive: number;
  readonly eraser: boolean;
  readonly eyedropperArmed: boolean;
  readonly shadow: boolean;
  readonly recentColors: readonly Rgb[];
  readonly savedColors: readonly Rgb[];
  readonly strokeCount: number;
  readonly maxStrokes: number;
  readonly status: string;
}

const DEFAULT_HSV: Hsv = { h: 0.03, s: 0.72, v: 0.85 };

export class PaintStore {
  private state: PaintPanelState;
  private readonly listeners = new Set<(state: PaintPanelState) => void>();

  constructor(brushSize: number) {
    this.state = {
      active: false,
      hsv: DEFAULT_HSV,
      color: hsvToRgb(DEFAULT_HSV),
      previousColor: hsvToRgb(DEFAULT_HSV),
      brushSize,
      opacity: 1,
      metallic: 0,
      smoothness: 0.35,
      emissive: 0,
      eraser: false,
      eyedropperArmed: false,
      shadow: true,
      recentColors: [],
      savedColors: [],
      strokeCount: 0,
      maxStrokes: MAX_PAINT_STROKES,
      status: "Drag on your body to paint. F samples a colour from the room.",
    };
  }

  getState(): PaintPanelState {
    return this.state;
  }

  subscribe(listener: (state: PaintPanelState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  patch(next: Partial<PaintPanelState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  setHsv(hsv: Hsv): void {
    this.patch({ hsv, color: hsvToRgb(hsv), eraser: false });
  }

  /** Used by the eyedropper, which has a colour but no hue to speak of. */
  setColor(color: Rgb): void {
    this.patch({ color, hsv: rgbToHsv(color), eraser: false });
  }

  /**
   * Files the current colour in the recent row. Called when a stroke commits
   * rather than on every wheel movement, so the row holds colours that were
   * actually used.
   */
  rememberColor(color: Rgb): void {
    const kept = this.state.recentColors.filter((entry) => !sameColorByte(entry, color));
    this.patch({
      recentColors: [color, ...kept].slice(0, RECENT_COLOR_COUNT),
      previousColor: color,
    });
  }

  /** Pins the current colour to the quick-swap row, or unpins it if already there. */
  toggleSavedColor(color: Rgb): void {
    const existing = this.state.savedColors;
    if (existing.some((entry) => sameColorByte(entry, color))) {
      this.patch({ savedColors: existing.filter((entry) => !sameColorByte(entry, color)) });
      return;
    }
    this.patch({ savedColors: [...existing, color].slice(0, SAVED_COLOR_COUNT) });
  }
}
