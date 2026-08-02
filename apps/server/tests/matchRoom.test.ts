import type { Client } from "@colyseus/core";
import type { MatchSettingsPatch, PrivateSimEvent, SimEvent } from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, MatchPhase } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import {
  MatchRoom,
  SERVER_MESSAGE,
  FORGE_SNAPSHOT_MESSAGE,
  MAX_CONSECUTIVE_TICK_FAILURES,
  PAINT_UPDATE_MESSAGE,
} from "../src/rooms/MatchRoom";
import { MAX_COMMANDS_PER_SECOND, MAX_MESSAGE_BYTES } from "../src/rooms/messageGuards";

/**
 * The room is exercised directly rather than through a booted Colyseus server:
 * everything under test is the wiring between validated messages, the
 * simulation, and the outbound routing, none of which needs a transport.
 */

interface SentMessage {
  readonly sessionId: string;
  readonly type: string;
  readonly payload: unknown;
}

class TestClient {
  readonly sent: SentMessage[] = [];

  constructor(
    readonly sessionId: string,
    private readonly log: SentMessage[],
  ) {}

  send(type: string | number, payload?: unknown): void {
    const entry = { sessionId: this.sessionId, type: String(type), payload };
    this.sent.push(entry);
    this.log.push(entry);
  }

  messagesOfType(type: string): unknown[] {
    return this.sent.filter((entry) => entry.type === type).map((entry) => entry.payload);
  }

  asClient(): Client {
    return this as unknown as Client;
  }
}

class TestRoom {
  readonly room = new MatchRoom();
  readonly broadcasts: SentMessage[] = [];
  readonly directed: SentMessage[] = [];
  readonly clients: TestClient[] = [];

  private now = 1_700_000_000_000;

  constructor(settings: MatchSettingsPatch = {}) {
    // The simulation interval and the schema patcher belong to a running
    // server; the test drives step() itself.
    this.room.setSimulationInterval = () => undefined;
    this.room.broadcast = (type: string | number, payload?: unknown): void => {
      this.broadcasts.push({ sessionId: "*", type: String(type), payload });
    };
    this.room.onCreate({ settings: { ...FAST_SETTINGS, ...settings }, seed: 9 });
  }

  join(sessionId: string, displayName: string): TestClient {
    const client = new TestClient(sessionId, this.directed);
    this.clients.push(client);
    (this.room.clients as unknown as TestClient[]).push(client);
    this.room.onJoin(client.asClient(), { displayName });
    return client;
  }

  client(sessionId: string): TestClient {
    const found = this.clients.find((entry) => entry.sessionId === sessionId);
    if (!found) throw new Error(`no client ${sessionId}`);
    return found;
  }

  advance(steps = 1, stepMs = 100): void {
    for (let index = 0; index < steps; index += 1) {
      this.now += stepMs;
      dateNow(this.now, () => {
        this.room.step();
      });
    }
  }

  broadcastEvents(): SimEvent[] {
    return this.broadcasts
      .filter((entry) => entry.type === SERVER_MESSAGE.simEvents)
      .flatMap((entry) => entry.payload as SimEvent[]);
  }
}

const FAST_SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 600,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
};

/** Runs `body` with Date.now() pinned, since the room reads the wall clock. */
function dateNow<T>(value: number, body: () => T): T {
  const original = Date.now;
  Date.now = () => value;
  try {
    return body();
  } finally {
    Date.now = original;
  }
}

