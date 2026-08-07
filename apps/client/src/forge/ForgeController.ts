import { Vector3 as CoreVector3 } from "three";
import * as THREE from "three/webgpu";

import { DisposalBag } from "../engine/DisposalBag";
import { tryReleasePointerCapture, trySetPointerCapture } from "../engine/pointerCapture";
import { LoopingSoundVoice } from "../audio/LoopingSoundVoice";
import { cloneDisguiseState, type AnchorState } from "../mimic/disguiseState";
import {
  applyDisguiseStateToPose,
  capturePoseToDisguiseState,
  createStarterArrangement,
  DEFAULT_BODY_SWATCH_ID,
  serializeDisguiseState,
  starterArrangementLabel,
  STARTER_ARRANGEMENT_IDS,
  validateDisguiseState,
  type DisguiseState,
  type StarterArrangementId,
} from "../mimic/disguiseState";
import {
  createPoseState,
  refreshRigMetrics,
  solveIK,
  updateWorldTransforms,
  type IkTargetName,
  type IkTargets,
  type PoseState,
} from "../mimic/ikSolver";
import {
  clampPanelState,
  clonePanelState,
  createDefaultPanelState,
  createResolvedPanel,
  isPanelSocketName,
  PANEL_MAX_EXTENSION_M,
  PANEL_MAX_HINGE_DEG,
  PANEL_MIN_HINGE_DEG,
  resolvePanel,
  type PanelProfileId,
  type PanelState,
} from "../mimic/panels";
import { MAX_OUTLINE_POINTS, MAX_SHAPES, type ShapeProfileId } from "@foldseek/shared";
import { readsAs } from "@foldseek/map-data";
import type { BoneName } from "../mimic/rig";
import {
  addShape as addShapeToList,
  duplicateShapeById,
  fitScore,
  snapOffset,
  type FitBox,
  removeShapeById,
  shapeLabels,
  strokeToBoxes,
  type DrawPoint,
  type ShapeEdit,
} from "./shapeAuthoring";
import type { CharacterController } from "../inspector/CharacterController";
import { nearestBlockerEntry } from "../inspector/geometry";
import { GrappleVisual } from "../inspector/GrappleVisual";
import { grappleTargetFromRay } from "../inspector/grappleTarget";
import {
  BOB_AMPLITUDE_M as CAMERA_BOB_AMPLITUDE_M,
  BOB_RATE_RAD_PER_M as CAMERA_BOB_RATE_RAD_PER_M,
  DEFAULT_BOOM_LENGTH_M,
  MAX_BOOM_LENGTH_M,
} from "../inspector/InspectorCamera";
import { DEFAULT_LOOK_SENSITIVITY } from "../inspector/InspectorInput";
import { WORLD_SCALE, type AABB, type NavData, type Vec3Like } from "../inspector/navData";
import { BodyLanguage, type BodyPosture } from "./BodyLanguage";
import { LocomotionRig, MIMIC_GAIT_PROFILE } from "./LocomotionRig";
import { HiderLocomotion } from "./HiderLocomotion";
import {
  boneIndex,
  clampBoneRotation,
  getBone,
  PANEL_SOCKET_NAMES,
  RIG_TO_WORLD,
  SEGMENT_BONES,
  type PanelSocketName,
} from "../mimic/rig";
import {
  clampSegmentForm,
  cloneSegmentForm,
  createDefaultSegmentForm,
  isSegmentProfileId,
  type SegmentFormState,
  type SegmentProfileId,
} from "../mimic/segmentForm";
import { createPuckGeometry } from "../mimic/visual/mimicGeometry";
import { MIMIC_BODY_TAG, MIMIC_VISUAL_ID, MimicVisual } from "../mimic/visual/MimicVisual";
import {
  MIMIC_LEGAL_SWATCHES,
  swatchById,
  type MaterialSwatch,
} from "../mimic/visual/materialSwatches";
import { createPaintTool, type PaintTool } from "../paint/createPaintTool";
import {
  BRUSH_RADIUS_STEPS,
  nearestBrushStepIndex,
} from "../paint/PaintBrushController";
import { mirroredPaintTarget } from "../paint/paintTargets";
import type { QualitySettings } from "../rendering/quality";
import { AudioPlayer } from "./AudioPlayer";
import { actionForCode, readStandardGamepad, type InputAction } from "../gameplay/inputBindings";
import {
  assignmentFor,
  assignmentSlots,
  BODY_SLOT_ID,
  EYE_SLOT_ID,
  mirroredSlotId,
  resolvedSwatchFor,
  validateAssignment,
} from "./materialAssignment";
import {
  capturePoseSnapshot,
  createAnchorCommand,
  createCompositeCommand,
  createMaterialCommand,
  createPaintClearCommand,
  createPaintStrokeCommand,
  createPanelCommand,
  createPoseCommand,
  createReplaceCommand,
  createSegmentFormCommand,
  ForgeCommandStack,
  poseSnapshotsEqual,
  type ForgeCommand,
  type PaintHistoryTarget,
  type PoseSnapshot,
} from "./forgeCommands";
import { resolveSurfaceSwatch, trayForColor, traySwatchForSurface } from "./roomSwatches";
import { Eyedropper } from "../paint/Eyedropper";
import {
  anchorForBone,
  anchorResidual,
  ANCHOR_GAP_M,
  ANCHOR_RELEASE_RADIUS_M,
  ANCHOR_SNAP_RADIUS_M,
  captureAnchor,
  solveContactAlignment,
  solvePanelReach,
  CONTACT_FACE_NORMALS,
  CONTACT_FACE_REVERSIBLE,
  createResolvedAnchor,
  isAnchorableBone,
  isAnchorSatisfied,
  nextAnchorId,
  resolveAnchor,
  anchorTargetName,
  withAnchorOnBone,
  type AnchorableBone,
  type AnchorCapture,
  type ResolvedAnchor,
} from "./anchors";

/**
 * The Mimic Forge editor (bible §7). Imperative and frame-driven: the pose
 * solver, the handles, and the renderable Mimic all live here, and React only
 * sees discrete state changes through `subscribe`.
 *
 * Input is captured at the window rather than the canvas so the Forge owns the
 * pointer while it is active, without the world's own orbit listeners having to
 * know about it.
 */

export type ForgeToolMode = "pose" | "shape" | "panels" | "material" | "paint";

export const FORGE_TOOL_MODES: readonly ForgeToolMode[] = [
  "pose",
  "shape",
  "panels",
  "material",
  "paint",
];

/** Form parameters a slider can drive, as opposed to the profile enum. */
export type SegmentFormNumericKey =
  | "length"
  | "width"
  | "depth"
  | "flatten"
  | "taper"
  | "roundness"
  | "twist";

const SEGMENT_FORM_NUMERIC_KEYS: readonly SegmentFormNumericKey[] = [
  "length",
  "width",
  "depth",
  "flatten",
  "taper",
  "roundness",
  "twist",
];

export type PanelNumericKey = "deployed" | "hingeAngle" | "extension" | "width" | "height";

const PANEL_NUMERIC_KEYS: readonly PanelNumericKey[] = [
  "deployed",
  "hingeAngle",
  "extension",
  "width",
  "height",
];

/** High-impact silhouettes shared by the Forge buttons and Shift+number hotkeys. */
export const FORGE_QUICK_SHAPES: readonly {
  readonly label: string;
  readonly values: Partial<Record<SegmentFormNumericKey, number>>;
  readonly profileId: SegmentProfileId;
}[] = [
  { label: "Slim", values: { width: 0.18, depth: 0.18, flatten: 0.15, taper: -0.18 }, profileId: "capsule" },
  { label: "Broad", values: { width: 0.88, depth: 0.68, flatten: 0, taper: 0.08 }, profileId: "rounded_box" },
  { label: "Flat", values: { width: 0.78, depth: 0.2, flatten: 0.9, taper: 0 }, profileId: "flat_panel" },
  { label: "Long", values: { length: 0.9, width: 0.38, depth: 0.38, taper: -0.12 }, profileId: "tapered_block" },
  { label: "Round", values: { width: 0.62, depth: 0.62, flatten: 0, roundness: 1, taper: 0 }, profileId: "cylinder" },
];

/** Fast panel identities shared by the Forge buttons and Shift+number hotkeys. */
export const FORGE_QUICK_PANELS: readonly {
  readonly label: string;
  readonly values: Partial<Record<PanelNumericKey, number>>;
  readonly profileId: PanelProfileId;
}[] = [
  { label: "Shield", values: { deployed: 1, width: 0.9, height: 0.78, extension: 0.08, hingeAngle: 0 }, profileId: "rounded_rect" },
  { label: "Blade", values: { deployed: 1, width: 0.18, height: 0.9, extension: 0.25, hingeAngle: 0 }, profileId: "triangle" },
  { label: "Wing", values: { deployed: 1, width: 0.82, height: 0.42, extension: 0.52, hingeAngle: 55 }, profileId: "triangle" },
  { label: "Tile", values: { deployed: 0.72, width: 0.68, height: 0.68, extension: 0, hingeAngle: 0 }, profileId: "rectangle" },
];

/**
 * Facing is a control response, not an inertial animation. The old hunt rate
 * took nearly three seconds to reverse 180 degrees, leaving the Mimic visibly
 * running backward. The gait still supplies weight; steering answers quickly.
 */
const FORGE_TURN_RATE_RAD_PER_SECOND = 28;
const CREEP_TURN_RATE_RAD_PER_SECOND = 22;

/** Preview cameras of bible §7.6. `inspector` is held, the rest toggle. */
export type ForgePreviewMode = "none" | "inspector" | "doorway";

export interface ForgeSegmentSelection {
  readonly slot: number;
  readonly bone: string;
  readonly form: SegmentFormState;
  readonly swatchId: string;
}

export interface ForgePanelSelection {
  readonly socketId: string;
  readonly panel: PanelState | null;
}

export interface ForgeShapeRow {
  readonly id: string;
  /** "Cylinder 2": what it is and which one, which is what a player scans for. */
  readonly label: string;
  readonly selected: boolean;
}

export interface ForgeHudState {
  readonly mode: ForgeToolMode;
  /** Null while the Forge dock is collapsed and no tool owns the pointer. */
  readonly activeMode: ForgeToolMode | null;
  readonly locked: boolean;
  readonly mirror: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly segment: ForgeSegmentSelection | null;
  /** How many parts the resize gizmo is driving (shift-click multi-select). */
  readonly selectedCount: number;
  readonly panel: ForgePanelSelection | null;
  /**
   * The shapes this disguise is built from, named and in build order, with
   * whichever one the gizmo is driving marked.
   *
   * The list is what a player reads to find a shape they placed a minute ago
   * and cannot now see, because it is buried inside the form they built - which
   * is the ordinary case once a disguise reads as an object at all.
   */
  readonly shapes: readonly ForgeShapeRow[];
  /**
   * How much of the body the built shapes hide, 0 to 1.
   *
   * Shown while building because a disguise is the shapes WITH their owner
   * tucked inside: a creature standing beside a beautiful barrel is still a
   * creature, and this is what tells a player which one they have made.
   */
  readonly fit: number;
  /** Whether a drawn outline closes into a slab or stands as the bare line. */
  readonly fillDrawings: boolean;
  /**
   * What the outline resembles in this room, and how closely. Null until
   * something is built. This is the answer a hider could only guess at before:
   * "does this read as something that belongs here?"
   */
  readonly readsAs: { readonly family: string; readonly closeness: number } | null;
  readonly sampledSwatchId: string | null;
  /** True while F has armed the material dropper and a click will sample. */
  readonly materialDropperArmed: boolean;
  /** Swatch tinting the eye glow, or null while they wear the default amber. */
  readonly eyeSwatchId: string | null;
  readonly bodySwatchId: string;
  readonly arrangementId: StarterArrangementId;
  readonly previewArrangementId: StarterArrangementId | null;
  readonly lockIssues: readonly string[];
  /** Contact points currently sealed to a surface, and any that cannot be met. */
  readonly anchoredBones: readonly string[];
  readonly unsatisfiedAnchors: readonly string[];
  readonly preview: ForgePreviewMode;
  readonly silhouette: boolean;
  readonly status: string;
  /**
   * Bumped only when something other than the player's own slider changes the
   * selected values: a different selection, an undo, a starter arrangement. The
   * HUD keys its uncontrolled sliders on it, so those events reset the controls
   * while ordinary editing leaves the live DOM values alone.
   */
  readonly formEpoch: number;
}

/**
 * What a successful lock produces. Paint travels beside the pose rather than
 * inside it, which is how the sim carries it too: `recordPaintUpdate` takes an
 * `encodedPaint` of its own with its own revision, so the two are edited and
 * validated independently.
 */
export interface LockedDisguise {
  readonly disguise: DisguiseState;
  readonly encodedPaint: string;
}

export interface ForgePaintSnapshot {
  readonly encodedPaint: string;
  readonly revision: number;
  readonly strokeCount: number;
}

export interface ForgeControllerOptions {
  readonly scene: THREE.Scene;
  readonly canvas: HTMLCanvasElement;
  readonly quality: QualitySettings;
  /** Where the Mimic stands, in world metres. */
  readonly origin?: THREE.Vector3;
  /** The active map's playable volume. Defaults to the practice room's. */
  readonly workspace?: ForgeWorkspace;
  /**
   * The map's walkable geometry. With it the player runs the Mimic around the
   * room on the walk keys; without it the body is only ever moved by dragging a
   * handle. Forge practice is staged in the test room, which publishes no nav
   * data, so it is optional rather than required.
   */
  readonly navData?: NavData;
  /** Lets the round authority grant the matching burst of hider movement. */
  readonly onGrapple?: (target: Vec3Like) => void;
}

interface HandleDef {
  readonly target: IkTargetName;
  readonly bone: string;
  readonly shape: "sphere" | "puck";
  readonly color: number;
  readonly label: string;
}

const HANDLE_DEFS: readonly HandleDef[] = [
  { target: "pelvis", bone: "pelvis", shape: "sphere", color: 0xb08a4a, label: "Pelvis" },
  { target: "chest", bone: "torso_upper", shape: "sphere", color: 0xb08a4a, label: "Chest" },
  { target: "head", bone: "head", shape: "sphere", color: 0xece2d2, label: "Head" },
  { target: "hand_L", bone: "hand_L", shape: "puck", color: 0xece2d2, label: "Left hand" },
  { target: "hand_R", bone: "hand_R", shape: "puck", color: 0xece2d2, label: "Right hand" },
  { target: "foot_L", bone: "foot_L", shape: "puck", color: 0x4d7a68, label: "Left foot" },
  { target: "foot_R", bone: "foot_R", shape: "puck", color: 0x4d7a68, label: "Right foot" },
];

interface Handle {
  readonly def: HandleDef;
  readonly boneIndex: number;
  /** The small grip the player sees. */
  readonly solid: THREE.Mesh;
  /** The billboarded outline around it, drawn through the body (§24.5). */
  readonly ring: THREE.Mesh;
  /** Invisible, and the only thing the pointer is tested against. */
  readonly pick: THREE.Mesh;
  readonly group: THREE.Object3D;
  readonly materials: readonly THREE.Material[];
}

interface SegmentEdit {
  readonly slot: number;
  readonly before: SegmentFormState;
  readonly mirrorSlot: number;
  readonly mirrorBefore: SegmentFormState | null;
}

/**
 * Orbit distances and handle sizes are measured against the body, not the room,
 * so they are quoted in the rig's authored units and converted with it. Left
 * absolute they would frame a player-height Mimic from across the shop and put
 * a 0.075 m grab handle on a 0.35 m creature.
 */
const CAMERA_MIN_RADIUS = 0.6 * RIG_TO_WORLD;
const CAMERA_MAX_RADIUS = MAX_BOOM_LENGTH_M;
/**
 * Both roles open at the same third-person boom distance. The Mimic still owns
 * an orbit rather than an over-shoulder rig, but neither role begins with the
 * character filling the frame and both can pull back to the shared ceiling.
 */
const CAMERA_START_RADIUS = DEFAULT_BOOM_LENGTH_M;
const CAMERA_MIN_PITCH = -1.2;
const CAMERA_MAX_PITCH = 1.45;

/**
 * Height of the point the camera orbits, as a share of body height above the
 * Mimic's feet. Just over halfway up puts the chest in the middle of the frame
 * and leaves the head clear of the top edge.
 */
const ORBIT_TARGET_BODY_SHARE = 0.55;

/**
 * How long the shot takes to catch up with a body that moved, and the rate that
 * delivers it: the camera closes all but a twentieth of the gap in that time.
 * The orbit point is the player's, so this is a lag rather than a spring — it
 * never overshoots the body and never oscillates around it, which would turn a
 * walk across the shop into a slow wobble.
 *
 * Under the snap distance the chase is over and the camera is placed exactly on
 * the orbit point, so a settled shot is the shot the player left, to the metre.
 */
const CAMERA_FOLLOW_SETTLE_SECONDS = 0.16;
const CAMERA_FOLLOW_RATE = Math.log(20) / CAMERA_FOLLOW_SETTLE_SECONDS;
const CAMERA_FOLLOW_SNAP_M = WORLD_SCALE.playerHeight * 1e-4;

/**
 * Share of the body's own landing compression the camera echoes. Half of it is
 * enough to feel the impact through the frame; the whole of it reads as the
 * camera having been dropped too.
 */
const CAMERA_LANDING_ECHO_SHARE = 0.55;

/**
 * Radians the shot turns per pixel of drag, the same number for both axes and
 * the same number the Inspector's own look uses. A game has one turn rate: at
 * the old 0.007 a four-hundred-pixel drag swung the view through 160 degrees,
 * which reads as the room being thrown past the player rather than as walking
 * around them, and a yaw that answered faster than the pitch bent every
 * diagonal drag into a curve.
 */
const ORBIT_PER_PIXEL = DEFAULT_LOOK_SENSITIVITY;
const PITCH_PER_PIXEL = DEFAULT_LOOK_SENSITIVITY;
const ZOOM_PER_NOTCH = 0.0016;

/**
 * Gap kept between the camera and whatever the boom would otherwise pass
 * through, as a share of body height, and the shortest the boom may be pulled
 * to. Without them the orbit swung straight through the floorboards and the
 * legs of the furniture: the pivot was still on the body, but the body was
 * behind a carpet, which is the same thing as having lost it.
 */
const ORBIT_SKIN_M = WORLD_SCALE.playerHeight * 0.069;
const ORBIT_MIN_RADIUS_M = WORLD_SCALE.playerHeight * 0.9;

/**
 * Handle radius in metres at one metre from the camera, kept constant on
 * screen. This one is a ratio rather than a length: it multiplies the camera
 * distance, which already shrank with the body, so converting it too would
 * shrink the handles twice.
 *
 * Drawing and grabbing are two different sizes on purpose. Seven filled discs at
 * the grab radius covered more of the Mimic than the Mimic showed, and the body
 * is the thing being judged; the drawn grip is therefore less than half the size
 * of the disc the pointer actually hits, which costs nothing because the pick
 * proxy is invisible.
 */
const HANDLE_PICK_SCREEN_RADIUS = 0.028;
const HANDLE_SCREEN_RADIUS = 0.012;
const HANDLE_MIN_RADIUS = 0.009 * RIG_TO_WORLD;
const HANDLE_MAX_RADIUS = 0.032 * RIG_TO_WORLD;
const HANDLE_PICK_RATIO = HANDLE_PICK_SCREEN_RADIUS / HANDLE_SCREEN_RADIUS;

/**
 * Panel tips are their own picking target and appear only while the panel tool
 * is up, so they are drawn at the size they are grabbed at rather than getting a
 * proxy. Larger than a pose grip, because a panel tip is dragged out into open
 * space where there is nothing else to aim at.
 */
const PANEL_TIP_SCREEN_RADIUS = 0.018;

/** Inner edge of the outline ring, as a share of the handle radius. */
const HANDLE_RING_INNER = 0.74;
/** The solid grip inside the ring. */
const HANDLE_GRIP_SCALE = 0.5;

/**
 * A handle is a hint while the pointer is elsewhere and a control under it, so
 * it is drawn faint until it is hovered or held. Idle opacity is low enough that
 * seven of them do not compete with the body they are attached to.
 */
const HANDLE_OPACITY_IDLE = 0.34;
/** The partner a mirrored edit will move: visible, but secondary to the pointer target. */
const HANDLE_OPACITY_MIRROR = 0.62;

/**
 * The Blender-style resize gizmo (2026-08-05): three axis arrows on the
 * selected segment replace the length/width/depth sliders. The axes live in
 * the segment's own frame - Y along the bone is length, X is width, Z is
 * depth - and one full body-height of pull sweeps a parameter end to end.
 */
const GIZMO_AXES: ReadonlyArray<{
  readonly key: "width" | "length" | "depth";
  readonly color: number;
  readonly dir: readonly [number, number, number];
}> = [
  { key: "width", color: 0xc75b45, dir: [1, 0, 0] },
  { key: "length", color: 0x6fa05a, dir: [0, 1, 0] },
  { key: "depth", color: 0x4a8fa8, dir: [0, 0, 1] },
];
const GIZMO_SHAFT_LENGTH_M = WORLD_SCALE.playerHeight * 0.44;
const GIZMO_SHAFT_RADIUS_M = WORLD_SCALE.playerHeight * 0.016;
const GIZMO_TIP_LENGTH_M = WORLD_SCALE.playerHeight * 0.12;
const GIZMO_TIP_RADIUS_M = WORLD_SCALE.playerHeight * 0.045;
const GIZMO_PICK_RADIUS_M = WORLD_SCALE.playerHeight * 0.09;
/** A shape may not be scaled away to nothing, nor past the body's own reach. */
/** One arrow press, about a fiftieth of the body's height. */
const SHAPE_NUDGE_M = 0.007;
/** A gap this small after a drag was not intended, so it closes itself. */
const AUTO_SEAT_M = 0.012;
/** Smaller than this was a click, not a drawn shape. */
const SHAPE_DRAW_MIN_M = 0.01;
/**
 * How wide a drawn disguise ends up, whatever size it was drawn.
 *
 * A little over the body's own height, so a drawing wraps its owner rather
 * than towering over the room. Proportions are the player's; scale is not.
 */
/** How deep a drawn outline stands, as a share of its own width. */
const DRAWN_THICKNESS_SHARE = 0.35;
/** The pointer while the Build tool is up, so drawing looks like drawing. */
const DRAW_CURSOR =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><path d='M3 21l4-1 12-12-3-3L4 17z' fill='%23e2b86a' stroke='%2314100c' stroke-width='1.5'/><path d='M16 5l3 3' stroke='%2314100c' stroke-width='1.5'/></svg>\") 2 22, crosshair";
const SHAPE_MIN_SCALE = 0.02;
const SHAPE_MAX_SCALE = 4;
/** A drag the width of the body turns a shape most of a half circle. */
const SHAPE_ROTATE_RAD_PER_METRE = Math.PI * 1.4;
/** A drag the width of the body roughly doubles a shape along that axis. */
const SHAPE_SCALE_PER_METRE = 1.2;
const SHAPE_ROTATE_SCRATCH = new THREE.Quaternion();
const SHAPE_MOVE_SCRATCH = new THREE.Vector3();
const SHAPE_START_SCRATCH = new THREE.Quaternion();
const SHAPE_AXIS_X = new THREE.Vector3(1, 0, 0);
const SHAPE_AXIS_Y = new THREE.Vector3(0, 1, 0);
const SHAPE_AXIS_Z = new THREE.Vector3(0, 0, 1);

const GIZMO_PARAM_PER_METRE = 1 / WORLD_SCALE.playerHeight;
/** How far a body shell may sit in front of a stud before it occludes it. */
const PANEL_PICK_OCCLUSION_TOLERANCE_M = WORLD_SCALE.playerHeight * 0.1;
const HANDLE_OPACITY_HOVER = 0.85;
const HANDLE_OPACITY_DRAG = 1;

/**
 * Draws nothing and writes no depth, but is still an ordinary object as far as
 * the raycaster is concerned. One instance serves every pick proxy: it holds no
 * per-handle state, so there is nothing for a controller to own or dispose.
 */
const INVISIBLE_PICK_MATERIAL = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});

/**
 * The volume the Forge may push the Mimic around inside (§7.16). It reaches the
 * room's own faces, not something smaller: a limit inside the walls would make
 * it impossible to touch one, and mounting on a wall is a legal disguise.
 *
 * It belongs to the map, so the active map supplies it. A workspace left at the
 * practice room's size silently drags a Mimic back toward the middle of a
 * larger shop the moment it is posed near a far wall.
 */
export interface ForgeWorkspace {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** The practice room's own volume, which is what Forge practice is staged in. */
export const TEST_ROOM_WORKSPACE: ForgeWorkspace = {
  minX: -4,
  maxX: 4,
  minY: 0.02,
  maxY: 2.6,
  minZ: -4,
  maxZ: 4,
};

const MANIPULATION_AUDIO_IDLE_MS = 110;

const RAD_TO_DEG = 180 / Math.PI;

/** How far back the §7.6 Inspector preview stands, as a share of body height. */
const PREVIEW_STAND_BACK_PER_BODY_HEIGHT = 7.4;

/** A panel's deploy slider covers this much of its swing (see MimicVisual). */
const PANEL_DEPLOY_DEGREES = 90;

/** Outer passes that walk the root toward a set of anchors before giving up. */
const ANCHOR_ROOT_PASSES = 3;

/** Fraction of the mean anchor error the root closes per pass. */
const ANCHOR_ROOT_GAIN = 0.85;

/** Directions a contact point probes for a surface to seal against. */
const ANCHOR_PROBE_DIRECTIONS: readonly THREE.Vector3[] = [
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(1, 0, 0),
];

/**
 * Where an Inspector's eye would be, and how far back they would stand, for the
 * §7.6 preview cameras. Both come from `WORLD_SCALE` rather than being written
 * out here: the players are toy-sized inside a full-sized room, so a preview
 * shot from a standing adult's height would show a view nobody in the match can
 * ever have. `WORLD_SCALE.playerHeight` is the one knob that decides all of it.
 */
const INSPECTOR_EYE_HEIGHT_M = WORLD_SCALE.eyeHeight;
const INSPECTOR_STAND_BACK_M = WORLD_SCALE.playerHeight * PREVIEW_STAND_BACK_PER_BODY_HEIGHT;

/**
 * The doorway preview stands where somebody who has just walked in would be:
 * further back than the Inspector preview and at the same eye height, looking
 * down the room's long axis. It used to be the fixed point (2.9, 1.62, 2.6),
 * which was the practice room's doorway and, after the scale retune, a camera
 * nearly five player heights up — a view nobody in the match can have. It is
 * derived from the active workspace instead, so it is right in any map.
 */
const DOORWAY_STAND_BACK_PER_BODY_HEIGHT = 22;

/** The seal marker is a disc lathed about +Y; this is the axis it aligns. */
const ANCHOR_MARKER_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Silhouette view: one grey material on everything, still lit. Colour, texture
 * and material response all go, which is the point; the lighting stays so form
 * still reads. An unlit fill removes the shading too and leaves a flat field
 * where nothing at all can be judged.
 */
const SILHOUETTE_FILL = 0x8d9298;
const SILHOUETTE_BACKDROP = new THREE.Color(0x0b0d10);

/** How far behind the wall face the root starts, before anchors pull it in. */
const WALL_MOUNT_STANDOFF_M = 0.34 * RIG_TO_WORLD;

/** Wall-mounted things hang at about chest height, not on the skirting board. */
const WALL_MOUNT_HEIGHT_M = 1.15;
const WALL_SEARCH_RANGE_M = 4 * RIG_TO_WORLD;

/** Auto-anchoring reaches further than a hand drag, having just been placed. */
const AUTO_ANCHOR_RADIUS_M = 0.6 * RIG_TO_WORLD;

/** Two surfaces count as the same face while their normals stay inside ~45 degrees. */
const SAME_FACE_DOT = 0.7;

/** A surface is level enough to rest on while its normal stays near vertical. */
const LEVEL_SURFACE_DOT = 0.8;

/** Where a bundle looks for something to sit on, and how high it must be. */
const PERCH_SAMPLE_RADII_M = [0.5 * RIG_TO_WORLD, 1.0 * RIG_TO_WORLD] as const;
const PERCH_SAMPLE_COUNT = 8;
const PERCH_SAMPLE_LIFT_M = 1.2 * RIG_TO_WORLD;
const PERCH_MIN_HEIGHT_M = 0.2 * RIG_TO_WORLD;

/**
 * Which contact points a starter arrangement wants held, and against what.
 * §24.7 solves the primary anchor before the limb contacts, so it is named
 * separately: the primary one decides where the body sits, and the secondary
 * ones only seal if they can already reach a surface from there.
 */
const ARRANGEMENT_CONTACTS: Partial<
  Record<
    StarterArrangementId,
    {
      readonly primary: AnchorableBone;
      readonly secondary: readonly AnchorableBone[];
      readonly approach: "wall" | "down";
    }
  >
> = {
  wall_mount: {
    primary: "pelvis",
    secondary: ["hand_L", "hand_R", "foot_L", "foot_R"],
    approach: "wall",
  },
  shelf_bundle: { primary: "pelvis", secondary: ["foot_L", "foot_R"], approach: "down" },
};

const PREVIEW_HINTS: Readonly<Record<ForgePreviewMode, string>> = {
  none: "Back to the workspace camera.",
  inspector: "Inspector eye height: this is what a hunter walking past would see.",
  doorway: "Doorway camera: the first read as someone enters the room.",
};

/** Marks the HUD elements that keep their own pointer input (see `ownsPointerEvent`). */
export const FORGE_UI_ATTRIBUTE = "data-forge-ui";
const FORGE_UI_SELECTOR = `[${FORGE_UI_ATTRIBUTE}]`;

export class ForgeController {
  readonly camera: THREE.PerspectiveCamera;

