import type { ObjectRegistry } from "@foldseek/game-sim";
import type { InnocentReactionId } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { SHOP_PLACEMENTS, type PropPlacement } from "./placements";
import { SECURITY_OFFICE_BOUNDS, type ZoneId } from "./zones";

/**
 * Gameplay metadata for every authored prop (§10.3), and the registry the
 * simulation validates focus and accusation against (§8.3).
 *
 * The map is the authority here: the simulation only accepts an object the map
 * published, so an Inspector cannot spend a warrant on something that does not
 * exist and a client cannot invent a target.
 */

export const CURIOSITY_SHOP_MAP_ID = "curiosity_shop";

export type AccusationPolicy = "allowed" | "decorative_only" | "blocked";

export type LodGroup = "hero" | "standard" | "background";

export interface MapObjectEntry {
  readonly objectId: string;
  readonly categoryId: string;
  readonly zoneId: ZoneId;
  readonly inspectable: boolean;
  readonly baselinePresent: boolean;
  readonly innocentReactionId: InnocentReactionId;
  readonly accusationPolicy: AccusationPolicy;
  /** Prop origin in world space, which is the centre of its footprint. */
  readonly position: THREE.Vector3;
  /** Screen-space bracket the Inspector tool conforms to (§8.2). */
  readonly focusBounds: THREE.Box3;
  readonly swatchIds: readonly string[];
  readonly lodGroup: LodGroup;
}

function isInSecurityOffice(placement: PropPlacement): boolean {
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
function focusBoundsFor(placement: PropPlacement): THREE.Box3 {
  const [width, height, depth] = placement.focus;
  const [x, y, z] = placement.position;
  const cos = Math.abs(Math.cos(placement.rotationY));
  const sin = Math.abs(Math.sin(placement.rotationY));
  const halfX = (width * cos + depth * sin) / 2;
  const halfZ = (width * sin + depth * cos) / 2;
  return new THREE.Box3(
    new THREE.Vector3(x - halfX, y, z - halfZ),
    new THREE.Vector3(x + halfX, y + height, z + halfZ),
  );
}

function policyFor(placement: PropPlacement): AccusationPolicy {
  if (isInSecurityOffice(placement)) {
    return "blocked";
  }
  return placement.inspectable ? "allowed" : "decorative_only";
}

function lodGroupFor(placement: PropPlacement): LodGroup {
  if (placement.hero) {
    return "hero";
  }
  // Matches `CuriosityShop.layerFor`: an obstacle is drawn on every tier, so it
  // is reported as standard rather than as dressing.
  return placement.inspectable || placement.obstacle === true ? "standard" : "background";
}

export function buildMapObjects(placements: readonly PropPlacement[] = SHOP_PLACEMENTS): readonly MapObjectEntry[] {
  return placements.map((placement) => ({
    objectId: placement.objectId,
    categoryId: placement.categoryId,
    zoneId: placement.zoneId,
    inspectable: placement.inspectable,
    baselinePresent: placement.baselinePresent,
    innocentReactionId: placement.innocentReactionId,
    accusationPolicy: policyFor(placement),
    position: new THREE.Vector3(placement.position[0], placement.position[1], placement.position[2]),
    focusBounds: focusBoundsFor(placement),
    swatchIds: placement.swatchIds,
    lodGroup: lodGroupFor(placement),
  }));
}

export const CURIOSITY_SHOP_OBJECTS: readonly MapObjectEntry[] = buildMapObjects();

const objectsById = new Map<string, MapObjectEntry>(
  CURIOSITY_SHOP_OBJECTS.map((entry) => [entry.objectId, entry]),
);

export function mapObject(objectId: string): MapObjectEntry | null {
  return objectsById.get(objectId) ?? null;
}

export function objectsInZone(zoneId: ZoneId): readonly MapObjectEntry[] {
  return CURIOSITY_SHOP_OBJECTS.filter((entry) => entry.zoneId === zoneId);
}

/**
 * The registry the simulation consumes. Only props an Inspector may accuse are
 * published: sealed cabinet contents, ceiling fittings and everything in the
 * Security Office stay in the baseline dossier without becoming targets.
 */
export function buildObjectRegistry(
  placements: readonly PropPlacement[] = SHOP_PLACEMENTS,
): ObjectRegistry {
  const objects = buildMapObjects(placements)
    .filter((entry) => entry.accusationPolicy === "allowed")
    .map((entry) => ({
      objectId: entry.objectId,
      innocentReactionIds: [entry.innocentReactionId] as readonly InnocentReactionId[],
    }));

  return { mapId: CURIOSITY_SHOP_MAP_ID, objects };
}
