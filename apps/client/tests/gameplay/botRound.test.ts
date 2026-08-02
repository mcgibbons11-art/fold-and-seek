import type { MatchSettingsPatch, SimEvent } from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, MatchPhase } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BOT_HIDE_PLANS, botCreeps, createBotDisguise } from "../../src/gameplay/botDisguises";
import { MAX_CATCH_UP_MS, MAX_STEP_MS } from "../../src/gameplay/botInspector";
import { DisguiseTheatre } from "../../src/gameplay/disguiseTheatre";
import { createLocalRound, LOCAL_ROUND_NAME, type LocalRound } from "../../src/gameplay/localRound";
import { RoundSpatialBridge } from "../../src/gameplay/roundSpatial";
import type { Vec3Like } from "../../src/inspector/navData";
import { qualitySettingsFor } from "../../src/rendering/quality";
import { NAV_BLOCKERS } from "../../src/world/maps/nav";

/**
 * The round has to have stakes: somebody must be caught, somebody must get
 * away, and both must happen because a bot Inspector walked over and pulled the
 * trigger rather than because the clock ran out. These drive the real
 * `createLocalRound` wiring headlessly, the same adapter, brain, registry and
 * geometry validator the menu's "Play a round" builds, and read back what the
 * results screen would show.
 *
 * The one thing a headless round lacks is a renderer, and a disguise has no
 * bounds until something has posed it, so the tests stand in for `RoundSession`
 * by running a `DisguiseTheatre` over the published poses each step. That is the
 * same lookup the live round installs.
 */

/** Everything but the hunt is compressed; the hunt itself runs at full length. */
const FAST_SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
};

const STEP_MS = 100;
const BOT_COUNT = 3;

/**
 * A main thread taken away for five seconds, which is the scale of the compile
 * stalls measured on the WebGL 2 backend. The browser coalesces the interval the
 * bots ride, so the whole five arrives as one tick.
 */
const STALL_MS = 5_000;

/**
 * Deals the Inspector's role to a bot rather than to the local player, which is
 * what this whole file is about. Roles come off a seeded shuffle, so the seed is
 * the only way to ask for it, and fixing it is also what makes a round repeat.
 */
const BOT_INSPECTOR_SEED = 7;

interface Fixture {
  readonly round: LocalRound;
  readonly events: SimEvent[];
  /** Every eye position the round was told about, in order, with its tick. */
  readonly trail: { readonly playerId: string; readonly eye: Vec3Like }[];
  advance(steps: number): void;
  /** One tick carrying an arbitrary amount of match time, for a stalled thread. */
  advanceBy(stepMs: number): void;
  runTo(phase: MatchPhase, maxSteps?: number): void;
  dispose(): void;
}

async function soloRound(seed: number): Promise<Fixture> {
  let clock = 0;
  const round = createLocalRound({
    bots: BOT_COUNT,
    seed,
    settings: FAST_SETTINGS,
    now: () => clock,
  });
  const theatre = new DisguiseTheatre(new THREE.Scene(), qualitySettingsFor("high"));
  round.spatial.setDisguiseBounds((objectId) => theatre.boundsOf(objectId));

  // The walk reaches the authority as eye positions and nowhere else, so this
  // is where a test watches a bot move.
  const trail: { playerId: string; eye: Vec3Like }[] = [];
  const publishEye = round.spatial.setInspectorEye.bind(round.spatial);
  round.spatial.setInspectorEye = (playerId, eye) => {
    if (eye !== null) trail.push({ playerId, eye: { x: eye.x, y: eye.y, z: eye.z } });
    publishEye(playerId, eye);
  };

  const events: SimEvent[] = [];
  round.adapter.onEvent((event) => events.push(event));

  const fixture: Fixture = {
    round,
    events,
    trail,
    advance(steps: number) {
      for (let index = 0; index < steps; index += 1) {
        fixture.advanceBy(STEP_MS);
      }
    },
    advanceBy(stepMs: number) {
      clock += stepMs;
      round.adapter.step();
      theatre.sync(round.adapter.getSync().publicState?.disguises ?? [], null);
    },
    runTo(phase: MatchPhase, maxSteps = 1_500) {
      for (let index = 0; index < maxSteps; index += 1) {
        const current = round.adapter.getSync().publicState?.phase;
        if (current === phase) return;
        if (current === MatchPhase.Lobby || current === MatchPhase.Loading) {
          round.adapter.sendCommand({ type: "player_ready", ready: true });
        }
        fixture.advance(1);
      }
      throw new Error(
        `phase ${phase} not reached; stopped at ${String(round.adapter.getSync().publicState?.phase)}`,
      );
    },
    dispose() {
      theatre.dispose();
      round.dispose();
    },
  };

  await round.adapter.join(LOCAL_ROUND_NAME, "Curator");
  fixture.advance(1);
  round.adapter.sendCommand({ type: "player_ready", ready: true });
  fixture.advance(1);
  round.adapter.sendCommand({ type: "start_match" });
  return fixture;
}