describe("MatchRoom payload validation", () => {
  it("rejects malformed commands without touching the simulation", () => {
    const harness = new TestRoom();
    const client = harness.join("s1", "Ada");
    const phaseBefore = harness.room.state.phase;

    const malformed: unknown[] = [
      undefined,
      null,
      "player_ready",
      { type: "player_ready" },
      { type: "player_ready", ready: "yes" },
      { type: "player_ready", ready: true, extra: 1 },
      { type: "not_a_command" },
      { type: "accuse" },
      { type: "accuse", targetObjectId: "" },
      { type: "lock_disguise", payload: "pose", revision: -1 },
      { type: "lock_disguise", payload: "pose", revision: 1.5 },
      { type: "set_settings", settings: { forgeMs: Number.NaN } },
      { type: "set_settings", settings: { unknownKey: 1 } },
      { type: "vote_rematch", yes: 1 },
    ];

    for (const message of malformed) {
      harness.room.handleMatchCommand(client.asClient(), "player_ready", message);
    }

    const rejections = client.messagesOfType(SERVER_MESSAGE.commandRejected);
    expect(rejections).toHaveLength(malformed.length);
    expect(harness.room.state.phase).toBe(phaseBefore);
    expect(harness.room.state.players.get("s1")).toBeUndefined();
  });

  it("rejects a well formed command that arrives on the wrong message channel", () => {
    const harness = new TestRoom();
    const client = harness.join("s1", "Ada");

    harness.room.handleMatchCommand(client.asClient(), "start_match", {
      type: "player_ready",
      ready: true,
    });

    expect(client.messagesOfType(SERVER_MESSAGE.commandRejected)).toEqual([
      { type: "start_match", reason: "type_mismatch" },
    ]);
  });

  it("reports the simulation's own refusal reason back to the sender", () => {
    const harness = new TestRoom();
    const host = harness.join("s1", "Ada");
    harness.join("s2", "Bex");

    harness.room.handleMatchCommand(host.asClient(), "start_match", { type: "start_match" });

    // No `detail` key at all, rather than an undefined one: msgpack turns an
    // undefined value into null, which the client's strict schema refuses.
    const rejections = host.messagesOfType(SERVER_MESSAGE.commandRejected);
    expect(rejections).toEqual([{ type: "start_match", reason: "players_not_ready" }]);
    expect(Object.keys(rejections[0] as object)).not.toContain("detail");
  });

  it("rejects a malformed forge snapshot", () => {
    const harness = new TestRoom();
    const client = harness.join("s1", "Ada");

    harness.room.handleForgeSnapshot(client.asClient(), { revision: "one", encodedPose: "p" });

    expect(client.messagesOfType(SERVER_MESSAGE.commandRejected)).toEqual([
      { type: FORGE_SNAPSHOT_MESSAGE, reason: "invalid_payload" },
    ]);
  });

  it("rejects a malformed paint update", () => {
    const harness = new TestRoom();
    const client = harness.join("s1", "Ada");

    harness.room.handlePaintUpdate(client.asClient(), { revision: 1, encodedPaint: 7 });

    expect(client.messagesOfType(SERVER_MESSAGE.commandRejected)).toEqual([
      { type: PAINT_UPDATE_MESSAGE, reason: "invalid_payload" },
    ]);
  });
});

