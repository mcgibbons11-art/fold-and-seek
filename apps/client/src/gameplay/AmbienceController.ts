import type { WatchedLevel } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";

import { getMasterVolume } from "../forge/AudioPlayer";
import { ZONES } from "../world/maps/zones";

/**
 * The room's own voice. Everything the player hears that is not an event: the
 * shop's night tone under everything, the bed of whichever zone they are
 * standing in, what the phase sounds like, and their own heartbeat when an
 * Inspector is looking at them.
 *
 * Four channels play at once and each one crossfades within itself, so moving
 * from the clock wall to the reading nook exchanges one zone bed for another
 * without touching the base tone or the heartbeat. A stinger ducks all four
 * briefly, which is what keeps a catch or a wrong accusation on top of the mix
 * rather than buried in room tone.
 *
 * Routing and gain live here and are pure. Playback lives behind `BedVoice`, so
 * the phase machine below can be driven a frame at a time in a test with no
 * audio device and no DOM.
 */

/**
 * Bundled ambience loops. Ids match the files in assets/audio/ambience, and the
 * list is the runtime one as well as the type, because the zone table below has
 * to be checked against it at load rather than asserted into place.
 */
export const BED_IDS = [
  "amb_shop_room_tone",
  "amb_street_moon",
  "amb_clock_ticks",
  "amb_glass_hum",
  "amb_nook_settle",
  "amb_counter_paper",
  "amb_workshop_creak",
  "amb_office_hum",
  "amb_forge_tinker",
  "amb_inspector_near",
  "amb_watched_low",
  "amb_watched_high",
] as const;

export type BedId = (typeof BED_IDS)[number];

function isBedId(value: string): value is BedId {
  return (BED_IDS as readonly string[]).includes(value);
}

/** One playing loop, at a gain the controller sets every frame. */
export interface BedVoice {
  /** 0 silent, 1 the bed's own full level. */
  setGain(gain: number): void;
  /** Advances anything the voice has to do itself, such as its loop seam. */
  update(dtMs: number): void;
  stop(): void;
}

export type BedVoiceFactory = (bedId: BedId) => BedVoice;

/**
 * The four things playing at once. They are separate because they change for
 * separate reasons: a zone changes when the player walks, a phase when the
 * match advances, and tension when an Inspector turns their head.
 */
type ChannelId = "base" | "zone" | "phase" | "tension";

const CHANNEL_IDS: readonly ChannelId[] = ["base", "zone", "phase", "tension"];

/**
 * How loud each channel sits when it is the only thing playing. The base tone
 * is deliberately the quietest: it is the floor the others stand on, and a room
 * tone the player can pick out is a room tone that is too loud.
 */
const CHANNEL_GAIN: Readonly<Record<ChannelId, number>> = {
  base: 0.3,
  zone: 0.38,
  phase: 0.32,
  tension: 0.55,
};

/** Seconds of overlap when a channel exchanges one bed for another. */
const CROSSFADE_MS = 1_200;
/** A heartbeat arrives faster than that: being looked at is sudden. */
const TENSION_CROSSFADE_MS = 450;

/** How far a stinger pushes the beds down, and how long they take to return. */
const DUCK_DEPTH = 0.45;
const DUCK_HOLD_MS = 180;
const DUCK_RECOVER_MS = 900;

/** Phases in which the hunt's low rumble plays under everything. */
const INSPECTION_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.InspectionIntro,
  MatchPhase.Inspection,
  MatchPhase.FinalCountdown,
]);

/** Phases in which the player is at the workbench. */
const FORGE_PHASES: ReadonlySet<MatchPhase> = new Set([MatchPhase.Forge, MatchPhase.Locking]);

/** Phases with no room at all: the lobby and everything after the hunt. */
const SILENT_PHASES: ReadonlySet<MatchPhase> = new Set([MatchPhase.Lobby, MatchPhase.Disposed]);

