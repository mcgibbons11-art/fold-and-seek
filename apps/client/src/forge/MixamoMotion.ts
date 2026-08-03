import { Quaternion } from "three";

import { type PoseState } from "../mimic/ikSolver";
import { boneIndex, clampBoneRotation } from "../mimic/rig";
import {
  MIXAMO_BONE_NAMES,
  MIXAMO_CLIPS,
  type MixamoClipData,
  type MixamoClipName,
} from "./mixamoClips.generated";

const TAU = Math.PI * 2;
/** The authored fall is 4.4 s; a caught Mimic should collapse in about 1.5 s. */
export const MIMIC_DEATH_PLAYBACK_RATE = 3;

/** Mixamo actions that can temporarily take control of the Mimic's whole body. */
export type MimicAction = Extract<MixamoClipName, "taunt" | "hit" | "death">;

export interface MixamoLocomotionFrame {
  /** Overall authoring/lock fade supplied by LocomotionRig. */
  active: number;
  /** Visible run-cycle strength after creep and grounded state are accounted for. */
  run: number;
  airborne: number;
  climbing: number;
  /** Existing distance-driven gait phase, in radians. */
  stridePhase: number;
  justTookOff: boolean;
}

interface WeightedClip {
  name: MixamoClipName;
  weight: number;
  phase: number;
  normalizedPhase?: boolean;
}

/** Maps action clock time onto its clip while keeping death terminal. */
export function mimicActionPlaybackSeconds(
  action: MimicAction,
  elapsedSeconds: number,
  durationSeconds: number,
): number {
  const playback = action === "death" ? elapsedSeconds * MIMIC_DEATH_PLAYBACK_RATE : elapsedSeconds;
  return Math.min(playback, durationSeconds);
}

const BONE_INDICES = MIXAMO_BONE_NAMES.map((name) => boneIndex(name));

/**
 * Samples authenticated Mixamo animation onto the Mimic's native skeleton.
 *
 * The baked clips contain bone-local rotation deltas, not a replacement mesh.
 * Applying those deltas over the authored pose is what lets a reshaped, painted
 * Mimic keep every Forge choice while gaining a human-quality performance.
 */
export class MixamoMotion {
  private elapsedSeconds = 0;
  private jumpSeconds = 0;
  private action: MimicAction | null = null;
  private actionSeconds = 0;

  private active = 0;
  private run = 0;
  private airborne = 0;
  private climbing = 0;
  private stridePhase = 0;

  private readonly from = new Quaternion();
  private readonly to = new Quaternion();
  private readonly sampled = new Quaternion();
  private readonly reference = new Quaternion();
  private readonly referenceInverse = new Quaternion();
  private readonly mixed = new Quaternion();
  private readonly delta = new Quaternion();

  /** True when sampling this layer can make no visible joint change. */
  get neutral(): boolean {
    if (this.active <= 0) return true;
    if (this.action !== null) return false;
    return this.run <= 0 && this.airborne <= 0 && this.climbing <= 0;
  }

  reset(): void {
    this.elapsedSeconds = 0;
    this.jumpSeconds = 0;
    this.action = null;
    this.actionSeconds = 0;
    this.active = 0;
    this.run = 0;
    this.airborne = 0;
    this.climbing = 0;
    this.stridePhase = 0;
  }

  update(dtSeconds: number, frame: MixamoLocomotionFrame): void {
    this.elapsedSeconds += dtSeconds;
    if (frame.justTookOff) this.jumpSeconds = 0;
    if (frame.airborne > 0) this.jumpSeconds += dtSeconds;

    this.active = clamp01(frame.active);
    this.run = clamp01(frame.run);
    this.airborne = clamp01(frame.airborne);
    this.climbing = clamp01(frame.climbing);
    this.stridePhase = ((frame.stridePhase % TAU) + TAU) % TAU;

    if (this.action !== null) {
      this.actionSeconds += dtSeconds;
      const clip = MIXAMO_CLIPS[this.action];
      if (this.action !== "death" && this.actionSeconds >= clipDuration(clip)) {
        this.action = null;
        this.actionSeconds = 0;
      }
    }
  }

