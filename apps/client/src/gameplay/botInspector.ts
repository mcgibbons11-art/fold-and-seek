import type { MatchCommand } from "@foldseek/game-sim";
import { MatchPhase, PLAYER_HEIGHT_M, type MatchSettings } from "@foldseek/shared";

import {
  aabbCenter,
  boundsVisibleFrom,
  distanceToBounds,
  SIGHT_LINE_EPSILON_M,
} from "../inspector/geometry";
import {
  blocksCapsule,
  surfaceAt,
  WORLD_SCALE,
  type AABB,
  type MutableVec3,
  type NavData,
  type Vec3Like,
  type WalkableSurface,
} from "../inspector/navData";

/**
 * A simulated Inspector that actually hunts: it walks the shop's own floor plan
 * at the room's walking speed, looks at what it passes, and spends warrants on
 * what it decides is suspicious. Every accusation goes through the same `accuse`
 * command a human fires, so the authority validates its range and its line of
 * sight exactly as it validates a player's. Nothing here can teleport, shoot
 * through a wall, or reach further than the settings allow (§28.4).
 *
 * **What it is allowed to know.** The brain is handed a flat list of object ids
 * and one bounds lookup. Props and disguises arrive merged, in one list, with no
 * record of which is which, so there is nothing here that could read a role, an
 * owner, or "is this a Mimic" even by accident. That is the same thing a human
 * client has: `DisguiseTheatre` publishes a disguise through the identical focus
 * proxy a chair publishes, and the reticle cannot tell them apart either (§8.5).
 *
 * **How it decides.** It cannot see, so its judgement is an explicit proxy for
 * the two things a player's eye actually does:
 *
 * 1. *That moved.* An object it watched and then found somewhere else is the one
 *    honest tell a hiding Mimic gives away, and a shop's furniture never gives
 *    it. This is what makes a restless hider catchable; a hider that holds still
 *    is found only when the shortlist below happens to send the bot its way.
 * 2. *That is the wrong size to be furniture.* A Mimic is a player-height body,
 *    so an object whose bracket is nowhere near player height is dismissed
 *    unlooked-at. Roughly half the shop's props survive this filter, which is
 *    why the bot still burns warrants on candlesticks and hat boxes.
 *
 * Anything that passes the size filter goes into a seeded shortlist, so a round
 * has a few honest mistakes in it and the same seed hunts the same way twice.
 */

/** Phases in which an Inspector is loose in the shop. */
function isHunting(phase: MatchPhase): boolean {
  return phase === MatchPhase.Inspection || phase === MatchPhase.FinalCountdown;
}

/**
 * Silhouettes worth a second look, as multiples of the player's own height.
 * The starter arrangements measure 0.32 to 0.50 m across their diagonal at this
 * scale, and the band is drawn well clear of that on both sides: the tightest
 * fold would have to shrink by a third or grow by half again before it stopped
 * looking like a person to this bot. That slack is deliberate, because the body
 * is still being reshaped and a filter that tracked it closely would silently
 * stop finding Mimics the first time somebody retuned a shell.
 */
const SUSPECT_MIN_DIAGONAL_M = PLAYER_HEIGHT_M * 0.6;
const SUSPECT_MAX_DIAGONAL_M = PLAYER_HEIGHT_M * 2.4;

/**
 * Share of plausible objects the bot decides to walk over and check. It is set
 * so a hunt spends most of its warrants without emptying them mechanically: a
 * round has a handful of honest mistakes in it, not a sweep of every hat box.
 */
const INSPECTION_RATE = 0.28;

/** Travel that counts as "that has moved", rather than as measurement noise. */
const MOVE_NOTICE_M = 0.015;

/** How long a thing that moved stays interesting. */
const MOVE_MEMORY_MS = 12_000;

/** Waypoint reached, in shares of the body. */
const WAYPOINT_ARRIVAL_M = PLAYER_HEIGHT_M * 1.2;

/**
 * Longest step integrated in one go. Arriving somewhere is what advances the
 * patrol and what replans the route, both of which are tested once per step, so
 * a long step would walk to the end of whatever was planned and stop there.
 */
export const MAX_STEP_MS = 120;

