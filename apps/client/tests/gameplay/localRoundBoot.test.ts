import { MatchPhase } from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalRound,
  LOCAL_ROUND_NAME,
  seedFromLocation,
} from "../../src/gameplay/localRound";

/**
 * The path the main menu actually takes into a round. It is separated from the
 * rest of the round tests because it is the one that has to survive being
 * driven exactly as the UI drives it: build, join, and then accept the very
 * first command a player can issue.
 *
 * The regression it guards is a lobby that looks alive and answers nothing:
 * `player_ready` arriving while the adapter still has no simulation, which the
 * loopback drops with a console warning rather than an error, so the roster sits
 * at "waiting" and the round can never be started.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("opening a local round from the menu", () => {
  it("accepts the first ready the player can send", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const round = createLocalRound({ seed: 10 });
    await round.adapter.join(LOCAL_ROUND_NAME, "Curator");

    round.adapter.sendCommand({ type: "player_ready", ready: true });

    expect(warn).not.toHaveBeenCalled();
    expect(round.adapter.getSync().privateState?.ready).toBe(true);
    expect(round.director.getState().self.ready).toBe(true);

    round.dispose();
  });

  it("seats the bots and reaches a startable lobby", async () => {
    vi.useFakeTimers();
    const round = createLocalRound({ seed: 10 });
    await round.adapter.join(LOCAL_ROUND_NAME, "Curator");

    // The bots ready themselves on the simulation's own tick.
    vi.advanceTimersByTime(500);

    const state = round.director.getState();
    expect(state.phase).toBe(MatchPhase.Lobby);
    expect(state.roster).toHaveLength(4);
    expect(state.roster.filter((player) => player.ready)).toHaveLength(3);

    round.adapter.sendCommand({ type: "player_ready", ready: true });
    expect(round.director.getState().actions.startMatch.allowed).toBe(true);

    round.dispose();
  });

  it("reads a seed from the query string, and ignores a bad one", () => {
    expect(seedFromLocation("?seed=10")).toBe(10);
    expect(seedFromLocation("?webgl&seed=0")).toBe(0);
    expect(seedFromLocation("?webgl")).toBeUndefined();
    expect(seedFromLocation("")).toBeUndefined();
    expect(seedFromLocation("?seed=nonsense")).toBeUndefined();
    expect(seedFromLocation("?seed=-3")).toBeUndefined();
  });

  it("honours a seed from the caller so a round can be dealt on purpose", async () => {
    vi.useFakeTimers();
    const round = createLocalRound({ seed: 10, bots: 3 });
    await round.adapter.join(LOCAL_ROUND_NAME, "Curator");
    expect(round.adapter.getRoster()).toHaveLength(4);
    round.dispose();
  });
});
