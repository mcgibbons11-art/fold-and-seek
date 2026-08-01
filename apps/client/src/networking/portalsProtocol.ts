import type { PrivateSimEvent, PublicMatchState, SimEvent } from "@foldseek/game-sim";
import {
  DEFAULT_MATCH_SETTINGS,
  ForgeSnapshotSchema,
  LIMITS,
  MatchCommandSchema,
  PaintUpdateSchema,
  PrivateSimEventSchema,
  SimEventSchema,
} from "@foldseek/shared";
import { z } from "zod";
import {
  CommandRejectionSchema,
  PublicMatchStateSchema,
  PrivateMatchStateSchema,
} from "./stateSchemas";

/**
 * Wire format for the Portals.net relay, plus the budgeting helpers that keep
 * it inside the documented limits (docs/PORTALS_CONSTRAINTS.md): 8 KB per
 * net.send, ~20 sends/s per player, 8 KB per net.setState value, 64 keys.
 */

export const PORTALS_PROTOCOL_VERSION = 1;

/** Hard ceiling for one net.send payload and for one net.setState value. */
export const MAX_PAYLOAD_BYTES = 8_192;
/** Relay allowance per player per second. */
export const SEND_RATE_LIMIT = 20;
export const RATE_WINDOW_MS = 1_000;
/** Snapshot writes are held well under the relay's ~10 writes/s. */
export const SNAPSHOT_WRITES_PER_SECOND = 2;
/** Shared-state writes the relay accepts per second across every key. */
export const STATE_WRITES_PER_SECOND = 10;
/**
 * Public match state, for every client's UI and for late joiners. One key per
 * chunk; `match` is first so a one-chunk publication uses it alone.
 */
export const SNAPSHOT_STATE_KEYS = ["match", "match1", "match2", "match3"] as const;
/**
 * The authoritative simulation snapshot, read only by a client taking over as
 * host (§27.11).
 *
 * SECRET MATERIAL, DELIBERATELY PUBLISHED. This carries every Mimic's role and
 * the disguise-to-player mapping, and Portals shared state is readable by every
 * client in the room. There is no private storage on the relay and any client
 * may become host, so a round that survives its host losing connection has to
 * put this where the next host can reach it. That is the §43.8 party-stakes
 * tradeoff taken knowingly and at its widest: a modified client can read the
 * whole round's secrets out of room state at any time, not merely snoop
 * broadcasts. It is written only while a round is actually in progress.
 */
export const SIM_STATE_KEYS = ["sim", "sim1", "sim2", "sim3"] as const;
/**
 * Locked disguise poses, keyed by public object id.
 *
 * They live apart from the rest of the public state because they are large and
 * they never change: one canonical pose is about 4 KB of JSON, so a full room
 * is around 44 KB, far past what one publication can carry, and republishing it
 * twice a second alongside the phase clock would burn the whole write budget
 * for data that was already final. This range is written only when the set of
 * locked poses actually changes.
 *
 * Twelve keys because the largest room fills eight of them today and a pose
 * that grows a few panels would otherwise have nowhere to go.
 */
export const POSE_STATE_KEYS = [
  "pose",
  "pose1",
  "pose2",
  "pose3",
  "pose4",
  "pose5",
  "pose6",
  "pose7",
  "pose8",
  "pose9",
  "pose10",
  "pose11",
] as const;

/**
 * Body-paint layers, keyed by public object id, on the same terms as the poses:
 * public appearance, too large for the publication, and written only when the
 * set of layers changes.
 *
 * Twenty keys because a paint layer is much larger than a pose, and about to
 * grow again. The range is sized for the wire's own ceiling rather than for
 * what a layer costs today, so that raising the stroke format does not quietly
 * take a room past the keys it has: a full room of maximum layers must fit, or
 * nothing in the range publishes at all.
 *
 * At MAX_PAINT_STROKES stamps and PAINT_STROKE_BYTES per stamp, the worst case
 * the settings allow is roughly 135 KB of JSON, which needs seventeen 8 KB
 * values. Twenty leaves headroom for the key-name overhead and one more
 * per-stroke channel after that. Derive the numbers from the constants rather
 * than trusting this paragraph: the measurement is printed by the "body paint
 * range" test in portalsProtocol.test.ts, which fails if the ceiling outgrows
 * the range.
 *
 * The relay allows 64 keys per session; this whole protocol uses forty.
 */
