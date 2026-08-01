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