interface Outcome {
  readonly selfWasInspector: boolean;
  readonly correct: number;
  readonly wrong: number;
  /** Pose updates the authority accepted from a hider that actually shifted. */
  readonly creeps: number;
  /** Whether each hiding bot was caught, in the order they took hiding places. */
  readonly botsCaught: readonly boolean[];
  readonly hidersCaught: number;
  readonly hidersAway: number;
}

/** Plays one whole round and reads the results screen. */
async function playOut(seed: number): Promise<Outcome> {
  const fixture = await soloRound(seed);
  fixture.runTo(MatchPhase.Results);

  const resolved = fixture.events.filter((event) => event.type === "accusation_resolved");
  const correct = resolved.filter(
    (event) => event.type === "accusation_resolved" && event.correct,
  ).length;
  const results = fixture.round.adapter.getSync().publicState?.results;
  const hiders = (results?.players ?? []).filter((player) => player.role === "mimic");

  // Bots lock in seat order inside one tick, so the lowest-numbered hiding bot
  // took hiding place 0, the next took 1, and so on.
  const botsCaught = hiders
    .filter((player) => player.displayName.startsWith("Bot "))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((player) => !player.fullRoundSurvival);

  const outcome: Outcome = {
    selfWasInspector: fixture.round.adapter.getSync().privateState?.role === "inspector",
    correct,
    wrong: resolved.length - correct,
    creeps: fixture.events.filter((event) => event.type === "disguise_updated" && event.moved)
      .length,
    botsCaught,
    hidersCaught: hiders.filter((player) => !player.fullRoundSurvival).length,
    hidersAway: hiders.filter((player) => player.fullRoundSurvival).length,
  };
  fixture.dispose();
  return outcome;
}

/**
 * Plays a round with the hunt ticked at `huntStepMs` instead of `STEP_MS`, which
 * is how a stalled main thread reaches the bots: the interval driving them is
 * coalesced, so whole seconds of the match arrive as one turn.
 */
async function playOutAt(seed: number, huntStepMs: number): Promise<Outcome> {
  const fixture = await soloRound(seed);
  const hunting = new Set([MatchPhase.Inspection, MatchPhase.FinalCountdown]);
  for (let index = 0; index < 4_000; index += 1) {
    const phase = fixture.round.adapter.getSync().publicState?.phase;
    if (phase === MatchPhase.Results) break;
    if (phase === MatchPhase.Lobby || phase === MatchPhase.Loading) {
      fixture.round.adapter.sendCommand({ type: "player_ready", ready: true });
    }
    fixture.advanceBy(phase !== undefined && hunting.has(phase) ? huntStepMs : STEP_MS);
  }

  const resolved = fixture.events.filter((event) => event.type === "accusation_resolved");
  const correct = resolved.filter(
    (event) => event.type === "accusation_resolved" && event.correct,
  ).length;
  const results = fixture.round.adapter.getSync().publicState?.results;
  const hiders = (results?.players ?? []).filter((player) => player.role === "mimic");
  const outcome: Outcome = {
    selfWasInspector: fixture.round.adapter.getSync().privateState?.role === "inspector",
    correct,
    wrong: resolved.length - correct,
    creeps: fixture.events.filter((event) => event.type === "disguise_updated" && event.moved).length,
    botsCaught: [],
    hidersCaught: hiders.filter((player) => !player.fullRoundSurvival).length,
    hidersAway: hiders.filter((player) => player.fullRoundSurvival).length,
  };
  fixture.dispose();
  return outcome;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the places a bot hides", () => {
  it("puts every one of them somewhere the authority allows a body to be", () => {
    const bridge = new RoundSpatialBridge();
    for (let index = 0; index < BOT_HIDE_PLANS.length; index += 1) {
      // Both ends of a fidget, because a creep the authority refuses would leave
      // the bot's disguise and the room's copy disagreeing for the whole hunt.
      for (const progress of [0, 1]) {
        const root = createBotDisguise(index, { progress }).root.position;
        const decision = bridge.canOccupy(`bot-${String(index)}`, [root[0], root[1], root[2]]);
        expect(
          decision.ok,
          `${BOT_HIDE_PLANS[index]?.note ?? ""} at ${String(progress)}: ${decision.ok ? "" : (decision.reason ?? "")}`,
        ).toBe(true);
      }
    }
  });

  it("offers cover as well as open floor, so hiding well is worth something", () => {
    const covered = BOT_HIDE_PLANS.filter((plan) => plan.note.startsWith("cover"));
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.length).toBeLessThan(BOT_HIDE_PLANS.length);
    // A hiding place in cover is one the bot keeps still in; the exposed ones
    // are where the fidget gives it away.
    for (let index = 0; index < BOT_HIDE_PLANS.length; index += 1) {
      const plan = BOT_HIDE_PLANS[index];
      expect(botCreeps(index), plan?.note ?? "").toBe(!plan?.note.startsWith("cover"));
    }
  });

  it("stands the ones that call themselves cover under real furniture", () => {
    for (const plan of BOT_HIDE_PLANS.filter((entry) => entry.note.startsWith("cover"))) {
      const overhead = NAV_BLOCKERS.filter(
        (blocker) =>
          blocker.min.y > plan.position[1] + 0.01 &&
          plan.position[0] >= blocker.min.x &&
          plan.position[0] <= blocker.max.x &&
          plan.position[2] >= blocker.min.z &&
          plan.position[2] <= blocker.max.z,
      );
      expect(overhead.length, `${plan.note} has open sky over it`).toBeGreaterThan(0);
    }
  });
});

