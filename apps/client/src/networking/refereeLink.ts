import {
  decodeStateChunks,
  SERVER_HELLO_KEY,
  SERVER_PROTOCOL_VERSION,
  SERVER_STATE_KEYS,
  type ServerHello,
} from "@foldseek/shared";
import { z } from "zod";

/**
 * The client's half of the conversation with the authoritative server script.
 *
 * Portals runs `server.js` as an invisible participant that holds the only
 * simulation and owns every `server:`-prefixed state key, which no client can
 * write. When it is there, no client is authoritative and this link carries
 * commands to it and its verdicts back.
 *
 * It is deliberately allowed to be ABSENT. A crashed or over-budget server
 * does not end a Portals session and disconnects nobody, and the platform's
 * own guidance is to keep the game playable without one, so this reports
 * presence and the adapter falls back to electing a host among the players.
 *
 * Everything arriving here is validated. A protected key cannot be forged by
 * another player, but it still crossed a network, and `send` is an ordinary
 * broadcast that any client could imitate - so a message claiming to be the
 * referee is only believed when it does not come from a known seat.
 */

/** Beats of silence before a referee that has stopped publishing is given up. */
export const REFEREE_SILENCE_MS = 6_000;

const HelloSchema = z.object({
  v: z.number().int(),
  epoch: z.number().int().min(0),
});

const EventsSchema = z.object({
  v: z.number().int(),
  t: z.literal("ev"),
  public: z.array(z.unknown()),
  private: z.array(z.tuple([z.string(), z.array(z.unknown())])),
});

const SyncSchema = z.object({
  v: z.number().int(),
  t: z.literal("sync"),
  to: z.string(),
  seat: z.string(),
  publicState: z.unknown(),
  privateState: z.unknown(),
});

const RejectedSchema = z.object({
  v: z.number().int(),
  t: z.literal("rejected"),
  to: z.string(),
  reason: z.string(),
});

export type RefereeMessage =
  | { readonly kind: "events"; readonly public: unknown[]; readonly private: [string, unknown[]][] }
  | {
      readonly kind: "sync";
      readonly to: string;
      readonly seat: string;
      readonly publicState: unknown;
      readonly privateState: unknown;
    }
  | { readonly kind: "rejected"; readonly to: string; readonly reason: string };

/**
 * Reads a relay message that claims to come from the referee.
 *
 * `isKnownSeat` is what makes the claim checkable: the server is not in the
 * roster, so a referee message whose sender IS a seated player is a peer
 * impersonating the authority and is discarded.
 */
export function readRefereeMessage(
  data: unknown,
  fromId: string | null,
  isKnownSeat: (id: string) => boolean,
): RefereeMessage | null {
  if (typeof data !== "object" || data === null) return null;
  if (fromId !== null && isKnownSeat(fromId)) return null;
  const envelope = data as { v?: unknown; t?: unknown };
  if (envelope.v !== SERVER_PROTOCOL_VERSION) return null;

  if (envelope.t === "ev") {
    const parsed = EventsSchema.safeParse(data);
    if (!parsed.success) return null;
    return {
      kind: "events",
      public: [...parsed.data.public],
      private: parsed.data.private.map(([seat, events]) => [seat, [...events]]),
    };
  }
  if (envelope.t === "sync") {
    const parsed = SyncSchema.safeParse(data);
    if (!parsed.success) return null;
    const { to, seat, publicState, privateState } = parsed.data;
    return { kind: "sync", to, seat, publicState, privateState };
  }
  if (envelope.t === "rejected") {
    const parsed = RejectedSchema.safeParse(data);
    if (!parsed.success) return null;
    return { kind: "rejected", to: parsed.data.to, reason: parsed.data.reason };
  }
  return null;
}

/** Reads the presence announcement, or null when the value is not one. */
export function readRefereeHello(value: unknown): ServerHello | null {
  const parsed = HelloSchema.safeParse(value);
  if (!parsed.success) return null;
  // A referee speaking a protocol this build does not know is worse than
  // none: it would be authoritative over a game that cannot read its verdicts.
  if (parsed.data.v !== SERVER_PROTOCOL_VERSION) return null;
  return parsed.data;
}

/** Reassembles the authoritative public state from its key range. */
export function readRefereeState(state: Record<string, unknown>): unknown | null {
  return decodeStateChunks(state, SERVER_STATE_KEYS)?.value ?? null;
}

/** True for any state key the referee owns, which no client may write. */
export function isRefereeKey(key: string): boolean {
  return key === SERVER_HELLO_KEY || (SERVER_STATE_KEYS as readonly string[]).includes(key);
}
