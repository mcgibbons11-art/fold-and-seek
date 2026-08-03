import { describe, expect, it } from "vitest";
import { MatchPhase, PrivateSimEventSchema, SimEventSchema } from "@foldseek/shared";
import {
  MatchSimulation,
  PERMISSIVE_SPATIAL_VALIDATOR,
  TAUNT_COOLDOWN_MS,
  WATCHED_THROTTLE_MS,
  type SpatialValidator,
} from "../src";
import { Harness } from "./harness";

/**
 * The surface round orchestration and the HUD read. Each test is named for the
 * gap it closes, so a regression says which consumer breaks.
 */

/** Locks every Mimic and reaches the hunt, so disguises exist to reason about. */
function huntHarness(seed: number, players = 5, spatial?: SpatialValidator): Harness {
  const harness = new Harness({ players, seed, spatial });
  harness.toInspection();
  return harness;
}

describe("1: results name the disguise", () => {
  it("gives each hider their public object id and inspectors none", () => {
    const harness = huntHarness(2_003);
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);
    harness.tickUntil(MatchPhase.Results);

    const results = harness.eventsOfType("match_ended")[0]?.results;
    const publicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId as string;
    const hider = results?.players.find((entry) => entry.publicPlayerId === publicId);
    expect(hider?.publicObjectId).toBe(objectId);

    const inspector = results?.players.find((entry) => entry.role === "inspector");
    expect(inspector?.publicObjectId).toBeNull();
    // Results only exist after the reveal, so naming the disguise costs nothing.
    expect(harness.phase()).toBe(MatchPhase.Results);
  });
});

describe("2: the round's warrant allowance is public", () => {
  it("reports the total alongside what is left", () => {
    const harness = huntHarness(2_011, 4);
    const bonus = harness.sim.getSettings().warrantsBonus;
    const total = 3 + bonus;
    expect(harness.sim.getPublicState().warrantsTotal).toBe(total);
    expect(harness.sim.getPublicState().warrantsRemaining).toBe(total);

    harness.command(harness.inspectorIds()[0] as string, {
      type: "accuse",
      targetObjectId: "prop-lamp",
    });
    const state = harness.sim.getPublicState();
    expect(state.warrantsTotal).toBe(total);
    expect(state.warrantsRemaining).toBe(total - 1);
  });

  it("clears the allowance when the room returns to the lobby", () => {
    const harness = huntHarness(2_017, 4);
    harness.tickUntil(MatchPhase.RematchVote);
    for (const playerId of harness.playerIds) {
      harness.command(playerId, { type: "vote_rematch", yes: false });
    }
    expect(harness.phase()).toBe(MatchPhase.Lobby);
    expect(harness.sim.getPublicState().warrantsTotal).toBe(0);
  });
});

describe("3: the roster carries seat ids without leaking ownership", () => {
  it("publishes the seat the transport supplied", () => {
    const harness = new Harness({ players: 3, seed: 2_027 });
    const rows = harness.sim.getPublicState().players;
    expect(rows.map((row) => row.seatId)).toEqual(["player-0", "player-1", "player-2"]);
    expect(rows[0]?.isHost).toBe(true);
    // The seat is the key the caller used, so a UI can match its own roster.
    expect(harness.sim.getPrivateStateFor("player-0")?.playerId).toBe(rows[0]?.seatId);
  });

  it("never links a seat to a disguise, in state or in events", () => {
    const harness = huntHarness(2_029, 6);
    const inspector = harness.inspectorIds()[0] as string;
    harness.command(inspector, {
      type: "accuse",
      targetObjectId: harness.objectIdOf(harness.mimicIds()[0] as string),
    });

    const state = harness.sim.getPublicState();
    const disguiseText = JSON.stringify(state.disguises);
    for (const row of state.players) {
      expect(disguiseText).not.toContain(row.seatId);
      expect(disguiseText).not.toContain(row.publicPlayerId);
    }
    // Mid-round the roster still refuses to say who is hiding.
    expect(state.players.filter((row) => row.rolePublicState === "unknown").length).toBeGreaterThan(
      0,
    );
    // And no seat id has entered the broadcast stream.
    const broadcast = JSON.stringify(harness.log);
    for (const playerId of harness.playerIds) expect(broadcast).not.toContain(playerId);
  });
});

describe("4: a wrong accusation carries its reaction", () => {
  it("puts the same reactionId on the result and on the world event", () => {
    const harness = huntHarness(2_039, 4);
    harness.command(harness.inspectorIds()[0] as string, {
      type: "accuse",
      targetObjectId: "prop-kettle",
    });

    const resolved = harness.eventsOfType("accusation_resolved").at(-1);
    const reaction = harness.eventsOfType("innocent_reaction").at(-1);
    expect(resolved?.correct).toBe(false);
    expect(resolved?.reactionId).toBeDefined();
    expect(resolved?.reactionId).toBe(reaction?.reactionId);
    // Both events still ship, so world presentation is unchanged.
    expect(harness.eventsOfType("innocent_reaction")).toHaveLength(1);
  });

  it("leaves a correct accusation without one", () => {
    const harness = huntHarness(2_053, 4);
    harness.command(harness.inspectorIds()[0] as string, {
      type: "accuse",
      targetObjectId: harness.objectIdOf(harness.mimicIds()[0] as string),
    });
    const resolved = harness.eventsOfType("accusation_resolved").at(-1);
    expect(resolved?.correct).toBe(true);
    expect(resolved?.reactionId).toBeUndefined();
    expect(harness.eventsOfType("innocent_reaction")).toHaveLength(0);
  });
});

