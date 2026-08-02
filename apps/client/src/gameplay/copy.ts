import type { InnocentReactionId, ResultVoteCategory } from "@foldseek/game-sim";
import { MatchPhase, type PlayerRole } from "@foldseek/shared";

import type { DeceptionEventKind } from "./roundView";

/**
 * The §41 copy deck, verbatim. Nothing here is generated or paraphrased: a
 * string the deck does not supply is absent rather than invented, which is why
 * several of these lookups return null.
 *
 * Three entries have been revised since the bible was written, because the
 * hunt design replaced the frozen-hider one and the bible text now describes
 * rules the game no longer has. The §41.2 Mimic card, the §41.3 lock
 * confirmation, and the §41.2 Inspector card are authoritative here rather than
 * in the bible; each is marked below. Do not "restore" them from §41.
 */

/** §41.1 phase copy. Phases the deck does not name return null. */
export function phaseLabel(phase: MatchPhase): string | null {
  switch (phase) {
    case MatchPhase.BaselineScan:
      return "MEMORIZE THE ROOM";
    case MatchPhase.Forge:
      return "FOLD";
    case MatchPhase.Locking:
      return "LOCKING THE LIES";
    case MatchPhase.InspectionIntro:
      return "INSPECTION BEGINS";
    case MatchPhase.FinalCountdown:
      return "TEN SECONDS";
    case MatchPhase.Reveal:
      return "THE ROOM CONFESSES";
    case MatchPhase.Results:
      return "RESULTS";
    default:
      return null;
  }
}

export interface RoleCard {
  readonly title: string;
  /** §41.2 body copy. Null for the spectator, which the deck does not cover. */
  readonly body: string | null;
}

const ROLE_CARDS: Readonly<Record<PlayerRole, RoleCard>> = {
  // Revised for the hunt design: a hider moves now, so the card no longer tells
  // them to do nothing.
  mimic: {
    title: "MIMIC",
    body: "Fold your body into something the room might plausibly contain. Then move only when nobody is watching.",
  },
  // Revised for the hunt design: the Inspector carries a warrant gun.
  inspector: {
    title: "INSPECTOR",
    body: "Memorize the room. Hunt the furniture that is lying. Every shot costs a warrant round.",
  },
  spectator: { title: "SPECTATOR", body: null },
};

export function roleCard(role: PlayerRole): RoleCard {
  return ROLE_CARDS[role];
}

/**
 * What the role card teaches on top of the §41.2 body: the thing to do next,
 * and the condition that ends the round in this player's favour.
 *
 * The deck's own card says what the role *is*, in the game's voice, and says it
 * once. A player seeing FOLD & SEEK for the first time also needs the two flat
 * facts underneath it, so these are additions rather than edits — the §41 copy
 * above stays verbatim.
 */
export interface RoleBrief {
  /** The first thing this role should do, in the imperative. */
  readonly goal: string;
  /** What winning is. */
  readonly win: string;
}

const ROLE_BRIEFS: Readonly<Record<PlayerRole, RoleBrief>> = {
  mimic: {
    goal: "Find a spot, fold into something that belongs there, and hold still.",
    win: "You win by still being furniture when the clock runs out.",
  },
  inspector: {
    goal: "Learn the room, then shoot whatever looks wrong. Each shot spends a warrant round.",
    win: "You win by finding every Mimic before the clock runs out.",
  },
  spectator: {
    goal: "Watch the room. The board keeps score while you do.",
    win: "You are out of this round and back in the next one.",
  },
};

export function roleBrief(role: PlayerRole): RoleBrief {
  return ROLE_BRIEFS[role];
}

/**
 * §41.3 lock confirmation, revised for the hunt design. Locking commits the
 * disguise but no longer ends the hider's round, so the prompt says what the
 * lock actually costs.
 */
export const LOCK_PROMPT_TITLE = "Become this object?";
export const LOCK_PROMPT_BODY =
  "You can still creep and adjust during the hunt, slowly, and at your own risk.";
export const LOCK_CONFIRM_LABEL = "BECOME OBJECT";
export const LOCK_CANCEL_LABEL = "KEEP FOLDING";

/**
 * §41.4 wrong-accusation stamps, one per reaction the simulation can play. The
 * sixth stamp is the fallback below, used when a wrong accusation resolves
 * before its innocent_reaction arrives or without one.
 */
const WRONG_ACCUSATION_STAMPS: Readonly<Record<InnocentReactionId, string>> = {
  lamp_turns_on: "INNOCENT LAMP",
  chair_squeaks: "LEGALLY A CHAIR",
  vase_dust_puff: "JUST A VASE",
  clock_chimes: "NO PERSON DETECTED",
  kettle_whistles: "FURNITURE CLEARED",
};

export const WRONG_ACCUSATION_FALLBACK_STAMP = "ORDINARY BOX";

export function wrongAccusationStamp(reactionId: InnocentReactionId | null): string {
  if (reactionId === null) return WRONG_ACCUSATION_FALLBACK_STAMP;
  return WRONG_ACCUSATION_STAMPS[reactionId];
}

/**
 * Ammunition copy. The Inspector's warrants are carried as rounds for the
 * warrant gun, so the HUD counts shots rather than stamps a dossier.
 */