  private readonly scene: THREE.Scene;
  private readonly canvas: HTMLCanvasElement;
  private readonly bag = new DisposalBag();
  private readonly audio = new AudioPlayer();
  private readonly sprayAudio = new LoopingSoundVoice("paint_stroke", { volume: 0.32 });
  private readonly manipulationAudio = new LoopingSoundVoice("servo_move", { volume: 0.24 });
  private manipulationAudioTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly mimic = new MimicVisual();
  private readonly handleGroup = new THREE.Object3D();
  private readonly handles: readonly Handle[];
  private readonly handleMeshes: readonly THREE.Mesh[];
  private readonly roomObjects: readonly THREE.Object3D[];
  /**
   * The subset of the room an anchor may be sealed to: everything except the
   * other creatures standing in it.
   *
   * A `DisguiseTheatre` builds its bodies before the hunt and parks them in the
   * scene, so by the time the Forge captures its room they are children of it
   * like any prop, with named meshes of their own. An anchor stores a surface by
   * name and resolves it again next time the disguise is loaded, so an anchor
   * that named `mimic_torso_upper` would seal a hand to whichever body happened
   * to be holding that name — or, having been parked twenty metres under the
   * boards, to nothing at all. The eyedropper still reads the full room, because
   * copying a colour off a peer's disguise is a fair thing to do (§MECCHA).
   */
  private readonly anchorObjects: readonly THREE.Object3D[];
  private readonly workspace: ForgeWorkspace;
  /**
   * The map's own geometry, or null in the practice room. The camera reads its
   * blockers to keep the boom out of the floor and the furniture, which is the
   * same query the Inspector's rig makes of the same data.
   */
  private readonly navData: NavData | null;
  /** Null when the map published no walkable geometry to run the body over. */
  private readonly locomotion: HiderLocomotion | null;

  /** True while the hider's body is riding a grapple pull (2026-08-04 foley). */
  get grappleActive(): boolean {
    return this.locomotion !== null && this.locomotion.motion.grappleState !== null;
  }

  /**
   * The owner's view of their own taunt: the theatre animates everyone else's
   * copy of the disguise, and this shakes the one the Forge is drawing.
   */
  tauntFlourish(): void {
    this.gaitRig.settle();
  }
  private readonly onGrapple: ((target: Vec3Like) => void) | null;
  private readonly grappleVisual: GrappleVisual;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly commands = new ForgeCommandStack();
  private readonly pose: PoseState = createPoseState();
  private readonly targets = new Map<IkTargetName, CoreVector3>();
  private readonly pinned = new Set<IkTargetName>();
  private readonly listeners = new Set<(state: ForgeHudState) => void>();

  private readonly paintMeshes: readonly THREE.Object3D[];
  private readonly visiblePaintMeshes: THREE.Object3D[] = [];
  private readonly paintPickTargets: THREE.Object3D[] = [];
  private readonly paintTool: PaintTool;
  /**
   * How a recorded paint command reaches the brushwork. The tool is built in the
   * constructor and these are only ever called from a command, long after, so
   * reading it through `this` here is safe and keeps the commands free of any
   * knowledge of the atlas.
   */
  private readonly paintHistory: PaintHistoryTarget = {
    reapplyBatch: (batch) => {
      this.paintTool.reapplyBatch(batch);
    },
    revertBatch: (batch) => {
      this.paintTool.revertBatch(batch);
    },
    restoreLog: (strokes) => {
      this.paintTool.restoreLog(strokes);
    },
    clearPaint: () => {
      this.paintTool.clearSilently();
    },
  };

  private state: DisguiseState;
  private arrangementPreviewOriginal: DisguiseState | null = null;
  private arrangementPreviewStatus = "";
  private arrangementPreviewIndex = 0;
  private previewArrangementId: StarterArrangementId | null = null;
  private readonly arrangementUndoIds: StarterArrangementId[] = [];
  private readonly gamepadMoveKeys = new Set<string>();
  private gamepadPreviousToolHeld = false;
  private gamepadNextToolHeld = false;
  private gamepadMirrorHeld = false;
  private gamepadGrappleHeld = false;
  private gamepadToolActionHeld: InputAction | null = null;
  private lockedPayload: LockedDisguise | null = null;

  /**
   * The point the shot turns about. It is derived from the body every frame
   * rather than accumulated, so nothing that moves the creature — a walk, a
   * pelvis drag, an undo, an anchor hauling the root onto a shelf — can leave
   * the camera turning about a place the creature no longer is.
   */
  private readonly orbitTarget = new THREE.Vector3();
  private yaw = 0.7;
  private pitch = 0.22;
  private radius = CAMERA_START_RADIUS;
  private viewportWidth = 1;
  private viewportHeight = 1;

  private mode: ForgeToolMode = "pose";
  private toolsActive = true;
  private mirror = false;
  private locked = false;
  // The tool column prints all five keys on ivory caps beside their names, so
  // reciting them here was a third copy of the same list on one screen. The
  // strip opens on the same hint switching to the pose tool would give.
  private status = "Drag a handle to pose. Drag open space to look around.";
  private sampledSwatchId: string | null = null;
  private selectedSlot = -1;
  /**
   * Every segment the resize gizmo drives (2026-08-05). Plain click selects
   * one; shift-click grows the set. `selectedSlot` stays the primary - the
   * one whose values the panel reads and whose centre carries the gizmo.
   */
  private readonly selectedSlots = new Set<number>();
  /**
   * True while the material dropper is armed (2026-08-05): F arms it, the
   * next click copies the swatch under the pointer, exactly the contract the
   * paint eyedropper keeps. Cleared by sampling, by pressing F again, and by
   * leaving the tool.
   */
  private materialDropperArmed = false;
  /** The shape the gizmo drives, and the row the object panel highlights. */
  private selectedShapeId: string | null = null;
  /**
   * The highest shape number handed out this session, which never falls.
   *
   * Ids double as material slots and paint tiles, so reusing one gives a fresh
   * shape the last occupant's colour and strokes - which is what made a
   * deleted drawing "come back" the moment a new one was made.
   */
  private shapeIdFloor = 0;
  /** Whether a drawn outline closes into a slab or stands as the line itself. */
  private fillDrawings = true;
  /** The shape under the press, selected only if the pointer never sweeps. */
  private pendingShapeSelect: string | null = null;
  private shapeOutline: THREE.LineSegments | null = null;
  private strokeTrace: THREE.Line | null = null;
  private shapeDraw: {
    /** Every sample, in world space, exactly as the hand made it. */
    points: THREE.Vector3[];
    /** The plane's own axes, so a sweep can be read back as a flat outline. */
    right: THREE.Vector3;
    up: THREE.Vector3;
    origin: THREE.Vector3;
  } | null = null;
  private drawProfileId: ShapeProfileId = "cube";
  /** Paint's own colour reader, for surfaces that declare no swatch. */
  private materialEyedropper: Eyedropper | null = null;
  private resizeGizmo: THREE.Group | null = null;
  /** Brass outline per selected part, so multi-select is visible on the body. */
  private readonly selectionOutlines = new Map<number, THREE.LineSegments>();
  private selectionOutlineMaterial: THREE.LineBasicMaterial | null = null;
  private readonly selectionBox = new THREE.Box3();
  /**
   * The part under the cursor (2026-08-06): a soft box on whatever a click
   * would act on - select in Shape, paint in Material, grab in Pose - so
   * the body itself says where clicking means something.
   */
  private hoveredSlot = -1;
  private hoverOutline: THREE.LineSegments | null = null;
  /** The socket stud under the cursor while the panel tool is up. */
  private hoveredSocket: PanelSocketName | null = null;
  private gizmoArrows: Array<{
    key: "width" | "length" | "depth";
    dir: THREE.Vector3;
    pick: THREE.Object3D;
  }> = [];
  private gizmoDrag: {
    key: "width" | "length" | "depth";
    dir: THREE.Vector3;
    origin: THREE.Vector3;
    startT: number;
    startValues: Map<number, number>;
    before: Map<number, SegmentFormState>;
    /**
     * Set while the gizmo is moving a built shape rather than resizing the
     * body. A shape arrives at its bone's origin, so without this the only
     * thing a player could do with one is delete it again.
     */
    shape: {
      id: string;
      start: [number, number, number];
      startRotation: [number, number, number, number];
      startScale: [number, number, number];
      /**
       * What the drag is doing to this shape.
       *
       * One set of arrows carries all three transforms, chosen by modifier,
       * so a player never leaves the shape they are holding to find a mode
       * switch: bare drag slides, Shift turns, Alt stretches.
       */
      mode: "move" | "turn" | "scale" | "uniform";
    } | null;
  } | null = null;
  private selectedSocket: PanelSocketName | null = null;
  private formEpoch = 0;
  private arrangementIndex = 0;
  private quickShapeIndex = 0;
  private quickPanelIndex = 0;

  private readonly anchorLookup = new Map<string, THREE.Object3D>();
  private readonly anchorTargets = new Map<string, CoreVector3>();
  private readonly resolvedAnchorPool = new Map<string, ResolvedAnchor>();
  private readonly resolvedAnchors = new Map<string, ResolvedAnchor>();
  private readonly previewAnchor = createResolvedAnchor();
  private anchorMarkerGeometry: THREE.BufferGeometry | null = null;
  private panelTipGeometry: THREE.BufferGeometry | null = null;
  private panelTipMaterial: THREE.MeshPhysicalMaterial | null = null;
  private readonly anchorResiduals = new Map<string, number>();
  private readonly anchorMarkers = new Map<string, THREE.Mesh>();
  private anchorMarkerMaterials: {
    readonly sealed: THREE.MeshPhysicalMaterial;
    readonly strained: THREE.MeshPhysicalMaterial;
    readonly preview: THREE.MeshBasicMaterial;
  } | null = null;
  private readonly heldPanelAnchors: PanelSocketName[] = [];
  private draggedPanelSocket: PanelSocketName | null = null;
  private snapCandidate: AnchorCapture | null = null;
  private snapping = false;
  private preview: ForgePreviewMode = "none";
  private silhouette = false;
  private silhouetteMaterial: THREE.MeshStandardMaterial | null = null;
  private savedBackground: THREE.Scene["background"] = null;

  private hoveredHandle: Handle | null = null;
  private mirrorHoveredHandle: Handle | null = null;
  private draggedHandle: Handle | null = null;
  private dragPointerId = -1;
  private cameraDrag: "orbit" | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private poseEditBefore: PoseSnapshot | null = null;
  /** Metres per second the hunt allows the body, or null while the Forge is open. */
  private creepSpeed: number | null = null;
  /** Metres of root travel a pointer drag may still spend this frame. */
  private dragBudgetM = 0;
  /** Where the body stood when the current walk began, for one undo per walk. */
  private walkBefore: PoseSnapshot | null = null;
  /** The seals that walk broke, so undoing it puts them back. */
  private walkAnchors: readonly AnchorState[] = [];
  private readonly walkPosition = { x: 0, y: 0, z: 0 };
  private readonly bodyLanguage = new BodyLanguage();
  private readonly gaitRig = new LocomotionRig(MIMIC_GAIT_PROFILE);
  private readonly postureRotation = new THREE.Quaternion();
  private readonly postureAxis = new THREE.Vector3();
  private readonly postureRoot = new THREE.Vector3();
  private postureDip = 0;
  private readonly bodyBox = new THREE.Box3();
  private readonly boundsPosition = new THREE.Vector3();
  private readonly boundsRotation = new THREE.Quaternion();
  /** Revision `bodyBox` was measured for, so a carried body does not re-measure. */
  private boundsRevision = -1;
  /**
   * The point the camera actually looks at, which chases `orbitTarget` rather
   * than being it. A body that moves drags the frame after it with a little
   * weight instead of welding the shot to the root.
   */
  private readonly cameraTarget = new THREE.Vector3();
  private cameraBobPhase = 0;
  private segmentEdit: SegmentEdit | null = null;
  private panelEditBefore: PanelState | null = null;
  private panelEditSocket: PanelSocketName | null = null;
  private panelMirrorEditBefore: PanelState | null = null;
  private panelMirrorEditSocket: PanelSocketName | null = null;
  /**
   * Continuous controls may deliver several DOM events between rendered game
   * frames. Keep their newest value, then do the expensive solve/layout once
   * on the frame clock instead of building a backlog behind the pointer.
   */
  private pendingValueRefresh: "none" | "refresh" | "solve" = "none";
  private pointerGestureDirty = false;

  private readonly dragPlane = new THREE.Plane();
  private readonly dragOffset = new THREE.Vector3();
  private readonly scratchVector = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly mirrorScratch = new THREE.Vector3();
  private readonly mirrorRotation = new THREE.Quaternion();
  private readonly scratchProbeOrigin = new THREE.Vector3();
  private readonly contactParentInverse = new THREE.Quaternion();
  private readonly contactLocal = new THREE.Quaternion();
  private readonly panelHinge = new THREE.Vector3();
  private readonly panelHingeRotation = new THREE.Quaternion();
  private readonly panelTip = new THREE.Vector3();
  private readonly resolvedPanelScratch = createResolvedPanel();
  private readonly panelDragTarget = new THREE.Vector3();
  private readonly panelTipHandles = new Map<string, THREE.Mesh>();
  private panelDragBefore: PanelState | null = null;
  private panelDragAnchorBefore: AnchorState | null = null;
  private panelSnapCandidate: AnchorCapture | null = null;
  private readonly scratchForward = new THREE.Vector3();

  constructor(options: ForgeControllerOptions) {
    this.scene = options.scene;
    this.canvas = options.canvas;
    this.onGrapple = options.onGrapple ?? null;
    this.grappleVisual = new GrappleVisual(options.scene);
    this.roomObjects = [...options.scene.children];
    this.anchorObjects = this.roomObjects.filter(
      (object) => object.userData[MIMIC_BODY_TAG] !== true,
    );
    this.workspace = options.workspace ?? TEST_ROOM_WORKSPACE;
    this.navData = options.navData ?? null;
    this.locomotion =
      options.navData === undefined ? null : new HiderLocomotion(options.navData);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 60);

    const origin = options.origin ?? new THREE.Vector3(-1.55, 0.075, -1.05);
    this.state = createStarterArrangement("upright");
    this.state.root.position = [origin.x, origin.y, origin.z];
    this.state.materials = [{ slotId: BODY_SLOT_ID, swatchId: DEFAULT_BODY_SWATCH_ID }];
    applyDisguiseStateToPose(this.state, this.pose);

    this.handleGroup.name = "forge_handles";
    this.handles = this.buildHandles();
    this.handleMeshes = this.handles.map((handle) => handle.pick);
    this.buildAnchorMarkerAssets();
    this.scene.add(this.mimic.root);
    this.scene.add(this.handleGroup);
    this.indexAnchorSurfaces();

    // Built shapes are paintable too, and they stand in front of the body, so
    // a brush stroke aimed at a jar lands on the jar rather than on the arm
    // behind it. Only the first eight own an atlas tile - the ones the retired
    // panels left - and a stroke on a shape without one is refused by the
    // target lookup rather than painted onto somebody else's tile.
    this.paintMeshes = [
      ...this.mimic.shapeMeshes,
      ...this.mimic.segmentMeshes,
      ...this.mimic.panelMeshes,
    ];
    this.paintTool = createPaintTool({
      canvas: this.canvas,
      camera: this.camera,
      raycaster: this.raycaster,
      getMimicMeshes: () => this.paintableMeshes(),
      // The eyedropper reads the room as well as the body: copying a shelf's own
      // colour onto a panel is the whole point of the MECCHA dropper.
      getPickTargets: () => {
        this.paintPickTargets.length = 0;
        this.paintPickTargets.push(...this.paintableMeshes(), ...this.roomObjects);
        return this.paintPickTargets;
      },
      setCastShadow: (enabled) => {
        this.mimic.setCastShadow(enabled);
      },
      onStrokeStart: () => {
        const flow = this.paintTool?.getState().opacity ?? 1;
        this.sprayAudio.start(0.28 + flow * 0.35, 0.96);
      },
      onStrokeUpdate: (speedPxPerSecond) => {
        const motion = Math.min(1, speedPxPerSecond / 1_100);
        const flow = this.paintTool?.getState().opacity ?? 1;
        this.sprayAudio.update((0.22 + motion * 0.5) * (0.4 + flow * 0.6), 0.94 + motion * 0.2);
      },
      onStrokeEnd: () => this.sprayAudio.stop(),
      onSample: (picked) => {
        this.audio.play(picked ? "eyedropper_pick" : "ui_deny");
      },
      // Paint joins the same history as the pose, so Ctrl+Z after a brush stroke
      // takes back the brush stroke. Both are recorded rather than applied: the
      // brush painted the drag as the pointer moved and the clear already threw
      // the log away, so the history only has to remember how to undo them.
      onStrokeBatch: (batch) => {
        this.commands.pushApplied(
          createPaintStrokeCommand(this.paintHistory, batch, performance.now()),
          this.state,
        );
        this.emit();
      },
      onClear: (cleared) => {
        if (cleared.length === 0) return;
        this.commands.pushApplied(
          createPaintClearCommand(this.paintHistory, cleared, performance.now()),
          this.state,
        );
        this.emit();
      },
      ownsPointerEvent: (event) => this.ownsPointerEvent(event),
      expandStroke: (stroke) => {
        if (!this.mirror) return [stroke];
        const target = mirroredPaintTarget(stroke.segmentId);
        return target === null ? [stroke] : [stroke, { ...stroke, segmentId: target }];
      },
    });

    this.syncOrbitTarget();
    // The shot starts where the body is rather than chasing it in from the last
    // one: an opening frame has nothing to catch up with.
    this.cameraTarget.copy(this.orbitTarget);
    this.updateCamera();
    this.applyQuality(options.quality);
    this.captureTargets();
    this.refreshAll(true);
    this.attachInput();
    this.writeMovementDiagnostics();
  }

  /** A brass seal for a met anchor, a warm red for one the pose cannot reach. */
  private buildAnchorMarkerAssets(): void {
    // A seal marker sits on the body, so it is sized against the body. Left at
    // 0.034 m it was a 68 mm disc on a 350 mm creature, which is most of a hand.
    this.anchorMarkerGeometry = this.bag.add(
      createPuckGeometry(0.03 * RIG_TO_WORLD, 0.009 * RIG_TO_WORLD),
    );
    // A panel tip is dragged, not just displayed, so it gets a real handle
    // rather than the flat seal disc (§24.5: large, readable, grabbable).
    this.panelTipGeometry = this.bag.add(new THREE.SphereGeometry(1, 16, 12));
    this.panelTipMaterial = this.bag.add(
      new THREE.MeshPhysicalMaterial({
        color: 0xd8b071,
        roughness: 0.3,
        metalness: 0.75,
        emissive: new THREE.Color(0x6a4a18),
        emissiveIntensity: 0.4,
      }),
    );
    this.anchorMarkerMaterials = {
      sealed: this.bag.add(
        new THREE.MeshPhysicalMaterial({
          color: 0xb08a4a,
          roughness: 0.3,
          metalness: 0.9,
          emissive: new THREE.Color(0x3a2a10),
        }),
      ),
      strained: this.bag.add(
        new THREE.MeshPhysicalMaterial({
          color: 0xa8412f,
          roughness: 0.45,
          metalness: 0.2,
          emissive: new THREE.Color(0x4a1008),
        }),
      ),
      preview: this.bag.add(
        new THREE.MeshBasicMaterial({ color: 0xf0e0c0, transparent: true, opacity: 0.55 }),
      ),
    };
  }

  // --- Frame ---------------------------------------------------------------

  update(dtMs = 0): void {
    this.stepGamepadInput();
    this.refreshCreepBudget(dtMs);
    this.flushPointerGesture();
    this.flushPendingValueRefresh();
    this.stepLocomotion(dtMs);
    this.writeMovementDiagnostics();
    this.stepBodyMotion(dtMs / 1_000);
    this.stepGrappleVisual(dtMs / 1_000);
    this.stepCameraFollow(dtMs / 1_000);
    this.layoutHandles();
    // Cheap when nothing was painted: a reference check per part and an upload
    // only while the atlas is dirty.
    this.paintTool.update();
  }

  /**
   * Keeps browser-level traversal checks on the render surface rather than in
   * React state. Walking redraws every frame but deliberately does not rerender
   * the HUD every frame; canvas data therefore reports the live controller
   * without turning diagnostics into input lag.
   */
  private writeMovementDiagnostics(): void {
    const dataset = (this.canvas as HTMLCanvasElement & { dataset?: DOMStringMap }).dataset;
    if (dataset === undefined) return;
    dataset["hiderVisualId"] = MIMIC_VISUAL_ID;
    const locomotion = this.locomotion;
    if (locomotion === null) {
      delete dataset["hiderPosition"];
      delete dataset["hiderFacingYaw"];
      delete dataset["hiderTravelYaw"];
      delete dataset["hiderSpeed"];
      delete dataset["hiderClimbing"];
      delete dataset["hiderGrounded"];
      delete dataset["hiderGrappling"];
      return;
    }
    const rotation = this.pose.rootRotation;
    const faceX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
    const faceZ = 1 - 2 * (rotation.x * rotation.x + rotation.y * rotation.y);
    const sample = locomotion.sample;
    dataset["hiderPosition"] = [
      this.pose.rootPosition.x,
      this.pose.rootPosition.y,
      this.pose.rootPosition.z,
    ].join(",");
    dataset["hiderFacingYaw"] = String(Math.atan2(-faceX, -faceZ));
    dataset["hiderTravelYaw"] = String(sample.travelYaw);
    dataset["hiderSpeed"] = String(sample.speedFraction);
    dataset["hiderClimbing"] = String(locomotion.motion.climbState !== null);
    dataset["hiderGrounded"] = String(locomotion.motion.grounded);
    dataset["hiderGrappling"] = String(locomotion.grappling);
  }

  /**
   * Caps the body at the hunt's creep speed, or hands it back the Forge run with
   * null. The authority validates every root move against `hiderCreepSpeed`
   * once a disguise has manifested, and a client that predicted faster than that
   * would show its owner a body the room does not agree is there until the next
   * accepted pose, so the same cap is applied here.
   */
  setCreepLimit(metresPerSecond: number | null): void {
    this.locomotion?.setCreepLimit(metresPerSecond);
    if (this.creepSpeed === metresPerSecond) return;
    this.creepSpeed = metresPerSecond;
    this.dragBudgetM = 0;
  }

  /**
   * Hands the pointer the metres it may move the body by this frame.
   *
   * The walk keys are capped by `CharacterController`, which clamps its velocity
   * to the creep speed every frame; a drag has no velocity to clamp, so it is
   * given the same allowance frame by frame instead. Nothing is banked while the
   * pointer is idle, which makes this stricter than the authority — it measures
   * from the last pose it accepted, so a body that sat still is owed every
   * second of it — and a rule that is never looser cannot produce the refusal
   * this exists to prevent. A frame that overspent, which is what a snap onto a
   * surface does, carries its debt forward instead of being forgiven.
   */
  private refreshCreepBudget(dtMs: number): void {
    if (this.creepSpeed === null) {
      this.dragBudgetM = 0;
      return;
    }
    this.dragBudgetM = Math.min(this.dragBudgetM, 0) + (this.creepSpeed * dtMs) / 1_000;
  }

  /**
   * Holds a root drag inside the frame's creep budget, in place. Only the pelvis
   * handle is limited: it is the one whose target the solver writes straight
   * into the root (`applyPelvisTarget`), and reshaping a limb during the hunt
   * moves nothing the authority measures.
   */
  private limitRootDrag(from: CoreVector3, to: THREE.Vector3): void {
    if (this.creepSpeed === null) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const budget = Math.max(0, this.dragBudgetM);
    if (distance <= budget) return;
    const scale = budget / distance;
    to.set(from.x + dx * scale, from.y + dy * scale, from.z + dz * scale);
  }

