import type { SpatialDecision, SpatialValidator } from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, type MatchSettings } from "@foldseek/shared";

import { SpatialValidatorImpl } from "../inspector/SpatialValidatorImpl";
import type { AABB, Vec3Like } from "../inspector/navData";
import { NAV_DATA } from "../world/maps/nav";
import { CURIOSITY_SHOP_OBJECTS } from "../world/maps/registry";

/**
 * The geometry seam between the running round and the simulation (§28.4).
 *
 * The authority is built before the scene is, and a disguise's bounds only
 * exist once something has posed it, so the simulation is handed this object
 * and the round fills it in as it goes: the Inspector's eye once they are
 * walking, and a disguise lookup once the theatre is rendering them. Everything
 * it has not been told about is refused rather than assumed, which is what
 * keeps an accusation on an unknown object from succeeding by default.
 *
 * It *is* the validator rather than merely holding one, because the simulation
 * takes its validator once at construction and would keep any instance replaced
 * later. The host can still change the room's reach in the lobby, so the bridge
 * keeps a stable identity and rebuilds the implementation underneath it.
 */

const PROP_BOUNDS = new Map<string, AABB>(
  CURIOSITY_SHOP_OBJECTS.map((entry) => [entry.objectId, entry.focusBounds] as const),
);

export class RoundSpatialBridge implements SpatialValidator {
  private readonly eyes = new Map<string, Vec3Like>();
  private disguiseBounds: (publicObjectId: string) => AABB | null = () => null;
  private accusationDistance: number;
  private focusDistance: number;
  private impl: SpatialValidatorImpl;

  constructor(settings: MatchSettings = DEFAULT_MATCH_SETTINGS) {
    this.accusationDistance = settings.accusationDistance;
    this.focusDistance = settings.inspectorFocusDistance;
    this.impl = this.build();
  }

  /** What the simulation is given. Its identity is stable for the whole round. */
  get validator(): SpatialValidator {
    return this;
  }

  canAccuse(inspectorId: string, targetObjectId: string): SpatialDecision {
    return this.impl.canAccuse(inspectorId, targetObjectId);
  }

  canObserve(inspectorId: string, targetObjectId: string): SpatialDecision {
    return this.impl.canObserve(inspectorId, targetObjectId);
  }

  canOccupy(playerId: string, position: readonly [number, number, number]): SpatialDecision {
    return this.impl.canOccupy(playerId, position);
  }

  /**
   * Adopts the room's current reach, which the host may change in the lobby.
   * Nothing else in the settings is geometry, so nothing else is read.
   */
  applySettings(settings: MatchSettings): void {
    if (
      settings.accusationDistance === this.accusationDistance &&
      settings.inspectorFocusDistance === this.focusDistance
    ) {
      return;
    }
    this.accusationDistance = settings.accusationDistance;
    this.focusDistance = settings.inspectorFocusDistance;
    this.impl = this.build();
  }

  setInspectorEye(inspectorId: string, eye: Vec3Like | null): void {
    if (eye === null) {
      this.eyes.delete(inspectorId);
      return;
    }
    // Copied rather than referenced: the camera rig mutates its own vector every
    // frame, and the validator must judge against the sample it was given.
    this.eyes.set(inspectorId, { x: eye.x, y: eye.y, z: eye.z });
  }

  setDisguiseBounds(lookup: (publicObjectId: string) => AABB | null): void {
    this.disguiseBounds = lookup;
  }

  private build(): SpatialValidatorImpl {
    return new SpatialValidatorImpl({
      floors: NAV_DATA.floors,
      blockers: NAV_DATA.blockers,
      accusationDistance: this.accusationDistance,
      focusDistance: this.focusDistance,
      inspectorEye: (inspectorId) => this.eyes.get(inspectorId) ?? null,
      // A prop and a disguise answer through the same lookup, in that order, so
      // neither is easier to reach than the other (§8.5).
      objectBounds: (objectId) => PROP_BOUNDS.get(objectId) ?? this.disguiseBounds(objectId),
    });
  }
}
