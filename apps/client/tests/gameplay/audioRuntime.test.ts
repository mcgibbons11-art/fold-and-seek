import { describe, expect, it, vi } from "vitest";

import { AudioRuntime } from "../../src/audio/AudioRuntime";

describe("audio runtime", () => {
  it("retries autoplay-refused media after the shared unlock", async () => {
    const runtime = new AudioRuntime();
    let allowed = false;
    const media = {
      paused: true,
      play: vi.fn(async () => {
        if (!allowed) throw new DOMException("gesture required", "NotAllowedError");
      }),
      pause: vi.fn(),
    } as unknown as HTMLMediaElement;

    runtime.play(media, true);
    await Promise.resolve();
    allowed = true;
    await runtime.unlock();
    await Promise.resolve();

    expect(media.play).toHaveBeenCalledTimes(2);
  });

  it("does not replay stale low-priority audio after unlock", async () => {
    const runtime = new AudioRuntime();
    const media = {
      paused: true,
      play: vi.fn(async () => { throw new DOMException("gesture required", "NotAllowedError"); }),
      pause: vi.fn(),
    } as unknown as HTMLMediaElement;
    runtime.play(media);
    await Promise.resolve();
    await runtime.unlock();
    expect(media.play).toHaveBeenCalledOnce();
  });

  it("resumes every registered context from the same unlock", async () => {
    const runtime = new AudioRuntime();
    const resume = vi.fn(async () => {});
    runtime.registerContext({ resume } as unknown as AudioContext);
    await runtime.unlock();
    expect(resume).toHaveBeenCalledOnce();
  });
});
