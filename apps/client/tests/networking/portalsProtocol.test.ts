import { MatchSimulation, type PublicMatchState } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import {
  createReferenceDisguiseWire,
  encodeDisguiseWire,
  encodePaintLayer,
  MAX_PAINT_STROKES,
  PAINT_WIRE_MAX_BASE64_LENGTH,
} from "@foldseek/shared";
import {
  decodePaintBook,
  decodePoseBook,
  encodeChunks,
  jsonByteLength,
  parseEnvelope,
  MAX_PAYLOAD_BYTES,
  MAX_SNAPSHOT_CHUNKS,
  PAINT_STATE_KEYS,
  PORTALS_PROTOCOL_VERSION,
  POSE_STATE_KEYS,
  RateWindow,
  SNAPSHOT_STATE_KEYS,
  type HostPublication,
} from "../../src/networking/portalsProtocol";

/**
 * The snapshot codec is the only path that can outgrow a single 8 KB relay
 * value, so it is exercised here at sizes a real match will not reach in the
 * loopback tests: a full room of long encoded poses.
 */

const FAST_SETTINGS = {
  mapIntroMs: 100,
  roleRevealMs: 100,
  baselineScanMs: 100,
  forgeMs: 100,
  lockGraceMs: 100,
  inspectionIntroMs: 100,
  inspectionMs: 20_000,
  revealMs: 100,
  resultsMs: 100,
  rematchVoteMs: 100,
};

/** Drives a real simulation to the inspection, where every disguise is public. */
function inspectionState(players: number): PublicMatchState {
  const sim = new MatchSimulation(FAST_SETTINGS, 17);
  const ids = Array.from({ length: players }, (_, index) => `player-${index}`);
  for (const [index, id] of ids.entries()) {
    sim.addPlayer(id, { displayName: `Visitor ${index}`, isHost: index === 0 });
  }

  let now = 0;
  const ready = (): void => {
    for (const id of ids) sim.handleCommand(id, { type: "player_ready", ready: true });
  };
  ready();
  sim.handleCommand(ids[0] as string, { type: "start_match" });
  for (let step = 0; step < 200; step += 1) {
    if (sim.getPhase() === MatchPhase.Inspection) break;
    if (sim.getPhase() === MatchPhase.Loading) ready();
    now += 50;
    sim.tick(now);
  }
  if (sim.getPhase() !== MatchPhase.Inspection) {
    throw new Error(`simulation stuck in ${sim.getPhase()}`);
  }
  return sim.getPublicState();
}

function snapshotWithPoses(state: PublicMatchState, poseChars: number): HostPublication {
  return {
    v: PORTALS_PROTOCOL_VERSION,
    seq: 3,
    authorityId: "player-0",
    publicState: {
      ...state,
      disguises: state.disguises.map((disguise) => ({
        ...disguise,
        encodedPose: "z".repeat(poseChars),
      })),
    },
  };
}

/** Writes chunks into the shape net.getState() returns, for one key range. */
function asState(
  chunks: ReturnType<typeof encodeChunks>,
  keys: readonly string[],
): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  (chunks ?? []).forEach((chunk, index) => {
    const key = keys[index];
    if (key !== undefined) state[key] = chunk;
  });
  return state;
}

