import {
  INNOCENT_REACTION_IDS,
  type MatchSettingsPatch,
  type PublicDisguiseView,
  type SimEvent,
} from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";

import { createBotDisguise } from "../../src/gameplay/botDisguises";
import { DisguiseTheatre } from "../../src/gameplay/disguiseTheatre";
import { REACTION_SOUNDS, ReactionTheatre } from "../../src/gameplay/huntCues";
import { RoundActions } from "../../src/gameplay/RoundActions";
import { RoundDirector } from "../../src/gameplay/RoundDirector";
import { decodeDisguiseState, encodeDisguiseState } from "../../src/mimic/poseWire";
import { LocalLoopbackAdapter } from "../../src/networking/LocalLoopbackAdapter";
import { PaintLayer } from "../../src/paint/PaintLayer";
import { qualitySettingsFor } from "../../src/rendering/quality";
import { CURIOSITY_SHOP_OBJECTS } from "../../src/world/maps/registry";

/**
 * The hunt's live events only matter if something happens on screen. These
 * drive a real round through the loopback and then render its public state the
 * way an observer's client does, so a creep or a brushstroke that the authority
 * accepted but nobody could see would fail here.
 *
 * The loopback runs without a spatial validator, which is its default and makes
 * the simulation permissive about where a body may stand. Range, line of sight
 * and the play volume are covered by roundAccusation.test.ts; what is under
 * test here is the chain from an accepted update to a body that moved.
 */

const QUALITY = qualitySettingsFor("high");

const SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 600,
  forgeMs: 1_000,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 10_000,
  revealMs: 400,
  resultsMs: 400,
  rematchVoteMs: 400,
};

const STEP_MS = 100;
const BOT_COUNT = 2;
/** Hands the local player the Mimic role, which is the only one that creeps. */
const MIMIC_SEED = 11;

/**
 * How far the hider creeps, in metres. `hiderCreepSpeed` is 0.6 m/s measured
 * between consecutive poses, and several seconds pass between the lock and this
 * move, so a step this size is comfortably inside the allowance.
 */
const CREEP_M = 0.05;

interface Fixture {
  readonly adapter: LocalLoopbackAdapter;
  readonly director: RoundDirector;
  readonly actions: RoundActions;
  readonly events: SimEvent[];
  advance(steps: number): void;
  runTo(phase: MatchPhase, maxSteps?: number): void;
  disguises(): readonly PublicDisguiseView[];
  dispose(): void;
}

async function hidingFixture(): Promise<Fixture> {
  let clock = 0;
  const adapter = new LocalLoopbackAdapter({ settings: SETTINGS, seed: MIMIC_SEED, now: () => clock });
  const director = new RoundDirector(adapter, { now: () => clock, tickIntervalMs: 0 });
  const events: SimEvent[] = [];
  adapter.onEvent((event) => events.push(event));

  const fixture: Fixture = {
    adapter,
    director,
    actions: new RoundActions(adapter, director),
    events,
    advance(steps: number) {
      for (let index = 0; index < steps; index += 1) {
        clock += STEP_MS;
        adapter.step();
        director.tick();
      }
    },
    runTo(phase: MatchPhase, maxSteps = 300) {
      for (let index = 0; index < maxSteps; index += 1) {
        const current = director.getState().phase;
        if (current === phase) return;
        if (current === MatchPhase.Lobby || current === MatchPhase.Loading) {
          fixture.actions.ready(true);
        }
        fixture.advance(1);
      }
      throw new Error(`phase ${phase} not reached; stopped at ${director.getState().phase}`);
    },
    disguises: () => adapter.getSync().publicState?.disguises ?? [],
    dispose() {
      director.dispose();
      adapter.dispose();
    },
  };

  for (let index = 0; index < BOT_COUNT; index += 1) adapter.addBot();
  await adapter.join("practice", "Curator");
  fixture.actions.ready(true);
  fixture.advance(1);
  fixture.actions.startMatch();

  // An authored pose, so the disguise carries geometry that can be nudged
  // rather than the §5.8 fallback the authority auto-locks.
  fixture.runTo(MatchPhase.Forge);
  fixture.actions.lockDisguise(encodeDisguiseState(createBotDisguise(0)), 1);
  fixture.advance(1);
  return fixture;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a creeping disguise, seen by somebody else", () => {
  it("moves on screen when the authority accepts the creep", async () => {
    vi.useFakeTimers();
    const fixture = await hidingFixture();
    fixture.runTo(MatchPhase.Inspection);

    const mine = fixture.director.getState().self.ownDisguise;
    expect(mine).not.toBeNull();
    if (mine === null) throw new Error("the hider locked nothing");

    // An observer draws every disguise, including this one: `omit` is only the
    // viewer's own, and this client is not the viewer.
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    theatre.sync(fixture.disguises(), null);
    const before = theatre.boundsOf(mine.publicObjectId)?.clone();
    expect(before).toBeDefined();

    const pose = decodeDisguiseState(mine.encodedPose);
    expect(pose).not.toBeNull();
    if (pose === null) throw new Error("the locked pose does not decode");
    pose.root.position = [
      (pose.root.position[0] ?? 0) + CREEP_M,
      pose.root.position[1] ?? 0,
      pose.root.position[2] ?? 0,
    ];
    // The lock above carried revision 1, and revisions only move forward.
    pose.revision = 2;

    fixture.adapter.sendForgeSnapshot({
      encodedPose: encodeDisguiseState(pose),
      revision: pose.revision,
    });
    fixture.advance(1);

    // Accepted, and announced as a move rather than a reshape.
    const updates = fixture.events.filter((event) => event.type === "disguise_updated");
    expect(updates.at(-1)).toMatchObject({
      publicObjectId: mine.publicObjectId,
      moved: true,
      painted: false,
    });
    expect(fixture.director.getState().rejections).toHaveLength(0);

    theatre.sync(fixture.disguises(), null);
    const after = theatre.boundsOf(mine.publicObjectId);
    expect(after).toBeDefined();
    const travelled =
      (after as THREE.Box3).getCenter(new THREE.Vector3()).x -
      (before as THREE.Box3).getCenter(new THREE.Vector3()).x;
    expect(travelled).toBeCloseTo(CREEP_M, 4);

    theatre.dispose();
    fixture.dispose();
  });

  it("repaints on screen when the hider paints during the hunt", async () => {
    vi.useFakeTimers();
    const fixture = await hidingFixture();
    fixture.runTo(MatchPhase.Inspection);

    const mine = fixture.director.getState().self.ownDisguise;
    if (mine === null) throw new Error("the hider locked nothing");

    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    theatre.sync(fixture.disguises(), null);
    expect(paintedMeshes(scene)).toHaveLength(0);

    const layer = new PaintLayer();
    layer.applyStroke({
      segmentId: 0,
      uv: [0.5, 0.5],
      radius: 0.4,
      color: [0.2, 0.7, 0.3],
      opacity: 1,
      kind: "brush",
      continued: false,
    });
    fixture.adapter.sendPaintUpdate({ encodedPaint: layer.toDataForWire(), revision: 1 });
    fixture.advance(1);

    expect(fixture.director.getState().rejections).toHaveLength(0);
    expect(fixture.events.filter((event) => event.type === "disguise_updated").at(-1)).toMatchObject(
      { publicObjectId: mine.publicObjectId, painted: true },
    );

    // The event says which object changed; the geometry and the paint travel in
    // public state, so a re-sync is what has to put the brushwork on the body.
    theatre.sync(fixture.disguises(), null);
    expect(paintedMeshes(scene).length).toBeGreaterThan(0);

    theatre.dispose();
    layer.dispose();
    fixture.dispose();
  });
});

