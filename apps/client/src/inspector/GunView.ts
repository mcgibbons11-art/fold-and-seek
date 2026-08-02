import * as THREE from "three/webgpu";

import type { ShotOutcome } from "./ShootingDriver";
import { WORLD_SCALE, type Vec3Like } from "./navData";

/**
 * The warrant gun the Inspector carries (override 1), and everything a round
 * leaving it does to the room.
 *
 * `ShootingDriver` decides what a trigger pull means; this decides what it
 * looks like. Nothing here can change an outcome: it is told what happened and
 * shows it, so a player who turns the effects off would still hit and miss the
 * same things.
 *
 * The rig is over the shoulder rather than at the eye (`InspectorCamera`), so
 * the gun is not a screen-space viewmodel pinned to the camera. It is a world
 * prop held where the Inspector's right hand is, built from the eye and the
 * look direction: the boom pulling in against a wall therefore brings the
 * camera closer to the gun instead of dragging the gun through the wall.
 *
 * No light is added for the muzzle flash. Adding and removing a light changes
 * the lighting configuration every material in the shop was linked against,
 * and on this project's ANGLE path a relink costs about a second per program
 * (see `SHOP_PRECOMPILE_DEADLINE_MS`). The flash is bright additive geometry
 * instead, which the pipeline's bloom spreads into the room for free.
 */

/** Body height is the one scale knob (override 4); every number below derives from it. */
const BODY_M = WORLD_SCALE.playerHeight;

/**
 * Barrel-to-butt length. A real pistol on a 0.35 m body would be four
 * centimetres, which at the boom distance is a speck; this is hero scale, sized
 * so the gun reads as held at a glance, like the oversized tools in the
 * reference diorama art.
 */
const GUN_LENGTH_M = BODY_M * 0.52;

/** Where the hand carries it, in the look basis: right of, below, and ahead of the eye. */
const HIP_RIGHT_M = BODY_M * 0.46;
const HIP_DOWN_M = BODY_M * 0.34;
const HIP_FORWARD_M = BODY_M * 0.34;
/**
 * Aiming brings the gun up and forward without putting it over the target. The
 * rig watches from behind the shoulder, so a gun on the sight line would sit on
 * top of the thing the player is trying to read; it settles below and right of
 * the reticle instead, where a shoulder-cam player expects to find it.
 */
const AIM_RIGHT_M = BODY_M * 0.3;
const AIM_DOWN_M = BODY_M * 0.26;
const AIM_FORWARD_M = BODY_M * 0.52;
/** Cant at the hip, levelled as the gun comes up. */
const HIP_ROLL_RAD = 0.28;
/**
 * Toe-in, so the gun is turned across the frame rather than pointing straight
 * away from the camera. End-on it is a stub; a few degrees inward shows the
 * drum and the length of the barrel, and it converges on the reticle the way a
 * hand holding a gun off to one side actually would.
 */
const HIP_TOE_IN_RAD = 0.22;
const AIM_TOE_IN_RAD = 0.11;

/** Walk sway, in the same currency as the camera's bob so the two agree. */
const SWAY_YAW_RAD = 0.05;
const SWAY_PITCH_RAD = 0.035;
const SWAY_RATE_RAD_PER_M = 4.2;
/** Idle drift, so a standing Inspector is not holding a photograph. */
const IDLE_SWAY_RAD = 0.012;
const IDLE_RATE_RAD_PER_S = 1.1;

/** Recoil: a critically damped kick backwards and upwards, over in a fifth of a second. */
const RECOIL_SECONDS = 0.14;
const RECOIL_OMEGA = 1 / RECOIL_SECONDS;
const RECOIL_BACK_M = GUN_LENGTH_M * 0.34;
const RECOIL_PITCH_RAD = 0.42;
const RECOIL_IMPULSE = RECOIL_OMEGA * Math.E;
/** A hammer falling on an empty chamber jolts the wrist and nothing else. */
const DRY_RECOIL_SCALE = 0.16;
const RECOIL_SETTLE = 1e-3;

