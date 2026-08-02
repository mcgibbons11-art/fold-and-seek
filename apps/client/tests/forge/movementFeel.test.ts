import { HIDER_FORGE_RUN_SPEED, PLAYER_HEIGHT_M } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BodyLanguage } from "../../src/forge/BodyLanguage";
import { DisguiseTheatre } from "../../src/gameplay/disguiseTheatre";
import { ForgeController } from "../../src/forge/ForgeController";
import { HiderLocomotion } from "../../src/forge/HiderLocomotion";
import { encodeDisguiseState } from "../../src/mimic/poseWire";
import { humanMimicSpawn } from "../../src/gameplay/botDisguises";
import { FootstepDriver, type MotionSample } from "../../src/gameplay/footsteps";
import {
  AIR_CONTROL_SCALE,
  CharacterController,
  COYOTE_SECONDS,
  createMoveInput,
  GROUND_ACCELERATION_SECONDS,
  GROUND_STOP_SECONDS,
  JUMP_BUFFER_SECONDS,
} from "../../src/inspector/CharacterController";
import { InspectorController } from "../../src/inspector/InspectorController";
import { WORLD_SCALE, type MutableVec3 } from "../../src/inspector/navData";
import { qualitySettingsFor } from "../../src/rendering/quality";
import { NAV_DATA } from "../../src/world/maps/nav";
import { SHOP_FORGE_WORKSPACE } from "../../src/world/ShopWorld";
import { openNavData, testSettings, TABLE_TOP } from "../inspector/navFixture";

/**
 * How the movement feels rather than where it ends up: the ramp up to speed and
 * back down, the shape of the jump arc and the two windows that make it
 * forgiving, the weight of a landing, and the body language laid over all of it.
 *
 * The load-bearing claim in this file is the last one. Every cosmetic here rides
 * on top of the authored pose and none of it may reach the wire: a Mimic that
 * published its lean would spend its command budget on a wobble and hand every
 * peer a body that never stops moving.
 */

const FRAME_SECONDS = 1 / 60;
const FRAME_MS = 1000 / 60;
const FACING_NORTH = 0;
const WALK_SPEED = testSettings().inspectorMoveSpeed;

/** What "up to speed" means: within a twentieth of the cap. */
const AT_SPEED_SHARE = 0.95;

function walker(): InspectorController {
  const controller = new InspectorController(openNavData(), testSettings());
  controller.teleportTo({ position: { x: 0, y: 0, z: 0 }, yaw: FACING_NORTH });
  return controller;
}

function at(x: number, y: number, z: number): MutableVec3 {
  return { x, y, z };
}