export const PAINT_STATE_KEYS = [
  "paint",
  "paint1",
  "paint2",
  "paint3",
  "paint4",
  "paint5",
  "paint6",
  "paint7",
  "paint8",
  "paint9",
  "paint10",
  "paint11",
  "paint12",
  "paint13",
  "paint14",
  "paint15",
  "paint16",
  "paint17",
  "paint18",
  "paint19",
] as const;

/**
 * Largest chunk count any one key range may use. Derived from the ranges rather
 * than written down, so widening one cannot leave the chunk header's own bounds
 * rejecting the chunks it is about to produce.
 */
export const MAX_SNAPSHOT_CHUNKS = Math.max(
  SNAPSHOT_STATE_KEYS.length,
  SIM_STATE_KEYS.length,
  POSE_STATE_KEYS.length,
  PAINT_STATE_KEYS.length,
);

export const MAX_EVENTS_PER_MESSAGE = 64;
/** Refusals carried in one per-recipient message before the rest are dropped. */
export const MAX_REJECTIONS_PER_MESSAGE = 8;
const connectionId = z.string().min(1).max(LIMITS.idLength);
const version = z.literal(PORTALS_PROTOCOL_VERSION);

/**
 * Every `to` in this protocol is a SEAT id (the identity the simulation knows a
 * player by, stable across a reconnection), with the single documented
 * exception of `refused`. Relay connection ids appear only as the `fromId` the
 * SDK reports, which the adapter maps to a seat before acting on anything.
 */
export const NetEnvelopeSchema = z.discriminatedUnion("t", [
  /** Command from a non-authoritative client, addressed to the current host. */
  z.strictObject({ v: version, t: z.literal("cmd"), to: connectionId, cmd: MatchCommandSchema }),
  /** Public event batch from the host. */
  z.strictObject({
    v: version,
    t: z.literal("ev"),
    events: z.array(SimEventSchema).max(MAX_EVENTS_PER_MESSAGE),
  }),
  /**
   * Everything addressed to one recipient: the private events the simulation
   * queued for them and their private view of the match. Both travel together
   * so a role reveal costs one message per player rather than two, which keeps
   * the burst inside the ~20 sends/s allowance for a full room.
   *
   * The Portals relay has no private channels, so this reaches every client and
   * only the addressee applies it. A modified client can read another player's
   * role; bible §43.8 accepts that for party stakes and mitigates by never
   * sending more than the recipient needs. Do not put anything of higher value
   * here.
   *
   * Public state never rides along: it travels as the chunked state snapshot,
   * which is the only path that can exceed one 8 KB message.
   */
  z.strictObject({
    v: version,
    t: z.literal("pev"),
    to: connectionId,
    events: z.array(PrivateSimEventSchema).max(MAX_EVENTS_PER_MESSAGE),
    privateState: PrivateMatchStateSchema.nullable(),
    /**
     * Refusals of this recipient's own commands. They ride along rather than
     * getting their own message so a client cannot spend the host's whole send
     * budget just by issuing illegal commands as fast as its rate limit allows.
     */
    rejections: z.array(CommandRejectionSchema).max(MAX_REJECTIONS_PER_MESSAGE),
  }),
  /**
   * A Mimic's latest legal pose, coalesced by the sender rather than streamed
   * per drag (§27.2). The host keeps it so a Mimic who never sends a lock still
   * locks into their most recent valid pose at the Forge deadline (§5.8).
   */
  z.strictObject({
    v: version,
    t: z.literal("snap"),
    to: connectionId,
    snapshot: ForgeSnapshotSchema,
  }),
  /**
   * A Mimic's latest body-paint layer, coalesced by the sender exactly as the
   * pose above is. It travels apart from the pose because the two are authored
   * independently and change at different rates, so sending either one would
   * otherwise have to carry the other unchanged.
   */
  z.strictObject({
    v: version,
    t: z.literal("paint"),
    to: connectionId,
    paint: PaintUpdateSchema,
  }),
  /** A client asking the host for a fresh sync after a join or a reconnect. */
  z.strictObject({ v: version, t: z.literal("resync") }),
  /**
   * A new host asking every Mimic to re-send its working Forge pose.
   *
   * A pose that was never locked exists only on the host that recorded it, so a
   * pose-omitted snapshot cannot carry it and a migration mid-Forge would lose
   * it. Rather than publish the poses in secret state, the new host asks for
   * them again: each client re-sends what it last gave the transport, so no
   * player's work is lost and nothing extra is written to room state.
   */
  z.strictObject({ v: version, t: z.literal("reforge") }),
  /**
   * The host refusing one client a seat.
   *
   * This is the one envelope addressed by CONNECTION id rather than seat id.
   * A second tab of an already-seated player shares that player's seat, so
   * addressing by seat would tell both tabs they had been refused; only the
   * connection that arrived second may be turned away.
   */
  z.strictObject({
    v: version,
    t: z.literal("refused"),
    to: connectionId,
    reason: z.string().min(1).max(LIMITS.idLength),
  }),
]);

