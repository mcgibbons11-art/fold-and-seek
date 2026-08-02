// @vitest-environment jsdom
import type { MatchSettingsPatch } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLocalRound, type LocalRound } from "../../src/gameplay/localRound";
import { RoundSession } from "../../src/gameplay/RoundSession";
import { qualitySettingsFor } from "../../src/rendering/quality";
import { CuriosityShop, type CuriosityShopMap } from "../../src/world/maps/CuriosityShop";
import { containsXZ } from "../../src/inspector/navData";
import { SECURITY_OFFICE_BOUNDS } from "../../src/world/maps/zones";
import { OFFICE_DOOR_NAME } from "../../src/world/maps/props";
import { installCanvas2DStub, type CanvasStub } from "../world/canvas2d";

/**
 * What the Inspector is allowed to know before the hunt opens, which live play
 * found was everything: the between-phases camera turned over the sales floor
 * for every role, so the one player who must not know where anybody is watched
 * the Mimics choose their hiding places for the whole of the Forge.
 *
 * The fix has two halves and both are asserted here. The Inspector waits inside
 * the Security Office behind a shut door, which is where §5.9 has always said
 * they were; and the disguises they would have been looking at are not in the
 * state their client holds at all, so a client that ignored the camera would
 * still have nothing to draw.
 */

const FAST_SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 6_000,
  lockGraceMs: 200,
  inspectionIntroMs: 400,
  inspectionMs: 20_000,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
};

const FRAME_MS = 20;
/** Deals the local player the gun, as `roundAccusation` does. */
const INSPECTOR_SEED = 10;
const BOT_COUNT = 3;
const VIEWPORT = { width: 800, height: 600 };

/**
 * The shop, built once for the file. It is several seconds of geometry and
 * procedural maps, and building it per test put every one of them over the
 * default timeout the moment the suite ran in parallel with the rest.
 */
let sharedMap: CuriosityShopMap | null = null;

function shopMap(): CuriosityShopMap {
  sharedMap ??= new CuriosityShop().build(qualitySettingsFor("high", "webgl2"));
  return sharedMap;
}

/** Room for the shop build and a full round of ticks under a loaded machine. */
const TEST_TIMEOUT_MS = 30_000;

interface Fixture {
  readonly round: LocalRound;
  readonly session: RoundSession;
  readonly scene: THREE.Scene;
  phase(): MatchPhase | undefined;
  /** Swing of the office door leaf, in radians. Zero is shut. */
  doorAngle(): number;
  advance(frames: number): void;
  runTo(phase: MatchPhase, maxFrames?: number): void;
  dispose(): void;
}

async function inspectorFixture(): Promise<Fixture> {
  let clock = 0;
  const round = createLocalRound({
    seed: INSPECTOR_SEED,
    bots: BOT_COUNT,
    settings: FAST_SETTINGS,
    now: () => clock,
  });

  const scene = new THREE.Scene();
  // The real shop, because the door under test is a prop of it.
  scene.add(shopMap().root);

  // A real element, because the Inspector's input reaches through it to the
  // document it belongs to when the hunt hands the player the rig.
  const canvas = document.createElement("canvas");
  canvas.width = VIEWPORT.width;
  canvas.height = VIEWPORT.height;
  Object.assign(canvas, { requestPointerLock: () => undefined });
  document.body.append(canvas);

  const session = new RoundSession({
    scene,
    canvas,
    adapter: round.adapter,
    director: round.director,
    spatial: round.spatial,
    quality: qualitySettingsFor("high"),
  });
  session.setViewport(VIEWPORT.width, VIEWPORT.height);

  const advance = (frames: number): void => {
    for (let index = 0; index < frames; index += 1) {
      clock += FRAME_MS;
      round.adapter.step();
      session.update(FRAME_MS, clock);
    }
  };

  const phase = (): MatchPhase | undefined => round.adapter.getSync().publicState?.phase;

  const runTo = (wanted: MatchPhase, maxFrames = 2_000): void => {
    for (let index = 0; index < maxFrames; index += 1) {
      if (phase() === wanted) return;
      if (phase() === MatchPhase.Lobby || phase() === MatchPhase.Loading) {
        round.adapter.sendCommand({ type: "player_ready", ready: true });
      }
      advance(1);
    }
    throw new Error(`phase ${wanted} not reached, stuck in ${String(phase())}`);
  };

  await round.adapter.join("practice", "Curator");
  round.adapter.sendCommand({ type: "player_ready", ready: true });
  advance(1);
  round.adapter.sendCommand({ type: "start_match" });
  runTo(MatchPhase.Forge);
  // The seed has to have dealt this client the gun, or nothing below is a test.
  expect(round.adapter.getSync().privateState?.role).toBe("inspector");

  return {
    round,
    session,
    scene,
    phase,
    doorAngle() {
      const door = scene.getObjectByName(OFFICE_DOOR_NAME);
      if (door === undefined) throw new Error("the shop has no office door");
      const leaf = door.children[0];
      if (leaf === undefined) throw new Error("the office door has no leaf");
      return leaf.rotation.y;
    },
    advance,
    runTo,
    dispose() {
      session.dispose();
      round.dispose();
      scene.remove(shopMap().root);
      canvas.remove();
    },
  };
}

