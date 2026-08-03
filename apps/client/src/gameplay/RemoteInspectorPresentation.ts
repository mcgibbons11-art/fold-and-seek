import * as THREE from "three/webgpu";

import { GunView, InspectorBody } from "../inspector";
import { CameraSampleInterpolationBuffer } from "../inspector/cameraSamples";
import { INSPECTOR_EYE_HEIGHT_M, WORLD_SCALE } from "../inspector/navData";
import type { InspectorCameraSample } from "../networking/NetworkAdapter";
import {
  clientPerformanceTelemetry,
  type PerformanceTelemetry,
} from "../engine/performanceTelemetry";
import type { RemoteInspectorFootsteps } from "./footsteps";

const TELEPORT_DISTANCE_M = WORLD_SCALE.playerHeight * 8;

/**
 * The body that represents another human Inspector.
 *
 * Camera telemetry is intentionally sparse (normally 10 Hz). This class turns
 * those samples back into a frame-rate presentation, including locomotion and
 * the gun in the articulated right hand. Gameplay authority never reads this
 * object; it is visual interpolation only.
 */
export class RemoteInspectorPresentation {
  readonly root = new THREE.Group();

  private readonly body: InspectorBody;
  private readonly gun: GunView;
  private readonly samples = new CameraSampleInterpolationBuffer();
  private readonly renderedEye = new THREE.Vector3();
  private renderedYaw = 0;
  private renderedPitch = 0;
  /** Achieved horizontal velocity inferred from sparse peer presentation samples. */
  private velocityX = 0;
  private velocityZ = 0;
  private speedMps = 0;
  private airborne = false;
  private climbing = false;
  private landingSpeed = 0;
  private visible = true;
  private initialized = false;
  private lastFiredEventSeq = Number.NEGATIVE_INFINITY;
  private footsteps: RemoteInspectorFootsteps | null = null;
  private surfaceAt: ((x: number, y: number, z: number) => string | null) | null = null;

  get eye(): Readonly<THREE.Vector3> | null {
    return this.initialized ? this.renderedEye : null;
  }

  /** Last achieved X/Z velocity, retained independently of vertical traversal. */
  get achievedHorizontalVelocity(): readonly [x: number, z: number] {
    return [this.velocityX, this.velocityZ];
  }

  constructor(
    scene: THREE.Scene,
    readonly seatId: string,
    castShadow = true,
    private readonly telemetry: PerformanceTelemetry = clientPerformanceTelemetry,
  ) {
    this.root.name = `remote-inspector-${seatId}`;
    scene.add(this.root);
    this.body = new InspectorBody(this.root, scene, castShadow);
    this.gun = new GunView(scene);
    this.gun.attachToHand(this.body.hand);
  }

  push(sample: InspectorCameraSample): void {
    const insertion = this.samples.push(sample);
    this.telemetry.recordRemoteInsertion(insertion);
    if (!this.initialized && insertion !== "duplicate" && insertion !== "stale") {
      this.renderedEye.set(sample.x, sample.y, sample.z);
      this.renderedYaw = sample.yaw;
      this.renderedPitch = sample.pitch;
      this.airborne = sample.airborne;
      this.climbing = sample.climbing;
      this.initialized = true;
      this.placeRoot();
    }
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.body.setVisible(visible);
    if (!visible) this.footsteps?.reset();
  }

  /** Adds positional steps to this remote seat; never call this on the local body. */
  attachFootsteps(
    footsteps: RemoteInspectorFootsteps,
    surfaceAt: (x: number, y: number, z: number) => string | null,
  ): void {
    this.footsteps = footsteps;
    this.surfaceAt = surfaceAt;
  }

  /**
   * Plays a remote trigger performance once for one authoritative warrant.
   * Relay event batches can be repeated during recovery; their simulation
   * sequence is stable, so it is the idempotency key rather than arrival time.
   */
  fire(authoritativeEventSeq: number): boolean {
    if (authoritativeEventSeq <= this.lastFiredEventSeq) return false;
    this.lastFiredEventSeq = authoritativeEventSeq;
    this.body.fire();
    return true;
  }

  update(dtMs: number): void {
    if (!this.initialized || !this.visible) return;
    const dtSeconds = Math.max(0, dtMs / 1000);
    const frame = this.samples.advance(dtMs);
    if (frame === null) return;
    this.telemetry.recordRemotePresentation(frame.mode);
    const previousY = this.renderedEye.y;
    const wasAirborne = this.airborne;
    const next = frame.sample;
    const dx = next.x - this.renderedEye.x;
    const dz = next.z - this.renderedEye.z;
    if (Math.hypot(dx, next.y - previousY, dz) > TELEPORT_DISTANCE_M) {
      this.velocityX = 0;
      this.velocityZ = 0;
    } else if (dtSeconds > 0) {
      const maxSpeed = WORLD_SCALE.playerHeight * 12;
      const measuredX = dx / dtSeconds;
      const measuredZ = dz / dtSeconds;
      const measuredSpeed = Math.hypot(measuredX, measuredZ);
      const scale = measuredSpeed > maxSpeed ? maxSpeed / measuredSpeed : 1;
      this.velocityX = measuredX * scale;
      this.velocityZ = measuredZ * scale;
    }
    this.speedMps = Math.hypot(this.velocityX, this.velocityZ);
    this.renderedEye.set(next.x, next.y, next.z);
    this.renderedYaw = next.yaw;
    this.renderedPitch = next.pitch;
    this.airborne = next.airborne;
    this.climbing = next.climbing;
    if (wasAirborne && !this.airborne && dtSeconds > 0) {
      this.landingSpeed = Math.max(0, (previousY - next.y) / dtSeconds);
    }
    this.placeRoot();

    this.gun.update(dtMs, {
      eye: this.renderedEye,
      yaw: this.renderedYaw,
      pitch: this.renderedPitch,
      aimAmount: 0,
      swayScale: 1,
      speedMps: this.speedMps,
    });
    this.body.update(dtSeconds, {
      speedMps: this.speedMps,
      speedCapMps: WORLD_SCALE.playerHeight * 4,
      airborne: this.airborne,
      climbing: this.climbing,
      landingSpeed: this.landingSpeed,
      pitch: this.renderedPitch,
      aimAmount: 0,
    });
    this.footsteps?.update(dtMs, {
      position: this.renderedEye,
      speedMps: this.speedMps,
      surfaceId: this.surfaceAt?.(
        this.renderedEye.x,
        this.renderedEye.y - INSPECTOR_EYE_HEIGHT_M,
        this.renderedEye.z,
      ) ?? null,
      visible: this.visible,
    });

    this.landingSpeed = 0;
  }

  dispose(): void {
    this.footsteps?.reset();
    this.gun.dispose();
    this.body.dispose();
    this.root.removeFromParent();
  }

  private placeRoot(): void {
    this.root.position.set(
      this.renderedEye.x,
      this.renderedEye.y - INSPECTOR_EYE_HEIGHT_M,
      this.renderedEye.z,
    );
    this.root.rotation.y = this.renderedYaw;
  }
}