export type NetEnvelope = z.infer<typeof NetEnvelopeSchema>;

/**
 * What the host publishes about the room for everyone to read. Named apart from
 * the simulation's own MatchSnapshot in @foldseek/shared, which is a different
 * thing entirely: this one is public by design, that one is secret.
 */
/** Locked poses as published: object id to encoded pose. */
export const PoseBookSchema = z.record(
  z.string().min(1).max(LIMITS.idLength),
  z.string().max(LIMITS.encodedPoseLength),
);

export type PoseBook = z.infer<typeof PoseBookSchema>;

/** Body-paint layers as published: object id to encoded layer. */
export const PaintBookSchema = z.record(
  z.string().min(1).max(LIMITS.idLength),
  z.string().max(LIMITS.encodedPaintLength),
);

export type PaintBook = z.infer<typeof PaintBookSchema>;

export const HostPublicationSchema = z.strictObject({
  v: version,
  /** Monotonic publish counter, used to reassemble a consistent chunk set. */
  seq: z.number().int().min(0),
  /** Seat id of the publishing host, so a late joiner knows who is authoritative. */
  authorityId: connectionId,
  publicState: PublicMatchStateSchema,
});

/**
 * The parsed shape, with the state view restored to its game-sim type. Zod
 * infers mutable arrays; the simulation hands out readonly ones, and both must
 * be able to produce a publication.
 */
export type HostPublication = Omit<z.infer<typeof HostPublicationSchema>, "publicState"> & {
  readonly publicState: PublicMatchState;
};

export const SnapshotChunkSchema = z.strictObject({
  v: version,
  seq: z.number().int().min(0),
  i: z.number().int().min(0).max(MAX_SNAPSHOT_CHUNKS - 1),
  n: z.number().int().min(1).max(MAX_SNAPSHOT_CHUNKS),
  data: z.string(),
});

export type SnapshotChunk = z.infer<typeof SnapshotChunkSchema>;

const encoder = new TextEncoder();

export function jsonByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

export function parseEnvelope(value: unknown): NetEnvelope | null {
  const result = NetEnvelopeSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Splits a value across as few state keys as fit the 8 KB per-value limit.
 * Returns null when the whole key range cannot hold it, rather than have the
 * relay reject the write. A caller that gets null must report it: a range that
 * never publishes still looks correct on the client that produced it, so
 * skipping quietly is how a player's work disappears without anyone noticing.
 */
export function encodeChunks(
  value: unknown,
  seq: number,
  maxChunks = MAX_SNAPSHOT_CHUNKS,
): SnapshotChunk[] | null {
  const serialized = JSON.stringify(value);
  for (let parts = 1; parts <= maxChunks; parts += 1) {
    const sliceLength = Math.ceil(serialized.length / parts);
    const chunks: SnapshotChunk[] = [];
    for (let index = 0; index < parts; index += 1) {
      chunks.push({
        v: PORTALS_PROTOCOL_VERSION,
        seq,
        i: index,
        n: parts,
        data: serialized.slice(index * sliceLength, (index + 1) * sliceLength),
      });
    }
    if (chunks.every((chunk) => jsonByteLength(chunk) <= MAX_PAYLOAD_BYTES)) return chunks;
  }
  return null;
}

/**
 * Reassembles the newest complete value from one key range of the shared state
 * map. Chunks left behind by an older, longer write carry a stale seq and are
 * ignored. The result is raw JSON: every caller validates it against its own
 * schema, because all of it arrived from a peer.
 */
export function decodeChunks(
  state: Record<string, unknown>,
  keys: readonly string[],
): { seq: number; value: unknown } | null {
  const bySeq = new Map<number, Map<number, SnapshotChunk>>();
  for (const key of keys) {
    const parsed = SnapshotChunkSchema.safeParse(state[key]);
    if (!parsed.success) continue;
    const chunk = parsed.data;
    const group = bySeq.get(chunk.seq) ?? new Map<number, SnapshotChunk>();
    group.set(chunk.i, chunk);
    bySeq.set(chunk.seq, group);
  }

  const ordered = [...bySeq.entries()].sort(([left], [right]) => right - left);
  for (const [, group] of ordered) {
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
      return { seq: first.seq, value: JSON.parse(serialized) };
    } catch {
      // A torn or truncated set is indistinguishable from a corrupt one here;
      // either way there is nothing to read, so fall through to older sets.
      continue;
    }
  }
  return null;
}

