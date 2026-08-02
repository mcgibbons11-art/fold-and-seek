import { describe, expect, it } from "vitest";
import { MatchPhase } from "@foldseek/shared";
import {
  CLOSE_PASS_COOLDOWN_MS,
  INNOCENT_REACTION_IDS,
  PERMISSIVE_SPATIAL_VALIDATOR,
  type SpatialValidator,
} from "../src";
import { Harness } from "./harness";

/** Registered but out of sight, so only the geometry seam can refuse it. */
const OUT_OF_SIGHT_PROP = "prop-vase";

/** Approves every target the map registers except the one behind a wall. */
function propValidator(): SpatialValidator {
  return {
    ...PERMISSIVE_SPATIAL_VALIDATOR,
    canAccuse: (_inspectorId, targetObjectId) =>
      targetObjectId === OUT_OF_SIGHT_PROP
        ? { ok: false, reason: "no_line_of_sight" }
        : { ok: true },
  };
}

describe("accusations", () => {
  it("rejects accusations outside the inspection phases", () => {
    const harness = new Harness({ players: 4, seed: 101 });
    harness.toForge();
    const inspector = harness.inspectorIds()[0] as string;

    expect(harness.command(inspector, { type: "accuse", targetObjectId: "prop-lamp" }).reason).toBe(
      "wrong_phase",
    );
  });

  it("rejects accusations from a mimic", () => {
    const harness = new Harness({ players: 4, seed: 103 });
    harness.toInspection();
    const mimic = harness.mimicIds()[0] as string;

    expect(harness.command(mimic, { type: "accuse", targetObjectId: "prop-lamp" }).reason).toBe(
      "wrong_role",
    );
  });

  it("rejects a second accusation on an already resolved target", () => {
    const harness = new Harness({ players: 4, seed: 107 });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    const objectId = harness.objectIdOf(harness.mimicIds()[0] as string);

    expect(harness.command(inspector, { type: "accuse", targetObjectId: objectId }).accepted).toBe(
      true,
    );
    harness.tick(1_000);
    expect(harness.command(inspector, { type: "accuse", targetObjectId: objectId }).reason).toBe(
      "target_already_resolved",
    );
  });

  it("applies the wrong-accusation cooldown", () => {
    const harness = new Harness({ players: 4, seed: 109, spatial: propValidator() });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;

    expect(
      harness.command(inspector, { type: "accuse", targetObjectId: "prop-lamp" }).accepted,
    ).toBe(true);
    expect(harness.command(inspector, { type: "accuse", targetObjectId: "prop-clock" }).reason).toBe(
      "accusation_cooldown",
    );

    harness.tick(harness.sim.getSettings().wrongAccusationCooldownMs + 1);
    expect(
      harness.command(inspector, { type: "accuse", targetObjectId: "prop-clock" }).accepted,
    ).toBe(true);
  });

  it("forwards the reason from the injected spatial validator", () => {
    const harness = new Harness({ players: 4, seed: 113, spatial: propValidator() });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;

    const result = harness.command(inspector, {
      type: "accuse",
      targetObjectId: OUT_OF_SIGHT_PROP,
    });
    expect(result.reason).toBe("spatial_rejected");
    expect(result.detail).toBe("no_line_of_sight");
  });

  it("consumes a warrant only on a wrong accusation and stops at zero", () => {
    const harness = new Harness({ players: 3, seed: 127, settings: { warrantsBonus: 2 } });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    const cooldown = harness.sim.getSettings().wrongAccusationCooldownMs + 1;

    expect(harness.sim.getPublicState().warrantsRemaining).toBe(4);
    for (const target of ["prop-lamp", "prop-clock", "prop-kettle", "prop-chair"]) {
      expect(harness.command(inspector, { type: "accuse", targetObjectId: target }).accepted).toBe(
        true,
      );
      harness.tick(cooldown);
    }

    expect(harness.sim.getPublicState().warrantsRemaining).toBe(0);
    expect(harness.command(inspector, { type: "accuse", targetObjectId: "prop-vase" }).reason).toBe(
      "no_warrants",
    );
    expect(harness.phase()).toBe(MatchPhase.Inspection);
  });

  it("emits a deterministic innocent reaction for a wrong accusation", () => {
    const first = new Harness({ players: 4, seed: 131, spatial: propValidator() });
    const second = new Harness({ players: 4, seed: 131, spatial: propValidator() });
    for (const harness of [first, second]) {
      harness.toInspection();
      harness.command(harness.inspectorIds()[0] as string, {
        type: "accuse",
        targetObjectId: "prop-kettle",
      });
    }

    const reactionA = first.eventsOfType("innocent_reaction")[0];
    const reactionB = second.eventsOfType("innocent_reaction")[0];
    expect(reactionA).toBeDefined();
    expect(INNOCENT_REACTION_IDS).toContain(reactionA?.reactionId);
    expect(reactionA?.reactionId).toBe(reactionB?.reactionId);
    expect(reactionA?.seed).toBe(reactionB?.seed);
  });

  it("reveals the caught player and ends the round when the last mimic is found", () => {
    const harness = new Harness({ players: 3, seed: 137 });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    const [firstMimic, secondMimic] = harness.mimicIds();

    harness.tick(4_000);
    harness.command(inspector, { type: "accuse", targetObjectId: harness.objectIdOf(firstMimic as string) });
    expect(harness.phase()).toBe(MatchPhase.Inspection);

    harness.tick(2_000);
    harness.command(inspector, {
      type: "accuse",
      targetObjectId: harness.objectIdOf(secondMimic as string),
    });

    const caught = harness.eventsOfType("mimic_caught");
    expect(caught).toHaveLength(2);
    expect(caught[0]?.survivalSeconds).toBe(4);
    expect(caught[1]?.survivalSeconds).toBe(6);
    expect(caught[1]?.mimicsRemaining).toBe(0);

    const resolved = harness.eventsOfType("accusation_resolved");
    expect(resolved.every((event) => event.correct)).toBe(true);
    expect(resolved[0]?.revealedPlayerPublicId).toBeDefined();
    expect(harness.phase()).toBe(MatchPhase.Reveal);
  });

  it("rejects an accusation against a mimic that was already caught", () => {
    const harness = new Harness({ players: 4, seed: 139 });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    const objectId = harness.objectIdOf(harness.mimicIds()[0] as string);

    harness.command(inspector, { type: "accuse", targetObjectId: objectId });
    harness.tick(2_000);
    const repeat = harness.command(inspector, { type: "accuse", targetObjectId: objectId });
    expect(repeat.accepted).toBe(false);
    expect(harness.sim.getPublicState().mimicsRemaining).toBe(2);
  });

  it("records unique focused objects and awards a direct-look escape", () => {
    const harness = new Harness({ players: 4, seed: 149 });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    const objectId = harness.objectIdOf(harness.mimicIds()[0] as string);
    const settings = harness.sim.getSettings();

    harness.command(inspector, { type: "focus", targetObjectId: objectId });
    harness.tick(settings.directLookMinMs + 100);
    harness.command(inspector, { type: "focus", targetObjectId: null });
    harness.tick(settings.directLookBreakMs + 100);

    expect(harness.eventsOfType("direct_look_escape")).toHaveLength(1);

    harness.command(inspector, { type: "focus", targetObjectId: "prop-lamp" });
    harness.command(inspector, { type: "focus", targetObjectId: "prop-lamp" });
    harness.tickUntil(MatchPhase.Results);

    const results = harness.eventsOfType("match_ended")[0]?.results;
    const inspectorResult = results?.players.find((entry) => entry.role === "inspector");
    expect(inspectorResult?.uniqueObjectsFocused).toBe(2);
  });

  it("counts close passes fed by the geometry owner, rate limited per pair", () => {
    const harness = new Harness({ players: 4, seed: 151 });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    const objectId = harness.objectIdOf(harness.mimicIds()[0] as string);

    harness.record(harness.sim.recordClosePass(inspector, objectId, harness.now));
    harness.tick(500);
    harness.record(harness.sim.recordClosePass(inspector, objectId, harness.now));
    harness.tick(CLOSE_PASS_COOLDOWN_MS);
    harness.record(harness.sim.recordClosePass(inspector, objectId, harness.now));

    expect(harness.eventsOfType("close_pass")).toHaveLength(2);
  });
});
