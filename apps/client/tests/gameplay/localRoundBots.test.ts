import type { MatchSettingsPatch } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BODY_SLOT_ID } from "../../src/forge/materialAssignment";
import { BOT_HIDE_PLANS, createBotDisguise } from "../../src/gameplay/botDisguises";
import { createLocalRound, type LocalRound } from "../../src/gameplay/localRound";
import { DEFAULT_BODY_SWATCH_ID } from "../../src/mimic/disguiseState";
import { decodeDisguiseState } from "../../src/mimic/poseWire";
import { isSwatchLegalForMimic } from "../../src/mimic/visual/materialSwatches";
import { NAV_DATA } from "../../src/world/maps/nav";

/**
 * The bots of a round the shipping build actually opens.
 *
 * `localRound.test.ts` proves the same claims against a `LocalLoopbackAdapter`
 * it wires by hand, which is a different `botPose` from the one
 * `createLocalRound` installs. That leaves the production wiring itself
 * untested, and the wiring is where a stranger's first round is decided: a bot
 * whose authored pose never reaches the simulation is auto-locked at the
 * deadline into a starting arrangement the §5.8 fallback chooses, which renders
 * as an upright body standing wherever the fallback put it.
 */

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
const BOT_COUNT = 3;
/**
 * Deals the Inspector's role to the local player in a four-seat room, which is
 * what makes every disguise standing in the shop a bot's.
 */
const INSPECTOR_SEED = 10;
/** Millimetres. The wire quantises, so an authored root arrives near, not exact. */
const WIRE_TOLERANCE_M = 0.01;

/**
 * Whether a published root is the hiding place `index` was authored for.
 *
 * A restless bot has already crept some way along its fidget by the time the
 * hunt opens, so the test is against the segment the plan authorises rather
 * than against its far end: anywhere between where the body locked and the full
 * extent of the offset is the plan being obeyed, and anywhere else is not.
 */
function matchesPlan(index: number, root: readonly number[]): boolean {
  const plan = BOT_HIDE_PLANS[index];
  const locked = createBotDisguise(index).root.position;
  if (plan === undefined) return false;
  return [0, 1, 2].every((axis) => {
    const from = locked[axis] ?? 0;
    const to = from + (plan.creepOffset[axis] ?? 0);
    const value = root[axis] ?? 0;
    return (
      value >= Math.min(from, to) - WIRE_TOLERANCE_M &&
      value <= Math.max(from, to) + WIRE_TOLERANCE_M
    );
  });
}