/**
 * Widest a mark at the target may be drawn, as a share of how far away it is,
 * which is what fixes how much of the screen it can cover. At a twentieth it
 * subtends about five degrees: a puff on the surface it hit, whether that
 * surface is the far wall of the shop or the door frame the Inspector is
 * standing in. Sized in metres alone it was the second of these that broke it,
 * covering a fifth of the frame in pale fog.
 */
const MARK_MAX_ANGULAR_SHARE = 0.045;

/** Chambers the drum will draw. Past this the HUD's magazine is the count of record. */
const MAX_VISIBLE_CHAMBERS = 8;

/**
 * Effect lifetimes, in milliseconds. The flash outlives a single frame at any
 * frame rate the game runs at, which is what makes it a flash rather than a
 * dropped frame; §5.13 forbids strobing, so it never repeats.
 */
const FLASH_MS = 120;
const TRACER_MS = 120;
const IMPACT_MS = 420;
const SMOKE_MS = 900;
const VERDICT_MS = 620;

/** The unseeable pair of effects that links their shader before a shot needs it. */
const PRIMER_MS = 200;
const PRIMER_OPACITY = 0.001;

/** Where a shot that found nothing at all is drawn to, when no wall stops it first. */
export const MISS_RANGE_M = BODY_M * 24;

/**
 * The gun's own palette, lifted off the shop's brass and walnut swatches and
 * then lightened.
 *
 * A prop that is on screen for the whole hunt cannot be allowed to go black
 * when the Inspector walks into an unlit corner, and the shop has a great many
 * unlit corners. So the metal is less metallic than the shelf fittings, which
 * keeps it lit by the room rather than by reflections of it, and every part
 * carries a small warm emissive floor: enough to hold the silhouette in the
 * dark, far too little to light anything else.
 */
const BRASS_COLOR = 0xd6a24a;
/** The warm floor every part of the gun keeps when the room gives it nothing. */
const SELF_LIT_COLOR = 0x2a1a0a;
const SELF_LIT_INTENSITY = 0.9;
const BRASS_LIT_COLOR = 0xffbe6b;
const WALNUT_COLOR = 0x6b4226;
const IRON_COLOR = 0x3b3733;
/** A catch: warm brass. An innocent object: the HUD's alarm red. A dud: cold smoke. */
const CATCH_COLOR = 0xffc978;
const INNOCENT_COLOR = 0xd8563c;
const DUD_COLOR = 0xb8ae9e;
const SMOKE_COLOR = 0x9a9186;

/** What the world sees of one round, from the muzzle outward. */
interface Effect {
  readonly mesh: THREE.Mesh;
  /** Its own material: two effects alight at once must fade independently. */
  readonly material: THREE.MeshBasicMaterial;
  readonly durationMs: number;
  readonly peakOpacity: number;
  /** Final scale, reached over the lifetime. Equal to the start for a flash. */
  readonly fromScale: THREE.Vector3;
  readonly toScale: THREE.Vector3;
  /** Metres the effect drifts upward over its life, for smoke. */
  readonly riseM: number;
  readonly baseY: number;
  elapsedMs: number;
}

/** Everything the gun needs to know about the frame it is being held in. */
export interface GunFrame {
  /** The Inspector's eye, which is where the arm comes from. */
  readonly eye: Vec3Like;
  readonly yaw: number;
  readonly pitch: number;
  /** `InspectorCamera.aimAmount`: 0 carried at the hip, 1 up on the sights. */
  readonly aimAmount: number;
  /** `InspectorCamera.swayScale`: how much of the walk survives the aim blend. */
  readonly swayScale: number;
  readonly speedMps: number;
}

export class GunView {
  /** The gun itself, moved every frame. Effects live in the scene, not on it. */
  private readonly root = new THREE.Group();
  private readonly effectRoot = new THREE.Group();
  private readonly scene: THREE.Object3D;

  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly effects: Effect[] = [];

  private readonly muzzle = new THREE.Object3D();
  private readonly hammer = new THREE.Group();
  private readonly sealMaterial: THREE.MeshBasicMaterial;
  private readonly brass: THREE.MeshStandardMaterial;
  private readonly iron: THREE.MeshStandardMaterial;
  /** One brass shell per drawn chamber. Hiding one reveals the empty hole behind it. */
  private readonly shells: THREE.Mesh[] = [];
  /** The drum's chambers, shells and holes together, cleared when the count changes. */
  private readonly chamberParts: THREE.Mesh[] = [];

