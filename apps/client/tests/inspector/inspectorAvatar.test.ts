import { describe, expect, it } from "vitest";

import {
  INSPECTOR_ASSET_SHA256,
  INSPECTOR_ASSET_URL,
  INSPECTOR_RUN_ANIMATION_WEIGHT,
  INSPECTOR_RUN_SWAY_KEEP,
  calmInspectorRunClip,
  inspectorActionForFrame,
  inspectorUsesGunIk,
  sanitizeInspectorClip,
} from "../../src/inspector/InspectorAvatar";
import * as THREE from "three";
import type { InspectorBodyFrame } from "../../src/inspector/InspectorBody";

const STILL: InspectorBodyFrame = {
  speedMps: 0,
  speedCapMps: 1,
  airborne: false,
  climbing: false,
  landingSpeed: 0,
  pitch: 0,
  aimAmount: 0,
};

describe("authored Inspector action selection", () => {
  it("moves from rifle idle into running at the first meaningful movement", () => {
    expect(inspectorActionForFrame(STILL)).toBe("rifle-idle");
    expect(inspectorActionForFrame({ ...STILL, speedMps: 0.04 })).toBe("rifle-idle");
    expect(inspectorActionForFrame({ ...STILL, speedMps: 0.06 })).toBe("run");
    // Once the stride is live it blends down through low residual velocity
    // instead of flashing idle/run while the controller decelerates.
    expect(inspectorActionForFrame({ ...STILL, speedMps: 0.04 }, true)).toBe("run");
    expect(inspectorActionForFrame({ ...STILL, speedMps: 0.02 }, true)).toBe("rifle-idle");
  });

  it("gives airborne and climbing actions priority over ground speed", () => {
    expect(inspectorActionForFrame({ ...STILL, speedMps: 1, airborne: true })).toBe("jump");
    expect(
      inspectorActionForFrame({ ...STILL, speedMps: 1, airborne: true, climbing: true }),
    ).toBe("climb");
  });

  it("keeps reactions full-body and death terminal", () => {
    expect(inspectorUsesGunIk("none")).toBe(true);
    expect(inspectorUsesGunIk("hit")).toBe(false);
    expect(inspectorUsesGunIk("death")).toBe(false);
  });

  it("removes the corrupt left-arm flourish from the fire take", () => {
    const clip = new THREE.AnimationClip("rifle-fire", 1, [
      new THREE.QuaternionKeyframeTrack("LeftArm.quaternion", [0], [0, 0, 0, 1]),
      new THREE.QuaternionKeyframeTrack("RightArm.quaternion", [0], [0, 0, 0, 1]),
      new THREE.QuaternionKeyframeTrack("mixamorig_LeftForeArm.quaternion", [0], [0, 0, 0, 1]),
    ]);

    expect(sanitizeInspectorClip(clip).tracks.map((track) => track.name)).toEqual([
      "RightArm.quaternion",
    ]);
  });

  it("tones down the authored run instead of applying its full swagger", () => {
    expect(INSPECTOR_RUN_ANIMATION_WEIGHT).toBeGreaterThan(0.5);
    expect(INSPECTOR_RUN_ANIMATION_WEIGHT).toBeLessThan(0.8);
  });

  it("shrinks the run's hip sway around its average without touching the legs", () => {
    const sway = 0.4;
    const rollKey = (angleRad: number) => [0, 0, Math.sin(angleRad / 2), Math.cos(angleRad / 2)];
    // A hip rolling +/- sway around identity, and a leg swinging the same way.
    const oscillation = [...rollKey(sway), ...rollKey(0), ...rollKey(-sway), ...rollKey(0)];
    const clip = new THREE.AnimationClip("run", 1, [
      new THREE.QuaternionKeyframeTrack("mixamorig_Hips.quaternion", [0, 0.25, 0.5, 0.75], [
        ...oscillation,
      ]),
      new THREE.QuaternionKeyframeTrack("RightLeg.quaternion", [0, 0.25, 0.5, 0.75], [
        ...oscillation,
      ]),
    ]);

    calmInspectorRunClip(clip);

    const keep = INSPECTOR_RUN_SWAY_KEEP.find(([bone]) => bone === "hips")?.[1] ?? 0;
    const hips = new THREE.Quaternion().fromArray(Array.from(clip.tracks[0]!.values), 0);
    const hipAngle = 2 * Math.asin(Math.abs(hips.z));
    expect(hipAngle).toBeCloseTo(sway * keep, 3);

    const leg = new THREE.Quaternion().fromArray(Array.from(clip.tracks[1]!.values), 0);
    expect(2 * Math.asin(Math.abs(leg.z))).toBeCloseTo(sway, 5);
  });

  it("leaves every clip other than the run untouched", () => {
    const clip = new THREE.AnimationClip("jump", 1, [
      new THREE.QuaternionKeyframeTrack(
        "mixamorig_Hips.quaternion",
        [0],
        [0, 0, Math.sin(0.2), Math.cos(0.2)],
      ),
    ]);
    const before = Array.from(clip.tracks[0]!.values);

    calmInspectorRunClip(clip);

    expect(Array.from(clip.tracks[0]!.values)).toEqual(before);
  });

  it("cache-busts the authored asset with its checked-in identity", () => {
    expect(INSPECTOR_ASSET_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(INSPECTOR_ASSET_URL).toBe(
      `assets/characters/inspector-curator.glb?v=${INSPECTOR_ASSET_SHA256.slice(0, 16)}`,
    );
  });
});
