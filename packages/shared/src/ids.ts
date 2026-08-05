import { LIMITS } from "./schemas";

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type PlayerId = Brand<string, "PlayerId">;
export type PublicPlayerId = Brand<string, "PublicPlayerId">;
export type EntityId = Brand<string, "EntityId">;
export type ObjectId = Brand<string, "ObjectId">;
export type MaterialSwatchId = Brand<string, "MaterialSwatchId">;
export type MatchId = Brand<string, "MatchId">;

let idCounter = 0;

/** Generates a compact unique ID: time component + counter + entropy. */
export function generateId(prefix = ""): string {
  idCounter = (idCounter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const entropy = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${prefix}${time}-${idCounter.toString(36)}-${entropy}`;
}

/**
 * Marks the second and later seats of one account.
 *
 * Portals ids never contain it, so a seat carrying it is always a derived one
 * and the base id can be read back off the front.
 */
export const DERIVED_SEAT_SEPARATOR = "~";

/** One connection, as the relay describes it: an account and a socket. */
export interface SeatIdentity {
  readonly id: string;
  readonly playerId?: string | null;
}

/**
 * The seat a connection plays under when its account is not already at a
 * keyboard.
 *
 * Keying on the signed-in account rather than the connection is what carries a
 * player's role, disguise, warrants, and score through a dropped connection.
 * A signed-out guest has no account, so their connection is the best identity
 * available and their seat lasts exactly as long as the socket does.
 */
export function baseSeatIdOf(player: SeatIdentity): string {
  return player.playerId ?? player.id;
}

/**
 * The seat a second live connection of one account takes.
 *
 * The connection id is kept whole and the account id is trimmed to fit, because
 * the connection id is what makes the seat unique: two accounts whose ids share
 * a prefix would collide if the trimming went the other way, while no two live
 * connections ever share an id. The result must fit `LIMITS.idLength`, which is
 * the bound every schema carrying a seat applies.
 */
export function derivedSeatId(baseSeatId: string, connectionId: string): string {
  const suffix = `${DERIVED_SEAT_SEPARATOR}${connectionId}`;
  const room = Math.max(0, LIMITS.idLength - suffix.length);
  return `${baseSeatId.slice(0, room)}${suffix}`.slice(0, LIMITS.idLength);
}
