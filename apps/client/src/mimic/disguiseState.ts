import { Euler, Quaternion } from "three";

import {
  BONE_NAMES,
  boneIndex,
  boneRotationViolation,
  DEG_TO_RAD,
  isBoneName,
  RIG_VERSION,
  SEGMENT_BONES,
  type BoneName,
  type SegmentBoneName,
  type Vector3Tuple,
} from "./rig";
import {
  clonePanelState,
  isPanelProfileId,
  isPanelSocketName,
  validatePanels,
  type PanelState,
} from "./panels";
import {
  cloneSegmentForm,
  createDefaultSegmentForm,
  isSegmentProfileId,
  isValidSegmentForm,
  normalizedFromScale,
  segmentRange,
  type SegmentFormState,
  type SegmentProfileId,
} from "./segmentForm";
import { refreshRigMetrics, updateWorldTransforms, type PoseState } from "./ikSolver";

/**
 * Authoring-side disguise state (bible §29.2) with plain-object serialization
 * and the starter arrangements of §7.15. This is the unquantized source of
 * truth; network and replay use the quantized form described in §7.18.
 */

export const DISGUISE_STATE_VERSION = 1;

export type QuaternionTuple = readonly [number, number, number, number];

export interface TransformState {
  position: [number, number, number];
  rotation: [number, number, number, number];
}

export interface JointState {
  bone: BoneName;
  rotation: [number, number, number, number];
}

export interface SegmentSlotState {
  bone: SegmentBoneName;
  form: SegmentFormState;
}

export interface AnchorState {
  id: string;
  /** Body contact point that is anchored. */
  bone: BoneName;
  /** World object the anchor references. */
  objectId: string;
  /** Surface-local coordinate on that object (§24.6). */
  uv: [number, number];
  normalOffset: number;
  localRotation: [number, number, number, number];
  positionToleranceM: number;
  angularToleranceDeg: number;
}

export interface MaterialAssignment {
  /** `body`, a bone name, or a panel socket name. */
  slotId: string;
  swatchId: string;
}

export interface DisguiseState {
  version: number;
  rigVersion: number;
  mapId: string;
  mapVersion: number;
  root: TransformState;
  joints: JointState[];
  segments: SegmentSlotState[];
  panels: PanelState[];
  anchors: AnchorState[];
  materials: MaterialAssignment[];
  revision: number;
}

export const DEFAULT_BODY_SWATCH_ID = "mimic_porcelain";

/** Largest deviation from unit length tolerated in a serialized quaternion. */
const QUATERNION_TOLERANCE = 1e-3;

/** Largest joint-limit overshoot tolerated before a pose is rejected, in radians. */
const JOINT_LIMIT_TOLERANCE = 1e-3;

export function createDefaultDisguiseState(): DisguiseState {
  return {
    version: DISGUISE_STATE_VERSION,
    rigVersion: RIG_VERSION,
    mapId: "",
    mapVersion: 0,
    root: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    joints: BONE_NAMES.map((bone) => ({
      bone,
      rotation: [0, 0, 0, 1] as [number, number, number, number],
    })),
    segments: SEGMENT_BONES.map((bone) => ({ bone, form: createDefaultSegmentForm(bone) })),
    panels: [],
    anchors: [],
    materials: [{ slotId: "body", swatchId: DEFAULT_BODY_SWATCH_ID }],
    revision: 0,
  };
}

