import { describe, expect, it } from "vitest";
import { MatchPhase } from "@foldseek/shared";
import {
  DUAL_SEEKER_MIN_SEATS,
  MatchSimulation,
  inspectorCountFor,
  type ObjectRegistry,
} from "../src";
import { Harness } from "./harness";

/**
 * A round with two seekers (task #42). The single-seeker round is the default
 * and every other file here proves it; what this one proves is that the second
 * hunter is a hunter of their own — their own magazine, their own cooldown,
 * their own catches on the board — rather than a second pair of hands on the
 * first one's gun.
 */

const TWO_SEEKERS = { seekerCount: 2 } as const;

/** Enough innocent props that two seekers can empty two magazines into them. */
function propRegistry(count: number): ObjectRegistry {
  return {
    mapId: "test_room",
    objects: Array.from({ length: count }, (_, index) => ({
      objectId: `prop-${index}`,
      innocentReactionIds: [],
    })),
  };
}

/** A hunt with two seekers and the roster to support them. */
function twoSeekerHunt(seed: number, players = 5, settings: Record<string, number> = {}): Harness {
  const harness = new Harness({
    players,
    seed,
    settings: { ...TWO_SEEKERS, ...settings },
    registry: propRegistry(8),
  });
  harness.toInspection();
  return harness;
}

describe("dealing two seekers", () => {
  it("deals the count the host asked for, and the same one twice from one seed", () => {
    const first = twoSeekerHunt(3_001);
    const second = twoSeekerHunt(3_001);

    expect(first.inspectorIds()).toHaveLength(2);
    expect(first.mimicIds()).toHaveLength(3);
    // Seeded, so a replay and a migrated host deal the identical pair.
    expect(second.inspectorIds()).toEqual(first.inspectorIds());
  });

  it("leaves the default round with one seeker", () => {
    const harness = new Harness({ players: 5, seed: 3_011 });
    harness.toForge();
    expect(harness.inspectorIds()).toHaveLength(1);
    expect(harness.mimicIds()).toHaveLength(4);
  });

  it("gives a roster too small for two seekers only one", () => {
    // Three seats cannot spare a second hunter: two hiders is the floor.
    const harness = new Harness({ players: 3, seed: 3_017, settings: TWO_SEEKERS });
    harness.toForge();
    expect(harness.inspectorIds()).toHaveLength(1);
    expect(harness.mimicIds()).toHaveLength(2);
  });

  it("resolves the count from the roster and the setting together", () => {
    expect(inspectorCountFor(1, 2)).toBe(0);
    expect(inspectorCountFor(2, 1)).toBe(1);
    expect(inspectorCountFor(3, 2)).toBe(1);
    expect(inspectorCountFor(DUAL_SEEKER_MIN_SEATS, 2)).toBe(2);
    expect(inspectorCountFor(5, 1)).toBe(1);
    // §5.5 still deals two hunters to a large room whatever the host set.
    expect(inspectorCountFor(9, 1)).toBe(2);
  });

  it("rotates both seats between rounds", () => {
    const harness = twoSeekerHunt(3_019, 6);
    const first = new Set(harness.inspectorIds());
    expect(first.size).toBe(2);

    harness.tickUntil(MatchPhase.RematchVote);
    for (const playerId of harness.playerIds) {
      harness.command(playerId, { type: "vote_rematch", yes: true });
    }
    harness.tickUntil(MatchPhase.BaselineScan);

    const second = harness.inspectorIds();
    expect(second).toHaveLength(2);
    expect(second.some((playerId) => first.has(playerId))).toBe(false);
  });
});

describe("the seat floor on the setting", () => {
  it("refuses two seekers in a room too small to seat them", () => {
    const harness = new Harness({ players: 2, seed: 3_023 });
    const set = (settings: Record<string, number>) =>
      harness.command(harness.hostId, { type: "set_settings", settings });

    expect(set({ maxPlayers: DUAL_SEEKER_MIN_SEATS - 1, seekerCount: 2 }).reason).toBe(
      "invalid_settings",
    );
    expect(set({ maxPlayers: DUAL_SEEKER_MIN_SEATS - 1, seekerCount: 2 }).detail).toBe(
      "seekerCount",
    );
    expect(set({ maxPlayers: DUAL_SEEKER_MIN_SEATS, seekerCount: 2 }).accepted).toBe(true);
    expect(harness.sim.getSettings().seekerCount).toBe(2);

    // And the seats cannot be taken away afterwards while two seekers stand.
    expect(set({ maxPlayers: DUAL_SEEKER_MIN_SEATS - 1 }).reason).toBe("invalid_settings");
    expect(set({ seekerCount: 3 }).reason).toBe("invalid_settings");
    expect(set({ seekerCount: 0 }).reason).toBe("invalid_settings");
  });
});

