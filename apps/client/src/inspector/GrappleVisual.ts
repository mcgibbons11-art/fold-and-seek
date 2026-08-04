import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type { Vec3Like } from "./navData";

export const GRAPPLE_LAUNCHER_ASSET_SHA256 =
  "f1d9879d3ada200dc6b0bff36b5590be2522962d457d130e2c1e5738f290716e";
export const GRAPPLE_CLAW_ASSET_SHA256 =
  "c698695164dbc35887e9ed064079fc6fa32b4ea5667187f200e0209a1cb5d2ff";
export const GRAPPLE_LAUNCHER_ASSET_URL =
  `assets/models/gameplay/grapple-launcher.glb?v=${GRAPPLE_LAUNCHER_ASSET_SHA256.slice(0, 16)}`;
export const GRAPPLE_CLAW_ASSET_URL =
  `assets/models/gameplay/grapple-claw.glb?v=${GRAPPLE_CLAW_ASSET_SHA256.slice(0, 16)}`;

/** Fast enough to read as a shot, long enough to see the authored travel. */
export const GRAPPLE_DEPLOY_SECONDS = 0.28;
const AUTHORED_ACTION_SPEED = 2.8;

interface LoadedGrapplePart {
  readonly scene: THREE.Group;
  readonly animations: readonly THREE.AnimationClip[];
}

/**
 * Mechanical claw-machine grapple presentation shared by both character rigs.
 * Blender owns the wrist launcher, recoil/winch performance and snapping jaws;
 * gameplay owns the arbitrary cable distance and collision-safe player pull.
 */
export class GrappleVisual {
  private readonly root = new THREE.Group();
  private readonly launcher = new THREE.Group();
  private readonly claw = new THREE.Group();
  private readonly launcherFallback = new THREE.Group();
  private readonly clawFallback = new THREE.Group();
  private readonly loader = new GLTFLoader();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly mixers: THREE.AnimationMixer[] = [];
  private readonly actions: THREE.AnimationAction[] = [];
  private readonly cable: THREE.Mesh;
  private readonly cableCore: THREE.Mesh;
  private readonly start = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly visualEnd = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private active = false;
  private deployProgress = 0;
  private disposed = false;

  readonly authoredReady: Promise<boolean>;