export function cloneDisguiseState(state: DisguiseState): DisguiseState {
  return {
    version: state.version,
    rigVersion: state.rigVersion,
    mapId: state.mapId,
    mapVersion: state.mapVersion,
    root: {
      position: [...state.root.position],
      rotation: [...state.root.rotation],
    },
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

// --- Validation -------------------------------------------------------------

function isFiniteTuple(values: readonly number[], expectedLength: number): boolean {
  return values.length === expectedLength && values.every((value) => Number.isFinite(value));
}

function isUnitQuaternionTuple(values: readonly number[]): boolean {
  if (!isFiniteTuple(values, 4)) return false;
  const lengthSq =
    values[0]! * values[0]! +
    values[1]! * values[1]! +
    values[2]! * values[2]! +
    values[3]! * values[3]!;
  return Math.abs(Math.sqrt(lengthSq) - 1) <= QUATERNION_TOLERANCE;
}

const validationQuaternion = new Quaternion();

/**
 * Structural and legality check (bible §7.16). Returns every problem found so
 * the player can be told what is wrong, rather than failing on the first one.
 */
export function validateDisguiseState(state: DisguiseState): string[] {
  const errors: string[] = [];

  if (state.version !== DISGUISE_STATE_VERSION) {
    errors.push(`unsupported disguise version ${state.version}`);
  }
  if (state.rigVersion !== RIG_VERSION) {
    errors.push(`unsupported rig version ${state.rigVersion}`);
  }
  if (!Number.isFinite(state.mapVersion) || !Number.isInteger(state.revision)) {
    errors.push("mapVersion or revision is not a valid number");
  }

  if (!isFiniteTuple(state.root.position, 3)) {
    errors.push("root.position is not finite");
  }
  if (!isUnitQuaternionTuple(state.root.rotation)) {
    errors.push("root.rotation is not a unit quaternion");
  }

  if (state.joints.length !== BONE_NAMES.length) {
    errors.push(`expected ${BONE_NAMES.length} joints, found ${state.joints.length}`);
  }
  for (let i = 0; i < state.joints.length; i++) {
    const joint = state.joints[i]!;
    if (joint.bone !== BONE_NAMES[i]) {
      errors.push(`joints[${i}] is "${joint.bone}", expected "${BONE_NAMES[i]}"`);
      continue;
    }
    if (!isUnitQuaternionTuple(joint.rotation)) {
      errors.push(`joints[${i}] (${joint.bone}) is not a unit quaternion`);
      continue;
    }
    validationQuaternion.set(
      joint.rotation[0],
      joint.rotation[1],
      joint.rotation[2],
      joint.rotation[3],
    );
    const violation = boneRotationViolation(i, validationQuaternion);
    if (violation > JOINT_LIMIT_TOLERANCE) {
      errors.push(
        `joints[${i}] (${joint.bone}) exceeds its limit by ${(violation / DEG_TO_RAD).toFixed(2)} degrees`,
      );
    }
  }

  if (state.segments.length !== SEGMENT_BONES.length) {
    errors.push(`expected ${SEGMENT_BONES.length} segments, found ${state.segments.length}`);
  }
  for (let i = 0; i < state.segments.length; i++) {
    const segment = state.segments[i]!;
    if (segment.bone !== SEGMENT_BONES[i]) {
      errors.push(`segments[${i}] is "${segment.bone}", expected "${SEGMENT_BONES[i]}"`);
      continue;
    }
    if (!isValidSegmentForm(segment.form)) {
      errors.push(`segments[${i}] (${segment.bone}) has out-of-range form parameters`);
    }
  }

  errors.push(...validatePanels(state.panels));

  for (let i = 0; i < state.anchors.length; i++) {
    const anchor = state.anchors[i]!;
    if (!isBoneName(anchor.bone)) {
      errors.push(`anchors[${i}] references unknown bone "${anchor.bone}"`);
    }
    if (anchor.objectId.length === 0) {
      errors.push(`anchors[${i}].objectId is empty`);
    }
    if (!isFiniteTuple(anchor.uv, 2)) {
      errors.push(`anchors[${i}].uv is not finite`);
    }
    if (!Number.isFinite(anchor.normalOffset)) {
      errors.push(`anchors[${i}].normalOffset is not finite`);
    }
    if (!isUnitQuaternionTuple(anchor.localRotation)) {
      errors.push(`anchors[${i}].localRotation is not a unit quaternion`);
    }
    if (!(anchor.positionToleranceM >= 0) || !(anchor.angularToleranceDeg >= 0)) {
      errors.push(`anchors[${i}] has a negative or non-finite tolerance`);
    }
  }

  for (let i = 0; i < state.materials.length; i++) {
    const material = state.materials[i]!;
    if (material.slotId.length === 0 || material.swatchId.length === 0) {
      errors.push(`materials[${i}] has an empty slot or swatch id`);
    }
  }

  return errors;
}

// --- Serialization ----------------------------------------------------------

export class DisguiseStateError extends Error {}

function fail(path: string, expectation: string): never {
  throw new DisguiseStateError(`${path}: expected ${expectation}`);
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "an object");
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(path, "an array");
  }
  return value;
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "a finite number");
  }
  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail(path, "a string");
  }
  return value;
}

