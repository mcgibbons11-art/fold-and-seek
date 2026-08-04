import type { DisguisePlacement, SpatialDecision, SpatialValidator } from "@foldseek/game-sim";
import {
  SpatialValidatorImpl,
  NAV_DATA,
  PROP_FOCUS_BOUNDS,
  WARRANT_RESTOCK_VOLUME,
  WORLD_SCALE,
  type AABB,
  type Vec3Like,
} from "@foldseek/map-data";
import { DEFAULT_MATCH_SETTINGS, type MatchSettings } from "@foldseek/shared";

/**
 * The geometry seam between a Colyseus room and the simulation (§28.4), and the
 * dedicated server's answer to the same problem `RoundSpatialBridge` solves in
 * the client.
 *
 * The two are deliberately the same shape. Both *are* the validator rather than
 * merely holding one, because the simulation takes its validator once at
 * construction and would keep any instance replaced later, and the host can
 * still change the room's reach from the lobby. Both refuse anything they have
 * not been told about rather than assuming it, which is what stops an
 * accusation on an unknown object succeeding by default.
 *
 * Where they differ is how they learn where a body is. The client reads the
 * bounds of a rendered Mimic out of its own theatre; a server has no renderer,
 * so it takes the root the simulation already holds and puts a body-sized
 * envelope around it.
 */

/**
 * How far a disguise's box reaches from the root the simulation records.
 *
 * The client measures the real folded body. This cannot: reproducing it would
 * mean running the Mimic rig's forward kinematics on a machine that has no rig,
 * so the server uses the volume a Mimic body occupies instead, which is the same
 * envelope the character controller and `canOccupy` already reason about. It is
 * therefore a slightly coarser target than the client's box on a tightly folded
 * disguise and a slightly tighter one on a sprawling pose, and both authorities
 * are wrong by less than a body either way.
 *
 * The root sits at the body's base: `canOccupy` measures it against the floor
 * top, so the box rises from there rather than being centred on it. It is
 * allowed a little below as well, since a disguise draped over a ledge puts its
 * root at the ledge and hangs part of itself under it.
 */
const DISGUISE_HALF_EXTENT_M = WORLD_SCALE.playerRadius;
const DISGUISE_RISE_M = WORLD_SCALE.playerHeight;
const DISGUISE_DROP_M = WORLD_SCALE.playerHeight * 0.25;

export function disguiseBoundsAt(root: readonly [number, number, number]): AABB {
  const [x, y, z] = root;
  return {
    min: { x: x - DISGUISE_HALF_EXTENT_M, y: y - DISGUISE_DROP_M, z: z - DISGUISE_HALF_EXTENT_M },
    max: { x: x + DISGUISE_HALF_EXTENT_M, y: y + DISGUISE_RISE_M, z: z + DISGUISE_HALF_EXTENT_M },
  };
}

export class RoomSpatialBridge implements SpatialValidator {
  private readonly eyes = new Map<string, Vec3Like>();
  private readonly disguiseBounds = new Map<string, AABB>();
  private accusationDistance: number;
  private focusDistance: number;
  private impl: SpatialValidatorImpl;

  constructor(settings: MatchSettings = DEFAULT_MATCH_SETTINGS) {
    this.accusationDistance = settings.accusationDistance;
    this.focusDistance = settings.inspectorFocusDistance;
    this.impl = this.build();
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
   * Where one client says it is looking from, keyed by session id, which is the
   * same identity the simulation seats a player under. Null forgets the eye,
   * which is what a client reports when it stops being an Inspector and what
   * the room does when that client leaves: a departed Inspector's last position
   * is not where anybody is standing.
   */
  setInspectorEye(sessionId: string, eye: readonly [number, number, number] | null): void {
    if (eye === null) {
      this.eyes.delete(sessionId);
      return;
    }
    this.eyes.set(sessionId, { x: eye[0], y: eye[1], z: eye[2] });
  }

  /** Adopts the simulation's own record of where every live disguise stands. */
  syncDisguises(placements: readonly DisguisePlacement[]): void {
    this.disguiseBounds.clear();
    for (const placement of placements) {
      this.disguiseBounds.set(placement.publicObjectId, disguiseBoundsAt(placement.rootPosition));
    }
  }

  /**
   * Where the room believes an object is. A prop and a disguise answer through
   * the same lookup, so neither is easier to reach than the other (§8.5) and
   * nothing reading this can tell one from the other.
   */
  boundsOf(objectId: string): AABB | null {
    return PROP_FOCUS_BOUNDS.get(objectId) ?? this.disguiseBounds.get(objectId) ?? null;
  }

  private build(): SpatialValidatorImpl {
    return new SpatialValidatorImpl({
      floors: NAV_DATA.floors,
      blockers: NAV_DATA.blockers,
      forbiddenOccupancy: [NAV_DATA.securityOffice],
      accusationDistance: this.accusationDistance,
      focusDistance: this.focusDistance,
      restockVolume: WARRANT_RESTOCK_VOLUME,
      inspectorEye: (sessionId) => this.eyes.get(sessionId) ?? null,
      objectBounds: (objectId) => this.boundsOf(objectId),
    });
  }
}
