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
  source: ColoredMaterial;
  clone: ColoredMaterial;
  /** Whether the clone carries the glow atlas, which the layer only grows later. */
  emissiveBound: boolean;
}

interface ColoredMaterial extends THREE.Material {
  color: THREE.Color;
  map: THREE.Texture | null;
  /** Present on the standard and physical materials, absent on the rest. */
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

const scratchColor = new THREE.Color();
const scratchEmissive = new THREE.Color();

/**
 * A part's own glow, in the sRGB the atlas stores, so an unpainted texel
 * reproduces it exactly once the material's emissive colour has gone to white.
 *
 * `emissive` is a linear colour and `emissiveIntensity` scales it linearly, so
 * the two are multiplied in linear and only then converted. A source brighter
 * than white clips, which is the price of moving an unbounded scalar into a
 * byte; nothing the Mimic wears is emissive above one.
 */
export function baseEmissiveOf(
  emissive: THREE.Color | undefined,
  intensity: number | undefined,
): [number, number, number] {
  if (emissive === undefined) return [0, 0, 0];
  const scale = intensity ?? 1;
  scratchEmissive.setRGB(
    Math.min(1, emissive.r * scale),
    Math.min(1, emissive.g * scale),
    Math.min(1, emissive.b * scale),
  );
  scratchEmissive.copyLinearToSRGB(scratchEmissive);
  return [scratchEmissive.r, scratchEmissive.g, scratchEmissive.b];
}

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
    const baseEmissives: [number, readonly [number, number, number]][] = [];
    // Monotonic, so this flips at most once in a layer's life and the re-clone
    // it forces happens the first time the player paints something that glows.
    const wantEmissive = this.layer.hasEmissive;

    for (const object of this.getMeshes()) {
      if (!(object instanceof THREE.Mesh)) continue;
      const target = paintTargetOfObject(object);
      if (target === null) continue;
      const current = object.material;
      if (Array.isArray(current) || !isColored(current)) continue;

      const binding = this.bindings.get(object.uuid);
      const wearingOurClone = binding !== undefined && binding.clone === current;
      if (wearingOurClone && binding.emissiveBound === wantEmissive) continue;

      // A clone is always made from the Mimic's own material, never from the
      // last clone: re-cloning a clone would bake the white it already carries
      // in as the part's colour and lose the swatch entirely. When the mesh is
      // still wearing ours, the source it was made from is the one to use.
      const source = wearingOurClone ? binding.source : current;
      if (binding !== undefined) {
        binding.clone.dispose();
        this.bindings.delete(object.uuid);
      }

      const clone = source.clone();
      source.color.getRGB(scratchColor, THREE.SRGBColorSpace);
      baseColors.push([target, [scratchColor.r, scratchColor.g, scratchColor.b]]);

      clone.name = `${source.name}+paint`;
      clone.color.setRGB(1, 1, 1);
      clone.map = this.layer.getTargetTexture(target);

      // Every one of these maps MULTIPLIES its scalar in three, so the scalar
      // goes to one and the swatch's own value is baked into the unpainted
      // texel instead. That is what leaves an empty layer looking exactly like
      // the material underneath it.
      if (clone.roughness !== undefined && clone.metalness !== undefined) {
        baseMaterials.push([target, source.roughness ?? 1, source.metalness ?? 0]);
        clone.roughness = 1;
        clone.metalness = 1;
        const response = this.layer.getTargetMaterialTexture(target);
        clone.roughnessMap = response;
        clone.metalnessMap = response;
      }

      // The part's own glow is reported whether or not the atlas exists yet, so
      // that the atlas is printed in the right base the moment a stroke calls
      // it into being. Binding the map waits for that moment: a body with no
      // glowing paint on it keeps its own emissive and never pays for the
      // texture or for the shader variant that reads one.
      if (clone.emissive !== undefined) {
        baseEmissives.push([target, baseEmissiveOf(source.emissive, source.emissiveIntensity)]);
        if (wantEmissive) {
          clone.emissive.setRGB(1, 1, 1);
          clone.emissiveIntensity = 1;
          clone.emissiveMap = this.layer.getTargetEmissiveTexture(target);
        }
      }

      object.material = clone;
      this.bindings.set(object.uuid, {
        mesh: object,
        target,
        source,
        clone,
        emissiveBound: wantEmissive,
      });
    }

    if (baseColors.length > 0) this.layer.setBaseColors(baseColors);
    if (baseMaterials.length > 0) this.layer.setBaseMaterials(baseMaterials);
    if (baseEmissives.length > 0) this.layer.setBaseEmissives(baseEmissives);
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
