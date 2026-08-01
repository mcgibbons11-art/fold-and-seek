import type { CSSProperties } from "react";

/**
 * The instrument-panel vocabulary the round HUDs share with the Forge: warm
 * cream on near-black lacquer, brass for anything the player acts on, and
 * letter-spaced capitals for anything the room says out loud (§12.1).
 *
 * #root is pointer-events: none so the 3D room keeps the pointer, which is why
 * every interactive element below sets pointerEvents: "auto" for itself.
 */

export const CREAM = "#e8ddcd";
export const BRASS = "#b08a4a";
export const LACQUER = "#14100c";
export const INK = "rgba(10, 9, 8, 0.82)";
export const EDGE = "1px solid rgba(232, 221, 205, 0.16)";
export const ALARM = "#c8503c";

export const overlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  color: CREAM,
  font: "13px/1.5 system-ui, sans-serif",
};

export const panelStyle: CSSProperties = {
  position: "absolute",
  background: INK,
  border: EDGE,
  borderRadius: 10,
  padding: "12px 14px",
  pointerEvents: "auto",
  backdropFilter: "blur(6px)",
};

export const headlineStyle: CSSProperties = {
  letterSpacing: "0.22em",
  textTransform: "uppercase",
  fontSize: 18,
  fontWeight: 600,
  margin: 0,
};

export const labelStyle: CSSProperties = {
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontSize: 10,
  opacity: 0.6,
};

export const buttonStyle: CSSProperties = {
  background: "rgba(232, 221, 205, 0.06)",
  color: CREAM,
  border: EDGE,
  borderRadius: 7,
  padding: "8px 14px",
  font: "inherit",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
  pointerEvents: "auto",
};

export const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "rgba(176, 138, 74, 0.28)",
  border: `1px solid ${BRASS}`,
  color: "#fff3df",
};

export function disabledButtonStyle(base: CSSProperties): CSSProperties {
  return { ...base, opacity: 0.35, cursor: "not-allowed" };
}

/** mm:ss, the only time format the HUD prints. */
export function formatClock(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
