import {
  encodedPoseByteLength,
  type MatchPhase,
  type MatchSettings,
  type PlayerRole,
  type StarterArrangementId,
} from "@foldseek/shared";
import type { ResultVoteCategory } from "./constants";
import type {
  DisguiseSource,
  MatchResults,
  PlayerLifeState,
  PrivateSimEvent,
  SimEvent,
  WatchedLevel,
} from "./events";

/**
 * Complete authoritative state of a MatchSimulation, as plain JSON.
 *
 * It exists for host migration (§27.11): the outgoing host serializes, the
 * incoming host restores, and the round continues on the same tick with the
 * same random stream. Every field the simulation reads when deciding what
 * happens next is here, including the generator cursor and the sequence
 * counter, because a restored room that diverges by one event is worse than
 * one that stops.
 *
 * SECRET MATERIAL. A snapshot contains every Mimic's role and the mapping from
 * disguise to player. It is host-to-host material and must never reach a
 * non-host player as plaintext. Portals `setState` values are readable by every
 * client in the room, so an adapter that migrates through room state is making
 * the party-stakes tradeoff of §43.8 knowingly, and should say so where it
 * writes the state. A dedicated server has no such excuse.
 *
 * Keys are short because the transport pays for every byte. See
 * estimateSnapshotBytes for what actually dominates the size.
 */

export const MATCH_SNAPSHOT_VERSION = 1;

export interface SnapshotStats {
  /** directLookEscapes, closePasses, peerStyleVotes. */
  readonly e: number;
  readonly c: number;
  readonly v: number;
  /** correctAccusations, wrongAccusations. */
  readonly ca: number;
  readonly wa: number;
  /** focusedObjectIds, in insertion order. */
  readonly f: readonly string[];
  /** Accumulated line-of-sight milliseconds. */
  readonly los: number;
  /** Taunts performed while an Inspector was watching. */
  readonly ot: number;
}

export interface SnapshotPlayer {
  readonly i: string;
  readonly p: string;
  readonly n: string;
  readonly h: boolean;
  readonly c: boolean;
  readonly d: number | null;
  readonly y: boolean;
  readonly r: PlayerRole;
  readonly l: PlayerLifeState;
  readonly j: number;
  readonly jr: number;
  readonly li: number;
  readonly ir: number;
  /** Object id of the disguise this player owns, resolved back to a shared record on restore. */
  readonly o: string | null;
  /** Last valid Forge pose as [encodedPose, revision]. */
  readonly vp: readonly [string, number] | null;
  /** Paint recorded before the disguise manifested. */
  readonly vt: readonly [string, number] | null;
  readonly ct: number | null;
  readonly st: SnapshotStats;
  /** When this player last taunted, for the cooldown. */
  readonly tt: number | null;
  /** When this player last sent a forge update, for the rate cap. */
  readonly fu: number | null;
  /** Last watched level delivered, and when, so a migration cannot re-fire it. */
  readonly wl: WatchedLevel;
  readonly wa: number | null;
}

export interface SnapshotDisguise {
  readonly o: string;
  readonly ow: string | null;
  readonly op: string;
  readonly on: string;
  readonly e: string;
  readonly rv: number;
  /** Paint layer and its own revision, parallel to the pose. */
  readonly pt: string | null;
  readonly pv: number;
  readonly s: DisguiseSource;
  readonly a: StarterArrangementId | null;
  readonly al: boolean;
  readonly lk: number;
  readonly ct: number | null;
  /** Root position of the current pose, the baseline for the creep speed cap. */
  readonly rp: readonly [number, number, number];
  /** When the root last moved, so a migration cannot reset the creep clock. */
  readonly mv: number;
}

