import * as THREE from "three/webgpu";
import { DisposalBag } from "../../engine/DisposalBag";
import type { QualitySettings } from "../../rendering/quality";
import { PRACTICAL_PLACEMENTS, type PropPlacement } from "./placements";
import {
  SECURITY_OFFICE_BOUNDS,
  SHOP_MAX_X,
  SHOP_MAX_Z,
  SHOP_MIN_X,
  SHOP_MIN_Z,
  WINDOW_MAX_X,
  WINDOW_MIN_X,
} from "./zones";

/**
 * Lighting for The Curiosity Shop (§10.2, §18.3).
 *
 * One cool moon key comes through the front window and is the only shadowed
 * directional; the warm practicals are the lamps the map actually authored, so
 * every pool of light in the room belongs to a prop a player can point at.
 * Underneath all of it sits the fill rig below, which is what stops a corner
 * with no lamp in it from going to black.
 */

const MOON_COLOR = 0x8fb2e8;
/** Findable by the round, which drifts the moon across the sky (2026-08-04). */
export const MOON_LIGHT_NAME = "shop.moonlight";
/** Where the moon starts, restated for the drift to swing about. */
export const MOON_BASE_POSITION: readonly [number, number, number] = [
  (WINDOW_MIN_X + WINDOW_MAX_X) / 2 + 2.5,
  6.5,
  SHOP_MIN_Z - 8,
];
/** Radians of azimuth the moon crosses over one full phase. */
export const MOON_DRIFT_RAD = 0.14;
const MOON_KEY_INTENSITY = 4.2;
const MOON_FILL_INTENSITY = 1.6;

/** A fill directional aims here, roughly the middle of the sales floor. */
const FILL_TARGET: readonly [number, number, number] = [0, 0.6, 0];

export interface FillDirectional {
  readonly color: number;
  readonly intensity: number;
  readonly position: readonly [number, number, number];
}

/**
 * Every unshadowed light in the room, as data.
 *
 * This is the *readability floor*: what a surface receives with no practical,
 * no moon and no environment map reaching it. The game asks a player to compare
 * a painted body against the props beside it, so a surface that falls below
 * readable is a fairness bug rather than atmosphere, and the floor has to hold
 * everywhere a player can stand rather than only inside the lamp pools.
 *
 * The rig is four-way on purpose, so a silhouette is lit from every side by
 * something and the hue still tells the player which way they are facing:
 * a cool hemisphere overhead and underfoot, a cool wash from the window side,
 * and a warm wash from the opposite corner standing in for the light the lamps
 * throw back off the walnut. Flat ambient alone would reach the same level and
 * read as fog.
 *
 * `dressing.test.ts` measures it: it is data rather than lights so the check
 * runs without a graphics device, and so the numbers in the test are the same
 * numbers the renderer gets.
 */
export const SHOP_FILL_RIG = {
  /** Cold, because every practical in the room is amber and the shadows are not. */
  ambientColor: 0x232c3c,
  ambientIntensity: 0.85,
  /**
   * Moonlit air above, and moonlit air below as well.
   *
   * The lower half used to be a warm brown standing in for lamplight bouncing
   * off the boards, and it put that brown on every face turned away from the
   * room: shadows came out muddy, which is the opposite of the reference, where
   * a cool ambient sits behind the warm pools rather than under them. The warm
   * bounce is still delivered, but by the warm directional below and by the
   * practicals themselves, which are the lights that actually have a colour.
   *
   * Blue-grey is also very slightly *brighter* than the brown it replaces, so
   * the readability floor `dressing.test.ts` measures went up rather than down:
   * a white body at the worst comparable normal reads 0.193 against 0.187, and
   * its separation from a mid tone 0.159 against 0.155.
   */
  skyColor: 0x4f68a0,
  groundColor: 0x4a566e,
  hemisphereIntensity: 1.3,
  directionals: [
    // Cold wash from high over the back corner: the back rooms are out of the
    // moon's reach and every practical in them is amber, so without this they
    // sat at one hue whatever the materials did (§17.3, §18.3).
    { color: 0x7f9ad8, intensity: 1.05, position: [SHOP_MAX_X + 4, 7.5, SHOP_MAX_Z + 5] },
    // Warm bounce from the window corner, low and opposite the cold one, so
    // every silhouette carries a warm edge against a cool one.
    { color: 0xffb37a, intensity: 0.8, position: [SHOP_MIN_X - 1.5, 3.2, SHOP_MIN_Z - 2.5] },
  ] as readonly FillDirectional[],
} as const;

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearRgb(hex: number): [number, number, number] {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ];
}

