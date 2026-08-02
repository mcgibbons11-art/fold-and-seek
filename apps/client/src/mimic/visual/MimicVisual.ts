import * as THREE from "three/webgpu";

import { DisposalBag } from "../../engine/DisposalBag";
import type { MaterialAssignment } from "../disguiseState";
import type { PoseState } from "../ikSolver";
import {
  boneIndex,
  BONES,
  PANEL_SOCKET_NAMES,
  RIG_TO_WORLD,
  SEGMENT_BONES,
  SEGMENT_BONE_INDICES,
  segmentSlotOfBone,
  type PanelSocketName,
  type SegmentBoneName,
} from "../rig";
import {
  createResolvedPanel,
  PANEL_PROFILE_IDS,
  resolvePanel,
  type PanelProfileId,
  type PanelState,
} from "../panels";
import {
  BELLOWS_OUTER_RATIO,
  createBellowsGeometry,
  createPanelGeometry,
  createPuckGeometry,
  createSegmentShellGeometry,
  writeSegmentShell,
} from "./mimicGeometry";
import { MimicMaterialPool, PORCELAIN_SWATCH_ID } from "./materialSwatches";

/**
 * The renderable Mimic (bible §7.2, §24.2). One shell per rig segment, a dark
 * bellows at every joint, eight panels on the rig's sockets, and a head pod with
 * two eyes behind a shutter.
 *
 * The rig math already produces world transforms for every bone, so the shells
 * are flat children of one group and take those transforms directly. Pose
 * updates therefore touch only object transforms and allocate nothing; geometry
 * is rewritten only when a segment's form parameters actually change.
 */

/**
 * Nominal cross-section of each segment at form scale 1, in the same authored
 * units as the bone table, converted to metres by `SEGMENT_DIMENSIONS` below.
 *
 * The proportions are what makes the body read as a creature rather than as a
 * pile of rounded solids, so they are set against the silhouette rather than
 * against the bone table: the head pod is the widest thing above the chest, the
 * neck is little more than half the head, the chest is the widest part of the
 * trunk and the waist is the narrowest, and every limb shell is slim enough to
 * clear the trunk it hangs beside. An upper arm hangs with its centre 0.13 out
 * from the spine, so at 0.10 across it stands 0.045 clear of a 0.27 chest — the
 * arm has an outline of its own from the front, which is the whole point.
 */
const AUTHORED_SEGMENT_DIMENSIONS: Readonly<
  Record<SegmentBoneName, readonly [number, number]>
> = {
  pelvis: [0.25, 0.2],
  torso_lower: [0.23, 0.195],
  torso_upper: [0.27, 0.215],
  neck: [0.115, 0.115],
  head: [0.2, 0.2],
  shoulder_L: [0.145, 0.145],
  upperarm_L: [0.1, 0.105],
  forearm_L: [0.088, 0.092],
  hand_L: [0.1, 0.045],
  shoulder_R: [0.145, 0.145],
  upperarm_R: [0.1, 0.105],
  forearm_R: [0.088, 0.092],
  hand_R: [0.1, 0.045],
  thigh_L: [0.145, 0.15],
  shin_L: [0.108, 0.112],
  foot_L: [0.115, 0.085],
  thigh_R: [0.145, 0.15],
  shin_R: [0.108, 0.112],
  foot_R: [0.115, 0.085],
};

const SEGMENT_DIMENSIONS = Object.fromEntries(
  Object.entries(AUTHORED_SEGMENT_DIMENSIONS).map(([bone, [width, depth]]) => [
    bone,
    [width * RIG_TO_WORLD, depth * RIG_TO_WORLD] as const,
  ]),
) as Readonly<Record<SegmentBoneName, readonly [number, number]>>;

/**
 * How far a shell is drawn past its bone's tip, as a share of its own length.
 *
 * Every shell closes to a point at both ends, so four trunk shells laid end to
 * end pinch four times and read as a stack of beads rather than as one body.
 * Overrunning a trunk shell into its successor buries both pinches. The values
 * differ because the segments do: the pelvis is a short block and has to reach
 * well into the waist above it, while the chest is long and needs only a little
 * to close over the base of the neck.
 *
 * A share rather than a length, so a player who stretches the trunk keeps the
 * joint covered instead of opening a gap at the seam.
 *
 * Limbs are left alone: the pinch at an elbow or a knee is the articulation, and
 * seeing it is what tells a forearm from an upper arm. The head runs to its bone
 * tip exactly, because it is the crown and player height is measured against it.
 */
