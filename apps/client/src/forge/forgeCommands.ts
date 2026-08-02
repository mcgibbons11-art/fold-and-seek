import type { PaintStrokeWire } from "@foldseek/shared";

import type { AnchorState, DisguiseState, MaterialAssignment } from "../mimic/disguiseState";
import type { PaintStrokeBatch } from "../paint/PaintLayer";
import { clonePanelState, type PanelState } from "../mimic/panels";
import { SEGMENT_BONES } from "../mimic/rig";
import { cloneSegmentForm, type SegmentFormState } from "../mimic/segmentForm";

/**
 * Forge undo/redo (bible §7.14). Every edit is a command that owns the value
 * before it and the value after it, so both directions are an absolute write
 * rather than an inverse operation. That keeps a redo after a partially applied
 * drag from drifting away from what the player saw.
 *
 * Commands mutate `DisguiseState` only. The live pose and the renderable Mimic
 * are rebuilt from the state afterwards, which is also what a server-accepted
 * delta will do.
 */

export interface ForgeCommand {
  readonly id: string;
  readonly issuedAt: number;
  /** Shown in the Forge HUD next to the undo control. */
  readonly label: string;
  apply(state: DisguiseState): void;
  revert(state: DisguiseState): void;
}

/** §7.14 asks for at least 64 local commands. */
export const FORGE_UNDO_CAPACITY = 96;

export interface PoseSnapshot {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  /** Local rotations in `BONE_NAMES` order. */
  readonly joints: readonly (readonly [number, number, number, number])[];
}

export function capturePoseSnapshot(state: DisguiseState): PoseSnapshot {
  return {
    position: [state.root.position[0], state.root.position[1], state.root.position[2]],
    rotation: [
      state.root.rotation[0],
      state.root.rotation[1],
      state.root.rotation[2],
      state.root.rotation[3],
    ],
    joints: state.joints.map(
      (joint) =>
        [joint.rotation[0], joint.rotation[1], joint.rotation[2], joint.rotation[3]] as const,
    ),
  };
}

export function restorePoseSnapshot(state: DisguiseState, snapshot: PoseSnapshot): void {
  state.root.position = [snapshot.position[0], snapshot.position[1], snapshot.position[2]];
  state.root.rotation = [
    snapshot.rotation[0],
    snapshot.rotation[1],
    snapshot.rotation[2],
    snapshot.rotation[3],
  ];
  for (let i = 0; i < state.joints.length; i++) {
    const source = snapshot.joints[i];
    const joint = state.joints[i];
    if (source === undefined || joint === undefined) continue;
    joint.rotation = [source[0], source[1], source[2], source[3]];
  }
}

/** True when two snapshots describe the same pose to within `epsilon`. */
export function poseSnapshotsEqual(a: PoseSnapshot, b: PoseSnapshot, epsilon = 1e-6): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs((a.position[i] ?? 0) - (b.position[i] ?? 0)) > epsilon) return false;
  }
  for (let i = 0; i < 4; i++) {
    if (Math.abs((a.rotation[i] ?? 0) - (b.rotation[i] ?? 0)) > epsilon) return false;
  }
  if (a.joints.length !== b.joints.length) return false;
  for (let j = 0; j < a.joints.length; j++) {
    const left = a.joints[j];
    const right = b.joints[j];
    if (left === undefined || right === undefined) return false;
    for (let i = 0; i < 4; i++) {
      if (Math.abs((left[i] ?? 0) - (right[i] ?? 0)) > epsilon) return false;
    }
  }
  return true;
}

let commandSerial = 0;

function nextCommandId(kind: string): string {
  commandSerial += 1;
  return `${kind}:${commandSerial}`;
}

export function createPoseCommand(
  before: PoseSnapshot,
  after: PoseSnapshot,
  issuedAt: number,
  label = "pose",
): ForgeCommand {
  return {
    id: nextCommandId("pose"),
    issuedAt,
    label,
    apply: (state) => {
      restorePoseSnapshot(state, after);
    },
    revert: (state) => {
      restorePoseSnapshot(state, before);
    },
  };
}

function writeSegmentForm(state: DisguiseState, slot: number, form: SegmentFormState): void {
  const segment = state.segments[slot];
  if (segment === undefined) {
    throw new Error(`Forge command targets segment slot ${slot}, which the rig does not have`);
  }
  segment.form = cloneSegmentForm(form);
}

export function createSegmentFormCommand(
  slot: number,
  before: SegmentFormState,
  after: SegmentFormState,
  issuedAt: number,
): ForgeCommand {
  const beforeCopy = cloneSegmentForm(before);
  const afterCopy = cloneSegmentForm(after);
  const bone = SEGMENT_BONES[slot] ?? `segment ${slot}`;
  return {
    id: nextCommandId("form"),
    issuedAt,
    label: `shape ${bone}`,
    apply: (state) => {
      writeSegmentForm(state, slot, afterCopy);
    },
    revert: (state) => {
      writeSegmentForm(state, slot, beforeCopy);
    },
  };
}

