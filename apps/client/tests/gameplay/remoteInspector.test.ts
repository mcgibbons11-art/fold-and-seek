import { Scene } from "three";
import { describe, expect, it } from "vitest";

import { RemoteInspectorPresentation } from "../../src/gameplay/RemoteInspectorPresentation";
import { WORLD_SCALE } from "../../src/inspector/navData";

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
    });
    remote.update(50);
    expect(remote.root.position.x).toBeGreaterThan(1);
    expect(remote.root.rotation.y).toBeGreaterThan(0);

    remote.dispose();
    expect(scene.getObjectByName("remote-inspector-seat-b")).toBeUndefined();
    expect(scene.getObjectByName("inspector-gun")).toBeUndefined();
  });
});
