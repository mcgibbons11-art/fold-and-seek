import type { MatchSettingsPatch } from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, MatchPhase } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ForgeController } from "../../src/forge/ForgeController";
import { createBotDisguisePayload, humanMimicSpawn } from "../../src/gameplay/botDisguises";
import { RoundSpatialBridge } from "../../src/gameplay/roundSpatial";
import type { MutableVec3 } from "../../src/inspector/navData";
import { applyDisguiseStateToPose, createStarterArrangement } from "../../src/mimic/disguiseState";
import { createPoseState } from "../../src/mimic/ikSolver";
import { decodeDisguiseState, encodeDisguiseState } from "../../src/mimic/poseWire";
import { boneIndex } from "../../src/mimic/rig";
import type { CommandRejection } from "../../src/networking/NetworkAdapter";
import { LocalLoopbackAdapter } from "../../src/networking/LocalLoopbackAdapter";
import { qualitySettingsFor } from "../../src/rendering/quality";
import { NAV_DATA } from "../../src/world/maps/nav";
import { buildObjectRegistry } from "../../src/world/maps/registry";
import { SHOP_FORGE_WORKSPACE } from "../../src/world/ShopWorld";

/**
 * The pointer's half of the hunt's speed cap.
 *
 * A Mimic keeps its Forge through the hunt (CLAUDE.md override 2), so there are
 * two ways to move a disguise: the walk keys, which `CharacterController` caps
 * by clamping its velocity every frame, and a drag of the pelvis handle, which
 * had no cap at all. The authority measures a straight line between published
 * poses against `hiderCreepSpeed` either way, so a quick drag was refused as
 * `moved_too_fast` and the body the player was holding snapped back to the one
 * the room had — the rubber-band the walk keys were fixed for.
 *
 * This drives the real `ForgeController` through its real pointer handlers,
 * against a real `LocalLoopbackAdapter` round, at the interval `RoundSession`
 * publishes on.
 */

const VIEWPORT = { width: 800, height: 600 };

/** One frame of the client's loop, and the publish interval as frames. */
const FRAME_MS = 20;
const FRAMES_PER_PUBLISH = 25;
/** Two seconds of hauling the handle across the viewport. */
const DRAG_FRAMES = 100;
const BOT_COUNT = 3;
/** The seat this seed deals a Mimic, which is the only role with a body. */
const MIMIC_SEED = 1;

const FAST_SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 20_000,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
};

class ForgeHarness {
  readonly controller: ForgeController;
  readonly scene = new THREE.Scene();
  readonly origin: THREE.Vector3;

  private readonly listeners = new Map<string, ((event: never) => void)[]>();
  private readonly previousWindow: unknown;
  private readonly canvas: unknown;

