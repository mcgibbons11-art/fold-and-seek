import {
  CLOSE_PASS_COOLDOWN_MS,
  CLOSE_PASS_DWELL_MS,
  SCORE_MIMIC_PER_CLOSE_PASS,
  SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE,
  type MatchSettingsPatch,
  type SimEvent,
  CLOSE_PASS_JACKPOT_COUNT,
  SCORE_MIMIC_CLOSE_PASS_JACKPOT,
} from "@foldseek/game-sim";
import { CLOSE_PASS_DISTANCE_M, DEFAULT_MATCH_SETTINGS, MatchPhase } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoundActions } from "../../src/gameplay/RoundActions";
import { RoundDirector } from "../../src/gameplay/RoundDirector";
import { RoundSpatialBridge } from "../../src/gameplay/roundSpatial";
import type { RoundViewState } from "../../src/gameplay/roundView";
import type { AABB } from "../../src/inspector/navData";
import { LocalLoopbackAdapter } from "../../src/networking/LocalLoopbackAdapter";
import { CURIOSITY_SHOP_OBJECTS, type MapObjectEntry } from "../../src/world/maps/registry";

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
 * `close_pass`, the other deception term, is driven the way the game drives it
 * too, and needs no command at all: the authority finds one by asking the round
 * for the Inspector's eye, which is the same seam that decides whether a shot
 * is in range. The second block below walks an eye up to a disguise through the
 * loopback and takes the whole chain from that walk to the owner's HUD.
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
/** Steps that outlast the close-pass dwell without reaching a second window. */
const DWELL_STEPS = Math.ceil(CLOSE_PASS_DWELL_MS / STEP_MS) + 2;

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

