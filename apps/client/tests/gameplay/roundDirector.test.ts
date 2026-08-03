import type { MatchSettingsPatch } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoundActions } from "../../src/gameplay/RoundActions";
import { RoundDirector } from "../../src/gameplay/RoundDirector";
import type { RoundViewState } from "../../src/gameplay/roundView";
import { LocalLoopbackAdapter } from "../../src/networking/LocalLoopbackAdapter";

/**
 * Drives a whole round through the loopback and reads it back through the view
 * state, which is the only surface the HUD sees. Pacing is compressed so a full
 * match takes a few dozen stepped ticks; the lock grace floor of one second is
 * a simulation constant and cannot be compressed, so Locking always costs ten.
 */

const SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 2_000,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
  wrongAccusationCooldownMs: 0,
};

const STEP_MS = 100;
const BOT_COUNT = 2;
/**
 * Role assignment breaks its ties on a seeded shuffle, so the seed decides who
 * inspects. This one hands the Inspector role to the local player, which is
 * what the accusation tests need.
 */
const INSPECTOR_SEED = 4;
/** The complement of the above: here the local player hides. */
const MIMIC_SEED = 11;
/** The simulation numbers the first round zero and counts up from a rematch. */
const FIRST_ROUND = 0;

interface Fixture {
  readonly adapter: LocalLoopbackAdapter;
  readonly director: RoundDirector;
  readonly actions: RoundActions;
  readonly states: RoundViewState[];
  advance(steps: number): void;
  runTo(phase: MatchPhase, maxSteps?: number): void;
  state(): RoundViewState;
  phases(): readonly MatchPhase[];
  dispose(): void;
}

interface FixtureOptions {
  readonly seed?: number;
  /** Milliseconds the authority's clock leads this machine's clock by. */
  readonly serverClockLeadMs?: number;
}

function createFixture(options: FixtureOptions = {}): Fixture {
  let clock = 0;
  const lead = options.serverClockLeadMs ?? 0;
  const adapter = new LocalLoopbackAdapter({
    settings: SETTINGS,
    seed: options.seed ?? INSPECTOR_SEED,
    // The simulation runs on the authority's clock, which leads this machine's.
    now: () => clock + lead,
  });
  const director = new RoundDirector(adapter, { now: () => clock, tickIntervalMs: 0 });
  const states: RoundViewState[] = [];
  director.subscribe((state) => states.push(state));

  const fixture: Fixture = {
    adapter,
    director,
    actions: new RoundActions(adapter, director),
    states,
    advance(steps: number) {
      for (let index = 0; index < steps; index += 1) {
        clock += STEP_MS;
        adapter.step();
        director.tick();
      }
    },
    runTo(phase: MatchPhase, maxSteps = 120) {
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
    state: () => director.getState(),
    phases: () => states.map((entry) => entry.phase),
    dispose() {
      director.dispose();
      adapter.dispose();
    },
  };
  return fixture;
}

async function seatedFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const fixture = createFixture(options);
  for (let index = 0; index < BOT_COUNT; index += 1) fixture.adapter.addBot();
  await fixture.adapter.join("practice", "Curator");
  return fixture;
}

