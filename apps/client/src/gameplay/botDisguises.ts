import { Quaternion, Vector3 } from "three";

import { BODY_SLOT_ID } from "../forge/materialAssignment";
import type { SpawnPose } from "../inspector/navData";
import {
  createStarterArrangement,
  type DisguiseState,
  type StarterArrangementId,
} from "../mimic/disguiseState";
import { encodeDisguiseState } from "../mimic/poseWire";
import { NAV_DATA } from "../world/maps/nav";
import { CURIOSITY_SHOP_MAP_ID } from "../world/maps/registry";

/**
 * How the simulated players a solo round is fielded with hide, and what they do
 * once they are hidden.
 *
 * A bot authors nothing, but it still has to become an object the Inspector can
 * walk up to and shoot at, and a round in which every bot stands in the open and
 * then holds perfectly still has no stakes: either all three are found or none
 * is. So the plans below deliberately vary in both respects. Half of them fold
 * into cover the map already has, under real furniture: the bay beneath the
 * workshop bench, a board of the steel rack with another board over it, the
 * space under the ladderback chair in the window. Those hold absolutely still.
 * The other half stand out on the open floor and cannot keep from shifting,
 * which is the one thing that gives a searching Inspector an honest reason to
 * look twice (§5.12, and the classic MECCHA hunt).
 *
 * Nothing here is aimed at any particular Inspector. A plan is a hiding place
 * and a fidget, and whether it survives is settled by whether somebody walks
 * over and shoots it.
 */

/** Where this client's own Mimic folds, and the spawn a bot never takes. */
const HUMAN_SPAWN_INDEX = 4;

export interface BotHidePlan {
  /** Root position of the folded body, in world metres. */
  readonly position: readonly [number, number, number];
  /** Facing about +Y, in radians. */
  readonly yaw: number;
  readonly arrangementId: StarterArrangementId;
  /**
   * What the body is finished in. A bot samples no colour of its own, so
   * without this it wears the porcelain every Mimic starts in (§17.3) — and a
   * white shell on brown floorboards is the one thing an Inspector can pick out
   * from across the shop whatever shape it has folded into. The swatch is
   * chosen for what stands around the hiding place, so the body reads as
   * something the room already owns.
   */
  readonly swatchId: string;
  /**
   * Full extent of this bot's fidget, as an offset from `position`. The body
   * creeps out to it and back, so a restless bot stays inside the hiding place
   * it chose rather than wandering across the shop. A zero vector is a bot that
   * holds still, and holding still is what cover is worth.
   */
  readonly creepOffset: readonly [number, number, number];
  /** What the plan is, for reading a failing test. Never shown to a player. */
  readonly note: string;
}

const NORTH = Math.PI;
const SOUTH = 0;
const EAST = -Math.PI / 2;
const WEST = Math.PI / 2;

/**
 * Six places to hide, alternating cover with exposure. Every position is
 * checked against the map by `botDisguises.test.ts`: the root has to be
 * somewhere the authority's `canOccupy` accepts, both ends of a fidget have to
 * be legal, and a cover plan has to have real furniture over it.
 *
 * The bay under the office desk is the third anchor surface `giantScale.test.ts`
 * measures and is deliberately absent: it is inside the Security Office, which a
 * Mimic may never enter (§10.4).
 */
export const BOT_HIDE_PLANS: readonly BotHidePlan[] = [
  {
    position: [-5.6, 0, -1.2],
    yaw: EAST,
    arrangementId: "tall",
    swatchId: "wood_walnut",
    creepOffset: [0, 0, 0.08],
    note: "open floor of the clock-wall aisle, as a longcase in walnut",
  },
  {
    position: [6.8, 0, -0.7],
    yaw: WEST,
    arrangementId: "compact",
    swatchId: "metal_patina",
    creepOffset: [0, 0, 0],
    note: "cover: the bay under the workshop bench, as oxidized copper",
  },
  {
    position: [1.2, 0, 1.6],
    yaw: NORTH,
    arrangementId: "wide",
    swatchId: "ceramic_glazed",
    creepOffset: [0.08, 0, 0],
    note: "open floor in front of the counter, as a glazed vessel",
  },
  {
    position: [7.05, 0.84, -3.6],
    yaw: WEST,
    arrangementId: "compact",
    swatchId: "metal_brass",
    creepOffset: [0, 0, 0],
    note: "cover: the second board of the steel rack, as brass fittings",
  },
  {
    position: [-3.6, 0, 4.6],
    yaw: SOUTH,
    arrangementId: "tripod",
    swatchId: "fabric_velvet_burgundy",
    creepOffset: [0, 0, -0.08],
    note: "open floor of the reading nook, as an upholstered stool",
  },
  {
    position: [0.9, 0, -4.0],
    yaw: SOUTH,
    arrangementId: "compact",
    swatchId: "wood_walnut",
    creepOffset: [0, 0, 0],
    note: "cover: under the ladderback chair in the window, as walnut",
  },
];

