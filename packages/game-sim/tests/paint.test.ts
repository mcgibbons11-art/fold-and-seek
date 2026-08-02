import { describe, expect, it } from "vitest";
import {
  MAX_PAINT_STROKES,
  MatchPhase,
  PAINT_WIRE_MAX_BASE64_LENGTH,
  SimEventSchema,
  encodePaintLayer,
  type PaintStrokeWire,
} from "@foldseek/shared";
import { MatchSimulation } from "../src";
import { Harness, testPose } from "./harness";

/**
 * Body paint (CLAUDE.md override 3) travels beside the pose, never inside it.
 * It is public appearance, so it is exposed publicly and rebuilt from public
 * state on a migration, exactly as the pose is.
 */

function stroke(index: number): PaintStrokeWire {
  return {
    target: index % 19,
    u: (index % 10) / 10,
    v: ((index * 3) % 10) / 10,
    radius: 0.25,
    color: [0.8, 0.2, 0.4],
    opacity: 1,
    emissive: index % 4 === 0 ? 1 : 0,
    metallic: 0,
    smoothness: 0.5,
    erase: false,
    continued: index % 4 !== 0,
  };
}

/** A valid layer of the requested size. */
function paint(strokeCount: number): string {
  return encodePaintLayer(Array.from({ length: strokeCount }, (_, index) => stroke(index)));
}

/** Reaches the hunt with every Mimic locked. */
function huntHarness(seed: number, players = 4): Harness {
  const harness = new Harness({ players, seed });
  harness.toInspection();
  return harness;
}

describe("paint during the forge", () => {
  it("captures the painted layer when the disguise manifests", () => {
    const harness = new Harness({ players: 4, seed: 3_001 });
    harness.toForge();
    const mimicId = harness.mimicIds()[0] as string;

    const layer = paint(24);
    expect(harness.sim.recordPaintUpdate(mimicId, layer, 1, harness.now).accepted).toBe(true);
    harness.command(mimicId, { type: "lock_disguise", payload: testPose(1), revision: 1 });

    const own = harness.sim.getPrivateStateFor(mimicId)?.ownDisguise;
    expect(own?.encodedPaint).toBe(layer);
    // The lock records the disguise; the Forge closing is what hands it to the
    // room, so nothing about it is public while the fold is still running.
    expect(harness.sim.getPublicState().disguises).toHaveLength(0);

    harness.tickUntil(MatchPhase.Inspection);
    const view = harness.sim
      .getPublicState()
      .disguises.find((entry) => entry.publicObjectId === own?.publicObjectId);
    expect(view?.encodedPaint).toBe(layer);
    // The pose is untouched by painting.
    expect(view?.encodedPose).toBe(testPose(1));
  });

  it("leaves an unpainted disguise with no layer at all", () => {
    const harness = huntHarness(3_011);
    const view = harness.sim.getPublicState().disguises[0];
    expect(view?.encodedPaint).toBeNull();
  });
});

describe("paint during the hunt", () => {
  it("accepts a repaint and round-trips it through public state", () => {
    const harness = huntHarness(3_019);
    const mimicId = harness.mimicIds()[0] as string;
    const objectId = harness.objectIdOf(mimicId);

    const layer = paint(64);
    const result = harness.record(harness.sim.recordPaintUpdate(mimicId, layer, 4, harness.now));
    expect(result.accepted).toBe(true);

    const updated = harness.eventsOfType("disguise_updated").at(-1);
    expect(updated).toMatchObject({ publicObjectId: objectId, painted: true, moved: false });
    expect(
      harness.sim.getPublicState().disguises.find((e) => e.publicObjectId === objectId)
        ?.encodedPaint,
    ).toBe(layer);
  });

  it("keeps paint and pose revisions independent", () => {
    const harness = huntHarness(3_023);
    const mimicId = harness.mimicIds()[0] as string;

    // The pose is already at revision 1 from the lock; paint starts its own count.
    expect(harness.sim.recordPaintUpdate(mimicId, paint(8), 1, harness.now).accepted).toBe(true);
    harness.tick(200);
    expect(harness.sim.recordForgeSnapshot(mimicId, testPose(2, 2), 2, harness.now).accepted).toBe(
      true,
    );
    harness.tick(200);
    // A paint revision below the last paint revision is stale, even though the
    // pose has since moved past it.
    expect(harness.sim.recordPaintUpdate(mimicId, paint(9), 1, harness.now).reason).toBe(
      "stale_revision",
    );
    expect(harness.sim.recordPaintUpdate(mimicId, paint(9), 2, harness.now).accepted).toBe(true);
  });

  it("refuses an invalid or oversized layer", () => {
    const harness = huntHarness(3_029);
    const mimicId = harness.mimicIds()[0] as string;

    const garbage = harness.sim.recordPaintUpdate(mimicId, "not base64 at all!", 2, harness.now);
    expect(garbage.accepted).toBe(false);
    expect(garbage.reason).toBe("invalid_paint");

    harness.tick(200);
    const oversized = harness.sim.recordPaintUpdate(
      mimicId,
      "A".repeat(PAINT_WIRE_MAX_BASE64_LENGTH + 4),
      3,
      harness.now,
    );
    expect(oversized.reason).toBe("invalid_paint");
    expect(oversized.detail).toBe("paint_payload_too_large");

    // A full legal layer is still accepted, so the ceiling is not off by one.
    harness.tick(200);
    expect(
      harness.sim.recordPaintUpdate(mimicId, paint(MAX_PAINT_STROKES), 4, harness.now).accepted,
    ).toBe(true);
  });

  it("shares one command budget with pose updates", () => {
    const harness = huntHarness(3_031);
    const mimicId = harness.mimicIds()[0] as string;

    expect(harness.sim.recordPaintUpdate(mimicId, paint(4), 2, harness.now).accepted).toBe(true);
    // Alternating paint and pose must not buy twice the rate.
    harness.tick(10);
    expect(harness.sim.recordForgeSnapshot(mimicId, testPose(1, 3), 3, harness.now).reason).toBe(
      "rate_limited",
    );
    harness.tick(10);
    expect(harness.sim.recordPaintUpdate(mimicId, paint(5), 3, harness.now).reason).toBe(
      "rate_limited",
    );

    harness.tick(200);
    expect(harness.sim.recordPaintUpdate(mimicId, paint(6), 3, harness.now).accepted).toBe(true);
  });

  it("refuses paint from a caught hider, a ghost, and outside the editable phases", () => {
    const harness = new Harness({ players: 5, seed: 3_037, settings: { reconnectGraceMs: 4_000 } });
    harness.toInspection();
    const inspector = harness.inspectorIds()[0] as string;
    const caughtId = harness.mimicIds()[0] as string;
    const departingId = harness.mimicIds()[1] as string;
    const ghostObjectId = harness.objectIdOf(departingId);

    harness.command(inspector, { type: "accuse", targetObjectId: harness.objectIdOf(caughtId) });
    expect(harness.sim.recordPaintUpdate(caughtId, paint(4), 5, harness.now).accepted).toBe(false);

    // A disguise whose owner left has nobody to repaint it.
    harness.record(harness.sim.markDisconnected(departingId, harness.now));
    harness.tick(5_000);
    const ghost = harness.sim.recordPaintUpdate(departingId, paint(4), 5, harness.now);
    expect(ghost.reason).toBe("unknown_player");
    expect(
      harness.sim.getPublicState().disguises.find((e) => e.publicObjectId === ghostObjectId)
        ?.encodedPaint,
    ).toBeNull();

    const survivor = harness.mimicIds().find((id) => id !== caughtId) as string;
    harness.tickUntil(MatchPhase.Reveal);
    expect(harness.sim.recordPaintUpdate(survivor, paint(4), 9, harness.now).reason).toBe(
      "wrong_phase",
    );
  });
});

