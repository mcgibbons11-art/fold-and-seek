import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SpatialAudioPlayer,
  SpatialAudioRuntime,
} from "../../src/audio/SpatialAudioPlayer";

class FakeParam {
  value = 0;
  setValueAtTime(value: number): void {
    this.value = value;
  }
  cancelScheduledValues(): void {}
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
}

class FakeNode {
  connect(): this {
    return this;
  }
  disconnect(): void {}
}

function fakeContext() {
  const listener = {
    positionX: new FakeParam(),
    positionY: new FakeParam(),
    positionZ: new FakeParam(),
    forwardX: new FakeParam(),
    forwardY: new FakeParam(),
    forwardZ: new FakeParam(),
    upX: new FakeParam(),
    upY: new FakeParam(),
    upZ: new FakeParam(),
  };
  const panners: Array<
    FakeNode & {
      positionX: FakeParam;
      positionY: FakeParam;
      positionZ: FakeParam;
      rolloffFactor: number;
      refDistance: number;
      maxDistance: number;
    }
  > = [];
  const sources: Array<FakeNode & { started: boolean; playbackRate: FakeParam }> = [];
  const context = {
    currentTime: 0,
    state: "running",
    destination: new FakeNode(),
    listener,
    createGain: () => Object.assign(new FakeNode(), { gain: new FakeParam() }),
    createPanner: () => {
      const panner = Object.assign(new FakeNode(), {
        positionX: new FakeParam(),
        positionY: new FakeParam(),
        positionZ: new FakeParam(),
        distanceModel: "inverse",
        panningModel: "HRTF",
        refDistance: 1,
        maxDistance: 10,
        rolloffFactor: 1,
        coneInnerAngle: 0,
        coneOuterAngle: 0,
        coneOuterGain: 0,
      });
      panners.push(panner);
      return panner;
    },
    createBufferSource: () => {
      const source = Object.assign(new FakeNode(), {
        context,
        buffer: null,
        loop: false,
        playbackRate: new FakeParam(),
        started: false,
        addEventListener: () => undefined,
        start() {
          this.started = true;
        },
        stop: () => undefined,
      });
      sources.push(source);
      return source;
    },
    decodeAudioData: vi.fn(async () => ({ duration: 1 })),
    resume: vi.fn(async () => undefined),
  };
  return { context, listener, panners, sources };
}

afterEach(() => vi.unstubAllGlobals());

describe("SpatialAudioPlayer", () => {
  it("shares an oriented listener and builds a bounded HRTF source", async () => {
    const fake = fakeContext();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) })),
    );
    const runtime = new SpatialAudioRuntime(fake.context as unknown as AudioContext);
    runtime.setListener({
      position: { x: 2, y: 1, z: -3 },
      forward: { x: 1, y: 0, z: 0 },
    });
    const player = new SpatialAudioPlayer(runtime, "/game/");
    const voice = await player.playAt("footstep_wood", { x: 4, y: 0, z: 1 }, {
      refDistanceM: 1,
      maxDistanceM: 11,
      minimumGain: 0.1,
    });

    expect(voice).not.toBeNull();
    expect(fake.listener.positionX.value).toBe(2);
    expect(fake.listener.forwardX.value).toBe(1);
    expect(fake.listener.upY.value).toBe(1);
    expect(fake.panners[0]?.positionX.value).toBe(4);
    expect(fake.panners[0]?.rolloffFactor).toBeCloseTo(0.9);
    expect(fake.sources[0]?.started).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/game/assets/audio/sfx/footstep_wood.mp3");
  });

  it("centres invalid source positions on the last valid listener pose", async () => {
    const fake = fakeContext();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) })),
    );
    const runtime = new SpatialAudioRuntime(fake.context as unknown as AudioContext);
    runtime.setListener({
      position: { x: -2, y: 1.5, z: 6 },
      forward: { x: 0, y: 0, z: -1 },
    });
    const player = new SpatialAudioPlayer(runtime, "/");
    await player.playAt("amb_clock_ticks", { x: Number.NaN, y: 0, z: 0 });

    expect(fake.panners[0]?.positionX.value).toBe(-2);
    expect(fake.panners[0]?.positionY.value).toBe(1.5);
    expect(fake.panners[0]?.positionZ.value).toBe(6);
    expect(fetch).toHaveBeenCalledWith("/assets/audio/ambience/amb_clock_ticks.mp3");
  });
});
