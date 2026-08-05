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
  { id: "climb", keys: ["Space"], label: "Jump · hold forward at a solid to climb · hold S to climb down" },
  { id: "grapple", keys: ["Q"], label: "Fire or release grapple · S emergency-releases" },
  { id: "board", keys: ["6"], label: "Toggle the missed-finds board" },
  { id: "taunt", keys: ["T"], label: "Taunt as a hiding Mimic" },
];

const FORGE_HOTKEYS: readonly ControlHint[] = [
  { id: "tools", keys: ["1", "2", "3", "4", "5"], label: "Pose · Shape · Panels · Material · Paint" },
  { id: "pose-grab", keys: ["LMB"], label: "Pose: drag any part of your body — the nearest joint follows" },
  { id: "resize", keys: ["LMB"], label: "Shape: drag the red/green/blue arrows to resize along that axis" },
  { id: "multi", keys: ["Shift", "LMB"], label: "Shape: add parts to the selection; the arrows resize them together" },
  { id: "cycle-tools", keys: ["Tab"], label: "Cycle tools (Shift reverses)" },
  { id: "cycle-preset", keys: ["R"], label: "Cycle the active pose, shape, or panel option (Shift reverses)" },
  { id: "quick-preset", keys: ["Shift", "1–5"], label: "Apply a quick pose or selected-part preset" },
  { id: "mirror", keys: ["M"], label: "Mirror every supported edit live" },
  { id: "eyedropper", keys: ["F"], label: "Sample a material or colour — hold F and click to sample what you click, your own parts included" },
  { id: "eraser", keys: ["X"], label: "Toggle the paint eraser" },
  { id: "brush", keys: ["−", "+"], label: "Shrink or grow the circular spray" },
  { id: "preview", keys: ["E"], label: "Hold Inspector-eye preview" },
  { id: "silhouette", keys: ["V"], label: "Toggle silhouette view" },
  { id: "arrangement", keys: ["[", "]"], label: "Previous or next whole-body arrangement" },
  { id: "undo", keys: ["Ctrl", "Z / Y"], label: "Undo or redo" },
  { id: "lock", keys: ["Enter"], label: "Lock the disguise · Esc reopens it, even mid-hunt" },
];

const INSPECTOR_HOTKEYS: readonly ControlHint[] = [
  { id: "hurry", keys: ["Shift"], label: "Hurry" },
  { id: "look", keys: ["Mouse"], label: "Look" },
  { id: "fire", keys: ["LMB"], label: "Fire a warrant" },
  { id: "aim", keys: ["RMB"], label: "Aim" },
  { id: "pointer", keys: ["Esc"], label: "Release the mouse" },
];

const SPECTATOR_HOTKEYS: readonly ControlHint[] = [
  { id: "follow", keys: ["F"], label: "Caught: camera rides the Inspector" },
  { id: "roam", keys: ["W", "A", "S", "D"], label: "Caught: roam the free camera; F picks the hunter back up" },
];

export interface HotkeyGuideProps {
  readonly role?: "mimic" | "inspector" | "spectator" | null;
}

const detailStyle: CSSProperties = {
  borderBottom: "1px solid rgba(176, 138, 74, 0.22)",
  padding: "8px 0",
};

/** Four-stage canonical guide; the live role opens first without hiding the rest. */
export function HotkeyGuide({ role = null }: HotkeyGuideProps): ReactElement {
  return (
    <div aria-label="Hotkeys">
      <details style={detailStyle} open={role === null || role === "spectator"}>
        <summary style={sectionStyle}>Overview</summary>
        <ControlsLegend hints={GENERAL_HOTKEYS} title={null} />
      </details>
      <details style={detailStyle} open={role === "mimic"}>
        <summary style={sectionStyle}>Mimic</summary>
        <ControlsLegend hints={[...GENERAL_HOTKEYS.filter((hint) => ["move", "climb", "grapple", "taunt"].includes(hint.id))]} title={null} />
      </details>
      <details style={detailStyle} open={role === "inspector"}>
        <summary style={sectionStyle}>Inspector</summary>
        <ControlsLegend
          hints={[
            ...GENERAL_HOTKEYS.filter((hint) => ["move", "climb", "grapple"].includes(hint.id)),
            ...INSPECTOR_HOTKEYS,
          ]}
          title={null}
        />
      </details>
      <details style={detailStyle}>
        <summary style={sectionStyle}>Forge & hotkeys</summary>
        <ControlsLegend hints={FORGE_HOTKEYS} title={null} />
      </details>
      <details style={detailStyle} open={role === "spectator"}>
        <summary style={sectionStyle}>Spectating</summary>
        <ControlsLegend hints={SPECTATOR_HOTKEYS} title={null} />
      </details>
    </div>
  );
}
