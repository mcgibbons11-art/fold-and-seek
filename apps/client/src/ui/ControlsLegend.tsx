import type { ReactElement } from "react";

import type { ControlHint } from "./rounds/huntControls";
import { FONT_UI, RULE, keycapStyle, labelStyle } from "./rounds/theme";

/**
 * The controls, written out in full rather than abbreviated onto a strip.
 *
 * The hunt's `ControlStrip` is a reminder for a player already in the room and
 * is sized to stay out of the way. This is the opposite: it is what the title
 * screen and the role card use to *teach* the controls, before the player has
 * pressed anything, so the caps are large enough to read at a glance and each
 * one gets its own line.
 */

const KEYCAP_FONT = `600 12px/1.5 ${FONT_UI}`;

export interface ControlsLegendProps {
  readonly hints: readonly ControlHint[];
  /** Heading above the list. Null draws the list on its own. */
  readonly title?: string | null;
}

export function ControlsLegend({ hints, title = "Controls" }: ControlsLegendProps): ReactElement {
  return (
    <div style={{ textAlign: "left" }}>
      {title === null ? null : (
        <div style={{ ...labelStyle, marginBottom: 7 }}>{title}</div>
      )}
      {hints.map((hint, index) => (
        <div
          key={hint.id}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: "6px 0",
            borderTop: index === 0 ? undefined : RULE,
          }}
        >
          <span style={{ display: "flex", gap: 4 }}>
            {hint.keys.map((key) => (
              <span key={key} style={keycapStyle(KEYCAP_FONT)}>
                {key}
              </span>
            ))}
          </span>
          <span style={{ fontSize: 12, opacity: 0.82 }}>{hint.label}</span>
        </div>
      ))}
    </div>
  );
}