/**
 * Irradiance the fill rig delivers to a surface with the given world normal, in
 * the renderer's linear working space.
 *
 * This restates three's own diffuse lighting for the fill lights only: ambient
 * contributes flat, the hemisphere mixes ground to sky by the normal's tilt,
 * and each directional contributes by its cosine. Multiply by albedo and divide
 * by pi to get the diffuse radiance the shader writes. Nothing here accounts
 * for the environment map, the moon or the practicals, so a real frame is
 * always brighter than this — the point is the guaranteed lower bound.
 */
export function fillIrradiance(normal: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n: [number, number, number] = [normal[0] / length, normal[1] / length, normal[2] / length];

  const ambient = linearRgb(SHOP_FILL_RIG.ambientColor);
  const sky = linearRgb(SHOP_FILL_RIG.skyColor);
  const ground = linearRgb(SHOP_FILL_RIG.groundColor);
  const skyWeight = 0.5 + 0.5 * n[1];

  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const a = ambient[i] ?? 0;
    const s = sky[i] ?? 0;
    const g = ground[i] ?? 0;
    out[i] = a * SHOP_FILL_RIG.ambientIntensity + (g + (s - g) * skyWeight) * SHOP_FILL_RIG.hemisphereIntensity;
  }

  for (const light of SHOP_FILL_RIG.directionals) {
    const dx = light.position[0] - FILL_TARGET[0];
    const dy = light.position[1] - FILL_TARGET[1];
    const dz = light.position[2] - FILL_TARGET[2];
    const distance = Math.hypot(dx, dy, dz) || 1;
    const cosine = Math.max((n[0] * dx + n[1] * dy + n[2] * dz) / distance, 0);
    if (cosine === 0) {
      continue;
    }
    const color = linearRgb(light.color);
    for (let i = 0; i < 3; i += 1) {
      out[i] = (out[i] ?? 0) + (color[i] ?? 0) * light.intensity * cosine;
    }
  }
  return out;
}

/**
 * Fixtures that get a light pool when they lose their live light, and which
 * kind of pool.
 *
 * The two kinds are different in size as well as in height. A floor lamp or a
 * pendant throws metres of light across open boards. A table lamp lights the
 * table it stands on and little else, and giving it the floor lamp's radius
 * would hang a glowing disc a metre out past the table edge in mid-air.
 *
 * A sconce gets none: it washes the wall beside it, and a disc lying flat under
 * one would be a lie. Its own lit shade carries it.
 */
const POOL_SURFACE: Readonly<Record<string, "floor" | "tabletop">> = {
  floor_lamp: "floor",
  pendant_lamp: "floor",
  table_lamp: "tabletop",
  task_light: "tabletop",
  candlestick: "tabletop",
};

interface PoolShape {
  /** Share of the practical's authored radius the pool covers. */
  readonly radiusShare: number;
  readonly maxRadius: number;
}

const POOL_SHAPE: Readonly<Record<"floor" | "tabletop", PoolShape>> = {
  floor: { radiusShare: 0.5, maxRadius: 2.4 },
  // Deliberately smaller than the light it stands in for, so the disc stays on
  // the furniture. The spill past the table edge is the part being given up.
  tabletop: { radiusShare: 0.09, maxRadius: 0.28 },
};

/** Clear of the surface by enough not to fight it for depth. */
const POOL_LIFT = 0.006;
const POOL_STRENGTH = 0.42;
const POOL_TEXTURE_SIZE = 128;

const WINDOW_CENTRE_X = (WINDOW_MIN_X + WINDOW_MAX_X) / 2;

/**
 * Whether a lamp lights anywhere a player can actually be.
 *
 * The Security Office is sealed: `FLOOR_PLAN` publishes no walkable box inside
 * it and every prop in it is `blocked` for accusation, so nobody ever stands
 * there and nothing ever hides there. Its pendant nonetheless carries the
 * highest authored priority in the manifest, which on a six-light budget would
 * have spent the single most valuable light in the room on a room nobody can
 * enter. It is still a lit fixture seen through the glazing; it is just the
 * first light to go rather than the last.
 */
