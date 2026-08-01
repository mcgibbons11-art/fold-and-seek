import * as THREE from "three/webgpu";
import { DisposalBag } from "../engine/DisposalBag";
import type { QualitySettings } from "../rendering/quality";

const ROOM_HALF = 4;
const WALL_HEIGHT = 3.2;
const WALL_THICKNESS = 0.14;
const FLOOR_THICKNESS = 0.06;
const WINDOW_HALF_WIDTH = 1.5;
const WINDOW_SILL_Y = 0.95;
const WINDOW_HEAD_Y = 2.45;

const CAMERA_TARGET_X = -1.2;
const CAMERA_TARGET_Y = 1.05;
const CAMERA_TARGET_Z = -0.9;
const CAMERA_BASE_YAW = 0.85;
const CAMERA_YAW_SWEEP = 0.5;
const CAMERA_ORBIT_SPEED = 0.09;
const CAMERA_MIN_RADIUS = 2.6;
const CAMERA_MAX_RADIUS = 9;
const CAMERA_MIN_PITCH = -0.15;
const CAMERA_MAX_PITCH = 1.15;
const DRAG_YAW_PER_PIXEL = 0.006;
const DRAG_PITCH_PER_PIXEL = 0.004;

const LAMP_X = -2.85;
const LAMP_Z = -0.2;
const LAMP_BULB_Y = 1.44;
const MOONLIGHT_KEY_INTENSITY = 4.2;
const MOONLIGHT_FILL_INTENSITY = 1.5;

/** Bible §17.3 core map, plus the neutral tones the blockout needs. */
const PALETTE = {
  porcelainCream: 0xece2d2,
  warmAmber: 0xffb066,
  darkWalnut: 0x2f1d13,
  midWalnut: 0x452a1a,
  warmWalnut: 0x5a3a22,
  tarnishedBrass: 0xb08a4a,
  agedBrass: 0x7a6134,
  burgundyVelvet: 0x431122,
  oxidizedGreen: 0x4d7a68,
  midnightBlue: 0x1b2742,
  coolMoonGray: 0xa8c0e0,
  plaster: 0xd8cbb6,
  smokedPlaster: 0x2e241b,
} as const;

type LatheProfile = readonly (readonly [number, number])[];

interface ClutterItem {
  readonly object: THREE.Object3D;
  readonly priority: number;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Tileable value noise. The grid indices wrap, so the texture repeats without
 * a visible seam when applied with RepeatWrapping.
 */
function tileableNoise(size: number, baseCells: number, octaves: number, seed: number): Float32Array {
  const field = new Float32Array(size * size);
  const random = makeRandom(seed);
  let amplitude = 1;
  let amplitudeSum = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    const cells = baseCells * (1 << octave);
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i += 1) {
      grid[i] = random();
    }

    const scale = cells / size;
    for (let y = 0; y < size; y += 1) {
      const gy = y * scale;
      const gy0 = Math.floor(gy);
      const fy = smoothStep(gy - gy0);
      const row0 = (((gy0 % cells) + cells) % cells) * cells;
      const row1 = ((((gy0 + 1) % cells) + cells) % cells) * cells;

      for (let x = 0; x < size; x += 1) {
        const gx = x * scale;
        const gx0 = Math.floor(gx);
        const fx = smoothStep(gx - gx0);
        const col0 = ((gx0 % cells) + cells) % cells;
        const col1 = (((gx0 + 1) % cells) + cells) % cells;

        const v00 = grid[row0 + col0] ?? 0;
        const v10 = grid[row0 + col1] ?? 0;
        const v01 = grid[row1 + col0] ?? 0;
        const v11 = grid[row1 + col1] ?? 0;
        const top = v00 + (v10 - v00) * fx;
        const bottom = v01 + (v11 - v01) * fx;

        field[y * size + x] = (field[y * size + x] ?? 0) + (top + (bottom - top) * fy) * amplitude;
      }
    }

    amplitudeSum += amplitude;
    amplitude *= 0.5;
  }

  for (let i = 0; i < field.length; i += 1) {
    field[i] = (field[i] ?? 0) / amplitudeSum;
  }
  return field;
}

interface NoiseTextureOptions {
  readonly size: number;
  readonly cells: number;
  readonly octaves: number;
  readonly seed: number;
  readonly low: number;
  readonly high: number;
  readonly repeatU: number;
  readonly repeatV: number;
  /** Anisotropic stretch applied before sampling, used for wood grain. */
  readonly stretchU: number;
}

function createNoiseTexture(options: NoiseTextureOptions): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = options.size;
  canvas.height = options.size;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("TestRoom: 2D canvas context unavailable, cannot build procedural surface noise");
  }

  const field = tileableNoise(options.size, options.cells, options.octaves, options.seed);
  const image = context.createImageData(options.size, options.size);
  const span = options.high - options.low;

  for (let y = 0; y < options.size; y += 1) {
    for (let x = 0; x < options.size; x += 1) {
      const sx = Math.floor(x / options.stretchU) % options.size;
      const value = field[y * options.size + sx] ?? 0.5;
      const level = Math.round((options.low + value * span) * 255);
      const offset = (y * options.size + x) * 4;
      image.data[offset] = level;
      image.data[offset + 1] = level;
      image.data[offset + 2] = level;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.repeat.set(options.repeatU, options.repeatV);
  texture.needsUpdate = true;
  return texture;
}

function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const r = Math.max(Math.min(radius, halfWidth * 0.98, halfHeight * 0.98), 0.0005);
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + r, -halfHeight);
  shape.lineTo(halfWidth - r, -halfHeight);
  shape.absarc(halfWidth - r, -halfHeight + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(halfWidth, halfHeight - r);
  shape.absarc(halfWidth - r, halfHeight - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-halfWidth + r, halfHeight);
  shape.absarc(-halfWidth + r, halfHeight - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-halfWidth, -halfHeight + r);
  shape.absarc(-halfWidth + r, -halfHeight + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/**
 * Box with a real chamfer on every edge. The art direction forbids sharp
 * primitive cubes, and a bevel is what gives the edges a highlight to catch.
 * Extrusion runs along local Z, so the result measures width x height x depth.
 */
function chamferedBox(
  width: number,
  height: number,
  depth: number,
  bevel = 0.02,
  cornerRadius = bevel * 1.6,
): THREE.ExtrudeGeometry {
  const b = Math.min(bevel, width * 0.24, height * 0.24, depth * 0.24);
  const shape = roundedRectShape(width - 2 * b, height - 2 * b, Math.max(cornerRadius - b, 0.0005));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(depth - 2 * b, 0.001),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 3,
    steps: 1,
  });
  geometry.translate(0, 0, -(depth / 2 - b));
  return geometry;
}

