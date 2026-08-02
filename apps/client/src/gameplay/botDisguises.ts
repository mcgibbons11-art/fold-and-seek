import { Quaternion, Vector3 } from "three";

import type { SpawnPose } from "../inspector/navData";
import {
  createStarterArrangement,
  STARTER_ARRANGEMENT_IDS,
  type DisguiseState,
} from "../mimic/disguiseState";
import { encodeDisguiseState } from "../mimic/poseWire";
import { NAV_DATA } from "../world/maps/nav";
import { CURIOSITY_SHOP_MAP_ID } from "../world/maps/registry";

/**
 * Disguises for the simulated players a solo round is fielded with.
 *
 * A bot does not author anything, but it still has to become an object the
 * Inspector can walk up to and shoot at. Left to itself the simulation falls
 * back to §5.8's starting arrangement at the world origin, which piles every
 * bot into one corner of the floor, so each one is instead given a whole
 * starter arrangement standing on one of the map's authored Mimic spawn poses.
 * They are deliberately unedited: a bot is a target and a decoy, not a player.
 */

/** Arrangements a bot never draws: they need a wall or a shelf to mean anything. */
const SITED_ARRANGEMENTS: ReadonlySet<string> = new Set(["wall_mount", "shelf_bundle", "hanging"]);

const BOT_ARRANGEMENTS = STARTER_ARRANGEMENT_IDS.filter((id) => !SITED_ARRANGEMENTS.has(id));

/**
 * Where the human Mimic folds. It is the one spawn near the middle of the sales
 * floor, which matters because the Forge clamps its workspace to a few metres
 * about the body: start against the far wall and half the room is unreachable.
 */
const HUMAN_SPAWN_INDEX = 4;

/** Everything left over, so a bot never materialises inside the player. */
const BOT_SPAWN_INDICES = NAV_DATA.spawnPoints.mimics
  .map((_pose, index) => index)
  .filter((index) => index !== HUMAN_SPAWN_INDEX);

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

const UP = new Vector3(0, 1, 0);
const yawRotation = new Quaternion();
const rootRotation = new Quaternion();

/**
 * The disguise the bot at `index` locks. Spawn poses and arrangements are both
 * walked by the index, so a four-bot round puts four different silhouettes in
 * four different parts of the shop.
 */
export function createBotDisguise(index: number): DisguiseState {
  const spawn = spawnAt(BOT_SPAWN_INDICES[index % BOT_SPAWN_INDICES.length] ?? 0);
  const arrangementId = BOT_ARRANGEMENTS[index % BOT_ARRANGEMENTS.length] ?? "upright";

  const state = createStarterArrangement(arrangementId);
  state.mapId = CURIOSITY_SHOP_MAP_ID;
  state.root.position = [spawn.position.x, spawn.position.y, spawn.position.z];

  yawRotation.setFromAxisAngle(UP, spawn.yaw);
  rootRotation.set(
    state.root.rotation[0],
    state.root.rotation[1],
    state.root.rotation[2],
    state.root.rotation[3],
  );
  rootRotation.premultiply(yawRotation).normalize();
  state.root.rotation = [rootRotation.x, rootRotation.y, rootRotation.z, rootRotation.w];

  // Locking refuses a revision below the last one recorded, and a bot records
  // nothing before this, so any positive revision does.
  state.revision = 1;
  return state;
}

export function createBotDisguisePayload(index: number): string {
  return encodeDisguiseState(createBotDisguise(index));
}
