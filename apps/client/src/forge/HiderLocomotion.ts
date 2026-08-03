import { HIDER_FORGE_RUN_SPEED } from "@foldseek/shared";

import { CharacterController, createMoveInput } from "../inspector/CharacterController";
import type { MutableVec3, NavData } from "../inspector/navData";
import type { LocomotionSample } from "./BodyLanguage";

/**
 * A Mimic on its feet (CLAUDE.md override 2 and the MECCHA loop it comes from:
 * run about as the creature, find a spot, settle, then disguise). It walks the
 * same `CharacterController` the Inspector hunts with, over the same nav data,
 * so a Mimic is stopped by the workbench the Inspector is stopped by, hops on
 * the same key with the same physics, and gets up onto the shelf by the same
 * authored climb link.
 *
 * It drives the Forge's root, not a camera. The Forge hands it the root position
 * each frame and takes back wherever the body ended up, which is the same route
 * a root-handle drag takes, so nothing downstream — the pose snapshot, the
 * publication interval, the authority's validation — can tell the two apart.
 *
 * Two speeds, one control. During the Forge the body runs at
 * `HIDER_FORGE_RUN_SPEED`. Once the disguise has manifested the hunt caps it at
 * `hiderCreepSpeed`, and the cap is applied here as well as by the authority:
 * predicting a creep the simulation is going to refuse would show the player's
 * own body somewhere the room does not have it until the next accepted pose.
 */

/**
 * The keys this steers with. Nothing else in the Forge binds them: space used
 * to hold the Inspector-eyeline preview, and that moved to E when the jump
 * arrived, because a movement key cannot also be a camera toggle.
 */
const MOVE_KEYS = ["w", "a", "s", "d", " "] as const;

/** The jump, held rather than edged, so landing with it down hops again. */
const JUMP_KEY = " ";

type MoveKey = (typeof MOVE_KEYS)[number];

/** Below this a frame's motion is floating-point residue rather than a step. */
const MOVED_EPSILON = 1e-9;

/**
 * Below this, collision-resolution jitter is not a trustworthy facing vector.
 * Once the body is genuinely travelling, however, the direction it actually
 * achieved wins over the direction the keys requested. This is what makes a
 * wall slide read as a wall slide instead of a Mimic moonwalking into the wall.
 */
const ACHIEVED_FACING_SPEED_MPS = 0.1;

export function isHiderMoveKey(key: string): key is MoveKey {
  return (MOVE_KEYS as readonly string[]).includes(key);
}

export class HiderLocomotion {
  private readonly controller: CharacterController;
  private readonly input = createMoveInput();
  private readonly held = new Set<MoveKey>();

  /** Metres per second the hunt allows, or null while the Forge is open. */
  private creepSpeed: number | null = null;

  /**
   * True from the first step until the body has come to rest with the keys
   * released. It has to outlive the keypress: a Mimic that runs off the end of
   * the counter is still falling after it lets go, and the fall is part of the
   * move.
   */
  private walking = false;

  /** True for the one frame the body touched down, cleared by the next update. */
  private landed = false;

  /** Reused rather than rebuilt, because `sample` is read every frame. */
  private readonly liveSample = {
    speedFraction: 0,
    travelYaw: 0,
    airborne: false,
    climbing: false,
    creeping: false,
    landingSpeed: 0,
  };

  constructor(navData: NavData) {
    this.controller = new CharacterController(
      navData,
      () => this.creepSpeed ?? HIDER_FORGE_RUN_SPEED,
    );
  }

  /** Metres per second the body may currently travel at. */
  get speed(): number {
    return this.creepSpeed ?? HIDER_FORGE_RUN_SPEED;
  }

  /** True while the body is under the walk keys rather than at rest. */
  get moving(): boolean {
    return this.walking;
  }

  /**
   * The body's motion, read-only, for anything that watches how the Mimic is
   * travelling without steering it. The footstep driver is the one caller, and
   * it needs the same speed, footing and surface the Inspector's controller
   * publishes so that both roles sound the same underfoot.
   */
  get motion(): CharacterController {
    return this.controller;
  }

  /**
   * True while the body is off the ground. The round does not publish a pose
   * from here: mid-hop is a moment rather than a place, and during the hunt the
   * apex of a hop is further from the last accepted pose than the creep cap
   * allows, so publishing one would be refused for a position the body is not
   * going to stay in anyway. It publishes on landing instead.
   */
  get airborne(): boolean {
    return this.walking && this.controller.airborne;
  }

  /** True while the hunt's creep cap is in force rather than the Forge run. */
  get creeping(): boolean {
    return this.creepSpeed !== null;
  }

  /**
   * What the body is doing, for the cosmetic body language that rides on top of
   * the authored pose. Every field is zeroed while the body is at rest, so a
   * controller still holding the last frame of a run cannot leave the creature
   * leaning into a step it is no longer taking.
   */
  get sample(): LocomotionSample {
    const sample = this.liveSample;
    const cap = this.speed;
    sample.speedFraction =
      this.walking && cap > 0 ? Math.min(1, this.controller.speed / cap) : 0;
    sample.travelYaw = this.controller.yaw;
    sample.airborne = this.walking && this.controller.airborne;
    sample.climbing = this.walking && this.controller.climbState !== null;
    sample.creeping = this.creeping;
    sample.landingSpeed = this.landed ? this.controller.landingSpeed : 0;
    return sample;
  }

