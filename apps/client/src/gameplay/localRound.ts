import { LocalLoopbackAdapter } from "../networking/LocalLoopbackAdapter";
import { buildObjectRegistry } from "../world/maps/registry";
import { createBotDisguisePayload } from "./botDisguises";
import { RoundDirector } from "./RoundDirector";
import { RoundSpatialBridge } from "./roundSpatial";

/**
 * A round of FOLD & SEEK played entirely in this tab (§4.3 practice, and the
 * offline half of the transport story). The simulation runs in the page against
 * the real Curiosity Shop registry and the real geometry validator, so a solo
 * round exercises the same rules a hosted one does.
 *
 * The bots exist to field a round, not to play one: they ready up and lock a
 * disguise, and make no inspection decisions. Three of them puts four players
 * in the shop, which is one Inspector and three Mimics whichever way the roles
 * fall.
 */

export const LOCAL_ROUND_BOTS = 3;
export const LOCAL_ROUND_NAME = "practice";

export interface LocalRound {
  readonly adapter: LocalLoopbackAdapter;
  readonly director: RoundDirector;
  readonly spatial: RoundSpatialBridge;
  dispose(): void;
}

export interface LocalRoundOptions {
  readonly bots?: number;
  /** Fixed seed for a repeatable round. Omitted, every round deals afresh. */
  readonly seed?: number;
}

/**
 * Roles come off a seeded shuffle, so a fixed seed would hand the same player
 * the same role every single time. A practice round therefore draws its own.
 */
function dealSeed(): number {
  return (Math.random() * 0x7fffffff) >>> 0;
}

/**
 * A seed named in the page's query string, for driving a particular deal from
 * outside the game: `?seed=10` puts this client in the Inspector's chair in a
 * four-seat room. Absent or unreadable, the round deals itself as usual.
 */
export function seedFromLocation(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("seed");
  if (raw === null) return undefined;
  const seed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(seed) && seed >= 0 ? seed : undefined;
}

export function createLocalRound(options: LocalRoundOptions = {}): LocalRound {
  const spatial = new RoundSpatialBridge();
  const adapter = new LocalLoopbackAdapter({
    seed: options.seed ?? dealSeed(),
    spatial: spatial.validator,
    objectRegistry: buildObjectRegistry(),
    botPose: (index) => createBotDisguisePayload(index),
  });
  for (let index = 0; index < (options.bots ?? LOCAL_ROUND_BOTS); index += 1) {
    adapter.addBot({ autoPlay: true });
  }
  const director = new RoundDirector(adapter);

  return {
    adapter,
    director,
    spatial,
    dispose() {
      director.dispose();
      adapter.dispose();
    },
  };
}
