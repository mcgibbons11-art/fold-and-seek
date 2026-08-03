import type { CSSProperties } from "react";

import "../theme.css";

/**
 * The shop's visual vocabulary, in one place.
 *
 * The bar is the cover art: a candlelit Victorian curiosity shop seen at toy
 * scale, warm cream and brass against near-black lacquer, with a serif title.
 * So every surface here is a brass-edged lacquer plate rather than a grey web
 * card, every heading is set in a serif, and the one accent colour is the light
 * a candle throws.
 *
 * Two rules constrain what may change:
 *
 * 1. **Type metrics are load-bearing.** `columnFit.ts` derives the hider column's
 *    card heights from the base 13px/1.5 and the exact rows each card draws, and
 *    `hudLayout.test.ts` checks that arithmetic against the region boxes. A font
 *    *family* may change freely because the line box is set by the ratio; a size
 *    or a line-height inside those cards may not.
 * 2. **#root is pointer-events: none** so the 3D room keeps the pointer, which is
 *    why every interactive element sets pointerEvents: "auto" for itself.
 */

/* ---------------------------------------------------------------- type ---- */

/**
 * Display serif, for anything the shop says in its own voice: titles, phase
 * headlines, stamps. All three stacks are fonts the platform already has, so
 * nothing is fetched — the Portals sandbox blocks external requests, and a
 * webfont that fails to load is a worse title than a system serif that does not.
 */
export const FONT_DISPLAY =
  '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif';

/** Reading and interface text, where a serif at 11px would go muddy. */
export const FONT_UI = '"Avenir Next", "Segoe UI", Inter, system-ui, sans-serif';

/** Anything counted or compared down a column: clocks, scores, distances. */
export const FONT_NUMERIC = FONT_UI;

/* -------------------------------------------------------------- colour ---- */

export const CREAM = "#e8ddcd";
export const BRASS = "#b08a4a";
export const LACQUER = "#14100c";
export const ALARM = "#c8503c";

/** Brass with the light on it: hover states, live values, the lit edge. */
export const BRASS_LIT = "#d8ad63";
/** The candle itself. Used for glow, never for text on a dark ground. */
export const CANDLE = "#ffbe6b";
/** Aged paper, for the few surfaces that read as a card rather than a plate. */
export const PAPER = "#efe2c8";

/** The hairline that separates rows inside a plate. */
export const RULE = "1px solid rgba(176, 138, 74, 0.22)";
/** A plate's own edge: brass, dimmed, so panels read as metal rather than glass. */
export const PLATE_EDGE = "1px solid rgba(176, 138, 74, 0.34)";

/* ------------------------------------------------------------- surfaces ---- */

/**
 * The lacquer plate every panel is cut from: a warm vertical wash, a brass
 * hairline, a lit top edge where the candle catches it, and a shadow deep
 * enough to lift it off the room behind.
 */
export const PLATE_BACKGROUND =
  "linear-gradient(178deg, rgba(41, 30, 19, 0.90) 0%, rgba(22, 16, 10, 0.93) 46%, rgba(13, 10, 7, 0.94) 100%)";

export const PLATE_SHADOW =
  "0 12px 34px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 232, 186, 0.13)";

/** The same plate with the candle sitting behind it, for full-screen cards. */
export const PLATE_SHADOW_LIT =
  "0 18px 52px rgba(0, 0, 0, 0.62), 0 0 46px rgba(255, 190, 107, 0.10), inset 0 1px 0 rgba(255, 232, 186, 0.18)";

/**
 * A panel surface. `lit` is for the handful of cards that own the whole screen
 * and can afford the candle behind them; everything in a live round takes the
 * plain one, because a glow around each of six HUD cards is six light sources
 * the room does not have.
 *
 * The edge is written as four longhands rather than the `border` shorthand
 * because several callers accent one side — the toast's tone bar, the role
 * card's lit top — and React warns when a shorthand and a longhand for the same
 * property are both updated on a rerender.
 */
export function plate(lit = false): CSSProperties {
  return {
    background: PLATE_BACKGROUND,
    borderTop: PLATE_EDGE,
    borderRight: PLATE_EDGE,
    borderBottom: PLATE_EDGE,
    borderLeft: PLATE_EDGE,
    boxShadow: lit ? PLATE_SHADOW_LIT : PLATE_SHADOW,
    backdropFilter: "blur(7px)",
  };
}

/**
 * The warm darkness a full-screen card sits on: a candle above and behind the
 * middle, falling off into the corners of the shop.
 */
export const SCREEN_WASH =
  "radial-gradient(120% 90% at 50% 34%, rgba(58, 38, 18, 0.62) 0%, rgba(12, 9, 6, 0.86) 62%, rgba(6, 5, 4, 0.94) 100%)";

/* ---------------------------------------------------------------- text ---- */

export const overlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  color: CREAM,
  font: `13px/1.5 ${FONT_UI}`,
};

export const panelStyle: CSSProperties = {
  position: "absolute",
  ...plate(),
  borderRadius: 10,
  padding: "12px 14px",
  pointerEvents: "auto",
};

