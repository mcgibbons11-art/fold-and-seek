import type { PropPlacement } from "../placements";
import type { PropBatcher } from "./batch";
import type { GeometryCache } from "./geometry";
import type { ShopMaterials } from "./materials";

/** Everything a prop builder is allowed to touch. */
export interface PropContext {
  readonly geometry: GeometryCache;
  readonly materials: ShopMaterials;
  readonly batcher: PropBatcher;
}

export type PropBuilder = (ctx: PropContext, placement: PropPlacement) => void;

/**
 * Swatch a prop wears in a given role. Roles are positional and documented per
 * variant, so one authored placement can restate a whole family in a different
 * set of materials without a new builder.
 */
export function swatchRole(placement: PropPlacement, index: number, fallback: string): string {
  return placement.swatchIds[index] ?? fallback;
}
