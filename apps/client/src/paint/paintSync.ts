import {
  decodePaintLayer,
  encodePaintLayer,
  MAX_PAINT_STROKES,
  type PaintStrokeWire,
} from "@foldseek/shared";

import type { PaintLayer } from "./PaintLayer";

/** A self-contained layer. Receivers use this to join or recover a missed delta. */
export interface PaintCheckpoint {
  readonly kind: "checkpoint";
  readonly revision: number;
  readonly encodedPaint: string;
}

/**
 * A bounded edit around one retained contiguous run from the prior revision.
 * This describes append, undo, front eviction and capped undo in O(changes),
 * while still being able to express an arbitrary replacement deterministically.
 */
export interface PaintDelta {
  readonly kind: "delta";
  readonly baseRevision: number;
  readonly revision: number;
  readonly retainStart: number;
  readonly retainCount: number;
  readonly encodedPrepend: string;
  readonly encodedAppend: string;
}

export type PaintSyncUpdate = PaintCheckpoint | PaintDelta;

export interface PaintRevisionState {
  readonly revision: number;
  readonly strokes: readonly PaintStrokeWire[];
}

export interface PaintSyncPublication {
  readonly update: PaintSyncUpdate;
  /** Compact transport form, suitable for a Portals command body. */
  readonly encoded: string;
}

export interface PaintSnapshotBookkeeperOptions {
  /** A checkpoint bounds recovery time after lost deltas. */
  readonly checkpointInterval?: number;
}

const CHECKPOINT_TAG = "pc1";
const DELTA_TAG = "pd1";

/** Stable text encoding. Paint-layer payloads are base64 and cannot contain `.`. */
export function encodePaintSyncUpdate(update: PaintSyncUpdate): string {
  if (update.kind === "checkpoint") {
    return `${CHECKPOINT_TAG}.${update.revision}.${update.encodedPaint}`;
  }
  return [
    DELTA_TAG,
    update.baseRevision,
    update.revision,
    update.retainStart,
    update.retainCount,
    update.encodedPrepend,
    update.encodedAppend,
  ].join(".");
}

/** Strict decoder: malformed deltas never mutate a receiver's known-good layer. */
export function decodePaintSyncUpdate(payload: string): PaintSyncUpdate | null {
  const fields = payload.split(".");
  if (fields[0] === CHECKPOINT_TAG && fields.length === 3) {
    const revision = natural(fields[1]);
    const encodedPaint = fields[2];
    if (revision === null || encodedPaint === undefined || !decodePaintLayer(encodedPaint).ok) {
      return null;
    }
    return { kind: "checkpoint", revision, encodedPaint };
  }
  if (fields[0] !== DELTA_TAG || fields.length !== 7) return null;
  const baseRevision = natural(fields[1]);
  const revision = natural(fields[2]);
  const retainStart = natural(fields[3]);
  const retainCount = natural(fields[4]);
  const encodedPrepend = fields[5];
  const encodedAppend = fields[6];
  if (
    baseRevision === null ||
    revision === null ||
    revision <= baseRevision ||
    retainStart === null ||
    retainCount === null ||
    encodedPrepend === undefined ||
    encodedAppend === undefined ||
    !decodePaintLayer(encodedPrepend).ok ||
    !decodePaintLayer(encodedAppend).ok
  ) {
    return null;
  }
  return {
    kind: "delta",
    baseRevision,
    revision,
    retainStart,
    retainCount,
    encodedPrepend,
    encodedAppend,
  };
}

/** Applies an update without side effects. Null means "request a checkpoint". */
export function applyPaintSyncUpdate(
  current: PaintRevisionState | null,
  update: PaintSyncUpdate,
): PaintRevisionState | null {
  if (update.kind === "checkpoint") {
    if (current !== null && update.revision < current.revision) return null;
    const decoded = decodePaintLayer(update.encodedPaint);
    if (!decoded.ok) return null;
    return { revision: update.revision, strokes: decoded.layer.strokes };
  }
  if (current === null || current.revision !== update.baseRevision) return null;
  if (
    update.retainStart > current.strokes.length ||
    update.retainStart + update.retainCount > current.strokes.length
  ) {
    return null;
  }
  const prepend = decodePaintLayer(update.encodedPrepend);
  const append = decodePaintLayer(update.encodedAppend);
  if (!prepend.ok || !append.ok) return null;
  const count = prepend.layer.strokes.length + update.retainCount + append.layer.strokes.length;
  if (count > MAX_PAINT_STROKES) return null;
  return {
    revision: update.revision,
    strokes: [
      ...prepend.layer.strokes,
      ...current.strokes.slice(update.retainStart, update.retainStart + update.retainCount),
      ...append.layer.strokes,
    ],
  };
}

/**
 * Publisher-side revision gate. It serializes at most once per layer revision,
 * chooses a delta only when it beats a checkpoint, and periodically emits a
 * checkpoint so one dropped command cannot strand a late peer forever.
 */