  /** Charges the budget with the ground the solved root actually covered. */
  private spendCreepBudget(fromX: number, fromY: number, fromZ: number): void {
    if (this.creepSpeed === null) return;
    const root = this.pose.rootPosition;
    const dx = root.x - fromX;
    const dy = root.y - fromY;
    const dz = root.z - fromZ;
    this.dragBudgetM -= Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * True while the body is off the ground, mid-hop or mid-fall. The round holds
   * its pose publication until it lands: an airborne pose is a moment rather
   * than a place, and during the hunt the apex of a hop sits further from the
   * last accepted pose than the creep cap allows.
   */
  get bodyAirborne(): boolean {
    return this.locomotion?.airborne ?? false;
  }

  /**
   * How the body is travelling, for the footstep driver. Null in a Forge built
   * without nav data, which is the practice room: there are no surfaces there to
   * have a sound.
   */
  get bodyMotion(): CharacterController | null {
    return this.locomotion?.motion ?? null;
  }

  /**
   * World bounds of the body as posed, which is the box the authority shoots at.
   *
   * The round needs this because the theatre does not draw the viewer's own
   * disguise while the Forge is holding it, and a disguise nothing is drawing has
   * no bounds to be accused of occupying. Without it the owner is the one player
   * in the room who cannot be hit, and on Portals the elected host is a player
   * holding the authority that refuses the shot.
   *
   * It is measured with the body language switched off, for the same reason the
   * body language never reaches the wire: every other client computes this box
   * from the published pose, and a box that leaned with the run would be one only
   * its owner agreed with. The result is cached against the disguise revision, so
   * a body that is merely carrying itself does not re-measure, and a body that
   * was actually re-posed does.
   */
  get bodyBounds(): AABB | null {
    this.flushPendingValueRefresh();
    if (this.boundsRevision !== this.state.revision) {
      this.boundsRevision = this.state.revision;
      this.measureBodyBounds();
    }
    return this.bodyBox.isEmpty() ? null : this.bodyBox;
  }

  private measureBodyBounds(): void {
    const root = this.mimic.root;
    this.boundsRotation.copy(root.quaternion);
    this.boundsPosition.copy(root.position);
    root.quaternion.identity();
    root.position.set(0, 0, 0);
    // And on the authored limbs, not the striding ones. The gait is as
    // cosmetic as the lean and reaches the box the same way if it is left on:
    // an owner mid-step would be shootable where their swinging arm is rather
    // than where every peer computes it from the pose they published.
    const striding = !this.gaitRig.neutral;
    if (striding) this.mimic.applyPose(this.pose);
    this.bodyBox.setFromObject(root);
    if (striding) this.applyPoseToVisual();
    root.quaternion.copy(this.boundsRotation);
    root.position.copy(this.boundsPosition);
    // `setFromObject` left every part's world matrix computed against the
    // identity it was measured under. Put them back, or the frame that asked for
    // the bounds draws and picks an unleaning body.
    root.updateWorldMatrix(false, true);
  }

  /**
   * Runs the walk keys. Locomotion writes the same root a handle drag writes and
   * goes out through the same pose snapshot, so the authority cannot tell a
   * Mimic that walked from a Mimic that was dragged.
   *
   * The camera keeps whatever angle and distance the player left it at and its
   * orbit point simply travels with the body, so posing and moving are the same
   * view rather than two modes: whenever a walk key is down the body moves, and
   * whenever a handle is dragged the body is posed.
   */
  private stepLocomotion(dtMs: number): void {
    const locomotion = this.locomotion;
    if (locomotion === null || this.locked) return;

    const wasWalking = locomotion.moving;
    this.walkPosition.x = this.pose.rootPosition.x;
    this.walkPosition.y = this.pose.rootPosition.y;
    this.walkPosition.z = this.pose.rootPosition.z;
    const moved = locomotion.update(dtMs / 1_000, this.yaw, this.walkPosition);

    if (!moved) {
      if (wasWalking && !locomotion.moving) this.endWalk();
      return;
    }
    if (this.walkBefore === null) this.beginWalk();

    this.turnAuthoredPoseTowardTravel(dtMs / 1_000);

    const x = clamp(this.walkPosition.x, this.workspace.minX, this.workspace.maxX);
    const z = clamp(this.walkPosition.z, this.workspace.minZ, this.workspace.maxZ);
    // The play volume's floor bound is a guard for the pointer, which can shove
    // a body down through the boards; a body that walked is standing on a
    // surface the map published, so the map decides its height. Applying the
    // bound here would lift a walking body off the floor by the guard's own
    // margin and then fight the controller for it every frame.
    const y = Math.min(this.walkPosition.y, this.workspace.maxY);
    if (x !== this.walkPosition.x || y !== this.walkPosition.y || z !== this.walkPosition.z) {
      // Every walkable surface lies inside the room's own faces, so this is the
      // map contradicting itself. Stop the walk at the boundary rather than
      // letting the body and the controller steering it drift apart.
      locomotion.releaseAll();
    }

    const dx = x - this.pose.rootPosition.x;
    const dy = y - this.pose.rootPosition.y;
    const dz = z - this.pose.rootPosition.z;

    // The IK targets are world positions, so a body that walked away from them
    // would be solved back toward where it was standing: a hand posed onto a
    // shelf would stretch across the shop after it, and a pinned pelvis would
    // simply undo the step. The pose travels with the body.
    for (const target of this.targets.values()) {
      target.set(target.x + dx, target.y + dy, target.z + dz);
    }
    this.pose.rootPosition.set(x, y, z);
    // The camera is not placed here, and neither is its orbit point.
    // `stepCameraFollow` runs later in the same frame, reads the point off the
    // body it now finds, and moves the shot toward it with some weight, rather
    // than the shot being welded to the body every step it takes.
    // Re-solves and re-captures the disguise, which is what advances the
    // revision the round publishes.
    this.solveAndRefresh();
  }

  /** Fires toward the cursor, or releases the active cable on a second press. */
  private toggleGrapple(): void {
    const locomotion = this.locomotion;
    const navData = this.navData;
    if (locomotion === null || navData === null || this.locked) return;
    this.walkPosition.x = this.pose.rootPosition.x;
    this.walkPosition.y = this.pose.rootPosition.y;
    this.walkPosition.z = this.pose.rootPosition.z;
    const active = locomotion.motion.grappleState;
    if (active !== null) {
      locomotion.toggleGrapple(active.anchor, this.walkPosition, this.yaw);
      this.audio.play("wallstick_release", 0.03, 0.65);
      return;
    }
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const target = grappleTargetFromRay(navData, this.raycaster.ray.origin, this.raycaster.ray.direction);
    if (target === null) {
      this.audio.play("ui_deny", 0, 0.4);
      return;
    }
    if (!locomotion.toggleGrapple(target, this.walkPosition, this.yaw)) return;
    this.onGrapple?.(target);
    this.audio.play("climb_grab", 0.05, 0.8);
  }

  /** Runs after body motion so the cable begins at the visible right hand. */
  private stepGrappleVisual(dtSeconds: number): void {
    const anchor = this.locomotion?.motion.grappleState?.anchor ?? null;
    if (anchor === null) {
      this.grappleVisual.update(this.pose.rootPosition, null, dtSeconds);
      return;
    }
    updateWorldTransforms(this.pose);
    const hand = this.pose.worldPositions[boneIndex("hand_R")] ?? this.pose.rootPosition;
    this.grappleVisual.update(hand, anchor, dtSeconds);
  }

  /**
   * Turns the authored disguise and its world-space IK targets together. The
   * gait can lean and step cosmetically, but yaw must travel on the wire or
   * every peer sees the creature moon-walk sideways.
   */
  private turnAuthoredPoseTowardTravel(dtSeconds: number): void {
    const locomotion = this.locomotion;
    if (locomotion === null || dtSeconds <= 0 || locomotion.sample.speedFraction <= 0) return;

    // The Mimic rig's authored face is +Z (`mimic/rig.ts`). The character
    // controller uses Three's camera heading convention where yaw 0 travels
    // toward -Z, so an identity-authored Mimic is facing *backward* in that
    // convention. Reading -Z here made those two conventions look identical
    // and left the creature moonwalking exactly 180 degrees away from travel.
    this.scratchForward.set(0, 0, 1).applyQuaternion(this.pose.rootRotation);
    this.scratchForward.y = 0;
    if (this.scratchForward.lengthSq() < 1e-8) return;
    this.scratchForward.normalize();

    const currentYaw = Math.atan2(-this.scratchForward.x, -this.scratchForward.z);
    const wantedYaw = locomotion.sample.travelYaw;
    const rate = this.creepSpeed === null
      ? FORGE_TURN_RATE_RAD_PER_SECOND
      : CREEP_TURN_RATE_RAD_PER_SECOND;
    const limit = rate * dtSeconds;
    const delta = clamp(shortestAngle(wantedYaw - currentYaw), -limit, limit);
    if (Math.abs(delta) < 1e-6) return;

    this.scratchQuaternion.setFromAxisAngle(this.postureAxis.set(0, 1, 0), delta);
    this.pose.rootRotation.premultiply(this.scratchQuaternion).normalize();
    const root = this.pose.rootPosition;
    for (const target of this.targets.values()) {
      this.scratchVector
        .set(target.x - root.x, target.y - root.y, target.z - root.z)
        .applyQuaternion(this.scratchQuaternion)
        .add(root);
      target.set(this.scratchVector.x, this.scratchVector.y, this.scratchVector.z);
    }
  }

  /**
   * Lays the creature's body language over the authored pose: the lean into a
   * run, the bank into a turn, the crouch of a creep, the reach of a climb, and
   * the compression of a landing.
   *
   * It is applied as a transform on the two groups the body hangs off rather
   * than as an edit to the pose, which is what keeps it cosmetic. `this.pose`
   * and `this.state` never see it, so `disguise` — the thing the round publishes
   * — is identical for a body mid-stride and a body standing still at the same
   * root. `movementFeel.test.ts` asserts exactly that.
   *
   * Rotating about the body's own root leaves the root where the player
   * authored it, so of the three channels only the dip moves the creature at
   * all, and the dip returns to exactly zero.
   *
   * A locked disguise gets none of it. An anonymized object that breathes on the
   * shelf tells an Inspector which of the six vases is a player, which is a
   * worse giveaway than any pose mistake the Forge could make.
   */
  private stepBodyMotion(dtSeconds: number): void {
    const locomotion = this.locomotion;
    if (locomotion === null) return;
    // A locked disguise, and a body being authored, both stand exactly as posed:
    // a handle is dragged to a place on the body, so the body has to be at the
    // place the pose says it is while the player is reaching for it. A locked
    // one has a second reason — an anonymized object that breathes on the shelf
    // tells an Inspector which of the six vases is a player.
    const suppressed = this.locked || this.authoring();
    if (suppressed) {
      if (!this.bodyLanguage.neutral) {
        this.bodyLanguage.reset();
        this.applyPosture(this.bodyLanguage.posture);
      }
    } else {
      this.applyPosture(this.bodyLanguage.update(dtSeconds, locomotion.sample));
    }
    // The gait eases out rather than being cut, because the pose handles are
    // laid out on the body as it is drawn: cutting it would move a grip out
    // from under the pointer that was reaching for it.
    if (!suppressed || !this.gaitRig.neutral) {
      this.gaitRig.update(dtSeconds, locomotion.sample, locomotion.motion.speed, suppressed);
      this.applyPoseToVisual();
    }
    // Grapple anticipation (2026-08-04): the body coils as the cable bites,
    // through the same settle spring the lock flourish rides.
    const grappling = locomotion.motion.grappleState !== null;
    if (grappling && !this.wasGrappling) this.gaitRig.settle();
    this.wasGrappling = grappling;
  }

  /** Whether the body rode a grapple last frame, for the anticipation coil. */
  private wasGrappling = false;

  /**
   * Draws the body wearing this frame's gait. The rig hands back the authored
   * pose itself while it is neutral, so a locked or hand-posed body is drawn
   * from exactly the state the player authored and nothing is copied at all.
   */
  private applyPoseToVisual(): void {
    this.mimic.applyPose(this.gaitRig.pose(this.pose));
  }

  /** Where a bone is as the body is carrying it, gait included. */
  private drawnBonePosition(index: number): Vec3Like | undefined {
    return this.gaitRig.pose(this.pose).worldPositions[index];
  }

  /** True while the pointer is on the body rather than steering it. */
  private authoring(): boolean {
    return (
      this.hoveredHandle !== null ||
      this.draggedHandle !== null ||
      this.draggedPanelSocket !== null ||
      this.heldPanelAnchors.length > 0
    );
  }

  /**
   * Writes the posture onto the Mimic. Its parts are placed at world positions,
   * so the transform has to rotate about the body's own root rather than about
   * the origin, which is what keeps the creature's feet where the pose put them.
   *
   * Only the Mimic carries it. The handle group holds three different kinds of
   * thing — pose grips on the body, seal markers on the map surfaces a disguise
   * is anchored to, and panel tips already read through the Mimic's own
   * transform — and only the first of those should lean with the creature.
   * `layoutHandles` applies the posture to those one at a time instead.
   */
  private applyPosture(posture: BodyPosture): void {
    const yaw = this.locomotion?.sample.travelYaw ?? 0;
    // Travel direction on three's convention, and the horizontal axis square to
    // it: tipping about the second one leans the body along the first.
    const travelX = -Math.sin(yaw);
    const travelZ = -Math.cos(yaw);
    this.postureRotation
      .setFromAxisAngle(this.postureAxis.set(travelZ, 0, -travelX), posture.leanRad)
      .multiply(
        this.scratchQuaternion.setFromAxisAngle(
          this.postureAxis.set(travelX, 0, travelZ),
          posture.bankRad,
        ),
      );
    this.postureDip = posture.dipM;

    const root = this.pose.rootPosition;
    this.postureRoot.set(root.x, root.y, root.z);
    this.mimic.root.quaternion.copy(this.postureRotation);
    this.mimic.root.position
      .copy(this.postureRoot)
      .sub(this.scratchVector.copy(this.postureRoot).applyQuaternion(this.postureRotation));
    this.mimic.root.position.y -= this.postureDip;
  }

  /** Carries an authored point onto the body as it is actually being held. */
  private toPosturedWorld(point: Vec3Like, out: THREE.Vector3): THREE.Vector3 {
    out
      .set(point.x, point.y, point.z)
      .sub(this.postureRoot)
      .applyQuaternion(this.postureRotation)
      .add(this.postureRoot);
    out.y -= this.postureDip;
    return out;
  }

  /**
   * Puts the orbit point back on the creature's chest. Just over halfway up the
   * body height keeps the head clear of the top of the frame, and reading it off
   * the root each frame is what makes the shot turn about the creature however
   * the creature came to be there.
   *
   * A handle drag is the one thing it sits out. The pointer moves the body along
   * a plane fixed to the view, so a camera that chased the body mid-drag would
   * move the plane the drag is being measured on and the two would push each
   * other across the room. It resyncs on release, and the follow lag glides the
   * shot back rather than cutting to it.
   */
  private syncOrbitTarget(): void {
    if (this.draggedHandle !== null) return;
    const root = this.pose.rootPosition;
    this.orbitTarget.set(
      root.x,
      root.y + WORLD_SCALE.playerHeight * ORBIT_TARGET_BODY_SHARE,
      root.z,
    );
  }

  /**
   * Moves the shot toward the orbit point, adds the walk bob, and lets the
   * camera feel the landing the body just took. The bob is quoted against body
   * height with the same constants the Inspector's own rig uses, so the two
   * cameras breathe at one rate rather than at two.
   */
  private stepCameraFollow(dtSeconds: number): void {
    this.syncOrbitTarget();
    if (this.preview !== "none") {
      this.cameraTarget.copy(this.orbitTarget);
      this.updateCamera();
      return;
    }
    if (dtSeconds > 0) {
      const gap = this.cameraTarget.distanceTo(this.orbitTarget);
      if (gap <= CAMERA_FOLLOW_SNAP_M) {
        this.cameraTarget.copy(this.orbitTarget);
      } else {
        this.cameraTarget.lerp(this.orbitTarget, 1 - Math.exp(-CAMERA_FOLLOW_RATE * dtSeconds));
      }
      const speed = this.locomotion?.motion.speed ?? 0;
      this.cameraBobPhase += speed * dtSeconds * CAMERA_BOB_RATE_RAD_PER_M;
    }
    this.updateCamera();
  }

  /** Vertical offset the shot carries this frame: the walk bob and the landing. */
  private cameraSway(): number {
    if (this.locomotion === null) return 0;
    const moving = this.locomotion.moving && !this.locomotion.airborne;
    const bob = moving ? Math.sin(this.cameraBobPhase) * CAMERA_BOB_AMPLITUDE_M : 0;
    return bob - this.bodyLanguage.posture.dipM * CAMERA_LANDING_ECHO_SHARE;
  }

  /**
   * Opens a walk. Walking away breaks every seal the body had: left in place,
   * the anchor pass in `solveAndRefresh` would haul the root straight back to
   * the surface the player just walked off.
   */
  private beginWalk(): void {
    this.commitEdits();
    this.walkBefore = capturePoseSnapshot(this.state);
    this.walkAnchors = this.state.anchors;
    if (this.state.anchors.length === 0) return;

    for (const anchor of this.state.anchors) {
      if (isAnchorableBone(anchor.bone)) this.pinned.delete(anchorTargetName(anchor.bone));
    }
    this.state.anchors = [];
    this.emit();
  }

  /** Closes a walk as one undo entry: where the body went, and what it let go. */
  private endWalk(): void {
    const before = this.walkBefore;
    const released = this.walkAnchors;
    this.walkBefore = null;
    this.walkAnchors = [];
    if (before === null) return;

    capturePoseToDisguiseState(this.pose, this.state);
    const after = capturePoseSnapshot(this.state);
    const issuedAt = performance.now();
    const parts: ForgeCommand[] = [];
    if (!poseSnapshotsEqual(before, after)) {
      parts.push(createPoseCommand(before, after, issuedAt, "walk"));
    }
    for (const anchor of released) {
      parts.push(createAnchorCommand(anchor.bone, anchor, null, issuedAt));
    }

    const only = parts.length === 1 ? parts[0] : null;
    if (only !== undefined && only !== null) {
      this.commands.push(only, this.state);
    } else if (parts.length > 1) {
      this.commands.push(createCompositeCommand("walk", parts, issuedAt), this.state);
    } else {
      return;
    }
    this.emit();
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = Math.max(width, 1);
    this.viewportHeight = Math.max(height, 1);
    this.camera.aspect = this.viewportWidth / this.viewportHeight;
    this.camera.updateProjectionMatrix();
  }

  applyQuality(settings: QualitySettings): void {
    this.mimic.setCastShadow(settings.dynamicShadows);
  }

  dispose(): void {
    this.setSilhouette(false);
    // Before the Mimic goes: the binder hands each part its own material back,
    // and those belong to the Mimic's cache.
    this.paintTool.dispose();
    this.sprayAudio.dispose();
    this.stopManipulationAudio();
    this.manipulationAudio.dispose();
    this.grappleVisual.dispose();
    this.mimic.dispose();
    this.handleGroup.removeFromParent();
    this.handleGroup.clear();
    this.audio.dispose();
    this.listeners.clear();
    this.bag.dispose();
  }

  // --- HUD bridge ----------------------------------------------------------

  subscribe(listener: (state: ForgeHudState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): ForgeHudState {
    const bone = SEGMENT_BONES[this.selectedSlot];
    const form = this.pose.segments[this.selectedSlot];
    const segment: ForgeSegmentSelection | null =
      bone === undefined || form === undefined
        ? null
        : {
            slot: this.selectedSlot,
            bone,
            form: cloneSegmentForm(form),
            swatchId: resolvedSwatchFor(this.state.materials, bone, DEFAULT_BODY_SWATCH_ID),
          };
    const panelState = this.selectedSocket === null ? null : this.findPanel(this.selectedSocket);
    const lockIssues = validateDisguiseState(this.state);
    return {
      mode: this.mode,
      activeMode: this.toolsActive ? this.mode : null,
      locked: this.locked,
      mirror: this.mirror,
      canUndo: this.commands.canUndo,
      canRedo: this.commands.canRedo,
      undoLabel: this.commands.nextUndoLabel,
      segment,
      selectedCount: segment === null ? 0 : Math.max(1, this.selectedSlots.size),
      panel:
        this.selectedSocket === null
          ? null
          : {
              socketId: this.selectedSocket,
              panel: panelState === null ? null : clonePanelState(panelState),
            },
      shapes: this.shapeList(),
      fillDrawings: this.fillDrawings,
      fit: this.fitScore(),
      readsAs: this.readsAs(),
      sampledSwatchId: this.sampledSwatchId,
      materialDropperArmed: this.materialDropperArmed,
      eyeSwatchId: assignmentFor(this.state.materials, EYE_SLOT_ID),
      bodySwatchId: resolvedSwatchFor(this.state.materials, BODY_SLOT_ID, DEFAULT_BODY_SWATCH_ID),
      arrangementId: STARTER_ARRANGEMENT_IDS[this.arrangementIndex] ?? "upright",
      previewArrangementId: this.previewArrangementId,
      lockIssues,
      anchoredBones: this.state.anchors.map((anchor) => anchor.bone),
      unsatisfiedAnchors: this.state.anchors
        .filter((anchor) => !isAnchorSatisfied(anchor, this.anchorResiduals.get(anchor.bone) ?? 0))
        .map((anchor) => anchor.bone),
      preview: this.preview,
      silhouette: this.silhouette,
      status: this.status,
      formEpoch: this.formEpoch,
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  // --- Tools ---------------------------------------------------------------

  /** The body-painting tool, for the HUD panel that drives it. */
  get paint(): PaintTool {
    return this.paintTool;
  }

  /**
   * Shells and the panel plates that are actually out. A stowed plate keeps its
   * unscaled geometry inside the body and the raycaster does not skip hidden
   * objects, so leaving them in would let a metre-wide invisible plate swallow
   * every brush stroke aimed at the torso behind it. The buffer is reused: the
   * brush copies what it is handed.
   */
  private paintableMeshes(): readonly THREE.Object3D[] {
    this.visiblePaintMeshes.length = 0;
    for (const mesh of this.paintMeshes) {
      if (mesh.visible) {
        this.visiblePaintMeshes.push(mesh);
      }
    }
    return this.visiblePaintMeshes;
  }

  setToolMode(mode: ForgeToolMode): void {
    // The pointer says which tool is in hand: a crayon while the Build tool is
    // up, the ordinary crosshair everywhere else.
    this.canvas.style.cursor = mode === "panels" ? DRAW_CURSOR : "crosshair";
    if ((this.mode === mode && this.toolsActive) || this.locked) {
      return;
    }
    const wasPainting = this.toolsActive && this.mode === "paint";
    // A drag belongs to the tool it started under. Switching tools with the
    // button still down would otherwise leave the camera holding a pointer the
    // new tool needs — which is how the brush loses its first stroke.
    this.finishActivePointerGesture();
    this.mode = mode;
    this.toolsActive = true;
    this.handleGroup.visible = true;
    // Paint itself survives the switch. Only the pointer changes hands.
    if (mode === "paint") {
      this.paintTool.activate();
    } else if (wasPainting) {
      this.paintTool.deactivate();
    }
    // The PANELS slot is the build tool now, and it builds with placed
    // primitives rather than flaps on sockets. Leaving the studs up put a ring
    // of live-looking handles on a body they no longer do anything to.
    this.mimic.setSocketMarkersVisible(false);
    this.materialDropperArmed = false;
    this.hoveredSlot = -1;
    this.hoveredSocket = null;
    this.layoutPanelTipHandles();
    this.status = TOOL_HINTS[mode];
    this.audio.play("ui_click");
    this.emit();
  }

  /** Stops every authoring tool when its controls leave the screen. */
  deactivateTools(): void {
    if (!this.toolsActive) return;
    this.finishActivePointerGesture();
    this.toolsActive = false;
    this.paintTool.deactivate();
    this.handleGroup.visible = false;
    this.setHovered(null);
    this.materialDropperArmed = false;
    this.hoveredSlot = -1;
    this.hoveredSocket = null;
    this.mimic.setSocketMarkersVisible(false);
    this.layoutPanelTipHandles();
    this.status = "Forge tools stowed. Choose a tool to resume editing.";
    this.audio.play("ui_back");
    this.emit();
  }

  setMirror(mirror: boolean): void {
    if (this.mirror === mirror) return;
    // Shape and panel gestures capture their mirror partner when the gesture
    // begins. Close the current one before changing symmetry, or turning Mirror
    // on keeps an old "no partner" edit alive (and turning it off keeps copying
    // to the old partner), making the toggle appear to do nothing.
    this.commitEdits();
    this.mirror = mirror;
    this.refreshMirrorHover();
    this.status = mirror
      ? "Mirror on: limb posing, shaping, panels, materials, and paint repeat on the other side."
      : "Mirror off.";
    this.audio.play(mirror ? "ui_confirm" : "ui_back");
    this.emit();
  }

  // --- Preview cameras (§7.6) ----------------------------------------------

  /**
   * Swaps the workspace camera for a preview. The orbit parameters are left
   * alone, so leaving a preview returns to exactly the view the player had.
   */
  setPreview(mode: ForgePreviewMode): void {
    if (this.preview === mode) {
      return;
    }
    this.preview = mode;
    if (mode !== "none") {
      this.audio.play("ui_click");
    }
    this.status = PREVIEW_HINTS[mode];
    this.updateCamera();
    this.emit();
  }

  /**
   * Grayscale unlit override across the whole scene, Mimic included: with
   * colour and lighting gone, only the outline is left to judge (§2.3 Pillar B).
   */
  setSilhouette(enabled: boolean): void {
    if (this.silhouette === enabled) {
      return;
    }
    this.silhouette = enabled;
    if (enabled) {
      if (this.silhouetteMaterial === null) {
        this.silhouetteMaterial = this.bag.add(
          new THREE.MeshStandardMaterial({
            color: SILHOUETTE_FILL,
            roughness: 0.85,
            metalness: 0,
          }),
        );
      }
      this.savedBackground = this.scene.background;
      this.scene.overrideMaterial = this.silhouetteMaterial;
      this.scene.background = SILHOUETTE_BACKDROP;
    } else {
      this.scene.overrideMaterial = null;
      this.scene.background = this.savedBackground;
    }
    this.audio.play("ui_click");
    this.status = enabled
      ? "Silhouette view: if the outline still reads as a creature, keep folding."
      : "Silhouette view off.";
    this.emit();
  }

  // --- Shape ---------------------------------------------------------------

  /** Live form edit. Repeated calls coalesce into one undo entry until `commitEdits`. */
  setSegmentFormValue(key: SegmentFormNumericKey, value: number): void {
    const form = this.beginSegmentEdit();
    if (form === null || !Number.isFinite(value)) {
      return;
    }
    form[key] = value;
    this.finishSegmentValueChange(form);
  }

  setSegmentProfile(profileId: SegmentProfileId): void {
    const form = this.beginSegmentEdit();
    if (form === null || !isSegmentProfileId(profileId)) {
      return;
    }
    form.profileId = profileId;
    this.finishSegmentValueChange(form);
  }

  /** Applies a whole silhouette idea in one solve and one undo entry. */
  applySegmentFormPreset(
    values: Partial<Record<SegmentFormNumericKey, number>>,
    profileId?: SegmentProfileId,
  ): void {
    const form = this.beginSegmentEdit();
    if (form === null) return;
    for (const key of SEGMENT_FORM_NUMERIC_KEYS) {
      const value = values[key];
      if (value !== undefined && Number.isFinite(value)) form[key] = value;
    }
    if (profileId !== undefined && isSegmentProfileId(profileId)) form.profileId = profileId;
    clampSegmentForm(form);
    this.finishSegmentValueChange(form);
    this.formEpoch += 1;
    this.commitEdits();
  }

  resetSelectedSegmentForm(): void {
    const bone = SEGMENT_BONES[this.selectedSlot];
    const form = this.beginSegmentEdit();
    if (bone === undefined || form === null) return;
    Object.assign(form, createDefaultSegmentForm(bone));
    this.finishSegmentValueChange(form);
    this.formEpoch += 1;
    this.commitEdits();
  }

  /** Opens a coalescing edit on the selected segment and returns its live form. */
  private beginSegmentEdit(): SegmentFormState | null {
    const slot = this.selectedSlot;
    const form = this.pose.segments[slot];
    if (form === undefined || this.locked) {
      return null;
    }
    if (this.segmentEdit === null || this.segmentEdit.slot !== slot) {
      this.commitEdits();
      const mirrorSlot = this.mirror ? mirroredSegmentSlot(slot) : -1;
      const mirrorForm = mirrorSlot < 0 ? undefined : this.pose.segments[mirrorSlot];
      this.segmentEdit = {
        slot,
        before: cloneSegmentForm(form),
        mirrorSlot,
        mirrorBefore: mirrorForm === undefined ? null : cloneSegmentForm(mirrorForm),
      };
    }
    return form;
  }

  private finishSegmentValueChange(form: SegmentFormState): void {
    const edit = this.segmentEdit;
    if (edit !== null && edit.mirrorSlot >= 0) {
      this.pose.segments[edit.mirrorSlot] = cloneSegmentForm(form);
    }
    this.pendingValueRefresh = "solve";
    this.startManipulationAudio();
  }

  /** Closes any open continuous edit and records it as one undoable command. */
  commitEdits(): void {
    this.stopManipulationAudio();
    // A slider release must serialize the value the player can see, even when
    // it arrives before the next animation frame has had a chance to solve it.
    this.flushPendingValueRefresh();
    // A walk in progress is an edit like any other, so an undo, a lock or a new
    // arrangement closes it first rather than folding it into whatever follows.
    this.endWalk();

    const edit = this.segmentEdit;
    if (edit !== null) {
      this.segmentEdit = null;
      const after = this.pose.segments[edit.slot];
      if (after !== undefined && !sameForm(edit.before, after)) {
        const issuedAt = performance.now();
        const primary = createSegmentFormCommand(edit.slot, edit.before, after, issuedAt);
        const mirrorAfter = edit.mirrorSlot < 0 ? undefined : this.pose.segments[edit.mirrorSlot];
        const command =
          mirrorAfter === undefined || edit.mirrorBefore === null
            ? primary
            : createCompositeCommand(
                primary.label,
                [
                  primary,
                  createSegmentFormCommand(
                    edit.mirrorSlot,
                    edit.mirrorBefore,
                    mirrorAfter,
                    issuedAt,
                  ),
                ],
                issuedAt,
              );
        this.commands.push(command, this.state);
        this.emit();
      }
    }

    const panelBefore = this.panelEditBefore;
    const socket = this.panelEditSocket;
    if (socket !== null) {
      this.panelEditBefore = null;
      this.panelEditSocket = null;
      const mirrorBefore = this.panelMirrorEditBefore;
      const mirrorSocket = this.panelMirrorEditSocket;
      this.panelMirrorEditBefore = null;
      this.panelMirrorEditSocket = null;
      const after = this.findPanel(socket);
      const mirrorAfter = mirrorSocket === null ? null : this.findPanel(mirrorSocket);
      const issuedAt = performance.now();
      const edits: ForgeCommand[] = [];
      if (after !== null && (panelBefore === null || !samePanel(panelBefore, after))) {
        edits.push(createPanelCommand(socket, panelBefore, after, issuedAt));
      }
      if (
        mirrorSocket !== null &&
        mirrorAfter !== null &&
        (mirrorBefore === null || !samePanel(mirrorBefore, mirrorAfter))
      ) {
        edits.push(createPanelCommand(mirrorSocket, mirrorBefore, mirrorAfter, issuedAt));
      }
      if (edits.length > 0) {
        this.commands.push(
          edits.length === 1
            ? edits[0]!
            : createCompositeCommand("adjust mirrored panels", edits, issuedAt),
          this.state,
        );
        this.emit();
      }
    }
  }

  private startManipulationAudio(intensity = 0.55): void {
    const amount = Math.min(1, Math.max(0, intensity));
    if (this.manipulationAudio.active) {
      this.manipulationAudio.update(0.3 + amount * 0.45, 0.9 + amount * 0.18);
    } else {
      this.manipulationAudio.start(0.3 + amount * 0.45, 0.9 + amount * 0.18);
    }
    if (this.manipulationAudioTimer !== null) clearTimeout(this.manipulationAudioTimer);
    this.manipulationAudioTimer = setTimeout(() => {
      this.manipulationAudioTimer = null;
      this.manipulationAudio.stop();
    }, MANIPULATION_AUDIO_IDLE_MS);
  }

  private stopManipulationAudio(): void {
    if (this.manipulationAudioTimer !== null) clearTimeout(this.manipulationAudioTimer);
    this.manipulationAudioTimer = null;
    this.manipulationAudio.stop();
  }

  // --- Panels --------------------------------------------------------------

  /**
   * Adds a primitive to the disguise and selects it.
   *
   * The bone is where the shape rides, and it defaults to whatever the player
   * currently has selected: a shape appears on the part they were just looking
   * at rather than at an origin they then have to hunt for.
   */
  addShape(profileId: ShapeProfileId, bone?: BoneName): boolean {
    if (this.locked) {
      // Said out loud. A press that does nothing and explains nothing is how
      // this tool looked broken in play: the panel drew, the button took the
      // click, and the disguise stayed empty with no reason given.
      this.status = "The disguise is locked. Unlock it to keep building.";
      this.audio.play("ui_deny");
      this.emit();
      return false;
    }
    const edit = addShapeToList(
      this.state.shapes,
      profileId,
      bone ?? this.shapeBone(),
      undefined,
      this.shapeIdFloor,
    );
    if (edit !== null) {
      const fresh = edit.shapes.at(-1);
      const previous = this.state.shapes.at(-1);
      if (fresh !== undefined && previous !== undefined) {
        // Carry the size the player already tuned. A build is a run of
        // similar parts - a barrel's bands, a crate's boards - and starting
        // every one back at the default means retuning the same numbers over
        // and over against a 115 second clock.
        fresh.scale = [...previous.scale] as [number, number, number];
        // And appear beside the last one rather than inside the body at the
        // bone's origin, where the first thing anyone must do is drag it out
        // before they can even see it.
        fresh.position = [
          previous.position[0] + previous.scale[0],
          previous.position[1],
          previous.position[2],
        ];
      }
    }
    if (edit === null) {
      this.status = `A disguise carries at most ${String(MAX_SHAPES)} shapes.`;
      this.audio.play("ui_deny");
      return false;
    }
    this.commitShapes(edit, `add ${profileId}`);
    this.status = `Added a ${profileId}. Drag its arrows to place it.`;
    return true;
  }

  /**
   * Copies the selected shape. This is the verb that makes building fast -
   * barrel bands, a pot's rim, a row of legs - so it is worth a key of its own.
   */
  duplicateSelectedShape(): boolean {
    if (this.locked || this.selectedShapeId === null) {
      this.status = this.locked
        ? "The disguise is locked. Unlock it to keep building."
        : "Select a shape first, in the room or in the list.";
      this.audio.play("ui_deny");
      this.emit();
      return false;
    }
    const edit = duplicateShapeById(this.state.shapes, this.selectedShapeId, this.shapeIdFloor);
    if (edit === null) {
      this.status = `A disguise carries at most ${String(MAX_SHAPES)} shapes.`;
      this.audio.play("ui_deny");
      return false;
    }
    this.commitShapes(edit, "duplicate shape");
    this.status = "Duplicated. The copy is beside the original.";
    return true;
  }

  /**
   * Copies the selected shape to the other side of the body.
   *
   * Almost everything a room contains is symmetric - a barrel's two bands, a
   * chair's legs, a lamp's arms - so building the second half by hand is
   * exactly half of a 115 second Forge spent doing what the first half
   * already said. Mirroring is the single largest speed-up available to this
   * tool, which is why it gets a verb of its own rather than living inside
   * Duplicate.
   *
   * Across X, the body's own left-right axis, because that is the symmetry a
   * body has and the one a player means.
   */
  mirrorSelectedShape(): boolean {
    const shape = this.state.shapes.find((entry) => entry.id === this.selectedShapeId);
    if (this.locked || shape === undefined) {
      this.status = this.locked
        ? "The disguise is locked. Unlock it to keep building."
        : "Select a shape first, in the room or in the list.";
      this.audio.play("ui_deny");
      this.emit();
      return false;
    }
    const edit = duplicateShapeById(this.state.shapes, shape.id, this.shapeIdFloor);
    if (edit === null) {
      this.status = `A disguise carries at most ${String(MAX_SHAPES)} shapes.`;
      this.audio.play("ui_deny");
      this.emit();
      return false;
    }
    const copy = edit.shapes.at(-1);
    if (copy !== undefined) {
      // Reflected, not offset: a mirror puts the copy where the body's other
      // side is, and negating the two off-axis turns keeps it facing the way
      // its twin does rather than inside out.
      copy.position = [-shape.position[0], shape.position[1], shape.position[2]];
      copy.rotation = [
        shape.rotation[0],
        -shape.rotation[1],
        -shape.rotation[2],
        shape.rotation[3],
      ];
    }
    this.commitShapes(edit, "mirror shape");
    this.status = "Mirrored to the other side.";
    return true;
  }



  /**
   * Seats a shape against its neighbour when a drag left it nearly touching.
   *
   * Deliberately tight. A generous magnet fights the player whenever they
   * want two things a small distance apart, which a room is full of; this only
   * closes the gap nobody meant to leave.
   */
  private autoSeat(id: string): void {
    const index = this.state.shapes.findIndex((entry) => entry.id === id);
    const shape = this.state.shapes[index];
    if (shape === undefined) return;
    const boxOf = (at: number): FitBox | null => {
      const mesh = this.mimic.shapeMeshes[at];
      if (mesh === undefined || mesh.parent === null) return null;
      const box = new THREE.Box3().setFromObject(mesh);
      return { min: { ...box.min }, max: { ...box.max } };
    };
    const moving = boxOf(index);
    if (moving === null) return;
    const others = this.state.shapes
      .map((_, at) => (at === index ? null : boxOf(at)))
      .filter((box): box is FitBox => box !== null);
    if (others.length === 0) return;

    const offset = snapOffset(moving, others);
    if (offset === null || Math.abs(offset.delta) > AUTO_SEAT_M) return;
    shape.position[offset.axis] = (shape.position[offset.axis] ?? 0) + offset.delta;
    this.status = "Seated flush.";
  }

  /**
   * Starts drawing a shape on the screen.
   *
   * The rectangle is measured on a plane through the body facing the camera,
   * so what the player draws around the body is the size they get on it.
   */
  /**
   * Draws an outline directly, in the drawing plane's own metres.
   *
   * The pointer path calls the same code with points it read off the screen.
   * This is the seam a test drives, because the thing worth proving is that a
   * SWEPT OUTLINE becomes a disguise - not that Playwright can move a mouse.
   */
  drawOutline(points: readonly { readonly x: number; readonly y: number }[]): boolean {
    if (this.locked || points.length < 2) return false;
    const first = points[0];
    if (first === undefined) return false;
    // A flat stroke on the world XY plane, which is what a test can state
    // plainly; the pointer path supplies real 3D samples and its own basis.
    this.shapeDraw = {
      points: points.map((point) => new THREE.Vector3(point.x, point.y, 0)),
      right: new THREE.Vector3(1, 0, 0),
      up: new THREE.Vector3(0, 1, 0),
      origin: new THREE.Vector3(first.x, first.y, 0),
    };
    const before = this.state.shapes.length;
    this.endShapeDraw();
    return this.state.shapes.length > before;
  }

  private beginShapeDraw(): void {
    // Through the BODY, not the visual group's origin. The group sits at the
    // world origin, so a plane through it put every drawing wherever the map
    // happens to start - which is how a sweep over the character ended up
    // hanging in the air somewhere else entirely.
    const pelvis = this.pose.worldPositions[boneIndex("pelvis")];
    this.dragPlane.setFromNormalAndCoplanarPoint(
      this.camera.getWorldDirection(this.scratchForward),
      pelvis === undefined
        ? this.mimic.root.position
        : this.scratchVector.set(pelvis.x, pelvis.y, pelvis.z),
    );
    const start = this.pointerOnDragPlane();
    if (start === null) return;
    // The plane's own right and up, taken from the camera. A sweep is read
    // back against these rather than against world X and Y - forcing a world
    // axis flattened every horizontal move and drew nothing but vertical
    // lines.
    const right = new THREE.Vector3().crossVectors(this.camera.up, this.dragPlane.normal).normalize();
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(this.dragPlane.normal, right).normalize();
    this.shapeDraw = { points: [start.clone()], right, up, origin: start.clone() };
    this.canvas.style.cursor = DRAW_CURSOR;
    // Says so while the stroke is live, which is both the feedback a player
    // needs and the only way to tell a draw that never started from one that
    // started and collected nothing.
    this.status = "Drawing…";
    this.emit();
  }

  /** Where the pointer meets the drawing plane, or null when it misses. */
  /**
   * Draws the stroke as it is being swept.
   *
   * Without it a player is drawing blind and only finds out what they made
   * after they let go, which is the slowest possible way to learn a tool.
   */
  private traceStroke(): void {
    const draw = this.shapeDraw;
    if (draw === null || draw.points.length < 2) {
      if (this.strokeTrace !== null) this.strokeTrace.visible = false;
      return;
    }
    if (this.strokeTrace === null) {
      const material = new THREE.LineBasicMaterial({
        color: 0xe2b86a,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      });
      this.strokeTrace = new THREE.Line(new THREE.BufferGeometry(), material);
      this.strokeTrace.renderOrder = 31;
      this.strokeTrace.frustumCulled = false;
      this.handleGroup.add(this.strokeTrace);
    }
    // The line the player is actually drawing, and nothing else. Closing it
    // every frame drew a chord straight back to the start, so the trace showed
    // shapes nobody had swept yet and the drawing appeared to fill itself in
    // ahead of the cursor. The close happens on release, where it belongs.
    const points = draw.points.map((point) => point.clone());
    this.strokeTrace.geometry.dispose();
    this.strokeTrace.geometry = new THREE.BufferGeometry().setFromPoints(points);
    this.strokeTrace.visible = true;
  }

  private pointerOnDragPlane(): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.dragPlane, this.scratchVector);
    return hit === null ? null : hit.clone();
  }

  /**
   * Turns the drawn rectangle into a shape.
   *
   * Depth comes from the smaller of the two drawn sides, because a rectangle
   * says nothing about how deep it is and a slab as deep as it is wide is the
   * answer that reads as an object rather than a card.
   */
  private endShapeDraw(): void {
    const draw = this.shapeDraw;
    this.shapeDraw = null;
    if (this.strokeTrace !== null) this.strokeTrace.visible = false;
    this.canvas.style.cursor = this.mode === "panels" ? DRAW_CURSOR : "crosshair";
    const pendingSelect = this.pendingShapeSelect;
    this.pendingShapeSelect = null;
    if (draw === null || this.locked) return;
    if (draw.points.length < 3) {
      // It never moved, so it was the click it looked like: select what was
      // pressed, or explain the gesture when the press hit nothing.
      if (pendingSelect !== null) {
        this.selectShape(pendingSelect);
        this.audio.play("ui_click");
      } else {
        this.status = "That was a click. Hold the button and sweep to draw.";
        this.emit();
      }
      return;
    }

    // NOTHING is interpreted until here. The stroke was collected exactly as
    // the hand made it; only now is it read back against the plane it was
    // drawn on, closed, and stood up as a solid.
    const flat = draw.points.map((point) => {
      const offset = SHAPE_MOVE_SCRATCH.copy(point).sub(draw.origin);
      return { u: offset.dot(draw.right), v: offset.dot(draw.up) };
    });
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const point of flat) {
      minU = Math.min(minU, point.u);
      maxU = Math.max(maxU, point.u);
      minV = Math.min(minV, point.v);
      maxV = Math.max(maxV, point.v);
    }
    const width = maxU - minU;
    const height = maxV - minV;
    const longest = Math.max(width, height);
    if (longest < SHAPE_DRAW_MIN_M) {
      this.status = "Too small to draw. Sweep a bigger outline.";
      this.audio.play("ui_deny");
      this.emit();
      return;
    }

    const centreU = (minU + maxU) / 2;
    const centreV = (minV + maxV) / 2;
    // Spaced along the STROKE'S OWN LENGTH, not the bounding span. A square's
    // perimeter is four times its span, so span-based spacing spent all the
    // points a quarter of the way round: a carefully drawn square kept one
    // side, and closePath bridged the other three with a single chord - which
    // is how a perfect square came back as a triangle.
    let arcLength = 0;
    for (let index = 1; index < flat.length; index += 1) {
      const from = flat[index - 1];
      const to = flat[index];
      if (from !== undefined && to !== undefined) {
        arcLength += Math.hypot(to.u - from.u, to.v - from.v);
      }
    }
    const spacing = Math.max(arcLength / (MAX_OUTLINE_POINTS - 1), 1e-6);
    const outline: [number, number][] = [];
    let lastU = Infinity;
    let lastV = Infinity;
    for (const point of flat) {
      if (Math.hypot(point.u - lastU, point.v - lastV) < spacing) continue;
      lastU = point.u;
      lastV = point.v;
      outline.push([(point.u - centreU) / longest, (point.v - centreV) / longest]);
      if (outline.length >= MAX_OUTLINE_POINTS) break;
    }
    if (outline.length < 3) return;

    const before = cloneDisguiseState(this.state);
    const edit = addShapeToList(
      this.state.shapes,
      "drawn",
      this.shapeBone(),
      undefined,
      this.shapeIdFloor,
    );
    if (edit === null) {
      this.status = `A disguise carries at most ${String(MAX_SHAPES)} shapes.`;
      this.audio.play("ui_deny");
      this.emit();
      return;
    }
    const shape = edit.shapes.at(-1);
    if (shape === undefined) return;
    this.state.shapes = edit.shapes;
    this.raiseShapeFloor(edit.shapes);
    this.selectedShapeId = shape.id;
    shape.outline = outline;
    shape.filled = this.fillDrawings;
    shape.scale = [
      clamp(longest, SHAPE_MIN_SCALE, SHAPE_MAX_SCALE),
      clamp(longest, SHAPE_MIN_SCALE, SHAPE_MAX_SCALE),
      clamp(Math.max(longest * DRAWN_THICKNESS_SHARE, SHAPE_MIN_SCALE), SHAPE_MIN_SCALE, SHAPE_MAX_SCALE),
    ];

    // Standing in the plane it was drawn on, facing the camera that drew it,
    // then expressed in the carrying bone's frame.
    const boneIdx = boneIndex(shape.bone);
    const origin = this.pose.worldPositions[boneIdx];
    const boneTurn = this.pose.worldRotations[boneIdx];
    const inverse = SHAPE_ROTATE_SCRATCH.set(
      boneTurn?.x ?? 0,
      boneTurn?.y ?? 0,
      boneTurn?.z ?? 0,
      boneTurn?.w ?? 1,
    ).invert();

    const centre = draw.origin
      .clone()
      .addScaledVector(draw.right, centreU)
      .addScaledVector(draw.up, centreV);
    const local = centre.sub(
      SHAPE_MOVE_SCRATCH.set(origin?.x ?? 0, origin?.y ?? 0, origin?.z ?? 0),
    );
    local.applyQuaternion(inverse);
    shape.position = [local.x, local.y, local.z];

    const facing = new THREE.Matrix4().makeBasis(
      draw.right,
      draw.up,
      new THREE.Vector3().crossVectors(draw.right, draw.up).normalize(),
    );
    const worldTurn = new THREE.Quaternion().setFromRotationMatrix(facing);
    const localTurn = inverse.clone().multiply(worldTurn);
    shape.rotation = [localTurn.x, localTurn.y, localTurn.z, localTurn.w];

    this.commands.pushApplied(
      createReplaceCommand(before, cloneDisguiseState(this.state), performance.now(), "draw a disguise"),
      this.state,
    );
    this.refreshAll(true);
    this.emit();
    this.audio.play("panel_snap");
    this.status = "Drew that. Drag its arrows to reshape it.";
  }

  /** The profile a drawn rectangle becomes. */
  setDrawProfile(profileId: ShapeProfileId): void {
    this.drawProfileId = profileId;
    this.status = `Drawing ${profileId}s. Drag on empty space to draw one.`;
    this.emit();
  }

  /** Removes the selected shape, leaving its neighbour selected. */
  deleteSelectedShape(): boolean {
    if (this.locked || this.selectedShapeId === null) {
      this.status = this.locked
        ? "The disguise is locked. Unlock it to keep building."
        : "Select a shape first, in the room or in the list.";
      this.audio.play("ui_deny");
      this.emit();
      return false;
    }
    const gone = this.state.shapes.find((entry) => entry.id === this.selectedShapeId);
    const edit = removeShapeById(this.state.shapes, this.selectedShapeId);
    if (edit === null) return false;
    // Its finish goes with it. A slot left behind would dress whatever took
    // the id next, and the drawing would look like it had come back.
    if (gone !== undefined) {
      this.state.materials = this.state.materials.filter(
        (entry) => entry.slotId !== gone.materialSlotId,
      );
    }
    this.commitShapes(edit, "delete shape");
    this.status = "Removed a shape.";
    return true;
  }

  /**
   * Moves the selected shape by a delta in its bone's frame, as one undoable
   * edit.
   *
   * The gizmo drives the same path a fraction at a time while dragging. This
   * is the whole move in one call, which is what a precise nudge wants: a
   * shape that needs to sit two millimetres further out is easier typed than
   * dragged at this scale, where a body is 0.35 m tall.
   */
  nudgeSelectedShape(dx: number, dy: number, dz: number): boolean {
    const shape = this.state.shapes.find((entry) => entry.id === this.selectedShapeId);
    if (this.locked || shape === undefined) return false;
    const before = cloneDisguiseState(this.state);
    shape.position[0] += dx;
    shape.position[1] += dy;
    shape.position[2] += dz;
    this.commands.pushApplied(
      createReplaceCommand(before, cloneDisguiseState(this.state), performance.now(), "move shape"),
      this.state,
    );
    this.refreshAll();
    this.emit();
    return true;
  }

  selectShape(id: string | null): void {
    this.selectedShapeId = id;
    this.refreshAll();
    this.emit();
  }

  /**
   * Stretches the selected shape along one axis, as one undoable edit.
   *
   * This is what turns the five primitives into a room's worth of objects: a
   * cylinder squashed on Y is a jar's rim, stretched is a barrel, and a cube
   * flattened on one axis is a shelf or a lid. Without per-axis scale the
   * palette is five shapes; with it, it is every object those five can be
   * pulled into.
   */
  scaleSelectedShape(axis: 0 | 1 | 2, factor: number): boolean {
    const shape = this.state.shapes.find((entry) => entry.id === this.selectedShapeId);
    if (this.locked || shape === undefined || !Number.isFinite(factor) || factor <= 0) {
      this.status = this.locked
        ? "The disguise is locked. Unlock it to keep building."
        : "Select a shape first, in the room or in the list.";
      this.audio.play("ui_deny");
      this.emit();
      return false;
    }
    const before = cloneDisguiseState(this.state);
    // Clamped so a shape cannot be scaled to nothing, which would leave an
    // invisible thing in the list that still answers clicks and still counts
    // against the sixteen.
    shape.scale[axis] = clamp((shape.scale[axis] ?? 1) * factor, SHAPE_MIN_SCALE, SHAPE_MAX_SCALE);
    this.commands.pushApplied(
      createReplaceCommand(before, cloneDisguiseState(this.state), performance.now(), "scale shape"),
      this.state,
    );
    this.refreshAll();
    this.emit();
    return true;
  }

  /**
   * Turns the selected shape a quarter at a time about one axis.
   *
   * Quarters rather than free rotation because rooms are built square: a lid
   * lies flat, a barrel stands up, a plank runs along a shelf. Free rotation
   * is a later refinement; snapping is what makes a convincing object fast.
   */
  rotateSelectedShape(axis: 0 | 1 | 2, quarters: number): boolean {
    const shape = this.state.shapes.find((entry) => entry.id === this.selectedShapeId);
    if (this.locked || shape === undefined) {
      this.status = this.locked
        ? "The disguise is locked. Unlock it to keep building."
        : "Select a shape first, in the room or in the list.";
      this.audio.play("ui_deny");
      this.emit();
      return false;
    }
    const before = cloneDisguiseState(this.state);
    const turn = new THREE.Quaternion().setFromAxisAngle(
      axis === 0 ? SHAPE_AXIS_X : axis === 1 ? SHAPE_AXIS_Y : SHAPE_AXIS_Z,
      (Math.PI / 2) * quarters,
    );
    const current = new THREE.Quaternion(
      shape.rotation[0],
      shape.rotation[1],
      shape.rotation[2],
      shape.rotation[3],
    );
    current.multiply(turn).normalize();
    shape.rotation = [current.x, current.y, current.z, current.w];
    this.commands.pushApplied(
      createReplaceCommand(before, cloneDisguiseState(this.state), performance.now(), "turn shape"),
      this.state,
    );
    this.refreshAll();
    this.emit();
    return true;
  }

  /**
   * How much of the body the built silhouette actually hides, 0 to 1.
   *
   * Measured from where the renderer puts things rather than from the stored
   * transforms, so it answers what the room can see rather than what the data
   * intends.
   */
  fitScore(): number {
    if (this.state.shapes.length === 0) return 0;
    const boxes: { min: THREE.Vector3; max: THREE.Vector3 }[] = [];
    for (const mesh of this.mimic.shapeMeshes) {
      if (mesh.parent === null) continue;
      const box = new THREE.Box3().setFromObject(mesh);
      boxes.push({ min: box.min.clone(), max: box.max.clone() });
    }
    const parts = SEGMENT_BONES.map((bone) => this.pose.worldPositions[boneIndex(bone)]).filter(
      (point): point is NonNullable<typeof point> => point !== undefined,
    );
    return fitScore(parts, boxes);
  }

  /**
   * What the built silhouette most resembles in this room.
   *
   * Measured across every shape at once, because the room reads the whole
   * outline rather than its parts: three cylinders that individually resemble
   * nothing can together be a barrel.
   */
  readsAs(): { readonly family: string; readonly closeness: number } | null {
    const drawn = this.mimic.shapeMeshes.filter((mesh) => mesh.parent !== null);
    if (drawn.length === 0) return null;
    const bounds = new THREE.Box3();
    for (const mesh of drawn) bounds.union(new THREE.Box3().setFromObject(mesh));
    const size = bounds.getSize(new THREE.Vector3());
    return readsAs(size.x, size.y, size.z);
  }

  /** The shapes a disguise carries, with the names the object panel draws. */
  shapeList(): readonly ForgeShapeRow[] {
    const labels = shapeLabels(this.state.shapes);
    return this.state.shapes.map((shape) => ({
      id: shape.id,
      label: labels.get(shape.id) ?? shape.id,
      selected: shape.id === this.selectedShapeId,
    }));
  }

  /** Switches between a filled drawing and the bare stroke. */
  setFillDrawings(filled: boolean): void {
    this.fillDrawings = filled;
    this.status = filled
      ? "Drawings fill in. Sweep a closed outline."
      : "Drawings follow the line. Nothing is added between the ends.";
    this.emit();
  }

  /** Keeps the id mark above every shape ever made, so none is handed out twice. */
  private raiseShapeFloor(shapes: readonly { readonly id: string }[]): void {
    for (const shape of shapes) {
      const match = /^shape_(\d+)$/.exec(shape.id);
      if (match?.[1] !== undefined) {
        this.shapeIdFloor = Math.max(this.shapeIdFloor, Number(match[1]));
      }
    }
  }

  /** Where a new shape rides: the selected part, or the pelvis as the body's centre. */
  private shapeBone(): BoneName {
    const slot = [...this.selectedSlots][0];
    const bone = slot === undefined ? undefined : SEGMENT_BONES[slot];
    return bone ?? "pelvis";
  }

  /** One accepted edit becomes one undoable command, as every Forge edit does. */
  private commitShapes(edit: ShapeEdit, label: string): void {
    this.raiseShapeFloor(edit.shapes);
    const before = cloneDisguiseState(this.state);
    const after = cloneDisguiseState(this.state);
    after.shapes = edit.shapes;
    this.commands.push(createReplaceCommand(before, after, performance.now(), label), this.state);
    this.selectedShapeId = edit.selectedId === "" ? null : edit.selectedId;
    this.audio.play("panel_snap");
    // Materials reapplied, so a new shape arrives already wearing the body's
    // finish rather than a frame of default porcelain.
    this.refreshAll(true);
    // refreshAll redraws the body; only emit tells the panel anything
    // happened. Without it a shape really was added and the tool went on
    // reading NOTHING BUILT YET, which is exactly how this looked dead.
    this.emit();
  }

  addPanel(socketId: string): void {
    if (this.locked || !isPanelSocketName(socketId) || this.findPanel(socketId) !== null) {
      return;
    }
    const panel = createDefaultPanelState(socketId);
    // A fresh panel THROWS itself open (2026-08-06): fully deployed, swung
    // out on its hinge, and a size that reads. The old 0.6-deployed flat
    // default hugged the body and the click looked like it did nothing -
    // which players reported as the tool not working at all.
    panel.deployed = 1;
    panel.hingeAngle = 75;
    panel.width = 0.5;
    panel.height = 0.5;
    const issuedAt = performance.now();
    const commands = [createPanelCommand(socketId, null, panel, issuedAt)];
    const opposite = this.mirror ? mirroredSlotId(socketId) : null;
    if (opposite !== null && isPanelSocketName(opposite) && this.findPanel(opposite) === null) {
      const mirrored = clonePanelState(panel);
      mirrored.socketId = opposite;
      commands.push(createPanelCommand(opposite, null, mirrored, issuedAt));
    }
    this.commands.push(
      commands.length === 1 ? commands[0]! : createCompositeCommand("deploy mirrored panels", commands, issuedAt),
      this.state,
    );
    this.selectPanelSocket(socketId);
    this.audio.play("panel_snap");
    this.status = `Deployed a panel on ${socketId.replace("panel_socket_", "socket ")}.`;
    this.refreshAll();
    this.emit();
  }

  removePanel(socketId: string): void {
    const existing = this.findPanel(socketId);
    if (this.locked || existing === null) {
      return;
    }
    const issuedAt = performance.now();
    const commands = [createPanelCommand(socketId, existing, null, issuedAt)];
    const opposite = this.mirror ? mirroredSlotId(socketId) : null;
    const mirrored = opposite === null ? null : this.findPanel(opposite);
    if (opposite !== null && mirrored !== null) {
      commands.push(createPanelCommand(opposite, mirrored, null, issuedAt));
    }
    this.commands.push(
      commands.length === 1 ? commands[0]! : createCompositeCommand("stow mirrored panels", commands, issuedAt),
      this.state,
    );
    this.audio.play("ui_click");
    this.refreshAll();
    this.emit();
  }

  setPanelValue(key: PanelNumericKey, value: number): void {
    const panel = this.beginPanelEdit();
    if (panel === null || !Number.isFinite(value)) {
      return;
    }
    panel[key] = value;
    this.finishPanelValueChange(panel);
  }

  setPanelProfile(profileId: PanelProfileId): void {
    const panel = this.beginPanelEdit();
    if (panel === null) {
      return;
    }
    panel.profileId = profileId;
    this.finishPanelValueChange(panel);
  }

  /** Applies a complete panel silhouette without making the player tune five controls. */
  applyPanelPreset(
    values: Partial<Record<PanelNumericKey, number>>,
    profileId?: PanelProfileId,
  ): void {
    const panel = this.beginPanelEdit();
    if (panel === null) return;
    for (const key of PANEL_NUMERIC_KEYS) {
      const value = values[key];
      if (value !== undefined && Number.isFinite(value)) panel[key] = value;
    }
    if (profileId !== undefined) panel.profileId = profileId;
    this.finishPanelValueChange(panel);
    this.formEpoch += 1;
    this.commitEdits();
  }

  private beginPanelEdit(): PanelState | null {
    const socket = this.selectedSocket;
    if (socket === null || this.locked) {
      return null;
    }
    const panel = this.findPanel(socket);
    if (panel === null) {
      return null;
    }
    if (this.panelEditSocket !== socket) {
      this.commitEdits();
      this.panelEditBefore = clonePanelState(panel);
      this.panelEditSocket = socket;
      const opposite = this.mirror ? mirroredSlotId(socket) : null;
      this.panelMirrorEditSocket =
        opposite !== null && isPanelSocketName(opposite) ? opposite : null;
      const mirrored =
        this.panelMirrorEditSocket === null ? null : this.findPanel(this.panelMirrorEditSocket);
      this.panelMirrorEditBefore = mirrored === null ? null : clonePanelState(mirrored);
    }
    return panel;
  }

  private finishPanelValueChange(panel: PanelState): void {
    clampPanelState(panel);
    const mirrorSocket = this.panelMirrorEditSocket;
    if (mirrorSocket !== null) {
      let mirrored = this.findPanel(mirrorSocket);
      if (mirrored === null) {
        mirrored = createDefaultPanelState(mirrorSocket);
        this.state.panels.push(mirrored);
      }
      copyPanelForm(panel, mirrored);
      clampPanelState(mirrored);
    }
    if (this.pendingValueRefresh === "none") {
      this.pendingValueRefresh = "refresh";
    }
    this.startManipulationAudio();
  }

  // --- Material ------------------------------------------------------------

  get swatches(): readonly MaterialSwatch[] {
    return MIMIC_LEGAL_SWATCHES;
  }

  /** Arms or stands down the material dropper, with the status saying which. */
  setMaterialDropperArmed(armed: boolean): void {
    this.materialDropperArmed = armed;
    this.status = armed
      ? "Dropper armed. Click anything — your own parts included — to copy its swatch."
      : "Dropper off.";
    this.audio.play("ui_click");
    this.emit();
  }

  selectSwatch(swatchId: string): void {
    if (swatchById(swatchId) === null) {
      return;
    }
    this.sampledSwatchId = swatchId;
    this.audio.play("ui_click");
    this.status = `Holding ${swatchById(swatchId)?.label ?? swatchId}. Click a part to paint it.`;
    this.emit();
  }

  /** Samples whatever the pointer is over, the `F` key of §7.5. */

  sampleUnderPointer(): void {
    // A built shape first, since it stands in front of the body: copying one
    // jar's finish onto its rim is the ordinary case once anything has been
    // built at all.
    const shapeId = this.pickShape();
    const built = shapeId === null ? undefined : this.state.shapes.find((e) => e.id === shapeId);
    if (built !== undefined) {
      const worn = resolvedSwatchFor(this.state.materials, built.materialSlotId, DEFAULT_BODY_SWATCH_ID);
      const swatch = swatchById(worn);
      if (swatch !== null) {
        this.sampledSwatchId = worn;
        this.audio.play("material_sample");
        this.status = `Sampled ${swatch.label} from that shape.`;
        this.emit();
        return;
      }
    }
    // Own body next (2026-08-05): pointing at your own part copies the
    // swatch it wears, the way paint's dropper reads its own strokes.
    const slot = this.pickSegmentSlot();
    const bone = slot >= 0 ? SEGMENT_BONES[slot] : undefined;
    if (bone !== undefined) {
      const worn = resolvedSwatchFor(this.state.materials, bone, DEFAULT_BODY_SWATCH_ID);
      const swatch = swatchById(worn);
      if (swatch !== null) {
        this.sampledSwatchId = worn;
        this.audio.play("material_sample");
        this.status = `Sampled ${swatch.label} from your ${bone.replaceAll("_", " ")}.`;
        this.emit();
        return;
      }
    }
    const hit = this.raycastRoom();
    if (hit === null) {
      this.status = "Nothing under the cursor to sample.";
      this.emit();
      return;
    }
    // The room's finishes map onto the body's own tray: sampling wears the
    // nearest legal equivalent rather than refusing an id the body's table
    // has never heard of (2026-08-06).
    const swatchId = resolveSurfaceSwatch(hit.object);
    const sample = swatchId === null ? ({ kind: "none" } as const) : traySwatchForSurface(swatchId);
    if (sample.kind === "refused") {
      this.status = `${sample.label} is not allowed on a disguise.`;
      this.emit();
      return;
    }
    if (sample.kind === "none") {
      // No declaration on the surface: read the colour the player is looking
      // at, exactly as paint's eyedropper does, and wear the nearest finish.
      this.materialEyedropper ??= new Eyedropper({
        raycaster: this.raycaster,
        camera: this.camera,
      });
      const seen = this.materialEyedropper.sampleIntersection(hit);
      if (seen === null) {
        this.status = "Nothing under the cursor to sample.";
        this.emit();
        return;
      }
      const tray = trayForColor(seen.color);
      this.sampledSwatchId = tray.id;
      this.audio.play("material_sample");
      this.status = `Matched the colour under the cursor — worn as ${tray.label}. Click a part to paint it.`;
      this.emit();
      return;
    }
    this.sampledSwatchId = sample.tray.id;
    this.audio.play("material_sample");
    this.status =
      sample.tray.label === sample.surfaceLabel
        ? `Sampled ${sample.tray.label}. Click a part to paint it, or use "whole body".`
        : `Sampled ${sample.surfaceLabel} — worn as ${sample.tray.label}. Click a part to paint it.`;
    this.emit();
  }

  /** Returns the eyes to their authored amber, which is the absence of a slot. */
  clearEyeSwatch(): void {
    if (this.locked) return;
    const current = assignmentFor(this.state.materials, EYE_SLOT_ID);
    if (current === null) return;
    // A null assignment removes the slot, which is what "back to default"
    // means here: the eyes have no fallback to the body swatch.
    this.commands.push(
      createMaterialCommand([EYE_SLOT_ID], [current], null, performance.now()),
      this.state,
    );
    this.mimic.applyMaterials(this.state.materials);
    this.audio.play("ui_back");
    this.status = "Eyes back to their own amber.";
    this.emit();
  }

  assignSwatch(slotId: string, swatchId: string | null = this.sampledSwatchId): void {
    if (this.locked || swatchId === null) {
      return;
    }
    const problem = validateAssignment(slotId, swatchId);
    if (problem !== null) {
      this.status =
        problem === "illegal-swatch"
          ? "That material is not published for disguises."
          : `${slotId} is not a material slot.`;
      this.emit();
      return;
    }
    const slots = assignmentSlots(slotId, this.mirror);
    const before = slots.map(
      (slot) => this.state.materials.find((entry) => entry.slotId === slot)?.swatchId ?? null,
    );
    this.commands.push(
      createMaterialCommand(slots, before, swatchId, performance.now()),
      this.state,
    );
    this.audio.play("ui_confirm");
    this.status = `Painted ${slots.join(" and ")} with ${swatchById(swatchId)?.label ?? swatchId}.`;
    this.mimic.applyMaterials(this.state.materials);
    this.emit();
  }

  // --- History and lock ----------------------------------------------------

  undo(): void {
    this.commitEdits();
    const command = this.commands.undo(this.state);
    if (command === null) {
      this.audio.play("ui_deny");
      return;
    }
    if (command.label.startsWith("arrangement ")) {
      const previous = this.arrangementUndoIds.pop();
      if (previous !== undefined) this.arrangementIndex = STARTER_ARRANGEMENT_IDS.indexOf(previous);
    }
    this.status = `Undid ${command.label}.`;
    this.audio.play("ui_back");
    this.reloadFromState();
  }

  redo(): void {
    this.commitEdits();
    const command = this.commands.redo(this.state);
    if (command === null) {
      this.audio.play("ui_deny");
      return;
    }
    if (command.label.startsWith("arrangement ")) {
      const id = command.label.slice("arrangement ".length) as StarterArrangementId;
      const current = STARTER_ARRANGEMENT_IDS[this.arrangementIndex];
      if (current !== undefined) this.arrangementUndoIds.push(current);
      const index = STARTER_ARRANGEMENT_IDS.indexOf(id);
      if (index >= 0) this.arrangementIndex = index;
    }
    this.status = `Redid ${command.label}.`;
    this.audio.play("ui_confirm");
    this.reloadFromState();
  }

  applyArrangement(id: StarterArrangementId): void {
    if (this.locked) {
      return;
    }
    this.cancelArrangementPreview(false);
    this.commitEdits();
    const previousArrangement = STARTER_ARRANGEMENT_IDS[this.arrangementIndex];
    if (previousArrangement !== undefined) this.arrangementUndoIds.push(previousArrangement);
    // The wall is found from the body as it currently stands, BEFORE the
    // arrangement's authored pose replaces it. An arrangement keeps the root
    // position but resets the rotation, which swings the pelvis somewhere else
    // entirely - and once a body is already mounted flush against plaster,
    // that swing puts the pelvis through it. Searching from there finds the
    // wall's far face and mounts the body outside the room, where it has no
    // floor and falls. Sampling first makes re-applying an arrangement
    // idempotent: the same wall, from the same standing position, every time.
    const wall = ARRANGEMENT_CONTACTS[id]?.approach === "wall" ? this.findNearestWall() : null;
    const next = createStarterArrangement(id);
    next.root.position = [...this.state.root.position];
    next.materials = this.state.materials.map((entry) => ({ ...entry }));
    next.panels = this.state.panels.map(clonePanelState);
    this.commands.push(
      createReplaceCommand(this.state, next, performance.now(), `arrangement ${id}`),
      this.state,
    );
    this.arrangementIndex = Math.max(STARTER_ARRANGEMENT_IDS.indexOf(id), 0);
    this.status = `${starterArrangementLabel(id)} arrangement loaded. It still reads as a creature: keep going.`;
    this.audio.play("ui_confirm");
    this.reloadFromState();

    // Arrangements that describe a relationship to a surface only mean anything
    // once they are actually against one (§7.15, §24.7).
    this.autoAnchorArrangement(id, wall);
    this.solveAndRefresh();
    this.frameMimic();
    this.emit();
  }

  beginArrangementPreview(id: StarterArrangementId): void {
    if (this.locked || this.previewArrangementId === id) return;
    this.cancelArrangementPreview(false);
    this.commitEdits();
    this.arrangementPreviewOriginal = serializeDisguiseState(this.state);
    this.arrangementPreviewStatus = this.status;
    this.arrangementPreviewIndex = this.arrangementIndex;
    const next = createStarterArrangement(id);
    next.root.position = [...this.state.root.position];
    next.materials = this.state.materials.map((entry) => ({ ...entry }));
    next.panels = this.state.panels.map(clonePanelState);
    this.state = next;
    this.arrangementIndex = Math.max(STARTER_ARRANGEMENT_IDS.indexOf(id), 0);
    this.previewArrangementId = id;
    this.status = `Previewing ${starterArrangementLabel(id)}. Click to apply.`;
    this.reloadFromState();
    this.frameMimic();
    this.emit();
  }

  cancelArrangementPreview(emit = true): void {
    const original = this.arrangementPreviewOriginal;
    if (original === null) return;
    this.state = original;
    this.status = this.arrangementPreviewStatus;
    this.arrangementIndex = this.arrangementPreviewIndex;
    this.arrangementPreviewOriginal = null;
    this.previewArrangementId = null;
    this.reloadFromState();
    this.frameMimic();
    if (emit) this.emit();
  }

  commitArrangementPreview(id: StarterArrangementId): void {
    this.cancelArrangementPreview(false);
    this.applyArrangement(id);
  }

  /**
   * Cuts the shot to the Mimic, which an arrangement may have carried across the
   * room. The orbit point follows the body by itself; what this adds is that the
   * shot arrives with it rather than sliding after it. The zoom and the angle
   * are left where the player put them.
   */
  private frameMimic(): void {
    this.syncOrbitTarget();
    // Switching arrangement is a cut, not a move, so the shot goes with it
    // rather than sliding across the shop after a body that teleported.
    this.cameraTarget.copy(this.orbitTarget);
    this.updateCamera();
  }

  cycleArrangement(step: number): void {
    const count = STARTER_ARRANGEMENT_IDS.length;
    const index = (((this.arrangementIndex + step) % count) + count) % count;
    const id = STARTER_ARRANGEMENT_IDS[index];
    if (id !== undefined) {
      this.applyArrangement(id);
    }
  }

  /**
   * R keeps the highest-impact option for the active authoring tool under the
   * movement hand. It deliberately does not add another always-visible HUD
   * control: the buttons remain available in the contextual panel and the key
   * lives in How to Play.
   */
  private cycleQuickOption(step: -1 | 1): void {
    if (this.locked || !this.toolsActive) return;
    if (this.mode === "pose") {
      this.cycleArrangement(step);
      return;
    }
    if (this.mode === "shape") {
      const count = FORGE_QUICK_SHAPES.length;
      if (step < 0) this.quickShapeIndex = (this.quickShapeIndex - 1 + count) % count;
      const preset = FORGE_QUICK_SHAPES[this.quickShapeIndex];
      if (preset !== undefined) this.applySegmentFormPreset(preset.values, preset.profileId);
      if (step > 0) this.quickShapeIndex = (this.quickShapeIndex + 1) % count;
      return;
    }
    if (this.mode === "panels") {
      const count = FORGE_QUICK_PANELS.length;
      if (step < 0) this.quickPanelIndex = (this.quickPanelIndex - 1 + count) % count;
      const preset = FORGE_QUICK_PANELS[this.quickPanelIndex];
      if (preset !== undefined) this.applyPanelPreset(preset.values, preset.profileId);
      if (step > 0) this.quickPanelIndex = (this.quickPanelIndex + 1) % count;
    }
  }

  /** Enter: freeze the disguise and hide the handles (§7.16, §24.5). */
  lock(): void {
    if (this.locked) {
      return;
    }
    this.commitEdits();
    capturePoseToDisguiseState(this.pose, this.state);
    const errors = validateDisguiseState(this.state);
    if (errors.length > 0) {
      this.audio.play("ui_deny");
      this.status = `Cannot lock: ${errors[0] ?? "the disguise is not legal"}.`;
      this.emit();
      return;
    }
    this.lockedPayload = {
      disguise: serializeDisguiseState(this.state),
      encodedPaint: this.paintTool.layer.toDataForWire(),
    };
    this.locked = true;
    this.paintTool.deactivate();
    this.handleGroup.visible = false;
    this.layoutAnchorMarkers();
    this.mimic.setSocketMarkersVisible(false);
    this.mimic.setLocked(true);
    // The fold-flourish (2026-08-04): the body tucks with a servo settle, so
    // the round's central verb lands as a mechanical gesture, not a checkbox.
    this.gaitRig.settle();
    this.audio.play("servo_move");
    this.audio.play("lock_seal");
    this.status = "Disguise locked. Esc to keep editing.";
    this.emit();
  }

  /**
   * Returns the disguise to editable. `status` names why, because unlocking
   * means two different things: leaving a practice lock, and reopening a
   * manifested disguise so its owner can keep working during the hunt.
   */
  unlock(status = "Unlocked. Practice mode only."): void {
    if (!this.locked) {
      return;
    }
    this.locked = false;
    this.lockedPayload = null;
    if (this.toolsActive && this.mode === "paint") {
      this.paintTool.activate();
    }
    this.handleGroup.visible = this.toolsActive;
    this.layoutAnchorMarkers();
    this.mimic.setSocketMarkersVisible(this.toolsActive && this.mode === "panels");
    this.mimic.setLocked(false);
    this.audio.play("wallstick_release");
    this.status = status;
    this.emit();
  }

  /** The serialized disguise and paint produced by the last successful lock. */
  get lockedDisguise(): LockedDisguise | null {
    return this.lockedPayload;
  }

  /**
   * The disguise as it currently stands, locked or not, for publishing a
   * working pose to the room. Its `revision` advances only when the pose
   * actually changed, so a publisher can skip a frame nobody edited.
   */
  get disguise(): DisguiseState {
    // Publication is allowed between frames (tests and the network adapter both
    // do this), so it is also a synchronization boundary for queued controls.
    this.flushPendingValueRefresh();
    return serializeDisguiseState(this.state);
  }

  /** Cheap dirty check used every frame; reading it never serializes the log. */
  get paintRevision(): number {
    return this.paintTool.layer.revision;
  }

  /** Live layer for revision-gated transport publication and diagnostics. */
  get paintLayer() {
    return this.paintTool.layer;
  }

  /** Encoded only after `paintRevision` says a real edit is ready to publish. */
  get paintSnapshot(): ForgePaintSnapshot {
    const layer = this.paintTool.layer;
    return {
      encodedPaint: layer.toDataForWire(),
      revision: layer.revision,
      strokeCount: layer.strokeCount,
    };
  }

  // --- Internals -----------------------------------------------------------

  /** Selection changes reset the HUD controls, so they carry an epoch bump. */
  private selectSegment(slot: number, additive = false): void {
    if (!additive) {
      this.selectedSlots.clear();
      this.selectedSlots.add(slot);
    }
    if (this.selectedSlot !== slot) {
      this.selectedSlot = slot;
      this.formEpoch += 1;
    }
  }

  private selectPanelSocket(socketId: PanelSocketName): void {
    if (this.selectedSocket !== socketId) {
      this.selectedSocket = socketId;
      this.formEpoch += 1;
    }
  }

  private findPanel(socketId: string): PanelState | null {
    return this.state.panels.find((panel) => panel.socketId === socketId) ?? null;
  }

  /** Rebuilds the live pose from the disguise, after undo or a whole-state swap. */
  private reloadFromState(): void {
    this.formEpoch += 1;
    applyDisguiseStateToPose(this.state, this.pose);
    this.pinned.clear();
    this.captureTargets();
    this.refreshAll(true);
    this.emit();
  }

  /**
   * Refreshes the live disguise after an edit. Material assignments are only
   * reapplied for a whole-state reload: doing that during every pose or form
   * change replaces the paint binder's material clones and makes it rebuild
   * the entire painted body on the following frame.
   */
  private refreshAll(reapplyMaterials = false): void {
    this.mimic.applyForms(this.pose);
    this.mimic.applyPanels(this.state.panels);
    this.mimic.applyShapes(this.state.shapes);
    // After applyShapes, so a shape added this frame is wearing its finish
    // before it is ever drawn rather than a frame of porcelain first.
    if (reapplyMaterials) {
      this.mimic.applyMaterials(this.state.materials);
    }
    this.applyPoseToVisual();
    this.layoutHandles();
    this.layoutAnchorMarkers();
    this.layoutPanelTipHandles();
  }

  /** Applies the newest slider value once, never every intermediate DOM event. */
  private flushPendingValueRefresh(): void {
    const refresh = this.pendingValueRefresh;
    if (refresh === "none") return;
    this.pendingValueRefresh = "none";
    if (refresh === "solve") {
      this.solveAndRefresh();
    } else {
      this.refreshAll();
    }
  }

  /**
   * Re-solves for the pinned targets and refreshes everything derived. Only
   * handles the player has actually dragged are pinned, so an untouched limb
   * keeps the pose its starter arrangement gave it instead of being pulled
   * straight the first time anything else moves.
   *
   * Anchors outrank dragged targets on the contact point they hold, and the root
   * is walked toward them before the limbs solve, which is the §24.7 order:
   * root and primary anchor, then contacts, then plain IK targets.
   */
  private solveAndRefresh(): void {
    const targets: { -readonly [K in IkTargetName]?: CoreVector3 } = {};
    for (const name of this.pinned) {
      const target = this.targets.get(name);
      if (target !== undefined) {
        targets[name] = target;
      }
    }

    const anchoredBones = this.refreshResolvedAnchors();
    for (const bone of anchoredBones) {
      const resolved = this.resolvedAnchors.get(bone);
      if (resolved === undefined) continue;
      const target = this.anchorTargets.get(bone) ?? new CoreVector3();
      target.set(resolved.position.x, resolved.position.y, resolved.position.z);
      this.anchorTargets.set(bone, target);
      targets[anchorTargetName(bone)] = target;
    }

    // A pelvis anchor already fixes the root, so nothing else may move it.
    const rootIsFree = !anchoredBones.includes("pelvis");
    if (anchoredBones.length > 0 && rootIsFree) {
      for (let pass = 0; pass < ANCHOR_ROOT_PASSES; pass++) {
        solveIK(this.pose, targets satisfies IkTargets);
        if (!this.stepRootTowardAnchors(anchoredBones)) {
          break;
        }
      }
    }

    solveIK(this.pose, targets satisfies IkTargets);
    this.alignAnchoredContacts(anchoredBones);
    this.measureAnchorResiduals(anchoredBones);
    capturePoseToDisguiseState(this.pose, this.state);
    this.refreshAll();

    // Panels hang off the solved body, so their own reach is solved after it.
    if (this.heldPanelAnchors.length > 0) {
      this.solveHeldPanelAnchors();
      this.refreshAll();
    }
  }

  // --- Anchors (§7.4 Layer 4) --------------------------------------------

  /**
   * Puts an arrangement onto the surface it was designed for. A wall mount is
   * carried to the nearest wall and sealed to it; a shelf bundle settles onto
   * whatever is under it. Everything else keeps whatever anchors it had.
   *
   * The move only has to land inside probe range: the anchor pass in
   * `solveAndRefresh` closes the last centimetres itself.
   */
  private autoAnchorArrangement(
    id: StarterArrangementId,
    /** The wall sampled before the arrangement moved the body; see the caller. */
    wall: { point: THREE.Vector3; normal: THREE.Vector3 } | null = null,
  ): void {
    const plan = ARRANGEMENT_CONTACTS[id];
    if (plan === undefined) {
      return;
    }

    let surfaceNormal: THREE.Vector3 | null = null;
    if (plan.approach === "wall") {
      if (wall === null) {
        this.status = `${starterArrangementLabel(id)} needs a wall. Drag the Mimic closer to one.`;
        return;
      }
      // The arrangement is authored as though the wall were behind +Z, so the
      // body is turned to face this wall before it is carried over. Without
      // this it mounts to a side wall shoulder-first.
      this.scratchQuaternion.setFromAxisAngle(
        ANCHOR_MARKER_AXIS,
        Math.atan2(wall.normal.x, wall.normal.z),
      );
      this.pose.rootRotation.premultiply(this.scratchQuaternion);
      refreshRigMetrics(this.pose);
      updateWorldTransforms(this.pose);

      // The body is carried by its pelvis, not by its root: the arrangement's
      // lean puts those in very different places, and it is the pelvis that has
      // to end up within reach of the wall.
      const pelvis = this.pose.worldPositions[boneIndex("pelvis")];
      if (pelvis !== undefined) {
        this.pose.rootPosition.set(
          clamp(
            this.pose.rootPosition.x + (wall.point.x + wall.normal.x * WALL_MOUNT_STANDOFF_M - pelvis.x),
            this.workspace.minX,
            this.workspace.maxX,
          ),
          clamp(
            this.pose.rootPosition.y + (WALL_MOUNT_HEIGHT_M - pelvis.y),
            this.workspace.minY,
            this.workspace.maxY,
          ),
          clamp(
            this.pose.rootPosition.z + (wall.point.z + wall.normal.z * WALL_MOUNT_STANDOFF_M - pelvis.z),
            this.workspace.minZ,
            this.workspace.maxZ,
          ),
        );
        updateWorldTransforms(this.pose);
      }
      surfaceNormal = wall.normal;
    } else {
      // A bundle wants a shelf, not the floor. Anything raised and level nearby
      // counts; the floor is the fallback when the room offers nothing.
      const perch = this.findNearestPerch();
      if (perch !== null) {
        let lowest = Number.POSITIVE_INFINITY;
        for (const bone of [plan.primary, ...plan.secondary]) {
          const contact = this.pose.worldPositions[boneIndex(bone)];
          if (contact !== undefined && contact.y < lowest) {
            lowest = contact.y;
          }
        }
        const pelvis = this.pose.worldPositions[boneIndex("pelvis")];
        if (pelvis !== undefined && Number.isFinite(lowest)) {
          this.pose.rootPosition.set(
            clamp(this.pose.rootPosition.x + (perch.x - pelvis.x), this.workspace.minX, this.workspace.maxX),
            clamp(this.pose.rootPosition.y + (perch.y - lowest), this.workspace.minY, this.workspace.maxY),
            clamp(this.pose.rootPosition.z + (perch.z - pelvis.z), this.workspace.minZ, this.workspace.maxZ),
          );
          updateWorldTransforms(this.pose);
        }
      }
    }

    // The primary anchor lands first and fixes the body; the limbs only seal
    // where the resulting pose already puts them on something.
    let sealed = this.sealContacts([plan.primary], AUTO_ANCHOR_RADIUS_M, surfaceNormal);
    if (sealed > 0) {
      this.solveAndRefresh();
    }
    // Limb contacts join the same face. A wall mount that also grabs the floor
    // is being pulled two ways and collapses instead of mounting.
    sealed += this.sealContacts(plan.secondary, ANCHOR_SNAP_RADIUS_M, surfaceNormal);

    // A contact the arrangement's own pose cannot hold is not a warning worth
    // showing the player on a fresh arrangement; it is an anchor that should
    // never have been offered. A manual one still reports, because there the
    // player asked for it.
    this.solveAndRefresh();
    sealed -= this.dropUnreachableAnchors(plan.secondary);
    capturePoseToDisguiseState(this.pose, this.state);
    if (sealed === 0) {
      this.status = `${starterArrangementLabel(id)} found nothing to hold on to here.`;
      return;
    }
    this.audio.play("anchor_snap");
    this.status = `${starterArrangementLabel(id)} anchored at ${String(sealed)} contact ${
      sealed === 1 ? "point" : "points"
    }. Keep editing.`;
  }

  /** Nearest wall-like surface around the Mimic, searched on the horizontal. */
  private findNearestWall(): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const pelvis = this.pose.worldPositions[boneIndex("pelvis")];
    if (pelvis === undefined) {
      return null;
    }
    this.scratchVector.set(pelvis.x, pelvis.y, pelvis.z);
    let best: { point: THREE.Vector3; normal: THREE.Vector3 } | null = null;
    let bestDistance = WALL_SEARCH_RANGE_M;

    for (const direction of ANCHOR_PROBE_DIRECTIONS) {
      if (direction.y !== 0) continue;
      this.raycaster.set(this.scratchVector, direction);
      this.raycaster.near = 0;
      this.raycaster.far = WALL_SEARCH_RANGE_M;
      // Only the map's own structure counts as a wall. A side table is closer
      // than the plaster and would otherwise win every search.
      const hit = this.raycaster
        .intersectObjects([...this.anchorObjects], true)
        .find((candidate) => candidate.object.userData["surfaceKind"] === "structure");
      const normal = hit?.normal;
      if (hit === undefined || normal === undefined || hit.distance >= bestDistance) {
        continue;
      }
      bestDistance = hit.distance;
      const facing = normal
        .clone()
        .applyQuaternion(hit.object.getWorldQuaternion(this.scratchQuaternion))
        .normalize();
      // Three reports the face's own normal, and a wall struck from inside the
      // room reports the one pointing OUT of it: nothing flips it for a
      // backface hit. Every caller then reads the normal as "which way is the
      // room", and mounting a body at `point + normal * standoff` puts it
      // through the plaster, where it has no floor and falls. Pressing the
      // arrangement again searches from out there and marches it further.
      //
      // So the normal is turned to face whoever asked for the wall. That is
      // what the callers have always assumed it meant.
      if (facing.dot(this.scratchVector) - facing.dot(hit.point) < 0) {
        facing.negate();
      }
      best = { point: hit.point.clone(), normal: facing };
    }
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    return best;
  }

