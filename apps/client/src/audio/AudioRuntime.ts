/** One browser lifecycle for HTML audio and Web Audio, including Portals iframes. */
export class AudioRuntime {
  private installed = false;
  private unlocked = false;
  private hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  private readonly queued = new Set<HTMLMediaElement>();
  private readonly media = new Set<HTMLMediaElement>();
  private readonly playingBeforeHide = new Set<HTMLMediaElement>();
  private readonly contexts = new Set<AudioContext>();

  install(): () => void {
    if (this.installed || typeof document === "undefined") return () => {};
    this.installed = true;
    const unlock = (): void => { void this.unlock(); };
    const visibility = (): void => { this.onVisibilityChange(); };
    const pageHide = (): void => { this.setHidden(true); };
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    document.addEventListener("touchstart", unlock, true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pageshow", visibility);
    window.addEventListener("pagehide", pageHide);
    return () => {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
      document.removeEventListener("touchstart", unlock, true);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pageshow", visibility);
      window.removeEventListener("pagehide", pageHide);
      this.installed = false;
    };
  }

  registerContext(context: AudioContext): void {
    this.contexts.add(context);
    if (this.unlocked && !this.hidden) void context.resume().catch(() => {});
  }

  play(element: HTMLMediaElement, essentialBeforeUnlock = false): void {
    this.media.add(element);
    if (this.hidden) {
      this.queued.add(element);
      return;
    }
    try {
      const playback = element.play();
      void Promise.resolve(playback).then(() => {
        this.unlocked = true;
        this.queued.delete(element);
      }).catch(() => {
        // A hover or footstep that happened before unlock is stale by the time
        // a gesture arrives. Only critical cues explicitly opt into replay.
        if (essentialBeforeUnlock) this.queued.add(element);
      });
    } catch {
      if (essentialBeforeUnlock) this.queued.add(element);
    }
  }

  forget(element: HTMLMediaElement): void {
    this.media.delete(element);
    this.queued.delete(element);
    this.playingBeforeHide.delete(element);
  }

  async unlock(): Promise<void> {
    if (this.hidden) return;
    this.unlocked = true;
    await Promise.all([...this.contexts].map(async (context) => context.resume().catch(() => {})));
    const queued = [...this.queued];
    this.queued.clear();
    for (const element of queued) this.play(element);
  }

  private onVisibilityChange(): void {
    this.setHidden(document.visibilityState === "hidden");
  }

  private setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) {
      for (const element of this.media) {
        if (!element.paused) {
          this.playingBeforeHide.add(element);
          element.pause();
        }
      }
      for (const context of this.contexts) void context.suspend().catch(() => {});
      return;
    }
    for (const element of this.playingBeforeHide) this.queued.add(element);
    this.playingBeforeHide.clear();
    if (this.unlocked) void this.unlock();
  }
}

export const audioRuntime = new AudioRuntime();

export function installAudioRuntime(): () => void {
  return audioRuntime.install();
}
