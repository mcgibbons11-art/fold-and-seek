import * as THREE from "three/webgpu";

import { qualitySettingsFor, isQualityTier, type QualityTier } from "../rendering/quality";
import { RendererManager } from "../rendering/RendererManager";
import { createShopEnvironment } from "../world/maps/lighting";
import { GunView } from "./GunView";
import { DEFAULT_BOOM_LENGTH_M, DEFAULT_SHOULDER_OFFSET_M } from "./InspectorCamera";
import { InspectorBody } from "./InspectorBody";
import { WORLD_SCALE } from "./navData";

/**
 * Standalone harness for the Inspector's body, in the same spirit as
 * `map-viewer.html`: it boots the renderer, stands one Inspector on a floor and
 * frames it from either end of the fiction, so the silhouette, the gait and the
 * gun in the hand can be looked at without playing a round to reach them.
 *
 * It is not part of the game bundle.
 *
 * Query parameters: `view=inspector|hider|profile`, `walk` (0 to 1, the share
 * of the walk cap), `aim` (0 to 1), `pitch` in degrees, `t` seconds of gait to
 * advance through before the frame is drawn, `tier`, and `webgl` to force the
 * WebGL 2 backend.
 */

interface BodyViewerApi {
  ready: boolean;
  error: string | null;
  view: string;
  /** Metres between the gun's grip and the hand, which should be nothing. */
  handGap: number | null;
  meshes: number | null;
}

declare global {
  interface Window {
    bodyViewer?: BodyViewerApi;
  }
}

const params = new URLSearchParams(window.location.search);
const requestedTier = params.get("tier");
const tier: QualityTier = requestedTier !== null && isQualityTier(requestedTier) ? requestedTier : "high";
const forceWebGL = params.has("webgl");
const view = params.get("view") ?? "inspector";
const walk = clamp01(Number.parseFloat(params.get("walk") ?? "0"));
const aim = clamp01(Number.parseFloat(params.get("aim") ?? "0"));
const pitch = ((Number.parseFloat(params.get("pitch") ?? "0") || 0) * Math.PI) / 180;
const seconds = Number.parseFloat(params.get("t") ?? "1.2") || 0;

/** The Inspector's own walk, which is what the gait's stride is measured on. */
const WALK_SPEED_MPS = WORLD_SCALE.playerHeight * 2.2;
const FRAME_S = 1 / 60;

const api: BodyViewerApi = { ready: false, error: null, view, handGap: null, meshes: null };
window.bodyViewer = api;

const canvasElement = document.getElementById("body-canvas");
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error("body-viewer: missing #body-canvas");
}
const canvas: HTMLCanvasElement = canvasElement;
const hud = document.getElementById("hud");

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

async function main(): Promise<void> {
  const manager = new RendererManager(canvas, qualitySettingsFor(tier), forceWebGL);
  await manager.initialize();
  const settings = qualitySettingsFor(tier, manager.backend);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0b10);
  scene.environment = createShopEnvironment(manager.renderer);
  scene.environmentIntensity = 0.6;

  // A floorboard-coloured ground and one warm key, so the silhouette is judged
  // against something rather than against black.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.85 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const key = new THREE.DirectionalLight(0xffd9a0, 2.4);
  key.position.set(1.2, 2.2, 0.9);
  key.castShadow = settings.dynamicShadows;
  key.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 6;
  key.shadow.camera.left = -1;
  key.shadow.camera.right = 1;
  key.shadow.camera.top = 1;
  key.shadow.camera.bottom = -1;
  scene.add(key);
  scene.add(new THREE.AmbientLight(0x6a7a92, 0.5));

  const root = new THREE.Group();
  scene.add(root);
  const gun = new GunView(scene);
  const body = new InspectorBody(root, scene, settings.dynamicShadows, (socket) => {
    gun.attachToSocket(socket);
  });
  gun.attachToHand(body.hand);
  await body.authoredReady;

  // Walked forward through `t` seconds at the requested speed, so a stride is
  // caught mid-swing rather than at whatever phase the first frame lands on.
  const speed = WALK_SPEED_MPS * walk;
  let travelled = 0;
  for (let elapsed = 0; elapsed < seconds; elapsed += FRAME_S) {
    travelled += speed * FRAME_S;
    root.position.set(0, 0, -travelled);
    gun.update(FRAME_S * 1000, {
      eye: { x: 0, y: WORLD_SCALE.eyeHeight, z: -travelled },
      yaw: 0,
      pitch,
      aimAmount: aim,
      swayScale: 1,
      speedMps: speed,
    });
    body.update(FRAME_S, {
      speedMps: speed,
      speedCapMps: WALK_SPEED_MPS,
      airborne: false,
      climbing: false,
      landingSpeed: 0,
      pitch,
      aimAmount: aim,
    });
  }
  scene.updateMatrixWorld(true);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.01, 40);
  const eye = new THREE.Vector3(0, WORLD_SCALE.eyeHeight, -travelled);
  if (view === "hider") {
    // A Mimic's eye, a few body lengths ahead of the Inspector and off to one
    // side: the read a hider gets of the hunt coming down the aisle.
    camera.position.set(0.55, WORLD_SCALE.eyeHeight * 0.8, -travelled - 1.15);
    camera.lookAt(0, WORLD_SCALE.playerHeight * 0.55, -travelled);
    camera.fov = 60;
  } else if (view === "profile") {
    camera.position.set(0.95, WORLD_SCALE.playerHeight * 0.75, -travelled - 0.1);
    camera.lookAt(0, WORLD_SCALE.playerHeight * 0.5, -travelled);
    camera.fov = 34;
  } else {
    // The player's own rig: over the right shoulder, on the boom the game uses.
    const pivot = new THREE.Vector3(DEFAULT_SHOULDER_OFFSET_M, 0, 0).add(eye);
    const forward = new THREE.Vector3(0, Math.sin(pitch), -Math.cos(pitch)).normalize();
    camera.position.copy(pivot).addScaledVector(forward, -DEFAULT_BOOM_LENGTH_M);
    camera.rotation.order = "YXZ";
    camera.rotation.set(pitch, 0, 0);
    camera.fov = 62;
  }
  camera.updateProjectionMatrix();

  const resize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    manager.setSize(width, height, window.devicePixelRatio);
  };
  resize();
  window.addEventListener("resize", resize);

  api.handGap = body.hand
    .getWorldPosition(new THREE.Vector3())
    .distanceTo(gun.gripWorldPosition());
  api.meshes = body.meshes.length;
  if (hud !== null) {
    hud.textContent = [
      `view ${view}  tier ${tier}  backend ${manager.backend}`,
      `walk ${walk.toFixed(2)}  aim ${aim.toFixed(2)}  pitch ${((pitch * 180) / Math.PI).toFixed(0)}deg`,
      `body meshes ${String(api.meshes)}  gun-to-hand ${api.handGap.toFixed(6)} m`,
    ].join("\n");
  }

  manager.renderer.render(scene, camera);
  api.ready = true;
}

main().catch((error: unknown) => {
  api.error = error instanceof Error ? error.message : String(error);
  if (hud !== null) hud.textContent = `body-viewer failed: ${api.error}`;
});