function writePanel(state: DisguiseState, socketId: string, panel: PanelState | null): void {
  const index = state.panels.findIndex((entry) => entry.socketId === socketId);
  if (panel === null) {
    if (index >= 0) {
      state.panels.splice(index, 1);
    }
    return;
  }
  const copy = clonePanelState(panel);
  if (index >= 0) {
    state.panels[index] = copy;
  } else {
    state.panels.push(copy);
  }
}

/** A null before or after adds or removes the panel on that socket. */
export function createPanelCommand(
  socketId: string,
  before: PanelState | null,
  after: PanelState | null,
  issuedAt: number,
): ForgeCommand {
  const beforeCopy = before === null ? null : clonePanelState(before);
  const afterCopy = after === null ? null : clonePanelState(after);
  const verb = before === null ? "deploy" : after === null ? "stow" : "adjust";
  return {
    id: nextCommandId("panel"),
    issuedAt,
    label: `${verb} ${socketId}`,
    apply: (state) => {
      writePanel(state, socketId, afterCopy);
    },
    revert: (state) => {
      writePanel(state, socketId, beforeCopy);
    },
  };
}

function writeMaterial(state: DisguiseState, slotId: string, swatchId: string | null): void {
  const index = state.materials.findIndex((entry) => entry.slotId === slotId);
  if (swatchId === null) {
    if (index >= 0) {
      state.materials.splice(index, 1);
    }
    return;
  }
  const assignment: MaterialAssignment = { slotId, swatchId };
  if (index >= 0) {
    state.materials[index] = assignment;
  } else {
    state.materials.push(assignment);
  }
}

export function createMaterialCommand(
  slots: readonly string[],
  before: readonly (string | null)[],
  after: string | null,
  issuedAt: number,
): ForgeCommand {
  const slotList = [...slots];
  const beforeList = [...before];
  return {
    id: nextCommandId("material"),
    issuedAt,
    label: slotList.length > 1 ? `material on ${slotList.length} slots` : `material on ${slotList[0] ?? "body"}`,
    apply: (state) => {
      for (const slot of slotList) {
        writeMaterial(state, slot, after);
      }
    },
    revert: (state) => {
      for (let i = 0; i < slotList.length; i++) {
        writeMaterial(state, slotList[i] ?? "", beforeList[i] ?? null);
      }
    },
  };
}

function writeAnchor(state: DisguiseState, bone: string, anchor: AnchorState | null): void {
  const index = state.anchors.findIndex((entry) => entry.bone === bone);
  if (anchor === null) {
    if (index >= 0) {
      state.anchors.splice(index, 1);
    }
    return;
  }
  const copy: AnchorState = { ...anchor, uv: [...anchor.uv], localRotation: [...anchor.localRotation] };
  if (index >= 0) {
    state.anchors[index] = copy;
  } else {
    state.anchors.push(copy);
  }
}

/**
 * Seals or releases the surface anchor on one contact point (§7.4 Layer 4). A
 * contact point holds at most one anchor, so the bone is the key.
 */
export function createAnchorCommand(
  bone: string,
  before: AnchorState | null,
  after: AnchorState | null,
  issuedAt: number,
): ForgeCommand {
  const beforeCopy = before === null ? null : { ...before };
  const afterCopy = after === null ? null : { ...after };
  return {
    id: nextCommandId("anchor"),
    issuedAt,
    label: after === null ? `release ${bone}` : `anchor ${bone}`,
    apply: (state) => {
      writeAnchor(state, bone, afterCopy);
    },
    revert: (state) => {
      writeAnchor(state, bone, beforeCopy);
    },
  };
}

/**
 * Body paint in the same history as the pose (§7.14, CLAUDE.md override 3).
 *
 * Paint is the one edit that does not live in `DisguiseState`: the strokes are
 * in the PaintLayer, which owns the atlas they rasterize into. The command
 * therefore ignores the state it is handed and drives the layer through the
 * seams the paint tool exposes. Everything else about it is ordinary, which is
 * the point: Ctrl+Z after a brush stroke has to take back the brush stroke, not
 * whatever the player did with the handles before it.
 */
export interface PaintHistoryTarget {
  reapplyBatch(batch: PaintStrokeBatch): void;
  revertBatch(batch: PaintStrokeBatch): void;
  restoreLog(strokes: readonly PaintStrokeWire[]): void;
  clearPaint(): void;
}

/** One drag: however many stamps it laid down, it is one entry. */
export function createPaintStrokeCommand(
  paint: PaintHistoryTarget,
  batch: PaintStrokeBatch,
  issuedAt: number,
): ForgeCommand {
  return {
    id: nextCommandId("paint"),
    issuedAt,
    label: "paint stroke",
    apply: () => {
      paint.reapplyBatch(batch);
    },
    revert: () => {
      paint.revertBatch(batch);
    },
  };
}

