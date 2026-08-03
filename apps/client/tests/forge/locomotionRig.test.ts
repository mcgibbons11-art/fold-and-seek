import { describe, expect, it } from "vitest";
import { Quaternion } from "three";

import { LocomotionRig } from "../../src/forge/LocomotionRig";
import {
  MIMIC_RUN_DELTA_LIMIT_RAD,
  MixamoMotion,
} from "../../src/forge/MixamoMotion";
import type { LocomotionSample } from "../../src/forge/BodyLanguage";
import { STRIDE_FACTOR } from "../../src/gameplay/footsteps";
import { WORLD_SCALE } from "../../src/inspector/navData";
import { applyDisguiseStateToPose, createStarterArrangement } from "../../src/mimic/disguiseState";
import { createPoseState, type PoseState } from "../../src/mimic/ikSolver";
import { boneIndex, boneRotationViolation, DEG_TO_RAD } from "../../src/mimic/rig";

/**
 * The gait itself: that the legs actually swing, that they swing against each
 * other and against the arms, that the step is measured in ground covered
 * rather than in seconds, and that none of it can reach the pose the round
 * publishes or the joint ranges the rig is built on.
 */

const FRAME_SECONDS = 1 / 60;
const RUN_SPEED = WORLD_SCALE.playerHeight * 2.4;
const CREEP_SPEED = WORLD_SCALE.playerHeight * 0.6;

const STILL: LocomotionSample = {
  speedFraction: 0,
  travelYaw: 0,
  airborne: false,
  climbing: false,
  creeping: false,
  landingSpeed: 0,
};

const RUNNING: LocomotionSample = { ...STILL, speedFraction: 1 };
const CREEPING: LocomotionSample = { ...STILL, speedFraction: 1, creeping: true };

/**
 * Footfalls taken over a distance. Read off the difference between the two
 * hips, which crosses zero once per step and is free of the crouch a creep
 * holds in both of them.
 */
function steps(sample: LocomotionSample, metres: number, speed: number): number {
  const rig = new LocomotionRig();
  const frames = Math.round(metres / speed / FRAME_SECONDS);
  let crossings = 0;
  let previous = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    rig.update(FRAME_SECONDS, sample, speed);
    const stride = rig.angles.hipL - rig.angles.hipR;
    if (previous !== 0 && Math.sign(stride) !== Math.sign(previous)) crossings += 1;
    previous = stride;
  }
  return crossings;
}

/** A rig already up to speed, so the blends are not still opening. */
function running(): LocomotionRig {
  const rig = new LocomotionRig();
  for (let frame = 0; frame < 60; frame += 1) rig.update(FRAME_SECONDS, RUNNING, RUN_SPEED);
  return rig;
}

/** Peak-to-trough of one channel over a full stride, which is its excursion. */
function excursion(
  rig: LocomotionRig,
  sample: LocomotionSample,
  speed: number,
  read: (rig: LocomotionRig) => number,
): number {
  let lowest = Infinity;
  let highest = -Infinity;
  // Two full cycles' worth of ground, so the sample cannot miss a peak.
  const frames = Math.round((WORLD_SCALE.playerHeight * STRIDE_FACTOR * 4) / speed / FRAME_SECONDS);
  for (let frame = 0; frame < frames; frame += 1) {
    rig.update(FRAME_SECONDS, sample, speed);
    const value = read(rig);
    lowest = Math.min(lowest, value);
    highest = Math.max(highest, value);
  }
  return highest - lowest;
}