/**
 * Most simulated time one turn may make up. Bots are driven from an interval the
 * browser coalesces, so a main thread that stalls for seconds delivers one turn
 * carrying all of it; walking only the last tick's worth is what produced an
 * Inspector that patrolled a few metres per round and caught nobody, against 17
 * catches in 19 headless rounds at a steady tick.
 *
 * Time past this ceiling is dropped rather than owed, because the alternatives
 * are both worse: a bot that keeps a debt walks at a visibly wrong speed for
 * whole seconds afterwards, and an uncapped burst plans a route per step for as
 * long as the stall lasted, on the thread that was already the problem. Six
 * seconds is fifty steps, which is a few metres of shop.
 */
const MAX_CATCH_UP_MS = 6_000;

/**
 * Floor grid the walk is planned on, a body's width to a cell. The shop is a
 * maze of cabinets with one door into the Security Office, and a bot that
 * steered straight at its goal and slid along whatever it hit spent whole rounds
 * pinned against the office partition. A short breadth-first search over this
 * grid is both cheaper to reason about and impossible to get stuck in.
 */
const CELL_M = WORLD_SCALE.playerRadius * 2;

/** How often the route is replanned, which is also what follows a moving target. */
const REPLAN_MS = 2_000;

interface FloorGrid {
  readonly minX: number;
  readonly minZ: number;
  readonly columns: number;
  readonly rows: number;
  /** Standing height of each cell, or null where a body does not fit. */
  readonly feetY: readonly (number | null)[];
}

function buildFloorGrid(nav: NavData): FloorGrid {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const surface of nav.floors) {
    if (surface.bounds.max.y > WORLD_SCALE.stepHeight) continue;
    minX = Math.min(minX, surface.bounds.min.x);
    minZ = Math.min(minZ, surface.bounds.min.z);
    maxX = Math.max(maxX, surface.bounds.max.x);
    maxZ = Math.max(maxZ, surface.bounds.max.z);
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minZ: 0, columns: 0, rows: 0, feetY: [] };
  }

  const columns = Math.max(1, Math.ceil((maxX - minX) / CELL_M));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL_M));
  const feetY: (number | null)[] = new Array<number | null>(columns * rows).fill(null);
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const x = minX + (column + 0.5) * CELL_M;
      const z = minZ + (row + 0.5) * CELL_M;
      const ground = groundUnder(nav.floors, x, z);
      if (ground === null) continue;
      if (blocksCapsule(nav.blockers, x, z, ground)) continue;
      feetY[row * columns + column] = ground;
    }
  }
  return { minX, minZ, columns, rows, feetY };
}

function cellCentre(grid: FloorGrid, index: number): Vec3Like {
  const column = index % grid.columns;
  const row = Math.floor(index / grid.columns);
  return {
    x: grid.minX + (column + 0.5) * CELL_M,
    y: grid.feetY[index] ?? 0,
    z: grid.minZ + (row + 0.5) * CELL_M,
  };
}

function cellAt(grid: FloorGrid, x: number, z: number): number | null {
  const column = Math.floor((x - grid.minX) / CELL_M);
  const row = Math.floor((z - grid.minZ) / CELL_M);
  if (column < 0 || row < 0 || column >= grid.columns || row >= grid.rows) return null;
  const index = row * grid.columns + column;
  return grid.feetY[index] === null ? null : index;
}

/**
 * Cell-centre route from where the bot is standing to as near `goal` as the
 * floor gets. It floods outward from the bot rather than searching toward the
 * goal, so a goal standing inside furniture, on a shelf, or outside the shop
 * altogether still yields the closest approach instead of no route at all,
 * which is how the bot discovers that something is out of its reach.
 */
