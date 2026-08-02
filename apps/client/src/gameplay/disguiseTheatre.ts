import type { PublicDisguiseView } from "@foldseek/game-sim";
import type { TauntId } from "@foldseek/shared";
import * as THREE from "three/webgpu";

import type { AABB } from "../inspector/navData";
import type { InspectableProxy } from "../inspector/FocusSystem";
import {
  applyDisguiseStateToPose,
  createStarterArrangement,
  type DisguiseState,
} from "../mimic/disguiseState";
import { createPoseState, type PoseState } from "../mimic/ikSolver";
import { decodeDisguiseState } from "../mimic/poseWire";
import { MimicVisual } from "../mimic/visual/MimicVisual";
import { PaintLayer } from "../paint/PaintLayer";
import { PaintMaterialBinder } from "../paint/PaintMaterialBinder";
import type { QualitySettings } from "../rendering/quality";
import { TAUNT_SOUND, type SoundCue } from "./huntCues";

/**
 * Puts the room's disguises in the room. Every locked Mimic arrives as a public
 * pose and nothing else, so this decodes it, poses a body with it, and hands the
 * Inspector a focus proxy for the result.
 *
 * The proxy it publishes is the same shape a shop prop publishes and carries the
 * same neutral category, because §8.5 requires that the reticle cannot tell a
 * disguise from a chair. What makes a disguise findable is its silhouette, never
 * anything the client knows about it.
 */

/** Category every disguise reports. Never "mimic": that would be the answer. */
const DISGUISE_CATEGORY = "curio";

/** Fallback for a disguise the authority locked without a pose (§5.8). */
const FALLBACK_ARRANGEMENT = "upright";

/**
 * One taunt's shape. Amplitudes are shares of the body's own measured height
 * rather than metres, so the gesture stays legible at whatever scale the map
 * and the player end up at.
 */
interface TauntMotion {
  readonly durationMs: number;
  /** Whole oscillations over the taunt. */
  readonly cycles: number;
  /** Sideways travel, as a share of body height. */
  readonly sway: number;
  /** Vertical travel, as a share of body height. */
  readonly bounce: number;
  readonly twistRad: number;
  readonly tiltRad: number;
}

/**
 * The five gestures §5.12 gives a hider, read as motion. Each is deliberately
 * small: a taunt is meant to catch an Inspector who is already looking, not to
 * turn the object into a dancer, and the focus box is only re-measured on a
 * pose change, so a large one would swing the body outside its own bracket.
 */
const TAUNT_MOTIONS: Readonly<Record<TauntId, TauntMotion>> = {
  shudder: { durationMs: 620, cycles: 7, sway: 0.03, bounce: 0, twistRad: 0, tiltRad: 0.05 },
  rattle: { durationMs: 700, cycles: 9, sway: 0.02, bounce: 0.02, twistRad: 0.04, tiltRad: 0 },
  tick_tock: { durationMs: 1_100, cycles: 3, sway: 0, bounce: 0, twistRad: 0, tiltRad: 0.16 },
  settle_creak: { durationMs: 900, cycles: 1, sway: 0.01, bounce: 0.05, twistRad: 0.06, tiltRad: 0.03 },
  puff: { durationMs: 520, cycles: 2, sway: 0, bounce: 0.07, twistRad: 0.1, tiltRad: 0 },
};

/** Body height assumed for a disguise whose bounds have not been taken yet. */
const FALLBACK_BODY_HEIGHT_M = 0.3;

/** Enough detune that two objects taunting at once do not sound like one. */
export const TAUNT_PITCH_JITTER = 0.08;

interface TauntPlayback {
  readonly motion: TauntMotion;
  /** Where in the cycle the gesture starts, from the authority's seed. */
  readonly phase: number;
  /** Which way it leans first, from the same seed. */
  readonly direction: number;
  readonly heightM: number;
  elapsedMs: number;
}

/**
 * Turns the event's seed into the two free parameters of the gesture. The
 * authority mints one seed and broadcasts it, so every client animates the same
 * taunt the same way and nobody sees a different object move.
 */
function tauntPhase(seed: number): number {
  return ((Math.abs(Math.trunc(seed)) % 1_000) / 1_000) * Math.PI * 2;
}

function tauntDirection(seed: number): number {
  return Math.abs(Math.trunc(seed)) % 2 === 0 ? 1 : -1;
}

const scratchSize = new THREE.Vector3();

/** Puts a body back where its pose says it stands. */
function restPose(root: THREE.Object3D): void {
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
}

/**
 * Displaces a body for one frame of its gesture. The envelope opens and closes
 * on zero, so a taunt neither snaps into motion nor leaves the object leaning.
 */
