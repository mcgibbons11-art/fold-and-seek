import { MAX_PANELS, PANEL_SOCKET_NAMES, type PanelSocketName } from "./rig";

/**
 * Deployable mimic panels (bible §7.4 Layer 3, §24.4). Panels are body parts
 * bound to a rig socket, so a panel set is legal only when every socket exists
 * and no socket carries two panels.
 */

export const PANEL_PROFILE_IDS = ["rectangle", "rounded_rect", "triangle"] as const;

export type PanelProfileId = (typeof PANEL_PROFILE_IDS)[number];

/** Panel width and height in metres at normalized 0 and 1. */
export const PANEL_SIZE_MIN_M = 0.06;
export const PANEL_SIZE_MAX_M = 0.9;

/** Telescoping travel in metres at `extension = 1`. */
export const PANEL_MAX_EXTENSION_M = 0.45;

export const PANEL_MIN_HINGE_DEG = -180;
export const PANEL_MAX_HINGE_DEG = 180;

export interface PanelSnapTarget {
  /** `panel` snaps to another deployed panel, `surface` snaps to map geometry. */
  kind: "panel" | "surface";
  /** Socket name for a panel target, or the world object ID for a surface target. */
  targetId: string;
  offset: [number, number, number];
  /** Unit normal the panel face aligns to, in the target's frame. */
  normal: [number, number, number];
}

export interface PanelState {
  socketId: PanelSocketName;
  /** 0 stowed, 1 fully deployed. */
  deployed: number;
  /** Rotation about the socket hinge, in degrees. */
  hingeAngle: number;
  /** 0..1 of `PANEL_MAX_EXTENSION_M` of telescoping travel. */
  extension: number;
  /** 0..1 mapped to `PANEL_SIZE_MIN_M`..`PANEL_SIZE_MAX_M`. */
  width: number;
  /** 0..1 mapped to `PANEL_SIZE_MIN_M`..`PANEL_SIZE_MAX_M`. */
  height: number;
  profileId: PanelProfileId;
  snapTarget?: PanelSnapTarget;
  materialSlotId: string;
}

export interface ResolvedPanel {
  widthM: number;
  heightM: number;
  extensionM: number;
  hingeRad: number;
  deployed: number;
  profileId: PanelProfileId;
}

const socketNames: ReadonlySet<string> = new Set<string>(PANEL_SOCKET_NAMES);

export function isPanelSocketName(value: string): value is PanelSocketName {
  return socketNames.has(value);
}

