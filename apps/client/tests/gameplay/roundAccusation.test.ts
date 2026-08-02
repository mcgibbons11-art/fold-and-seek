import type { MatchSettingsPatch, SimEvent } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotDisguisePayload } from "../../src/gameplay/botDisguises";
import { DisguiseTheatre } from "../../src/gameplay/disguiseTheatre";
import { RoundSpatialBridge } from "../../src/gameplay/roundSpatial";
import { LocalLoopbackAdapter, LOCAL_SELF_ID } from "../../src/networking/LocalLoopbackAdapter";
import { qualitySettingsFor } from "../../src/rendering/quality";
import { buildObjectRegistry, mapObject } from "../../src/world/maps/registry";
import { SHOP_MAX_Z } from "../../src/world/maps/zones";

/**
 * The Inspector's gun is the accusation, and the authority only allows one when
 * the geometry agrees: the shot has to come from an eye the authority knows
 * about, within range, with the target in sight. That whole chain runs through
 * the round's spatial bridge and the disguise theatre, so this drives it end to
 * end against a real locked bot disguise rather than a fixture.
 */

const FAST_SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 10_000,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
};

const STEP_MS = 100;
const BOT_COUNT = 3;
/** Hands the Inspector role to the local player in a four-seat room. */
const INSPECTOR_SEED = 10;

interface Fixture {
  readonly adapter: LocalLoopbackAdapter;
  readonly bridge: RoundSpatialBridge;
  readonly theatre: DisguiseTheatre;
  readonly events: SimEvent[];
  advance(steps: number): void;
  dispose(): void;
}

async function huntingFixture(): Promise<Fixture> {
  let clock = 0;
  const bridge = new RoundSpatialBridge();
  const adapter = new LocalLoopbackAdapter({
    settings: FAST_SETTINGS,
    seed: INSPECTOR_SEED,
    now: () => clock,
    spatial: bridge.validator,
    objectRegistry: buildObjectRegistry(),
    botPose: (index) => createBotDisguisePayload(index),
  });
  const theatre = new DisguiseTheatre(new THREE.Scene(), qualitySettingsFor("high"));
  bridge.setDisguiseBounds((objectId) => theatre.boundsOf(objectId));

  const events: SimEvent[] = [];
  adapter.onEvent((event) => events.push(event));

  const advance = (steps: number): void => {
    for (let index = 0; index < steps; index += 1) {
      clock += STEP_MS;
      adapter.step();
      theatre.sync(adapter.getSync().publicState?.disguises ?? [], null);
    }
  };

  for (let index = 0; index < BOT_COUNT; index += 1) adapter.addBot({ autoPlay: true });
  await adapter.join("practice", "Curator");
  adapter.sendCommand({ type: "player_ready", ready: true });
  advance(1);
  adapter.sendCommand({ type: "start_match" });

  for (let index = 0; index < 120; index += 1) {
    const phase = adapter.getSync().publicState?.phase;
    if (phase === MatchPhase.Inspection) break;
    if (phase === MatchPhase.Lobby || phase === MatchPhase.Loading) {
      adapter.sendCommand({ type: "player_ready", ready: true });
    }
    advance(1);
  }
  expect(adapter.getSync().publicState?.phase).toBe(MatchPhase.Inspection);

  return {
    adapter,
    bridge,
    theatre,
    events,
    advance,
    dispose() {
      theatre.dispose();
      adapter.dispose();
    },
  };
}