describe("getting up to speed and back down", () => {
  it("reaches the cap in the authored time and never passes it", () => {
    const controller = walker();
    const input = createMoveInput();
    input.forward = 1;

    let reachedAt = Number.POSITIVE_INFINITY;
    let fastest = 0;
    for (let frame = 1; frame <= 120; frame += 1) {
      controller.update(FRAME_SECONDS, input);
      fastest = Math.max(fastest, controller.speed);
      if (reachedAt === Number.POSITIVE_INFINITY && controller.speed >= WALK_SPEED * AT_SPEED_SHARE) {
        reachedAt = frame * FRAME_SECONDS;
      }
    }

    // Within a frame of the authored time: the ramp is continuous and the frame
    // it crosses the line on is the first one sampled past it.
    expect(reachedAt).toBeLessThanOrEqual(GROUND_ACCELERATION_SECONDS + FRAME_SECONDS);
    // And it is a ramp rather than a step: the first frame is well short of it.
    expect(reachedAt).toBeGreaterThan(FRAME_SECONDS * 2);
    expect(fastest).toBeLessThanOrEqual(WALK_SPEED + 1e-9);
  });

  it("comes to rest in the authored stopping time once the keys are released", () => {
    const controller = walker();
    const input = createMoveInput();
    input.forward = 1;
    for (let frame = 0; frame < 60; frame += 1) controller.update(FRAME_SECONDS, input);
    expect(controller.speed).toBeCloseTo(WALK_SPEED, 6);

    input.forward = 0;
    let stoppedAt = Number.POSITIVE_INFINITY;
    for (let frame = 1; frame <= 60; frame += 1) {
      controller.update(FRAME_SECONDS, input);
      if (controller.speed === 0) {
        stoppedAt = frame * FRAME_SECONDS;
        break;
      }
    }

    // Within a frame of the authored time, and stopping is quicker than starting.
    expect(stoppedAt).toBeLessThanOrEqual(GROUND_STOP_SECONDS + FRAME_SECONDS);
    expect(GROUND_STOP_SECONDS).toBeLessThan(GROUND_ACCELERATION_SECONDS);
  });

  it("eases through a change of direction instead of snapping to the new one", () => {
    const controller = walker();
    const forward = createMoveInput();
    forward.forward = 1;
    for (let frame = 0; frame < 60; frame += 1) controller.update(FRAME_SECONDS, forward);

    // Reverse. A body that turned instantly would be travelling at the cap the
    // other way on the next frame; one with weight passes through a standstill.
    const back = createMoveInput();
    back.forward = -1;
    controller.update(FRAME_SECONDS, back);
    expect(controller.speed).toBeLessThan(WALK_SPEED);
    let slowest = controller.speed;
    for (let frame = 0; frame < 20; frame += 1) {
      controller.update(FRAME_SECONDS, back);
      slowest = Math.min(slowest, controller.speed);
    }
    expect(slowest).toBeLessThan(WALK_SPEED / 4);

    for (let frame = 0; frame < 40; frame += 1) controller.update(FRAME_SECONDS, back);
    expect(controller.speed).toBeCloseTo(WALK_SPEED, 6);
  });

  it("steers less in the air than on the ground, and never brakes there", () => {
    const airborne = walker();
    const ground = walker();
    const jumping = createMoveInput();
    jumping.jump = true;
    airborne.update(FRAME_SECONDS, jumping);
    expect(airborne.airborne).toBe(true);

    const steering = createMoveInput();
    steering.forward = 1;
    steering.jump = true;
    const grounded = createMoveInput();
    grounded.forward = 1;
    for (let frame = 0; frame < 4; frame += 1) {
      airborne.update(FRAME_SECONDS, steering);
      ground.update(FRAME_SECONDS, grounded);
    }
    expect(airborne.speed).toBeLessThan(ground.speed);
    expect(airborne.speed).toBeGreaterThan(ground.speed * AIR_CONTROL_SCALE * 0.5);

    // Letting go in mid-air keeps the momentum: a hop is an arc, not a hover.
    const coasting = airborne.speed;
    const released = createMoveInput();
    released.jump = true;
    airborne.update(FRAME_SECONDS, released);
    expect(airborne.speed).toBeCloseTo(coasting, 6);
  });
});