describe("the walking gait", () => {
  it("advances exactly one animation cycle per two footfalls of ground", () => {
    const rig = new LocomotionRig();
    const footfallM = WORLD_SCALE.playerHeight * STRIDE_FACTOR;
    rig.update((footfallM * 2) / RUN_SPEED, RUNNING, RUN_SPEED);
    expect(rig.stridePhaseRadians).toBeCloseTo(0, 8);
    rig.update(footfallM / RUN_SPEED, RUNNING, RUN_SPEED);
    expect(rig.stridePhaseRadians).toBeCloseTo(Math.PI, 8);
  });

  it("rebases every Mixamo motion to the Mimic rest pose at frame zero", () => {
    const frames = [
      { run: 1, airborne: 0, climbing: 0, action: null },
      { run: 0, airborne: 1, climbing: 0, action: null },
      { run: 0, airborne: 0, climbing: 1, action: null },
      { run: 0, airborne: 0, climbing: 0, action: "taunt" as const },
      { run: 0, airborne: 0, climbing: 0, action: "hit" as const },
      { run: 0, airborne: 0, climbing: 0, action: "death" as const },
    ];
    for (const frame of frames) {
      const motion = new MixamoMotion();
      if (frame.action !== null) motion.play(frame.action);
      motion.update(1e-9, {
        active: 1,
        run: frame.run,
        airborne: frame.airborne,
        climbing: frame.climbing,
        stridePhase: 0,
        justTookOff: false,
      });
      const pose = createPoseState();
      motion.apply(pose);
      for (const rotation of pose.localRotations) {
        expect(2 * Math.acos(Math.min(1, Math.abs(rotation.w)))).toBeLessThan(2 * DEG_TO_RAD);
      }
    }
  });

  it("draws an explicit hit action even while locomotion is otherwise still", () => {
    const rig = new LocomotionRig();
    const pose = createPoseState();
    rig.playAction("hit");
    for (let frame = 0; frame < 8; frame += 1) rig.update(FRAME_SECONDS, STILL, 0);
    expect(rig.neutral).toBe(false);
    expect(rig.pose(pose)).not.toBe(pose);
  });

  it("swings the legs, and swings them against each other", () => {
    const rig = running();
    const hips = excursion(rig, RUNNING, RUN_SPEED, (r) => r.angles.hipL);
    // A visible stride rather than a twitch: the leg covers tens of degrees.
    expect(hips).toBeGreaterThan(40 * DEG_TO_RAD);

    // Contralateral, which is what walking is: at every instant one hip leads
    // by as much as the other trails.
    for (let frame = 0; frame < 90; frame += 1) {
      rig.update(FRAME_SECONDS, RUNNING, RUN_SPEED);
      expect(rig.angles.hipL).toBeCloseTo(-rig.angles.hipR, 9);
    }
  });

  it("bends the knee only on the leg that is off the ground", () => {
    const rig = running();
    let both = 0;
    let apart = 0;
    for (let frame = 0; frame < 240; frame += 1) {
      rig.update(FRAME_SECONDS, RUNNING, RUN_SPEED);
      const { kneeL, kneeR } = rig.angles;
      // Both knees carry a base flex; only one folds at a time.
      expect(kneeL).toBeGreaterThanOrEqual(0);
      expect(kneeR).toBeGreaterThanOrEqual(0);
      if (Math.abs(kneeL - kneeR) > 20 * DEG_TO_RAD) apart += 1;
      if (kneeL > 20 * DEG_TO_RAD && kneeR > 20 * DEG_TO_RAD) both += 1;
    }
    expect(apart).toBeGreaterThan(0);
    expect(both).toBe(0);
  });

  it("swings each arm against the leg on its own side", () => {
    const rig = running();
    for (let frame = 0; frame < 120; frame += 1) {
      rig.update(FRAME_SECONDS, RUNNING, RUN_SPEED);
      const { hipL, armL } = rig.angles;
      // The hip carries the leg forward on a negative angle and the shoulder
      // carries the arm back on a positive one, so a walking body has the two
      // on opposite signs whenever either is off centre.
      if (Math.abs(hipL) > 5 * DEG_TO_RAD) expect(Math.sign(armL)).toBe(-Math.sign(hipL));
    }
  });

  it("measures the step in ground covered rather than in seconds", () => {
    const distance = WORLD_SCALE.playerHeight * STRIDE_FACTOR * 20;
    const fast = steps(RUNNING, distance, RUN_SPEED);
    // Same ground at three speeds is the same count of steps, which is what
    // makes the visible step land where the footfall sounds. A slower body
    // samples the stride on a finer grid, so the step that falls on the last
    // frame can land either side of it; everything before that is exact.
    expect(fast).toBeGreaterThan(15);
    expect(Math.abs(steps(RUNNING, distance, RUN_SPEED / 3) - fast)).toBeLessThanOrEqual(1);
    expect(Math.abs(steps(RUNNING, distance, RUN_SPEED / 7) - fast)).toBeLessThanOrEqual(1);
  });

  it("creeps in shorter, smaller steps than it runs", () => {
    const creepStride = excursion(new LocomotionRig(), CREEPING, CREEP_SPEED, (r) => r.angles.hipL);
    const runStride = excursion(running(), RUNNING, RUN_SPEED, (r) => r.angles.hipL);
    expect(creepStride).toBeLessThan(runStride * 0.5);

    // And it holds a crouch in the knees that a running body does not.
    const creeping = new LocomotionRig();
    for (let frame = 0; frame < 120; frame += 1) {
      creeping.update(FRAME_SECONDS, { ...CREEPING, speedFraction: 0 }, 0);
    }
    expect(creeping.angles.kneeL).toBeGreaterThan(15 * DEG_TO_RAD);
    expect(running().angles.kneeL).toBeLessThan(creeping.angles.kneeL);
  });

  it("takes more steps per metre creeping than running", () => {
    const metres = WORLD_SCALE.playerHeight * STRIDE_FACTOR * 6;
    expect(steps(CREEPING, metres, CREEP_SPEED)).toBeGreaterThan(
      steps(RUNNING, metres, RUN_SPEED),
    );
  });

  it("holds the authored pose perfectly still while hiding", () => {
    const rig = new LocomotionRig();
    const torsoMotion = excursion(rig, STILL, WORLD_SCALE.playerHeight, (r) => r.angles.torsoPitch);
    const armMotion = excursion(rig, STILL, WORLD_SCALE.playerHeight, (r) => r.angles.armL);
    expect(torsoMotion).toBe(0);
    expect(armMotion).toBe(0);
    expect(rig.neutral).toBe(true);
  });
});

