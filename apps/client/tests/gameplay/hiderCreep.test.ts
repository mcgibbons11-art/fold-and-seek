import type { CommandRejection } from "../../src/networking/NetworkAdapter";
import type { MatchSettingsPatch } from "@foldseek/game-sim";
import { DEFAULT_MATCH_SETTINGS, JUMP_HEIGHT_M, MatchPhase } from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { humanMimicSpawn, createBotDisguisePayload } from "../../src/gameplay/botDisguises";
import { RoundSpatialBridge } from "../../src/gameplay/roundSpatial";
import { HiderLocomotion } from "../../src/forge/HiderLocomotion";
import { createStarterArrangement } from "../../src/mimic/disguiseState";
import { decodeDisguiseState, encodeDisguiseState } from "../../src/mimic/poseWire";
import { LocalLoopbackAdapter } from "../../src/networking/LocalLoopbackAdapter";
import type { MutableVec3 } from "../../src/inspector/navData";
import { NAV_DATA } from "../../src/world/maps/nav";
import { buildObjectRegistry } from "../../src/world/maps/registry";

/**
 * The seam between the creep a player steers and the creep the authority will
 * accept. `MatchSimulation.validateCreep` measures a straight line from the last
 * pose it took against the time since and refuses anything over
 * `hiderCreepSpeed`; `HiderLocomotion` caps the same motion locally so that
 * refusal never happens. This drives both through the real loopback, at the
 * publication interval `RoundSession` uses, and fails if a single update comes
 * back refused.
 */

const FAST_SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 20_000,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
};

/**
 * One frame of the client's loop. Fifty hertz rather than a round number of
 * milliseconds-per-tick, because the arc of a hop has to be sampled at
 * something like the rate a browser samples it: at 100 ms frames the arc is so
 * under-sampled that its apex fits inside the creep budget by accident, and the
 * mid-air publication test below passes for the wrong reason.
 */
const FRAME_MS = 20;
/** `RoundSession.POSE_PUBLISH_INTERVAL_MS`, restated as frames. */
const FRAMES_PER_PUBLISH = 25;
/** Ten seconds of holding a key, which is most of a creep across the shop. */
const HELD_FRAMES = 500;
const BOT_COUNT = 3;
/**
 * Roles come off a seeded shuffle. This seat deals the local player a Mimic in a
 * four-seat room, which is the only role that has a body to creep.
 */
const MIMIC_SEED = 1;

interface Fixture {
  readonly adapter: LocalLoopbackAdapter;
  readonly rejections: CommandRejection[];
  now(): number;
  advance(frames: number): void;
  runTo(phase: MatchPhase, maxSteps?: number): void;
}

