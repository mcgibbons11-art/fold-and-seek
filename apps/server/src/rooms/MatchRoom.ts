import { Room, type Client } from "@colyseus/core";
import { Schema, MapSchema, type } from "@colyseus/schema";
import {
  MatchSimulation,
  type CommandResult,
  type MatchCommand,
  type MatchSettingsPatch,
  type SimOutput,
  type SpatialValidator,
} from "@foldseek/game-sim";
import {
  DEFAULT_MATCH_SETTINGS,
  ForgeSnapshotSchema,
  MatchCommandSchema,
  MatchPhase,
  PaintUpdateSchema,
} from "@foldseek/shared";
import {
  KeyedRateWindow,
  MAX_COMMANDS_PER_SECOND,
  MAX_MESSAGE_BYTES,
  RATE_WINDOW_MS,
  messageByteLength,
} from "./messageGuards";

/**
 * Dedicated-server wrapper around MatchSimulation. The room owns no game rules:
 * it validates what arrives, feeds the simulation, and routes what comes back
 * out. Public, frequently observed state stays in the schema for lobby UI;
 * everything private is a targeted message (§27.5).
 *
 * The simulation separates the two event streams itself, so routing here is
 * mechanical: `public` is broadcast and each `private` queue goes to the client
 * whose session id it is keyed under. Nothing is redacted at this layer.
 */

/** Client to server. Each carries the whole MatchCommand, so the name is its `type`. */
const COMMAND_MESSAGE_TYPES: readonly MatchCommand["type"][] = [
  "player_ready",
  "set_settings",
  "start_match",
  "lock_disguise",
  "accuse",
  "focus",
  "taunt",
  "vote_result",
  "vote_rematch",
];

/** Server to client. Mirrored by SERVER_MESSAGE in the client ColyseusAdapter. */
export const SERVER_MESSAGE = {
  simEvents: "sim_events",
  privateEvents: "private_events",
  privateState: "private_state",
  commandRejected: "command_rejected",
} as const;

export const FORGE_SNAPSHOT_MESSAGE = "forge_snapshot";
export const PAINT_UPDATE_MESSAGE = "paint_update";
export const SIMULATION_TICK_MS = Math.round(1_000 / DEFAULT_MATCH_SETTINGS.serverTickHz);

/**
 * Consecutive failed ticks tolerated before the room closes itself. A sim that
 * cannot tick at all would otherwise leave every client on a frozen phase with
 * no rejection and no status change — a silent freeze instead of a loud fault.
 */
export const MAX_CONSECUTIVE_TICK_FAILURES = 5;

export class PublicPlayerState extends Schema {
  @type("string") publicId = "";
  @type("string") displayName = "";
  @type("string") rolePublicState = "unknown";
  @type("string") lifeState = "active";
  @type("boolean") isHost = false;
  @type("boolean") ready = false;
  @type("boolean") connected = true;
}

export class MatchStateSchema extends Schema {
  @type("string") phase: string = MatchPhase.Lobby;
  @type("number") phaseEndsAt = 0;
  @type("number") round = 0;
  @type("string") mapId = "curiosity_shop";
  /** Keyed by public player id: session ids never enter synchronized state. */
  @type({ map: PublicPlayerState }) players = new MapSchema<PublicPlayerState>();
}

export interface MatchRoomOptions {
  readonly settings?: MatchSettingsPatch;
  readonly seed?: number;
  /**
   * Range and line-of-sight checks. The simulation defaults to a permissive
   * validator, so leaving this out means accusations and direct-look escapes
   * are not gated on geometry.
   */
  readonly spatial?: SpatialValidator;
}

export class MatchRoom extends Room<MatchStateSchema> {
  /** Replaced in onCreate by the configured capacity; typed wide so it can be. */
  override maxClients: number = DEFAULT_MATCH_SETTINGS.maxPlayers;

  private sim = new MatchSimulation();
  private commandWindow = new KeyedRateWindow(MAX_COMMANDS_PER_SECOND, RATE_WINDOW_MS);
  private forgeWindow = new KeyedRateWindow(
    DEFAULT_MATCH_SETTINGS.maxForgeCommandHz,
    RATE_WINDOW_MS,
  );
  private consecutiveTickFailures = 0;