  /**
   * The highest level surface near the Mimic that is not the floor: a table
   * top, a stool, a sill. Sampled on a ring rather than straight down, because
   * the thing to sit on is usually beside you, not under you.
   */
  private findNearestPerch(): THREE.Vector3 | null {
    const pelvis = this.pose.worldPositions[boneIndex("pelvis")];
    if (pelvis === undefined) {
      return null;
    }
    let best: THREE.Vector3 | null = null;
    let bestHeight = PERCH_MIN_HEIGHT_M;

    for (const radius of PERCH_SAMPLE_RADII_M) {
      for (let step = 0; step < PERCH_SAMPLE_COUNT; step++) {
        const angle = (step / PERCH_SAMPLE_COUNT) * Math.PI * 2;
        this.scratchVector.set(
          pelvis.x + Math.cos(angle) * radius,
          pelvis.y + PERCH_SAMPLE_LIFT_M,
          pelvis.z + Math.sin(angle) * radius,
        );
        this.scratchForward.set(0, -1, 0);
        this.raycaster.set(this.scratchVector, this.scratchForward);
        this.raycaster.near = 0;
        this.raycaster.far = PERCH_SAMPLE_LIFT_M + 2;
        for (const hit of this.raycaster.intersectObjects([...this.anchorObjects], true)) {
          const normal = hit.normal;
          if (normal === undefined || hit.object.name.length === 0) continue;
          const worldNormal = normal
            .clone()
            .applyQuaternion(hit.object.getWorldQuaternion(this.scratchQuaternion))
            .normalize();
          if (worldNormal.y < LEVEL_SURFACE_DOT) continue;
          if (hit.point.y > bestHeight) {
            bestHeight = hit.point.y;
            best = hit.point.clone();
          }
          break;
        }
      }
    }
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    return best;
  }