/** Anything the shop says out loud: serif, spaced, and in capitals. */
export const headlineStyle: CSSProperties = {
  font: `600 18px/1.25 ${FONT_DISPLAY}`,
  letterSpacing: "0.2em",
  textTransform: "uppercase",
  margin: 0,
};

/** The small capitals that name a field. */
export const labelStyle: CSSProperties = {
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  fontSize: 10,
  opacity: 0.62,
};

/** A counted value, sized to be read across the room. */
export const figureStyle: CSSProperties = {
  font: `600 22px/1.2 ${FONT_NUMERIC}`,
  fontVariantNumeric: "tabular-nums",
  color: BRASS_LIT,
};

/* ------------------------------------------------------------- controls ---- */

/**
 * A secondary control: dark brass-edged plate. Pair every button with
 * `className: PRESS_CLASS` so it lights under the pointer and under the
 * keyboard, which an inline style cannot express.
 */
export const PRESS_CLASS = "fs-press";

export const buttonStyle: CSSProperties = {
  background: "linear-gradient(180deg, rgba(232, 221, 205, 0.10), rgba(232, 221, 205, 0.03))",
  color: CREAM,
  border: "1px solid rgba(176, 138, 74, 0.38)",
  borderRadius: 7,
  padding: "8px 15px",
  font: `600 11px/1.4 ${FONT_UI}`,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  cursor: "pointer",
  pointerEvents: "auto",
  boxShadow: "inset 0 1px 0 rgba(255, 232, 186, 0.10)",
};

/** The one control on a screen that the player is meant to press. */
export const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  // Bright the whole way down. An earlier gradient fell to #7d5f2f at the
  // bottom and the dark label went muddy across the middle of the cap.
  background: "linear-gradient(180deg, #e7c07a 0%, #cfa159 52%, #b1873f 100%)",
  border: `1px solid #f0d49a`,
  color: "#1d1404",
  textShadow: "0 1px 0 rgba(255, 240, 205, 0.45)",
  boxShadow:
    "0 6px 16px rgba(0, 0, 0, 0.45), 0 0 22px rgba(255, 190, 107, 0.16), inset 0 1px 0 rgba(255, 240, 205, 0.5)",
};

/** Destructive actions are alarm-red and textual; brass remains reserved for progress/selection. */
export const destructiveButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: "#ffd8cf",
  borderColor: "rgba(200, 80, 60, 0.78)",
  background: "repeating-linear-gradient(135deg, rgba(200, 80, 60, 0.23) 0 7px, rgba(70, 24, 18, 0.28) 7px 14px)",
};

export const screenCardStyle: CSSProperties = {
  ...plate(true),
  borderRadius: 14,
  color: CREAM,
  boxSizing: "border-box",
};

export function statusPatternStyle(tone: "active" | "warning" | "error" | "neutral"): CSSProperties {
  if (tone === "active") return { borderColor: BRASS_LIT, background: "linear-gradient(180deg, rgba(216,173,99,.24), rgba(80,57,25,.18))" };
  if (tone === "warning") return { borderColor: CANDLE, background: "repeating-linear-gradient(135deg, rgba(255,190,107,.18) 0 6px, transparent 6px 12px)" };
  if (tone === "error") return { borderColor: ALARM, background: "repeating-linear-gradient(135deg, rgba(200,80,60,.22) 0 6px, transparent 6px 12px)" };
  return { borderColor: "rgba(232,221,205,.4)" };
}

export function disabledButtonStyle(base: CSSProperties): CSSProperties {
  return {
    ...base,
    opacity: 0.32,
    cursor: "not-allowed",
    boxShadow: "none",
    filter: "saturate(0.5)",
  };
}

/**
 * A key the player presses, drawn as an aged ivory cap. The size is passed in
 * because the rail and the hint strip carry different type at different
 * densities and both declare their own heights.
 */
export function keycapStyle(font: string): CSSProperties {
  return {
    display: "inline-block",
    minWidth: 20,
    padding: "1px 5px",
    borderRadius: 4,
    textAlign: "center",
    font,
    letterSpacing: "0.04em",
    color: "#221806",
    background: `linear-gradient(180deg, ${PAPER} 0%, #cdbb9c 100%)`,
    boxShadow: "0 1px 0 rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.6)",
  };
}

/* ------------------------------------------------------------ ornaments ---- */

/**
 * The brass rule under a title: a line that fades out at both ends with a lozenge
 * at its middle, the way a shop sign is ruled. Drawn in gradients rather than an
 * image so it costs nothing and tints with the panel.
 */
export function ornamentRuleStyle(width: number | string = "100%"): CSSProperties {
  return {
    width,
    height: 7,
    margin: "0 auto",
    background: [
      `linear-gradient(90deg, transparent, ${BRASS} 22%, ${BRASS} 78%, transparent) center/100% 1px no-repeat`,
      `radial-gradient(circle at center, ${BRASS_LIT} 0 2.6px, transparent 2.9px) center/9px 7px no-repeat`,
    ].join(", "),
    opacity: 0.75,
  };
}

/** mm:ss, the only time format the HUD prints. */
export function formatClock(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
