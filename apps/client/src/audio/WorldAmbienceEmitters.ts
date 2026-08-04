import { WORLD_SCALE } from "../inspector/navData";
import type { AudioPoint, SpatialAudioPlayer, SpatialVoice } from "./SpatialAudioPlayer";

export interface WorldAmbienceLandmark {
  readonly id:
    | "amb_clock_ticks"
    | "amb_glass_hum"
    | "amb_counter_paper"
    | "amb_workshop_creak"
    | "amb_candle_flicker";
  readonly position: AudioPoint;
  readonly gain: number;
}

/** Five readable anchors, deliberately fewer than the seven zone beds. */
export const WORLD_AMBIENCE_LANDMARKS: readonly WorldAmbienceLandmark[] = [
  { id: "amb_clock_ticks", position: { x: -7.1, y: 1.55, z: -0.5 }, gain: 0.2 },
  { id: "amb_glass_hum", position: { x: 0.1, y: 1.15, z: -0.1 }, gain: 0.1 },
  { id: "amb_counter_paper", position: { x: 2.7, y: 1.05, z: 4.55 }, gain: 0.11 },
  { id: "amb_workshop_creak", position: { x: 6.45, y: 1.25, z: -1.5 }, gain: 0.15 },
  // The Curio Annex candle (2026-08-04): the salon has its own small fire.
  { id: "amb_candle_flicker", position: { x: -0.85, y: 1.1, z: 4.85 }, gain: 0.12 },
] as const;

/**
 * Persistent, quiet positional landmarks. The broad room/zone beds remain the
 * acoustic floor; these four emitters give turning toward the clock, cabinets,
 * counter, or workshop a perceptible direction without filling every prop with
 * a loop.
 */
export class WorldAmbienceEmitters {
  private readonly voices: SpatialVoice[] = [];
  private generation = 0;

  constructor(
    private readonly audio: Pick<SpatialAudioPlayer, "playAt">,
    private readonly landmarks: readonly WorldAmbienceLandmark[] = WORLD_AMBIENCE_LANDMARKS,
  ) {}

  async start(): Promise<void> {
    this.stop(0);
    const generation = ++this.generation;
    const created = await Promise.all(
      this.landmarks.map((landmark) =>
        this.audio.playAt(landmark.id, landmark.position, {
          gain: landmark.gain,
          bus: "ambience",
          loop: true,
          refDistanceM: WORLD_SCALE.playerHeight * 4,
          maxDistanceM: 16,
          minimumGain: 0.035,
        }),
      ),
    );
    if (generation !== this.generation) {
      for (const voice of created) voice?.stop(0);
      return;
    }
    for (const voice of created) if (voice !== null) this.voices.push(voice);
  }

  stop(fadeMs = 180): void {
    this.generation += 1;
    for (const voice of this.voices.splice(0)) voice.stop(fadeMs);
  }

  dispose(): void {
    this.stop(40);
  }
}
