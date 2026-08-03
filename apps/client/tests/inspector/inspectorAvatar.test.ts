import { describe, expect, it } from "vitest";

import {
  INSPECTOR_ASSET_SHA256,
  INSPECTOR_ASSET_URL,
  INSPECTOR_RUN_ANIMATION_WEIGHT,
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

  it("cache-busts the authored asset with its checked-in identity", () => {
    expect(INSPECTOR_ASSET_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(INSPECTOR_ASSET_URL).toBe(
      `assets/characters/inspector-curator.glb?v=${INSPECTOR_ASSET_SHA256.slice(0, 16)}`,
    );
  });
});
