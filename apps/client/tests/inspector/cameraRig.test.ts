import { PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";

import { CameraSamplePublisher, type CameraSample } from "../../src/inspector/cameraSamples";
import {
  CAMERA_SKIN_M,
  DEFAULT_BASE_FOV_DEG,
  DEFAULT_BOOM_LENGTH_M,
  DEFAULT_AIM_FOV_DEG,
  InspectorCamera,
} from "../../src/inspector/InspectorCamera";
import { InspectorController } from "../../src/inspector/InspectorController";
import { WORLD_SCALE } from "../../src/inspector/navData";
import { box, openNavData, testNavData, testSettings, WALL } from "./navFixture";

const FRAME_SECONDS = 1 / 60;

/** Yaw that faces -X, putting the boom behind the Inspector at +X. */
const YAW_AWAY_FROM_WALL = Math.PI / 2;

function rig(
  navData = testNavData(),
  x = 0,
): { rig: InspectorCamera; controller: InspectorController } {
  const controller = new InspectorController(navData, testSettings());
  controller.teleportTo({ position: { x, y: 0, z: 0 }, yaw: YAW_AWAY_FROM_WALL });
  return { rig: new InspectorCamera(new PerspectiveCamera(), navData, {}), controller };
}

function settle(
  camera: InspectorCamera,
  controller: InspectorController,
  frames: number,
  aiming: boolean,
): void {
  for (let i = 0; i < frames; i += 1) camera.update(FRAME_SECONDS, controller, aiming);
}

describe("InspectorCamera rig", () => {
  it("sits a boom length behind the eye with clear space behind", () => {
    const { rig: camera, controller } = rig(openNavData());
    settle(camera, controller, 1, false);

    expect(camera.origin.x).toBeCloseTo(DEFAULT_BOOM_LENGTH_M, 3);
    expect(camera.eye.y).toBeCloseTo(WORLD_SCALE.eyeHeight, 6);
    expect(camera.forward.x).toBeCloseTo(-1, 6);
  });

  it("pulls in when the boom would pass through a wall", () => {
    const { rig: camera, controller } = rig(testNavData(), 0.75);
    settle(camera, controller, 1, false);

    expect(camera.origin.x).toBeCloseTo(WALL.min.x - CAMERA_SKIN_M, 3);
    expect(camera.origin.x).toBeLessThan(WALL.min.x);
  });

  it("tightens the field of view and settles sway while aiming", () => {
    const { rig: camera, controller } = rig();
    settle(camera, controller, 1, false);
    expect(camera.aimAmount).toBeLessThan(0.2);
    expect(camera.swayScale).toBeGreaterThan(0.8);

    settle(camera, controller, 120, true);
    expect(camera.aimAmount).toBeGreaterThan(0.99);
    expect(camera.swayScale).toBeLessThan(0.2);

    settle(camera, controller, 120, false);
    expect(camera.aimAmount).toBeLessThan(0.01);
  });

  it("stays between the two authored fields of view throughout the blend", () => {
    const { rig: camera, controller } = rig();
    const seen: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      camera.update(FRAME_SECONDS, controller, true);
      seen.push(
        DEFAULT_BASE_FOV_DEG + (DEFAULT_AIM_FOV_DEG - DEFAULT_BASE_FOV_DEG) * camera.aimAmount,
      );
    }
    for (const fov of seen) {
      expect(fov).toBeLessThanOrEqual(DEFAULT_BASE_FOV_DEG);
      expect(fov).toBeGreaterThanOrEqual(DEFAULT_AIM_FOV_DEG);
    }
    expect(seen[seen.length - 1]).toBeLessThan(seen[0] ?? 0);
  });
});

describe("InspectorCamera target frame", () => {
  it("brackets a target ahead of the camera and reports none behind it", () => {
    const { rig: camera, controller } = rig(openNavData());
    settle(camera, controller, 1, false);

    const ahead = camera.updateTargetFrame(box(-1.2, 0.2, -0.3, -0.8, 0.5, 0.3));
    expect(ahead.visible).toBe(true);
    expect(ahead.maxX).toBeGreaterThan(ahead.minX);
    expect(ahead.maxY).toBeGreaterThan(ahead.minY);
    expect(Math.abs((ahead.minX + ahead.maxX) / 2)).toBeLessThan(0.3);

    const behind = camera.updateTargetFrame(box(2, 0.2, -0.3, 2.4, 0.5, 0.3));
    expect(behind.visible).toBe(false);

    expect(camera.updateTargetFrame(null).visible).toBe(false);
  });
});

describe("CameraSamplePublisher", () => {
  it("emits at the configured rate, not once per frame", () => {
    const samples: CameraSample[] = [];
    const publisher = new CameraSamplePublisher(10, (sample) => samples.push(sample));

    for (let frame = 0; frame < 60; frame += 1) {
      publisher.update(16, frame * 16, 1, 2, 3, 0.5, -0.25);
    }

    expect(samples.length).toBeGreaterThanOrEqual(9);
    expect(samples.length).toBeLessThanOrEqual(10);
    expect(samples[0]).toMatchObject({ x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.25 });
  });

  it("publishes nothing at zero hertz and drops a long stall rather than bursting", () => {
    const silent: CameraSample[] = [];
    new CameraSamplePublisher(0, (sample) => silent.push(sample)).update(1000, 0, 0, 0, 0, 0, 0);
    expect(silent).toHaveLength(0);

    const stalled: CameraSample[] = [];
    const publisher = new CameraSamplePublisher(10, (sample) => stalled.push(sample));
    publisher.update(5_000, 5_000, 0, 0, 0, 0, 0);
    publisher.update(16, 5_016, 0, 0, 0, 0, 0);
    expect(stalled).toHaveLength(1);
  });
});
