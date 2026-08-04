import { describe, expect, it } from "vitest";
import { MatchPhase } from "@foldseek/shared";
import { Harness, testPose } from "./harness";

describe("match flow", () => {
  it("runs a full round from lobby to rematch", () => {
    const harness = new Harness({ players: 4, seed: 11 });
    harness.toInspection();

    const inspector = harness.inspectorIds()[0] as string;
    for (const mimicId of harness.mimicIds()) {
      harness.tick(1_000);
      const result = harness.command(inspector, {
        type: "accuse",
        targetObjectId: harness.objectIdOf(mimicId),
      });
      expect(result.accepted).toBe(true);
    }

    expect(harness.phase()).toBe(MatchPhase.Reveal);
    harness.tickUntil(MatchPhase.Results);

    const ended = harness.eventsOfType("match_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.winner).toBe("inspectors");

    for (const playerId of harness.playerIds) {
      harness.command(playerId, { type: "vote_rematch", yes: true });
    }
    harness.tickUntil(MatchPhase.RoleReveal);

    expect(harness.eventsOfType("rematch_started")).toHaveLength(1);
    expect(harness.sim.getPublicState().round).toBe(1);
  });

  it("visits every scripted phase in order", () => {
    const harness = new Harness({ players: 4, seed: 3 });
    harness.toInspection();
    harness.tickUntil(MatchPhase.RematchVote);

    const phases = harness.eventsOfType("phase_changed").map((event) => event.phase);
    expect(phases).toEqual([
      MatchPhase.Loading,
      MatchPhase.RoleReveal,
      MatchPhase.Forge,
      MatchPhase.Locking,
      MatchPhase.InspectionIntro,
      MatchPhase.Inspection,
      MatchPhase.FinalCountdown,
      MatchPhase.Reveal,
      MatchPhase.Results,
      MatchPhase.RematchVote,
    ]);
  });

  it("goes straight from loading to the role card with production settings", () => {
    const harness = new Harness({ players: 3, seed: 4 });
    harness.readyAll();
    expect(harness.command(harness.hostId, { type: "start_match" }).accepted).toBe(true);
    harness.tickUntil(MatchPhase.RoleReveal);
    expect(harness.eventsOfType("phase_changed").map((event) => event.phase)).toEqual([
      MatchPhase.Loading,
      MatchPhase.RoleReveal,
    ]);
  });

  it("refuses to start without the minimum roster and without ready players", () => {
    const solo = new Harness({ players: 1, seed: 5 });
    solo.readyAll();
    expect(solo.command(solo.hostId, { type: "start_match" }).reason).toBe("not_enough_players");

    const group = new Harness({ players: 3, seed: 5 });
    expect(group.command(group.hostId, { type: "start_match" }).reason).toBe("players_not_ready");

    const nonHost = new Harness({ players: 3, seed: 5 });
    nonHost.readyAll();
    expect(nonHost.command(nonHost.playerIds[1] as string, { type: "start_match" }).reason).toBe(
      "not_host",
    );
  });

  it("emits inspection warrants as mimics plus the bonus", () => {
    const harness = new Harness({ players: 6, seed: 21 });
    harness.toInspection();

    const started = harness.eventsOfType("inspection_started")[0];
    expect(started?.mimicsRemaining).toBe(5);
    expect(started?.warrantsRemaining).toBe(5 + harness.sim.getSettings().warrantsBonus);
  });

  it("auto-locks a mimic that never sent a lock, using its last valid pose", () => {
    const harness = new Harness({ players: 3, seed: 9 });
    harness.toForge();

    const [first, second] = harness.mimicIds();
    const recovered = testPose(7, 4);
    expect(harness.sim.recordForgeSnapshot(first as string, recovered, 4).accepted).toBe(true);
    harness.command(second as string, { type: "lock_disguise", payload: testPose(1), revision: 2 });
    harness.tickUntil(MatchPhase.Inspection);

    expect(harness.eventsOfType("disguise_locked")).toHaveLength(2);
    const auto = harness.privateEventsOfType(first as string, "own_disguise_locked")[0];
    expect(auto?.autoLocked).toBe(true);
    expect(auto?.source).toBe("recovered_pose");
    expect(harness.sim.getPrivateStateFor(first as string)?.ownDisguise?.encodedPose).toBe(
      recovered,
    );

    const manual = harness.privateEventsOfType(second as string, "own_disguise_locked")[0];
    expect(manual?.autoLocked).toBe(false);
    expect(manual?.source).toBe("player_lock");
  });

  it("ends the round on the inspection deadline with a mimic win", () => {
    const harness = new Harness({ players: 4, seed: 13 });
    harness.toInspection();
    harness.tickUntil(MatchPhase.Results);

    const ended = harness.eventsOfType("match_ended")[0];
    expect(ended?.winner).toBe("mimics");
    expect(ended?.results.players.filter((entry) => entry.fullRoundSurvival)).toHaveLength(3);
  });

  it("returns to the lobby when the rematch vote fails", () => {
    const harness = new Harness({ players: 4, seed: 17 });
    harness.toInspection();
    harness.tickUntil(MatchPhase.RematchVote);

    for (const playerId of harness.playerIds) {
      harness.command(playerId, { type: "vote_rematch", yes: false });
    }
    expect(harness.phase()).toBe(MatchPhase.Lobby);
    expect(harness.eventsOfType("rematch_started")).toHaveLength(0);
    expect(harness.sim.getPublicState().players.every((player) => !player.ready)).toBe(true);
  });

  it("resolves a complete Results-screen ballot when the vote phase opens", () => {
    const harness = new Harness({
      players: 2,
      seed: 19,
      settings: { resultsMs: 100, rematchVoteMs: 10_000 },
    });
    harness.toInspection();
    harness.tickUntil(MatchPhase.Results);

    for (const playerId of harness.playerIds) {
      expect(harness.command(playerId, { type: "vote_rematch", yes: false }).accepted).toBe(true);
    }
    expect(harness.phase()).toBe(MatchPhase.Results);

    harness.tick(100);
    expect(harness.phase()).toBe(MatchPhase.Lobby);
    expect(harness.eventsOfType("rematch_started")).toHaveLength(0);
    expect(harness.sim.getPublicState().players.every((player) => !player.ready)).toBe(true);
  });

  it("accepts host settings changes only in the lobby", () => {
    const harness = new Harness({ players: 3, seed: 23 });
    const applied = harness.command(harness.hostId, {
      type: "set_settings",
      settings: { forgeMs: 30_000, inspectionMs: 45_000 },
    });
    expect(applied.accepted).toBe(true);
    expect(harness.sim.getSettings().forgeMs).toBe(30_000);

    expect(
      harness.command(harness.playerIds[1] as string, {
        type: "set_settings",
        settings: { forgeMs: 1_000 },
      }).reason,
    ).toBe("not_host");
    expect(
      harness.command(harness.hostId, { type: "set_settings", settings: { forgeMs: -1 } }).reason,
    ).toBe("invalid_settings");

    harness.toForge();
    expect(
      harness.command(harness.hostId, { type: "set_settings", settings: { forgeMs: 20_000 } })
        .reason,
    ).toBe("wrong_phase");
  });

  it("keeps a disconnected mimic locked and restores the role on reconnect", () => {
    const harness = new Harness({ players: 4, seed: 29 });
    harness.toInspection();

    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);
    harness.record(harness.sim.markDisconnected(mimicId, harness.now));

    expect(
      harness.sim.getPublicState().disguises.some((entry) => entry.publicObjectId === objectId),
    ).toBe(true);
    expect(harness.sim.getPublicState().mimicsRemaining).toBe(3);

    harness.tick(1_000);
    harness.record(harness.sim.markReconnected(mimicId, harness.now));
    expect(harness.sim.getPrivateStateFor(mimicId)?.role).toBe("mimic");
    expect(harness.sim.getPrivateStateFor(mimicId)?.ownDisguise?.publicObjectId).toBe(objectId);
  });

  it("drops a player whose reconnect grace expires", () => {
    const harness = new Harness({ players: 5, seed: 31 });
    harness.toInspection();

    const mimicId = harness.mimicIds()[0] as string;
    harness.record(harness.sim.markDisconnected(mimicId, harness.now));
    harness.tick(harness.sim.getSettings().reconnectGraceMs + 500);

    const left = harness.eventsOfType("player_left");
    expect(left).toHaveLength(1);
    expect(left[0]?.reason).toBe("reconnect_timeout");
    expect(harness.sim.getPrivateStateFor(mimicId)).toBeNull();
  });

  it("ends the inspection when the last inspector leaves", () => {
    const harness = new Harness({ players: 4, seed: 37 });
    harness.toInspection();

    harness.record(harness.sim.removePlayer(harness.inspectorIds()[0] as string));
    expect(harness.phase()).toBe(MatchPhase.Reveal);
  });

  it("promotes a new host when the host leaves", () => {
    const harness = new Harness({ players: 3, seed: 41 });
    harness.record(harness.sim.removePlayer(harness.hostId));

    const promoted = harness.eventsOfType("host_changed");
    expect(promoted).toHaveLength(1);
    expect(harness.sim.getPrivateStateFor(harness.playerIds[1] as string)?.isHost).toBe(true);
  });
});
