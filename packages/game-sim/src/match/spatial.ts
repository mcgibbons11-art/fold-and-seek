/**
 * Geometry checks the pure simulation cannot perform. The dedicated server and
 * the host-elected Portals client each supply their own implementation backed
 * by authoritative positions, line of sight, and distance limits (§28.4, §28.5).
 *
 * Target existence is not one of these checks: it is decided by the object
 * registry inside the simulation, which runs first and always. What is left
 * here is range, line of sight, and camera tolerance, and it stays permissive
 * until the map delivers real geometry in Phase 3.
 */
export interface SpatialValidator {
  canAccuse(inspectorId: string, targetObjectId: string): SpatialDecision;
  /**
   * Whether the Inspector can actually see the object right now. It gates the
   * direct-look escapes of §6.3, which must reflect real line of sight rather
   * than a client-reported focus.
   */
  canObserve(inspectorId: string, targetObjectId: string): SpatialDecision;
  /**
   * Whether a creeping hider's new root position is somewhere it may legally
   * be: inside the playable volume, not inside blocked geometry. The simulation
   * enforces the speed cap itself, since that is arithmetic on the pose it
   * already holds, but where the walls are is map knowledge it does not have.
   */
  canOccupy(
    playerId: string,
    position: readonly [number, number, number],
  ): SpatialDecision;
  /**
   * Whether the Inspector is close enough to this object, right now, to have
   * brushed past it (§6.4). The simulation asks once per inspector per live
   * disguise per tick and owns everything else about a close pass: how long the
   * Inspector has to stay there, and how often one pair may score.
   *
   * Unlike the three above it is a source rather than a gate. They answer
   * "may this happen", so not knowing means refusing; this answers "is this
   * happening", so not knowing means nothing happens. A validator with no eye
   * position must return `ok: false` here for the same reason it refuses an
   * accusation: an authority that has never heard where the Inspector is
   * cannot say they walked past anybody.
   */
  isNearby(inspectorId: string, targetObjectId: string): SpatialDecision;
}

export interface SpatialDecision {
  readonly ok: boolean;
  /** Human-readable cause, forwarded to the accusing inspector only. */
  readonly reason?: string;
  /**
   * How strongly an observation lands, for the tension indicator of §5.12.
   * Only canObserve supplies it. A focus hold already means the Inspector has
   * this object under the reticle, so the default is the strong reading; a
   * validator with real geometry downgrades to 1 when the object sits in the
   * cone but beyond the focus distance.
   */
  readonly level?: 1 | 2;
}

/**
 * Default used by unit tests and by hosts that have not wired geometry yet.
 *
 * Permissive means every gate opens and no close pass is ever produced. Both
 * halves are the same rule read in the right direction: a host with no geometry
 * blocks nothing and invents nothing. Answering `ok: true` to `isNearby` would
 * make it invent one for every hider on every tick of the hunt.
 */
export const PERMISSIVE_SPATIAL_VALIDATOR: SpatialValidator = {
  canAccuse: () => ({ ok: true }),
  canObserve: () => ({ ok: true }),
  canOccupy: () => ({ ok: true }),
  isNearby: () => ({ ok: false, reason: "no_geometry" }),
};