describe("5: reveal entries carry survival time", () => {
  it("gives survivors and the caught their seconds at the reveal", () => {
    const harness = huntHarness(2_063, 4);
    const inspector = harness.inspectorIds()[0] as string;
    const caughtId = harness.mimicIds()[0] as string;
    const caughtObjectId = harness.objectIdOf(caughtId);

    harness.tick(8_000);
    harness.command(inspector, { type: "accuse", targetObjectId: caughtObjectId });
    harness.tickUntil(MatchPhase.Reveal);

    const owners = harness.privateEventsOfType(inspector, "disguise_owners").at(-1)?.owners;
    expect(owners).toHaveLength(3);
    expect(owners?.find((entry) => entry.publicObjectId === caughtObjectId)?.survivalSeconds).toBe(
      8,
    );
    // A survivor's clock runs to the end of the inspection, not to zero.
    const survivor = owners?.find((entry) => entry.publicObjectId !== caughtObjectId);
    expect(survivor?.survivalSeconds).toBeGreaterThan(8);
  });
});

describe("6: an unassigned lobby player is not a spectator", () => {
  it("separates the two states across a whole round", () => {
    const harness = new Harness({ players: 4, seed: 2_069 });
    expect(harness.sim.getPrivateStateFor("player-0")?.roleState).toBe("unassigned");

    harness.toInspection();
    const mimicId = harness.mimicIds()[0] as string;
    expect(harness.sim.getPrivateStateFor(mimicId)?.roleState).toBe("mimic");
    expect(harness.sim.getPrivateStateFor(harness.inspectorIds()[0] as string)?.roleState).toBe(
      "inspector",
    );

    // Someone arriving mid-round is genuinely sitting it out.
    harness.record(harness.sim.addPlayer("late-arrival", { displayName: "Late" }));
    expect(harness.sim.getPrivateStateFor("late-arrival")?.roleState).toBe("spectator");

    // Back in the lobby nobody holds a role again. The late arrival is now a
    // voter too, so the vote runs to its deadline rather than closing early.
    harness.tickUntil(MatchPhase.RematchVote);
    for (const playerId of harness.playerIds) {
      harness.command(playerId, { type: "vote_rematch", yes: false });
    }
    harness.tickUntil(MatchPhase.Lobby);
    expect(harness.sim.getPrivateStateFor(mimicId)?.roleState).toBe("unassigned");
    expect(harness.sim.getPrivateStateFor("late-arrival")?.roleState).toBe("unassigned");
  });
});

describe("7: the taunt cooldown is published, not shadow-counted", () => {
  it("mirrors the accusation cooldown for hiders", () => {
    const harness = huntHarness(2_081, 4);
    const mimicId = harness.mimicIds()[0] as string;
    expect(harness.sim.getPrivateStateFor(mimicId)?.tauntReadyAtMs).toBe(0);

    harness.command(mimicId, { type: "taunt", tauntId: "rattle" });
    expect(harness.sim.getPrivateStateFor(mimicId)?.tauntReadyAtMs).toBe(
      harness.now + TAUNT_COOLDOWN_MS,
    );
    // Inspectors have no taunt to wait on.
    expect(
      harness.sim.getPrivateStateFor(harness.inspectorIds()[0] as string)?.tauntReadyAtMs,
    ).toBeNull();
  });
});

