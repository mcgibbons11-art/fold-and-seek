import type { MatchSettingsPatch } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotDisguise, createBotDisguisePayload } from "../../src/gameplay/botDisguises";
import { RoundSpatialBridge } from "../../src/gameplay/roundSpatial";
import { decodeDisguiseState } from "../../src/mimic/poseWire";
import { LocalLoopbackAdapter } from "../../src/networking/LocalLoopbackAdapter";
import { TEST_ROOM_WORKSPACE } from "../../src/forge/ForgeController";
import { NAV_DATA } from "../../src/world/maps/nav";
import { buildObjectRegistry, CURIOSITY_SHOP_OBJECTS } from "../../src/world/maps/registry";
import { SHOP_MAX_X, SHOP_MIN_X, WALL_HEIGHT } from "../../src/world/maps/zones";
import { SHOP_FORGE_WORKSPACE } from "../../src/world/ShopWorld";

/**
 * A solo round has to put real objects in the room: without an authored bot
 * pose the simulation falls back to a starting arrangement at the world origin,
 * and an Inspector walks a shop with nothing in it to find. These tests drive
 * the loopback the client actually uses, with the same registry, validator and
 * bot poses, and read back what the room would show.
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
 * Roles are assigned from a seeded shuffle, so the seed decides who inspects.
 * This one hands the Inspector role to the local player in a four-seat room,
 * which is what makes every disguise in the shop a bot's.
 */
const INSPECTOR_SEED = 10;

interface Fixture {
  readonly adapter: LocalLoopbackAdapter;
  advance(steps: number): void;
  runTo(phase: MatchPhase, maxSteps?: number): void;
}

function createFixture(): Fixture {
  let clock = 0;
  const spatial = new RoundSpatialBridge();
  const adapter = new LocalLoopbackAdapter({
    settings: FAST_SETTINGS,
    seed: INSPECTOR_SEED,
    now: () => clock,
    spatial: spatial.validator,
    objectRegistry: buildObjectRegistry(),
    botPose: (index) => createBotDisguisePayload(index),
  });

  const fixture: Fixture = {
    adapter,
    advance(steps: number) {
      for (let index = 0; index < steps; index += 1) {
        clock += STEP_MS;
        adapter.step();
      }
    },
    runTo(phase: MatchPhase, maxSteps = 120) {
      for (let index = 0; index < maxSteps; index += 1) {
        const current = adapter.getSync().publicState?.phase;
        if (current === phase) return;
        if (current === MatchPhase.Lobby || current === MatchPhase.Loading) {
          adapter.sendCommand({ type: "player_ready", ready: true });
        }
        fixture.advance(1);
      }
      throw new Error(
        `phase ${phase} not reached; stopped at ${String(adapter.getSync().publicState?.phase)}`,
      );
    },
  };
  return fixture;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bot disguises", () => {
  it("stands every bot somewhere different, in a place the map allows", () => {
    const spatial = new RoundSpatialBridge();
    const seen = new Set<string>();

    for (let index = 0; index < 6; index += 1) {
      const disguise = createBotDisguise(index);
      const position = disguise.root.position;
      const decision = spatial.validator.canOccupy(`bot-${index}`, [
        position[0],
        position[1],
        position[2],
      ]);
      expect(decision.ok, `bot ${index}: ${decision.ok ? "" : (decision.reason ?? "")}`).toBe(true);
      seen.add(position.join(","));
    }

    expect(seen.size).toBe(6);
  });

  it("never draws an arrangement that needs a surface it was not placed against", () => {
    for (let index = 0; index < 8; index += 1) {
      const decoded = decodeDisguiseState(createBotDisguisePayload(index));
      expect(decoded).not.toBeNull();
      // A bot seals no anchors, so an arrangement that only reads when it is
      // mounted or shelved would hang in mid-air.
      expect(decoded?.anchors).toHaveLength(0);
    }
  });
});