function lightsPlayableSpace(placement: PropPlacement): boolean {
  const [x, , z] = placement.position;
  return !(
    x >= SECURITY_OFFICE_BOUNDS.min.x &&
    x <= SECURITY_OFFICE_BOUNDS.max.x &&
    z >= SECURITY_OFFICE_BOUNDS.min.z &&
    z <= SECURITY_OFFICE_BOUNDS.max.z
  );
}

/**
 * Practicals in the order they keep their live lights: the ones lighting space
 * a player occupies first, then by authored priority.
 *
 * The authored priority is a claim about how much a lamp matters to the room's
 * look, which is the right tie-break but the wrong first sort once the budget
 * is small enough that only the gameplay-relevant pools survive. Sorting here
 * rather than in `placements.ts` keeps the manifest a description of the shop
 * and leaves this a rendering policy. `sort` is stable, so lamps that tie keep
 * their authored order.
 */
export const PRACTICALS_BY_RANK: readonly PropPlacement[] = [...PRACTICAL_PLACEMENTS].sort((a, b) => {
  const playable = Number(lightsPlayableSpace(b)) - Number(lightsPlayableSpace(a));
  return playable !== 0 ? playable : (b.practical?.priority ?? 0) - (a.practical?.priority ?? 0);
});

/**
 * Practicals that author a pool, in the order the pools are built.
 *
 * Reverse rank: the lamps a budget gives up first come first, so the pools that
 * have to appear are always the leading instances of one `InstancedMesh` and
 * switching them on costs a `count` assignment.
 */
const POOL_ORDER: readonly number[] = PRACTICALS_BY_RANK.map((placement, index) => ({ placement, index }))
  .reverse()
  .filter((entry) => POOL_SURFACE[entry.placement.variant] !== undefined)
  .map((entry) => entry.index);

export interface PracticalLightPlan {
  /** Practicals running as real point lights. */
  readonly live: number;
  /** Practicals reduced to emissive geometry. */
  readonly unlit: number;
  /** Of those, the ones that stand a pool in for their light. */
  readonly pools: number;
}

/**
 * What a live-light budget actually buys, as pure arithmetic over the authored
 * manifest. The renderer and the tests read the same function, so a claim about
 * how many lights the WebGPU path runs is checkable without a device.
 */
export function planPracticalLights(maxPracticalLights: number): PracticalLightPlan {
  const live = Math.max(Math.min(maxPracticalLights, PRACTICALS_BY_RANK.length), 0);
  return {
    live,
    unlit: PRACTICALS_BY_RANK.length - live,
    pools: POOL_ORDER.filter((index) => index >= live).length,
  };
}

function shadowSignature(settings: QualitySettings): string {
  return `${String(settings.dynamicShadows)}:${String(settings.shadowMapSize)}:${String(settings.shadowedLocalLights)}`;
}

/**
 * Soft disc the stand-in pools are drawn with. Alpha carries the falloff,
 * because additive blending scales the source by it, and the instance colour
 * then decides the lamp's hue and how strong its pool is.
 */
function createPoolTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = POOL_TEXTURE_SIZE;
  canvas.height = POOL_TEXTURE_SIZE;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Curiosity Shop: 2D canvas context unavailable, cannot build the light pools");
  }

  const half = POOL_TEXTURE_SIZE / 2;
  const gradient = context.createRadialGradient(half, half, 0, half, half, half);
  // A linear ramp reads as a disc with an edge; this is roughly an inverse
  // square, which is what the light it stands in for would have done.
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.62)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.26)");
  gradient.addColorStop(0.75, "rgba(255,255,255,0.08)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, POOL_TEXTURE_SIZE, POOL_TEXTURE_SIZE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export interface ShopLightingStats {
  readonly practicals: number;
  readonly shadowedLights: number;
  /** Lamps standing in a pool for a light the backend could not afford. */
  readonly lightPools: number;
}

export class ShopLighting {
  private readonly bag = new DisposalBag();
  private readonly practicals: THREE.PointLight[] = [];
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;

