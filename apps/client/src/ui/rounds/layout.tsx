import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";

import { CREAM, FONT_UI } from "./theme";

/**
 * Screen-region ownership for the round HUD.
 *
 * Before this existed every HUD component placed itself with its own absolute
 * offsets, and the hunt was the phase where that caught up with us: the hider's
 * status card sat on the Forge tool rail, the Forge's own header sat on the
 * phase timer, and the taunt button sat on its own hint. Offsets that each look
 * reasonable alone cannot be made to agree by inspection.
 *
 * So the screen is cut into named regions once, here. A region is a box derived
 * from the viewport by `resolveAxis`, the same arithmetic produces both the CSS
 * and `regionRect`, and `hudLayout.test.ts` checks the whole set is pairwise
 * disjoint at the resolutions we ship at. Every region clips or scrolls its own
 * content, so a component that outgrows its box is cut off inside it rather than
 * spilling onto its neighbour. Components render content; they never position.
 */

export const HUD_REGIONS = [
  /** Hider icons, hourglass, seeker icons, phase label. The original's top row. */
  "topCenter",
  /** Stamp stack: accusation results and command refusals. */
  "topRight",
  /** Stacked cards: role status, the missed-spot board, a hider's tool panels. */
  "leftColumn",
  /** Vertical action rail of keybind chips. */
  "rightRail",
  /** Contextual control-hint strip. */
  "bottomCenter",
  /** Mode name and its two-line description. */
  "bottomRight",
  /** Reticle and the shot callout, which own the middle of the screen. */
  "center",
] as const;

export type HudRegion = (typeof HUD_REGIONS)[number];

/** The hunt role changes which pieces need protected screen space. */
export type HudLayoutMode = "generic" | "hider" | "inspector" | "spectator";

/**
 * Where one edge-to-edge extent of a region sits.
 *
 * `start` measures from the left or top, `end` from the right or bottom,
 * `center` is a fixed size about the middle, and `stretch` insets both edges so
 * the region grows with the viewport.
 */
export type RegionAxis =
  | { readonly kind: "start"; readonly offset: number; readonly size: number }
  | { readonly kind: "end"; readonly offset: number; readonly size: number }
  | { readonly kind: "center"; readonly size: number }
  | { readonly kind: "stretch"; readonly start: number; readonly end: number };

export interface RegionRule {
  readonly x: RegionAxis;
  readonly y: RegionAxis;
  /** How the region behaves when its content is taller than its box. */
  readonly overflowY: "hidden" | "auto";
  /** Which edge the content stacks against inside the box. */
  readonly justify: "start" | "center" | "end";
  /** Which side the content aligns to inside the box. */
  readonly align: "start" | "center" | "end";
}

/**
 * The one table. Everything is in CSS pixels and holds from 1280x720 upward;
 * `hudLayout.test.ts` is what says the boxes do not touch.
 */
export const REGION_RULES: Readonly<Record<HudRegion, RegionRule>> = {
  topCenter: {
    x: { kind: "center", size: 480 },
    y: { kind: "start", offset: 10, size: 124 },
    overflowY: "hidden",
    justify: "start",
    align: "center",
  },
  topRight: {
    x: { kind: "end", offset: 12, size: 288 },
    y: { kind: "start", offset: 10, size: 120 },
    overflowY: "hidden",
    justify: "start",
    align: "end",
  },
  leftColumn: {
    x: { kind: "start", offset: 12, size: 300 },
    y: { kind: "stretch", start: 10, end: 152 },
    overflowY: "auto",
    justify: "start",
    align: "start",
  },
  rightRail: {
    x: { kind: "end", offset: 12, size: 176 },
    y: { kind: "stretch", start: 144, end: 156 },
    overflowY: "auto",
    justify: "center",
    align: "end",
  },
  bottomCenter: {
    x: { kind: "center", size: 560 },
    y: { kind: "end", offset: 10, size: 120 },
    overflowY: "hidden",
    justify: "end",
    align: "center",
  },
  bottomRight: {
    x: { kind: "end", offset: 12, size: 340 },
    y: { kind: "end", offset: 10, size: 76 },
    overflowY: "hidden",
    justify: "end",
    align: "end",
  },
  center: {
    x: { kind: "center", size: 300 },
    y: { kind: "center", size: 300 },
    overflowY: "hidden",
    justify: "center",
    align: "center",
  },
};

