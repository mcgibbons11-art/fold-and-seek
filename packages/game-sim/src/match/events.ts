import type { MatchPhase, PlayerRole, StarterArrangementId, TauntId } from "@foldseek/shared";
import type { InnocentReactionId, ResultVoteCategory } from "./constants";

/**
 * Every observable state change of MatchSimulation leaves as an event. The two
 * streams are separated at the source rather than by transport policy: a
 * SimEvent is safe to broadcast to the whole room, and a PrivateSimEvent is
 * addressed to exactly one player. Nothing in a SimEvent needs redaction, so a
 * transport has no opportunity to leak a secret by forwarding the wrong list.
 */

export interface SimEventBase {
  /** Monotonic per-simulation sequence number, stable for a given seed and command stream. */
  readonly seq: number;
  /** Simulation time of the event, in the caller's tick clock. */
  readonly at: number;
}

/** How a Mimic arrived at its locked pose (§5.8). */
export type DisguiseSource = "player_lock" | "recovered_pose" | "default_arrangement";

export type PlayerLifeState = "active" | "caught" | "spectating";

/** 0 unobserved, 1 inside the Inspector's cone, 2 held at close range. */
export type WatchedLevel = 0 | 1 | 2;

/** Which disguise belongs to whom. Never public before the reveal (§27.10). */
export interface DisguiseOwnership {
  readonly publicObjectId: string;
  readonly publicPlayerId: string;
  readonly displayName: string;
  /**
   * How long this disguise lasted. Live while the round runs, final once it
   * reaches the reveal, which is when the whole list becomes readable anyway.
   */
  readonly survivalSeconds: number;
}

export interface PlayerResult {
  readonly publicPlayerId: string;
  readonly displayName: string;
  readonly role: PlayerRole;
  readonly score: number;
  readonly survivalSeconds: number;
  readonly fullRoundSurvival: boolean;
  readonly directLookEscapes: number;
  readonly closePasses: number;
  readonly peerStyleVotes: number;
  readonly correctAccusations: number;
  readonly wrongAccusations: number;
  readonly uniqueObjectsFocused: number;
  /** The disguise this player wore, or null for an Inspector. */
  readonly publicObjectId: string | null;
  /** Whole seconds spent inside an Inspector's focus while still unresolved. */
  readonly lineOfSightSeconds: number;
  /** Taunts performed while an Inspector was actually watching. */
  readonly observedTaunts: number;
}

export type MatchWinner = "inspectors" | "mimics";

export interface MatchResults {
  readonly round: number;
  readonly winner: MatchWinner;
  readonly inspectionDurationMs: number;
  readonly timeRemainingMs: number;
  readonly players: readonly PlayerResult[];
}

export type PlayerLeftReason = "left" | "reconnect_timeout" | "removed";

