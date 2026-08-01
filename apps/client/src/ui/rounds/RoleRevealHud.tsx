import type { ReactElement } from "react";

import { roleCard, roundLabel } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { BRASS, EDGE, INK, headlineStyle, labelStyle, overlayStyle } from "./theme";

/**
 * Role reveal (§5.5). One card, centred, holding the §41.2 copy verbatim and
 * nothing else. It is on screen for four seconds by default, so it says one
 * thing and says it large.
 */

export interface RoleRevealHudProps {
  readonly state: RoundViewState;
}

export function RoleRevealHud({ state }: RoleRevealHudProps): ReactElement | null {
  const role = state.self.role;
  if (role === null) return null;
  const card = roleCard(role);

  return (
    <div style={overlayStyle}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeContent: "center",
          textAlign: "center",
          padding: 32,
        }}
      >
        <div
          style={{
            background: INK,
            border: EDGE,
            borderTop: `2px solid ${BRASS}`,
            borderRadius: 12,
            padding: "28px 36px",
            maxWidth: 520,
            backdropFilter: "blur(8px)",
          }}
        >
          <div style={labelStyle}>{roundLabel(state.round)}</div>
          <h1 style={{ ...headlineStyle, fontSize: 34, color: BRASS, margin: "10px 0 14px" }}>
            {card.title}
          </h1>
          {card.body === null ? null : (
            <p style={{ margin: 0, font: "15px/1.7 system-ui, sans-serif" }}>{card.body}</p>
          )}
        </div>
      </div>
    </div>
  );
}
