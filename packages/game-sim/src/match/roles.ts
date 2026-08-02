import { DeterministicRng } from "../deterministic/rng";
import {
  DUAL_INSPECTOR_MIN_PLAYERS,
  DUAL_SEEKER_MIN_SEATS,
  SINGLE_INSPECTOR_MAX_PLAYERS,
} from "./constants";

/** Per-player role history kept across rounds in one room (§28.3). */
export interface RoleHistory {
  readonly playerId: string;
  /** Round index of the player's most recent Inspector duty, or -1 if never. */
  readonly lastInspectorRound: number;
  /** Total Inspector rounds served in this room. */
  readonly inspectorRounds: number;
  /** Round index when the player joined, so newcomers are not favoured. */
  readonly joinedRound: number;
}

export function inspectorCountForRoster(playerCount: number): number {
  if (playerCount <= 1) return 0;
  if (playerCount <= SINGLE_INSPECTOR_MAX_PLAYERS) return 1;
  return playerCount >= DUAL_INSPECTOR_MIN_PLAYERS ? 2 : 1;
}

/**
 * Most Inspectors a roster of this size can carry. A second hunter needs
 * `DUAL_SEEKER_MIN_SEATS` seats so that two people are still hiding, which is
 * what keeps the round a game of hide and seek rather than a duel.
 */
export function inspectorCapacityForRoster(playerCount: number): number {
  if (playerCount <= 1) return 0;
  return playerCount >= DUAL_SEEKER_MIN_SEATS ? 2 : 1;
}

/**
 * Inspectors to deal, given what the host asked for and who turned up.
 *
 * `seekerCount` is a floor rather than the answer: the roster rule of §5.5
 * still gives a large room two hunters whatever the host set, and a roster too
 * small to spare a second seeker gets one however high the setting is. So a
 * host who wants two seekers in a five-player room gets them, and a host who
 * leaves the setting alone gets exactly the round this game has always dealt.
 */
export function inspectorCountFor(playerCount: number, seekerCount: number): number {
  const capacity = inspectorCapacityForRoster(playerCount);
  if (capacity === 0) return 0;
  const requested = Math.max(seekerCount, inspectorCountForRoster(playerCount), 1);
  return Math.min(requested, capacity);
}

/**
 * Picks Inspectors for a round. Players who served least recently come first,
 * then players who have served fewest rounds, so consecutive Inspector duty is
 * only assigned when the roster leaves no alternative. Ties break on a seeded
 * shuffle rather than join order, keeping the choice deterministic without
 * making the first player to join a permanent Inspector.
 *
 * How many to pick is a caller's decision, because it depends on the host's
 * seeker setting as well as on the roster. Omitting it deals the roster's own
 * count, which is what a caller that has no setting to consult wants.
 */
export function assignInspectors(
  candidates: readonly RoleHistory[],
  rng: DeterministicRng,
  count = inspectorCountForRoster(candidates.length),
): string[] {
  const inspectorCount = Math.max(0, Math.min(count, candidates.length));
  if (inspectorCount === 0) return [];

  const shuffled = rng.shuffle(candidates);
  const ranked = shuffled
    .map((entry, tiebreak) => ({ entry, tiebreak }))
    .sort((a, b) => {
      if (a.entry.lastInspectorRound !== b.entry.lastInspectorRound) {
        return a.entry.lastInspectorRound - b.entry.lastInspectorRound;
      }
      if (a.entry.inspectorRounds !== b.entry.inspectorRounds) {
        return a.entry.inspectorRounds - b.entry.inspectorRounds;
      }
      if (a.entry.joinedRound !== b.entry.joinedRound) {
        return a.entry.joinedRound - b.entry.joinedRound;
      }
      return a.tiebreak - b.tiebreak;
    });

  return ranked.slice(0, inspectorCount).map((item) => item.entry.playerId);
}
