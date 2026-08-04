import type { MatchCommand, MatchSettingsPatch, ResultVoteCategory } from "@foldseek/game-sim";
import { MatchPhase, TAUNT_IDS, type TauntId } from "@foldseek/shared";

import type { NetworkAdapter } from "../networking/NetworkAdapter";
import type { RoundDirector } from "./RoundDirector";
import type { ActionBlockReason, RoundActionName, RoundViewState } from "./roundView";

/**
 * Every verb the round HUD can issue, in one place. Each one checks the gate
 * RoundDirector already computed before it spends a round trip, so a control
 * the authority would refuse is refused here with the same reason string the
 * authority would have sent (§27.3).
 *
 * The check is a mirror, not a rule. The simulation validates line of sight,
 * distance, pose contents, and rate limits, none of which a client can decide,
 * and a rejection still arrives on the adapter's rejection stream.
 */

export type ActionOutcome =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: ActionBlockReason };

const SENT: ActionOutcome = { sent: true };

/** Taunt the button sends when the caller names none. */
export const DEFAULT_TAUNT_ID: TauntId = TAUNT_IDS[0];

function refused(reason: ActionBlockReason): ActionOutcome {
  return { sent: false, reason };
}

export class RoundActions {
  private readonly adapter: NetworkAdapter;
  private readonly director: RoundDirector;
  /** Cursor through the taunt vocabulary, so the button never repeats itself. */
  private tauntCycle = 0;

  constructor(adapter: NetworkAdapter, director: RoundDirector) {
    this.adapter = adapter;
    this.director = director;
  }

  ready(ready: boolean): ActionOutcome {
    return this.send("ready", { type: "player_ready", ready });
  }

  startMatch(): ActionOutcome {
    return this.send("startMatch", { type: "start_match" });
  }

  /** Lobby-only room options. The authority repeats both checks. */
  setSettings(settings: MatchSettingsPatch): ActionOutcome {
    const state = this.director.getState();
    if (!state.self.isHost) return refused("not_host");
    if (state.phase !== MatchPhase.Lobby) return refused("wrong_phase");
    this.adapter.sendCommand({ type: "set_settings", settings });
    return SENT;
  }

  /**
   * `payload` is an encoded disguise from the Forge and `revision` its authoring
   * revision. Neither is inspected here: only the simulation's decoder decides
   * whether a pose is legal (§7.16).
   */
  lockDisguise(payload: string, revision: number): ActionOutcome {
    return this.send("lockDisguise", { type: "lock_disguise", payload, revision });
  }

  accuse(targetObjectId: string): ActionOutcome {
    return this.send("accuse", { type: "accuse", targetObjectId });
  }

  focus(targetObjectId: string | null): ActionOutcome {
    return this.send("focus", { type: "focus", targetObjectId });
  }

  /**
   * Baits the Inspector from inside the disguise. It is sent optimistically:
   * the gate only stops trying once the authority has refused a taunt as
   * something it does not recognise, so a room on an older build degrades to a
   * disabled button rather than a stream of refusals.
   */
  taunt(tauntId?: TauntId): ActionOutcome {
    // The button cycles the whole vocabulary (2026-08-04): five authored
    // gestures existed and one was ever sent, so repeat presses played the
    // same shudder all round. A caller naming a gesture still gets it.
    const chosen = tauntId ?? TAUNT_IDS[this.tauntCycle % TAUNT_IDS.length] ?? DEFAULT_TAUNT_ID;
    const outcome = this.send("taunt", { type: "taunt", tauntId: chosen });
    if (outcome.sent && tauntId === undefined) this.tauntCycle += 1;
    return outcome;
  }

  voteResult(category: ResultVoteCategory, targetPublicObjectId: string): ActionOutcome {
    const state = this.director.getState();
    const gate = state.actions.voteResult;
    if (!gate.allowed) return refused(gate.reason ?? "wrong_phase");
    if (state.results !== null && state.results.myVotes[category] !== null) {
      return refused("duplicate_vote");
    }
    if (
      !state.results?.voteCandidates.some(
        (candidate) => candidate.publicObjectId === targetPublicObjectId,
      )
    ) {
      return refused("target_unknown");
    }
    this.adapter.sendCommand({ type: "vote_result", category, targetPublicObjectId });
    return SENT;
  }

  voteRematch(yes: boolean): ActionOutcome {
    return this.send("voteRematch", { type: "vote_rematch", yes });
  }

  /**
   * Fills one more seat with a bot, so a room short of people can still start.
   *
   * This is the one verb that does not travel: only the client holding the
   * simulation can seat anyone, and that client is the one pressing the button,
   * so it goes straight to the adapter rather than through a command the
   * authority would only ever receive from itself.
   */
  addBot(): ActionOutcome {
    const bots = this.adapter.bots;
    const state = this.director.getState();
    if (bots === undefined || !state.botSeats.canManage) return refused("not_host");
    if (state.roster.length >= state.botSeats.maxSeats) return refused("room_full");
    return bots.addBot() === null ? refused("room_full") : SENT;
  }

  /** Gives up the most recently added bot seat. */
  removeBot(): ActionOutcome {
    const bots = this.adapter.bots;
    if (bots === undefined || !this.director.getState().botSeats.canManage) {
      return refused("not_host");
    }
    const seatId = bots.botSeatIds().at(-1);
    if (seatId === undefined) return refused("target_unknown");
    bots.removeBot(seatId);
    return SENT;
  }

  /** The gate the HUD reads to disable a control before anyone clicks it. */
  gate(action: RoundActionName): RoundViewState["actions"][RoundActionName] {
    return this.director.getState().actions[action];
  }

  private send(action: RoundActionName, command: MatchCommand): ActionOutcome {
    const gate = this.director.getState().actions[action];
    if (!gate.allowed) return refused(gate.reason ?? "wrong_phase");
    this.adapter.sendCommand(command);
    return SENT;
  }
}
