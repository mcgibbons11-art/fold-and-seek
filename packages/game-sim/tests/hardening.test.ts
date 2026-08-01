import { describe, expect, it } from "vitest";
import {
  MatchPhase,
  PrivateSimEventSchema,
  SimEventSchema,
  createReferenceDisguiseWire,
  encodeDisguiseWire,
} from "@foldseek/shared";
import {
  CORRECT_ACCUSATION_COOLDOWN_MS,
  DEFAULT_OBJECT_REGISTRY,
  MAX_PHASE_DURATION_MS,
  MIN_LOCK_GRACE_MS,
  SCORE_INSPECTOR_MAX_FOCUSED_OBJECTS,
  type ObjectRegistry,
  type SpatialValidator,
} from "../src";
import { Harness, testPose } from "./harness";

/**
 * Regression tests for the findings of critique round 1. Each name carries the
 * finding it pins down, so a future change that reopens one says which.
 */

function registryOf(objectIds: readonly string[]): ObjectRegistry {
  return {
    mapId: "test_room",
    objects: objectIds.map((objectId) => ({
      objectId,
      innocentReactionIds: ["lamp_turns_on" as const],
    })),
  };
}

describe("P0-1 a dropped Mimic leaves its disguise behind", () => {
  it("keeps the locked pose in the room after the owner's grace expires", () => {
    const harness = new Harness({ players: 5, seed: 401, settings: { reconnectGraceMs: 5_000 } });
    harness.toInspection();

    const mimicId = harness.mimicIds()[0] as string;
    const before = harness.sim.getPrivateStateFor(mimicId);
    const objectId = before?.ownDisguise?.publicObjectId as string;
    const lockedPose = before?.ownDisguise?.encodedPose as string;
    expect(lockedPose.length).toBeGreaterThan(0);

    harness.record(harness.sim.markDisconnected(mimicId, harness.now));
    harness.tick(6_000);

    expect(harness.sim.getPrivateStateFor(mimicId)).toBeNull();
    expect(harness.eventsOfType("player_left")[0]?.reason).toBe("reconnect_timeout");

    const view = harness.sim
      .getPublicState()
      .disguises.find((entry) => entry.publicObjectId === objectId);
    expect(view).toBeDefined();
    expect(view?.encodedPose).toBe(lockedPose);
  });

  it("resolves an accusation against the abandoned disguise as a correct catch", () => {
    const harness = new Harness({ players: 5, seed: 419, settings: { reconnectGraceMs: 5_000 } });
    harness.toInspection();

    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    const departing = harness.sim.getPrivateStateFor(mimicId);
    const objectId = departing?.ownDisguise?.publicObjectId as string;
    const departedPublicId = departing?.publicPlayerId as string;

    harness.record(harness.sim.markDisconnected(mimicId, harness.now));
    harness.tick(6_000);

    // The object is still one of the Mimics left to find, not scenery.
    expect(harness.sim.getPublicState().mimicsRemaining).toBe(4);

    const warrantsBefore = harness.sim.getPublicState().warrantsRemaining;
    const result = harness.command(inspector, { type: "accuse", targetObjectId: objectId });
    expect(result.accepted).toBe(true);

    const resolved = harness.eventsOfType("accusation_resolved").at(-1);
    expect(resolved?.correct).toBe(true);
    expect(resolved?.revealedPlayerPublicId).toBe(departedPublicId);
    expect(harness.eventsOfType("mimic_caught").at(-1)?.publicPlayerId).toBe(departedPublicId);

    // A correct catch costs no warrant and provokes no innocent reaction.
    expect(harness.sim.getPublicState().warrantsRemaining).toBe(warrantsBefore);
    expect(harness.eventsOfType("innocent_reaction")).toHaveLength(0);
    expect(harness.sim.getPublicState().mimicsRemaining).toBe(3);
  });

  it("takes back the style votes a departing player cast", () => {
    const harness = new Harness({ players: 4, seed: 421 });
    harness.toInspection();
    harness.tickUntil(MatchPhase.Results);

    const voter = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    const publicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId as string;
    const scoreOf = () =>
      harness.sim.getPublicState().results?.players.find((e) => e.publicPlayerId === publicId)
        ?.score as number;

    const before = scoreOf();
    harness.command(voter, {
      type: "vote_result",
      category: "best_disguise",
      targetPublicObjectId: harness.objectIdOf(mimicId),
    });
    expect(scoreOf() - before).toBe(100);

    harness.record(harness.sim.removePlayer(voter));
    expect(scoreOf()).toBe(before);
  });
});

