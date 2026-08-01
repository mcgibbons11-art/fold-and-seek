import { LIMITS, type MatchSettings, type TauntId } from "@foldseek/shared";
import type { ResultVoteCategory } from "./constants";
import type { SimOutput } from "./events";

/**
 * Player-issued commands accepted by MatchSimulation. Ids are plain strings so
 * that the wire schemas in @foldseek/shared infer exactly these types; the
 * branded ids from §29.1 stay in the application layer.
 */
export type MatchCommand =
  | { readonly type: "player_ready"; readonly ready: boolean }
  | { readonly type: "set_settings"; readonly settings: MatchSettingsPatch }
  | { readonly type: "start_match" }
  | { readonly type: "lock_disguise"; readonly payload: string; readonly revision: number }
  | { readonly type: "accuse"; readonly targetObjectId: string }
  | { readonly type: "focus"; readonly targetObjectId: string | null }
  | {
      readonly type: "vote_result";
      readonly category: ResultVoteCategory;
      readonly targetPublicObjectId: string;
    }
  | { readonly type: "vote_rematch"; readonly yes: boolean }
  | { readonly type: "taunt"; readonly tauntId: TauntId };

export type MatchCommandType = MatchCommand["type"];

/** Host-settable subset of the match settings (§5.3). */
export const SETTABLE_SETTING_KEYS = [
  "maxPlayers",
  "mapIntroMs",
  "roleRevealMs",
  "baselineScanMs",
  "forgeMs",
  "lockGraceMs",
  "inspectionIntroMs",
  "inspectionMs",
  "revealMs",
  "resultsMs",
  "rematchVoteMs",
  "warrantsBonus",
  "wrongAccusationCooldownMs",
  "reconnectGraceMs",
] as const;

export type SettableSettingKey = (typeof SETTABLE_SETTING_KEYS)[number];

export type MatchSettingsPatch = Partial<Pick<MatchSettings, SettableSettingKey>>;

/** Longest a single phase may be configured to run. */
export const MAX_PHASE_DURATION_MS = 600_000;

export interface SettingBound {
  readonly min: number;
  readonly max: number;
}

const phaseDurationBound: SettingBound = { min: 0, max: MAX_PHASE_DURATION_MS };

/**
 * Accepted range for each host-settable value, mirroring MatchSettingsPatchSchema
 * in @foldseek/shared. Every one is a whole number: durations are milliseconds
 * and the rest are counts, so a fractional value is always a client error.
 */
export const SETTING_BOUNDS: Readonly<Record<SettableSettingKey, SettingBound>> = {
  maxPlayers: { min: 2, max: LIMITS.maxPlayersPerMatch },
  mapIntroMs: phaseDurationBound,
  roleRevealMs: phaseDurationBound,
  baselineScanMs: phaseDurationBound,
  forgeMs: phaseDurationBound,
  lockGraceMs: phaseDurationBound,
  inspectionIntroMs: phaseDurationBound,
  inspectionMs: phaseDurationBound,
  revealMs: phaseDurationBound,
  resultsMs: phaseDurationBound,
  rematchVoteMs: phaseDurationBound,
  warrantsBonus: { min: 0, max: 16 },
  wrongAccusationCooldownMs: { min: 0, max: MAX_PHASE_DURATION_MS },
  reconnectGraceMs: { min: 0, max: MAX_PHASE_DURATION_MS },
};

/** Why a command was refused. Surfaced to the issuing client only. */
export type CommandRejectionReason =
  | "unknown_player"
  | "duplicate_player"
  | "room_full"
  | "not_host"
  | "wrong_phase"
  | "wrong_role"
  | "player_not_active"
  | "player_disconnected"
  | "not_enough_players"
  | "players_not_ready"
  | "no_warrants"
  | "accusation_cooldown"
  | "target_unknown"
  | "target_already_resolved"
  | "spatial_rejected"
  | "invalid_settings"
  | "already_locked"
  | "stale_revision"
  | "invalid_pose"
  /** The paint layer failed to decode or exceeded its ceiling. */
  | "invalid_paint"
  | "duplicate_vote"
  /** A creeping hider tried to cover more ground than hiderCreepSpeed allows. */
  | "moved_too_fast"
  /** The geometry owner refused the new root position (§28.5 seam). */
  | "outside_play_volume"
  /** Forge updates arrived faster than maxForgeCommandHz. */
  | "rate_limited"
  | "taunt_cooldown";

/**
 * Outcome of one command. It carries the same two streams as SimOutput, so the
 * events a command produced are routed by exactly the rules that apply to every
 * other simulation output. A rejected lock arrives here as `invalid_pose` plus
 * the decoder's complaint in `detail`, which is what a transport turns into the
 * forge rejection of §7.16.
 */
export interface CommandResult extends SimOutput {
  readonly accepted: boolean;
  readonly reason?: CommandRejectionReason;
  /** Free-form detail from a validator or decoder, for client-side messaging. */
  readonly detail?: string;
}
