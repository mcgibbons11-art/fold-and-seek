export type SoundCaptionImportance = "gameplay" | "critical";

export interface SoundCaption {
  readonly id: number;
  readonly label: string;
  /** Radians from screen-up; null is a non-positional/global sound. */
  readonly bearingRad: number | null;
  readonly importance: SoundCaptionImportance;
  readonly count: number;
  readonly remainingMs: number;
}

export type SoundCaptionMode = "off" | "critical" | "gameplay";

export interface SoundCaptionEvent {
  readonly label: string;
  readonly bearingRad?: number | null;
  readonly importance?: SoundCaptionImportance;
  readonly durationMs?: number;
}

const DEFAULT_DURATION_MS = 2_200;
const MERGE_WINDOW_MS = 650;
const MAX_CAPTIONS = 3;

/**
 * A tiny semantic ledger, deliberately independent of actual playback. Muting
 * the game must not mute information a deaf or hard-of-hearing player asked
 * to see, and repeated footsteps must collapse instead of flooding the HUD.
 */
export class SoundCaptionLedger {
  private captions: SoundCaption[] = [];
  private nextId = 1;

  get current(): readonly SoundCaption[] {
    return this.captions;
  }

  push(event: SoundCaptionEvent): void {
    const bearingRad = event.bearingRad ?? null;
    const importance = event.importance ?? "gameplay";
    const durationMs = Math.max(300, event.durationMs ?? DEFAULT_DURATION_MS);
    const mergeIndex = this.captions.findIndex(
      (caption) =>
        caption.label === event.label &&
        caption.importance === importance &&
        caption.remainingMs > durationMs - MERGE_WINDOW_MS,
    );
    const next: SoundCaption = {
      id: mergeIndex < 0 ? this.nextId++ : (this.captions[mergeIndex]?.id ?? this.nextId++),
      label: event.label,
      bearingRad,
      importance,
      count: mergeIndex < 0 ? 1 : (this.captions[mergeIndex]?.count ?? 0) + 1,
      remainingMs: durationMs,
    };
    if (mergeIndex >= 0) this.captions.splice(mergeIndex, 1);
    this.captions = [next, ...this.captions].slice(0, MAX_CAPTIONS);
  }

  update(dtMs: number): boolean {
    const before = this.signature();
    this.captions = this.captions
      .map((caption) => ({ ...caption, remainingMs: Math.max(0, caption.remainingMs - dtMs) }))
      .filter((caption) => caption.remainingMs > 0);
    return before !== this.signature();
  }

  visible(mode: SoundCaptionMode): readonly SoundCaption[] {
    if (mode === "off") return [];
    return mode === "critical"
      ? this.captions.filter((caption) => caption.importance === "critical")
      : this.captions;
  }

  clear(): void {
    this.captions = [];
  }

  private signature(): string {
    return this.captions.map((caption) => `${caption.id}:${Math.ceil(caption.remainingMs / 100)}`).join("|");
  }
}
