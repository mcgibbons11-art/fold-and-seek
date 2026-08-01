import { boundsVisibleFrom, distanceToBounds, rayAabbEntry, raySphereEntry } from "./geometry";
import type { AABB, Vec3Like } from "./navData";

/**
 * Inspector focus (§8.3, §8.5). The reticle picks against a registry of focus
 * proxies and nothing else, so what can be looked at is authored data rather
 * than whatever happens to be renderable.
 *
 * The anti-leak rule of §8.5 is structural here: a Mimic disguise registers an
 * `InspectableProxy` exactly like a shop prop does, this file has no notion of
 * either kind, and every field of `FocusMetadata` is a function of geometry and
 * authored labels alone. There is one code path, so there is no second one to
 * behave differently.
 */

export type AccusationPolicy = "allowed" | "decorative_only" | "blocked";

export type PickProxy =
  | { readonly kind: "box"; readonly box: AABB }
  | { readonly kind: "sphere"; readonly center: Vec3Like; readonly radius: number };

export interface InspectableProxy {
  readonly objectId: string;
  /** Authored family, e.g. "lamp". Never a role, never a disguise marker. */
  readonly categoryId: string;
  /** Bounds the reticle brackets conform to, and the gameplay distance source. */
  readonly bounds: AABB;
  readonly pickProxy: PickProxy;
  readonly accusationPolicy: AccusationPolicy;
}

export type FocusPhase = "hover" | "focused";

/**
 * Everything the HUD and the accusation driver learn about the current target.
 * Built in exactly one place, from one object literal, so the key order and the
 * value provenance are identical for every target.
 */
export interface FocusMetadata {
  readonly objectId: string;
  readonly categoryId: string;
  readonly phase: FocusPhase;
  /** Metres from the Inspector's eye to the nearest point of `bounds`. */
  readonly distanceM: number;
  /** Milliseconds the focus input has been held on this target. */
  readonly holdMs: number;
  /** Coarse line of sight from the eye, by the same rule the server applies. */
  readonly visible: boolean;
  readonly accusable: boolean;
}

export class InspectableSet {
  private readonly entries = new Map<string, InspectableProxy>();

  constructor(initial?: Iterable<InspectableProxy>) {
    if (initial === undefined) return;
    for (const proxy of initial) this.add(proxy);
  }

  add(proxy: InspectableProxy): void {
    this.entries.set(proxy.objectId, proxy);
  }

  remove(objectId: string): void {
    this.entries.delete(objectId);
  }

  get(objectId: string): InspectableProxy | undefined {
    return this.entries.get(objectId);
  }

  values(): IterableIterator<InspectableProxy> {
    return this.entries.values();
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface FocusSystemOptions {
  /** `inspectorFocusDistance`: how far the reticle reaches, in metres. */
  readonly focusDistance: number;
  /** `accusationDistance`: how close a target must be to be accusable. */
  readonly accusationDistance: number;
  /** Map blockers, consulted only for line of sight, never for picking. */
  readonly blockers?: readonly AABB[];
  /** How long the focus input must be held before the target reads as focused. */
  readonly engageMs?: number;
  readonly onChange?: (focus: FocusMetadata | null) => void;
}

/** Deliberate but short, so focus feels immediate without flickering (§8.2). */
export const DEFAULT_FOCUS_ENGAGE_MS = 120;

/**
 * The pick ray starts at the over-shoulder camera, which sits behind the eye.
 * This is how much further than `focusDistance` it may travel before the
 * gameplay distance test, measured from the eye, rejects the hit anyway.
 */
export const PICK_RAY_SLACK_M = 4;

export class FocusSystem {
  private readonly options: FocusSystemOptions;
  private readonly engageMs: number;
  private readonly onChange: ((focus: FocusMetadata | null) => void) | null;

  private inspectables: InspectableSet;
  private targetId: string | null = null;
  private holdMs = 0;
  private focus: FocusMetadata | null = null;

  constructor(inspectables: InspectableSet, options: FocusSystemOptions) {
    this.inspectables = inspectables;
    this.options = options;
    this.engageMs = options.engageMs ?? DEFAULT_FOCUS_ENGAGE_MS;
    this.onChange = options.onChange ?? null;
  }

  setInspectables(inspectables: InspectableSet): void {
    this.inspectables = inspectables;
    this.targetId = null;
    this.holdMs = 0;
    this.publish(null);
  }

  get current(): FocusMetadata | null {
    return this.focus;
  }

  /**
   * @param rayOrigin   camera position, so the reticle agrees with the screen
   * @param rayDir      normalized camera forward
   * @param eye         Inspector eye position, the origin of every distance
   * @param engageHeld  focus (or accuse) input held this frame
   */
  update(
    dtMs: number,
    rayOrigin: Vec3Like,
    rayDir: Vec3Like,
    eye: Vec3Like,
    engageHeld: boolean,
  ): void {
    const hit = this.pick(rayOrigin, rayDir);
    if (hit === null) {
      this.targetId = null;
      this.holdMs = 0;
      this.publish(null);
      return;
    }

    const distanceM = distanceToBounds(eye, hit.bounds);
    if (distanceM > this.options.focusDistance) {
      this.targetId = null;
      this.holdMs = 0;
      this.publish(null);
      return;
    }

    if (this.targetId !== hit.objectId) {
      this.targetId = hit.objectId;
      this.holdMs = 0;
    }
    this.holdMs = engageHeld ? this.holdMs + dtMs : 0;

    const blockers = this.options.blockers;
    const visible = blockers === undefined || boundsVisibleFrom(blockers, eye, hit.bounds);

    this.publish({
      objectId: hit.objectId,
      categoryId: hit.categoryId,
      phase: this.holdMs >= this.engageMs ? "focused" : "hover",
      distanceM,
      holdMs: this.holdMs,
      visible,
      accusable:
        visible &&
        hit.accusationPolicy === "allowed" &&
        distanceM <= this.options.accusationDistance,
    });
  }

  /**
   * Nearest focus proxy along the ray. Ties keep the earlier registration, so
   * two co-located proxies always resolve the same way.
   */
  private pick(origin: Vec3Like, dir: Vec3Like): InspectableProxy | null {
    const reach = this.options.focusDistance + PICK_RAY_SLACK_M;
    let best: InspectableProxy | null = null;
    let bestT = Number.POSITIVE_INFINITY;
    for (const proxy of this.inspectables.values()) {
      const proxyShape = proxy.pickProxy;
      const t =
        proxyShape.kind === "box"
          ? rayAabbEntry(origin, dir, proxyShape.box, 0, reach)
          : raySphereEntry(origin, dir, proxyShape.center, proxyShape.radius, 0, reach);
      if (t < 0 || t >= bestT) continue;
      best = proxy;
      bestT = t;
    }
    return best;
  }

  /** Notifies only on a change a listener could act on, never every frame. */
  private publish(next: FocusMetadata | null): void {
    const previous = this.focus;
    this.focus = next;
    if (previous === null && next === null) return;
    if (
      previous !== null &&
      next !== null &&
      previous.objectId === next.objectId &&
      previous.phase === next.phase &&
      previous.visible === next.visible &&
      previous.accusable === next.accusable
    ) {
      return;
    }
    this.onChange?.(next);
  }
}
