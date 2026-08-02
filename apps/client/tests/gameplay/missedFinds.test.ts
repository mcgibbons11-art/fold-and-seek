import type { MatchSettingsPatch } from "@foldseek/game-sim";
import { MISSED_FINDS_POINT_BUCKET } from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, MatchPhase } from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoundActions } from "../../src/gameplay/RoundActions";
import { RoundDirector } from "../../src/gameplay/RoundDirector";
import type { RoundViewState } from "../../src/gameplay/roundView";
import { LocalLoopbackAdapter } from "../../src/networking/LocalLoopbackAdapter";

/**
 * The missed-finds board reaches the HUD only as an event. Nothing in the match
 * state carries the ranking, so these drive a real round and read the board off
 * the view state the same way the HUD does, including the empty state a player
 * sees before the first report lands.
 *
 * The report cycle is not host-settable, so the round is paced around the
 * simulation's own twenty-second cycle rather than compressed.
 */

/** Long enough for the authority's own ~20 s cycle to report at least once. */
const INSPECTION_MS = 60_000;

const SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: INSPECTION_MS,
  revealMs: 400,
  resultsMs: 400,
  rematchVoteMs: 400,
};

const STEP_MS = 250;
const BOT_COUNT = 2;
/** Hands the Inspector role to the local player; both bots hide. */
const INSPECTOR_SEED = 4;
/** The complement: the local player hides and belongs on the board. */
const MIMIC_SEED = 11;

/** Steps that comfortably cover one report cycle plus its jitter. */
const CYCLE_STEPS = Math.ceil(30_000 / STEP_MS);

interface Fixture {
  readonly adapter: LocalLoopbackAdapter;
  readonly director: RoundDirector;
  readonly actions: RoundActions;
  advance(steps: number): void;
  runTo(phase: MatchPhase, maxSteps?: number): void;
  /** Steps until the board arrives, and fails rather than returning without it. */
  awaitBoard(maxSteps?: number): void;
  state(): RoundViewState;
  dispose(): void;
}

