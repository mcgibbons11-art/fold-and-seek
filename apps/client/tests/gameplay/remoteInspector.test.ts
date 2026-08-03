import { Scene } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteInspectorPresentation } from "../../src/gameplay/RemoteInspectorPresentation";
import { InspectorBody, type InspectorBodyFrame } from "../../src/inspector/InspectorBody";
import { WORLD_SCALE } from "../../src/inspector/navData";

const STILL = {
  airborne: false,
  climbing: false,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remote Inspector presentation", () => {
  it("creates a complete articulated body and follows sparse eye samples", () => {
    const scene = new Scene();
    const remote = new RemoteInspectorPresentation(scene, "seat-b", false);
    remote.push({
      atMs: 100,
      x: 1,
      y: WORLD_SCALE.eyeHeight,
      z: 2,
      yaw: 0,
      pitch: 0,
      ...STILL,
    });
    remote.update(16);

    expect(remote.root.position.x).toBeCloseTo(1);
    expect(remote.root.position.y).toBeCloseTo(0);
    expect(remote.root.position.z).toBeCloseTo(2);
    expect(scene.getObjectByName("inspector-body")).toBeDefined();
    expect(scene.getObjectByName("inspector-gun")).toBeDefined();

    remote.push({
      atMs: 200,
      x: 1.1,
      y: WORLD_SCALE.eyeHeight,
      z: 2,
      yaw: 0.2,
      pitch: 0.1,
      ...STILL,
    });
    remote.update(50);
    expect(remote.root.position.x).toBeGreaterThan(1);
    expect(remote.root.rotation.y).toBeGreaterThan(0);

    remote.dispose();
    expect(scene.getObjectByName("remote-inspector-seat-b")).toBeUndefined();
    expect(scene.getObjectByName("inspector-gun")).toBeUndefined();
  });

  it("uses achieved horizontal velocity for gait and ignores pure vertical motion", () => {
    const frames: InspectorBodyFrame[] = [];
    vi.spyOn(InspectorBody.prototype, "update").mockImplementation((_dt, frame) => {
      frames.push(frame);
    });
    const remote = new RemoteInspectorPresentation(new Scene(), "seat-vertical", false);
    remote.push({ atMs: 0, x: 1, y: 1, z: 2, yaw: 0, pitch: 0, ...STILL });
    remote.push({ atMs: 100, x: 1, y: 2, z: 2, yaw: 0, pitch: 0, airborne: true, climbing: false });
    remote.update(16);

    expect(remote.achievedHorizontalVelocity).toEqual([0, 0]);
    expect(frames.at(-1)).toMatchObject({ speedMps: 0, airborne: true, climbing: false });
    remote.dispose();
  });

  it("derives the same speed and direction at different sample rates", () => {
    const frames: InspectorBodyFrame[] = [];
    vi.spyOn(InspectorBody.prototype, "update").mockImplementation((_dt, frame) => {
      frames.push(frame);
    });
    const sparse = new RemoteInspectorPresentation(new Scene(), "seat-sparse", false);
    sparse.push({ atMs: 0, x: 0, y: 1, z: 0, yaw: 0, pitch: 0, ...STILL });
    sparse.push({ atMs: 100, x: 0.12, y: 1, z: -0.16, yaw: 0, pitch: 0, ...STILL });
    const sparseVelocity = sparse.achievedHorizontalVelocity;
    sparse.update(16);
    const sparseSpeed = frames.at(-1)?.speedMps;

    const frequent = new RemoteInspectorPresentation(new Scene(), "seat-frequent", false);
    frequent.push({ atMs: 0, x: 0, y: 1, z: 0, yaw: 0, pitch: 0, ...STILL });
    frequent.push({ atMs: 50, x: 0.06, y: 1, z: -0.08, yaw: 0, pitch: 0, ...STILL });
    frequent.push({ atMs: 100, x: 0.12, y: 1, z: -0.16, yaw: 0, pitch: 0, ...STILL });
    const frequentVelocity = frequent.achievedHorizontalVelocity;
    frequent.update(16);
    const frequentSpeed = frames.at(-1)?.speedMps;

    expect(frequentVelocity[0]).toBeCloseTo(sparseVelocity[0]);
    expect(frequentVelocity[1]).toBeCloseTo(sparseVelocity[1]);
    expect(frequentSpeed).toBeCloseTo(sparseSpeed ?? -1);
    expect(frequentVelocity[0]).toBeGreaterThan(0);
    expect(frequentVelocity[1]).toBeLessThan(0);
    sparse.dispose();
    frequent.dispose();
  });

  it("forwards airborne and climbing transitions and emits landing once", () => {
    const frames: InspectorBodyFrame[] = [];
    vi.spyOn(InspectorBody.prototype, "update").mockImplementation((_dt, frame) => {
      frames.push(frame);
    });
    const remote = new RemoteInspectorPresentation(new Scene(), "seat-traversal", false);
    remote.push({ atMs: 0, x: 0, y: 1.2, z: 0, yaw: 0, pitch: 0, airborne: true, climbing: false });
    remote.update(16);
    remote.push({ atMs: 100, x: 0, y: 1.5, z: 0, yaw: 0, pitch: 0, airborne: true, climbing: true });
    remote.update(16);
    remote.push({ atMs: 200, x: 0, y: 1.2, z: 0, yaw: 0, pitch: 0, ...STILL });
    remote.update(16);
    remote.update(16);

    expect(frames.map(({ airborne, climbing }) => [airborne, climbing])).toEqual([
      [true, false],
      [true, true],
      [false, false],
      [false, false],
    ]);
    expect(frames[2]?.landingSpeed).toBeCloseTo(3);
    expect(frames[3]?.landingSpeed).toBe(0);
    remote.dispose();
  });

  it("fires the remote body once per authoritative warrant sequence", () => {
    const fire = vi.spyOn(InspectorBody.prototype, "fire").mockImplementation(() => undefined);
    const remote = new RemoteInspectorPresentation(new Scene(), "seat-shot", false);

    expect(remote.fire(41)).toBe(true);
    expect(remote.fire(41)).toBe(false);
    expect(remote.fire(42)).toBe(true);
    expect(remote.fire(40)).toBe(false);
    expect(fire).toHaveBeenCalledTimes(2);
    remote.dispose();
  });
});
