import type { CSSProperties, ReactElement } from "react";

import type { RailAction, RailTone } from "./huntControls";
import { BRASS, CREAM, EDGE, INK } from "./theme";

/**
 * The right-edge action rail, ported from the original: one chip per verb, each
 * carrying the key that fires it and an icon, with the label under it. Its job
 * is to answer "what can I press" without the player having to find out by
 * pressing things.
 *
 * Chips are buttons wherever a handler exists, so the rail is usable with a
 * mouse as well as by key, and inert where the verb lives on the mouse itself.
 */

export interface ActionRailProps {
  readonly actions: readonly RailAction[];
  /** Invoked with a `RailAction.id`. Ids without a handler render inert. */
  readonly onPress?: (id: string) => void;
}

const TONE_ACCENTS: Readonly<Record<RailTone, string>> = {
  primary: BRASS,
  normal: "rgba(232, 221, 205, 0.45)",
  quiet: "rgba(232, 221, 205, 0.22)",
};

const railStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 6,
};

const keycapStyle: CSSProperties = {
  minWidth: 22,
  padding: "1px 5px",
  borderRadius: 4,
  textAlign: "center",
  font: "600 11px/1.5 system-ui, sans-serif",
  letterSpacing: "0.04em",
  color: "#1a150e",
  background: CREAM,
};

function chipStyle(action: RailAction): CSSProperties {
  const accent = TONE_ACCENTS[action.tone];
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 2,
    width: 160,
    padding: "6px 9px",
    background: action.active ? "rgba(176, 138, 74, 0.3)" : INK,
    border: action.active ? `1px solid ${BRASS}` : EDGE,
    borderRight: `3px solid ${accent}`,
    borderRadius: 8,
    backdropFilter: "blur(6px)",
    color: CREAM,
    font: "inherit",
    textAlign: "right",
    opacity: action.enabled ? 1 : 0.42,
  };
}

function ChipBody({ action }: { readonly action: RailAction }): ReactElement {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={keycapStyle}>{action.key}</span>
        <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
          {action.glyph}
        </span>
      </div>
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.04em",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "100%",
        }}
      >
        {action.label}
      </div>
      {action.note === null ? null : (
        <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: BRASS }}>
          {action.note}
        </div>
      )}
    </>
  );
}

export function ActionRail({ actions, onPress }: ActionRailProps): ReactElement {
  return (
    <div style={railStyle} role="group" aria-label="Actions">
      {actions.map((action) => {
        if (!action.pressable || onPress === undefined) {
          return (
            <div key={action.id} style={{ ...chipStyle(action), pointerEvents: "none" }}>
              <ChipBody action={action} />
            </div>
          );
        }
        return (
          <button
            key={action.id}
            type="button"
            disabled={!action.enabled}
            aria-pressed={action.active}
            style={{
              ...chipStyle(action),
              pointerEvents: "auto",
              cursor: action.enabled ? "pointer" : "not-allowed",
            }}
            onClick={() => {
              onPress(action.id);
            }}
          >
            <ChipBody action={action} />
          </button>
        );
      })}
    </div>
  );
}
