import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_SETTINGS, MatchPhase, MatchSnapshotSchema } from "@foldseek/shared";
import {
  DEFAULT_OBJECT_REGISTRY,
  MATCH_SNAPSHOT_VERSION,
  MatchSimulation,
  estimateSnapshotBytes,
  estimateSnapshotPoseBytes,
  type MatchCommand,
  type MatchSnapshot,
  type SimOutput,
} from "../src";
import { Harness, testPose } from "./harness";

/**
 * Host migration (§27.11). A restored room must be the same room: same state,
 * same random stream, same events from the same later input.
 */

/** Everything one output carried, flattened so two runs can be compared whole. */
function outputToJson(output: SimOutput): string {
  return JSON.stringify({
    public: output.public,
    private: [...output.private.entries()].map(([playerId, events]) => [playerId, events]),
  });
}

/** The playerId of a sim's first Inspector, found through its private views. */
function inspectorOf(sim: MatchSimulation): string {
  for (let index = 0; index < 12; index += 1) {
    const playerId = `player-${index}`;
    if (sim.getPrivateStateFor(playerId)?.role === "inspector") return playerId;
  }
  throw new Error("no inspector in this simulation");
}

/** An object id that is still in play, so accusing it does something. */
function survivingObjectOf(sim: MatchSimulation): string {
  const target = sim.getPublicState().disguises.find((disguise) => !disguise.revealed);
  if (!target) throw new Error("no unresolved disguise left");
  return target.publicObjectId;
}

/**
 * A mid-inspection room holding every awkward case at once: a caught Mimic, a
 * wrongly accused prop, a focus hold, a close-pass clock, a Mimic still inside
 * their reconnect grace, and a ghost disguise whose owner is gone for good.
 */
function midRoundHarness(seed: number): Harness {
  const harness = new Harness({ players: 6, seed, settings: { reconnectGraceMs: 4_000 } });
  harness.toInspection();

  const inspector = harness.inspectorIds()[0] as string;
  const mimics = harness.mimicIds();
  harness.tick(2_000);
  harness.command(inspector, { type: "accuse", targetObjectId: "prop-lamp" });
  harness.tick(3_000);
  harness.command(inspector, {
    type: "accuse",
    targetObjectId: harness.objectIdOf(mimics[0] as string),
  });
  harness.command(inspector, { type: "focus", targetObjectId: "prop-clock" });
  harness.record(harness.sim.recordClosePass(inspector, harness.objectIdOf(mimics[1] as string)));

  // One Mimic leaves for good, so their disguise is standing there ownerless.
  harness.record(harness.sim.markDisconnected(mimics[1] as string, harness.now));
  harness.tick(5_000);

  // A second Mimic is only briefly away and must keep their slot.
  harness.record(harness.sim.markDisconnected(mimics[2] as string, harness.now));
  harness.tick(1_000);
  return harness;
}