describe("P0-2 a transient Inspector disconnect does not end the round", () => {
  it("holds the inspection open while the Inspector is inside their grace", () => {
    const harness = new Harness({ players: 4, seed: 431, settings: { reconnectGraceMs: 10_000 } });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;

    harness.record(harness.sim.markDisconnected(inspector, harness.now));
    expect(harness.phase()).toBe(MatchPhase.Inspection);

    harness.tick(3_000);
    expect(harness.phase()).toBe(MatchPhase.Inspection);

    harness.record(harness.sim.markReconnected(inspector, harness.now));
    harness.tick(1_000);
    expect(harness.phase()).toBe(MatchPhase.Inspection);
    expect(harness.sim.getPrivateStateFor(inspector)?.role).toBe("inspector");
  });

  it("ends the round once the last Inspector is permanently gone", () => {
    const harness = new Harness({ players: 4, seed: 433, settings: { reconnectGraceMs: 5_000 } });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;

    harness.record(harness.sim.markDisconnected(inspector, harness.now));
    harness.tick(2_000);
    expect(harness.phase()).toBe(MatchPhase.Inspection);

    harness.tick(4_000);
    expect(harness.phase()).toBe(MatchPhase.Reveal);
  });
});

describe("P1-3 lock payloads are validated", () => {
  it("refuses a lock whose payload is not a canonical pose", () => {
    const harness = new Harness({ players: 4, seed: 443 });
    harness.toForge();
    const mimicId = harness.mimicIds()[0] as string;

    const garbage = harness.command(mimicId, {
      type: "lock_disguise",
      payload: "pose-0",
      revision: 1,
    });
    expect(garbage.accepted).toBe(false);
    expect(garbage.reason).toBe("invalid_pose");
    expect(garbage.detail).toBe("payload_not_json");
    expect(harness.sim.getPrivateStateFor(mimicId)?.ownDisguise).toBeNull();

    const denormalized = createReferenceDisguiseWire() as unknown as Record<string, any>;
    denormalized["root"].rotation = [0.5, 0, 0, 0.5];
    const rejected = harness.command(mimicId, {
      type: "lock_disguise",
      payload: JSON.stringify(denormalized),
      revision: 1,
    });
    expect(rejected.reason).toBe("invalid_pose");
    expect(rejected.detail).toContain("root.rotation");

    const accepted = harness.command(mimicId, {
      type: "lock_disguise",
      payload: encodeDisguiseWire(createReferenceDisguiseWire(1)),
      revision: 1,
    });
    expect(accepted.accepted).toBe(true);
  });

  it("refuses to remember an invalid Forge snapshot", () => {
    const harness = new Harness({ players: 4, seed: 449 });
    harness.toForge();
    const mimicId = harness.mimicIds()[0] as string;

    expect(harness.sim.recordForgeSnapshot(mimicId, "not-a-pose", 2).accepted).toBe(false);
    expect(harness.sim.recordForgeSnapshot(mimicId, testPose(2, 2), 2).accepted).toBe(true);
  });

  it("falls back to the default arrangement when no valid pose was ever recorded", () => {
    const harness = new Harness({ players: 3, seed: 457 });
    harness.toForge();
    const mimicId = harness.mimicIds()[0] as string;
    harness.tickUntil(MatchPhase.Inspection);

    const locked = harness.privateEventsOfType(mimicId, "own_disguise_locked")[0];
    expect(locked?.autoLocked).toBe(true);
    expect(locked?.source).toBe("default_arrangement");
    expect(locked?.defaultArrangementId).toBe("upright");

    const own = harness.sim.getPrivateStateFor(mimicId)?.ownDisguise;
    expect(own?.encodedPose).toBe("");
    expect(own?.defaultArrangementId).toBe("upright");

    const view = harness.sim
      .getPublicState()
      .disguises.find((entry) => entry.publicObjectId === own?.publicObjectId);
    expect(view?.defaultArrangementId).toBe("upright");
  });

  it("P2 treats a revision below the last recorded one as stale, and an equal one as current", () => {
    const harness = new Harness({ players: 4, seed: 461 });
    harness.toForge();
    const mimicId = harness.mimicIds()[0] as string;

    expect(harness.sim.recordForgeSnapshot(mimicId, testPose(1, 5), 5).accepted).toBe(true);
    // The same revision carries nothing new, so the snapshot is not retaken.
    expect(harness.sim.recordForgeSnapshot(mimicId, testPose(2, 5), 5).accepted).toBe(false);
    expect(harness.sim.recordForgeSnapshot(mimicId, testPose(3, 4), 4).accepted).toBe(false);

    expect(
      harness.command(mimicId, { type: "lock_disguise", payload: testPose(4, 4), revision: 4 })
        .reason,
    ).toBe("stale_revision");
    expect(
      harness.command(mimicId, { type: "lock_disguise", payload: testPose(5, 5), revision: 5 })
        .accepted,
    ).toBe(true);
  });
});

