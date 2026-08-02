import type { PublicDisguiseView } from "@foldseek/game-sim";
import type { TauntId } from "@foldseek/shared";
import * as THREE from "three/webgpu";

import { distanceGain } from "../audio/distance";
import type { AABB } from "../inspector/navData";
import type { InspectableProxy } from "../inspector/FocusSystem";
import {
  applyDisguiseStateToPose,
  createStarterArrangement,
  type DisguiseState,
} from "../mimic/disguiseState";
import { createPoseState, type PoseState } from "../mimic/ikSolver";
import { decodeDisguiseState } from "../mimic/poseWire";
import { MergedMimicBody } from "../mimic/visual/MergedMimicBody";
import { MimicVisual } from "../mimic/visual/MimicVisual";
import { MimicMaterialPool } from "../mimic/visual/materialSwatches";
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
 *
 * A body here is drawn merged (`MergedMimicBody`): the forty parts the Forge
 * needs individually are one mesh per material by the time the room draws them.
 * The theatre still poses the parts, and still measures the focus box from them.
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

/**
 * Bodies built and compiled before the hunt, and the ceiling on how many are
 * kept in reserve once a round releases them.
 *
 * The local menu seats four, so a round shows a player at most three peers plus
 * their own disguise once the Forge lets go of it. A fifth is still built on
 * demand rather than refused; this is the number that costs nothing at the
 * transition, not a limit on the cast.
 */
export const PREWARM_BODY_COUNT = 4;

/**
 * Where a body waits while the backend builds its shaders: far below the boards,
 * so a frame drawn between the prewarm's awaits cannot show a Mimic standing in
 * the middle of the shop.
 */
const PREWARM_PARK_Y = -20;

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
const scratchCentre = new THREE.Vector3();

/**
 * A precompile walks the same render list a frame does, culling included, so a
 * body parked outside every camera builds nothing until culling is turned off
 * for it.
 */
function setFrustumCulled(visual: MimicVisual, culled: boolean): void {
  visual.root.traverse((object) => {
    object.frustumCulled = culled;
  });
}

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
  /**
   * What is actually drawn: the body's forty-odd parts collapsed to one mesh
   * per material. The parts themselves stay in the graph, hidden, because they
   * are what the pose is applied to and what the focus box is measured from.
   */
  readonly merged: MergedMimicBody;
  readonly pose: PoseState;
  readonly bounds: THREE.Box3;
  readonly proxy: InspectableProxy;
  /** The pose text last applied, so an unchanged disguise is not re-solved. */
  appliedPose: string;
  /**
   * The swatch assignment last applied. Reassigning materials is not free: it
   * hands each part a different material object, which re-groups the merge and
   * makes the paint clone be built again, and on WebGPU every new material is a
   * blocking shader compile. A creeping hider republishes a pose several times a
   * second and almost never changes a swatch, so the two are tracked apart.
   */
  appliedMaterials: string;
  /**
   * Body paint, built only for a disguise that carries any. Paint and pose are
   * authored independently and arrive with separate revisions, so the layer is
   * tracked by its own payload rather than the pose's.
   */
  paint: PaintLayer | null;
  appliedPaint: string | null;
  /** The gesture this object is performing, if any. */
  taunt: TauntPlayback | null;
}

export class DisguiseTheatre {
  private readonly scene: THREE.Scene;
  private readonly audio: SoundCue | null;
  private readonly actors = new Map<string, Actor>();
  /**
   * One set of materials for the whole cast. Four bodies wearing the default
   * porcelain are four identical shaders unless they share these, and each one
   * is built by the backend the first time a frame draws it.
   */
  private readonly pool = new MimicMaterialPool();
  /** Bodies built ahead of time or handed back by a disguise that left. */
  private readonly spare: MimicVisual[] = [];
  private castShadow: boolean;
  /** Bumped whenever an actor is added or removed, never on a pose change. */
  private castRevision = 0;
  private prewarmed = false;

  /** Where the player is listening from, for placing a taunt in the room. */
  private readonly listener: (() => THREE.Vector3 | null) | null;

