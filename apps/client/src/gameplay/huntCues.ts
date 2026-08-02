import type { InnocentReactionId } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import * as THREE from "three/webgpu";

import { distanceGain } from "../audio/distance";
import type { AudioPlayer, SoundId } from "../forge/AudioPlayer";
import { mapObject } from "../world/maps/registry";

/**
 * What the hunt's public events sound and look like.
 *
 * The simulation names an outcome (`clock_chimes`) and the bundle names a file
 * (`clock_chime.mp3`); the two vocabularies are close enough to be mistaken for
 * one and are not the same, so the crossing is written out here rather than
 * derived from the string. Adding a reaction to the simulation therefore breaks
 * this table at compile time instead of playing nothing at run time.
 */

/** Anything that can make a noise. Narrow enough for a test to stand in for. */
export type SoundCue = Pick<AudioPlayer, "play">;

/**
 * A taunt used to borrow `unfold_reveal`, the three-and-a-half second
 * transformation flourish, which announced a hider baiting the Inspector as
 * though the round had ended. It has its own short, impudent sound now, and
 * `unfold_reveal` went to the reveal, where bodies actually do unfold.
 */
export const TAUNT_SOUND: SoundId = "taunt_call";
export const CATCH_SOUND: SoundId = "caught_sting";
export const WRONG_ACCUSATION_SOUND: SoundId = "wrong_horn";
/** An Inspector sweeping past a hider without seeing them, heard by the hider. */
export const CLOSE_PASS_SOUND: SoundId = "close_pass_riser";
/** A hider survived a look straight at them. */
export const ESCAPE_SOUND: SoundId = "escape_relief";
/** How the match resolved, from the viewer's own side of it. */
export const WIN_SOUND: SoundId = "win_sting";
export const LOSE_SOUND: SoundId = "lose_sting";

export const REACTION_SOUNDS: Readonly<Record<InnocentReactionId, SoundId>> = {
  lamp_turns_on: "lamp_switch",
  chair_squeaks: "chair_squeak",
  vase_dust_puff: "vase_dust_puff",
  clock_chimes: "clock_chime",
  kettle_whistles: "kettle_whistle",
};

/**
 * What a phase sounds like as it opens. A phase absent from this table opens in
 * silence, which is now only the ones that are genuinely a continuation: the
 * loading screen, the map fly-in and the baseline scan all sit under beds that
 * are already playing.
 *
 * The hunt opens on two sounds at once because it is two things at once: the
 * shop door letting the Inspector in, and the room going from workshop to hunt.
 * Every role hears both, and a hider hearing the door is the whole tension of
 * the phase opening. The reveal is two for the same reason: the bodies unfold
 * and then the round resolves over the top of them.
 *
 * `MatchPhase.Locking` is deliberately absent. The Forge plays `lock_seal` as it
 * freezes the disguise, and a second one here would double it.
 */
export const PHASE_SOUNDS: Partial<Readonly<Record<MatchPhase, readonly SoundId[]>>> = {
  [MatchPhase.RoleReveal]: ["role_reveal"],
  [MatchPhase.Forge]: ["forge_start"],
  [MatchPhase.InspectionIntro]: ["door_open", "hunt_riser"],
  [MatchPhase.Reveal]: ["unfold_reveal", "reveal_swell"],
  [MatchPhase.Results]: ["results_resolve"],
  [MatchPhase.RematchVote]: ["rematch_tick"],
};

/** How an innocent object protests when a warrant is spent on it (§5.10). */
interface ReactionLook {
  readonly colour: number;
  readonly durationMs: number;
  /** Radius the flare grows to, as a share of the prop's own height. */
  readonly spread: number;
  /** Whether the flare also throws light, for a reaction that is a light. */
  readonly lit: boolean;
}

const REACTION_LOOKS: Readonly<Record<InnocentReactionId, ReactionLook>> = {
  lamp_turns_on: { colour: 0xffd7a0, durationMs: 900, spread: 0.5, lit: true },
  chair_squeaks: { colour: 0xd8c39a, durationMs: 420, spread: 0.28, lit: false },
  vase_dust_puff: { colour: 0xcfc4b0, durationMs: 1_100, spread: 0.8, lit: false },
  clock_chimes: { colour: 0xe0c070, durationMs: 800, spread: 0.4, lit: true },
  kettle_whistles: { colour: 0xe8e0d4, durationMs: 900, spread: 0.6, lit: false },
};

/** Peak brightness of the flare, before the fade takes it down. */
const FLARE_OPACITY = 0.42;
const FLARE_LIGHT_INTENSITY = 2.4;
const FLARE_SEGMENTS = 10;
/** How far a lit reaction throws light, as a multiple of the flare's radius. */
const FLARE_LIGHT_RANGE = 8;
/** Floor on the prop height a flare is sized from, for a very flat object. */
const MIN_PROP_HEIGHT_M = 0.05;
/** Detune, so two objects protesting at once do not sound like one. */
const REACTION_PITCH_JITTER = 0.06;

