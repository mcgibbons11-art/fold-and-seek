import type { MatchSettingsPatch, PrivateSimEvent, SimEvent } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalLoopbackAdapter,
  type LocalLoopbackOptions,
} from "../../src/networking/LocalLoopbackAdapter";
import type { ConnectionState, RosterEntry } from "../../src/networking/NetworkAdapter";

/** Round pacing compressed so a full match runs in a handful of stepped ticks. */
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

const STEP_MS = 100;

interface Fixture {
  readonly adapter: LocalLoopbackAdapter;
  readonly events: SimEvent[];
  readonly privateEvents: PrivateSimEvent[];
  readonly rosters: RosterEntry[][];
  readonly statuses: ConnectionState[];
  advance(steps: number): void;
  now(): number;
}

function createFixture(options: Partial<LocalLoopbackOptions> = {}): Fixture {
  let clock = 0;
  const events: SimEvent[] = [];
  const privateEvents: PrivateSimEvent[] = [];
  const rosters: RosterEntry[][] = [];
  const statuses: ConnectionState[] = [];
  const adapter = new LocalLoopbackAdapter({
    settings: FAST_SETTINGS,
    seed: 11,
    now: () => clock,
    ...options,
  });
  adapter.onEvent((event) => events.push(event));
  adapter.onPrivateEvent((event) => privateEvents.push(event));
  adapter.onRoster((roster) => rosters.push([...roster]));
  adapter.onStatus((state) => statuses.push(state));

  return {
    adapter,
    events,
    privateEvents,
    rosters,
    statuses,
    now: () => clock,
    advance(steps: number) {
      for (let index = 0; index < steps; index += 1) {
        clock += STEP_MS;
        adapter.step();
      }
    },
  };
}

/**
 * Steps until the match reaches `target`, re-arming the human player's ready
 * flag whenever the simulation clears it on entering Loading.
 */
function runTo(fixture: Fixture, target: MatchPhase, maxSteps = 60): void {
  for (let index = 0; index < maxSteps; index += 1) {
    const phase = fixture.adapter.getSync().publicState?.phase;
    if (phase === target) return;
    if (phase === MatchPhase.Lobby || phase === MatchPhase.Loading) {
      fixture.adapter.sendCommand({ type: "player_ready", ready: true });
    }
    fixture.advance(1);
  }
  throw new Error(`phase ${target} not reached in ${maxSteps} steps`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalLoopbackAdapter", () => {
  it("plays a full round with three simulated players", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    for (let index = 0; index < 3; index += 1) fixture.adapter.addBot();
    await fixture.adapter.join("practice", "Curator");

    expect(fixture.adapter.getSelfId()).toBe("local-self");
    expect(fixture.adapter.getRoster()).toHaveLength(4);
    expect(fixture.adapter.getConnection().status).toBe("connected");

    fixture.adapter.sendCommand({ type: "player_ready", ready: true });
    fixture.advance(1);
    fixture.adapter.sendCommand({ type: "start_match" });
    runTo(fixture, MatchPhase.Results);

    const phases = fixture.events
      .filter((event): event is Extract<SimEvent, { type: "phase_changed" }> =>
        event.type === "phase_changed",
      )
      .map((event) => event.phase);

    expect(phases).toContain(MatchPhase.RoleReveal);
    expect(phases).toContain(MatchPhase.Forge);
    expect(phases).toContain(MatchPhase.Inspection);
    expect(phases).toContain(MatchPhase.Reveal);
    expect(phases).toContain(MatchPhase.Results);
    expect(fixture.events.some((event) => event.type === "match_ended")).toBe(true);

    const results = fixture.adapter.getSync().publicState?.results;
    expect(results).not.toBeNull();
    expect(results?.players).toHaveLength(4);

    fixture.adapter.dispose();
  });

  it("delivers the local player's role on the private stream only", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    for (let index = 0; index < 3; index += 1) fixture.adapter.addBot();
    await fixture.adapter.join("practice", "Curator");

    fixture.adapter.sendCommand({ type: "player_ready", ready: true });
    fixture.advance(1);
    fixture.adapter.sendCommand({ type: "start_match" });
    runTo(fixture, MatchPhase.Forge);

    const assignments = fixture.privateEvents.filter(
      (event): event is Extract<PrivateSimEvent, { type: "role_assigned" }> =>
        event.type === "role_assigned",
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.role).toBe(fixture.adapter.getSync().privateState?.role);
    expect(assignments[0]?.publicPlayerId).toBe(
      fixture.adapter.getSync().privateState?.publicPlayerId,
    );

    // The bots' three role assignments never reach the local stream at all.
    expect(fixture.privateEvents.filter((event) => event.type === "role_assigned")).toHaveLength(1);

    fixture.adapter.dispose();
  });

  it("drives the simulation from its own interval", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const adapter = new LocalLoopbackAdapter({
      settings: FAST_SETTINGS,
      seed: 3,
      tickHz: 10,
      now: () => (clock += STEP_MS),
    });
    await adapter.join("practice", "Curator");

    const before = adapter.getSync().publicState?.now ?? 0;
    vi.advanceTimersByTime(500);
    const after = adapter.getSync().publicState?.now ?? 0;

    expect(after).toBeGreaterThan(before);
    adapter.dispose();
  });

  it("seats a bot added after the session started and drops it on removal", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    await fixture.adapter.join("practice", "Curator");
    expect(fixture.adapter.getRoster()).toHaveLength(1);

    const botId = fixture.adapter.addBot({ displayName: "Understudy" });
    expect(fixture.adapter.getRoster().map((entry) => entry.displayName)).toEqual([
      "Curator",
      "Understudy",
    ]);
    expect(fixture.adapter.getSync().publicState?.players).toHaveLength(2);

    fixture.adapter.removeBot(botId);
    expect(fixture.adapter.getRoster()).toHaveLength(1);
    expect(fixture.adapter.getSync().publicState?.players).toHaveLength(1);

    fixture.adapter.dispose();
  });

  it("ignores commands issued before join", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = new LocalLoopbackAdapter();
    adapter.sendCommand({ type: "start_match" });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    adapter.dispose();
  });
});
