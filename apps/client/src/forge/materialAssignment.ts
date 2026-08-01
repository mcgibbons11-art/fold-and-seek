import type { MaterialAssignment } from "../mimic/disguiseState";
import { isPanelSocketName } from "../mimic/panels";
import { isBoneName } from "../mimic/rig";
import { isSwatchLegalForMimic } from "../mimic/visual/materialSwatches";

/**
 * Material slot bookkeeping for the Forge (bible §7.4 Layer 5). A slot is the
 * whole body, one bone, or one panel socket; assignment is a pure list edit so
 * the same function serves the editor, undo, and a server-accepted delta.
 */

export const BODY_SLOT_ID = "body";

export type SlotAssignmentError = "unknown-slot" | "illegal-swatch";

/** Slot ids the Forge is allowed to write. */
export function isAssignableSlot(slotId: string): boolean {
  return slotId === BODY_SLOT_ID || isBoneName(slotId) || isPanelSocketName(slotId);
}

export function assignmentFor(
  materials: readonly MaterialAssignment[],
  slotId: string,
): string | null {
  for (const assignment of materials) {
    if (assignment.slotId === slotId) {
      return assignment.swatchId;
    }
  }
  return null;
}

/**
 * Swatch a slot actually renders with: its own assignment when it has one, the
 * body assignment otherwise.
 */
export function resolvedSwatchFor(
  materials: readonly MaterialAssignment[],
  slotId: string,
  fallback: string,
): string {
  return assignmentFor(materials, slotId) ?? assignmentFor(materials, BODY_SLOT_ID) ?? fallback;
}

/** Returns a new list with `slotId` set to `swatchId`, preserving order. */
export function withAssignment(
  materials: readonly MaterialAssignment[],
  slotId: string,
  swatchId: string,
): MaterialAssignment[] {
  const next = materials.map((assignment) => ({ ...assignment }));
  const existing = next.find((assignment) => assignment.slotId === slotId);
  if (existing !== undefined) {
    existing.swatchId = swatchId;
    return next;
  }
  next.push({ slotId, swatchId });
  return next;
}

/** Returns a new list without `slotId`, so the slot falls back to the body swatch. */
export function withoutAssignment(
  materials: readonly MaterialAssignment[],
  slotId: string,
): MaterialAssignment[] {
  return materials
    .filter((assignment) => assignment.slotId !== slotId)
    .map((assignment) => ({ ...assignment }));
}

/** Rejects an assignment the map does not publish for a body (§7.12). */
export function validateAssignment(slotId: string, swatchId: string): SlotAssignmentError | null {
  if (!isAssignableSlot(slotId)) {
    return "unknown-slot";
  }
  if (!isSwatchLegalForMimic(swatchId)) {
    return "illegal-swatch";
  }
  return null;
}

const MIRRORED_SOCKETS: Readonly<Record<string, string>> = {
  panel_socket_03: "panel_socket_04",
  panel_socket_04: "panel_socket_03",
  panel_socket_05: "panel_socket_06",
  panel_socket_06: "panel_socket_05",
  panel_socket_07: "panel_socket_08",
  panel_socket_08: "panel_socket_07",
};

/**
 * The slot on the other side of the symmetry plane, or null for a slot that
 * sits on it. Limb bones carry an `_L`/`_R` suffix; the sockets are paired by
 * the segment they hang off.
 */
export function mirroredSlotId(slotId: string): string | null {
  const socket = MIRRORED_SOCKETS[slotId];
  if (socket !== undefined) {
    return socket;
  }
  if (slotId.endsWith("_L")) {
    const mirrored = `${slotId.slice(0, -2)}_R`;
    return isBoneName(mirrored) ? mirrored : null;
  }
  if (slotId.endsWith("_R")) {
    const mirrored = `${slotId.slice(0, -2)}_L`;
    return isBoneName(mirrored) ? mirrored : null;
  }
  return null;
}

/** The slots one assignment touches: just the slot, or the mirrored pair. */
export function assignmentSlots(slotId: string, mirror: boolean): string[] {
  if (!mirror) {
    return [slotId];
  }
  const mirrored = mirroredSlotId(slotId);
  return mirrored === null ? [slotId] : [slotId, mirrored];
}