describe("the Forge workspace", () => {
  /**
   * The Forge clamps the body into its workspace. Left at the practice room's
   * size it would drag a Mimic off the far half of the shop, so the volume has
   * to come from the map the round is actually played on.
   */
  it("covers the shop wall to wall, where the practice room's does not", () => {
    for (const spawn of NAV_DATA.spawnPoints.mimics) {
      const { x, y, z } = spawn.position;
      expect(x, "spawn outside the shop workspace").toBeGreaterThanOrEqual(SHOP_FORGE_WORKSPACE.minX);
      expect(x).toBeLessThanOrEqual(SHOP_FORGE_WORKSPACE.maxX);
      expect(z).toBeGreaterThanOrEqual(SHOP_FORGE_WORKSPACE.minZ);
      expect(z).toBeLessThanOrEqual(SHOP_FORGE_WORKSPACE.maxZ);
      expect(y).toBeLessThanOrEqual(SHOP_FORGE_WORKSPACE.maxY);
    }

    // The regression this guards: several spawns sit outside the old box.
    const stranded = NAV_DATA.spawnPoints.mimics.filter(
      (spawn) =>
        spawn.position.x < TEST_ROOM_WORKSPACE.minX ||
        spawn.position.x > TEST_ROOM_WORKSPACE.maxX ||
        spawn.position.z < TEST_ROOM_WORKSPACE.minZ ||
        spawn.position.z > TEST_ROOM_WORKSPACE.maxZ,
    );
    expect(stranded.length).toBeGreaterThan(0);
  });

  it("reaches the walls rather than stopping short of them", () => {
    // Mounting on a wall is a legal disguise, so the volume ends at the faces.
    expect(SHOP_FORGE_WORKSPACE.minX).toBe(SHOP_MIN_X);
    expect(SHOP_FORGE_WORKSPACE.maxX).toBe(SHOP_MAX_X);
    expect(SHOP_FORGE_WORKSPACE.maxY).toBe(WALL_HEIGHT);
  });
});

describe("a solo local round", () => {
  it("carries the human player and three bots from the lobby to the hunt", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    for (let index = 0; index < BOT_COUNT; index += 1) fixture.adapter.addBot({ autoPlay: true });
    await fixture.adapter.join("practice", "Curator");

    fixture.adapter.sendCommand({ type: "player_ready", ready: true });
    fixture.advance(1);
    fixture.adapter.sendCommand({ type: "start_match" });
    fixture.runTo(MatchPhase.Inspection);

    const state = fixture.adapter.getSync();
    expect(state.privateState?.role).toBe("inspector");
    expect(state.publicState?.disguises).toHaveLength(BOT_COUNT);
    expect(state.publicState?.warrantsRemaining).toBeGreaterThan(0);

    fixture.adapter.dispose();
  });

  it("locks each bot into its authored pose rather than the origin fallback", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    for (let index = 0; index < BOT_COUNT; index += 1) fixture.adapter.addBot({ autoPlay: true });
    await fixture.adapter.join("practice", "Curator");

    fixture.adapter.sendCommand({ type: "player_ready", ready: true });
    fixture.advance(1);
    fixture.adapter.sendCommand({ type: "start_match" });
    fixture.runTo(MatchPhase.Inspection);

    const disguises = fixture.adapter.getSync().publicState?.disguises ?? [];
    const positions = new Set<string>();
    for (const disguise of disguises) {
      expect(disguise.defaultArrangementId).toBeNull();
      const decoded = decodeDisguiseState(disguise.encodedPose);
      expect(decoded).not.toBeNull();
      const position = decoded?.root.position ?? [0, 0, 0];
      expect(Math.hypot(position[0] ?? 0, position[2] ?? 0)).toBeGreaterThan(0);
      positions.add(position.join(","));
    }
    expect(positions.size).toBe(disguises.length);

    fixture.adapter.dispose();
  });

  it("publishes the shop's own props as the only accusable targets", () => {
    const registry = buildObjectRegistry();
    const allowed = CURIOSITY_SHOP_OBJECTS.filter(
      (entry) => entry.accusationPolicy === "allowed",
    ).map((entry) => entry.objectId);

    expect(registry.objects.map((entry) => entry.objectId)).toEqual(allowed);
    expect(registry.objects.length).toBeGreaterThan(0);
  });
});