export type SimEvent =
  | (SimEventBase & {
      readonly type: "player_joined";
      readonly publicPlayerId: string;
      readonly displayName: string;
      readonly isHost: boolean;
    })
  | (SimEventBase & {
      readonly type: "player_left";
      readonly publicPlayerId: string;
      readonly reason: PlayerLeftReason;
    })
  | (SimEventBase & {
      readonly type: "player_connection_changed";
      readonly publicPlayerId: string;
      readonly connected: boolean;
    })
  | (SimEventBase & {
      readonly type: "player_ready_changed";
      readonly publicPlayerId: string;
      readonly ready: boolean;
    })
  | (SimEventBase & { readonly type: "host_changed"; readonly publicPlayerId: string })
  | (SimEventBase & {
      readonly type: "settings_changed";
      readonly changedKeys: readonly string[];
    })
  | (SimEventBase & {
      readonly type: "phase_changed";
      readonly phase: MatchPhase;
      readonly previousPhase: MatchPhase;
      readonly phaseEndsAt: number;
      readonly round: number;
    })
  | (SimEventBase & {
      readonly type: "roles_assigned";
      readonly round: number;
      /** Inspectors are public knowledge; who the Mimics are is not (§27.10). */
      readonly inspectorPublicIds: readonly string[];
      readonly mimicCount: number;
    })
  | (SimEventBase & { readonly type: "baseline_started"; readonly endsAt: number })
  | (SimEventBase & { readonly type: "forge_started"; readonly endsAt: number })
  | (SimEventBase & { readonly type: "disguise_locked"; readonly publicObjectId: string })
  | (SimEventBase & {
      /**
       * A hider adjusted itself during the hunt. The geometry travels in public
       * state rather than in the event, which would repeat kilobytes per tick;
       * this says only which object changed and how current it is.
       */
      readonly type: "disguise_updated";
      readonly publicObjectId: string;
      readonly revision: number;
      /** True when the root actually moved, rather than only reshaping. */
      readonly moved: boolean;
    })
  | (SimEventBase & {
      readonly type: "taunt_performed";
      readonly publicObjectId: string;
      readonly tauntId: TauntId;
      readonly seed: number;
    })
  | (SimEventBase & {
      readonly type: "inspection_started";
      readonly endsAt: number;
      readonly warrantsRemaining: number;
      readonly mimicsRemaining: number;
    })
  | (SimEventBase & {
      readonly type: "accusation_resolved";
      readonly inspectorPublicId: string;
      readonly correct: boolean;
      readonly targetObjectId: string;
      readonly warrantsRemaining: number;
      readonly revealedPlayerPublicId?: string;
      /**
       * The innocent object's response, on a wrong accusation. It also arrives
       * as its own innocent_reaction event for world presentation; carrying it
       * here spares a consumer from joining the two by object id.
       */
      readonly reactionId?: InnocentReactionId;
    })
  | (SimEventBase & {
      readonly type: "innocent_reaction";
      readonly objectId: string;
      readonly reactionId: InnocentReactionId;
      readonly seed: number;
    })
  | (SimEventBase & {
      readonly type: "mimic_caught";
      readonly publicObjectId: string;
      readonly publicPlayerId: string;
      readonly survivalSeconds: number;
      readonly mimicsRemaining: number;
    })
  | (SimEventBase & {
      readonly type: "direct_look_escape";
      readonly publicObjectId: string;
      readonly inspectorPublicId: string;
    })
  | (SimEventBase & {
      readonly type: "close_pass";
      readonly publicObjectId: string;
      readonly inspectorPublicId: string;
    })
  | (SimEventBase & {
      readonly type: "result_vote_cast";
      readonly voterPublicId: string;
      readonly category: ResultVoteCategory;
      readonly targetPublicObjectId: string;
    })
  | (SimEventBase & {
      readonly type: "rematch_vote_cast";
      readonly voterPublicId: string;
      readonly yes: boolean;
      readonly yesVotes: number;
      readonly totalVoters: number;
    })
  | (SimEventBase & {
      readonly type: "match_ended";
      readonly winner: MatchWinner;
      readonly results: MatchResults;
    })
  | (SimEventBase & { readonly type: "rematch_started"; readonly round: number });

export type SimEventType = SimEvent["type"];

/**
 * Events addressed to one player. The simulation queues them per player, so a
 * secret has no route into a broadcast.
 */
export type PrivateSimEvent =
  | (SimEventBase & {
      readonly type: "role_assigned";
      readonly round: number;
      readonly role: PlayerRole;
      readonly publicPlayerId: string;
      /** Public ids of players sharing this role. */
      readonly teammatePublicIds: readonly string[];
    })
  | (SimEventBase & {
      readonly type: "own_disguise_locked";
      readonly publicObjectId: string;
      readonly autoLocked: boolean;
      readonly source: DisguiseSource;
      /** Set only when the pose fell back to a starting arrangement (§5.8). */
      readonly defaultArrangementId: StarterArrangementId | null;
    })
  | (SimEventBase & {
      readonly type: "disguise_owners";
      readonly owners: readonly DisguiseOwnership[];
    })
  | (SimEventBase & {
      /**
       * The tension indicator of §5.12, which survives the live-hider redesign.
       * It says only how strongly this hider is being looked at, never by whom
       * or from how far, and it is delivered to that hider alone.
       */
      readonly type: "watched";
      readonly level: WatchedLevel;
    });

export type PrivateSimEventType = PrivateSimEvent["type"];

/**
 * Everything one call produced: events for the whole room, and a queue per
 * player who has something addressed to them. A transport broadcasts `public`
 * and sends each `private` entry to its named player, and no other routing is
 * correct.
 */
export interface SimOutput {
  readonly public: readonly SimEvent[];
  readonly private: ReadonlyMap<string, readonly PrivateSimEvent[]>;
}

/** One event variant without the fields the simulation stamps on emission. */
export type SimEventDraft = SimEvent extends infer Variant
  ? Variant extends SimEvent
    ? Omit<Variant, "seq" | "at">
    : never
  : never;

export type PrivateSimEventDraft = PrivateSimEvent extends infer Variant
  ? Variant extends PrivateSimEvent
    ? Omit<Variant, "seq" | "at">
    : never
  : never;