/** Drives a real `createLocalRound` to the hunt and hands back what it published. */
async function huntedRound(): Promise<LocalRound> {
  let clock = 0;
  const round = createLocalRound({
    seed: INSPECTOR_SEED,
    bots: BOT_COUNT,
    settings: FAST_SETTINGS,
    now: () => clock,
  });
  await round.adapter.join("practice", "Curator");

  round.adapter.sendCommand({ type: "player_ready", ready: true });
  clock += STEP_MS;
  round.adapter.step();
  round.adapter.sendCommand({ type: "start_match" });

  for (let step = 0; step < 200; step += 1) {
    const phase = round.adapter.getSync().publicState?.phase;
    if (phase === MatchPhase.Inspection) return round;
    if (phase === MatchPhase.Lobby || phase === MatchPhase.Loading) {
      round.adapter.sendCommand({ type: "player_ready", ready: true });
    }
    clock += STEP_MS;
    round.adapter.step();
  }
  round.dispose();
  throw new Error("the round never reached the hunt");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the bots of a round the shipping build opens", () => {
  it("folds every bot into an authored hiding place, not the fallback", async () => {
    vi.useFakeTimers();
    const round = await huntedRound();

    expect(round.adapter.getSync().privateState?.role).toBe("inspector");
    const disguises = round.adapter.getSync().publicState?.disguises ?? [];
    expect(disguises).toHaveLength(BOT_COUNT);

    const spawns = NAV_DATA.spawnPoints.mimics;
    const taken = new Set<string>();

    for (const disguise of disguises) {
      // A fallback disguise names an arrangement and carries no pose; an
      // authored one is the other way round.
      expect(disguise.defaultArrangementId).toBeNull();
      expect(disguise.encodedPose.length).toBeGreaterThan(0);

      const decoded = decodeDisguiseState(disguise.encodedPose);
      expect(decoded).not.toBeNull();
      const root = decoded?.root.position ?? [0, 0, 0];

      const plan = BOT_HIDE_PLANS.findIndex((_entry, index) => matchesPlan(index, root));
      expect(plan, `root ${root.join(",")} is no authored hiding place`).toBeGreaterThanOrEqual(0);
      taken.add(String(plan));

      // The two ways a body ends up standing where nobody chose to hide it: at
      // the spawn the round dealt it, or at the origin the §5.8 fallback uses.
      // Measured in three dimensions, because the bay under the workshop bench
      // and the spawn on top of it differ by height alone.
      for (const spawn of spawns) {
        expect(
          Math.hypot(
            spawn.position.x - (root[0] ?? 0),
            spawn.position.y - (root[1] ?? 0),
            spawn.position.z - (root[2] ?? 0),
          ),
        ).toBeGreaterThan(WIRE_TOLERANCE_M);
      }
      expect(Math.hypot(root[0] ?? 0, root[2] ?? 0)).toBeGreaterThan(WIRE_TOLERANCE_M);
    }

    // Two bots in one hiding place is one bot in the open.
    expect(taken.size).toBe(BOT_COUNT);
    round.dispose();
  });

  it("gives each bot the arrangement its hiding place was authored for", async () => {
    vi.useFakeTimers();
    const round = await huntedRound();
    const disguises = round.adapter.getSync().publicState?.disguises ?? [];

    for (const disguise of disguises) {
      const decoded = decodeDisguiseState(disguise.encodedPose);
      const root = decoded?.root.position ?? [0, 0, 0];
      const index = BOT_HIDE_PLANS.findIndex((_entry, candidate) =>
        matchesPlan(candidate, root),
      );
      expect(index).toBeGreaterThanOrEqual(0);

      // The body wears the arrangement its hiding place was authored for,
      // joint for joint. An upright fallback body would not.
      const authored = createBotDisguise(index);
      expect(decoded?.joints).toEqual(authored.joints);
      expect(decoded?.segments).toEqual(authored.segments);
    }

    round.dispose();
  });

  it("finishes every bot in something the room owns, never the default shell", async () => {
    vi.useFakeTimers();
    const round = await huntedRound();
    const disguises = round.adapter.getSync().publicState?.disguises ?? [];
    expect(disguises).toHaveLength(BOT_COUNT);

    for (const disguise of disguises) {
      const decoded = decodeDisguiseState(disguise.encodedPose);
      const body = decoded?.materials.find((entry) => entry.slotId === BODY_SLOT_ID);
      expect(body, "a bot published no body finish at all").toBeDefined();
      // The regression: a bot samples no colour of its own, so it used to reach
      // the hunt in the porcelain every Mimic starts in. A white shell on brown
      // floorboards is picked out from across the shop whatever shape it is in.
      expect(body?.swatchId).not.toBe(DEFAULT_BODY_SWATCH_ID);
      expect(isSwatchLegalForMimic(body?.swatchId ?? "")).toBe(true);
    }

    round.dispose();
  });

  it("authors a legal finish for every hiding place, not just the three in play", () => {
    for (const [index, plan] of BOT_HIDE_PLANS.entries()) {
      expect(
        isSwatchLegalForMimic(plan.swatchId),
        `${plan.note}: ${plan.swatchId} is not a swatch a Mimic may wear`,
      ).toBe(true);
      expect(plan.swatchId).not.toBe(DEFAULT_BODY_SWATCH_ID);
      expect(createBotDisguise(index).materials).toEqual([
        { slotId: BODY_SLOT_ID, swatchId: plan.swatchId },
      ]);
    }
  });
});
