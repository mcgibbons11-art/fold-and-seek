import {
  encodeStateChunks,
  SERVER_HELLO_KEY,
  SERVER_PROTOCOL_VERSION,
  SERVER_STATE_KEYS,
} from "@foldseek/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MatchSimulation } from "@foldseek/game-sim";

import { PortalsNetAdapter } from "../../src/networking/PortalsNetAdapter";
import { REFEREE_SILENCE_MS } from "../../src/networking/refereeLink";
import { FakePortalsRelay } from "./fakePortals";

/**
 * The authoritative server script, seen from the client.
 *
 * Portals runs `server.js` as an invisible participant that owns every
 * `server:` key and holds the only simulation. What matters here is the
 * handover in both directions: while it is present no client may run a
 * simulation of its own, and when it goes quiet the game must carry on rather
 * than freeze, because a crashed server does not end a Portals session and
 * disconnects nobody.
 */

const CHANNEL = "referee-test";
/** Not a seat: the server is never in the roster, which is how clients know it. */
const REFEREE_ID = "portals-server";

function hello(epoch = 1): { v: number; epoch: number } {
  return { v: SERVER_PROTOCOL_VERSION, epoch };
}

/**
 * A real simulation, used as the source of every payload below.
 *
 * The referee runs this exact class, so taking states and events from it is
 * both more faithful than hand-written fixtures and immune to drifting out of
 * step with the schemas that validate them on arrival.
 */
function simulation(): MatchSimulation {
  const sim = new MatchSimulation({}, 5);
  for (const seat of ["seat-a", "seat-b"]) {
    sim.addPlayer(seat, { displayName: seat });
    sim.handleCommand(seat, { type: "player_ready", ready: true });
  }
  return sim;
}

/** Drives a simulation to the phase where roles have been dealt. */
function dealtRoles(sim: MatchSimulation): Map<string, unknown[]> {
  sim.handleCommand("seat-a", { type: "start_match" });
  const privateBySeat = new Map<string, unknown[]>();
  let now = 0;
  for (let i = 0; i < 700; i += 1) {
    now += 50;
    const output = sim.tick(now);
    for (const [seat, events] of output.private) {
      if (events.length === 0) continue;
      privateBySeat.set(seat, [...(privateBySeat.get(seat) ?? []), ...events]);
    }
  }
  return privateBySeat;
}

let clock = 0;

async function connected(relay: FakePortalsRelay, id: string): Promise<PortalsNetAdapter> {
  const adapter = new PortalsNetAdapter(
    relay.createPeer({ id, displayName: `Visitor ${id}` }),
    { seed: 5, now: () => clock, joinRetryDelayMs: 0 },
  );
  await adapter.connect();
  await adapter.join(CHANNEL, `Visitor ${id}`);
  return adapter;
}

/** Advances both the relay's fake timers and the adapter's injected clock. */
async function elapse(ms: number): Promise<void> {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

describe("a session with an authoritative server", () => {
  let relay: FakePortalsRelay;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    relay = new FakePortalsRelay();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stands down from host election the moment a referee announces itself", async () => {
    const adapter = await connected(relay, "a");
    // Alone in the session, this client would ordinarily elect itself.
    relay.write(SERVER_HELLO_KEY, hello());
    await elapse(50);

    expect(adapter.hasReferee()).toBe(true);
    expect(adapter.isAuthority()).toBe(false);
    expect(adapter.getConnection().authorityId).toBeNull();
    adapter.dispose();
  });

  it("reads the authoritative state out of the protected key range", async () => {
    const adapter = await connected(relay, "a");
    relay.write(SERVER_HELLO_KEY, hello());

    const sim = simulation();
    dealtRoles(sim);
    const state = sim.getPublicState();
    const chunks = encodeStateChunks(state, 1, SERVER_STATE_KEYS.length);
    expect(chunks).not.toBeNull();
    for (const chunk of chunks ?? []) {
      const key = SERVER_STATE_KEYS[chunk.i];
      if (key !== undefined) relay.write(key, chunk);
    }
    await elapse(50);

    expect(adapter.getSync().publicState?.phase).toBe(state.phase);
    expect(adapter.getSync().publicState?.players).toHaveLength(2);
    adapter.dispose();
  });

  it("takes a private batch addressed to its own seat and ignores another's", async () => {
    const adapter = await connected(relay, "a");
    relay.write(SERVER_HELLO_KEY, hello());
    await elapse(50);

    // The referee tells this connection which seat it holds.
    const sim = simulation();
    const dealt = dealtRoles(sim);
    relay.injectRaw(REFEREE_ID, {
      v: SERVER_PROTOCOL_VERSION,
      t: "sync",
      to: "a",
      seat: "seat-a",
      publicState: sim.getPublicState(),
      privateState: sim.getPrivateStateFor("seat-a"),
    });
    await elapse(10);

    const mine: unknown[] = [];
    adapter.onPrivateEvent((event) => mine.push(event));
    const forA = dealt.get("seat-a") ?? [];
    const forB = dealt.get("seat-b") ?? [];
    expect(forA.length).toBeGreaterThan(0);
    expect(forB.length).toBeGreaterThan(0);
    relay.injectRaw(REFEREE_ID, {
      v: SERVER_PROTOCOL_VERSION,
      t: "ev",
      public: [],
      private: [
        ["seat-b", forB],
        ["seat-a", forA],
      ],
    });
    await elapse(10);

    // Private batches are broadcast with the seat they belong to, because the
    // relay has no addressed send. Another seat's batch is not ours to read.
    expect(mine).toHaveLength(forA.length);
    adapter.dispose();
  });

  it("refuses a referee message that came from a seated player", async () => {
    const host = await connected(relay, "a");
    const peer = await connected(relay, "b");
    relay.write(SERVER_HELLO_KEY, hello());
    await elapse(50);

    const seen: unknown[] = [];
    host.onEvent((event) => seen.push(event));
    // "b" is in the roster, so it cannot be the referee however it dresses up.
    relay.injectRaw("b", {
      v: SERVER_PROTOCOL_VERSION,
      t: "ev",
      public: [{ type: "phase_changed", phase: "results", round: 0 }],
      private: [],
    });
    await elapse(10);

    expect(seen).toHaveLength(0);
    host.dispose();
    peer.dispose();
  });

  it("falls back to an elected host when the referee goes quiet", async () => {
    const adapter = await connected(relay, "a");
    relay.write(SERVER_HELLO_KEY, hello());
    await elapse(50);
    expect(adapter.hasReferee()).toBe(true);

    // A crashed or over-budget server script does not end the session and
    // disconnects nobody, so silence has to be survivable rather than fatal.
    await elapse(REFEREE_SILENCE_MS + 1_000);

    expect(adapter.hasReferee()).toBe(false);
    adapter.dispose();
  });

  it("ignores a referee speaking a protocol this build cannot read", async () => {
    const adapter = await connected(relay, "a");
    relay.write(SERVER_HELLO_KEY, { v: SERVER_PROTOCOL_VERSION + 1, epoch: 1 });
    await elapse(50);

    // Being ruled by an authority whose verdicts are unreadable is worse than
    // having none, so the game plays on without it.
    expect(adapter.hasReferee()).toBe(false);
    adapter.dispose();
  });
});