  constructor(parent: THREE.Object3D) {
    this.root.name = "mechanical-claw-grapple";
    this.root.visible = false;
    this.launcher.name = "grapple-wrist-winch";
    this.claw.name = "grapple-three-jaw-claw";
    this.launcherFallback.name = "grapple-launcher-fallback";
    this.clawFallback.name = "grapple-claw-fallback";

    const steel = this.material(0x222a30, 0.72, 0.72);
    const brass = this.material(0xb77a2e, 0.52, 0.7);
    const paint = this.material(0xc8492e, 0.56, 0.38);
    const yellow = this.material(0xe5a51e, 0.5, 0.42);
    const rubber = this.material(0x151719, 0.92, 0.02);
    const glow = new THREE.MeshStandardMaterial({
      color: 0x59e9ff,
      emissive: 0x168ba6,
      emissiveIntensity: 2.2,
      roughness: 0.32,
      metalness: 0.2,
    });
    this.materials.add(glow);

    this.cable = this.mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 1, 10, 1, true), steel);
    this.cableCore = this.mesh(new THREE.CylinderGeometry(0.003, 0.003, 1.002, 8, 1, true), glow);
    this.cable.renderOrder = 8;
    this.cableCore.renderOrder = 9;

    this.launcherFallback.add(this.mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.055, 14), rubber));
    const housing = this.mesh(new THREE.BoxGeometry(0.082, 0.052, 0.064), paint);
    housing.position.y = 0.036;
    this.launcherFallback.add(housing);
    const drum = this.mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.074, 12), steel);
    drum.rotation.z = Math.PI / 2;
    drum.position.y = 0.068;
    this.launcherFallback.add(drum);
    for (const x of [-0.041, 0.041]) {
      const flange = this.mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.009, 12), yellow);
      flange.rotation.z = Math.PI / 2;
      flange.position.set(x, 0.068, 0);
      this.launcherFallback.add(flange);
    }
    const guide = this.mesh(new THREE.TorusGeometry(0.016, 0.005, 7, 14), brass);
    guide.rotation.x = Math.PI / 2;
    guide.position.y = 0.112;
    this.launcherFallback.add(guide);
    const status = this.mesh(new THREE.BoxGeometry(0.028, 0.007, 0.014), glow);
    status.position.set(0, 0.064, 0.034);
    this.launcherFallback.add(status);

    this.clawFallback.add(this.mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.055, 12), brass));
    const hub = this.mesh(new THREE.SphereGeometry(0.031, 12, 8), paint);
    hub.position.y = -0.018;
    this.clawFallback.add(hub);
    const lens = this.mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.006, 10), glow);
    lens.position.y = -0.051;
    this.clawFallback.add(lens);
    for (let index = 0; index < 3; index += 1) {
      const jaw = new THREE.Group();
      jaw.rotation.y = (index / 3) * Math.PI * 2;
      const hinge = this.mesh(new THREE.SphereGeometry(0.011, 8, 6), brass);
      hinge.position.set(0.028, -0.008, 0);
      jaw.add(hinge);
      const upper = this.mesh(new THREE.BoxGeometry(0.015, 0.07, 0.018), steel);
      upper.position.set(0.047, -0.042, 0);
      upper.rotation.z = -0.48;
      jaw.add(upper);
      const hook = this.mesh(new THREE.BoxGeometry(0.014, 0.058, 0.017), brass);
      hook.position.set(0.062, -0.092, 0);
      hook.rotation.z = 0.7;
      jaw.add(hook);
      this.clawFallback.add(jaw);
    }

    this.launcher.add(this.launcherFallback);
    this.claw.add(this.clawFallback);
    this.root.add(this.cable, this.cableCore, this.launcher, this.claw);
    parent.add(this.root);
    this.authoredReady = import.meta.env.MODE === "test"
      ? Promise.resolve(false)
      : this.loadAuthored();
  }

  update(start: Vec3Like, anchor: Vec3Like | null, dtSeconds = 1 / 60): void {
    for (const mixer of this.mixers) mixer.update(Math.min(0.1, Math.max(0, dtSeconds)));
    if (anchor === null) {
      this.root.visible = false;
      this.active = false;
      this.deployProgress = 0;
      return;
    }
    if (!this.active) {
      this.active = true;
      this.deployProgress = 0;
      this.playAuthoredActions();
    }

    this.start.set(start.x, start.y, start.z);
    this.target.set(anchor.x, anchor.y, anchor.z);
    this.direction.copy(this.target).sub(this.start);
    const targetLength = this.direction.length();
    if (targetLength < 1e-5) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    this.direction.multiplyScalar(1 / targetLength);
    this.deployProgress = Math.min(1, this.deployProgress + Math.max(0, dtSeconds) / GRAPPLE_DEPLOY_SECONDS);
    const travel = 1 - Math.pow(1 - this.deployProgress, 3);
    const cableLength = Math.max(0.015, targetLength * travel);
    this.visualEnd.copy(this.start).addScaledVector(this.direction, cableLength);
    const orientation = this.cable.quaternion.setFromUnitVectors(this.up, this.direction);
    for (const strand of [this.cable, this.cableCore]) {
      strand.position.copy(this.start).addScaledVector(this.direction, cableLength * 0.5);
      strand.scale.set(1, cableLength, 1);
      strand.quaternion.copy(orientation);
    }
    this.launcher.position.copy(this.start);
    this.launcher.quaternion.copy(orientation);
    this.claw.position.copy(this.visualEnd);
    this.claw.quaternion.copy(orientation);
  }

  dispose(): void {
    this.disposed = true;
    for (const mixer of this.mixers) mixer.stopAllAction();
    this.root.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.mixers.length = 0;
    this.actions.length = 0;
  }

  private async loadAuthored(): Promise<boolean> {
    let launcherGltf: LoadedGrapplePart | null = null;
    let clawGltf: LoadedGrapplePart | null = null;
    try {
      launcherGltf = await this.loader.loadAsync(new URL(GRAPPLE_LAUNCHER_ASSET_URL, document.baseURI).href);
      clawGltf = await this.loader.loadAsync(new URL(GRAPPLE_CLAW_ASSET_URL, document.baseURI).href);
      if (this.disposed) {
        disposeTree(launcherGltf.scene);
        disposeTree(clawGltf.scene);
        return false;
      }
      this.installAuthoredPart(this.launcher, launcherGltf);
      this.installAuthoredPart(this.claw, clawGltf);
      this.launcherFallback.visible = false;
      this.clawFallback.visible = false;
      if (this.active) this.playAuthoredActions();
      return true;
    } catch (error) {
      if (launcherGltf !== null) disposeTree(launcherGltf.scene);
      if (clawGltf !== null) disposeTree(clawGltf.scene);
      if (!this.disposed) console.warn("[grapple] authored claw unavailable; using fallback", error);
      return false;
    }
  }

  private installAuthoredPart(parent: THREE.Group, gltf: LoadedGrapplePart): void {
    const model = gltf.scene;
    model.name = `${parent.name}-authored`;
    // Blender authored the cable axis on +Y. glTF converts that axis to -Z;
    // rotating the imported root maps the firing axis back onto local +Y.
    model.rotation.x = Math.PI / 2;
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = true;
      this.geometries.add(object.geometry);
      if (Array.isArray(object.material)) object.material.forEach((entry) => this.materials.add(entry));
      else this.materials.add(object.material);
    });
    parent.add(model);
    if (gltf.animations.length === 0) return;
    const mixer = new THREE.AnimationMixer(model);
    this.mixers.push(mixer);
    for (const clip of gltf.animations) {
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.timeScale = AUTHORED_ACTION_SPEED;
      this.actions.push(action);
    }
  }

  private playAuthoredActions(): void {
    for (const action of this.actions) action.reset().play();
  }

  private material(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    this.materials.add(material);
    return material;
  }

  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    this.geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    return mesh;
  }
}

function disposeTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    if (Array.isArray(object.material)) object.material.forEach((entry) => materials.add(entry));
    else materials.add(object.material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
