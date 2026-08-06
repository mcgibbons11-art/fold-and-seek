import type { MatchCommand, PrivateSimEvent, PublicMatchState, SimEvent } from "@foldseek/game-sim";

/**
 * The authority's view of the wire it shares with the client.
 *
 * The keys, limits, and envelope shapes live in @foldseek/shared so the client
 * reads exactly what this writes. Only the payloads differ: here they are the
 * simulation's own types, because this side produces them, while the client
 * validates what arrives.
 */

export {
  MAX_SERVER_STATE_CHUNKS,
  SERVER_BROADCASTS_PER_SECOND,
  SERVER_DEBUG_KEY,
  SERVER_HELLO_KEY,
  SERVER_PROTOCOL_VERSION,
  SERVER_STATE_KEYS,
  SERVER_STATE_WRITES_PER_SECOND,
  type ServerDebug,
  type ServerHello,
} from "@foldseek/shared";

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
