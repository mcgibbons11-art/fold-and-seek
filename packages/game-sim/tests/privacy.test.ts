import { describe, expect, it } from "vitest";
import { MatchPhase } from "@foldseek/shared";
import { Harness, testPose } from "./harness";

describe("identity privacy", () => {
  it("assigns public object ids that carry no link to the owner", () => {
    const harness = new Harness({ players: 6, seed: 71 });
    harness.toInspection();

    const objectIds = harness.mimicIds().map((playerId) => harness.objectIdOf(playerId));
    expect(new Set(objectIds).size).toBe(objectIds.length);

    for (const mimicId of harness.mimicIds()) {
      const objectId = harness.objectIdOf(mimicId);
      const publicPlayerId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId as string;
      expect(objectId).not.toContain(mimicId);
      expect(objectId).not.toContain(publicPlayerId.replace("p_", ""));
    }

    // Two rooms with identical rosters but different seeds must not agree on ids.
    const other = new Harness({ players: 6, seed: 72 });
    other.toInspection();
    const otherIds = other.mimicIds().map((playerId) => other.objectIdOf(playerId));
    expect(otherIds.some((id) => objectIds.includes(id))).toBe(false);
  });

  it("hides mimic identity from inspectors and from the public state", () => {
    const harness = new Harness({ players: 5, seed: 73 });
    harness.toInspection();

    const publicState = harness.sim.getPublicState();
    expect(publicState.players.filter((player) => player.rolePublicState === "mimic")).toHaveLength(
      0,
    );
    expect(publicState.disguises.every((entry) => !entry.revealed)).toBe(true);

    // Who is in the room is public, so the roster carries seat ids. What stays
    // secret is which of them is inside which disguise: nothing on a public
    // disguise names a seat or a public player id.
    const seatIds = publicState.players.map((player) => player.seatId);
    expect(seatIds).toContain("player-1");
    const disguiseText = JSON.stringify(publicState.disguises);
    for (const player of publicState.players) {
      expect(disguiseText).not.toContain(player.seatId);
      expect(disguiseText).not.toContain(player.publicPlayerId);
    }

    // Events remain seat-free entirely: routing, not redaction, keeps them safe.
    expect(JSON.stringify(harness.log)).not.toContain("player-1");

    const inspector = harness.inspectorIds()[0] as string;
    expect(harness.sim.getPrivateStateFor(inspector)?.knownDisguiseOwners).toHaveLength(0);
  });

  it("lets mimics see teammates but not the inspector roster of disguises", () => {
    const harness = new Harness({ players: 5, seed: 79 });
    harness.toInspection();

    const mimicId = harness.mimicIds()[0] as string;
    const state = harness.sim.getPrivateStateFor(mimicId);
    expect(state?.knownDisguiseOwners).toHaveLength(harness.mimicIds().length - 1);
    expect(
      state?.knownDisguiseOwners.some(
        (entry) => entry.publicObjectId === state.ownDisguise?.publicObjectId,
      ),
    ).toBe(false);
    expect(state?.warrantsRemaining).toBeNull();
  });

  /**
   * The Inspector waits out the fold with nothing to look at, which only holds
   * if the state their client reads carries nothing to look at either. A Mimic
   * may lock whenever they please and a bot seat locks on the Forge's first
   * tick, so "the record exists" and "the room may see it" have to be different
   * questions: live play had an Inspector watching the disguises arrange
   * themselves through the whole of the fold.
   */
  it("keeps every disguise out of public state until the fold closes", () => {
    const harness = new Harness({ players: 5, seed: 91 });
    harness.toForge();

    const mimicId = harness.mimicIds()[0] as string;
    harness.command(mimicId, { type: "lock_disguise", payload: testPose(0), revision: 1 });

    // The owner still has their own, through their own private state.
    const own = harness.sim.getPrivateStateFor(mimicId)?.ownDisguise;
    expect(own?.publicObjectId).toBeDefined();
    expect(harness.sim.getPublicState().disguises).toHaveLength(0);

    harness.tickUntil(MatchPhase.Inspection);
    expect(
      harness.sim
        .getPublicState()
        .disguises.some((entry) => entry.publicObjectId === own?.publicObjectId),
    ).toBe(true);
  });

  it("reveals every owner once the round reaches the reveal", () => {
    const harness = new Harness({ players: 5, seed: 83 });
    harness.toInspection();
    harness.tickUntil(MatchPhase.Reveal);

    const inspector = harness.inspectorIds()[0] as string;
    expect(harness.sim.getPrivateStateFor(inspector)?.knownDisguiseOwners).toHaveLength(4);
    expect(harness.sim.getPublicState().disguises.every((entry) => entry.revealed)).toBe(true);
  });

  it("shows a caught mimic the whole room but keeps a late joiner blind", () => {
    const harness = new Harness({ players: 5, seed: 89 });
    harness.toInspection();

    const inspector = harness.inspectorIds()[0] as string;
    const caughtId = harness.mimicIds()[0] as string;
    harness.command(inspector, { type: "accuse", targetObjectId: harness.objectIdOf(caughtId) });

    expect(harness.sim.getPrivateStateFor(caughtId)?.knownDisguiseOwners).toHaveLength(4);

    harness.record(harness.sim.addPlayer("late-arrival", { displayName: "Late" }));
    const lateState = harness.sim.getPrivateStateFor("late-arrival");
    expect(lateState?.role).toBe("spectator");
    expect(lateState?.knownDisguiseOwners.map((entry) => entry.publicObjectId)).toEqual([
      harness.objectIdOf(caughtId),
    ]);
  });

  it("only gives warrant and cooldown state to inspectors", () => {
    const harness = new Harness({ players: 4, seed: 97 });
    harness.toInspection();

    const inspector = harness.inspectorIds()[0] as string;
    const inspectorState = harness.sim.getPrivateStateFor(inspector);
    expect(inspectorState?.warrantsRemaining).toBe(5);
    expect(inspectorState?.accusationReadyAt).toBe(0);

    harness.command(inspector, { type: "accuse", targetObjectId: "prop-lamp" });
    expect(harness.sim.getPrivateStateFor(inspector)?.accusationReadyAt).toBe(
      harness.now + harness.sim.getSettings().wrongAccusationCooldownMs,
    );
    expect(harness.sim.getPrivateStateFor(harness.mimicIds()[0] as string)?.accusationReadyAt).toBeNull();
  });

  it("delivers roles privately, one entry per player", () => {
    const harness = new Harness({ players: 5, seed: 101 });
    harness.toForge();

    // The public event names the Inspectors and counts the rest, nothing more.
    const assigned = harness.eventsOfType("roles_assigned")[0];
    expect(assigned?.inspectorPublicIds).toHaveLength(1);
    expect(assigned?.mimicCount).toBe(4);

    for (const playerId of harness.playerIds) {
      expect(harness.privateEventsOfType(playerId, "role_assigned")).toHaveLength(1);
    }
    const inspector = harness.inspectorIds()[0] as string;
    expect(
      harness.privateEventsOfType(inspector, "role_assigned")[0]?.teammatePublicIds,
    ).toHaveLength(0);
    const mimicDelivery = harness.privateEventsOfType(
      harness.mimicIds()[0] as string,
      "role_assigned",
    )[0];
    expect(mimicDelivery?.role).toBe("mimic");
    expect(mimicDelivery?.teammatePublicIds).toHaveLength(3);
  });

  it("returns null private state for an unknown player and rejects its commands", () => {
    const harness = new Harness({ players: 3, seed: 103 });
    expect(harness.sim.getPrivateStateFor("ghost")).toBeNull();
    expect(harness.command("ghost", { type: "player_ready", ready: true }).reason).toBe(
      "unknown_player",
    );
  });
});