const SHELL_OVERRUN_SHARE: Readonly<Partial<Record<SegmentBoneName, number>>> = {
  pelvis: 0.75,
  torso_lower: 0.38,
  torso_upper: 0.09,
  neck: 0.6,
};

const PANEL_THICKNESS_M = 0.018 * RIG_TO_WORLD;

/** A panel swings from flush with its parent to square out of it. */
const PANEL_DEPLOY_ANGLE_RAD = Math.PI / 2;

/** Below this the panel is stowed inside its parent segment and not drawn. */
const PANEL_VISIBLE_DEPLOY = 0.02;

/**
 * Widest point of the dark rubber at a joint, as a share of the thinner of the
 * two shells it bridges, keyed on the child bone. Over one leaves the rubber
 * standing proud: that ring is what tells an elbow from the middle of a forearm
 * at a glance, and it is the only edge definition a matte white body gets. Under
 * one tucks it away, which is what the trunk wants, since the four trunk shells
 * are drawn to read as one continuous surface.
 *
 * The ankle stays inside the sole. Rubber proud of the foot there would hang
 * below the surface the body is standing on.
 */
const BELLOWS_OUTER_BY_BONE: Readonly<Partial<Record<SegmentBoneName, number>>> = {
  upperarm_L: 1.1,
  upperarm_R: 1.1,
  forearm_L: 1.2,
  forearm_R: 1.2,
  hand_L: 1.15,
  hand_R: 1.15,
  shin_L: 1.2,
  shin_R: 1.2,
  foot_L: 0.97,
  foot_R: 0.97,
};

/** Trunk joints, shoulders and hips, which the shells cover for themselves. */
const BELLOWS_OUTER_DEFAULT = 0.94;
const BELLOWS_RIBS = 3;

const DEG_TO_RAD = Math.PI / 180;

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

/** Maps the geometry's +Y onto each bone's own axis. */
const BONE_ALIGNMENTS: readonly THREE.Quaternion[] = BONES.map((bone) =>
  new THREE.Quaternion().setFromUnitVectors(
    AXIS_Y,
    new THREE.Vector3(bone.axis[0], bone.axis[1], bone.axis[2]).normalize(),
  ),
);

/** Maps a panel's outward +Z onto its socket axis. */
const SOCKET_ALIGNMENTS: readonly THREE.Quaternion[] = PANEL_SOCKET_NAMES.map((name) => {
  const bone = BONES[boneIndex(name)];
  if (bone === undefined) {
    throw new Error(`Panel socket ${name} is missing from the rig`);
  }
  return new THREE.Quaternion().setFromUnitVectors(
    AXIS_Z,
    new THREE.Vector3(bone.axis[0], bone.axis[1], bone.axis[2]).normalize(),
  );
});

interface SegmentVisual {
  readonly slot: number;
  readonly boneIndex: number;
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  /** Resolved metres, refreshed by `applyForms`. */
  width: number;
  depth: number;
  length: number;
  /** Form parameters the current geometry was written for. */
  shapeKey: string;
}

interface PanelVisual {
  readonly socketIndex: number;
  readonly socketId: PanelSocketName;
  readonly boneIndex: number;
  readonly parentSlot: number;
  /** Socket axis in its parent bone's frame, and in that shell's geometry frame. */
  readonly axisLocal: THREE.Vector3;
  readonly axisGeometry: THREE.Vector3;
  readonly pivot: THREE.Object3D;
  readonly plate: THREE.Mesh;
  readonly marker: THREE.Mesh;
  /** Total hinge rotation from the stowed position, in radians. */
  angle: number;
  /** Distance from the rig socket out to the parent shell's surface. */
  surfacePush: number;
  present: boolean;
}

