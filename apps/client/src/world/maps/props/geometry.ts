import * as THREE from "three/webgpu";
import { DisposalBag } from "../../../engine/DisposalBag";

/**
 * Geometry helpers for the shop prop library.
 *
 * The art direction forbids sharp primitive cubes (§17.1, §17.6), so every
 * box-like part is extruded from a rounded profile with a real bevel and every
 * turned part comes from a lathe profile. Bevels run slightly wider than strict
 * realism, which is what gives the miniature-diorama read its edge highlights.
 */

export type LatheProfile = readonly (readonly [number, number])[];

const MIN_RADIUS = 0.0005;

export function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const r = Math.max(Math.min(radius, halfWidth * 0.98, halfHeight * 0.98), MIN_RADIUS);
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + r, -halfHeight);
  shape.lineTo(halfWidth - r, -halfHeight);
  shape.absarc(halfWidth - r, -halfHeight + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(halfWidth, halfHeight - r);
  shape.absarc(halfWidth - r, halfHeight - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-halfWidth + r, halfHeight);
  shape.absarc(-halfWidth + r, halfHeight - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-halfWidth, -halfHeight + r);
  shape.absarc(-halfWidth + r, -halfHeight + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/**
 * Superellipse cross-section. An exponent near 2 is an ellipse and a large one
 * approaches a rounded rectangle; the shop uses the range in between for
 * plinths, cabinet ornaments and Mimic-plausible silhouettes (§7.11).
 */
export function superellipseShape(width: number, height: number, exponent: number, segments = 24): THREE.Shape {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const power = 2 / Math.max(exponent, 0.5);
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = Math.sign(cos) * Math.abs(cos) ** power * halfWidth;
    const y = Math.sign(sin) * Math.abs(sin) ** power * halfHeight;
    if (i === 0) {
      shape.moveTo(x, y);
    } else {
      shape.lineTo(x, y);
    }
  }
  shape.closePath();
  return shape;
}

export interface ExtrudeOptions {
  readonly bevel: number;
  readonly curveSegments?: number;
  readonly bevelSegments?: number;
}

/**
 * Extrudes a profile along local Z with a chamfer on the cap edges. The result
 * measures shapeWidth x shapeHeight x depth, centred on its own origin.
 */
export function extrudeProfile(shape: THREE.Shape, depth: number, options: ExtrudeOptions): THREE.ExtrudeGeometry {
  const bevel = Math.max(Math.min(options.bevel, depth * 0.24), MIN_RADIUS);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(depth - 2 * bevel, 0.001),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: options.bevelSegments ?? 2,
    curveSegments: options.curveSegments ?? 3,
    steps: 1,
  });
  geometry.translate(0, 0, -(depth / 2 - bevel));
  return geometry;
}

/** Box with a chamfer on every edge: width on X, height on Y, depth on Z. */
export function chamferedBox(
  width: number,
  height: number,
  depth: number,
  bevel = 0.015,
  cornerRadius = bevel * 1.6,
): THREE.ExtrudeGeometry {
  const b = Math.min(bevel, width * 0.24, height * 0.24, depth * 0.24);
  const shape = roundedRectShape(width - 2 * b, height - 2 * b, Math.max(cornerRadius - b, MIN_RADIUS));
  return extrudeProfile(shape, depth, { bevel: b });
}

/** Chamfered box lying flat: width on X, depth on Z, thickness on Y. */
export function chamferedSlab(width: number, thickness: number, depth: number, bevel = 0.012): THREE.BufferGeometry {
  const geometry = chamferedBox(width, depth, thickness, bevel);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** Superellipse column, chamfered, standing on Y. */
export function superellipseColumn(
  width: number,
  depth: number,
  height: number,
  exponent = 3.2,
  bevel = 0.02,
): THREE.BufferGeometry {
  const geometry = extrudeProfile(superellipseShape(width, depth, exponent, 20), height, { bevel, curveSegments: 2 });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function lathe(profile: LatheProfile, segments = 24): THREE.LatheGeometry {
  const points = profile.map(([radius, height]) => new THREE.Vector2(Math.max(radius, 0), height));
  return new THREE.LatheGeometry(points, segments);
}

/**
 * Vertical curtain panel: a run of soft folds swept as a lathe section so the
 * cloth catches the moonlight along its length rather than reading as a plane.
 */
export function curtainPanel(width: number, height: number, folds: number, depth: number): THREE.BufferGeometry {
  const columns = Math.max(folds, 2) * 4;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= columns; i += 1) {
    const t = i / columns;
    const phase = t * Math.PI * 2 * folds;
    const x = (t - 0.5) * width;
    const z = Math.cos(phase) * depth * 0.5;
    const slope = -Math.sin(phase) * depth * 0.5 * ((Math.PI * 2 * folds) / width);
    const normal = new THREE.Vector3(-slope, 0, 1).normalize();
    // Slight taper: the hem hangs a touch wider than the heading.
    for (let row = 0; row <= 1; row += 1) {
      const y = row === 0 ? 0 : height;
      const spread = row === 0 ? 1.06 : 1;
      positions.push(x * spread, y, z * spread);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(t, row);
    }
  }

  for (let i = 0; i < columns; i += 1) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Shared geometry pool. Repeated families must hand the batcher the same
 * BufferGeometry instance or nothing can be instanced, so every part asks for
 * geometry by key rather than building its own.
 */
export class GeometryCache {
  private readonly cache = new Map<string, THREE.BufferGeometry>();

  constructor(private readonly bag: DisposalBag) {}

  get(key: string, factory: () => THREE.BufferGeometry): THREE.BufferGeometry {
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = this.bag.add(factory());
    this.cache.set(key, created);
    return created;
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Snaps an authored dimension to a step. Repeated families are only
 * instanceable when their geometry is identical, so a picture frame authored
 * at 0.34 m and one at 0.36 m must resolve to the same cached geometry.
 */
export function quantize(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** Deterministic jitter source: the same map must build identically every run. */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
