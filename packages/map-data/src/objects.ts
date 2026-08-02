import type { ObjectRegistry } from "@foldseek/game-sim";
import type { InnocentReactionId } from "@foldseek/shared";

import type { AABB } from "./navData";
import { SHOP_PLACEMENTS, type PropPlacement } from "./placements";
import { SECURITY_OFFICE_BOUNDS, type ZoneId } from "./zones";

/**
 * Gameplay metadata for every authored prop (§10.3), and the registry the
 * simulation validates focus and accusation against (§8.3).
 *
 * The map is the authority here: the simulation only accepts an object the map
 * published, so an Inspector cannot spend a warrant on something that does not
 * exist and a client cannot invent a target.
 *
 * This is the plain-data half. The client's `world/maps/registry.ts` builds the
 * same entries with `THREE.Box3` and `THREE.Vector3` for the renderer and the
 * focus system; both call the functions below, so the box an authority checks a
 * shot against and the box the reticle brackets are the same arithmetic.
 */

export const CURIOSITY_SHOP_MAP_ID = "curiosity_shop";

export type AccusationPolicy = "allowed" | "decorative_only" | "blocked";

export type LodGroup = "hero" | "standard" | "background";

/** One prop as the authority sees it: identity, policy, and where it stands. */
export interface MapObjectRecord {
  readonly objectId: string;
  readonly categoryId: string;
  readonly zoneId: ZoneId;
  readonly inspectable: boolean;
  readonly baselinePresent: boolean;
  readonly innocentReactionId: InnocentReactionId;
  readonly accusationPolicy: AccusationPolicy;
  /** Prop origin in world space, which is the centre of its footprint. */
  readonly position: readonly [number, number, number];
  /** Screen-space bracket the Inspector tool conforms to (§8.2). */
  readonly focusBounds: AABB;
  readonly swatchIds: readonly string[];
  readonly lodGroup: LodGroup;
}

export function isInSecurityOffice(placement: PropPlacement): boolean {
  const [x, , z] = placement.position;
  return (
    x >= SECURITY_OFFICE_BOUNDS.min.x &&
    x <= SECURITY_OFFICE_BOUNDS.max.x &&
    z >= SECURITY_OFFICE_BOUNDS.min.z &&
    z <= SECURITY_OFFICE_BOUNDS.max.z
  );
}

/**
 * Axis-aligned focus box for a prop that may be rotated about Y. The authored
 * extents are in the prop's own frame, so the footprint is rotated before the
 * bounds are taken rather than assuming the prop faces down an axis.
 */
export function focusBoundsFor(placement: PropPlacement): AABB {
  const [width, height, depth] = placement.focus;
  const [x, y, z] = placement.position;
  const cos = Math.abs(Math.cos(placement.rotationY));
  const sin = Math.abs(Math.sin(placement.rotationY));
  const halfX = (width * cos + depth * sin) / 2;
  const halfZ = (width * sin + depth * cos) / 2;
  return {
    min: { x: x - halfX, y, z: z - halfZ },
    max: { x: x + halfX, y: y + height, z: z + halfZ },
  };
}

export function policyFor(placement: PropPlacement): AccusationPolicy {
  if (isInSecurityOffice(placement)) {
    return "blocked";
  }
  return placement.inspectable ? "allowed" : "decorative_only";
}

export function lodGroupFor(placement: PropPlacement): LodGroup {
  if (placement.hero) {
    return "hero";
  }
  // Matches `CuriosityShop.layerFor`: an obstacle is drawn on every tier, so it
  // is reported as standard rather than as dressing.
  return placement.inspectable || placement.obstacle === true ? "standard" : "background";
}

export function buildMapObjectRecords(
  placements: readonly PropPlacement[] = SHOP_PLACEMENTS,
): readonly MapObjectRecord[] {
  return placements.map((placement) => ({
    objectId: placement.objectId,
    categoryId: placement.categoryId,
    zoneId: placement.zoneId,
    inspectable: placement.inspectable,
    baselinePresent: placement.baselinePresent,
    innocentReactionId: placement.innocentReactionId,
    accusationPolicy: policyFor(placement),
    position: placement.position,
    focusBounds: focusBoundsFor(placement),
    swatchIds: placement.swatchIds,
    lodGroup: lodGroupFor(placement),
  }));
}

export const CURIOSITY_SHOP_RECORDS: readonly MapObjectRecord[] = buildMapObjectRecords();

/**
 * Where every authored prop stands, for the authority's range and line-of-sight
 * checks. Every prop is here rather than only the accusable ones: a decorative
 * shelf is not a target, but the Inspector still walks past it and the close
 * passes of §6.4 are measured against whatever a disguise is standing beside.
 */
export const PROP_FOCUS_BOUNDS: ReadonlyMap<string, AABB> = new Map(
  CURIOSITY_SHOP_RECORDS.map((entry) => [entry.objectId, entry.focusBounds] as const),
);

/**
 * The registry the simulation consumes. Only props an Inspector may accuse are
 * published: sealed cabinet contents, ceiling fittings and everything in the
 * Security Office stay in the baseline dossier without becoming targets.
 */
export function buildObjectRegistry(
  placements: readonly PropPlacement[] = SHOP_PLACEMENTS,
): ObjectRegistry {
  const objects = buildMapObjectRecords(placements)
    .filter((entry) => entry.accusationPolicy === "allowed")
    .map((entry) => ({
      objectId: entry.objectId,
      innocentReactionIds: [entry.innocentReactionId] as readonly InnocentReactionId[],
    }));

  return { mapId: CURIOSITY_SHOP_MAP_ID, objects };
}