const WATCHED_BEDS: Readonly<Record<WatchedLevel, BedId | null>> = {
  0: null,
  1: "amb_watched_low",
  2: "amb_watched_high",
};

/**
 * Zone id to bed id. The map already names a bed on every zone (`ambienceId` in
 * `world/maps/zones.ts`), so this is read from the map rather than written out
 * again and a zone gains its bed by being authored. `ambienceId` is a plain
 * string there, so a zone naming a bed that was never generated would otherwise
 * fall through to silence in one corner of the shop and nowhere else, which is
 * exactly the kind of fault nobody notices; it is checked here instead, once, at
 * load.
 */
const ZONE_BEDS: ReadonlyMap<string, BedId> = new Map(
  ZONES.map((zone) => {
    if (!isBedId(zone.ambienceId)) {
      throw new Error(
        `ambience: zone "${zone.id}" names bed "${zone.ambienceId}", which is not bundled`,
      );
    }
    return [zone.id, zone.ambienceId];
  }),
);

/** What the controller needs to know about the world each frame. */
export interface AmbienceInput {
  readonly phase: MatchPhase;
  readonly watchedLevel: WatchedLevel;
  /** Where the listener is standing, for the zone bed. Null while there is no camera. */
  readonly listenerX: number | null;
  readonly listenerZ: number | null;
}

/** One channel's fade between the bed it was playing and the bed it wants. */
interface Channel {
  /** The bed being faded in, and the one being faded out under it. */
  wanted: BedId | null;
  playing: BedId | null;
  outgoing: BedId | null;
  voice: BedVoice | null;
  outgoingVoice: BedVoice | null;
  /** 0 at the start of the crossfade, 1 once it has finished. */
  progress: number;
  crossfadeMs: number;
  /** The gain last handed to the leading voice, which is what is audible. */
  appliedGain: number;
}

function createChannel(): Channel {
  return {
    wanted: null,
    playing: null,
    outgoing: null,
    voice: null,
    outgoingVoice: null,
    progress: 1,
    crossfadeMs: CROSSFADE_MS,
    appliedGain: 0,
  };
}

export class AmbienceController {
  private readonly createVoice: BedVoiceFactory;
  private readonly channels: Record<ChannelId, Channel> = {
    base: createChannel(),
    zone: createChannel(),
    phase: createChannel(),
    tension: createChannel(),
  };

  /**
   * Nothing plays until the page has seen a gesture. Browsers refuse playback
   * before one, and a bed that was refused stays silent rather than throwing,
   * so the beds are not even created until `start` is called.
   */
  private started = false;
  private disposed = false;
  private duck = 1;
  private duckHoldMs = 0;

  constructor(createVoice: BedVoiceFactory) {
    this.createVoice = createVoice;
  }

  /** True once a gesture has let the beds open. */
  get running(): boolean {
    return this.started;
  }

  /** Called from the first click the flow already contains. Idempotent. */
  start(): void {
    if (this.disposed) return;
    this.started = true;
  }

  /**
   * Pushes the beds down for a moment so an event sits on top of them. Called
   * beside a stinger rather than derived from one: the mix decides what is loud,
   * and that is a decision, not a side effect of a file playing.
   */
  duckUnderStinger(): void {
    this.duck = 1 - DUCK_DEPTH;
    this.duckHoldMs = DUCK_HOLD_MS;
  }

  /** Which bed a channel is fading toward, or null when it wants silence. */
  wantedBed(channel: ChannelId): BedId | null {
    return this.channels[channel].wanted;
  }

  /**
   * The gain a channel's leading bed is actually at, after the fade, the duck
   * and the master. This is the number handed to the voice rather than a second
   * calculation of it, so it cannot quietly disagree with what is audible.
   */
  gainOf(channel: ChannelId): number {
    return this.channels[channel].appliedGain;
  }

