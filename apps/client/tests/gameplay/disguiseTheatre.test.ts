import type { PublicDisguiseView } from "@foldseek/game-sim";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";

import { createBotDisguisePayload } from "../../src/gameplay/botDisguises";
import { DisguiseTheatre } from "../../src/gameplay/disguiseTheatre";
import { TAUNT_SOUND } from "../../src/gameplay/huntCues";
import { decodeDisguiseState } from "../../src/mimic/poseWire";
import { PaintLayer } from "../../src/paint/PaintLayer";
import { qualitySettingsFor } from "../../src/rendering/quality";

/**
 * A disguise that does not become geometry is a target the Inspector can never
 * find, so these assert the whole path from the authority's public pose to a
 * body standing in the scene with bounds the reticle can bracket.
 */

const QUALITY = qualitySettingsFor("high");

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

function publicDisguise(
  publicObjectId: string,
  encodedPose: string,
  overrides: Partial<PublicDisguiseView> = {},
): PublicDisguiseView {
  return {
    publicObjectId,
    encodedPose,
    encodedPaint: null,
    defaultArrangementId: null,
    revealed: false,
    ...overrides,
  };
}

describe("DisguiseTheatre", () => {
  it("stands a locked bot pose up in the scene where the authority put it", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const payload = createBotDisguisePayload(0);
    const expected = decodeDisguiseState(payload);
    expect(expected).not.toBeNull();

    theatre.sync([publicDisguise("obj_a", payload)], null);

    const bounds = theatre.boundsOf("obj_a");
    expect(bounds).not.toBeNull();
    const box = bounds as THREE.Box3;
    expect(box.isEmpty()).toBe(false);
    // The body is around the root the pose declared, not at the world origin.
    const root = expected?.root.position ?? [0, 0, 0];
    expect(Math.abs(box.getCenter(new THREE.Vector3()).x - (root[0] ?? 0))).toBeLessThan(1);
    expect(Math.abs(box.getCenter(new THREE.Vector3()).z - (root[2] ?? 0))).toBeLessThan(1);

    theatre.dispose();
  });

  it("publishes a focus proxy that says nothing about what the object really is", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    theatre.sync([publicDisguise("obj_a", createBotDisguisePayload(1))], null);

    const proxies = theatre.proxies();
    expect(proxies).toHaveLength(1);
    const proxy = proxies[0];
    expect(proxy?.objectId).toBe("obj_a");
    expect(proxy?.accusationPolicy).toBe("allowed");
    expect(proxy?.categoryId).not.toContain("mimic");
    // The reticle brackets the live box, so a creeping hider stays framed.
    expect(proxy?.bounds).toBe(theatre.boundsOf("obj_a"));

    theatre.dispose();
  });

  it("falls back to the named starting arrangement when no pose was authored", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    theatre.sync(
      [publicDisguise("obj_a", "", { defaultArrangementId: "tripod" })],
      null,
    );

    expect(theatre.boundsOf("obj_a")?.isEmpty()).toBe(false);
    theatre.dispose();
  });

  it("re-measures a disguise that creeps and leaves an unchanged one alone", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    theatre.sync([publicDisguise("obj_a", createBotDisguisePayload(0))], null);
    const first = theatre.boundsOf("obj_a")?.clone();
    const castAfterFirst = theatre.revision;

    theatre.sync([publicDisguise("obj_a", createBotDisguisePayload(2))], null);
    const moved = theatre.boundsOf("obj_a");

    expect(first).toBeDefined();
    expect(moved?.equals(first as THREE.Box3)).toBe(false);
    // A pose change is not a change of cast, so the focus set is not rebuilt.
    expect(theatre.revision).toBe(castAfterFirst);

    theatre.dispose();
  });

  /**
   * Paint is public appearance. A peer's brushwork that never reaches anyone
   * else's screen means every player is painting a Mimic nobody ever sees, so
   * the layer has to be decoded and bound to the body's own materials.
   */
  it("puts a peer's paint on their body, and takes it off again when it goes", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const pose = createBotDisguisePayload(0);

    const layer = new PaintLayer();
    layer.applyStroke({
      segmentId: 0,
      uv: [0.5, 0.5],
      radius: 0.4,
      color: [1, 0, 0],
      opacity: 1,
      kind: "brush",
      continued: false,
    });
    const encodedPaint = layer.toDataForWire();
    expect(encodedPaint.length).toBeGreaterThan(0);

    theatre.sync([publicDisguise("obj_a", pose, { encodedPaint })], null);
    const painted = paintedMeshes(scene);
    expect(painted.length).toBeGreaterThan(0);

    // The same disguise with its layer cleared hands the parts their own
    // materials back rather than leaving a stale clone behind.
    theatre.sync([publicDisguise("obj_a", pose, { encodedPaint: null })], null);
    expect(paintedMeshes(scene)).toHaveLength(0);

    theatre.dispose();
    layer.dispose();
  });

  /**
   * A creeping hider republishes a pose several times a second. If each one
   * reassigned the body's materials, the paint binder would clone them again
   * every time, and on WebGPU every new material is a blocking shader compile.
   */
  it("does not hand a creeping disguise new materials on every pose", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const layer = new PaintLayer();
    layer.applyStroke({
      segmentId: 0,
      uv: [0.5, 0.5],
      radius: 0.4,
      color: [0, 0, 1],
      opacity: 1,
      kind: "brush",
      continued: false,
    });
    const encodedPaint = layer.toDataForWire();

    theatre.sync(
      [publicDisguise("obj_a", createBotDisguisePayload(0), { encodedPaint })],
      null,
    );
    const before = paintedMeshes(scene).map((mesh) => mesh.material);
    expect(before.length).toBeGreaterThan(0);

    // A different pose, same swatches: the disguise moved, nothing was recoloured.
    theatre.sync(
      [publicDisguise("obj_a", createBotDisguisePayload(2), { encodedPaint })],
      null,
    );
    const after = paintedMeshes(scene).map((mesh) => mesh.material);

    expect(after).toHaveLength(before.length);
    for (let index = 0; index < before.length; index += 1) {
      expect(after[index], "a pose update replaced a material").toBe(before[index]);
    }

    theatre.dispose();
    layer.dispose();
  });

  it("leaves a disguise that carries no paint entirely alone", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    theatre.sync([publicDisguise("obj_a", createBotDisguisePayload(0))], null);

    expect(paintedMeshes(scene)).toHaveLength(0);
    theatre.dispose();
  });

  it("leaves out the viewer's own disguise and takes down one that has gone", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const cast = [
      publicDisguise("obj_a", createBotDisguisePayload(0)),
      publicDisguise("obj_mine", createBotDisguisePayload(1)),
    ];

    theatre.sync(cast, "obj_mine");
    expect(theatre.proxies().map((entry) => entry.objectId)).toEqual(["obj_a"]);

    // Once the Forge stops drawing it, the viewer's own object joins the room.
    theatre.sync(cast, null);
    expect(theatre.proxies().map((entry) => entry.objectId).sort()).toEqual(["obj_a", "obj_mine"]);

    theatre.sync([], null);
    expect(theatre.proxies()).toHaveLength(0);
    expect(scene.children).toHaveLength(0);

    theatre.dispose();
  });
});