function readNumberTuple(value: unknown, path: string, length: number): number[] {
  const array = readArray(value, path);
  if (array.length !== length) {
    fail(path, `${length} numbers`);
  }
  return array.map((entry, i) => readNumber(entry, `${path}[${i}]`));
}

function readVec3(value: unknown, path: string): [number, number, number] {
  const values = readNumberTuple(value, path, 3);
  return [values[0]!, values[1]!, values[2]!];
}

function readQuaternion(value: unknown, path: string): [number, number, number, number] {
  const values = readNumberTuple(value, path, 4);
  const tuple: [number, number, number, number] = [
    values[0]!,
    values[1]!,
    values[2]!,
    values[3]!,
  ];
  if (!isUnitQuaternionTuple(tuple)) {
    fail(path, "a unit quaternion");
  }
  return tuple;
}

function readSegmentForm(value: unknown, path: string): SegmentFormState {
  const record = readRecord(value, path);
  const profileId = readString(record["profileId"], `${path}.profileId`);
  if (!isSegmentProfileId(profileId)) {
    fail(`${path}.profileId`, "a known segment profile");
  }
  return {
    length: readNumber(record["length"], `${path}.length`),
    width: readNumber(record["width"], `${path}.width`),
    depth: readNumber(record["depth"], `${path}.depth`),
    flatten: readNumber(record["flatten"], `${path}.flatten`),
    taper: readNumber(record["taper"], `${path}.taper`),
    roundness: readNumber(record["roundness"], `${path}.roundness`),
    twist: readNumber(record["twist"], `${path}.twist`),
    profileId,
  };
}

function readPanel(value: unknown, path: string): PanelState {
  const record = readRecord(value, path);
  const socketId = readString(record["socketId"], `${path}.socketId`);
  if (!isPanelSocketName(socketId)) {
    fail(`${path}.socketId`, "a known panel socket");
  }
  const profileId = readString(record["profileId"], `${path}.profileId`);
  if (!isPanelProfileId(profileId)) {
    fail(`${path}.profileId`, "a known panel profile");
  }
  const panel: PanelState = {
    socketId,
    deployed: readNumber(record["deployed"], `${path}.deployed`),
    hingeAngle: readNumber(record["hingeAngle"], `${path}.hingeAngle`),
    extension: readNumber(record["extension"], `${path}.extension`),
    width: readNumber(record["width"], `${path}.width`),
    height: readNumber(record["height"], `${path}.height`),
    profileId,
    materialSlotId: readString(record["materialSlotId"], `${path}.materialSlotId`),
  };
  const snap = record["snapTarget"];
  if (snap !== undefined && snap !== null) {
    const snapRecord = readRecord(snap, `${path}.snapTarget`);
    const kind = readString(snapRecord["kind"], `${path}.snapTarget.kind`);
    if (kind !== "panel" && kind !== "surface") {
      fail(`${path}.snapTarget.kind`, '"panel" or "surface"');
    }
    panel.snapTarget = {
      kind,
      targetId: readString(snapRecord["targetId"], `${path}.snapTarget.targetId`),
      offset: readVec3(snapRecord["offset"], `${path}.snapTarget.offset`),
      normal: readVec3(snapRecord["normal"], `${path}.snapTarget.normal`),
    };
  }
  return panel;
}

function readAnchor(value: unknown, path: string): AnchorState {
  const record = readRecord(value, path);
  const bone = readString(record["bone"], `${path}.bone`);
  if (!isBoneName(bone)) {
    fail(`${path}.bone`, "a known bone");
  }
  const uv = readNumberTuple(record["uv"], `${path}.uv`, 2);
  return {
    id: readString(record["id"], `${path}.id`),
    bone,
    objectId: readString(record["objectId"], `${path}.objectId`),
    uv: [uv[0]!, uv[1]!],
    normalOffset: readNumber(record["normalOffset"], `${path}.normalOffset`),
    localRotation: readQuaternion(record["localRotation"], `${path}.localRotation`),
    positionToleranceM: readNumber(record["positionToleranceM"], `${path}.positionToleranceM`),
    angularToleranceDeg: readNumber(
      record["angularToleranceDeg"],
      `${path}.angularToleranceDeg`,
    ),
  };
}

/**
 * Produces a detached plain-data copy safe to hand to `JSON.stringify` or a
 * network encoder. `DisguiseState` holds no class instances, so this is a clone.
 */
