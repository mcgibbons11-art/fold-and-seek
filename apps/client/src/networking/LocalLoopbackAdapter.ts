import {
  MatchSimulation,
  type MatchCommand,
  type MatchSettingsPatch,
  type ObjectRegistry,
  type PrivateMatchState,
  type PrivateSimEvent,
  type PublicMatchState,
  type SimEvent,
  type SimOutput,
  type SpatialValidator,
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
  /**
   * Geometry seam. Omitted, the simulation accepts every accusation from every
   * distance, so a real round supplies the map's validator here (§28.4).
   */
  readonly spatial?: SpatialValidator;
  /** Objects an Inspector may accuse. Defaults to the simulation's own fixture. */
  readonly objectRegistry?: ObjectRegistry;
  /**
   * Encoded disguise an auto-playing bot locks, by seat order. Returning null
   * leaves the bot to the simulation's §5.8 fallback, which is a starting
   * arrangement at the world origin rather than anywhere in the room.
   */
  readonly botPose?: (index: number, playerId: string) => string | null;
  /**
   * Behaviour for auto-playing bots beyond readying up and locking: patrolling,
   * accusing, creeping. Omitted, bots lock a disguise and do nothing else, and
   * a round in which the bots inspect runs the clock out.
   */
  readonly botBrain?: BotBrain;
}

/**
 * What one bot may do on one tick. A command is anything a player could send;
 * a forge snapshot is the pose channel, which is not a command because it is
 * validated on its own terms (creep speed, revision, play volume).
 */
export type BotAction =
  | { readonly kind: "command"; readonly command: MatchCommand }
  | { readonly kind: "forge_snapshot"; readonly encodedPose: string; readonly revision: number };

export interface BotTurn {
  /** Seat order, which is what `botPose` indexes bot disguises by. */
  readonly index: number;
  readonly playerId: string;
  readonly nowMs: number;
  readonly publicState: PublicMatchState;
  /**
   * This bot's own private state. No other seat's is ever offered here, so a
   * brain cannot read another player's role or disguise even by mistake.
   */
  readonly privateState: PrivateMatchState;
}

export interface BotBrain {
  act(turn: BotTurn): readonly BotAction[];
  /** A bot that has left the room, so any state kept for it can go. */
  release?(playerId: string): void;
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

    this.sim = new MatchSimulation(
      this.options.settings ?? {},
      this.options.seed ?? 1,
      this.options.spatial,
      this.options.objectRegistry,
    );
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
      // Dropping this on the floor leaves a lobby that looks alive and answers
      // nothing, which is indistinguishable from a hung game. The refusal goes
      // to the same stream every other refusal uses, so the player sees it.
      console.warn("[local] command before join, ignoring", command.type);
      if (playerId === LOCAL_SELF_ID) {
        this.rejectionSignal.emit({ type: command.type, reason: "not_connected" });
      }
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
    this.options.botBrain?.release?.(playerId);
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
    // One reading drives the whole step. A bot measures how much of the match it
    // has to catch up on against the clock the phase machine was just advanced
    // to, so taking a second reading for the bots would hand them a different
    // moment from the one the authority is judging them in.
    const nowMs = this.clock();
    this.publish(sim.tick(nowMs));
    this.driveBots(sim, nowMs);
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
   * Gets every bot through the round. Readying up in the lobby and locking a
   * disguise in the Forge are the two things a seat must do for the match to
   * progress at all, so they live here; everything a bot chooses to do after
   * that is the brain's, and a round without one runs the clock out.
   *
   * `nowMs` is the step's own clock reading and is the only time a brain is
   * given. Ticks are not counted anywhere: this interval is coalesced by the
   * browser whenever the main thread is busy, so a brain that acted per callback
   * would slow down exactly when the match did not.
   */
  private driveBots(sim: MatchSimulation, nowMs: number): void {
    const phase = sim.getPhase();
    const brain = this.options.botBrain;
    // Taken once and shared: it is a defensive copy of the whole room, and one
    // per bot per tick would be several disguise poses of garbage a second.
    const publicState = brain === undefined ? null : sim.getPublicState();

    for (const [index, bot] of this.bots.entries()) {
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
            payload:
              this.options.botPose?.(index, bot.playerId) ?? `${BOT_POSE_PREFIX}${bot.playerId}`,
            revision: 1,
          }),
        );
        continue;
      }
      if (brain === undefined || publicState === null) continue;

      const actions = brain.act({
        index,
        playerId: bot.playerId,
        nowMs,
        publicState,
        privateState: state,
      });
      for (const action of actions) this.applyBotAction(bot.playerId, action, nowMs);
    }
  }

  private applyBotAction(playerId: string, action: BotAction, nowMs: number): void {
    const sim = this.sim;
    if (!sim) return;
    if (action.kind === "command") {
      this.sendCommandAs(playerId, action.command);
      return;
    }
    // A creep is judged on its own terms, so it goes to the pose channel rather
    // than through handleCommand, exactly as a human hider's does, and against
    // the moment the brain decided on it rather than a later reading of the
    // clock, because the authority measures creep speed over that interval.
    this.publish(sim.recordForgeSnapshot(playerId, action.encodedPose, action.revision, nowMs));
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