let canvas2d: CanvasStub | null = null;

beforeEach(() => {
  canvas2d = installCanvas2DStub();
  // jsdom ships the media elements without playback: `play` returns undefined
  // where the platform returns a promise, and the audio player chains a catch
  // onto it. The round makes noise on every phase it enters, so this is the
  // difference between exercising it and crashing in the first transition.
  const media = HTMLMediaElement.prototype as unknown as Record<string, () => unknown>;
  media["play"] = () => Promise.resolve();
  media["pause"] = () => undefined;
  media["load"] = () => undefined;
});

afterAll(() => {
  sharedMap?.dispose();
  sharedMap = null;
});

afterEach(() => {
  canvas2d?.restore();
  canvas2d = null;
  vi.useRealTimers();
});

describe("the Inspector waiting out the fold", () => {
  it("watches the Security Office rather than the shop, behind a shut door", async () => {
    const fixture = await inspectorFixture();
    try {
      // A full turn of the between-phases camera, so this is the whole orbit
      // rather than the one angle it happened to start at.
      for (let sweep = 0; sweep < 12; sweep += 1) {
        fixture.advance(20);
        expect(fixture.phase()).toBe(MatchPhase.Forge);
        const eye = fixture.session.camera.position;
        expect(
          containsXZ(SECURITY_OFFICE_BOUNDS, eye.x, eye.z),
          `camera left the office at ${eye.x.toFixed(2)},${eye.z.toFixed(2)}`,
        ).toBe(true);
        expect(fixture.doorAngle()).toBe(0);
      }
    } finally {
      fixture.dispose();
    }
  }, TEST_TIMEOUT_MS);

  it("is told about no disguise until the fold closes", async () => {
    const fixture = await inspectorFixture();
    try {
      // Every bot locks on the Forge's first tick, so by now the authority holds
      // three disguises. None of them may be in what this client can read.
      fixture.advance(30);
      expect(fixture.round.adapter.getSync().publicState?.disguises ?? []).toHaveLength(0);

      fixture.runTo(MatchPhase.Inspection);
      expect(fixture.round.adapter.getSync().publicState?.disguises.length).toBe(BOT_COUNT);
    } finally {
      fixture.dispose();
    }
  }, TEST_TIMEOUT_MS);

  it("opens the door on the hunt and lets the Inspector out of the office", async () => {
    const fixture = await inspectorFixture();
    try {
      expect(fixture.doorAngle()).toBe(0);

      fixture.runTo(MatchPhase.Inspection);
      // The swing runs over about a second, so give it one before reading.
      fixture.advance(80);
      expect(fixture.doorAngle()).toBeGreaterThan(1);
    } finally {
      fixture.dispose();
    }
  }, TEST_TIMEOUT_MS);
});