describe("snapshot chunking", () => {
  it("round trips a value that needs several keys", () => {
    // Publications no longer carry pose bodies, so the multi-chunk path is
    // exercised by the range that does: a book of canonical poses.
    const pose = encodeDisguiseWire(createReferenceDisguiseWire(1));
    const book: Record<string, string> = {};
    for (let index = 0; index < 6; index += 1) book[`obj_${index}`] = pose;

    const chunks = encodeChunks(book, 3, POSE_STATE_KEYS.length);
    expect(chunks).not.toBeNull();
    expect((chunks ?? []).length).toBeGreaterThan(1);
    for (const chunk of chunks ?? []) {
      expect(jsonByteLength(chunk)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      expect(chunk.n).toBe((chunks ?? []).length);
    }

    expect(decodePoseBook(asState(chunks, POSE_STATE_KEYS))).toEqual(book);
  });

  it("ignores chunks left behind by an older, longer write", () => {
    const pose = encodeDisguiseWire(createReferenceDisguiseWire(1));
    const large: Record<string, string> = {};
    for (let index = 0; index < 6; index += 1) large[`obj_${index}`] = pose;
    const small: Record<string, string> = { obj_0: pose };

    const state = asState(encodeChunks(large, 7, POSE_STATE_KEYS.length), POSE_STATE_KEYS);
    const fresh = encodeChunks(small, 8, POSE_STATE_KEYS.length) ?? [];
    expect(fresh.length).toBe(1);
    // The newer write only touches the first key, leaving the older tail behind.
    state[POSE_STATE_KEYS[0] as string] = fresh[0];

    expect(decodePoseBook(state)).toEqual(small);
  });

  it("refuses a publication that its own key range cannot hold", () => {
    // Eleven Mimics at the 6 KB pose ceiling is about 68 KB, far past the four
    // keys the publication range owns.
    const snapshot = snapshotWithPoses(inspectionState(12), 6_144);
    expect(encodeChunks(snapshot, snapshot.seq, SNAPSHOT_STATE_KEYS.length)).toBeNull();
  });

  it("returns nothing when a chunk of the newest set is missing", () => {
    const pose = encodeDisguiseWire(createReferenceDisguiseWire(1));
    const book: Record<string, string> = {};
    for (let index = 0; index < 6; index += 1) book[`obj_${index}`] = pose;

    const chunks = encodeChunks(book, 9, POSE_STATE_KEYS.length) ?? [];
    expect(chunks.length).toBeGreaterThan(1);
    const state = asState(chunks, POSE_STATE_KEYS);
    delete state[POSE_STATE_KEYS[1] as string];

    expect(decodePoseBook(state)).toBeNull();
  });

  it("reports the measured size of a realistic eight player match", () => {
    const snapshot = snapshotWithPoses(inspectionState(8), 352);
    const chunks = encodeChunks(snapshot, snapshot.seq, SNAPSHOT_STATE_KEYS.length) ?? [];
    const largest = Math.max(...chunks.map((chunk) => jsonByteLength(chunk)));

    expect(chunks.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHUNKS);
    expect(largest).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    console.log(
      `8 players at 352-char poses: ${jsonByteLength(snapshot)} bytes in ${chunks.length} key(s), largest ${largest} bytes`,
    );
  });
});

describe("locked pose range", () => {
  it("holds a full room of canonical poses inside its key budget", () => {
    // The largest room the settings allow is twelve players, which fields ten
    // Mimics once the roster is big enough for a second Inspector.
    const pose = encodeDisguiseWire(createReferenceDisguiseWire(1));
    const book: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) book[`obj_${index}`] = pose;

    const chunks = encodeChunks(book, 1, POSE_STATE_KEYS.length);
    expect(chunks).not.toBeNull();
    for (const chunk of chunks ?? []) {
      expect(jsonByteLength(chunk)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    }

    expect(decodePoseBook(asState(chunks, POSE_STATE_KEYS))).toEqual(book);

    console.log(
      `12-player room: ${jsonByteLength(book)} bytes of poses in ${(chunks ?? []).length} of ${POSE_STATE_KEYS.length} key(s), one pose is ${pose.length} chars`,
    );
  });
});

describe("body paint range", () => {
  it("holds a full room of maximum paint layers inside its key budget", () => {
    // The worst case the wire permits: every Mimic in the largest room has
    // filled its stroke log to the ceiling. Ten Mimics, because a roster that
    // big fields a second Inspector.
    const layer = encodePaintLayer(
      Array.from({ length: MAX_PAINT_STROKES }, (_, index) => ({
        target: index % 19,
        u: (index % 64) / 64,
        v: (index % 32) / 32,
        radius: 0.25,
        color: [0.8, 0.2, 0.4] as const,
        opacity: 1,
        erase: false,
        continued: index % 4 !== 0,
      })),
    );
    expect(layer.length).toBe(PAINT_WIRE_MAX_BASE64_LENGTH);

    const book: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) book[`obj_${index}`] = layer;

    const chunks = encodeChunks(book, 1, PAINT_STATE_KEYS.length);
    expect(chunks).not.toBeNull();
    for (const chunk of chunks ?? []) {
      expect(jsonByteLength(chunk)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    }
    expect(decodePaintBook(asState(chunks, PAINT_STATE_KEYS))).toEqual(book);

    console.log(
      `12-player room: ${jsonByteLength(book)} bytes of paint in ${(chunks ?? []).length} of ${PAINT_STATE_KEYS.length} key(s), one layer is ${layer.length} chars`,
    );
  });

  it("refuses a book of layers its own key range cannot hold", () => {
    // Sized from the range rather than written down, so this stays a genuine
    // over-capacity case when the stroke format grows and each layer with it.
    // The caller has to report this, never skip it.
    const layer = "p".repeat(PAINT_WIRE_MAX_BASE64_LENGTH);
    const capacity = PAINT_STATE_KEYS.length * MAX_PAYLOAD_BYTES;
    const tooMany = Math.ceil(capacity / PAINT_WIRE_MAX_BASE64_LENGTH) + 2;

    const book: Record<string, string> = {};
    for (let index = 0; index < tooMany; index += 1) book[`obj_${index}`] = layer;

    expect(encodeChunks(book, 1, PAINT_STATE_KEYS.length)).toBeNull();
  });
});

describe("envelope validation", () => {
  it("rejects everything that is not a well formed envelope", () => {
    const rejected: unknown[] = [
      undefined,
      null,
      42,
      "cmd",
      {},
      { v: 1 },
      { v: 2, t: "resync" },
      { v: 1, t: "unknown" },
      { v: 1, t: "cmd", to: "a" },
      { v: 1, t: "cmd", to: "a", cmd: { type: "nope" } },
      { v: 1, t: "cmd", to: "", cmd: { type: "start_match" } },
      { v: 1, t: "ev", events: [{ type: "phase_changed" }] },
      { v: 1, t: "pev", to: "a", events: [] },
      { v: 1, t: "pev", to: "a", events: [], privateState: {} },
      { v: 1, t: "resync", extra: true },
    ];
    for (const value of rejected) {
      expect(parseEnvelope(value)).toBeNull();
    }
  });

  it("accepts a command envelope and a resync", () => {
    expect(
      parseEnvelope({
        v: PORTALS_PROTOCOL_VERSION,
        t: "cmd",
        r: "ABCD",
        to: "host-1",
        cmd: { type: "start_match" },
      }),
    ).not.toBeNull();
    expect(
      parseEnvelope({ v: PORTALS_PROTOCOL_VERSION, t: "resync", r: "ABCD" }),
    ).not.toBeNull();
    // The room is what separates one match from another on a channel they
    // share, so an envelope without one addresses nobody and is refused.
    expect(parseEnvelope({ v: PORTALS_PROTOCOL_VERSION, t: "resync" })).toBeNull();
  });
});

describe("send rate window", () => {
  it("allows the limit inside one window and refuses the next", () => {
    const window = new RateWindow(3, 1_000);
    expect(window.tryConsume(0)).toBe(true);
    expect(window.tryConsume(10)).toBe(true);
    expect(window.tryConsume(20)).toBe(true);
    expect(window.tryConsume(30)).toBe(false);
    // The first stamp ages out exactly one window after it was taken.
    expect(window.tryConsume(1_000)).toBe(true);
  });
});
