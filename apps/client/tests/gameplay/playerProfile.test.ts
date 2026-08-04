// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  loadPlayerProfile,
  recordProfileRound,
  summarizePlayerProfile,
} from "../../src/gameplay/playerProfile";
import type { ResultsView } from "../../src/gameplay/roundView";

function results(bestVotes: number, score = 420): ResultsView {
  return {
    round: 2,
    winner: "mimics",
    inspectionDurationMs: 32_000,
    timeRemainingMs: 0,
    rows: [{
      publicPlayerId: "self",
      displayName: "Player",
      isSelf: true,
      role: "mimic",
      score,
      survivalSeconds: 32,
      fullRoundSurvival: true,
      directLookEscapes: 1,
      closePasses: 2,
      peerStyleVotes: bestVotes,
      correctAccusations: 0,
      wrongAccusations: 0,
      uniqueObjectsFocused: 0,
      publicObjectId: "object-self",
    }],
    voteCandidates: [],
    myVotes: { best_disguise: null, funniest_attempt: null, most_audacious: null },
    voteTallies: {
      best_disguise: { "object-self": bestVotes, rival: Math.max(0, bestVotes - 1) },
      funniest_attempt: {},
      most_audacious: {},
    },
  };
}

describe("persistent player profile", () => {
  beforeEach(() => window.localStorage.clear());

  it("upserts live tally changes into one game-history record", () => {
    recordProfileRound("room:2", results(1), 1000);
    recordProfileRound("room:2", results(3, 620), 1000);

    const profile = loadPlayerProfile();
    expect(profile.games).toHaveLength(1);
    expect(profile.games[0]?.score).toBe(620);
    expect(profile.games[0]?.awards).toEqual(["best_disguise"]);
    expect(summarizePlayerProfile(profile)).toMatchObject({
      gamesPlayed: 1,
      wins: 1,
      totalAwards: 1,
      awards: { best_disguise: 1 },
    });
  });
});