  override onCreate(options: MatchRoomOptions = {}): void {
    this.sim = new MatchSimulation(
      options.settings ?? {},
      options.seed ?? Date.now() >>> 0,
      options.spatial,
    );
    // The simulation is the authority on capacity; the matchmaker turns clients
    // away before they reach onJoin using the same number.
    this.maxClients = this.sim.getSettings().maxPlayers;
    this.commandWindow = new KeyedRateWindow(MAX_COMMANDS_PER_SECOND, RATE_WINDOW_MS);
    this.forgeWindow = new KeyedRateWindow(
      this.sim.getSettings().maxForgeCommandHz,
      RATE_WINDOW_MS,
    );
    this.setState(new MatchStateSchema());

    for (const messageType of COMMAND_MESSAGE_TYPES) {
      this.onMessage(messageType, (client: Client, message: unknown) => {
        this.handleMatchCommand(client, messageType, message);
      });
    }
    this.onMessage(FORGE_SNAPSHOT_MESSAGE, (client: Client, message: unknown) => {
      this.handleForgeSnapshot(client, message);
    });
    this.onMessage(PAINT_UPDATE_MESSAGE, (client: Client, message: unknown) => {
      this.handlePaintUpdate(client, message);
    });

    this.setSimulationInterval(() => {
      this.step();
    }, SIMULATION_TICK_MS);
  }

  override onJoin(client: Client, options: { displayName?: unknown } | undefined): void {
    const requested = typeof options?.displayName === "string" ? options.displayName : "";
    const displayName = requested.trim().slice(0, 24) || `Guest-${client.sessionId.slice(0, 4)}`;

    const seated = this.sim.addPlayer(client.sessionId, { displayName });
    if (!seated.accepted) {
      // Throwing from onJoin is how Colyseus refuses a seat, and it reaches the
      // client as a join error rather than a silent seat that never appears.
      throw new Error(seated.reason ?? "join_refused");
    }
    this.publish(seated);
    this.sendPrivateState(client);
  }

  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    this.commandWindow.forget(client.sessionId);
    this.forgeWindow.forget(client.sessionId);
    if (consented === true) {
      this.publish(this.sim.removePlayer(client.sessionId));
      return;
    }

