import * as THREE from "three/webgpu";

import type { PaintLayer } from "../../paint/PaintLayer";
import { baseEmissiveOf } from "../../paint/PaintMaterialBinder";
import { paintTargetOfObject, paintTileTransform } from "../../paint/paintTargets";
import type { MimicVisual } from "./MimicVisual";

/**
 * Collapses a Mimic body into one drawn mesh per material.
 *
 * A body is about forty meshes: nineteen shells, seventeen bellows, up to eight
 * panels, two eyes and a shutter. That is the right shape for the Forge, where
 * every part is picked, dragged and recoloured on its own, and it is the wrong
 * shape for the hunt, where four locked disguises stand in a shop that is
 * already spending most of its draw-call budget. Nothing about a disguise is
 * addressed per part: it is shot through its focus proxy's bounds and the
 * reticle picks analytically against a box, never against a mesh, so the parts
 * only have to be *drawn*, and they can be drawn together.
 *
 * The body's own parts stay in the scene graph under a hidden group rather than
 * being taken out of it. They are what the pose is applied to, what the merge
 * reads, and what `Box3.setFromObject` measures, and `Box3` ignores visibility,
 * so a merged disguise publishes exactly the bounds an unmerged one publishes.
 * The renderer skips the whole hidden subtree in one test.
 *
 * Because every part moves with its bone, there is no static half to merge once
 * and articulating half to leave alone. The merge therefore bakes each part's
 * pose-space transform into vertices and re-bakes on a pose change, writing into
 * buffers that are allocated only when the set of parts itself changes.
 */

/**
 * Where one part's vertices live inside its group's buffers, and the paint
 * atlas tile its UVs are baked into.
 */
interface MergedPart {
  readonly mesh: THREE.Mesh;
  readonly vertexOffset: number;
  readonly vertexCount: number;
  readonly tile: ReturnType<typeof paintTileTransform> | null;
}

/** What a part has to keep for the merged buffers to still describe it. */
interface PartSignature {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  castShadow: boolean;
  receiveShadow: boolean;
}

interface MergedGroup {
  /** The material the parts were wearing, and what the merged mesh wears unpainted. */
  readonly source: THREE.Material;
  /** True when every part in the group carries a paint target of its own. */
  readonly paintable: boolean;
  readonly mesh: THREE.Mesh;
  parts: readonly MergedPart[];
}

/**
 * The subset of a material the paint layer needs. This is the same contract
 * `PaintMaterialBinder` binds a single part against; a merged mesh needs its own
 * because it wears the whole atlas rather than one tile of it.
 */
interface ColoredMaterial extends THREE.Material {
  color: THREE.Color;
  map: THREE.Texture | null;
  roughness?: number;
  metalness?: number;
  roughnessMap?: THREE.Texture | null;
  metalnessMap?: THREE.Texture | null;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  emissiveMap?: THREE.Texture | null;
}

function isColored(material: THREE.Material): material is ColoredMaterial {
  return (material as Partial<ColoredMaterial>).color instanceof THREE.Color;
}

/**
 * Where the body's own parts are put while the merge stands in for them.
 *
 * A `Raycaster` tests layers but ignores visibility, so hiding the parts is not
 * enough on its own: the Forge's eyedropper reads the room, a peer's disguise is
 * a legitimate thing to sample a colour from, and a part and the merged mesh
 * drawn over it are the same surface at the same distance. Left on the picking
 * layer they would answer that ray about half the time, with the swatch colour
 * underneath the paint rather than the paint. Nothing renders or picks on this
 * layer, so the merged mesh answers alone.
 */
const UNPICKED_LAYER = 1;

const scratchColor = new THREE.Color();
const scratchSize = new THREE.Vector3();
const scratchBounds = new THREE.Box3();

/**
 * A source attribute's raw floats. Every part of a Mimic is built here or by a
 * three primitive, so all of them are plain float buffers; anything else is a
 * change to the body that this has to be told about rather than guess at.
 */