/** Clearing the paint, which is the one gesture that can throw away a lot of it. */
export function createPaintClearCommand(
  paint: PaintHistoryTarget,
  cleared: readonly PaintStrokeWire[],
  issuedAt: number,
): ForgeCommand {
  const before = [...cleared];
  return {
    id: nextCommandId("paint"),
    issuedAt,
    label: "clear paint",
    apply: () => {
      paint.clearPaint();
    },
    revert: () => {
      paint.restoreLog(before);
    },
  };
}

/**
 * Groups commands so one gesture is one undo. A mirrored edit writes two
 * segments; the player made a single move and expects a single undo to take it
 * back. Reverting runs in reverse order so overlapping writes unwind cleanly.
 */
export function createCompositeCommand(
  label: string,
  parts: readonly ForgeCommand[],
  issuedAt: number,
): ForgeCommand {
  const ordered = [...parts];
  return {
    id: nextCommandId("group"),
    issuedAt,
    label,
    apply: (state) => {
      for (const part of ordered) {
        part.apply(state);
      }
    },
    revert: (state) => {
      for (let i = ordered.length - 1; i >= 0; i--) {
        ordered[i]?.revert(state);
      }
    },
  };
}

/** Replaces the whole disguise, used by the starter arrangements (§7.15). */
export function createReplaceCommand(
  before: DisguiseState,
  after: DisguiseState,
  issuedAt: number,
  label: string,
): ForgeCommand {
  const beforeCopy = structuredCloneState(before);
  const afterCopy = structuredCloneState(after);
  return {
    id: nextCommandId("replace"),
    issuedAt,
    label,
    apply: (state) => {
      overwriteState(state, afterCopy);
    },
    revert: (state) => {
      overwriteState(state, beforeCopy);
    },
  };
}

function structuredCloneState(state: DisguiseState): DisguiseState {
  return {
    ...state,
    root: { position: [...state.root.position], rotation: [...state.root.rotation] },
    joints: state.joints.map((joint) => ({ bone: joint.bone, rotation: [...joint.rotation] })),
    segments: state.segments.map((segment) => ({
      bone: segment.bone,
      form: cloneSegmentForm(segment.form),
    })),
    panels: state.panels.map(clonePanelState),
    anchors: state.anchors.map((anchor) => ({ ...anchor, uv: [...anchor.uv], localRotation: [...anchor.localRotation] })),
    materials: state.materials.map((material) => ({ ...material })),
  };
}

function overwriteState(target: DisguiseState, source: DisguiseState): void {
  const copy = structuredCloneState(source);
  target.root = copy.root;
  target.joints = copy.joints;
  target.segments = copy.segments;
  target.panels = copy.panels;
  target.anchors = copy.anchors;
  target.materials = copy.materials;
}

/**
 * Bounded undo history. Pushing after an undo discards the redo tail, which is
 * the behaviour every editor shares and the one players expect.
 */
export class ForgeCommandStack {
  private readonly commands: ForgeCommand[] = [];
  private cursor = 0;

  constructor(private readonly capacity: number = FORGE_UNDO_CAPACITY) {
    if (capacity < 1) {
      throw new Error("Forge undo capacity must be at least one command");
    }
  }

  /** Applies `command` to `state` and records it. */
  push(command: ForgeCommand, state: DisguiseState): void {
    command.apply(state);
    this.pushApplied(command, state);
  }

  /**
   * Records a command whose effect the player has already produced. A brush
   * paints as the pointer moves, so the drag is on the body before the history
   * hears about it and applying the command again would paint it twice.
   */
  pushApplied(command: ForgeCommand, state: DisguiseState): void {
    state.revision += 1;
    this.commands.length = this.cursor;
    this.commands.push(command);
    if (this.commands.length > this.capacity) {
      this.commands.shift();
    }
    this.cursor = this.commands.length;
  }

  undo(state: DisguiseState): ForgeCommand | null {
    if (this.cursor === 0) {
      return null;
    }
    this.cursor -= 1;
    const command = this.commands[this.cursor];
    if (command === undefined) {
      return null;
    }
    command.revert(state);
    state.revision += 1;
    return command;
  }

  redo(state: DisguiseState): ForgeCommand | null {
    const command = this.commands[this.cursor];
    if (command === undefined) {
      return null;
    }
    this.cursor += 1;
    command.apply(state);
    state.revision += 1;
    return command;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.commands.length;
  }

  get undoDepth(): number {
    return this.cursor;
  }

  get redoDepth(): number {
    return this.commands.length - this.cursor;
  }

  /** Label of the command an undo would revert, for the HUD. */
  get nextUndoLabel(): string | null {
    return this.cursor > 0 ? this.commands[this.cursor - 1]?.label ?? null : null;
  }

  clear(): void {
    this.commands.length = 0;
    this.cursor = 0;
  }
}
