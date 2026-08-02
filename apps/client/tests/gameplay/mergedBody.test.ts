import type { PublicDisguiseView } from "@foldseek/game-sim";
import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";

import { createBotDisguisePayload } from "../../src/gameplay/botDisguises";
import { DisguiseTheatre } from "../../src/gameplay/disguiseTheatre";
import { applyDisguiseStateToPose } from "../../src/mimic/disguiseState";
import { createPoseState } from "../../src/mimic/ikSolver";
import { decodeDisguiseState, encodeDisguiseState } from "../../src/mimic/poseWire";
import { createDefaultPanelState } from "../../src/mimic/panels";
import type { PanelSocketName } from "../../src/mimic/rig";
import { MimicVisual } from "../../src/mimic/visual/MimicVisual";
import { PaintLayer } from "../../src/paint/PaintLayer";
import { paintTargetOfObject, paintTileTransform } from "../../src/paint/paintTargets";
import { qualitySettingsFor } from "../../src/rendering/quality";

/**
 * A hunt puts four disguises in a shop that is already drawing close to three
 * hundred meshes, and a Mimic is about forty of them. These hold the merge to
 * the only two things that make it safe to draw a body as three meshes instead:
 * it must be the same geometry in the same place, and it must publish the same
 * focus box, because that box is what the Inspector's gun is checked against.
 */

const QUALITY = qualitySettingsFor("high");

function publicDisguise(
  publicObjectId: string,
  encodedPose: string,
  encodedPaint: string | null = null,
): PublicDisguiseView {
  return {
    publicObjectId,
    encodedPose,
    encodedPaint,
    defaultArrangementId: null,
    revealed: false,
  };
}

/** What the renderer would submit: meshes with no hidden ancestor. */
function drawnMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const drawn: THREE.Mesh[] = [];
  const walk = (object: THREE.Object3D): void => {
    for (const child of object.children) {
      if (!child.visible) continue;
      if (child instanceof THREE.Mesh) drawn.push(child);
      walk(child);
    }
  };
  if (root.visible) walk(root);
  return drawn;
}

function bodyOf(scene: THREE.Scene, publicObjectId: string): THREE.Object3D {
  const body = scene.getObjectByName(`disguise-${publicObjectId}`);
  if (body === undefined) throw new Error(`no body standing for ${publicObjectId}`);
  return body;
}

/** The parts the merge reads, which the theatre keeps posed but hidden. */
function sourceParts(body: THREE.Object3D): THREE.Mesh[] {
  const parts = body.getObjectByName("mimic_parts");
  if (parts === undefined) throw new Error("the body kept no parts to merge from");
  parts.visible = true;
  const meshes = drawnMeshes(parts);
  parts.visible = false;
  return meshes;
}

/** Exact axis-aligned box of a mesh list, from vertices rather than corners. */
function preciseBounds(meshes: readonly THREE.Mesh[]): THREE.Box3 {
  const box = new THREE.Box3();
  const vertex = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const position = mesh.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      box.expandByPoint(vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
    }
  }
  return box;
}

function trianglesOf(meshes: readonly THREE.Mesh[]): number {
  let triangles = 0;
  for (const mesh of meshes) {
    const index = mesh.geometry.getIndex();
    triangles += (index === null ? mesh.geometry.getAttribute("position").count : index.count) / 3;
  }
  return triangles;
}

/** The same pose with panels deployed, which the bot arrangements never carry. */
function withPanels(encodedPose: string, sockets: readonly PanelSocketName[]): string {
  const state = decodeDisguiseState(encodedPose);
  if (state === null) throw new Error("the fixture pose does not decode");
  for (const socketId of sockets) {
    const panel = createDefaultPanelState(socketId);
    panel.deployed = 1;
    state.panels.push(panel);
  }
  return encodeDisguiseState(state);
}

/**
 * The same disguise built the way the Forge builds one: every part its own
 * mesh, nothing merged. This is the reference the merged body has to match.
 */
function unmergedReference(encodedPose: string): MimicVisual {
  const state = decodeDisguiseState(encodedPose);
  if (state === null) throw new Error("the fixture pose does not decode");
  const pose = createPoseState();
  applyDisguiseStateToPose(state, pose);
  const visual = new MimicVisual();
  visual.applyForms(pose);
  visual.applyPanels(state.panels);
  visual.applyMaterials(state.materials);
  visual.applyPose(pose);
  visual.root.updateWorldMatrix(true, true);
  return visual;
}