const scratchQuaternion = new THREE.Quaternion();
const inverseAlignScratch = new THREE.Quaternion();
const hingeUndoScratch = new THREE.Quaternion();
const socketOffsetScratch = new THREE.Vector3();
const resolvedPanelScratch = createResolvedPanel();

function shapeKeyOf(profileId: string, roundness: number, tipScale: number, twistDeg: number): string {
  return `${profileId}|${roundness.toFixed(3)}|${tipScale.toFixed(3)}|${twistDeg.toFixed(2)}`;
}

export class MimicVisual {
  readonly root: THREE.Group;
  /** Shell meshes in `SEGMENT_BONES` order, for picking and material assignment. */
  readonly segmentMeshes: readonly THREE.Mesh[];
  /** Panel plates in `PANEL_SOCKET_NAMES` order. */
  readonly panelMeshes: readonly THREE.Mesh[];
  /** Socket studs, shown while the panel tool is active. */
  readonly socketMarkers: readonly THREE.Mesh[];

  private readonly bag = new DisposalBag();
  private readonly pool: MimicMaterialPool;
  private readonly segments: readonly SegmentVisual[];
  private readonly panels: readonly PanelVisual[];
  private readonly bellows: readonly THREE.Mesh[];
  private readonly bellowsBones: readonly number[];
  private readonly panelGeometries: ReadonlyMap<PanelProfileId, THREE.BufferGeometry>;
  private readonly eyeGroup: THREE.Object3D;
  private readonly eyes: readonly THREE.Mesh[];
  private readonly shutter: THREE.Mesh;
  private panelStates: readonly PanelState[] = [];
  private locked = false;