describe("P1-4 targets must exist in the object registry", () => {
  it("refuses an accusation against an object no map declares", () => {
    const harness = new Harness({ players: 4, seed: 463 });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;

    expect(
      harness.command(inspector, { type: "accuse", targetObjectId: "prop-invented" }).reason,
    ).toBe("target_unknown");
    expect(
      harness.command(inspector, { type: "accuse", targetObjectId: "obj_notreal" }).reason,
    ).toBe("target_unknown");
    expect(harness.sim.getPublicState().warrantsRemaining).toBe(5);

    expect(
      harness.command(inspector, { type: "accuse", targetObjectId: "prop-lamp" }).accepted,
    ).toBe(true);
  });

  it("accepts a live disguise even though the registry never lists it", () => {
    const harness = new Harness({ players: 4, seed: 467, registry: registryOf(["prop-lamp"]) });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    const objectId = harness.objectIdOf(harness.mimicIds()[0] as string);

    expect(harness.command(inspector, { type: "accuse", targetObjectId: objectId }).accepted).toBe(
      true,
    );
  });

  it("P2 validates in the order of §28.4: warrant, then target, then rate limit", () => {
    const harness = new Harness({ players: 3, seed: 479, settings: { warrantsBonus: 0 } });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;

    // The cooldown is checked last, so an unknown target is named as such even
    // while the Inspector is still in cooldown.
    expect(
      harness.command(inspector, { type: "accuse", targetObjectId: "prop-lamp" }).accepted,
    ).toBe(true);
    expect(
      harness.command(inspector, { type: "accuse", targetObjectId: "prop-invented" }).reason,
    ).toBe("target_unknown");
    expect(
      harness.command(inspector, { type: "accuse", targetObjectId: "prop-clock" }).reason,
    ).toBe("accusation_cooldown");

    // With the warrants gone, the warrant check speaks before the target check.
    harness.tick(5_000);
    harness.command(inspector, { type: "accuse", targetObjectId: "prop-clock" });
    expect(harness.sim.getPublicState().warrantsRemaining).toBe(0);
    expect(
      harness.command(inspector, { type: "accuse", targetObjectId: "prop-invented" }).reason,
    ).toBe("no_warrants");
  });
});