/** The locked poses, validated. */
export function decodePoseBook(state: Record<string, unknown>): PoseBook | null {
  const chunked = decodeChunks(state, POSE_STATE_KEYS);
  if (!chunked) return null;
  const result = PoseBookSchema.safeParse(chunked.value);
  return result.success ? result.data : null;
}

/** The published paint layers, validated. */
export function decodePaintBook(state: Record<string, unknown>): PaintBook | null {
  const chunked = decodeChunks(state, PAINT_STATE_KEYS);
  if (!chunked) return null;
  const result = PaintBookSchema.safeParse(chunked.value);
  return result.success ? result.data : null;
}

/** The public publication, validated. */
export function decodeHostPublication(state: Record<string, unknown>): HostPublication | null {
  const chunked = decodeChunks(state, SNAPSHOT_STATE_KEYS);
  if (!chunked) return null;
  const result = HostPublicationSchema.safeParse(chunked.value);
  return result.success ? result.data : null;
}

/**
 * Inbound command allowance per sender (§36.5). Well above what a player can
 * produce by hand, and low enough that one client cannot flood the host.
 */
export const MAX_COMMANDS_PER_SECOND = 20;

/**
 * Inbound Forge snapshots allowed per sender per second, matching the authoring
 * cadence the match settings budget for (§27.2).
 */
export const MAX_FORGE_SNAPSHOTS_PER_SECOND = DEFAULT_MATCH_SETTINGS.maxForgeCommandHz;

/** Sliding-window counter for the relay's per-second send allowance. */
export class RateWindow {
  private readonly stamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  tryConsume(nowMs: number): boolean {
    while (this.stamps.length > 0 && nowMs - (this.stamps[0] as number) >= this.windowMs) {
      this.stamps.shift();
    }
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(nowMs);
    return true;
  }
}

/**
 * One sliding window per sender, so a client that floods the host spends only
 * its own allowance and cannot starve the rest of the room.
 */
export class KeyedRateWindow {
  private readonly windows = new Map<string, RateWindow>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  tryConsume(key: string, nowMs: number): boolean {
    let window = this.windows.get(key);
    if (!window) {
      window = new RateWindow(this.limit, this.windowMs);
      this.windows.set(key, window);
    }
    return window.tryConsume(nowMs);
  }

  /** Releases a sender's window when they leave, so the map cannot grow forever. */
  forget(key: string): void {
    this.windows.delete(key);
  }

  clear(): void {
    this.windows.clear();
  }
}

/**
 * Packs events into the fewest 8 KB batches. An event that cannot fit alone is
 * returned as `oversized` instead of throwing inside a network callback, and
 * the caller is required to report it rather than drop it quietly.
 */
export function batchEvents<E extends SimEvent | PrivateSimEvent>(
  events: readonly E[],
  build: (batch: E[]) => unknown,
): { batches: E[][]; oversized: E[] } {
  const batches: E[][] = [];
  const oversized: E[] = [];
  let current: E[] = [];

  for (const event of events) {
    if (jsonByteLength(build([event])) > MAX_PAYLOAD_BYTES) {
      oversized.push(event);
      continue;
    }
    const candidate = [...current, event];
    if (candidate.length > MAX_EVENTS_PER_MESSAGE || jsonByteLength(build(candidate)) > MAX_PAYLOAD_BYTES) {
      if (current.length > 0) batches.push(current);
      current = [event];
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) batches.push(current);
  return { batches, oversized };
}