  /** Anchors each contact point to whatever surface it can currently find. */
  private sealContacts(
    bones: readonly AnchorableBone[],
    radius: number,
    requiredNormal: THREE.Vector3 | null,
  ): number {
    let sealed = 0;
    for (const bone of bones) {
      const effector = this.pose.worldPositions[boneIndex(bone)];
      if (effector === undefined) continue;
      this.scratchVector.set(effector.x, effector.y, effector.z);
      const capture = this.probeAnchorSurface(bone, this.scratchVector, radius, requiredNormal);
      if (capture === null) continue;
      const anchor = captureAnchor(nextAnchorId(bone), capture, ANCHOR_GAP_M);
      if (anchor === null) continue;
      this.state.anchors = withAnchorOnBone(this.state.anchors, bone, anchor);
      this.pinned.add(anchorTargetName(bone));
      sealed += 1;
    }
    return sealed;
  }

  /**
   * Drives every anchored panel's hinge and telescope toward the point it holds,
   * then records how far short it fell. Nothing here touches the body: a panel
   * reaches for its anchor, it does not drag the Mimic toward it.
   */
  private solveHeldPanelAnchors(): void {
    for (const socketId of this.heldPanelAnchors) {
      const resolved = this.resolvedAnchors.get(socketId);
      if (resolved === undefined) continue;
      this.reachPanelTo(socketId, resolved.position);
      const residual = this.panelTipDistanceTo(socketId, resolved.position);
      this.anchorResiduals.set(socketId, residual ?? Number.POSITIVE_INFINITY);
    }
  }

