import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandRejection } from "../../src/networking/NetworkAdapter";
import { PortalsNetAdapter } from "../../src/networking/PortalsNetAdapter";
import { FakePortalsRelay } from "./fakePortals";

/**
 * A key range that cannot be chunked must be reported, never skipped.
 *
 * This is the transport's worst failure shape: the host goes on rendering its
 * own simulation perfectly while a range of shared state stops updating, so
 * every other client's view quietly freezes and nothing in the room says why.
 * The ranges are sized so this cannot happen at the limits the game enforces,
 * which is exactly why the reaction to it has to be tested rather than trusted:
 * the guard is unreachable through the front door, so the encoder is forced to
 * fail here and the adapter's answer is what is under test.
 */

const forced = vi.hoisted(() => ({ publications: false }));

vi.mock("../../src/networking/portalsProtocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/networking/portalsProtocol")>();
  return {
    ...actual,
    encodeChunks: (value: unknown, seq: number, maxChunks?: number) => {
      const isPublication =
        typeof value === "object" && value !== null && "authorityId" in value;
      if (forced.publications && isPublication) return null;
      return actual.encodeChunks(value, seq, maxChunks);
    },
  };
});

const CHANNEL = "fold-seek-publish-failure";

afterEach(() => {
  forced.publications = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Peer {
  readonly adapter: PortalsNetAdapter;
  readonly rejections: CommandRejection[];
}

interface Room {
  readonly host: Peer;
  readonly other: Peer;
  /**
   * Readies a player and lets the room settle. Toggling ready is the cheapest
   * way to make the lobby publish: nothing is written unless the public state
   * actually changed, so a quiet room attempts no writes to fail.
   */
  republish(times?: number): void;
  dispose(): void;
}

async function openRoom(): Promise<Room> {
  const relay = new FakePortalsRelay();
  let clock = 1_700_000_000_000;
  let ready = false;

  const seat = async (id: string, displayName: string): Promise<Peer> => {
    const adapter = new PortalsNetAdapter(relay.createPeer({ id, displayName }), {
      seed: 5,
      now: () => clock,
    });
    const rejections: CommandRejection[] = [];
    adapter.onRejection((rejection) => rejections.push(rejection));
    await adapter.connect();
    await adapter.join(CHANNEL, displayName);
    return { adapter, rejections };
  };

  const host = await seat("a", "Ada");
  const other = await seat("b", "Bex");
  const peers = [host, other];

  const advance = (steps: number): void => {
    for (let step = 0; step < steps; step += 1) {
      clock += 100;
      for (const peer of peers) peer.adapter.tick();
    }
  };
  advance(4);

  return {
    host,
    other,
    republish(times = 1) {
      for (let round = 0; round < times; round += 1) {
        ready = !ready;
        other.adapter.sendCommand({ type: "player_ready", ready });
        advance(6);
      }
    },
    dispose() {
      for (const peer of peers) peer.adapter.dispose();
    },
  };
}

describe("PortalsNetAdapter publish failures", () => {
  it("reports a public state range that cannot publish, once, to the whole room", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = await openRoom();
    const { host, other } = room;

    expect(host.adapter.isAuthority()).toBe(true);
    room.republish();
    for (const peer of [host, other]) expect(peer.rejections).toEqual([]);

    forced.publications = true;
    // Several publish attempts: the fault repeats on every one of them.
    room.republish(4);

    const expected = {
      type: "state_publish",
      reason: "range_too_large",
      detail: "public state",
    };
    // The host learns directly, since it is the client that could not publish.
    expect(host.rejections).toEqual([expected]);
    // Everyone else learns too, because the range they read is the one that
    // stopped moving, and latched so four attempts are still one report.
    expect(other.rejections).toEqual([expected]);
    expect(error).toHaveBeenCalled();

    room.dispose();
  });

  it("reports again once the range recovers and fails a second time", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const room = await openRoom();

    forced.publications = true;
    room.republish(3);
    expect(room.host.rejections).toHaveLength(1);

    // A range that starts publishing again clears the latch, so a later fault
    // is a new report rather than one swallowed by the old one.
    forced.publications = false;
    room.republish(2);
    forced.publications = true;
    room.republish(3);
    expect(room.host.rejections).toHaveLength(2);

    room.dispose();
  });
});