describe("MatchRoom wire limits", () => {
  it("refuses a message larger than the per-message cap", () => {
    const harness = new TestRoom();
    const client = harness.join("s1", "Ada");

    harness.room.handleMatchCommand(client.asClient(), "lock_disguise", {
      type: "lock_disguise",
      payload: "x".repeat(MAX_MESSAGE_BYTES),
      revision: 1,
    });

    expect(client.messagesOfType(SERVER_MESSAGE.commandRejected)).toEqual([
      { type: "lock_disguise", reason: "payload_too_large" },
    ]);
  });

  it("rate limits one client without touching another", () => {
    const harness = new TestRoom();
    const flooder = harness.join("s1", "Ada");
    const quiet = harness.join("s2", "Bex");

    const attempts = MAX_COMMANDS_PER_SECOND + 10;
    for (let index = 0; index < attempts; index += 1) {
      harness.room.handleMatchCommand(flooder.asClient(), "player_ready", {
        type: "player_ready",
        ready: index % 2 === 0,
      });
    }
    harness.room.handleMatchCommand(quiet.asClient(), "player_ready", {
      type: "player_ready",
      ready: true,
    });

    const limited = flooder
      .messagesOfType(SERVER_MESSAGE.commandRejected)
      .filter((entry) => (entry as { reason: string }).reason === "rate_limited");
    expect(limited).toHaveLength(attempts - MAX_COMMANDS_PER_SECOND);
    expect(quiet.messagesOfType(SERVER_MESSAGE.commandRejected)).toEqual([]);
    expect(
      [...harness.room.state.players.values()].some(
        (player) => player.displayName === "Bex" && player.ready,
      ),
    ).toBe(true);
  });

  it("caps forge snapshots at the configured forge command rate", () => {
    const harness = new TestRoom();
    const client = harness.join("s1", "Ada");

    const attempts = DEFAULT_MATCH_SETTINGS.maxForgeCommandHz + 5;
    for (let index = 0; index < attempts; index += 1) {
      harness.room.handleForgeSnapshot(client.asClient(), { revision: index, encodedPose: "" });
    }

    const limited = client
      .messagesOfType(SERVER_MESSAGE.commandRejected)
      .filter((entry) => (entry as { reason: string }).reason === "rate_limited");
    expect(limited).toHaveLength(5);
  });

  it("refuses a seat once the room is full and reports the reason", () => {
    const harness = new TestRoom({ maxPlayers: 2 });
    harness.join("s1", "Ada");
    harness.join("s2", "Bex");

    expect(() => harness.join("s3", "Cora")).toThrow("room_full");
    expect(harness.room.state.players.size).toBe(2);
    expect(harness.room.maxClients).toBe(2);
  });
});

describe("MatchRoom live hider contract", () => {
  it("accepts a taunt on its own message channel and validates the id", () => {
    const harness = new TestRoom();
    const client = harness.join("s1", "Ada");

    // The channel exists: a well formed taunt is refused by the simulation for
    // the phase, not rejected by the room as an unknown message or bad payload.
    harness.room.handleMatchCommand(client.asClient(), "taunt", {
      type: "taunt",
      tauntId: "rattle",
    });
    expect(client.messagesOfType(SERVER_MESSAGE.commandRejected)).toEqual([
      { type: "taunt", reason: "wrong_phase" },
    ]);

    harness.room.handleMatchCommand(client.asClient(), "taunt", {
      type: "taunt",
      tauntId: "not_a_taunt",
    });
    expect(client.messagesOfType(SERVER_MESSAGE.commandRejected).at(-1)).toEqual({
      type: "taunt",
      reason: "invalid_payload",
    });
  });

  it("returns a refused forge snapshot to the sender rather than dropping it", () => {
    const harness = new TestRoom();
    const client = harness.join("s1", "Ada");

    // Schema-valid, but not a pose the canonical wire format can decode.
    harness.room.handleForgeSnapshot(client.asClient(), {
      revision: 3,
      encodedPose: "not a pose",
    });

    const rejections = client.messagesOfType(SERVER_MESSAGE.commandRejected);
    expect(rejections).toHaveLength(1);
    const only = rejections[0] as { type: string; reason: string };
    expect(only.type).toBe(FORGE_SNAPSHOT_MESSAGE);
    // The simulation's own reason travels, not a generic failure.
    expect(["wrong_phase", "wrong_role", "invalid_pose"]).toContain(only.reason);
  });

  it("returns a refused paint update to the sender rather than dropping it", () => {
    const harness = new TestRoom();
    const client = harness.join("s1", "Ada");

    // Schema-valid, but not a layer the paint wire can decode.
    harness.room.handlePaintUpdate(client.asClient(), {
      revision: 3,
      encodedPaint: "not base64 at all!",
    });

    const rejections = client.messagesOfType(SERVER_MESSAGE.commandRejected);
    expect(rejections).toHaveLength(1);
    const only = rejections[0] as { type: string; reason: string };
    expect(only.type).toBe(PAINT_UPDATE_MESSAGE);
    expect(["wrong_phase", "wrong_role", "invalid_paint"]).toContain(only.reason);
  });

  it("charges paint and poses to one forge budget so alternating buys no rate", () => {
    const harness = new TestRoom();
    const client = harness.join("s1", "Ada");

    // Alternating the two message channels must not double the allowance: the
    // room shares one window, matching the simulation's own shared budget.
    const attempts = DEFAULT_MATCH_SETTINGS.maxForgeCommandHz + 5;
    for (let index = 0; index < attempts; index += 1) {
      if (index % 2 === 0) {
        harness.room.handleForgeSnapshot(client.asClient(), { revision: index, encodedPose: "" });
      } else {
        harness.room.handlePaintUpdate(client.asClient(), { revision: index, encodedPaint: "" });
      }
    }

    const limited = client
      .messagesOfType(SERVER_MESSAGE.commandRejected)
      .filter((entry) => (entry as { reason: string }).reason === "rate_limited");
    expect(limited).toHaveLength(5);
  });
});