export interface MatchSnapshot {
  readonly v: number;
  /** Map the registry must describe, so a restore cannot silently swap maps. */
  readonly map: string;
  /** True when locked poses were left out and must be supplied on restore. */
  readonly po: boolean;
  readonly s: MatchSettings;
  readonly sd: number;
  /** Identity generator cursor, so public ids continue the same stream. */
  readonly rc: number;
  readonly sq: number;
  readonly nj: number;
  readonly t: number;
  readonly r: number;
  readonly ph: MatchPhase;
  readonly pe: number;
  readonly wr: number;
  /** Warrants the round started with. */
  readonly wt: number;
  /** Next missed-finds board time, and how many have been published. */
  readonly mf: number;
  readonly mc: number;
  readonly is: number;
  readonly ie: number;
  readonly ix: number;
  readonly lg: number;
  readonly ac: number;
  readonly op: readonly string[];
  readonly pl: readonly SnapshotPlayer[];
  readonly dg: readonly SnapshotDisguise[];
  readonly ro: ReadonlyArray<readonly [string, "mimic" | "innocent"]>;
  readonly ar: ReadonlyArray<readonly [string, number]>;
  /** Focus holds as [playerId, objectId, sinceMs]. */
  readonly fh: ReadonlyArray<readonly [string, string, number]>;
  /** Pending escapes as [inspectorId, objectId, brokenAtMs]. */
  readonly pes: ReadonlyArray<readonly [string, string, number]>;
  readonly le: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]>;
  readonly lc: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]>;
  readonly rv: ReadonlyArray<readonly [string, ReadonlyArray<readonly [ResultVoteCategory, string]>]>;
  readonly rm: ReadonlyArray<readonly [string, boolean]>;
  readonly rs: MatchResults | null;
  /** Events emitted but not yet drained, so a migration loses none. */
  readonly qp: readonly SimEvent[];
  readonly qv: ReadonlyArray<readonly [string, readonly PrivateSimEvent[]]>;
}

export interface SnapshotOptions {
  /**
   * "omit" leaves locked poses out. They are already public
   * (`PublicMatchState.disguises[].encodedPose`), so a host taking over holds
   * them as a client and does not need them repeated in secret state. It is
   * available once every pose is locked; before that a Mimic's working pose
   * exists nowhere else, and omitting it would lose the round's work, so
   * `snapshot` refuses rather than truncating.
   */
  readonly poses?: "include" | "omit";
}

/** Enough of a public disguise view to rebuild a pose-omitted snapshot. */
export interface PoseSource {
  readonly publicObjectId: string;
  readonly encodedPose: string;
  /** Paint is public too, so an omitted snapshot rebuilds it from here. */
  readonly encodedPaint?: string | null;
}

/** Dependencies a restored simulation needs that state alone cannot carry. */
export interface RestoreDeps {
  readonly spatial?: import("./spatial").SpatialValidator;
  readonly objectRegistry?: import("./objects").ObjectRegistry;
  /**
   * Locked poses for a snapshot taken with `poses: "omit"`. Pass
   * `getPublicState().disguises` straight through. A pose that is missing or
   * empty throws, because a disguise standing in the room without its geometry
   * is worse than a failed migration.
   */
  readonly poses?: readonly PoseSource[];
  /**
   * Who is actually in the room now. A snapshot is always authored by a host
   * that has since left, so the surviving roster is smaller than the captured
   * one. Players absent from this list are detached as they would be on any
   * other departure: disguises stay behind as ghosts, the host is promoted, and
   * the round ends early if no Inspector is left. Omit it to restore the roster
   * exactly as captured.
   */
  readonly seatedPlayerIds?: readonly string[];
}

/**
 * Serialized size in bytes, for a transport that has to fit a snapshot into
 * fixed-size state values.
 *
 * Locked poses dominate: every disguise carries a full encoded pose, which
 * @foldseek/shared caps at 6 KB each. A room of eleven Mimics can therefore
 * produce a snapshot far larger than a four-key, 8 KB-per-key Portals budget,
 * and no amount of key shortening changes that. A transport with a hard ceiling
 * should move poses on their own channel and migrate the rest.
 */
export function estimateSnapshotBytes(snapshot: MatchSnapshot): number {
  return encodedPoseByteLength(JSON.stringify(snapshot));
}

/** Bytes attributable to locked poses, which is the term worth watching. */
export function estimateSnapshotPoseBytes(snapshot: MatchSnapshot): number {
  let bytes = 0;
  for (const disguise of snapshot.dg) bytes += encodedPoseByteLength(disguise.e);
  for (const player of snapshot.pl) {
    if (player.vp) bytes += encodedPoseByteLength(player.vp[0]);
  }
  return bytes;
}
