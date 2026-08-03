import type { SoundId } from "../forge/AudioPlayer";
import { audioMixer } from "./AudioMixer";
import { audioRuntime } from "./AudioRuntime";

export interface AudioPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ListenerPose {
  readonly position: AudioPoint;
  readonly forward: AudioPoint;
  readonly up?: AudioPoint;
}

export interface SpatialPlayOptions {
  readonly bus?: "gameplay" | "ambience";
  readonly gain?: number;
  readonly loop?: boolean;
  readonly pitch?: number;
  readonly refDistanceM?: number;
  readonly maxDistanceM?: number;
  readonly minimumGain?: number;
}

export interface SpatialVoice {
  readonly ended: Promise<void>;
  setPosition(position: AudioPoint): void;
  setGain(gain: number, rampMs?: number): void;
  stop(fadeMs?: number): void;
}

type AudioAsset = SoundId | `amb_${string}`;

const DEFAULT_FORWARD: AudioPoint = { x: 0, y: 0, z: -1 };
const DEFAULT_UP: AudioPoint = { x: 0, y: 1, z: 0 };
const DEFAULT_REF_DISTANCE_M = 0.8;
const DEFAULT_MAX_DISTANCE_M = 13;
const DEFAULT_MINIMUM_GAIN = 0.08;
const MAX_SPATIAL_VOICES = 20;

function finitePoint(point: AudioPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function setParam(param: AudioParam, value: number, now: number): void {
  param.setValueAtTime(value, now);
}

function setListenerPosition(listener: AudioListener, point: AudioPoint, now: number): void {
  if (listener.positionX !== undefined) {
    setParam(listener.positionX, point.x, now);
    setParam(listener.positionY, point.y, now);
    setParam(listener.positionZ, point.z, now);
  } else {
    listener.setPosition(point.x, point.y, point.z);
  }
}

function setListenerOrientation(
  listener: AudioListener,
  forward: AudioPoint,
  up: AudioPoint,
  now: number,
): void {
  if (listener.forwardX !== undefined) {
    setParam(listener.forwardX, forward.x, now);
    setParam(listener.forwardY, forward.y, now);
    setParam(listener.forwardZ, forward.z, now);
    setParam(listener.upX, up.x, now);
    setParam(listener.upY, up.y, now);
    setParam(listener.upZ, up.z, now);
  } else {
    listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }
}

function setPannerPosition(panner: PannerNode, point: AudioPoint, now: number): void {
  if (panner.positionX !== undefined) {
    setParam(panner.positionX, point.x, now);
    setParam(panner.positionY, point.y, now);
    setParam(panner.positionZ, point.z, now);
  } else {
    panner.setPosition(point.x, point.y, point.z);
  }
}

/**
 * One Web Audio graph and decode cache for the entire game. Keeping this shared
 * prevents every presentation feature from making another AudioContext, while
 * `setListener` gives all positional voices the same camera orientation.
 */
export class SpatialAudioRuntime {
  readonly context: AudioContext;

  private readonly outputs: Readonly<Record<"gameplay" | "ambience", GainNode>>;
  private readonly unsubscribeMixer: () => void;
  private readonly decoded = new Map<string, Promise<AudioBuffer>>();
  private readonly active: SpatialVoiceImpl[] = [];
  private listenerPosition: AudioPoint = { x: 0, y: 0, z: 0 };
  private disposed = false;

  constructor(context?: AudioContext) {
    const Context = globalThis.AudioContext;
    if (context === undefined && Context === undefined) {
      throw new Error("Spatial audio is unavailable: this browser has no AudioContext");
    }
    this.context = context ?? new Context();
    audioRuntime.registerContext(this.context);
    this.outputs = {
      gameplay: this.context.createGain(),
      ambience: this.context.createGain(),
    };
    this.outputs.gameplay.connect(this.context.destination);
    this.outputs.ambience.connect(this.context.destination);
    const applyMix = (): void => {
      const now = this.context.currentTime;
      this.outputs.gameplay.gain.setValueAtTime(audioMixer.gain("gameplay"), now);
      this.outputs.ambience.gain.setValueAtTime(audioMixer.gain("ambience"), now);
    };
    applyMix();
    this.unsubscribeMixer = audioMixer.subscribe(applyMix);
  }

  setListener(pose: ListenerPose): void {
    if (this.disposed) return;
    const position = finitePoint(pose.position) ? pose.position : this.listenerPosition;
    const forward = finitePoint(pose.forward) ? pose.forward : DEFAULT_FORWARD;
    const up = pose.up !== undefined && finitePoint(pose.up) ? pose.up : DEFAULT_UP;
    this.listenerPosition = { ...position };
    const now = this.context.currentTime;
    setListenerPosition(this.context.listener, position, now);
    setListenerOrientation(this.context.listener, forward, up, now);
  }

  async playUrl(
    url: string,
    position: AudioPoint,
    options: SpatialPlayOptions = {},
  ): Promise<SpatialVoice | null> {
    if (this.disposed) return null;
    const buffer = await this.load(url);
    if (this.disposed) return null;

    while (this.active.length >= MAX_SPATIAL_VOICES) this.active[0]?.stop(12);
    const voice = new SpatialVoiceImpl(
      this.context,
      this.outputs[options.bus ?? "gameplay"],
      buffer,
      finitePoint(position) ? position : this.listenerPosition,
      options,
      () => {
        const index = this.active.indexOf(voice);
        if (index >= 0) this.active.splice(index, 1);
      },
    );
    this.active.push(voice);
    return voice;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of [...this.active]) voice.stop(20);
    this.active.length = 0;
    this.unsubscribeMixer();
    this.outputs.gameplay.disconnect();
    this.outputs.ambience.disconnect();
    this.decoded.clear();
  }

  private load(url: string): Promise<AudioBuffer> {
    const cached = this.decoded.get(url);
    if (cached !== undefined) return cached;
    const decoded = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`audio: failed to fetch ${url} (${response.status})`);
        return response.arrayBuffer();
      })
      .then((bytes) => this.context.decodeAudioData(bytes));
    this.decoded.set(url, decoded);
    void decoded.catch(() => this.decoded.delete(url));
    return decoded;
  }
}

