import { MatchPhase, PLAYER_HEIGHT_M, type MatchSettings } from "@foldseek/shared";

/**
 * Simulation constants that are not part of the tunable match settings in
 * @foldseek/shared. They govern sequencing and scoring rather than round pacing.
 */

/** Loading waits for every connected client to report ready, then gives up. */
export const LOADING_TIMEOUT_MS = 20_000;

/**
 * A hider whose root sits at least this high counts as elevated for the
 * opening hint (2026-08-05): one body height off the boards is a climb, not
 * a doorstep.
 */
export const OPENING_HINT_ELEVATED_MIN_Y = PLAYER_HEIGHT_M;

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
 * Shortest Forge window, held even when every Mimic has already locked.
 *
 * Forge ends early once every Mimic is locked, which is right for a room of
 * people and wrong for the round a solo Inspector plays: bots lock on the frame
 * they are dealt a disguise, so the phase collapsed to about ten seconds and the
 * Inspector's staging beat — walking the shop, reading the baseline, choosing
 * where to start — never happened. The floor gives that beat a length whatever
 * the roster is. It is a floor and never an extension: the settings' own
 * `forgeMs` still ends the phase, and a shorter `forgeMs` wins over this
 * (`min` at the call site), so a host who wants a fast round gets one.
 */
export const MIN_FORGE_DWELL_MS = 25_000;

/**
 * Interaction cooldown after a correct accusation. Deliberately its own
 * constant: the bible's hold-to-confirm accuse control (and its
 * `accusationHoldMs` setting) was replaced by the gun per design override 1,
 * so no settings value governs this beat.
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
 * How long the Inspector must stay inside `CLOSE_PASS_DISTANCE_M` before the
 * pass counts. It separates a walk-past from a jump in the reported eye: a
 * teleport, a rejoin, or a camera cut puts the eye beside a disguise for a
 * single sample, and none of those is the beat §6.4 pays for.
 *
 * At the Inspector's 0.91 m/s walk, a straight line through the middle of the
 * 1.4 m proximity band takes about 1.5 s, and a grazing pass along its edge
 * rather less. Four hundred milliseconds is 0.36 m of walking, so every real
 * pass clears it with room to spare while a one-sample jump never does. It is
 * also four ticks of the 10 Hz loopback and eight of the 20 Hz server, so no
 * transport can satisfy it inside a single tick.
 */
export const CLOSE_PASS_DWELL_MS = 400;

/**
 * Bait scoring. A taunt only pays when an Inspector is actually looking, which
 * is what makes performing one a real risk rather than free points.
 */
export const SCORE_MIMIC_PER_OBSERVED_TAUNT = 40;
/**
 * Bait-streak bonus (2026-08-04): each consecutive watched taunt beyond the
 * first pays this on top, up to the cap. An unwatched taunt resets the run,
 * which is what makes a late-round taunt spree a wager rather than a grind.
 */
export const SCORE_MIMIC_TAUNT_STREAK_STEP = 20;
export const SCORE_MIMIC_TAUNT_STREAK_CAP = 4;
/** One-time bonus for a third close pass with the same seeker (2026-08-04). */
export const SCORE_MIMIC_CLOSE_PASS_JACKPOT = 40;
/** Close passes with one seeker that trip the jackpot. */
export const CLOSE_PASS_JACKPOT_COUNT = 3;
/** Warrants one restock claim refills (2026-08-04 expansion). */
export const WARRANT_RESTOCK_COUNT = 1;
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
/**
 * Live missed-finds board (MECCHA "MISSED FINDS RATING", docs/MECCHA_RESEARCH.md).
 *
 * Points are published in buckets rather than exactly, and the cycle is
 * jittered, because every component of the score is caused by the Inspector's
 * own actions: they stare, and twenty seconds later somebody's number moves.
 * Coarsening the number blunts that inference. It does not remove it, and the
 * board is a deliberate design choice to publish a signal the Inspector partly
 * authored, so the residual correlation is accepted rather than solved here.
 */
export const MISSED_FINDS_POINT_BUCKET = 25;
export const MISSED_FINDS_JITTER_MS = 3_000;
/** Floor on the jittered cycle, so a short setting cannot spin the scheduler. */
export const MISSED_FINDS_MIN_INTERVAL_MS = 1_000;

export const SCORE_MIMIC_PER_LINE_OF_SIGHT_SECOND = 2;
export const SCORE_MIMIC_MAX_LINE_OF_SIGHT_POINTS = 200;

/**
 * Tolerance on the creep speed cap, absorbing float error and one tick of
 * clock jitter so a legal move is never rejected for arithmetic reasons.
 */
export const CREEP_SPEED_TOLERANCE = 1.05;

export {
  DUAL_SEEKER_MIN_SEATS,
  INNOCENT_REACTION_IDS,
  MAX_SEEKER_COUNT,
  RESULT_VOTE_CATEGORIES,
  type InnocentReactionId,
  type ResultVoteCategory,
} from "@foldseek/shared";
