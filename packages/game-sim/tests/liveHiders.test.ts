import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_SETTINGS,
  MatchPhase,
  PrivateSimEventSchema,
  SimEventSchema,
  createReferenceDisguiseWire,
  encodeDisguiseWire,
} from "@foldseek/shared";
import {
  MatchSimulation,
  SCORE_MIMIC_MAX_LINE_OF_SIGHT_POINTS,
  SCORE_MIMIC_MAX_OBSERVED_TAUNTS,
  SCORE_MIMIC_PER_OBSERVED_TAUNT,
  TAUNT_COOLDOWN_MS,
  scoreMimic,
  type SpatialValidator,
} from "../src";
import { Harness } from "./harness";

/**
 * Hiders stay active through the hunt (MECCHA CHAMELEON behaviour, per the user
 * design override in CLAUDE.md): a manifested disguise can still be reshaped and
 * can creep, slowly, under server validation.
 */

/**
 * Metres a creeping hider earns by waiting, at whatever creep speed ships. The
 * distances below are quoted through this rather than written out, so retuning
 * the setting cannot quietly turn "a teleport" into "a legal creep".
 */
function creepBudget(waitedMs: number): number {
  return (DEFAULT_MATCH_SETTINGS.hiderCreepSpeed * waitedMs) / 1_000;
}

/** A pose at a chosen root position, so a test can drive movement precisely. */
function poseAt(x: number, revision: number, y = 0, z = 0): string {
  const pose = createReferenceDisguiseWire(revision);
  pose.root.position = [x, y, z];
  return encodeDisguiseWire(pose);
}

/** Reaches Inspection with every Mimic locked at a known root position. */
function huntHarness(seed: number, players = 4): Harness {
  const harness = new Harness({ players, seed });
  harness.toForge();
  for (const [index, mimicId] of harness.mimicIds().entries()) {
    harness.command(mimicId, { type: "lock_disguise", payload: poseAt(index, 1), revision: 1 });
  }
  harness.tickUntil(MatchPhase.Inspection);
  return harness;
}