describe("the two windows that make a hop forgiving", () => {
  /** Walks the body off the table's edge and hands back the airborne frame. */
  function steppedOff(): InspectorController {
    const controller = new InspectorController(
      { ...openNavData(), floors: [...openNavData().floors, TABLE_TOP] },
      testSettings(),
    );
    controller.teleportTo({ position: { x: -1.3, y: TABLE_TOP.bounds.max.y, z: 0 }, yaw: 0 });
    expect(controller.surfaceId).toBe("table");
    const input = createMoveInput();
    input.forward = 1;
    for (let frame = 0; frame < 240 && controller.grounded; frame += 1) {
      controller.update(FRAME_SECONDS, input);
    }
    expect(controller.grounded).toBe(false);
    return controller;
  }

  /** Highest the body got after `frames` of falling, then pressing jump. */
  function apexAfterWaiting(frames: number): number {
    const controller = steppedOff();
    const falling = createMoveInput();
    for (let frame = 0; frame < frames; frame += 1) controller.update(FRAME_SECONDS, falling);
    const from = controller.position.y;

    const jumping = createMoveInput();
    jumping.jump = true;
    let apex = controller.position.y;
    for (let frame = 0; frame < 6; frame += 1) {
      controller.update(FRAME_SECONDS, jumping);
      apex = Math.max(apex, controller.position.y);
    }
    return apex - from;
  }

  it("still answers the jump key just after the feet leave an edge", () => {
    // One frame into the fall, which is inside the coyote window.
    expect(apexAfterWaiting(1)).toBeGreaterThan(0);
    expect(COYOTE_SECONDS).toBeGreaterThan(FRAME_SECONDS);
  });

  it("refuses it once the window has passed, so there is no second jump", () => {
    const past = Math.ceil(COYOTE_SECONDS / FRAME_SECONDS) + 2;
    // Purely falling: pressing jump gains nothing at all.
    expect(apexAfterWaiting(past)).toBeLessThanOrEqual(0);
  });

  /**
   * Hops, taps the jump key for one frame `beforeLanding` frames from the
   * ground, and reports whether the body left the floor a second time.
   */
  function tappedBeforeLanding(beforeLanding: number): boolean {
    const controller = walker();
    const jumping = createMoveInput();
    jumping.jump = true;
    const falling = createMoveInput();

    // How long the hop lasts, measured on a body that never touches the key
    // again, so the tap below can be placed a known number of frames from the
    // ground without the tap itself changing the arc.
    let airborne = 0;
    const probe = walker();
    probe.update(FRAME_SECONDS, jumping);
    while (!probe.grounded && airborne < 240) {
      probe.update(FRAME_SECONDS, falling);
      airborne += 1;
    }

    controller.update(FRAME_SECONDS, jumping);
    for (let frame = 0; frame < airborne; frame += 1) {
      controller.update(FRAME_SECONDS, frame === airborne - beforeLanding ? jumping : falling);
    }
    expect(controller.grounded).toBe(true);

    for (let frame = 0; frame < 6; frame += 1) {
      controller.update(FRAME_SECONDS, falling);
      if (!controller.grounded) return true;
    }
    return false;
  }

  it("remembers a press made just before the feet touch down", () => {
    const inside = Math.floor(JUMP_BUFFER_SECONDS / FRAME_SECONDS / 2);
    expect(inside).toBeGreaterThan(0);
    expect(tappedBeforeLanding(inside)).toBe(true);
  });

  it("forgets one made too early, so the buffer is not a queue", () => {
    const outside = Math.ceil((JUMP_BUFFER_SECONDS / FRAME_SECONDS) * 2);
    expect(tappedBeforeLanding(outside)).toBe(false);
  });
});

