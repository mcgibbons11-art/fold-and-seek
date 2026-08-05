import { LIMITS, MatchPhase } from "@foldseek/shared";
import { z } from "zod";

import {
  MAX_PAYLOAD_BYTES,
  PAINT_STATE_KEYS,
  POSE_STATE_KEYS,
  PORTALS_PROTOCOL_VERSION,
  SIM_STATE_KEYS,
  SNAPSHOT_STATE_KEYS,
} from "./portalsProtocol";

/**
 * Concurrent rooms inside one Portals session.
 *
 * WHY THIS IS NOT A CHANNEL PER ROOM. The injected SDK holds exactly one net
 * session at a time: `join()` while joined is refused by the host, and the local
 * mirror is a single slot. A client sitting in a room's own channel therefore
 * cannot also write into a directory channel, so the obvious design — one
 * channel per room plus a lobby channel listing them — cannot be built at all.
 * Rooms here are instead LOGICAL partitions of the one shared channel everybody
 * joins: every message carries the room it belongs to and clients drop the rest,
 * and each room owns a disjoint range of shared-state keys.
 *
 * WHY THE ROOM COUNT IS SMALL AND FIXED. The relay allows 64 state keys per
 * session, and a room's own publishing is what spends them. The dominant cost is
 * body paint: one layer at the wire ceiling is PAINT_WIRE_MAX_BASE64_LENGTH
 * characters, about 12.3 KB, which is more than a single 8 KB relay value holds,
 * so every hider costs roughly one and a half keys of paint and another
 * three-quarters of a key of pose. A full twelve-player room (ten hiders, since
 * a roster that size fields a second Inspector) needs the forty keys the
 * existing ranges already reserve. That leaves twenty-four, which funds exactly
 * one more room and its advertisement.
 *
 * So the session holds TWO rooms, not an unbounded directory, and the second is
 * smaller than the first. The alternative — uniform rooms — would mean shrinking
 * the flagship twelve-player room to ten (two rooms) or six (three), and the
 * twelve-player room is the game the bible describes. `roomKeyBudget` below
 * derives the whole allocation from the wire constants and the accompanying test
 * fails if a format change outgrows it, so this stays a measurement rather than
 * a paragraph that rots.
 *
 * When both slots are taken, creating a room is refused with a reason the player
 * can read. A silently overloaded key range publishes nothing at all for the
 * whole room while every client that produced part of it goes on rendering its
 * own copy correctly, which is the worst failure this transport has.
 */

/** Rooms one Portals session can hold at once, derived from the slot table. */
export const MAX_CONCURRENT_ROOMS = 2;

/**
 * How often a room's host rewrites its advertisement. Four missed beats retire
 * the room, which is long enough that a host mid-`enterRoundMode` is not
 * mistaken for a dead one and short enough that a browser does not show a room
 * nobody is in for most of a minute.
 */
export const ROOM_HEARTBEAT_MS = 3_000;
export const ROOM_AD_STALE_MS = ROOM_HEARTBEAT_MS * 4;

/**
 * Room codes are typed by people reading them off someone else's screen, so the
 * alphabet leaves out the pairs that get misread: O and 0, I and 1, S and 5.
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";
export const ROOM_CODE_LENGTH = 4;
export const ROOM_NAME_MAX_LENGTH = 24;

/** The shared-state keys one room publishes on. Disjoint between slots. */
export interface RoomKeySet {
  readonly snapshot: readonly string[];
  readonly sim: readonly string[];
  readonly pose: readonly string[];
  readonly paint: readonly string[];
}

export interface RoomSlot {
  readonly index: number;
  /** The one key this slot's host advertises on, and nobody else writes. */
  readonly adKey: string;
  /**
   * Seats this slot's key ranges can carry at the wire's worst case. It is a
   * property of the key allocation, not a play-balance choice: a room seated
   * past it would publish nothing rather than publish late.
   */
  readonly maxPlayers: number;
  readonly keys: RoomKeySet;
}

function numberedKeys(prefix: string, count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => (index === 0 ? prefix : `${prefix}${index}`));
}