  update(dtMs: number, input: AmbienceInput): void {
    if (!this.started || this.disposed) return;

    this.advanceDuck(dtMs);
    this.route(input);

    for (const id of CHANNEL_IDS) this.advanceChannel(id, dtMs);
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
    for (const id of CHANNEL_IDS) {
      const channel = this.channels[id];
      channel.voice?.stop();
      channel.outgoingVoice?.stop();
      channel.voice = null;
      channel.outgoingVoice = null;
      channel.playing = null;
      channel.outgoing = null;
      channel.wanted = null;
    }
  }

  /** Decides what every channel should be playing this frame. */
  private route(input: AmbienceInput): void {
    const silent = SILENT_PHASES.has(input.phase);
    this.want("base", silent ? null : "amb_shop_room_tone");
    this.want("zone", silent ? null : this.zoneBed(input.listenerX, input.listenerZ));
    this.want("phase", this.phaseBed(input.phase));
    // Being looked at only means anything while the hunt is running. A watched
    // level left over from a previous round must not beat under the results.
    this.want(
      "tension",
      INSPECTION_PHASES.has(input.phase) ? WATCHED_BEDS[input.watchedLevel] : null,
    );
  }

  private phaseBed(phase: MatchPhase): BedId | null {
    if (FORGE_PHASES.has(phase)) return "amb_forge_tinker";
    if (INSPECTION_PHASES.has(phase)) return "amb_inspector_near";
    return null;
  }

  /**
   * The zone the listener is standing in. Zones tile the sales floor, so a
   * position on the floor lands in exactly one; a position outside them all
   * (the Inspector still in the office doorway, a camera pulled back through a
   * wall) keeps whatever bed was already playing rather than cutting to silence
   * and back a frame later.
   */
  private zoneBed(x: number | null, z: number | null): BedId | null {
    if (x === null || z === null) return this.channels.zone.wanted;
    for (const zone of ZONES) {
      const { min, max } = zone.bounds;
      if (x >= min.x && x <= max.x && z >= min.z && z <= max.z) {
        return ZONE_BEDS.get(zone.id) ?? null;
      }
    }
    return this.channels.zone.wanted;
  }

  /**
   * Points a channel at a bed. Asking for what is already playing is a no-op,
   * which matters because `route` runs every frame; only a change starts a fade.
   */
  private want(id: ChannelId, bed: BedId | null): void {
    const channel = this.channels[id];
    if (channel.wanted === bed) return;
    channel.wanted = bed;

    // Whatever was leading becomes the outgoing bed. A change that arrives
    // mid-crossfade drops the bed that had not arrived yet rather than stacking
    // a third voice: on a fast walk through three zones the player hears the
    // one they left and the one they are in, never all three.
    channel.outgoingVoice?.stop();
    channel.outgoingVoice = channel.voice;
    channel.outgoing = channel.playing;

    channel.playing = bed;
    channel.voice = bed === null ? null : this.createVoice(bed);
    channel.progress = 0;
    channel.crossfadeMs = id === "tension" ? TENSION_CROSSFADE_MS : CROSSFADE_MS;
  }

  private advanceChannel(id: ChannelId, dtMs: number): void {
    const channel = this.channels[id];
    if (channel.progress < 1) {
      channel.progress = Math.min(1, channel.progress + dtMs / channel.crossfadeMs);
    }

    const ceiling = CHANNEL_GAIN[id] * this.duck * getMasterVolume();
    channel.appliedGain = channel.voice === null ? 0 : ceiling * channel.progress;
    channel.voice?.setGain(channel.appliedGain);
    channel.voice?.update(dtMs);

    if (channel.outgoingVoice === null) return;
    if (channel.progress >= 1) {
      channel.outgoingVoice.stop();
      channel.outgoingVoice = null;
      channel.outgoing = null;
      return;
    }
    // Equal-power would be right for two takes of the same material; these are
    // different rooms, so a straight complement is what keeps the total from
    // swelling as one replaces the other.
    channel.outgoingVoice.setGain(ceiling * (1 - channel.progress));
    channel.outgoingVoice.update(dtMs);
  }

