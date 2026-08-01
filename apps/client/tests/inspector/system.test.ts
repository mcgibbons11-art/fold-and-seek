import type { MatchCommand } from "@foldseek/game-sim";
import { PerspectiveCamera, Scene } from "three";
import { describe, expect, it } from "vitest";

import type { CameraSample } from "../../src/inspector/cameraSamples";
import { InspectableSet, type FocusMetadata } from "../../src/inspector/FocusSystem";
import { WORLD_SCALE } from "../../src/inspector/navData";
import { createInspectorSystem, type InspectorSystem } from "../../src/inspector/index";
import { box, openNavData, testSettings } from "./navFixture";

/**
 * The seam GameHost will use. No DOM element is supplied, which is the headless
 * path: the factory must still wire focus, gaze commands, and telemetry.
 */

const FRAME_MS = 16;
const SHELF = box(-1.2, 0.1, -0.4, -0.8, 0.5, 0.4);

interface Harness {
  readonly system: InspectorSystem;
  readonly scene: Scene;
  readonly commands: MatchCommand[];
  readonly focusChanges: (FocusMetadata | null)[];
  readonly samples: CameraSample[];
}

function harness(): Harness {
  const scene = new Scene();
  const commands: MatchCommand[] = [];
  const focusChanges: (FocusMetadata | null)[] = [];
  const samples: CameraSample[] = [];

  const system = createInspectorSystem({
    scene,
    camera: new PerspectiveCamera(),
    navData: openNavData(),
    inspectables: new InspectableSet([
      {
        objectId: "prop-shelf",
        categoryId: "shelf",
        bounds: SHELF,
        pickProxy: { kind: "box", box: SHELF },
        accusationPolicy: "allowed",
      },
    ]),
    sendCommand: (command) => commands.push(command),
    onFocusChange: (focus) => focusChanges.push(focus),
    settings: testSettings(),
    onCameraSample: (sample) => samples.push(sample),
  });
  system.spawnAt({ position: { x: 0, y: 0, z: 0 }, yaw: Math.PI / 2 });

  return { system, scene, commands, focusChanges, samples };
}

describe("createInspectorSystem", () => {
  it("parents a root to the scene and releases it on dispose", () => {
    const h = harness();
    expect(h.scene.children).toContain(h.system.root);

    h.system.dispose();
    expect(h.scene.children).not.toContain(h.system.root);
  });

  it("reports the object under the reticle and sends one gaze command for it", () => {
    const h = harness();
    for (let frame = 0; frame < 10; frame += 1) h.system.update(FRAME_MS, frame * FRAME_MS);

    expect(h.focusChanges).toHaveLength(1);
    expect(h.focusChanges[0]?.objectId).toBe("prop-shelf");
    expect(h.commands).toEqual([{ type: "focus", targetObjectId: "prop-shelf" }]);
  });

  it("publishes camera samples at the settings rate", () => {
    const h = harness();
    for (let frame = 0; frame < 63; frame += 1) h.system.update(FRAME_MS, frame * FRAME_MS);

    const expected = Math.floor((63 * FRAME_MS) / (1000 / testSettings().cameraSampleHz));
    expect(h.samples.length).toBe(expected);
    expect(h.samples[0]?.y).toBeCloseTo(WORLD_SCALE.eyeHeight, 6);
  });

  it("routes a shot refusal to the gun and ignores other commands", () => {
    const h = harness();
    h.system.update(FRAME_MS, 0);

    h.system.handleRejection({ type: "lock_disguise", reason: "invalid_pose" });
    expect(h.system.weapon.phase).toBe("ready");

    h.system.handleRejection({ type: "accuse", reason: "accusation_cooldown" });
    expect(h.system.weapon.phase).toBe("ready");
  });

  it("passes the warrant count through to the gun as ammunition", () => {
    const h = harness();
    h.system.setAmmo(4);
    expect(h.system.weapon.state.ammo).toBe(4);
  });

  it("clears the reticle when the inspectable registry is replaced", () => {
    const h = harness();
    h.system.update(FRAME_MS, 0);
    expect(h.system.focusSystem.current?.objectId).toBe("prop-shelf");

    h.system.setInspectables(new InspectableSet());
    expect(h.system.focusSystem.current).toBeNull();

    h.system.update(FRAME_MS, FRAME_MS);
    expect(h.system.focusSystem.current).toBeNull();
    expect(h.commands.at(-1)).toEqual({ type: "focus", targetObjectId: null });
  });
});