  /** Starts a one-shot performance. Death holds its final pose until reset. */
  play(action: MimicAction): void {
    this.action = action;
    this.actionSeconds = 0;
  }

  /** Applies the current full-body performance over an already copied pose. */
  apply(pose: PoseState): void {
    if (this.active <= 0) return;

    const clips = this.weightedClips();
    if (clips.length === 0) return;

    for (let slot = 0; slot < BONE_INDICES.length; slot += 1) {
      let totalWeight = 0;
      this.mixed.identity();

      for (const entry of clips) {
        if (entry.weight <= 0) continue;
        this.sample(entry.name, entry.phase, slot, this.sampled, entry.normalizedPhase ?? false);
        if (totalWeight === 0) {
          this.mixed.copy(this.sampled);
          totalWeight = entry.weight;
        } else {
          const nextWeight = totalWeight + entry.weight;
          this.mixed.slerp(this.sampled, entry.weight / nextWeight);
          totalWeight = nextWeight;
        }
      }

      if (totalWeight <= 0) continue;
      // The unused share is identity, so a quiet idle remains a quiet idle and
      // an authored extreme pose is never obliterated by the animation layer.
      this.delta.identity().slerp(this.mixed, Math.min(1, totalWeight));
      const bone = BONE_INDICES[slot]!;
      pose.localRotations[bone]!.premultiply(this.delta);
      clampBoneRotation(bone, pose.localRotations[bone]!);
    }
  }

  private weightedClips(): WeightedClip[] {
    if (this.action !== null) {
      const clip = MIXAMO_CLIPS[this.action];
      const time = mimicActionPlaybackSeconds(
        this.action,
        this.actionSeconds,
        clipDuration(clip),
      );
      return [{ name: this.action, weight: this.active, phase: time }];
    }

    const climb = this.active * this.climbing;
    const jump = this.active * this.airborne * (1 - this.climbing);
    const run = this.active * this.run * (1 - this.airborne) * (1 - this.climbing);
    return [
      {
        name: "run",
        weight: run,
        phase: this.stridePhase / TAU,
        normalizedPhase: true,
      },
      { name: "jump", weight: jump, phase: this.jumpSeconds },
      { name: "climb", weight: climb, phase: this.elapsedSeconds },
    ];
  }

  private sample(
    name: MixamoClipName,
    phase: number,
    boneSlot: number,
    output: Quaternion,
    normalizedPhase: boolean,
  ): void {
    const clip = MIXAMO_CLIPS[name];
    const last = clip.frames.length - 1;
    if (last <= 0) {
      output.identity();
      return;
    }

    let frame = normalizedPhase ? phase * last : phase * clip.fps;
    if (clip.loop) {
      frame = ((frame % last) + last) % last;
    } else {
      frame = Math.min(last, Math.max(0, frame));
    }
    const firstFrame = Math.floor(frame);
    const secondFrame = clip.loop ? (firstFrame + 1) % last : Math.min(last, firstFrame + 1);
    readQuaternion(clip.frames[firstFrame]!, boneSlot, this.from);
    readQuaternion(clip.frames[secondFrame]!, boneSlot, this.to);
    output.slerpQuaternions(this.from, this.to, frame - firstFrame);

    // Mixamo's first keyed pose is not the Mimic's upright rest pose. Applying
    // it as an absolute delta is what produced the old permanent crossed-leg /
    // raised-arm silhouette. Rebase every clip to its own authenticated frame 0
    // before it reaches the Mimic: frame 0 becomes identity, and every later
    // frame is the motion away from that pose. The result is then projected
    // through the Mimic's own joint limits by `apply` above.
    readQuaternion(clip.frames[0]!, boneSlot, this.reference);
    this.referenceInverse.copy(this.reference).invert();
    output.multiply(this.referenceInverse).normalize();
  }
}

function readQuaternion(frame: readonly number[], boneSlot: number, output: Quaternion): void {
  const offset = boneSlot * 4;
  output.set(frame[offset]!, frame[offset + 1]!, frame[offset + 2]!, frame[offset + 3]!).normalize();
}

function clipDuration(clip: MixamoClipData): number {
  return Math.max(0, clip.frames.length - 1) / clip.fps;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