class SpatialVoiceImpl implements SpatialVoice {
  readonly ended: Promise<void>;

  private readonly source: AudioBufferSourceNode;
  private readonly gain: GainNode;
  private readonly panner: PannerNode;
  private readonly onFinish: () => void;
  private resolveEnded!: () => void;
  private done = false;

  constructor(
    context: AudioContext,
    output: AudioNode,
    buffer: AudioBuffer,
    position: AudioPoint,
    options: SpatialPlayOptions,
    onFinish: () => void,
  ) {
    this.onFinish = onFinish;
    this.source = context.createBufferSource();
    this.gain = context.createGain();
    this.panner = context.createPanner();
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve;
    });

    const refDistance = Math.max(0.05, options.refDistanceM ?? DEFAULT_REF_DISTANCE_M);
    const maxDistance = Math.max(refDistance, options.maxDistanceM ?? DEFAULT_MAX_DISTANCE_M);
    const minimumGain = Math.min(1, Math.max(0.01, options.minimumGain ?? DEFAULT_MINIMUM_GAIN));
    this.panner.distanceModel = "inverse";
    this.panner.panningModel = "HRTF";
    this.panner.refDistance = refDistance;
    this.panner.maxDistance = maxDistance;
    // Inverse distance reaches exactly the requested non-zero floor at maxDistance.
    this.panner.rolloffFactor =
      maxDistance === refDistance
        ? 0
        : (refDistance * (1 / minimumGain - 1)) / (maxDistance - refDistance);
    this.panner.coneInnerAngle = 360;
    this.panner.coneOuterAngle = 360;
    this.panner.coneOuterGain = 1;
    setPannerPosition(this.panner, position, context.currentTime);

    this.source.buffer = buffer;
    this.source.loop = options.loop ?? false;
    this.source.playbackRate.value = Math.max(0.25, Math.min(4, options.pitch ?? 1));
    this.gain.gain.value = Math.max(0, Math.min(1, options.gain ?? 1));
    this.source.connect(this.gain);
    this.gain.connect(this.panner);
    this.panner.connect(output);
    this.source.addEventListener("ended", () => this.finish(), { once: true });
    this.source.start();
  }

  setPosition(position: AudioPoint): void {
    if (this.done || !finitePoint(position)) return;
    setPannerPosition(this.panner, position, this.source.context.currentTime);
  }

  setGain(gain: number, rampMs = 0): void {
    if (this.done) return;
    const now = this.source.context.currentTime;
    const target = Math.max(0, Math.min(1, gain));
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    if (rampMs > 0) this.gain.gain.linearRampToValueAtTime(target, now + rampMs / 1_000);
    else this.gain.gain.setValueAtTime(target, now);
  }

  stop(fadeMs = 0): void {
    if (this.done) return;
    if (fadeMs > 0) {
      const now = this.source.context.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(this.gain.gain.value, now);
      this.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1_000);
      this.source.stop(now + fadeMs / 1_000);
    } else {
      this.source.stop();
    }
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.source.disconnect();
    this.gain.disconnect();
    this.panner.disconnect();
    this.onFinish();
    this.resolveEnded();
  }
}

let sharedRuntime: SpatialAudioRuntime | null = null;

export function getSpatialAudioRuntime(): SpatialAudioRuntime | null {
  if (sharedRuntime !== null) return sharedRuntime;
  if (globalThis.AudioContext === undefined) return null;
  sharedRuntime = new SpatialAudioRuntime();
  return sharedRuntime;
}

export function disposeSpatialAudioRuntime(): void {
  sharedRuntime?.dispose();
  sharedRuntime = null;
}

/** Convenience facade that resolves bundled SFX and ambience asset paths. */
export class SpatialAudioPlayer {
  private readonly root: string;

  constructor(
    readonly runtime: SpatialAudioRuntime,
    baseUrl: string = import.meta.env.BASE_URL,
  ) {
    this.root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  }

  playAt(
    asset: AudioAsset,
    position: AudioPoint,
    options: SpatialPlayOptions = {},
  ): Promise<SpatialVoice | null> {
    const folder = asset.startsWith("amb_") ? "ambience" : "sfx";
    return this.runtime.playUrl(
      `${this.root}assets/audio/${folder}/${asset}.mp3`,
      position,
      options,
    );
  }
}
