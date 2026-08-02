import { Vector3 as CoreVector3 } from "three";
import * as THREE from "three/webgpu";

import { DisposalBag } from "../engine/DisposalBag";
import type { AnchorState } from "../mimic/disguiseState";
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
import { WORLD_SCALE } from "../inspector/navData";
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
  cloneSegmentForm,
  isSegmentProfileId,
  type SegmentFormState,
  type SegmentProfileId,
} from "../mimic/segmentForm";
import { createPuckGeometry } from "../mimic/visual/mimicGeometry";
import { MimicVisual } from "../mimic/visual/MimicVisual";
import {
  MIMIC_LEGAL_SWATCHES,
  swatchById,
  type MaterialSwatch,
} from "../mimic/visual/materialSwatches";
import { createPaintTool, type PaintTool } from "../paint/createPaintTool";
import type { QualitySettings } from "../rendering/quality";
import { AudioPlayer } from "./AudioPlayer";
import {
  assignmentSlots,
  BODY_SLOT_ID,
  resolvedSwatchFor,
  validateAssignment,
} from "./materialAssignment";
import {
  capturePoseSnapshot,
  createAnchorCommand,
  createCompositeCommand,
  createMaterialCommand,
  createPanelCommand,
  createPoseCommand,
  createReplaceCommand,
  createSegmentFormCommand,
  ForgeCommandStack,
  poseSnapshotsEqual,
  type ForgeCommand,
  type PoseSnapshot,
} from "./forgeCommands";
import { resolveSurfaceSwatch } from "./roomSwatches";
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

export type PanelNumericKey = "deployed" | "hingeAngle" | "extension" | "width" | "height";

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

export interface ForgeHudState {
  readonly mode: ForgeToolMode;
  readonly locked: boolean;
  readonly mirror: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly segment: ForgeSegmentSelection | null;
  readonly panel: ForgePanelSelection | null;
  readonly sampledSwatchId: string | null;
  readonly bodySwatchId: string;
  readonly arrangementId: StarterArrangementId;
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

export interface ForgeControllerOptions {
  readonly scene: THREE.Scene;
  readonly canvas: HTMLCanvasElement;
  readonly quality: QualitySettings;
  /** Where the Mimic stands, in world metres. */
  readonly origin?: THREE.Vector3;
  /** The active map's playable volume. Defaults to the practice room's. */
  readonly workspace?: ForgeWorkspace;
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
  readonly solid: THREE.Mesh;
  readonly ghost: THREE.Mesh;
  readonly group: THREE.Object3D;
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
const CAMERA_MAX_RADIUS = 7 * RIG_TO_WORLD;
const CAMERA_MIN_PITCH = -1.2;
const CAMERA_MAX_PITCH = 1.45;
const ORBIT_PER_PIXEL = 0.007;
const PITCH_PER_PIXEL = 0.005;
const ZOOM_PER_NOTCH = 0.0016;

/**
 * Handle radius in metres at one metre from the camera, kept constant on
 * screen. This one is a ratio rather than a length: it multiplies the camera
 * distance, which already shrank with the body, so converting it too would
 * shrink the handles twice.
 */
const HANDLE_SCREEN_RADIUS = 0.028;
const HANDLE_MIN_RADIUS = 0.022 * RIG_TO_WORLD;
const HANDLE_MAX_RADIUS = 0.075 * RIG_TO_WORLD;

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

const SERVO_INTERVAL_MS = 130;

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
const DOORWAY_POSITION = new THREE.Vector3(2.9, 1.62, 2.6);

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
  private readonly mimic = new MimicVisual();
  private readonly handleGroup = new THREE.Object3D();
  private readonly handles: readonly Handle[];
  private readonly handleMeshes: readonly THREE.Mesh[];
  private readonly roomObjects: readonly THREE.Object3D[];
  private readonly workspace: ForgeWorkspace;
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

  private state: DisguiseState;
  private lockedPayload: LockedDisguise | null = null;

  private orbitTarget = new THREE.Vector3();
  private yaw = 0.7;
  private pitch = 0.22;
  private radius = 2.4;
  private viewportWidth = 1;
  private viewportHeight = 1;

