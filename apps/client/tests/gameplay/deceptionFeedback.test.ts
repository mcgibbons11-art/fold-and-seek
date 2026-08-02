import {
  SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE,
  type MatchSettingsPatch,
  type SimEvent,
} from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, MatchPhase } from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoundActions } from "../../src/gameplay/RoundActions";
import { RoundDirector } from "../../src/gameplay/RoundDirector";
import type { RoundViewState } from "../../src/gameplay/roundView";
import { LocalLoopbackAdapter } from "../../src/networking/LocalLoopbackAdapter";

/**
 * Score feedback for being looked straight at and surviving it.
 *
 * `direct_look_escape` is broadcast and names a public object, so the guard that
 * matters is not cosmetic: only the client wearing that object may be told what
 * happened. An Inspector shown "the thing you just stared at was a person" has
 * been handed the answer they are spending warrants to find, and these tests
 * hold that line from the authority's event to the view state.
 *
 * A direct look is driven the way the game drives it, through focus commands:
 * hold the object past `directLookMinMs`, break off past `directLookBreakMs`,
 * and the authority credits the escape on its own tick.
 *
 * `close_pass`, the other deception term, is NOT exercised end to end here
 * because nothing in the client produces it: `MatchSimulation.recordClosePass`
 * has no caller outside the simulation's own tests, so the event cannot occur
 * in play. The consumer is built and symmetrical with this one, and the missing
 * producer is reported rather than papered over with a stubbed authority.
 */

const SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 20_000,
  revealMs: 400,
  resultsMs: 400,
  rematchVoteMs: 400,
};

const STEP_MS = 100;
const BOT_COUNT = 2;
/** Hands the Inspector role to the local player; both bots hide. */
const INSPECTOR_SEED = 4;
/** The complement: the local player hides and is the one being looked at. */
const MIMIC_SEED = 11;

/** Steps that comfortably outlast the hold and the break windows. */
const HOLD_STEPS = Math.ceil(DEFAULT_MATCH_SETTINGS.directLookMinMs / STEP_MS) + 2;
const BREAK_STEPS = Math.ceil(DEFAULT_MATCH_SETTINGS.directLookBreakMs / STEP_MS) + 2;

interface Fixture {
  readonly adapter: LocalLoopbackAdapter;
  readonly director: RoundDirector;
  readonly actions: RoundActions;
  /** Every public event the room broadcast, so a test can prove one happened. */
  readonly events: SimEvent[];
  advance(steps: number): void;
  runTo(phase: MatchPhase, maxSteps?: number): void;
  /** Seat of the Inspector, which is how a command is issued on their behalf. */
  inspectorSeat(): string;
  /** Holds an object in focus long enough to earn its owner an escape. */
  stareAndLookAway(objectId: string): void;
  state(): RoundViewState;
  dispose(): void;
}