/**
 * The two slots.
 *
 * Slot 0 keeps the original key names and ranges exactly, so a session with one
 * room publishes byte for byte what it published before rooms existed, and the
 * twelve-player room is untouched.
 *
 * Slot 1's ranges are sized from the same worst case for seven seats, and the
 * numbers below are measured by the budget test rather than reasoned about: six
 * hiders (a room that size fields one Inspector) each holding a full stroke log
 * fill ten paint keys exactly and five pose keys exactly, so the range carries
 * one more of each. A tenth spare is the margin, on a worst case that already
 * assumes every hider painted to the ceiling. Two keys of public state and two
 * of simulation snapshot are several times what a room that size measures at,
 * since both are published with the pose and paint bodies stripped out.
 *
 * The whole protocol then uses 63 of the relay's 64 keys. Anything that wants a
 * key range of its own has to take seats out of this slot to pay for it, which
 * is the trade the budget test makes visible.
 */
export const ROOM_SLOTS: readonly RoomSlot[] = [
  {
    index: 0,
    adKey: "room0",
    maxPlayers: 12,
    keys: {
      snapshot: SNAPSHOT_STATE_KEYS,
      sim: SIM_STATE_KEYS,
      pose: POSE_STATE_KEYS,
      paint: PAINT_STATE_KEYS,
    },
  },
  {
    index: 1,
    adKey: "room1",
    maxPlayers: 7,
    keys: {
      snapshot: numberedKeys("bmatch", 2),
      sim: numberedKeys("bsim", 2),
      pose: numberedKeys("bpose", 6),
      paint: numberedKeys("bpaint", 11),
    },
  },
];

export const DEFAULT_ROOM_SLOT = ROOM_SLOTS[0] as RoomSlot;

/** Every state key this protocol can ever write, for the budget test. */
export function allRoomStateKeys(): string[] {
  return ROOM_SLOTS.flatMap((slot) => [
    slot.adKey,
    ...slot.keys.snapshot,
    ...slot.keys.sim,
    ...slot.keys.pose,
    ...slot.keys.paint,
  ]);
}

/**
 * What one slot's ranges can carry, in the units the ceiling is written in.
 *
 * Chunk overhead is charged per key because every chunk carries the protocol
 * version, the publish counter, its index and its count alongside the payload;
 * `encodeChunks` measures the real thing, and this is the conservative estimate
 * the slot table was sized against.
 */
const CHUNK_OVERHEAD_BYTES = 96;

export function roomKeyBudget(slot: RoomSlot): {
  readonly paintBytes: number;
  readonly poseBytes: number;
  readonly stateBytes: number;
  readonly keys: number;
} {
  const usable = (count: number): number => count * (MAX_PAYLOAD_BYTES - CHUNK_OVERHEAD_BYTES);
  return {
    paintBytes: usable(slot.keys.paint.length),
    poseBytes: usable(slot.keys.pose.length),
    stateBytes: usable(slot.keys.snapshot.length),
    keys:
      1 +
      slot.keys.snapshot.length +
      slot.keys.sim.length +
      slot.keys.pose.length +
      slot.keys.paint.length,
  };
}

/* ------------------------------------------------------------ the advertisement */

/**
 * What a room's host publishes about it, and the only thing a client browsing
 * the session reads. It is written by one client and read by every other, so it
 * is validated on the way in like any other peer-supplied value.
 *
 * `beat` is a counter rather than a timestamp on purpose. Portals gives the
 * session no shared clock, so a reader cannot compare a host's `Date.now()` with
 * its own; what it can do is notice that a counter it has been watching stopped
 * moving. Liveness is therefore measured entirely on the reader's own clock.
 */