describe("the weight of a landing", () => {
  /** Runs a body language rig through a hop and reports the deepest dip. */
  function hopAndSettle(landingSpeed: number): { deepest: number; settled: number } {
    const body = new BodyLanguage();
    const still = {
      speedFraction: 0,
      travelYaw: 0,
      airborne: false,
      climbing: false,
      creeping: false,
      landingSpeed: 0,
    };
    body.update(FRAME_SECONDS, { ...still, landingSpeed });
    let deepest = body.posture.dipM;
    for (let frame = 0; frame < 240; frame += 1) {
      body.update(FRAME_SECONDS, still);
      deepest = Math.max(deepest, body.posture.dipM);
    }
    return { deepest, settled: body.posture.dipM };
  }

  it("compresses the body and returns it to exactly the authored height", () => {
    const { deepest, settled } = hopAndSettle(2);
    expect(deepest).toBeGreaterThan(PLAYER_HEIGHT_M * 0.02);
    expect(deepest).toBeLessThan(PLAYER_HEIGHT_M * 0.2);
    // Exactly, not nearly: the spring is snapped onto its rest value once it has
    // arrived, so a body that landed stands at the height the player authored.
    expect(settled).toBe(0);
  });

  it("dips further for a harder landing, up to its ceiling", () => {
    expect(hopAndSettle(3).deepest).toBeGreaterThan(hopAndSettle(1).deepest);
    // Capped, so a fall off the shelving does not fold the creature into the
    // boards: twenty times a hop's speed is no deeper than three times.
    expect(hopAndSettle(40).deepest).toBeCloseTo(hopAndSettle(20).deepest, 9);
  });

  it("leaves the body leaning and swaying while it runs, and level at rest", () => {
    const body = new BodyLanguage();
    const running = {
      speedFraction: 1,
      travelYaw: FACING_NORTH,
      airborne: false,
      climbing: false,
      creeping: false,
      landingSpeed: 0,
    };
    for (let frame = 0; frame < 60; frame += 1) body.update(FRAME_SECONDS, running);
    expect(body.posture.leanRad).toBeGreaterThan(0.05);
    expect(body.atRest).toBe(false);

    for (let frame = 0; frame < 120; frame += 1) {
      body.update(FRAME_SECONDS, { ...running, speedFraction: 0 });
    }
    expect(body.posture.leanRad).toBe(0);
    expect(body.atRest).toBe(true);
    // Resting is not the same as neutral: a creature that stops breathing reads
    // as a prop, so the sway carries on under a body that has stopped walking.
    expect(body.posture.bankRad).not.toBe(0);
    expect(body.neutral).toBe(false);
    body.reset();
    expect(body.neutral).toBe(true);
  });

  it("crouches while the hunt's creep cap is on and stands back up when it lifts", () => {
    const body = new BodyLanguage();
    const creeping = {
      speedFraction: 0.5,
      travelYaw: FACING_NORTH,
      airborne: false,
      climbing: false,
      creeping: true,
      landingSpeed: 0,
    };
    for (let frame = 0; frame < 120; frame += 1) body.update(FRAME_SECONDS, creeping);
    expect(body.posture.dipM).toBeGreaterThan(PLAYER_HEIGHT_M * 0.05);
    expect(body.posture.dipM).toBeLessThan(PLAYER_HEIGHT_M * 0.07);
    // And it creeps lower than it runs, which is the whole point of the posture.
    expect(body.posture.leanRad).toBeLessThan(0.05);

    for (let frame = 0; frame < 120; frame += 1) {
      body.update(FRAME_SECONDS, { ...creeping, creeping: false, speedFraction: 0 });
    }
    expect(body.posture.dipM).toBe(0);
  });
});

/**
 * The isolation the whole cosmetic layer rests on. A body carrying itself is
 * still wearing exactly the disguise its owner authored, so the bytes the round
 * publishes are the same whether the creature is mid-stride or standing still.
 */