  private mode: ForgeToolMode = "pose";
  private mirror = false;
  private locked = false;
  private status = "Drag a handle to pose. 1 pose  2 shape  3 panels  4 material  5 paint.";
  private sampledSwatchId: string | null = null;
  private selectedSlot = -1;
  private selectedSocket: PanelSocketName | null = null;
  private formEpoch = 0;
  private arrangementIndex = 0;

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
  private draggedHandle: Handle | null = null;
  private dragPointerId = -1;
  private cameraDrag: "orbit" | "pan" | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private poseEditBefore: PoseSnapshot | null = null;
  private segmentEdit: SegmentEdit | null = null;
  private panelEditBefore: PanelState | null = null;
  private panelEditSocket: PanelSocketName | null = null;

  private readonly dragPlane = new THREE.Plane();
  private readonly dragOffset = new THREE.Vector3();
  private readonly scratchVector = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
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
  private readonly scratchRight = new THREE.Vector3();
  private readonly scratchUp = new THREE.Vector3();
  private readonly scratchForward = new THREE.Vector3();

  constructor(options: ForgeControllerOptions) {
    this.scene = options.scene;
    this.canvas = options.canvas;
    this.roomObjects = [...options.scene.children];
    this.workspace = options.workspace ?? TEST_ROOM_WORKSPACE;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 60);

    const origin = options.origin ?? new THREE.Vector3(-1.55, 0.075, -1.05);
    this.state = createStarterArrangement("upright");
    this.state.root.position = [origin.x, origin.y, origin.z];
    this.state.materials = [{ slotId: BODY_SLOT_ID, swatchId: DEFAULT_BODY_SWATCH_ID }];
    applyDisguiseStateToPose(this.state, this.pose);

    this.handleGroup.name = "forge_handles";
    this.handles = this.buildHandles();
    this.handleMeshes = this.handles.map((handle) => handle.solid);
    this.buildAnchorMarkerAssets();
    this.scene.add(this.mimic.root);
    this.scene.add(this.handleGroup);
    this.indexAnchorSurfaces();

