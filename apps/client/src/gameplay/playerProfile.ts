import {
  RESULT_VOTE_CATEGORIES,
  type ResultVoteCategory,
} from "@foldseek/shared";

import type { ResultsView } from "./roundView";

const STORAGE_KEY = "foldseek.player-profile.v1";
const HISTORY_LIMIT = 40;

export interface GameHistoryEntry {
  readonly id: string;
  readonly playedAt: number;
  readonly round: number;
  readonly role: "mimic" | "inspector";
  readonly winner: "mimics" | "inspectors";
  readonly won: boolean;
  readonly score: number;
  readonly votesReceived: number;
  readonly awards: readonly ResultVoteCategory[];
}

export interface PlayerProfile {
  readonly version: 1;
  readonly games: readonly GameHistoryEntry[];
}

export interface PlayerProfileSummary {
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly totalAwards: number;
  readonly awards: Readonly<Record<ResultVoteCategory, number>>;
}

const EMPTY_PROFILE: PlayerProfile = { version: 1, games: [] };

export function loadPlayerProfile(): PlayerProfile {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY_PROFILE;
    return sanitizeProfile(JSON.parse(raw));
  } catch {
    return EMPTY_PROFILE;
  }
}

/** Upserts one round so each live vote update refreshes, rather than duplicates, history. */
export function recordProfileRound(id: string, results: ResultsView, playedAt = Date.now()): PlayerProfile {
  const self = results.rows.find((row) => row.isSelf);
  if (self === undefined || self.role === "spectator") return loadPlayerProfile();
  const awards: ResultVoteCategory[] = [];
  if (self.publicObjectId !== null) {
    for (const category of RESULT_VOTE_CATEGORIES) {
      const categoryTallies = results.voteTallies[category];
      const ownVotes = categoryTallies[self.publicObjectId] ?? 0;
      const leadingVotes = Math.max(0, ...Object.values(categoryTallies));
      if (ownVotes > 0 && ownVotes === leadingVotes) awards.push(category);
    }
  }
  const entry: GameHistoryEntry = {
    id,
    playedAt,
    round: results.round,
    role: self.role,
    winner: results.winner,
    won: (self.role === "mimic" && results.winner === "mimics") ||
      (self.role === "inspector" && results.winner === "inspectors"),
    score: self.score,
    votesReceived: self.peerStyleVotes,
    awards,
  };
  const previous = loadPlayerProfile();
  const games = [entry, ...previous.games.filter((game) => game.id !== id)]
    .sort((left, right) => right.playedAt - left.playedAt)
    .slice(0, HISTORY_LIMIT);
  const profile: PlayerProfile = { version: 1, games };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Portals privacy modes may disable storage; the current game still runs.
  }
  return profile;
}

export function summarizePlayerProfile(profile: PlayerProfile): PlayerProfileSummary {
  const awards: Record<ResultVoteCategory, number> = {
    best_disguise: 0,
    funniest_attempt: 0,
    most_audacious: 0,
  };
  let wins = 0;
  for (const game of profile.games) {
    if (game.won) wins += 1;
    for (const category of game.awards) awards[category] += 1;
  }
  return {
    gamesPlayed: profile.games.length,
    wins,
    totalAwards: Object.values(awards).reduce((sum, count) => sum + count, 0),
    awards,
  };
}

function sanitizeProfile(value: unknown): PlayerProfile {
  if (typeof value !== "object" || value === null) return EMPTY_PROFILE;
  const games = (value as { games?: unknown }).games;
  if (!Array.isArray(games)) return EMPTY_PROFILE;
  const clean = games.flatMap((entry): GameHistoryEntry[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const game = entry as Partial<GameHistoryEntry>;
    if (
      typeof game.id !== "string" ||
      typeof game.playedAt !== "number" ||
      typeof game.round !== "number" ||
      (game.role !== "mimic" && game.role !== "inspector") ||
      (game.winner !== "mimics" && game.winner !== "inspectors") ||
      typeof game.won !== "boolean" ||
      typeof game.score !== "number" ||
      typeof game.votesReceived !== "number" ||
      !Array.isArray(game.awards)
    ) return [];
    return [{
      id: game.id,
      playedAt: game.playedAt,
      round: game.round,
      role: game.role,
      winner: game.winner,
      won: game.won,
      score: game.score,
      votesReceived: game.votesReceived,
      awards: game.awards.filter((award): award is ResultVoteCategory =>
        RESULT_VOTE_CATEGORIES.includes(award as ResultVoteCategory)),
    }];
  });
  return { version: 1, games: clean.slice(0, HISTORY_LIMIT) };
}
