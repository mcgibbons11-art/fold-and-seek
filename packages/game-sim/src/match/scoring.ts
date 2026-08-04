import {
  SCORE_INSPECTOR_MAX_FOCUSED_OBJECTS,
  SCORE_MIMIC_CLOSE_PASS_JACKPOT,
  SCORE_MIMIC_TAUNT_STREAK_CAP,
  SCORE_MIMIC_TAUNT_STREAK_STEP,
  SCORE_INSPECTOR_PER_CORRECT,
  SCORE_INSPECTOR_PER_FOCUSED_OBJECT,
  SCORE_INSPECTOR_PER_SECOND_REMAINING_ON_WIN,
  SCORE_INSPECTOR_PER_WRONG,
  SCORE_MIMIC_FULL_ROUND_SURVIVAL,
  SCORE_MIMIC_MAX_LINE_OF_SIGHT_POINTS,
  SCORE_MIMIC_MAX_OBSERVED_TAUNTS,
  SCORE_MIMIC_PER_CLOSE_PASS,
  SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE,
  SCORE_MIMIC_PER_LINE_OF_SIGHT_SECOND,
  SCORE_MIMIC_PER_OBSERVED_TAUNT,
  SCORE_MIMIC_PER_PEER_STYLE_VOTE,
  SCORE_MIMIC_PER_SURVIVAL_SECOND,
} from "./constants";

/** Inputs to the Mimic score formula in §6.2. */
export interface MimicScoreInput {
  readonly survivalSeconds: number;
  readonly directLookEscapes: number;
  readonly closePasses: number;
  readonly fullRoundSurvival: boolean;
  readonly peerStyleVotes: number;
  /** Whole seconds spent inside an Inspector's focus while still unresolved. */
  readonly lineOfSightSeconds?: number;
  /** Taunts performed while an Inspector was actually watching. */
  readonly observedTaunts?: number;
  /** Longest run of consecutive watched taunts (2026-08-04 bait streak). */
  readonly tauntStreakBest?: number;
  /** Third-close-pass jackpots earned, one per seeker (2026-08-04). */
  readonly closePassJackpots?: number;
}

/** Inputs to the Inspector score formula in §6.2. */
export interface InspectorScoreInput {
  readonly correctAccusations: number;
  readonly wrongAccusations: number;
  /** Whole seconds left on the inspection clock, counted only on an Inspector win. */
  readonly secondsRemainingOnTeamWin: number;
  readonly uniqueObjectsFocused: number;
}

export function scoreMimic(input: MimicScoreInput): number {
  const lineOfSight = Math.min(
    (input.lineOfSightSeconds ?? 0) * SCORE_MIMIC_PER_LINE_OF_SIGHT_SECOND,
    SCORE_MIMIC_MAX_LINE_OF_SIGHT_POINTS,
  );
  const taunts = Math.min(input.observedTaunts ?? 0, SCORE_MIMIC_MAX_OBSERVED_TAUNTS);
  const streakSteps = Math.min(
    Math.max((input.tauntStreakBest ?? 0) - 1, 0),
    SCORE_MIMIC_TAUNT_STREAK_CAP,
  );
  return (
    input.survivalSeconds * SCORE_MIMIC_PER_SURVIVAL_SECOND +
    input.directLookEscapes * SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE +
    input.closePasses * SCORE_MIMIC_PER_CLOSE_PASS +
    (input.fullRoundSurvival ? SCORE_MIMIC_FULL_ROUND_SURVIVAL : 0) +
    input.peerStyleVotes * SCORE_MIMIC_PER_PEER_STYLE_VOTE +
    lineOfSight +
    taunts * SCORE_MIMIC_PER_OBSERVED_TAUNT +
    streakSteps * SCORE_MIMIC_TAUNT_STREAK_STEP +
    (input.closePassJackpots ?? 0) * SCORE_MIMIC_CLOSE_PASS_JACKPOT
  );
}

export function scoreInspector(input: InspectorScoreInput): number {
  const focused = Math.min(input.uniqueObjectsFocused, SCORE_INSPECTOR_MAX_FOCUSED_OBJECTS);
  return (
    input.correctAccusations * SCORE_INSPECTOR_PER_CORRECT -
    input.wrongAccusations * SCORE_INSPECTOR_PER_WRONG +
    input.secondsRemainingOnTeamWin * SCORE_INSPECTOR_PER_SECOND_REMAINING_ON_WIN +
    focused * SCORE_INSPECTOR_PER_FOCUSED_OBJECT
  );
}