describe("post-lock adjustments", () => {
  it("accepts a reshape and a slow creep during the hunt", () => {
    const harness = huntHarness(1_301);
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    // Reshaping without moving is always fine.
    const reshaped = harness.record(
      harness.sim.recordForgeSnapshot(mimicId, poseAt(0, 2), 2, harness.now),
    );
    expect(reshaped.accepted).toBe(true);
    const updates = harness.eventsOfType("disguise_updated");
    expect(updates.at(-1)).toMatchObject({ publicObjectId: objectId, revision: 2, moved: false });

    // Two seconds of waiting buys more than this on its own, so the creep is
    // legal with margin however the speed is tuned.
    const step = creepBudget(2_000) / 2;
    harness.tick(2_000);
    const crept = harness.record(
      harness.sim.recordForgeSnapshot(mimicId, poseAt(step, 3), 3, harness.now),
    );
    expect(crept.accepted).toBe(true);
    expect(harness.eventsOfType("disguise_updated").at(-1)).toMatchObject({
      revision: 3,
      moved: true,
    });

    // The room sees the new geometry.
    const view = harness.sim
      .getPublicState()
      .disguises.find((entry) => entry.publicObjectId === objectId);
    expect(view?.encodedPose).toBe(poseAt(step, 3));
    expect(harness.sim.getPrivateStateFor(mimicId)?.ownDisguise?.encodedPose).toBe(poseAt(step, 3));
  });

  it("refuses a creep faster than hiderCreepSpeed", () => {
    const harness = huntHarness(1_303);
    const mimicId = harness.mimicIds()[0] as string;

    // A distance that takes forty seconds of creeping to earn, attempted one
    // second in. The disguise has been standing still since it locked, so its
    // budget is the few seconds of lock grace and intro, nowhere near enough.
    const WAIT_MS = 40_000;
    const bolt = creepBudget(WAIT_MS);
    harness.tick(1_000);
    const bolted = harness.sim.recordForgeSnapshot(mimicId, poseAt(bolt, 2), 2, harness.now);
    expect(bolted.accepted).toBe(false);
    expect(bolted.reason).toBe("moved_too_fast");
    expect(bolted.detail).toContain("m/s");

    // The disguise did not move, and the room was told nothing.
    const objectId = harness.objectIdOf(mimicId);
    expect(
      harness.sim.getPublicState().disguises.find((e) => e.publicObjectId === objectId)
        ?.encodedPose,
    ).toBe(poseAt(0, 1));
    expect(harness.eventsOfType("disguise_updated")).toHaveLength(0);

    // The same distance is legal once enough time has passed.
    harness.tick(WAIT_MS);
    expect(
      harness.sim.recordForgeSnapshot(mimicId, poseAt(bolt, 3), 3, harness.now).accepted,
    ).toBe(true);
  });

  it("refuses a creep the geometry owner rejects", () => {
    const walled: SpatialValidator = {
      canAccuse: () => ({ ok: true }),
      canObserve: () => ({ ok: true }),
      canOccupy: (_playerId, position) =>
        position[0] > 0.2 ? { ok: false, reason: "inside_wall" } : { ok: true },
    };
    const harness = new Harness({ players: 4, seed: 1_307, spatial: walled });
    harness.toForge();
    for (const [index, mimicId] of harness.mimicIds().entries()) {
      harness.command(mimicId, { type: "lock_disguise", payload: poseAt(index * 0.1, 1), revision: 1 });
    }
    harness.tickUntil(MatchPhase.Inspection);

    const mimicId = harness.mimicIds()[0] as string;
    harness.tick(5_000);
    const blocked = harness.sim.recordForgeSnapshot(mimicId, poseAt(1, 2), 2, harness.now);
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toBe("outside_play_volume");
    expect(blocked.detail).toBe("inside_wall");
  });

  it("caps forge updates at the configured command rate", () => {
    const harness = huntHarness(1_309);
    const mimicId = harness.mimicIds()[0] as string;

    expect(harness.sim.recordForgeSnapshot(mimicId, poseAt(0, 2), 2, harness.now).accepted).toBe(
      true,
    );
    // maxForgeCommandHz is 15, so a second update inside ~67 ms is too soon.
    harness.tick(10);
    const flooded = harness.sim.recordForgeSnapshot(mimicId, poseAt(0, 3), 3, harness.now);
    expect(flooded.accepted).toBe(false);
    expect(flooded.reason).toBe("rate_limited");

    harness.tick(100);
    expect(harness.sim.recordForgeSnapshot(mimicId, poseAt(0, 4), 4, harness.now).accepted).toBe(
      true,
    );
  });

  it("refuses adjustments once the round has moved past the hunt", () => {
    const harness = huntHarness(1_311);
    const mimicId = harness.mimicIds()[0] as string;
    harness.tickUntil(MatchPhase.Reveal);

    const late = harness.sim.recordForgeSnapshot(mimicId, poseAt(0, 9), 9, harness.now);
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe("wrong_phase");
  });

  it("refuses adjustments during Locking, when the pose is settling", () => {
    const harness = new Harness({ players: 3, seed: 1_313 });
    harness.toForge();
    const [first, second] = harness.mimicIds();
    // Locking one Mimic leaves the phase waiting on the other.
    harness.command(first as string, { type: "lock_disguise", payload: poseAt(0, 1), revision: 1 });
    harness.tickUntil(MatchPhase.Locking, 250);

    const during = harness.sim.recordForgeSnapshot(first as string, poseAt(0, 2), 2, harness.now);
    expect(during.accepted).toBe(false);
    expect(during.reason).toBe("wrong_phase");
    expect(second).toBeDefined();
  });

  it("keeps refusing a stale or repeated revision", () => {
    const harness = huntHarness(1_317);
    const mimicId = harness.mimicIds()[0] as string;

    harness.tick(1_000);
    expect(harness.sim.recordForgeSnapshot(mimicId, poseAt(0, 5), 5, harness.now).accepted).toBe(
      true,
    );
    harness.tick(1_000);
    expect(harness.sim.recordForgeSnapshot(mimicId, poseAt(0, 5), 5, harness.now).reason).toBe(
      "stale_revision",
    );
    expect(harness.sim.recordForgeSnapshot(mimicId, poseAt(0, 4), 4, harness.now).reason).toBe(
      "stale_revision",
    );
  });

  it("does not move a disguise whose owner has left", () => {
    const harness = new Harness({ players: 5, seed: 1_319, settings: { reconnectGraceMs: 4_000 } });
    harness.toForge();
    for (const [index, mimicId] of harness.mimicIds().entries()) {
      harness.command(mimicId, { type: "lock_disguise", payload: poseAt(index, 1), revision: 1 });
    }
    harness.tickUntil(MatchPhase.Inspection);

    const departing = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(departing);
    const posed = harness.sim.getPrivateStateFor(departing)?.ownDisguise?.encodedPose as string;

    harness.record(harness.sim.markDisconnected(departing, harness.now));
    harness.tick(5_000);
    expect(harness.sim.getPrivateStateFor(departing)).toBeNull();

    // A ghost has nobody to drive it, so its pose is frozen where it was left.
    const ghostMove = harness.sim.recordForgeSnapshot(departing, poseAt(50, 9), 9, harness.now);
    expect(ghostMove.accepted).toBe(false);
    expect(ghostMove.reason).toBe("unknown_player");
    expect(
      harness.sim.getPublicState().disguises.find((e) => e.publicObjectId === objectId)
        ?.encodedPose,
    ).toBe(posed);
  });
});

