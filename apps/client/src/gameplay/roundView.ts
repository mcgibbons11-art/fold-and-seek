import type {
  InnocentReactionId,
  MatchWinner,
  PlayerLifeState,
  ResultVoteCategory,
  WatchedLevel,
} from "@foldseek/game-sim";
import type { MatchPhase, PlayerRole, StarterArrangementId } from "@foldseek/shared";

import type { ConnectionStatus, NetworkMode } from "../networking/NetworkAdapter";

/**
 * The one state the round HUD renders from (§12.2, §12.3). RoundDirector builds
 * it out of the adapter's public events, private events, roster, sync, and
 * rejections so that no component has to know which of those a fact came from,
 * and no component imports the simulation.
 *
 * Every timestamp named `...ServerMs` belongs to the authority's clock, which is
 * the only clock a phase deadline is expressed in. `timer.remainingMs` is the
 * one already converted to this machine's clock; see RoundDirector for how the
 * offset between the two is estimated.
 */

export type ActionBlockReason =
  | "not_connected"
  | "wrong_phase"
  | "wrong_role"
  | "not_host"
  | "player_not_active"
  | "not_enough_players"
  | "players_not_ready"
  | "already_locked"
  | "no_warrants"
  | "accusation_cooldown"
  | "taunt_cooldown"
  /** The authority is running a build that does not know this command. */
  | "unsupported"
  | "duplicate_vote"
  | "target_unknown";

/** Whether a verb may be issued now, and what is stopping it when it may not. */
export interface ActionGate {
  readonly allowed: boolean;
  readonly reason: ActionBlockReason | null;
}

export type RoundActionName =
  | "ready"
  | "startMatch"
  | "lockDisguise"
  | "accuse"
  | "focus"
  | "taunt"
  | "voteResult"
  | "voteRematch";

export type ActionAvailability = Readonly<Record<RoundActionName, ActionGate>>;

/**
 * Commands the authority has shown it understands. A client can be newer than
 * the room it joined, so a verb the simulation added recently is sent
 * optimistically and switched off if the authority refuses it as unknown.
 */
export interface RoundCapabilities {
  readonly taunt: boolean;
}

export interface PhaseTimerView {
  /** Deadline in the authority's clock. Zero when the phase has no deadline. */
  readonly endsAtServerMs: number;
  /** Milliseconds left on this machine's clock, never negative. */
  readonly remainingMs: number;
  /** Whole seconds left, rounded up, which is what the HUD prints. */
  readonly secondsRemaining: number;
  /** Length of the phase, for a progress arc. Zero when unknown. */
  readonly totalMs: number;
  readonly running: boolean;
  /** True through MatchPhase.FinalCountdown, the §5.13 treatment. */
  readonly finalTen: boolean;
}

export interface OwnDisguiseSummary {
  readonly publicObjectId: string;
  readonly encodedPose: string;
  readonly defaultArrangementId: StarterArrangementId | null;
  /** True when the pose was auto-locked or recovered rather than sent by hand. */
  readonly autoLocked: boolean;
}

export interface SelfView {
  /** Transport identity, from the adapter. Not the id events are stamped with. */
  readonly transportId: string | null;
  /** Identity every event names this player by. Null before the first sync. */
  readonly publicPlayerId: string | null;
  readonly displayName: string;
  /** Null until the private role_assigned event of the current round arrives. */
  readonly role: PlayerRole | null;
  readonly lifeState: PlayerLifeState;
  readonly isHost: boolean;
  readonly ready: boolean;
  readonly ownDisguise: OwnDisguiseSummary | null;
  readonly disguiseLocked: boolean;
  /** Inspector only; null for every other role. */
  readonly warrantsRemaining: number | null;
  readonly accusationReadyAtServerMs: number | null;
  /** Milliseconds until the next accusation is allowed. Zero when ready. */
  readonly accusationCooldownMs: number;
  /** Milliseconds until this hider may taunt again. Zero when ready. */
  readonly tauntCooldownMs: number;
  /** How hard an Inspector is looking at this hider: 0 none, 1 cone, 2 close. */
  readonly watchedLevel: WatchedLevel;
}