describe("body language never reaches the wire", () => {
  const VIEWPORT = { width: 800, height: 600 };
  const SPAWN = humanMimicSpawn().position;

  class Rig {
    readonly controller: ForgeController;
    readonly scene = new THREE.Scene();

    private readonly keyListeners: ((event: never) => void)[] = [];

    constructor() {
      keydownSink = (listener) => {
        this.keyListeners.push(listener);
      };
      const canvas = {
        style: { cursor: "default" },
        getBoundingClientRect: () => ({ left: 0, top: 0, ...VIEWPORT }),
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
        hasPointerCapture: () => false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
      this.controller = new ForgeController({
        scene: this.scene,
        canvas: canvas as unknown as HTMLCanvasElement,
        quality: qualitySettingsFor("medium"),
        origin: new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z),
        navData: NAV_DATA,
        workspace: SHOP_FORGE_WORKSPACE,
      });
      this.controller.setViewport(VIEWPORT.width, VIEWPORT.height);
    }

    press(key: string): void {
      const event = {
        key,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        target: null,
        preventDefault: () => undefined,
      };
      for (const listener of [...this.keyListeners]) {
        (listener as (event: unknown) => void)(event);
      }
    }

    run(frames: number): void {
      for (let frame = 0; frame < frames; frame += 1) this.controller.update(FRAME_MS);
    }

    /** The rendered body's own transform, which is where the cosmetic lands. */
    get bodyRoot(): THREE.Object3D {
      const root = this.scene.getObjectByName("mimic");
      if (root === undefined) throw new Error("the Mimic is not in the scene");
      return root;
    }

    dispose(): void {
      this.controller.dispose();
    }
  }

  let rigs: Rig[] = [];
  let previousWindow: unknown;
  /** Set by whichever rig is being built, so its own key events reach only it. */
  let keydownSink: (listener: (event: never) => void) => void = () => undefined;

  beforeEach(() => {
    // The Forge reads the DOM classes its key handler guards on, and plays audio.
    // Neither exists in the headless environment these tests run in.
    const globals = globalThis as Record<string, unknown>;
    previousWindow = globals["window"];
    globals["window"] = {
      addEventListener: (type: string, listener: (event: never) => void) => {
        if (type === "keydown") keydownSink(listener);
      },
      removeEventListener: () => undefined,
    };
    globals["HTMLInputElement"] ??= class {};
    globals["HTMLTextAreaElement"] ??= class {};
    globals["Element"] ??= class {};
    globals["Audio"] ??= class {
      volume = 1;
      preload = "";
      currentTime = 0;
      playbackRate = 1;
      play(): Promise<void> {
        return Promise.resolve();
      }
      pause(): void {}
      removeAttribute(): void {}
    };
  });

  afterEach(() => {
    // Every controller goes before the window it registered against does: the
    // Forge detaches its listeners from the live global on the way out.
    for (const rig of rigs) rig.dispose();
    rigs = [];
    (globalThis as Record<string, unknown>)["window"] = previousWindow;
  });

  function build(): Rig {
    const rig = new Rig();
    rigs.push(rig);
    return rig;
  }

  it("publishes the same pose for a running body as for a still one at that root", () => {
    const still = build();
    const running = build();
    still.run(1);

    running.press("w");
    running.run(40);

    const leaning = running.bodyRoot;
    // The cosmetic is genuinely live: the body is tipped into its run, and the
    // rendered root has been carried off the authored one to keep the pivot at
    // the creature's feet.
    expect(Math.abs(leaning.quaternion.w)).toBeLessThan(1 - 1e-6);
    expect(leaning.position.length()).toBeGreaterThan(0);

    // The grips travel with the body they are attached to, so a player reaching
    // for the head's handle mid-run reaches for where the head actually is.
    running.scene.updateMatrixWorld(true);
    const head = running.scene.getObjectByName("mimic_head");
    const grip = running.scene.getObjectByName("forge_handle_ring_head");
    if (head === undefined || grip === undefined) throw new Error("no head or its handle");
    expect(grip.getWorldPosition(new THREE.Vector3()).distanceTo(
      head.getWorldPosition(new THREE.Vector3()),
    )).toBeLessThan(1e-9);

    // And the group they live in is never itself transformed: it also carries
    // seal markers, which belong to the map surfaces rather than to the body.
    const handles = running.scene.getObjectByName("forge_handles");
    if (handles === undefined) throw new Error("no handle group");
    expect(handles.position.lengthSq()).toBe(0);
    expect(handles.quaternion.w).toBe(1);

    const moving = running.controller.disguise;
    const parked = still.controller.disguise;
    expect(moving.root.position).not.toEqual(parked.root.position);
    // Everything except where the body is standing is byte-identical, and the
    // root it publishes is the authored one rather than the leaning one.
    expect(moving.bones).toEqual(parked.bones);
    expect(moving.segments).toEqual(parked.segments);
    expect(moving.panels).toEqual(parked.panels);
    expect(moving.root.rotation).toEqual(parked.root.rotation);
  });

  it("swings the drawn legs while it walks, and publishes none of it", () => {
    const rig = build();
    rig.run(1);
    rig.press("w");

    // Where the shin sits inside the body, so the body travelling does not
    // count as the leg swinging.
    const shinInBody = (): THREE.Vector3 => {
      rig.scene.updateMatrixWorld(true);
      const shin = rig.scene.getObjectByName("mimic_shin_L");
      if (shin === undefined) throw new Error("the Mimic has no left shin");
      return rig.bodyRoot.worldToLocal(shin.getWorldPosition(new THREE.Vector3()));
    };

    const authored = JSON.stringify(rig.controller.disguise.bones);
    let nearest = Infinity;
    let furthest = -Infinity;
    for (let frame = 0; frame < 90; frame += 1) {
      rig.controller.update(FRAME_MS);
      const z = shinInBody().z;
      nearest = Math.min(nearest, z);
      furthest = Math.max(furthest, z);
    }

    // A stride the player can see: the knee travels a good share of the
    // creature's own height fore and aft as the body crosses the shop.
    expect(furthest - nearest).toBeGreaterThan(PLAYER_HEIGHT_M * 0.15);
    // And every bone the round publishes is exactly what was folded, because
    // the gait is laid over a copy of the pose rather than over the pose.
    expect(JSON.stringify(rig.controller.disguise.bones)).toBe(authored);
  });

  it("stops the legs dead once the disguise locks", () => {
    const rig = build();
    rig.press("w");
    rig.run(30);
    rig.controller.lock();
    // The gait eases out rather than cutting, so the body needs the blend
    // before it is standing exactly as it was folded.
    rig.run(30);

    const shin = (): number[] => {
      rig.scene.updateMatrixWorld(true);
      const mesh = rig.scene.getObjectByName("mimic_shin_L");
      if (mesh === undefined) throw new Error("the Mimic has no left shin");
      return [...mesh.matrixWorld.elements];
    };

    const settled = shin();
    rig.run(120);
    expect(shin()).toEqual(settled);
  });

  it("gives the authority the authored box, not the leaning one", () => {
    // The bounds a hider is shot at are read out of their own Forge while the
    // theatre is not drawing them (see gameplay/ownDisguiseBounds.test.ts). If
    // the lean reached that box, the owner would be shootable somewhere nobody
    // else believes they are — the same failure as publishing the lean, in a
    // place no wire format would catch.
    const rig = build();
    rig.press("w");
    rig.run(40);
    expect(Math.abs(rig.bodyRoot.quaternion.w)).toBeLessThan(1 - 1e-6);

    const own = rig.controller.bodyBounds;
    expect(own).not.toBeNull();

    // What a peer computes from the disguise this Forge is currently wearing.
    const theatre = new DisguiseTheatre(new THREE.Scene(), qualitySettingsFor("high"));
    theatre.sync(
      [
        {
          publicObjectId: "peer",
          encodedPose: encodeDisguiseState(rig.controller.disguise),
          encodedPaint: null,
          defaultArrangementId: null,
          revealed: false,
        },
      ],
      null,
    );
    const remote = theatre.boundsOf("peer");
    expect(remote).not.toBeNull();

    const mine = own as THREE.Box3;
    const theirs = remote as THREE.Box3;
    for (const axis of ["x", "y", "z"] as const) {
      expect(Math.abs(mine.min[axis] - theirs.min[axis])).toBeLessThan(PLAYER_HEIGHT_M * 1e-3);
      expect(Math.abs(mine.max[axis] - theirs.max[axis])).toBeLessThan(PLAYER_HEIGHT_M * 1e-3);
    }
    theatre.dispose();
  });

  it("keeps a locked disguise perfectly still, so it cannot be picked out by breathing", () => {
    const rig = build();
    rig.press("w");
    rig.run(20);
    rig.controller.lock();
    rig.run(1);

    const settled = rig.bodyRoot;
    expect(settled.quaternion.w).toBe(1);
    expect(settled.position.lengthSq()).toBe(0);

    const before = settled.matrixWorld.clone();
    rig.run(120);
    rig.scene.updateMatrixWorld(true);
    expect(rig.bodyRoot.matrixWorld.elements).toEqual(before.elements);
  });

  it("settles the shot onto the body without oscillating around it", () => {
    const rig = build();
    rig.run(1);
    rig.press("w");
    rig.run(40);

    const distances: number[] = [];
    for (let frame = 0; frame < 60; frame += 1) {
      rig.controller.update(FRAME_MS);
      const root = rig.controller.disguise.root.position;
      distances.push(
        rig.controller.camera.position.distanceTo(
          new THREE.Vector3(root[0], root[1], root[2]),
        ),
      );
    }

    // The body is still running here, so the shot holds a steady trail rather
    // than closing on it; what matters is that the trail does not hunt. Count
    // the turns in the distance and allow one, which is the single overshoot a
    // settling shot is permitted.
    let turns = 0;
    for (let i = 2; i < distances.length; i += 1) {
      const previous = (distances[i - 1] ?? 0) - (distances[i - 2] ?? 0);
      const current = (distances[i] ?? 0) - (distances[i - 1] ?? 0);
      if (previous * current < -1e-9) turns += 1;
    }
    expect(turns).toBeLessThanOrEqual(1);
  });
});

