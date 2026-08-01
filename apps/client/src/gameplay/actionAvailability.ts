import type { PlayerLifeState } from "@foldseek/game-sim";
import { MatchPhase, type PlayerRole } from "@foldseek/shared";

import type { ConnectionStatus } from "../networking/NetworkAdapter";
import type { ActionAvailability, ActionGate } from "./roundView";

/**
 * Client-side mirrors of the command guards in MatchSimulation, so a control
 * the authority would refuse is disabled instead of round-tripped (§27.3).
 *
 * These are a courtesy, never a substitute: the simulation still validates
 * everything, including the geometry and rate limits no client can evaluate. A
 * mirror that drifts from the simulation therefore costs a wasted round trip
 * and a rejection toast, not a rule.
 */

const ALLOWED: ActionGate = { allowed: true, reason: null };

function blocked(reason: NonNullable<ActionGate["reason"]>): ActionGate {
  return { allowed: false, reason };
}

export interface AvailabilityInput {
  readonly status: ConnectionStatus;
  readonly phase: MatchPhase;
  readonly role: PlayerRole | null;
  readonly lifeState: PlayerLifeState;
  readonly isHost: boolean;
  readonly disguiseLocked: boolean;
  readonly warrantsRemaining: number | null;
  readonly accusationReadyAtServerMs: number | null;
  readonly serverNowMs: number;
  /** Players the authority counts toward starting: connected ones (§5.3). */
  readonly connectedPlayers: number;
  readonly connectedPlayersReady: number;
  readonly minPlayers: number;
  /** Disguises this player may vote for on the results screen. */
  readonly voteCandidates: number;
  readonly rematchVoted: boolean;
  /** Milliseconds left on this player's own taunt cooldown. */
  readonly tauntCooldownMs: number;
  /** False once the authority has refused a taunt as an unknown command. */
  readonly tauntSupported: boolean;
}

function isInspectionPhase(phase: MatchPhase): boolean {
  return phase === MatchPhase.Inspection || phase === MatchPhase.FinalCountdown;
}

function readyGate(input: AvailabilityInput): ActionGate {
  if (input.phase !== MatchPhase.Lobby && input.phase !== MatchPhase.Loading) {
    return blocked("wrong_phase");
  }
  return ALLOWED;
}

function startMatchGate(input: AvailabilityInput): ActionGate {
  if (!input.isHost) return blocked("not_host");
  if (input.phase !== MatchPhase.Lobby) return blocked("wrong_phase");
  // inspectorCountForRoster is positive for every roster of two or more, so
  // minPlayers is the whole of the simulation's canFieldARound test here.
  if (input.connectedPlayers < Math.max(2, input.minPlayers)) return blocked("not_enough_players");
  if (input.connectedPlayersReady < input.connectedPlayers) return blocked("players_not_ready");
  return ALLOWED;
}

function lockDisguiseGate(input: AvailabilityInput): ActionGate {
  if (input.phase !== MatchPhase.Forge && input.phase !== MatchPhase.Locking) {
    return blocked("wrong_phase");
  }
  if (input.role !== "mimic") return blocked("wrong_role");
  if (input.lifeState !== "active") return blocked("player_not_active");
  if (input.disguiseLocked) return blocked("already_locked");
  return ALLOWED;
}

function accuseGate(input: AvailabilityInput): ActionGate {
  if (!isInspectionPhase(input.phase)) return blocked("wrong_phase");
  if (input.role !== "inspector") return blocked("wrong_role");
  if ((input.warrantsRemaining ?? 0) <= 0) return blocked("no_warrants");
  if (
    input.accusationReadyAtServerMs !== null &&
    input.serverNowMs < input.accusationReadyAtServerMs
  ) {
    return blocked("accusation_cooldown");
  }
  return ALLOWED;
}

function focusGate(input: AvailabilityInput): ActionGate {
  if (!isInspectionPhase(input.phase)) return blocked("wrong_phase");
  if (input.role !== "inspector") return blocked("wrong_role");
  return ALLOWED;
}

/**
 * A hider baits the room (§MECCHA taunt). It needs a disguise still standing,
 * which is what `disguiseLocked` reports, and the simulation's own five-second
 * cooldown, which no private state carries.
 */
function tauntGate(input: AvailabilityInput): ActionGate {
  if (!input.tauntSupported) return blocked("unsupported");
  if (!isInspectionPhase(input.phase)) return blocked("wrong_phase");
  if (input.role !== "mimic") return blocked("wrong_role");
  if (input.lifeState !== "active" || !input.disguiseLocked) return blocked("player_not_active");
  if (input.tauntCooldownMs > 0) return blocked("taunt_cooldown");
  return ALLOWED;
}

function voteResultGate(input: AvailabilityInput): ActionGate {
  if (input.phase !== MatchPhase.Reveal && input.phase !== MatchPhase.Results) {
    return blocked("wrong_phase");
  }
  if (input.role === "spectator") return blocked("wrong_role");
  if (input.voteCandidates === 0) return blocked("target_unknown");
  return ALLOWED;
}

function voteRematchGate(input: AvailabilityInput): ActionGate {
  if (input.phase !== MatchPhase.Results && input.phase !== MatchPhase.RematchVote) {
    return blocked("wrong_phase");
  }
  if (input.rematchVoted) return blocked("duplicate_vote");
  return ALLOWED;
}

const DISCONNECTED: ActionAvailability = {
  ready: blocked("not_connected"),
  startMatch: blocked("not_connected"),
  lockDisguise: blocked("not_connected"),
  accuse: blocked("not_connected"),
  focus: blocked("not_connected"),
  taunt: blocked("not_connected"),
  voteResult: blocked("not_connected"),
  voteRematch: blocked("not_connected"),
};

export function computeAvailability(input: AvailabilityInput): ActionAvailability {
  if (input.status !== "connected") return DISCONNECTED;
  return {
    ready: readyGate(input),
    startMatch: startMatchGate(input),
    lockDisguise: lockDisguiseGate(input),
    accuse: accuseGate(input),
    focus: focusGate(input),
    taunt: tauntGate(input),
    voteResult: voteResultGate(input),
    voteRematch: voteRematchGate(input),
  };
}
