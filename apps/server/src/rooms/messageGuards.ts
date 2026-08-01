/**
 * Wire caps for anything a client can send (§36.5). Colyseus decodes msgpack
 * before a handler runs, so the room measures and rate-limits the decoded
 * message itself. The zod schemas bound every string and number inside a
 * payload; these guards bound how large a message may be overall and how often
 * one client may send them.
 *
 * The Portals adapter enforces the same two limits with its own copy in
 * apps/client/src/networking/portalsProtocol.ts. The two cannot share a module
 * because no package sits below both apps, so a change here belongs there too.
 */

/** Largest decoded message accepted from one client, matching the Portals cap. */
export const MAX_MESSAGE_BYTES = 8_192;

/** Inbound match commands allowed per client per second. */
export const MAX_COMMANDS_PER_SECOND = 20;

export const RATE_WINDOW_MS = 1_000;

const encoder = new TextEncoder();

/**
 * Serialized size of a decoded message. Undefined and values JSON cannot
 * represent count as zero rather than throwing, because the schema rejects
 * them a moment later with a better reason.
 */
export function messageByteLength(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // A cyclic payload cannot be sized, so treat it as over the cap.
    return Number.POSITIVE_INFINITY;
  }
  return serialized === undefined ? 0 : encoder.encode(serialized).length;
}

/** Sliding-window counter over one key's recent sends. */
class RateWindow {
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
 * One sliding window per client, so a client that floods the room spends only
 * its own allowance and cannot starve the rest of the match.
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

  /** Releases a client's window on leave, so the map cannot grow forever. */
  forget(key: string): void {
    this.windows.delete(key);
  }
}
