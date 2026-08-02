import type { MatchSettingsPatch } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";

import {
  LocalLoopbackAdapter,
  type BotAction,
  type BotBrain,
  type BotTurn,
} from "../networking/LocalLoopbackAdapter";
import { buildObjectRegistry } from "../world/maps/registry";
import { NAV_DATA } from "../world/maps/nav";
import { BotCreep, createBotDisguisePayload } from "./botDisguises";
import { BotInspector } from "./botInspector";
import { dealSeed, type GameRound } from "./round";
import { RoundDirector } from "./RoundDirector";
import { RoundSpatialBridge } from "./roundSpatial";

/**
 * A round of FOLD & SEEK played entirely in this tab (§4.3 practice, and the
 * offline half of the transport story). The simulation runs in the page against
 * the real Curiosity Shop registry and the real geometry validator, so a solo
 * round exercises the same rules a hosted one does.
 *
 * The bots play it. One dealt the Inspector's role walks the shop and spends
 * warrants; ones dealt Mimic fold into a hiding place and, if that place is out
 * in the open, cannot keep still. A solo round therefore ends with somebody
 * caught and somebody else still standing, rather than with the clock running
 * out on four identical scorelines.
 */

export const LOCAL_ROUND_BOTS = 3;
export const LOCAL_ROUND_NAME = "practice";

export interface LocalRound extends GameRound {
  readonly adapter: LocalLoopbackAdapter;
}

export interface LocalRoundOptions {
  readonly bots?: number;
  /** Fixed seed for a repeatable round. Omitted, every round deals afresh. */
  readonly seed?: number;
  /** Shortened phase durations, for driving a whole round headlessly. */
  readonly settings?: MatchSettingsPatch;
  /** Clock source. Defaults to the loopback's, which is performance.now(). */
  readonly now?: () => number;
}

/**
 * A seed named in the page's query string, for driving a particular deal from
 * outside the game: `?seed=10` puts this client in the Inspector's chair in a
 * four-seat room. Absent or unreadable, the round deals itself as usual.
 */
export function seedFromLocation(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("seed");
  if (raw === null) return undefined;
  const seed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(seed) && seed >= 0 ? seed : undefined;
}

/** Which hiding place a given bot took, stable for the life of the room. */
type HidePlanRegister = (playerId: string) => number;

/**
 * Hands out the hiding places in the order bots actually hide, rather than by
 * seat. Seats are dealt roles by a shuffle, so a seat-ordered table gives the
 * two bots left hiding whichever plans the Inspector's seat did not take, and
 * one deal in three left both of them standing in the open with nobody in cover.
 * Assigning on the way into a disguise keeps the round's mix of good and bad
 * hides whoever ends up carrying the gun.
 */
function createHidePlanRegister(): HidePlanRegister {
  const taken = new Map<string, number>();
  return (playerId: string) => {
    const existing = taken.get(playerId);
    if (existing !== undefined) return existing;
    const assigned = taken.size;
    taken.set(playerId, assigned);
    return assigned;
  };
}

/** Phases in which a manifested disguise may still be adjusted (§5.12). */
function isLiveHiderPhase(phase: MatchPhase): boolean {
  return (
    phase === MatchPhase.InspectionIntro ||
    phase === MatchPhase.Inspection ||
    phase === MatchPhase.FinalCountdown
  );
}

/**
 * Routes each bot to the behaviour its own role calls for. It is the one place
 * that reads the room's list of disguises, and it reads exactly one thing from
 * it, the object ids, which it merges into the shop's props before handing the
 * result to the Inspector brain. The brain is therefore given a flat list of
 * things in the room with no record of which are people, which is the same view
 * a human client's reticle has (§8.5).
 */
function createBotBrain(spatial: RoundSpatialBridge, seed: number, hidePlan: HidePlanRegister): BotBrain {
  const propIds = buildObjectRegistry().objects.map((entry) => entry.objectId);
  const creep = new BotCreep();
  let candidateIds: readonly string[] = propIds;

  const inspector = new BotInspector(
    {
      nav: NAV_DATA,
      candidateIds: () => candidateIds,
      objectBounds: (objectId) => spatial.boundsOf(objectId),
      setEye: (playerId, eye) => {
        spatial.setInspectorEye(playerId, eye);
      },
    },
    seed,
  );

  return {
    act(turn: BotTurn): readonly BotAction[] {
      const { publicState, privateState } = turn;
      if (privateState.role === "inspector") {
        candidateIds = [
          ...propIds,
          ...publicState.disguises.map((disguise) => disguise.publicObjectId),
        ];
        return inspector
          .update({
            playerId: turn.playerId,
            nowMs: turn.nowMs,
            phase: publicState.phase,
            round: publicState.round,
            settings: publicState.settings,
            warrantsRemaining: privateState.warrantsRemaining ?? 0,
            accusationReadyAt: privateState.accusationReadyAt ?? 0,
          })
          .map((command) => ({ kind: "command", command }) as const);
      }

      if (
        privateState.role !== "mimic" ||
        privateState.lifeState !== "active" ||
        privateState.ownDisguise === null ||
        !isLiveHiderPhase(publicState.phase)
      ) {
        return [];
      }
      const shift = creep.update(hidePlan(turn.playerId), turn.playerId, turn.nowMs);
      return shift === null
        ? []
        : [{ kind: "forge_snapshot", encodedPose: shift.encodedPose, revision: shift.revision }];
    },
    release(playerId: string) {
      inspector.release(playerId);
      creep.release(playerId);
    },
  };
}

export function createLocalRound(options: LocalRoundOptions = {}): LocalRound {
  const seed = options.seed ?? dealSeed();
  const spatial = new RoundSpatialBridge();
  const hidePlan = createHidePlanRegister();
  const adapter = new LocalLoopbackAdapter({
    seed,
    spatial: spatial.validator,
    objectRegistry: buildObjectRegistry(),
    botPose: (_index, playerId) => createBotDisguisePayload(hidePlan(playerId)),
    botBrain: createBotBrain(spatial, seed, hidePlan),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  for (let index = 0; index < (options.bots ?? LOCAL_ROUND_BOTS); index += 1) {
    adapter.addBot({ autoPlay: true });
  }
  const director = new RoundDirector(adapter);

  return {
    adapter,
    director,
    spatial,
    dispose() {
      director.dispose();
      adapter.dispose();
    },
  };
}
