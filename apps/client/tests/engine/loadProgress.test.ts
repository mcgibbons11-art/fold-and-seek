import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import {
  LOAD_MIMICS_END,
  LOAD_SHADERS_END,
  LOAD_ZONES_END,
  shaderLoadFraction,
  zoneLoadFraction,
} from "../../src/engine/GameHost";
import { SHOP_BUILD_STEP_COUNT } from "../../src/world/maps/CuriosityShop";
import { compileSceneInBatches, SHOP_PRECOMPILE_BATCH } from "../../src/world/ShopWorld";

/**
 * What the loading bar is told, and whether it can be read as progress.
 *
 * The measured failure, from the round-6 critic: the bar sat on "91% · the
 * shaders" for the whole shader sweep. The sweep was reporting every batch — the
 * wiring was never broken — but the fraction it reported through was
 * `(tail - 1 + done / total) / tail`, where `tail` was the map's own step count
 * plus two. With nine map steps that is eleven, so the longest and least
 * predictable part of the load was given one eleventh of the bar and opened at
 * ten elevenths, which is 91%. A sweep that ran into its 20-second deadline part
 * way through never got out of the low nineties.
 *
 * So what is checked here is the arithmetic that replaced it, driven through the
 * real batching, and the property the player actually needs: the number in front
 * of them keeps moving.
 */

/** Drawables strung out in front of the camera, all of them in view. */
function sceneOf(count: number): THREE.Scene {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  for (let index = 0; index < count; index += 1) {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.set(0, 0, -2 - index * 0.05);
    scene.add(mesh);
  }
  scene.updateMatrixWorld(true);
  return scene;
}

function camera(): THREE.PerspectiveCamera {
  const view = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 40);
  view.updateMatrixWorld(true);
  view.updateProjectionMatrix();
  return view;
}

/** The fractions a sweep over `count` drawables reports, in order. */
async function sweepFractions(count: number): Promise<number[]> {
  const fractions: number[] = [];
  await compileSceneInBatches({
    scene: sceneOf(count),
    camera: camera(),
    compile: () => Promise.resolve(),
    onBatch: (done, total) => {
      fractions.push(shaderLoadFraction(done, total));
    },
  });
  return fractions;
}

/** The figure the loading screen prints, which is the only one a player sees. */
function percent(fraction: number): number {
  return Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
}

function isStrictlyIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] as number));
}

describe("the load's share of the bar", () => {
  it("gives the shader sweep the largest share, because it is the longest wait", () => {
    const zones = LOAD_ZONES_END;
    const shaders = LOAD_SHADERS_END - LOAD_MIMICS_END;
    expect(shaders).toBeGreaterThan(zones);
    expect(shaders).toBeGreaterThan(0.5);

    // The share the old step count gave it, for the room the change bought: one
    // step of the map's own count plus the two the tail added.
    const oldShare = 1 / (SHOP_BUILD_STEP_COUNT + 2);
    expect(shaders).toBeGreaterThan(oldShare * 5);
  });

  it("runs the four phases end to end without ever going backwards", () => {
    const zones = Array.from({ length: SHOP_BUILD_STEP_COUNT }, (_, index) =>
      zoneLoadFraction(index + 1, SHOP_BUILD_STEP_COUNT),
    );
    const whole = [0, ...zones, LOAD_ZONES_END, LOAD_MIMICS_END, LOAD_SHADERS_END, 1];
    expect(whole.every((value, index) => index === 0 || value >= (whole[index - 1] as number))).toBe(
      true,
    );
    expect(zones[zones.length - 1]).toBe(LOAD_ZONES_END);
  });

  it("counts an empty pass as finished rather than stalling on a division by zero", () => {
    expect(zoneLoadFraction(0, 0)).toBe(LOAD_ZONES_END);
    expect(shaderLoadFraction(0, 0)).toBe(LOAD_SHADERS_END);
  });

  it("never reports outside its own phase, whatever it is handed", () => {
    expect(zoneLoadFraction(-4, 9)).toBe(0);
    expect(zoneLoadFraction(40, 9)).toBe(LOAD_ZONES_END);
    expect(shaderLoadFraction(-4, 40)).toBe(LOAD_MIMICS_END);
    expect(shaderLoadFraction(400, 40)).toBe(LOAD_SHADERS_END);
  });
});

describe("the shader sweep as the player reads it", () => {
  it("moves the printed percentage on every batch of a 40-drawable sweep", async () => {
    // Forty drawables at the shop's own batch size, which is five batches. Every
    // one of them has to be visible in the number, because a batch is the only
    // moment the sweep has anything to say.
    const fractions = await sweepFractions(40);
    expect(fractions).toHaveLength(Math.ceil(40 / SHOP_PRECOMPILE_BATCH));
    expect(isStrictlyIncreasing(fractions)).toBe(true);
    expect(isStrictlyIncreasing(fractions.map(percent))).toBe(true);
    expect(fractions[0]).toBeGreaterThan(LOAD_MIMICS_END);
    expect(fractions[fractions.length - 1]).toBe(LOAD_SHADERS_END);
  });

  it("shows at least ten distinct figures across a sweep of the shop's own size", async () => {
    // The shop submits roughly 174 drawables, so this is the sweep the load
    // actually runs, and it is the case the critic was watching. Under the old
    // arithmetic the whole of it fitted between 91% and 100%.
    const SHOP_SCALE_DRAWABLES = 176;
    const fractions = await sweepFractions(SHOP_SCALE_DRAWABLES);
    const figures = new Set(fractions.map(percent));

    expect(isStrictlyIncreasing(fractions)).toBe(true);
    expect(figures.size).toBeGreaterThanOrEqual(10);
    for (const fraction of fractions) {
      expect(fraction).toBeGreaterThan(LOAD_MIMICS_END);
      expect(fraction).toBeLessThanOrEqual(LOAD_SHADERS_END);
    }

    // And a sweep cut off by its deadline part way through still reads as
    // progress rather than as a hang, which is the case the old arithmetic could
    // not survive: a third of the way in it printed 94%.
    const third = fractions[Math.floor(fractions.length / 3)] as number;
    expect(percent(third)).toBeLessThan(70);
    expect(percent(third)).toBeGreaterThan(percent(LOAD_MIMICS_END));
  });
});