function planRoute(grid: FloorGrid, from: Vec3Like, goal: Vec3Like): Vec3Like[] {
  const start = cellAt(grid, from.x, from.z) ?? nearestCell(grid, from);
  if (start === null) return [];

  const parent = new Int32Array(grid.columns * grid.rows).fill(-2);
  parent[start] = -1;
  const queue: number[] = [start];
  let best = start;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head] as number;
    const centre = cellCentre(grid, index);
    const distance = Math.hypot(centre.x - goal.x, centre.z - goal.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
    const column = index % grid.columns;
    const row = Math.floor(index / grid.columns);
    for (const [dx, dz] of NEIGHBOURS) {
      const nextColumn = column + dx;
      const nextRow = row + dz;
      if (nextColumn < 0 || nextRow < 0 || nextColumn >= grid.columns || nextRow >= grid.rows) {
        continue;
      }
      const next = nextRow * grid.columns + nextColumn;
      if (parent[next] !== -2) continue;
      const feetY = grid.feetY[next];
      if (feetY === null || feetY === undefined) continue;
      // A step between cells has to be one a walk could take: no falling off a
      // ledge, and no hopping either. A human Inspector's hop reaches nothing
      // that can be stood on, so a planner that ignores it plans the same
      // routes; what the bot cannot do is climb.
      if (Math.abs(feetY - (grid.feetY[index] as number)) > WORLD_SCALE.stepHeight) continue;
      parent[next] = index;
      queue.push(next);
    }
  }

  const route: Vec3Like[] = [];
  for (let index = best; index >= 0; index = parent[index] as number) {
    route.push(cellCentre(grid, index));
    if (parent[index] === -1) break;
  }
  route.reverse();
  // The first node is the cell the bot is already standing in.
  route.shift();
  return route;
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Nearest standable cell to a point that is not on the floor grid at all. */
function nearestCell(grid: FloorGrid, point: Vec3Like): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < grid.feetY.length; index += 1) {
    if (grid.feetY[index] === null) continue;
    const centre = cellCentre(grid, index);
    const distance = Math.hypot(centre.x - point.x, centre.z - point.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

export interface BotInspectorDeps {
  readonly nav: NavData;
  /**
   * Every object in the room that could be aimed at, props and disguises in one
   * list. The caller merges them; nothing downstream is told which is which.
   */
  readonly candidateIds: () => readonly string[];
  /** World bounds of one of those objects, or null when the room has none yet. */
  readonly objectBounds: (objectId: string) => AABB | null;
  /** Publishes where this bot is standing to the authority's geometry seam. */
  readonly setEye: (playerId: string, eye: Vec3Like | null) => void;
}

export interface BotInspectorTurn {
  readonly playerId: string;
  readonly nowMs: number;
  readonly phase: MatchPhase;
  readonly round: number;
  readonly settings: MatchSettings;
  readonly warrantsRemaining: number;
  /** When the authority will accept this bot's next shot, from its own state. */
  readonly accusationReadyAt: number;
}

interface Sighting {
  /** Where the object was when it was last looked at. */
  readonly at: MutableVec3;
  /** When it was last seen somewhere new, or null if it has never shifted. */
  movedAtMs: number | null;
}

interface Hunter {
  x: number;
  z: number;
  feetY: number;
  nowMs: number;
  waypoint: number;
  /** The object being walked toward, when the bot has decided to check one. */
  target: string | null;
  focused: string | null;
  round: number;
  /** Cell centres still to walk, and what they were planned toward. */
  route: Vec3Like[];
  routeFor: string;
  replanAtMs: number;
  readonly seen: Map<string, Sighting>;
  /** Objects already shot at, or ruled out, so the bot does not circle back. */
  readonly settled: Set<string>;
}

const scratchCentre: MutableVec3 = { x: 0, y: 0, z: 0 };
const scratchGoal: MutableVec3 = { x: 0, y: 0, z: 0 };

function diagonalOf(bounds: AABB): number {
  return Math.hypot(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
}

/**
 * A stable number in [0, 1) for one object in one round. It replaces the die a
 * player rolls when they decide which of two identical hat boxes to walk over
 * and prod, and being seeded is what makes a practice round repeatable.
 */
function shortlistRoll(seed: number, round: number, objectId: string): number {
  let hash = (seed ^ 0x9e3779b9) >>> 0;
  hash = (Math.imul(hash ^ round, 0x85ebca6b) >>> 0) >>> 0;
  for (let index = 0; index < objectId.length; index += 1) {
    hash = Math.imul(hash ^ objectId.charCodeAt(index), 0x01000193) >>> 0;
  }
  hash = Math.imul(hash ^ (hash >>> 15), 0x2545f491) >>> 0;
  return ((hash ^ (hash >>> 16)) >>> 0) / 0x1_0000_0000;
}

/** Ground the bot may stand on: the shop floor and the crawl spaces under it. */
function groundUnder(floors: readonly WalkableSurface[], x: number, z: number): number | null {
  const surface = surfaceAt(floors, x, z, WORLD_SCALE.stepHeight);
  return surface === null ? null : surface.bounds.max.y;
}

/**
 * The patrol: one representative point per ground surface the map publishes,
 * chained nearest-first from the Security Office door. Deriving it from the
 * floor plan rather than authoring a route means a room that grows a new bay is
 * walked without anybody remembering to add a waypoint.
 */
function buildPatrolRoute(nav: NavData): readonly Vec3Like[] {
  const ground = nav.floors.filter(
    (surface) =>
      surface.bounds.max.y <= WORLD_SCALE.stepHeight &&
      (surface.clearance === undefined || surface.clearance >= WORLD_SCALE.playerHeight),
  );

  const points: Vec3Like[] = [];
  for (const surface of ground) {
    const found = standablePointIn(surface, nav.blockers);
    if (found !== null) points.push(found);
  }

  // The Inspector starts inside the office, so the door is the first waypoint:
  // walking straight at a far corner of the shop puts them into the partition.
  const door = nav.securityOffice;
  const start: Vec3Like = {
    x: door.min.x - WORLD_SCALE.playerRadius * 2,
    y: 0,
    z: (door.min.z + door.max.z) / 2,
  };

  const route: Vec3Like[] = [];
  const remaining = [...points];
  let from = start;
  while (remaining.length > 0) {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const point = remaining[index] as Vec3Like;
      const distance = Math.hypot(point.x - from.x, point.z - from.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    from = remaining[best] as Vec3Like;
    route.push(from);
    remaining.splice(best, 1);
  }
  return route;
}

/**
 * A point inside a surface a body actually fits at. The centre is tried first
 * and a coarse grid after it, because several of the shop's floor boxes have
 * furniture standing in the middle of them.
 */
function standablePointIn(surface: WalkableSurface, blockers: readonly AABB[]): Vec3Like | null {
  const y = surface.bounds.max.y;
  const samples = 5;
  const candidates: Vec3Like[] = [
    {
      x: (surface.bounds.min.x + surface.bounds.max.x) / 2,
      y,
      z: (surface.bounds.min.z + surface.bounds.max.z) / 2,
    },
  ];
  for (let ix = 1; ix < samples; ix += 1) {
    for (let iz = 1; iz < samples; iz += 1) {
      candidates.push({
        x: surface.bounds.min.x + ((surface.bounds.max.x - surface.bounds.min.x) * ix) / samples,
        y,
        z: surface.bounds.min.z + ((surface.bounds.max.z - surface.bounds.min.z) * iz) / samples,
      });
    }
  }
  for (const candidate of candidates) {
    if (!blocksCapsule(blockers, candidate.x, candidate.z, y)) return candidate;
  }
  return null;
}

export class BotInspector {
  private readonly deps: BotInspectorDeps;
  private readonly seed: number;
  private readonly route: readonly Vec3Like[];
  private readonly grid: FloorGrid;
  private readonly hunters = new Map<string, Hunter>();

  constructor(deps: BotInspectorDeps, seed: number) {
    this.deps = deps;
    this.seed = seed >>> 0;
    this.grid = buildFloorGrid(deps.nav);
    this.route = buildPatrolRoute(deps.nav);
  }

  /** The patrol the bot walks, for a test that wants to check it is walkable. */
  get patrolRoute(): readonly Vec3Like[] {
    return this.route;
  }

  /** Forgets a bot entirely, which is what leaving the round means. */
  release(playerId: string): void {
    this.hunters.delete(playerId);
    this.deps.setEye(playerId, null);
  }

  /**
   * One tick of one bot Inspector. Returns the commands it wants issued in its
   * own seat; moving is not a command, so the walk is published straight to the
   * geometry seam instead.
   */
  update(turn: BotInspectorTurn): readonly MatchCommand[] {
    if (!isHunting(turn.phase)) {
      // Staged in the office until the door opens (§5.9). The eye is published
      // from there so the authority is never asked about an Inspector it has
      // not heard from, and the walk starts the moment the hunt does.
      if (turn.phase === MatchPhase.InspectionIntro) this.stage(turn);
      return [];
    }

    const hunter = this.hunterFor(turn);
    // What the bot walks is the time the match says has passed, not one turn's
    // worth: the tick it rides is a browser interval, and a busy main thread
    // delivers ten ticks' worth of match in a single callback.
    const elapsedMs = Math.max(0, turn.nowMs - hunter.nowMs);
    hunter.nowMs = turn.nowMs;

    // Sensing happens once, from where the bot was standing when the turn began.
    // Looking at the room per step of a catch-up would cost a visibility test
    // against every object in it per step, on the thread that was already the
    // problem; a stalled client's Inspector is a step behind for one turn.
    const visible = this.look(hunter, turn);
    const commands: MatchCommand[] = [];

    this.chooseTarget(hunter, turn, visible);
    this.catchUp(hunter, turn, Math.min(elapsedMs, MAX_CATCH_UP_MS));
    this.deps.setEye(turn.playerId, this.eyeOf(hunter));

    // Look at the nearest thing in reach. It costs nothing, it is what an
    // Inspector's reticle does anyway, and it is what earns a watched hider the
    // tension indicator and the deception points they are playing for (§5.12).
    const nearest = visible.length > 0 ? (visible[0] as string) : null;
    if (nearest !== hunter.focused) {
      hunter.focused = nearest;
      commands.push({ type: "focus", targetObjectId: nearest });
    }

    const shot = this.shoot(hunter, turn);
    if (shot !== null) commands.push(shot);
    return commands;
  }

  /** Stands the bot at its spawn and tells the authority where that is. */
  private stage(turn: BotInspectorTurn): void {
    const hunter = this.hunterFor(turn);
    // Staging is standing still, so the clock is kept current here too. Left
    // behind, the whole of InspectionIntro would read as elapsed walking time
    // and the hunt would open with the bot several metres into the shop.
    hunter.nowMs = turn.nowMs;
    this.deps.setEye(turn.playerId, this.eyeOf(hunter));
  }

  private hunterFor(turn: BotInspectorTurn): Hunter {
    const existing = this.hunters.get(turn.playerId);
    if (existing !== undefined && existing.round === turn.round) return existing;

    const spawn = this.deps.nav.spawnPoints.inspectors[0];
    const hunter: Hunter = {
      x: spawn?.position.x ?? 0,
      z: spawn?.position.z ?? 0,
      feetY: spawn?.position.y ?? 0,
      nowMs: turn.nowMs,
      waypoint: 0,
      target: null,
      focused: null,
      round: turn.round,
      route: [],
      routeFor: "",
      replanAtMs: turn.nowMs,
      seen: new Map(),
      settled: new Set(),
    };
    this.hunters.set(turn.playerId, hunter);
    return hunter;
  }

  private eyeOf(hunter: Hunter): Vec3Like {
    return { x: hunter.x, y: hunter.feetY + WORLD_SCALE.eyeHeight, z: hunter.z };
  }

  /**
   * Everything in sight this tick, nearest first, with what has changed since
   * the last look written into the bot's memory. Only objects it can genuinely
   * see are recorded: noticing that something moved while it was in another
   * aisle would be knowledge no player has.
   */
  private look(hunter: Hunter, turn: BotInspectorTurn): readonly string[] {
    const eye = this.eyeOf(hunter);
    const reach = turn.settings.inspectorFocusDistance;
    const seen: { objectId: string; distance: number }[] = [];

    for (const objectId of this.deps.candidateIds()) {
      const bounds = this.deps.objectBounds(objectId);
      if (bounds === null) continue;
      const distance = distanceToBounds(eye, bounds);
      if (distance > reach) continue;
      if (!boundsVisibleFrom(this.deps.nav.blockers, eye, bounds, SIGHT_LINE_EPSILON_M)) continue;

      aabbCenter(bounds, scratchCentre);
      const memory = hunter.seen.get(objectId);
      if (memory === undefined) {
        hunter.seen.set(objectId, {
          at: { x: scratchCentre.x, y: scratchCentre.y, z: scratchCentre.z },
          movedAtMs: null,
        });
      } else {
        const travelled = Math.hypot(
          scratchCentre.x - memory.at.x,
          scratchCentre.y - memory.at.y,
          scratchCentre.z - memory.at.z,
        );
        if (travelled > MOVE_NOTICE_M) {
          memory.at.x = scratchCentre.x;
          memory.at.y = scratchCentre.y;
          memory.at.z = scratchCentre.z;
          memory.movedAtMs = turn.nowMs;
        }
      }
      seen.push({ objectId, distance });
    }

    seen.sort((a, b) => a.distance - b.distance);
    return seen.map((entry) => entry.objectId);
  }

  /**
   * Whether this object is worth walking over to. The two tests are the eye's:
   * it is about the size of a person, and either it has been caught moving or
   * this round's shortlist picked it out.
   */
  private suspicious(hunter: Hunter, turn: BotInspectorTurn, objectId: string): boolean {
    if (hunter.settled.has(objectId)) return false;
    const bounds = this.deps.objectBounds(objectId);
    if (bounds === null) return false;
    const diagonal = diagonalOf(bounds);
    if (diagonal < SUSPECT_MIN_DIAGONAL_M || diagonal > SUSPECT_MAX_DIAGONAL_M) return false;

    const memory = hunter.seen.get(objectId);
    if (memory?.movedAtMs != null && turn.nowMs - memory.movedAtMs < MOVE_MEMORY_MS) return true;
    return shortlistRoll(this.seed, turn.round, objectId) < INSPECTION_RATE;
  }

  private chooseTarget(hunter: Hunter, turn: BotInspectorTurn, visible: readonly string[]): void {
    if (hunter.target !== null && hunter.settled.has(hunter.target)) hunter.target = null;
    if (hunter.target !== null) return;

    for (const objectId of visible) {
      if (!this.suspicious(hunter, turn, objectId)) continue;
      hunter.target = objectId;
      hunter.routeFor = "";
      return;
    }
  }

  /**
   * Walks `advanceMs` of match time in steps of at most `MAX_STEP_MS`, replanning
   * between them exactly as a run of ordinary turns would. A burst is therefore
   * a run of ordinary steps taken back to back, and cannot outpace one: each
   * consumes at most `inspectorMoveSpeed * stepMs` of the planned route, and the
   * route is a polyline over standable cells, so covering it faster than the
   * walk allows is not expressible here.
   *
   * At most one step is taken when no time has passed, which is what keeps a
   * route planned for a bot that has only just arrived in the room.
   */
  private catchUp(hunter: Hunter, turn: BotInspectorTurn, advanceMs: number): void {
    let remainingMs = advanceMs;
    do {
      const stepMs = Math.min(MAX_STEP_MS, remainingMs);
      this.walk(hunter, turn, stepMs);
      remainingMs -= stepMs;
    } while (remainingMs > 0);
  }

  /**
   * Follows the planned route, cell by cell, at the room's own walking speed.
   * Whether the route leads to a suspect object or to the next patrol point is
   * settled in `plan`; from here it is the same walk either way.
   */
  private walk(hunter: Hunter, turn: BotInspectorTurn, dtMs: number): void {
    this.plan(hunter, turn);

    let budget = (turn.settings.inspectorMoveSpeed * dtMs) / 1_000;
    while (budget > 0 && hunter.route.length > 0) {
      const next = hunter.route[0] as Vec3Like;
      const toX = next.x - hunter.x;
      const toZ = next.z - hunter.z;
      const distance = Math.hypot(toX, toZ);
      if (distance <= budget) {
        hunter.x = next.x;
        hunter.z = next.z;
        hunter.feetY = next.y;
        hunter.route.shift();
        budget -= distance;
        continue;
      }
      hunter.x += (toX / distance) * budget;
      hunter.z += (toZ / distance) * budget;
      budget = 0;
    }
  }

  /**
   * Keeps the route pointed at whatever the bot currently wants. It is replanned
   * when the goal changes, when the route runs out, and on a slow timer, which
   * is also what follows a target that has crept somewhere else.
   */
  private plan(hunter: Hunter, turn: BotInspectorTurn): void {
    const reach = turn.settings.accusationDistance;
    const targetBounds = hunter.target === null ? null : this.deps.objectBounds(hunter.target);
    if (hunter.target !== null && targetBounds === null) hunter.target = null;

    // Already close enough to shoot, so there is nowhere left to walk.
    if (targetBounds !== null && this.canShoot(this.eyeOf(hunter), targetBounds, reach)) {
      hunter.route.length = 0;
      hunter.routeFor = hunter.target ?? "";
      hunter.replanAtMs = turn.nowMs + REPLAN_MS;
      return;
    }

    // Standing on a patrol point is what advances the patrol.
    if (hunter.target === null) {
      const point = this.patrolPoint(hunter);
      if (point !== null && Math.hypot(point.x - hunter.x, point.z - hunter.z) <= WAYPOINT_ARRIVAL_M) {
        this.advancePatrol(hunter);
      }
    }

    const goalKey = hunter.target ?? `patrol:${String(hunter.waypoint)}`;
    if (goalKey === hunter.routeFor && hunter.route.length > 0 && turn.nowMs < hunter.replanAtMs) {
      return;
    }
    hunter.routeFor = goalKey;
    hunter.replanAtMs = turn.nowMs + REPLAN_MS;

    const here: Vec3Like = { x: hunter.x, y: hunter.feetY, z: hunter.z };
    if (targetBounds === null) {
      const point = this.patrolPoint(hunter);
      hunter.route = point === null ? [] : planRoute(this.grid, here, point);
      if (hunter.route.length === 0) this.advancePatrol(hunter);
      return;
    }

    aabbCenter(targetBounds, scratchGoal);
    const route = planRoute(this.grid, here, scratchGoal);
    // Stop the walk where the gun reaches rather than trying to stand inside the
    // thing. What no part of the floor can get near enough to shoot is out of
    // this bot's reach for good: it does not climb, and a hop reaches nothing
    // that can be stood on.
    const approach = this.trimToReach(route, targetBounds, reach);
    if (approach === null) {
      hunter.settled.add(hunter.target as string);
      hunter.target = null;
      hunter.route = [];
      hunter.routeFor = "";
      return;
    }
    hunter.route = approach;
  }

  private patrolPoint(hunter: Hunter): Vec3Like | null {
    return this.route[hunter.waypoint % Math.max(1, this.route.length)] ?? null;
  }

  private advancePatrol(hunter: Hunter): void {
    hunter.waypoint = (hunter.waypoint + 1) % Math.max(1, this.route.length);
    hunter.routeFor = "";
  }

  /** In range and in sight, which is exactly what the authority will ask. */
  private canShoot(eye: Vec3Like, bounds: AABB, reach: number): boolean {
    if (distanceToBounds(eye, bounds) > reach) return false;
    return boundsVisibleFrom(this.deps.nav.blockers, eye, bounds, SIGHT_LINE_EPSILON_M);
  }

  /** The route cut at the first node the shot can be taken from, or null. */
  private trimToReach(route: readonly Vec3Like[], bounds: AABB, reach: number): Vec3Like[] | null {
    for (let index = 0; index < route.length; index += 1) {
      const node = route[index] as Vec3Like;
      const eye = { x: node.x, y: node.y + WORLD_SCALE.eyeHeight, z: node.z };
      if (this.canShoot(eye, bounds, reach)) return route.slice(0, index + 1);
    }
    return null;
  }

  /**
   * Fires when the target is in reach and in sight. The authority checks both
   * again and is free to disagree; the bot marks the object settled either way,
   * so a refusal costs it the walk rather than the rest of the round.
   */
  private shoot(hunter: Hunter, turn: BotInspectorTurn): MatchCommand | null {
    const target = hunter.target;
    if (target === null) return null;
    if (turn.warrantsRemaining <= 0) return null;
    if (turn.nowMs < turn.accusationReadyAt) return null;

    const bounds = this.deps.objectBounds(target);
    if (bounds === null) return null;
    if (!this.canShoot(this.eyeOf(hunter), bounds, turn.settings.accusationDistance)) return null;

    hunter.settled.add(target);
    hunter.target = null;
    return { type: "accuse", targetObjectId: target };
  }
}