interface Flare {
  readonly mesh: THREE.Mesh;
  /**
   * Its own material, because two flares alight at once fade independently and
   * a shared one would drag them both down together. The geometry is shared.
   */
  readonly material: THREE.MeshBasicMaterial;
  readonly light: THREE.PointLight | null;
  readonly radiusM: number;
  readonly durationMs: number;
  elapsedMs: number;
}

/**
 * The world's answer to a wrong accusation. The shop's props are merged and
 * instanced into shared draw calls, so an individual chair cannot be squeaked
 * by moving it; what the map does publish is where each prop stands and how big
 * it is, and a short flare at that spot tells the Inspector which object just
 * denied being a person. It is the reaction, not the prop, that animates.
 */
export class ReactionTheatre {
  private readonly scene: THREE.Scene;
  private readonly audio: SoundCue | null;
  private readonly listener: (() => THREE.Vector3 | null) | null;
  private readonly flares: Flare[] = [];
  /** One unit sphere for every flare this theatre ever raises. */
  private geometry: THREE.SphereGeometry | null = null;

  constructor(
    scene: THREE.Scene,
    audio: SoundCue | null = null,
    listener: (() => THREE.Vector3 | null) | null = null,
  ) {
    this.scene = scene;
    this.audio = audio;
    this.listener = listener;
  }

  /**
   * Plays one reaction. An object the map does not know is heard but not seen:
   * the sound still belongs to the shot, and inventing a position for it would
   * put a flare somewhere nothing stands.
   */
  play(objectId: string, reactionId: InnocentReactionId): void {
    const entry = mapObject(objectId);
    // An object the map does not know is heard at full volume rather than
    // guessed at: there is no position to be far from, and inventing one would
    // quieten a reaction for a distance nothing measured.
    const centre = entry === null ? null : entry.focusBounds.getCenter(new THREE.Vector3());
    this.audio?.play(REACTION_SOUNDS[reactionId], REACTION_PITCH_JITTER, this.gainAt(centre));

    if (entry === null) return;

    const look = REACTION_LOOKS[reactionId];
    const size = entry.focusBounds.getSize(new THREE.Vector3());
    const radiusM = Math.max(size.y, MIN_PROP_HEIGHT_M) * look.spread;

    const material = new THREE.MeshBasicMaterial({
      color: look.colour,
      transparent: true,
      opacity: FLARE_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.geometry ??= new THREE.SphereGeometry(1, FLARE_SEGMENTS, FLARE_SEGMENTS);
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.name = `reaction-${objectId}`;
    entry.focusBounds.getCenter(mesh.position);
    mesh.scale.setScalar(0.001);
    this.scene.add(mesh);

    let light: THREE.PointLight | null = null;
    if (look.lit) {
      light = new THREE.PointLight(look.colour, FLARE_LIGHT_INTENSITY, radiusM * FLARE_LIGHT_RANGE);
      light.position.copy(mesh.position);
      this.scene.add(light);
    }

    this.flares.push({ mesh, material, light, radiusM, durationMs: look.durationMs, elapsedMs: 0 });
  }

  /** Grows every live flare and fades it out. Called from the frame loop. */
  update(dtMs: number): void {
    for (let index = this.flares.length - 1; index >= 0; index -= 1) {
      const flare = this.flares[index];
      if (flare === undefined) continue;
      flare.elapsedMs += dtMs;
      const t = flare.elapsedMs / flare.durationMs;
      if (t >= 1) {
        this.flares.splice(index, 1);
        this.release(flare);
        continue;
      }
      // Fast out, slow settle: the object answers at once and the answer hangs.
      flare.mesh.scale.setScalar(flare.radiusM * Math.sqrt(t));
      flare.material.opacity = FLARE_OPACITY * (1 - t);
      if (flare.light !== null) flare.light.intensity = FLARE_LIGHT_INTENSITY * (1 - t);
    }
  }

  /** Flares still playing, which is what a test without a renderer can see. */
  get count(): number {
    return this.flares.length;
  }

  /** How loud a reaction is for standing where the listener stands. */
  private gainAt(position: THREE.Vector3 | null): number {
    if (position === null || this.listener === null) return 1;
    const ear = this.listener();
    return ear === null ? 1 : distanceGain(ear.distanceTo(position));
  }

  dispose(): void {
    for (const flare of this.flares) this.release(flare);
    this.flares.length = 0;
    this.geometry?.dispose();
    this.geometry = null;
  }

  /** The shared geometry outlives the flare and belongs to `dispose`. */
  private release(flare: Flare): void {
    flare.mesh.removeFromParent();
    flare.material.dispose();
    flare.light?.removeFromParent();
    flare.light?.dispose();
  }
}