describe("taunts", () => {
  it("performs a taunt as the object, never as the player", () => {
    const harness = huntHarness(1_321);
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    const result = harness.command(mimicId, { type: "taunt", tauntId: "rattle" });
    expect(result.accepted).toBe(true);

    const performed = harness.eventsOfType("taunt_performed");
    expect(performed).toHaveLength(1);
    expect(performed[0]).toMatchObject({ publicObjectId: objectId, tauntId: "rattle" });
    expect(JSON.stringify(performed[0])).not.toContain(mimicId);
    expect(performed[0]?.seed).toBeLessThan(2 ** 24);
  });

  it("rate limits taunts per player", () => {
    const harness = huntHarness(1_327);
    const mimicId = harness.mimicIds()[0] as string;

    expect(harness.command(mimicId, { type: "taunt", tauntId: "shudder" }).accepted).toBe(true);
    harness.tick(TAUNT_COOLDOWN_MS - 500);
    expect(harness.command(mimicId, { type: "taunt", tauntId: "shudder" }).reason).toBe(
      "taunt_cooldown",
    );

    harness.tick(600);
    expect(harness.command(mimicId, { type: "taunt", tauntId: "shudder" }).accepted).toBe(true);
    expect(harness.eventsOfType("taunt_performed")).toHaveLength(2);
  });

  it("refuses a taunt from an Inspector, outside the hunt, and after being caught", () => {
    const harness = huntHarness(1_331);
    const inspector = harness.inspectorIds()[0] as string;
    expect(harness.command(inspector, { type: "taunt", tauntId: "puff" }).reason).toBe("wrong_role");

    const caught = harness.mimicIds()[0] as string;
    harness.command(inspector, { type: "accuse", targetObjectId: harness.objectIdOf(caught) });
    expect(harness.command(caught, { type: "taunt", tauntId: "puff" }).accepted).toBe(false);

    const forging = new Harness({ players: 4, seed: 1_337 });
    forging.toForge();
    expect(
      forging.command(forging.mimicIds()[0] as string, { type: "taunt", tauntId: "puff" }).reason,
    ).toBe("wrong_phase");
  });

  it("pays only for taunts an Inspector was watching, up to the cap", () => {
    const harness = huntHarness(1_339);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    // Unwatched taunts are free to perform and worth nothing.
    for (let i = 0; i < 3; i += 1) {
      expect(harness.command(mimicId, { type: "taunt", tauntId: "rattle" }).accepted).toBe(true);
      harness.tick(TAUNT_COOLDOWN_MS + 100);
    }

    harness.command(inspector, { type: "focus", targetObjectId: objectId });
    for (let i = 0; i < 7; i += 1) {
      expect(harness.command(mimicId, { type: "taunt", tauntId: "rattle" }).accepted).toBe(true);
      harness.tick(TAUNT_COOLDOWN_MS + 100);
    }
    harness.tickUntil(MatchPhase.Results);

    const results = harness.eventsOfType("match_ended")[0]?.results;
    const publicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId as string;
    const entry = results?.players.find((player) => player.publicPlayerId === publicId);
    expect(entry?.observedTaunts).toBe(SCORE_MIMIC_MAX_OBSERVED_TAUNTS + 2);
    // Ten taunts were performed; only the watched ones count and only five pay.
    expect(harness.eventsOfType("taunt_performed")).toHaveLength(10);
    expect(
      scoreMimic({
        survivalSeconds: 0,
        directLookEscapes: 0,
        closePasses: 0,
        fullRoundSurvival: false,
        peerStyleVotes: 0,
        observedTaunts: entry?.observedTaunts ?? 0,
      }),
    ).toBe(SCORE_MIMIC_MAX_OBSERVED_TAUNTS * SCORE_MIMIC_PER_OBSERVED_TAUNT);
  });

  it("pays nothing for a taunt the Inspector cannot actually see", () => {
    const blind: SpatialValidator = {
      canAccuse: () => ({ ok: true }),
      canObserve: () => ({ ok: false, reason: "occluded" }),
      canOccupy: () => ({ ok: true }),
    };
    const harness = new Harness({ players: 4, seed: 1_343, spatial: blind });
    harness.toForge();
    for (const [index, mimicId] of harness.mimicIds().entries()) {
      harness.command(mimicId, { type: "lock_disguise", payload: poseAt(index, 1), revision: 1 });
    }
    harness.tickUntil(MatchPhase.Inspection);

    const mimicId = harness.mimicIds()[0] as string;
    expect(harness.command(mimicId, { type: "taunt", tauntId: "rattle" }).accepted).toBe(true);
    harness.tickUntil(MatchPhase.Results);

    const publicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId as string;
    const entry = harness.eventsOfType("match_ended")[0]?.results.players.find(
      (player) => player.publicPlayerId === publicId,
    );
    expect(entry?.observedTaunts).toBe(0);
  });
});