export const RoomAdSchema = z.strictObject({
  v: z.literal(PORTALS_PROTOCOL_VERSION),
  code: z.string().length(ROOM_CODE_LENGTH),
  name: z.string().min(1).max(ROOM_NAME_MAX_LENGTH),
  /** Seat id of the client holding this room's simulation. */
  host: z.string().min(1).max(LIMITS.idLength),
  slot: z.number().int().min(0).max(ROOM_SLOTS.length - 1),
  players: z.number().int().min(0).max(LIMITS.maxPlayersPerMatch),
  /**
   * How many of those players are bots. A room the host filled out with them is
   * not full to a person — the host gives a bot's seat up rather than turning
   * somebody away — so a browser that counted only heads would hide the one
   * room in the session that would have taken the player.
   */
  bots: z.number().int().min(0).max(LIMITS.maxPlayersPerMatch),
  maxPlayers: z.number().int().min(2).max(LIMITS.maxPlayersPerMatch),
  seekers: z.number().int().min(1).max(LIMITS.maxPlayersPerMatch),
  phase: z.nativeEnum(MatchPhase),
  beat: z.number().int().min(0),
  /**
   * True when the host admits session joiners without the approval step
   * (approved 2026-08-05): the browser shows JOIN instead of REQUEST TO
   * JOIN, and the host's adapter answers requests itself. Optional so the
   * adverts of builds that predate the flag still parse.
   */
  open: z.boolean().optional(),
});

export type RoomAd = z.infer<typeof RoomAdSchema>;

/**
 * A slot whose room has ended. The relay has no delete, so a vacancy has to be
 * written over the advertisement that was there; a reader that only ignored
 * unparseable values would go on showing the dead room until it timed out.
 */
export const RoomVacancySchema = z.strictObject({
  v: z.literal(PORTALS_PROTOCOL_VERSION),
  vacant: z.literal(true),
});

export const VACANT_SLOT: z.infer<typeof RoomVacancySchema> = {
  v: PORTALS_PROTOCOL_VERSION,
  vacant: true,
};

export interface RoomListing extends RoomAd {
  /** True while the room still has a seat and has not started its reveal. */
  readonly joinable: boolean;
}

/**
 * A room stops taking arrivals once the round is effectively over, because a
 * player seated during the reveal watches other people's scores and never plays.
 * Everything earlier accepts late joiners: the simulation seats them and the
 * phase machine gives them whatever is left of the round.
 */
const CLOSED_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.Reveal,
  MatchPhase.Results,
  MatchPhase.RematchVote,
  MatchPhase.Disposed,
]);

export function isJoinable(ad: RoomAd): boolean {
  if (CLOSED_PHASES.has(ad.phase)) return false;
  return ad.players < ad.maxPlayers || ad.bots > 0;
}

/** Seats held by people, which is what a browser counts out loud. */
export function humanPlayers(ad: RoomAd): number {
  return Math.max(0, ad.players - ad.bots);
}

/**
 * Every room the session is advertising, kept current from the state events the
 * relay delivers.
 *
 * Liveness is per reader: an advertisement counts as live while its `beat` is
 * still moving, measured against the clock of whoever is reading. A room whose
 * host lost its connection without writing a vacancy therefore disappears from
 * every browser within ROOM_AD_STALE_MS of its last beat, and its slot becomes
 * available to the next player who creates one.
 */
export class RoomDirectory {
  private readonly ads = new Map<number, { ad: RoomAd; changedAtMs: number }>();

  /** Reads every advertisement out of a full state map, as join() hands it over. */
  observeState(state: Record<string, unknown>, nowMs: number): void {
    for (const slot of ROOM_SLOTS) this.observe(slot.adKey, state[slot.adKey], nowMs);
  }

  /**
   * Applies one state write. Returns true when the value belonged to this
   * registry, so the adapter's state handler can stop looking at it.
   */
  observe(key: string, value: unknown, nowMs: number): boolean {
    const slot = ROOM_SLOTS.find((candidate) => candidate.adKey === key);
    if (slot === undefined) return false;

    if (RoomVacancySchema.safeParse(value).success) {
      this.ads.delete(slot.index);
      return true;
    }

    const parsed = RoomAdSchema.safeParse(value);
    if (!parsed.success) {
      // Either nothing has been written here yet or a peer wrote something this
      // version does not understand. Both mean the same thing to a browser.
      this.ads.delete(slot.index);
      return true;
    }

    const ad = parsed.data;
    if (ad.slot !== slot.index) {
      // An advertisement claiming a slot it is not written on cannot be acted
      // on: the reader would look for the room's state on the wrong keys.
      this.ads.delete(slot.index);
      return true;
    }

    const held = this.ads.get(slot.index);
    const moved = held === undefined || held.ad.beat !== ad.beat;
    this.ads.set(slot.index, { ad, changedAtMs: moved ? nowMs : held.changedAtMs });
    return true;
  }