describe("P1-5 focus is validated, capped and gated on observation", () => {
  it("refuses focus on an object no map declares", () => {
    const harness = new Harness({ players: 4, seed: 487 });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;

    expect(
      harness.command(inspector, { type: "focus", targetObjectId: "prop-invented" }).reason,
    ).toBe("target_unknown");
    expect(
      harness.command(inspector, { type: "focus", targetObjectId: "prop-lamp" }).accepted,
    ).toBe(true);
    expect(harness.command(inspector, { type: "focus", targetObjectId: null }).accepted).toBe(true);
  });

  it("stops counting unique focus targets at the scoring cap", () => {
    const objectIds = Array.from({ length: 25 }, (_, i) => `prop-${i}`);
    const harness = new Harness({ players: 4, seed: 491, registry: registryOf(objectIds) });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;

    for (const objectId of objectIds) {
      expect(harness.command(inspector, { type: "focus", targetObjectId: objectId }).accepted).toBe(
        true,
      );
    }
    harness.tickUntil(MatchPhase.Results);

    const results = harness.eventsOfType("match_ended")[0]?.results;
    const inspectorResult = results?.players.find((entry) => entry.role === "inspector");
    expect(inspectorResult?.uniqueObjectsFocused).toBe(SCORE_INSPECTOR_MAX_FOCUSED_OBJECTS);
  });

  it("awards an escape only once focus has held past the threshold", () => {
    // Guards against the canObserve gate making the escape test pass for the
    // wrong reason: the duration threshold must still be what decides.
    const escapesAfterHolding = (holdMs: number): number => {
      const harness = new Harness({ players: 4, seed: 493 });
      harness.toInspection();
      const inspector = harness.inspectorIds()[0] as string;
      const objectId = harness.objectIdOf(harness.mimicIds()[0] as string);

      harness.command(inspector, { type: "focus", targetObjectId: objectId });
      harness.tick(holdMs);
      harness.command(inspector, { type: "focus", targetObjectId: null });
      harness.tick(harness.sim.getSettings().directLookBreakMs + 100);
      return harness.eventsOfType("direct_look_escape").length;
    };

    const minMs = new Harness({ players: 4, seed: 493 }).sim.getSettings().directLookMinMs;
    expect(escapesAfterHolding(minMs - 450)).toBe(0);
    expect(escapesAfterHolding(minMs + 100)).toBe(1);
  });

  it("awards no direct-look escape for an object the Inspector cannot see", () => {
    const blind: SpatialValidator = {
      canAccuse: () => ({ ok: true }),
      canObserve: () => ({ ok: false, reason: "occluded" }),
      canOccupy: () => ({ ok: true }),
    };
    const harness = new Harness({ players: 4, seed: 499, spatial: blind });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    const objectId = harness.objectIdOf(harness.mimicIds()[0] as string);
    const settings = harness.sim.getSettings();

    const focused = harness.command(inspector, { type: "focus", targetObjectId: objectId });
    expect(focused.reason).toBe("spatial_rejected");
    expect(focused.detail).toBe("occluded");

    harness.tick(settings.directLookMinMs + 100);
    harness.command(inspector, { type: "focus", targetObjectId: null });
    harness.tick(settings.directLookBreakMs + 100);
    expect(harness.eventsOfType("direct_look_escape")).toHaveLength(0);
  });
});

describe("P1-6 the roster is bounded", () => {
  it("refuses a join past maxPlayers and a join that repeats a player id", () => {
    const harness = new Harness({ players: 4, seed: 503, settings: { maxPlayers: 4 } });

    const full = harness.sim.addPlayer("player-4");
    expect(full.accepted).toBe(false);
    expect(full.reason).toBe("room_full");
    expect(harness.sim.getPublicState().players).toHaveLength(4);

    const duplicate = harness.sim.addPlayer("player-0");
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.reason).toBe("duplicate_player");
    expect(harness.sim.getPublicState().players).toHaveLength(4);
  });

  it("refuses to shrink the room below the people standing in it", () => {
    const harness = new Harness({ players: 4, seed: 509 });

    const shrunk = harness.command(harness.hostId, {
      type: "set_settings",
      settings: { maxPlayers: 3 },
    });
    expect(shrunk.reason).toBe("invalid_settings");
    expect(shrunk.detail).toBe("maxPlayers");
    expect(
      harness.command(harness.hostId, { type: "set_settings", settings: { maxPlayers: 6 } })
        .accepted,
    ).toBe(true);
  });
});