describe("a solo round with a bot Inspector", () => {
  it("ends with somebody caught, somebody away, and warrants spent on furniture", async () => {
    vi.useFakeTimers();
    const outcome = await playOut(BOT_INSPECTOR_SEED);

    // If this seed ever stops dealing the gun to a bot, the rest proves nothing.
    expect(outcome.selfWasInspector).toBe(false);

    expect(outcome.correct + outcome.wrong, "the bot Inspector never fired").toBeGreaterThan(0);
    expect(outcome.correct, "no shot ever landed on a Mimic").toBeGreaterThan(0);
    expect(outcome.wrong, "no warrant was ever wasted on the shop's own furniture").toBeGreaterThan(
      0,
    );
    expect(outcome.hidersCaught, "every hider survived: the hunt had no stakes").toBeGreaterThan(0);
    expect(outcome.hidersAway, "every hider was caught: hiding well was worth nothing").toBeGreaterThan(
      0,
    );

    // The catch has to come from the mechanism, not from luck: the authority
    // accepted real creeps, so there was something for the bot to notice. A
    // creep refused as `moved_too_fast` or rate limited would leave this at nil
    // and the round would be back to nobody ever being found.
    expect(outcome.creeps, "no hider's creep was ever accepted").toBeGreaterThan(20);
  });

  it("plays the same round twice from the same seed", async () => {
    vi.useFakeTimers();
    const first = await playOut(BOT_INSPECTOR_SEED);
    const second = await playOut(BOT_INSPECTOR_SEED);
    expect(second).toEqual(first);
  });

  it("finds the hider that could not keep still, and misses the one that could", async () => {
    vi.useFakeTimers();
    // The single claim this bot makes about difficulty: it hunts by noticing
    // that something is not where it was. So the hider out on the open floor,
    // shifting, should be caught far more often than the one folded under the
    // workshop bench holding still.
    //
    // It is measured over a spread of deals rather than asserted on one, because
    // either outcome is possible in any single round: the shortlist can send the
    // bot to check a still hider, and the restless one can be missed. Over these
    // seeds the rates come out at 17 of 19 for the restless hider against 7 of 19
    // for the one in cover, so the thresholds below sit well clear of both.
    let restlessCaught = 0;
    let stillCaught = 0;
    let rounds = 0;
    let correct = 0;
    let wrong = 0;
    for (let seed = 1; seed <= 24; seed += 1) {
      const outcome = await playOut(seed);
      if (outcome.selfWasInspector) continue;
      if (outcome.botsCaught.length < 2) continue;
      rounds += 1;
      correct += outcome.correct;
      wrong += outcome.wrong;
      if (outcome.botsCaught[0] === true) restlessCaught += 1;
      if (outcome.botsCaught[1] === true) stillCaught += 1;
    }

    expect(rounds, "no deal in this spread gave a bot the gun").toBeGreaterThan(9);

    // The bot is handed props and disguises in one list with no record of which
    // is which, so most of what it shoots has to be furniture. If somebody ever
    // wires the room's disguise list into the brain as an answer key, the wrong
    // accusations collapse toward nil and this is what says so.
    expect(wrong, "the bot is shooting Mimics too accurately to be guessing").toBeGreaterThan(
      correct,
    );
    expect(restlessCaught, "the restless hider is usually missed").toBeGreaterThan(rounds * 0.6);
    expect(
      stillCaught * 2,
      "hiding in cover and holding still bought almost nothing",
    ).toBeLessThan(restlessCaught);
  }, 120_000);

  it("spends several warrants and catches somebody in every round it is dealt the gun", async () => {
    vi.useFakeTimers();
    // The round-6 critic reported one warrant spent in about 200 seconds of a
    // live round, which would leave a 75-second hunt with no stakes at all. It
    // does not reproduce through the production wiring: over these seeds the bot
    // fires between four and seven times and always finds at least one hider.
    // The bounds are drawn around that measurement, wide enough that a change of
    // map or of body size does not fail them for no reason, and tight enough
    // that a hunt collapsing to a shot or two does.
    const shots: number[] = [];
    const caught: number[] = [];
    for (let seed = 1; seed <= 6; seed += 1) {
      const outcome = await playOut(seed);
      if (outcome.selfWasInspector) continue;
      shots.push(outcome.correct + outcome.wrong);
      caught.push(outcome.hidersCaught);
    }

    expect(shots.length, "no deal in this spread gave a bot the gun").toBeGreaterThan(3);
    for (const spent of shots) {
      expect(spent, "a hunt this quiet has no stakes").toBeGreaterThanOrEqual(3);
      expect(spent, "the bot is emptying its warrants mechanically").toBeLessThanOrEqual(10);
    }
    for (const found of caught) expect(found, "a hunt that found nobody").toBeGreaterThan(0);

    const mean = shots.reduce((total, spent) => total + spent, 0) / shots.length;
    expect(mean).toBeGreaterThan(4);
  }, 120_000);

  it("loses the hunt when the thread stalls for longer than the catch-up ceiling", async () => {
    vi.useFakeTimers();
    // This is what the critic's count is consistent with, and it is not a tuning
    // problem. `MAX_CATCH_UP_MS` is how much match time one turn may make up, and
    // anything past it is dropped rather than owed, so a hunt whose turns arrive
    // further apart than that walks a fraction of its own length. The same seeds
    // ticked at four times the ceiling fire well under half as often and catch
    // nobody. Nothing in the bot fixes this; keeping the main thread free does.
    let healthy = 0;
    let stalled = 0;
    let healthyCatches = 0;
    let stalledCatches = 0;
    for (let seed = 1; seed <= 6; seed += 1) {
      const fast = await playOutAt(seed, STEP_MS);
      if (fast.selfWasInspector) continue;
      const slow = await playOutAt(seed, MAX_CATCH_UP_MS * 4);
      healthy += fast.correct + fast.wrong;
      stalled += slow.correct + slow.wrong;
      healthyCatches += fast.hidersCaught;
      stalledCatches += slow.hidersCaught;
    }

    expect(healthyCatches, "the control hunt caught nobody either").toBeGreaterThan(0);
    expect(stalled * 2, "a stalled hunt is no longer measurably worse").toBeLessThan(healthy);
    expect(stalledCatches).toBeLessThan(healthyCatches);
  }, 180_000);

  it("walks to what it shoots rather than reaching across the shop", async () => {
    vi.useFakeTimers();
    const fixture = await soloRound(BOT_INSPECTOR_SEED);
    fixture.runTo(MatchPhase.Inspection);
    const staged = fixture.trail.length;
    fixture.runTo(MatchPhase.Reveal);

    const walk = fixture.trail.slice(staged);
    expect(walk.length).toBeGreaterThan(100);

    // Nothing may cover more ground between two ticks than the room's own
    // walking speed allows. A bot that teleported onto its target would satisfy
    // every authority check and still be cheating.
    const ceiling = (DEFAULT_MATCH_SETTINGS.inspectorMoveSpeed * STEP_MS) / 1_000;
    let longest = 0;
    for (let index = 1; index < walk.length; index += 1) {
      const from = walk[index - 1] as { playerId: string; eye: Vec3Like };
      const to = walk[index] as { playerId: string; eye: Vec3Like };
      if (from.playerId !== to.playerId) continue;
      longest = Math.max(longest, Math.hypot(to.eye.x - from.eye.x, to.eye.z - from.eye.z));
    }
    expect(longest).toBeLessThanOrEqual(ceiling + 1e-6);

    // And it really does leave the Security Office it starts in and cross the
    // shop, rather than pacing the room it was let in through.
    const spanX = Math.max(...walk.map((entry) => entry.eye.x)) - Math.min(...walk.map((entry) => entry.eye.x));
    const spanZ = Math.max(...walk.map((entry) => entry.eye.z)) - Math.min(...walk.map((entry) => entry.eye.z));
    expect(spanX).toBeGreaterThan(8);
    expect(spanZ).toBeGreaterThan(4);

    fixture.dispose();
  });

  it("walks a stalled main thread's missing seconds rather than losing them", async () => {
    vi.useFakeTimers();

    // Two rounds from one seed, identical up to the stall. One is ticked every
    // 100 ms throughout; the other has its main thread taken away for five
    // seconds, which is what a shader compile storm does to this tab, and gets
    // the whole five back in a single tick.
    const healthy = await soloRound(BOT_INSPECTOR_SEED);
    const stalled = await soloRound(BOT_INSPECTOR_SEED);
    for (const fixture of [healthy, stalled]) {
      fixture.runTo(MatchPhase.Inspection);
      // Out of the Security Office and walking before the thread goes away.
      fixture.advance(30);
    }

    const inspectorId = (stalled.trail[stalled.trail.length - 1] as { playerId: string }).playerId;
    const eyes = (fixture: Fixture): readonly Vec3Like[] =>
      fixture.trail.filter((entry) => entry.playerId === inspectorId).map((entry) => entry.eye);
    const startedAt = (eyes(stalled).at(-1) as Vec3Like);

    healthy.advance(STALL_MS / STEP_MS);
    stalled.advanceBy(STALL_MS);

    const control = eyes(healthy);
    const burst = eyes(stalled);
    const groundCovered = (walk: readonly Vec3Like[], from: number): number => {
      let total = 0;
      for (let index = from + 1; index < walk.length; index += 1) {
        const a = walk[index - 1] as Vec3Like;
        const b = walk[index] as Vec3Like;
        total += Math.hypot(b.x - a.x, b.z - a.z);
      }
      return total;
    };

    // The control has to be walking, or the rest of this measures nothing. It
    // covers the ground of an unstalled bot over the same five seconds.
    const controlWalk = groundCovered(control, control.length - 1 - STALL_MS / STEP_MS);
    expect(controlWalk, "the control bot stood still; stall the round elsewhere").toBeGreaterThan(1);

    // The whole stall arrives as one published position, so this single hop is
    // the catch-up. It may not outrun the room's walking speed over the time it
    // is making up. A bot that teleported onto its target would satisfy every
    // authority check and still be cheating.
    const arrivedAt = burst.at(-1) as Vec3Like;
    const hop = Math.hypot(arrivedAt.x - startedAt.x, arrivedAt.z - startedAt.z);
    expect(hop).toBeLessThanOrEqual(
      (DEFAULT_MATCH_SETTINGS.inspectorMoveSpeed * STALL_MS) / 1_000 + 1e-6,
    );

    // And it did catch up, rather than take one callback's step and drop the
    // other 4.9 seconds, which is what the old clamp did: its ceiling was
    // `inspectorMoveSpeed * MAX_STEP_MS`, 0.11 m. The hop measures 2.90 m
    // against 4.45 m of control path, the difference being the corners the
    // route turns, which a straight line between two points does not.
    expect(hop, "the stall cost the bot its walk").toBeGreaterThan(controlWalk * 0.5);
    expect(hop).toBeGreaterThan((DEFAULT_MATCH_SETTINGS.inspectorMoveSpeed * MAX_STEP_MS) / 1_000);

    // It also lands where the unstalled bot did, because the catch-up follows
    // the same planned route at the same speed over the same five seconds. The
    // two agree to 3e-15 m, so this is equality with room for a rounding
    // difference rather than a tolerance covering real divergence.
    const healthyAt = control.at(-1) as Vec3Like;
    expect(Math.hypot(arrivedAt.x - healthyAt.x, arrivedAt.z - healthyAt.z)).toBeLessThan(0.001);

    healthy.dispose();
    stalled.dispose();
  });
});