  /**
   * Solves one panel's two free parameters so its tip comes as close to `target`
   * as its hinge range and telescope allow (§7.4 Layer 3, §24.4).
   */
  private reachPanelTo(socketId: PanelSocketName, target: THREE.Vector3): boolean {
    const panel = this.findPanel(socketId);
    if (panel === null) {
      return false;
    }
    if (!this.mimic.panelHingeFrame(socketId, this.panelHinge, this.panelHingeRotation)) {
      return false;
    }
    const resolved = resolvePanel(panel, this.resolvedPanelScratch);
    const reach = solvePanelReach(
      this.panelHinge,
      this.panelHingeRotation,
      target,
      resolved.heightM,
      this.scratchVector,
    );

    const extensionM = clamp(reach.extensionM, 0, PANEL_MAX_EXTENSION_M);
    panel.extension = extensionM / PANEL_MAX_EXTENSION_M;
    // `deployed` is the player's, so only the hinge takes up the difference.
    panel.hingeAngle = clamp(
      reach.angleRad * RAD_TO_DEG - resolved.deployed * PANEL_DEPLOY_DEGREES,
      PANEL_MIN_HINGE_DEG,
      PANEL_MAX_HINGE_DEG,
    );
    clampPanelState(panel);
    this.mimic.applyPanels(this.state.panels);
    this.mimic.applyShapes(this.state.shapes);
    this.applyPoseToVisual();
    return true;
  }

  /** How far a panel's tip ended up from a point, or null when it has no panel. */
  private panelTipDistanceTo(socketId: string, target: THREE.Vector3): number | null {
    if (!this.mimic.panelTipWorld(socketId, this.panelTip)) {
      return null;
    }
    return this.panelTip.distanceTo(target);
  }

  /** Releases anchors the current pose cannot reach. Returns how many went. */
  private dropUnreachableAnchors(bones: readonly AnchorableBone[]): number {
    let dropped = 0;
    for (const bone of bones) {
      const anchor = anchorForBone(this.state.anchors, bone);
      if (anchor === null) continue;
      const residual = this.anchorResiduals.get(bone);
      if (residual !== undefined && isAnchorSatisfied(anchor, residual)) continue;
      this.state.anchors = withAnchorOnBone(this.state.anchors, bone, null);
      this.pinned.delete(anchorTargetName(bone));
      dropped += 1;
    }
    return dropped;
  }

  /** Names an anchor may be sealed to, which is what the index resolved. */
  get anchorSurfaceIds(): readonly string[] {
    return [...this.anchorLookup.keys()];
  }

  /** Indexes the map's named surfaces once, so an anchor can find its object. */
  private indexAnchorSurfaces(): void {
    this.anchorLookup.clear();
    for (const root of this.anchorObjects) {
      root.traverse((object) => {
        if (object instanceof THREE.Mesh && object.name.length > 0) {
          this.anchorLookup.set(object.name, object);
        }
      });
    }
  }

  /** Rebuilds every anchor's world contact point. Returns the bones still held. */
  private refreshResolvedAnchors(): AnchorableBone[] {
    this.resolvedAnchors.clear();
    this.heldPanelAnchors.length = 0;
    const held: AnchorableBone[] = [];
    for (const anchor of this.state.anchors) {
      if (isPanelSocketName(anchor.bone)) {
        if (this.draggedPanelSocket === anchor.bone) continue;
        const panelResolved = this.resolvedAnchorPool.get(anchor.bone) ?? createResolvedAnchor();
        this.resolvedAnchorPool.set(anchor.bone, panelResolved);
        if (resolveAnchor(anchor, (id) => this.anchorLookup.get(id) ?? null, panelResolved)) {
          this.resolvedAnchors.set(anchor.bone, panelResolved);
          this.heldPanelAnchors.push(anchor.bone);
        } else {
          this.anchorResiduals.set(anchor.bone, Number.POSITIVE_INFINITY);
        }
        continue;
      }
      if (!isAnchorableBone(anchor.bone)) continue;
      // The point being dragged answers to the pointer, not to its old anchor.
      if (this.draggedHandle?.def.bone === anchor.bone) continue;
      const resolved = this.resolvedAnchorPool.get(anchor.bone) ?? createResolvedAnchor();
      this.resolvedAnchorPool.set(anchor.bone, resolved);
      if (!resolveAnchor(anchor, (id) => this.anchorLookup.get(id) ?? null, resolved)) {
        this.anchorResiduals.set(anchor.bone, Number.POSITIVE_INFINITY);
        continue;
      }
      this.resolvedAnchors.set(anchor.bone, resolved);
      held.push(anchor.bone);
    }
    return held;
  }

  /**
   * Moves the root toward whatever its anchors cannot otherwise reach. Returns
   * false once the remaining error is small enough to stop iterating.
   */
  private stepRootTowardAnchors(bones: readonly AnchorableBone[]): boolean {
    this.scratchVector.set(0, 0, 0);
    let counted = 0;
    for (const bone of bones) {
      const resolved = this.resolvedAnchors.get(bone);
      const effector = this.pose.worldPositions[boneIndex(bone)];
      if (resolved === undefined || effector === undefined) continue;
      this.scratchVector.x += resolved.position.x - effector.x;
      this.scratchVector.y += resolved.position.y - effector.y;
      this.scratchVector.z += resolved.position.z - effector.z;
      counted += 1;
    }
    if (counted === 0) {
      return false;
    }
    this.scratchVector.multiplyScalar(ANCHOR_ROOT_GAIN / counted);
    if (this.scratchVector.lengthSq() < 1e-8) {
      return false;
    }
    this.pose.rootPosition.set(
      clamp(this.pose.rootPosition.x + this.scratchVector.x, this.workspace.minX, this.workspace.maxX),
      clamp(this.pose.rootPosition.y + this.scratchVector.y, this.workspace.minY, this.workspace.maxY),
      clamp(this.pose.rootPosition.z + this.scratchVector.z, this.workspace.minZ, this.workspace.maxZ),
    );
    return true;
  }

  /**
   * Lays each anchored contact face flat on the surface it holds (§7.4 Layer 4).
   *
   * This runs after the position solve and cannot undo it: a bone's rotation
   * does not move its own origin, and the origin is what the IK placed. So the
   * ankle and the wrist are free to turn the sole and the palm onto the surface
   * without the foot or hand leaving the anchor point.
   */
  private alignAnchoredContacts(bones: readonly AnchorableBone[]): void {
    let changed = false;
    for (const bone of bones) {
      const face = CONTACT_FACE_NORMALS[bone];
      const resolved = this.resolvedAnchors.get(bone);
      if (face === undefined || resolved === undefined) continue;

      const index = boneIndex(bone);
      const parentIndex = getBone(index).parentIndex;
      const worldRotation = this.pose.worldRotations[index];
      const parentRotation = this.pose.worldRotations[parentIndex < 0 ? index : parentIndex];
      if (worldRotation === undefined || parentRotation === undefined) continue;

      this.scratchQuaternion.set(
        worldRotation.x,
        worldRotation.y,
        worldRotation.z,
        worldRotation.w,
      );
      this.contactParentInverse.set(
        parentRotation.x,
        parentRotation.y,
        parentRotation.z,
        parentRotation.w,
      );
      solveContactAlignment(
        face,
        this.scratchQuaternion,
        this.contactParentInverse,
        resolved.normal,
        CONTACT_FACE_REVERSIBLE[bone] === true,
        this.contactLocal,
      );

      // The joint limit still decides. A contact the wrist cannot reach stays
      // as close as the limit allows rather than snapping through it.
      clampBoneRotation(index, this.contactLocal);
      const live = this.pose.localRotations[index];
      if (live === undefined) continue;
      live.set(
        this.contactLocal.x,
        this.contactLocal.y,
        this.contactLocal.z,
        this.contactLocal.w,
      );
      changed = true;
    }

    if (changed) {
      updateWorldTransforms(this.pose);
    }
  }

  private measureAnchorResiduals(bones: readonly AnchorableBone[]): void {
    this.anchorResiduals.clear();
    for (const bone of bones) {
      const resolved = this.resolvedAnchors.get(bone);
      const effector = this.pose.worldPositions[boneIndex(bone)];
      if (resolved === undefined || effector === undefined) continue;
      this.anchorResiduals.set(
        bone,
        anchorResidual(resolved, this.scratchVector.set(effector.x, effector.y, effector.z)),
      );
    }
  }

  /**
   * Looks for a surface within snapping distance of a contact point. Probing
   * along all six axes rather than straight down is what lets a hand find a
   * wall and a foot find the underside of a shelf with one rule.
   */
  private probeAnchorSurface(
    bone: AnchorableBone,
    from: THREE.Vector3,
    radius = ANCHOR_SNAP_RADIUS_M,
    requiredNormal: THREE.Vector3 | null = null,
  ): AnchorCapture | null {
    let best: AnchorCapture | null = null;
    let bestDistance = radius;
    for (const direction of ANCHOR_PROBE_DIRECTIONS) {
      // Each axis is probed as a segment centred on the contact point, cast from
      // the far side inwards. Casting outwards from the point itself finds
      // nothing the moment the point is inside a prop, because from in there
      // every face is back-facing: exactly the case where a foot is being
      // pushed into the stool it is meant to stand on.
      this.scratchProbeOrigin.copy(from).addScaledVector(direction, -radius);
      this.raycaster.set(this.scratchProbeOrigin, direction);
      this.raycaster.near = 0;
      this.raycaster.far = radius * 2;
      // Every hit along the ray is considered, not just the first: a lamp stem
      // in front of the wall should not hide the wall from a mount looking for
      // it, it should just not be the thing that gets anchored to.
      for (const hit of this.raycaster.intersectObjects([...this.anchorObjects], true)) {
        const normal = hit.normal;
        if (normal === undefined || hit.object.name.length === 0) {
          continue;
        }
        // Distance from the contact point, not from the shifted ray origin.
        const reach = Math.abs(hit.distance - radius);
        if (reach >= bestDistance) {
          continue;
        }
        // Intersection normals arrive in object space.
        const worldNormal = normal
          .clone()
          .applyQuaternion(hit.object.getWorldQuaternion(this.scratchQuaternion))
          .normalize();
        if (requiredNormal !== null && worldNormal.dot(requiredNormal) < SAME_FACE_DOT) {
          continue;
        }
        bestDistance = reach;
        best = { bone, object: hit.object, point: hit.point.clone(), normal: worldNormal };
        break;
      }
    }
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    return best;
  }

  /**
   * A grabbable point at the free edge of every deployed panel, shown only while
   * the panel tool is active. Dragging one drives the panel's own two degrees of
   * freedom rather than the body's pose.
   */
  private layoutPanelTipHandles(): void {
    const geometry = this.panelTipGeometry;
    const material = this.panelTipMaterial;
    if (geometry === null || material === null) {
      return;
    }
    const active = this.toolsActive && this.mode === "panels" && !this.locked;

    for (const socketId of PANEL_SOCKET_NAMES) {
      let handle = this.panelTipHandles.get(socketId);
      const reachable = active && this.mimic.panelTipWorld(socketId, this.panelTip);
      if (!reachable) {
        if (handle !== undefined) handle.visible = false;
        continue;
      }
      if (handle === undefined) {
        handle = new THREE.Mesh(geometry, material);
        handle.name = `forge_panel_tip_${socketId}`;
        handle.userData["panelTip"] = socketId;
        this.handleGroup.add(handle);
        this.panelTipHandles.set(socketId, handle);
      }
      handle.visible = true;
      handle.position.copy(this.panelTip);
      const distance = this.camera.position.distanceTo(handle.position);
      handle.scale.setScalar(
        clamp(
          distance * PANEL_TIP_SCREEN_RADIUS,
          HANDLE_MIN_RADIUS * HANDLE_PICK_RATIO,
          HANDLE_MAX_RADIUS * HANDLE_PICK_RATIO,
        ),
      );
    }
  }

