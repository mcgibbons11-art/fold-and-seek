import type { SpatialDecision, SpatialValidator } from "@foldseek/game-sim";
import { CLOSE_PASS_DISTANCE_M } from "@foldseek/shared";

import { boundsVisibleFrom, distanceToBounds, SIGHT_LINE_EPSILON_M } from "./geometry";
import { containsXZ, type AABB, type Vec3Like, type WalkableSurface } from "./navData";

/**
 * The real SpatialValidator the simulation asks about geometry (§28.4, §28.5).
 * It replaces `PERMISSIVE_SPATIAL_VALIDATOR`, which accepted every accusation,
 * every observation, and every creep destination, and therefore let a client
 * accuse a target it could not see, from any distance, through any wall, and
 * slide a disguise into the geometry.
 *
 * It is deliberately pure and plain-data: the constructor takes boxes, two
 * lookups, and two distances, so the dedicated Colyseus server and the
 * host-elected Portals client run identical code with no renderer, no physics
 * engine, and no Three.js. Given the same inputs it always returns the same
 * decision, which is what makes an authoritative check auditable.
 */

export type SpatialRejectionReason =
  | "inspector_position_unknown"
  | "target_bounds_unknown"
  | "out_of_range"
  | "no_line_of_sight"
  | "outside_playable_area"
  | "inside_blocked_geometry";

export interface SpatialValidatorDeps {
  /** Standable surfaces, which together define the playable footprint. */
  readonly floors: readonly WalkableSurface[];
  /** Map blockers: walls, furniture, blocked volumes (§26.5). */
  readonly blockers: readonly AABB[];
  /** `accusationDistance` from the match settings. */
  readonly accusationDistance: number;
  /** `inspectorFocusDistance` from the match settings. */
  readonly focusDistance: number;
  /**
   * Latest authoritative eye position of an Inspector, or null when the
   * authority has never heard from them. Unknown is refused, never assumed.
   */
  readonly inspectorEye: (inspectorId: string) => Vec3Like | null;
  /**
   * World bounds of a registered object or a locked disguise. The same lookup
   * answers for both, so a Mimic is neither easier nor harder to accuse than
   * the prop standing beside it.
   */
  readonly objectBounds: (objectId: string) => AABB | null;
}

/**
 * How far below and above the floor a disguise root may legally sit. The drop
 * is small, so nothing sinks through the map. The rise is generous, because a
 * disguise on a shelf or a table is exactly the hiding place §7 asks for.
 */
export const OCCUPANCY_DROP_M = 0.5;
export const OCCUPANCY_RISE_M = 3;

/**
 * A root resting against a wall or standing on a cabinet touches that blocker's
 * surface. Only this much penetration past the surface counts as being inside.
 */
export const OCCUPANCY_PENETRATION_M = 0.05;

const OK: SpatialDecision = { ok: true };

export class SpatialValidatorImpl implements SpatialValidator {
  private readonly deps: SpatialValidatorDeps;

  constructor(deps: SpatialValidatorDeps) {
    this.deps = deps;
  }

  canAccuse(inspectorId: string, targetObjectId: string): SpatialDecision {
    return this.check(inspectorId, targetObjectId, this.deps.accusationDistance);
  }

  canObserve(inspectorId: string, targetObjectId: string): SpatialDecision {
    return this.check(inspectorId, targetObjectId, this.deps.focusDistance);
  }

  /**
   * Proximity for the close passes of §6.4, on the same terms as the two above:
   * the same eye, the same bounds, the same sight line, a shorter reach. Sight
   * line is part of it on purpose. Two body heights is nothing at this scale,
   * so an Inspector in the next aisle can be 0.7 m from a disguise with a
   * cabinet between them, and walking along the far side of a wall is not the
   * beat where somebody nearly had you.
   */
  isNearby(inspectorId: string, targetObjectId: string): SpatialDecision {
    return this.check(inspectorId, targetObjectId, CLOSE_PASS_DISTANCE_M);
  }

  /**
   * Where a creeping hider's root may legally end up. The simulation caps the
   * speed itself; what it cannot know is where the walls are, so this answers
   * only that: over a floor, within reach above it, and not buried in solid
   * geometry. It does not require standing on the floor, because a disguise on
   * a shelf is a legitimate hiding place.
   */
  canOccupy(playerId: string, position: readonly [number, number, number]): SpatialDecision {
    const [x, y, z] = position;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return refuse("outside_playable_area");
    }

    let overFloor = false;
    for (const floor of this.deps.floors) {
      if (!containsXZ(floor.bounds, x, z)) continue;
      const top = floor.bounds.max.y;
      if (y < top - OCCUPANCY_DROP_M || y > top + OCCUPANCY_RISE_M) continue;
      overFloor = true;
      break;
    }
    if (!overFloor) return refuse("outside_playable_area");

    for (const blocker of this.deps.blockers) {
      if (
        x > blocker.min.x + OCCUPANCY_PENETRATION_M &&
        x < blocker.max.x - OCCUPANCY_PENETRATION_M &&
        y > blocker.min.y + OCCUPANCY_PENETRATION_M &&
        y < blocker.max.y - OCCUPANCY_PENETRATION_M &&
        z > blocker.min.z + OCCUPANCY_PENETRATION_M &&
        z < blocker.max.z - OCCUPANCY_PENETRATION_M
      ) {
        return refuse("inside_blocked_geometry");
      }
    }
    return OK;
  }

  private check(
    inspectorId: string,
    targetObjectId: string,
    maxDistance: number,
  ): SpatialDecision {
    const eye = this.deps.inspectorEye(inspectorId);
    if (eye === null) return refuse("inspector_position_unknown");
    const bounds = this.deps.objectBounds(targetObjectId);
    if (bounds === null) return refuse("target_bounds_unknown");

    if (distanceToBounds(eye, bounds) > maxDistance) return refuse("out_of_range");
    if (!boundsVisibleFrom(this.deps.blockers, eye, bounds, SIGHT_LINE_EPSILON_M)) {
      return refuse("no_line_of_sight");
    }
    return OK;
  }
}

function refuse(reason: SpatialRejectionReason): SpatialDecision {
  return { ok: false, reason };
}
