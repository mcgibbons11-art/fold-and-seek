import { DeterministicRng } from "../deterministic/rng";
import { DUAL_INSPECTOR_MIN_PLAYERS, SINGLE_INSPECTOR_MAX_PLAYERS } from "./constants";

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
 * Picks Inspectors for a round. Players who served least recently come first,
 * then players who have served fewest rounds, so consecutive Inspector duty is
 * only assigned when the roster leaves no alternative. Ties break on a seeded
 * shuffle rather than join order, keeping the choice deterministic without
 * making the first player to join a permanent Inspector.
 */
export function assignInspectors(candidates: readonly RoleHistory[], rng: DeterministicRng): string[] {
  const inspectorCount = inspectorCountForRoster(candidates.length);
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
