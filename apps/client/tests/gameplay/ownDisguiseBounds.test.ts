import type { MatchSettingsPatch, PublicDisguiseView } from "@foldseek/game-sim";
import { MatchPhase, PLAYER_HEIGHT_M } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DisguiseTheatre } from "../../src/gameplay/disguiseTheatre";
import { createLocalRound, type LocalRound } from "../../src/gameplay/localRound";
import { RoundSession } from "../../src/gameplay/RoundSession";
import { qualitySettingsFor } from "../../src/rendering/quality";

/**
 * A hider has to be shootable while they are still wearing their Forge, which
 * under CLAUDE.md override 2 is the whole hunt.
 *
 * The theatre does not draw the viewer's own disguise while their Forge holds
 * it, and it deletes any actor it is told to omit. Every bounds lookup therefore
 * used to return null for the local player's own body, and `SpatialValidatorImpl`
 * refuses an accusation with no bounds as `target_bounds_unknown` — so the owner
 * was the one player in the room who could not be hit. Under Portals the
 * authority runs on an elected client, so a host who drew Mimic was immune for
 * as long as they held it. That is a fairness hole, not a rendering detail.
 *
 * What is asserted here is the whole chain: the round's spatial bridge answers
 * for the local player's own disguise, and the box it answers with is the one
 * any other client computes from the same published pose — including while the
 * body is leaning into a run, because the body language must no more reach the
 * bounds than it reaches the wire.
 */

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

const FRAME_MS = 20;
/** Deals the local player a Mimic in a four-seat room, as `hiderCreep` does. */
const MIMIC_SEED = 1;
const BOT_COUNT = 3;
const VIEWPORT = { width: 800, height: 600 };

/**
 * Two boxes agree when their corners sit within this of each other. It is a
 * thousandth of body height, a third of a millimetre on a 0.35 m creature, and
 * the slack is for the merged geometry a drawn actor is measured with rather
 * than for any difference in the pose.
 */
const BOUNDS_TOLERANCE_M = PLAYER_HEIGHT_M * 1e-3;

function expectSameBox(actual: THREE.Box3, expected: THREE.Box3): void {
  for (const axis of ["x", "y", "z"] as const) {
    expect(Math.abs(actual.min[axis] - expected.min[axis])).toBeLessThan(BOUNDS_TOLERANCE_M);
    expect(Math.abs(actual.max[axis] - expected.max[axis])).toBeLessThan(BOUNDS_TOLERANCE_M);
  }
}

interface Fixture {
  readonly round: LocalRound;
  readonly session: RoundSession;
  readonly scene: THREE.Scene;
  /** The local player's own disguise, as the room publishes it. */
  ownObjectId(): string;
  published(): readonly PublicDisguiseView[];
  advance(frames: number): void;
  press(key: string): void;
  release(key: string): void;
  dispose(): void;
}

/** What a client that is not the owner draws, and therefore shoots at. */
function remoteBoundsOf(
  scene: THREE.Scene,
  disguises: readonly PublicDisguiseView[],
  objectId: string,
): THREE.Box3 | null {
  const theatre = new DisguiseTheatre(scene, qualitySettingsFor("high"));
  try {
    theatre.sync(disguises, null);
    const bounds = theatre.boundsOf(objectId);
    return bounds === null ? null : (bounds as THREE.Box3).clone();
  } finally {
    theatre.dispose();
  }
}