  private pickPanelTipHandle(): PanelSocketName | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const meshes = [...this.panelTipHandles.values()].filter((mesh) => mesh.visible);
    const socket = this.raycaster.intersectObjects(meshes, false)[0]?.object.userData["panelTip"];
    return typeof socket === "string" && isPanelSocketName(socket) ? socket : null;
  }

  /** Moves a panel's tip toward the pointer, snapping to a surface within reach. */
  private dragPanelTip(socketId: PanelSocketName): void {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    if (this.raycaster.ray.intersectPlane(this.dragPlane, this.panelDragTarget) === null) {
      return;
    }
    this.panelDragTarget.add(this.dragOffset);

    const capture = this.probeAnchorSurface("pelvis", this.panelDragTarget);
    this.panelSnapCandidate = capture;
    if (capture !== null) {
      this.panelDragTarget.copy(capture.point).addScaledVector(capture.normal, ANCHOR_GAP_M);
      if (!this.snapping) {
        this.snapping = true;
        this.audio.play("anchor_snap", 0.05);
        this.status = `Snapping panel to ${capture.object.name}. Release to seal it.`;
        this.emit();
      }
    } else if (this.snapping) {
      this.snapping = false;
      this.emit();
    }

    this.reachPanelTo(socketId, this.panelDragTarget);
    this.layoutPanelTipHandles();
    this.startManipulationAudio();
  }

  /** Closes a panel-tip drag, recording the panel move and any seal as one edit. */
  private endPanelTipDrag(socketId: PanelSocketName): void {
    const before = this.panelDragBefore;
    const anchorBefore = this.panelDragAnchorBefore;
    this.panelDragBefore = null;
    this.panelDragAnchorBefore = null;
    this.draggedPanelSocket = null;
    this.snapping = false;
    const capture = this.panelSnapCandidate;
    this.panelSnapCandidate = null;

    const after = this.findPanel(socketId);
    if (before === null || after === null) {
      return;
    }

    const issuedAt = performance.now();
    const parts: ForgeCommand[] = [];
    if (!samePanel(before, after)) {
      parts.push(createPanelCommand(socketId, before, after, issuedAt));
    }

    if (capture !== null) {
      const anchor = captureAnchor(nextAnchorId(socketId), capture, ANCHOR_GAP_M);
      if (anchor !== null) {
        parts.push(createAnchorCommand(socketId, anchorBefore, anchor, issuedAt));
        this.audio.play("anchor_snap");
        this.status = `Panel sealed to ${capture.object.name}.`;
      }
    } else if (anchorBefore !== null) {
      parts.push(createAnchorCommand(socketId, anchorBefore, null, issuedAt));
      this.status = "Panel released.";
    }

    if (parts.length === 0) {
      return;
    }
    const first = parts[0];
    if (first === undefined) {
      return;
    }
    this.commands.push(
      parts.length === 1 ? first : createCompositeCommand(first.label, parts, issuedAt),
      this.state,
    );
    this.solveAndRefresh();
    this.emit();
  }

  /** Places a seal marker on every held anchor, tinted by whether it is met. */
  private layoutAnchorMarkers(): void {
    const materials = this.anchorMarkerMaterials;
    if (materials === null) return;

    for (const marker of this.anchorMarkers.values()) {
      marker.visible = false;
    }

    const geometry = this.anchorMarkerGeometry;
    if (geometry === null) return;

    const show = (bone: string, resolved: ResolvedAnchor, material: THREE.Material): void => {
      let marker = this.anchorMarkers.get(bone);
      if (marker === undefined) {
        marker = new THREE.Mesh(geometry, material);
        marker.name = `forge_anchor_${bone}`;
        this.handleGroup.add(marker);
        this.anchorMarkers.set(bone, marker);
      }
      marker.material = material;
      marker.visible = !this.locked;
      marker.position.copy(resolved.position);
      marker.quaternion.setFromUnitVectors(ANCHOR_MARKER_AXIS, resolved.normal);
    };

    for (const [bone, resolved] of this.resolvedAnchors) {
      const anchor = anchorForBone(this.state.anchors, bone);
      const satisfied =
        anchor === null || isAnchorSatisfied(anchor, this.anchorResiduals.get(bone) ?? 0);
      show(bone, resolved, satisfied ? materials.sealed : materials.strained);
    }

    const candidate = this.snapCandidate;
    if (candidate !== null && this.draggedHandle !== null) {
      this.previewAnchor.position.copy(candidate.point);
      this.previewAnchor.normal.copy(candidate.normal);
      show(candidate.bone, this.previewAnchor, materials.preview);
    }
  }

  private captureTargets(): void {
    for (const def of HANDLE_DEFS) {
      const index = boneIndex(def.bone);
      const world = this.pose.worldPositions[index];
      if (world === undefined) continue;
      const target = this.targets.get(def.target) ?? new CoreVector3();
      target.set(world.x, world.y, world.z);
      this.targets.set(def.target, target);
    }
  }

  private buildHandles(): readonly Handle[] {
    const sphere = this.bag.add(new THREE.SphereGeometry(1, 20, 14));
    // Laid on its side so the billboarded puck presents its round face.
    const puck = this.bag.add(new THREE.CylinderGeometry(1, 1, 0.55, 22, 1));
    puck.rotateX(Math.PI / 2);
    // The outline is the part that has to survive being drawn over the body, so
    // it is a flat annulus billboarded at the group and rendered without depth.
    const ring = this.bag.add(new THREE.RingGeometry(HANDLE_RING_INNER, 1, 28));
    const pickSphere = this.bag.add(new THREE.SphereGeometry(1, 8, 6));

    const handles: Handle[] = [];
    for (const def of HANDLE_DEFS) {
      const geometry = def.shape === "sphere" ? sphere : puck;
      const solidMaterial = this.bag.add(
        new THREE.MeshPhysicalMaterial({
          color: def.color,
          roughness: 0.3,
          metalness: def.shape === "sphere" ? 0.85 : 0.1,
          clearcoat: 0.6,
          emissive: new THREE.Color(def.color),
          emissiveIntensity: 0.12,
          transparent: true,
          opacity: HANDLE_OPACITY_IDLE,
        }),
      );
      // §24.5's "controlled pass": the outline ignores depth so a handle behind
      // an arm still reads, without turning depth off for the grip itself.
      const ringMaterial = this.bag.add(
        new THREE.MeshBasicMaterial({
          color: def.color,
          transparent: true,
          opacity: HANDLE_OPACITY_IDLE,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );

      const group = new THREE.Object3D();
      group.name = `forge_handle_${def.target}`;
      const solid = new THREE.Mesh(geometry, solidMaterial);
      solid.name = `forge_handle_grip_${def.target}`;
      solid.scale.setScalar(HANDLE_GRIP_SCALE);
      const outline = new THREE.Mesh(ring, ringMaterial);
      outline.name = `forge_handle_ring_${def.target}`;
      outline.renderOrder = 10;
      // Invisible but still raycast: `Raycaster` skips `visible === false`, so
      // the proxy stays visible and is made to draw nothing instead.
      const pick = new THREE.Mesh(pickSphere, INVISIBLE_PICK_MATERIAL);
      pick.name = `forge_handle_pick_${def.target}`;
      pick.userData["handleTarget"] = def.target;
      pick.renderOrder = -1;

      group.add(outline);
      group.add(solid);
      group.add(pick);
      this.handleGroup.add(group);
      handles.push({
        def,
        boneIndex: boneIndex(def.bone),
        solid,
        ring: outline,
        pick,
        group,
        materials: [solidMaterial, ringMaterial],
      });
    }
    return handles;
  }

  /**
   * Handles keep a constant apparent size so they stay grabbable at any zoom.
   * The pick proxy is laid out against its own, larger screen radius, so
   * shrinking what is drawn never makes a handle harder to hit.
   */
  private layoutHandles(): void {
    for (const handle of this.handles) {
      const world = this.drawnBonePosition(handle.boneIndex);
      if (world === undefined) continue;
      // On the joint as the body is carrying it, not as the pose authored it:
      // a grip a few millimetres off the shoulder it belongs to is a grip the
      // player reaches for and misses. That is the gait as well as the lean —
      // a knee mid-stride is a long way from where the pose left it.
      this.toPosturedWorld(world, handle.group.position);
      const distance = this.camera.position.distanceTo(handle.group.position);
      const radius = clamp(
        distance * HANDLE_SCREEN_RADIUS,
        HANDLE_MIN_RADIUS,
        HANDLE_MAX_RADIUS,
      );
      const emphasis = handle === this.draggedHandle ? 1.3 : handle === this.hoveredHandle ? 1.15 : 1;
      handle.group.scale.setScalar(radius * emphasis);
      handle.group.quaternion.copy(this.camera.quaternion);
      // The group carries the drawn radius, so the proxy divides it back out.
      const pickRadius = clamp(
        distance * HANDLE_PICK_SCREEN_RADIUS,
        HANDLE_MIN_RADIUS * HANDLE_PICK_RATIO,
        HANDLE_MAX_RADIUS * HANDLE_PICK_RATIO,
      );
      handle.pick.scale.setScalar(pickRadius / (radius * emphasis));
    }
    this.layoutResizeGizmo();
    this.layoutHoverAffordances();
  }

  /**
   * The where-can-I-click layer (2026-08-06). A soft cream box stands on the
   * part under the cursor wherever a click would act on it, and the panel
   * tool's socket studs breathe so they can be found at all - the hovered
   * one swells to say it is the one about to fold.
   */
  private layoutHoverAffordances(): void {
    const interactive =
      this.toolsActive && !this.locked && this.gizmoDrag === null && this.draggedHandle === null;
    const partHoverWanted =
      interactive &&
      (this.mode === "shape" || this.mode === "material" || this.mode === "pose") &&
      this.hoveredSlot >= 0 &&
      !(this.mode === "shape" && this.selectedSlots.has(this.hoveredSlot));
    // In panels mode the hovered DEPLOYED plate takes the box, so an
    // existing panel reads as clickable too, not only the empty studs.
    const hoveredPlate =
      interactive && this.mode === "panels" && this.hoveredSocket !== null
        ? this.mimic.panelMeshes.find(
            (plate) => plate.visible && plate.userData["panelSocket"] === this.hoveredSocket,
          )
        : undefined;
    const mesh = partHoverWanted ? this.mimic.segmentMeshes[this.hoveredSlot] : hoveredPlate;
    if (mesh !== undefined) {
      if (this.hoverOutline === null) {
        this.hoverOutline = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
          new THREE.LineBasicMaterial({
            color: 0xf3e6c8,
            transparent: true,
            opacity: 0.45,
            depthTest: false,
          }),
        );
        this.hoverOutline.renderOrder = 28;
        this.handleGroup.add(this.hoverOutline);
      }
      this.hoverOutline.visible = true;
      this.selectionBox.setFromObject(mesh);
      this.selectionBox.getCenter(this.hoverOutline.position);
      this.selectionBox.getSize(this.scratchVector);
      this.hoverOutline.scale.set(
        Math.max(this.scratchVector.x, 1e-4) * 1.04,
        Math.max(this.scratchVector.y, 1e-4) * 1.04,
        Math.max(this.scratchVector.z, 1e-4) * 1.04,
      );
      this.hoverOutline.quaternion.identity();
    } else if (this.hoverOutline !== null) {
      this.hoverOutline.visible = false;
    }

    // The studs breathe while the panel tool is up; the hovered one swells.
    const panelsUp = this.toolsActive && !this.locked && this.mode === "panels";
    const pulse = 1 + 0.14 * Math.sin(performance.now() * 0.005);
    for (const marker of this.mimic.socketMarkers) {
      if (!marker.visible) continue;
      const socket = marker.userData["panelSocket"];
      const hovered = panelsUp && socket === this.hoveredSocket;
      marker.scale.setScalar(panelsUp ? (hovered ? 1.7 : pulse) : 1);
    }
  }

  /** Builds the three-arrow resize gizmo once, hidden until shape mode. */
  private ensureResizeGizmo(): THREE.Group {
    if (this.resizeGizmo !== null) return this.resizeGizmo;
    const gizmo = new THREE.Group();
    gizmo.name = "forge.resizeGizmo";
    gizmo.visible = false;
    for (const axis of GIZMO_AXES) {
      const material = new THREE.MeshBasicMaterial({
        color: axis.color,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
      });
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(GIZMO_SHAFT_RADIUS_M, GIZMO_SHAFT_RADIUS_M, GIZMO_SHAFT_LENGTH_M, 6),
        material,
      );
      shaft.position.y = GIZMO_SHAFT_LENGTH_M / 2;
      const tip = new THREE.Mesh(
        new THREE.ConeGeometry(GIZMO_TIP_RADIUS_M, GIZMO_TIP_LENGTH_M, 8),
        material,
      );
      tip.position.y = GIZMO_SHAFT_LENGTH_M + GIZMO_TIP_LENGTH_M / 2;
      const pick = new THREE.Mesh(
        new THREE.CylinderGeometry(
          GIZMO_PICK_RADIUS_M,
          GIZMO_PICK_RADIUS_M,
          GIZMO_SHAFT_LENGTH_M + GIZMO_TIP_LENGTH_M,
          6,
        ),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      pick.position.y = (GIZMO_SHAFT_LENGTH_M + GIZMO_TIP_LENGTH_M) / 2;
      shaft.renderOrder = 30;
      tip.renderOrder = 30;
      arrow.add(shaft);
      arrow.add(tip);
      arrow.add(pick);
      const dir = new THREE.Vector3(...axis.dir);
      // The arrow is authored along +Y; rotate it onto its axis.
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      gizmo.add(arrow);
      this.gizmoArrows.push({ key: axis.key, dir, pick });
    }
    this.handleGroup.add(gizmo);
    this.resizeGizmo = gizmo;
    return gizmo;
  }

  /** Parks the gizmo on the primary segment, in that segment's own frame. */
  private layoutResizeGizmo(): void {
    // A selected shape gets the arrows while the build tool is open. A shape
    // arrives at its bone's origin and there is nothing else to move it with,
    // so without this the tool can only add and delete.
    const shapeIndex =
      this.toolsActive && this.mode === "panels" && !this.locked && this.selectedShapeId !== null
        ? this.state.shapes.findIndex((entry) => entry.id === this.selectedShapeId)
        : -1;
    if (shapeIndex >= 0) {
      const shapeMesh = this.mimic.shapeMeshes[shapeIndex];
      const shapeGizmo = this.ensureResizeGizmo();
      this.layoutSelectionOutlines(false);
      this.layoutShapeOutline(shapeMesh ?? null);
      if (shapeGizmo === null || shapeMesh === undefined) return;
      shapeGizmo.visible = true;
      shapeMesh.getWorldPosition(this.scratchVector);
      shapeGizmo.position.copy(this.scratchVector);
      return;
    }
    this.layoutShapeOutline(null);

    const wanted =
      this.toolsActive &&
      this.mode === "shape" &&
      !this.locked &&
      this.selectedSlots.size > 0 &&
      this.mimic.segmentMeshes[this.selectedSlot] !== undefined;
    const gizmo = wanted ? this.ensureResizeGizmo() : this.resizeGizmo;
    this.layoutSelectionOutlines(wanted);
    if (gizmo === null) return;
    gizmo.visible = wanted;
    if (!wanted) return;
    const mesh = this.mimic.segmentMeshes[this.selectedSlot];
    if (mesh === undefined) return;
    mesh.getWorldPosition(this.scratchVector);
    // handleGroup shares the scene's frame, so world coordinates park it.
    gizmo.position.copy(this.scratchVector);
    mesh.getWorldQuaternion(gizmo.quaternion);
  }

  /**
   * A brass box around every selected part (2026-08-05): with shift-click
   * multi-select in play, the body itself has to say which pieces the arrows
   * are about to resize.
   */
  /**
   * Draws a box round the shape the gizmo is driving.
   *
   * A build is a pile of similar primitives, and the arrows alone do not say
   * WHICH of them a drag is about to move - so a player checks by dragging and
   * undoing, which is the most expensive way to ask a question under a 115
   * second clock.
   */
  private layoutShapeOutline(mesh: THREE.Mesh | null): void {
    if (mesh === null) {
      if (this.shapeOutline !== null) this.shapeOutline.visible = false;
      return;
    }
    if (this.selectionOutlineMaterial === null) {
      this.selectionOutlineMaterial = new THREE.LineBasicMaterial({
        color: 0xe2b86a,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      });
    }
    if (this.shapeOutline === null) {
      this.shapeOutline = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
        this.selectionOutlineMaterial,
      );
      this.shapeOutline.renderOrder = 29;
      this.handleGroup.add(this.shapeOutline);
    }
    this.shapeOutline.visible = true;
    this.selectionBox.setFromObject(mesh);
    this.selectionBox.getCenter(this.shapeOutline.position);
    this.selectionBox.getSize(this.scratchVector);
    this.shapeOutline.scale.set(
      Math.max(this.scratchVector.x, 1e-4) * 1.08,
      Math.max(this.scratchVector.y, 1e-4) * 1.08,
      Math.max(this.scratchVector.z, 1e-4) * 1.08,
    );
    this.shapeOutline.quaternion.identity();
  }

  private layoutSelectionOutlines(wanted: boolean): void {
    for (const [slot, outline] of this.selectionOutlines) {
      outline.visible = wanted && this.selectedSlots.has(slot);
    }
    if (!wanted) return;
    if (this.selectionOutlineMaterial === null) {
      this.selectionOutlineMaterial = new THREE.LineBasicMaterial({
        color: 0xe2b86a,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      });
    }
    for (const slot of this.selectedSlots) {
      const mesh = this.mimic.segmentMeshes[slot];
      if (mesh === undefined) continue;
      let outline = this.selectionOutlines.get(slot);
      if (outline === undefined) {
        outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
          this.selectionOutlineMaterial,
        );
        outline.renderOrder = 29;
        this.handleGroup.add(outline);
        this.selectionOutlines.set(slot, outline);
      }
      outline.visible = true;
      this.selectionBox.setFromObject(mesh);
      this.selectionBox.getCenter(outline.position);
      this.selectionBox.getSize(this.scratchVector);
      outline.scale.set(
        Math.max(this.scratchVector.x, 1e-4) * 1.05,
        Math.max(this.scratchVector.y, 1e-4) * 1.05,
        Math.max(this.scratchVector.z, 1e-4) * 1.05,
      );
      outline.quaternion.identity();
    }
  }

  /** The built shape under the pointer, so clicking one selects it. */
  private pickShape(): string | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const meshes = this.mimic.shapeMeshes.filter((mesh) => mesh.parent !== null);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (hit === undefined) return null;
    const index = this.mimic.shapeMeshes.indexOf(hit.object as THREE.Mesh);
    return this.state.shapes[index]?.id ?? null;
  }

  private pickGizmoArrow(): { key: "width" | "length" | "depth"; dir: THREE.Vector3 } | null {
    if (this.resizeGizmo === null || !this.resizeGizmo.visible) return null;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.gizmoArrows.map((arrow) => arrow.pick),
      false,
    );
    const first = hits[0];
    if (first === undefined) return null;
    const arrow = this.gizmoArrows.find((entry) => entry.pick === first.object);
    if (arrow === undefined) return null;
    const worldDir = arrow.dir.clone().applyQuaternion(this.resizeGizmo.quaternion).normalize();
    return { key: arrow.key, dir: worldDir };
  }

  /** Closest-point parameter of the pointer ray along the drag axis line. */
  private gizmoAxisParam(origin: THREE.Vector3, dir: THREE.Vector3): number {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const ray = this.raycaster.ray;
    const w0 = this.scratchVector.copy(origin).sub(ray.origin);
    const b = dir.dot(ray.direction);
    const d = dir.dot(w0);
    const e = ray.direction.dot(w0);
    const denominator = 1 - b * b;
    if (Math.abs(denominator) < 1e-6) return d;
    return (b * e - d) / denominator;
  }

  /** Every slot a resize drives: the selection, plus mirrors when mirroring. */
  private resizeTargetSlots(): number[] {
    const slots = new Set<number>(this.selectedSlots);
    if (this.mirror) {
      for (const slot of [...slots]) {
        const mirrored = mirroredSegmentSlot(slot);
        if (mirrored >= 0) slots.add(mirrored);
      }
    }
    return [...slots];
  }

  private beginGizmoDrag(
    arrow: { key: "width" | "length" | "depth"; dir: THREE.Vector3 },
    mode: "move" | "turn" | "scale" | "uniform" = "move",
  ): void {
    if (this.resizeGizmo === null) return;
    this.commitEdits();
    const origin = this.resizeGizmo.position.clone();

    // A selected shape takes the gizmo. Moving what you just built is the
    // first thing anyone tries, and the arrows are already the language the
    // Forge uses for "drag along this axis".
    const shape = this.state.shapes.find((entry) => entry.id === this.selectedShapeId);
    if (shape !== undefined) {
      this.gizmoDrag = {
        key: arrow.key,
        dir: arrow.dir.clone(),
        origin,
        startT: this.gizmoAxisParam(origin, arrow.dir),
        startValues: new Map(),
        before: new Map(),
        shape: {
          id: shape.id,
          start: [...shape.position] as [number, number, number],
          startRotation: [...shape.rotation] as [number, number, number, number],
          startScale: [...shape.scale] as [number, number, number],
          mode,
        },
      };
      this.startManipulationAudio();
      this.canvas.style.cursor = "grabbing";
      return;
    }
    const startValues = new Map<number, number>();
    const before = new Map<number, SegmentFormState>();
    for (const slot of this.resizeTargetSlots()) {
      const form = this.pose.segments[slot];
      if (form === undefined) continue;
      startValues.set(slot, form[arrow.key]);
      before.set(slot, cloneSegmentForm(form));
    }
    if (startValues.size === 0) return;
    this.gizmoDrag = {
      key: arrow.key,
      dir: arrow.dir.clone(),
      origin,
      startT: this.gizmoAxisParam(origin, arrow.dir),
      startValues,
      before,
      shape: null,
    };
    this.startManipulationAudio();
    this.canvas.style.cursor = "grabbing";
  }

  private updateGizmoDrag(): void {
    const drag = this.gizmoDrag;
    if (drag === null) return;
    const t = this.gizmoAxisParam(drag.origin, drag.dir);
    const delta = (t - drag.startT) * GIZMO_PARAM_PER_METRE;

    if (drag.shape !== null) {
      const shape = this.state.shapes.find((entry) => entry.id === drag.shape?.id);
      if (shape !== undefined) {
        const axis = drag.key === "width" ? 0 : drag.key === "length" ? 1 : 2;
        if (drag.shape.mode === "uniform") {
          // Every axis at once, from the size the drag began at. Most things a
          // room contains are resized whole - a bigger jar is a bigger jar,
          // not a taller one - so this is the common case and the per-axis
          // stretch is the exception.
          const factor = 1 + delta * SHAPE_SCALE_PER_METRE;
          for (let axisIndex = 0; axisIndex < 3; axisIndex += 1) {
            const start = drag.shape.startScale[axisIndex] ?? 1;
            shape.scale[axisIndex] = clamp(start * Math.max(factor, 0.05), SHAPE_MIN_SCALE, SHAPE_MAX_SCALE);
          }
        } else if (drag.shape.mode === "scale") {
          // Stretching along the arrow the player grabbed, from the size the
          // drag started at, so a shape grows and shrinks under the hand
          // rather than stepping in fixed amounts from a button.
          const start = drag.shape.startScale[axis] ?? 1;
          shape.scale[axis] = clamp(
            start + delta * SHAPE_SCALE_PER_METRE,
            SHAPE_MIN_SCALE,
            SHAPE_MAX_SCALE,
          );
        } else if (drag.shape.mode === "turn") {
          // Free rotation about the arrow's own axis. Quarter turns square a
          // shape up fast; this is for the tilted lid and the leaning plank
          // that a room actually contains.
          const turn = SHAPE_ROTATE_SCRATCH.setFromAxisAngle(
            axis === 0 ? SHAPE_AXIS_X : axis === 1 ? SHAPE_AXIS_Y : SHAPE_AXIS_Z,
            delta * SHAPE_ROTATE_RAD_PER_METRE,
          );
          const start = SHAPE_START_SCRATCH.set(
            drag.shape.startRotation[0],
            drag.shape.startRotation[1],
            drag.shape.startRotation[2],
            drag.shape.startRotation[3],
          );
          const next = start.clone().multiply(turn).normalize();
          shape.rotation = [next.x, next.y, next.z, next.w];
        } else {
          // Along the arrow's own WORLD direction, converted into the bone's
          // frame. Writing the delta straight into a local axis moved the
          // shape wherever that bone happened to face, so an arrow pointing
          // right slid the piece somewhere else - the gizmo lied about what it
          // would do.
          const world = SHAPE_MOVE_SCRATCH.copy(drag.dir).multiplyScalar(delta);
          const boneTurn = this.pose.worldRotations[boneIndex(shape.bone)];
          if (boneTurn !== undefined) {
            world.applyQuaternion(
              SHAPE_ROTATE_SCRATCH.set(boneTurn.x, boneTurn.y, boneTurn.z, boneTurn.w).invert(),
            );
          }
          shape.position = [
            (drag.shape.start[0] ?? 0) + world.x,
            (drag.shape.start[1] ?? 0) + world.y,
            (drag.shape.start[2] ?? 0) + world.z,
          ];
        }
      }
      this.pendingValueRefresh = "solve";
      return;
    }

    for (const [slot, start] of drag.startValues) {
      const form = this.pose.segments[slot];
      if (form === undefined) continue;
      form[drag.key] = clamp(start + delta, 0, 1);
    }
    this.pendingValueRefresh = "solve";
  }

  private endGizmoDrag(): void {
    const drag = this.gizmoDrag;
    if (drag === null) return;
    this.gizmoDrag = null;
    this.stopManipulationAudio();
    this.canvas.style.cursor = "crosshair";
    this.flushPendingValueRefresh();
    const issuedAt = performance.now();

    if (drag.shape !== null) {
      // One drag, one command. The live edit already moved the shape, so the
      // undo has to carry the position it started from rather than re-deriving
      // it - the pointer is long gone by the time anyone presses undo.
      const moved = this.state.shapes.find((entry) => entry.id === drag.shape?.id);
      if (moved === undefined) return;
      const before = cloneDisguiseState(this.state);
      const restored = before.shapes.find((entry) => entry.id === drag.shape?.id);
      if (restored !== undefined) {
        restored.position = [...drag.shape.start] as [number, number, number];
        restored.rotation = [...drag.shape.startRotation] as [number, number, number, number];
        restored.scale = [...drag.shape.startScale] as [number, number, number];
      }
      const unchanged =
        restored !== undefined &&
        restored.position.every((axis, index) => axis === moved.position[index]) &&
        restored.rotation.every((axis, index) => axis === moved.rotation[index]) &&
        restored.scale.every((axis, index) => axis === moved.scale[index]);
      if (unchanged) return;
      // A move that lands within a hair of another shape seats itself. The
      // player was aiming for flush - nobody drags a barrel band to three
      // millimetres off on purpose - and asking them to press Snap after every
      // drag is a second gesture for something the first one already said.
      if (drag.shape.mode === "move") this.autoSeat(moved.id);
      this.commands.pushApplied(
        createReplaceCommand(
          before,
          cloneDisguiseState(this.state),
          issuedAt,
          drag.shape.mode === "uniform"
            ? "resize shape"
            : drag.shape.mode === "scale"
              ? "stretch shape"
            : drag.shape.mode === "turn"
              ? "turn shape"
              : "move shape",
        ),
        this.state,
      );
      this.refreshAll();
      this.emit();
      return;
    }

    const parts: ForgeCommand[] = [];
    for (const [slot, beforeForm] of drag.before) {
      const form = this.pose.segments[slot];
      if (form === undefined || form[drag.key] === beforeForm[drag.key]) continue;
      parts.push(createSegmentFormCommand(slot, beforeForm, cloneSegmentForm(form), issuedAt));
    }
    if (parts.length === 0) return;
    const command =
      parts.length === 1 && parts[0] !== undefined
        ? parts[0]
        : createCompositeCommand("resize", parts, issuedAt);
    this.commands.pushApplied(command, this.state);
    this.formEpoch += 1;
    this.emit();
  }

  private setHandleOpacity(handle: Handle, opacity: number): void {
    for (const material of handle.materials) {
      if ("opacity" in material) {
        (material as THREE.Material & { opacity: number }).opacity = opacity;
      }
    }
  }

  private setHovered(handle: Handle | null): void {
    if (this.hoveredHandle === handle) {
      return;
    }
    if (this.hoveredHandle !== null && this.hoveredHandle !== this.draggedHandle) {
      this.setHandleOpacity(this.hoveredHandle, HANDLE_OPACITY_IDLE);
    }
    if (
      this.mirrorHoveredHandle !== null &&
      this.mirrorHoveredHandle !== this.draggedHandle &&
      this.mirrorHoveredHandle !== handle
    ) {
      this.setHandleOpacity(this.mirrorHoveredHandle, HANDLE_OPACITY_IDLE);
    }
    this.hoveredHandle = handle;
    if (handle !== null) {
      this.setHandleOpacity(handle, HANDLE_OPACITY_HOVER);
      this.audio.playThrottled("ui_hover", 220);
    }
    this.refreshMirrorHover();
    this.canvas.style.cursor = "crosshair";
  }

  /** Lights the exact counterpart Mirror will move, so symmetry is spatial rather than textual. */
  private refreshMirrorHover(): void {
    const previous = this.mirrorHoveredHandle;
    const mirroredTarget =
      this.mirror && this.hoveredHandle !== null
        ? mirroredIkTarget(this.hoveredHandle.def.target)
        : null;
    const next =
      mirroredTarget === null
        ? null
        : (this.handles.find((handle) => handle.def.target === mirroredTarget) ?? null);
    if (
      previous !== null &&
      previous !== next &&
      previous !== this.hoveredHandle &&
      previous !== this.draggedHandle
    ) {
      this.setHandleOpacity(previous, HANDLE_OPACITY_IDLE);
    }
    this.mirrorHoveredHandle = next;
    if (next !== null && next !== this.hoveredHandle && next !== this.draggedHandle) {
      this.setHandleOpacity(next, HANDLE_OPACITY_MIRROR);
    }
  }

  // --- Input ---------------------------------------------------------------

  private attachInput(): void {
    const onPointerDown = (event: PointerEvent): void => {
      if (!this.ownsPointerEvent(event)) return;
      // The brush listens on the canvas, and these handlers run at the window in
      // the capture phase, so stopping propagation here would swallow the press
      // before it ever reached the brush. In paint mode the left button belongs
      // to the brush and the Forge does not touch the event at all. Right-drag
      // and middle-drag still turn the shot while painting.
      if (this.paintOwnsPointer() && event.button === 0) return;
      event.stopPropagation();
      event.preventDefault();
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;

      if (event.button === 2 || event.button === 1) {
        this.cameraDrag = "orbit";
      } else if (event.button === 0 && !this.beginLeftPress(event)) {
        // Nothing under the pointer to edit, so the press belongs to the camera.
        // Right-drag orbits too, but a left-drag on empty space is the gesture
        // players reach for first, and without it the Forge reads as a fixed
        // angle onto a body wedged behind whatever the map put next to it.
        this.cameraDrag = "orbit";
      }
      // A live drawing has to claim the pointer like any other drag, or every
      // move after the press is rejected as somebody else's and the stroke
      // arrives at pointerup with a single point in it.
      if (this.cameraDrag !== null || this.draggedHandle !== null || this.shapeDraw !== null) {
        this.dragPointerId = event.pointerId;
        trySetPointerCapture(this.canvas, event.pointerId);
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!this.ownsPointerEvent(event)) return;
      // The brush tracks the drag on the window, so the same rule applies here:
      // unless the Forge is already turning the camera, it stays out of the way.
      if (this.paintOwnsPointer()) return;
      event.stopPropagation();
      this.updatePointerNdc(event);

      if (this.cameraDrag === "orbit") {
        this.yaw -= (event.clientX - this.lastPointerX) * ORBIT_PER_PIXEL;
        this.pitch = clamp(
          this.pitch + (event.clientY - this.lastPointerY) * PITCH_PER_PIXEL,
          CAMERA_MIN_PITCH,
          CAMERA_MAX_PITCH,
        );
        this.updateCamera();
      } else if (this.shapeDraw !== null) {
        // A live drawing owns the pointer: every move is a point on the
        // outline, and none of them orbit the camera.
        this.updatePointerNdc(event);
        const point = this.pointerOnDragPlane();
        if (point !== null) this.shapeDraw.points.push(point.clone());
        this.traceStroke();
      } else if (this.gizmoDrag !== null) {
        this.updateGizmoDrag();
      } else if (this.draggedHandle !== null) {
        this.pointerGestureDirty = true;
      } else if (this.draggedPanelSocket !== null) {
        this.pointerGestureDirty = true;
      } else if (this.toolsActive && this.mode === "pose" && !this.locked) {
        // Hovering the body itself lights the handle a press there would
        // take, so the limb-grab is discoverable before it is ever used.
        this.setHovered(this.pickHandle() ?? this.pickHandleNearBody());
        this.hoveredSlot = this.pickSegmentSlot();
      } else if (this.toolsActive && !this.locked && (this.mode === "shape" || this.mode === "material")) {
        this.hoveredSlot = this.pickSegmentSlot();
      } else if (this.toolsActive && !this.locked && this.mode === "panels") {
        this.hoveredSocket = this.pickSocket();
      }
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!this.ownsPointerEvent(event) && event.pointerId !== this.dragPointerId) return;
      if (this.paintOwnsPointer()) return;
      event.stopPropagation();
      if (this.shapeDraw !== null) {
        this.updatePointerNdc(event);
        const drawn = this.pointerOnDragPlane();
        if (drawn !== null) this.shapeDraw.points.push(drawn.clone());
        this.traceStroke();
        // The release ends the stroke, whatever else the pointer was doing.
        this.endShapeDraw();
        this.canvas.style.cursor = "crosshair";
      }
      if (this.gizmoDrag !== null) {
        if (event.clientX !== this.lastPointerX || event.clientY !== this.lastPointerY) {
          this.updatePointerNdc(event);
          this.updateGizmoDrag();
        }
        this.endGizmoDrag();
      }
      if (this.draggedHandle !== null) {
        if (event.clientX !== this.lastPointerX || event.clientY !== this.lastPointerY) {
          this.updatePointerNdc(event);
          this.pointerGestureDirty = true;
        }
        this.flushPointerGesture();
        const released = this.draggedHandle;
        this.draggedHandle = null;
        this.setHandleOpacity(
          released,
          released === this.hoveredHandle ? HANDLE_OPACITY_HOVER : HANDLE_OPACITY_IDLE,
        );
        this.endPoseEdit(released);
        this.canvas.style.cursor = "crosshair";
      } else if (this.draggedPanelSocket !== null) {
        if (event.clientX !== this.lastPointerX || event.clientY !== this.lastPointerY) {
          this.updatePointerNdc(event);
          this.pointerGestureDirty = true;
        }
        this.flushPointerGesture();
        this.endPanelTipDrag(this.draggedPanelSocket);
        this.canvas.style.cursor = "crosshair";
      }
      this.cameraDrag = null;
      this.pointerGestureDirty = false;
      if (this.dragPointerId >= 0) tryReleasePointerCapture(this.canvas, this.dragPointerId);
      this.dragPointerId = -1;
    };

    const onWheel = (event: WheelEvent): void => {
      if (!this.ownsPointerEvent(event)) return;
      event.stopPropagation();
      event.preventDefault();
      this.radius = clamp(
        this.radius * (1 + event.deltaY * ZOOM_PER_NOTCH),
        CAMERA_MIN_RADIUS,
        CAMERA_MAX_RADIUS,
      );
      this.updateCamera();
    };

    const onContextMenu = (event: MouseEvent): void => {
      if (event.target === this.canvas) {
        event.preventDefault();
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      this.handleKey(event);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      // A release is never filtered by where it landed. A walk key pressed over
      // the canvas and let go over a HUD field would otherwise stay down and
      // the body would keep walking with nothing holding it.
      const key = forgeKey(event);
      this.locomotion?.release(key);
      if (key === "e" && this.preview === "inspector") {
        this.setPreview("none");
      }
    };

    /** A window that loses focus never delivers the keyup. */
    const onBlur = (): void => {
      this.locomotion?.releaseAll();
    };

    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    this.bag.addFn(() => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      this.canvas.style.cursor = "default";
    });
  }

  /**
   * The Forge owns pointer input over the workspace while it is active.
   *
   * The event does not necessarily land on the canvas: the React root covers the
   * viewport, so anything not over a HUD control arrives with the root as its
   * target. HUD controls mark themselves with `data-forge-ui`, and everything
   * else is workspace.
   */
  private ownsPointerEvent(event: Event): boolean {
    const target = event.target;
    if (target === this.canvas) {
      return true;
    }
    return target instanceof Element && target.closest(FORGE_UI_SELECTOR) === null;
  }

  /**
   * True while the brush, not the Forge, should be reading the pointer. A camera
   * drag already in progress keeps the pointer it captured until it is released.
   */
  private paintOwnsPointer(): boolean {
    return this.toolsActive && this.mode === "paint" && !this.locked && this.cameraDrag === null;
  }

  /**
   * Closes the gesture under its original tool before another tool takes the
   * pointer. This is used by keyboard/button switching, where no pointer-up is
   * guaranteed to reach the canvas that began the edit.
   */
  private finishActivePointerGesture(): void {
    this.endGizmoDrag();
    this.flushPointerGesture();
    if (this.draggedHandle !== null) {
      const released = this.draggedHandle;
      this.draggedHandle = null;
      this.setHandleOpacity(
        released,
        released === this.hoveredHandle ? HANDLE_OPACITY_HOVER : HANDLE_OPACITY_IDLE,
      );
      this.endPoseEdit(released);
    }
    if (this.draggedPanelSocket !== null) {
      const socket = this.draggedPanelSocket;
      this.endPanelTipDrag(socket);
    }
    this.cameraDrag = null;
    this.pointerGestureDirty = false;
    if (this.dragPointerId >= 0) tryReleasePointerCapture(this.canvas, this.dragPointerId);
    this.dragPointerId = -1;
    this.canvas.style.cursor = "crosshair";
  }

  /**
   * Runs at most one pose/panel solve for all pointer events received since the
   * previous game frame. Pointer-up calls it too, preserving the exact release
   * position when the browser delivers down/move/up before another frame.
   */
  private flushPointerGesture(): void {
    if (!this.pointerGestureDirty) return;
    this.pointerGestureDirty = false;
    if (this.draggedHandle !== null) {
      this.dragHandle(this.draggedHandle);
    } else if (this.draggedPanelSocket !== null) {
      this.dragPanelTip(this.draggedPanelSocket);
    }
  }

  private handleKey(event: KeyboardEvent): void {
    const key = forgeKey(event);
    if (event.ctrlKey || event.metaKey) {
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
      } else if (key === "y") {
        event.preventDefault();
        this.redo();
      } else if (key === "d" && this.toolsActive) {
        // Duplicate lives here rather than in the plain switch below because
        // bare D strafes: WASD walks the body, so a build key on D would never
        // have been reached. Ctrl+D is the editor convention anyway.
        event.preventDefault();
        this.duplicateSelectedShape();
      }
      return;
    }

    // Shift+number changes the selected thing, while an unmodified number
    // changes tools. This makes one hand enough to move from a body part to a
    // strong silhouette without crossing the screen to the context panel.
    if (event.shiftKey && /^[1-5]$/.test(key)) {
      if (!this.toolsActive) return;
      const index = Number(key) - 1;
      if (this.mode === "shape") {
        const preset = FORGE_QUICK_SHAPES[index];
        if (preset !== undefined) this.applySegmentFormPreset(preset.values, preset.profileId);
      } else if (this.mode === "panels") {
        const preset = FORGE_QUICK_PANELS[index];
        if (preset !== undefined) this.applyPanelPreset(preset.values, preset.profileId);
      } else if (this.mode === "pose") {
        const arrangement = STARTER_ARRANGEMENT_IDS[index];
        if (arrangement !== undefined) this.applyArrangement(arrangement);
      }
      event.preventDefault();
      return;
    }

    if (key === "tab") {
      const current = FORGE_TOOL_MODES.indexOf(this.mode);
      const step = event.shiftKey ? -1 : 1;
      const next = (current + step + FORGE_TOOL_MODES.length) % FORGE_TOOL_MODES.length;
      this.setToolMode(FORGE_TOOL_MODES[next]!);
      event.preventDefault();
      return;
    }

    // The walk keys are held rather than pressed, so they are taken before the
    // switch: the browser repeats a held key and every repeat would otherwise
    // fall through to the default and be handed back to the page.
    if (!this.locked && this.locomotion?.press(key) === true) {
      event.preventDefault();
      return;
    }

    switch (key) {
      case "1":
        this.setToolMode("pose");
        break;
      case "2":
        this.setToolMode("shape");
        break;
      case "3":
        this.setToolMode("panels");
        break;
      case "4":
        this.setToolMode("material");
        break;
      case "5":
        this.setToolMode("paint");
        break;
      case "e":
        // Held, not toggled: §7.5 lists this as "hold Inspector preview", on
        // Space. Space is the jump now (CLAUDE.md override 6), and a key cannot
        // be both a movement verb and a camera hold, so the preview moved to
        // the letter its own name starts with, next to the walk keys.
        this.setPreview("inspector");
        break;
      case "v":
        this.setSilhouette(!this.silhouette);
        break;

      case "arrowleft":
      case "arrowright":
      case "arrowup":
      case "arrowdown":
      case "pageup":
      case "pagedown": {
        // Precise placement by key. At this scale - the body is 0.35 m tall -
        // a shape that needs to sit a few millimetres over is genuinely hard
        // to drag there, and a mouse that overshoots costs more time than the
        // move saved. Arrows move in the body's own frame: left and right
        // across it, up and down along it, page keys through it.
        if (!this.toolsActive || this.mode !== "panels" || this.selectedShapeId === null) break;
        event.preventDefault();
        const step = key === "arrowleft" || key === "arrowdown" || key === "pagedown"
          ? -SHAPE_NUDGE_M
          : SHAPE_NUDGE_M;
        if (key === "arrowleft" || key === "arrowright") this.nudgeSelectedShape(step, 0, 0);
        else if (key === "arrowup" || key === "arrowdown") this.nudgeSelectedShape(0, step, 0);
        else this.nudgeSelectedShape(0, 0, step);
        break;
      }
      case "delete":
      case "backspace":
        // Both, because half of players reach for one and half the other, and
        // being wrong costs a trip to a panel to find the button.
        if (this.toolsActive) this.deleteSelectedShape();
        break;
      case "f":
        // In paint mode F belongs to the brush's eyedropper, which the paint
        // panel binds. In material mode F arms the same contract the paint
        // dropper keeps: press, then click to copy. Everywhere else it stays
        // the §7.5 instant sample at the pointer.
        if (!this.toolsActive) break;
        if (this.mode === "material") {
          this.setMaterialDropperArmed(!this.materialDropperArmed);
        } else if (this.mode !== "paint") {
          this.sampleUnderPointer();
        }
        break;
      case "m":
        this.setMirror(!this.mirror);
        break;
      case "q":
        this.toggleGrapple();
        break;
      case "r":
        this.cycleQuickOption(event.shiftKey ? -1 : 1);
        break;
      case "x":
        if (!this.toolsActive || this.mode !== "paint" || this.locked) return;
        this.paintTool.setEraser(!this.paintTool.getState().eraser);
        break;
      case "-":
      case "_":
        if (!this.toolsActive || this.mode !== "paint" || this.locked) return;
        this.paintTool.setBrushSize(BRUSH_RADIUS_STEPS[Math.max(
          0,
          nearestBrushStepIndex(this.paintTool.getState().brushSize) - 1,
        )]!);
        break;
      case "=":
      case "+":
        if (!this.toolsActive || this.mode !== "paint" || this.locked) return;
        this.paintTool.setBrushSize(BRUSH_RADIUS_STEPS[Math.min(
          BRUSH_RADIUS_STEPS.length - 1,
          nearestBrushStepIndex(this.paintTool.getState().brushSize) + 1,
        )]!);
        break;
      case "[":
        if (!this.toolsActive) return;
        this.cycleArrangement(-1);
        break;
      case "]":
        if (!this.toolsActive) return;
        this.cycleArrangement(1);
        break;
      case "enter":
        this.lock();
        break;
      case "escape":
        if (this.locked) {
          this.unlock();
        } else if (this.mode !== "pose") {
          this.setToolMode("pose");
        } else {
          this.finishActivePointerGesture();
          this.setHovered(null);
          this.status = "Pose tool disengaged. Choose a handle when ready.";
          this.audio.play("ui_back");
          this.emit();
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private stepGamepadInput(): void {
    const pad = readStandardGamepad();
    const desired = new Set<string>();
    if (pad !== null && !this.locked) {
      if (pad.moveY < -0.28) desired.add("w");
      if (pad.moveY > 0.28) desired.add("s");
      if (pad.moveX < -0.28) desired.add("a");
      if (pad.moveX > 0.28) desired.add("d");
      if (pad.jump) desired.add(" ");
    }
    for (const key of this.gamepadMoveKeys) if (!desired.has(key)) this.locomotion?.release(key);
    for (const key of desired) if (!this.gamepadMoveKeys.has(key)) this.locomotion?.press(key);
    this.gamepadMoveKeys.clear();
    for (const key of desired) this.gamepadMoveKeys.add(key);

    const previous = pad?.previousTool ?? false;
    const next = pad?.nextTool ?? false;
    const mirror = pad?.mirror ?? false;
    const grapple = pad?.grapple ?? false;
    const toolAction = pad?.toolAction ?? null;
    if (previous && !this.gamepadPreviousToolHeld) {
      const index = (FORGE_TOOL_MODES.indexOf(this.mode) - 1 + FORGE_TOOL_MODES.length) % FORGE_TOOL_MODES.length;
      this.setToolMode(FORGE_TOOL_MODES[index]!);
    }
    if (next && !this.gamepadNextToolHeld) {
      const index = (FORGE_TOOL_MODES.indexOf(this.mode) + 1) % FORGE_TOOL_MODES.length;
      this.setToolMode(FORGE_TOOL_MODES[index]!);
    }
    if (mirror && !this.gamepadMirrorHeld) this.setMirror(!this.mirror);
    if (grapple && !this.gamepadGrappleHeld) this.toggleGrapple();
    if (toolAction !== null && toolAction !== this.gamepadToolActionHeld) {
      const directMode: Partial<Record<InputAction, ForgeToolMode>> = {
        toolPose: "pose",
        toolShape: "shape",
        toolPanels: "panels",
        toolMaterial: "material",
        toolPaint: "paint",
      };
      const mode = directMode[toolAction];
      if (mode !== undefined) this.setToolMode(mode);
    }
    this.gamepadPreviousToolHeld = previous;
    this.gamepadNextToolHeld = next;
    this.gamepadMirrorHeld = mirror;
    this.gamepadGrappleHeld = grapple;
    this.gamepadToolActionHeld = toolAction;
  }

  /**
   * Runs the active tool's left-click. Returns false when the press found
   * nothing to act on, which is the caller's cue to hand it to the camera.
   */
  private beginLeftPress(event: PointerEvent): boolean {
    this.updatePointerNdc(event);
    if (this.locked || !this.toolsActive) {
      return false;
    }

    if (this.mode === "pose") {
      const handle = this.pickHandle() ?? this.pickHandleNearBody();
      if (handle !== null) {
        this.draggedHandle = handle;
        this.setHandleOpacity(handle, HANDLE_OPACITY_DRAG);
        this.pinned.add(handle.def.target);
        const mirroredTarget = this.mirror ? mirroredIkTarget(handle.def.target) : null;
        if (mirroredTarget !== null) this.pinned.add(mirroredTarget);
        this.poseEditBefore = capturePoseSnapshot(this.state);
        const world = this.pose.worldPositions[handle.boneIndex];
        if (world !== undefined) {
          this.dragPlane.setFromNormalAndCoplanarPoint(
            this.camera.getWorldDirection(this.scratchForward),
            this.scratchVector.set(world.x, world.y, world.z),
          );
          this.raycaster.setFromCamera(this.pointerNdc, this.camera);
          if (this.raycaster.ray.intersectPlane(this.dragPlane, this.scratchVector) !== null) {
            this.dragOffset.set(world.x, world.y, world.z).sub(this.scratchVector);
          } else {
            this.dragOffset.set(0, 0, 0);
          }
        }
        this.audio.play("ui_click");
        return true;
      }
      return false;
    }

    if (this.mode === "shape") {
      // The arrows outrank the body, EXCEPT under shift: shift is the
      // selection modifier, and a shift-press that grazed an arrow must
      // still add the part behind it rather than start a dead drag.
      const arrow = event.shiftKey ? null : this.pickGizmoArrow();
      if (arrow !== null) {
        this.beginGizmoDrag(arrow);
        this.audio.play("ui_click");
        return true;
      }
      const slot = this.pickSegmentSlot();
      if (slot < 0) {
        return false;
      }
      this.commitEdits();
      if (event.shiftKey && this.selectedSlots.size > 0) {
        // Shift grows or shrinks the set; the last part touched leads it.
        if (this.selectedSlots.has(slot) && this.selectedSlots.size > 1) {
          this.selectedSlots.delete(slot);
          const next = [...this.selectedSlots][0];
          if (this.selectedSlot === slot && next !== undefined) this.selectSegment(next, true);
        } else {
          this.selectedSlots.add(slot);
          this.selectSegment(slot, true);
        }
      } else {
        this.selectSegment(slot);
      }
      const count = this.selectedSlots.size;
      const bone = SEGMENT_BONES[this.selectedSlot] ?? "segment";
      this.status =
        count > 1
          ? `${String(count)} parts selected. Drag the arrows to resize them together.`
          : `Editing ${bone}. Drag the arrows to resize; shift-click adds parts.`;
      this.audio.play("ui_click");
      this.emit();
      return true;
    }

    if (this.mode === "panels") {
      // The build tool's own pointer path, ahead of the panel handles it is
      // replacing. Without this the arrows drew on a selected shape and did
      // nothing when dragged, and a shape could not be picked in the world at
      // all - the list was the only way to select one.
      const arrow = this.pickGizmoArrow();
      if (arrow !== null) {
        // Shift turns instead of sliding, which keeps one set of arrows doing
        // both jobs rather than putting a mode switch between the player and
        // the shape they are holding.
        // Alt stretches, Shift turns, bare drag slides. Alt rather than Ctrl
        // because Ctrl is already undo, redo and duplicate.
        // Alt+Shift resizes the whole shape, Alt one axis, Shift turns, bare
        // drag slides. Four transforms on one set of arrows, and the player
        // never leaves the shape to find a mode.
        this.beginGizmoDrag(
          arrow,
          event.altKey && event.shiftKey
            ? "uniform"
            : event.altKey
              ? "scale"
              : event.shiftKey
                ? "turn"
                : "move",
        );
        this.audio.play("ui_click");
        return true;
      }
      // Select-versus-draw is decided by MOVEMENT, not by what is under the
      // press. Deciding at press time meant a press that landed on any built
      // shape selected it instead of starting a stroke, so once the first
      // piece existed nothing overlapping could ever be drawn - and a
      // disguise is nothing but overlapping pieces. The press starts a draw
      // either way; a release that never moved becomes the click it was.
      if (!this.locked) {
        this.pendingShapeSelect = this.pickShape();
        this.beginShapeDraw();
        return true;
      }

      const tipSocket = this.pickPanelTipHandle();
      if (tipSocket !== null) {
        const panel = this.findPanel(tipSocket);
        if (panel !== null && this.mimic.panelTipWorld(tipSocket, this.panelTip)) {
          this.commitEdits();
          this.draggedPanelSocket = tipSocket;
          this.panelDragBefore = clonePanelState(panel);
          this.panelDragAnchorBefore = anchorForBone(this.state.anchors, tipSocket);
          this.selectPanelSocket(tipSocket);
          this.dragPlane.setFromNormalAndCoplanarPoint(
            this.camera.getWorldDirection(this.scratchForward),
            this.panelTip,
          );
          this.raycaster.setFromCamera(this.pointerNdc, this.camera);
          if (this.raycaster.ray.intersectPlane(this.dragPlane, this.scratchVector) !== null) {
            this.dragOffset.copy(this.panelTip).sub(this.scratchVector);
          } else {
            this.dragOffset.set(0, 0, 0);
          }
          this.audio.play("ui_click");
          this.emit();
          return true;
        }
      }
      const socket = this.pickSocket();
      if (socket === null) {
        return false;
      }
      this.commitEdits();
      this.selectPanelSocket(socket);
      if (this.findPanel(socket) === null) {
        this.addPanel(socket);
      } else {
        this.audio.play("ui_click");
        this.status = `Panel on ${socket.replace("panel_socket_", "socket ")} selected.`;
        this.emit();
      }
      return true;
    }

    // An armed dropper turns the click into the sample, exactly as paint's
    // does (2026-08-05): whatever was clicked - own part, panel, or the room
    // - is copied instead of painted over.
    if (this.materialDropperArmed) {
      this.materialDropperArmed = false;
      this.sampleUnderPointer();
      return true;
    }
    // Built shapes take the swatch before the body does. They stand in front
    // of it - that is the point of them - so a click that lands on one was
    // meant for it, and a player painting a jar should not have to switch back
    // to the Build tool to do it.
    const shapeId = this.pickShape();
    if (shapeId !== null) {
      const shape = this.state.shapes.find((entry) => entry.id === shapeId);
      if (shape !== undefined) {
        this.selectShape(shapeId);
        this.assignSwatch(shape.materialSlotId);
        return true;
      }
    }
    const slot = this.pickSegmentSlot();
    if (slot >= 0) {
      const bone = SEGMENT_BONES[slot];
      if (bone !== undefined) {
        this.selectSegment(slot);
        this.assignSwatch(bone);
        return true;
      }
      return false;
    }
    const socket = this.pickSocket();
    if (socket === null) {
      return false;
    }
    this.assignSwatch(socket);
    return true;
  }

  /**
   * Closes a drag. The pose change and any anchor the release sealed or broke
   * are one gesture, so they undo together.
   */
  private endPoseEdit(handle: Handle | null): void {
    const before = this.poseEditBefore;
    this.poseEditBefore = null;
    const anchorPart = handle === null ? null : this.commitDraggedAnchor(handle);
    this.snapCandidate = null;
    this.snapping = false;

    if (before === null) {
      if (anchorPart !== null) {
        this.commands.push(anchorPart, this.state);
        this.solveAndRefresh();
        this.emit();
      }
      return;
    }

    capturePoseToDisguiseState(this.pose, this.state);
    const after = capturePoseSnapshot(this.state);
    const posed = !poseSnapshotsEqual(before, after);
    if (!posed && anchorPart === null) {
      return;
    }

    const issuedAt = performance.now();
    const posePart = createPoseCommand(before, after, issuedAt);
    if (anchorPart === null) {
      this.commands.push(posePart, this.state);
    } else {
      this.commands.push(
        createCompositeCommand(anchorPart.label, [posePart, anchorPart], issuedAt),
        this.state,
      );
      this.solveAndRefresh();
    }
    this.emit();
  }

  /**
   * Turns the state of a finished drag into an anchor edit: a contact point
   * released on a surface seals to it, and one dragged away from its surface
   * lets go. Returns null when the anchor is unchanged.
   */
  private commitDraggedAnchor(handle: Handle): ForgeCommand | null {
    const bone = handle.def.bone;
    if (!isAnchorableBone(bone)) {
      return null;
    }
    const existing = anchorForBone(this.state.anchors, bone);
    const candidate = this.snapCandidate;

    if (candidate !== null) {
      const anchor = captureAnchor(nextAnchorId(bone), candidate, ANCHOR_GAP_M);
      if (anchor === null) {
        this.status = "That surface cannot hold an anchor.";
        return null;
      }
      this.audio.play("anchor_snap");
      this.status = `${handle.def.label} sealed to ${candidate.object.name}.`;
      return createAnchorCommand(bone, existing, anchor, performance.now());
    }

    if (existing !== null) {
      // A small wobble should not break a seal; only a real move away does.
      const resolved = this.resolvedAnchorPool.get(bone);
      const effector = this.pose.worldPositions[boneIndex(bone)];
      if (resolved !== undefined && effector !== undefined) {
        const distance = resolved.position.distanceTo(
          this.scratchVector.set(effector.x, effector.y, effector.z),
        );
        if (distance <= ANCHOR_RELEASE_RADIUS_M) {
          return null;
        }
      }
      this.status = `${handle.def.label} released.`;
      return createAnchorCommand(bone, existing, null, performance.now());
    }
    return null;
  }

  private dragHandle(handle: Handle): void {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    if (this.raycaster.ray.intersectPlane(this.dragPlane, this.scratchVector) === null) {
      return;
    }
    this.scratchVector.add(this.dragOffset);
    const target = this.targets.get(handle.def.target);
    if (target === undefined) {
      return;
    }
    this.scratchVector.set(
      clamp(this.scratchVector.x, this.workspace.minX, this.workspace.maxX),
      clamp(this.scratchVector.y, this.workspace.minY, this.workspace.maxY),
      clamp(this.scratchVector.z, this.workspace.minZ, this.workspace.maxZ),
    );
    if (handle.def.target === "pelvis") {
      this.limitRootDrag(target, this.scratchVector);
    }
    target.set(this.scratchVector.x, this.scratchVector.y, this.scratchVector.z);

    const rootX = this.pose.rootPosition.x;
    const rootY = this.pose.rootPosition.y;
    const rootZ = this.pose.rootPosition.z;
    this.updateSnapCandidate(handle, target);
    this.mirrorDraggedTarget(handle.def.target, target);
    this.solveAndRefresh();
    // Charged after the solve rather than before it, because an anchor pass can
    // walk the root further than the pointer asked for. Every drag pays, not
    // only the pelvis: whatever moved the root spent the same budget.
    this.spendCreepBudget(rootX, rootY, rootZ);
    this.startManipulationAudio(0.75);
  }

  /**
   * Looks for a surface under the dragged contact point and, when one is close
   * enough, pulls the target onto it so the snap is felt while dragging rather
   * than only after release.
   */
  private updateSnapCandidate(handle: Handle, target: CoreVector3): void {
    const bone = handle.def.bone;
    if (!isAnchorableBone(bone)) {
      this.snapCandidate = null;
      return;
    }

    this.scratchVector.set(target.x, target.y, target.z);
    const candidate = this.probeAnchorSurface(bone, this.scratchVector);
    this.snapCandidate = candidate;

    if (candidate === null) {
      if (this.snapping) {
        this.snapping = false;
        this.emit();
      }
      return;
    }

    // Hold the contact point just off the surface while the snap is live.
    this.scratchVector.copy(candidate.point).addScaledVector(candidate.normal, ANCHOR_GAP_M);
    target.set(this.scratchVector.x, this.scratchVector.y, this.scratchVector.z);

    if (!this.snapping) {
      this.snapping = true;
      this.audio.play("anchor_snap", 0.05);
      this.status = `Snapping ${handle.def.label} to ${candidate.object.name}. Release to seal it.`;
      this.emit();
    }
  }

  /** Keeps a paired hand or foot at the reflected world-space target. */
  private mirrorDraggedTarget(name: IkTargetName, target: CoreVector3): void {
    if (!this.mirror) return;
    const opposite = mirroredIkTarget(name);
    if (opposite === null) return;
    const mirrored = this.targets.get(opposite);
    if (mirrored === undefined) return;

    const root = this.pose.rootPosition;
    const rotation = this.pose.rootRotation;
    this.mirrorRotation.set(rotation.x, rotation.y, rotation.z, rotation.w).invert();
    this.mirrorScratch
      .set(target.x - root.x, target.y - root.y, target.z - root.z)
      .applyQuaternion(this.mirrorRotation);
    this.mirrorScratch.x *= -1;
    this.mirrorRotation.set(rotation.x, rotation.y, rotation.z, rotation.w);
    this.mirrorScratch.applyQuaternion(this.mirrorRotation);
    mirrored.set(
      root.x + this.mirrorScratch.x,
      root.y + this.mirrorScratch.y,
      root.z + this.mirrorScratch.z,
    );
  }

  private updatePointerNdc(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      -(((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1),
    );
  }

  private pickHandle(): Handle | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects([...this.handleMeshes], false);
    const first = hits[0];
    if (first === undefined) {
      return null;
    }
    return this.handles.find((handle) => handle.pick === first.object) ?? null;
  }

  /**
   * Grab a limb, not a handle (design review 2026-08-05): a press that lands
   * on the body itself takes the nearest IK handle to the point it touched,
   * so a novice clicks the shin and gets the foot without ever having learned
   * what the gizmos are. A press on empty air still returns null and falls
   * through to the camera, which keeps the one-button contract intact.
   */
  private pickHandleNearBody(): Handle | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects([...this.mimic.segmentMeshes], false);
    const hit = hits[0];
    if (hit === undefined) return null;
    let best: Handle | null = null;
    let bestSq = WORLD_SCALE.playerHeight * WORLD_SCALE.playerHeight;
    for (const handle of this.handles) {
      const world = this.pose.worldPositions[handle.boneIndex];
      if (world === undefined) continue;
      const dx = world.x - hit.point.x;
      const dy = world.y - hit.point.y;
      const dz = world.z - hit.point.z;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq < bestSq) {
        bestSq = distanceSq;
        best = handle;
      }
    }
    return best;
  }

  private pickSegmentSlot(): number {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects([...this.mimic.segmentMeshes], false);
    const slot = hits[0]?.object.userData["segmentSlot"];
    return typeof slot === "number" ? slot : -1;
  }

  private pickSocket(): PanelSocketName | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    // The invisible pick discs stand in for the studs (2026-08-05): the stud
    // itself is a body-scaled feature a few pixels wide, and asking players
    // to hit it exactly is why the panel tool read as dead. The body's own
    // shells join the ray as occluders (2026-08-06): without them a click on
    // the chest reached the stud on the BACK, and the panel it deployed was
    // invisible from where the player stood - "it did nothing".
    const candidates = [
      ...this.mimic.panelMeshes,
      ...this.mimic.socketMarkers,
      ...this.mimic.socketPicks,
    ].filter((mesh) => mesh.visible);
    const hits = this.raycaster.intersectObjects(
      [...candidates, ...this.mimic.segmentMeshes],
      false,
    );
    let socketHit: { distance: number; socket: PanelSocketName } | null = null;
    let bodyDistance = Number.POSITIVE_INFINITY;
    for (const hit of hits) {
      const socket = hit.object.userData["panelSocket"];
      if (typeof socket === "string") {
        if (socketHit === null && isPanelSocketName(socket)) {
          socketHit = { distance: hit.distance, socket };
        }
      } else if (hit.distance < bodyDistance) {
        bodyDistance = hit.distance;
      }
    }
    if (socketHit === null) return null;
    // A stud sits ON the shell, so the shell may beat its own stud by a
    // hair; only a body hit clearly in FRONT of the socket occludes it.
    return socketHit.distance <= bodyDistance + PANEL_PICK_OCCLUSION_TOLERANCE_M
      ? socketHit.socket
      : null;
  }

  private raycastRoom(): THREE.Intersection | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects([...this.roomObjects], true);
    return hits[0] ?? null;
  }

  private updateCamera(): void {
    if (this.preview !== "none") {
      this.placePreviewCamera();
      return;
    }
    // The orbit angle and distance are the player's and answer at once; only the
    // point being orbited lags, and the sway rides on top of wherever it got to.
    const targetY = this.cameraTarget.y + this.cameraSway();
    this.scratchVector.set(this.cameraTarget.x, targetY, this.cameraTarget.z);

    // Out from the creature along the boom, which is the direction the camera
    // would have to travel to reach where the angle asks for it.
    const cosPitch = Math.cos(this.pitch);
    this.scratchForward.set(
      Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosPitch,
    );
    const boom = this.boomLength();

    this.camera.position
      .copy(this.scratchVector)
      .addScaledVector(this.scratchForward, boom);
    this.camera.lookAt(this.scratchVector);
  }

  /**
   * How far back the shot may stand this frame. The map's blockers are the same
   * ones the Inspector's own rig pulls its boom in against, so both cameras stop
   * at the same wall; without it the orbit swept the view through the floor and
   * the legs of the furniture and left the creature behind a carpet.
   *
   * The practice room publishes no geometry, so there the boom is simply the
   * distance the player zoomed to.
   */
  private boomLength(): number {
    const navData = this.navData;
    if (navData === null) return this.radius;
    const hit = nearestBlockerEntry(
      navData.blockers,
      this.scratchVector,
      this.scratchForward,
      0,
      this.radius,
    );
    if (hit < 0) return this.radius;
    // Never past the distance the player zoomed to: the floor on the pull-in
    // stops the shot collapsing into the creature's own head, and a floor that
    // outran the zoom would push the camera further out than it was asked for.
    return Math.min(this.radius, Math.max(ORBIT_MIN_RADIUS_M, hit - ORBIT_SKIN_M));
  }

  /**
   * Both previews look at the Mimic from a player's own eye height. The
   * Inspector view uses the direction the player is already orbiting from, so it
   * answers "how does this read from where I am looking" rather than from a
   * fixed seat; the doorway view answers the other question, and takes the long
   * axis of the room instead, standing off down whichever end is further away
   * and staying inside the workspace.
   */
  private placePreviewCamera(): void {
    const standBack =
      this.preview === "doorway"
        ? WORLD_SCALE.playerHeight * DOORWAY_STAND_BACK_PER_BODY_HEIGHT
        : INSPECTOR_STAND_BACK_M;

    if (this.preview === "doorway") {
      const alongX =
        this.workspace.maxX - this.workspace.minX >= this.workspace.maxZ - this.workspace.minZ;
      const span = alongX
        ? this.workspace.maxX - this.orbitTarget.x - (this.orbitTarget.x - this.workspace.minX)
        : this.workspace.maxZ - this.orbitTarget.z - (this.orbitTarget.z - this.workspace.minZ);
      const sign = span >= 0 ? 1 : -1;
      this.scratchForward.set(alongX ? sign : 0, 0, alongX ? 0 : sign);
    } else {
      this.scratchForward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).normalize();
    }

    // The workspace reaches the room's own faces, so a preview standing further
    // back than the room is deep has to stop short of the wall rather than
    // inside it. One player radius is where a player would stop too.
    const inset = WORLD_SCALE.playerRadius;
    this.camera.position.set(
      clamp(
        this.orbitTarget.x + this.scratchForward.x * standBack,
        this.workspace.minX + inset,
        this.workspace.maxX - inset,
      ),
      INSPECTOR_EYE_HEIGHT_M,
      clamp(
        this.orbitTarget.z + this.scratchForward.z * standBack,
        this.workspace.minZ + inset,
        this.workspace.maxZ - inset,
      ),
    );
    this.camera.lookAt(this.orbitTarget);
  }
}

