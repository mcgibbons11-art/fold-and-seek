import * as THREE from "three/webgpu";
import type { PropPlacement } from "../placements";
import { swatchRole, type PropContext } from "./context";
import { chamferedBox, lathe } from "./geometry";
import { BULB_MATERIAL, LAMPSHADE_MATERIAL } from "./materials";

/**
 * The lamp family (§10.2 asks for at least eight). Every lamp is a metal frame,
 * a cloth or glass diffuser and an emissive bulb, so the same silhouette
 * vocabulary repeats at floor, table, wall and ceiling height and a Mimic can
 * plausibly claim any of those heights.
 *
 * Swatch roles: 0 = frame metal, 1 = shade cloth.
 */

const LAMP_BODY_SEGMENTS = 20;

export function buildFloorLamp(ctx: PropContext, placement: PropPlacement): void {
  const frame = ctx.materials.get(swatchRole(placement, 0, "brass_tarnished_01"));
  const shade = ctx.materials.get(LAMPSHADE_MATERIAL);
  const bulb = ctx.materials.get(BULB_MATERIAL);
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("lamp.floor.base", () =>
      lathe(
        [
          [0, 0],
          [0.21, 0],
          [0.222, 0.016],
          [0.2, 0.038],
          [0.06, 0.056],
          [0.034, 0.08],
          [0, 0.08],
        ],
        LAMP_BODY_SEGMENTS + 8,
      ),
    ),
    frame,
  );
  b.part(
    ctx.geometry.get("lamp.floor.pole", () => new THREE.CylinderGeometry(0.018, 0.024, 1.42, 12)),
    frame,
    { y: 0.79 },
  );
  b.part(
    ctx.geometry.get("lamp.floor.collar", () => new THREE.TorusGeometry(0.029, 0.01, 6, 18)),
    frame,
    { y: 1.36, rx: -Math.PI / 2 },
  );
  b.part(
    ctx.geometry.get("lamp.bulb", () => new THREE.SphereGeometry(0.052, 14, 9)),
    bulb,
    { y: 1.5 },
    { shadow: false, receive: false },
  );
  b.part(
    ctx.geometry.get("lamp.floor.shade", () => new THREE.CylinderGeometry(0.2, 0.29, 0.33, 26, 1, true)),
    shade,
    { y: 1.54 },
    { shadow: false, receive: false },
  );
  b.part(
    ctx.geometry.get("lamp.floor.shadeRing", () => new THREE.TorusGeometry(0.2, 0.008, 6, 26)),
    frame,
    { y: 1.705, rx: -Math.PI / 2 },
    { shadow: false },
  );
}

export function buildTableLamp(ctx: PropContext, placement: PropPlacement): void {
  const frame = ctx.materials.get(swatchRole(placement, 0, "brass_aged_02"));
  const body = ctx.materials.get(swatchRole(placement, 1, "ceramic_celadon_02"));
  const shade = ctx.materials.get(LAMPSHADE_MATERIAL);
  const bulb = ctx.materials.get(BULB_MATERIAL);
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("lamp.table.foot", () =>
      lathe(
        [
          [0, 0],
          [0.115, 0],
          [0.12, 0.012],
          [0.1, 0.03],
          [0.055, 0.05],
          [0, 0.05],
        ],
        LAMP_BODY_SEGMENTS,
      ),
    ),
    frame,
  );
  b.part(
    ctx.geometry.get("lamp.table.body", () =>
      lathe(
        [
          [0, 0.05],
          [0.072, 0.05],
          [0.086, 0.12],
          [0.07, 0.22],
          [0.036, 0.28],
          [0.03, 0.33],
          [0, 0.33],
        ],
        LAMP_BODY_SEGMENTS,
      ),
    ),
    body,
  );
  b.part(
    ctx.geometry.get("lamp.bulb.small", () => new THREE.SphereGeometry(0.04, 12, 8)),
    bulb,
    { y: 0.4 },
    { shadow: false, receive: false },
  );
  b.part(
    ctx.geometry.get("lamp.table.shade", () => new THREE.CylinderGeometry(0.13, 0.18, 0.21, 22, 1, true)),
    shade,
    { y: 0.42 },
    { shadow: false, receive: false },
  );
  b.part(
    ctx.geometry.get("lamp.table.finial", () => new THREE.SphereGeometry(0.022, 10, 7)),
    frame,
    { y: 0.545 },
    { shadow: false },
  );
}

export function buildWallSconce(ctx: PropContext, placement: PropPlacement): void {
  const frame = ctx.materials.get(swatchRole(placement, 0, "brass_aged_02"));
  const shade = ctx.materials.get(LAMPSHADE_MATERIAL);
  const bulb = ctx.materials.get(BULB_MATERIAL);
  const b = ctx.batcher;

  b.part(ctx.geometry.get("sconce.plate", () => chamferedBox(0.11, 0.2, 0.035, 0.012)), frame, { z: 0.018 });
  b.part(
    ctx.geometry.get("sconce.arm", () => new THREE.CylinderGeometry(0.014, 0.016, 0.2, 8)),
    frame,
    { y: 0.03, z: 0.12, rx: Math.PI / 2 },
  );
  b.part(
    ctx.geometry.get("sconce.cup", () =>
      lathe(
        [
          [0, 0],
          [0.03, 0],
          [0.045, 0.03],
          [0.05, 0.06],
          [0.046, 0.062],
          [0.026, 0.03],
          [0, 0.026],
        ],
        14,
      ),
    ),
    frame,
    { y: 0.03, z: 0.22 },
  );
  b.part(
    ctx.geometry.get("sconce.shade", () => new THREE.CylinderGeometry(0.075, 0.1, 0.13, 16, 1, true)),
    shade,
    { y: 0.13, z: 0.22 },
    { shadow: false, receive: false },
  );
  b.part(
    ctx.geometry.get("lamp.bulb.small", () => new THREE.SphereGeometry(0.04, 12, 8)),
    bulb,
    { y: 0.12, z: 0.22 },
    { shadow: false, receive: false },
  );
}