const PORTALS_PANE_MAX_WIDTH = 720;
const COMPACT_HUD_MAX_WIDTH = 1100;

/**
 * Portals may mount the game in a tall 640px pane rather than a desktop tab.
 * These rules keep the role's interaction corridor clear instead of shrinking
 * the desktop table until its columns overlap the reticle.
 */
export function regionRulesFor(
  viewportWidth: number,
  viewportHeight: number,
  mode: HudLayoutMode = "generic",
): Readonly<Record<HudRegion, RegionRule>> {
  if (viewportWidth > COMPACT_HUD_MAX_WIDTH && viewportHeight >= 600) return REGION_RULES;

  const pane = viewportWidth <= PORTALS_PANE_MAX_WIDTH;
  const edge = 8;
  const topHeight = pane ? 84 : 88;
  const contentTop = topHeight + 16;
  const bottomReserve = pane ? 100 : 102;
  const hiderWidth = Math.min(pane ? 280 : 288, viewportWidth - edge * 2);
  const inspectorColumnWidth = pane ? 192 : 238;
  const railWidth = 148;
  const centerSize = pane ? 220 : 240;

  return {
    topCenter: {
      x: { kind: "center", size: Math.min(pane ? 396 : 420, viewportWidth - edge * 2) },
      y: { kind: "start", offset: edge, size: topHeight },
      overflowY: "hidden",
      justify: "start",
      align: "center",
    },
    topRight: {
      x: { kind: "end", offset: edge, size: Math.min(220, viewportWidth - edge * 2) },
      y: { kind: "start", offset: contentTop, size: pane ? 88 : 82 },
      overflowY: "hidden",
      justify: "start",
      align: "end",
    },
    leftColumn: {
      x: {
        kind: "start",
        offset: edge,
        size: mode === "hider" ? hiderWidth : inspectorColumnWidth,
      },
      y: { kind: "stretch", start: contentTop, end: mode === "hider" ? 8 : bottomReserve },
      overflowY: "auto",
      justify: "start",
      align: "start",
    },
    rightRail: {
      x: { kind: "end", offset: edge, size: railWidth },
      y: { kind: "stretch", start: contentTop + 90, end: bottomReserve },
      overflowY: "auto",
      justify: "center",
      align: "end",
    },
    bottomCenter: {
      x: { kind: "center", size: Math.min(360, viewportWidth - edge * 2) },
      y: { kind: "end", offset: edge, size: 80 },
      overflowY: "hidden",
      justify: "end",
      align: "center",
    },
    bottomRight: {
      x: { kind: "end", offset: edge, size: Math.min(230, viewportWidth - edge * 2) },
      y: { kind: "end", offset: edge, size: 64 },
      overflowY: "hidden",
      justify: "end",
      align: "end",
    },
    center: {
      x: { kind: "center", size: centerSize },
      y: { kind: "center", size: centerSize },
      overflowY: "hidden",
      justify: "center",
      align: "center",
    },
  };
}

/** Space a region leaves between the cards stacked inside it. */
export const REGION_GAP = 10;

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function resolveAxis(axis: RegionAxis, extent: number): { start: number; end: number } {
  switch (axis.kind) {
    case "start":
      return { start: axis.offset, end: axis.offset + axis.size };
    case "end":
      return { start: extent - axis.offset - axis.size, end: extent - axis.offset };
    case "center": {
      const start = (extent - axis.size) / 2;
      return { start, end: start + axis.size };
    }
    case "stretch":
      return { start: axis.start, end: extent - axis.end };
  }
}

/** The box a region occupies in a viewport of this size. */
export function regionRect(
  region: HudRegion,
  viewportWidth: number,
  viewportHeight: number,
  mode: HudLayoutMode = "generic",
): Rect {
  const rule = regionRulesFor(viewportWidth, viewportHeight, mode)[region];
  const x = resolveAxis(rule.x, viewportWidth);
  const y = resolveAxis(rule.y, viewportHeight);
  return { left: x.start, top: y.start, right: x.end, bottom: y.end };
}