describe("MatchRoom simulation wiring", () => {
  it("feeds accepted commands to the simulation and mirrors them into the schema", () => {
    const harness = new TestRoom();
    const host = harness.join("s1", "Ada");
    harness.join("s2", "Bex");

    harness.room.handleMatchCommand(host.asClient(), "player_ready", {
      type: "player_ready",
      ready: true,
    });

    expect(host.messagesOfType(SERVER_MESSAGE.commandRejected)).toEqual([]);
    const ready = [...harness.room.state.players.values()].filter((player) => player.ready);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.displayName).toBe("Ada");
    expect(
      harness.broadcastEvents().some((event) => event.type === "player_ready_changed"),
    ).toBe(true);
  });

  it("runs a round from the tick and keeps every role off the broadcast", () => {
    const harness = new TestRoom();
    const host = harness.join("s1", "Ada");
    const guest = harness.join("s2", "Bex");

    for (const client of [host, guest]) {
      harness.room.handleMatchCommand(client.asClient(), "player_ready", {
        type: "player_ready",
        ready: true,
      });
    }
    harness.room.handleMatchCommand(host.asClient(), "start_match", { type: "start_match" });
    for (const client of [host, guest]) {
      harness.room.handleMatchCommand(client.asClient(), "player_ready", {
        type: "player_ready",
        ready: true,
      });
    }
    harness.advance(12);

    expect(harness.room.state.phase).not.toBe(MatchPhase.Lobby);

    // The broadcast announcement names the Inspectors and counts the Mimics.
    // Who the Mimics are only ever reaches each player's own private stream.
    const announcements = harness
      .broadcastEvents()
      .filter((event) => event.type === "roles_assigned");
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.type === "roles_assigned" && announcements[0].mimicCount)
      .toBeGreaterThan(0);

    for (const client of [host, guest]) {
      const batches = client.messagesOfType(SERVER_MESSAGE.privateEvents) as PrivateSimEvent[][];
      const roles = batches.flat().filter((event) => event.type === "role_assigned");
      expect(roles).toHaveLength(1);
      const privateStates = client.messagesOfType(SERVER_MESSAGE.privateState);
      const latest = privateStates.at(-1) as { role: string; publicPlayerId: string };
      expect(roles[0]?.type === "role_assigned" && roles[0].role).toBe(latest.role);
      expect(roles[0]?.type === "role_assigned" && roles[0].publicPlayerId).toBe(
        latest.publicPlayerId,
      );
    }
  });

  it("never puts a session id or a role into the synchronized schema", () => {
    const harness = new TestRoom();
    const host = harness.join("s1", "Ada");
    const guest = harness.join("s2", "Bex");

    for (const client of [host, guest]) {
      harness.room.handleMatchCommand(client.asClient(), "player_ready", {
        type: "player_ready",
        ready: true,
      });
    }
    harness.room.handleMatchCommand(host.asClient(), "start_match", { type: "start_match" });
    for (const client of [host, guest]) {
      harness.room.handleMatchCommand(client.asClient(), "player_ready", {
        type: "player_ready",
        ready: true,
      });
    }
    harness.advance(12);

    const keys = [...harness.room.state.players.keys()];
    expect(keys).not.toContain("s1");
    expect(keys).not.toContain("s2");
    expect(keys.every((key) => key.startsWith("p_"))).toBe(true);
    for (const player of harness.room.state.players.values()) {
      expect(["unknown", "inspector"]).toContain(player.rolePublicState);
    }
  });

  it("sends each player a private state carrying only their own view", () => {
    const harness = new TestRoom();
    const host = harness.join("s1", "Ada");
    const guest = harness.join("s2", "Bex");

    for (const client of [host, guest]) {
      const states = client.messagesOfType(SERVER_MESSAGE.privateState);
      expect(states.length).toBeGreaterThan(0);
      for (const state of states) {
        expect((state as { playerId: string }).playerId).toBe(client.sessionId);
      }
    }
  });

  it("drops a player who leaves deliberately", () => {
    const harness = new TestRoom();
    const host = harness.join("s1", "Ada");
    harness.join("s2", "Bex");
    expect(harness.room.state.players.size).toBe(2);

    void harness.room.onLeave(host.asClient(), true);
    expect(harness.room.state.players.size).toBe(1);
  });
});