async function startedFixture(seed: number, spatial?: RoundSpatialBridge): Promise<Fixture> {
  let clock = 0;
  const adapter = new LocalLoopbackAdapter({
    settings: SETTINGS,
    seed,
    now: () => clock,
    ...(spatial === undefined ? {} : { spatial: spatial.validator }),
  });
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

/**
 * A hunt in which the room knows where every disguise is and the test says
 * where the Inspector is standing.
 *
 * The bounds come from the shop's own props, which is where a folded Mimic
 * ends up, so the sight lines are the map's rather than an empty room's. The
 * props are chosen far enough apart that an eye beside one is nowhere near
 * another, which is what lets a pass be attributed to one hider.
 */
interface WalkPast {
  readonly fixture: Fixture;
  /**
   * Puts the Inspector's eye a stride from the named disguise and ticks once,
   * which is the tick the authority first sees them there. The dwell runs from
   * that observation, so everything advanced afterwards is time spent alongside.
   */
  standBy(objectId: string): void;
  /** Takes them well outside close-pass range of everything. */
  walkAway(): void;
  /** Close passes the room has broadcast for one disguise, or for all of them. */
  passes(objectId?: string): number;
}

/** Half the close-pass reach, so standing here is unambiguously inside it. */
const STRIDE_M = CLOSE_PASS_DISTANCE_M / 2;

/**
 * How far apart the props holding two disguises must be. Six close-pass reaches
 * is 4.2 m, so an eye a stride from one of them is more than five reaches from
 * the other and no assertion below can be satisfied by the wrong hider.
 */
const SEPARATION_M = CLOSE_PASS_DISTANCE_M * 6;

/** Props spread across the shop, taken greedily in the map's own order. */
function spacedProps(count: number): readonly THREE.Box3[] {
  const chosen: MapObjectEntry[] = [];
  for (const prop of CURIOSITY_SHOP_OBJECTS) {
    if (chosen.some((taken) => taken.position.distanceTo(prop.position) < SEPARATION_M)) continue;
    chosen.push(prop);
    if (chosen.length === count) return chosen.map((entry) => entry.focusBounds);
  }
  throw new Error(`the shop has no ${count} props ${SEPARATION_M} m apart`);
}

async function walkPastFixture(seed: number): Promise<WalkPast> {
  const spatial = new RoundSpatialBridge();
  const fixture = await startedFixture(seed, spatial);
  fixture.runTo(MatchPhase.Inspection);

  // One prop per disguise, in the order the room publishes them.
  const disguises = fixture.state().reveal.entries;
  const boxes = spacedProps(disguises.length);
  const bounds = new Map<string, AABB>();
  for (const [index, entry] of disguises.entries()) {
    bounds.set(entry.publicObjectId, boxes[index] as THREE.Box3);
  }
  spatial.setDisguiseBounds((objectId) => bounds.get(objectId) ?? null);

  const seat = fixture.inspectorSeat();
  const far = { x: 1e4, y: 1e4, z: 1e4 };
  return {
    fixture,
    standBy(objectId: string) {
      const box = bounds.get(objectId);
      if (box === undefined) throw new Error(`no bounds for ${objectId}`);
      spatial.acceptInspectorEye(seat, {
        x: box.max.x + STRIDE_M,
        y: (box.min.y + box.max.y) / 2,
        z: (box.min.z + box.max.z) / 2,
      });
      // The premise of every assertion below. If the shop ever puts something
      // between this spot and the prop, the test says so instead of quietly
      // measuring nothing.
      expect(spatial.isNearby(seat, objectId).ok).toBe(true);
      fixture.advance(1);
    },
    walkAway() {
      spatial.acceptInspectorEye(seat, far);
    },
    passes: (objectId?: string) =>
      fixture.events.filter(
        (event) =>
          event.type === "close_pass" &&
          (objectId === undefined || event.publicObjectId === objectId),
      ).length,
  };
}

describe("close passes", () => {
  it("pays the hider the Inspector walked past, and nobody else", async () => {
    vi.useFakeTimers();
    const walk = await walkPastFixture(MIMIC_SEED);
    const fixture = walk.fixture;
    expect(fixture.state().self.role).toBe("mimic");

    const mine = fixture.state().self.ownDisguise?.publicObjectId;
    if (mine === undefined) throw new Error("the hider holds no disguise");

    // Nothing while the Inspector is on the other side of the shop.
    walk.walkAway();
    fixture.advance(DWELL_STEPS * 4);
    expect(walk.passes()).toBe(0);
    expect(fixture.state().deception.closePasses).toBe(0);

    walk.standBy(mine);
    fixture.advance(DWELL_STEPS);

    // One pass, and it named this hider's object: nobody else was passed.
    expect(walk.passes()).toBe(1);
    expect(walk.passes(mine)).toBe(1);
    const earned = fixture.state().deception;
    expect(earned.closePasses).toBe(1);
    expect(earned.directLookEscapes).toBe(0);
    expect(earned.points).toBe(SCORE_MIMIC_PER_CLOSE_PASS);
    expect(earned.recent[0]?.kind).toBe("close_pass");
    expect(earned.recent[0]?.points).toBe(SCORE_MIMIC_PER_CLOSE_PASS);

    fixture.dispose();
  });

  it("tells a bystanding hider nothing about the pass somebody else earned", async () => {
    vi.useFakeTimers();
    const walk = await walkPastFixture(MIMIC_SEED);
    const fixture = walk.fixture;

    const mine = fixture.state().self.ownDisguise?.publicObjectId;
    const other = fixture
      .state()
      .reveal.entries.map((entry) => entry.publicObjectId)
      .find((objectId) => objectId !== mine);
    if (other === undefined) throw new Error("no other disguise in the room");

    walk.standBy(other);
    fixture.advance(DWELL_STEPS);

    // The pass has to have happened, or the guard below is proving nothing.
    expect(walk.passes(other)).toBe(1);
    // Counting other hiders' close passes would locate the Inspector: the
    // number moves exactly when they are standing beside somebody.
    expect(fixture.state().deception.closePasses).toBe(0);
    expect(fixture.state().deception.points).toBe(0);
    expect(fixture.state().deception.recent).toHaveLength(0);

    fixture.dispose();
  });

  it("pays a loitering Inspector once per cooldown rather than every tick", async () => {
    vi.useFakeTimers();
    const walk = await walkPastFixture(MIMIC_SEED);
    const fixture = walk.fixture;
    const mine = fixture.state().self.ownDisguise?.publicObjectId;
    if (mine === undefined) throw new Error("the hider holds no disguise");

    // Long enough for several windows, short enough that the hunt is still
    // running at the end of it: a finished round clears the feed.
    const loiterMs = 12_000;
    walk.standBy(mine);
    fixture.advance(loiterMs / STEP_MS);
    expect([MatchPhase.Inspection, MatchPhase.FinalCountdown]).toContain(fixture.state().phase);

    // One at the dwell, then one per cooldown for the rest of the stay. A
    // hundred and twenty ticks in the same spot, paid three times - and the
    // third pass with the same seeker also trips the 2026-08-04 jackpot.
    const windows = 1 + Math.floor((loiterMs - CLOSE_PASS_DWELL_MS) / CLOSE_PASS_COOLDOWN_MS);
    expect(fixture.state().deception.closePasses).toBe(windows);
    const jackpots = windows >= CLOSE_PASS_JACKPOT_COUNT ? 1 : 0;
    expect(fixture.state().deception.points).toBe(
      windows * SCORE_MIMIC_PER_CLOSE_PASS + jackpots * SCORE_MIMIC_CLOSE_PASS_JACKPOT,
    );
    expect(windows).toBeLessThan(loiterMs / STEP_MS);

    fixture.dispose();
  });
});
