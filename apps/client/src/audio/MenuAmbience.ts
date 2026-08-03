import { AudioPlayer } from "../forge/AudioPlayer";
import { getAudioBusGain } from "./AudioMixer";
import { domBedVoices, type BedId, type BedVoice, type BedVoiceFactory } from "../gameplay/AmbienceController";

/**
 * The shop heard from the doorway, behind the menu.
 *
 * `AmbienceController` runs a round and treats the lobby as one of its silent
 * phases, and it is only built once a round opens at all, so everything before
 * the player presses play — the menu, the quality panel, a join that failed and
 * sent them back — had no sound of any kind. That is the first thing anyone
 * hears of the game, and it was dead air.
 *
 * Two beds rather than one: the room tone says the shop is large and empty, and
 * the candle says something in it is alight and close to the listener. A clock
 * two rooms away strikes every so often over the top, which is the only event
 * here and is what keeps a held menu from settling into a flat drone.
 *
 * This drives itself on a timer rather than a frame loop. Nothing on the menu
 * renders, and the beds only need attention often enough to catch a loop seam.
 */

/** Beds under the menu, and how loud each sits when the fade has finished. */
const MENU_BEDS: readonly (readonly [BedId, number])[] = [
  ["amb_shop_room_tone", 0.34],
  ["amb_candle_flicker", 0.24],
];

/** Slow enough that the menu is heard opening rather than switched on. */
const FADE_IN_MS = 2_000;
/** Fast enough that pressing play does not leave the menu playing under a round. */
const FADE_OUT_MS = 700;

/** How often the beds are serviced. The seam they cover is half a second wide. */
const TICK_MS = 50;

/** A distant clock, at a random gap in this range. */
const CHIME_MIN_MS = 40_000;
const CHIME_MAX_MS = 95_000;
/** Two rooms away, so it is weather rather than a clock. */
const CHIME_VOLUME = 0.22;
/** The first strike waits at least this long, so the menu opens on room tone. */
const CHIME_FIRST_MIN_MS = 12_000;

interface Bed {
  readonly voice: BedVoice;
  readonly ceiling: number;
}

export class MenuAmbience {
  private readonly createVoice: BedVoiceFactory;
  private readonly chimes: AudioPlayer;
  private readonly beds: Bed[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 0 silent, 1 fully open. Fades both ways. */
  private level = 0;
  private fadingOut = false;
  private untilChimeMs = 0;
  private disposed = false;

  constructor(createVoice: BedVoiceFactory = domBedVoices()) {
    this.createVoice = createVoice;
    this.chimes = new AudioPlayer(undefined, CHIME_VOLUME, "ui");
  }

  /** True while the beds are open, which is what a test can see. */
  get running(): boolean {
    return this.timer !== null && !this.fadingOut;
  }

  /** The gain the loudest bed is actually at, after the fade and the master. */
  get level0to1(): number {
    return this.level;
  }

  /**
   * Opens the beds. Idempotent, and safe to call before the page has seen a
   * gesture: a browser that refuses playback leaves the elements paused and the
   * voices ask again on their own every tick.
   */
  start(): void {
    if (this.disposed) return;
    this.fadingOut = false;
    if (this.timer !== null) return;

    for (const [bedId, ceiling] of MENU_BEDS) {
      this.beds.push({ voice: this.createVoice(bedId), ceiling });
    }
    this.untilChimeMs = CHIME_FIRST_MIN_MS + Math.random() * (CHIME_MAX_MS - CHIME_FIRST_MIN_MS);
    this.timer = setInterval(() => {
      this.tick(TICK_MS);
    }, TICK_MS);
  }

  /**
   * Closes the beds over `FADE_OUT_MS` and releases them. The round's own
   * ambience is what plays next, and two shops running at once is the one thing
   * this must not leave behind.
   */
  stop(): void {
    if (this.timer === null) return;
    this.fadingOut = true;
  }

  dispose(): void {
    this.disposed = true;
    this.release();
    this.chimes.dispose();
  }

  private tick(dtMs: number): void {
    const step = dtMs / (this.fadingOut ? FADE_OUT_MS : FADE_IN_MS);
    this.level = Math.min(1, Math.max(0, this.level + (this.fadingOut ? -step : step)));

    const master = getAudioBusGain("ambience");
    for (const bed of this.beds) {
      bed.voice.setGain(bed.ceiling * this.level * master);
      bed.voice.update(dtMs);
    }

    if (this.fadingOut && this.level <= 0) {
      this.release();
      return;
    }
    this.stepChime(dtMs);
  }

  /** A clock somewhere else in the shop, once the beds are properly open. */
  private stepChime(dtMs: number): void {
    if (this.level < 1) return;
    this.untilChimeMs -= dtMs;
    if (this.untilChimeMs > 0) return;
    this.untilChimeMs = CHIME_MIN_MS + Math.random() * (CHIME_MAX_MS - CHIME_MIN_MS);
    this.chimes.play("clock_chime", 0.04);
  }

  private release(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const bed of this.beds) bed.voice.stop();
    this.beds.length = 0;
    this.level = 0;
    this.fadingOut = false;
  }
}
