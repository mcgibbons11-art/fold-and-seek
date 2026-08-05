import {
  MatchSimulation,
  type MatchCommand,
  type PrivateSimEvent,
  type SimEvent,
} from "@foldseek/game-sim";
import { SpatialValidatorImpl, NAV_DATA, PROP_FOCUS_BOUNDS, WARRANT_RESTOCK_VOLUME, SOLID_PROP_VOLUMES, WORLD_SCALE, type AABB, type Vec3Like } from "@foldseek/map-data";
import { DEFAULT_MATCH_SETTINGS } from "@foldseek/shared";

import { SERVER_PROTOCOL_VERSION, type ClientToServer, type ServerToClient } from "./protocol";
import { PortalsServerRuntime, type ServerGlobal } from "./runtime";

/**
 * FOLD & SEEK as an authoritative Portals server script.
 *
 * The simulation this file drives is the same `packages/game-sim` the client
 * and the Colyseus server drive: pure, DOM-free, deterministic, and fed only
 * by commands and a clock. That is what makes it legal cargo for a sandbox
 * with no imports, no DOM and no network - and it is why the authority can
 * move here at all rather than being rewritten for the occasion.
 *
 * What changes by living here is trust. A host-elected client could be
 * modified; this cannot. Roles, warrants, catches and scores are decided in
 * this file and published under `server:` keys, which the relay refuses to
 * let any client overwrite.
 */

/** Ticks per second. The sandbox floors timers at 50 ms, which is this exactly. */
const TICK_MS = 50;

/**
 * How often authoritative public state is republished, in ticks.
 *
 * Twice a second, which is a write budget rather than a taste: a full round's
 * state spans four or five keys, the session allows about thirty state writes
 * a second in total, and a change anywhere near the front of the state shifts
 * every chunk boundary after it, so a publication almost always rewrites the
 * whole range. Ten writes a second leaves room for everything else.
 *
 * Nothing time-critical rides on this. Events carry the round as it happens;
 * published state is what a late joiner or a resync reads.
 */
const STATE_EVERY_TICKS = 10;

declare const server: ServerGlobal;

/**
 * Real geometry, not a permissive stub. The dedicated server already proved
 * `@foldseek/map-data` is portable enough to hand an authority the shop's own
 * floors, blockers and prop volumes; the same is true inside the sandbox, so
 * accusations and occupancy are judged here against the room the players are
 * actually standing in.
 */
function buildSpatial(eyes: Map<string, Vec3Like>, bounds: Map<string, AABB>): SpatialValidatorImpl {
  return new SpatialValidatorImpl({
    floors: NAV_DATA.floors,
    blockers: NAV_DATA.blockers,
    forbiddenOccupancy: [NAV_DATA.securityOffice],
    solidProps: SOLID_PROP_VOLUMES,
    accusationDistance: DEFAULT_MATCH_SETTINGS.accusationDistance,
    focusDistance: DEFAULT_MATCH_SETTINGS.inspectorFocusDistance,
    restockVolume: WARRANT_RESTOCK_VOLUME,
    inspectorEye: (inspectorId) => eyes.get(inspectorId) ?? null,
    objectBounds: (objectId) => PROP_FOCUS_BOUNDS.get(objectId) ?? bounds.get(objectId) ?? null,
  });
}

/** A disguise the simulation has placed, as a box the spatial rules can read. */
function disguiseBounds(root: readonly [number, number, number]): AABB {
  const half = WORLD_SCALE.playerRadius;
  const height = WORLD_SCALE.playerHeight;
  return {
    min: { x: root[0] - half, y: root[1], z: root[2] - half },
    max: { x: root[0] + half, y: root[1] + height, z: root[2] + half },
  };
}

export function startServer(host: ServerGlobal): PortalsServerRuntime {
  const eyes = new Map<string, Vec3Like>();
  const bounds = new Map<string, AABB>();
  const spatial = buildSpatial(eyes, bounds);
  const sim = new MatchSimulation({}, Math.floor(Date.now() % 0xffffffff), spatial);
  const runtime = new PortalsServerRuntime(host, sim, {
    tickMs: TICK_MS,
    stateEveryTicks: STATE_EVERY_TICKS,
    protocolVersion: SERVER_PROTOCOL_VERSION,
    onEye: (playerId, eye) => {
      if (eye === null) eyes.delete(playerId);
      else eyes.set(playerId, eye);
    },
    onPlacements: (placements) => {
      bounds.clear();
      for (const placement of placements) {
        bounds.set(placement.publicObjectId, disguiseBounds(placement.rootPosition));
      }
    },
  });
  runtime.start();
  return runtime;
}

// The sandbox executes this file top to bottom the moment a session opens.
startServer(server);

export type { ClientToServer, ServerToClient, SimEvent, PrivateSimEvent, MatchCommand };