describe("a merged disguise body", () => {
  it("draws a handful of meshes where the body has forty parts", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    theatre.sync([publicDisguise("obj_a", createBotDisguisePayload(0))], null);

    const body = bodyOf(scene, "obj_a");
    const drawn = drawnMeshes(body);
    const parts = sourceParts(body);

    // The bar the hunt is being held to. Four bodies at forty parts each is a
    // 55% rise in the shop's draw calls; four at three or four is noise.
    expect(parts.length).toBeGreaterThanOrEqual(35);
    expect(drawn.length).toBeLessThanOrEqual(6);
    // Nothing was dropped on the way: the merged meshes draw the same surface.
    expect(trianglesOf(drawn)).toBe(trianglesOf(parts));

    theatre.dispose();
  });

  it("keeps a whole room of disguises under a handful of draws each", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    theatre.sync(
      Array.from({ length: 4 }, (_, i) =>
        publicDisguise(`obj_${String(i)}`, createBotDisguisePayload(i)),
      ),
      null,
    );

    for (let i = 0; i < 4; i++) {
      expect(drawnMeshes(bodyOf(scene, `obj_${String(i)}`)).length).toBeLessThanOrEqual(6);
    }

    theatre.dispose();
  });

  it("puts the merged surface exactly where the parts stand", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    theatre.sync([publicDisguise("obj_a", createBotDisguisePayload(3))], null);

    const body = bodyOf(scene, "obj_a");
    const merged = preciseBounds(drawnMeshes(body));
    const parts = preciseBounds(sourceParts(body));

    // Vertex for vertex, not silhouette for silhouette: a merge that lost the
    // pose would still produce a plausible box somewhere near the body.
    expect(merged.min.toArray()).toEqual(parts.min.toArray().map((v) => expect.closeTo(v, 5)));
    expect(merged.max.toArray()).toEqual(parts.max.toArray().map((v) => expect.closeTo(v, 5)));

    theatre.dispose();
  });

  /**
   * The focus box is the accusation hitbox (§8.5, and the 1.25x bounds-to-shell
   * guard), so it has to survive the merge untouched rather than approximately.
   */
  it("publishes the focus box an unmerged body publishes", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);

    for (const seed of [0, 1, 2, 3]) {
      const pose = createBotDisguisePayload(seed);
      theatre.sync([publicDisguise("obj_a", pose)], null);
      const reference = unmergedReference(pose);
      const expected = new THREE.Box3().setFromObject(reference.root);

      expect(theatre.boundsOf("obj_a")?.equals(expected)).toBe(true);
      reference.dispose();
    }

    theatre.dispose();
  });

  /**
   * A panel is the one part whose presence changes across a pose, so it is the
   * one thing that forces the buffers to be laid out again rather than rewritten.
   */
  it("takes a deploying panel into the merge and into the focus box", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const bare = createBotDisguisePayload(0);
    theatre.sync([publicDisguise("obj_a", bare)], null);

    const body = bodyOf(scene, "obj_a");
    const before = trianglesOf(drawnMeshes(body));
    const boxBefore = theatre.boundsOf("obj_a")?.clone();

    const panelled = withPanels(bare, ["panel_socket_01"]);
    theatre.sync([publicDisguise("obj_a", panelled)], null);

    expect(trianglesOf(drawnMeshes(body))).toBeGreaterThan(before);
    expect(trianglesOf(drawnMeshes(body))).toBe(trianglesOf(sourceParts(body)));

    const reference = unmergedReference(panelled);
    expect(
      theatre.boundsOf("obj_a")?.equals(new THREE.Box3().setFromObject(reference.root)),
    ).toBe(true);
    expect(theatre.boundsOf("obj_a")?.equals(boxBefore as THREE.Box3)).toBe(false);
    reference.dispose();

    theatre.dispose();
  });

  it("moves the drawn geometry when the disguise creeps", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const still = createBotDisguisePayload(0);
    theatre.sync([publicDisguise("obj_a", still)], null);

    const body = bodyOf(scene, "obj_a");
    const before = preciseBounds(drawnMeshes(body)).getCenter(new THREE.Vector3());

    const crept = decodeDisguiseState(still);
    if (crept === null) throw new Error("the fixture pose does not decode");
    crept.root.position = [
      (crept.root.position[0] ?? 0) + 0.4,
      crept.root.position[1] ?? 0,
      crept.root.position[2] ?? 0,
    ];
    theatre.sync([publicDisguise("obj_a", encodeDisguiseState(crept))], null);

    const after = preciseBounds(drawnMeshes(body)).getCenter(new THREE.Vector3());
    expect(after.x - before.x).toBeCloseTo(0.4, 4);
    expect(after.z - before.z).toBeCloseTo(0, 4);

    theatre.dispose();
  });

  it("carries a taunt on the whole merged body", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    theatre.sync([publicDisguise("obj_a", createBotDisguisePayload(0))], null);
    const body = bodyOf(scene, "obj_a");
    const before = preciseBounds(drawnMeshes(body)).getCenter(new THREE.Vector3());

    theatre.taunt("obj_a", "tick_tock", 4);
    theatre.update(300);
    body.updateWorldMatrix(true, true);
    const during = preciseBounds(drawnMeshes(body)).getCenter(new THREE.Vector3());

    // The gesture is a transform on the body, so it reaches the merged meshes
    // without re-merging anything.
    expect(during.distanceTo(before)).toBeGreaterThan(0);

    theatre.update(5_000);
    body.updateWorldMatrix(true, true);
    const after = preciseBounds(drawnMeshes(body)).getCenter(new THREE.Vector3());
    expect(after.distanceTo(before)).toBeCloseTo(0, 6);

    theatre.dispose();
  });
});