function applyTauntPose(root: THREE.Object3D, taunt: TauntPlayback, t: number): void {
  const { motion, phase, direction, heightM } = taunt;
  const envelope = Math.sin(Math.PI * t);
  const wave = Math.sin(phase + t * motion.cycles * Math.PI * 2) * envelope * direction;

  root.position.set(
    wave * motion.sway * heightM,
    Math.abs(wave) * motion.bounce * heightM,
    0,
  );
  root.rotation.set(0, wave * motion.twistRad, wave * motion.tiltRad);
}

interface Actor {
  readonly publicObjectId: string;
  readonly visual: MimicVisual;
  readonly pose: PoseState;
  readonly bounds: THREE.Box3;
  readonly proxy: InspectableProxy;
  /** The pose text last applied, so an unchanged disguise is not re-solved. */
  appliedPose: string;
  /**
   * The swatch assignment last applied. Reassigning materials is not free: it
   * hands each part a different material object, which makes the paint binder
   * clone it again, and on WebGPU every new material is a blocking shader
   * compile. A creeping hider republishes a pose several times a second and
   * almost never changes a swatch, so the two are tracked apart.
   */
  appliedMaterials: string;
  /**
   * Body paint, built only for a disguise that carries any. Paint and pose are
   * authored independently and arrive with separate revisions, so the layer is
   * tracked by its own payload rather than the pose's.
   */
  paint: { layer: PaintLayer; binder: PaintMaterialBinder } | null;
  appliedPaint: string | null;
  /** The gesture this object is performing, if any. */
  taunt: TauntPlayback | null;
}

export class DisguiseTheatre {
  private readonly scene: THREE.Scene;
  private readonly audio: SoundCue | null;
  private readonly actors = new Map<string, Actor>();
  private castShadow: boolean;
  /** Bumped whenever an actor is added or removed, never on a pose change. */
  private castRevision = 0;

  constructor(scene: THREE.Scene, quality: QualitySettings, audio: SoundCue | null = null) {
    this.scene = scene;
    this.audio = audio;
    this.castShadow = quality.dynamicShadows;
  }

  /**
   * Brings the cast into line with what the authority publishes. `omit` is the
   * viewer's own disguise, which the Forge is already drawing.
   */
  sync(disguises: readonly PublicDisguiseView[], omit: string | null): void {
    const present = new Set<string>();
    for (const disguise of disguises) {
      if (disguise.publicObjectId === omit) continue;
      present.add(disguise.publicObjectId);
      this.apply(disguise);
    }
    for (const [objectId, actor] of this.actors) {
      if (present.has(objectId)) continue;
      this.actors.delete(objectId);
      this.castRevision += 1;
      this.release(actor);
    }
  }

  /**
   * Performs a taunt on the object that made it. The player never appears: the
   * event names a public object and the disguise is what moves, which is the
   * whole reason a hider can bait an Inspector without giving themselves away.
   *
   * Returns false for an object this theatre is not drawing, which is how the
   * viewer's own disguise looks from here while the Forge holds it. The caller
   * still owes that player the sound; there is no body here to perform it.
   */
  taunt(publicObjectId: string, tauntId: TauntId, seed: number): boolean {
    const actor = this.actors.get(publicObjectId);
    if (actor === undefined) return false;

    const size = actor.bounds.getSize(scratchSize);
    actor.taunt = {
      motion: TAUNT_MOTIONS[tauntId],
      phase: tauntPhase(seed),
      direction: tauntDirection(seed),
      heightM: size.y > 0 ? size.y : FALLBACK_BODY_HEIGHT_M,
      elapsedMs: 0,
    };
    this.audio?.play(TAUNT_SOUND, TAUNT_PITCH_JITTER);
    return true;
  }

  /**
   * Advances every gesture. Driven from the frame loop after `sync`, so a pose
   * that arrived this frame has already put the body back at rest and this is
   * what displaces it again.
   */
  update(dtMs: number): void {
    for (const actor of this.actors.values()) {
      const taunt = actor.taunt;
      if (taunt === null) continue;
      taunt.elapsedMs += dtMs;
      const t = taunt.elapsedMs / taunt.motion.durationMs;
      if (t >= 1) {
        actor.taunt = null;
        restPose(actor.visual.root);
        continue;
      }
      applyTauntPose(actor.visual.root, taunt, t);
    }
  }

  applyQuality(settings: QualitySettings): void {
    this.castShadow = settings.dynamicShadows;
    for (const actor of this.actors.values()) actor.visual.setCastShadow(this.castShadow);
  }

  /** Identity of the current cast, for deciding when the focus set is stale. */
  get revision(): number {
    return this.castRevision;
  }

  boundsOf(publicObjectId: string): AABB | null {
    return this.actors.get(publicObjectId)?.bounds ?? null;
  }