/**
 * A taunt is performed by the object, never by the player, which is the only
 * reason a hider can bait an Inspector without confessing. These check that the
 * gesture reaches the body, that every client animates it identically off the
 * authority's seed, and that it does not drag the object's focus box with it.
 */
describe("DisguiseTheatre taunts", () => {
  /** The disguise's own body transform, which is what a taunt displaces. */
  function bodyOf(theatre: DisguiseTheatre, scene: THREE.Scene): THREE.Object3D {
    const root = scene.getObjectByName("disguise-obj_a");
    expect(root, "no body standing for obj_a").toBeDefined();
    return root as THREE.Object3D;
  }

  function stagedTheatre(audio?: { play: (id: string, jitter?: number) => void }): {
    theatre: DisguiseTheatre;
    scene: THREE.Scene;
  } {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY, audio ?? null);
    theatre.sync([publicDisguise("obj_a", createBotDisguisePayload(0))], null);
    return { theatre, scene };
  }

  it("moves the object it names, then leaves it exactly where it stood", () => {
    const play = vi.fn();
    const { theatre, scene } = stagedTheatre({ play });
    const body = bodyOf(theatre, scene);
    expect(body.position.lengthSq()).toBe(0);

    expect(theatre.taunt("obj_a", "shudder", 7)).toBe(true);
    expect(play).toHaveBeenCalledWith(TAUNT_SOUND, expect.any(Number));
    expect(play.mock.calls[0]?.[0]).toBe(TAUNT_SOUND);

    theatre.update(120);
    expect(body.position.lengthSq(), "the taunt never reached the body").toBeGreaterThan(0);

    // A gesture that ended leaning would leave the disguise permanently askew.
    theatre.update(5_000);
    expect(body.position.lengthSq()).toBe(0);
    expect(body.rotation.y).toBe(0);
    expect(body.rotation.z).toBe(0);

    theatre.dispose();
  });

  it("plays the same gesture on every client from the same seed", () => {
    const first = stagedTheatre();
    const second = stagedTheatre();
    const third = stagedTheatre();

    first.theatre.taunt("obj_a", "rattle", 12_345);
    second.theatre.taunt("obj_a", "rattle", 12_345);
    third.theatre.taunt("obj_a", "rattle", 12_346);
    for (const staged of [first, second, third]) staged.theatre.update(180);

    const a = bodyOf(first.theatre, first.scene);
    const b = bodyOf(second.theatre, second.scene);
    const c = bodyOf(third.theatre, third.scene);

    expect(b.position.toArray()).toEqual(a.position.toArray());
    expect(b.rotation.toArray()).toEqual(a.rotation.toArray());
    // A different seed is a different performance, or the seed is doing nothing.
    expect(c.position.toArray()).not.toEqual(a.position.toArray());

    for (const staged of [first, second, third]) staged.theatre.dispose();
  });

  it("gives each gesture its own shape and its own length", () => {
    const shudder = stagedTheatre();
    const tick = stagedTheatre();
    shudder.theatre.taunt("obj_a", "shudder", 3);
    tick.theatre.taunt("obj_a", "tick_tock", 3);
    shudder.theatre.update(200);
    tick.theatre.update(200);

    const shudderBody = bodyOf(shudder.theatre, shudder.scene);
    const tickBody = bodyOf(tick.theatre, tick.scene);
    expect(tickBody.position.toArray()).not.toEqual(shudderBody.position.toArray());

    // shudder is the short one; tick_tock is still swinging when it is over.
    shudder.theatre.update(500);
    tick.theatre.update(500);
    expect(shudderBody.position.lengthSq()).toBe(0);
    expect(Math.abs(tickBody.rotation.z)).toBeGreaterThan(0);

    shudder.theatre.dispose();
    tick.theatre.dispose();
  });

  it("refuses a taunt for an object it is not drawing", () => {
    const play = vi.fn();
    const { theatre } = stagedTheatre({ play });

    // The viewer's own disguise looks exactly like this: the Forge holds it, so
    // the theatre has no body to perform with and says so rather than pretending.
    expect(theatre.taunt("obj_mine", "puff", 1)).toBe(false);
    expect(play).not.toHaveBeenCalled();

    theatre.dispose();
  });

  it("keeps the focus box on the pose rather than on the wobble", () => {
    const { theatre, scene } = stagedTheatre();
    const still = new THREE.Scene();
    const reference = new DisguiseTheatre(still, QUALITY);

    theatre.taunt("obj_a", "settle_creak", 5);
    theatre.update(300);
    expect(bodyOf(theatre, scene).position.lengthSq()).toBeGreaterThan(0);

    // The same creep arriving mid-gesture: the box the reticle brackets and the
    // authority shoots against has to describe where the pose puts the body,
    // not where the taunt has thrown it this frame.
    const crept = publicDisguise("obj_a", createBotDisguisePayload(2));
    theatre.sync([crept], null);
    reference.sync([crept], null);
    expect(theatre.boundsOf("obj_a")?.equals(reference.boundsOf("obj_a") as THREE.Box3)).toBe(true);

    theatre.dispose();
    reference.dispose();
  });
});