/** Starts the match and returns once the round is under way. */
async function startedFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const fixture = await seatedFixture(options);
  fixture.actions.ready(true);
  fixture.advance(1);
  fixture.actions.startMatch();
  return fixture;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RoundDirector", () => {
  it("carries a round through every phase with the copy deck and a live countdown", async () => {
    vi.useFakeTimers();
    const fixture = await seatedFixture();
    expect(fixture.state().phase).toBe(MatchPhase.Lobby);

    fixture.actions.ready(true);
    fixture.advance(1);
    fixture.actions.startMatch();
    fixture.runTo(MatchPhase.Forge);

    const forge = fixture.state();
    expect(forge.phaseLabel).toBe("FOLD");
    expect(forge.timer.running).toBe(true);
    expect(forge.timer.remainingMs).toBeGreaterThan(0);
    expect(forge.timer.remainingMs).toBeLessThanOrEqual(SETTINGS.forgeMs ?? 0);
    expect(forge.timer.totalMs).toBe(SETTINGS.forgeMs);
    expect(forge.self.role).not.toBeNull();
    expect(forge.round).toBe(FIRST_ROUND);

    fixture.runTo(MatchPhase.Inspection);
    const inspection = fixture.state();
    // Two Mimics plus the default bonus of two warrants (§5.11).
    expect(inspection.warrantsTotal).toBe(BOT_COUNT + 2);
    expect(inspection.warrantsRemaining).toBe(BOT_COUNT + 2);
    expect(inspection.mimicsRemaining).toBe(BOT_COUNT);
    expect(inspection.reveal.entries).toHaveLength(BOT_COUNT);

    fixture.runTo(MatchPhase.Results, 200);

    const seen = new Set(fixture.phases());
    for (const phase of [
      MatchPhase.Lobby,
      MatchPhase.Loading,
      MatchPhase.MapIntro,
      MatchPhase.RoleReveal,
      MatchPhase.Forge,
      MatchPhase.Locking,
      MatchPhase.InspectionIntro,
      MatchPhase.Inspection,
      MatchPhase.FinalCountdown,
      MatchPhase.Reveal,
      MatchPhase.Results,
    ]) {
      expect(seen.has(phase), `phase ${phase} was never published`).toBe(true);
    }

    const results = fixture.state().results;
    expect(results).not.toBeNull();
    expect(results?.rows).toHaveLength(BOT_COUNT + 1);
    expect(results?.rows.filter((row) => row.isSelf)).toHaveLength(1);
    expect(fixture.state().phaseLabel).toBe("RESULTS");

    fixture.dispose();
  });

  it("names the phases the copy deck names and leaves the others unnamed", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture();
    const labelled = new Map<MatchPhase, string | null>();
    fixture.runTo(MatchPhase.Results, 200);
    for (const state of fixture.states) labelled.set(state.phase, state.phaseLabel);

    expect(labelled.has(MatchPhase.BaselineScan)).toBe(false);
    expect(labelled.get(MatchPhase.Forge)).toBe("FOLD");
    expect(labelled.get(MatchPhase.Locking)).toBe("LOCKING THE LIES");
    expect(labelled.get(MatchPhase.InspectionIntro)).toBe("INSPECTION BEGINS");
    expect(labelled.get(MatchPhase.FinalCountdown)).toBe("TEN SECONDS");
    expect(labelled.get(MatchPhase.Reveal)).toBe("THE ROOM CONFESSES");
    expect(labelled.get(MatchPhase.Results)).toBe("RESULTS");
    expect(labelled.get(MatchPhase.Lobby)).toBeNull();
    expect(labelled.get(MatchPhase.RoleReveal)).toBeNull();

    fixture.dispose();
  });

  it("stamps the accusation feed from §41.4 and §41.5", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture();
    fixture.runTo(MatchPhase.Inspection);
    expect(fixture.state().self.role).toBe("inspector");

    const target = fixture.state().reveal.entries[0];
    expect(target).toBeDefined();
    if (!target) throw new Error("no disguise to accuse");

    expect(fixture.actions.accuse(target.publicObjectId)).toEqual({ sent: true });
    fixture.advance(1);

    const caught = fixture.state().accusations[0];
    expect(caught?.correct).toBe(true);
    expect(caught?.byMe).toBe(true);
    expect(caught?.stamp).toBe("MIMIC FOUND");
    expect(caught?.revealedDisplayName).not.toBeNull();
    expect(fixture.state().mimicsRemaining).toBe(BOT_COUNT - 1);

    // The correct-accusation cooldown is a simulation constant of 450 ms.
    fixture.advance(6);
    expect(fixture.actions.accuse("prop-lamp")).toEqual({ sent: true });
    fixture.advance(1);

    const wrong = fixture.state().accusations[0];
    expect(wrong?.correct).toBe(false);
    expect(wrong?.reactionId).toBe("lamp_turns_on");
    expect(wrong?.stamp).toBe("INNOCENT LAMP");
    expect(wrong?.warrantsRemaining).toBe(BOT_COUNT + 1);
    expect(fixture.state().accusations[1]?.stamp).toBe("MIMIC FOUND");

    fixture.dispose();
  });

  it("surfaces a refusal from the authority and refuses an illegal verb locally", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture();
    fixture.runTo(MatchPhase.Inspection);

    // Straight to the adapter, bypassing the client-side mirror, so the
    // authority is the one doing the refusing.
    fixture.adapter.sendCommand({ type: "accuse", targetObjectId: "no-such-object" });
    fixture.advance(1);

    const rejection = fixture.state().rejections[0];
    expect(rejection?.commandType).toBe("accuse");
    expect(rejection?.reason).toBe("target_unknown");

    const before = fixture.state().rejections.length;
    expect(fixture.actions.startMatch()).toEqual({ sent: false, reason: "wrong_phase" });
    expect(fixture.actions.lockDisguise("anything", 1)).toEqual({
      sent: false,
      reason: "wrong_phase",
    });
    fixture.advance(1);
    // A locally refused verb never reaches the authority, so nothing new is
    // rejected.
    expect(fixture.state().rejections.length).toBe(before);

    fixture.dispose();
  });

  it("runs a second round through the same director after a rematch", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture();
    fixture.runTo(MatchPhase.Results, 200);

    expect(fixture.state().round).toBe(FIRST_ROUND);
    expect(fixture.state().results).not.toBeNull();

    expect(fixture.actions.voteRematch(true)).toEqual({ sent: true });
    expect(fixture.state().rematch.myVote).toBe(true);
    expect(fixture.state().rematch.yesVotes).toBe(1);
    // A second vote from the same player is refused before it is sent.
    expect(fixture.actions.voteRematch(true)).toEqual({ sent: false, reason: "duplicate_vote" });

    // Nobody votes on the bots' behalf. They answer a rematch by following the
    // people in the room, and one yes among one person is a majority of them,
    // so the two bots say yes on the next tick of their own accord.
    fixture.advance(1);
    expect(fixture.state().rematch.yesVotes).toBe(3);
    expect(fixture.state().rematch.totalVoters).toBe(3);

    fixture.runTo(MatchPhase.RoleReveal, 200);
    const second = fixture.state();
    expect(second.round).toBe(FIRST_ROUND + 1);
    expect(second.results).toBeNull();
    expect(second.accusations).toHaveLength(0);
    expect(second.rematch.myVote).toBeNull();
    // The allowance is stated by the public state and reads zero until the
    // inspection of the new round opens.
    expect(second.warrantsTotal).toBe(0);

    fixture.runTo(MatchPhase.Inspection, 200);
    expect(fixture.state().warrantsTotal).toBe(BOT_COUNT + 2);
    expect(fixture.state().self.role).not.toBeNull();

    fixture.dispose();
  });

  it("does not show a ready acknowledgement that arrives after host start", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture();
    fixture.runTo(MatchPhase.Forge);

    fixture.adapter.sendCommand({ type: "player_ready", ready: true });
    fixture.advance(1);

    expect(fixture.state().rejections).toHaveLength(0);
    fixture.dispose();
  });

  it("does not show rejected focus telemetry as a failed player action", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture();
    fixture.runTo(MatchPhase.Inspection);

    fixture.adapter.sendCommand({ type: "focus", targetObjectId: "not-a-real-object" });
    fixture.advance(1);

    expect(fixture.state().rejections).toHaveLength(0);
    fixture.dispose();
  });

  it("corrects the countdown for a server clock that leads this machine's", async () => {
    vi.useFakeTimers();
    const lead = 5_000;
    const fixture = await startedFixture({ serverClockLeadMs: lead });
    fixture.runTo(MatchPhase.Forge);

    const state = fixture.state();
    expect(state.clockOffsetMs).toBeCloseTo(lead, 0);
    // Without the correction the deadline would read a full lead ahead.
    expect(state.timer.remainingMs).toBeGreaterThan(0);
    expect(state.timer.remainingMs).toBeLessThanOrEqual(SETTINGS.forgeMs ?? 0);

    fixture.dispose();
  });

  it("lets a hider taunt once, then holds them to the cooldown", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture({ seed: MIMIC_SEED });
    fixture.runTo(MatchPhase.Inspection);

    const hiding = fixture.state();
    expect(hiding.self.role).toBe("mimic");
    // Every Mimic holds a disguise by the time inspection opens, auto-locked if
    // they never sent one themselves.
    expect(hiding.self.disguiseLocked).toBe(true);
    expect(hiding.capabilities.taunt).toBe(true);
    expect(hiding.actions.taunt.allowed).toBe(true);

    expect(fixture.actions.taunt()).toEqual({ sent: true });
    fixture.advance(1);

    const baited = fixture.state();
    expect(baited.self.tauntCooldownMs).toBeGreaterThan(0);
    expect(baited.actions.taunt).toEqual({ allowed: false, reason: "taunt_cooldown" });
    // The second press never reaches the authority.
    expect(fixture.actions.taunt()).toEqual({ sent: false, reason: "taunt_cooldown" });
    expect(fixture.state().rejections).toHaveLength(0);

    fixture.dispose();
  });

  it("refuses a taunt to an Inspector and to a hider outside inspection", async () => {
    vi.useFakeTimers();
    const inspecting = await startedFixture();
    inspecting.runTo(MatchPhase.Inspection);
    expect(inspecting.state().self.role).toBe("inspector");
    expect(inspecting.actions.taunt()).toEqual({ sent: false, reason: "wrong_role" });
    inspecting.dispose();

    const folding = await startedFixture({ seed: MIMIC_SEED });
    folding.runTo(MatchPhase.Forge);
    expect(folding.state().self.role).toBe("mimic");
    expect(folding.actions.taunt()).toEqual({ sent: false, reason: "wrong_phase" });
    folding.dispose();
  });

  it("raises and drops the being-watched level as an Inspector looks", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture({ seed: MIMIC_SEED });

    // Nobody is looking at a player who has no disguise yet.
    fixture.runTo(MatchPhase.Forge);
    expect(fixture.state().self.watchedLevel).toBe(0);

    fixture.runTo(MatchPhase.Inspection);
    const hiding = fixture.state();
    expect(hiding.self.role).toBe("mimic");
    const myDisguise = hiding.self.ownDisguise?.publicObjectId;
    expect(myDisguise).toBeDefined();
    if (myDisguise === undefined) throw new Error("hider has no disguise");
    // Unwatched until somebody actually looks.
    expect(hiding.self.watchedLevel).toBe(0);

    // The seat is what a transport addresses a player by, which is the only way
    // to issue the Inspector's focus on their behalf.
    const inspectorSeat = hiding.roster.find(
      (player) => player.rolePublicState === "inspector",
    )?.seatId;
    expect(inspectorSeat).toBeDefined();
    if (inspectorSeat === undefined) throw new Error("no inspector seated");
    expect(inspectorSeat).not.toBe(hiding.roster.find((player) => player.isSelf)?.seatId);

    fixture.adapter.sendCommandAs(inspectorSeat, {
      type: "focus",
      targetObjectId: myDisguise,
    });
    fixture.advance(1);
    expect(fixture.state().self.watchedLevel).toBeGreaterThan(0);

    // The Inspector looks away. The delivery is throttled, so the drop needs a
    // moment before it reaches the hider.
    fixture.adapter.sendCommandAs(inspectorSeat, { type: "focus", targetObjectId: null });
    fixture.advance(8);
    expect(fixture.state().self.watchedLevel).toBe(0);

    fixture.dispose();
  });

  it("takes seats, survival times and result objects straight from the authority", async () => {
    vi.useFakeTimers();
    const fixture = await startedFixture();
    fixture.runTo(MatchPhase.Inspection);

    const roster = fixture.state().roster;
    expect(roster.every((player) => player.seatId !== "")).toBe(true);
    expect(new Set(roster.map((player) => player.seatId)).size).toBe(roster.length);
    // The loopback runs the simulation in this page, so the local seat holds it.
    expect(roster.find((player) => player.isSelf)?.isAuthority).toBe(true);

    // Ownership carries a survival time for a hider who is still standing, so
    // the reveal can show one before any results exist.
    fixture.runTo(MatchPhase.Reveal, 200);
    const revealed = fixture.state().reveal;
    expect(revealed.entries.length).toBeGreaterThan(0);
    expect(revealed.entries.every((entry) => entry.survivalSeconds !== null)).toBe(true);
    expect(revealed.entries.every((entry) => entry.displayName !== null)).toBe(true);

    fixture.runTo(MatchPhase.Results, 200);
    const rows = fixture.state().results?.rows ?? [];
    expect(rows).toHaveLength(BOT_COUNT + 1);
    // An Inspector wore no disguise; every hider did.
    expect(rows.filter((row) => row.role === "inspector").every((row) => row.publicObjectId === null)).toBe(true);
    expect(rows.filter((row) => row.role === "mimic").every((row) => row.publicObjectId !== null)).toBe(true);

    fixture.dispose();
  });

  it("reports the roster and the local seat from the public state", async () => {
    vi.useFakeTimers();
    const fixture = await seatedFixture();

    const roster = fixture.state().roster;
    expect(roster).toHaveLength(BOT_COUNT + 1);
    expect(roster.filter((player) => player.isSelf)).toHaveLength(1);
    expect(roster.find((player) => player.isSelf)?.displayName).toBe("Curator");
    expect(roster.find((player) => player.isSelf)?.isHost).toBe(true);
    // Nobody has a round role yet, so the roster shows everyone as a spectator
    // and no Mimic is identifiable from it (§27.10).
    expect(roster.every((player) => player.rolePublicState === "spectator")).toBe(true);
    expect(fixture.state().self.role).toBeNull();

    expect(fixture.state().actions.startMatch.allowed).toBe(false);
    expect(fixture.state().actions.startMatch.reason).toBe("players_not_ready");
    fixture.actions.ready(true);
    fixture.advance(1);
    expect(fixture.state().self.ready).toBe(true);
    expect(fixture.state().actions.startMatch.allowed).toBe(true);

    fixture.dispose();
  });
});
