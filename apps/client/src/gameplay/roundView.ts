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
  | "target_unknown"
  /** Every seat the settings allow is taken. */
  | "room_full";

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
  /** A seat the machine plays, filling out a room short of people. */
  readonly isBot: boolean;
}

/** The lobby's bot controls, and what the room currently holds. */
export interface BotSeatsView {
  /** True on a transport that can hold bot seats at all. */
  readonly supported: boolean;
  /** True when this client may add or remove one right now, which is the host. */
  readonly canManage: boolean;
  readonly count: number;
  /** Seats the settings allow in total, people and bots together. */
  readonly maxSeats: number;
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

/** The two things a hider earns by being looked at and surviving it (§6.2). */
export type DeceptionEventKind = "direct_look_escape" | "close_pass";

export interface DeceptionEventView {
  /** Event sequence number, stable across republishes, usable as a React key. */
  readonly id: number;
  readonly atServerMs: number;
  readonly kind: DeceptionEventKind;
  /** What the simulation's own scoring weight pays for it. */
  readonly points: number;
}

/**
 * Score feedback for the viewer's own disguise, and only ever for that.
 *
 * `direct_look_escape` and `close_pass` are broadcast events naming a public
 * object, and the one client that can say whose object it is, is its owner.
 * Showing either to an Inspector would tell them that the thing they just
 * walked past was a person, which is the answer they are paying warrants for,
 * so RoundDirector fills this in for a hider and leaves it empty for everyone
 * else.
 */
export interface DeceptionView {
  /** Most recent first, capped by the director's feed limit. */
  readonly recent: readonly DeceptionEventView[];
  readonly directLookEscapes: number;
  readonly closePasses: number;
  /** Points these two terms have earned so far this round. */
  readonly points: number;
}

export interface MissedFindsRowView {
  /** Position on the board, counting from one, which is what the HUD prints. */
  readonly rank: number;
  readonly publicPlayerId: string;
  readonly displayName: string;
  /** Bucketed while the round runs, exact on the board published at the reveal. */
  readonly points: number;
  readonly isSelf: boolean;
}

/**
 * The live missed-finds board (the original's Missed-Spot Ranking). It arrives
 * only as an event on a jittered cycle: there is no field in the match state
 * carrying it, so a player who joins mid-round has no board until the next
 * report lands, and `received` is what says so.
 */
export interface MissedFindsView {
  readonly received: boolean;
  readonly rows: readonly MissedFindsRowView[];
  /** Deadline for the next board in the authority's clock. Zero when none is due. */
  readonly nextUpdateAtServerMs: number;
  /** Seconds until that board, or null once no further one is coming. */
  readonly secondsToNextUpdate: number | null;
  /** True for the exact board published at the reveal. */
  readonly final: boolean;
}

export interface RevealEntryView {
  readonly publicObjectId: string;
  readonly encodedPose: string;
  /** Body paint, so the reveal shows the disguise as the room saw it. */
  readonly encodedPaint: string | null;
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

/**
 * How each award is running: votes cast so far, per category, counted by the
 * disguise they were cast for.
 *
 * The simulation broadcasts every `result_vote_cast` to the whole room and keeps
 * no running total in its state, so this is counted from the event stream on the
 * way past. A player who joins during the results screen therefore sees only the
 * votes cast after they arrived, which is the same limit the missed-finds board
 * has and is why nothing here is presented as a final figure.
 */
export type VoteTallies = Readonly<
  Record<ResultVoteCategory, Readonly<Record<string, number>>>
>;

export interface ResultsView {
  readonly round: number;
  readonly winner: MatchWinner;
  readonly inspectionDurationMs: number;
  readonly timeRemainingMs: number;
  readonly rows: readonly ResultRowView[];
  /** Disguises this player may vote for, self excluded (§5.15). */
  readonly voteCandidates: readonly VoteCandidateView[];
  readonly myVotes: Readonly<Record<ResultVoteCategory, string | null>>;
  readonly voteTallies: VoteTallies;
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
  /** Local monotonic deadline after which the HUD must stop showing it. */
  readonly expiresAtLocalMs: number;
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
  readonly botSeats: BotSeatsView;
  readonly warrantsRemaining: number | null;
  /** Warrants the round started with, so the HUD can draw the spent ones. */
  readonly warrantsTotal: number | null;
  /**
   * One seeker's allowance. `warrantsTotal` counts the room's, which is twice
   * this in a two-seeker round, so the magazine is drawn from this instead.
   */
  readonly warrantsPerInspector: number | null;
  readonly mimicsRemaining: number;
  /** Most recent first, capped by the director's feed limit. */
  readonly accusations: readonly AccusationFeedEntry[];
  readonly missedFinds: MissedFindsView;
  /** This player's own deception score as it happens. Empty for an Inspector. */
  readonly deception: DeceptionView;
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