const FORGE_ACTION_KEYS: Partial<Readonly<Record<InputAction, string>>> = {
  moveForward: "w",
  moveBack: "s",
  moveLeft: "a",
  moveRight: "d",
  jump: " ",
  grapple: "q",
  toolPose: "1",
  toolShape: "2",
  toolPanels: "3",
  toolMaterial: "4",
  toolPaint: "5",
  mirror: "m",
  eyedropper: "f",
};

function forgeKey(event: KeyboardEvent): string {
  const action = event.code === "" ? null : actionForCode(event.code);
  return (action === null ? undefined : FORGE_ACTION_KEYS[action]) ?? event.key.toLowerCase();
}

const TOOL_HINTS: Readonly<Record<ForgeToolMode, string>> = {
  pose: "Drag a handle to pose. Drag open space to look around.",
  shape: "Click a body part, then stretch it with the sliders.",
  panels: "Add cubes and cylinders, then drag the arrows to build the object you want to be.",
  material: "Point at the room and press F to sample, then click a part to paint it.",
  // How to paint is on the paint panel, once. This strip carries the thing the
  // panel does not: that the camera and the brush share the left button, so a
  // drag that misses the body looks around instead of painting nothing.
  paint: "Spray the body, or drag open space to look around.",
};

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Heading difference taken the short way around ±π. */
function shortestAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = radians % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  return wrapped;
}

function sameForm(a: SegmentFormState, b: SegmentFormState): boolean {
  return (
    a.length === b.length &&
    a.width === b.width &&
    a.depth === b.depth &&
    a.flatten === b.flatten &&
    a.taper === b.taper &&
    a.roundness === b.roundness &&
    a.twist === b.twist &&
    a.profileId === b.profileId
  );
}

function samePanel(a: PanelState, b: PanelState): boolean {
  return (
    a.deployed === b.deployed &&
    a.hingeAngle === b.hingeAngle &&
    a.extension === b.extension &&
    a.width === b.width &&
    a.height === b.height &&
    a.profileId === b.profileId
  );
}

/** Segment slot of the mirrored bone, or -1 for a bone on the symmetry plane. */
function mirroredSegmentSlot(slot: number): number {
  const bone = SEGMENT_BONES[slot];
  if (bone === undefined) return -1;
  const mirrored = bone.endsWith("_L")
    ? `${bone.slice(0, -2)}_R`
    : bone.endsWith("_R")
      ? `${bone.slice(0, -2)}_L`
      : null;
  if (mirrored === null) return -1;
  return SEGMENT_BONES.findIndex((name) => name === mirrored);
}

function mirroredIkTarget(target: IkTargetName): IkTargetName | null {
  switch (target) {
    case "hand_L":
      return "hand_R";
    case "hand_R":
      return "hand_L";
    case "foot_L":
      return "foot_R";
    case "foot_R":
      return "foot_L";
    default:
      return null;
  }
}

/** Copies the visible form while preserving the opposite socket's identity. */
function copyPanelForm(source: PanelState, target: PanelState): void {
  target.deployed = source.deployed;
  target.hingeAngle = source.hingeAngle;
  target.extension = source.extension;
  target.width = source.width;
  target.height = source.height;
  target.profileId = source.profileId;
}