function createFixture(): Fixture {
  let clock = 0;
  const spatial = new RoundSpatialBridge();
  const rejections: CommandRejection[] = [];
  const adapter = new LocalLoopbackAdapter({
    settings: FAST_SETTINGS,
    seed: MIMIC_SEED,
    now: () => clock,
    spatial: spatial.validator,
    objectRegistry: buildObjectRegistry(),
    botPose: (index) => createBotDisguisePayload(index),
  });
  adapter.onRejection((rejection) => rejections.push(rejection));

  const fixture: Fixture = {
    adapter,
    rejections,
    now: () => clock,
    advance(frames: number) {
      for (let index = 0; index < frames; index += 1) {
        clock += FRAME_MS;
        adapter.step();
      }
    },
    runTo(phase: MatchPhase, maxSteps = 200) {
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

/** The disguise this client locks, standing on the map's own Mimic spawn. */
function lockedPoseAt(position: MutableVec3, revision: number): string {
  const state = createStarterArrangement("upright");
  state.root.position = [position.x, position.y, position.z];
  state.revision = revision;
  return encodeDisguiseState(state);
}

/** Where the room currently has this player's disguise standing. */
function publishedRoot(adapter: LocalLoopbackAdapter): MutableVec3 {
  const own = adapter.getSync().privateState?.ownDisguise?.publicObjectId ?? null;
  const disguise = (adapter.getSync().publicState?.disguises ?? []).find(
    (entry) => entry.publicObjectId === own,
  );
  if (disguise === undefined) throw new Error("this client has no disguise in the room");
  const decoded = decodeDisguiseState(disguise.encodedPose);
  if (decoded === null) throw new Error("the room is holding a pose it cannot decode");
  const [x = 0, y = 0, z = 0] = decoded.root.position;
  return { x, y, z };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a hider creeping through the hunt", () => {
  it("is never refused for moving too fast over a straight-line creep", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    for (let index = 0; index < BOT_COUNT; index += 1) fixture.adapter.addBot({ autoPlay: true });
    await fixture.adapter.join("practice", "Curator");

    fixture.adapter.sendCommand({ type: "player_ready", ready: true });
    fixture.advance(1);
    fixture.adapter.sendCommand({ type: "start_match" });
    fixture.runTo(MatchPhase.Forge);

    expect(fixture.adapter.getSync().privateState?.role).toBe("mimic");

    const spawn = humanMimicSpawn().position;
    const root: MutableVec3 = { x: spawn.x, y: spawn.y, z: spawn.z };
    let revision = 2;
    fixture.adapter.sendCommand({
      type: "lock_disguise",
      payload: lockedPoseAt(root, revision),
      revision,
    });

    fixture.runTo(MatchPhase.Inspection);
    expect(fixture.rejections).toEqual([]);

    // The client caps itself at exactly the number the authority checks, which
    // is where a rubber-band would come from if the two ever disagreed.
    const locomotion = new HiderLocomotion(NAV_DATA);
    locomotion.setCreepLimit(DEFAULT_MATCH_SETTINGS.hiderCreepSpeed);
    locomotion.press("w");

    const start = { ...root };
    const frames = HELD_FRAMES;
    for (let frame = 1; frame <= frames; frame += 1) {
      fixture.advance(1);
      locomotion.update(FRAME_MS / 1_000, 0, root);
      if (frame % FRAMES_PER_PUBLISH !== 0) continue;
      revision += 1;
      fixture.adapter.sendForgeSnapshot({ encodedPose: lockedPoseAt(root, revision), revision });
    }

    expect(fixture.rejections).toEqual([]);

    // And the creep was real. It covers less than the whole budget because the
    // shop stops it: ten seconds of creeping is 1.75 m and this spawn has
    // furniture in front of it, which is the point of walking the nav data.
    const elapsedSeconds = (frames * FRAME_MS) / 1_000;
    const budget = DEFAULT_MATCH_SETTINGS.hiderCreepSpeed * elapsedSeconds;
    const roomRoot = publishedRoot(fixture.adapter);
    const travelled = Math.hypot(roomRoot.x - start.x, roomRoot.y - start.y, roomRoot.z - start.z);

    expect(travelled).toBeGreaterThan(budget / 2);
    expect(travelled).toBeLessThanOrEqual(budget);

    // The rubber-band test: the body the player is steering and the body the
    // room is showing are in the same place, to the wire's own precision.
    expect(roomRoot.x).toBeCloseTo(root.x, 3);
    expect(roomRoot.y).toBeCloseTo(root.y, 3);
    expect(roomRoot.z).toBeCloseTo(root.z, 3);

    fixture.adapter.dispose();
  });

  it("hops without the authority refusing it", async () => {
    // CLAUDE.md override 6. A hop is root motion like any other and the
    // authority measures it in three dimensions, so the apex is further from
    // the last accepted pose than the creep cap allows. Two things keep it
    // legal: the hop lands on the height it left, and `RoundSession` holds the
    // publication while the body is off the ground, which is what this
    // reproduces by publishing only when the locomotion says it has landed.
    vi.useFakeTimers();
    const fixture = createFixture();
    for (let index = 0; index < BOT_COUNT; index += 1) fixture.adapter.addBot({ autoPlay: true });
    await fixture.adapter.join("practice", "Curator");

    fixture.adapter.sendCommand({ type: "player_ready", ready: true });
    fixture.advance(1);
    fixture.adapter.sendCommand({ type: "start_match" });
    fixture.runTo(MatchPhase.Forge);

    const spawn = humanMimicSpawn().position;
    const root: MutableVec3 = { x: spawn.x, y: spawn.y, z: spawn.z };
    let revision = 2;
    fixture.adapter.sendCommand({
      type: "lock_disguise",
      payload: lockedPoseAt(root, revision),
      revision,
    });
    fixture.runTo(MatchPhase.Inspection);
    expect(fixture.rejections).toEqual([]);

    const locomotion = new HiderLocomotion(NAV_DATA);
    locomotion.setCreepLimit(DEFAULT_MATCH_SETTINGS.hiderCreepSpeed);
    locomotion.press("w");
    locomotion.press(" ");

    let apexY = root.y;
    let hops = 0;
    let wasAirborne = false;
    for (let frame = 1; frame <= HELD_FRAMES; frame += 1) {
      fixture.advance(1);
      locomotion.update(FRAME_MS / 1_000, 0, root);
      apexY = Math.max(apexY, root.y);
      if (locomotion.airborne && !wasAirborne) hops += 1;
      wasAirborne = locomotion.airborne;
      if (frame % FRAMES_PER_PUBLISH !== 0 || locomotion.airborne) continue;
      revision += 1;
      fixture.adapter.sendForgeSnapshot({ encodedPose: lockedPoseAt(root, revision), revision });
    }

    // It really did leave the ground, repeatedly, and came back to it. The apex
    // falls a little short of `JUMP_HEIGHT_M` because a discrete arc always
    // undershoots the analytic one; the height itself is measured at 60 Hz in
    // `jump.test.ts`. What matters here is that a hop the authority would have
    // refused mid-flight was accepted at both ends of itself.
    expect(hops).toBeGreaterThan(2);
    expect(apexY).toBeGreaterThan(spawn.y + JUMP_HEIGHT_M * 0.8);
    expect(apexY).toBeLessThanOrEqual(spawn.y + JUMP_HEIGHT_M);
    expect(fixture.rejections).toEqual([]);
    expect(publishedRoot(fixture.adapter).y).toBeCloseTo(spawn.y, 6);

    fixture.adapter.dispose();
  });

  it("would be refused if the round published a pose in mid-air", async () => {
    // The other half of the hop's legality, and the reason `RoundSession` holds
    // its publication while `bodyAirborne` is true. The same hop, published on
    // the interval regardless of whether the body is off the ground.
    vi.useFakeTimers();
    const fixture = createFixture();
    for (let index = 0; index < BOT_COUNT; index += 1) fixture.adapter.addBot({ autoPlay: true });
    await fixture.adapter.join("practice", "Curator");

    fixture.adapter.sendCommand({ type: "player_ready", ready: true });
    fixture.advance(1);
    fixture.adapter.sendCommand({ type: "start_match" });
    fixture.runTo(MatchPhase.Forge);

    const spawn = humanMimicSpawn().position;
    const root: MutableVec3 = { x: spawn.x, y: spawn.y, z: spawn.z };
    let revision = 2;
    fixture.adapter.sendCommand({
      type: "lock_disguise",
      payload: lockedPoseAt(root, revision),
      revision,
    });
    fixture.runTo(MatchPhase.Inspection);

    const locomotion = new HiderLocomotion(NAV_DATA);
    locomotion.setCreepLimit(DEFAULT_MATCH_SETTINGS.hiderCreepSpeed);
    locomotion.press(" ");

    for (let frame = 1; frame <= HELD_FRAMES; frame += 1) {
      fixture.advance(1);
      locomotion.update(FRAME_MS / 1_000, 0, root);
      if (frame % FRAMES_PER_PUBLISH !== 0) continue;
      revision += 1;
      fixture.adapter.sendForgeSnapshot({ encodedPose: lockedPoseAt(root, revision), revision });
    }

    expect(fixture.rejections.map((rejection) => rejection.reason)).toContain("moved_too_fast");

    fixture.adapter.dispose();
  });

  it("is refused the moment the same creep is driven at the Forge run speed", async () => {
    // The other half of the claim: the authority really is checking, so the
    // local cap is what is keeping the round clean rather than a dead rule.
    vi.useFakeTimers();
    const fixture = createFixture();
    for (let index = 0; index < BOT_COUNT; index += 1) fixture.adapter.addBot({ autoPlay: true });
    await fixture.adapter.join("practice", "Curator");

    fixture.adapter.sendCommand({ type: "player_ready", ready: true });
    fixture.advance(1);
    fixture.adapter.sendCommand({ type: "start_match" });
    fixture.runTo(MatchPhase.Forge);

    const spawn = humanMimicSpawn().position;
    const root: MutableVec3 = { x: spawn.x, y: spawn.y, z: spawn.z };
    let revision = 2;
    fixture.adapter.sendCommand({
      type: "lock_disguise",
      payload: lockedPoseAt(root, revision),
      revision,
    });
    fixture.runTo(MatchPhase.Inspection);

    // No creep limit: the body runs at the Forge speed it has while folding.
    const locomotion = new HiderLocomotion(NAV_DATA);
    locomotion.press("w");

    for (let frame = 1; frame <= FRAMES_PER_PUBLISH * 4; frame += 1) {
      fixture.advance(1);
      locomotion.update(FRAME_MS / 1_000, 0, root);
      if (frame % FRAMES_PER_PUBLISH !== 0) continue;
      revision += 1;
      fixture.adapter.sendForgeSnapshot({ encodedPose: lockedPoseAt(root, revision), revision });
    }

    expect(fixture.rejections.map((rejection) => rejection.reason)).toContain("moved_too_fast");

    fixture.adapter.dispose();
  });
});