export function serializeDisguiseState(state: DisguiseState): DisguiseState {
  return cloneDisguiseState(state);
}

/** Parses untrusted input, throwing `DisguiseStateError` on the first problem. */
export function deserializeDisguiseState(input: unknown): DisguiseState {
  const record = readRecord(input, "disguise");
  const root = readRecord(record["root"], "disguise.root");

  const joints = readArray(record["joints"], "disguise.joints").map((entry, i) => {
    const jointRecord = readRecord(entry, `disguise.joints[${i}]`);
    const bone = readString(jointRecord["bone"], `disguise.joints[${i}].bone`);
    if (!isBoneName(bone)) {
      fail(`disguise.joints[${i}].bone`, "a known bone");
    }
    return {
      bone,
      rotation: readQuaternion(jointRecord["rotation"], `disguise.joints[${i}].rotation`),
    } satisfies JointState;
  });

  const segments = readArray(record["segments"], "disguise.segments").map((entry, i) => {
    const segmentRecord = readRecord(entry, `disguise.segments[${i}]`);
    const bone = readString(segmentRecord["bone"], `disguise.segments[${i}].bone`);
    const expected = SEGMENT_BONES[i];
    if (expected === undefined || expected !== bone) {
      fail(`disguise.segments[${i}].bone`, `"${expected ?? "no further segment"}"`);
    }
    return {
      bone: expected,
      form: readSegmentForm(segmentRecord["form"], `disguise.segments[${i}].form`),
    } satisfies SegmentSlotState;
  });

  return {
    version: readNumber(record["version"], "disguise.version"),
    rigVersion: readNumber(record["rigVersion"], "disguise.rigVersion"),
    mapId: readString(record["mapId"], "disguise.mapId"),
    mapVersion: readNumber(record["mapVersion"], "disguise.mapVersion"),
    root: {
      position: readVec3(root["position"], "disguise.root.position"),
      rotation: readQuaternion(root["rotation"], "disguise.root.rotation"),
    },
    joints,
    segments,
    panels: readArray(record["panels"], "disguise.panels").map((entry, i) =>
      readPanel(entry, `disguise.panels[${i}]`),
    ),
    anchors: readArray(record["anchors"], "disguise.anchors").map((entry, i) =>
      readAnchor(entry, `disguise.anchors[${i}]`),
    ),
    materials: readArray(record["materials"], "disguise.materials").map((entry, i) => {
      const materialRecord = readRecord(entry, `disguise.materials[${i}]`);
      return {
        slotId: readString(materialRecord["slotId"], `disguise.materials[${i}].slotId`),
        swatchId: readString(materialRecord["swatchId"], `disguise.materials[${i}].swatchId`),
      } satisfies MaterialAssignment;
    }),
    revision: readNumber(record["revision"], "disguise.revision"),
  };
}

// --- Pose bridge ------------------------------------------------------------

/** Loads a disguise into a live `PoseState` and runs forward kinematics. */
export function applyDisguiseStateToPose(state: DisguiseState, pose: PoseState): void {
  pose.rootPosition.set(state.root.position[0], state.root.position[1], state.root.position[2]);
  pose.rootRotation.set(
    state.root.rotation[0],
    state.root.rotation[1],
    state.root.rotation[2],
    state.root.rotation[3],
  );
  for (const joint of state.joints) {
    const index = boneIndex(joint.bone);
    if (index < 0) continue;
    pose.localRotations[index]!.set(
      joint.rotation[0],
      joint.rotation[1],
      joint.rotation[2],
      joint.rotation[3],
    );
  }
  for (let slot = 0; slot < state.segments.length; slot++) {
    const segment = state.segments[slot];
    if (segment === undefined || slot >= pose.segments.length) continue;
    pose.segments[slot] = cloneSegmentForm(segment.form);
  }
  refreshRigMetrics(pose);
  updateWorldTransforms(pose);
}