  private readonly sharedSphere: THREE.SphereGeometry;
  private readonly sharedCylinder: THREE.CylinderGeometry;
  private readonly scratch = new THREE.Vector3();
  private readonly scratchTo = new THREE.Vector3();
  /** The colour the seal cools back to, kept rather than rebuilt every frame. */
  private readonly coolColor = new THREE.Color(BRASS_LIT_COLOR);

  private recoil = 0;
  private recoilVelocity = 0;
  private swayPhase = 0;
  private idlePhase = 0;
  /** Cocked with the aim and dropped by the shot, which is the whole hammer. */
  private hammerCock = 0;
  private hammerSnap = 0;
  private warrantsTotal = 0;
  private warrantsRemaining = 0;
  /** Where the round in the air landed, so the verdict flares in the same place. */
  private pendingImpact: THREE.Vector3 | null = null;
  private sealHeatMs = 0;
  private sealHeatColor = BRASS_LIT_COLOR;

  constructor(scene: THREE.Object3D) {
    this.scene = scene;
    this.root.name = "inspector-gun";
    this.effectRoot.name = "inspector-gun-effects";
    this.root.rotation.order = "YXZ";

    this.sharedSphere = this.keep(new THREE.SphereGeometry(1, 10, 8));
    this.sharedCylinder = this.keep(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true));

    this.brass = this.own(
      new THREE.MeshStandardMaterial({
        color: BRASS_COLOR,
        roughness: 0.32,
        metalness: 0.5,
        emissive: SELF_LIT_COLOR,
        emissiveIntensity: SELF_LIT_INTENSITY,
      }),
    );
    this.iron = this.own(
      new THREE.MeshStandardMaterial({
        color: IRON_COLOR,
        roughness: 0.5,
        metalness: 0.5,
        emissive: SELF_LIT_COLOR,
        emissiveIntensity: SELF_LIT_INTENSITY * 0.4,
      }),
    );
    const walnut = this.own(
      new THREE.MeshStandardMaterial({
        color: WALNUT_COLOR,
        roughness: 0.52,
        metalness: 0,
        emissive: SELF_LIT_COLOR,
        emissiveIntensity: SELF_LIT_INTENSITY * 0.6,
      }),
    );
    this.sealMaterial = this.own(new THREE.MeshBasicMaterial({ color: BRASS_LIT_COLOR }));

    this.build(walnut);
    this.scene.add(this.root);
    this.scene.add(this.effectRoot);

