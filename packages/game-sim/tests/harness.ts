import {
  MatchPhase,
  createReferenceDisguiseWire,
  encodeDisguiseWire,
} from "@foldseek/shared";
import {
  MatchSimulation,
  type CommandResult,
  type MatchCommand,
  type MatchSettingsPatch,
  type ObjectRegistry,
  type PrivateSimEvent,
  type SimEvent,
  type SimOutput,
  type SpatialValidator,
} from "../src";

export interface HarnessOptions {
  readonly players?: number;
  readonly seed?: number;
  readonly settings?: MatchSettingsPatch;
  readonly spatial?: SpatialValidator;
  readonly registry?: ObjectRegistry;
}

/** A schema-valid pose, nudged so two Mimics never lock identical geometry. */
export function testPose(offset: number, revision = 1): string {
  const pose = createReferenceDisguiseWire(revision);
  pose.root.position = [offset / 10, 0, 0];
  return encodeDisguiseWire(pose);
}

/** Drives a MatchSimulation with an explicit clock and records every event. */
export class Harness {
  readonly sim: MatchSimulation;
  readonly playerIds: string[] = [];
  readonly log: SimEvent[] = [];
  readonly privateLog = new Map<string, PrivateSimEvent[]>();
  now = 0;

  constructor(options: HarnessOptions = {}) {
    const playerCount = options.players ?? 4;
    this.sim = new MatchSimulation(
      options.settings ?? {},
      options.seed ?? 7,
      options.spatial,
      options.registry,
    );
    for (let i = 0; i < playerCount; i += 1) {
      const playerId = `player-${i}`;
      this.playerIds.push(playerId);
      this.record(this.sim.addPlayer(playerId, { displayName: `Visitor ${i}`, isHost: i === 0 }));
    }
  }

  get hostId(): string {
    return this.playerIds[0] as string;
  }

  record<T extends SimOutput>(output: T): T {
    this.log.push(...output.public);
    for (const [playerId, events] of output.private) {
      const queue = this.privateLog.get(playerId);
      if (queue) {
        queue.push(...events);
      } else {
        this.privateLog.set(playerId, [...events]);
      }
    }
    return output;
  }

  tick(deltaMs: number): SimOutput {
    this.now += deltaMs;
    return this.record(this.sim.tick(this.now));
  }

  command(playerId: string, command: MatchCommand): CommandResult {
    return this.record(this.sim.handleCommand(playerId, command));
  }

  readyAll(): void {
    for (const playerId of this.playerIds) {
      this.command(playerId, { type: "player_ready", ready: true });
    }
  }

  /** Role, or "absent" once a player has left the room entirely. */
  roleOf(playerId: string): string {
    return this.sim.getPrivateStateFor(playerId)?.role ?? "absent";
  }

  inspectorIds(): string[] {
    return this.playerIds.filter((playerId) => this.roleOf(playerId) === "inspector");
  }

  mimicIds(): string[] {
    return this.playerIds.filter((playerId) => this.roleOf(playerId) === "mimic");
  }

  objectIdOf(playerId: string): string {
    const disguise = this.sim.getPrivateStateFor(playerId)?.ownDisguise;
    if (!disguise) throw new Error(`${playerId} has no locked disguise`);
    return disguise.publicObjectId;
  }

  eventsOfType<T extends SimEvent["type"]>(type: T): Array<Extract<SimEvent, { type: T }>> {
    return this.log.filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);
  }

  privateEventsFor(playerId: string): readonly PrivateSimEvent[] {
    return this.privateLog.get(playerId) ?? [];
  }

  privateEventsOfType<T extends PrivateSimEvent["type"]>(
    playerId: string,
    type: T,
  ): Array<Extract<PrivateSimEvent, { type: T }>> {
    return this.privateEventsFor(playerId).filter(
      (event): event is Extract<PrivateSimEvent, { type: T }> => event.type === type,
    );
  }

  /** Every private event the run produced, in delivery order per player. */
  allPrivateEvents(): PrivateSimEvent[] {
    return [...this.privateLog.values()].flat();
  }

  phase(): MatchPhase {
    return this.sim.getPhase();
  }

  /** Lobby through Forge, leaving every Mimic unlocked. */
  toForge(): this {
    this.readyAll();
    this.command(this.hostId, { type: "start_match" });
    this.readyAll();
    this.tickUntil(MatchPhase.Forge);
    return this;
  }

  /** Locks every Mimic and runs the inspection intro out. */
  toInspection(): this {
    if (this.phase() !== MatchPhase.Forge) this.toForge();
    for (const [index, mimicId] of this.mimicIds().entries()) {
      this.command(mimicId, { type: "lock_disguise", payload: testPose(index), revision: 1 });
    }
    this.tickUntil(MatchPhase.Inspection);
    return this;
  }

  /** Ticks in small steps until the simulation reaches the requested phase. */
  tickUntil(phase: MatchPhase, stepMs = 250, maxSteps = 2_000): void {
    for (let step = 0; step < maxSteps; step += 1) {
      if (this.phase() === phase) return;
      this.tick(stepMs);
    }
    throw new Error(`phase ${phase} not reached, stuck in ${this.phase()}`);
  }
}
