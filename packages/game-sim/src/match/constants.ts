import { MatchPhase, type MatchSettings } from "@foldseek/shared";

/**
 * Simulation constants that are not part of the tunable match settings in
 * @foldseek/shared. They govern sequencing and scoring rather than round pacing.
 */

/** Loading waits for every connected client to report ready, then gives up. */
export const LOADING_TIMEOUT_MS = 20_000;

/** Longest FinalCountdown tail inside the inspection deadline (§5.13). */
export const MAX_FINAL_COUNTDOWN_MS = 10_000;

/**
 * Countdown length for a given inspection. A short inspection would otherwise
 * spend most of itself in the countdown, so it never takes more than half.
 */
export function finalCountdownMs(settings: MatchSettings): number {
  return Math.min(MAX_FINAL_COUNTDOWN_MS, Math.floor(settings.inspectionMs / 2));
}

/**
 * Shortest Locking window, held even when every Mimic locked early. The phase
 * carries the shutter-close and pose-blend beats of §5.8, which need a moment
 * of screen time to read.
 */
export const MIN_LOCK_GRACE_MS = 1_000;

/**
 * Interaction cooldown after a correct accusation. It is deliberately not the
 * settings value `accusationHoldMs`, which is how long the Inspector holds the
 * accuse control before it fires.
 */
export const CORRECT_ACCUSATION_COOLDOWN_MS = 450;

/** Duration of a phase in milliseconds, from settings. Zero means event-driven. */
export function phaseDurationMs(phase: MatchPhase, settings: MatchSettings): number {
  switch (phase) {
    case MatchPhase.MapIntro: return settings.mapIntroMs;
    case MatchPhase.RoleReveal: return settings.roleRevealMs;
    case MatchPhase.BaselineScan: return settings.baselineScanMs;
    case MatchPhase.Forge: return settings.forgeMs;
    case MatchPhase.Locking: return settings.lockGraceMs;
    case MatchPhase.InspectionIntro: return settings.inspectionIntroMs;
    case MatchPhase.Inspection: return settings.inspectionMs;
    case MatchPhase.Reveal: return settings.revealMs;
    case MatchPhase.Results: return settings.resultsMs;
    case MatchPhase.RematchVote: return settings.rematchVoteMs;
    default: return 0;
  }
}

/** Inspector counts by roster size (§5.5). */
export const SINGLE_INSPECTOR_MAX_PLAYERS = 8;
export const DUAL_INSPECTOR_MIN_PLAYERS = 9;

/** Length of generated anonymized identifiers. */
export const PUBLIC_ID_LENGTH = 10;

/** Scoring weights (§6.2). */
export const SCORE_MIMIC_PER_SURVIVAL_SECOND = 10;
export const SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE = 75;
export const SCORE_MIMIC_PER_CLOSE_PASS = 50;
export const SCORE_MIMIC_FULL_ROUND_SURVIVAL = 500;
export const SCORE_MIMIC_PER_PEER_STYLE_VOTE = 100;
export const SCORE_INSPECTOR_PER_CORRECT = 400;
export const SCORE_INSPECTOR_PER_WRONG = 150;
export const SCORE_INSPECTOR_PER_SECOND_REMAINING_ON_WIN = 8;
/**
 * "small capped value" from §6.2, resolved to 5 points over at most 20 objects.
 * The cap also bounds how many focus targets the simulation retains per player.
 */
export const SCORE_INSPECTOR_PER_FOCUSED_OBJECT = 5;
export const SCORE_INSPECTOR_MAX_FOCUSED_OBJECTS = 20;

/** One close pass per inspector/object pair inside this window (§6.4). */
export const CLOSE_PASS_COOLDOWN_MS = 4_000;

/**
 * Bait scoring. A taunt only pays when an Inspector is actually looking, which
 * is what makes performing one a real risk rather than free points.
 */
export const SCORE_MIMIC_PER_OBSERVED_TAUNT = 40;
export const SCORE_MIMIC_MAX_OBSERVED_TAUNTS = 5;
export const TAUNT_COOLDOWN_MS = 5_000;

/**
 * Shortest gap between tension-indicator deliveries to one hider. The signal is
 * a mood, not a radar: updating it faster would let a hider triangulate an
 * Inspector by watching their own indicator flicker.
 */
export const WATCHED_THROTTLE_MS = 500;

/**
 * Time spent inside an Inspector's focus, which rewards hiding in plain sight
 * rather than in a corner. Held time is summed per focus hold, so two
 * Inspectors watching at once accrue separately, and the total is capped.
 */
export const SCORE_MIMIC_PER_LINE_OF_SIGHT_SECOND = 2;
export const SCORE_MIMIC_MAX_LINE_OF_SIGHT_POINTS = 200;

/**
 * Tolerance on the creep speed cap, absorbing float error and one tick of
 * clock jitter so a legal move is never rejected for arithmetic reasons.
 */
export const CREEP_SPEED_TOLERANCE = 1.05;

export {
  INNOCENT_REACTION_IDS,
  RESULT_VOTE_CATEGORIES,
  type InnocentReactionId,
  type ResultVoteCategory,
} from "@foldseek/shared";