/** Writes a live pose back into a disguise, bumping the revision. */
export function capturePoseToDisguiseState(pose: PoseState, state: DisguiseState): DisguiseState {
  state.root.position = [pose.rootPosition.x, pose.rootPosition.y, pose.rootPosition.z];
  state.root.rotation = [
    pose.rootRotation.x,
    pose.rootRotation.y,
    pose.rootRotation.z,
    pose.rootRotation.w,
  ];
  state.joints = BONE_NAMES.map((bone, index) => {
    const rotation = pose.localRotations[index]!;
    return { bone, rotation: [rotation.x, rotation.y, rotation.z, rotation.w] };
  });
  state.segments = SEGMENT_BONES.map((bone, slot) => ({
    bone,
    form: cloneSegmentForm(pose.segments[slot] ?? createDefaultSegmentForm(bone)),
  }));
  state.revision += 1;
  return state;
}

// --- Starter arrangements (§7.15) -------------------------------------------

export const STARTER_ARRANGEMENT_IDS = [
  "upright",
  "compact",
  "wide",
  "tall",
  "tripod",
  "wall_mount",
  "shelf_bundle",
  "hanging",
] as const;

export type StarterArrangementId = (typeof STARTER_ARRANGEMENT_IDS)[number];

/**
 * Segment overrides are authored in scale space, which reads far better than the
 * normalized slider values they map onto.
 */
interface SegmentOverride {
  readonly lengthScale?: number;
  readonly widthScale?: number;
  readonly depthScale?: number;
  readonly flatten?: number;
  readonly taper?: number;
  readonly roundness?: number;
  readonly twist?: number;
  readonly profileId?: SegmentProfileId;
}

interface ArrangementDef {
  readonly id: StarterArrangementId;
  readonly label: string;
  /** Whole-body tilt, in degrees, applied above the pelvis. */
  readonly rootRotationDeg: Vector3Tuple;
  /**
   * Local joint rotations in degrees. Each entry rotates about a single axis so
   * the pose stays inside the swing cone or hinge range it is authored against.
   */
  readonly joints: Partial<Record<BoneName, Vector3Tuple>>;
  readonly segments: Partial<Record<SegmentBoneName, SegmentOverride>>;
}

