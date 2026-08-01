import {
  MatchSimulation,
  type MatchCommand,
  type MatchSettingsPatch,
  type PrivateSimEvent,
  type SimEvent,
  type SimOutput,
} from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import {
  EMPTY_SYNC,
  idleConnection,
  type CommandRejection,
  type ConnectionState,
  type ForgeSnapshot,
  type MatchSync,
  type NetworkAdapter,
  type PaintUpdate,
  type RosterEntry,
  type Unsubscribe,
} from "./NetworkAdapter";
import { Signal } from "./signal";

/**
 * Runs MatchSimulation in the page for practice and offline play. Commands go
 * straight into the simulation and its output comes straight back out, so the
 * client exercises the same code path it uses on a real transport with none of
 * the latency, batching, or authority machinery.
 */

export const LOCAL_TICK_HZ = 10;
export const LOCAL_SELF_ID = "local-self";
const BOT_POSE_PREFIX = "bot-pose-";

export interface LocalLoopbackOptions {
  readonly settings?: MatchSettingsPatch;
  readonly seed?: number;
  readonly tickHz?: number;
  /** Clock source. Defaults to performance.now(), which never runs backwards. */
  readonly now?: () => number;
}

export interface AddBotOptions {
  readonly displayName?: string;
  /** Bots ready up and lock a placeholder pose so a solo round can progress. */
  readonly autoPlay?: boolean;
}

interface Bot {
  readonly playerId: string;
  readonly displayName: string;
  readonly autoPlay: boolean;
}

export class LocalLoopbackAdapter implements NetworkAdapter {
  readonly mode = "local" as const;

  private readonly options: LocalLoopbackOptions;
  private readonly tickHz: number;
  private readonly clock: () => number;

  private readonly eventSignal = new Signal<SimEvent>();
  private readonly privateSignal = new Signal<PrivateSimEvent>();
  private readonly rejectionSignal = new Signal<CommandRejection>();
  private readonly rosterSignal = new Signal<readonly RosterEntry[]>();
  private readonly statusSignal = new Signal<ConnectionState>();
  private readonly syncSignal = new Signal<MatchSync>();