describe("host migration snapshot", () => {
  it("round-trips a mid-round snapshot without losing a field", () => {
    const harness = midRoundHarness(881);
    const original = harness.sim.snapshot();
    const restored = MatchSimulation.restore(original).snapshot();

    expect(restored).toEqual(original);
    // Through JSON too, since that is how a transport will carry it.
    expect(JSON.parse(JSON.stringify(restored))).toEqual(JSON.parse(JSON.stringify(original)));
    expect(original.v).toBe(MATCH_SNAPSHOT_VERSION);
  });

  it("captures the state a mid-round room actually holds", () => {
    const harness = midRoundHarness(883);
    const snapshot = harness.sim.snapshot();

    expect(snapshot.ph).toBe(MatchPhase.Inspection);
    expect(snapshot.dg).toHaveLength(5);
    expect(snapshot.t).toBe(harness.now);
    expect(snapshot.rc).toBeGreaterThan(0);
    expect(snapshot.sq).toBeGreaterThan(0);

    // The disconnected player keeps their grace clock, the caught Mimic its time.
    expect(snapshot.pl.some((player) => player.c === false && player.d !== null)).toBe(true);
    expect(snapshot.dg.some((disguise) => disguise.ct !== null)).toBe(true);
    // The departed owner's disguise survives them, with its pose and identity.
    const ghost = snapshot.dg.find((disguise) => disguise.ow === null);
    expect(ghost).toBeDefined();
    expect(ghost?.e.length).toBeGreaterThan(0);
    expect(ghost?.op).toMatch(/^p_/);
    expect(snapshot.pl).toHaveLength(5);
    expect(snapshot.ro.some(([, kind]) => kind === "innocent")).toBe(true);
    expect(snapshot.ro.some(([, kind]) => kind === "mimic")).toBe(true);
    expect(snapshot.ar).not.toHaveLength(0);
    expect(snapshot.fh).not.toHaveLength(0);
    expect(snapshot.lc).not.toHaveLength(0);
    expect(snapshot.dg.every((disguise) => disguise.e.length > 0)).toBe(true);
  });

  it("keeps a player and the disguise map pointing at one record", () => {
    const harness = midRoundHarness(887);
    const sim = MatchSimulation.restore(harness.sim.snapshot());

    // Catching a Mimic must be visible through the owner's private view, which
    // only holds if the player and the map share the record rather than copies.
    // The owner has to be connected, or the tick below evicts them first.
    const connected = new Set(
      sim
        .getPublicState()
        .players.filter((player) => player.connected)
        .map((player) => player.publicPlayerId),
    );
    const owner = harness.playerIds.find((playerId) => {
      const state = sim.getPrivateStateFor(playerId);
      return (
        state?.lifeState === "active" &&
        state.ownDisguise !== null &&
        connected.has(state.publicPlayerId)
      );
    }) as string;
    const objectId = sim.getPrivateStateFor(owner)?.ownDisguise?.publicObjectId as string;

    const inspector = harness.inspectorIds()[0] as string;
    sim.tick(harness.now + 10_000);
    expect(sim.handleCommand(inspector, { type: "accuse", targetObjectId: objectId }).accepted).toBe(
      true,
    );
    expect(sim.getPrivateStateFor(owner)?.lifeState).toBe("caught");
    expect(sim.getPublicState().disguises.find((d) => d.publicObjectId === objectId)?.revealed).toBe(
      true,
    );
  });

  it("carries a ghost disguise across the migration and still catches it", () => {
    const harness = midRoundHarness(943);
    const snapshot = harness.sim.snapshot();
    const ghost = snapshot.dg.find((disguise) => disguise.ow === null);
    const ghostObjectId = ghost?.o as string;
    const ghostPublicId = ghost?.op as string;

    const sim = MatchSimulation.restore(snapshot);
    expect(sim.getPublicState().disguises.find((d) => d.publicObjectId === ghostObjectId)).toEqual(
      harness.sim.getPublicState().disguises.find((d) => d.publicObjectId === ghostObjectId),
    );
    expect(sim.getPublicState().mimicsRemaining).toBe(
      harness.sim.getPublicState().mimicsRemaining,
    );

    const inspectorId = harness.inspectorIds()[0] as string;
    sim.tick(harness.now + 5_000);
    const result = sim.handleCommand(inspectorId, { type: "accuse", targetObjectId: ghostObjectId });
    expect(result.accepted).toBe(true);
    expect(result.public.find((event) => event.type === "accusation_resolved")).toMatchObject({
      correct: true,
      revealedPlayerPublicId: ghostPublicId,
    });
  });

  it("a ghost disguise still decides the winner after a migration", () => {
    // The Mimics keep the round while an uncaught ownerless disguise stands,
    // even though nobody is left in the room to be caught inside it.
    const harness = midRoundHarness(947);
    expect(harness.sim.snapshot().dg.some((disguise) => disguise.ow === null)).toBe(true);

    const sim = MatchSimulation.restore(harness.sim.snapshot());
    let winner: string | undefined;
    for (let step = 0; step < 400 && winner === undefined; step += 1) {
      const output = sim.tick(harness.now + step * 1_000);
      const ended = output.public.find((event) => event.type === "match_ended");
      if (ended && ended.type === "match_ended") winner = ended.winner;
    }
    expect(winner).toBe("mimics");
  });

  it("still abandons a disguise correctly when its owner is dropped after the migration", () => {
    // detachPlayer marks the disguise through the player's own reference, so a
    // restore that copied the record instead of sharing it would leave the
    // abandoned object owned and uncatchable (the P0-1 failure, reintroduced).
    const harness = new Harness({ players: 5, seed: 941, settings: { reconnectGraceMs: 5_000 } });
    harness.toInspection();

    const mimicId = harness.mimicIds()[0] as string;
    const inspectorId = harness.inspectorIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);
    const departedPublicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId as string;

    const sim = MatchSimulation.restore(harness.sim.snapshot());
    const now = harness.now;
    sim.markDisconnected(mimicId, now);
    sim.tick(now + 6_000);
    expect(sim.getPrivateStateFor(mimicId)).toBeNull();

    expect(sim.getPublicState().mimicsRemaining).toBe(4);
    const result = sim.handleCommand(inspectorId, { type: "accuse", targetObjectId: objectId });
    expect(result.accepted).toBe(true);
    const resolved = result.public.find((event) => event.type === "accusation_resolved");
    expect(resolved).toMatchObject({ correct: true, revealedPlayerPublicId: departedPublicId });
  });

  it("produces identical events to the original for the same later input", () => {
    const original = midRoundHarness(907).sim;
    const restored = MatchSimulation.restore(original.snapshot());

    const inspector = original
      .getPublicState()
      .players.find((player) => player.rolePublicState === "inspector")?.publicPlayerId as string;
    const inspectorId = ["player-0", "player-1", "player-2", "player-3", "player-4", "player-5"].find(
      (playerId) => original.getPrivateStateFor(playerId)?.publicPlayerId === inspector,
    ) as string;

    const survivor = original
      .getPublicState()
      .disguises.find((disguise) => !disguise.revealed)?.publicObjectId as string;

    const script: Array<{ at: number; playerId?: string; command?: MatchCommand }> = [
      { at: 1_000 },
      { at: 2_000, playerId: inspectorId, command: { type: "focus", targetObjectId: "prop-kettle" } },
      { at: 3_500, playerId: inspectorId, command: { type: "focus", targetObjectId: null } },
      { at: 5_000 },
      { at: 6_000, playerId: inspectorId, command: { type: "accuse", targetObjectId: survivor } },
      { at: 9_000 },
      { at: 30_000 },
      { at: 60_000 },
    ];

    const play = (sim: MatchSimulation, base: number): string[] => {
      const log: string[] = [];
      for (const step of script) {
        log.push(outputToJson(sim.tick(base + step.at)));
        if (step.command && step.playerId) {
          log.push(outputToJson(sim.handleCommand(step.playerId, step.command)));
        }
      }
      return log;
    };

    const base = original.getPublicState().now;
    const fromOriginal = play(original, base);
    const fromRestored = play(restored, base);
    expect(fromRestored).toEqual(fromOriginal);
    // Not vacuous: the script really did produce events.
    expect(fromOriginal.join("").length).toBeGreaterThan(500);
  });

  it("continues the identity stream so a later joiner gets the same public id", () => {
    const harness = new Harness({ players: 3, seed: 911 });
    harness.toForge();

    const restored = MatchSimulation.restore(harness.sim.snapshot());
    harness.record(harness.sim.addPlayer("late-arrival", { displayName: "Late" }));
    restored.addPlayer("late-arrival", { displayName: "Late" });

    expect(restored.getPrivateStateFor("late-arrival")?.publicPlayerId).toBe(
      harness.sim.getPrivateStateFor("late-arrival")?.publicPlayerId,
    );
  });

  it("carries undrained events across the migration", () => {
    const harness = new Harness({ players: 4, seed: 919 });
    harness.toForge();
    // addPlayer leaves nothing queued, so emit without draining by reaching in
    // through a command whose output the caller never reads.
    harness.sim.handleCommand(harness.mimicIds()[0] as string, {
      type: "lock_disguise",
      payload: testPose(1),
      revision: 1,
    });

    const snapshot = harness.sim.snapshot();
    const restored = MatchSimulation.restore(snapshot);
    // The lock's own output was already drained by handleCommand, so the queues
    // are empty here; the shape must still round-trip.
    expect(snapshot.qp).toEqual([]);
    expect(restored.snapshot().qp).toEqual([]);
    expect(restored.snapshot().qv).toEqual(snapshot.qv);
  });

  it("validates an incoming snapshot as the untrusted peer input it is", () => {
    const harness = midRoundHarness(953);
    const snapshot = harness.sim.snapshot();

    // What the simulation produces must satisfy the schema that guards it.
    const parsed = MatchSnapshotSchema.safeParse(snapshot);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    // A parsed snapshot is usable as one, with no cast, so the two cannot drift.
    if (parsed.success) {
      const roundTripped: MatchSnapshot = parsed.data;
      expect(roundTripped.pl).toHaveLength(snapshot.pl.length);
    }

    const tampered = (change: (draft: Record<string, any>) => void): unknown => {
      const draft = JSON.parse(JSON.stringify(snapshot)) as Record<string, any>;
      change(draft);
      return draft;
    };

    // A peer could send anything; none of it may become authoritative state.
    expect(() => MatchSimulation.restore(tampered((d) => (d["pl"] = "all mine")) as MatchSnapshot))
      .toThrow(/not valid state/);
    expect(() =>
      MatchSimulation.restore(tampered((d) => (d["dg"][0].e = 42)) as MatchSnapshot),
    ).toThrow(/not valid state/);
    expect(() =>
      MatchSimulation.restore(tampered((d) => (d["pl"][0].r = "overlord")) as MatchSnapshot),
    ).toThrow(/not valid state/);
    expect(() =>
      MatchSimulation.restore(tampered((d) => (d["backdoor"] = true)) as MatchSnapshot),
    ).toThrow(/not valid state/);
    expect(() =>
      MatchSimulation.restore(tampered((d) => delete d["wp"]) as MatchSnapshot),
    ).toThrow(/not valid state/);
    expect(() =>
      MatchSimulation.restore(tampered((d) => (d["rc"] = -1)) as MatchSnapshot),
    ).toThrow(/not valid state/);
    // The complaint names where the trouble is.
    expect(() =>
      MatchSimulation.restore(tampered((d) => (d["dg"][0].e = 42)) as MatchSnapshot),
    ).toThrow(/dg\.0\.e/);
  });

  it("refuses a snapshot from another map or another format version", () => {
    const harness = new Harness({ players: 3, seed: 929 });
    const snapshot = harness.sim.snapshot();

    expect(() =>
      MatchSimulation.restore({ ...snapshot, map: "curiosity_shop" }),
    ).toThrow(/curiosity_shop/);
    expect(() =>
      MatchSimulation.restore(snapshot, {
        objectRegistry: { mapId: "elsewhere", objects: [] },
      }),
    ).toThrow(/elsewhere/);
    expect(() => MatchSimulation.restore({ ...snapshot, v: 99 } as MatchSnapshot)).toThrow(
      /version 99/,
    );
    expect(harness.sim.getObjectRegistry()).toBe(DEFAULT_OBJECT_REGISTRY);
  });

  it("rehydrates a pose-omitted snapshot from public state and stays identical", () => {
    const original = midRoundHarness(967).sim;
    const now = original.getPublicState().now;

    const omitted = original.snapshot({ poses: "omit" });
    expect(omitted.po).toBe(true);
    expect(omitted.dg.every((disguise) => disguise.e === "")).toBe(true);
    expect(omitted.pl.every((player) => player.vp === null)).toBe(true);

    // A disguise whose owner already left has to survive this route too: its
    // pose is public like any other, so it rehydrates like any other.
    const ghost = omitted.dg.find((disguise) => disguise.ow === null);
    expect(ghost).toBeDefined();

    // The new host holds the poses already, as any client does.
    const restored = MatchSimulation.restore(omitted, {
      poses: original.getPublicState().disguises,
    });

    // Rebuilt state is the state that was captured, poses included.
    expect(restored.snapshot()).toEqual(original.snapshot());
    const ghostPose = restored
      .getPublicState()
      .disguises.find((disguise) => disguise.publicObjectId === ghost?.o)?.encodedPose;
    expect(ghostPose).not.toBe("");
    expect(ghostPose).toBe(
      original.getPublicState().disguises.find((d) => d.publicObjectId === ghost?.o)?.encodedPose,
    );

    const script: Array<{ at: number; playerId?: string; command?: MatchCommand }> = [
      { at: 1_000 },
      { at: 2_500, playerId: inspectorOf(original), command: { type: "focus", targetObjectId: "prop-kettle" } },
      { at: 4_000, playerId: inspectorOf(original), command: { type: "focus", targetObjectId: null } },
      { at: 6_000 },
      {
        at: 8_000,
        playerId: inspectorOf(original),
        command: { type: "accuse", targetObjectId: survivingObjectOf(original) },
      },
      { at: 20_000 },
      // Past the inspection deadline, then far enough for the reveal to resolve
      // into results, so the comparison covers the end of the round too. Both
      // beats are derived from the hunt length rather than pinned, so tuning
      // the clock cannot quietly stop this test reaching the end of a round.
      { at: DEFAULT_MATCH_SETTINGS.inspectionMs + 20_000 },
      { at: DEFAULT_MATCH_SETTINGS.inspectionMs + 60_000 },
    ];

    const play = (sim: MatchSimulation): string[] => {
      const log: string[] = [];
      for (const step of script) {
        log.push(outputToJson(sim.tick(now + step.at)));
        if (step.command && step.playerId) {
          log.push(outputToJson(sim.handleCommand(step.playerId, step.command)));
        }
      }
      return log;
    };

    const fromOriginal = play(original);
    const fromRestored = play(restored);
    expect(fromRestored).toEqual(fromOriginal);
    // Not vacuous: both streams really carried events. Roles were dealt before
    // the snapshot, so the private traffic here is the ownership mapping.
    expect(fromOriginal.join("")).toContain('"type":"accusation_resolved"');
    expect(fromOriginal.join("")).toContain('"type":"disguise_owners"');
    expect(fromOriginal.join("")).toContain('"type":"match_ended"');
    expect(fromOriginal.join("").length).toBeGreaterThan(500);
  });

  it("fits a twelve player pose-omitted snapshot inside the transport budget", () => {
    const harness = new Harness({ players: 12, seed: 971 });
    harness.toInspection();

    const full = harness.sim.snapshot();
    const omitted = harness.sim.snapshot({ poses: "omit" });
    const omittedBytes = estimateSnapshotBytes(omitted);

    // Four 8 KB keys is the budget the lead set; 24 KB is the transport's
    // comfortable target. Reference poses are ~3.4 KB each, so the full
    // snapshot is far past both.
    expect(omittedBytes).toBeLessThan(4 * 8_192);
    expect(omittedBytes).toBeLessThan(24_000);
    expect(estimateSnapshotBytes(full)).toBeGreaterThan(4 * 8_192);
    expect(estimateSnapshotPoseBytes(omitted)).toBe(0);
  });

  it("refuses to omit poses that exist nowhere else, and to restore without them", () => {
    // Mid-Forge a working pose is private and unlocked, so there is nothing
    // public to rebuild it from.
    const forging = new Harness({ players: 4, seed: 977 });
    forging.toForge();
    const mimicId = forging.mimicIds()[0] as string;
    expect(forging.sim.recordForgeSnapshot(mimicId, testPose(3, 2), 2).accepted).toBe(true);
    expect(forging.sim.canOmitSnapshotPoses()).toBe(false);
    expect(() => forging.sim.snapshot({ poses: "omit" })).toThrow(/unlocked pose/);

    const harness = midRoundHarness(983);
    expect(harness.sim.canOmitSnapshotPoses()).toBe(true);
    const omitted = harness.sim.snapshot({ poses: "omit" });
    expect(() => MatchSimulation.restore(omitted)).toThrow(/could not be supplied/);
    expect(() => MatchSimulation.restore(omitted, { poses: [] })).toThrow(/could not be supplied/);
    expect(() =>
      MatchSimulation.restore(omitted, {
        poses: harness.sim
          .getPublicState()
          .disguises.map((entry) => ({ ...entry, encodedPose: "" })),
      }),
    ).toThrow(/could not be supplied/);
  });

  it("stops recording Forge snapshots once a Mimic has locked", () => {
    const harness = new Harness({ players: 4, seed: 991 });
    harness.toForge();
    const mimicId = harness.mimicIds()[0] as string;

    expect(harness.sim.recordForgeSnapshot(mimicId, testPose(1, 2), 2).accepted).toBe(true);
    harness.command(mimicId, { type: "lock_disguise", payload: testPose(2, 3), revision: 3 });
    expect(harness.sim.recordForgeSnapshot(mimicId, testPose(4, 9), 9).accepted).toBe(false);
  });

  it("reconciles a roster that shrank while the snapshot was in flight", () => {
    // The authoring host is always gone by the time anyone restores.
    const harness = midRoundHarness(997);
    const snapshot = harness.sim.snapshot();
    const departedHost = harness.hostId;
    const seated = harness.playerIds.filter(
      (playerId) => playerId !== departedHost && harness.roleOf(playerId) !== "absent",
    );

    const reconciled = MatchSimulation.restore(snapshot, { seatedPlayerIds: seated });
    expect(reconciled.getPrivateStateFor(departedHost)).toBeNull();
    expect(reconciled.getPublicState().players).toHaveLength(seated.length);
    // Someone still holds the room.
    expect(reconciled.getPublicState().players.some((player) => player.isHost)).toBe(true);

    // Reconciliation leaves its own player_left and host_changed events queued
    // for the new host to broadcast, which is the one thing the manual route
    // does differently: removePlayer hands them back instead. Flush both, then
    // the resulting state has to be the same.
    const manual = MatchSimulation.restore(snapshot);
    manual.removePlayer(departedHost, "left");
    const flushed = reconciled.tick(snapshot.t);
    expect(flushed.public.some((event) => event.type === "player_left")).toBe(true);
    manual.tick(snapshot.t);
    expect(manual.snapshot()).toEqual(reconciled.snapshot());
  });

  it("leaves the departed host's disguise catchable after reconciliation", () => {
    const harness = new Harness({ players: 5, seed: 1_009 });
    harness.toInspection();
    // Make the host a Mimic so their disguise is the one left behind.
    const hostIsMimic = harness.roleOf(harness.hostId) === "mimic";
    const departing = hostIsMimic ? harness.hostId : (harness.mimicIds()[0] as string);
    const objectId = harness.objectIdOf(departing);
    const departedPublicId = harness.sim.getPrivateStateFor(departing)?.publicPlayerId as string;
    const inspectorId = harness.inspectorIds()[0] as string;

    const seated = harness.playerIds.filter((playerId) => playerId !== departing);
    const sim = MatchSimulation.restore(harness.sim.snapshot(), { seatedPlayerIds: seated });

    expect(sim.getPublicState().mimicsRemaining).toBe(4);
    sim.tick(harness.now + 1_000);
    const result = sim.handleCommand(inspectorId, { type: "accuse", targetObjectId: objectId });
    expect(result.accepted).toBe(true);
    expect(result.public.find((event) => event.type === "accusation_resolved")).toMatchObject({
      correct: true,
      revealedPlayerPublicId: departedPublicId,
    });
  });

  it("ends the round when reconciliation leaves no Inspector", () => {
    const harness = new Harness({ players: 4, seed: 1_013 });
    harness.toInspection();
    const inspectorId = harness.inspectorIds()[0] as string;
    const seated = harness.playerIds.filter((playerId) => playerId !== inspectorId);

    const sim = MatchSimulation.restore(harness.sim.snapshot(), { seatedPlayerIds: seated });
    expect(sim.getPhase()).toBe(MatchPhase.Reveal);
  });

  it("reports its serialized size and what dominates it", () => {
    const harness = midRoundHarness(937);
    const snapshot = harness.sim.snapshot();

    const total = estimateSnapshotBytes(snapshot);
    const poses = estimateSnapshotPoseBytes(snapshot);
    expect(total).toBe(new TextEncoder().encode(JSON.stringify(snapshot)).length);
    expect(poses).toBeGreaterThan(0);
    expect(poses).toBeLessThan(total);
    // Locked poses are the term that scales with roster size.
    expect(poses / total).toBeGreaterThan(0.5);
  });
});
