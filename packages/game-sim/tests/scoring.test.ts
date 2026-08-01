import { describe, expect, it } from "vitest";
import { MatchPhase } from "@foldseek/shared";
import { scoreInspector, scoreMimic } from "../src";
import { Harness } from "./harness";

describe("scoring", () => {
  it("computes the mimic score from the bible formula", () => {
    // 30*10 + 2*75 + 1*50 + 500 + 1*100
    expect(
      scoreMimic({
        survivalSeconds: 30,
        directLookEscapes: 2,
        closePasses: 1,
        fullRoundSurvival: true,
        peerStyleVotes: 1,
      }),
    ).toBe(1_100);

    // A caught mimic loses the full-round bonus: 12*10 + 0 + 0 + 0 + 0
    expect(
      scoreMimic({
        survivalSeconds: 12,
        directLookEscapes: 0,
        closePasses: 0,
        fullRoundSurvival: false,
        peerStyleVotes: 0,
      }),
    ).toBe(120);
  });

  it("computes the inspector score and caps the focus bonus", () => {
    // 2*400 - 1*150 + 20*8 + 7*5
    expect(
      scoreInspector({
        correctAccusations: 2,
        wrongAccusations: 1,
        secondsRemainingOnTeamWin: 20,
        uniqueObjectsFocused: 7,
      }),
    ).toBe(845);

    // The focus term stops at 20 objects, so 100 points either way.
    expect(
      scoreInspector({
        correctAccusations: 0,
        wrongAccusations: 0,
        secondsRemainingOnTeamWin: 0,
        uniqueObjectsFocused: 200,
      }),
    ).toBe(100);

    // Wrong accusations can push the score negative.
    expect(
      scoreInspector({
        correctAccusations: 0,
        wrongAccusations: 2,
        secondsRemainingOnTeamWin: 0,
        uniqueObjectsFocused: 0,
      }),
    ).toBe(-300);
  });

  it("awards no time bonus when the mimics win", () => {
    expect(
      scoreInspector({
        correctAccusations: 1,
        wrongAccusations: 0,
        secondsRemainingOnTeamWin: 0,
        uniqueObjectsFocused: 0,
      }),
    ).toBe(400);
  });

  it("scores a played round against hand-computed values", () => {
    const harness = new Harness({ players: 3, seed: 211 });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    const [firstMimic, secondMimic] = harness.mimicIds();

    harness.tick(10_000);
    harness.command(inspector, {
      type: "accuse",
      targetObjectId: harness.objectIdOf(firstMimic as string),
    });
    harness.tick(5_000);
    harness.command(inspector, {
      type: "accuse",
      targetObjectId: harness.objectIdOf(secondMimic as string),
    });
    harness.tickUntil(MatchPhase.Results);

    const results = harness.eventsOfType("match_ended")[0]?.results;
    expect(results?.winner).toBe("inspectors");
    // Inspection is 75 s and the last catch landed at 15 s, so 60 s remain.
    expect(results?.timeRemainingMs).toBe(60_000);

    const byPublicId = new Map(results?.players.map((entry) => [entry.publicPlayerId, entry]));
    const inspectorPublicId = harness.sim.getPrivateStateFor(inspector)?.publicPlayerId as string;
    const inspectorResult = byPublicId.get(inspectorPublicId);
    // 2*400 - 0 + 60*8 + 0 focused objects
    expect(inspectorResult?.score).toBe(1_280);

    const firstPublicId = harness.sim.getPrivateStateFor(firstMimic as string)
      ?.publicPlayerId as string;
    const firstResult = byPublicId.get(firstPublicId);
    expect(firstResult?.survivalSeconds).toBe(10);
    expect(firstResult?.score).toBe(100);

    const secondPublicId = harness.sim.getPrivateStateFor(secondMimic as string)
      ?.publicPlayerId as string;
    expect(byPublicId.get(secondPublicId)?.score).toBe(150);
  });

  it("adds peer style votes to a mimic score during the results phase", () => {
    const harness = new Harness({ players: 4, seed: 223 });
    harness.toInspection();
    harness.tickUntil(MatchPhase.Results);

    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);
    const publicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId as string;

    const before = harness.sim
      .getPublicState()
      .results?.players.find((entry) => entry.publicPlayerId === publicId)?.score as number;

    const voter = harness.inspectorIds()[0] as string;
    const vote = harness.command(voter, {
      type: "vote_result",
      category: "best_disguise",
      targetPublicObjectId: objectId,
    });
    expect(vote.accepted).toBe(true);

    const after = harness.sim
      .getPublicState()
      .results?.players.find((entry) => entry.publicPlayerId === publicId)?.score as number;
    expect(after - before).toBe(100);

    const duplicate = harness.command(voter, {
      type: "vote_result",
      category: "best_disguise",
      targetPublicObjectId: objectId,
    });
    expect(duplicate.reason).toBe("duplicate_vote");
  });
});