    // Hold the slot so a dropped player keeps their role and disguise (§27.9).
    // The simulation runs the same grace window and evicts the slot when it
    // expires, so the two clocks agree.
    this.publish(this.sim.markDisconnected(client.sessionId, Date.now()));
    const graceSeconds = this.sim.getSettings().reconnectGraceMs / 1_000;
    try {
      await this.allowReconnection(client, graceSeconds);
      this.publish(this.sim.markReconnected(client.sessionId, Date.now()));
      this.sendPrivateState(client);
    } catch {
      this.publish(this.sim.removePlayer(client.sessionId, "reconnect_timeout"));
    }
  }

  /**
   * Message entry point for every match command. Public so the room can be
   * driven directly in unit tests without booting a transport.
   */
  handleMatchCommand(client: Client, messageType: MatchCommand["type"], message: unknown): void {
    if (!this.withinLimits(client, this.commandWindow, messageType, message)) return;

    const parsed = MatchCommandSchema.safeParse(message);
    if (!parsed.success) {
      client.send(SERVER_MESSAGE.commandRejected, { type: messageType, reason: "invalid_payload" });
      return;
    }
    if (parsed.data.type !== messageType) {
      client.send(SERVER_MESSAGE.commandRejected, { type: messageType, reason: "type_mismatch" });
      return;
    }

    let result: CommandResult;
    try {
      result = this.sim.handleCommand(client.sessionId, parsed.data);
    } catch (error) {
      // A throw from the simulation must not escape a message handler and take
      // the room down with it; the match keeps running on its last good state.
      console.error(`[match-room] simulation failed on ${messageType}`, error);
      client.send(SERVER_MESSAGE.commandRejected, { type: messageType, reason: "internal_error" });
      return;
    }

    // The `detail` key is omitted rather than set to undefined: msgpack would
    // carry it across as a null, which the client's rejection schema refuses.
    if (!result.accepted) this.reject(client, messageType, result.reason, result.detail);
    this.publish(result);
  }

  handleForgeSnapshot(client: Client, message: unknown): void {
    if (!this.withinLimits(client, this.forgeWindow, FORGE_SNAPSHOT_MESSAGE, message)) return;

    const parsed = ForgeSnapshotSchema.safeParse(message);
    if (!parsed.success) {
      client.send(SERVER_MESSAGE.commandRejected, {
        type: FORGE_SNAPSHOT_MESSAGE,
        reason: "invalid_payload",
      });
      return;
    }

    // A creep is a pose update, so it produces events and can be refused for
    // moving too fast or leaving the play volume. Both have to reach the room.
    let result: CommandResult;
    try {
      result = this.sim.recordForgeSnapshot(
        client.sessionId,
        parsed.data.encodedPose,
        parsed.data.revision,
        Date.now(),
      );
    } catch (error) {
      console.error("[match-room] simulation failed on forge snapshot", error);
      client.send(SERVER_MESSAGE.commandRejected, {
        type: FORGE_SNAPSHOT_MESSAGE,
        reason: "internal_error",
      });
      return;
    }

    if (!result.accepted) this.reject(client, FORGE_SNAPSHOT_MESSAGE, result.reason, result.detail);
    this.publish(result);
  }

  /**
   * Body paint spends the same allowance the pose does, on purpose: the
   * simulation charges both to one command budget, so a client that alternated
   * the two against separate windows would buy itself twice the inbound rate.
   */
  handlePaintUpdate(client: Client, message: unknown): void {
    if (!this.withinLimits(client, this.forgeWindow, PAINT_UPDATE_MESSAGE, message)) return;

    const parsed = PaintUpdateSchema.safeParse(message);
    if (!parsed.success) {
      client.send(SERVER_MESSAGE.commandRejected, {
        type: PAINT_UPDATE_MESSAGE,
        reason: "invalid_payload",
      });
      return;
    }

    let result: CommandResult;
    try {
      result = this.sim.recordPaintUpdate(
        client.sessionId,
        parsed.data.encodedPaint,
        parsed.data.revision,
        Date.now(),
      );
    } catch (error) {
      console.error("[match-room] simulation failed on paint update", error);
      client.send(SERVER_MESSAGE.commandRejected, {
        type: PAINT_UPDATE_MESSAGE,
        reason: "internal_error",
      });
      return;
    }

    if (!result.accepted) this.reject(client, PAINT_UPDATE_MESSAGE, result.reason, result.detail);
    this.publish(result);
  }

  /** One refusal, with `detail` omitted rather than sent as an undefined. */
  private reject(client: Client, type: string, reason?: string, detail?: string): void {
    const body = reason ?? "rejected";
    client.send(
      SERVER_MESSAGE.commandRejected,
      detail === undefined ? { type, reason: body } : { type, reason: body, detail },
    );
  }

  /**
   * Size and frequency gate for anything a client sends. A refusal is reported
   * back to the sender so a client that is over its budget can back off rather
   * than guess why its commands stopped taking effect.
   */
  private withinLimits(
    client: Client,
    window: KeyedRateWindow,
    messageType: string,
    message: unknown,
  ): boolean {
    const bytes = messageByteLength(message);
    if (bytes > MAX_MESSAGE_BYTES) {
      client.send(SERVER_MESSAGE.commandRejected, { type: messageType, reason: "payload_too_large" });
      return false;
    }
    if (!window.tryConsume(client.sessionId, Date.now())) {
      client.send(SERVER_MESSAGE.commandRejected, { type: messageType, reason: "rate_limited" });
      return false;
    }
    return true;
  }

  /** One authoritative step. The simulation interval calls this. */
  step(): void {
    let output: SimOutput;
    try {
      output = this.sim.tick(Date.now());
      this.consecutiveTickFailures = 0;
    } catch (error) {
      this.consecutiveTickFailures += 1;
      console.error("[match-room] simulation failed on tick", error);
      if (this.consecutiveTickFailures >= MAX_CONSECUTIVE_TICK_FAILURES) {
        console.error("[match-room] simulation failing every tick; closing the room");
        void this.disconnect();
      }
      return;
    }
    this.publish(output);
  }

  private publish(output: SimOutput): void {
    if (output.public.length > 0) {
      this.broadcast(SERVER_MESSAGE.simEvents, output.public);
    }
    for (const client of this.clients) {
      const events = output.private.get(client.sessionId);
      if (!events || events.length === 0) continue;
      client.send(SERVER_MESSAGE.privateEvents, events);
      // A private event always changes the recipient's own view, so the fresh
      // slice follows it rather than waiting for the next phase change.
      this.sendPrivateState(client);
    }
    if (output.public.some((event) => event.type === "phase_changed")) {
      for (const client of this.clients) this.sendPrivateState(client);
    }
    this.syncSchema();
  }

  private sendPrivateState(client: Client): void {
    const privateState = this.sim.getPrivateStateFor(client.sessionId);
    if (privateState) client.send(SERVER_MESSAGE.privateState, privateState);
  }

  private syncSchema(): void {
    const publicState = this.sim.getPublicState();
    this.state.phase = publicState.phase;
    this.state.phaseEndsAt = publicState.phaseEndsAt;
    this.state.round = publicState.round;

    const live = new Set<string>();
    for (const view of publicState.players) {
      live.add(view.publicPlayerId);
      const entry = this.state.players.get(view.publicPlayerId) ?? new PublicPlayerState();
      entry.publicId = view.publicPlayerId;
      entry.displayName = view.displayName;
      entry.rolePublicState = view.rolePublicState;
      entry.lifeState = view.lifeState;
      entry.isHost = view.isHost;
      entry.ready = view.ready;
      entry.connected = view.connected;
      this.state.players.set(view.publicPlayerId, entry);
    }
    for (const publicId of [...this.state.players.keys()]) {
      if (!live.has(publicId)) this.state.players.delete(publicId);
    }
  }
}