export interface RosterPlayerView {
  /**
   * Transport seat, which is what connection-level identities are expressed in.
   * Events never carry it, so it attributes a roster row and nothing else.
   */
  readonly seatId: string;
  readonly publicPlayerId: string;
  readonly displayName: string;
  readonly isSelf: boolean;
  /** True for the peer running the authoritative simulation, if any. */
  readonly isAuthority: boolean;
  readonly isHost: boolean;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly lifeState: PlayerLifeState;
  /** Mimic identity stays "unknown" until the reveal (§27.10). */
  readonly rolePublicState: "unknown" | "inspector" | "spectator" | "mimic";
}

export interface AccusationFeedEntry {
  /** Event sequence number, stable across republishes, usable as a React key. */
  readonly id: number;
  readonly atServerMs: number;
  readonly inspectorPublicId: string;
  readonly byMe: boolean;
  readonly targetObjectId: string;
  readonly correct: boolean;
  /** Stamp copy from §41.4 or §41.5. */
  readonly stamp: string;
  /** Null until the accompanying innocent_reaction arrives, and on a catch. */
  readonly reactionId: InnocentReactionId | null;
  readonly revealedPlayerPublicId: string | null;
  readonly revealedDisplayName: string | null;
  readonly warrantsRemaining: number;
}

export interface RevealEntryView {
  readonly publicObjectId: string;
  readonly encodedPose: string;
  readonly defaultArrangementId: StarterArrangementId | null;
  /** True once the room may see what this object was. */
  readonly revealed: boolean;
  readonly caught: boolean;
  readonly publicPlayerId: string | null;
  readonly displayName: string | null;
  /** Live while the round runs, final once it reaches the reveal. */
  readonly survivalSeconds: number | null;
}

export interface RevealView {
  readonly entries: readonly RevealEntryView[];
  readonly survivors: readonly RevealEntryView[];
  readonly caught: readonly RevealEntryView[];
}

export interface ResultRowView {
  readonly publicPlayerId: string;
  readonly displayName: string;
  readonly isSelf: boolean;
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
  /** The disguise this player wore, once ownership is known. Null otherwise. */
  readonly publicObjectId: string | null;
}

export interface VoteCandidateView {
  readonly publicObjectId: string;
  readonly publicPlayerId: string;
  readonly displayName: string;
}

export interface ResultsView {
  readonly round: number;
  readonly winner: MatchWinner;
  readonly inspectionDurationMs: number;
  readonly timeRemainingMs: number;
  readonly rows: readonly ResultRowView[];
  /** Disguises this player may vote for, self excluded (§5.15). */
  readonly voteCandidates: readonly VoteCandidateView[];
  readonly myVotes: Readonly<Record<ResultVoteCategory, string | null>>;
}

export interface RematchView {
  readonly yesVotes: number;
  readonly totalVoters: number;
  /** This player's own vote, or null when they have not voted. */
  readonly myVote: boolean | null;
}

export interface RejectionView {
  readonly id: number;
  readonly commandType: string;
  readonly reason: string;
  readonly detail: string | null;
}

export interface ConnectionView {
  readonly mode: NetworkMode;
  readonly status: ConnectionStatus;
  readonly canRejoin: boolean;
  readonly detail: string | null;
}

export interface RoundViewState {
  readonly connection: ConnectionView;
  readonly round: number;
  readonly phase: MatchPhase;
  readonly previousPhase: MatchPhase | null;
  /** Phase headline from §41.1, or null for a phase the copy deck does not name. */
  readonly phaseLabel: string | null;
  readonly timer: PhaseTimerView;
  readonly self: SelfView;
  readonly roster: readonly RosterPlayerView[];
  readonly warrantsRemaining: number | null;
  /** Warrants the round started with, so the HUD can draw the spent ones. */
  readonly warrantsTotal: number | null;
  readonly mimicsRemaining: number;
  /** Most recent first, capped by the director's feed limit. */
  readonly accusations: readonly AccusationFeedEntry[];
  readonly reveal: RevealView;
  readonly results: ResultsView | null;
  readonly rematch: RematchView;
  /** Most recent first. Refusals of this player's own commands only. */
  readonly rejections: readonly RejectionView[];
  readonly actions: ActionAvailability;
  readonly capabilities: RoundCapabilities;
  /** Authority clock minus this machine's clock, in milliseconds. */
  readonly clockOffsetMs: number;
}