/** Parts the paint binder has taken over, which it marks on the clone's name. */
function paintedMeshes(scene: THREE.Scene): THREE.Mesh[] {
  const painted: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = object.material;
    if (Array.isArray(material) || material === undefined) return;
    if (material.name.endsWith("+paint")) painted.push(object);
  });
  return painted;
}

describe("innocent reactions", () => {
  it("names a bundled sound for every reaction the simulation can play", () => {
    // The simulation's vocabulary and the bundle's filenames are close enough
    // to be mistaken for one another, which is exactly why the crossing is
    // written out. A reaction added upstream must not fall through silently.
    for (const reactionId of INNOCENT_REACTION_IDS) {
      expect(REACTION_SOUNDS[reactionId], `no sound for ${reactionId}`).toBeDefined();
    }
    expect(Object.keys(REACTION_SOUNDS).sort()).toEqual([...INNOCENT_REACTION_IDS].sort());
    expect(REACTION_SOUNDS.clock_chimes).toBe("clock_chime");
    expect(REACTION_SOUNDS.lamp_turns_on).toBe("lamp_switch");
    expect(REACTION_SOUNDS.chair_squeaks).toBe("chair_squeak");
  });

  it("answers where the prop stands, and fades out on its own", () => {
    const prop = CURIOSITY_SHOP_OBJECTS.find((entry) => entry.accusationPolicy === "allowed");
    expect(prop).toBeDefined();
    if (prop === undefined) throw new Error("the map publishes no accusable prop");

    const scene = new THREE.Scene();
    const play = vi.fn();
    const reactions = new ReactionTheatre(scene, { play });

    reactions.play(prop.objectId, prop.innocentReactionId);
    expect(play).toHaveBeenCalledWith(REACTION_SOUNDS[prop.innocentReactionId], expect.any(Number));
    expect(reactions.count).toBe(1);

    const flare = scene.getObjectByName(`reaction-${prop.objectId}`);
    expect(flare).toBeDefined();
    const centre = prop.focusBounds.getCenter(new THREE.Vector3());
    expect((flare as THREE.Object3D).position.distanceTo(centre)).toBeLessThan(1e-6);

    // It grows out of nothing and then goes, leaving the scene as it found it.
    reactions.update(200);
    expect((flare as THREE.Object3D).scale.x).toBeGreaterThan(0.001);
    reactions.update(5_000);
    expect(reactions.count).toBe(0);
    expect(scene.children).toHaveLength(0);

    reactions.dispose();
  });

  it("still sounds for an object the map does not publish, without inventing a place for it", () => {
    const scene = new THREE.Scene();
    const play = vi.fn();
    const reactions = new ReactionTheatre(scene, { play });

    reactions.play("no-such-prop", "vase_dust_puff");

    expect(play).toHaveBeenCalledWith(REACTION_SOUNDS.vase_dust_puff, expect.any(Number));
    expect(reactions.count).toBe(0);
    expect(scene.children).toHaveLength(0);

    reactions.dispose();
  });
});