export function buildPendantLamp(ctx: PropContext, placement: PropPlacement): void {
  const frame = ctx.materials.get(swatchRole(placement, 0, "brass_tarnished_01"));
  const shade = ctx.materials.get(LAMPSHADE_MATERIAL);
  const bulb = ctx.materials.get(BULB_MATERIAL);
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("pendant.rod", () => new THREE.CylinderGeometry(0.01, 0.01, 0.6, 7)),
    frame,
    { y: 0.3 },
    { shadow: false },
  );
  b.part(
    ctx.geometry.get("pendant.canopy", () =>
      lathe(
        [
          [0, 0.6],
          [0.055, 0.6],
          [0.06, 0.575],
          [0.03, 0.56],
          [0, 0.56],
        ],
        14,
      ),
    ),
    frame,
    {},
    { shadow: false },
  );
  b.part(
    ctx.geometry.get("pendant.dome", () =>
      lathe(
        [
          [0, 0.03],
          [0.06, 0.028],
          [0.14, 0.005],
          [0.2, -0.06],
          [0.225, -0.15],
          [0.222, -0.156],
          [0.196, -0.068],
          [0.135, -0.005],
          [0.06, 0.018],
          [0, 0.02],
        ],
        22,
      ),
    ),
    shade,
    { y: 0.02 },
    { shadow: false, receive: false },
  );
  b.part(
    ctx.geometry.get("lamp.bulb", () => new THREE.SphereGeometry(0.052, 14, 9)),
    bulb,
    { y: -0.09 },
    { shadow: false, receive: false },
  );
}

/** Workshop task light: clamp, two arms and a spun steel head (§10.2 zone F). */
export function buildTaskLight(ctx: PropContext, placement: PropPlacement): void {
  const frame = ctx.materials.get(swatchRole(placement, 0, "iron_dark_03"));
  const bulb = ctx.materials.get(BULB_MATERIAL);
  const b = ctx.batcher;

  b.part(ctx.geometry.get("task.clamp", () => chamferedBox(0.09, 0.07, 0.12, 0.014)), frame, { y: 0.035 });
  b.part(
    ctx.geometry.get("task.arm", () => new THREE.CylinderGeometry(0.011, 0.011, 0.44, 7)),
    frame,
    { y: 0.26, z: 0.06, rx: 0.42 },
  );
  b.part(
    ctx.geometry.get("task.joint", () => new THREE.SphereGeometry(0.024, 10, 7)),
    frame,
    { y: 0.46, z: 0.15 },
  );
  b.part(
    ctx.geometry.get("task.arm", () => new THREE.CylinderGeometry(0.011, 0.011, 0.44, 7)),
    frame,
    { y: 0.6, z: 0.31, rx: -0.9 },
  );
  b.part(
    ctx.geometry.get("task.head", () =>
      lathe(
        [
          [0, 0],
          [0.03, 0.005],
          [0.06, 0.05],
          [0.105, 0.12],
          [0.101, 0.124],
          [0.056, 0.056],
          [0.026, 0.014],
          [0, 0.012],
        ],
        18,
      ),
    ),
    frame,
    { y: 0.72, z: 0.48, rx: 2.3 },
  );
  b.part(
    ctx.geometry.get("lamp.bulb.small", () => new THREE.SphereGeometry(0.04, 12, 8)),
    bulb,
    { y: 0.7, z: 0.46 },
    { shadow: false, receive: false },
  );
}

export function buildCandlestick(ctx: PropContext, placement: PropPlacement): void {
  const frame = ctx.materials.get(swatchRole(placement, 0, "brass_tarnished_01"));
  const wax = ctx.materials.get(swatchRole(placement, 1, "porcelain_cream_01"));
  const bulb = ctx.materials.get(BULB_MATERIAL);
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("candle.stand", () =>
      lathe(
        [
          [0, 0],
          [0.062, 0],
          [0.066, 0.009],
          [0.05, 0.024],
          [0.018, 0.032],
          [0.014, 0.13],
          [0.03, 0.16],
          [0.026, 0.175],
          [0.016, 0.181],
          [0, 0.179],
        ],
        16,
      ),
    ),
    frame,
  );
  b.part(
    ctx.geometry.get("candle.stick", () => new THREE.CylinderGeometry(0.014, 0.015, 0.2, 12)),
    wax,
    { y: 0.28 },
  );
  b.part(
    ctx.geometry.get("candle.flame", () => new THREE.ConeGeometry(0.011, 0.05, 8)),
    bulb,
    { y: 0.405 },
    { shadow: false, receive: false },
  );
}