describe("8: the being-watched signal", () => {
  it("tells a hider they are seen without saying by whom", () => {
    const harness = huntHarness(2_083, 5);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    expect(harness.sim.getPrivateStateFor(mimicId)?.watchedLevel).toBe(0);
    harness.command(inspector, { type: "focus", targetObjectId: objectId });
    expect(harness.sim.getPrivateStateFor(mimicId)?.watchedLevel).toBe(2);

    const watched = harness.privateEventsOfType(mimicId, "watched");
    expect(watched).toHaveLength(1);
    expect(watched[0]?.level).toBe(2);
    // Nothing about the Inspector or the distance rides along.
    expect(Object.keys(watched[0] ?? {}).sort()).toEqual(["at", "level", "seq", "type"]);
    expect(JSON.stringify(watched[0])).not.toContain(inspector);

    // Only the object's owner hears it.
    for (const other of harness.mimicIds()) {
      if (other === mimicId) continue;
      expect(harness.privateEventsOfType(other, "watched")).toHaveLength(0);
    }
    expect(harness.privateEventsOfType(inspector, "watched")).toHaveLength(0);
    // And it is private, never broadcast.
    expect(harness.eventsOfType("phase_changed").length).toBeGreaterThan(0);
    expect(JSON.stringify(harness.log)).not.toContain('"watched"');
  });

  it("drops back to unwatched when the Inspector looks away", () => {
    const harness = huntHarness(2_087, 5);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;

    harness.command(inspector, { type: "focus", targetObjectId: harness.objectIdOf(mimicId) });
    harness.tick(WATCHED_THROTTLE_MS + 100);
    harness.command(inspector, { type: "focus", targetObjectId: null });
    harness.tick(WATCHED_THROTTLE_MS + 100);

    expect(harness.sim.getPrivateStateFor(mimicId)?.watchedLevel).toBe(0);
    const levels = harness.privateEventsOfType(mimicId, "watched").map((event) => event.level);
    expect(levels).toEqual([2, 0]);
  });

  it("throttles the signal so it cannot be used to triangulate", () => {
    const harness = huntHarness(2_089, 5);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    // Flicking on and off inside one throttle window must not stream updates.
    for (let i = 0; i < 6; i += 1) {
      harness.command(inspector, { type: "focus", targetObjectId: objectId });
      harness.command(inspector, { type: "focus", targetObjectId: null });
      harness.tick(20);
    }
    expect(harness.privateEventsOfType(mimicId, "watched").length).toBeLessThanOrEqual(1);

    harness.tick(WATCHED_THROTTLE_MS + 100);
    harness.command(inspector, { type: "focus", targetObjectId: objectId });
    harness.tick(WATCHED_THROTTLE_MS + 100);
    const levels = harness.privateEventsOfType(mimicId, "watched").map((event) => event.level);
    expect(levels.at(-1)).toBe(2);
  });

  it("takes the weaker reading when the geometry owner supplies one", () => {
    const distant: SpatialValidator = {
      ...PERMISSIVE_SPATIAL_VALIDATOR,
      canObserve: () => ({ ok: true, level: 1 }),
    };
    const harness = huntHarness(2_099, 5, distant);
    const mimicId = harness.mimicIds()[0] as string;
    harness.command(harness.inspectorIds()[0] as string, {
      type: "focus",
      targetObjectId: harness.objectIdOf(mimicId),
    });

    expect(harness.sim.getPrivateStateFor(mimicId)?.watchedLevel).toBe(1);
    expect(harness.privateEventsOfType(mimicId, "watched")[0]?.level).toBe(1);
  });

  it("stops signalling once the hider is caught", () => {
    const harness = huntHarness(2_111, 5);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    harness.command(inspector, { type: "focus", targetObjectId: objectId });
    harness.tick(WATCHED_THROTTLE_MS + 100);
    expect(harness.sim.getPrivateStateFor(mimicId)?.watchedLevel).toBe(2);

    harness.command(inspector, { type: "accuse", targetObjectId: objectId });
    harness.tick(WATCHED_THROTTLE_MS + 100);
    expect(harness.sim.getPrivateStateFor(mimicId)?.watchedLevel).toBe(0);
    expect(harness.privateEventsOfType(mimicId, "watched").at(-1)?.level).toBe(0);
  });

  it("survives a migration without re-firing or resetting the throttle", () => {
    const harness = huntHarness(2_113, 5);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    harness.command(inspector, { type: "focus", targetObjectId: harness.objectIdOf(mimicId) });
    harness.tick(100);

    const snapshot = harness.sim.snapshot();
    expect(snapshot.pl.some((player) => player.wl === 2)).toBe(true);

    const restored = MatchSimulation.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.getPrivateStateFor(mimicId)?.watchedLevel).toBe(2);
    // The level is unchanged, so a fresh host does not announce it again.
    const output = restored.tick(harness.now + 50);
    expect(output.private.get(mimicId) ?? []).toHaveLength(0);
  });

  it("keeps both streams schema-valid with the new traffic", () => {
    const harness = huntHarness(2_129, 5);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    harness.command(inspector, { type: "focus", targetObjectId: harness.objectIdOf(mimicId) });
    harness.tick(WATCHED_THROTTLE_MS + 100);
    harness.command(inspector, { type: "accuse", targetObjectId: "prop-lamp" });
    harness.tickUntil(MatchPhase.Results);

    expect(harness.privateEventsOfType(mimicId, "watched").length).toBeGreaterThan(0);
    for (const event of harness.log) {
      const parsed = SimEventSchema.safeParse(event);
      expect(parsed.success, `${event.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
    for (const event of harness.allPrivateEvents()) {
      const parsed = PrivateSimEventSchema.safeParse(event);
      expect(parsed.success, `${event.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
});

describe("9: round numbering", () => {
  it("starts at zero and adds one per rematch", () => {
    const harness = huntHarness(2_131, 4);
    expect(harness.sim.getPublicState().round).toBe(0);

    harness.tickUntil(MatchPhase.RematchVote);
    for (const playerId of harness.playerIds) {
      harness.command(playerId, { type: "vote_rematch", yes: true });
    }
    harness.tickUntil(MatchPhase.Forge);
    expect(harness.sim.getPublicState().round).toBe(1);
  });
});