  proxies(): readonly InspectableProxy[] {
    return [...this.actors.values()].map((actor) => actor.proxy);
  }

  dispose(): void {
    for (const actor of this.actors.values()) this.release(actor);
    this.actors.clear();
  }

  /** The binder hands each part its own material back before the body goes. */
  private release(actor: Actor): void {
    actor.paint?.binder.dispose();
    actor.paint?.layer.dispose();
    actor.visual.root.removeFromParent();
    actor.visual.dispose();
  }

  private apply(disguise: PublicDisguiseView): void {
    const existing = this.actors.get(disguise.publicObjectId);
    const poseChanged = existing === undefined || existing.appliedPose !== disguise.encodedPose;
    const paintChanged = existing !== undefined && existing.appliedPaint !== disguise.encodedPaint;
    if (!poseChanged && !paintChanged) return;

    const state = poseChanged ? this.poseFor(disguise) : null;
    if (poseChanged && state === null) return;

    const actor = existing ?? this.createActor(disguise.publicObjectId);

    if (state !== null) {
      actor.appliedPose = disguise.encodedPose;
      applyDisguiseStateToPose(state, actor.pose);
      actor.visual.applyForms(actor.pose);
      actor.visual.applyPanels(state.panels);
      // Swatches first, when they moved: the paint binder clones whatever
      // material is on a part and bakes its colour into the unpainted texel, so
      // binding before this would leave the layer sitting on the previous one.
      const materials = JSON.stringify(state.materials);
      if (materials !== actor.appliedMaterials) {
        actor.appliedMaterials = materials;
        actor.visual.applyMaterials(state.materials);
      }
      actor.visual.applyPose(actor.pose);
      // Measured at rest. A taunt displaces the whole body and the box is not
      // re-taken while it runs, so measuring mid-gesture would bake the lean
      // into the bracket the reticle draws and the authority shoots against.
      // `update` puts the displacement back on the same frame.
      restPose(actor.visual.root);
      actor.bounds.setFromObject(actor.visual.root);
    }

    this.applyPaint(actor, disguise.encodedPaint);
  }

  /**
   * Puts a peer's brushwork on their body. Paint is public by nature: it is what
   * the object looks like, and a disguise nobody else can see painted is half a
   * disguise. A layer that fails to decode is dropped rather than half-applied.
   */
  private applyPaint(actor: Actor, encodedPaint: string | null): void {
    if (encodedPaint === null || encodedPaint.length === 0) {
      if (actor.paint !== null) {
        actor.paint.binder.dispose();
        actor.paint.layer.dispose();
        actor.paint = null;
      }
      actor.appliedPaint = encodedPaint;
      return;
    }

    const paint =
      actor.paint ??
      (() => {
        const layer = new PaintLayer();
        return {
          layer,
          binder: new PaintMaterialBinder(layer, () => [
            ...actor.visual.segmentMeshes,
            ...actor.visual.panelMeshes,
          ]),
        };
      })();
    actor.paint = paint;

    if (actor.appliedPaint !== encodedPaint && !paint.layer.fromWireData(encodedPaint)) {
      return;
    }
    actor.appliedPaint = encodedPaint;
    // sync() also re-clones any part the pose update just handed a new swatch.
    paint.binder.sync();
    paint.layer.flush();
  }

  /**
   * A disguise with no pose fell back to a starting arrangement rather than
   * being authored, which is what §5.8 does for a Mimic who never sent one. An
   * illegal pose is dropped: the authority validated it, so this only happens
   * to a client older than the room it joined.
   */
  private poseFor(disguise: PublicDisguiseView): DisguiseState | null {
    if (disguise.encodedPose.length === 0) {
      return createStarterArrangement(disguise.defaultArrangementId ?? FALLBACK_ARRANGEMENT);
    }
    return decodeDisguiseState(disguise.encodedPose);
  }

  private createActor(publicObjectId: string): Actor {
    const visual = new MimicVisual();
    visual.root.name = `disguise-${publicObjectId}`;
    visual.setCastShadow(this.castShadow);
    this.scene.add(visual.root);

    const bounds = new THREE.Box3();
    const actor: Actor = {
      publicObjectId,
      visual,
      pose: createPoseState(),
      bounds,
      proxy: {
        objectId: publicObjectId,
        categoryId: DISGUISE_CATEGORY,
        // The live box, not a copy: it is re-measured in place whenever the
        // disguise moves, so the reticle brackets a creeping hider correctly.
        bounds,
        pickProxy: { kind: "box", box: bounds },
        accusationPolicy: "allowed",
      },
      appliedPose: "",
      appliedMaterials: "",
      paint: null,
      appliedPaint: null,
      taunt: null,
    };
    this.actors.set(publicObjectId, actor);
    this.castRevision += 1;
    return actor;
  }
}