  private readonly fills: THREE.DirectionalLight[];
  private moon: THREE.DirectionalLight;
  private counterSpot: THREE.SpotLight;
  private shadowKey: string;
  private settings: QualitySettings;

  /** Stand-in pools for the lamps a backend cannot afford to light. */
  private pools: THREE.InstancedMesh | null = null;

  constructor(
    private readonly root: THREE.Group,
    settings: QualitySettings,
  ) {
    this.settings = settings;
    this.shadowKey = shadowSignature(settings);

    this.hemisphere = new THREE.HemisphereLight(
      SHOP_FILL_RIG.skyColor,
      SHOP_FILL_RIG.groundColor,
      SHOP_FILL_RIG.hemisphereIntensity,
    );
    this.ambient = new THREE.AmbientLight(SHOP_FILL_RIG.ambientColor, SHOP_FILL_RIG.ambientIntensity);
    this.root.add(this.hemisphere);
    this.root.add(this.ambient);

    this.moon = this.buildMoon(settings);
    this.fills = SHOP_FILL_RIG.directionals.map((entry) => this.buildFill(entry));
    this.counterSpot = this.buildCounterSpot(settings);
    this.buildPracticals();
    this.buildPools();
    this.applyQuality(settings);
  }

  get stats(): ShopLightingStats {
    const shadowed = (this.moon.castShadow ? 1 : 0) + (this.counterSpot.castShadow ? 1 : 0);
    return {
      practicals: this.practicals.filter((light) => light.visible).length,
      shadowedLights: shadowed,
      lightPools: this.pools?.count ?? 0,
    };
  }

  applyQuality(settings: QualitySettings): void {
    this.settings = settings;

    const key = shadowSignature(settings);
    if (key !== this.shadowKey) {
      this.shadowKey = key;
      this.releaseLight(this.moon);
      this.releaseLight(this.counterSpot);
      this.moon = this.buildMoon(settings);
      this.counterSpot = this.buildCounterSpot(settings);
    }

    // Without a shadow map the key floods straight through the shopfront, so
    // it drops to a fill level and the warm practicals stay dominant.
    this.moon.intensity = settings.dynamicShadows ? MOON_KEY_INTENSITY : MOON_FILL_INTENSITY;

    // The lights were built in rank order, so a budget cut always takes the
    // lamps that matter least to a player first.
    const budget = Math.min(settings.maxPracticalLights, this.practicals.length);
    this.practicals.forEach((light, index) => {
      light.visible = index < budget;
    });

    // Pools are built in reverse, so the ones belonging to the lamps that just
    // lost their light are exactly the leading instances. An InstancedMesh
    // draws [0, count), which makes this the whole of the switch-over.
    if (this.pools !== null) {
      this.pools.count = planPracticalLights(budget).pools;
      this.pools.visible = this.pools.count > 0;
    }
  }

  dispose(): void {
    this.releaseLight(this.moon);
    for (const fill of this.fills) {
      this.releaseLight(fill);
    }
    this.fills.length = 0;
    this.releaseLight(this.counterSpot);
    for (const light of this.practicals) {
      this.root.remove(light);
    }
    this.practicals.length = 0;
    this.root.remove(this.hemisphere);
    this.root.remove(this.ambient);
    this.hemisphere.dispose();
    this.ambient.dispose();
    this.bag.dispose();
  }

  /**
   * Cool key raking through the shopfront. The shadow camera frames the sales
   * floor rather than the whole map, which is what keeps a 2k map sharp enough
   * for the window mullions to read on the floor.
   */
  private buildMoon(settings: QualitySettings): THREE.DirectionalLight {
    const light = new THREE.DirectionalLight(MOON_COLOR, MOON_KEY_INTENSITY);
    light.name = MOON_LIGHT_NAME;
    light.position.set(WINDOW_CENTRE_X + 2.5, 6.5, SHOP_MIN_Z - 8);
    light.target.position.set(WINDOW_CENTRE_X + 1.5, 0.2, 1.5);
    // Set before the light is first rendered: a light built with castShadow
    // off never allocates a shadow map, which is how a tier actually hands the
    // render targets back rather than merely hiding the shadows.
    light.castShadow = settings.dynamicShadows;
    light.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    light.shadow.bias = -0.0006;
    light.shadow.normalBias = 0.035;
    light.shadow.radius = 3;
    // The frustum has to cover the whole shell: a fragment outside it is not
    // shadowed at all, which lit the back rooms as if the wall were not there.
    const camera = light.shadow.camera;
    camera.left = -13;
    camera.right = 13;
    camera.top = 11;
    camera.bottom = -11;
    camera.near = 1;
    camera.far = 34;
    camera.updateProjectionMatrix();
    this.root.add(light);
    this.root.add(light.target);
    return light;
  }