/**
 * The seam the audio driver hangs off. Nothing here plays a sound; what is under
 * test is that the motion the driver reads reports the states it switches on,
 * now that speed ramps rather than stepping.
 */
describe("the footstep seam reads real locomotion state", () => {
  class Ear {
    readonly heard: string[] = [];
    play = (id: string): void => {
      this.heard.push(id);
    };
  }

  function run(
    driver: FootstepDriver,
    motion: MotionSample,
    frames: number,
    creeping = false,
  ): void {
    for (let frame = 0; frame < frames; frame += 1) driver.update(FRAME_MS, motion, creeping);
  }

  const grounded = (speed: number): MotionSample => ({
    speed,
    grounded: true,
    position: { y: 0 },
    surfaceId: "floor",
    climbState: null,
  });

  it("goes quiet while the body is off the ground", () => {
    const ear = new Ear();
    const driver = new FootstepDriver(ear);
    run(driver, grounded(HIDER_FORGE_RUN_SPEED), 60);
    const walked = ear.heard.filter((id) => id.startsWith("footstep")).length;
    expect(walked).toBeGreaterThan(0);

    const airborne = ear.heard.length;
    run(driver, { ...grounded(HIDER_FORGE_RUN_SPEED), grounded: false }, 60);
    expect(ear.heard.filter((id) => id.startsWith("footstep")).length).toBe(walked);
    expect(ear.heard.length).toBeGreaterThanOrEqual(airborne);
  });

  it("treads faster at a run than at the hunt's creep", () => {
    const running = new Ear();
    run(new FootstepDriver(running), grounded(HIDER_FORGE_RUN_SPEED), 120);
    const creeping = new Ear();
    run(
      new FootstepDriver(creeping),
      grounded(WORLD_SCALE.playerHeight * 0.5),
      120,
      true,
    );

    expect(running.heard.filter((id) => id.startsWith("footstep")).length).toBeGreaterThan(
      creeping.heard.length,
    );
  });

  it("is fed by a body whose speed ramps rather than stepping", () => {
    // The driver counts distance, so the ramp shows up as fewer footfalls over
    // the first second than over a second at speed.
    const controller = new CharacterController(openNavData(), () => HIDER_FORGE_RUN_SPEED);
    controller.teleportTo({ position: { x: 0, y: 0, z: 0 }, yaw: FACING_NORTH });
    const input = createMoveInput();
    input.forward = 1;

    const ear = new Ear();
    const driver = new FootstepDriver(ear);
    for (let frame = 0; frame < 60; frame += 1) {
      controller.update(FRAME_SECONDS, input);
      driver.update(FRAME_MS, controller);
    }
    const first = ear.heard.length;
    for (let frame = 0; frame < 60; frame += 1) {
      controller.update(FRAME_SECONDS, input);
      driver.update(FRAME_MS, controller);
    }
    expect(ear.heard.length - first).toBeGreaterThan(first);
  });
});
