import { MatchSimulation } from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, derivedSeatId, MatchPhase } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import {
  SERVER_DEBUG_KEY,
  SERVER_HELLO_KEY,
  SERVER_PROTOCOL_VERSION,
  SERVER_STATE_KEY,
} from "../src/protocol";
import { PortalsServerRuntime, type ServerGlobal, type ServerPlayer } from "../src/runtime";

/**
 * The authority, driven against a fake sandbox.
 *
 * The runtime takes its host as a parameter precisely so this is possible:
 * every rule below is the one that will run inside Portals, exercised without
 * a browser, a relay, or a session.
 */

class FakeHost implements ServerGlobal {
  readonly sent: unknown[] = [];
  readonly state = new Map<string, unknown>();
  readonly logs: unknown[][] = [];
  readonly kicked: string[] = [];
  private roster: ServerPlayer[] = [];
  private readonly handlers = new Map<string, ((...args: never[]) => void)[]>();
  private nextTimer = 1;
  /** The callback the runtime installed on setInterval, so tests can pump it. */
  interval: (() => void) | null = null;

  on(event: string, handler: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (...values: unknown[]) => void)(...args);
    }
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  setState(key: string, value: unknown): void {
    this.state.set(key, value);
  }

  getState(key?: string): unknown {
    return key === undefined ? Object.fromEntries(this.state) : this.state.get(key);
  }

  players(): readonly ServerPlayer[] {
    return this.roster;
  }

  kick(sessionId: string): void {
    this.kicked.push(sessionId);
  }

  setTimeout(): number {
    return this.nextTimer++;
  }

  setInterval(callback: () => void): number {
    this.interval = callback;
    return this.nextTimer++;
  }

  clearTimer(): void {
    this.interval = null;
  }

  log(...values: unknown[]): void {
    this.logs.push(values);
  }

  /** Seats a player the way the relay would, roster first then the event. */
  arrive(player: ServerPlayer): void {
    this.roster = [...this.roster, player];
    this.emit("playerjoin", player, this.roster);
  }

  depart(id: string): void {
    const player = this.roster.find((entry) => entry.id === id);
    this.roster = this.roster.filter((entry) => entry.id !== id);
    if (player !== undefined) this.emit("playerleave", player, this.roster);
  }

  message(data: unknown, fromId: string): void {
    this.emit("message", data, fromId);
  }

  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && (entry as { t?: string }).t === type,
    );
  }
}

function startRuntime(): { host: FakeHost; runtime: PortalsServerRuntime; sim: MatchSimulation } {
  const host = new FakeHost();
  const sim = new MatchSimulation({}, 7);
  const runtime = new PortalsServerRuntime(host, sim, {
    tickMs: 50,
    stateEveryTicks: 4,
    protocolVersion: SERVER_PROTOCOL_VERSION,
    onEye: () => undefined,
    onPlacements: () => undefined,
  });
  runtime.start();
  return { host, runtime, sim };
}

const command = (cmd: unknown): unknown => ({ v: SERVER_PROTOCOL_VERSION, t: "cmd", cmd });