  constructor(
    scene: THREE.Scene,
    quality: QualitySettings,
    audio: SoundCue | null = null,
    listener: (() => THREE.Vector3 | null) | null = null,
  ) {
    this.scene = scene;
    this.audio = audio;
    this.listener = listener;
    this.castShadow = quality.dynamicShadows;
  }

  /**
   * Builds the hunt's bodies while there is still time to spare, and hands them
   * to `compile` so the backend builds their shaders before the transition
   * rather than during it.
   *
   * A disguise only becomes public when its owner locks it, so waiting for the
   * hunt means every body in the room is new at the one moment the frame budget
   * is tightest: on a weak device that is a compile burst measured in tens of
   * seconds with the whole tab stopped. The bodies here are posed with the
   * fallback arrangement and parked out of sight; a real disguise arriving later
   * takes one over and re-poses it, which touches geometry and transforms only.
   *
   * `compile` is the renderer's own precompile. It is passed in rather than
   * taken from a renderer handle because the theatre owns no device, and it is
   * awaited, so a caller is free to yield to the browser inside it.
   */
  async prewarm(bodies: number, compile: () => Promise<void>): Promise<void> {
    if (this.prewarmed || bodies <= 0) return;
    this.prewarmed = true;

    const state = createStarterArrangement(FALLBACK_ARRANGEMENT);
    const pose = createPoseState();
    applyDisguiseStateToPose(state, pose);

    const built: MimicVisual[] = [];
    for (let i = 0; i < bodies; i++) {
      const visual = new MimicVisual(this.pool);
      visual.root.name = `disguise-prewarm-${String(i)}`;
      visual.setCastShadow(this.castShadow);
      this.scene.add(visual.root);
      visual.applyForms(pose);
      visual.applyPanels(state.panels);
      visual.applyMaterials(state.materials);
      visual.applyPose(pose);
      visual.root.position.y = PREWARM_PARK_Y;
      // A stowed panel is invisible and scaled to nothing, and a precompile
      // walks the visible scene, so its plate would be skipped here and built
      // at the first frame a disguise deploys one. The next `applyPanels` puts
      // every one of these back where its own state says it belongs.
      for (const plate of visual.panelMeshes) {
        plate.visible = true;
        plate.scale.setScalar(1);
      }
      // A precompile frustum-culls exactly as a render does, and these are
      // parked outside any camera. Culling is restored when the body is taken.
      setFrustumCulled(visual, false);
      built.push(visual);
    }

    // One body wears paint, because a painted part swaps in a cloned material
    // carrying the atlas and that is a different shader from the bare swatch.
    // The last one, so the other three still cover the unpainted case.
    //
    // Warmed unmerged, and deliberately: a merged body wears the same pool
    // materials and a paint clone of the same shape over the same attributes,
    // so this builds the shaders a merged one needs, and precompiling the
    // bodies before they are merged keeps the prewarm out of the merge's way.
    //
    // Glowing paint is a second variant again, because the layer only grows its
    // emissive atlas once a stroke asks for one and the clone that carries it
    // reads a map the plain paint clone does not. One body wears each, so a peer
    // whose disguise turns up glowing costs no compile either.
    const warmPaint: { layer: PaintLayer; binder: PaintMaterialBinder }[] = [];
    const dressInPaint = (target: MimicVisual | undefined, glowing: boolean): void => {
      if (target === undefined) return;
      const layer = new PaintLayer();
      if (glowing) {
        layer.applyStroke({
          segmentId: 0,
          uv: [0.5, 0.5],
          radius: 0.2,
          color: [1, 1, 1],
          opacity: 1,
          emissive: 1,
          kind: "brush",
        });
      }
      const binder = new PaintMaterialBinder(layer, () => [
        ...target.segmentMeshes,
        ...target.panelMeshes,
      ]);
      binder.sync();
      warmPaint.push({ layer, binder });
    };
    dressInPaint(bodies > 1 ? built[bodies - 1] : undefined, false);
    dressInPaint(bodies > 2 ? built[bodies - 2] : undefined, true);

    await compile();

    // The clones go back before the body is parked, so a disguise that takes it
    // over starts from the pool's own materials exactly as a fresh body does.
    for (const warm of warmPaint) {
      warm.binder.dispose();
      warm.layer.dispose();
    }
    for (const visual of built) this.park(visual);
  }