export function isPanelProfileId(value: string): value is PanelProfileId {
  return (PANEL_PROFILE_IDS as readonly string[]).includes(value);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function sanitize(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function createDefaultPanelState(socketId: PanelSocketName): PanelState {
  return {
    socketId,
    deployed: 0,
    hingeAngle: 0,
    extension: 0,
    width: 0.35,
    height: 0.35,
    profileId: "rounded_rect",
    materialSlotId: "body",
  };
}

export function clonePanelState(panel: PanelState): PanelState {
  const copy: PanelState = {
    socketId: panel.socketId,
    deployed: panel.deployed,
    hingeAngle: panel.hingeAngle,
    extension: panel.extension,
    width: panel.width,
    height: panel.height,
    profileId: panel.profileId,
    materialSlotId: panel.materialSlotId,
  };
  if (panel.snapTarget !== undefined) {
    copy.snapTarget = {
      kind: panel.snapTarget.kind,
      targetId: panel.snapTarget.targetId,
      offset: [...panel.snapTarget.offset],
      normal: [...panel.snapTarget.normal],
    };
  }
  return copy;
}

/** Forces a panel into its legal ranges in place. */
export function clampPanelState(panel: PanelState): PanelState {
  panel.deployed = clamp(sanitize(panel.deployed, 0), 0, 1);
  panel.hingeAngle = clamp(sanitize(panel.hingeAngle, 0), PANEL_MIN_HINGE_DEG, PANEL_MAX_HINGE_DEG);
  panel.extension = clamp(sanitize(panel.extension, 0), 0, 1);
  panel.width = clamp(sanitize(panel.width, 0.35), 0, 1);
  panel.height = clamp(sanitize(panel.height, 0.35), 0, 1);
  if (!isPanelProfileId(panel.profileId)) {
    panel.profileId = "rounded_rect";
  }
  if (panel.snapTarget !== undefined && panel.snapTarget.targetId === panel.socketId) {
    delete panel.snapTarget;
  }
  return panel;
}

export function resolvePanel(panel: PanelState, out: ResolvedPanel): ResolvedPanel {
  const sizeSpan = PANEL_SIZE_MAX_M - PANEL_SIZE_MIN_M;
  out.widthM = PANEL_SIZE_MIN_M + clamp(sanitize(panel.width, 0.35), 0, 1) * sizeSpan;
  out.heightM = PANEL_SIZE_MIN_M + clamp(sanitize(panel.height, 0.35), 0, 1) * sizeSpan;
  out.extensionM = clamp(sanitize(panel.extension, 0), 0, 1) * PANEL_MAX_EXTENSION_M;
  out.hingeRad =
    clamp(sanitize(panel.hingeAngle, 0), PANEL_MIN_HINGE_DEG, PANEL_MAX_HINGE_DEG) *
    (Math.PI / 180);
  out.deployed = clamp(sanitize(panel.deployed, 0), 0, 1);
  out.profileId = isPanelProfileId(panel.profileId) ? panel.profileId : "rounded_rect";
  return out;
}

export function createResolvedPanel(): ResolvedPanel {
  return {
    widthM: PANEL_SIZE_MIN_M,
    heightM: PANEL_SIZE_MIN_M,
    extensionM: 0,
    hingeRad: 0,
    deployed: 0,
    profileId: "rounded_rect",
  };
}

/** Reasons a panel set would be rejected, empty when the set is legal. */
export function validatePanels(panels: readonly PanelState[]): string[] {
  const errors: string[] = [];
  if (panels.length > MAX_PANELS) {
    errors.push(`panel count ${panels.length} exceeds the ${MAX_PANELS} socket limit`);
  }

  const used = new Set<string>();
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i]!;
    const where = `panels[${i}]`;
    if (!isPanelSocketName(panel.socketId)) {
      errors.push(`${where} references unknown socket "${panel.socketId}"`);
    } else if (used.has(panel.socketId)) {
      errors.push(`${where} reuses socket "${panel.socketId}"`);
    } else {
      used.add(panel.socketId);
    }

    if (!Number.isFinite(panel.deployed) || panel.deployed < 0 || panel.deployed > 1) {
      errors.push(`${where}.deployed out of range`);
    }
    if (
      !Number.isFinite(panel.hingeAngle) ||
      panel.hingeAngle < PANEL_MIN_HINGE_DEG ||
      panel.hingeAngle > PANEL_MAX_HINGE_DEG
    ) {
      errors.push(`${where}.hingeAngle out of range`);
    }
    if (!Number.isFinite(panel.extension) || panel.extension < 0 || panel.extension > 1) {
      errors.push(`${where}.extension out of range`);
    }
    if (!Number.isFinite(panel.width) || panel.width < 0 || panel.width > 1) {
      errors.push(`${where}.width out of range`);
    }
    if (!Number.isFinite(panel.height) || panel.height < 0 || panel.height > 1) {
      errors.push(`${where}.height out of range`);
    }
    if (!isPanelProfileId(panel.profileId)) {
      errors.push(`${where} has unknown profile "${panel.profileId}"`);
    }
    if (panel.materialSlotId.length === 0) {
      errors.push(`${where}.materialSlotId is empty`);
    }

    const snap = panel.snapTarget;
    if (snap !== undefined) {
      if (snap.targetId === panel.socketId) {
        errors.push(`${where} snaps to itself`);
      }
      if (snap.kind === "panel" && !isPanelSocketName(snap.targetId)) {
        errors.push(`${where} snaps to unknown panel socket "${snap.targetId}"`);
      }
      if (snap.offset.some((value) => !Number.isFinite(value))) {
        errors.push(`${where}.snapTarget.offset is not finite`);
      }
      const normalLengthSq =
        snap.normal[0] * snap.normal[0] +
        snap.normal[1] * snap.normal[1] +
        snap.normal[2] * snap.normal[2];
      if (!Number.isFinite(normalLengthSq) || normalLengthSq < 1e-6) {
        errors.push(`${where}.snapTarget.normal is degenerate`);
      }
    }
  }

  return errors;
}
