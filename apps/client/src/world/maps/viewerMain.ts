import * as THREE from "three/webgpu";
import { WORLD_SCALE } from "../../inspector/navData";
import { RendererManager } from "../../rendering/RendererManager";
import { isQualityTier, qualitySettingsFor, type QualityTier } from "../../rendering/quality";
import { CuriosityShop, type CuriosityShopMap } from "./CuriosityShop";
import { createShopEnvironment } from "./lighting";
import { ZONES, type MapZone } from "./zones";

/**
 * Standalone harness for The Curiosity Shop: boots the renderer, builds the
 * map and frames one zone at a time.
 *
 * It exists so the blockout can be looked at, measured and screenshotted
 * without the game shell, which is the only way to tell whether the art
 * direction actually landed. It is not part of the game bundle.
 *
 * Query parameters: `zone` (a to g), `tier` (a quality tier), `hud=0`,
 * `webgl` to force the WebGL 2 backend, and `eye=x,z[,yawDegrees]` to drop the
 * camera to a standing player's eye height. The eye view is the one that shows
 * whether the giant scale reads: at 0.32 m a chair is a building.
 */

interface ViewerApi {
  ready: boolean;
  /** Scene graph handle, so batching and materials can be inspected live. */
  root: THREE.Object3D | null;
  error: string | null;
  zone: string;
  mapStats: CuriosityShopMap["stats"] | null;
  renderStats: { drawCalls: number; triangles: number } | null;
  setZone: (letter: string) => void;
}

declare global {
  interface Window {
    mapViewer?: ViewerApi;
  }
}

const params = new URLSearchParams(window.location.search);
const requestedTier = params.get("tier");
const tier: QualityTier = requestedTier !== null && isQualityTier(requestedTier) ? requestedTier : "high";
const showHud = params.get("hud") !== "0";
// Running several viewer tabs exhausts the available WebGPU devices, so the
// harness needs a way to ask for the fallback backend explicitly.
const forceWebGL = params.has("webgl");

interface EyeView {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

/** Parses `eye=x,z[,yawDegrees]`. Returns null when the viewer is orbiting. */
function parseEyeView(raw: string | null): EyeView | null {
  if (raw === null) {
    return null;
  }
  const parts = raw.split(",").map((value) => Number.parseFloat(value));
  const [x, z, yawDegrees] = parts;
  if (x === undefined || z === undefined || !Number.isFinite(x) || !Number.isFinite(z)) {
    return null;
  }
  const yaw = yawDegrees !== undefined && Number.isFinite(yawDegrees) ? yawDegrees : 0;
  return { x, z, yaw: (yaw * Math.PI) / 180 };
}

const eyeView = parseEyeView(params.get("eye"));

const api: ViewerApi = {
  ready: false,
  root: null,
  error: null,
  zone: params.get("zone") ?? "a",
  mapStats: null,
  renderStats: null,
  setZone: () => undefined,
};
window.mapViewer = api;

const canvasElement = document.getElementById("map-canvas");
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error("map-viewer: missing #map-canvas");
}
const canvas: HTMLCanvasElement = canvasElement;
const hud = document.getElementById("hud");

function zoneByLetter(letter: string): MapZone {
  const zone = ZONES.find((candidate) => candidate.letter === letter.toLowerCase());
  if (zone === undefined) {
    const fallback = ZONES[0];
    if (fallback === undefined) {
      throw new Error("map-viewer: the map declares no zones");
    }
    return fallback;
  }
  return zone;
}

async function main(): Promise<void> {
  const manager = new RendererManager(canvas, qualitySettingsFor(tier), forceWebGL);
  await manager.initialize();
  // Re-resolved now the backend is known: it decides the live light budget, and
  // the viewer is where that gets measured, so it has to match the game.
  const settings = qualitySettingsFor(tier, manager.backend);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x08070a);
  scene.environment = createShopEnvironment(manager.renderer);
  scene.environmentIntensity = 0.55;

  const shop = new CuriosityShop();
  const map = shop.build(settings);
  scene.add(map.root);
  api.root = map.root;
  api.mapStats = map.stats;

  const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 80);
  const target = new THREE.Vector3();
  const spherical = new THREE.Spherical();
  let radius = 5;
  let yaw = 0;
  let pitch = 0.2;

  const frameZone = (zone: MapZone): void => {
    api.zone = zone.letter;
    const [tx, ty, tz] = zone.camera.target;
    const [px, py, pz] = zone.camera.position;
    target.set(tx, ty, tz);
    const offset = new THREE.Vector3(px - tx, py - ty, pz - tz);
    spherical.setFromVector3(offset);
    radius = spherical.radius;
    yaw = spherical.theta;
    pitch = Math.PI / 2 - spherical.phi;
    updateCamera();
  };

  function updateCamera(): void {
    const horizontal = Math.cos(pitch) * radius;
    camera.position.set(
      target.x + Math.sin(yaw) * horizontal,
      target.y + Math.sin(pitch) * radius,
      target.z + Math.cos(yaw) * horizontal,
    );
    camera.lookAt(target);
  }

  api.setZone = (letter: string): void => {
    frameZone(zoneByLetter(letter));
  };
  frameZone(zoneByLetter(api.zone));

  if (eyeView !== null) {
    // Stand on the floor at a player's eye. The orbit target is pushed a few
    // metres down the view direction so dragging still turns the head, and the
    // near plane comes in because at this height props are centimetres away.
    const distance = 4;
    camera.fov = 65;
    camera.near = 0.01;
    camera.updateProjectionMatrix();
    target.set(
      eyeView.x + Math.sin(eyeView.yaw) * distance,
      WORLD_SCALE.eyeHeight,
      eyeView.z - Math.cos(eyeView.yaw) * distance,
    );
    radius = distance;
    yaw = -eyeView.yaw;
    pitch = 0;
    updateCamera();
    api.zone = "eye";
  }

  const resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    manager.setSize(width, height, window.devicePixelRatio);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
  });
  window.addEventListener("pointerup", () => {
    dragging = false;
  });
  window.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    yaw += (event.clientX - lastX) * 0.006;
    pitch = Math.min(Math.max(pitch + (event.clientY - lastY) * 0.004, -0.3), 1.3);
    lastX = event.clientX;
    lastY = event.clientY;
    updateCamera();
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      radius = Math.min(Math.max(radius * (1 + event.deltaY * 0.0012), 0.8), 30);
      updateCamera();
    },
    { passive: false },
  );
  window.addEventListener("keydown", (event) => {
    if (event.key.length === 1) {
      api.setZone(event.key);
    }
  });

  let frames = 0;
  manager.setAnimationLoop(() => {
    manager.render(scene, camera);
    frames += 1;
    const info = manager.renderer.info.render;
    api.renderStats = { drawCalls: info.drawCalls, triangles: info.triangles };
    if (frames === 3) {
      api.ready = true;
    }
    if (showHud && hud !== null && frames % 15 === 0) {
      hud.textContent = [
        `zone ${api.zone} · tier ${tier} · ${manager.backend}`,
        `draw calls ${String(info.drawCalls)} · triangles ${String(info.triangles)}`,
        `props ${String(map.stats.props)} · parts ${String(map.stats.parts)} · inspectable ${String(map.stats.inspectableObjects)}`,
      ].join("\n");
    }
  });
}

main().catch((error: unknown) => {
  api.error = error instanceof Error ? error.message : String(error);
  api.ready = true;
  if (hud !== null) {
    hud.textContent = `map-viewer failed: ${api.error}`;
  }
  throw error;
});