describe("the air and the ground it lands on", () => {
  it("tucks the knees up while the feet are off the ground", () => {
    const rig = running();
    const grounded = rig.angles.kneeL;
    for (let frame = 0; frame < 30; frame += 1) {
      rig.update(FRAME_SECONDS, { ...RUNNING, airborne: true }, RUN_SPEED);
    }
    expect(rig.angles.kneeL).toBeGreaterThan(grounded);
    expect(rig.angles.kneeL).toBeGreaterThan(40 * DEG_TO_RAD);
    // Both legs tuck together: a body in the air is not mid-step.
    expect(rig.angles.kneeL).toBeCloseTo(rig.angles.kneeR, 6);
    // And it stops sinking, because there is no stride to sink through.
    expect(rig.angles.sinkM).toBeLessThan(WORLD_SCALE.playerHeight * 1e-3);
  });

  it("folds deeper for a heavier landing and comes back out of it", () => {
    const fold = (landingSpeed: number): number => {
      const rig = new LocomotionRig();
      rig.update(FRAME_SECONDS, { ...STILL, landingSpeed }, 0);
      let deepest = rig.angles.kneeL;
      for (let frame = 0; frame < 120; frame += 1) {
        rig.update(FRAME_SECONDS, STILL, 0);
        deepest = Math.max(deepest, rig.angles.kneeL);
      }
      return deepest;
    };
    expect(fold(2)).toBeGreaterThan(10 * DEG_TO_RAD);
    expect(fold(4)).toBeGreaterThan(fold(1));
    // Capped, so a fall off the shelving does not fold the creature in half.
    expect(fold(40)).toBeCloseTo(fold(20), 6);

    // And the knee comes back to the walking base rather than staying folded.
    const rig = new LocomotionRig();
    rig.update(FRAME_SECONDS, { ...STILL, landingSpeed: 3 }, 0);
    for (let frame = 0; frame < 240; frame += 1) rig.update(FRAME_SECONDS, STILL, 0);
    expect(rig.angles.kneeL).toBeLessThan(2 * DEG_TO_RAD);
  });

  it("drives the legs straight as the feet leave the ground", () => {
    const rig = running();
    const before = rig.angles.kneeL;
    // The first airborne frame is the takeoff, and the tuck has barely opened.
    rig.update(FRAME_SECONDS, { ...RUNNING, airborne: true }, RUN_SPEED);
    expect(rig.angles.kneeL).toBeLessThan(before);
  });

  it("reaches overhead on a climb instead of stepping", () => {
    const rig = new LocomotionRig();
    for (let frame = 0; frame < 60; frame += 1) {
      rig.update(FRAME_SECONDS, { ...RUNNING, climbing: true }, RUN_SPEED);
    }
    // Both arms up, one further than the other: hand over hand.
    expect(rig.angles.armL).toBeLessThan(-45 * DEG_TO_RAD);
    expect(rig.angles.armR).toBeLessThan(-45 * DEG_TO_RAD);
    expect(rig.angles.armL).not.toBeCloseTo(rig.angles.armR, 3);
  });
});

