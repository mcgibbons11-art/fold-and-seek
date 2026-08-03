import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type { InspectorBodyFrame } from "./InspectorBody";
import { WORLD_SCALE } from "./navData";

export const INSPECTOR_ASSET_SHA256 =
  "f7f2d030cbfb105d1b19912d1784b993419d0d5b7a2f4b3344bf9e893552c9f5";
export const INSPECTOR_ASSET_URL =
  `assets/characters/inspector-curator.glb?v=${INSPECTOR_ASSET_SHA256.slice(0, 16)}`;
/** Blender master is just over two metres from boot sole to head loop. */
const AUTHORED_HEIGHT_M = 2.05;
const CROSS_FADE_SECONDS = 0.1;
const FIRE_FADE_SECONDS = 0.045;
const HIT_FADE_SECONDS = 0.065;
/** Keep the Mixamo stride readable without its exaggerated hip/shoulder swagger. */
export const INSPECTOR_RUN_ANIMATION_WEIGHT = 0.58;
/** Separate exit threshold prevents acceleration noise flickering run and idle. */
export const INSPECTOR_RUN_EXIT_FRACTION = 0.025;
export const INSPECTOR_RUN_ENTER_FRACTION = 0.055;
/** Maximum correction away from the authored pose for each solved joint. */
const ARM_IK_LIMIT_RAD = 1.45;
const FOREARM_IK_LIMIT_RAD = 1.8;
export const INSPECTOR_WEAPON_SOCKET_NAME = "WeaponSocket_R";

type BaseAction = "rifle-idle" | "run" | "jump" | "climb";
type InspectorAction = BaseAction | "rifle-fire" | "hit" | "death";
export type InspectorReaction = "none" | "hit" | "death";

export function inspectorUsesGunIk(reaction: InspectorReaction): boolean {
  return reaction === "none";
}

/**
 * The downloaded fire take contains a corrupt flourish on the unsupported
 * left arm. The gun and right arm still perform the shot; removing only these
 * tracks leaves the off hand in the stable rifle-idle pose instead of spinning
 * around the shoulder.
 */
export function sanitizeInspectorClip(clip: THREE.AnimationClip): THREE.AnimationClip {
  if (clip.name !== "rifle-fire") return clip;
  const unsafeBones = ["leftshoulder", "leftarm", "leftforearm", "lefthand"];
  clip.tracks = clip.tracks.filter((track) => {
    const name = track.name.toLowerCase().replaceAll("_", "");
    return !unsafeBones.some((bone) => name.includes(bone));
  });
  clip.resetDuration();
  return clip;
}

/** Locomotion choice is kept pure so the gameplay thresholds stay testable. */
export function inspectorActionForFrame(
  frame: InspectorBodyFrame,
  wasRunning = false,
): BaseAction {
  if (frame.climbing) return "climb";
  if (frame.airborne) return "jump";
  const speedFraction = frame.speedCapMps > 0 ? frame.speedMps / frame.speedCapMps : 0;
  const threshold = wasRunning ? INSPECTOR_RUN_EXIT_FRACTION : INSPECTOR_RUN_ENTER_FRACTION;
  return speedFraction > threshold ? "run" : "rifle-idle";
}

/**
 * Authored Blender/Mixamo presentation for InspectorBody.
 *
 * The game still owns movement, collision, camera and the warrant gun. This
 * layer owns only the visible performance and solves its right arm onto the
 * gun hand after Mixamo has posed the skeleton, so animation can never make
 * the weapon float away from the character.
 */
export class InspectorAvatar {
  private readonly parent: THREE.Object3D;
  private readonly gunHand: THREE.Object3D;
  private readonly onSettled: (loaded: boolean, weaponSocket: THREE.Object3D | null) => void;
  private readonly loader = new GLTFLoader();
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();

