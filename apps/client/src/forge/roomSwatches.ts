import * as THREE from "three/webgpu";

/**
 * Resolves a raycast hit on map geometry to a published material swatch
 * (bible §7.4 Layer 5, §7.12).
 *
 * A surface declares the swatch it is made of, and sampling copies that id.
 * Nothing here reads a colour off the renderer, so a map can only ever hand the
 * Forge a material the map itself approved. The declaration lives on the
 * material, because a swatch describes a surface family rather than one mesh; a
 * per-mesh override is honoured first for the rare one-off.
 */

function firstMaterial(object: THREE.Object3D): THREE.Material | null {
  if (!(object instanceof THREE.Mesh)) {
    return null;
  }
  const material = object.material;
  return Array.isArray(material) ? material[0] ?? null : material;
}

function declaredSwatch(source: { readonly userData: Record<string, unknown> } | null): string | null {
  if (source === null) {
    return null;
  }
  const declared = source.userData["swatchId"];
  return typeof declared === "string" && declared.length > 0 ? declared : null;
}

/**
 * Swatch id for the surface under a raycast hit, or null when the surface
 * publishes none. A null is a legitimate answer, not a failure: a lit window and
 * a candle flame are deliberately not samplable.
 */
export function resolveSurfaceSwatch(object: THREE.Object3D): string | null {
  return declaredSwatch(object) ?? declaredSwatch(firstMaterial(object));
}
