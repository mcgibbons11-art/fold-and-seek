// @vitest-environment jsdom
import * as THREE from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { qualitySettingsFor } from "../../src/rendering/quality";
import { CuriosityShop } from "../../src/world/maps/CuriosityShop";
import { compileGroupKey, planShopCompile } from "../../src/world/ShopWorld";
import { installCanvas2DStub, type CanvasStub } from "./canvas2d";
import { describeStructure, programStructureKey } from "./programStructure";

/**
 * How many distinct shader programs the shop actually needs, and how much of the
 * load is spent on drawables that need none.
 *
 * This is the measurement the load-time work was decided on, kept runnable
 * because both numbers regress silently. A material that stops carrying the
 * shared map slots, or a family that stops declaring vertex colours, splits a
 * program in two and neither typecheck nor a screenshot shows it. The only
 * symptom is another second and a half on the ANGLE/D3D11 path, on a load the
 * player already thinks is broken.
 *
 * Measured 2026-08-02, high tier: 281 drawables, 53 compile groups, and 13
 * distinct programs, down from 18 before the map slots were made uniform. The
 * ceilings below are those numbers with a little room, not targets.
 */

/** Programs the shop generates today, with room for a family or two more. */
const MAX_PROGRAM_STRUCTURES = 14;
/** Share of the shop the loading screen has to wait for. */
const MAX_LEAD_SHARE = 0.25;

let stub: CanvasStub;

beforeEach(() => {
  stub = installCanvas2DStub();
});

afterEach(() => {
  stub.restore();
});

function shopScene(): { scene: THREE.Scene; dispose: () => void } {
  const map = new CuriosityShop().build(qualitySettingsFor("high", "webgl2"));
  const scene = new THREE.Scene();
  scene.add(map.root);
  scene.updateMatrixWorld();
  return { scene, dispose: () => map.dispose() };
}

function drawablesOf(scene: THREE.Scene): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  scene.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh === true) meshes.push(mesh);
  });
  return meshes;
}

describe("the shop's program census", () => {
  it("generates far fewer programs than it has drawables", () => {
    const { scene, dispose } = shopScene();
    const drawables = drawablesOf(scene);
    const structures = new Map<string, THREE.Mesh>();
    for (const mesh of drawables) {
      const key = programStructureKey(mesh, scene);
      if (!structures.has(key)) structures.set(key, mesh);
    }

    // Named in the failure, because a census that only says "15 > 14" tells
    // whoever broke it nothing about which family split.
    const roster = [...structures.values()].map(describeStructure).join("\n  ");
    expect(structures.size, `program structures:\n  ${roster}\n`).toBeLessThanOrEqual(
      MAX_PROGRAM_STRUCTURES,
    );
    expect(drawables.length).toBeGreaterThan(200);
    dispose();
  });

  it("waits on one drawable per compile group and no more", () => {
    const { scene, dispose } = shopScene();
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
    camera.position.set(3.2, 2.35, 3.2);
    camera.lookAt(-0.5, 0.8, 0);
    camera.updateMatrixWorld(true);

    const plan = planShopCompile(scene, camera);
    const groups = new Set(drawablesOf(scene).map(compileGroupKey));

    expect(plan.lead).toHaveLength(groups.size);
    expect(new Set(plan.lead.map(compileGroupKey)).size).toBe(groups.size);
    expect(plan.lead.length + plan.remainder.length).toBe(drawablesOf(scene).length);
    expect(plan.lead.length / (plan.lead.length + plan.remainder.length)).toBeLessThan(MAX_LEAD_SHARE);
    dispose();
  });

  it("gives every lit material the same map slots and the same vertex colours", () => {
    // This is the consolidation itself, stated as an invariant rather than as a
    // count. A `MeshStandardMaterial` in the shop without these is a second copy
    // of every program its family already has.
    const { scene, dispose } = shopScene();
    const offenders: string[] = [];
    for (const mesh of drawablesOf(scene)) {
      const material = mesh.material as THREE.Material;
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (material.map === null) offenders.push(`${material.name}: no colour map`);
      if (material.roughnessMap === null) offenders.push(`${material.name}: no roughness map`);
      if (material.bumpMap === null) offenders.push(`${material.name}: no bump map`);
      if (!material.vertexColors) offenders.push(`${material.name}: no vertex colours`);
    }

    expect(offenders.join("\n")).toBe("");
    dispose();
  });
});