export const AMMO_LABEL = "WARRANT ROUNDS";
export const AMMO_EMPTY_PROMPT = "OUT OF WARRANT ROUNDS";
export const AMMO_COOLDOWN_PROMPT = "CHAMBERING";
export const AMMO_OUT_OF_RANGE_PROMPT = "OUT OF RANGE";
export const AMMO_READY_PROMPT = "HOLD TO FIRE";
export const AMMO_NO_TARGET_PROMPT = "NO TARGET";

/**
 * What a hider is told during inspection. Movement is legal now and is also
 * what gives a Mimic away, which is the whole tension of the phase.
 */
export const HIDER_CREEP_HINT = "Move slowly. Movement is how they catch you.";
export const TAUNT_LABEL = "Taunt";

/**
 * The hunt's own top-centre label, under the hourglass. §41.1 names the two
 * short phases either side of the search but leaves the search itself unnamed,
 * because the bible expected a hider to have nothing to read by then. A hider is
 * live throughout now, so the row needs a word for every second it is up. These
 * three are not §41 entries.
 */
export function huntStatusLabel(phase: MatchPhase): string {
  switch (phase) {
    case MatchPhase.InspectionIntro:
      return "UNTIL THE SEARCH STARTS";
    case MatchPhase.FinalCountdown:
      return "TEN SECONDS";
    default:
      return "SEARCH TIME";
  }
}

/**
 * The mode card in the bottom-right corner: what this game is, in the two lines
 * the original gives it, said differently for the side reading it. Also outside
 * §41, which describes role cards shown once at the reveal rather than a
 * standing reminder.
 */
export const MODE_TITLE = "FOLD & SEEK";

export function modeSummary(role: PlayerRole): readonly string[] {
  switch (role) {
    case "inspector":
      return ["Any object here could be a person.", "Spend your warrant rounds well."];
    case "mimic":
      return ["Be furniture. Move only unwatched.", "Outlast the inspection to win."];
    case "spectator":
      return ["You are out of this round.", "Watch the room give them away."];
  }
}

/** Rail labels for the hunt's action chips. */
export const TOOL_RAIL_LABELS: Readonly<Record<"pose" | "shape" | "panels" | "material" | "paint", string>> = {
  pose: "Pose",
  shape: "Shape",
  panels: "Panels",
  material: "Material",
  paint: "Paint Mode",
};

export const MIRROR_RAIL_LABEL = "Mirror";

export function tauntCooldownNote(seconds: number): string {
  return seconds > 0 ? `${seconds}s` : "not now";
}

/**
 * Deception score feedback, for the hider who earned it and nobody else. Being
 * looked straight at and surviving it is the point of the disguise, so the two
 * events that pay for it are named plainly rather than as statistics.
 */
export const DECEPTION_TITLE = "Deception";
export const DECEPTION_ESCAPE_LABEL = "SEEN AND MISSED";
export const DECEPTION_CLOSE_PASS_LABEL = "CLOSE PASS";

export function deceptionLabel(kind: DeceptionEventKind): string {
  return kind === "direct_look_escape" ? DECEPTION_ESCAPE_LABEL : DECEPTION_CLOSE_PASS_LABEL;
}

/**
 * The missed-finds board, carrying the original's own English name for it
 * (docs/MECCHA_RESEARCH.md). It reports on a cycle rather than continuously, so
 * a player who has just joined is told the board is coming rather than shown an
 * empty ranking they would read as "nobody has scored".
 */
export const MISSED_FINDS_TITLE = "Missed-Spot Ranking";
/** The same board, named on its rail chip. */
export const BOARD_RAIL_LABEL = MISSED_FINDS_TITLE;
export const MISSED_FINDS_TOGGLE_HINT = "6";
export const MISSED_FINDS_AWAITING = "Awaiting the first report.";
export const MISSED_FINDS_FINAL_NOTE = "final";

export function missedFindsCountdown(secondsToNextUpdate: number | null): string {
  if (secondsToNextUpdate === null) return MISSED_FINDS_FINAL_NOTE;
  return `next update ${secondsToNextUpdate}s`;
}

/** §41.5 correct-accusation stamps, cycled so a run of catches does not repeat. */
export const CORRECT_ACCUSATION_STAMPS = [
  "MIMIC FOUND",
  "THAT WAS A PERSON",
  "OBJECT STATUS REVOKED",
] as const;

export function correctAccusationStamp(catchIndex: number): string {
  const stamp = CORRECT_ACCUSATION_STAMPS[catchIndex % CORRECT_ACCUSATION_STAMPS.length];
  return stamp ?? CORRECT_ACCUSATION_STAMPS[0];
}

/**
 * The simulation numbers the first round zero and counts up from each rematch,
 * so the printed number is one ahead of the one in RoundViewState.
 */
export function roundLabel(round: number): string {
  return `Round ${round + 1}`;
}

/** §5.15 community vote categories, in the order the results screen lists them. */
export const VOTE_CATEGORY_LABELS: Readonly<Record<ResultVoteCategory, string>> = {
  best_disguise: "Best Disguise",
  funniest_attempt: "Funniest Attempt",
  most_audacious: "Most Audacious",
};
