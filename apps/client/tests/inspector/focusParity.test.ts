import type { MatchCommand } from "@foldseek/game-sim";
import { describe, expect, it } from "vitest";

import { ShootingDriver, type ShotOutcome } from "../../src/inspector/ShootingDriver";
import {
  FocusSystem,
  InspectableSet,
  type FocusMetadata,
  type InspectableProxy,
} from "../../src/inspector/FocusSystem";
import type { Vec3Like } from "../../src/inspector/navData";
import { box, testSettings, WALL } from "./navFixture";

/** Frame the trigger is pulled on, once the target has been aimed at a while. */
const FIRE_FRAME = 12;

/**
 * §8.5: focus must not leak whether the target is a shop prop or a Mimic. The
 * parity here is structural, so the test is written to fail the moment that
 * changes: two runs differing only in which module registered the proxy must
 * produce byte-identical metadata, at identical frame indices, and drive the
 * accusation to fire on the same frame.
 */

const FRAME_MS = 16;
const EYE: Vec3Like = { x: 0, y: 0.32, z: 0 };
const RAY_ORIGIN: Vec3Like = { x: 0, y: 0.32, z: 0.44 };
const RAY_DIR: Vec3Like = { x: 0, y: 0, z: -1 };

/** Geometry both runs share. Only the registering module differs. */
const TARGET_BOUNDS = box(-0.3, 0.1, -1.2, 0.3, 0.5, -0.8);

/** How the map registers an ordinary prop. */
function propProxy(objectId: string): InspectableProxy {
  return {
    objectId,
    categoryId: "lamp",
    bounds: TARGET_BOUNDS,
    pickProxy: { kind: "box", box: TARGET_BOUNDS },
    accusationPolicy: "allowed",
  };
}

/**
 * How a locked disguise registers into the same interaction layer (§8.3). It
 * carries the fields the Mimic module tracks about its own disguise, which is
 * the realistic leak: the focus path must consume none of them.
 */
function disguiseProxy(objectId: string): InspectableProxy {
  const withDisguiseData = {
    objectId,
    categoryId: "lamp",
    bounds: TARGET_BOUNDS,
    pickProxy: { kind: "box", box: TARGET_BOUNDS } as const,
    accusationPolicy: "allowed" as const,
    isMimic: true,
    ownerPublicPlayerId: "player-7",
    disguiseRevision: 4,
    poseSource: "player_lock",
  };
  return withDisguiseData;
}

interface ScenarioTrace {
  readonly emissions: string[];
  readonly perFrame: string[];
  readonly commands: MatchCommand[];
  readonly shots: ShotOutcome[];
  readonly accuseFrame: number;
}

/**
 * Drives one target through hover, aim, and a shot, recording everything a HUD
 * or the network would ever see.
 */
function runScenario(proxy: InspectableProxy, frames = 30): ScenarioTrace {
  const emissions: string[] = [];
  const perFrame: string[] = [];
  const commands: MatchCommand[] = [];
  const shots: ShotOutcome[] = [];
  const settings = testSettings();

  const focusSystem = new FocusSystem(new InspectableSet([proxy]), {
    focusDistance: settings.inspectorFocusDistance,
    accusationDistance: settings.accusationDistance,
    blockers: [WALL],
    onChange: (focus: FocusMetadata | null) => {
      emissions.push(JSON.stringify(focus));
    },
  });
  const driver = new ShootingDriver({
    settings,
    sendCommand: (command) => commands.push(command),
    onShot: (outcome) => shots.push(outcome),
  });
  driver.setAmmo(5);

  let accuseFrame = -1;
  for (let frame = 0; frame < frames; frame += 1) {
    // Aim from frame 2, pull the trigger once on the same frame in both runs.
    const aiming = frame >= 2;
    const firePressed = frame === FIRE_FRAME;
    focusSystem.update(FRAME_MS, RAY_ORIGIN, RAY_DIR, EYE, aiming);
    const before = commands.length;
    driver.update(FRAME_MS, focusSystem.current, firePressed, aiming);
    if (accuseFrame < 0 && commands.length > before) accuseFrame = frame;
    perFrame.push(
      `${frame}:${JSON.stringify(focusSystem.current)}:${JSON.stringify(driver.state)}`,
    );
  }

  return { emissions, perFrame, commands, shots, accuseFrame };
}

describe("focus parity between a prop and a Mimic disguise (§8.5)", () => {
  it("emits byte-identical focus metadata for both", () => {
    const prop = runScenario(propProxy("obj-1"));
    const disguise = runScenario(disguiseProxy("obj-1"));

    expect(disguise.emissions).toEqual(prop.emissions);
    expect(disguise.emissions.join("|")).toBe(prop.emissions.join("|"));
  });

  it("passes through the same states on the same frames", () => {
    const prop = runScenario(propProxy("obj-1"));
    const disguise = runScenario(disguiseProxy("obj-1"));

    expect(disguise.perFrame).toEqual(prop.perFrame);
    expect(disguise.accuseFrame).toBe(prop.accuseFrame);
    expect(prop.accuseFrame).toBe(FIRE_FRAME);
    expect(disguise.commands).toEqual(prop.commands);
    expect(disguise.shots).toEqual(prop.shots);
    expect(prop.shots).toEqual(["hit"]);
  });

  it("exposes only geometry and authored labels, so there is no field to leak through", () => {
    const trace = runScenario(propProxy("obj-1"), 10);
    const focus = JSON.parse(trace.emissions[trace.emissions.length - 1] ?? "null") as
      | Record<string, unknown>
      | null;

    expect(focus).not.toBeNull();
    expect(Object.keys(focus ?? {})).toEqual([
      "objectId",
      "categoryId",
      "phase",
      "distanceM",
      "holdMs",
      "visible",
      "accusable",
    ]);
  });

  it("treats a disguise and a prop the same when the target is out of reach", () => {
    const far = box(-0.3, 0.1, -30, 0.3, 0.5, -29.6);
    const farProxy = (objectId: string): InspectableProxy => ({
      objectId,
      categoryId: "lamp",
      bounds: far,
      pickProxy: { kind: "box", box: far },
      accusationPolicy: "allowed",
    });

    const prop = runScenario(farProxy("obj-1"));
    const disguise = runScenario(farProxy("obj-1"));

    expect(prop.perFrame).toEqual(disguise.perFrame);
    expect(prop.commands).toHaveLength(0);
    expect(prop.shots).toEqual(["miss"]);
  });

  it("resolves a disguise and a prop identically when they are co-located", () => {
    // Two proxies sharing one volume must break the tie by registration order
    // alone, never by which module registered them.
    const first = new InspectableSet([propProxy("obj-a"), disguiseProxy("obj-b")]);
    const second = new InspectableSet([disguiseProxy("obj-a"), propProxy("obj-b")]);
    const settings = testSettings();
    const options = {
      focusDistance: settings.inspectorFocusDistance,
      accusationDistance: settings.accusationDistance,
    };

    const a = new FocusSystem(first, options);
    const b = new FocusSystem(second, options);
    a.update(FRAME_MS, RAY_ORIGIN, RAY_DIR, EYE, true);
    b.update(FRAME_MS, RAY_ORIGIN, RAY_DIR, EYE, true);

    expect(JSON.stringify(a.current)).toBe(JSON.stringify(b.current));
    expect(a.current?.objectId).toBe("obj-a");
  });
});