describe("line of sight scoring", () => {
  it("banks watched seconds and caps the points", () => {
    const harness = huntHarness(1_349);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;

    harness.command(inspector, { type: "focus", targetObjectId: harness.objectIdOf(mimicId) });
    harness.tick(20_000);
    harness.command(inspector, { type: "focus", targetObjectId: null });
    harness.tickUntil(MatchPhase.Results);

    const publicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId as string;
    const entry = harness.eventsOfType("match_ended")[0]?.results.players.find(
      (player) => player.publicPlayerId === publicId,
    );
    expect(entry?.lineOfSightSeconds).toBe(20);

    // 20 s at 2/s is 40 points, and the term stops at its ceiling.
    const base = { directLookEscapes: 0, closePasses: 0, fullRoundSurvival: false, peerStyleVotes: 0 };
    expect(scoreMimic({ ...base, survivalSeconds: 0, lineOfSightSeconds: 20 })).toBe(40);
    expect(scoreMimic({ ...base, survivalSeconds: 0, lineOfSightSeconds: 10_000 })).toBe(
      SCORE_MIMIC_MAX_LINE_OF_SIGHT_POINTS,
    );
  });

  it("stops paying once the hider is caught", () => {
    const harness = huntHarness(1_353);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    harness.command(inspector, { type: "focus", targetObjectId: objectId });
    harness.tick(6_000);
    harness.command(inspector, { type: "accuse", targetObjectId: objectId });
    // Staring at the wreckage afterwards earns the hider nothing more.
    harness.tick(30_000);
    harness.command(inspector, { type: "focus", targetObjectId: null });
    harness.tickUntil(MatchPhase.Results);

    const publicId = harness.sim.getPrivateStateFor(mimicId)?.publicPlayerId as string;
    const entry = harness.eventsOfType("match_ended")[0]?.results.players.find(
      (player) => player.publicPlayerId === publicId,
    );
    expect(entry?.lineOfSightSeconds).toBe(6);
  });
});