  /** One wash of the fill rig. These never cast: they are the base, not a key. */
  private buildFill(entry: FillDirectional): THREE.DirectionalLight {
    const light = new THREE.DirectionalLight(entry.color, entry.intensity);
    light.position.set(entry.position[0], entry.position[1], entry.position[2]);
    light.target.position.set(FILL_TARGET[0], FILL_TARGET[1], FILL_TARGET[2]);
    light.castShadow = false;
    this.root.add(light);
    this.root.add(light.target);
    return light;
  }

  /** Warm shadowed key over the counter, the one local light worth a map. */
  private buildCounterSpot(settings: QualitySettings): THREE.SpotLight {
    const spot = new THREE.SpotLight(0xffc48e, 15, 7, 0.95, 0.8, 2);
    spot.position.set(2.1, 2.85, 3.9);
    spot.target.position.set(2.1, 1.0, 4.0);
    spot.castShadow = settings.dynamicShadows && settings.shadowedLocalLights > 0;
    spot.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    spot.shadow.bias = -0.0008;
    spot.shadow.normalBias = 0.02;
    spot.shadow.radius = 4;
    spot.shadow.camera.near = 0.3;
    spot.shadow.camera.far = 8;
    this.root.add(spot);
    this.root.add(spot.target);
    return spot;
  }

  /**
   * One point light per authored practical, strongest first, so a tier can cut
   * the tail without ever dimming the lamp a player is standing next to.
   */
  private buildPracticals(): void {
    for (const placement of PRACTICALS_BY_RANK) {
      const practical = placement.practical;
      if (practical === undefined) {
        continue;
      }
      const light = new THREE.PointLight(practical.color, practical.intensity, practical.distance, 2);
      light.name = `practical:${placement.objectId}`;
      // Real bulbs of different ages are not the same amber. A deterministic
      // spread across the authored colour keeps the room from reading as one
      // lamp copied twenty times, without changing what the manifest declares.
      const drift = Math.sin(placement.position[0] * 12.9898 + placement.position[2] * 78.233) * 0.5;
      light.color.offsetHSL(drift * 0.035, drift * 0.12, 0);
      light.position.set(
        placement.position[0],
        placement.position[1] + practical.offsetY,
        placement.position[2],
      );
      this.root.add(light);
      this.bag.add(light);
      this.practicals.push(light);
    }
  }