function latheGeometry(profile: LatheProfile, segments: number): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  for (const [radius, height] of profile) {
    points.push(new THREE.Vector2(radius, height));
  }
  return new THREE.LatheGeometry(points, segments);
}

export interface TestRoomStats {
  readonly meshCount: number;
}

/**
 * Procedural reading-nook blockout that proves the target art direction is
 * reachable before any authored art exists: chamfered geometry, a restrained
 * palette, image-based ambient plus one warm practical and one cool key.
 */
export class TestRoom {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly bag = new DisposalBag();
  private readonly textures: THREE.Texture[] = [];
  private readonly clutter: ClutterItem[] = [];
  private readonly heroCasters: THREE.Mesh[] = [];
  private readonly lampGlow: THREE.PointLight;
  private readonly rendererMaxAnisotropy: number;

  private moonlight: THREE.DirectionalLight;
  private lampSpot: THREE.SpotLight;
  /**
   * Identifies the shadow configuration the current light objects were built
   * for. A shadow map cannot be resized on a live light: three's WebGPU shadow
   * node keeps submitting the depth texture it captured, so the tier switch
   * replaces the light objects instead of editing them.
   */
  private shadowKey: string;

  private orbitTime = 0;
  private previousOrbitTime = 0;
  private yawOffset = 0;
  private pitch = 0.24;
  private radius = 5.6;
  private dragging = false;
  private dragPointerId = -1;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private meshCount = 0;