function floats(
  geometry: THREE.BufferGeometry,
  name: "position" | "normal" | "uv",
  mesh: THREE.Mesh,
): Float32Array {
  const attribute = geometry.getAttribute(name);
  const array = (attribute as Partial<THREE.BufferAttribute>).array;
  if (!(array instanceof Float32Array)) {
    throw new Error(`Mimic part ${mesh.name} stores ${name} in a buffer the merge cannot read`);
  }
  return array;
}

function dynamicAttribute(length: number, itemSize: number): THREE.BufferAttribute {
  const attribute = new THREE.BufferAttribute(new Float32Array(length), itemSize);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

export class MergedMimicBody {
  /** Drawn meshes, one per material. Parented to the body's own root. */
  readonly group = new THREE.Group();

  private readonly visual: MimicVisual;
  /** The body's real parts, hidden from the renderer and kept for measurement. */
  private readonly source = new THREE.Group();
  private readonly groups = new Map<string, MergedGroup>();
  /** One paint clone per source material, so a pose change never mints one. */
  private readonly paintClones = new Map<string, THREE.Material>();
  /** Whether those clones were cut carrying the layer's glow atlas. */
  private paintEmissiveBound = false;
  private readonly rootInverse = new THREE.Matrix4();
  private readonly partMatrix = new THREE.Matrix4();
  private readonly normalMatrix = new THREE.Matrix3();
  private paint: PaintLayer | null = null;
  /** The parts found by the last collection, reused so a re-bake allocates nothing. */
  private readonly collected: THREE.Mesh[] = [];
  /** The part set the current buffers were laid out for. */
  private layout: PartSignature[] = [];

  constructor(visual: MimicVisual) {
    this.visual = visual;
    this.source.name = "mimic_parts";
    this.source.visible = false;
    for (const child of [...visual.root.children]) {
      this.source.add(child);
    }
    this.source.traverse((object) => {
      object.layers.set(UNPICKED_LAYER);
    });
    this.group.name = "mimic_merged";
    visual.root.add(this.source);
    visual.root.add(this.group);
  }

  /** Meshes the renderer submits for this body, which is the whole point. */
  get drawCount(): number {
    return this.groups.size;
  }

  /**
   * Re-bakes the body at its current pose. Cheap enough for the rate a creeping
   * hider republishes at: it rewrites vertex buffers and allocates nothing
   * unless the set of parts changed, which happens on a panel deploying, a
   * swatch changing or a shadow setting changing, never on a move.
   */
  refresh(): void {
    this.visual.root.updateWorldMatrix(true, true);
    this.rootInverse.copy(this.visual.root.matrixWorld).invert();

    if (this.collect()) {
      this.rebuild(this.collected);
      this.bindPaint();
    }
    for (const group of this.groups.values()) {
      this.bake(group);
    }
  }

  /**
   * Dresses the merged meshes in a paint layer, or hands their own materials
   * back. Pass the same layer instance for the life of the body: a different one
   * throws the clones away, and a clone is a shader the backend has to build.
   */
  setPaint(layer: PaintLayer | null): void {
    if (layer !== this.paint) {
      for (const group of this.groups.values()) {
        group.mesh.material = group.source;
      }
      for (const clone of this.paintClones.values()) {
        clone.dispose();
      }
      this.paintClones.clear();
      this.paintEmissiveBound = false;
      this.paint = layer;
    }
    this.bindPaint();
  }

  /** Gives the body its parts back and drops everything the merge allocated. */
  dispose(): void {
    for (const group of this.groups.values()) {
      group.mesh.geometry.dispose();
    }
    this.groups.clear();
    for (const clone of this.paintClones.values()) {
      clone.dispose();
    }
    this.paintClones.clear();
    this.group.clear();
    this.group.removeFromParent();
    this.source.traverse((object) => {
      object.layers.set(0);
    });
    for (const child of [...this.source.children]) {
      this.visual.root.add(child);
    }
    this.source.removeFromParent();
    this.collected.length = 0;
    this.layout = [];
    this.paint = null;
  }

  /**
   * Gathers every part the renderer would have drawn into `collected`, and says
   * whether the buffers have to be laid out again. A move never changes the
   * answer, so the common case allocates nothing at all.
   */
  private collect(): boolean {
    this.collected.length = 0;
    this.gather(this.source);

    let changed = this.layout.length !== this.collected.length;
    for (let i = 0; i < this.collected.length && !changed; i++) {
      const mesh = this.collected[i];
      const previous = this.layout[i];
      changed =
        mesh === undefined ||
        previous === undefined ||
        previous.mesh !== mesh ||
        previous.geometry !== mesh.geometry ||
        previous.material !== mesh.material ||
        previous.castShadow !== mesh.castShadow ||
        previous.receiveShadow !== mesh.receiveShadow;
    }
    if (!changed) return false;

    this.layout = this.collected.map((mesh) => ({
      mesh,
      geometry: mesh.geometry,
      material: mesh.material as THREE.Material,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
    }));
    return true;
  }

  private gather(object: THREE.Object3D): void {
    for (const child of object.children) {
      if (!child.visible) continue;
      if (child instanceof THREE.Mesh) {
        if (Array.isArray(child.material)) {
          throw new Error(`Mimic part ${child.name} carries a material array, which cannot be merged`);
        }
        this.collected.push(child);
      }
      this.gather(child);
    }
  }

  /**
   * Lays out one merged mesh per material. Shadow flags join the key because a
   * merged mesh casts as a whole: the eye shutter shares graphite with the
   * bellows and is the one part of the body that deliberately casts nothing.
   */
  private rebuild(parts: readonly THREE.Mesh[]): void {
    const wanted = new Map<string, THREE.Mesh[]>();
    for (const mesh of parts) {
      const material = mesh.material as THREE.Material;
      const paintable = paintTargetOfObject(mesh) !== null;
      const key = [
        material.uuid,
        mesh.castShadow ? "1" : "0",
        mesh.receiveShadow ? "1" : "0",
        paintable ? "1" : "0",
      ].join("|");
      const existing = wanted.get(key);
      if (existing === undefined) {
        wanted.set(key, [mesh]);
      } else {
        existing.push(mesh);
      }
    }

    for (const [key, group] of this.groups) {
      if (wanted.has(key)) continue;
      group.mesh.removeFromParent();
      group.mesh.geometry.dispose();
      this.groups.delete(key);
    }

    for (const [key, meshes] of wanted) {
      const first = meshes[0];
      if (first === undefined) continue;
      let group = this.groups.get(key);
      if (group === undefined) {
        const source = first.material as THREE.Material;
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), source);
        // The shadow flags are in the name as well as the key, because two
        // groups can share a material and differ only in them.
        mesh.name = `mimic_merged_${source.name}_${first.castShadow ? "c" : ""}${
          first.receiveShadow ? "r" : ""
        }`;
        mesh.castShadow = first.castShadow;
        mesh.receiveShadow = first.receiveShadow;
        this.group.add(mesh);
        group = {
          source,
          paintable: paintTargetOfObject(first) !== null,
          mesh,
          parts: [],
        };
        this.groups.set(key, group);
      }
      group.parts = this.layoutGroup(group, meshes);
    }
  }

  /** Allocates a group's buffers for its parts and writes the merged index. */
  private layoutGroup(group: MergedGroup, meshes: readonly THREE.Mesh[]): readonly MergedPart[] {
    let vertexCount = 0;
    let indexCount = 0;
    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      const position = geometry.getAttribute("position");
      if (position === undefined) {
        throw new Error(`Mimic part ${mesh.name} has no position attribute to merge`);
      }
      if (geometry.getAttribute("normal") === undefined || geometry.getAttribute("uv") === undefined) {
        throw new Error(`Mimic part ${mesh.name} is missing the normals or UVs the merge writes`);
      }
      const index = geometry.getIndex();
      vertexCount += position.count;
      indexCount += index === null ? position.count : index.count;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", dynamicAttribute(vertexCount * 3, 3));
    merged.setAttribute("normal", dynamicAttribute(vertexCount * 3, 3));
    merged.setAttribute("uv", dynamicAttribute(vertexCount * 2, 2));

    const indices = new Uint32Array(indexCount);
    const parts: MergedPart[] = [];
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      const count = geometry.getAttribute("position").count;
      const index = geometry.getIndex();
      if (index === null) {
        // An extruded panel arrives unindexed while every lathe and every shell
        // is indexed, and one merged geometry cannot be both.
        for (let i = 0; i < count; i++) {
          indices[indexOffset + i] = vertexOffset + i;
        }
        indexOffset += count;
      } else {
        for (let i = 0; i < index.count; i++) {
          indices[indexOffset + i] = vertexOffset + index.getX(i);
        }
        indexOffset += index.count;
      }
      const target = paintTargetOfObject(mesh);
      parts.push({
        mesh,
        vertexOffset,
        vertexCount: count,
        tile: target === null ? null : paintTileTransform(target),
      });
      vertexOffset += count;
    }
    merged.setIndex(new THREE.BufferAttribute(indices, 1));

    group.mesh.geometry.dispose();
    group.mesh.geometry = merged;
    return parts;
  }

  /**
   * Writes every part's posed vertices into its group's buffers.
   *
   * UVs carry the paint atlas tile the part occupies, which is what lets one
   * merged mesh wear the whole atlas. Unmerged, each part gets a material clone
   * holding a view of its own tile; the offset and repeat that view applies are
   * exactly what is folded into the coordinates here, so a merged body samples
   * the same texels as an unmerged one.
   */
  private bake(group: MergedGroup): void {
    const geometry = group.mesh.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    const outPosition = position.array as Float32Array;
    const outNormal = normal.array as Float32Array;
    const outUv = uv.array as Float32Array;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (const part of group.parts) {
      this.partMatrix.copy(this.rootInverse).multiply(part.mesh.matrixWorld);
      this.normalMatrix.getNormalMatrix(this.partMatrix);
      const m = this.partMatrix.elements;
      const n = this.normalMatrix.elements;
      const source = part.mesh.geometry;
      const sourcePosition = floats(source, "position", part.mesh);
      const sourceNormal = floats(source, "normal", part.mesh);
      const sourceUv = floats(source, "uv", part.mesh);
      const tile = part.tile;
      const offsetU = tile === null ? 0 : tile.offsetU;
      const offsetV = tile === null ? 0 : tile.offsetV;
      const repeatU = tile === null ? 1 : tile.repeatU;
      const repeatV = tile === null ? 1 : tile.repeatV;

      // Thirteen thousand vertices a body, re-baked every time a creeping
      // hider republishes, is the one loop here worth writing against the
      // buffers rather than through Vector3.
      let out3 = part.vertexOffset * 3;
      let out2 = part.vertexOffset * 2;
      for (let i3 = 0, i2 = 0; i3 < part.vertexCount * 3; i3 += 3, i2 += 2) {
        const x = sourcePosition[i3] ?? 0;
        const y = sourcePosition[i3 + 1] ?? 0;
        const z = sourcePosition[i3 + 2] ?? 0;
        const px = m[0] * x + m[4] * y + m[8] * z + m[12];
        const py = m[1] * x + m[5] * y + m[9] * z + m[13];
        const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
        outPosition[out3] = px;
        outPosition[out3 + 1] = py;
        outPosition[out3 + 2] = pz;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (pz < minZ) minZ = pz;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        if (pz > maxZ) maxZ = pz;

        const nx0 = sourceNormal[i3] ?? 0;
        const ny0 = sourceNormal[i3 + 1] ?? 0;
        const nz0 = sourceNormal[i3 + 2] ?? 0;
        const nx = n[0] * nx0 + n[3] * ny0 + n[6] * nz0;
        const ny = n[1] * nx0 + n[4] * ny0 + n[7] * nz0;
        const nz = n[2] * nx0 + n[5] * ny0 + n[8] * nz0;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        outNormal[out3] = nx / length;
        outNormal[out3 + 1] = ny / length;
        outNormal[out3 + 2] = nz / length;

        outUv[out2] = offsetU + (sourceUv[i2] ?? 0) * repeatU;
        outUv[out2 + 1] = offsetV + (sourceUv[i2 + 1] ?? 0) * repeatV;

        out3 += 3;
        out2 += 2;
      }
    }

    position.needsUpdate = true;
    normal.needsUpdate = true;
    uv.needsUpdate = true;

    scratchBounds.min.set(minX, minY, minZ);
    scratchBounds.max.set(maxX, maxY, maxZ);
    geometry.boundingBox = (geometry.boundingBox ?? new THREE.Box3()).copy(scratchBounds);
    const sphere = geometry.boundingSphere ?? new THREE.Sphere();
    scratchBounds.getCenter(sphere.center);
    // Half the diagonal from the centre reaches every corner, so it reaches
    // every vertex. Culling wants a sphere that is never too small.
    sphere.radius = scratchBounds.getSize(scratchSize).length() / 2;
    geometry.boundingSphere = sphere;
  }

  /**
   * Puts the layer on every group that can wear it and tells the layer what
   * each part's material looks like, which is what an unpainted texel prints.
   */
  private bindPaint(): void {
    const layer = this.paint;
    const baseColors: [number, readonly [number, number, number]][] = [];
    const baseMaterials: [number, number, number][] = [];
    const baseEmissives: [number, readonly [number, number, number]][] = [];

    // A layer grows its glow atlas the first time a stroke asks for one, which
    // can happen after these clones were cut. The clones are keyed by source
    // material, so the only way to pick the map up is to cut them again, and
    // this flips once per layer at most.
    const wantEmissive = layer !== null && layer.hasEmissive;
    if (wantEmissive !== this.paintEmissiveBound) {
      for (const clone of this.paintClones.values()) {
        clone.dispose();
      }
      this.paintClones.clear();
      this.paintEmissiveBound = wantEmissive;
    }

    for (const group of this.groups.values()) {
      const source = group.source;
      if (layer === null || !group.paintable || !isColored(source)) {
        group.mesh.material = source;
        continue;
      }
      let clone = this.paintClones.get(source.uuid);
      if (clone === undefined) {
        clone = paintCloneOf(source, layer, wantEmissive);
        this.paintClones.set(source.uuid, clone);
      }
      group.mesh.material = clone;

      for (const part of group.parts) {
        const target = paintTargetOfObject(part.mesh);
        if (target === null) continue;
        source.color.getRGB(scratchColor, THREE.SRGBColorSpace);
        baseColors.push([target, [scratchColor.r, scratchColor.g, scratchColor.b]]);
        if (source.roughness !== undefined && source.metalness !== undefined) {
          baseMaterials.push([target, source.roughness, source.metalness]);
        }
        if (source.emissive !== undefined) {
          baseEmissives.push([target, baseEmissiveOf(source.emissive, source.emissiveIntensity)]);
        }
      }
    }

    if (layer === null) return;
    if (baseColors.length > 0) layer.setBaseColors(baseColors);
    if (baseMaterials.length > 0) layer.setBaseMaterials(baseMaterials);
    if (baseEmissives.length > 0) layer.setBaseEmissives(baseEmissives);
  }
}

/**
 * A material carrying the whole paint atlas. The swatch's own colour and
 * response move into the unpainted texels of the layer, so the scalars here go
 * to one: every one of these maps multiplies its scalar in three, and an empty
 * layer has to look exactly like the material underneath it.
 */
function paintCloneOf(
  source: ColoredMaterial,
  layer: PaintLayer,
  withEmissive: boolean,
): THREE.Material {
  const clone = source.clone() as ColoredMaterial;
  clone.name = `${source.name}+paint`;
  clone.color.setRGB(1, 1, 1);
  clone.map = layer.getTexture();
  if (clone.roughness !== undefined && clone.metalness !== undefined) {
    clone.roughness = 1;
    clone.metalness = 1;
    const response = layer.getMaterialTexture();
    clone.roughnessMap = response;
    clone.metalnessMap = response;
  }
  // The glow atlas carries the colour as well as the strength of the glow, so
  // the material's own emissive goes to white and lets the map decide both.
  if (withEmissive && clone.emissive !== undefined) {
    clone.emissive.setRGB(1, 1, 1);
    clone.emissiveIntensity = 1;
    clone.emissiveMap = layer.getEmissiveTexture();
  }
  return clone;
}
