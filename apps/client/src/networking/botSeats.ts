import type {
  MatchCommand,
  MatchSimulation,
  PrivateMatchState,
  PublicMatchState,
  SimEvent,
} from "@foldseek/game-sim";
import { LIMITS, MatchPhase } from "@foldseek/shared";

/**
 * Seats filled by the machine rather than by a person, and the one place that
 * decides what those seats do.
 *
 * A bot is a player of the authoritative simulation like any other: it holds a
 * seat, is dealt a role, locks a disguise and appears in the roster every client
 * renders. What it is not is a connection. Nothing is listening on a bot's seat,
 * so whoever runs the simulation has to act for it, which is what `drive` is.
 *
 * Both transports that run a simulation in the page use this: the loopback,
 * where the bots are the practice round's opponents, and the Portals host, where
 * they fill a room that is short of people. Neither one has its own copy.
 */

/**
 * Marks a seat as a bot's, and is why a bot can never be confused for a player.
 *
 * The Portals transport builds a seat from a Portals account id, a connection
 * id, or one joined to the other by `DERIVED_SEAT_SEPARATOR`. Portals produces
 * `~` in neither half — that is the premise the derived seat already rests on —
 * so a real seat carries at most one separator and this marker carries two. The
 * loopback shares the scheme rather than inventing a second one, since a bot
 * seat means the same thing on both.
 */
export const BOT_SEAT_MARKER = "~bot~";

/** The seat the nth bot of a room takes. Bounded well under `LIMITS.idLength`. */
export function botSeatId(index: number): string {
  return `${BOT_SEAT_MARKER}${index}`;
}

export function isBotSeat(seatId: string): boolean {
  return seatId.startsWith(BOT_SEAT_MARKER);
}

/** The index in a bot seat, or null when the seat is not a bot's. */
export function botSeatIndex(seatId: string): number | null {
  if (!isBotSeat(seatId)) return null;
  const index = Number.parseInt(seatId.slice(BOT_SEAT_MARKER.length), 10);
  return Number.isSafeInteger(index) && index > 0 ? index : null;
}

/**
 * What one bot may do on one tick. A command is anything a player could send;
 * a forge snapshot is the pose channel, which is not a command because it is
 * validated on its own terms (creep speed, revision, play volume).
 */
export type BotAction =
  | { readonly kind: "command"; readonly command: MatchCommand }
  | { readonly kind: "forge_snapshot"; readonly encodedPose: string; readonly revision: number };

export interface BotTurn {
  /** Seat order, which is what `botPose` indexes bot disguises by. */
  readonly index: number;
  readonly playerId: string;
  readonly nowMs: number;
  readonly publicState: PublicMatchState;
  /**
   * This bot's own private state. No other seat's is ever offered here, so a
   * brain cannot read another player's role or disguise even by mistake.
   */
  readonly privateState: PrivateMatchState;
}

export interface BotBrain {
  act(turn: BotTurn): readonly BotAction[];
  /** A bot that has left the room, so any state kept for it can go. */
  release?(playerId: string): void;
}

export interface BotSeatOptions {
  /**
   * Encoded disguise an auto-playing bot locks, by seat order. Returning null
   * leaves the bot to the simulation's §5.8 fallback, which is a starting
   * arrangement at the world origin rather than anywhere in the room.
   */
  readonly botPose?: (index: number, playerId: string) => string | null;
  /**
   * Behaviour beyond readying up, locking and voting on a rematch: patrolling,
   * accusing, creeping. Omitted, bots hide and do nothing else, and a round in
   * which the bots inspect runs the clock out.
   */
  readonly botBrain?: BotBrain;
}

export interface AddBotOptions {
  readonly displayName?: string;
  /** Bots ready up and lock a placeholder pose so a solo round can progress. */
  readonly autoPlay?: boolean;
}

export interface BotSeatRecord {
  readonly playerId: string;
  readonly displayName: string;
  readonly autoPlay: boolean;
}