  /**
   * `pool` lets several bodies share one set of materials, which is what keeps
   * a room full of Mimics from building the same shaders once per body. A body
   * given a pool does not own it; one that is not builds and disposes its own,
   * so a lone Mimic in the Forge needs no ceremony.
   */
  constructor(pool?: MimicMaterialPool) {
    this.root = new THREE.Group();
    this.root.name = "mimic";

    this.pool = pool ?? this.bag.add(new MimicMaterialPool());
    const graphite = this.pool.graphite;
    const brass = this.pool.brass;
    const porcelain = this.pool.swatches.get(PORCELAIN_SWATCH_ID);

    const segments: SegmentVisual[] = [];
    const segmentMeshes: THREE.Mesh[] = [];
    for (let slot = 0; slot < SEGMENT_BONES.length; slot++) {
      const bone = SEGMENT_BONES[slot];
      const index = SEGMENT_BONE_INDICES[slot];
      if (bone === undefined || index === undefined) {
        throw new Error(`Segment slot ${slot} is missing from the rig`);
      }
      const geometry = this.bag.add(
        createSegmentShellGeometry({ profileId: "capsule", roundness: 0.5, tipScale: 1, twistRad: 0 }),
      );
      const mesh = new THREE.Mesh(geometry, porcelain);
      mesh.name = `mimic_${bone}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData["segmentSlot"] = slot;
      this.root.add(mesh);
      segments.push({
        slot,
        boneIndex: index,
        mesh,
        geometry,
        width: 1,
        depth: 1,
        length: 1,
        shapeKey: "",
      });
      segmentMeshes.push(mesh);
    }
    this.segments = segments;
    this.segmentMeshes = segmentMeshes;

    const bellowsGeometry = this.bag.add(createBellowsGeometry(BELLOWS_RIBS));
    const bellows: THREE.Mesh[] = [];
    const bellowsBones: number[] = [];
    for (const segment of segments) {
      const parentIndex = BONES[segment.boneIndex]?.parentIndex ?? -1;
      if (parentIndex < 0 || segmentSlotOfBone(parentIndex) < 0) {
        continue;
      }
      const mesh = new THREE.Mesh(bellowsGeometry, graphite);
      mesh.name = `mimic_bellows_${SEGMENT_BONES[segment.slot] ?? segment.slot}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      bellows.push(mesh);
      bellowsBones.push(segment.boneIndex);
    }
    this.bellows = bellows;
    this.bellowsBones = bellowsBones;

    const panelGeometries = new Map<PanelProfileId, THREE.BufferGeometry>();
    for (const profileId of PANEL_PROFILE_IDS) {
      panelGeometries.set(profileId, this.bag.add(createPanelGeometry(profileId, PANEL_THICKNESS_M)));
    }
    this.panelGeometries = panelGeometries;

    // A socket stud is a feature of the body, so it converts with the body. Left
    // at 0.026 m it was a 52 mm brass disc on a 350 mm creature.
    const markerGeometry = this.bag.add(
      createPuckGeometry(0.024 * RIG_TO_WORLD, 0.013 * RIG_TO_WORLD),
    );
    const panels: PanelVisual[] = [];
    const panelMeshes: THREE.Mesh[] = [];
    const socketMarkers: THREE.Mesh[] = [];
    for (let i = 0; i < PANEL_SOCKET_NAMES.length; i++) {
      const socketId = PANEL_SOCKET_NAMES[i];
      if (socketId === undefined) {
        throw new Error(`Panel socket ${i} is missing from the rig`);
      }
      const pivot = new THREE.Object3D();
      pivot.name = `mimic_socket_${socketId}`;
      const plate = new THREE.Mesh(panelGeometries.get("rounded_rect") ?? markerGeometry, porcelain);
      plate.name = `mimic_panel_${socketId}`;
      plate.castShadow = true;
      plate.receiveShadow = true;
      plate.visible = false;
      plate.userData["panelSocket"] = socketId;
      pivot.add(plate);

      const marker = new THREE.Mesh(markerGeometry, brass);
      marker.name = `mimic_socket_marker_${socketId}`;
      marker.visible = false;
      marker.rotation.x = Math.PI / 2;
      marker.userData["panelSocket"] = socketId;
      pivot.add(marker);

      const socketBone = boneIndex(socketId);
      const parentBone = BONES[socketBone]?.parentIndex ?? -1;
      const axisLocal = new THREE.Vector3(
        BONES[socketBone]?.axis[0] ?? 0,
        BONES[socketBone]?.axis[1] ?? 0,
        BONES[socketBone]?.axis[2] ?? 1,
      ).normalize();
      const parentAlign = BONE_ALIGNMENTS[parentBone];
      const axisGeometry = axisLocal.clone();
      if (parentAlign !== undefined) {
        axisGeometry.applyQuaternion(inverseAlignScratch.copy(parentAlign).invert());
      }

      this.root.add(pivot);
      panels.push({
        socketIndex: i,
        socketId,
        boneIndex: socketBone,
        parentSlot: segmentSlotOfBone(parentBone),
        axisLocal,
        axisGeometry,
        pivot,
        plate,
        marker,
        angle: 0,
        surfacePush: 0,
        present: false,
      });
      panelMeshes.push(plate);
      socketMarkers.push(marker);
    }
    this.panels = panels;
    this.panelMeshes = panelMeshes;
    this.socketMarkers = socketMarkers;

    this.eyeGroup = new THREE.Object3D();
    this.eyeGroup.name = "mimic_head_pod";
    this.root.add(this.eyeGroup);
    const eyeGeometry = this.bag.add(new THREE.SphereGeometry(0.5, 14, 10));
    const eyes: THREE.Mesh[] = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeometry, this.pool.eyeLit);
      eye.name = `mimic_eye_${side < 0 ? "R" : "L"}`;
      this.eyeGroup.add(eye);
      eyes.push(eye);
    }
    this.eyes = eyes;
    this.shutter = new THREE.Mesh(this.bag.add(createPuckGeometry(0.5, 0.16)), graphite);
    this.shutter.name = "mimic_eye_shutter";
    this.shutter.rotation.x = Math.PI / 2;
    this.shutter.castShadow = false;
    this.eyeGroup.add(this.shutter);
  }

  /**
   * Rewrites shell geometry and refreshes every derived dimension. Call after a
   * form edit, before `applyPose`.
   */
  applyForms(pose: PoseState): void {
    for (const segment of this.segments) {
      const bone = SEGMENT_BONES[segment.slot];
      const form = pose.resolvedSegments[segment.slot];
      if (bone === undefined || form === undefined) {
        continue;
      }
      const dimensions = SEGMENT_DIMENSIONS[bone];
      segment.width = dimensions[0] * form.widthScale;
      segment.depth = dimensions[1] * form.depthScale;
      segment.length = pose.effectiveLengths[segment.boneIndex] ?? 0;

      const key = shapeKeyOf(form.profileId, form.roundness, form.tipScale, form.twistDeg);
      if (key !== segment.shapeKey) {
        segment.shapeKey = key;
        writeSegmentShell(segment.geometry, {
          profileId: form.profileId,
          roundness: form.roundness,
          tipScale: form.tipScale,
          twistRad: form.twistDeg * DEG_TO_RAD,
        });
      }
      // `segment.length` stays the bone's own length: it is what panel push and
      // the head pod are measured against. Only what is drawn overruns.
      segment.mesh.scale.set(
        segment.width,
        segment.length * (1 + (SHELL_OVERRUN_SHARE[bone] ?? 0)),
        segment.depth,
      );
    }

    for (let i = 0; i < this.bellows.length; i++) {
      const mesh = this.bellows[i];
      const childBone = this.bellowsBones[i];
      if (mesh === undefined || childBone === undefined) {
        continue;
      }
      const childSlot = segmentSlotOfBone(childBone);
      const child = this.segments[childSlot];
      const parentSlot = segmentSlotOfBone(BONES[childBone]?.parentIndex ?? -1);
      const parent = this.segments[parentSlot];
      const childName = SEGMENT_BONES[childSlot];
      if (child === undefined || parent === undefined || childName === undefined) {
        continue;
      }
      const outer = BELLOWS_OUTER_BY_BONE[childName] ?? BELLOWS_OUTER_DEFAULT;
      const thinnest = Math.min(child.width, child.depth, parent.width, parent.depth);
      mesh.scale.setScalar((outer * thinnest) / BELLOWS_OUTER_RATIO);
    }

    // A socket sits at an authored point inside its parent bone, but a panel
    // has to hinge from the shell's outside face, and that face moves whenever
    // the segment is stretched. The push is the gap between the two.
    for (const panel of this.panels) {
      const parent = this.segments[panel.parentSlot];
      if (parent === undefined) {
        panel.surfacePush = 0;
        continue;
      }
      const geometryAxis = panel.axisGeometry;
      const halfExtent =
        Math.abs(geometryAxis.x) * parent.width * 0.5 +
        Math.abs(geometryAxis.y) * parent.length +
        Math.abs(geometryAxis.z) * parent.depth * 0.5;
      const socketOffset = pose.effectiveOffsets[panel.boneIndex];
      const alongAxis =
        socketOffset === undefined
          ? 0
          : socketOffsetScratch
              .set(socketOffset.x, socketOffset.y, socketOffset.z)
              .dot(panel.axisLocal);
      panel.surfacePush = Math.max(halfExtent - alongAxis, 0);
    }

    this.layoutHeadPod();
  }

  /**
   * Eyes and shutter sit on the head pod's front face, so their placement
   * follows the head's resolved dimensions and the lock state together.
   */
  private layoutHeadPod(): void {
    const head = this.segments[segmentSlotOfBone(boneIndex("head"))];
    if (head === undefined) {
      return;
    }
    const eyeRadius = Math.min(head.width, head.depth) * 0.11;
    const spread = head.width * 0.22;
    const height = head.length * 0.55;
    const front = head.depth * 0.46;

    for (let i = 0; i < this.eyes.length; i++) {
      const eye = this.eyes[i];
      if (eye === undefined) continue;
      eye.scale.setScalar(eyeRadius * 2);
      eye.position.set((i === 0 ? -1 : 1) * spread, height, front);
    }

    // The shutter is a graphite band that stays inside the pod at both ends of
    // its travel: parked in the brow while the Mimic is awake, drawn down over
    // the eyes once the disguise locks. Sizing it to the space above the eyes is
    // what keeps it from hanging off the top of a short head.
    const park = Math.max(head.length - height - eyeRadius, eyeRadius);
    const shutterHeight = Math.min(park, eyeRadius * 2.6);
    // The lathe axis is the plate's thickness, so scale.y is the shutter depth.
    this.shutter.scale.set(head.width * 0.7, head.depth * 0.12, shutterHeight);
    this.shutter.position.set(
      0,
      this.locked ? height : height + eyeRadius + shutterHeight / 2,
      front * 0.92,
    );
  }

  /** Places every part from the rig's world transforms. Allocates nothing. */
  applyPose(pose: PoseState): void {
    for (const segment of this.segments) {
      const position = pose.worldPositions[segment.boneIndex];
      const rotation = pose.worldRotations[segment.boneIndex];
      const align = BONE_ALIGNMENTS[segment.boneIndex];
      if (position === undefined || rotation === undefined || align === undefined) {
        continue;
      }
      segment.mesh.position.set(position.x, position.y, position.z);
      segment.mesh.quaternion
        .set(rotation.x, rotation.y, rotation.z, rotation.w)
        .multiply(align);
    }

    for (let i = 0; i < this.bellows.length; i++) {
      const mesh = this.bellows[i];
      const bone = this.bellowsBones[i];
      if (mesh === undefined || bone === undefined) continue;
      const position = pose.worldPositions[bone];
      const parentIndex = BONES[bone]?.parentIndex ?? -1;
      const rotation = pose.worldRotations[parentIndex < 0 ? bone : parentIndex];
      if (position === undefined || rotation === undefined) continue;
      mesh.position.set(position.x, position.y, position.z);
      mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }

    for (const panel of this.panels) {
      const position = pose.worldPositions[panel.boneIndex];
      const rotation = pose.worldRotations[panel.boneIndex];
      const align = SOCKET_ALIGNMENTS[panel.socketIndex];
      if (position === undefined || rotation === undefined || align === undefined) {
        continue;
      }
      const parentIndex = BONES[panel.boneIndex]?.parentIndex ?? -1;
      const parentRotation = pose.worldRotations[parentIndex < 0 ? panel.boneIndex : parentIndex];
      panel.pivot.position.set(position.x, position.y, position.z);
      if (parentRotation !== undefined && panel.surfacePush > 0) {
        socketOffsetScratch
          .copy(panel.axisLocal)
          .multiplyScalar(panel.surfacePush)
          .applyQuaternion(
            scratchQuaternion.set(
              parentRotation.x,
              parentRotation.y,
              parentRotation.z,
              parentRotation.w,
            ),
          );
        panel.pivot.position.add(socketOffsetScratch);
      }
      panel.pivot.quaternion
        .set(rotation.x, rotation.y, rotation.z, rotation.w)
        .multiply(align)
        .multiply(scratchQuaternion.setFromAxisAngle(AXIS_X, panel.angle));
    }

    const headIndex = boneIndex("head");
    const headPosition = pose.worldPositions[headIndex];
    const headRotation = pose.worldRotations[headIndex];
    if (headPosition !== undefined && headRotation !== undefined) {
      this.eyeGroup.position.set(headPosition.x, headPosition.y, headPosition.z);
      this.eyeGroup.quaternion.set(headRotation.x, headRotation.y, headRotation.z, headRotation.w);
    }
  }

  /** Stores panel state and applies everything about a panel except its pose. */
  applyPanels(panels: readonly PanelState[]): void {
    this.panelStates = panels;
    const byState = new Map<string, PanelState>();
    for (const panel of panels) {
      byState.set(panel.socketId, panel);
    }

    for (const panel of this.panels) {
      const state = byState.get(panel.socketId);
      if (state === undefined) {
        panel.present = false;
        panel.angle = 0;
        panel.plate.visible = false;
        // A plate nobody can see still has a size, and `Box3.setFromObject`
        // measures hidden children. Left at its build scale it put a metre-wide
        // slab around every disguise, which is the box the reticle brackets and
        // the gun is checked against.
        panel.plate.scale.setScalar(0);
        continue;
      }
      const resolved = resolvePanel(state, resolvedPanelScratch);
      panel.present = true;
      panel.angle = resolved.deployed * PANEL_DEPLOY_ANGLE_RAD + resolved.hingeRad;
      panel.plate.visible = resolved.deployed > PANEL_VISIBLE_DEPLOY;
      if (panel.plate.visible) {
        panel.plate.scale.set(resolved.widthM, resolved.heightM, 1);
      } else {
        panel.plate.scale.setScalar(0);
      }
      panel.plate.position.set(0, resolved.extensionM, 0);
      const geometry = this.panelGeometries.get(resolved.profileId);
      if (geometry !== undefined && panel.plate.geometry !== geometry) {
        panel.plate.geometry = geometry;
      }
    }
  }

  /**
   * Resolves slot assignments onto shells and panels (§7.4 Layer 5). A bone or
   * socket assignment wins over the whole-body one; the body slot is the
   * fallback for everything.
   */
  applyMaterials(assignments: readonly MaterialAssignment[]): void {
    const bySlot = new Map<string, string>();
    for (const assignment of assignments) {
      bySlot.set(assignment.slotId, assignment.swatchId);
    }
    const bodySwatch = bySlot.get("body") ?? PORCELAIN_SWATCH_ID;

    for (const segment of this.segments) {
      const bone = SEGMENT_BONES[segment.slot];
      const swatchId = (bone !== undefined ? bySlot.get(bone) : undefined) ?? bodySwatch;
      segment.mesh.material = this.pool.swatches.get(swatchId);
    }

    const stateBySocket = new Map<string, PanelState>();
    for (const state of this.panelStates) {
      stateBySocket.set(state.socketId, state);
    }
    for (const panel of this.panels) {
      const state = stateBySocket.get(panel.socketId);
      const slotId = state?.materialSlotId ?? "body";
      const swatchId = bySlot.get(panel.socketId) ?? bySlot.get(slotId) ?? bodySwatch;
      panel.plate.material = this.pool.swatches.get(swatchId);
    }
  }

  /**
   * World position of a deployed panel's free edge, which is the point a panel
   * anchor holds (§7.4 Layer 3/4). The plate's geometry runs from its hinge at
   * y = 0 to its tip at y = 1, so the tip is that corner of its own matrix.
   * Returns false for a socket carrying no deployed panel.
   */
  panelTipWorld(socketId: string, out: THREE.Vector3): boolean {
    const panel = this.panels.find((entry) => entry.socketId === socketId);
    if (panel === undefined || !panel.present || !panel.plate.visible) {
      return false;
    }
    panel.plate.updateWorldMatrix(true, false);
    out.set(0, 1, 0).applyMatrix4(panel.plate.matrixWorld);
    return true;
  }

  /** The frame a panel hinges in: its socket's world transform, hinge angle aside. */
  panelHingeFrame(socketId: string, outPosition: THREE.Vector3, outRotation: THREE.Quaternion): boolean {
    const panel = this.panels.find((entry) => entry.socketId === socketId);
    const align = panel === undefined ? undefined : SOCKET_ALIGNMENTS[panel.socketIndex];
    if (panel === undefined || align === undefined) {
      return false;
    }
    panel.pivot.updateWorldMatrix(true, false);
    outPosition.setFromMatrixPosition(panel.pivot.matrixWorld);
    // The pivot already carries the hinge rotation; the frame is it without.
    outRotation.copy(panel.pivot.quaternion).multiply(
      hingeUndoScratch.setFromAxisAngle(AXIS_X, -panel.angle),
    );
    return true;
  }

  /** Socket studs are only meaningful while the panel tool is active. */
  setSocketMarkersVisible(visible: boolean): void {
    for (const panel of this.panels) {
      panel.marker.visible = visible && !panel.present;
    }
  }

  /** A locked disguise closes its shutters: the eyes are the giveaway (§7.2). */
  setLocked(locked: boolean): void {
    if (this.locked === locked) {
      return;
    }
    this.locked = locked;
    const eyeMaterial = locked ? this.pool.eyeShut : this.pool.eyeLit;
    for (const eye of this.eyes) {
      eye.material = eyeMaterial;
    }
    this.layoutHeadPod();
  }

  setCastShadow(enabled: boolean): void {
    for (const segment of this.segments) {
      segment.mesh.castShadow = enabled;
    }
    for (const mesh of this.bellows) {
      mesh.castShadow = enabled;
    }
    for (const panel of this.panels) {
      panel.plate.castShadow = enabled;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();
    this.bag.dispose();
  }
}