/**
 * Painting is what makes merging harder than it looks. Unmerged, each part
 * wears a clone of its material holding a view of that part's tile of the paint
 * atlas, which is 27 materials and 27 draws on a painted body. Merged, one mesh
 * wears the whole atlas and the tile has to live in the vertices instead.
 */
describe("a merged disguise body wearing paint", () => {
  function paintedPose(): { pose: string; encodedPaint: string; layer: PaintLayer } {
    const layer = new PaintLayer();
    layer.applyStroke({
      segmentId: 0,
      uv: [0.5, 0.5],
      radius: 0.3,
      color: [1, 0, 0],
      opacity: 1,
      kind: "brush",
      continued: false,
    });
    // Panelled, because a panel is the one paintable part that is not a shell:
    // it carries its own tile and it is the only part whose presence changes
    // the merge's layout.
    return {
      pose: withPanels(createBotDisguisePayload(0), ["panel_socket_01", "panel_socket_04"]),
      encodedPaint: layer.toDataForWire(),
      layer,
    };
  }

  it("wears the paint without spending a draw call per part", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const { pose, encodedPaint, layer } = paintedPose();

    theatre.sync([publicDisguise("obj_a", pose, encodedPaint)], null);
    const drawn = drawnMeshes(bodyOf(scene, "obj_a"));

    expect(drawn.length).toBeLessThanOrEqual(6);
    const painted = drawn.filter((mesh) => {
      const material = mesh.material;
      return !Array.isArray(material) && material.name.endsWith("+paint");
    });
    expect(painted.length).toBeGreaterThan(0);

    theatre.dispose();
    layer.dispose();
  });

  /**
   * Every part shares one UV square, so the atlas gives each its own tile and
   * the unmerged path reaches it through the material's offset and repeat. The
   * merged path folds exactly that transform into the coordinates, so a vertex
   * that lands outside its own tile is a part wearing another part's paint.
   */
  it("bakes each part's atlas tile into the merged coordinates", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const { pose, encodedPaint, layer } = paintedPose();
    theatre.sync([publicDisguise("obj_a", pose, encodedPaint)], null);

    const body = bodyOf(scene, "obj_a");
    const expectedTargets = new Set<number>();
    for (const part of sourceParts(body)) {
      const target = paintTargetOfObject(part);
      if (target !== null) expectedTargets.add(target);
    }
    // Nineteen shells and the two deployed panels.
    expect(expectedTargets.size).toBe(21);

    const tiles = [...expectedTargets].map((target) => ({
      target,
      ...paintTileTransform(target),
    }));
    const covered = new Set<number>();
    let checked = 0;

    for (const mesh of drawnMeshes(body)) {
      const material = mesh.material;
      if (Array.isArray(material) || !material.name.endsWith("+paint")) continue;
      const uv = mesh.geometry.getAttribute("uv");
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        checked += 1;
        const inside = tiles.filter(
          (tile) =>
            u >= tile.offsetU - 1e-6 &&
            u <= tile.offsetU + tile.repeatU + 1e-6 &&
            v >= tile.offsetV - 1e-6 &&
            v <= tile.offsetV + tile.repeatV + 1e-6,
        );
        expect(inside.length, `a merged vertex at ${String(u)},${String(v)} sits in no tile`)
          .toBeGreaterThan(0);
        // A vertex on a tile edge belongs to both neighbours, and the shells all
        // carry one, so only interior vertices name the tile they came from.
        if (inside.length === 1 && inside[0] !== undefined) covered.add(inside[0].target);
      }
    }

    expect(checked).toBeGreaterThan(0);
    // Every painted part is represented, and no vertex claimed a tile the body
    // does not own.
    expect([...covered].sort((a, b) => a - b)).toEqual(
      [...expectedTargets].sort((a, b) => a - b),
    );

    theatre.dispose();
    layer.dispose();
  });

  /**
   * The Forge's eyedropper reads the room, and a peer's disguise is a fair
   * thing to copy a colour from. A hidden part and the merged mesh drawn over
   * it are the same surface at the same distance, and a `Raycaster` ignores
   * visibility, so only one of them may answer or the dropper picks the swatch
   * under the paint about half the time.
   */
  it("answers a picking ray with the merged surface and not the parts", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const { pose, encodedPaint, layer } = paintedPose();
    theatre.sync([publicDisguise("obj_a", pose, encodedPaint)], null);

    const body = bodyOf(scene, "obj_a");
    const painted = drawnMeshes(body).find((mesh) => {
      const material = mesh.material;
      return !Array.isArray(material) && material.name.endsWith("+paint");
    });
    if (painted === undefined) throw new Error("no painted merged mesh to aim at");

    // Aimed down the outward normal of one of its own triangles, so the ray is
    // guaranteed to meet the body rather than to thread between its limbs.
    const position = painted.geometry.getAttribute("position");
    const normal = painted.geometry.getAttribute("normal");
    const target = new THREE.Vector3().fromBufferAttribute(position, 0);
    const direction = new THREE.Vector3().fromBufferAttribute(normal, 0).normalize();
    painted.updateWorldMatrix(true, false);
    target.applyMatrix4(painted.matrixWorld);
    direction.transformDirection(painted.matrixWorld);

    const hits = new THREE.Raycaster(
      target.clone().addScaledVector(direction, 1),
      direction.clone().negate(),
    ).intersectObject(body, true);

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.object.parent?.name, `a picking ray reached a part it should not see`).toBe(
        "mimic_merged",
      );
    }

    theatre.dispose();
    layer.dispose();
  });

  it("hands the body its own materials back when the paint goes", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const { pose, encodedPaint, layer } = paintedPose();

    theatre.sync([publicDisguise("obj_a", pose, encodedPaint)], null);
    theatre.sync([publicDisguise("obj_a", pose, null)], null);

    for (const mesh of drawnMeshes(bodyOf(scene, "obj_a"))) {
      const material = mesh.material;
      expect(Array.isArray(material) ? "array" : material.name).not.toContain("+paint");
    }

    theatre.dispose();
    layer.dispose();
  });
});