/**
 * Where a driven bot's commands go. Both adapters already have a path that runs
 * one simulation call and publishes what it produced; this is that path, with
 * the refusal reporting left out, because a refusal addressed to a bot's seat
 * has no one to reach.
 */
export interface BotSeatSink {
  applyCommand(playerId: string, command: MatchCommand): void;
  applyForgeSnapshot(
    playerId: string,
    encodedPose: string,
    revision: number,
    nowMs: number,
  ): void;
}

const BOT_POSE_PREFIX = "bot-pose-";

/** The two phases in which a rematch vote may be cast (§5.15). */
function isRematchPhase(phase: MatchPhase): boolean {
  return phase === MatchPhase.Results || phase === MatchPhase.RematchVote;
}

export class BotSeats {
  private readonly options: BotSeatOptions;
  private readonly seats: BotSeatRecord[] = [];
  /**
   * Monotonic, so a seat id is never reused. A disguise outlives the player who
   * locked it (§27.9), and handing a fresh bot the seat of one that just left
   * would hand it that disguise as well.
   */
  private nextIndex = 1;

  /** How each player voted on a rematch, keyed by the id events name them by. */
  private readonly rematchVotes = new Map<string, boolean>();
  /** Bot seats whose vote this driver has already cast in the current phase. */
  private readonly rematchCast = new Set<string>();

  constructor(options: BotSeatOptions = {}) {
    this.options = options;
  }

  list(): readonly BotSeatRecord[] {
    return this.seats;
  }

  ids(): readonly string[] {
    return this.seats.map((seat) => seat.playerId);
  }

  has(playerId: string): boolean {
    return this.seats.some((seat) => seat.playerId === playerId);
  }

  /** Reserves the next seat. The caller seats it in the simulation. */
  add(options: AddBotOptions = {}): BotSeatRecord {
    const index = this.nextIndex;
    this.nextIndex += 1;
    const record: BotSeatRecord = {
      playerId: botSeatId(index),
      displayName: (options.displayName ?? `Bot ${index}`).slice(0, LIMITS.displayNameLength),
      autoPlay: options.autoPlay ?? true,
    };
    this.seats.push(record);
    return record;
  }

  /** Forgets a seat and releases whatever the brain was keeping for it. */
  remove(playerId: string): boolean {
    const index = this.seats.findIndex((seat) => seat.playerId === playerId);
    if (index < 0) return false;
    this.seats.splice(index, 1);
    this.rematchCast.delete(playerId);
    this.options.botBrain?.release?.(playerId);
    return true;
  }

  clear(): void {
    for (const seat of [...this.seats]) this.remove(seat.playerId);
    this.rematchVotes.clear();
  }

  /**
   * Takes over the bot seats a simulation is already holding, which is what a
   * client promoted to host does. The seats came out of the departed host's
   * snapshot, so their ids and names are already decided; all that is left is
   * to start driving them and to keep the counter clear of them.
   */
  adopt(entries: readonly { readonly seatId: string; readonly displayName: string }[]): void {
    for (const entry of entries) {
      if (!isBotSeat(entry.seatId) || this.has(entry.seatId)) continue;
      this.seats.push({
        playerId: entry.seatId,
        displayName: entry.displayName,
        autoPlay: true,
      });
      const index = botSeatIndex(entry.seatId);
      if (index !== null) this.nextIndex = Math.max(this.nextIndex, index + 1);
    }
    this.seats.sort((left, right) => left.playerId.localeCompare(right.playerId));
  }

  /**
   * Reads the room's rematch votes off the event stream. There is no field in
   * the match state carrying them, and the driver needs them to keep the bots
   * out of the decision; see `decideRematch`.
   */
  observe(events: readonly SimEvent[]): void {
    for (const event of events) {
      if (event.type === "rematch_vote_cast") {
        this.rematchVotes.set(event.voterPublicId, event.yes);
        continue;
      }
      if (event.type === "phase_changed" && !isRematchPhase(event.phase)) {
        this.rematchVotes.clear();
        this.rematchCast.clear();
      }
    }
  }