  private model: THREE.Group | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private currentAction: InspectorAction | null = null;
  private oneShotSeconds = 0;
  private reaction: InspectorReaction = "none";
  private lastFrame: InspectorBodyFrame | null = null;
  private rightArm: THREE.Bone | null = null;
  private rightForeArm: THREE.Bone | null = null;
  private rightHand: THREE.Bone | null = null;
  private weaponSocket: THREE.Object3D | null = null;
  private disposed = false;
  private castShadow = true;

  private readonly target = new THREE.Vector3();
  private readonly jointPoint = new THREE.Vector3();
  private readonly handPoint = new THREE.Vector3();
  private readonly currentVector = new THREE.Vector3();
  private readonly targetVector = new THREE.Vector3();
  private readonly worldDelta = new THREE.Quaternion();
  private readonly limitedDelta = new THREE.Quaternion();
  private readonly parentWorld = new THREE.Quaternion();
  private readonly parentWorldInverse = new THREE.Quaternion();
  private readonly localDelta = new THREE.Quaternion();
  private readonly identity = new THREE.Quaternion();
  private readonly correction = new THREE.Quaternion();
  private readonly armAuthoredRotation = new THREE.Quaternion();
  private readonly foreArmAuthoredRotation = new THREE.Quaternion();
  private readonly targetRotation = new THREE.Quaternion();
  private readonly socketRotation = new THREE.Quaternion();

  constructor(
    parent: THREE.Object3D,
    gunHand: THREE.Object3D,
    onSettled: (loaded: boolean, weaponSocket: THREE.Object3D | null) => void,
  ) {
    this.parent = parent;
    this.gunHand = gunHand;
    this.onSettled = onSettled;
  }

  async load(): Promise<boolean> {
    try {
      const url = new URL(INSPECTOR_ASSET_URL, document.baseURI).href;
      const gltf = await this.loader.loadAsync(url);
      if (this.disposed) {
        disposeTree(gltf.scene);
        return false;
      }

      const model = gltf.scene;
      model.name = "inspector-curator-avatar";
      model.scale.setScalar(WORLD_SCALE.playerHeight / AUTHORED_HEIGHT_M);
      // The Blender character faces -Y; the glTF conversion maps that to +Z,
      // while an Inspector at yaw zero travels along -Z.
      model.rotation.y = Math.PI;
      this.parent.add(model);
      this.model = model;
      this.mixer = new THREE.AnimationMixer(model);

      model.traverse((object) => {
        if (object.name === INSPECTOR_WEAPON_SOCKET_NAME) this.weaponSocket = object;
        if (object instanceof THREE.Bone) {
          if (object.name === "RightArm") this.rightArm = object;
          if (object.name === "RightForeArm") this.rightForeArm = object;
          if (object.name === "RightHand") this.rightHand = object;
        }
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = this.castShadow;
        object.receiveShadow = false;
        this.geometries.add(object.geometry);
        const material = object.material;
        if (Array.isArray(material)) material.forEach((entry) => this.materials.add(entry));
        else this.materials.add(material);
      });

      for (const clip of gltf.animations) {
        this.actions.set(clip.name, this.mixer.clipAction(sanitizeInspectorClip(clip)));
      }
      for (const required of [
        "rifle-idle",
        "run",
        "jump",
        "climb",
        "rifle-fire",
        "hit",
        "death",
      ]) {
        if (!this.actions.has(required)) throw new Error(`missing ${required} action`);
      }
      if (this.weaponSocket === null) {
        throw new Error(`missing ${INSPECTOR_WEAPON_SOCKET_NAME} hand socket`);
      }

      this.play("rifle-idle", 0);
      this.onSettled(true, this.weaponSocket);
      return true;
    } catch (error) {
      if (!this.disposed) console.warn("[inspector] authored avatar unavailable; using fallback", error);
      this.disposeModel();
      this.onSettled(false, null);
      return false;
    }
  }