    this.paintMeshes = [...this.mimic.segmentMeshes, ...this.mimic.panelMeshes];
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
      ownsPointerEvent: (event) => this.ownsPointerEvent(event),
    });

    this.orbitTarget.set(origin.x, origin.y + 0.55, origin.z);
    this.updateCamera();
    this.applyQuality(options.quality);
    this.captureTargets();
    this.refreshAll();
    this.attachInput();
  }

  /** A brass seal for a met anchor, a warm red for one the pose cannot reach. */
  private buildAnchorMarkerAssets(): void {
    this.anchorMarkerGeometry = this.bag.add(createPuckGeometry(0.034, 0.01));
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

  update(): void {
    this.layoutHandles();
    // Cheap when nothing was painted: a reference check per part and an upload
    // only while the atlas is dirty.
    this.paintTool.update();
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
    return {
      mode: this.mode,
      locked: this.locked,
      mirror: this.mirror,
      canUndo: this.commands.canUndo,
      canRedo: this.commands.canRedo,
      undoLabel: this.commands.nextUndoLabel,
      segment,
      panel:
        this.selectedSocket === null
          ? null
          : {
              socketId: this.selectedSocket,
              panel: panelState === null ? null : clonePanelState(panelState),
            },
      sampledSwatchId: this.sampledSwatchId,
      bodySwatchId: resolvedSwatchFor(this.state.materials, BODY_SLOT_ID, DEFAULT_BODY_SWATCH_ID),
      arrangementId: STARTER_ARRANGEMENT_IDS[this.arrangementIndex] ?? "upright",
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
    if (this.mode === mode || this.locked) {
      return;
    }
    const wasPainting = this.mode === "paint";
    this.mode = mode;
    // Paint itself survives the switch. Only the pointer changes hands.
    if (mode === "paint") {
      this.paintTool.activate();
    } else if (wasPainting) {
      this.paintTool.deactivate();
    }
    this.mimic.setSocketMarkersVisible(mode === "panels");
    this.layoutPanelTipHandles();
    this.status = TOOL_HINTS[mode];
    this.audio.play("ui_click");
    this.emit();
  }

  setMirror(mirror: boolean): void {
    this.mirror = mirror;
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
    this.solveAndRefresh();
    this.audio.playThrottled("servo_move", SERVO_INTERVAL_MS, 0.08);
  }

  /** Closes any open continuous edit and records it as one undoable command. */
  commitEdits(): void {
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
      const after = this.findPanel(socket);
      if (after !== null && (panelBefore === null || !samePanel(panelBefore, after))) {
        this.commands.push(createPanelCommand(socket, panelBefore, after, performance.now()), this.state);
        this.emit();
      }
    }
  }

  // --- Panels --------------------------------------------------------------

  addPanel(socketId: string): void {
    if (this.locked || !isPanelSocketName(socketId) || this.findPanel(socketId) !== null) {
      return;
    }
    const panel = createDefaultPanelState(socketId);
    panel.deployed = 0.6;
    this.commands.push(createPanelCommand(socketId, null, panel, performance.now()), this.state);
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
    this.commands.push(createPanelCommand(socketId, existing, null, performance.now()), this.state);
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
    }
    return panel;
  }

  private finishPanelValueChange(panel: PanelState): void {
    clampPanelState(panel);
    this.refreshAll();
    this.audio.playThrottled("servo_move", SERVO_INTERVAL_MS, 0.08);
  }

  // --- Material ------------------------------------------------------------

  get swatches(): readonly MaterialSwatch[] {
    return MIMIC_LEGAL_SWATCHES;
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
    const hit = this.raycastRoom();
    if (hit === null) {
      this.status = "Nothing under the cursor to sample.";
      this.emit();
      return;
    }
    const swatchId = resolveSurfaceSwatch(hit.object);
    if (swatchId === null) {
      this.status = "That surface publishes no material swatch.";
      this.emit();
      return;
    }
    const swatch = swatchById(swatchId);
    if (swatch === null || !swatch.legalForMimic) {
      this.status = `${swatch?.label ?? swatchId} is not allowed on a disguise.`;
      this.emit();
      return;
    }
    this.sampledSwatchId = swatchId;
    this.audio.play("material_sample");
    this.status = `Sampled ${swatch.label}. Click a part to paint it, or use "whole body".`;
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
      return;
    }
    this.status = `Undid ${command.label}.`;
    this.audio.play("ui_click");
    this.reloadFromState();
  }

  redo(): void {
    this.commitEdits();
    const command = this.commands.redo(this.state);
    if (command === null) {
      return;
    }
    this.status = `Redid ${command.label}.`;
    this.audio.play("ui_click");
    this.reloadFromState();
  }

  applyArrangement(id: StarterArrangementId): void {
    if (this.locked) {
      return;
    }
    this.commitEdits();
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
    this.autoAnchorArrangement(id);
    this.solveAndRefresh();
    this.frameMimic();
    this.emit();
  }

  /** Recentres the orbit on the Mimic, which an arrangement may have carried. */
  private frameMimic(): void {
    const pelvis = this.pose.worldPositions[boneIndex("pelvis")];
    if (pelvis === undefined) {
      return;
    }
    this.orbitTarget.set(pelvis.x, pelvis.y, pelvis.z);
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

  /** Enter: freeze the disguise and hide the handles (§7.16, §24.5). */
  lock(): void {
    if (this.locked) {
      return;
    }
    this.commitEdits();
    capturePoseToDisguiseState(this.pose, this.state);
    const errors = validateDisguiseState(this.state);
    if (errors.length > 0) {
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
    if (this.mode === "paint") {
      this.paintTool.activate();
    }
    this.handleGroup.visible = true;
    this.layoutAnchorMarkers();
    this.mimic.setSocketMarkersVisible(this.mode === "panels");
    this.mimic.setLocked(false);
    this.audio.play("ui_click");
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
    return serializeDisguiseState(this.state);
  }

  // --- Internals -----------------------------------------------------------

  /** Selection changes reset the HUD controls, so they carry an epoch bump. */
  private selectSegment(slot: number): void {
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
    this.refreshAll();
    this.emit();
  }

  private refreshAll(): void {
    this.mimic.applyForms(this.pose);
    this.mimic.applyPanels(this.state.panels);
    this.mimic.applyMaterials(this.state.materials);
    this.mimic.applyPose(this.pose);
    this.layoutHandles();
    this.layoutAnchorMarkers();
    this.layoutPanelTipHandles();
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
  private autoAnchorArrangement(id: StarterArrangementId): void {
    const plan = ARRANGEMENT_CONTACTS[id];
    if (plan === undefined) {
      return;
    }

    let surfaceNormal: THREE.Vector3 | null = null;
    if (plan.approach === "wall") {
      const wall = this.findNearestWall();
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
        .intersectObjects([...this.roomObjects], true)
        .find((candidate) => candidate.object.userData["surfaceKind"] === "structure");
      const normal = hit?.normal;
      if (hit === undefined || normal === undefined || hit.distance >= bestDistance) {
        continue;
      }
      bestDistance = hit.distance;
      best = {
        point: hit.point.clone(),
        normal: normal
          .clone()
          .applyQuaternion(hit.object.getWorldQuaternion(this.scratchQuaternion))
          .normalize(),
      };
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
        for (const hit of this.raycaster.intersectObjects([...this.roomObjects], true)) {
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
    this.mimic.applyPose(this.pose);
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

  /** Indexes the map's named surfaces once, so an anchor can find its object. */
  private indexAnchorSurfaces(): void {
    this.anchorLookup.clear();
    for (const root of this.roomObjects) {
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
      for (const hit of this.raycaster.intersectObjects([...this.roomObjects], true)) {
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
    const active = this.mode === "panels" && !this.locked;

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
        clamp(distance * HANDLE_SCREEN_RADIUS, HANDLE_MIN_RADIUS, HANDLE_MAX_RADIUS),
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
    this.audio.playThrottled("servo_move", SERVO_INTERVAL_MS, 0.08);
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
        }),
      );
      // The ghost is the "controlled pass" of §24.5: it ignores depth so an
      // occluded handle still reads, without turning depth off for the solid.
      const ghostMaterial = this.bag.add(
        new THREE.MeshBasicMaterial({
          color: def.color,
          transparent: true,
          opacity: 0.22,
          depthTest: false,
          depthWrite: false,
        }),
      );
      const group = new THREE.Object3D();
      group.name = `forge_handle_${def.target}`;
      const solid = new THREE.Mesh(geometry, solidMaterial);
      solid.userData["handleTarget"] = def.target;
      const ghost = new THREE.Mesh(geometry, ghostMaterial);
      ghost.renderOrder = 10;
      ghost.scale.setScalar(1.02);
      group.add(ghost);
      group.add(solid);
      this.handleGroup.add(group);
      handles.push({ def, boneIndex: boneIndex(def.bone), solid, ghost, group });
    }
    return handles;
  }

  /** Handles keep a constant apparent size so they stay grabbable at any zoom. */
  private layoutHandles(): void {
    for (const handle of this.handles) {
      const world = this.pose.worldPositions[handle.boneIndex];
      if (world === undefined) continue;
      handle.group.position.set(world.x, world.y, world.z);
      const distance = this.camera.position.distanceTo(handle.group.position);
      const radius = Math.min(
        Math.max(distance * HANDLE_SCREEN_RADIUS, HANDLE_MIN_RADIUS),
        HANDLE_MAX_RADIUS,
      );
      const emphasis = handle === this.draggedHandle ? 1.25 : handle === this.hoveredHandle ? 1.15 : 1;
      handle.group.scale.setScalar(radius * emphasis);
      handle.group.quaternion.copy(this.camera.quaternion);
    }
  }

  private setHovered(handle: Handle | null): void {
    if (this.hoveredHandle === handle) {
      return;
    }
    if (this.hoveredHandle !== null) {
      setGhostOpacity(this.hoveredHandle, 0.22);
    }
    this.hoveredHandle = handle;
    if (handle !== null) {
      setGhostOpacity(handle, 0.55);
      this.audio.playThrottled("ui_hover", 220);
    }
    this.canvas.style.cursor = handle === null ? "default" : "grab";
  }

  // --- Input ---------------------------------------------------------------

  private attachInput(): void {
    const onPointerDown = (event: PointerEvent): void => {
      if (!this.ownsPointerEvent(event)) return;
      // The brush listens on the canvas, and these handlers run at the window in
      // the capture phase, so stopping propagation here would swallow the press
      // before it ever reached the brush. In paint mode the left button belongs
      // to the brush and the Forge does not touch the event at all. Right-drag
      // orbit, middle-drag and shift-drag pan still work while painting.
      if (this.paintOwnsPointer() && event.button === 0 && !event.shiftKey) return;
      event.stopPropagation();
      event.preventDefault();
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;

      if (event.button === 2) {
        this.cameraDrag = "orbit";
      } else if (event.button === 1 || (event.button === 0 && event.shiftKey)) {
        this.cameraDrag = "pan";
      } else if (event.button === 0) {
        this.beginLeftPress(event);
      }
      if (this.cameraDrag !== null || this.draggedHandle !== null) {
        this.dragPointerId = event.pointerId;
        this.canvas.setPointerCapture(event.pointerId);
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
      } else if (this.cameraDrag === "pan") {
        this.panCamera(event.clientX - this.lastPointerX, event.clientY - this.lastPointerY);
      } else if (this.draggedHandle !== null) {
        this.dragHandle(this.draggedHandle);
      } else if (this.draggedPanelSocket !== null) {
        this.dragPanelTip(this.draggedPanelSocket);
      } else if (this.mode === "pose" && !this.locked) {
        this.setHovered(this.pickHandle());
      }
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!this.ownsPointerEvent(event) && event.pointerId !== this.dragPointerId) return;
      if (this.paintOwnsPointer()) return;
      event.stopPropagation();
      if (this.draggedHandle !== null) {
        const released = this.draggedHandle;
        this.draggedHandle = null;
        this.endPoseEdit(released);
        this.canvas.style.cursor = "default";
      } else if (this.draggedPanelSocket !== null) {
        this.endPanelTipDrag(this.draggedPanelSocket);
        this.canvas.style.cursor = "default";
      }
      this.cameraDrag = null;
      if (this.dragPointerId >= 0 && this.canvas.hasPointerCapture(this.dragPointerId)) {
        this.canvas.releasePointerCapture(this.dragPointerId);
      }
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
      if (event.key === " " && this.preview === "inspector") {
        this.setPreview("none");
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    this.bag.addFn(() => {
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
    return this.mode === "paint" && !this.locked && this.cameraDrag === null;
  }

  private handleKey(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
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
      }
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
      case " ":
        // Held, not toggled: §7.5 lists Space as "hold Inspector preview".
        this.setPreview("inspector");
        break;
      case "v":
        this.setSilhouette(!this.silhouette);
        break;
      case "f":
        // In paint mode F belongs to the brush's eyedropper, which the paint
        // panel binds. Sampling a swatch here as well would fight it.
        if (this.mode !== "paint") {
          this.sampleUnderPointer();
        }
        break;
      case "m":
        this.setMirror(!this.mirror);
        break;
      case "[":
        this.cycleArrangement(-1);
        break;
      case "]":
        this.cycleArrangement(1);
        break;
      case "enter":
        this.lock();
        break;
      case "escape":
        this.unlock();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private beginLeftPress(event: PointerEvent): void {
    this.updatePointerNdc(event);
    if (this.locked) {
      return;
    }

    if (this.mode === "pose") {
      const handle = this.pickHandle();
      if (handle !== null) {
        this.draggedHandle = handle;
        this.pinned.add(handle.def.target);
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
        this.canvas.style.cursor = "grabbing";
        this.audio.play("ui_click");
      }
      return;
    }

    if (this.mode === "shape") {
      const slot = this.pickSegmentSlot();
      if (slot >= 0) {
        this.commitEdits();
        this.selectSegment(slot);
        this.status = `Editing ${SEGMENT_BONES[slot] ?? "segment"}. Sliders on the right.`;
        this.audio.play("ui_click");
        this.emit();
      }
      return;
    }

    if (this.mode === "panels") {
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
          this.canvas.style.cursor = "grabbing";
          this.audio.play("ui_click");
          this.emit();
          return;
        }
      }
      const socket = this.pickSocket();
      if (socket !== null) {
        this.commitEdits();
        this.selectPanelSocket(socket);
        if (this.findPanel(socket) === null) {
          this.addPanel(socket);
        } else {
          this.audio.play("ui_click");
          this.status = `Panel on ${socket.replace("panel_socket_", "socket ")} selected.`;
          this.emit();
        }
      }
      return;
    }

    const slot = this.pickSegmentSlot();
    if (slot >= 0) {
      const bone = SEGMENT_BONES[slot];
      if (bone !== undefined) {
        this.selectSegment(slot);
        this.assignSwatch(bone);
      }
      return;
    }
    const socket = this.pickSocket();
    if (socket !== null) {
      this.assignSwatch(socket);
    }
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
    target.set(
      clamp(this.scratchVector.x, this.workspace.minX, this.workspace.maxX),
      clamp(this.scratchVector.y, this.workspace.minY, this.workspace.maxY),
      clamp(this.scratchVector.z, this.workspace.minZ, this.workspace.maxZ),
    );

    this.updateSnapCandidate(handle, target);
    this.solveAndRefresh();
    this.audio.playThrottled("servo_move", SERVO_INTERVAL_MS, 0.1);
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
    return this.handles.find((handle) => handle.solid === first.object) ?? null;
  }

  private pickSegmentSlot(): number {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects([...this.mimic.segmentMeshes], false);
    const slot = hits[0]?.object.userData["segmentSlot"];
    return typeof slot === "number" ? slot : -1;
  }

  private pickSocket(): PanelSocketName | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const candidates = [...this.mimic.panelMeshes, ...this.mimic.socketMarkers].filter(
      (mesh) => mesh.visible,
    );
    const hits = this.raycaster.intersectObjects(candidates, false);
    const socket = hits[0]?.object.userData["panelSocket"];
    return typeof socket === "string" && isPanelSocketName(socket) ? socket : null;
  }

  private raycastRoom(): THREE.Intersection | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects([...this.roomObjects], true);
    return hits[0] ?? null;
  }

  private panCamera(deltaX: number, deltaY: number): void {
    const scale = (this.radius * 1.4) / Math.max(this.viewportHeight, 1);
    this.camera.getWorldDirection(this.scratchForward);
    this.scratchRight.crossVectors(this.scratchForward, this.camera.up).normalize();
    this.scratchUp.crossVectors(this.scratchRight, this.scratchForward).normalize();
    this.orbitTarget.addScaledVector(this.scratchRight, -deltaX * scale);
    this.orbitTarget.addScaledVector(this.scratchUp, deltaY * scale);
    this.orbitTarget.y = clamp(this.orbitTarget.y, 0, this.workspace.maxY);
    this.updateCamera();
  }

  private updateCamera(): void {
    if (this.preview !== "none") {
      this.placePreviewCamera();
      return;
    }
    const horizontal = Math.cos(this.pitch) * this.radius;
    this.camera.position.set(
      this.orbitTarget.x + Math.sin(this.yaw) * horizontal,
      this.orbitTarget.y + Math.sin(this.pitch) * this.radius,
      this.orbitTarget.z + Math.cos(this.yaw) * horizontal,
    );
    this.camera.lookAt(this.orbitTarget);
  }

  /**
   * Both previews look at the Mimic from standing height. The Inspector view
   * uses the direction the player is already orbiting from, so it answers "how
   * does this read from where I am looking" rather than from a fixed seat.
   */
  private placePreviewCamera(): void {
    if (this.preview === "doorway") {
      this.camera.position.copy(DOORWAY_POSITION);
    } else {
      this.scratchForward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).normalize();
      this.camera.position.set(
        this.orbitTarget.x + this.scratchForward.x * INSPECTOR_STAND_BACK_M,
        INSPECTOR_EYE_HEIGHT_M,
        this.orbitTarget.z + this.scratchForward.z * INSPECTOR_STAND_BACK_M,
      );
    }
    this.camera.lookAt(this.orbitTarget);
  }
}

const TOOL_HINTS: Readonly<Record<ForgeToolMode, string>> = {
  pose: "Drag the handles. Right-drag orbits, shift-drag pans, wheel zooms.",
  shape: "Click a body part, then stretch it with the sliders.",
  panels: "Click a brass stud to fold a panel out, then shape it.",
  material: "Point at the room and press F to sample, then click a part to paint it.",
  paint: "Drag on your body to paint it. F copies a colour from anything you point at.",
};

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function setGhostOpacity(handle: Handle, opacity: number): void {
  const material = handle.ghost.material;
  if (material instanceof THREE.MeshBasicMaterial) {
    material.opacity = opacity;
  }
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