describe("warrants are held per seeker", () => {
  it("issues each seeker a full allowance and sums them for the room", () => {
    const harness = twoSeekerHunt(3_037);
    const [first, second] = harness.inspectorIds();
    const allowance = 3 + harness.sim.getSettings().warrantsBonus;

    const state = harness.sim.getPublicState();
    expect(state.warrantsPerInspector).toBe(allowance);
    expect(state.warrantsTotal).toBe(allowance * 2);
    expect(state.warrantsRemaining).toBe(allowance * 2);
    expect(harness.sim.getPrivateStateFor(first as string)?.warrantsRemaining).toBe(allowance);
    expect(harness.sim.getPrivateStateFor(second as string)?.warrantsRemaining).toBe(allowance);
  });

  it("spends only the shooter's own warrant, and only their own cooldown", () => {
    const harness = twoSeekerHunt(3_041);
    const [first, second] = harness.inspectorIds();
    const allowance = 3 + harness.sim.getSettings().warrantsBonus;

    expect(harness.command(first as string, { type: "accuse", targetObjectId: "prop-0" }).accepted)
      .toBe(true);

    expect(harness.sim.getPrivateStateFor(first as string)?.warrantsRemaining).toBe(allowance - 1);
    expect(harness.sim.getPrivateStateFor(second as string)?.warrantsRemaining).toBe(allowance);
    expect(harness.sim.getPublicState().warrantsRemaining).toBe(allowance * 2 - 1);

    // The first seeker is now in cooldown; the second never fired and is not.
    expect(harness.command(first as string, { type: "accuse", targetObjectId: "prop-1" }).reason)
      .toBe("accusation_cooldown");
    expect(harness.command(second as string, { type: "accuse", targetObjectId: "prop-1" }).accepted)
      .toBe(true);
  });

  it("reports the shooter's own remainder on the resolution event", () => {
    const harness = twoSeekerHunt(3_043);
    const [first, second] = harness.inspectorIds();
    const allowance = 3 + harness.sim.getSettings().warrantsBonus;

    harness.command(first as string, { type: "accuse", targetObjectId: "prop-0" });
    harness.command(second as string, { type: "accuse", targetObjectId: "prop-1" });

    const resolved = harness.eventsOfType("accusation_resolved");
    expect(resolved).toHaveLength(2);
    // Both read the same, because each spent one of their own rather than two
    // out of a shared pool.
    expect(resolved.map((event) => event.warrantsRemaining)).toEqual([
      allowance - 1,
      allowance - 1,
    ]);
  });

  it("lets a seeker who is out of warrants stop without disarming their partner", () => {
    // Two seats each, so a magazine can actually be emptied inside a test.
    const harness = twoSeekerHunt(3_047, 4, { warrantsBonus: 0 });
    const [first, second] = harness.inspectorIds();
    const cooldown = harness.sim.getSettings().wrongAccusationCooldownMs + 1;
    expect(harness.sim.getPublicState().warrantsPerInspector).toBe(2);

    for (const target of ["prop-0", "prop-1"]) {
      expect(
        harness.command(first as string, { type: "accuse", targetObjectId: target }).accepted,
      ).toBe(true);
      harness.tick(cooldown);
    }

    expect(harness.sim.getPrivateStateFor(first as string)?.warrantsRemaining).toBe(0);
    expect(harness.command(first as string, { type: "accuse", targetObjectId: "prop-2" }).reason)
      .toBe("no_warrants");
    // The partner still has every round they were issued.
    expect(harness.sim.getPrivateStateFor(second as string)?.warrantsRemaining).toBe(2);
    expect(
      harness.command(second as string, { type: "accuse", targetObjectId: "prop-2" }).accepted,
    ).toBe(true);
  });

  it("keeps the hunt running once both magazines are empty", () => {
    const harness = twoSeekerHunt(3_049, 4, { warrantsBonus: 0 });
    const [first, second] = harness.inspectorIds();
    const cooldown = harness.sim.getSettings().wrongAccusationCooldownMs + 1;

    const shots: Array<readonly [string, string]> = [
      [first as string, "prop-0"],
      [second as string, "prop-1"],
      [first as string, "prop-2"],
      [second as string, "prop-3"],
    ];
    for (const [inspectorId, target] of shots) {
      expect(harness.command(inspectorId, { type: "accuse", targetObjectId: target }).accepted)
        .toBe(true);
      harness.tick(cooldown);
    }

    expect(harness.sim.getPublicState().warrantsRemaining).toBe(0);
    for (const inspectorId of [first, second]) {
      expect(harness.command(inspectorId as string, { type: "accuse", targetObjectId: "prop-4" }).reason)
        .toBe("no_warrants");
    }
    // Running out of warrants refuses the shot; it does not end the round. The
    // clock does, and the hiders win it.
    expect(harness.phase()).toBe(MatchPhase.Inspection);
    harness.tickUntil(MatchPhase.Results);
    expect(harness.eventsOfType("match_ended")[0]?.winner).toBe("mimics");
  });

  it("takes a departing seeker's unspent warrants out of the room's total", () => {
    const harness = twoSeekerHunt(3_053);
    const [first, second] = harness.inspectorIds();
    const allowance = 3 + harness.sim.getSettings().warrantsBonus;

    harness.record(harness.sim.removePlayer(first as string));
    expect(harness.sim.getPublicState().warrantsRemaining).toBe(allowance);
    expect(harness.sim.getPrivateStateFor(second as string)?.warrantsRemaining).toBe(allowance);
    // One hunter left standing keeps the round alive.
    expect(harness.phase()).toBe(MatchPhase.Inspection);
  });
});

