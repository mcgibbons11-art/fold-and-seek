import * as THREE from "three/webgpu";

import type { PaintLayer } from "./PaintLayer";
import { paintTargetOfObject } from "./paintTargets";

/**
 * Hangs the paint atlas on the body without the Mimic having to know about it.
 *
 * MimicVisual hands every shell wearing the same swatch the same cached material
 * instance, which is what makes a material assignment free, and it reassigns
 * that instance whenever the player picks a new swatch. A per-part texture
 * cannot live on a shared instance, so the binder gives each painted part a
 * clone of its current material carrying that part's tile of the atlas, and
 * re-clones whenever it notices the Mimic has swapped the underlying material
 * back. `sync` is a reference comparison per part, cheap enough to call every
 * frame.
 *
 * The clone's own colour is white and the part's swatch colour becomes the
 * tile's base fill instead, so an unpainted body still shows its material and a
 * painted pixel shows exactly the colour that was painted.
 */

interface Binding {
  readonly mesh: THREE.Mesh;
  readonly target: number;
  /** What the Mimic had assigned when the clone was made. */
  source: THREE.Material;
  clone: THREE.Material;
}

interface ColoredMaterial extends THREE.Material {
  color: THREE.Color;
  map: THREE.Texture | null;
  /** Present on the standard and physical materials, absent on the rest. */
  roughness?: number;
  metalness?: number;
  roughnessMap?: THREE.Texture | null;
  metalnessMap?: THREE.Texture | null;
}

function isColored(material: THREE.Material): material is ColoredMaterial {
  return (material as Partial<ColoredMaterial>).color instanceof THREE.Color;
}

const scratchColor = new THREE.Color();

export class PaintMaterialBinder {
  private readonly layer: PaintLayer;
  private readonly getMeshes: () => readonly THREE.Object3D[];
  private readonly bindings = new Map<string, Binding>();
  private attached = false;

  constructor(layer: PaintLayer, getMeshes: () => readonly THREE.Object3D[]) {
    this.layer = layer;
    this.getMeshes = getMeshes;
  }

  /** Binds every paintable mesh and refreshes any the Mimic reassigned. */
  sync(): void {
    this.attached = true;
    const baseColors: [number, readonly [number, number, number]][] = [];
    const baseMaterials: [number, number, number][] = [];

    for (const object of this.getMeshes()) {
      if (!(object instanceof THREE.Mesh)) continue;
      const target = paintTargetOfObject(object);
      if (target === null) continue;
      const current = object.material;
      if (Array.isArray(current) || !isColored(current)) continue;

      const binding = this.bindings.get(object.uuid);
      if (binding !== undefined && binding.clone === current) continue;
      if (binding !== undefined) {
        binding.clone.dispose();
        this.bindings.delete(object.uuid);
      }

      const clone = current.clone();
      current.color.getRGB(scratchColor, THREE.SRGBColorSpace);
      baseColors.push([target, [scratchColor.r, scratchColor.g, scratchColor.b]]);

      clone.name = `${current.name}+paint`;
      clone.color.setRGB(1, 1, 1);
      clone.map = this.layer.getTargetTexture(target);

      // Every one of these maps MULTIPLIES its scalar in three, so the scalar
      // goes to one and the swatch's own value is baked into the unpainted
      // texel instead. That is what leaves an empty layer looking exactly like
      // the material underneath it.
      if (clone.roughness !== undefined && clone.metalness !== undefined) {
        baseMaterials.push([target, current.roughness ?? 1, current.metalness ?? 0]);
        clone.roughness = 1;
        clone.metalness = 1;
        const response = this.layer.getTargetMaterialTexture(target);
        clone.roughnessMap = response;
        clone.metalnessMap = response;
      }
      object.material = clone;
      this.bindings.set(object.uuid, { mesh: object, target, source: current, clone });
    }

    if (baseColors.length > 0) this.layer.setBaseColors(baseColors);
    if (baseMaterials.length > 0) this.layer.setBaseMaterials(baseMaterials);
  }

  /** Puts the Mimic's own materials back and drops every clone. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    for (const binding of this.bindings.values()) {
      if (binding.mesh.material === binding.clone) {
        binding.mesh.material = binding.source;
      }
      binding.clone.dispose();
    }
    this.bindings.clear();
  }

  dispose(): void {
    this.detach();
  }
}