async function hidingFixture(): Promise<Fixture> {
  let clock = 0;
  const round = createLocalRound({
    seed: MIMIC_SEED,
    bots: BOT_COUNT,
    settings: FAST_SETTINGS,
    now: () => clock,
  });

  const keyListeners: ((event: never) => void)[] = [];
  const upListeners: ((event: never) => void)[] = [];
  (globalThis as Record<string, unknown>)["window"] = {
    addEventListener: (type: string, listener: (event: never) => void) => {
      if (type === "keydown") keyListeners.push(listener);
      if (type === "keyup") upListeners.push(listener);
    },
    removeEventListener: () => undefined,
  };

  const scene = new THREE.Scene();
  const canvas = {
    style: { cursor: "default" },
    getBoundingClientRect: () => ({ left: 0, top: 0, ...VIEWPORT }),
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    hasPointerCapture: () => false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const session = new RoundSession({
    scene,
    canvas: canvas as unknown as HTMLCanvasElement,
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

  const fire = (listeners: readonly ((event: never) => void)[], key: string): void => {
    const event = {
      key,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      target: null,
      preventDefault: () => undefined,
    };
    for (const listener of [...listeners]) (listener as (event: unknown) => void)(event);
  };

  await round.adapter.join("practice", "Curator");
  round.adapter.sendCommand({ type: "player_ready", ready: true });
  advance(1);
  round.adapter.sendCommand({ type: "start_match" });

  for (let index = 0; index < 400; index += 1) {
    const phase = round.adapter.getSync().publicState?.phase;
    if (phase === MatchPhase.Inspection) break;
    if (phase === MatchPhase.Lobby || phase === MatchPhase.Loading) {
      round.adapter.sendCommand({ type: "player_ready", ready: true });
    }
    advance(1);
  }
  expect(round.adapter.getSync().publicState?.phase).toBe(MatchPhase.Inspection);
  // The seed has to have dealt this client a body, or nothing below is a test.
  expect(round.adapter.getSync().privateState?.role).toBe("mimic");

  return {
    round,
    session,
    scene,
    ownObjectId() {
      const id = round.adapter.getSync().privateState?.ownDisguise?.publicObjectId ?? null;
      if (id === null) throw new Error("this client has no disguise");
      return id;
    },
    published() {
      return round.adapter.getSync().publicState?.disguises ?? [];
    },
    advance,
    press: (key) => fire(keyListeners, key),
    release: (key) => fire(upListeners, key),
    dispose() {
      session.dispose();
      round.dispose();
    },
  };
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
    loop = false;
    src = "";
    duration = 0;
    paused = true;
    play(): Promise<void> {
      return Promise.resolve();
    }
    pause(): void {}
    load(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    removeAttribute(): void {}
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a hider holding their own Forge through the hunt", () => {
  it("can be shot at: the round knows where their body is", async () => {
    const fixture = await hidingFixture();
    try {
      const objectId = fixture.ownObjectId();

      // The premise. The room publishes this body to everybody, and every other
      // client draws it, so it is only the owner's own view that lacks it.
      expect(fixture.published().some((entry) => entry.publicObjectId === objectId)).toBe(true);
      const remote = remoteBoundsOf(new THREE.Scene(), fixture.published(), objectId);
      expect(remote).not.toBeNull();

      // The bug, reproduced directly: a theatre told to leave this body out has
      // no bounds for it, which is the only source the bridge used to have.
      const omitting = new DisguiseTheatre(new THREE.Scene(), qualitySettingsFor("high"));
      omitting.sync(fixture.published(), objectId);
      expect(omitting.boundsOf(objectId)).toBeNull();
      omitting.dispose();

      // The fix: the bridge answers anyway, out of the Forge that is holding the
      // body, and answers with the box every other client is shooting at.
      const own = fixture.round.spatial.boundsOf(objectId);
      expect(own).not.toBeNull();
      expectSameBox(own as THREE.Box3, remote as THREE.Box3);

      // And the consequence that matters, through the validator the authority
      // actually asks: an Inspector standing over this body is allowed the shot
      // rather than being told the target has no bounds.
      const centre = (own as THREE.Box3).getCenter(new THREE.Vector3());
      fixture.round.spatial.acceptInspectorEye("hunter", {
        x: centre.x + PLAYER_HEIGHT_M,
        y: centre.y,
        z: centre.z,
      });
      expect(fixture.round.spatial.canAccuse("hunter", objectId)).toEqual({ ok: true });
    } finally {
      fixture.dispose();
    }
  });

  it("carries the box with the body when the hider creeps", async () => {
    const fixture = await hidingFixture();
    try {
      const objectId = fixture.ownObjectId();
      const still = (fixture.round.spatial.boundsOf(objectId) as THREE.Box3).clone();

      fixture.press("w");
      fixture.advance(60);
      fixture.release("w");
      fixture.advance(30);

      const crept = fixture.round.spatial.boundsOf(objectId);
      expect(crept).not.toBeNull();
      // The box followed the creep rather than being answered from a cache taken
      // when the body was somewhere else.
      expect((crept as THREE.Box3).min.distanceTo(still.min)).toBeGreaterThan(0);
      // And once the pose has gone out, it is again the box every other client
      // is shooting at. Whether the *leaning* body reports the authored box is
      // asserted in `forge/movementFeel.test.ts`, where the Forge is driven
      // directly and the published pose cannot lag behind the authored one.
      expectSameBox(
        crept as THREE.Box3,
        remoteBoundsOf(new THREE.Scene(), fixture.published(), objectId) as THREE.Box3,
      );
    } finally {
      fixture.dispose();
    }
  });
});
