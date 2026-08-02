import type { MatchSettingsPatch } from "@foldseek/game-sim";

import { LocalLoopbackAdapter } from "../networking/LocalLoopbackAdapter";
import { buildObjectRegistry } from "../world/maps/registry";
import { createBotPlay } from "./botPlay";
import { dealSeed, type GameRound } from "./round";
import { RoundDirector } from "./RoundDirector";
import { RoundSpatialBridge } from "./roundSpatial";

/**
 * A round of FOLD & SEEK played entirely in this tab (§4.3 practice, and the
 * offline half of the transport story). The simulation runs in the page against
 * the real Curiosity Shop registry and the real geometry validator, so a solo
 * round exercises the same rules a hosted one does.
 *
 * The bots play it. One dealt the Inspector's role walks the shop and spends
 * warrants; ones dealt Mimic fold into a hiding place and, if that place is out
 * in the open, cannot keep still. A solo round therefore ends with somebody
 * caught and somebody else still standing, rather than with the clock running
 * out on four identical scorelines.
 */

export const LOCAL_ROUND_BOTS = 3;
export const LOCAL_ROUND_NAME = "practice";

export interface LocalRound extends GameRound {
  readonly adapter: LocalLoopbackAdapter;
}

export interface LocalRoundOptions {
  readonly bots?: number;
  /** Fixed seed for a repeatable round. Omitted, every round deals afresh. */
  readonly seed?: number;
  /** Shortened phase durations, for driving a whole round headlessly. */
  readonly settings?: MatchSettingsPatch;
  /** Clock source. Defaults to the loopback's, which is performance.now(). */
  readonly now?: () => number;
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
  const seed = options.seed ?? dealSeed();
  const spatial = new RoundSpatialBridge();
  const adapter = new LocalLoopbackAdapter({
    seed,
    spatial: spatial.validator,
    objectRegistry: buildObjectRegistry(),
    ...createBotPlay(spatial, seed),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.now === undefined ? {} : { now: options.now }),
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
