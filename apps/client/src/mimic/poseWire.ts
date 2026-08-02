import {
  DISGUISE_WIRE_VERSION,
  RIG_CONTRACT_VERSION,
  decodeDisguiseWire,
  encodeDisguiseWire,
  type DisguiseWire,
} from "@foldseek/shared";

import { cloneSegmentForm } from "./segmentForm";
import { clonePanelState } from "./panels";
import type { DisguiseState } from "./disguiseState";

/**
 * The bridge between the Forge's authoring state and the canonical wire form
 * every authority validates (§7.16). The two carry the same fields in the same
 * order, so this is a re-labelling rather than a transform: what it adds is the
 * version literals the schema insists on and a decode that hands the room's
 * disguises back as something the rig can pose.
 *
 * Nothing here judges a pose. `decodeDisguiseWire` owns the size cap, the parse
 * and the legality check, and this module reports its verdict unchanged.
 */

export function toDisguiseWire(state: DisguiseState): DisguiseWire {
  return {
    version: DISGUISE_WIRE_VERSION,
    rigVersion: RIG_CONTRACT_VERSION,
    mapId: state.mapId,
    mapVersion: state.mapVersion,
    root: { position: [...state.root.position], rotation: [...state.root.rotation] },
    joints: state.joints.map((joint) => ({ bone: joint.bone, rotation: [...joint.rotation] })),
    segments: state.segments.map((segment) => ({
      bone: segment.bone,
      form: cloneSegmentForm(segment.form),
    })),
    panels: state.panels.map(clonePanelState),
    anchors: state.anchors.map((anchor) => ({
      id: anchor.id,
      bone: anchor.bone,
      objectId: anchor.objectId,
      uv: [...anchor.uv],
      normalOffset: anchor.normalOffset,
      localRotation: [...anchor.localRotation],
      positionToleranceM: anchor.positionToleranceM,
      angularToleranceDeg: anchor.angularToleranceDeg,
    })),
    materials: state.materials.map((material) => ({
      slotId: material.slotId,
      swatchId: material.swatchId,
    })),
    revision: state.revision,
  };
}

export function fromDisguiseWire(pose: DisguiseWire): DisguiseState {
  return {
    version: pose.version,
    rigVersion: pose.rigVersion,
    mapId: pose.mapId,
    mapVersion: pose.mapVersion,
    root: { position: [...pose.root.position], rotation: [...pose.root.rotation] },
    joints: pose.joints.map((joint) => ({ bone: joint.bone, rotation: [...joint.rotation] })),
    segments: pose.segments.map((segment) => ({
      bone: segment.bone,
      form: cloneSegmentForm(segment.form),
    })),
    panels: pose.panels.map(clonePanelState),
    anchors: pose.anchors.map((anchor) => ({
      id: anchor.id,
      bone: anchor.bone,
      objectId: anchor.objectId,
      uv: [...anchor.uv],
      normalOffset: anchor.normalOffset,
      localRotation: [...anchor.localRotation],
      positionToleranceM: anchor.positionToleranceM,
      angularToleranceDeg: anchor.angularToleranceDeg,
    })),
    materials: pose.materials.map((material) => ({
      slotId: material.slotId,
      swatchId: material.swatchId,
    })),
    revision: pose.revision,
  };
}

export function encodeDisguiseState(state: DisguiseState): string {
  return encodeDisguiseWire(toDisguiseWire(state));
}

/** The room's view of somebody else's disguise, or null when it is not legal. */
export function decodeDisguiseState(payload: string): DisguiseState | null {
  const decoded = decodeDisguiseWire(payload);
  return decoded.ok ? fromDisguiseWire(decoded.pose) : null;
}
