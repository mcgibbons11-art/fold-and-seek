import type { PrivateMatchState, PublicMatchState } from "@foldseek/game-sim";
import {
  DisguiseOwnershipSchema,
  DisguiseSourceSchema,
  LIMITS,
  MatchPhaseSchema,
  MatchResultsSchema,
  PlayerLifeStateSchema,
  PlayerRoleSchema,
  StarterArrangementIdSchema,
  type MatchSettings,
} from "@foldseek/shared";
import { z } from "zod";
import type { CommandRejection } from "./NetworkAdapter";

/**
 * Wire validation for the canonical state views a transport replicates.
 * @foldseek/shared validates commands and events; the state views live in
 * @foldseek/game-sim and have no schema there, so they are described here, next
 * to the adapters that receive them from an untrusted peer (bible rule 5).
 *
 * Each parse helper is typed against the game-sim interface it must produce, so
 * a field added upstream fails the build here rather than silently dropping.
 */

const timestamp = z.number().min(0).max(LIMITS.maxTimestamp);
const count = z.number().int().min(0).max(LIMITS.maxCount);
const id = z.string().min(1).max(LIMITS.idLength);
const displayName = z.string().min(1).max(LIMITS.displayNameLength);
const encodedPose = z.string().max(LIMITS.encodedPoseLength);
/** Null on a disguise nobody painted, which is the common case. */
const encodedPaint = z.string().max(LIMITS.encodedPaintLength).nullable();
const settingValue = z.number().min(0).max(LIMITS.maxTimestamp);

const settingsShape: Record<keyof MatchSettings, z.ZodNumber> = {
  minPlayers: settingValue,
  maxPlayers: settingValue,
  mapIntroMs: settingValue,
  roleRevealMs: settingValue,
  baselineScanMs: settingValue,
  forgeMs: settingValue,
  lockGraceMs: settingValue,
  inspectionIntroMs: settingValue,
  inspectionMs: settingValue,
  revealMs: settingValue,
  resultsMs: settingValue,
  rematchVoteMs: settingValue,
  warrantsBonus: settingValue,
  inspectorMoveSpeed: settingValue,
  hiderCreepSpeed: settingValue,
  inspectorFocusDistance: settingValue,
  accusationDistance: settingValue,
  wrongAccusationCooldownMs: settingValue,
  directLookMinMs: settingValue,
  directLookBreakMs: settingValue,
  missedFindsUpdateMs: settingValue,
  reconnectGraceMs: settingValue,
  serverTickHz: settingValue,
  cameraSampleHz: settingValue,
  maxForgeCommandHz: settingValue,
};

export const MatchSettingsSchema = z.strictObject(settingsShape);

/** Which kind of nobody a player is, when `role` alone cannot tell them apart. */
export const PrivateRoleStateSchema = z.enum([
  "unassigned",
  "inspector",
  "mimic",
  "spectator",
]);

/** How hard an Inspector is looking at this hider right now (§5.12). */
export const WatchedLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const PublicPlayerViewSchema = z.strictObject({
  // The transport's own seating key. Public because who is in the room is
  // public; it links to no disguise, and ownership stays private until the
  // reveal (§27.10).
  seatId: id,
  publicPlayerId: id,
  displayName,
  isHost: z.boolean(),
  connected: z.boolean(),
  ready: z.boolean(),
  lifeState: PlayerLifeStateSchema,
  rolePublicState: z.enum(["unknown", "inspector", "spectator", "mimic"]),
});

export const PublicDisguiseViewSchema = z.strictObject({
  publicObjectId: id,
  encodedPose,
  // Body paint is public: it is part of what the object looks like.
  encodedPaint,
  defaultArrangementId: StarterArrangementIdSchema.nullable(),
  revealed: z.boolean(),
});

export const PublicMatchStateSchema = z.strictObject({
  now: timestamp,
  round: count,
  phase: MatchPhaseSchema,
  phaseEndsAt: timestamp,
  warrantsRemaining: count,
  warrantsTotal: count,
  mimicsRemaining: count,
  settings: MatchSettingsSchema,
  players: z.array(PublicPlayerViewSchema).max(LIMITS.maxPlayersPerMatch),
  disguises: z.array(PublicDisguiseViewSchema).max(LIMITS.maxPlayersPerMatch),
  results: MatchResultsSchema.nullable(),
});

export const OwnDisguiseViewSchema = z.strictObject({
  publicObjectId: id,
  encodedPose,
  encodedPaint,
  source: DisguiseSourceSchema,
  defaultArrangementId: StarterArrangementIdSchema.nullable(),
});

export const PrivateMatchStateSchema = z.strictObject({
  playerId: id,
  publicPlayerId: id,
  role: PlayerRoleSchema,
  roleState: PrivateRoleStateSchema,
  lifeState: PlayerLifeStateSchema,
  isHost: z.boolean(),
  ready: z.boolean(),
  ownDisguise: OwnDisguiseViewSchema.nullable(),
  knownDisguiseOwners: z.array(DisguiseOwnershipSchema).max(LIMITS.maxPlayersPerMatch),
  warrantsRemaining: count.nullable(),
  accusationReadyAt: timestamp.nullable(),
  tauntReadyAtMs: timestamp.nullable(),
  watchedLevel: WatchedLevelSchema,
});

/**
 * Shape of a refusal on the wire. The dedicated server and the Portals host
 * both produce it, so both client adapters validate against this one schema.
 */
export const CommandRejectionSchema = z.strictObject({
  type: z.string().min(1).max(LIMITS.idLength),
  reason: z.string().min(1).max(LIMITS.idLength),
  detail: z.string().max(LIMITS.displayNameLength * 8).optional(),
});

export function parseCommandRejection(value: unknown): CommandRejection | null {
  const result = CommandRejectionSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parsePublicState(value: unknown): PublicMatchState | null {
  const result = PublicMatchStateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parsePrivateState(value: unknown): PrivateMatchState | null {
  const result = PrivateMatchStateSchema.safeParse(value);
  return result.success ? result.data : null;
}