/** True when two boxes share any area. Touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function axisCss(axis: RegionAxis, startProperty: "left" | "top", size: "width" | "height"): CSSProperties {
  const endProperty = startProperty === "left" ? "right" : "bottom";
  switch (axis.kind) {
    case "start":
      return { [startProperty]: axis.offset, [size]: axis.size };
    case "end":
      return { [endProperty]: axis.offset, [size]: axis.size };
    case "center":
      // calc rather than a translate, because both axes may centre and one
      // transform cannot carry two independent offsets without conflicting.
      return { [startProperty]: `calc(50% - ${axis.size / 2}px)`, [size]: axis.size };
    case "stretch":
      return { [startProperty]: axis.start, [endProperty]: axis.end };
  }
}

const FLEX_POSITION: Readonly<Record<"start" | "center" | "end", string>> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
};

export function regionStyle(
  region: HudRegion,
  viewportWidth = 1280,
  viewportHeight = 720,
  mode: HudLayoutMode = "generic",
): CSSProperties {
  const rule = regionRulesFor(viewportWidth, viewportHeight, mode)[region];
  return {
    position: "absolute",
    ...axisCss(rule.x, "left", "width"),
    ...axisCss(rule.y, "top", "height"),
    display: "flex",
    flexDirection: "column",
    gap: REGION_GAP,
    justifyContent: FLEX_POSITION[rule.justify],
    alignItems: FLEX_POSITION[rule.align],
    overflowY: rule.overflowY,
    overflowX: "hidden",
    // The 3D room keeps the pointer; controls inside a region opt themselves
    // back in, which is the same rule the rest of the HUD follows.
    pointerEvents: "none",
  };
}

/**
 * How tall a region is in the current viewport. Without a window it answers for
 * 1280x720, the smallest size the HUD is checked at, so anything sized from this
 * before layout is never larger than it can be.
 */
export function regionHeight(region: HudRegion, mode: HudLayoutMode = "generic"): number {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const height = typeof window === "undefined" ? 720 : window.innerHeight;
  const rect = regionRect(region, width, height, mode);
  return rect.bottom - rect.top;
}

/** `regionHeight`, kept current through a window that changes size mid-round. */
export function useRegionHeight(region: HudRegion, mode: HudLayoutMode = "generic"): number {
  const [height, setHeight] = useState(() => regionHeight(region, mode));

  useEffect(() => {
    const onResize = (): void => {
      setHeight(regionHeight(region, mode));
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [mode, region]);

  return height;
}

/**
 * What a phase HUD hands the layout: at most one node per region. A record makes
 * a double claim impossible to write rather than merely wrong, which is the
 * whole point of having regions at all.
 */
export type RegionAssignment = Partial<Readonly<Record<HudRegion, ReactNode>>>;

export interface HudLayoutProps {
  readonly regions: RegionAssignment;
  readonly mode?: HudLayoutMode;
}

/**
 * The 13px/1.5 is load-bearing rather than a taste: `columnFit.ts` derives the
 * hider column's card heights from it row by row, and `hudLayout.test.ts` checks
 * that arithmetic against these region boxes. The family may change; the size
 * and the ratio may not.
 */
const rootStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  color: CREAM,
  font: `13px/1.5 ${FONT_UI}`,
};

export function HudLayout({ regions, mode = "generic" }: HudLayoutProps): ReactElement {
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 1280 : window.innerWidth,
    height: typeof window === "undefined" ? 720 : window.innerHeight,
  }));

  useEffect(() => {
    const onResize = (): void => setViewport({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div style={rootStyle} data-hud-layout={mode} data-hud-viewport={`${viewport.width}x${viewport.height}`}>
      {HUD_REGIONS.map((region) => {
        const content = regions[region];
        if (content === undefined || content === null || content === false) return null;
        return (
          <div
            key={region}
            data-hud-region={region}
            style={regionStyle(region, viewport.width, viewport.height, mode)}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}
