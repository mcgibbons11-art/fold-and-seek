import * as THREE from "three/webgpu";
import { DisposalBag } from "../../engine/DisposalBag";
import type { QualitySettings, QualityTier } from "../../rendering/quality";
import { PRACTICAL_PLACEMENTS } from "./placements";
import { SHOP_MAX_X, SHOP_MAX_Z, SHOP_MIN_Z, WINDOW_MAX_X, WINDOW_MIN_X } from "./zones";

/**
 * Lighting for The Curiosity Shop (§10.2, §18.3).
 *
 * One cool moon key comes through the front window and is the only shadowed
 * directional; the warm practicals are the lamps the map actually authored, so
 * every pool of light in the room belongs to a prop a player can point at. A
 * hemisphere and a low ambient keep the darkest corner readable, because a
 * pitch-black hiding spot is a fairness bug rather than atmosphere.
 */

const MOON_COLOR = 0x8fb2e8;
const MOON_KEY_INTENSITY = 4.2;
const MOON_FILL_INTENSITY = 1.6;
const SKY_COLOR = 0x3f5a92;
const GROUND_COLOR = 0x2a1d12;
/**
 * The ambient is cold on purpose. Every practical in the shop is warm, so a
 * warm ambient left the whole room one hue and flattened it; a cold ambient
 * puts the shadows in blue and lets each lamp carve its own amber pool, which
 * is the read the reference dioramas get their depth from (§17.3).
 */
const AMBIENT_COLOR = 0x1d2739;

/** How many authored practicals a tier can afford as real lights. */
const PRACTICAL_BUDGET: Readonly<Record<QualityTier, number>> = {
  ultra: 20,
  high: 17,
  medium: 10,
  low: 7,
  light: 5,
};

const WINDOW_CENTRE_X = (WINDOW_MIN_X + WINDOW_MAX_X) / 2;

function shadowSignature(settings: QualitySettings): string {
  return `${String(settings.dynamicShadows)}:${String(settings.shadowMapSize)}:${String(settings.shadowedLocalLights)}`;
}

export interface ShopLightingStats {
  readonly practicals: number;
  readonly shadowedLights: number;
}

export class ShopLighting {
  private readonly bag = new DisposalBag();
  private readonly practicals: THREE.PointLight[] = [];
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;

  private readonly coolFill: THREE.DirectionalLight;
  private moon: THREE.DirectionalLight;
  private counterSpot: THREE.SpotLight;
  private shadowKey: string;
  private settings: QualitySettings;

  constructor(
    private readonly root: THREE.Group,
    settings: QualitySettings,
  ) {
    this.settings = settings;
    this.shadowKey = shadowSignature(settings);

    this.hemisphere = new THREE.HemisphereLight(SKY_COLOR, GROUND_COLOR, 0.62);
    this.ambient = new THREE.AmbientLight(AMBIENT_COLOR, 0.62);
    this.root.add(this.hemisphere);
    this.root.add(this.ambient);

    this.moon = this.buildMoon(settings);
    this.coolFill = this.buildCoolFill();
    this.counterSpot = this.buildCounterSpot(settings);
    this.buildPracticals();
    this.applyQuality(settings);
  }

  get stats(): ShopLightingStats {
    const shadowed = (this.moon.castShadow ? 1 : 0) + (this.counterSpot.castShadow ? 1 : 0);
    return { practicals: this.practicals.filter((light) => light.visible).length, shadowedLights: shadowed };
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

    const budget = PRACTICAL_BUDGET[settings.tier];
    this.practicals.forEach((light, index) => {
      light.visible = index < budget;
    });
  }

  dispose(): void {
    this.releaseLight(this.moon);
    this.releaseLight(this.coolFill);
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

  /**
   * Unshadowed cold wash from high on the back wall.
   *
   * The back rooms are out of the moon's reach and every practical in them is
   * amber, which left them a single hue whatever the materials did. This costs
   * no shadow map and gives every silhouette a cold edge to separate it from
   * the warm pool behind it, which is where the reference dioramas get their
   * depth (§17.3, §18.3).
   */
  private buildCoolFill(): THREE.DirectionalLight {
    const light = new THREE.DirectionalLight(0x7f9ad8, 1.15);
    light.position.set(SHOP_MAX_X + 4, 7.5, SHOP_MAX_Z + 5);
    light.target.position.set(WINDOW_CENTRE_X, 0.6, 0);
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
    for (const placement of PRACTICAL_PLACEMENTS) {
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

  const shell = bag.add(new THREE.BoxGeometry(24, 10, 20));
  const shellMaterial = bag.add(new THREE.MeshBasicMaterial({ color: 0x0e0c0a, side: THREE.BackSide }));
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
    { color: 0x3a2a1c, scale: [20, 16], position: [0, -1.5, 0], rotation: [-Math.PI / 2, 0, 0] },
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
