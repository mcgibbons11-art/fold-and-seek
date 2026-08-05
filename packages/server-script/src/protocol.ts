import type { MatchCommand, PrivateSimEvent, PublicMatchState, SimEvent } from "@foldseek/game-sim";

/**
 * The wire between a Portals client and the authoritative server script.
 *
 * It is deliberately much smaller than `portalsProtocol.ts`, which the
 * host-elected client needed: there is no authority term to carry, no host to
 * address, no migration snapshot to publish, and no election to arbitrate,
 * because the authority is a participant the relay itself starts and nobody
 * can become.
 *
 * Privacy works exactly as it does today. `server.send` reaches every player
 * with no addressed variant, and the existing protocol already broadcasts
 * private events carrying the seat they belong to, filtered on arrival. The
 * server therefore stamps each private batch with its recipient rather than
 * pretending to have a private channel it does not have.
 */

export const SERVER_PROTOCOL_VERSION = 1;

/** State key holding the server's presence, which is also how clients detect it. */
export const SERVER_HELLO_KEY = "server:hello";
/**
 * Key range holding the authoritative public match state.
 *
 * A range rather than a key because the state does not fit one. Measured at
 * six seats with disguises manifested it reaches about 27 KB against an 8 KB
 * per-value ceiling, so it is published in sequenced chunks and reassembled
 * on arrival. Eight keys is roughly double the four that measurement needs,
 * which leaves room for the state to grow without a protocol change.
 */
export const SERVER_STATE_KEYS = [
  "server:match0",
  "server:match1",
  "server:match2",
  "server:match3",
  "server:match4",
  "server:match5",
  "server:match6",
  "server:match7",
] as const;

export const MAX_SERVER_STATE_CHUNKS = SERVER_STATE_KEYS.length;

/** What the sandbox allows the authority in total, documented as about thirty. */
export const SERVER_STATE_WRITES_PER_SECOND = 30;
/** What the authority may broadcast in a second, documented as about sixty. */
export const SERVER_BROADCASTS_PER_SECOND = 60;
/**
 * State key carrying the authority's own diagnostics.
 *
 * `server.log` output is not surfaced anywhere a developer can read it, so the
 * few things worth knowing about a running session - a refused seat, a send the
 * relay would not take - are published as state instead. Without this the
 * script's error paths are silent in production.
 */
export const SERVER_DEBUG_KEY = "server:debug";

/**
 * Two identities travel in this protocol and they are not interchangeable.
 *
 * A *connection* id is one live socket, and is what the relay stamps on an
 * arriving message. A *seat* id is who the simulation thinks is playing, taken
 * from the signed-in player id so that dropping and returning keeps a player's
 * disguise, warrants, and score. One player who opens the game twice holds two
 * connections and two seats.
 *
 * `sync` is addressed by connection because it is what tells a fresh client
 * which seat it got. Everything after that is addressed by seat.
 */
export interface ServerDebug {
  readonly at: number;
  readonly note: string;
}

export interface ServerHello {
  readonly v: number;
  /** Bumped whenever the session's simulation is replaced, so clients resync. */
  readonly epoch: number;
}

export type ClientToServer =
  | {
      readonly v: number;
      readonly t: "cmd";
      readonly cmd: MatchCommand;
      /**
       * The shot origin, paired atomically with the command that needs it. A
       * client reports its own eye - the relay gives the server no way to
       * observe a player directly - but every use of it is still judged here
       * against the map's real geometry.
       */
      readonly eye?: readonly [number, number, number];
    }
  | { readonly v: number; readonly t: "eye"; readonly eye: readonly [number, number, number] | null }
  | { readonly v: number; readonly t: "resync" };

export type ServerToClient =
  | {
      readonly v: number;
      readonly t: "ev";
      readonly public: readonly SimEvent[];
      /** Private batches, each stamped with the seat that may act on it. */
      readonly private: readonly (readonly [string, readonly PrivateSimEvent[]])[];
    }
  | {
      readonly v: number;
      readonly t: "sync";
      /** The connection this answers, which may not have a seat yet. */
      readonly to: string;
      /** The seat that connection holds, and the id it is addressed by after this. */
      readonly seat: string;
      readonly publicState: PublicMatchState;
      readonly privateState: unknown;
    }
  | { readonly v: number; readonly t: "rejected"; readonly to: string; readonly reason: string };
