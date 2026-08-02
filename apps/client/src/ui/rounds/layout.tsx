import type { CSSProperties, ReactElement, ReactNode } from "react";

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
export function regionRect(region: HudRegion, viewportWidth: number, viewportHeight: number): Rect {
  const rule = REGION_RULES[region];
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

export function regionStyle(region: HudRegion): CSSProperties {
  const rule = REGION_RULES[region];
  return {
    position: "absolute",
    ...axisCss(rule.x, "left", "width"),
    ...axisCss(rule.y, "top", "height"),
    display: "flex",
    flexDirection: "column",
    gap: 10,
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
 * What a phase HUD hands the layout: at most one node per region. A record makes
 * a double claim impossible to write rather than merely wrong, which is the
 * whole point of having regions at all.
 */
export type RegionAssignment = Partial<Readonly<Record<HudRegion, ReactNode>>>;

export interface HudLayoutProps {
  readonly regions: RegionAssignment;
}

const rootStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  color: "#e8ddcd",
  font: "13px/1.5 system-ui, sans-serif",
};

export function HudLayout({ regions }: HudLayoutProps): ReactElement {
  return (
    <div style={rootStyle}>
      {HUD_REGIONS.map((region) => {
        const content = regions[region];
        if (content === undefined || content === null || content === false) return null;
        return (
          <div key={region} data-hud-region={region} style={regionStyle(region)}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