function spawnAt(index: number): SpawnPose {
  const spawn = NAV_DATA.spawnPoints.mimics[index];
  if (spawn === undefined) {
    throw new Error("botDisguises: the map publishes no Mimic spawn poses");
  }
  return spawn;
}

/** Where this client's own Mimic starts the Forge. */
export function humanMimicSpawn(): SpawnPose {
  return spawnAt(HUMAN_SPAWN_INDEX);
}

export function botHidePlan(index: number): BotHidePlan {
  const plan = BOT_HIDE_PLANS[index % BOT_HIDE_PLANS.length];
  if (plan === undefined) throw new Error("botDisguises: no hide plans are authored");
  return plan;
}

/** True when this bot shifts about rather than holding still. */
export function botCreeps(index: number): boolean {
  const [x, y, z] = botHidePlan(index).creepOffset;
  return Math.hypot(x, y, z) > 0;
}

const UP = new Vector3(0, 1, 0);
const yawRotation = new Quaternion();
const rootRotation = new Quaternion();

export interface BotPoseOptions {
  /** How far along the fidget the body stands: 0 where it locked, 1 the far end. */
  readonly progress?: number;
  /**
   * Wire revision. The authority refuses an update that does not carry a higher
   * one than the last it accepted, so a creeping bot counts up from the lock.
   */
  readonly revision?: number;
}

/**
 * The disguise the bot at `index` wears. A still bot ignores `progress`, since
 * both ends of a zero offset are the same place.
 */
export function createBotDisguise(index: number, options: BotPoseOptions = {}): DisguiseState {
  const progress = options.progress ?? 0;
  const plan = botHidePlan(index);
  const state = createStarterArrangement(plan.arrangementId);
  state.mapId = CURIOSITY_SHOP_MAP_ID;
  // The whole body, which is what a Mimic who samples one colour and fills with
  // it gets. A bot has no eyedropper, so the plan does the sampling for it.
  state.materials = [{ slotId: BODY_SLOT_ID, swatchId: plan.swatchId }];
  state.root.position = [
    plan.position[0] + plan.creepOffset[0] * progress,
    plan.position[1] + plan.creepOffset[1] * progress,
    plan.position[2] + plan.creepOffset[2] * progress,
  ];

  yawRotation.setFromAxisAngle(UP, plan.yaw);
  rootRotation.set(
    state.root.rotation[0],
    state.root.rotation[1],
    state.root.rotation[2],
    state.root.rotation[3],
  );
  rootRotation.premultiply(yawRotation).normalize();
  state.root.rotation = [rootRotation.x, rootRotation.y, rootRotation.z, rootRotation.w];

  state.revision = options.revision ?? 1;
  return state;
}

export function createBotDisguisePayload(index: number, options: BotPoseOptions = {}): string {
  return encodeDisguiseState(createBotDisguise(index, options));
}

/** How often a restless bot republishes its pose. */
const CREEP_UPDATE_MS = 400;

/** One trip out to the far end of the fidget and back again. */
const CREEP_CYCLE_MS = 6_000;

interface CreepState {
  revision: number;
  nextUpdateAtMs: number;
}

/** Position along a there-and-back fidget at time `t` through the cycle. */
function triangle(t: number): number {
  const cycle = t - Math.floor(t);
  return cycle < 0.5 ? cycle * 2 : 2 - cycle * 2;
}

/**
 * The shifting a restless bot does once its disguise has manifested. It is a
 * slow drift out to the end of the plan's offset and back, republished a couple
 * of times a second, so each step is roughly a centimetre: far inside the
 * `hiderCreepSpeed` the authority enforces, and still enough that an object
 * somebody looked at twice is visibly not where it was.
 *
 * A bot whose plan has no offset never produces an update at all, which is the
 * whole of the difference between a hider that gets found and one that does not.
 */
export class BotCreep {
  private readonly states = new Map<string, CreepState>();

  /** The pose this bot wants published now, or null to hold still. */
  update(
    index: number,
    playerId: string,
    nowMs: number,
  ): { readonly encodedPose: string; readonly revision: number } | null {
    if (!botCreeps(index)) return null;

    const state = this.states.get(playerId) ?? { revision: 1, nextUpdateAtMs: nowMs };
    this.states.set(playerId, state);
    if (nowMs < state.nextUpdateAtMs) return null;
    state.nextUpdateAtMs = nowMs + CREEP_UPDATE_MS;
    state.revision += 1;

    return {
      encodedPose: createBotDisguisePayload(index, {
        progress: triangle(nowMs / CREEP_CYCLE_MS),
        revision: state.revision,
      }),
      revision: state.revision,
    };
  }

  release(playerId: string): void {
    this.states.delete(playerId);
  }
}