const ARRANGEMENTS: readonly ArrangementDef[] = [
  {
    id: "upright",
    label: "Upright",
    rootRotationDeg: [0, 0, 0],
    joints: {},
    segments: {},
  },
  {
    id: "compact",
    label: "Compact",
    rootRotationDeg: [0, 0, 0],
    joints: {
      pelvis: [-10, 0, 0],
      torso_lower: [-20, 0, 0],
      torso_upper: [-15, 0, 0],
      neck: [25, 0, 0],
      head: [10, 0, 0],
      upperarm_L: [-70, 0, 0],
      upperarm_R: [-70, 0, 0],
      forearm_L: [-120, 0, 0],
      forearm_R: [-120, 0, 0],
      thigh_L: [-80, 0, 0],
      thigh_R: [-80, 0, 0],
      shin_L: [130, 0, 0],
      shin_R: [130, 0, 0],
      foot_L: [-40, 0, 0],
      foot_R: [-40, 0, 0],
    },
    segments: {
      torso_lower: { lengthScale: 0.85, widthScale: 1.25 },
      torso_upper: { lengthScale: 0.85, widthScale: 1.25 },
      neck: { lengthScale: 0.55 },
    },
  },
  {
    id: "wide",
    label: "Wide",
    rootRotationDeg: [0, 0, 0],
    joints: {
      shoulder_L: [0, 0, -15],
      shoulder_R: [0, 0, 15],
      upperarm_L: [0, 0, 75],
      upperarm_R: [0, 0, -75],
      thigh_L: [0, 0, 40],
      thigh_R: [0, 0, -40],
      shin_L: [12, 0, 0],
      shin_R: [12, 0, 0],
    },
    segments: {
      torso_lower: { lengthScale: 0.8, widthScale: 1.9, depthScale: 0.75 },
      torso_upper: { lengthScale: 0.8, widthScale: 1.9, depthScale: 0.75 },
      pelvis: { widthScale: 1.6 },
      head: { widthScale: 1.3, flatten: 0.25 },
      hand_L: { widthScale: 1.8 },
      hand_R: { widthScale: 1.8 },
    },
  },
  {
    id: "tall",
    label: "Tall",
    rootRotationDeg: [0, 0, 0],
    joints: {
      neck: [-8, 0, 0],
      head: [8, 0, 0],
      upperarm_L: [0, 0, 8],
      upperarm_R: [0, 0, -8],
    },
    segments: {
      torso_lower: { lengthScale: 1.6, widthScale: 0.8 },
      torso_upper: { lengthScale: 1.6, widthScale: 0.8 },
      neck: { lengthScale: 2.0, widthScale: 0.75 },
      thigh_L: { lengthScale: 1.35 },
      thigh_R: { lengthScale: 1.35 },
      shin_L: { lengthScale: 1.35 },
      shin_R: { lengthScale: 1.35 },
    },
  },
  {
    id: "tripod",
    label: "Tripod",
    rootRotationDeg: [8, 0, 0],
    joints: {
      pelvis: [10, 0, 0],
      torso_lower: [15, 0, 0],
      neck: [-20, 0, 0],
      thigh_L: [0, 0, 35],
      thigh_R: [0, 0, -35],
      shin_L: [10, 0, 0],
      shin_R: [10, 0, 0],
      upperarm_L: [35, 0, 0],
      upperarm_R: [35, 0, 0],
      forearm_L: [-20, 0, 0],
      forearm_R: [-20, 0, 0],
    },
    segments: {
      thigh_L: { lengthScale: 1.2, taper: -0.35 },
      thigh_R: { lengthScale: 1.2, taper: -0.35 },
      shin_L: { lengthScale: 1.2, taper: -0.35 },
      shin_R: { lengthScale: 1.2, taper: -0.35 },
      torso_lower: { widthScale: 1.2 },
    },
  },
  {
    id: "wall_mount",
    label: "Wall Mount",
    rootRotationDeg: [70, 0, 0],
    joints: {
      pelvis: [-15, 0, 0],
      torso_lower: [-20, 0, 0],
      torso_upper: [-20, 0, 0],
      neck: [-30, 0, 0],
      upperarm_L: [140, 0, 0],
      upperarm_R: [140, 0, 0],
      forearm_L: [-30, 0, 0],
      forearm_R: [-30, 0, 0],
      thigh_L: [20, 0, 0],
      thigh_R: [20, 0, 0],
      shin_L: [15, 0, 0],
      shin_R: [15, 0, 0],
      foot_L: [45, 0, 0],
      foot_R: [45, 0, 0],
    },
    segments: {
      torso_lower: { widthScale: 1.6, depthScale: 0.45, flatten: 0.3 },
      torso_upper: { widthScale: 1.6, depthScale: 0.45, flatten: 0.3 },
      head: { depthScale: 0.7, flatten: 0.35 },
      hand_L: { widthScale: 1.6, flatten: 0.6, profileId: "flat_panel" },
      hand_R: { widthScale: 1.6, flatten: 0.6, profileId: "flat_panel" },
    },
  },
  {
    id: "shelf_bundle",
    label: "Shelf Bundle",
    rootRotationDeg: [0, 0, 0],
    joints: {
      pelvis: [-15, 0, 0],
      torso_lower: [-25, 0, 0],
      torso_upper: [-20, 0, 0],
      neck: [30, 0, 0],
      head: [20, 0, 0],
      shoulder_L: [0, 0, -20],
      shoulder_R: [0, 0, 20],
      upperarm_L: [-100, 0, 0],
      upperarm_R: [-100, 0, 0],
      forearm_L: [-140, 0, 0],
      forearm_R: [-140, 0, 0],
      thigh_L: [-110, 0, 0],
      thigh_R: [-110, 0, 0],
      shin_L: [140, 0, 0],
      shin_R: [140, 0, 0],
      foot_L: [-50, 0, 0],
      foot_R: [-50, 0, 0],
    },
    segments: {
      torso_lower: { lengthScale: 0.8, widthScale: 1.4, depthScale: 1.2, roundness: 0.2 },
      torso_upper: { lengthScale: 0.8, widthScale: 1.4, depthScale: 1.2, roundness: 0.2 },
      neck: { lengthScale: 0.5 },
      upperarm_L: { lengthScale: 0.85 },
      upperarm_R: { lengthScale: 0.85 },
      forearm_L: { lengthScale: 0.85 },
      forearm_R: { lengthScale: 0.85 },
      thigh_L: { lengthScale: 0.85 },
      thigh_R: { lengthScale: 0.85 },
      shin_L: { lengthScale: 0.85 },
      shin_R: { lengthScale: 0.85 },
    },
  },
  {
    id: "hanging",
    label: "Hanging",
    rootRotationDeg: [0, 0, 0],
    joints: {
      shoulder_L: [0, 0, 25],
      shoulder_R: [0, 0, -25],
      upperarm_L: [145, 0, 0],
      upperarm_R: [145, 0, 0],
      forearm_L: [-15, 0, 0],
      forearm_R: [-15, 0, 0],
      neck: [-10, 0, 0],
      head: [-10, 0, 0],
      thigh_L: [10, 0, 0],
      thigh_R: [10, 0, 0],
      shin_L: [15, 0, 0],
      shin_R: [15, 0, 0],
      foot_L: [-35, 0, 0],
      foot_R: [-35, 0, 0],
    },
    segments: {
      torso_lower: { lengthScale: 1.3, widthScale: 0.85 },
      torso_upper: { lengthScale: 1.3, widthScale: 0.85 },
      neck: { lengthScale: 1.6 },
      upperarm_L: { lengthScale: 1.15 },
      upperarm_R: { lengthScale: 1.15 },
      forearm_L: { lengthScale: 1.15 },
      forearm_R: { lengthScale: 1.15 },
    },
  },
];