async function startedFixture(seed: number): Promise<Fixture> {
  let clock = 0;
  const adapter = new LocalLoopbackAdapter({ settings: SETTINGS, seed, now: () => clock });
  const director = new RoundDirector(adapter, { now: () => clock, tickIntervalMs: 0 });

  const fixture: Fixture = {
    adapter,
    director,
    actions: new RoundActions(adapter, director),
    advance(steps: number) {
      for (let index = 0; index < steps; index += 1) {
        clock += STEP_MS;
        adapter.step();
        director.tick();
      }
    },
    runTo(phase: MatchPhase, maxSteps = 400) {
      for (let index = 0; index < maxSteps; index += 1) {
        const current = director.getState().phase;
        if (current === phase) return;
        if (current === MatchPhase.Lobby || current === MatchPhase.Loading) {
          fixture.actions.ready(true);
        }
        fixture.advance(1);
      }
      throw new Error(`phase ${phase} not reached; stopped at ${director.getState().phase}`);
    },
    awaitBoard(maxSteps = CYCLE_STEPS) {
      for (let index = 0; index < maxSteps; index += 1) {
        if (director.getState().missedFinds.received) return;
        fixture.advance(1);
      }
      throw new Error("no missed-finds board arrived within one report cycle");
    },
    state: () => director.getState(),
    dispose() {
      director.dispose();
      adapter.dispose();
    },
  };

  for (let index = 0; index < BOT_COUNT; index += 1) adapter.addBot();
  await adapter.join("practice", "Curator");
  fixture.actions.ready(true);
  fixture.advance(1);
  fixture.actions.startMatch();
  return fixture;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the missed-finds board", () => {
  it("shows nothing until the first report, then ranks every hider", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture(INSPECTOR_SEED);
    fixture.runTo(MatchPhase.Inspection);
    expect(fixture.state().self.role).toBe("inspector");

    // There is no state fallback: an Inspector who has just walked in has no
    // board at all, which is not the same as a board on which nobody has scored.
    const before = fixture.state().missedFinds;
    expect(before.received).toBe(false);
    expect(before.rows).toHaveLength(0);
    expect(before.secondsToNextUpdate).toBeNull();

    fixture.awaitBoard();

    const board = fixture.state().missedFinds;
    expect(board.final).toBe(false);
    // Entries name players, never disguises, and every hider is on the board.
    expect(board.rows).toHaveLength(BOT_COUNT);
    expect(board.rows.map((row) => row.rank)).toEqual([1, 2]);
    expect(new Set(board.rows.map((row) => row.publicPlayerId)).size).toBe(BOT_COUNT);
    expect(board.rows.every((row) => row.displayName.length > 0)).toBe(true);
    // An Inspector is not a hider, so none of these rows is theirs.
    expect(board.rows.some((row) => row.isSelf)).toBe(false);
    // Ranked by points, highest first.
    expect(board.rows[0]?.points).toBeGreaterThanOrEqual(board.rows[1]?.points ?? 0);
    // Mid-round figures are floored into buckets, which is what blunts the
    // inference from a stare to a name.
    expect(board.rows.every((row) => row.points % MISSED_FINDS_POINT_BUCKET === 0)).toBe(true);

    fixture.dispose();
  });

  it("counts down to the next report against the authority's own clock", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture(INSPECTOR_SEED);
    fixture.runTo(MatchPhase.Inspection);
    fixture.awaitBoard();

    const board = fixture.state().missedFinds;
    expect(board.nextUpdateAtServerMs).toBeGreaterThan(0);
    expect(board.secondsToNextUpdate).not.toBeNull();
    // The cycle is jittered by up to three seconds either side of the setting.
    const cycleSeconds = DEFAULT_MATCH_SETTINGS.missedFindsUpdateMs / 1_000;
    expect(board.secondsToNextUpdate ?? 0).toBeGreaterThan(0);
    expect(board.secondsToNextUpdate ?? 0).toBeLessThanOrEqual(cycleSeconds + 3);

    // The countdown falls as the deadline approaches rather than standing still.
    const first = board.secondsToNextUpdate ?? 0;
    fixture.advance(Math.ceil(5_000 / STEP_MS));
    expect(fixture.state().missedFinds.secondsToNextUpdate ?? 0).toBeLessThan(first);

    fixture.dispose();
  });

  it("marks a hider's own row and publishes an exact board at the reveal", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture(MIMIC_SEED);
    fixture.runTo(MatchPhase.Inspection);
    expect(fixture.state().self.role).toBe("mimic");

    // Both roles read the board; a hider finds themselves on it.
    fixture.awaitBoard();
    const live = fixture.state().missedFinds;
    expect(live.rows.filter((row) => row.isSelf)).toHaveLength(1);

    fixture.runTo(MatchPhase.Reveal, 600);
    const final = fixture.state().missedFinds;
    expect(final.received).toBe(true);
    expect(final.final).toBe(true);
    // Nothing further is coming, so the countdown has nothing to say.
    expect(final.nextUpdateAtServerMs).toBe(0);
    expect(final.secondsToNextUpdate).toBeNull();
    expect(final.rows.length).toBeGreaterThan(0);

    fixture.dispose();
  });

  it("clears the board when a rematch starts a new round", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture(INSPECTOR_SEED);
    fixture.runTo(MatchPhase.Inspection);
    fixture.awaitBoard();
    expect(fixture.state().missedFinds.received).toBe(true);

    fixture.runTo(MatchPhase.Results, 600);
    fixture.actions.voteRematch(true);
    for (let index = 0; index < BOT_COUNT; index += 1) {
      fixture.adapter.sendCommandAs(`bot-${index + 1}`, { type: "vote_rematch", yes: true });
    }
    fixture.runTo(MatchPhase.RoleReveal, 600);

    // Last round's ranking is not this round's, and showing it would be a lie.
    expect(fixture.state().missedFinds.received).toBe(false);
    expect(fixture.state().missedFinds.rows).toHaveLength(0);

    fixture.dispose();
  });
});
