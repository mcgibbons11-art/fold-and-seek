import type { CSSProperties, ReactElement } from "react";

import { ControlsLegend } from "./ControlsLegend";
import type { ControlHint } from "./rounds/huntControls";
import { BRASS_LIT, FONT_UI } from "./rounds/theme";

const sectionStyle: CSSProperties = {
  margin: "18px 0 7px",
  color: BRASS_LIT,
  font: `600 11px/1.3 ${FONT_UI}`,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const GENERAL_HOTKEYS: readonly ControlHint[] = [
  { id: "game-menu", keys: ["F1"], label: "Open or close the game menu" },
  { id: "move", keys: ["W", "A", "S", "D"], label: "Move" },
  { id: "climb", keys: ["Space"], label: "Jump · hold forward at a solid to climb" },
  { id: "board", keys: ["6"], label: "Toggle the missed-finds board" },
  { id: "taunt", keys: ["T"], label: "Taunt as a hiding Mimic" },
];

const FORGE_HOTKEYS: readonly ControlHint[] = [
  { id: "tools", keys: ["1", "2", "3", "4", "5"], label: "Pose · Shape · Panels · Material · Paint" },
  { id: "cycle-tools", keys: ["Tab"], label: "Cycle tools (Shift reverses)" },
  { id: "cycle-preset", keys: ["Q"], label: "Cycle the active pose, shape, or panel option (Shift reverses)" },
  { id: "quick-preset", keys: ["Shift", "1–5"], label: "Apply a quick pose or selected-part preset" },
  { id: "mirror", keys: ["M"], label: "Mirror every supported edit live" },
  { id: "eyedropper", keys: ["F"], label: "Copy a material or paint colour" },
  { id: "eraser", keys: ["X"], label: "Toggle the paint eraser" },
  { id: "brush", keys: ["−", "+"], label: "Shrink or grow the circular spray" },
  { id: "preview", keys: ["E"], label: "Hold Inspector-eye preview" },
  { id: "silhouette", keys: ["V"], label: "Toggle silhouette view" },
  { id: "arrangement", keys: ["[", "]"], label: "Previous or next whole-body arrangement" },
  { id: "undo", keys: ["Ctrl", "Z / Y"], label: "Undo or redo" },
  { id: "lock", keys: ["Enter"], label: "Lock the disguise" },
];

const INSPECTOR_HOTKEYS: readonly ControlHint[] = [
  { id: "hurry", keys: ["Shift"], label: "Hurry" },
  { id: "look", keys: ["Mouse"], label: "Look" },
  { id: "fire", keys: ["LMB"], label: "Fire a warrant" },
  { id: "aim", keys: ["RMB"], label: "Aim" },
  { id: "pointer", keys: ["Esc"], label: "Release the mouse" },
];

/** Canonical hotkey reference shared by the title and the live game menu. */
export function HotkeyGuide(): ReactElement {
  return (
    <div aria-label="Hotkeys">
      <div style={sectionStyle}>General hotkeys</div>
      <ControlsLegend hints={GENERAL_HOTKEYS} title={null} />
      <div style={sectionStyle}>Fast Forge hotkeys</div>
      <ControlsLegend hints={FORGE_HOTKEYS} title={null} />
      <div style={sectionStyle}>Inspector hotkeys</div>
      <ControlsLegend hints={INSPECTOR_HOTKEYS} title={null} />
    </div>
  );
}