/** A point just outside a disguise, level with it, to shoot from. */
function eyeBeside(bounds: THREE.Box3, metres: number): { x: number; y: number; z: number } {
  const centre = bounds.getCenter(new THREE.Vector3());
  return { x: centre.x + metres, y: centre.y, z: centre.z };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("shooting a disguise", () => {
  it("catches the Mimic when the Inspector is standing over it", async () => {
    vi.useFakeTimers();
    const fixture = await huntingFixture();
    const target = fixture.adapter.getSync().publicState?.disguises[0];
    expect(target).toBeDefined();
    const objectId = target?.publicObjectId ?? "";

    const bounds = fixture.theatre.boundsOf(objectId);
    expect(bounds).not.toBeNull();
    fixture.bridge.setInspectorEye(LOCAL_SELF_ID, eyeBeside(bounds as THREE.Box3, 0.4));

    fixture.adapter.sendCommand({ type: "accuse", targetObjectId: objectId });

    const resolved = fixture.events.filter((event) => event.type === "accusation_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ correct: true, targetObjectId: objectId });
    expect(fixture.events.some((event) => event.type === "mimic_caught")).toBe(true);
    expect(fixture.adapter.getSync().publicState?.mimicsRemaining).toBe(BOT_COUNT - 1);

    fixture.dispose();
  });

  it("refuses a shot from across the shop, and never spends a warrant on it", async () => {
    vi.useFakeTimers();
    const fixture = await huntingFixture();
    const objectId = fixture.adapter.getSync().publicState?.disguises[0]?.publicObjectId ?? "";
    const warrantsBefore = fixture.adapter.getSync().publicState?.warrantsRemaining ?? 0;

    const rejections: string[] = [];
    fixture.adapter.onRejection((rejection) => rejections.push(rejection.reason));

    const bounds = fixture.theatre.boundsOf(objectId) as THREE.Box3;
    fixture.bridge.setInspectorEye(LOCAL_SELF_ID, eyeBeside(bounds, 40));
    fixture.adapter.sendCommand({ type: "accuse", targetObjectId: objectId });

    expect(rejections).toContain("spatial_rejected");
    expect(fixture.events.some((event) => event.type === "accusation_resolved")).toBe(false);
    expect(fixture.adapter.getSync().publicState?.warrantsRemaining).toBe(warrantsBefore);

    fixture.dispose();
  });

  it("refuses a shot through the shop wall, and says so", async () => {
    vi.useFakeTimers();
    const fixture = await huntingFixture();
    const disguises = fixture.adapter.getSync().publicState?.disguises ?? [];

    // Somewhere close enough that only the wall can be what stops the shot: an
    // out-of-range refusal would prove nothing about line of sight.
    const behindWall = disguises
      .map((disguise) => {
        const bounds = fixture.theatre.boundsOf(disguise.publicObjectId) as THREE.Box3;
        const centre = bounds.getCenter(new THREE.Vector3());
        return { objectId: disguise.publicObjectId, centre, gap: SHOP_MAX_Z + 0.6 - centre.z };
      })
      .find((entry) => entry.gap > 0 && entry.gap < 5);
    expect(behindWall, "no disguise stands near enough to the south wall").toBeDefined();

    const rejections: { reason: string; detail?: string }[] = [];
    fixture.adapter.onRejection((rejection) => rejections.push(rejection));

    const eye = behindWall as NonNullable<typeof behindWall>;
    fixture.bridge.setInspectorEye(LOCAL_SELF_ID, {
      x: eye.centre.x,
      y: eye.centre.y,
      z: SHOP_MAX_Z + 0.6,
    });
    fixture.adapter.sendCommand({ type: "accuse", targetObjectId: eye.objectId });

    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("spatial_rejected");
    // Named explicitly: a range refusal here would mean the test proved nothing.
    expect(rejections[0]?.detail).toBe("no_line_of_sight");
    expect(fixture.events.some((event) => event.type === "accusation_resolved")).toBe(false);

    fixture.dispose();
  });

  it("refuses every shot until the round has been told where the Inspector is", async () => {
    vi.useFakeTimers();
    const fixture = await huntingFixture();
    const objectId = fixture.adapter.getSync().publicState?.disguises[0]?.publicObjectId ?? "";

    const rejections: string[] = [];
    fixture.adapter.onRejection((rejection) => rejections.push(rejection.reason));
    fixture.adapter.sendCommand({ type: "accuse", targetObjectId: objectId });

    expect(rejections).toContain("spatial_rejected");
    fixture.dispose();
  });

  it("lets the Inspector spend a warrant on one of the shop's own props", async () => {
    vi.useFakeTimers();
    const fixture = await huntingFixture();
    const registry = buildObjectRegistry();
    const propId = registry.objects[0]?.objectId ?? "";
    const prop = mapObject(propId);
    expect(prop).not.toBeNull();

    const warrantsBefore = fixture.adapter.getSync().publicState?.warrantsRemaining ?? 0;
    fixture.bridge.setInspectorEye(
      LOCAL_SELF_ID,
      eyeBeside(prop?.focusBounds as THREE.Box3, 0.4),
    );
    fixture.adapter.sendCommand({ type: "accuse", targetObjectId: propId });

    const resolved = fixture.events.filter((event) => event.type === "accusation_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ correct: false, targetObjectId: propId });
    // A wrong accusation costs a warrant and the room reacts (§5.10).
    expect(fixture.adapter.getSync().publicState?.warrantsRemaining).toBe(warrantsBefore - 1);
    expect(fixture.events.some((event) => event.type === "innocent_reaction")).toBe(true);

    fixture.dispose();
  });
});