describe("the authoritative server script", () => {
  it("announces itself on a protected key the moment a session opens", () => {
    const { host } = startRuntime();
    expect(host.state.get(SERVER_HELLO_KEY)).toMatchObject({ v: SERVER_PROTOCOL_VERSION });
    // The key is server-owned; that prefix is the whole reason a client cannot
    // forge authority once this ships.
    expect(SERVER_HELLO_KEY.startsWith("server:")).toBe(true);
    expect(SERVER_STATE_KEY.startsWith("server:")).toBe(true);
  });

  it("seats arrivals and publishes the roster as authoritative state", () => {
    const { host, runtime } = startRuntime();
    host.arrive({ id: "seat-a", displayName: "Ada" });
    host.arrive({ id: "seat-b", displayName: "Bex" });
    runtime.tick();

    const state = host.state.get(SERVER_STATE_KEY) as { players: { displayName: string }[] };
    expect(state.players.map((player) => player.displayName).sort()).toEqual(["Ada", "Bex"]);
  });

  it("runs a real round: ready, start, and the phase machine moving on its own", () => {
    const { host, runtime } = startRuntime();
    host.arrive({ id: "seat-a", displayName: "Ada" });
    host.arrive({ id: "seat-b", displayName: "Bex" });

    host.message(command({ type: "player_ready", ready: true }), "seat-a");
    host.message(command({ type: "player_ready", ready: true }), "seat-b");
    host.message(command({ type: "start_match" }), "seat-a");

    // Drive the session clock the way the sandbox interval would. Loading
    // holds until every seat reports in or its 20 s timeout expires, so the
    // round only deals roles once the clock has passed it - which is itself
    // worth pinning: a client that never reports must not wedge a session.
    for (let i = 0; i < 500; i += 1) runtime.tick();

    const state = host.state.get(SERVER_STATE_KEY) as { phase: MatchPhase };
    expect(state.phase).not.toBe(MatchPhase.Lobby);
    expect(state.phase).not.toBe(MatchPhase.Loading);
    // Roles are dealt by the server, and reach their owner as a private batch
    // stamped with the seat it belongs to.
    const events = host.sentOfType("ev");
    const privateSeats = events.flatMap((entry) =>
      (entry.private as [string, unknown[]][]).map(([seat]) => seat),
    );
    expect(new Set(privateSeats)).toEqual(new Set(["seat-a", "seat-b"]));
  });

  it("refuses a command the simulation rejects, and says so only to its sender", () => {
    const { host } = startRuntime();
    host.arrive({ id: "seat-a", displayName: "Ada" });
    // Nobody is ready, so starting is illegal.
    host.message(command({ type: "start_match" }), "seat-a");

    const refusals = host.sentOfType("rejected");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ to: "seat-a" });
    expect(typeof refusals[0]?.reason).toBe("string");
  });

  it("ignores traffic from another protocol version rather than trusting it", () => {
    const { host } = startRuntime();
    host.arrive({ id: "seat-a", displayName: "Ada" });
    const before = host.sent.length;
    host.message({ v: SERVER_PROTOCOL_VERSION + 1, t: "cmd", cmd: { type: "start_match" } }, "seat-a");
    host.message("not an envelope at all", "seat-a");
    expect(host.sent.length).toBe(before);
  });

  it("answers a resync with the asking seat's own private state", () => {
    const { host } = startRuntime();
    host.arrive({ id: "seat-a", displayName: "Ada" });
    host.message({ v: SERVER_PROTOCOL_VERSION, t: "resync" }, "seat-a");

    const syncs = host.sentOfType("sync");
    expect(syncs.at(-1)).toMatchObject({ to: "seat-a" });
    expect(syncs.at(-1)?.publicState).toBeDefined();
  });

  it("holds a leaver's seat through the grace, then lets the simulation evict it", () => {
    const { host, runtime } = startRuntime();
    host.arrive({ id: "seat-a", displayName: "Ada" });
    host.arrive({ id: "seat-b", displayName: "Bex" });
    host.depart("seat-b");
    runtime.tick();

    const held = host.state.get(SERVER_STATE_KEY) as {
      players: { displayName: string; connected: boolean }[];
    };
    // Still at the table, just not answering: a player who closes the tab
    // mid-round has a window to come back to their own disguise.
    expect(held.players.map((player) => player.displayName).sort()).toEqual(["Ada", "Bex"]);
    expect(held.players.find((player) => player.displayName === "Bex")?.connected).toBe(false);

    // Past the reconnect grace the simulation evicts the seat on its own; the
    // runtime never removes a player itself.
    const graceTicks = Math.ceil(DEFAULT_MATCH_SETTINGS.reconnectGraceMs / 50) + 4;
    for (let i = 0; i < graceTicks; i += 1) runtime.tick();

    const state = host.state.get(SERVER_STATE_KEY) as { players: { displayName: string }[] };
    expect(state.players.map((player) => player.displayName)).toEqual(["Ada"]);
  });

  it("seats a signed-in player by account, so a dropped connection keeps the round", () => {
    const { host, runtime, sim } = startRuntime();
    host.arrive({ id: "conn-1", playerId: "account-ada", displayName: "Ada" });
    host.arrive({ id: "conn-2", playerId: "account-bex", displayName: "Bex" });
    host.message(command({ type: "player_ready", ready: true }), "conn-1");
    host.message(command({ type: "player_ready", ready: true }), "conn-2");
    host.message(command({ type: "start_match" }), "conn-1");
    for (let i = 0; i < 500; i += 1) runtime.tick();

    const before = sim.getPrivateStateFor("account-ada");
    expect(before).not.toBeNull();

    // Ada closes the tab and reopens it. Portals gives her a new connection,
    // and the only thing that survives that is her account id.
    host.depart("conn-1");
    runtime.tick();
    host.arrive({ id: "conn-3", playerId: "account-ada", displayName: "Ada" });

    const sync = host.sentOfType("sync").at(-1);
    expect(sync).toMatchObject({ to: "conn-3", seat: "account-ada" });
    // The same seat, still holding the role it was dealt before the drop.
    expect(sim.getPrivateStateFor("account-ada")).not.toBeNull();
    const players = (host.state.get(SERVER_STATE_KEY) as { players: unknown[] }).players;
    expect(players).toHaveLength(2);
  });

  it("gives one account's second connection a seat of its own", () => {
    const { host, runtime } = startRuntime();
    host.arrive({ id: "conn-1", playerId: "account-ada", displayName: "Ada" });
    host.arrive({ id: "conn-2", playerId: "account-ada", displayName: "Ada" });
    runtime.tick();

    const seats = host.sentOfType("sync").map((entry) => entry.seat);
    expect(seats).toEqual(["account-ada", derivedSeatId("account-ada", "conn-2")]);
    const players = (host.state.get(SERVER_STATE_KEY) as { players: unknown[] }).players;
    expect(players).toHaveLength(2);
  });

  it("acts on the seat the relay stamped, never one a message claims", () => {
    const { host } = startRuntime();
    host.arrive({ id: "conn-1", playerId: "account-ada", displayName: "Ada" });
    // A message from a connection the server never seated is not a player.
    const before = host.sent.length;
    host.message(command({ type: "player_ready", ready: true }), "conn-unknown");
    expect(host.sent.length).toBe(before);
  });

  it("publishes its diagnostics as state, because server.log goes nowhere", () => {
    const { host } = startRuntime();
    const sim = new MatchSimulation({ maxPlayers: 2 }, 7);
    const small = new PortalsServerRuntime(host, sim, {
      tickMs: 50,
      stateEveryTicks: 4,
      protocolVersion: SERVER_PROTOCOL_VERSION,
      onEye: () => undefined,
      onPlacements: () => undefined,
    });
    small.start();
    for (const id of ["c1", "c2", "c3"]) host.arrive({ id, displayName: id });

    const debug = host.state.get(SERVER_DEBUG_KEY) as { note: string } | undefined;
    expect(debug?.note).toContain("room_full");
  });

  it("keeps its own clock rather than trusting the sandbox for time", () => {
    const { host, runtime } = startRuntime();
    host.arrive({ id: "seat-a", displayName: "Ada" });
    for (let i = 0; i < 8; i += 1) runtime.tick();
    const state = host.state.get(SERVER_STATE_KEY) as { now: number };
    // Eight ticks of the 50 ms interval, counted by the runtime itself.
    expect(state.now).toBe(400);
  });
});