  private sim: MatchSimulation | null = null;
  private readonly bots: Bot[] = [];
  private displayName = "Visitor";
  private connection: ConnectionState = idleConnection("local");
  private sync: MatchSync = EMPTY_SYNC;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: LocalLoopbackOptions = {}) {
    this.options = options;
    this.tickHz = options.tickHz ?? LOCAL_TICK_HZ;
    this.clock = options.now ?? (() => performance.now());
  }

  async connect(): Promise<void> {
    // No transport to acquire; join() builds the simulation.
  }

  async join(_room: string, displayName: string): Promise<ConnectionState> {
    if (this.disposed) throw new Error("LocalLoopbackAdapter was disposed");
    this.displayName = displayName;
    this.setStatus({ status: "connecting", selfId: null, authorityId: null });

    this.sim = new MatchSimulation(this.options.settings ?? {}, this.options.seed ?? 1);
    this.publish(this.sim.addPlayer(LOCAL_SELF_ID, { displayName, isHost: true }));
    for (const bot of this.bots) {
      this.publish(this.sim.addPlayer(bot.playerId, { displayName: bot.displayName }));
    }

    this.startTicking();
    this.setStatus({ status: "connected", selfId: LOCAL_SELF_ID, authorityId: LOCAL_SELF_ID });
    this.emitRoster();
    this.emitSync();
    return this.connection;
  }

  async disconnect(): Promise<void> {
    this.stopTicking();
    this.sim = null;
    this.sync = EMPTY_SYNC;
    this.setStatus({ status: "closed", selfId: null, authorityId: null });
    this.syncSignal.emit(this.sync);
    this.emitRoster();
  }

  dispose(): void {
    this.disposed = true;
    this.stopTicking();
    this.sim = null;
    this.eventSignal.clear();
    this.privateSignal.clear();
    this.rejectionSignal.clear();
    this.rosterSignal.clear();
    this.statusSignal.clear();
    this.syncSignal.clear();
  }

  sendCommand(command: MatchCommand): void {
    this.sendCommandAs(LOCAL_SELF_ID, command);
  }

  sendForgeSnapshot(snapshot: ForgeSnapshot): void {
    const sim = this.sim;
    if (!sim) return;
    // A creep is a pose update: it produces events for the room and can be
    // refused for moving too fast or leaving the play volume.
    const result = sim.recordForgeSnapshot(
      LOCAL_SELF_ID,
      snapshot.encodedPose,
      snapshot.revision,
      this.clock(),
    );
    if (!result.accepted) {
      this.rejectionSignal.emit(
        result.detail === undefined
          ? { type: "forge_snapshot", reason: result.reason ?? "rejected" }
          : { type: "forge_snapshot", reason: result.reason ?? "rejected", detail: result.detail },
      );
    }
    this.publish(result);
    this.emitSync();
  }

  sendPaintUpdate(update: PaintUpdate): void {
    const sim = this.sim;
    if (!sim) return;
    const result = sim.recordPaintUpdate(
      LOCAL_SELF_ID,
      update.encodedPaint,
      update.revision,
      this.clock(),
    );
    if (!result.accepted) {
      this.rejectionSignal.emit(
        result.detail === undefined
          ? { type: "paint_update", reason: result.reason ?? "rejected" }
          : { type: "paint_update", reason: result.reason ?? "rejected", detail: result.detail },
      );
    }
    this.publish(result);
    this.emitSync();
  }

  /** Issues a command on behalf of a bot, for scripted practice and tests. */
  sendCommandAs(playerId: string, command: MatchCommand): void {
    const sim = this.sim;
    if (!sim) {
      console.warn("[local] command before join, ignoring", command.type);
      return;
    }
    const result = sim.handleCommand(playerId, command);
    // Only the human player's refusals reach the UI; a bot's are its own business.
    if (!result.accepted && playerId === LOCAL_SELF_ID) {
      this.rejectionSignal.emit(
        result.detail === undefined
          ? { type: command.type, reason: result.reason ?? "rejected" }
          : { type: command.type, reason: result.reason ?? "rejected", detail: result.detail },
      );
    }
    this.publish(result);
    this.emitSync();
  }

  /**
   * Adds a simulated player. Callable before join(), in which case the bot is
   * seated when the session starts.
   */
  addBot(options: AddBotOptions = {}): string {
    const playerId = `bot-${this.bots.length + 1}`;
    const displayName = options.displayName ?? `Bot ${this.bots.length + 1}`;
    this.bots.push({ playerId, displayName, autoPlay: options.autoPlay ?? true });
    if (this.sim) {
      this.publish(this.sim.addPlayer(playerId, { displayName }));
      this.emitRoster();
      this.emitSync();
    }
    return playerId;
  }

  removeBot(playerId: string): void {
    const index = this.bots.findIndex((bot) => bot.playerId === playerId);
    if (index < 0) return;
    this.bots.splice(index, 1);
    if (this.sim) {
      this.publish(this.sim.removePlayer(playerId));
      this.emitRoster();
      this.emitSync();
    }
  }

  /** Advances the simulation by hand. The interval calls this; tests can too. */
  step(): void {
    const sim = this.sim;
    if (!sim) return;
    this.publish(sim.tick(this.clock()));
    this.driveBots(sim);
    this.emitSync();
  }

  getSelfId(): string | null {
    return this.connection.selfId;
  }

  getConnection(): ConnectionState {
    return this.connection;
  }

  getRoster(): readonly RosterEntry[] {
    if (!this.sim) return [];
    return [
      { id: LOCAL_SELF_ID, displayName: this.displayName, isSelf: true, isAuthority: true },
      ...this.bots.map((bot) => ({
        id: bot.playerId,
        displayName: bot.displayName,
        isSelf: false,
        isAuthority: false,
      })),
    ];
  }

  getSync(): MatchSync {
    return this.sync;
  }

  onEvent(listener: (event: SimEvent) => void): Unsubscribe {
    return this.eventSignal.subscribe(listener);
  }

  onPrivateEvent(listener: (event: PrivateSimEvent) => void): Unsubscribe {
    return this.privateSignal.subscribe(listener);
  }

  onRejection(listener: (rejection: CommandRejection) => void): Unsubscribe {
    return this.rejectionSignal.subscribe(listener);
  }

  onRoster(listener: (roster: readonly RosterEntry[]) => void): Unsubscribe {
    return this.rosterSignal.subscribe(listener);
  }

  onStatus(listener: (state: ConnectionState) => void): Unsubscribe {
    return this.statusSignal.subscribe(listener);
  }

  onSync(listener: (sync: MatchSync) => void): Unsubscribe {
    return this.syncSignal.subscribe(listener);
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = setInterval(() => {
      this.step();
    }, Math.round(1_000 / this.tickHz));
  }

  private stopTicking(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The smallest policy that lets a solo player reach the reveal: bots ready up
   * in the lobby and, as Mimics, lock a placeholder pose during the Forge. They
   * make no inspection decisions, so a bot-only round ends on the timer.
   */
  private driveBots(sim: MatchSimulation): void {
    const phase = sim.getPhase();
    for (const bot of this.bots) {
      if (!bot.autoPlay) continue;
      const state = sim.getPrivateStateFor(bot.playerId);
      if (!state) continue;

      if ((phase === MatchPhase.Lobby || phase === MatchPhase.Loading) && !state.ready) {
        this.publish(sim.handleCommand(bot.playerId, { type: "player_ready", ready: true }));
        continue;
      }
      if (phase === MatchPhase.Forge && state.role === "mimic" && state.ownDisguise === null) {
        this.publish(
          sim.handleCommand(bot.playerId, {
            type: "lock_disguise",
            payload: `${BOT_POSE_PREFIX}${bot.playerId}`,
            revision: 1,
          }),
        );
      }
    }
  }

  /**
   * Public events reach the one local player; private events reach them only if
   * the simulation addressed them there, which is exactly the routing a real
   * transport performs.
   */
  private publish(output: SimOutput): void {
    for (const event of output.public) this.eventSignal.emit(event);
    for (const event of output.private.get(LOCAL_SELF_ID) ?? []) this.privateSignal.emit(event);
    if (output.public.some((event) => event.type === "player_joined" || event.type === "player_left")) {
      this.emitRoster();
    }
  }

  private emitRoster(): void {
    this.rosterSignal.emit(this.getRoster());
  }

  private emitSync(): void {
    const sim = this.sim;
    if (!sim) return;
    this.sync = {
      publicState: sim.getPublicState(),
      privateState: sim.getPrivateStateFor(LOCAL_SELF_ID),
    };
    this.syncSignal.emit(this.sync);
  }

  private setStatus(patch: Pick<ConnectionState, "status" | "selfId" | "authorityId">): void {
    this.connection = { ...this.connection, ...patch, canRejoin: false, detail: null };
    this.statusSignal.emit(this.connection);
  }
}