  /** Drops this client's own memory of a slot, after it writes a vacancy there. */
  forget(slotIndex: number): void {
    this.ads.delete(slotIndex);
  }

  clear(): void {
    this.ads.clear();
  }

  /** Live rooms, in slot order so the browser does not reshuffle under a click. */
  list(nowMs: number): RoomListing[] {
    const listings: RoomListing[] = [];
    for (const slot of ROOM_SLOTS) {
      const held = this.ads.get(slot.index);
      if (held === undefined) continue;
      if (nowMs - held.changedAtMs >= ROOM_AD_STALE_MS) continue;
      listings.push({ ...held.ad, joinable: isJoinable(held.ad) });
    }
    return listings;
  }

  find(code: string, nowMs: number): RoomListing | null {
    const wanted = code.trim().toUpperCase();
    return this.list(nowMs).find((room) => room.code === wanted) ?? null;
  }

  /** The slot a new room may take, or null when the session is full. */
  freeSlot(nowMs: number): RoomSlot | null {
    const taken = new Set(this.list(nowMs).map((room) => room.slot));
    return ROOM_SLOTS.find((slot) => !taken.has(slot.index)) ?? null;
  }

  /**
   * Where quick join sends a player: the fullest room that still has a seat,
   * preferring one that has not started, so a party gathers into one round
   * rather than spreading itself thin across two half-empty ones.
   */
  quickJoinTarget(nowMs: number): RoomListing | null {
    const open = this.list(nowMs).filter((room) => room.joinable);
    if (open.length === 0) return null;
    return open.sort((left, right) => {
      const leftWaiting = left.phase === MatchPhase.Lobby ? 0 : 1;
      const rightWaiting = right.phase === MatchPhase.Lobby ? 0 : 1;
      if (leftWaiting !== rightWaiting) return leftWaiting - rightWaiting;
      // Fullest by people: a room of bots is emptier than it looks, and quick
      // join is meant to gather a party rather than to fill a table.
      const leftHeads = humanPlayers(left);
      const rightHeads = humanPlayers(right);
      if (leftHeads !== rightHeads) return rightHeads - leftHeads;
      return left.slot - right.slot;
    })[0] as RoomListing;
  }
}

/* -------------------------------------------------------------------- codes */

/**
 * A room code, drawn from whatever randomness the caller has. It is a label a
 * player reads aloud, not a secret: the session is already a closed group, and
 * the registry refuses a code that collides with a live room.
 */
export function makeRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    const pick = Math.floor(random() * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET.charAt(Math.min(pick, ROOM_CODE_ALPHABET.length - 1));
  }
  return code;
}

/**
 * A code nobody in the session is using. Codes are four characters from a
 * thirty-letter alphabet, so a collision across two live rooms is rare enough
 * that a handful of attempts always settles it; the fallback walks the alphabet
 * rather than looping forever.
 */
export function freeRoomCode(directory: RoomDirectory, nowMs: number, random?: () => number): string {
  const taken = new Set(directory.list(nowMs).map((room) => room.code));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = makeRoomCode(random);
    if (!taken.has(code)) return code;
  }
  for (const letter of ROOM_CODE_ALPHABET) {
    const code = `${letter}${makeRoomCode(random).slice(1)}`;
    if (!taken.has(code)) return code;
  }
  return makeRoomCode(random);
}

/**
 * A room name fit to publish: trimmed to the advertisement's length, and never
 * empty, because a browser row with no label is a room nobody will pick.
 */
export function sanitizeRoomName(name: string, fallback: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ").slice(0, ROOM_NAME_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed : fallback.slice(0, ROOM_NAME_MAX_LENGTH);
}
