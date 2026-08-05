import { z } from "zod";

/**
 * Splitting one value across several Portals state keys, and putting it back.
 *
 * A state value may not exceed 8 KB, and the authoritative public state passes
 * that as soon as disguises manifest: six seats carrying real poses measure
 * about 27 KB. So the authority publishes across a range of keys and clients
 * reassemble, which is what makes a whole match state fit a store that caps
 * every value.
 *
 * Writes across keys are not atomic. A reader can arrive mid-publication and
 * see the front of a new value and the tail of an old one, which would parse
 * into nonsense. Every chunk therefore carries the sequence number of the
 * publication it belongs to, and only a complete set sharing one sequence is
 * ever assembled.
 */

/** The 8 KB Portals ceiling for a single state value or message. */
export const MAX_STATE_VALUE_BYTES = 8_192;

/**
 * Room for the key's own JSON envelope inside that ceiling: the sequence,
 * the index, the count, and the quoting of the payload itself.
 */
const CHUNK_ENVELOPE_BYTES = 256;

export const StateChunkSchema = z.strictObject({
  seq: z.number().int().min(0),
  i: z.number().int().min(0),
  n: z.number().int().min(1),
  data: z.string(),
});

export type StateChunk = z.infer<typeof StateChunkSchema>;

const encoder = new TextEncoder();

/** The bytes a value occupies once serialised, which is what the cap counts. */
export function jsonByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "").length;
}

/**
 * Cuts a value into as few chunks as will fit the cap, or returns null when
 * even `maxChunks` of them will not hold it.
 *
 * Returning null rather than truncating is deliberate: a silently shortened
 * match state would decode into a plausible-looking round missing players.
 */
export function encodeStateChunks(
  value: unknown,
  seq: number,
  maxChunks: number,
  maxBytes = MAX_STATE_VALUE_BYTES,
): StateChunk[] | null {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  const budget = maxBytes - CHUNK_ENVELOPE_BYTES;

  for (let parts = 1; parts <= maxChunks; parts += 1) {
    const sliceLength = Math.ceil(serialized.length / parts);
    const chunks: StateChunk[] = [];
    for (let index = 0; index < parts; index += 1) {
      chunks.push({
        seq,
        i: index,
        n: parts,
        data: serialized.slice(index * sliceLength, (index + 1) * sliceLength),
      });
    }
    if (chunks.every((chunk) => jsonByteLength(chunk) <= budget)) return chunks;
  }
  return null;
}

/**
 * Reassembles the newest complete value present in a key range.
 *
 * Chunks left behind by an older, longer publication carry a stale sequence and
 * are ignored. The result is raw JSON: the caller validates it, because even
 * from a protected key it is data that crossed a network.
 */
export function decodeStateChunks(
  state: Record<string, unknown>,
  keys: readonly string[],
): { seq: number; value: unknown } | null {
  const bySeq = new Map<number, Map<number, StateChunk>>();
  for (const key of keys) {
    const parsed = StateChunkSchema.safeParse(state[key]);
    if (!parsed.success) continue;
    const chunk = parsed.data;
    const group = bySeq.get(chunk.seq) ?? new Map<number, StateChunk>();
    group.set(chunk.i, chunk);
    bySeq.set(chunk.seq, group);
  }

  for (const [, group] of [...bySeq.entries()].sort(([left], [right]) => right - left)) {
    const first = group.get(0);
    if (!first || group.size !== first.n) continue;
    let serialized = "";
    let complete = true;
    for (let index = 0; index < first.n; index += 1) {
      const chunk = group.get(index);
      if (!chunk) {
        complete = false;
        break;
      }
      serialized += chunk.data;
    }
    if (!complete) continue;
    try {
      return { seq: first.seq, value: JSON.parse(serialized) as unknown };
    } catch {
      // A torn set is indistinguishable from a corrupt one here, so fall
      // through to an older sequence that may still be whole.
      continue;
    }
  }
  return null;
}
