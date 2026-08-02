import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import type { RailAction, RailTone } from "./huntControls";
import { regionRect } from "./layout";
import { BRASS, CREAM, EDGE, INK } from "./theme";

/**
 * The right-edge action rail, ported from the original: one chip per verb, each
 * carrying the key that fires it and an icon, with the label under it. Its job
 * is to answer "what can I press" without the player having to find out by
 * pressing things.
 *
 * Chips are buttons wherever a handler exists, so the rail is usable with a
 * mouse as well as by key, and inert where the verb lives on the mouse itself.
 *
 * **Every chip has to be on screen.** A live hider's rail is eight chips — the
 * taunt, five Forge tools, mirror and the board — and at 1280x720 the roomy
 * chip runs 54 px past the bottom of its region, which cut the taunt off the top
 * and the board off the bottom and left the player scrolling a keybind list mid
 * hunt. So the chip has an *explicit* height taken from `RAIL_SIZES` rather than
 * whatever its text happens to measure, the rail picks the largest size whose
 * arithmetic fits the region, and `hudLayout.test.ts` checks that arithmetic
 * against the region box the layout table resolves. A chip whose content
 * outgrows its height is clipped inside itself, which is the same rule the
 * regions follow.
 */

export interface ActionRailProps {
  readonly actions: readonly RailAction[];
  /** Invoked with a `RailAction.id`. Ids without a handler render inert. */
  readonly onPress?: (id: string) => void;
  /**
   * Height the rail has to fit inside. Omitted in the game, where it is read
   * from the viewport; supplied by tests that have no window to measure.
   */
  readonly availableHeight?: number;
}

/** One chip geometry. Heights are the whole chip, borders and padding included. */
export interface RailSize {
  readonly id: "roomy" | "compact";
  /** A chip with a keycap row and a label. */
  readonly chipHeight: number;
  /** A chip carrying a note under the label as well. */
  readonly notedChipHeight: number;
  readonly gap: number;
  readonly chipWidth: number;
  readonly padding: string;
  readonly keycapFont: string;
  readonly glyphSize: number;
  readonly labelFont: string;
  readonly noteFont: string;
  readonly rowGap: number;
}

const ROOMY: RailSize = {
  id: "roomy",
  chipHeight: 50,
  notedChipHeight: 66,
  gap: 6,
  chipWidth: 160,
  padding: "6px 9px",
  keycapFont: "600 11px/1.5 system-ui, sans-serif",
  glyphSize: 14,
  labelFont: "400 11px/1.4 system-ui, sans-serif",
  noteFont: "400 10px/1.4 system-ui, sans-serif",
  rowGap: 2,
};

const COMPACT: RailSize = {
  id: "compact",
  chipHeight: 38,
  notedChipHeight: 48,
  gap: 4,
  chipWidth: 148,
  padding: "3px 8px",
  keycapFont: "600 10px/1.4 system-ui, sans-serif",
  glyphSize: 12,
  labelFont: "400 10px/1.1 system-ui, sans-serif",
  noteFont: "400 9px/1.1 system-ui, sans-serif",
  rowGap: 1,
};

/** Largest first. The rail takes the first one whose rail height fits. */
export const RAIL_SIZES: readonly RailSize[] = [ROOMY, COMPACT];

/** Exactly how tall the rail draws for this roster at this size. */
export function railHeight(actions: readonly RailAction[], size: RailSize): number {
  if (actions.length === 0) return 0;
  const chips = actions.reduce(
    (total, action) => total + (action.note === null ? size.chipHeight : size.notedChipHeight),
    0,
  );
  return chips + size.gap * (actions.length - 1);
}

/**
 * The size to draw at. The smallest is returned even when it does not fit,
 * because a rail that has run out of sizes still has to render something; the
 * region scrolls in that case and the test says which rosters reach it.
 */
export function railSizeFor(actions: readonly RailAction[], availableHeight: number): RailSize {
  for (const size of RAIL_SIZES) {
    if (railHeight(actions, size) <= availableHeight) return size;
  }
  return RAIL_SIZES[RAIL_SIZES.length - 1] as RailSize;
}

/**
 * The rail region's height in the current viewport, from the layout table.
 * Without a window it answers for 1280x720, the smallest size the HUD is
 * checked at, so a rail rendered before layout is never larger than it can be.
 */
function railRegionHeight(): number {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const height = typeof window === "undefined" ? 720 : window.innerHeight;
  const rect = regionRect("rightRail", width, height);
  return rect.bottom - rect.top;
}

function useRailRegionHeight(): number {
  const [height, setHeight] = useState(railRegionHeight);

  useEffect(() => {
    const onResize = (): void => {
      setHeight(railRegionHeight());
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return height;
}

const TONE_ACCENTS: Readonly<Record<RailTone, string>> = {
  primary: BRASS,
  normal: "rgba(232, 221, 205, 0.45)",
  quiet: "rgba(232, 221, 205, 0.22)",
};

function railStyle(size: RailSize): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: size.gap,
  };
}

function keycapStyle(size: RailSize): CSSProperties {
  return {
    minWidth: 20,
    padding: "1px 5px",
    borderRadius: 4,
    textAlign: "center",
    font: size.keycapFont,
    letterSpacing: "0.04em",
    color: "#1a150e",
    background: CREAM,
  };
}

function chipStyle(action: RailAction, size: RailSize): CSSProperties {
  const accent = TONE_ACCENTS[action.tone];
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: size.rowGap,
    width: size.chipWidth,
    height: action.note === null ? size.chipHeight : size.notedChipHeight,
    boxSizing: "border-box",
    // A chip that outgrows its height is cut off inside itself rather than
    // pushing the chip below it off the screen.
    overflow: "hidden",
    padding: size.padding,
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

function ChipBody({
  action,
  size,
}: {
  readonly action: RailAction;
  readonly size: RailSize;
}): ReactElement {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={keycapStyle(size)}>{action.key}</span>
        <span aria-hidden style={{ fontSize: size.glyphSize, lineHeight: 1 }}>
          {action.glyph}
        </span>
      </div>
      <div
        style={{
          font: size.labelFont,
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
        <div
          style={{
            font: size.noteFont,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: BRASS,
            whiteSpace: "nowrap",
          }}
        >
          {action.note}
        </div>
      )}
    </>
  );
}

export function ActionRail({ actions, onPress, availableHeight }: ActionRailProps): ReactElement {
  const measured = useRailRegionHeight();
  const size = railSizeFor(actions, availableHeight ?? measured);

  return (
    <div style={railStyle(size)} role="group" aria-label="Actions" data-rail-size={size.id}>
      {actions.map((action) => {
        if (!action.pressable || onPress === undefined) {
          return (
            <div key={action.id} style={{ ...chipStyle(action, size), pointerEvents: "none" }}>
              <ChipBody action={action} size={size} />
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
              ...chipStyle(action, size),
              pointerEvents: "auto",
              cursor: action.enabled ? "pointer" : "not-allowed",
            }}
            onClick={() => {
              onPress(action.id);
            }}
          >
            <ChipBody action={action} size={size} />
          </button>
        );
      })}
    </div>
  );
}