  update(dtSeconds: number, frame: InspectorBodyFrame): void {
    this.lastFrame = frame;
    const mixer = this.mixer;
    if (mixer === null) return;

    if (this.reaction === "death") {
      mixer.update(Math.min(dtSeconds, 0.1));
      return;
    }

    if (this.oneShotSeconds > 0) {
      this.oneShotSeconds = Math.max(0, this.oneShotSeconds - dtSeconds);
      if (this.oneShotSeconds === 0) {
        this.reaction = "none";
        this.play(inspectorActionForFrame(frame, this.currentAction === "run"));
      }
    } else {
      this.play(inspectorActionForFrame(frame, this.currentAction === "run"));
    }

    const run = this.actions.get("run");
    if (run !== undefined && this.currentAction === "run") {
      const fraction = frame.speedCapMps > 0 ? Math.min(1, frame.speedMps / frame.speedCapMps) : 0;
      run.timeScale = THREE.MathUtils.lerp(0.78, 1.42, fraction);
      run.setEffectiveWeight(INSPECTOR_RUN_ANIMATION_WEIGHT);
    }
    mixer.update(Math.min(dtSeconds, 0.1));
    // Hit and death are full-body performances. Solving the arm back onto the
    // live gun during either one destroys the authored reaction silhouette.
    if (inspectorUsesGunIk(this.reaction)) this.solveGunArm();
  }

  fire(): void {
    if (this.reaction !== "none") return;
    const action = this.actions.get("rifle-fire");
    if (action === undefined) return;
    this.play("rifle-fire", FIRE_FADE_SECONDS, true);
    this.oneShotSeconds = Math.max(0.12, action.getClip().duration - FIRE_FADE_SECONDS);
  }

  hit(): void {
    if (this.reaction === "death") return;
    const action = this.actions.get("hit");
    if (action === undefined) return;
    this.reaction = "hit";
    this.play("hit", HIT_FADE_SECONDS, true);
    this.oneShotSeconds = Math.max(0.12, action.getClip().duration - HIT_FADE_SECONDS);
  }

  death(): void {
    if (this.reaction === "death" || !this.actions.has("death")) return;
    this.reaction = "death";
    this.oneShotSeconds = 0;
    this.play("death", HIT_FADE_SECONDS, true);
  }

