import type { ReactElement } from "react";

import { roleBrief, roleCard, roundLabel } from "../../gameplay/copy";
import type { RoundViewState } from "../../gameplay/roundView";
import { ControlsLegend } from "../ControlsLegend";
import { roleCardHints } from "./huntControls";
import {
  BRASS_LIT,
  CREAM,
  FONT_DISPLAY,
  RULE,
  SCREEN_WASH,
  headlineStyle,
  labelStyle,
  ornamentRuleStyle,
  overlayStyle,
  plate,
} from "./theme";

/**
 * Role reveal (§5.5). The one moment in the round where the player is not doing
 * anything, so it is the moment to say what they are and what they are for.
 *
 * The §41.2 card is the headline and is quoted verbatim. Under it go the two
 * facts the deck does not carry — what to do first and what winning is — and the
 * controls, because this card is the last thing between a new player and a shop
 * they are expected to move around in.
 */

export interface RoleRevealHudProps {
  readonly state: RoundViewState;
}

export function RoleRevealHud({ state }: RoleRevealHudProps): ReactElement | null {
  const role = state.self.role;
  if (role === null) return null;
  const card = roleCard(role);
  const brief = roleBrief(role);

  return (
    <div style={{ ...overlayStyle, background: SCREEN_WASH }}>
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
          className="fs-rise"
          style={{
            ...plate(true),
            borderTop: `2px solid ${BRASS_LIT}`,
            borderRadius: 12,
            padding: "26px 34px 24px",
            width: 460,
            maxWidth: "88vw",
          }}
        >
          <div style={labelStyle}>{roundLabel(state.round)}</div>

          <h1
            className="fs-candle"
            style={{
              ...headlineStyle,
              font: `600 36px/1.15 ${FONT_DISPLAY}`,
              letterSpacing: "0.16em",
              textIndent: "0.16em",
              color: BRASS_LIT,
              margin: "8px 0 0",
              textShadow: "0 2px 20px rgba(255, 190, 107, 0.3)",
            }}
          >
            {card.title}
          </h1>

          <div style={{ ...ornamentRuleStyle(170), margin: "14px auto 16px" }} aria-hidden />

          {card.body === null ? null : (
            <p
              style={{
                margin: "0 0 18px",
                font: `16px/1.65 ${FONT_DISPLAY}`,
                color: CREAM,
              }}
            >
              {card.body}
            </p>
          )}

          <div style={{ textAlign: "left", borderTop: RULE, paddingTop: 14 }}>
            <div style={labelStyle}>First</div>
            <p style={{ margin: "3px 0 12px", fontSize: 13, lineHeight: 1.6 }}>{brief.goal}</p>

            <div style={labelStyle}>To win</div>
            <p style={{ margin: "3px 0 0", fontSize: 13, lineHeight: 1.6, color: BRASS_LIT }}>
              {brief.win}
            </p>
          </div>

          <div style={{ marginTop: 18, borderTop: RULE, paddingTop: 14 }}>
            <ControlsLegend hints={roleCardHints(role)} />
          </div>
        </div>
      </div>
    </div>
  );
}