describe("two seekers on the scoreboard", () => {
  it("attributes each catch to the seeker who made it and ends on the last hider", () => {
    const harness = twoSeekerHunt(3_059, 4);
    const [first, second] = harness.inspectorIds();
    const [firstMimic, secondMimic] = harness.mimicIds();

    harness.tick(2_000);
    harness.command(first as string, {
      type: "accuse",
      targetObjectId: harness.objectIdOf(firstMimic as string),
    });
    expect(harness.phase()).toBe(MatchPhase.Inspection);

    harness.tick(2_000);
    harness.command(second as string, {
      type: "accuse",
      targetObjectId: harness.objectIdOf(secondMimic as string),
    });

    // Every hider resolved ends the hunt however many hunters are in the room.
    expect(harness.phase()).toBe(MatchPhase.Reveal);
    harness.tickUntil(MatchPhase.Results);

    const results = harness.eventsOfType("match_ended")[0]?.results;
    expect(results?.winner).toBe("inspectors");
    const inspectors = results?.players.filter((entry) => entry.role === "inspector") ?? [];
    expect(inspectors).toHaveLength(2);
    expect(inspectors.every((entry) => entry.correctAccusations === 1)).toBe(true);
    expect(inspectors.every((entry) => entry.score > 0)).toBe(true);
    // A catch belongs to the seeker who fired, so neither carries the other's.
    expect(inspectors.map((entry) => entry.publicObjectId)).toEqual([null, null]);
  });

  it("separates the two seekers' wrong accusations", () => {
    const harness = twoSeekerHunt(3_061, 4, { warrantsBonus: 1 });
    const [first, second] = harness.inspectorIds();
    const cooldown = harness.sim.getSettings().wrongAccusationCooldownMs + 1;

    harness.command(first as string, { type: "accuse", targetObjectId: "prop-0" });
    harness.tick(cooldown);
    harness.command(first as string, { type: "accuse", targetObjectId: "prop-1" });
    harness.command(second as string, { type: "accuse", targetObjectId: "prop-2" });
    harness.tickUntil(MatchPhase.Results);

    const results = harness.eventsOfType("match_ended")[0]?.results;
    const firstPublicId = harness.sim.getPrivateStateFor(first as string)?.publicPlayerId;
    const secondPublicId = harness.sim.getPrivateStateFor(second as string)?.publicPlayerId;
    const rowOf = (publicId: string | undefined) =>
      results?.players.find((entry) => entry.publicPlayerId === publicId);

    expect(rowOf(firstPublicId)?.wrongAccusations).toBe(2);
    expect(rowOf(secondPublicId)?.wrongAccusations).toBe(1);
  });

  it("credits a close pass and a watched reading to each seeker separately", () => {
    const harness = twoSeekerHunt(3_067);
    const [first, second] = harness.inspectorIds();
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    harness.record(harness.sim.recordClosePass(first as string, objectId, harness.now));
    harness.record(harness.sim.recordClosePass(second as string, objectId, harness.now));

    // The cooldown is per seeker and object, so the second hunter's pass pays.
    const passes = harness.eventsOfType("close_pass");
    expect(passes).toHaveLength(2);
    expect(new Set(passes.map((event) => event.inspectorPublicId)).size).toBe(2);

    // Both may hold the same object in focus, and the hider feels the stronger.
    harness.command(first as string, { type: "focus", targetObjectId: objectId });
    harness.command(second as string, { type: "focus", targetObjectId: objectId });
    expect(harness.sim.getPrivateStateFor(mimicId)?.watchedLevel).toBe(2);
  });
});

describe("two seekers survive a host migration", () => {
  it("carries both magazines through the snapshot", () => {
    const harness = twoSeekerHunt(3_071);
    const [first, second] = harness.inspectorIds();
    const allowance = 3 + harness.sim.getSettings().warrantsBonus;

    harness.command(first as string, { type: "accuse", targetObjectId: "prop-0" });
    const snapshot = harness.sim.snapshot();
    expect(snapshot.wi).toBe(allowance);
    expect(snapshot.wp).toHaveLength(2);

    const restored = MatchSimulation.restore(snapshot, {
      objectRegistry: harness.sim.getObjectRegistry(),
    });
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.getPrivateStateFor(first as string)?.warrantsRemaining).toBe(allowance - 1);
    expect(restored.getPrivateStateFor(second as string)?.warrantsRemaining).toBe(allowance);
    expect(restored.getPublicState().warrantsRemaining).toBe(allowance * 2 - 1);
  });
});