  setCastShadow(enabled: boolean): void {
    this.castShadow = enabled;
    this.model?.traverse((object) => {
      if (object instanceof THREE.Mesh) object.castShadow = enabled;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.disposeModel();
  }

  private play(name: InspectorAction, fadeSeconds = CROSS_FADE_SECONDS, restart = false): void {
    if (!restart && this.currentAction === name) return;
    const next = this.actions.get(name);
    if (next === undefined) return;
    const previous = this.currentAction === null ? undefined : this.actions.get(this.currentAction);

    next.enabled = true;
    next.setEffectiveWeight(1);
    if (name === "rifle-fire" || name === "hit" || name === "death") {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = name === "death";
    } else {
      next.setLoop(THREE.LoopRepeat, Number.POSITIVE_INFINITY);
      next.clampWhenFinished = false;
    }
    if (restart) next.reset();
    next.play();
    if (previous !== undefined && previous !== next && fadeSeconds > 0) {
      next.crossFadeFrom(previous, fadeSeconds, true);
    }
    this.currentAction = name;
  }

  /** Small CCD solve, applied after the animation mixer has posed the arm. */
  private solveGunArm(): void {
    const model = this.model;
    const arm = this.rightArm;
    const foreArm = this.rightForeArm;
    const hand = this.rightHand;
    const socket = this.weaponSocket;
    if (model === null || arm === null || foreArm === null || hand === null || socket === null) return;
    this.gunHand.getWorldPosition(this.target);
    this.gunHand.getWorldQuaternion(this.targetRotation);
    this.armAuthoredRotation.copy(arm.quaternion);
    this.foreArmAuthoredRotation.copy(foreArm.quaternion);

    // Position and orientation are solved together. Using the authored socket
    // as the effector means the grip, rather than the wrist bone's origin, is
    // what lands on the weapon. The final hand rotation makes the gun's local
    // -Z agree with the camera aim instead of merely putting it near the palm.
    for (let pass = 0; pass < 5; pass += 1) {
      this.rotateJointToward(foreArm, socket, this.target, this.foreArmAuthoredRotation);
      this.rotateJointToward(arm, socket, this.target, this.armAuthoredRotation);
      this.rotateHandSocketToward(hand, socket, this.targetRotation);
    }
  }

  private rotateJointToward(
    joint: THREE.Bone,
    effector: THREE.Object3D,
    target: THREE.Vector3,
    authoredRotation: THREE.Quaternion,
  ): void {
    joint.updateWorldMatrix(true, true);
    joint.getWorldPosition(this.jointPoint);
    effector.getWorldPosition(this.handPoint);
    this.currentVector.copy(this.handPoint).sub(this.jointPoint);
    this.targetVector.copy(target).sub(this.jointPoint);
    if (this.currentVector.lengthSq() < 1e-10 || this.targetVector.lengthSq() < 1e-10) return;
    this.currentVector.normalize();
    this.targetVector.normalize();
    this.worldDelta.setFromUnitVectors(this.currentVector, this.targetVector);

    // A bad first loaded frame should bend toward the target, never snap an
    // elbow through the torso in one solve.
    const angle = this.identity.angleTo(this.worldDelta);
    if (angle > 0.72) {
      this.limitedDelta.slerpQuaternions(this.identity, this.worldDelta, 0.72 / angle);
    } else {
      this.limitedDelta.copy(this.worldDelta);
    }

    const parent = joint.parent;
    if (parent === null) return;
    parent.getWorldQuaternion(this.parentWorld);
    this.parentWorldInverse.copy(this.parentWorld).invert();
    this.localDelta
      .copy(this.parentWorldInverse)
      .multiply(this.limitedDelta)
      .multiply(this.parentWorld);
    joint.quaternion.premultiply(this.localDelta).normalize();
    // CCD has no anatomical knowledge. Bound its correction relative to the
    // mixer-authored joint so an unreachable grip cannot turn the elbow inside
    // out or leave a corrupt pose latched across frames.
    this.correction.copy(authoredRotation).invert().multiply(joint.quaternion);
    const limit = joint === this.rightForeArm ? FOREARM_IK_LIMIT_RAD : ARM_IK_LIMIT_RAD;
    const correctionAngle = this.identity.angleTo(this.correction);
    if (correctionAngle > limit) {
      this.correction.slerpQuaternions(this.identity, this.correction, limit / correctionAngle);
      joint.quaternion.copy(authoredRotation).multiply(this.correction).normalize();
    }
    joint.updateWorldMatrix(false, true);
  }

  private rotateHandSocketToward(
    hand: THREE.Bone,
    socket: THREE.Object3D,
    target: THREE.Quaternion,
  ): void {
    socket.updateWorldMatrix(true, false);
    socket.getWorldQuaternion(this.socketRotation);
    this.worldDelta.copy(target).multiply(this.socketRotation.invert()).normalize();
    const parent = hand.parent;
    if (parent === null) return;
    parent.getWorldQuaternion(this.parentWorld);
    this.parentWorldInverse.copy(this.parentWorld).invert();
    this.localDelta
      .copy(this.parentWorldInverse)
      .multiply(this.worldDelta)
      .multiply(this.parentWorld);
    hand.quaternion.premultiply(this.localDelta).normalize();
    hand.updateWorldMatrix(false, true);
  }

  private disposeModel(): void {
    this.mixer?.stopAllAction();
    if (this.model !== null) this.model.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.actions.clear();
    this.mixer = null;
    this.model = null;
    this.currentAction = null;
    this.oneShotSeconds = 0;
    this.reaction = "none";
    this.rightArm = null;
    this.rightForeArm = null;
    this.rightHand = null;
    this.weaponSocket = null;
    this.lastFrame = null;
  }
}

function disposeTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
    else materials.add(object.material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
