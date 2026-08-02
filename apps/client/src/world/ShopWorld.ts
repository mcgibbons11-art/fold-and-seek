import * as THREE from "three/webgpu";

import { DisposalBag } from "../engine/DisposalBag";
import type { ForgeWorkspace } from "../forge/ForgeController";
import type { QualitySettings } from "../rendering/quality";
import { CuriosityShop, type CuriosityShopMap, type ShopBuildStep } from "./maps/CuriosityShop";
import { createShopEnvironment } from "./maps/lighting";
import {
  SHOP_MAX_X,
  SHOP_MAX_Z,
  SHOP_MIN_X,
  SHOP_MIN_Z,
  WALL_HEIGHT,
} from "./maps/zones";

/**
 * The volume a Mimic may be folded inside on this map. It reaches the walls and
 * the ceiling rather than stopping short of them, because mounting on a wall
 * and hanging from a fitting are both legal disguises (§7.15, §7.16). The floor
 * bound sits a hair above zero so nothing is posed inside the boards.
 */
export const SHOP_FORGE_WORKSPACE: ForgeWorkspace = {
  minX: SHOP_MIN_X,
  maxX: SHOP_MAX_X,
  minY: 0.02,
  maxY: WALL_HEIGHT,
  minZ: SHOP_MIN_Z,
  maxZ: SHOP_MAX_Z,
};

/**
 * Longest the loading screen will wait on the shader precompile before letting
 * the round proceed with lazy compilation. Generous for a healthy GPU (the
 * whole-shop compile is seconds there) and a ceiling for a contended one.
 */
export const SHOP_PRECOMPILE_DEADLINE_MS = 20_000;

/**
 * The scene a round is played in: The Curiosity Shop and the environment that
 * lights it, and nothing else. It deliberately owns no camera, because during a
 * round the camera belongs to whichever system has the player, the Forge orbit,
 * the Inspector rig, or the survey view between phases.
 */
export class ShopWorld {
  readonly scene: THREE.Scene;
  readonly map: CuriosityShopMap;

  private readonly bag = new DisposalBag();

  constructor(renderer: THREE.WebGPURenderer, settings: QualitySettings, map?: CuriosityShopMap) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08070a);
    this.scene.environment = this.bag.add(createShopEnvironment(renderer));
    this.scene.environmentIntensity = 0.55;

    this.map = map ?? new CuriosityShop().build(settings);
    this.scene.add(this.map.root);
  }

  /**
   * Builds the map across several turns, handing each finished piece back so a
   * caller can yield to the browser between them, and wraps the result.
   *
   * The environment map is generated first because it is one prefiltered render
   * and there is nothing to divide; everything after it is the shop itself.
   */
  static async createIncremental(
    renderer: THREE.WebGPURenderer,
    settings: QualitySettings,
    onStep: (step: ShopBuildStep) => Promise<void>,
  ): Promise<ShopWorld> {
    const steps = new CuriosityShop().buildSteps(settings);
    let step = steps.next();
    while (step.done !== true) {
      await onStep(step.value);
      step = steps.next();
    }
    return new ShopWorld(renderer, settings, step.value);
  }

  /**
   * Builds every shader the shop needs before the first frame that draws it.
   *
   * A precompile walks the render list exactly as a frame does, so a prop
   * outside the camera would be skipped and its shader built later, in the
   * middle of play. Culling is turned off for the length of the call and put
   * back afterwards, which is what makes one camera enough for the whole room.
   *
   * Shadow passes are not covered: three builds those pipelines from the shadow
   * camera on the first frame that casts, and there is no public precompile for
   * them.
   *
   * The precompile is BEST-EFFORT, not a gate. Measured in the Portals editor's
   * 2p preview on an integrated GPU, two panes compiling the whole shop at once
   * sat at "95% · the shaders" for minutes — a loading screen that never ends
   * is worse than the hitches it prevents. Past the deadline the load proceeds
   * and whatever is still uncompiled is built lazily on the frames that first
   * draw it; the compile keeps running behind play and culling is restored
   * whenever it settles.
   */
  async precompile(renderer: THREE.WebGPURenderer, camera: THREE.Camera): Promise<void> {
    const culled: THREE.Object3D[] = [];
    this.scene.traverse((object) => {
      if (!object.frustumCulled) return;
      object.frustumCulled = false;
      culled.push(object);
    });
    const restore = (): void => {
      for (const object of culled) object.frustumCulled = true;
      culled.length = 0;
    };
    const compile = renderer.compileAsync(this.scene, camera).then(restore, restore);
    await Promise.race([
      compile,
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHOP_PRECOMPILE_DEADLINE_MS);
      }),
    ]);
  }

  applyQuality(settings: QualitySettings): void {
    this.map.applyQuality(settings);
  }

  dispose(): void {
    this.map.dispose();
    this.scene.clear();
    this.bag.dispose();
  }
}