  constructor(origin: THREE.Vector3) {
    const add = (type: string, listener: (event: never) => void): void => {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    };
    const canvas = {
      style: { cursor: "default" },
      getBoundingClientRect: () => ({ left: 0, top: 0, ...VIEWPORT }),
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
      hasPointerCapture: () => false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    this.canvas = canvas;

    this.previousWindow = (globalThis as Record<string, unknown>)["window"];
    (globalThis as Record<string, unknown>)["window"] = {
      addEventListener: add,
      removeEventListener: () => undefined,
    };

    this.origin = origin;
    this.controller = new ForgeController({
      scene: this.scene,
      canvas: canvas as unknown as HTMLCanvasElement,
      quality: qualitySettingsFor("medium"),
      origin,
      workspace: SHOP_FORGE_WORKSPACE,
      navData: NAV_DATA,
    });
    this.controller.setViewport(VIEWPORT.width, VIEWPORT.height);
  }

  pointer(type: string, fields: Record<string, unknown> = {}): void {
    const event = {
      pointerId: 1,
      button: 0,
      shiftKey: false,
      clientX: VIEWPORT.width / 2,
      clientY: VIEWPORT.height / 2,
      target: this.canvas,
      stopPropagation: () => undefined,
      preventDefault: () => undefined,
      ...fields,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      (listener as (event: unknown) => void)(event);
    }
  }

  frame(dtMs: number): void {
    this.controller.update(dtMs);
    this.controller.camera.updateMatrixWorld(true);
    this.scene.updateMatrixWorld(true);
  }

  /** Viewport coordinates of the pelvis handle on the opening arrangement. */
  pelvisPoint(): { clientX: number; clientY: number } {
    const state = createStarterArrangement("upright");
    state.root.position = [this.origin.x, this.origin.y, this.origin.z];
    const pose = createPoseState();
    applyDisguiseStateToPose(state, pose);
    const world = pose.worldPositions[boneIndex("pelvis")];
    if (world === undefined) throw new Error("the rig has no pelvis");
    const ndc = new THREE.Vector3(world.x, world.y, world.z).project(this.controller.camera);
    return {
      clientX: ((ndc.x + 1) / 2) * VIEWPORT.width,
      clientY: ((1 - ndc.y) / 2) * VIEWPORT.height,
    };
  }

  dispose(): void {
    this.controller.dispose();
    (globalThis as Record<string, unknown>)["window"] = this.previousWindow;
  }
}

interface Fixture {
  readonly adapter: LocalLoopbackAdapter;
  readonly rejections: CommandRejection[];
  advance(frames: number): void;
  runTo(phase: MatchPhase, maxSteps?: number): void;
}

function createFixture(): Fixture {
  let clock = 0;
  const spatial = new RoundSpatialBridge();
  const rejections: CommandRejection[] = [];
  const adapter = new LocalLoopbackAdapter({
    settings: FAST_SETTINGS,
    seed: MIMIC_SEED,
    now: () => clock,
    spatial: spatial.validator,
    objectRegistry: buildObjectRegistry(),
    botPose: (index) => createBotDisguisePayload(index),
  });
  adapter.onRejection((rejection) => rejections.push(rejection));

  const fixture: Fixture = {
    adapter,
    rejections,
    advance(frames: number) {
      for (let index = 0; index < frames; index += 1) {
        clock += FRAME_MS;
        adapter.step();
      }
    },
    runTo(phase: MatchPhase, maxSteps = 200) {
      for (let index = 0; index < maxSteps; index += 1) {
        const current = adapter.getSync().publicState?.phase;
        if (current === phase) return;
        if (current === MatchPhase.Lobby || current === MatchPhase.Loading) {
          adapter.sendCommand({ type: "player_ready", ready: true });
        }
        fixture.advance(1);
      }
      throw new Error(
        `phase ${phase} not reached; stopped at ${String(adapter.getSync().publicState?.phase)}`,
      );
    },
  };
  return fixture;
}

/** Where the room currently has this player's disguise standing. */
function publishedRoot(adapter: LocalLoopbackAdapter): MutableVec3 {
  const own = adapter.getSync().privateState?.ownDisguise?.publicObjectId ?? null;
  const disguise = (adapter.getSync().publicState?.disguises ?? []).find(
    (entry) => entry.publicObjectId === own,
  );
  if (disguise === undefined) throw new Error("this client has no disguise in the room");
  const decoded = decodeDisguiseState(disguise.encodedPose);
  if (decoded === null) throw new Error("the room is holding a pose it cannot decode");
  const [x = 0, y = 0, z = 0] = decoded.root.position;
  return { x, y, z };
}

/**
 * Opens a round with the local player disguised at the map's own Mimic spawn,
 * standing in the Inspection phase with a live Forge over it.
 */
async function openHunt(): Promise<{ fixture: Fixture; harness: ForgeHarness }> {
  const fixture = createFixture();
  for (let index = 0; index < BOT_COUNT; index += 1) fixture.adapter.addBot({ autoPlay: true });
  await fixture.adapter.join("practice", "Curator");

  fixture.adapter.sendCommand({ type: "player_ready", ready: true });
  fixture.advance(1);
  fixture.adapter.sendCommand({ type: "start_match" });
  fixture.runTo(MatchPhase.Forge);
  expect(fixture.adapter.getSync().privateState?.role).toBe("mimic");

  const spawn = humanMimicSpawn().position;
  const harness = new ForgeHarness(new THREE.Vector3(spawn.x, spawn.y, spawn.z));
  harness.frame(FRAME_MS);

  const disguise = harness.controller.disguise;
  fixture.adapter.sendCommand({
    type: "lock_disguise",
    payload: encodeDisguiseState(disguise),
    revision: disguise.revision,
  });
  fixture.runTo(MatchPhase.Inspection);
  expect(fixture.rejections).toEqual([]);

  return { fixture, harness };
}

/**
 * Two seconds of dragging the pelvis handle from one side of the viewport to
 * the other, publishing whatever the Forge holds on the round's own interval.
 * Returns how far the body actually went.
 */
function dragAcrossViewport(fixture: Fixture, harness: ForgeHarness): number {
  const start = { ...harness.controller.disguise.root.position };
  const grip = harness.pelvisPoint();
  harness.pointer("pointerdown", grip);

  let revision = harness.controller.disguise.revision;
  for (let frame = 1; frame <= DRAG_FRAMES; frame += 1) {
    fixture.advance(1);
    harness.frame(FRAME_MS);
    // Straight across the frame in a fifth of a second, which is far faster
    // than the body may travel and is an ordinary flick of the wrist.
    harness.pointer("pointermove", {
      clientX: grip.clientX + ((frame * 40) % VIEWPORT.width),
      clientY: grip.clientY,
    });
    if (frame % FRAMES_PER_PUBLISH !== 0) continue;
    const disguise = harness.controller.disguise;
    if (disguise.revision <= revision) continue;
    revision = disguise.revision;
    fixture.adapter.sendForgeSnapshot({
      encodedPose: encodeDisguiseState(disguise),
      revision: disguise.revision,
    });
  }
  harness.pointer("pointerup", { clientX: grip.clientX, clientY: grip.clientY });

  const end = harness.controller.disguise.root.position;
  return Math.hypot(
    (end[0] ?? 0) - (start[0] ?? 0),
    (end[1] ?? 0) - (start[1] ?? 0),
    (end[2] ?? 0) - (start[2] ?? 0),
  );
}

beforeEach(() => {
  const globals = globalThis as Record<string, unknown>;
  globals["HTMLInputElement"] ??= class {};
  globals["HTMLTextAreaElement"] ??= class {};
  globals["Element"] ??= class {};
  globals["Audio"] ??= class {
    volume = 1;
    preload = "";
    currentTime = 0;
    playbackRate = 1;
    play(): Promise<void> {
      return Promise.resolve();
    }
    pause(): void {}
    removeAttribute(): void {}
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dragging a disguise's root through the hunt", () => {
  it("is never refused for moving too fast, however hard the pointer is thrown", async () => {
    vi.useFakeTimers();
    const { fixture, harness } = await openHunt();
    harness.controller.setCreepLimit(DEFAULT_MATCH_SETTINGS.hiderCreepSpeed);

    const travelled = dragAcrossViewport(fixture, harness);

    expect(fixture.rejections).toEqual([]);

    // The drag was held to the cap rather than ignored: the pointer asked for
    // the width of the room and the body covered no more than two seconds of
    // creeping, while still covering a real fraction of it.
    const budget = (DEFAULT_MATCH_SETTINGS.hiderCreepSpeed * DRAG_FRAMES * FRAME_MS) / 1_000;
    expect(travelled).toBeGreaterThan(budget / 2);
    expect(travelled).toBeLessThanOrEqual(budget);

    // And the two copies of the body agree, which is what a rubber-band is the
    // absence of.
    const room = publishedRoot(fixture.adapter);
    const local = harness.controller.disguise.root.position;
    expect(room.x).toBeCloseTo(local[0] ?? 0, 3);
    expect(room.y).toBeCloseTo(local[1] ?? 0, 3);
    expect(room.z).toBeCloseTo(local[2] ?? 0, 3);

    harness.dispose();
    fixture.adapter.dispose();
  });

  it("is refused the moment the same drag runs without the cap", async () => {
    // The other half of the claim: the authority really is checking this drag,
    // so the cap above is what keeps the round clean rather than a dead rule.
    vi.useFakeTimers();
    const { fixture, harness } = await openHunt();
    // No creep limit, which is the Forge phase's freedom applied during a hunt.
    harness.controller.setCreepLimit(null);

    dragAcrossViewport(fixture, harness);

    expect(fixture.rejections.map((rejection) => rejection.reason)).toContain("moved_too_fast");

    harness.dispose();
    fixture.adapter.dispose();
  });
});