  /**
   * Caps the body at the hunt's creep speed, or releases it back to the Forge
   * run with null. Changing the cap ends any walk in progress, so the next press
   * re-reads the surface the body is standing on under the new rules.
   */
  setCreepLimit(metresPerSecond: number | null): void {
    if (this.creepSpeed === metresPerSecond) return;
    this.creepSpeed = metresPerSecond;
    // Start hunt movement surface-locked so Space remains a hop unless the
    // player is deliberately pushing into a climb. CharacterController drops
    // this lock after a successful top-out, allowing the shelf crossing and
    // dismount without turning every held jump near furniture into a climb.
    this.controller.surfaceLocked = metresPerSecond !== null;
    this.walking = false;
  }

  press(key: string): boolean {
    if (!isHiderMoveKey(key)) return false;
    this.held.add(key);
    // Hiders do not need a reverse-climb mode. S is the reliable emergency
    // exit: drop the traversal immediately, then resume normal backward WASD
    // once no climb is active.
    if (key === "s") this.controller.disengageClimb();
    return true;
  }

  release(key: string): void {
    if (!isHiderMoveKey(key)) return;
    this.held.delete(key);
    // Forward + Space starts a contextual climb. Releasing Space is an explicit
    // stop/top-out gesture even when Forward remains held; waiting for every
    // direction key to come up is what left players hanging at the lip.
    if (key === JUMP_KEY) this.controller.releaseClimbInput();
    if (!["w", "a", "s", "d"].some((moveKey) => this.held.has(moveKey as MoveKey))) {
      this.controller.releaseClimbInput();
    }
  }

  /** Drops every held key, for a lost focus or a closing Forge. */
  releaseAll(): void {
    this.held.clear();
    this.controller.releaseClimbInput();
  }

  /**
   * Advances one frame and writes the body's new position into `root`. Returns
   * true when it actually moved, which is the Forge's cue to re-solve the pose.
   *
   * `headingYaw` is the camera's own yaw, so the keys steer relative to what the
   * player is looking at. The body is then turned to face the direction it is
   * travelling and walks straight ahead, which is what puts a climb link under
   * it when it is walked into sideways as well as head on.
   */
  update(dtSeconds: number, headingYaw: number, root: MutableVec3): boolean {
    const forward = (this.held.has("w") ? 1 : 0) - (this.held.has("s") ? 1 : 0);
    const strafe = (this.held.has("d") ? 1 : 0) - (this.held.has("a") ? 1 : 0);
    const steering = forward !== 0 || strafe !== 0;
    // A hop with no direction held is still a reason to be running the body.
    this.input.jump = this.held.has(JUMP_KEY);
    const intent = steering || this.input.jump;
    // A landing is one frame's worth of news. Clearing it here rather than after
    // the controller runs means a frame the body sat out cannot replay the last
    // landing into a second compression.
    this.landed = false;

    if (dtSeconds <= 0) return false;
    if (!this.walking && !intent) return false;

    if (!this.walking) {
      this.controller.placeAt(root.x, root.y, root.z, headingYaw);
      // A creep travels along whatever it settled on, and hops off it. A
      // disguise hanging off a wall or wedged on a shelf edge with nothing
      // underfoot has neither, so the press does nothing rather than dropping
      // the body.
      if (this.creepSpeed !== null && !this.controller.grounded) return false;
      this.walking = true;
    }

    if (steering) {
      // three's convention: yaw 0 faces -Z, so the direction the player is
      // pushing is the camera's forward and right combined the same way the
      // controller resolves its own.
      const sin = Math.sin(headingYaw);
      const cos = Math.cos(headingYaw);
      const dirX = forward * -sin + strafe * cos;
      const dirZ = forward * -cos + strafe * -sin;
      this.controller.yaw = Math.atan2(-dirX, -dirZ);
      this.input.forward = 1;
    } else {
      this.input.forward = 0;
    }

    const startX = this.controller.position.x;
    const startY = this.controller.position.y;
    const startZ = this.controller.position.z;
    this.controller.update(dtSeconds, this.input);
    this.landed = this.controller.justLanded;
    const { x, y, z } = this.controller.position;

    const achievedX = x - startX;
    const achievedZ = z - startZ;
    const achievedSpeed = Math.hypot(achievedX, achievedZ) / dtSeconds;
    if (achievedSpeed >= ACHIEVED_FACING_SPEED_MPS) {
      // Three's yaw zero faces -Z. Deriving yaw from the post-collision delta,
      // rather than input, keeps the visible +Z Mimic face on achieved travel.
      this.controller.yaw = Math.atan2(-achievedX, -achievedZ);
    }

    // Settled: nothing held, standing on something, no climb still running, and
    // the body has actually stopped. The last of those matters as much as the
    // rest — a body decelerating out of a run is still moving after the key came
    // up, and calling the walk over on the release frame would cut the stop off
    // and drop the body on the spot.
    if (
      !intent &&
      this.controller.grounded &&
      this.controller.climbState === null &&
      this.controller.speed < MOVED_EPSILON
    ) {
      this.walking = false;
    }

    const moved =
      Math.abs(achievedX) > MOVED_EPSILON ||
      Math.abs(y - startY) > MOVED_EPSILON ||
      Math.abs(achievedZ) > MOVED_EPSILON;
    if (!moved) return false;

    root.x = x;
    root.y = y;
    root.z = z;
    return true;
  }
}