/**
 * Every part of a Mimic moves with its bone, so there is no static half to bake
 * once. A creeping hider republishes several times a second and the merge is
 * redone each time, which is only affordable because it writes into buffers it
 * already owns.
 */
describe("the cost of re-merging a moving disguise", () => {
  it("re-poses a body without allocating a new layout", () => {
    const scene = new THREE.Scene();
    const theatre = new DisguiseTheatre(scene, QUALITY);
    const pose = decodeDisguiseState(createBotDisguisePayload(0));
    if (pose === null) throw new Error("the fixture pose does not decode");
    theatre.sync([publicDisguise("obj_a", encodeDisguiseState(pose))], null);

    const body = bodyOf(scene, "obj_a");
    const geometries = drawnMeshes(body).map((mesh) => mesh.geometry);
    const materials = drawnMeshes(body).map((mesh) => mesh.material);

    const samples: number[] = [];
    for (let step = 1; step <= 60; step++) {
      pose.root.position = [
        (pose.root.position[0] ?? 0) + 0.005,
        pose.root.position[1] ?? 0,
        pose.root.position[2] ?? 0,
      ];
      const encoded = encodeDisguiseState(pose);
      const started = performance.now();
      theatre.sync([publicDisguise("obj_a", encoded)], null);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    // A move re-bakes vertices into the buffers already allocated: the merged
    // geometry and its material are the same objects sixty poses later.
    expect(drawnMeshes(body).map((mesh) => mesh.geometry)).toEqual(geometries);
    expect(drawnMeshes(body).map((mesh) => mesh.material)).toEqual(materials);
    // The whole path a creep takes, decode and solve included. Four bodies
    // republishing twice a second have to stay far inside one frame; the first
    // few passes are excluded because they are the engine warming up, not the
    // cost the hunt pays. The bound is a median and carries headroom for a
    // loaded machine (measured 3.3-4.3 ms during concurrent agent runs, ~1 ms
    // quiet): a real regression here is re-baking into fresh allocations,
    // which lands an order of magnitude past this, not nearby.
    expect(samples[30] ?? Infinity).toBeLessThan(8);

    theatre.dispose();
  });
});
