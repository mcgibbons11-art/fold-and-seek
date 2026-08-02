import { REGION_GAP } from "./layout";

/**
 * How tall a live hider's left column is allowed to be, and what it drops when
 * the viewport cannot hold it.
 *
 * The measured defect, from the round-6 critic: at 1280x720 the column drew
 * 661 px of content into a 558 px region. A hider's column stacks the status
 * card, the missed-spot board and the *whole* of the Forge's tool panels, and
 * override 2 keeps those panels live for the entire hunt, so this is the normal
 * case rather than a corner of one. The region scrolls, so nothing was lost, but
 * a player mid-hunt was reading a status card through a scrollbar.
 *
 * This is `ActionRail`'s answer applied to the other column: the geometry is
 * declared rather than measured, the components take their padding and their
 * heights from it, and the arithmetic is checked against the region box the
 * layout table resolves. What it adds over the rail is a second lever — the tool
 * panels fold behind a header — because unlike a rail of keybind chips they are
 * genuinely large and genuinely optional to have open.
 */

export interface ColumnDensity {
  readonly id: "roomy" | "compact";
  /** Padding on every card in the column. */
  readonly cardPadding: string;
  /** Space above a heading inside a card. */
  readonly headingGap: number;
  /** The hider's status card with no deception score on it yet. */
  readonly statusHeight: number;
  /** The same card once the round has given it a score to show. */
  readonly statusScoredHeight: number;
  /** The folded tool-panel header. */
  readonly disclosureHeight: number;
  /** Whether the creep hint may wrap onto a second line. */
  readonly wrapHint: boolean;
}

/**
 * Heights are the whole card, border and padding included, and each is the sum
 * of the rows the card draws plus a few pixels of slack. Roomy, with the base
 * 13px/1.5 type: 24 padding and 2 border, a 15 px label, a two-line hint under
 * a 4 px margin (43), the watched heading under a 14 px margin (29), the meter
 * (12) and its caption (19) — 144, declared 152. The deception block adds a
 * heading (29), a 22px figure (26), the latest award (17) and the tallies (19),
 * so 235, declared 244.
 *
 * Compact takes 8 px off the padding, holds the hint to one line (19.5) and
 * halves the two headings' margins (12), which is 110 and 196.
 */
const ROOMY: ColumnDensity = {
  id: "roomy",
  cardPadding: "12px 14px",
  headingGap: 14,
  statusHeight: 152,
  statusScoredHeight: 244,
  disclosureHeight: 38,
  wrapHint: true,
};

const COMPACT: ColumnDensity = {
  id: "compact",
  cardPadding: "8px 10px",
  headingGap: 8,
  statusHeight: 116,
  statusScoredHeight: 200,
  disclosureHeight: 32,
  wrapHint: false,
};

/** Largest first. The column takes the first one whose open stack fits. */
export const COLUMN_DENSITIES: readonly ColumnDensity[] = [ROOMY, COMPACT];

/**
 * Height the Forge's tool panels want before opening them by default is a
 * courtesy rather than a shove.
 *
 * It is the tallest of them. The Shape panel is a heading, seven sliders at a
 * label and a control each, a profile label and a select: about 425 px inside
 * its card. The undo row under it is another 46 and the gap between them 10.
 * Below this the panels open onto a scrollbar, which is the state being fixed.
 */
export const FORGE_PANELS_MIN_HEIGHT = 480;

export interface HiderColumnContent {
  /** True once the hider has earned deception points, which grows the card. */
  readonly scored: boolean;
  /** True when the Forge's tool panels are unfolded. */
  readonly forgeOpen: boolean;
}

/** Exactly how tall a hider's column draws, with the board closed. */
export function hiderColumnHeight(density: ColumnDensity, content: HiderColumnContent): number {
  const status = content.scored ? density.statusScoredHeight : density.statusHeight;
  // The header stays on screen when the panels are unfolded, so an open column
  // is the folded one plus a gap plus the panels rather than the panels alone.
  const forge = content.forgeOpen
    ? density.disclosureHeight + REGION_GAP + FORGE_PANELS_MIN_HEIGHT
    : density.disclosureHeight;
  return status + REGION_GAP + forge;
}

/**
 * The density to draw at: the first whose column fits with the tool panels open
 * and a score on the card, which is the tallest a hider's column ever gets with
 * the board closed. The smallest is returned when none of them fit, because a
 * column that has run out of sizes still has to render something.
 */
export function columnDensityFor(availableHeight: number): ColumnDensity {
  for (const density of COLUMN_DENSITIES) {
    if (hiderColumnHeight(density, { scored: true, forgeOpen: true }) <= availableHeight) {
      return density;
    }
  }
  return COLUMN_DENSITIES[COLUMN_DENSITIES.length - 1] as ColumnDensity;
}

/**
 * Whether the tool panels start unfolded. They never do.
 *
 * They used to unfold wherever the column could hold them whole, which meant
 * everywhere above 720p. The round-1 critic counted about 35 elements on a
 * hider's screen at 1080p and found the reason: the left column's open panels
 * and the right rail are two renderings of the same toolset, so a hider who has
 * just been told to hold still is reading their whole tool inventory twice.
 * The rail is the one that always fits and always has the keys on it, so the
 * column starts folded at every size and the panels are one press away.
 *
 * `availableHeight` is kept in the signature because the caller has it and
 * because whether the panels *would* fit is still what `columnDensityFor`
 * decides above.
 */
export function forgePanelsOpenByDefault(_availableHeight: number): boolean {
  return false;
}