describe("live hiders under migration and replay", () => {
  it("carries creep, taunt and line-of-sight state through a snapshot", () => {
    const harness = huntHarness(1_361, 5);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;

    harness.command(inspector, { type: "focus", targetObjectId: harness.objectIdOf(mimicId) });
    harness.tick(3_000);
    harness.command(mimicId, { type: "taunt", tauntId: "tick_tock" });
    harness.record(harness.sim.recordForgeSnapshot(mimicId, poseAt(0.4, 2), 2, harness.now));
    harness.tick(2_000);
    harness.command(inspector, { type: "focus", targetObjectId: null });

    const snapshot = harness.sim.snapshot();
    const restored = MatchSimulation.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);

    const moved = snapshot.dg.find((entry) => entry.rp[0] === 0.4);
    expect(moved).toBeDefined();
    expect(snapshot.pl.some((player) => player.tt !== null)).toBe(true);
    expect(snapshot.pl.some((player) => player.st.los > 0)).toBe(true);
    expect(snapshot.pl.some((player) => player.st.ot === 1)).toBe(true);

    // The cooldown survives, so a migration is not a way to taunt twice.
    expect(restored.handleCommand(mimicId, { type: "taunt", tauntId: "puff" }).reason).toBe(
      "taunt_cooldown",
    );
  });

  it("keeps both event streams schema-valid with the new traffic", () => {
    const harness = huntHarness(1_367, 5);
    const inspector = harness.inspectorIds()[0] as string;
    const mimicId = harness.mimicIds()[0] as string;

    harness.command(inspector, { type: "focus", targetObjectId: harness.objectIdOf(mimicId) });
    harness.command(mimicId, { type: "taunt", tauntId: "settle_creak" });
    harness.tick(1_000);
    harness.record(harness.sim.recordForgeSnapshot(mimicId, poseAt(0.3, 2), 2, harness.now));
    harness.tickUntil(MatchPhase.Results);

    expect(harness.eventsOfType("taunt_performed")).toHaveLength(1);
    expect(harness.eventsOfType("disguise_updated")).toHaveLength(1);
    for (const event of harness.log) {
      const parsed = SimEventSchema.safeParse(event);
      expect(parsed.success, `${event.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
    for (const event of harness.allPrivateEvents()) {
      expect(PrivateSimEventSchema.safeParse(event).success, event.type).toBe(true);
    }
  });

  it("stays deterministic with creeping and taunting in the stream", () => {
    const play = (seed: number): string => {
      const harness = huntHarness(seed, 5);
      const inspector = harness.inspectorIds()[0] as string;
      const mimicId = harness.mimicIds()[0] as string;
      harness.command(inspector, { type: "focus", targetObjectId: harness.objectIdOf(mimicId) });
      for (let step = 0; step < 4; step += 1) {
        harness.tick(TAUNT_COOLDOWN_MS + 200);
        harness.command(mimicId, { type: "taunt", tauntId: "rattle" });
        harness.record(
          harness.sim.recordForgeSnapshot(mimicId, poseAt(step * 0.2, step + 2), step + 2, harness.now),
        );
      }
      harness.tickUntil(MatchPhase.Results);
      return JSON.stringify({
        public: harness.log,
        private: [...harness.privateLog.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      });
    };

    expect(play(1_373)).toBe(play(1_373));
    expect(play(1_381)).not.toBe(play(1_373));
  });
});