  /**
   * Light pools for the lamps that lose their point light.
   *
   * A lamp with no light is a lamp that stops lighting its corner, which would
   * undo the whole point of the fill work; the pool puts the warm disc back
   * without a light in the shading loop. It is one additive instanced draw for
   * the whole room, and it is unlit geometry, so it costs the fragment shader
   * nothing but a texture fetch.
   *
   * What it deliberately does not do is light the walls and props around the
   * lamp — only the surface it lies on. That is the price of the trade, and it
   * is why the fill rig had to come up first.
   */
  private buildPools(): void {
    const entries = POOL_ORDER.map((index) => PRACTICALS_BY_RANK[index]).filter(
      (placement): placement is PropPlacement => placement !== undefined,
    );
    if (entries.length === 0) {
      return;
    }

    const geometry = this.bag.add(new THREE.PlaneGeometry(1, 1));
    geometry.rotateX(-Math.PI / 2);
    const material = this.bag.add(
      new THREE.MeshBasicMaterial({
        map: this.bag.add(createPoolTexture()),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );

    const mesh = new THREE.InstancedMesh(geometry, material, entries.length);
    mesh.name = "shop.lightPools";
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // The pools sit flat on surfaces the camera is often level with, and their
    // bounds are a hair thick, which makes frustum culling unreliable for them.
    mesh.frustumCulled = false;

    const matrix = new THREE.Matrix4();
    const colour = new THREE.Color();
    entries.forEach((placement, instance) => {
      const practical = placement.practical;
      if (practical === undefined) {
        return;
      }
      const surface = POOL_SURFACE[placement.variant];
      if (surface === undefined) {
        return;
      }
      const shape = POOL_SHAPE[surface];
      // A floor pool lies on the boards whether its lamp stands there or hangs
      // over it; a tabletop pool lies on the furniture the lamp stands on.
      const y = (surface === "floor" ? 0 : placement.position[1]) + POOL_LIFT;
      const radius = Math.min(practical.distance * shape.radiusShare, shape.maxRadius);
      matrix.makeScale(radius * 2, 1, radius * 2);
      matrix.setPosition(placement.position[0], y, placement.position[2]);
      mesh.setMatrixAt(instance, matrix);

      colour.setHex(practical.color, THREE.SRGBColorSpace);
      colour.multiplyScalar(POOL_STRENGTH * Math.min(practical.intensity / 6, 1.4));
      mesh.setColorAt(instance, colour);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }

    this.root.add(mesh);
    this.bag.add(mesh);
    this.pools = mesh;
  }

  private releaseLight(light: THREE.DirectionalLight | THREE.SpotLight): void {
    this.root.remove(light.target);
    this.root.remove(light);
    // dispose() only dispatches an event; the shadow map is a separate render
    // target and is the object actually holding GPU memory.
    light.shadow.dispose();
    light.dispose();
  }
}

/**
 * Image-based ambient built from a tiny procedural room: a dark shell, a cool
 * window panel, two warm lamp panels and a floor bounce. Cheaper and far more
 * controllable here than shipping an HDR, and it is what gives the brass and
 * the glazes something to reflect.
 *
 * The map itself never needs the renderer, so this is offered separately for
 * the host to apply to its scene.
 */
export function createShopEnvironment(renderer: THREE.WebGPURenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const bag = new DisposalBag();

  // The shell is the indirect equivalent of the fill rig: it is what a surface
  // reflects when it faces nothing in particular. Left at near-black it made
  // every unlit roughness read as a hole, so it carries a dim warm floor now.
  const shell = bag.add(new THREE.BoxGeometry(24, 10, 20));
  const shellMaterial = bag.add(new THREE.MeshBasicMaterial({ color: 0x171310, side: THREE.BackSide }));
  scene.add(new THREE.Mesh(shell, shellMaterial));

  const panel = bag.add(new THREE.PlaneGeometry(1, 1));
  const panels: readonly {
    readonly color: number;
    readonly scale: readonly [number, number];
    readonly position: readonly [number, number, number];
    readonly rotation: readonly [number, number, number];
  }[] = [
    // Two cool sources against three warm ones: the brass and the glazes need
    // a hue to reflect on each side, or every specular in the room is amber.
    { color: 0xa8c8ff, scale: [7, 3.4], position: [-3.7, 1.8, SHOP_MIN_Z - 0.2], rotation: [0, 0, 0] },
    { color: 0x6f8fd0, scale: [4, 3], position: [7.6, 2.2, 3], rotation: [0, -Math.PI / 2, 0] },
    { color: 0xffb066, scale: [2, 2], position: [-6, 1.6, 3], rotation: [0, Math.PI / 2, 0] },
    { color: 0xffb066, scale: [2, 2], position: [2.1, 2.6, 3.9], rotation: [Math.PI / 2, 0, 0] },
    { color: 0x46341f, scale: [20, 16], position: [0, -1.5, 0], rotation: [-Math.PI / 2, 0, 0] },
    { color: 0x16121a, scale: [20, 16], position: [0, 4.6, 0], rotation: [Math.PI / 2, 0, 0] },
  ];

  for (const entry of panels) {
    const material = bag.add(new THREE.MeshBasicMaterial({ color: entry.color, side: THREE.DoubleSide }));
    const mesh = new THREE.Mesh(panel, material);
    mesh.scale.set(entry.scale[0], entry.scale[1], 1);
    mesh.position.set(entry.position[0], entry.position[1], entry.position[2]);
    mesh.rotation.set(entry.rotation[0], entry.rotation[1], entry.rotation[2]);
    scene.add(mesh);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  scene.clear();
  bag.dispose();
  return target.texture;
}
