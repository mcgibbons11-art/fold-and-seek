import type { CSSProperties, ReactElement } from "react";

import { MODE_TITLE, modeSummary } from "../../gameplay/copy";
import type { PlayerRole } from "@foldseek/shared";
import type { ControlHint } from "./huntControls";
import { BRASS, CREAM, EDGE, INK } from "./theme";

/**
 * The bottom of the screen, in the original's two pieces: a strip of keycaps in
 * the middle naming the controls this role has right now, and the mode named in
 * the corner with a line about what winning it means.
 *
 * The strip lists controls, never verbs. Whatever the player *does* is on the
 * action rail; what they steer with is here, which is why a hider's strip has no
 * walk key and an Inspector's has no taunt.
 */

const stripStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: 6,
  padding: 6,
  background: INK,
  border: EDGE,
  borderRadius: 10,
  backdropFilter: "blur(6px)",
  pointerEvents: "none",
  maxWidth: "100%",
  flexWrap: "wrap",
  justifyContent: "center",
};

const keycapStyle: CSSProperties = {
  minWidth: 20,
  padding: "1px 5px",
  borderRadius: 4,
  font: "600 11px/1.5 system-ui, sans-serif",
  color: "#1a150e",
  background: CREAM,
};

export interface ControlStripProps {
  readonly hints: readonly ControlHint[];
}

export function ControlStrip({ hints }: ControlStripProps): ReactElement {
  return (
    <div style={stripStyle} role="group" aria-label="Controls">
      {hints.map((hint) => (
        <div
          key={hint.id}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 3,
            padding: "4px 8px",
            borderRadius: 7,
            background: "rgba(232, 221, 205, 0.05)",
          }}
        >
          <div style={{ display: "flex", gap: 3 }}>
            {hint.keys.map((key) => (
              <span key={key} style={keycapStyle}>
                {key}
              </span>
            ))}
          </div>
          <span style={{ fontSize: 10, letterSpacing: "0.06em", whiteSpace: "nowrap", opacity: 0.75 }}>
            {hint.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface ModeNoteProps {
  readonly role: PlayerRole;
}

export function ModeNote({ role }: ModeNoteProps): ReactElement {
  return (
    <div style={{ textAlign: "right", pointerEvents: "none" }}>
      <div
        style={{
          font: "600 17px/1.2 system-ui, sans-serif",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: BRASS,
        }}
      >
        {MODE_TITLE}
      </div>
      {modeSummary(role).map((line) => (
        <div key={line} style={{ fontSize: 11, opacity: 0.72 }}>
          {line}
        </div>
      ))}
    </div>
  );
}
