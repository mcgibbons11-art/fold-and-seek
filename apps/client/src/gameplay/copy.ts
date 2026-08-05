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
      return null;
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
    // Not a §41.1 entry. The results screen is one screen across two phases —
    // `RoundHud` renders `ResultsHud` for Results and RematchVote alike — and
    // without a headline for the second the clock finished, the pill went blank
    // and a fresh 12 seconds started counting, which reads as the screen about
    // to be taken away rather than as the same screen asking a new question.
    case MatchPhase.RematchVote:
      return "PLAY AGAIN?";
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
    body: "Hunt the furniture that is lying. Every shot costs a warrant round.",
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
    goal: "Patrol the Security Office until the hunt starts, then shoot whatever looks wrong.",
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

/**
 * What the Inspector spends the Fold phase doing, and why.
 *
 * §41.1 names this phase FOLD, which is the Mimics' verb: the Inspector is shut
 * in the Security Office for the same sixty seconds with nothing to fold. The
 * phase is renamed for them and the standing goal stays under it.
 */
export const INSPECTOR_FORGE_LABEL = "STAND BY";
export const INSPECTOR_FORGE_GOAL =
  "Move around the Security Office. The hunt begins when the Hiders finish forging.";
export const INSPECTOR_FORGE_PLACE = "Security Office";

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

export const DECEPTION_JACKPOT_LABEL = "THIRD PASS JACKPOT";

export function deceptionLabel(kind: DeceptionEventKind): string {
  if (kind === "direct_look_escape") return DECEPTION_ESCAPE_LABEL;
  if (kind === "close_pass_jackpot") return DECEPTION_JACKPOT_LABEL;
  return DECEPTION_CLOSE_PASS_LABEL;
}

/** The midpoint nudge, spoken to the seeker alone (2026-08-04). */
export function huntHintLine(closePasses: number): string {
  if (closePasses <= 0) return "Halfway. You have not come close to a single one yet.";
  if (closePasses === 1) return "Halfway. You have brushed right past one of them.";
  return `Halfway. You have brushed right past ${String(closePasses)} of them.`;
}

/**
 * The hunt-start thread for a seeker (2026-08-05): the census, and how many
 * of them climbed. A direction to think in, never a place.
 */
export function openingHintLine(hidden: number, elevated: number): string {
  const census = hidden === 1 ? "One Mimic is hiding" : `${String(hidden)} Mimics are hiding`;
  if (hidden === 0) return "Nobody is hiding. Enjoy the quiet.";
  if (elevated === 0) return `${census} — every one of them kept its feet on the boards.`;
  if (elevated === hidden) {
    return hidden === 1
      ? `${census} — and it climbed. Look up.`
      : `${census} — and all of them climbed. Look up.`;
  }
  return `${census} — ${String(elevated)} climbed off the floor.`;
}

export const RESTOCK_TITLE = "Warrant case";
export function restockLine(byMe: boolean, name: string | null): string {
  if (byMe) return "The case snaps open. One warrant refilled.";
  return `${name ?? "A seeker"} refilled a warrant at the case.`;
}

/**
 * The once-a-round reminder to a hider nobody has looked at (2026-08-05):
 * hiding pays by the second, but the real money is in being watched and
 * getting away with it.
 */
export const BAIT_NUDGE_TITLE = "Nobody is watching";
export const BAIT_NUDGE_BODY =
  "Safe pays slowly. Bait a passing seeker — a taunt under their gaze pays, and streaks pay more.";

/**
 * The missed-finds board. It reports on a cycle rather than continuously, so a
 * player who has just joined is told the board is coming rather than shown an
 * empty ranking they would read as "nobody has scored".
 *
 * The board was previously titled with the original's own English name,
 * "Missed-Spot Ranking" (docs/MECCHA_RESEARCH.md). That name says nothing to a
 * player who has not read the research note: it ranks hiders by the points they
 * have earned for being looked straight at and walked past, so it is titled with
 * what it measures and its two columns are named.
 */
export const MISSED_FINDS_TITLE = "Fooled the Inspector";
/** The same board, named on its rail chip. */
export const BOARD_RAIL_LABEL = MISSED_FINDS_TITLE;
export const MISSED_FINDS_TOGGLE_HINT = "6";
export const MISSED_FINDS_AWAITING = "Awaiting the first report.";
export const MISSED_FINDS_FINAL_NOTE = "final";
export const MISSED_FINDS_PLAYER_HEADER = "Player";
export const MISSED_FINDS_POINTS_HEADER = "Points";

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

/**
 * The results ledger, which reports two different rounds. A Mimic's round is
 * measured in the time they held out; an Inspector's is measured in what they
 * spent and what they caught. Printing one set of columns for both is what put
 * "SURVIVED 0.0s" against the Inspector and a pair of permanent zeroes against
 * every Mimic, so each side is given the columns that mean something to it.
 */
export const RESULTS_MIMIC_HEADING = "The Mimics";
export const RESULTS_INSPECTOR_HEADING = "The Inspector";
export const RESULTS_SPECTATOR_HEADING = "Sitting this one out";
export const RESULTS_COLUMN_PLAYER = "Player";
export const RESULTS_COLUMN_HELD_OUT = "Held out";
export const RESULTS_COLUMN_SEEN_AND_MISSED = "Seen and missed";
export const RESULTS_COLUMN_WARRANTS_SPENT = "Warrants spent";
export const RESULTS_COLUMN_CAUGHT = "Mimics caught";
export const RESULTS_COLUMN_SCORE = "Score";
export const RESULTS_SURVIVED_NOTE = "survived";

/** What the three award rows are, said once above them. */
export const RESULTS_VOTE_HEADING = "Award your votes";
export const RESULTS_VOTE_BLURB = "One vote each. You cannot vote for yourself, and a vote is final.";
export const RESULTS_VOTE_NOTHING = "Nothing to vote on.";
export const RESULTS_VOTE_LEADER_NOTE = "leading";
export const RESULTS_VOTE_YOUR_PICK = "your pick";

export function voteTallyNote(votes: number): string {
  return `${votes} vote${votes === 1 ? "" : "s"}`;
}

/**
 * The room's own words for the parts of a load that are otherwise named after
 * the machinery doing them. `GameHost` reports what it is actually building, and
 * the zone steps it reports are already in the player's language; only the
 * graphics-pipeline steps need translating out of it.
 */
const LOAD_LABELS: Readonly<Record<string, string>> = {
  "the shaders": "warming the lanterns",
  "the first frame": "turning up the lamps",
};

export function loadingLabel(label: string): string {
  return LOAD_LABELS[label] ?? label;
}

/**
 * Body painting, said once. Three panels used to carry three wordings of it at
 * once: this is the one, and it lives on the paint panel because the panel is
 * the only one of the three that travels into the hunt with the tool.
 */
export const PAINT_INSTRUCTION =
  "Drag on your body to paint it. F copies a colour from anything you point at.";

/**
 * The paint panel's shadow toggle, which is not a paint channel: it turns the
 * Mimic's own cast shadow on and off, and a shadow with nothing above it is how
 * a good disguise gets found.
 */
export const PAINT_SHADOW_LABEL = "Cast shadow";
export const PAINT_SHADOW_TITLE =
  "Whether your body casts a shadow. A shadow falling from an object that should not have one gives the disguise away.";
