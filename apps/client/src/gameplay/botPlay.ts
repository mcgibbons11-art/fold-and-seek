import { MatchPhase } from "@foldseek/shared";

import type {
  BotAction,
  BotBrain,
  BotSeatOptions,
  BotTurn,
} from "../networking/botSeats";
import { NAV_DATA } from "../world/maps/nav";
import { buildObjectRegistry } from "../world/maps/registry";
import { BotCreep, createBotDisguisePayload } from "./botDisguises";
import { BotInspector } from "./botInspector";
import type { RoundSpatialBridge } from "./roundSpatial";

/**
 * What a bot does with the round it was dealt, for whichever transport is
 * running the simulation. One dealt the Inspector's role walks the shop and
 * spends warrants; ones dealt Mimic fold into a hiding place and, if that place
 * is out in the open, cannot keep still.
 *
 * Practice and a Portals room share this rather than each writing their own,
 * because a bot filling out a room of people has to play the round exactly as
 * well as a bot in a solo one does.
 */

/** Which hiding place a given bot took, stable for the life of the room. */
export type HidePlanRegister = (playerId: string) => number;

/**
 * Hands out the hiding places in the order bots actually hide, rather than by
 * seat. Seats are dealt roles by a shuffle, so a seat-ordered table gives the
 * two bots left hiding whichever plans the Inspector's seat did not take, and
 * one deal in three left both of them standing in the open with nobody in cover.
 * Assigning on the way into a disguise keeps the round's mix of good and bad
 * hides whoever ends up carrying the gun.
 */
export function createHidePlanRegister(): HidePlanRegister {
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
export function createBotBrain(
  spatial: RoundSpatialBridge,
  seed: number,
  hidePlan: HidePlanRegister,
): BotBrain {
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

/**
 * The whole of what an adapter needs to run bots on this map: where each one
 * hides and how it plays. Both are keyed on the same register, so the pose a
 * bot locks and the fidget it makes afterwards belong to one hiding place.
 */
export function createBotPlay(spatial: RoundSpatialBridge, seed: number): Required<BotSeatOptions> {
  const hidePlan = createHidePlanRegister();
  return {
    botPose: (_index, playerId) => createBotDisguisePayload(hidePlan(playerId)),
    botBrain: createBotBrain(spatial, seed, hidePlan),
  };
}