    // One of each effect, at a brightness nobody can see, so the programs they
    // need are linked while the Inspector is still walking in. Without this the
    // first trigger pull of the round is what compiles them, and on the ANGLE
    // path a link is measured in seconds, not milliseconds.
    this.spawn(this.sharedSphere, BRASS_LIT_COLOR, this.scratch.set(0, 0, 0), PRIMER_MS, PRIMER_OPACITY);
    this.spawn(this.sharedCylinder, BRASS_LIT_COLOR, this.scratch.set(0, 0, 0), PRIMER_MS, PRIMER_OPACITY);
  }

  /**
   * The pistol, in a local frame whose -Z is the way it points and whose origin
   * is the grip: a walnut butt under a brass frame, an octagonal barrel over a
   * revolving drum of warrant rounds, and a blackened hammer at the back. The
   * seal on the butt is the shop's own brass, and it is the one part that
   * lights up, because it is what a warrant is stamped with.
   */
  private build(walnut: THREE.MeshStandardMaterial): void {
    const L = GUN_LENGTH_M;
    const brass = this.brass;
    const iron = this.iron;

    const grip = new THREE.Mesh(this.keep(new THREE.BoxGeometry(L * 0.17, L * 0.44, L * 0.24)), walnut);
    grip.position.set(0, -L * 0.24, L * 0.1);
    grip.rotation.x = -0.32;
    this.root.add(grip);

    const frame = new THREE.Mesh(this.keep(new THREE.BoxGeometry(L * 0.16, L * 0.22, L * 0.42)), brass);
    frame.position.set(0, -L * 0.02, L * 0.02);
    this.root.add(frame);

    const barrel = new THREE.Mesh(this.keep(new THREE.CylinderGeometry(L * 0.075, L * 0.07, L * 0.56, 8)), brass);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, L * 0.02, -L * 0.38);
    this.root.add(barrel);

    const drum = new THREE.Mesh(this.keep(new THREE.CylinderGeometry(L * 0.14, L * 0.14, L * 0.2, 12)), brass);
    drum.rotation.x = Math.PI / 2;
    drum.position.set(0, L * 0.01, -L * 0.06);
    this.root.add(drum);

    const guard = new THREE.Mesh(this.keep(new THREE.TorusGeometry(L * 0.11, L * 0.02, 6, 12, Math.PI)), brass);
    guard.rotation.set(Math.PI / 2, 0, Math.PI);
    guard.position.set(0, -L * 0.14, L * 0.06);
    this.root.add(guard);

    const trigger = new THREE.Mesh(this.keep(new THREE.BoxGeometry(L * 0.03, L * 0.1, L * 0.03)), iron);
    trigger.position.set(0, -L * 0.11, L * 0.05);
    this.root.add(trigger);

    // The hammer is its own group so cocking rotates it about the pin rather
    // than about the gun.
    this.hammer.position.set(0, L * 0.06, L * 0.16);
    const spur = new THREE.Mesh(this.keep(new THREE.BoxGeometry(L * 0.05, L * 0.14, L * 0.05)), iron);
    spur.position.set(0, L * 0.06, 0);
    this.hammer.add(spur);
    this.root.add(this.hammer);

    const foresight = new THREE.Mesh(this.keep(new THREE.BoxGeometry(L * 0.02, L * 0.06, L * 0.04)), brass);
    foresight.position.set(0, L * 0.1, -L * 0.62);
    this.root.add(foresight);

    const seal = new THREE.Mesh(this.keep(new THREE.CylinderGeometry(L * 0.07, L * 0.07, L * 0.02, 10)), this.sealMaterial);
    seal.rotation.z = Math.PI / 2;
    seal.position.set(L * 0.09, -L * 0.24, L * 0.12);
    this.root.add(seal);

    this.muzzle.position.set(0, L * 0.02, -L * 0.68);
    this.root.add(this.muzzle);
  }

  /**
   * Rebuilds the drum's chambers for a magazine of this size. The count is the
   * warrant total, which the authority sets from the number of Mimics, so it is
   * known once a round starts and does not change inside one.
   */
  private buildChambers(count: number): void {
    for (const part of this.chamberParts) part.removeFromParent();
    this.chamberParts.length = 0;
    this.shells.length = 0;
    if (count <= 0) return;

    const L = GUN_LENGTH_M;
    // The shell wears the frame's brass and the hole behind it wears the
    // hammer's iron, so a spent chamber introduces no new material and
    // therefore no new shader program: hiding the shell is the whole
    // animation, and on this project's ANGLE path that matters (see the note
    // on the muzzle flash above).
    const shellGeometry = this.keep(new THREE.CylinderGeometry(L * 0.035, L * 0.035, L * 0.17, 6));
    const holeGeometry = this.keep(new THREE.CylinderGeometry(L * 0.04, L * 0.04, L * 0.14, 6));

    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      const x = Math.cos(angle) * L * 0.09;
      const y = L * 0.01 + Math.sin(angle) * L * 0.09;

      const hole = new THREE.Mesh(holeGeometry, this.iron);
      hole.rotation.x = Math.PI / 2;
      hole.position.set(x, y, -L * 0.06);
      this.root.add(hole);
      this.chamberParts.push(hole);

      const shell = new THREE.Mesh(shellGeometry, this.brass);
      shell.rotation.x = Math.PI / 2;
      shell.position.set(x, y, -L * 0.055);
      this.root.add(shell);
      this.chamberParts.push(shell);
      this.shells.push(shell);
    }
  }

  /**
   * Warrants remaining, drawn as the rounds still in the drum. Above
   * `MAX_VISIBLE_CHAMBERS` the drum stops growing and the HUD's magazine is the
   * count of record; a drum of twelve would be a ring of specks.
   */
  setWarrants(remaining: number, total: number): void {
    const drawn = Math.min(Math.max(total, 0), MAX_VISIBLE_CHAMBERS);
    if (drawn !== this.warrantsTotal) {
      this.warrantsTotal = drawn;
      this.buildChambers(drawn);
    }
    this.warrantsRemaining = Math.max(0, Math.min(remaining, drawn));
    for (let index = 0; index < this.shells.length; index += 1) {
      const shell = this.shells[index];
      if (shell !== undefined) shell.visible = index < this.warrantsRemaining;
    }
  }

  /** Chambers still loaded, which is what a test without a renderer can count. */
  get liveChambers(): number {
    return this.shells.filter((shell) => shell.visible).length;
  }

  /** Effects still playing. */
  get effectCount(): number {
    return this.effects.length;
  }

  /**
   * One round leaves the gun. Everything but an empty chamber throws a flash, a
   * kick and a line to wherever it landed; an empty chamber is the hammer and
   * nothing else, because there was no round in it to go anywhere.
   */
  fire(outcome: ShotOutcome, impact: Vec3Like | null): void {
    this.hammerSnap = 1;
    if (outcome === "empty") {
      this.recoilVelocity += RECOIL_IMPULSE * DRY_RECOIL_SCALE;
      return;
    }
    this.recoilVelocity += RECOIL_IMPULSE;

    this.root.updateMatrixWorld(true);
    const from = this.muzzle.getWorldPosition(this.scratch).clone();
    const to = impact === null ? from : this.scratchTo.set(impact.x, impact.y, impact.z).clone();
    this.pendingImpact = outcome === "hit" ? to : null;

    this.flash(from);
    this.smoke(from);
    if (impact !== null) {
      this.tracer(from, to);
      // A shot that reached an object it may not accuse, or one that only found
      // scenery, still marks where it landed. The mark is cold rather than
      // brass: nothing about it says a person was found there.
      this.burst(to, outcome === "hit" ? CATCH_COLOR : DUD_COLOR, IMPACT_MS, this.markRadius(to));
    }
  }

  /**
   * How big a mark at this distance may be drawn.
   *
   * A puff sized only in metres is a puff sized only for one range: fired at a
   * wall an arm's length away — which is most of what a shot in the Security
   * Office hits — a mark as wide as the gun covers a third of the screen and
   * reads as fog. Capping it against the distance it is being viewed from holds
   * its angular size down wherever it lands.
   */
  private markRadius(at: THREE.Vector3): number {
    const distance = at.distanceTo(this.root.position);
    return Math.min(GUN_LENGTH_M * 0.5, distance * MARK_MAX_ANGULAR_SHARE);
  }

  /**
   * The authority's verdict on the round already in the air. A catch flares
   * brass where it landed and heats the seal; a wrong warrant answers in alarm
   * red, over the innocent object's own protest from `ReactionTheatre`.
   */
  resolve(correct: boolean): void {
    this.sealHeatMs = VERDICT_MS;
    this.sealHeatColor = correct ? CATCH_COLOR : INNOCENT_COLOR;
    const impact = this.pendingImpact;
    this.pendingImpact = null;
    if (impact === null) return;
    this.burst(
      impact,
      correct ? CATCH_COLOR : INNOCENT_COLOR,
      VERDICT_MS,
      this.markRadius(impact) * (correct ? 3.2 : 2.2),
    );
  }

  /** Places, sways and recoils the gun, and ages every effect in the air. */
  update(dtMs: number, frame: GunFrame): void {
    const dtSeconds = Math.max(dtMs, 0) / 1000;
    this.stepEffects(dtMs);
    this.stepSeal(dtMs);
    this.stepRecoil(dtSeconds);
    this.swayPhase += frame.speedMps * dtSeconds * SWAY_RATE_RAD_PER_M;
    this.idlePhase += dtSeconds * IDLE_RATE_RAD_PER_S;
    this.hammerSnap = Math.max(0, this.hammerSnap - dtSeconds / RECOIL_SECONDS);
    this.hammerCock += (frame.aimAmount - this.hammerCock) * Math.min(1, dtSeconds * 9);

    const aim = Math.min(1, Math.max(0, frame.aimAmount));
    const sway = frame.swayScale;
    const swayYaw =
      Math.sin(this.swayPhase) * SWAY_YAW_RAD * sway + Math.sin(this.idlePhase) * IDLE_SWAY_RAD;
    const swayPitch =
      Math.cos(this.swayPhase * 2) * SWAY_PITCH_RAD * sway +
      Math.sin(this.idlePhase * 0.7) * IDLE_SWAY_RAD;

    // The hand first, in the look basis, so the carry is where the arm is
    // whatever the gun is doing; then the wrist, which is the toe-in and the
    // kick, and turns the gun about the grip rather than swinging the arm.
    this.root.position.set(frame.eye.x, frame.eye.y, frame.eye.z);
    this.root.rotation.set(frame.pitch + swayPitch, frame.yaw + swayYaw, 0);
    this.root.translateX(HIP_RIGHT_M + (AIM_RIGHT_M - HIP_RIGHT_M) * aim);
    this.root.translateY(-(HIP_DOWN_M + (AIM_DOWN_M - HIP_DOWN_M) * aim));
    this.root.translateZ(-(HIP_FORWARD_M + (AIM_FORWARD_M - HIP_FORWARD_M) * aim) + this.recoil * RECOIL_BACK_M);
    this.root.rotation.x += this.recoil * RECOIL_PITCH_RAD;
    this.root.rotation.y += HIP_TOE_IN_RAD + (AIM_TOE_IN_RAD - HIP_TOE_IN_RAD) * aim;
    this.root.rotation.z = HIP_ROLL_RAD * (1 - aim);

    // Cocked as the gun comes up, thrown forward by the shot.
    this.hammer.rotation.x = -0.9 * this.hammerCock + 1.1 * this.hammerSnap;
  }

  /**
   * The kick, as an impulse into a critically damped spring, the same shape the
   * camera's landing dip uses. One number drives the slide back and the muzzle
   * climb, so they recover together instead of drifting apart.
   */
  private stepRecoil(dtSeconds: number): void {
    if (dtSeconds <= 0) return;
    const f = 1 + 2 * dtSeconds * RECOIL_OMEGA;
    const hoo = dtSeconds * RECOIL_OMEGA * RECOIL_OMEGA;
    const detInv = 1 / (f + dtSeconds * hoo);
    const previous = this.recoil;
    this.recoil = (f * previous + dtSeconds * this.recoilVelocity) * detInv;
    this.recoilVelocity = (this.recoilVelocity - hoo * previous) * detInv;
    if (Math.abs(this.recoil) < RECOIL_SETTLE && Math.abs(this.recoilVelocity) < RECOIL_SETTLE) {
      this.recoil = 0;
      this.recoilVelocity = 0;
    }
  }

  /** The seal cools back to brass after a verdict has passed through it. */
  private stepSeal(dtMs: number): void {
    if (this.sealHeatMs <= 0) return;
    this.sealHeatMs = Math.max(0, this.sealHeatMs - dtMs);
    const heat = this.sealHeatMs / VERDICT_MS;
    this.sealMaterial.color.set(this.sealHeatColor).lerp(this.coolColor, 1 - heat);
  }

  private flash(at: THREE.Vector3): void {
    const flash = this.spawn(this.sharedSphere, BRASS_LIT_COLOR, at, FLASH_MS, 0.95);
    flash.fromScale.set(GUN_LENGTH_M * 0.1, GUN_LENGTH_M * 0.1, GUN_LENGTH_M * 0.34);
    flash.toScale.set(GUN_LENGTH_M * 0.22, GUN_LENGTH_M * 0.22, GUN_LENGTH_M * 0.5);
    // A flash points where the barrel does, so it is stretched along the shot
    // rather than being a ball hanging off the front of the gun.
    flash.mesh.quaternion.copy(this.root.quaternion);
  }

  /**
   * The smoke the shot leaves. It is deliberately small: it hangs about a
   * third of a metre from the camera, where a puff the size of the gun fills a
   * third of the screen and reads as fog rather than as a gunshot.
   */
  private smoke(at: THREE.Vector3): void {
    const smoke = this.spawn(this.sharedSphere, SMOKE_COLOR, at, SMOKE_MS, 0.1);
    smoke.fromScale.setScalar(GUN_LENGTH_M * 0.06);
    smoke.toScale.setScalar(GUN_LENGTH_M * 0.24);
  }

  private burst(at: THREE.Vector3, color: number, durationMs: number, radiusM: number): void {
    const burst = this.spawn(this.sharedSphere, color, at, durationMs, 0.32);
    burst.fromScale.setScalar(radiusM * 0.15);
    burst.toScale.setScalar(radiusM);
  }

  /** The round's path, drawn for as long as an eye keeps it. */
  private tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const middle = from.clone().add(to).multiplyScalar(0.5);
    const tracer = this.spawn(this.sharedCylinder, BRASS_LIT_COLOR, middle, TRACER_MS, 0.75);
    const length = from.distanceTo(to);
    const radius = GUN_LENGTH_M * 0.018;
    tracer.fromScale.set(radius, length, radius);
    tracer.toScale.set(radius * 0.2, length, radius * 0.2);
    tracer.mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      to.clone().sub(from).normalize(),
    );
  }

  private spawn(
    geometry: THREE.BufferGeometry,
    color: number,
    at: THREE.Vector3,
    durationMs: number,
    peakOpacity: number,
  ): Effect {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: peakOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(at);
    // Never culled: an effect is small and short-lived, so the test costs more
    // than it saves, and the primer pair above has to be submitted wherever the
    // camera happens to be pointing for it to link anything.
    mesh.frustumCulled = false;
    this.effectRoot.add(mesh);

    const effect: Effect = {
      mesh,
      material,
      durationMs,
      peakOpacity,
      fromScale: new THREE.Vector3(1, 1, 1),
      toScale: new THREE.Vector3(1, 1, 1),
      riseM: geometry === this.sharedCylinder ? 0 : GUN_LENGTH_M * 0.3,
      baseY: at.y,
      elapsedMs: 0,
    };
    this.effects.push(effect);
    return effect;
  }

  private stepEffects(dtMs: number): void {
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index];
      if (effect === undefined) continue;
      effect.elapsedMs += dtMs;
      const t = effect.elapsedMs / effect.durationMs;
      if (t >= 1) {
        this.effects.splice(index, 1);
        effect.mesh.removeFromParent();
        effect.material.dispose();
        continue;
      }
      // Out fast and settling: the round is over before the smoke it left is.
      const eased = Math.sqrt(t);
      effect.mesh.scale.lerpVectors(effect.fromScale, effect.toScale, eased);
      effect.mesh.position.y = effect.baseY + effect.riseM * t * t;
      effect.material.opacity = effect.peakOpacity * (1 - t) * (1 - t);
    }
  }

  private keep<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry);
    return geometry;
  }

  private own<T extends THREE.Material>(material: T): T {
    this.materials.push(material);
    return material;
  }

  dispose(): void {
    for (const effect of this.effects) {
      effect.mesh.removeFromParent();
      effect.material.dispose();
    }
    this.effects.length = 0;
    this.root.removeFromParent();
    this.effectRoot.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
  }
}

/**
 * Where a round that left the muzzle stopped.
 *
 * A shot with something under the reticle stops at that object, at the distance
 * the focus system already measured from the eye. A shot at nothing carries on
 * until a wall takes it, and failing that runs out at `MISS_RANGE_M`, so a
 * round fired across the shop still puts a mark somewhere a player can see.
 */
export function shotImpactPoint(
  eye: Vec3Like,
  forward: Vec3Like,
  focusDistanceM: number | null,
  wallDistanceM: number,
): THREE.Vector3 {
  const distance =
    focusDistanceM ?? (wallDistanceM >= 0 ? wallDistanceM : MISS_RANGE_M);
  return new THREE.Vector3(
    eye.x + forward.x * distance,
    eye.y + forward.y * distance,
    eye.z + forward.z * distance,
  );
}