describe("the gait is drawn, never published", () => {
  /** The authored pose, and a record of every number in it. */
  function authored(arrangement = "upright"): { pose: PoseState; before: string } {
    const pose = createPoseState();
    applyDisguiseStateToPose(createStarterArrangement(arrangement), pose);
    return { pose, before: snapshot(pose) };
  }

  function snapshot(pose: PoseState): string {
    return JSON.stringify({
      root: pose.rootPosition.toArray(),
      rotation: pose.rootRotation.toArray(),
      bones: pose.localRotations.map((q) => q.toArray()),
      world: pose.worldPositions.map((v) => v.toArray()),
    });
  }

  it("leaves the authored pose untouched while it animates", () => {
    const { pose, before } = authored();
    const rig = running();
    for (let frame = 0; frame < 120; frame += 1) {
      rig.update(FRAME_SECONDS, RUNNING, RUN_SPEED);
      const drawn = rig.pose(pose);
      // Genuinely animating: the drawn body is not the authored one.
      expect(drawn).not.toBe(pose);
    }
    expect(snapshot(pose)).toBe(before);
  });

  it("moves the drawn knees a distance a player can see", () => {
    const { pose } = authored();
    const rig = running();
    const knee = boneIndex("shin_L");
    let lowest = Infinity;
    let highest = -Infinity;
    for (let frame = 0; frame < 120; frame += 1) {
      rig.update(FRAME_SECONDS, RUNNING, RUN_SPEED);
      const z = rig.pose(pose).worldPositions[knee]!.z;
      lowest = Math.min(lowest, z);
      highest = Math.max(highest, z);
    }
    // The knee travels a good fraction of the creature's own height fore and
    // aft. Anything less than this reads as a statue on a conveyor, which is
    // exactly what it read as before there was a rig at all.
    expect(highest - lowest).toBeGreaterThan(WORLD_SCALE.playerHeight * 0.15);
  });

  it("retargets full-body Mixamo motion instead of a single-axis procedural swing", () => {
    const pose = createPoseState();
    const rig = running();
    const drawn = rig.pose(pose);
    const animated = drawn.localRotations.filter(
      (rotation) => Math.abs(rotation.x) + Math.abs(rotation.y) + Math.abs(rotation.z) > 0.01,
    );

    expect(animated.length).toBeGreaterThan(10);
    expect(animated.some((rotation) => Math.abs(rotation.y) > 0.02)).toBe(true);
    expect(animated.some((rotation) => Math.abs(rotation.z) > 0.02)).toBe(true);
  });

  it("keeps the run agile without wrenching any forged arrangement", () => {
    let largestMotion = 0;
    for (const arrangement of ["upright", "compact", "tripod", "wall_mount", "shelf_bundle"]) {
      const { pose } = authored(arrangement);
      const rig = new LocomotionRig();
      for (let frame = 0; frame < 180; frame += 1) {
        rig.update(FRAME_SECONDS, RUNNING, RUN_SPEED);
        const drawn = rig.pose(pose);
        for (let bone = 1; bone < drawn.localRotations.length; bone += 1) {
          const authoredInverse = pose.localRotations[bone]!.clone().invert();
          const motion = drawn.localRotations[bone]!.clone().multiply(authoredInverse);
          const angle = new Quaternion().angleTo(motion);
          largestMotion = Math.max(largestMotion, angle);
          expect(angle).toBeLessThanOrEqual(MIMIC_RUN_DELTA_LIMIT_RAD + 1e-6);
        }
      }
    }
    expect(largestMotion).toBeGreaterThan(5 * DEG_TO_RAD);
  });

  it("hands back the authored pose itself once it has been suppressed", () => {
    const { pose, before } = authored();
    const rig = running();
    expect(rig.pose(pose)).not.toBe(pose);

    // A tenth of a second, which is the blend, and it is exactly neutral.
    for (let frame = 0; frame < 30; frame += 1) {
      rig.update(FRAME_SECONDS, RUNNING, RUN_SPEED, true);
    }
    expect(rig.neutral).toBe(true);
    expect(rig.pose(pose)).toBe(pose);
    expect(snapshot(pose)).toBe(before);
  });

  it("eases out rather than cutting, so nothing under the pointer jumps", () => {
    const rig = running();
    let frames = 0;
    while (!rig.neutral && frames < 120) {
      rig.update(FRAME_SECONDS, RUNNING, RUN_SPEED, true);
      frames += 1;
    }
    // Several frames rather than one, so a grip laid out on the body does not
    // move out from under a pointer that had just reached it, and well inside a
    // second, so a locked disguise is standing still long before anyone sees it.
    expect(frames).toBeGreaterThan(3);
    expect(frames).toBeLessThan(30);
  });

  it("keeps every joint inside its own range, whatever the pose it lands on", () => {
    for (const arrangement of ["upright", "compact", "tripod", "wall_mount", "shelf_bundle"]) {
      const { pose } = authored(arrangement);
      const rig = new LocomotionRig();
      for (let frame = 0; frame < 200; frame += 1) {
        rig.update(
          FRAME_SECONDS,
          frame % 40 < 10 ? { ...RUNNING, airborne: true } : RUNNING,
          RUN_SPEED,
        );
        const drawn = rig.pose(pose);
        for (let bone = 1; bone < drawn.localRotations.length; bone += 1) {
          const violation = boneRotationViolation(bone, drawn.localRotations[bone]!);
          expect(violation).toBeLessThan(1e-6);
        }
      }
    }
  });
});