describe("MatchRoom tick fault handling", () => {
  interface FaultHarness {
    readonly harness: TestRoom;
    disconnects: number;
    failNext(times: number): void;
  }

  /** Wraps the room's sim so the next N ticks throw, and counts disconnects. */
  function faultHarness(): FaultHarness {
    const harness = new TestRoom();
    const sim = (harness.room as unknown as { sim: { tick(now: number): unknown } }).sim;
    const realTick = sim.tick.bind(sim);
    const pending = { remaining: 0 };
    sim.tick = (now: number) => {
      if (pending.remaining > 0) {
        pending.remaining -= 1;
        throw new Error("forced tick failure");
      }
      return realTick(now);
    };
    const fault: FaultHarness = {
      harness,
      disconnects: 0,
      failNext: (times) => {
        pending.remaining = times;
      },
    };
    harness.room.disconnect = (() => {
      fault.disconnects += 1;
      return Promise.resolve([]);
    }) as unknown as typeof harness.room.disconnect;
    return fault;
  }

  it("absorbs transient failures below the closure threshold", () => {
    const fault = faultHarness();
    fault.harness.join("s1", "Ada");
    fault.failNext(MAX_CONSECUTIVE_TICK_FAILURES - 1);
    fault.harness.advance(MAX_CONSECUTIVE_TICK_FAILURES + 2);
    expect(fault.disconnects).toBe(0);
  });

  it("closes the room after repeated consecutive failures instead of freezing silently", () => {
    const fault = faultHarness();
    fault.harness.join("s1", "Ada");
    fault.failNext(MAX_CONSECUTIVE_TICK_FAILURES);
    fault.harness.advance(MAX_CONSECUTIVE_TICK_FAILURES);
    expect(fault.disconnects).toBe(1);
  });

  it("resets the consecutive count on a successful tick", () => {
    const fault = faultHarness();
    fault.harness.join("s1", "Ada");
    fault.failNext(MAX_CONSECUTIVE_TICK_FAILURES - 1);
    fault.harness.advance(MAX_CONSECUTIVE_TICK_FAILURES - 1);
    fault.harness.advance(1);
    fault.failNext(MAX_CONSECUTIVE_TICK_FAILURES - 1);
    fault.harness.advance(MAX_CONSECUTIVE_TICK_FAILURES - 1);
    expect(fault.disconnects).toBe(0);
  });
});
