import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as THREE from "three/webgpu";
import { DisposalBag } from "../../../engine/DisposalBag";

/**
 * Collects every prop part and emits the smallest set of draw calls that can
 * still express the shop.
 *
 * A part that repeats across the map (a book, a parcel, a picture rail) shares
 * one geometry and one material, so all of its copies collapse into a single
 * instanced draw. A part belonging to a hero prop stays an individual mesh,
 * because only hero objects cast dynamic shadows (§17.5, §18.4) and an
 * instanced batch can only cast as a whole.
 *
 * Batches are kept apart by asset tier, so a quality tier can drop the
 * background layer without disturbing anything a player can accuse.
 */

export type PropLayer = "hero" | "standard" | "background";

export const PROP_LAYERS: readonly PropLayer[] = ["hero", "standard", "background"];

export interface PartTransform {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly rx?: number;
  readonly ry?: number;
  readonly rz?: number;
  readonly sx?: number;
  readonly sy?: number;
  readonly sz?: number;
}

export interface PartOptions {
  /** Hero parts cast by default; set false for bulbs, glass and thin trim. */
  readonly shadow?: boolean;
  readonly receive?: boolean;
}

/** Instance count at or below which a bucket is merged rather than instanced. */
const MERGE_THRESHOLD = 3;

export interface BatchStats {
  readonly parts: number;
  readonly heroMeshes: number;
  readonly instancedMeshes: number;
  /** Static meshes built by baking sparse batches together per material. */
  readonly mergedMeshes: number;
  /** Meshes the renderer submits for the map, before culling. */
  readonly drawCalls: number;
  readonly triangles: number;
}

interface MergeQueue {
  readonly layer: PropLayer;
  readonly material: THREE.Material;
  readonly structure: boolean;
  readonly geometries: THREE.BufferGeometry[];
}

interface Bucket {
  readonly layer: PropLayer;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  /** Shell geometry, which a disguise mounts against rather than hides among. */
  readonly structure: boolean;
  readonly matrices: THREE.Matrix4[];
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index !== null) {
    return index.count / 3;
  }
  const position = geometry.getAttribute("position");
  return position === undefined ? 0 : position.count / 3;
}

export class PropBatcher {
  readonly layers: Readonly<Record<PropLayer, THREE.Group>>;

  private readonly buckets = new Map<string, Bucket>();
  private readonly base = new THREE.Matrix4();
  private readonly local = new THREE.Matrix4();
  private readonly euler = new THREE.Euler();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();

  private layer: PropLayer = "standard";
  private hero = false;
  private structure = false;
  private heroGroup: THREE.Group | null = null;
  private partCount = 0;
  private heroMeshCount = 0;
  private triangles = 0;
  /** Build order is deterministic, so this is a stable mesh id (§24.6). */
  private meshCount = 0;

  constructor(
    root: THREE.Group,
    private readonly bag: DisposalBag,
  ) {
    const groups = {} as Record<PropLayer, THREE.Group>;
    for (const layer of PROP_LAYERS) {
      const group = new THREE.Group();
      group.name = `layer:${layer}`;
      root.add(group);
      groups[layer] = group;
    }
    this.layers = groups;
  }

  /**
   * Opens a prop. Every part placed until `end` is expressed in the prop's own
   * space, which is what lets a family share one authored builder.
   */
  begin(
    name: string,
    position: readonly [number, number, number],
    rotationY: number,
    hero: boolean,
    scale = 1,
    layer: PropLayer = "standard",
    structure = false,
  ): void {
    this.euler.set(0, rotationY, 0);
    this.quaternion.setFromEuler(this.euler);
    this.base.compose(
      this.position.set(position[0], position[1], position[2]),
      this.quaternion,
      this.scale.set(scale, scale, scale),
    );
    this.layer = layer;
    this.hero = hero;
    this.structure = structure;
    if (hero) {
      const group = new THREE.Group();
      group.name = name;
      this.layers[layer].add(group);
      this.heroGroup = group;
    } else {
      this.heroGroup = null;
    }
  }