async function startedFixture(seed: number): Promise<Fixture> {
  let clock = 0;
  const adapter = new LocalLoopbackAdapter({ settings: SETTINGS, seed, now: () => clock });
  const director = new RoundDirector(adapter, { now: () => clock, tickIntervalMs: 0 });
  const events: SimEvent[] = [];
  adapter.onEvent((event) => events.push(event));

  const fixture: Fixture = {
    adapter,
    director,
    actions: new RoundActions(adapter, director),
    events,
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
    inspectorSeat() {
      const seat = director
        .getState()
        .roster.find((player) => player.rolePublicState === "inspector")?.seatId;
      if (seat === undefined) throw new Error("no inspector seated");
      return seat;
    },
    stareAndLookAway(objectId: string) {
      const seat = fixture.inspectorSeat();
      fixture.adapter.sendCommandAs(seat, { type: "focus", targetObjectId: objectId });
      fixture.advance(HOLD_STEPS);
      fixture.adapter.sendCommandAs(seat, { type: "focus", targetObjectId: null });
      fixture.advance(BREAK_STEPS);
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

describe("deception score feedback", () => {
  it("pays the hider who was stared at, at the simulation's own weight", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture(MIMIC_SEED);
    fixture.runTo(MatchPhase.Inspection);
    expect(fixture.state().self.role).toBe("mimic");

    const mine = fixture.state().self.ownDisguise?.publicObjectId;
    expect(mine).toBeDefined();
    if (mine === undefined) throw new Error("the hider holds no disguise");

    // Nothing earned before anybody looks.
    expect(fixture.state().deception.points).toBe(0);
    expect(fixture.state().deception.recent).toHaveLength(0);

    fixture.stareAndLookAway(mine);

    const earned = fixture.state().deception;
    expect(earned.directLookEscapes).toBe(1);
    expect(earned.closePasses).toBe(0);
    // The figure is the simulation's own §6.2 weight, not a number the HUD made up.
    expect(earned.points).toBe(SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE);
    expect(earned.recent).toHaveLength(1);
    expect(earned.recent[0]?.kind).toBe("direct_look_escape");
    expect(earned.recent[0]?.points).toBe(SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE);

    fixture.dispose();
  });

  it("tells an Inspector nothing about the object they just stared at", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture(INSPECTOR_SEED);
    fixture.runTo(MatchPhase.Inspection);
    expect(fixture.state().self.role).toBe("inspector");

    const target = fixture.state().reveal.entries[0]?.publicObjectId;
    expect(target).toBeDefined();
    if (target === undefined) throw new Error("no disguise in the room");

    fixture.stareAndLookAway(target);

    // The escape has to have actually happened, or this proves nothing: a test
    // that never fires the event would pass with the guard removed.
    expect(
      fixture.events.filter((event) => event.type === "direct_look_escape"),
    ).toHaveLength(1);

    // A hider was paid for it, and this client is the one that must never learn
    // it. Anything here would name the object as a person.
    const seen = fixture.state().deception;
    expect(seen.points).toBe(0);
    expect(seen.directLookEscapes).toBe(0);
    expect(seen.recent).toHaveLength(0);

    fixture.dispose();
  });

  it("ignores an escape earned by somebody else's disguise", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture(MIMIC_SEED);
    fixture.runTo(MatchPhase.Inspection);

    const mine = fixture.state().self.ownDisguise?.publicObjectId;
    const other = fixture
      .state()
      .reveal.entries.map((entry) => entry.publicObjectId)
      .find((objectId) => objectId !== mine);
    expect(other).toBeDefined();
    if (other === undefined) throw new Error("no other disguise in the room");

    fixture.stareAndLookAway(other);

    expect(
      fixture.events.filter((event) => event.type === "direct_look_escape"),
    ).toHaveLength(1);
    // A hider who could count other hiders' escapes could work out which object
    // is which by watching where the Inspector stands when the number moves.
    expect(fixture.state().deception.points).toBe(0);
    expect(fixture.state().deception.recent).toHaveLength(0);

    fixture.dispose();
  });

  it("accumulates across looks and clears with the round", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture(MIMIC_SEED);
    fixture.runTo(MatchPhase.Inspection);

    const mine = fixture.state().self.ownDisguise?.publicObjectId;
    if (mine === undefined) throw new Error("the hider holds no disguise");

    fixture.stareAndLookAway(mine);
    fixture.stareAndLookAway(mine);

    const twice = fixture.state().deception;
    expect(twice.directLookEscapes).toBe(2);
    expect(twice.points).toBe(SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE * 2);
    expect(twice.recent).toHaveLength(2);
    // Most recent first, as every other feed on the view state is ordered.
    expect(twice.recent[0]?.id).toBeGreaterThan(twice.recent[1]?.id ?? 0);

    fixture.runTo(MatchPhase.Results, 600);
    // The bots follow the room's one person, so a single yes carries the vote.
    fixture.actions.voteRematch(true);
    fixture.runTo(MatchPhase.RoleReveal, 600);

    expect(fixture.state().deception.points).toBe(0);
    expect(fixture.state().deception.recent).toHaveLength(0);

    fixture.dispose();
  });
});