  /** Bodies waiting in reserve, which is what a hunt entry spends instead of building. */
  get sparedBodies(): number {
    return this.spare.length;
  }

  /** Distinct materials the whole cast shares, however many bodies are standing. */
  get materialCount(): number {
    return this.pool.size;
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
    // A taunt is bait, so where it came from is the point of it: an Inspector
    // has to be able to tell a hider jeering at their elbow from one across the
    // sales floor, and a flat taunt tells them only that somebody did it.
    this.audio?.play(TAUNT_SOUND, TAUNT_PITCH_JITTER, this.gainAt(actor.bounds));
    return true;
  }

  /** How loud a body's gesture is from where the player is standing. */
  private gainAt(bounds: THREE.Box3): number {
    if (this.listener === null) return 1;
    const ear = this.listener();
    if (ear === null) return 1;
    return distanceGain(ear.distanceTo(bounds.getCenter(scratchCentre)));
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
    for (const actor of this.actors.values()) {
      actor.visual.setCastShadow(this.castShadow);
      // A merged mesh casts as a whole, so the flag lives on the merge and the
      // parts' own flags only reach the screen through a re-merge.
      actor.merged.refresh();
    }
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
    for (const actor of this.actors.values()) {
      actor.merged.dispose();
      actor.paint?.dispose();
      actor.visual.dispose();
    }
    this.actors.clear();
    for (const visual of this.spare) visual.dispose();
    this.spare.length = 0;
    this.pool.dispose();
  }

  /**
   * The merge hands the body its own parts back, and then the body itself goes
   * into reserve rather than being destroyed: a disguise leaving is a catch or
   * a rematch, and either way another one is likely to want a body.
   */
  private release(actor: Actor): void {
    actor.merged.dispose();
    actor.paint?.dispose();
    this.park(actor.visual);
  }

  /** Puts a body out of sight and back in the reserve. */
  private park(visual: MimicVisual): void {
    if (this.spare.length >= PREWARM_BODY_COUNT) {
      visual.dispose();
      return;
    }
    visual.root.visible = false;
    // A body released mid-taunt is still leaning. Reserved bodies are left at
    // rest so what a disguise takes over never depends on how it was given up.
    restPose(visual.root);
    setFrustumCulled(visual, true);
    this.spare.push(visual);
  }

  /** A reserved body if there is one, otherwise a new one on the shared pool. */
  private takeBody(publicObjectId: string): MimicVisual {
    const spare = this.spare.pop();
    const visual = spare ?? new MimicVisual(this.pool);
    if (spare === undefined) this.scene.add(visual.root);
    visual.root.name = `disguise-${publicObjectId}`;
    visual.root.visible = true;
    visual.root.position.set(0, 0, 0);
    visual.setCastShadow(this.castShadow);
    return visual;
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
      // Before the box, not after: the merged geometry is measured along with
      // the parts, and one still holding the previous pose would widen it.
      actor.merged.refresh();
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
        actor.merged.setPaint(null);
        actor.paint.dispose();
        actor.paint = null;
      }
      actor.appliedPaint = encodedPaint;
      return;
    }

    const layer = actor.paint ?? new PaintLayer();
    actor.paint = layer;

    if (actor.appliedPaint !== encodedPaint && !layer.fromWireData(encodedPaint)) {
      return;
    }
    actor.appliedPaint = encodedPaint;
    // setPaint() also re-reads the swatch colours a pose update may have
    // changed, which is what the unpainted texels of the layer are printed in.
    actor.merged.setPaint(layer);
    layer.flush();
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
    const visual = this.takeBody(publicObjectId);
    const bounds = new THREE.Box3();
    const actor: Actor = {
      publicObjectId,
      visual,
      merged: new MergedMimicBody(visual),
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