  private advanceDuck(dtMs: number): void {
    if (this.duck >= 1) return;
    if (this.duckHoldMs > 0) {
      this.duckHoldMs = Math.max(0, this.duckHoldMs - dtMs);
      return;
    }
    this.duck = Math.min(1, this.duck + (dtMs / DUCK_RECOVER_MS) * DUCK_DEPTH);
  }
}

// ---------------------------------------------------------------------------
// The DOM-backed voice
// ---------------------------------------------------------------------------

/**
 * How long before the end of the file the next pass starts, to cover the seam.
 *
 * The beds are generated as seamless loops, but an MP3 carries encoder padding
 * at both ends, so `HTMLMediaElement.loop` still leaves a short hole in a tone
 * the player is meant not to notice. Two elements of the same file running a
 * fixed distance apart, each fading across the join, means something is always
 * mid-file and the hole never arrives.
 */
const SEAM_OVERLAP_S = 0.5;

/** Only ever fetched from the bundle; see the Portals sandbox note in CLAUDE.md. */
const BED_DIR = "assets/audio/ambience";

class ElementBedVoice implements BedVoice {
  private readonly elements: readonly [HTMLAudioElement, HTMLAudioElement];
  private leading = 0;
  private gain = 0;
  private stopped = false;
  /** 0..1 across the seam; 1 whenever a single element is carrying the loop. */
  private seam = 1;

  constructor(bedId: BedId, baseUrl: string) {
    const src = `${baseUrl}${BED_DIR}/${bedId}.mp3`;
    this.elements = [new Audio(src), new Audio(src)];
    for (const element of this.elements) {
      element.preload = "auto";
      element.volume = 0;
    }
    this.play(0);
  }

  setGain(gain: number): void {
    this.gain = Math.min(Math.max(gain, 0), 1);
  }

  update(): void {
    if (this.stopped) return;

    const lead = this.elements[this.leading];
    const trail = this.elements[1 - this.leading];
    if (lead === undefined || trail === undefined) return;

    // A browser that refused the opening `play` leaves the bed paused, and
    // nothing else would ever ask it again. Asking every frame costs a property
    // read while it is playing and recovers the whole soundscape when it is not.
    if (lead.paused) this.play(this.leading);

    // `duration` is NaN until the file has enough of itself to know; until then
    // there is no seam to plan for and the leading element simply plays.
    const duration = lead.duration;
    if (Number.isFinite(duration) && duration > SEAM_OVERLAP_S) {
      const remaining = duration - lead.currentTime;
      if (remaining <= SEAM_OVERLAP_S) {
        if (trail.paused) this.play(1 - this.leading);
        this.seam = Math.max(0, remaining / SEAM_OVERLAP_S);
        if (remaining <= 0) {
          // The lead has run out; the trail is now carrying the loop.
          lead.pause();
          lead.currentTime = 0;
          this.leading = 1 - this.leading;
          this.seam = 1;
        }
      } else {
        this.seam = 1;
      }
    }

    const leadElement = this.elements[this.leading];
    const trailElement = this.elements[1 - this.leading];
    if (leadElement !== undefined) leadElement.volume = this.gain * this.seam;
    if (trailElement !== undefined) {
      trailElement.volume = trailElement.paused ? 0 : this.gain * (1 - this.seam);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const element of this.elements) {
      element.pause();
      element.removeAttribute("src");
    }
  }

  private play(index: number): void {
    const element = this.elements[index];
    if (element === undefined) return;
    element.currentTime = 0;
    void element.play().catch(() => {
      // A bed refused before the page's first gesture is not an error worth
      // reporting: the next phase change asks for it again.
    });
  }
}

/** The factory the game uses. Tests pass their own. */
export function domBedVoices(baseUrl: string = import.meta.env.BASE_URL): BedVoiceFactory {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return (bedId) => new ElementBedVoice(bedId, base);
}
