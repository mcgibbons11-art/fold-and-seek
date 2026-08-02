import {
  buildMapObjectRecords,
  SHOP_PLACEMENTS,
  type MapObjectRecord,
  type PropPlacement,
  type ZoneId,
} from "@foldseek/map-data";
import * as THREE from "three/webgpu";

/**
 * Gameplay metadata for every authored prop (§10.3), in the shapes the renderer
 * and the focus system want.
 *
 * The data and its arithmetic live in `@foldseek/map-data`, because the
 * dedicated Colyseus server validates shots against the same focus boxes and
 * cannot import Three.js. What this file adds is the Three.js face: a `Vector3`
 * origin and a `Box3` bracket, which `FocusSystem` raycasts against and
 * `huntCues` measures. The boxes are converted, never recomputed, so the box an
 * authority refuses a shot outside and the box the reticle draws around it are
 * the same numbers.
 */

export {
  buildObjectRegistry,
  CURIOSITY_SHOP_MAP_ID,
  type AccusationPolicy,
  type LodGroup,
} from "@foldseek/map-data";

/** The map's own record, with its position and bounds as Three.js objects. */
export type MapObjectEntry = Omit<MapObjectRecord, "position" | "focusBounds"> & {
  readonly position: THREE.Vector3;
  readonly focusBounds: THREE.Box3;
};

function toEntry(record: MapObjectRecord): MapObjectEntry {
  const { min, max } = record.focusBounds;
  return {
    ...record,
    position: new THREE.Vector3(record.position[0], record.position[1], record.position[2]),
    focusBounds: new THREE.Box3(
      new THREE.Vector3(min.x, min.y, min.z),
      new THREE.Vector3(max.x, max.y, max.z),
    ),
  };
}

export function buildMapObjects(
  placements: readonly PropPlacement[] = SHOP_PLACEMENTS,
): readonly MapObjectEntry[] {
  return buildMapObjectRecords(placements).map(toEntry);
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