describe("paint under migration and replay", () => {
  it("carries paint through a full snapshot", () => {
    const harness = huntHarness(3_041, 5);
    const mimicId = harness.mimicIds()[0] as string;
    const layer = paint(40);
    harness.record(harness.sim.recordPaintUpdate(mimicId, layer, 3, harness.now));

    const snapshot = harness.sim.snapshot();
    expect(snapshot.dg.some((entry) => entry.pt === layer && entry.pv === 3)).toBe(true);

    const restored = MatchSimulation.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.getPrivateStateFor(mimicId)?.ownDisguise?.encodedPaint).toBe(layer);
  });

  it("rebuilds paint from public state in a pose-omitted snapshot", () => {
    const harness = huntHarness(3_043, 5);
    const mimicId = harness.mimicIds()[0] as string;
    const layer = paint(32);
    harness.record(harness.sim.recordPaintUpdate(mimicId, layer, 2, harness.now));

    const omitted = harness.sim.snapshot({ poses: "omit" });
    expect(omitted.dg.every((entry) => entry.pt === null)).toBe(true);

    const restored = MatchSimulation.restore(omitted, {
      poses: harness.sim.getPublicState().disguises,
    });
    expect(restored.snapshot()).toEqual(harness.sim.snapshot());
    expect(restored.getPrivateStateFor(mimicId)?.ownDisguise?.encodedPaint).toBe(layer);
  });

  it("refuses to rebuild when a painted layer cannot be supplied", () => {
    const harness = huntHarness(3_047, 5);
    const mimicId = harness.mimicIds()[0] as string;
    harness.record(harness.sim.recordPaintUpdate(mimicId, paint(16), 2, harness.now));

    const omitted = harness.sim.snapshot({ poses: "omit" });
    const posesOnly = harness.sim
      .getPublicState()
      .disguises.map((entry) => ({ publicObjectId: entry.publicObjectId, encodedPose: entry.encodedPose }));
    expect(() => MatchSimulation.restore(omitted, { poses: posesOnly })).toThrow(
      /omitted paint but 1 could not be supplied/,
    );
  });

  it("stays deterministic and schema-valid with paint in the stream", () => {
    const play = (seed: number): string => {
      const harness = huntHarness(seed, 5);
      const mimicId = harness.mimicIds()[0] as string;
      for (let step = 0; step < 4; step += 1) {
        harness.tick(200);
        harness.record(
          harness.sim.recordPaintUpdate(mimicId, paint(8 + step), step + 2, harness.now),
        );
      }
      harness.tickUntil(MatchPhase.Results);
      for (const event of harness.log) {
        expect(SimEventSchema.safeParse(event).success, event.type).toBe(true);
      }
      expect(harness.eventsOfType("disguise_updated")).toHaveLength(4);
      return JSON.stringify(harness.log);
    };

    expect(play(3_053)).toBe(play(3_053));
    expect(play(3_059)).not.toBe(play(3_053));
  });
});
