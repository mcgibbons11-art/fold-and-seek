import * as THREE from "three/webgpu";

import {
  MIMIC_LEGAL_SWATCHES,
  swatchById,
  type MaterialSwatch,
} from "../mimic/visual/materialSwatches";
import { shopSwatch } from "../world/maps/swatches";

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

/** What sampling a surface hands the Forge: a finish to wear, or a reason. */
export type SurfaceSampleResult =
  | { readonly kind: "wear"; readonly tray: MaterialSwatch; readonly surfaceLabel: string }
  | { readonly kind: "refused"; readonly label: string }
  | { readonly kind: "none" };

function colorDistance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Bridges the room's swatch ids onto the Mimic's own finishes (2026-08-06).
 *
 * The map and the body deliberately keep separate swatch tables - the room
 * has twenty-six finishes and a disguise wears eleven - but the dropper used
 * to look a room id up in the body's table, find nothing, and refuse with
 * "walnut_dark_01 is not allowed on a disguise" for nearly every surface in
 * the shop. Sampling a surface now wears the nearest legal body finish:
 * same family first, closest colour breaks the tie. Only a surface the map
 * itself refuses (the glasses) stays refused, by its proper name.
 */
export function traySwatchForSurface(surfaceId: string): SurfaceSampleResult {
  const direct = swatchById(surfaceId);
  if (direct !== null) {
    return direct.legalForMimic
      ? { kind: "wear", tray: direct, surfaceLabel: direct.label }
      : { kind: "refused", label: direct.label };
  }
  const map = shopSwatch(surfaceId);
  if (map === null) return { kind: "none" };
  if (!map.legalForMimic) return { kind: "refused", label: map.label };

  let best: MaterialSwatch | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const tray of MIMIC_LEGAL_SWATCHES) {
    const score =
      colorDistance(tray.baseColor, map.baseColor) +
      (tray.family === (map.family as string) ? 0 : 0.75);
    if (score < bestScore) {
      bestScore = score;
      best = tray;
    }
  }
  return best === null
    ? { kind: "none" }
    : { kind: "wear", tray: best, surfaceLabel: map.label };
}
