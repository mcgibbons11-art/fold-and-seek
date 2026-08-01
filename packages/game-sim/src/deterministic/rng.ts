/**
 * Seeded deterministic randomness. The match simulation must produce identical
 * results on a dedicated server and on a host-elected client, so every random
 * choice comes from here and never from Math.random.
 */

const MULBERRY_INCREMENT = 0x6d2b79f5;
const UINT32_DIVISOR = 4294967296;

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_DIVISOR;
  };
}

/** FNV-1a, used to fold string ids into a seed without depending on ordering. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function mixSeeds(...parts: number[]): number {
  let mixed = 0x9e3779b9;
  for (const part of parts) {
    mixed = (Math.imul(mixed ^ (part >>> 0), 0x85ebca6b) >>> 0) ^ (mixed >>> 13);
  }
  return mixed >>> 0;
}

export class DeterministicRng {
  /**
   * Position in the stream. It is held here rather than in a closure so a
   * long-lived generator can be snapshotted mid-round and resumed exactly on
   * another host (§27.11 host migration).
   */
  private state: number;

  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** Where the generator currently sits, for serialization. */
  get cursor(): number {
    return this.state;
  }

  /** Rebuilds a generator that has already produced part of its stream. */
  static fromCursor(seed: number, cursor: number): DeterministicRng {
    const rng = new DeterministicRng(seed);
    rng.state = cursor >>> 0;
    return rng;
  }

  /** Uniform in [0, 1). The mulberry32 step, inlined so state stays visible. */
  float(): number {
    this.state = (this.state + MULBERRY_INCREMENT) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_DIVISOR;
  }

  /** Uniform integer in [0, exclusiveMax). */
  int(exclusiveMax: number): number {
    if (!Number.isInteger(exclusiveMax) || exclusiveMax <= 0) {
      throw new Error(`exclusiveMax must be a positive integer, received ${exclusiveMax}`);
    }
    return Math.floor(this.float() * exclusiveMax) % exclusiveMax;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("cannot pick from an empty list");
    }
    return items[this.int(items.length)] as T;
  }

  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const a = result[i] as T;
      const b = result[j] as T;
      result[i] = b;
      result[j] = a;
    }
    return result;
  }

  /** Lowercase base36 token of the requested length. */
  token(length: number): string {
    let out = "";
    while (out.length < length) {
      out += Math.floor(this.float() * UINT32_DIVISOR)
        .toString(36)
        .padStart(7, "0");
    }
    return out.slice(0, length);
  }
}