  /**
   * Gets every bot through the round. Readying up in the lobby, locking a
   * disguise in the Forge and answering the rematch are the three things a seat
   * must do for the room to progress at all, so they live here; everything a
   * bot chooses to do in between is the brain's.
   *
   * `nowMs` is the caller's own clock reading and is the only time a brain is
   * given. Ticks are not counted anywhere: the interval driving them is
   * coalesced by the browser whenever the main thread is busy, so a brain that
   * acted per callback would slow down exactly when the match did not.
   */
  drive(sim: MatchSimulation, nowMs: number, sink: BotSeatSink): void {
    if (this.seats.length === 0) return;
    const phase = sim.getPhase();
    const brain = this.options.botBrain;
    const voting = isRematchPhase(phase);
    // Taken once and shared: it is a defensive copy of the whole room, and one
    // per bot per tick would be several disguise poses of garbage a second.
    const publicState = brain === undefined && !voting ? null : sim.getPublicState();
    const rematchVote =
      voting && publicState !== null ? this.decideRematch(publicState) : null;

    for (const [index, bot] of this.seats.entries()) {
      if (!bot.autoPlay) continue;
      const state = sim.getPrivateStateFor(bot.playerId);
      if (!state) continue;

      if ((phase === MatchPhase.Lobby || phase === MatchPhase.Loading) && !state.ready) {
        sink.applyCommand(bot.playerId, { type: "player_ready", ready: true });
        continue;
      }
      if (phase === MatchPhase.Forge && state.role === "mimic" && state.ownDisguise === null) {
        sink.applyCommand(bot.playerId, {
          type: "lock_disguise",
          payload:
            this.options.botPose?.(index, bot.playerId) ?? `${BOT_POSE_PREFIX}${bot.playerId}`,
          revision: 1,
        });
        continue;
      }
      if (voting) {
        if (rematchVote !== null && !this.rematchCast.has(bot.playerId)) {
          this.rematchCast.add(bot.playerId);
          sink.applyCommand(bot.playerId, { type: "vote_rematch", yes: rematchVote });
        }
        continue;
      }
      if (brain === undefined || publicState === null) continue;

      const actions = brain.act({
        index,
        playerId: bot.playerId,
        nowMs,
        publicState,
        privateState: state,
      });
      for (const action of actions) {
        if (action.kind === "command") {
          sink.applyCommand(bot.playerId, action.command);
          continue;
        }
        // A creep is judged on its own terms, so it goes to the pose channel
        // rather than through a command, exactly as a human hider's does, and
        // against the moment the brain decided on it rather than a later
        // reading of the clock, because creep speed is measured over that
        // interval.
        sink.applyForgeSnapshot(bot.playerId, action.encodedPose, action.revision, nowMs);
      }
    }
  }

  /**
   * How the bots answer a rematch, which is: with whichever way the people in
   * the room have already decided, and not at all until they have.
   *
   * The simulation counts every connected player as a voter and needs a strict
   * majority of them to say yes, so bots that abstain are no votes and bots
   * that always say yes can carry a rematch nobody asked for. Mirroring the
   * human majority is exactly neutral instead. Writing H for the connected
   * people, y for their yes votes and B for the bots: a human majority yes
   * means 2y > H, so 2(y + B) > H + B holds and the rematch runs; a human
   * majority no leaves the yes count at y with 2y <= H < H + B, so it does not.
   * Bots therefore never decide a rematch and never block one.
   *
   * Null is "the room has not decided", which covers a split and a room where
   * somebody simply has not voted. It stays null until the window closes, and
   * an undecided room is one that does not rematch either way.
   */
  private decideRematch(publicState: PublicMatchState): boolean | null {
    const people = publicState.players.filter(
      (player) => player.connected && !isBotSeat(player.seatId),
    );
    if (people.length === 0) return null;

    let yes = 0;
    let no = 0;
    for (const person of people) {
      const vote = this.rematchVotes.get(person.publicPlayerId);
      if (vote === true) yes += 1;
      else if (vote === false) no += 1;
    }
    if (yes * 2 > people.length) return true;
    if (no * 2 > people.length) return false;
    return null;
  }
}