  constructor(renderer: THREE.WebGPURenderer, settings: QualitySettings) {
    this.rendererMaxAnisotropy = renderer.getMaxAnisotropy();
    this.shadowKey = shadowSignature(settings);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0908);
    this.scene.environmentIntensity = 0.5;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);

    const plasterNoise = this.registerTexture(
      createNoiseTexture({ size: 256, cells: 4, octaves: 4, seed: 11, low: 0.55, high: 1, repeatU: 3, repeatV: 1.4, stretchU: 1 }),
    );
    const woodNoise = this.registerTexture(
      createNoiseTexture({ size: 256, cells: 6, octaves: 4, seed: 29, low: 0.4, high: 0.95, repeatU: 1.5, repeatV: 6, stretchU: 8 }),
    );
    const fabricNoise = this.registerTexture(
      createNoiseTexture({ size: 256, cells: 16, octaves: 3, seed: 47, low: 0.6, high: 1, repeatU: 8, repeatV: 8, stretchU: 1 }),
    );

    const plaster = this.bag.add(
      new THREE.MeshStandardMaterial({
        color: PALETTE.plaster,
        roughness: 0.95,
        metalness: 0,
        roughnessMap: plasterNoise,
        bumpMap: plasterNoise,
        bumpScale: 0.012,
      }),
    );
    const walnutTones = [PALETTE.darkWalnut, PALETTE.midWalnut, PALETTE.warmWalnut].map((color, index) =>
      this.bag.add(
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.5 + index * 0.05,
          metalness: 0,
          roughnessMap: woodNoise,
        }),
      ),
    );
    const walnut = walnutTones[1] ?? walnutTones[0];
    if (walnut === undefined) {
      throw new Error("TestRoom: walnut material palette is empty");
    }
    const brass = this.bag.add(
      new THREE.MeshStandardMaterial({ color: PALETTE.tarnishedBrass, roughness: 0.34, metalness: 0.95 }),
    );
    const agedBrass = this.bag.add(
      new THREE.MeshStandardMaterial({ color: PALETTE.agedBrass, roughness: 0.55, metalness: 0.85 }),
    );
    const velvet = this.bag.add(
      new THREE.MeshPhysicalMaterial({
        color: PALETTE.burgundyVelvet,
        roughness: 0.92,
        metalness: 0,
        sheen: 1,
        sheenRoughness: 0.45,
        roughnessMap: fabricNoise,
      }),
    );
    velvet.sheenColor.setHex(0xc0707c);
    const porcelain = this.bag.add(
      new THREE.MeshPhysicalMaterial({
        color: PALETTE.porcelainCream,
        roughness: 0.28,
        metalness: 0,
        clearcoat: 0.5,
        clearcoatRoughness: 0.25,
      }),
    );
    const rugWool = this.bag.add(
      new THREE.MeshStandardMaterial({
        color: PALETTE.midnightBlue,
        roughness: 0.88,
        metalness: 0,
        roughnessMap: fabricNoise,
      }),
    );
    const patina = this.bag.add(
      new THREE.MeshStandardMaterial({ color: PALETTE.oxidizedGreen, roughness: 0.45, metalness: 0.55 }),
    );
    const bulbGlass = this.bag.add(
      new THREE.MeshStandardMaterial({
        color: 0x201404,
        roughness: 0.25,
        emissive: new THREE.Color(PALETTE.warmAmber),
        emissiveIntensity: 6,
      }),
    );
    const shadeLinen = this.bag.add(
      new THREE.MeshPhysicalMaterial({
        color: 0xf2e3c8,
        roughness: 0.72,
        metalness: 0,
        side: THREE.DoubleSide,
        emissive: new THREE.Color(0xffcf9c),
        emissiveIntensity: 0.5,
      }),
    );
    const flame = this.bag.add(
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: new THREE.Color(0xffc06a),
        emissiveIntensity: 9,
      }),
    );
    const artCanvas = this.bag.add(new THREE.MeshStandardMaterial({ color: 0x6b5233, roughness: 0.9, metalness: 0 }));
    const bookCloth = [0x6d2130, 0x24405e, 0x4a5a3a].map((color) =>
      this.bag.add(new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0 })),
    );
    const paper = this.bag.add(new THREE.MeshStandardMaterial({ color: 0xe4d8bf, roughness: 0.85, metalness: 0 }));
    const ceilingPlaster = this.bag.add(
      new THREE.MeshStandardMaterial({
        color: PALETTE.smokedPlaster,
        roughness: 0.98,
        metalness: 0,
        roughnessMap: plasterNoise,
        bumpMap: plasterNoise,
        bumpScale: 0.01,
      }),
    );

    // Publishing the swatch on the material rather than on each mesh keeps one
    // declaration per surface family: the Forge samples a material, and every
    // mesh wearing it answers the same way (bible §7.12). A material with no
    // entry here is deliberately not samplable.
    publishSwatch(plaster, "paint_plaster");
    publishSwatch(ceilingPlaster, "paint_plaster");
    for (const tone of walnutTones) {
      publishSwatch(tone, "wood_walnut");
    }
    publishSwatch(brass, "metal_brass");
    publishSwatch(agedBrass, "metal_brass");
    publishSwatch(velvet, "fabric_velvet_burgundy");
    publishSwatch(porcelain, "mimic_porcelain");
    publishSwatch(rugWool, "fabric_wool_midnight");
    publishSwatch(patina, "metal_patina");
    publishSwatch(shadeLinen, "fabric_cream_linen");
    publishSwatch(paper, "fabric_cream_linen");
    publishSwatch(artCanvas, "paint_plaster");
    publishSwatch(bookCloth[0], "fabric_velvet_burgundy");
    publishSwatch(bookCloth[1], "fabric_wool_midnight");
    publishSwatch(bookCloth[2], "metal_patina");

    this.buildEnvironmentLighting(renderer);
    this.buildNightExterior();
    this.buildShell(plaster, walnutTones, walnut);
    this.publishStructure();
    this.buildCeiling(ceilingPlaster, walnut);
    this.buildRug(rugWool);
    this.buildArmchair(velvet, walnut);
    this.buildSideTable(walnut, brass);
    this.buildFloorLamp(brass, agedBrass, shadeLinen, bulbGlass);
    this.buildFootstool(velvet, walnut);
    this.buildBookStacks(bookCloth, paper);
    this.buildVessels(patina, porcelain);
    this.buildTeaSet(porcelain);
    this.buildCandlestick(brass, porcelain, flame);
    this.buildPictureFrame(walnut, artCanvas, brass);

    this.moonlight = this.buildMoonlight(settings);
    this.lampSpot = this.buildLampSpot(settings);
    this.lampGlow = this.buildLampGlow();

    const hemisphere = new THREE.HemisphereLight(0x3a4a68, 0x141009, 0.4);
    this.scene.add(hemisphere);

    this.applyQuality(settings);
    this.previousOrbitTime = this.orbitTime;
    this.updateCamera(0);
  }

  get stats(): TestRoomStats {
    return { meshCount: this.meshCount };
  }

  setViewport(width: number, height: number): void {
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  simulate(fixedStep: number): void {
    this.previousOrbitTime = this.orbitTime;
    if (!this.dragging) {
      this.orbitTime += fixedStep;
    }
  }

  interpolate(alpha: number): void {
    this.updateCamera(this.previousOrbitTime + (this.orbitTime - this.previousOrbitTime) * alpha);
  }

  applyQuality(settings: QualitySettings): void {
    const anisotropy = Math.min(settings.maxAnisotropy, this.rendererMaxAnisotropy);
    for (const texture of this.textures) {
      if (texture.anisotropy !== anisotropy) {
        texture.anisotropy = anisotropy;
        texture.needsUpdate = true;
      }
    }

    const shadowKey = shadowSignature(settings);
    if (shadowKey !== this.shadowKey) {
      this.shadowKey = shadowKey;
      this.replaceShadowLights(settings);
    }

    // With no shadow map the key floods straight through the walls, so it is
    // pulled back to a fill level and the warm practical stays dominant.
    this.moonlight.intensity = settings.dynamicShadows ? MOONLIGHT_KEY_INTENSITY : MOONLIGHT_FILL_INTENSITY;
    this.lampGlow.intensity = settings.dynamicShadows ? 2.4 : 3.6;

    for (const mesh of this.heroCasters) {
      mesh.castShadow = settings.dynamicShadows;
    }
    for (const item of this.clutter) {
      item.object.visible = item.priority <= settings.clutterDensity;
    }
  }

  attachInput(element: HTMLElement): void {
    const onPointerDown = (event: PointerEvent): void => {
      if (this.dragging) {
        return;
      }
      this.dragging = true;
      this.dragPointerId = event.pointerId;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      element.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!this.dragging || event.pointerId !== this.dragPointerId) {
        return;
      }
      this.yawOffset += (event.clientX - this.lastPointerX) * DRAG_YAW_PER_PIXEL;
      this.pitch = clamp(
        this.pitch + (event.clientY - this.lastPointerY) * DRAG_PITCH_PER_PIXEL,
        CAMERA_MIN_PITCH,
        CAMERA_MAX_PITCH,
      );
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (event.pointerId !== this.dragPointerId) {
        return;
      }
      this.dragging = false;
      this.dragPointerId = -1;
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      this.radius = clamp(this.radius * (1 + event.deltaY * 0.0012), CAMERA_MIN_RADIUS, CAMERA_MAX_RADIUS);
    };

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerUp);
    element.addEventListener("pointercancel", onPointerUp);
    element.addEventListener("wheel", onWheel, { passive: false });

    this.bag.addFn(() => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerUp);
      element.removeEventListener("wheel", onWheel);
    });
  }

  dispose(): void {
    this.releaseLight(this.moonlight);
    this.releaseLight(this.lampSpot);
    this.lampGlow.dispose();
    this.scene.clear();
    this.bag.dispose();
    this.textures.length = 0;
    this.clutter.length = 0;
    this.heroCasters.length = 0;
  }

  private updateCamera(time: number): void {
    const yaw = CAMERA_BASE_YAW + Math.sin(time * CAMERA_ORBIT_SPEED * Math.PI * 2) * CAMERA_YAW_SWEEP + this.yawOffset;
    const horizontal = Math.cos(this.pitch) * this.radius;
    this.camera.position.set(
      CAMERA_TARGET_X + Math.sin(yaw) * horizontal,
      CAMERA_TARGET_Y + Math.sin(this.pitch) * this.radius,
      CAMERA_TARGET_Z + Math.cos(yaw) * horizontal,
    );
    this.camera.lookAt(CAMERA_TARGET_X, CAMERA_TARGET_Y, CAMERA_TARGET_Z);
  }

  /**
   * Marks the room's shell as structure. A disguise that wants to mount on a
   * wall has to tell a wall from a table leg, and only the map knows which is
   * which; guessing from geometry picks whichever happens to be nearest.
   */
  private publishStructure(): void {
    const shell = this.scene.getObjectByName("shell");
    if (shell === undefined) {
      throw new Error("TestRoom: the shell group must exist before structure is published");
    }
    shell.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.userData["surfaceKind"] = "structure";
      }
    });
  }

  private registerTexture(texture: THREE.CanvasTexture): THREE.CanvasTexture {
    this.bag.add(texture);
    this.textures.push(texture);
    return texture;
  }

  private addMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    parent: THREE.Object3D,
    options: { casts?: boolean; receives?: boolean } = {},
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = options.receives ?? true;
    if (options.casts === true) {
      this.heroCasters.push(mesh);
      mesh.castShadow = true;
    }
    // Build order is deterministic, so this is a stable id a saved disguise can
    // still resolve on the next load: a surface anchor references it (§24.6).
    mesh.name = `${parent.name.length > 0 ? parent.name : "room"}#${this.meshCount}`;
    parent.add(mesh);
    this.meshCount += 1;
    return mesh;
  }

  private group(name: string, x: number, y: number, z: number, rotationY = 0): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    group.position.set(x, y, z);
    group.rotation.y = rotationY;
    this.scene.add(group);
    return group;
  }

  /**
   * Image-based ambient from a tiny procedural room: a dark box with a cool
   * window panel, a warm lamp panel, and a floor bounce. Cheaper and more
   * controllable here than shipping an HDR file.
   */
  private buildEnvironmentLighting(renderer: THREE.WebGPURenderer): void {
    const envScene = new THREE.Scene();
    const envBag = new DisposalBag();

    const shellGeometry = envBag.add(new THREE.BoxGeometry(14, 9, 14));
    const shellMaterial = envBag.add(new THREE.MeshBasicMaterial({ color: 0x0d0b0a, side: THREE.BackSide }));
    envScene.add(new THREE.Mesh(shellGeometry, shellMaterial));

    const panelGeometry = envBag.add(new THREE.PlaneGeometry(1, 1));
    const panels: readonly {
      color: number;
      scale: readonly [number, number];
      position: readonly [number, number, number];
      rotation: readonly [number, number, number];
    }[] = [
      { color: 0x91b4e6, scale: [5, 4], position: [0, 2.6, -6.8], rotation: [0, 0, 0] },
      { color: 0xffb066, scale: [2.4, 2.4], position: [-3.2, 1.6, 0], rotation: [0, Math.PI / 2, 0] },
      { color: 0x3a2a1c, scale: [12, 12], position: [0, -4.4, 0], rotation: [-Math.PI / 2, 0, 0] },
      { color: 0x1d1814, scale: [12, 12], position: [0, 4.4, 0], rotation: [Math.PI / 2, 0, 0] },
    ];

    for (const panel of panels) {
      const material = envBag.add(new THREE.MeshBasicMaterial({ color: panel.color, side: THREE.DoubleSide }));
      const mesh = new THREE.Mesh(panelGeometry, material);
      mesh.scale.set(panel.scale[0], panel.scale[1], 1);
      mesh.position.set(panel.position[0], panel.position[1], panel.position[2]);
      mesh.rotation.set(panel.rotation[0], panel.rotation[1], panel.rotation[2]);
      envScene.add(mesh);
    }

    const pmrem = new THREE.PMREMGenerator(renderer);
    const target = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = target.texture;
    this.bag.add(target);
    pmrem.dispose();
    envScene.clear();
    envBag.dispose();
  }

  /**
   * Unlit backdrop past the window. Without it the aperture reads as a hole
   * punched in the wall rather than a view onto a night street.
   */
  private buildNightExterior(): void {
    const exterior = this.group("night-exterior", 0, 0, 0);
    const geometry = this.bag.add(new THREE.PlaneGeometry(1, 1));

    const bands: readonly (readonly [number, number, number, number, number])[] = [
      [0x1a2740, 18, 9, 4.6, -9],
      [0x0d1420, 18, 3.2, -0.6, -8.6],
    ];
    for (const [color, width, height, y, z] of bands) {
      const material = this.bag.add(new THREE.MeshBasicMaterial({ color }));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.set(width, height, 1);
      mesh.position.set(0, y, z);
      exterior.add(mesh);
      this.meshCount += 1;
    }
  }

  private buildShell(
    plaster: THREE.Material,
    walnutTones: readonly THREE.Material[],
    walnut: THREE.Material,
  ): void {
    const shell = this.group("shell", 0, 0, 0);

    // Every piece is chamfered, so butt joints would open a gap the moonlight
    // leaks through. Piers overlap the band above and below by more than the
    // combined bevel width.
    const seamOverlap = 0.05;
    const pierWidth = ROOM_HALF - WINDOW_HALF_WIDTH;
    const pierHeight = WINDOW_HEAD_Y - WINDOW_SILL_Y + seamOverlap * 2;
    const backWallZ = -ROOM_HALF - WALL_THICKNESS / 2;
    const backWallPieces: readonly (readonly [number, number, number, number])[] = [
      [ROOM_HALF * 2, WINDOW_SILL_Y, 0, WINDOW_SILL_Y / 2],
      [ROOM_HALF * 2, WALL_HEIGHT - WINDOW_HEAD_Y, 0, (WALL_HEIGHT + WINDOW_HEAD_Y) / 2],
      [pierWidth, pierHeight, -(WINDOW_HALF_WIDTH + pierWidth / 2), (WINDOW_SILL_Y + WINDOW_HEAD_Y) / 2],
      [pierWidth, pierHeight, WINDOW_HALF_WIDTH + pierWidth / 2, (WINDOW_SILL_Y + WINDOW_HEAD_Y) / 2],
    ];
    for (const [width, height, x, y] of backWallPieces) {
      const mesh = this.addMesh(
        this.bag.add(chamferedBox(width, height, WALL_THICKNESS, 0.012)),
        plaster,
        shell,
        { casts: true },
      );
      mesh.position.set(x, y, backWallZ);
    }

    // Runs past the back wall so the corner is filled rather than notched.
    const sideWallDepth = ROOM_HALF * 2 + WALL_THICKNESS + seamOverlap;
    const sideWall = this.addMesh(
      this.bag.add(chamferedBox(WALL_THICKNESS, WALL_HEIGHT, sideWallDepth, 0.012)),
      plaster,
      shell,
      { casts: true },
    );
    sideWall.position.set(
      -ROOM_HALF - WALL_THICKNESS / 2,
      WALL_HEIGHT / 2,
      ROOM_HALF - sideWallDepth / 2,
    );

    // Planks vary in width so the floor does not read as a repeating stripe.
    const plankWidths = [0.44, 0.52, 0.48, 0.56, 0.42, 0.5, 0.46, 0.54];
    let cursor = -ROOM_HALF;
    let index = 0;
    while (cursor < ROOM_HALF - 0.01) {
      const width = plankWidths[index % plankWidths.length] ?? 0.48;
      const depth = Math.min(width, ROOM_HALF - cursor);
      const plank = this.addMesh(
        this.bag.add(chamferedBox(ROOM_HALF * 2, FLOOR_THICKNESS, depth - 0.012, 0.008)),
        walnutTones[index % walnutTones.length] ?? walnut,
        shell,
      );
      plank.position.set(0, FLOOR_THICKNESS / 2, cursor + depth / 2);
      cursor += depth;
      index += 1;
    }

    const baseboardBack = this.addMesh(
      this.bag.add(chamferedBox(ROOM_HALF * 2, 0.17, 0.045, 0.008)),
      walnut,
      shell,
    );
    baseboardBack.position.set(0, 0.085 + FLOOR_THICKNESS, -ROOM_HALF + 0.022);
    const baseboardSide = this.addMesh(
      this.bag.add(chamferedBox(0.045, 0.17, ROOM_HALF * 2, 0.008)),
      walnut,
      shell,
    );
    baseboardSide.position.set(-ROOM_HALF + 0.022, 0.085 + FLOOR_THICKNESS, 0);

    this.buildWindowFrame(shell, walnut);
  }

  /**
   * Caps the diorama. The shell is deliberately open on two sides so the camera
   * can orbit into the room, but without a lid the same orbit tips up into empty
   * background. A smoke-darkened ceiling also gives the lamp something to bounce
   * off, which is most of what sells the practical as a light source.
   */
  private buildCeiling(ceilingPlaster: THREE.Material, walnut: THREE.Material): void {
    const ceiling = this.group("ceiling", 0, 0, 0);

    // Overhangs both walls so the outside corner reads as solid from any angle.
    const span = ROOM_HALF * 2 + WALL_THICKNESS;
    const slab = this.addMesh(
      this.bag.add(chamferedBox(span, WALL_THICKNESS, span, 0.012)),
      ceilingPlaster,
      ceiling,
    );
    slab.position.set(-WALL_THICKNESS / 2, WALL_HEIGHT + WALL_THICKNESS / 2, -WALL_THICKNESS / 2);

    const corniceHeight = 0.15;
    const corniceDepth = 0.1;
    const corniceY = WALL_HEIGHT - corniceHeight / 2;

    const corniceBack = this.addMesh(
      this.bag.add(chamferedBox(ROOM_HALF * 2, corniceHeight, corniceDepth, 0.012)),
      walnut,
      ceiling,
    );
    corniceBack.position.set(0, corniceY, -ROOM_HALF + corniceDepth / 2);

    const corniceSide = this.addMesh(
      this.bag.add(chamferedBox(corniceDepth, corniceHeight, ROOM_HALF * 2, 0.012)),
      walnut,
      ceiling,
    );
    corniceSide.position.set(-ROOM_HALF + corniceDepth / 2, corniceY, 0);
  }

  private buildWindowFrame(parent: THREE.Object3D, walnut: THREE.Material): void {
    const frameZ = -ROOM_HALF + 0.02;
    const openingHeight = WINDOW_HEAD_Y - WINDOW_SILL_Y;
    const jambGeometry = this.bag.add(chamferedBox(0.09, openingHeight + 0.12, 0.2, 0.012));
    for (const side of [-1, 1]) {
      const jamb = this.addMesh(jambGeometry, walnut, parent, { casts: true });
      jamb.position.set(side * (WINDOW_HALF_WIDTH + 0.045), (WINDOW_SILL_Y + WINDOW_HEAD_Y) / 2, frameZ);
    }

    const head = this.addMesh(
      this.bag.add(chamferedBox(WINDOW_HALF_WIDTH * 2 + 0.18, 0.09, 0.2, 0.012)),
      walnut,
      parent,
      { casts: true },
    );
    head.position.set(0, WINDOW_HEAD_Y + 0.045, frameZ);

    const sill = this.addMesh(
      this.bag.add(chamferedBox(WINDOW_HALF_WIDTH * 2 + 0.34, 0.09, 0.36, 0.014)),
      walnut,
      parent,
      { casts: true },
    );
    sill.position.set(0, WINDOW_SILL_Y - 0.045, -ROOM_HALF + 0.06);

    const mullionVertical = this.addMesh(
      this.bag.add(chamferedBox(0.05, openingHeight, 0.1, 0.008)),
      walnut,
      parent,
      { casts: true },
    );
    mullionVertical.position.set(0, (WINDOW_SILL_Y + WINDOW_HEAD_Y) / 2, frameZ);

    const mullionHorizontal = this.addMesh(
      this.bag.add(chamferedBox(WINDOW_HALF_WIDTH * 2, 0.05, 0.1, 0.008)),
      walnut,
      parent,
      { casts: true },
    );
    mullionHorizontal.position.set(0, WINDOW_SILL_Y + openingHeight * 0.58, frameZ);
  }

  private buildRug(wool: THREE.Material): void {
    const shape = roundedRectShape(3.9, 3.0, 0.18);
    const geometry = this.bag.add(
      new THREE.ExtrudeGeometry(shape, {
        depth: 0.012,
        bevelEnabled: true,
        bevelThickness: 0.004,
        bevelSize: 0.004,
        bevelOffset: 0,
        bevelSegments: 1,
        curveSegments: 6,
        steps: 1,
      }),
    );
    const rug = this.addMesh(geometry, wool, this.group("rug", -1.55, FLOOR_THICKNESS + 0.001, -1.05));
    rug.rotation.x = -Math.PI / 2;
  }

  private buildArmchair(velvet: THREE.Material, walnut: THREE.Material): void {
    const chair = this.group("armchair", -2.05, FLOOR_THICKNESS, -1.65, 0.78);

    const legGeometry = this.bag.add(new THREE.CylinderGeometry(0.032, 0.044, 0.22, 10));
    for (const dx of [-0.34, 0.34]) {
      for (const dz of [-0.32, 0.32]) {
        const leg = this.addMesh(legGeometry, walnut, chair, { casts: true });
        leg.position.set(dx, 0.11, dz);
      }
    }

    const skirt = this.addMesh(this.bag.add(chamferedBox(0.88, 0.18, 0.86, 0.03)), velvet, chair, { casts: true });
    skirt.position.set(0, 0.31, 0);

    const cushion = this.addMesh(this.bag.add(chamferedBox(0.8, 0.19, 0.78, 0.06)), velvet, chair, { casts: true });
    cushion.position.set(0, 0.49, 0.01);

    const back = this.addMesh(this.bag.add(chamferedBox(0.88, 0.82, 0.17, 0.05)), velvet, chair, { casts: true });
    back.position.set(0, 0.86, -0.36);
    back.rotation.x = 0.14;

    const backCushion = this.addMesh(this.bag.add(chamferedBox(0.68, 0.6, 0.13, 0.05)), velvet, chair, { casts: true });
    backCushion.position.set(0, 0.8, -0.24);
    backCushion.rotation.x = 0.16;

    const armGeometry = this.bag.add(chamferedBox(0.15, 0.26, 0.82, 0.04));
    const rollGeometry = this.bag.add(new THREE.CapsuleGeometry(0.078, 0.6, 4, 12));
    for (const side of [-1, 1]) {
      const arm = this.addMesh(armGeometry, velvet, chair, { casts: true });
      arm.position.set(side * 0.4, 0.66, -0.02);
      const roll = this.addMesh(rollGeometry, velvet, chair, { casts: true });
      roll.position.set(side * 0.4, 0.79, -0.02);
      roll.rotation.x = Math.PI / 2;
    }
  }

  private buildSideTable(walnut: THREE.Material, brass: THREE.Material): void {
    const table = this.group("side-table", -0.62, FLOOR_THICKNESS, -1.2, -0.3);

    const pedestal = latheGeometry(
      [
        [0.26, 0],
        [0.27, 0.018],
        [0.24, 0.05],
        [0.095, 0.09],
        [0.07, 0.17],
        [0.078, 0.31],
        [0.058, 0.43],
        [0.088, 0.5],
        [0.076, 0.56],
        [0.055, 0.6],
      ],
      28,
    );
    this.addMesh(this.bag.add(pedestal), walnut, table, { casts: true });

    const top = latheGeometry(
      [
        [0, 0.6],
        [0.3, 0.6],
        [0.335, 0.616],
        [0.335, 0.64],
        [0.3, 0.658],
        [0, 0.658],
      ],
      32,
    );
    this.addMesh(this.bag.add(top), walnut, table, { casts: true });

    const inlay = this.addMesh(
      this.bag.add(new THREE.TorusGeometry(0.29, 0.006, 8, 40)),
      brass,
      table,
      { casts: false },
    );
    inlay.position.set(0, 0.66, 0);
    inlay.rotation.x = -Math.PI / 2;
  }

  private buildFloorLamp(
    brass: THREE.Material,
    agedBrass: THREE.Material,
    shade: THREE.Material,
    bulb: THREE.Material,
  ): void {
    const lamp = this.group("floor-lamp", LAMP_X, FLOOR_THICKNESS, LAMP_Z);

    const base = latheGeometry(
      [
        [0, 0],
        [0.21, 0],
        [0.22, 0.014],
        [0.2, 0.034],
        [0.055, 0.05],
        [0.032, 0.07],
        [0, 0.07],
      ],
      28,
    );
    this.addMesh(this.bag.add(base), agedBrass, lamp, { casts: true });

    const pole = this.addMesh(this.bag.add(new THREE.CylinderGeometry(0.017, 0.023, 1.38, 14)), brass, lamp, {
      casts: true,
    });
    pole.position.set(0, 0.76, 0);

    const collar = this.addMesh(this.bag.add(new THREE.TorusGeometry(0.028, 0.009, 8, 20)), agedBrass, lamp);
    collar.position.set(0, 1.3, 0);
    collar.rotation.x = -Math.PI / 2;

    const bulbMesh = this.addMesh(this.bag.add(new THREE.SphereGeometry(0.055, 18, 12)), bulb, lamp, {
      casts: false,
      receives: false,
    });
    bulbMesh.position.set(0, LAMP_BULB_Y - FLOOR_THICKNESS, 0);

    const shadeMesh = this.addMesh(
      this.bag.add(new THREE.CylinderGeometry(0.2, 0.28, 0.32, 32, 1, true)),
      shade,
      lamp,
      { casts: false, receives: false },
    );
    shadeMesh.position.set(0, LAMP_BULB_Y - FLOOR_THICKNESS + 0.04, 0);

    const shadeRing = this.addMesh(this.bag.add(new THREE.TorusGeometry(0.2, 0.007, 8, 32)), brass, lamp);
    shadeRing.position.set(0, LAMP_BULB_Y - FLOOR_THICKNESS + 0.2, 0);
    shadeRing.rotation.x = -Math.PI / 2;
  }

  private buildFootstool(velvet: THREE.Material, walnut: THREE.Material): void {
    const stool = this.group("footstool", -1.25, FLOOR_THICKNESS, -0.25, 0.5);

    const legGeometry = this.bag.add(new THREE.CylinderGeometry(0.026, 0.034, 0.17, 10));
    for (const dx of [-0.19, 0.19]) {
      for (const dz of [-0.14, 0.14]) {
        const leg = this.addMesh(legGeometry, walnut, stool, { casts: true });
        leg.position.set(dx, 0.085, dz);
      }
    }
    const top = this.addMesh(this.bag.add(chamferedBox(0.52, 0.16, 0.42, 0.05)), velvet, stool, { casts: true });
    top.position.set(0, 0.25, 0);
  }

  private buildBookStacks(bookCloth: readonly THREE.Material[], paper: THREE.Material): void {
    const tableStack = this.group("book-stack-table", -0.62, FLOOR_THICKNESS + 0.658, -1.2, -0.3);
    const tableBooks: readonly (readonly [number, number, number, number, number])[] = [
      [0.22, 0.05, 0.16, 0, 0.11],
      [0.2, 0.042, 0.15, 0.24, 0.09],
      [0.17, 0.038, 0.13, -0.15, 0.07],
    ];
    let height = 0;
    let index = 0;
    for (const [width, thickness, depth, rotation, offset] of tableBooks) {
      const cover = this.addMesh(
        this.bag.add(chamferedBox(width, thickness, depth, 0.006)),
        bookCloth[index % bookCloth.length] ?? paper,
        tableStack,
        { casts: true },
      );
      cover.position.set(offset * 0.15, height + thickness / 2, 0);
      cover.rotation.y = rotation;
      const leaves = this.addMesh(
        this.bag.add(chamferedBox(width - 0.02, thickness * 0.6, depth - 0.018, 0.004)),
        paper,
        tableStack,
      );
      leaves.position.set(offset * 0.15 + 0.006, height + thickness / 2, 0);
      leaves.rotation.y = rotation;
      height += thickness;
      index += 1;
    }

    const floorStack = this.group("book-stack-floor", -0.25, FLOOR_THICKNESS, -0.35, 0.4);
    const floorBooks: readonly (readonly [number, number, number, number])[] = [
      [0.26, 0.055, 0.19, 0],
      [0.24, 0.048, 0.18, 0.18],
      [0.25, 0.05, 0.18, -0.12],
      [0.21, 0.042, 0.16, 0.3],
    ];
    height = 0;
    index = 0;
    for (const [width, thickness, depth, rotation] of floorBooks) {
      const cover = this.addMesh(
        this.bag.add(chamferedBox(width, thickness, depth, 0.006)),
        bookCloth[(index + 1) % bookCloth.length] ?? paper,
        floorStack,
        { casts: true },
      );
      cover.position.set(0, height + thickness / 2, 0);
      cover.rotation.y = rotation;
      height += thickness;
      index += 1;
    }
    this.clutter.push({ object: floorStack, priority: 0.5 });
  }

  private buildVessels(patina: THREE.Material, porcelain: THREE.Material): void {
    const vase = latheGeometry(
      [
        [0, 0],
        [0.09, 0],
        [0.096, 0.012],
        [0.115, 0.06],
        [0.148, 0.16],
        [0.142, 0.26],
        [0.1, 0.34],
        [0.076, 0.38],
        [0.083, 0.402],
        [0.072, 0.404],
        [0, 0.39],
      ],
      32,
    );
    const vaseGroup = this.group("sill-vase", 0.88, WINDOW_SILL_Y, -ROOM_HALF + 0.1);
    this.addMesh(this.bag.add(vase), patina, vaseGroup, { casts: true });
    this.clutter.push({ object: vaseGroup, priority: 0.8 });

    const bottle = latheGeometry(
      [
        [0, 0],
        [0.1, 0],
        [0.106, 0.014],
        [0.11, 0.18],
        [0.095, 0.28],
        [0.045, 0.34],
        [0.038, 0.46],
        [0.05, 0.49],
        [0.046, 0.5],
        [0, 0.49],
      ],
      32,
    );
    const bottleGroup = this.group("floor-bottle", -3.45, FLOOR_THICKNESS, 1.15);
    this.addMesh(this.bag.add(bottle), porcelain, bottleGroup, { casts: true });
    this.clutter.push({ object: bottleGroup, priority: 0.65 });
  }

  private buildTeaSet(porcelain: THREE.Material): void {
    const tea = this.group("tea-set", -0.62, FLOOR_THICKNESS + 0.658, -1.2, -0.3);
    tea.position.x += 0.19;
    tea.position.z += 0.13;

    const saucer = latheGeometry(
      [
        [0, 0],
        [0.072, 0.002],
        [0.078, 0.008],
        [0.075, 0.013],
        [0.03, 0.007],
        [0, 0.006],
      ],
      24,
    );
    this.addMesh(this.bag.add(saucer), porcelain, tea, { casts: true });

    const cupWall = this.addMesh(
      this.bag.add(new THREE.CylinderGeometry(0.039, 0.028, 0.062, 24, 1, true)),
      porcelain,
      tea,
      { casts: true },
    );
    cupWall.position.set(0, 0.044, 0);
    const cupBase = this.addMesh(this.bag.add(new THREE.CylinderGeometry(0.03, 0.028, 0.008, 24)), porcelain, tea);
    cupBase.position.set(0, 0.017, 0);
    const handle = this.addMesh(this.bag.add(new THREE.TorusGeometry(0.022, 0.005, 8, 20, Math.PI * 1.4)), porcelain, tea);
    handle.position.set(0.045, 0.045, 0);
    handle.rotation.set(Math.PI / 2, 0, -0.4);

    this.clutter.push({ object: tea, priority: 0.9 });
  }

  private buildCandlestick(brass: THREE.Material, wax: THREE.Material, flame: THREE.Material): void {
    const candle = this.group("candlestick", -0.95, WINDOW_SILL_Y, -ROOM_HALF + 0.12);

    const stand = latheGeometry(
      [
        [0, 0],
        [0.062, 0],
        [0.066, 0.008],
        [0.05, 0.022],
        [0.018, 0.03],
        [0.014, 0.12],
        [0.03, 0.15],
        [0.026, 0.164],
        [0.016, 0.17],
        [0, 0.168],
      ],
      24,
    );
    this.addMesh(this.bag.add(stand), brass, candle, { casts: true });

    const stick = this.addMesh(this.bag.add(new THREE.CylinderGeometry(0.014, 0.015, 0.19, 16)), wax, candle, {
      casts: true,
    });
    stick.position.set(0, 0.263, 0);

    const flameMesh = this.addMesh(this.bag.add(new THREE.ConeGeometry(0.011, 0.05, 10)), flame, candle, {
      casts: false,
      receives: false,
    });
    flameMesh.position.set(0, 0.385, 0);

    this.clutter.push({ object: candle, priority: 0.75 });
  }

  private buildPictureFrame(walnut: THREE.Material, canvas: THREE.Material, brass: THREE.Material): void {
    const frame = this.group("picture-frame", -ROOM_HALF + 0.01, 1.95, -1.1, Math.PI / 2);

    const width = 0.86;
    const height = 0.64;
    const railGeometry = this.bag.add(chamferedBox(width, 0.07, 0.05, 0.01));
    const stileGeometry = this.bag.add(chamferedBox(0.07, height, 0.05, 0.01));
    for (const dy of [-height / 2 - 0.035, height / 2 + 0.035]) {
      const rail = this.addMesh(railGeometry, walnut, frame, { casts: true });
      rail.position.set(0, dy, 0.01);
    }
    for (const dx of [-width / 2 - 0.035, width / 2 + 0.035]) {
      const stile = this.addMesh(stileGeometry, walnut, frame, { casts: true });
      stile.position.set(dx, 0, 0.01);
    }

    const art = this.addMesh(this.bag.add(chamferedBox(width, height, 0.02, 0.004)), canvas, frame);
    art.position.set(0, 0, 0.005);

    const plaque = this.addMesh(this.bag.add(chamferedBox(0.16, 0.035, 0.012, 0.004)), brass, frame);
    plaque.position.set(0, -height / 2 - 0.035, 0.04);
  }

  private buildMoonlight(settings: QualitySettings): THREE.DirectionalLight {
    const light = new THREE.DirectionalLight(PALETTE.coolMoonGray, MOONLIGHT_KEY_INTENSITY);
    light.position.set(1.1, 4.8, -9.5);
    light.target.position.set(-1.1, 0.3, 0.3);
    // Set before the light is ever rendered. A light built with castShadow off
    // never allocates a shadow map at all, which is how the light tier actually
    // hands the render targets back rather than merely hiding the shadows.
    light.castShadow = settings.dynamicShadows;
    light.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    light.shadow.bias = -0.0006;
    light.shadow.normalBias = 0.03;
    light.shadow.radius = 3;
    const shadowCamera = light.shadow.camera;
    shadowCamera.left = -6;
    shadowCamera.right = 6;
    shadowCamera.top = 5;
    shadowCamera.bottom = -5;
    shadowCamera.near = 0.5;
    shadowCamera.far = 24;
    shadowCamera.updateProjectionMatrix();
    this.scene.add(light);
    this.scene.add(light.target);
    return light;
  }

  private buildLampSpot(settings: QualitySettings): THREE.SpotLight {
    const spot = new THREE.SpotLight(0xffc48e, 20, 9, 1.05, 0.85, 2);
    spot.position.set(LAMP_X, LAMP_BULB_Y, LAMP_Z);
    spot.target.position.set(LAMP_X + 0.7, 0, LAMP_Z - 0.7);
    spot.castShadow = settings.dynamicShadows && settings.shadowedLocalLights > 0;
    spot.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    spot.shadow.bias = -0.0008;
    spot.shadow.normalBias = 0.02;
    spot.shadow.radius = 4;
    spot.shadow.camera.near = 0.2;
    spot.shadow.camera.far = 10;
    this.scene.add(spot);
    this.scene.add(spot.target);
    return spot;
  }

  /** No shadow map, so this one survives every tier change untouched. */
  private buildLampGlow(): THREE.PointLight {
    const glow = new THREE.PointLight(PALETTE.warmAmber, 2.4, 4.5, 2);
    glow.position.set(LAMP_X, LAMP_BULB_Y + 0.14, LAMP_Z);
    this.scene.add(glow);
    return glow;
  }

  private replaceShadowLights(settings: QualitySettings): void {
    this.releaseLight(this.moonlight);
    this.releaseLight(this.lampSpot);
    this.moonlight = this.buildMoonlight(settings);
    this.lampSpot = this.buildLampSpot(settings);
  }

  private releaseLight(light: THREE.DirectionalLight | THREE.SpotLight): void {
    this.scene.remove(light.target);
    this.scene.remove(light);
    // Light.dispose() only dispatches an event. The shadow map is a separate
    // render target and is the object actually holding GPU memory.
    light.shadow.dispose();
    light.dispose();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Declares which curated swatch a surface is made of, so the Forge samples an
 * approved material id rather than reading colours off the renderer (§7.12).
 */
function publishSwatch(material: THREE.Material | undefined, swatchId: string): void {
  if (material === undefined) {
    throw new Error(`TestRoom: cannot publish swatch "${swatchId}" on a missing material`);
  }
  material.userData["swatchId"] = swatchId;
}

/** Everything about a tier that can only be honoured by rebuilding the lights. */
function shadowSignature(settings: QualitySettings): string {
  return `${String(settings.dynamicShadows)}:${String(settings.shadowMapSize)}:${String(settings.shadowedLocalLights > 0)}`;
}
