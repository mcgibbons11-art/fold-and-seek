import type { SpatialDecision, SpatialValidator } from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, type MatchSettings } from "@foldseek/shared";

import { SpatialValidatorImpl } from "../inspector/SpatialValidatorImpl";
import type { AABB, Vec3Like } from "../inspector/navData";
import { NAV_DATA, WARRANT_RESTOCK_VOLUME } from "../world/maps/nav";
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
  private observer: ((inspectorId: string, eye: Vec3Like | null) => void) | null = null;
  private disguiseBounds: (publicObjectId: string) => AABB | null = () => null;
  private ownDisguiseBounds: (publicObjectId: string) => AABB | null = () => null;
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

  isNearby(inspectorId: string, targetObjectId: string): SpatialDecision {
    return this.impl.isNearby(inspectorId, targetObjectId);
  }

  canClaimRestock(inspectorId: string): SpatialDecision {
    return this.impl.canClaimRestock(inspectorId);
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

  /**
   * Where an Inspector on this machine is looking from. The round's own camera
   * writes here every frame, and the observer below is how a transport whose
   * authority lives on another machine gets to hear about it.
   */
  setInspectorEye(inspectorId: string, eye: Vec3Like | null): void {
    this.writeEye(inspectorId, eye);
    this.observer?.(inspectorId, eye);
  }

  /**
   * The same, for an eye that arrived from another client. It deliberately does
   * not run the observer: this is the far end of that report, and echoing it
   * would send another client's position back out under this one's name.
   */
  acceptInspectorEye(inspectorId: string, eye: Vec3Like | null): void {
    this.writeEye(inspectorId, eye);
  }

  /**
   * Watches every local write. Only one observer is kept, because there is only
   * one transport under a round.
   */
  observeInspectorEye(observer: (inspectorId: string, eye: Vec3Like | null) => void): void {
    this.observer = observer;
  }

  private writeEye(inspectorId: string, eye: Vec3Like | null): void {
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

  /**
   * The viewer's own disguise, which the theatre does not draw while the Forge
   * is holding it (override 2 keeps a hider's Forge open for the whole hunt).
   * A disguise nothing is drawing has no bounds, and an object with no bounds is
   * refused as `target_bounds_unknown` — so without this source the owner is the
   * one player in the room who cannot be shot, and under Portals the elected host
   * is a player. That is a fairness hole rather than a rendering detail.
   *
   * The two disguise sources are exact complements, not alternatives: this one
   * answers precisely when the theatre has been told to omit the body, so at
   * most one of them ever knows about a given disguise.
   */
  setOwnDisguiseBounds(lookup: (publicObjectId: string) => AABB | null): void {
    this.ownDisguiseBounds = lookup;
  }

  /**
   * Where the round believes an object is. A prop, a disguise the theatre is
   * drawing, and the viewer's own disguise answer through the same lookup, in
   * that order, so none is easier to reach than another (§8.5) and nothing
   * reading this can tell one from another.
   */
  boundsOf(objectId: string): AABB | null {
    return (
      PROP_BOUNDS.get(objectId) ??
      this.disguiseBounds(objectId) ??
      this.ownDisguiseBounds(objectId)
    );
  }

  private build(): SpatialValidatorImpl {
    return new SpatialValidatorImpl({
      floors: NAV_DATA.floors,
      blockers: NAV_DATA.blockers,
      forbiddenOccupancy: [NAV_DATA.securityOffice],
      accusationDistance: this.accusationDistance,
      focusDistance: this.focusDistance,
      restockVolume: WARRANT_RESTOCK_VOLUME,
      inspectorEye: (inspectorId) => this.eyes.get(inspectorId) ?? null,
      objectBounds: (objectId) => this.boundsOf(objectId),
    });
  }
}