  part(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    transform: PartTransform = {},
    options: PartOptions = {},
  ): void {
    this.euler.set(transform.rx ?? 0, transform.ry ?? 0, transform.rz ?? 0);
    this.local.compose(
      this.position.set(transform.x ?? 0, transform.y ?? 0, transform.z ?? 0),
      this.quaternion.setFromEuler(this.euler),
      this.scale.set(transform.sx ?? 1, transform.sy ?? 1, transform.sz ?? 1),
    );
    this.local.premultiply(this.base);
    this.partCount += 1;
    this.triangles += triangleCount(geometry);

    // A hero part that does not cast is worth nothing as an individual mesh:
    // it batches with the rest of its family and costs one draw call less in
    // both the beauty pass and every shadow pass.
    const heroGroup = this.heroGroup;
    if (this.hero && heroGroup !== null && (options.shadow ?? true)) {
      const mesh = new THREE.Mesh(geometry, material);
      this.local.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.castShadow = options.shadow ?? true;
      mesh.receiveShadow = options.receive ?? true;
      mesh.userData["swatchId"] = material.userData["swatchId"];
      this.publish(mesh, heroGroup);
      this.heroMeshCount += 1;
      return;
    }

    // A hero prop's non-casting trim batches with the standard layer rather
    // than with its own, so a brass collar shared with fifty other lamps is
    // still one draw call.
    const layer: PropLayer = this.hero ? "standard" : this.layer;
    const key = `${layer}|${String(this.structure)}|${geometry.uuid}|${material.uuid}`;
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      this.buckets.set(key, {
        layer,
        geometry,
        material,
        structure: this.structure,
        matrices: [this.local.clone()],
      });
      return;
    }
    bucket.matrices.push(this.local.clone());
  }

  end(): void {
    this.hero = false;
    this.structure = false;
    this.heroGroup = null;
    this.layer = "standard";
  }

  /**
   * Names a mesh and parents it. The name is `parentGroup#index` with a
   * build-order index, matching the test room, so a saved disguise anchored to
   * a surface still resolves that surface on the next load (§24.6).
   *
   * `surfaceKind` marks the shell. A disguise mounting on a wall has to tell a
   * wall from a table leg, and only the map knows which is which.
   */
  private publish(mesh: THREE.Mesh, parent: THREE.Object3D, structure = this.structure): void {
    mesh.name = `${parent.name.length > 0 ? parent.name : "shop"}#${String(this.meshCount)}`;
    this.meshCount += 1;
    if (structure) {
      mesh.userData["surfaceKind"] = "structure";
    }
    parent.add(mesh);
  }

  /**
   * Realises the batched parts. Called once, after every zone has been placed,
   * because a bucket's instance count is only known when the map is complete.
   */
  finalize(): BatchStats {
    let instancedMeshes = 0;
    const merges = new Map<string, MergeQueue>();

    for (const bucket of this.buckets.values()) {
      const first = bucket.matrices[0];
      if (first === undefined) {
        continue;
      }
      const parent = this.layers[bucket.layer];

      // A part that repeats only once or twice is not worth an instanced draw.
      // Baking its transform into the vertices lets every such part sharing a
      // material collapse into a single static mesh, which is where most of
      // the map's draw-call budget is won.
      if (bucket.matrices.length <= MERGE_THRESHOLD) {
        const key = `${bucket.layer}|${String(bucket.structure)}|${bucket.material.uuid}`;
        const queue = merges.get(key) ?? {
          layer: bucket.layer,
          material: bucket.material,
          structure: bucket.structure,
          geometries: [],
        };
        for (const matrix of bucket.matrices) {
          // Merging needs one indexing scheme across the whole queue, and the
          // library mixes indexed lathes with non-indexed extrusions.
          const baked = bucket.geometry.clone().applyMatrix4(matrix);
          queue.geometries.push(baked.getIndex() === null ? baked : baked.toNonIndexed());
        }
        merges.set(key, queue);
        continue;
      }

      const instanced = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.matrices.length);
      for (let i = 0; i < bucket.matrices.length; i += 1) {
        const matrix = bucket.matrices[i];
        if (matrix !== undefined) {
          instanced.setMatrixAt(i, matrix);
        }
      }
      instanced.instanceMatrix.needsUpdate = true;
      instanced.castShadow = false;
      instanced.receiveShadow = true;
      instanced.userData["swatchId"] = bucket.material.userData["swatchId"];
      instanced.computeBoundingSphere();
      this.bag.add(instanced);
      this.publish(instanced, parent, bucket.structure);
      instancedMeshes += 1;
    }

    const mergedMeshes = this.buildMerged(merges);
    this.buckets.clear();

    return {
      parts: this.partCount,
      heroMeshes: this.heroMeshCount,
      instancedMeshes,
      mergedMeshes,
      drawCalls: this.heroMeshCount + instancedMeshes + mergedMeshes,
      triangles: Math.round(this.triangles),
    };
  }

  private buildMerged(merges: ReadonlyMap<string, MergeQueue>): number {
    let count = 0;
    for (const queue of merges.values()) {
      const merged = mergeGeometries(queue.geometries, false);
      for (const geometry of queue.geometries) {
        geometry.dispose();
      }
      if (merged === null) {
        continue;
      }
      merged.computeBoundingSphere();
      this.bag.add(merged);

      const mesh = new THREE.Mesh(merged, queue.material);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData["swatchId"] = queue.material.userData["swatchId"];
      this.publish(mesh, this.layers[queue.layer], queue.structure);
      count += 1;
    }
    return count;
  }
}