const arrangementEuler = new Euler();
const arrangementQuaternion = new Quaternion();

function quaternionFromDegrees(degrees: Vector3Tuple): [number, number, number, number] {
  arrangementEuler.set(
    degrees[0] * DEG_TO_RAD,
    degrees[1] * DEG_TO_RAD,
    degrees[2] * DEG_TO_RAD,
    "XYZ",
  );
  arrangementQuaternion.setFromEuler(arrangementEuler);
  return [
    arrangementQuaternion.x,
    arrangementQuaternion.y,
    arrangementQuaternion.z,
    arrangementQuaternion.w,
  ];
}

function applySegmentOverride(
  bone: SegmentBoneName,
  override: SegmentOverride,
  form: SegmentFormState,
): void {
  const range = segmentRange(bone);
  if (override.lengthScale !== undefined) {
    form.length = normalizedFromScale(
      override.lengthScale,
      range.minLengthScale,
      range.maxLengthScale,
    );
  }
  if (override.widthScale !== undefined) {
    form.width = normalizedFromScale(
      override.widthScale,
      range.minWidthScale,
      range.maxWidthScale,
    );
  }
  if (override.depthScale !== undefined) {
    form.depth = normalizedFromScale(
      override.depthScale,
      range.minDepthScale,
      range.maxDepthScale,
    );
  }
  if (override.flatten !== undefined) form.flatten = override.flatten;
  if (override.taper !== undefined) form.taper = override.taper;
  if (override.roundness !== undefined) form.roundness = override.roundness;
  if (override.twist !== undefined) form.twist = override.twist;
  if (override.profileId !== undefined) form.profileId = override.profileId;
}

export function starterArrangementLabel(id: StarterArrangementId): string {
  const definition = ARRANGEMENTS.find((entry) => entry.id === id);
  if (definition === undefined) {
    throw new Error(`Unknown starter arrangement "${id}"`);
  }
  return definition.label;
}

/**
 * Builds one of the §7.15 starting arrangements. These are starting points, not
 * finished disguises: every one still reads as the same creature.
 */
export function createStarterArrangement(id: StarterArrangementId): DisguiseState {
  const definition = ARRANGEMENTS.find((entry) => entry.id === id);
  if (definition === undefined) {
    throw new Error(`Unknown starter arrangement "${id}"`);
  }

  const state = createDefaultDisguiseState();
  state.root.rotation = quaternionFromDegrees(definition.rootRotationDeg);

  for (const joint of state.joints) {
    const degrees = definition.joints[joint.bone];
    if (degrees !== undefined) {
      joint.rotation = quaternionFromDegrees(degrees);
    }
  }

  for (const segment of state.segments) {
    const override = definition.segments[segment.bone];
    if (override !== undefined) {
      applySegmentOverride(segment.bone, override, segment.form);
    }
  }

  return state;
}

export function createAllStarterArrangements(): Record<StarterArrangementId, DisguiseState> {
  return {
    upright: createStarterArrangement("upright"),
    compact: createStarterArrangement("compact"),
    wide: createStarterArrangement("wide"),
    tall: createStarterArrangement("tall"),
    tripod: createStarterArrangement("tripod"),
    wall_mount: createStarterArrangement("wall_mount"),
    shelf_bundle: createStarterArrangement("shelf_bundle"),
    hanging: createStarterArrangement("hanging"),
  };
}