describe("P1-7 public events carry no secrets", () => {
  it("keeps roles and ownership out of the broadcast stream", () => {
    const harness = new Harness({ players: 5, seed: 521 });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    harness.command(inspector, {
      type: "accuse",
      targetObjectId: harness.objectIdOf(harness.mimicIds()[0] as string),
    });
    harness.tickUntil(MatchPhase.Results);

    const broadcast = JSON.stringify(harness.log);
    for (const playerId of harness.playerIds) {
      expect(broadcast).not.toContain(playerId);
    }
    expect(harness.log.some((event) => event.type === "roles_assigned")).toBe(true);
    for (const event of harness.log) {
      expect(event).not.toHaveProperty("deliveries");
      expect(event).not.toHaveProperty("mimicPublicIds");
    }

    // The private stream is keyed by the real player id, which is the only
    // place a real id appears at all.
    expect([...harness.privateLog.keys()].sort()).toEqual([...harness.playerIds].sort());
    for (const playerId of harness.playerIds) {
      expect(harness.privateEventsOfType(playerId, "role_assigned")).toHaveLength(1);
    }
  });

  it("validates both streams against the shared schemas", () => {
    const harness = new Harness({ players: 5, seed: 523 });
    harness.toInspection();
    harness.tickUntil(MatchPhase.Results);

    expect(harness.log.length).toBeGreaterThan(20);
    for (const event of harness.log) {
      const parsed = SimEventSchema.safeParse(event);
      expect(parsed.success, `${event.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }

    const privateEvents = harness.allPrivateEvents();
    expect(privateEvents.length).toBeGreaterThan(5);
    for (const event of privateEvents) {
      const parsed = PrivateSimEventSchema.safeParse(event);
      expect(parsed.success, `${event.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("gives every Mimic the teammate ownership mapping and Inspectors none", () => {
    const harness = new Harness({ players: 5, seed: 541 });
    harness.toInspection();

    const mimicId = harness.mimicIds()[0] as string;
    const owners = harness.privateEventsOfType(mimicId, "disguise_owners").at(-1)?.owners;
    expect(owners).toHaveLength(harness.mimicIds().length - 1);

    const inspector = harness.inspectorIds()[0] as string;
    expect(harness.privateEventsOfType(inspector, "disguise_owners")).toHaveLength(0);
  });
});

describe("P1-8 phase durations come from one place", () => {
  it("still resolves every timed phase from settings", () => {
    const harness = new Harness({ players: 3, seed: 547, settings: { forgeMs: 20_000 } });
    harness.toForge();
    expect(harness.sim.getPublicState().phaseEndsAt).toBe(harness.now + 20_000);
  });
});

describe("P1-9 a round only starts when one can be fielded", () => {
  it("falls back to the lobby when too few players remain for a rematch", () => {
    const harness = new Harness({ players: 4, seed: 557 });
    harness.toInspection();
    harness.tickUntil(MatchPhase.RematchVote);

    for (const playerId of harness.playerIds.slice(1)) {
      harness.record(harness.sim.markDisconnected(playerId, harness.now));
    }
    harness.command(harness.hostId, { type: "vote_rematch", yes: true });

    expect(harness.phase()).toBe(MatchPhase.Lobby);
    expect(harness.eventsOfType("rematch_started")).toHaveLength(0);
  });

  it("refuses to start a match a lone player cannot field", () => {
    const harness = new Harness({ players: 4, seed: 563 });
    harness.readyAll();
    for (const playerId of harness.playerIds.slice(1)) {
      harness.record(harness.sim.removePlayer(playerId));
    }
    expect(harness.command(harness.hostId, { type: "start_match" }).reason).toBe(
      "not_enough_players",
    );
  });
});

describe("P2 hardening batch", () => {
  it("clamps host settings to whole milliseconds inside the wire bounds", () => {
    const harness = new Harness({ players: 3, seed: 569 });
    const set = (settings: Record<string, number>) =>
      harness.command(harness.hostId, { type: "set_settings", settings });

    expect(set({ forgeMs: MAX_PHASE_DURATION_MS + 1 }).reason).toBe("invalid_settings");
    expect(set({ forgeMs: 1.5 }).reason).toBe("invalid_settings");
    expect(set({ forgeMs: -1 }).reason).toBe("invalid_settings");
    expect(set({ maxPlayers: 1 }).reason).toBe("invalid_settings");
    expect(set({ warrantsBonus: 17 }).reason).toBe("invalid_settings");
    expect(set({ forgeMs: MAX_PHASE_DURATION_MS }).accepted).toBe(true);
  });

  it("publishes a reaction nonce that does not expose the room seed", () => {
    const seed = 0x2b3c4d5e;
    const harness = new Harness({ players: 3, seed });
    harness.toInspection();
    harness.command(harness.inspectorIds()[0] as string, {
      type: "accuse",
      targetObjectId: "prop-lamp",
    });

    const reaction = harness.eventsOfType("innocent_reaction")[0];
    expect(reaction).toBeDefined();
    expect(reaction?.seed).not.toBe(seed);
    // The published value is truncated, so it cannot name the seed behind it.
    expect(reaction?.seed).toBeLessThan(2 ** 24);

    const replay = new Harness({ players: 3, seed });
    replay.toInspection();
    replay.command(replay.inspectorIds()[0] as string, {
      type: "accuse",
      targetObjectId: "prop-lamp",
    });
    expect(replay.eventsOfType("innocent_reaction")[0]?.seed).toBe(reaction?.seed);
  });

  it("uses the named correct-accusation cooldown, not the accusation hold", () => {
    const harness = new Harness({ players: 4, seed: 571 });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;

    harness.command(inspector, {
      type: "accuse",
      targetObjectId: harness.objectIdOf(harness.mimicIds()[0] as string),
    });
    expect(harness.sim.getPrivateStateFor(inspector)?.accusationReadyAt).toBe(
      harness.now + CORRECT_ACCUSATION_COOLDOWN_MS,
    );
  });

  it("promotes the next host by join order, never by a reused index", () => {
    const harness = new Harness({ players: 3, seed: 577 });
    harness.record(harness.sim.removePlayer(harness.playerIds[1] as string));
    harness.record(harness.sim.addPlayer("late-arrival", { displayName: "Late" }));

    harness.record(harness.sim.removePlayer(harness.hostId));
    expect(harness.sim.getPrivateStateFor(harness.playerIds[2] as string)?.isHost).toBe(true);
    expect(harness.sim.getPrivateStateFor("late-arrival")?.isHost).toBe(false);
  });

  it("keeps spectators and late joiners out of the style vote", () => {
    const harness = new Harness({ players: 4, seed: 587 });
    harness.toInspection();
    const objectId = harness.objectIdOf(harness.mimicIds()[0] as string);
    harness.tickUntil(MatchPhase.Results);

    harness.record(harness.sim.addPlayer("late-arrival", { displayName: "Late" }));
    const vote = harness.sim.handleCommand("late-arrival", {
      type: "vote_result",
      category: "funniest_attempt",
      targetPublicObjectId: objectId,
    });
    expect(vote.accepted).toBe(false);
    expect(vote.reason).toBe("wrong_role");
  });

  it("hands out defensive copies of the public state", () => {
    const harness = new Harness({ players: 4, seed: 593 });
    harness.toInspection();
    harness.tickUntil(MatchPhase.Results);

    const state = harness.sim.getPublicState();
    const firstScore = state.results?.players[0]?.score as number;
    (state.results?.players as unknown as Array<{ score: number }>)[0]!.score = -99_999;
    (state.settings as { forgeMs: number }).forgeMs = 1;

    const fresh = harness.sim.getPublicState();
    expect(fresh.results?.players[0]?.score).toBe(firstScore);
    expect(fresh.settings.forgeMs).toBe(harness.sim.getSettings().forgeMs);
  });

  it("derives the final countdown from the configured inspection length", () => {
    const harness = new Harness({ players: 3, seed: 599, settings: { inspectionMs: 10_000 } });
    harness.toInspection();
    const inspectionStartedAt = harness.now;
    harness.tickUntil(MatchPhase.FinalCountdown, 100);

    // Half of a 10 s inspection, rather than the 10 s default tail.
    expect(harness.now - inspectionStartedAt).toBeGreaterThanOrEqual(5_000);
    expect(harness.now - inspectionStartedAt).toBeLessThan(5_200);
  });

  it("holds a minimum lock grace even when every Mimic locks early", () => {
    const harness = new Harness({ players: 3, seed: 601 });
    harness.toForge();
    for (const [index, mimicId] of harness.mimicIds().entries()) {
      harness.command(mimicId, { type: "lock_disguise", payload: testPose(index), revision: 1 });
    }

    expect(harness.phase()).toBe(MatchPhase.Locking);
    harness.tick(MIN_LOCK_GRACE_MS - 500);
    expect(harness.phase()).toBe(MatchPhase.Locking);

    harness.tick(600);
    expect(harness.phase()).toBe(MatchPhase.InspectionIntro);
  });

  it("exposes the default object registry it validates against", () => {
    const harness = new Harness({ players: 3, seed: 607 });
    expect(harness.sim.getObjectRegistry()).toBe(DEFAULT_OBJECT_REGISTRY);
    expect(DEFAULT_OBJECT_REGISTRY.objects.length).toBeGreaterThan(0);
  });
});