export class PaintSnapshotBookkeeper {
  private readonly checkpointInterval: number;
  private revision = -1;
  private strokes: readonly PaintStrokeWire[] = [];
  private deltasSinceCheckpoint = 0;

  constructor(options: PaintSnapshotBookkeeperOptions = {}) {
    this.checkpointInterval = Math.max(1, Math.trunc(options.checkpointInterval ?? 12));
  }

  capture(layer: PaintLayer, forceCheckpoint = false): PaintSyncPublication | null {
    if (layer.revision === this.revision && !forceCheckpoint) return null;

    const current = [...layer.strokeLog];
    const checkpoint: PaintCheckpoint = {
      kind: "checkpoint",
      revision: layer.revision,
      encodedPaint: layer.toDataForWire(),
    };
    const encodedCheckpoint = encodePaintSyncUpdate(checkpoint);
    let publication: PaintSyncPublication = {
      update: checkpoint,
      encoded: encodedCheckpoint,
    };

    if (
      !forceCheckpoint &&
      this.revision >= 0 &&
      this.deltasSinceCheckpoint < this.checkpointInterval
    ) {
      const retained = longestRetainedRun(this.strokes, current);
      const delta: PaintDelta = {
        kind: "delta",
        baseRevision: this.revision,
        revision: layer.revision,
        retainStart: retained.oldStart,
        retainCount: retained.count,
        encodedPrepend: encodePaintLayer(current.slice(0, retained.newStart)),
        encodedAppend: encodePaintLayer(current.slice(retained.newStart + retained.count)),
      };
      const encodedDelta = encodePaintSyncUpdate(delta);
      if (encodedDelta.length < encodedCheckpoint.length) {
        publication = { update: delta, encoded: encodedDelta };
      }
    }

    this.revision = layer.revision;
    this.strokes = current;
    if (publication.update.kind === "checkpoint") this.deltasSinceCheckpoint = 0;
    else this.deltasSinceCheckpoint += 1;
    return publication;
  }

  /** The revision a relay may advertise beside its latest accepted payload. */
  get publishedRevision(): number {
    return this.revision;
  }

  reset(): void {
    this.revision = -1;
    this.strokes = [];
    this.deltasSinceCheckpoint = 0;
  }
}

interface RetainedRun {
  readonly oldStart: number;
  readonly newStart: number;
  readonly count: number;
}

/** Finds the largest unchanged contiguous run without quadratic stamp comparisons. */
function longestRetainedRun(
  before: readonly PaintStrokeWire[],
  after: readonly PaintStrokeWire[],
): RetainedRun {
  const candidates: RetainedRun[] = [];

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && sameStroke(before[prefix], after[prefix])) {
    prefix += 1;
  }
  candidates.push({ oldStart: 0, newStart: 0, count: prefix });

  let suffix = 0;
  while (
    suffix < before.length &&
    suffix < after.length &&
    sameStroke(before[before.length - suffix - 1], after[after.length - suffix - 1])
  ) {
    suffix += 1;
  }
  candidates.push({
    oldStart: before.length - suffix,
    newStart: after.length - suffix,
    count: suffix,
  });

  // The hot capped-log path: old suffix becomes new prefix after front eviction.
  let shiftedForward = Math.min(before.length, after.length);
  while (shiftedForward > 0) {
    const oldStart = before.length - shiftedForward;
    let matches = true;
    for (let index = 0; index < shiftedForward; index++) {
      if (!sameStroke(before[oldStart + index], after[index])) {
        matches = false;
        break;
      }
    }
    if (matches) {
      candidates.push({ oldStart, newStart: 0, count: shiftedForward });
      break;
    }
    shiftedForward -= 1;
  }

  // The inverse hot path: undo at the cap prepends evicted stamps.
  let shiftedBack = Math.min(before.length, after.length);
  while (shiftedBack > 0) {
    const newStart = after.length - shiftedBack;
    let matches = true;
    for (let index = 0; index < shiftedBack; index++) {
      if (!sameStroke(before[index], after[newStart + index])) {
        matches = false;
        break;
      }
    }
    if (matches) {
      candidates.push({ oldStart: 0, newStart, count: shiftedBack });
      break;
    }
    shiftedBack -= 1;
  }

  return candidates.reduce((best, candidate) => candidate.count > best.count ? candidate : best);
}

function sameStroke(a: PaintStrokeWire | undefined, b: PaintStrokeWire | undefined): boolean {
  if (a === b) return a !== undefined;
  return a !== undefined && b !== undefined &&
    a.target === b.target && a.u === b.u && a.v === b.v && a.radius === b.radius &&
    a.color[0] === b.color[0] && a.color[1] === b.color[1] && a.color[2] === b.color[2] &&
    a.opacity === b.opacity && a.metallic === b.metallic && a.smoothness === b.smoothness &&
    a.emissive === b.emissive && a.erase === b.erase && a.continued === b.continued;
}

function natural(value: string | undefined): number | null {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
