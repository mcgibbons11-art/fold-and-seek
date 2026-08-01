import { CORRECT_ACCUSATION_COOLDOWN_MS, type MatchCommand } from "@foldseek/game-sim";
import type { MatchSettings } from "@foldseek/shared";

import type { FocusMetadata } from "./FocusSystem";

/**
 * The Inspector's gun. A shot is the accusation: left click fires along the
 * reticle, and a round that lands on an inspectable object sends exactly the
 * `accuse` command the simulation already understands, so warrants, cooldowns,
 * and correct or wrong resolution are unchanged.
 *
 * This replaces the hold-to-confirm of §8.2. The anti-random-click protection
 * of §8.7 survives in a different form: warrants are ammunition, a wrong hit
 * still costs one and still locks the trigger for `wrongAccusationCooldownMs`,
 * and a round that hits nothing costs no warrant but still spends the fire
 * cooldown, so emptying the gun at a shelf remains poor play.
 *
 * Nothing here decides an accusation. The driver chooses when to ask, the
 * authority answers, and `SpatialValidatorImpl` re-checks range and line of
 * sight, so a client cannot shoot through a wall by lying about its reticle.
 */

export type WeaponPhase = "ready" | "cooling" | "pending";

/** What the last round did. Only `hit` sends a command or costs a warrant. */
export type ShotOutcome =
  /** Landed on an inspectable object in range: an accusation was sent. */
  | "hit"
  /** Hit scenery, empty air, or an object the geometry was covering. */
  | "miss"
  /** An inspectable object, but beyond `accusationDistance`. */
  | "out_of_range"
  /** An object the map marks decorative or blocked (§8.3). */
  | "not_shootable"
  /** No warrants left, so the trigger clicks on an empty chamber. */
  | "empty";

/** What the reticle should say about whatever is under it right now. */
export type AimTarget = "none" | "in_range" | "out_of_range" | "not_shootable";

/** Presentation state for the HUD and, later, a weapon viewmodel. */
export interface WeaponState {
  readonly phase: WeaponPhase;
  /** Right mouse held: tighter field of view and settled sway. */
  readonly aiming: boolean;
  /** Warrants remaining, which is the magazine. */
  readonly ammo: number;
  readonly target: AimTarget;
  readonly lastShot: ShotOutcome | null;
  readonly lastShotObjectId: string | null;
  readonly shotsFired: number;
}

export interface ShootingDriverOptions {
  readonly settings: MatchSettings;
  readonly sendCommand: (command: MatchCommand) => void;
  /** Fired once per round, for the muzzle flash, report, and impact effect. */
  readonly onShot?: (outcome: ShotOutcome, targetObjectId: string | null) => void;
  readonly onStateChange?: (state: WeaponState) => void;
  readonly fireCooldownMs?: number;
  readonly pendingTimeoutMs?: number;
}

/**
 * Trigger delay after any round, hit or miss. It is what stops a player from
 * sweeping the room with clicks, now that no confirmation hold does.
 */
export const DEFAULT_FIRE_COOLDOWN_MS = 800;

/**
 * How long a sent accusation waits for an answer before the trigger frees
 * again. A dropped packet must not disarm the Inspector for the round.
 */
export const DEFAULT_PENDING_TIMEOUT_MS = 5_000;

export class ShootingDriver {
  private readonly settings: MatchSettings;
  private readonly sendCommand: (command: MatchCommand) => void;
  private readonly onShot: ((outcome: ShotOutcome, targetObjectId: string | null) => void) | null;
  private readonly onStateChange: ((state: WeaponState) => void) | null;
  private readonly fireCooldownMs: number;
  private readonly pendingTimeoutMs: number;

  private phaseValue: WeaponPhase = "ready";
  private aimingValue = false;
  /** Unknown until the host reports warrants, and an unknown gun is not empty. */
  private ammoValue = Number.POSITIVE_INFINITY;
  private targetValue: AimTarget = "none";
  private lastShotValue: ShotOutcome | null = null;
  private lastShotObjectIdValue: string | null = null;
  private shotsFiredValue = 0;

  private cooldownMs = 0;
  private cooldownTotalMs = 0;
  private pendingMs = 0;
  private published: WeaponState;

  constructor(options: ShootingDriverOptions) {
    this.settings = options.settings;
    this.sendCommand = options.sendCommand;
    this.onShot = options.onShot ?? null;
    this.onStateChange = options.onStateChange ?? null;
    this.fireCooldownMs = options.fireCooldownMs ?? DEFAULT_FIRE_COOLDOWN_MS;
    this.pendingTimeoutMs = options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
    this.published = this.snapshot();
  }

  get state(): WeaponState {
    return this.published;
  }

  get phase(): WeaponPhase {
    return this.phaseValue;
  }

  get cooldownRemainingMs(): number {
    return this.cooldownMs;
  }

  /** 1 immediately after a shot, falling to 0, for a HUD sweep. */
  get cooldownFraction(): number {
    if (this.cooldownTotalMs <= 0) return 0;
    return this.cooldownMs / this.cooldownTotalMs;
  }

  /** Warrants remaining, from the authoritative match state. */
  setAmmo(warrantsRemaining: number): void {
    if (this.ammoValue === warrantsRemaining) return;
    this.ammoValue = warrantsRemaining;
    this.publish();
  }

  /**
   * @param firePressed true only on the frame the trigger was pressed, so the
   *                    gun is semi-automatic and holding the button does not
   *                    keep firing.
   */
  update(
    dtMs: number,
    focus: FocusMetadata | null,
    firePressed: boolean,
    aiming: boolean,
  ): void {
    this.aimingValue = aiming;

    if (this.cooldownMs > 0) {
      this.cooldownMs = Math.max(0, this.cooldownMs - dtMs);
    }
    if (this.phaseValue === "pending") {
      this.pendingMs += dtMs;
      if (this.pendingMs >= this.pendingTimeoutMs) {
        this.pendingMs = 0;
        this.phaseValue = this.cooldownMs > 0 ? "cooling" : "ready";
      }
    } else if (this.phaseValue === "cooling" && this.cooldownMs === 0) {
      this.phaseValue = "ready";
    }

    this.targetValue = this.classify(focus);

    if (firePressed && this.phaseValue === "ready") {
      this.fire(focus);
    }
    this.publish();
  }

  private fire(focus: FocusMetadata | null): void {
    const outcome = this.outcomeFor(focus);
    const targetObjectId = outcome === "hit" && focus !== null ? focus.objectId : null;

    this.shotsFiredValue += 1;
    this.lastShotValue = outcome;
    this.lastShotObjectIdValue = targetObjectId;
    this.cooldownMs = this.fireCooldownMs;
    this.cooldownTotalMs = this.fireCooldownMs;

    if (targetObjectId === null) {
      this.phaseValue = "cooling";
    } else {
      this.phaseValue = "pending";
      this.pendingMs = 0;
      this.sendCommand({ type: "accuse", targetObjectId });
    }
    this.onShot?.(outcome, targetObjectId);
  }

  /**
   * What is under the reticle, by the one rule the shot itself uses. The HUD
   * reads this every frame, so what the reticle promises and what the trigger
   * does can never disagree.
   */
  private classify(focus: FocusMetadata | null): AimTarget {
    if (focus === null || !focus.visible) return "none";
    if (focus.distanceM > this.settings.accusationDistance) return "out_of_range";
    return focus.accusable ? "in_range" : "not_shootable";
  }

  /**
   * A round only becomes an accusation when the reticle was on an inspectable
   * object, the map allows accusing it, the geometry was not in the way, and it
   * was inside `accusationDistance`. Every other case is a dry miss: no command,
   * no warrant, just the fire cooldown.
   */
  private outcomeFor(focus: FocusMetadata | null): ShotOutcome {
    switch (this.classify(focus)) {
      case "none":
        return "miss";
      case "out_of_range":
        return "out_of_range";
      case "not_shootable":
        return "not_shootable";
      case "in_range":
        return this.ammoValue <= 0 ? "empty" : "hit";
    }
  }

  /**
   * Outcome of this client's own shot, taken from the authoritative
   * `accusation_resolved` event. Callers must filter the event by inspector
   * first: another Inspector's mistake is not this Inspector's cooldown.
   */
  handleResolved(correct: boolean): void {
    if (this.phaseValue !== "pending") return;
    this.beginCooldown(
      correct ? CORRECT_ACCUSATION_COOLDOWN_MS : this.settings.wrongAccusationCooldownMs,
    );
  }

  /** A refusal of the accuse command, forwarded from the adapter's onRejection. */
  handleRejection(reason: string): void {
    if (this.phaseValue !== "pending") return;
    if (reason === "accusation_cooldown") {
      this.beginCooldown(this.settings.wrongAccusationCooldownMs);
      return;
    }
    this.pendingMs = 0;
    this.phaseValue = this.cooldownMs > 0 ? "cooling" : "ready";
    this.publish();
  }

  /** Clears the trigger and every cooldown, for a phase change or a reveal. */
  cancel(): void {
    this.cooldownMs = 0;
    this.cooldownTotalMs = 0;
    this.pendingMs = 0;
    this.phaseValue = "ready";
    this.targetValue = "none";
    this.publish();
  }

  private beginCooldown(durationMs: number): void {
    // The trigger delay and the accusation penalty overlap rather than stack:
    // whichever has longer to run is the one the player waits out.
    this.cooldownMs = Math.max(this.cooldownMs, Math.max(0, durationMs));
    this.cooldownTotalMs = Math.max(this.cooldownTotalMs, this.cooldownMs);
    this.pendingMs = 0;
    this.phaseValue = this.cooldownMs > 0 ? "cooling" : "ready";
    this.publish();
  }

  private snapshot(): WeaponState {
    return {
      phase: this.phaseValue,
      aiming: this.aimingValue,
      ammo: this.ammoValue,
      target: this.targetValue,
      lastShot: this.lastShotValue,
      lastShotObjectId: this.lastShotObjectIdValue,
      shotsFired: this.shotsFiredValue,
    };
  }

  /**
   * Republishes only when something a listener could act on changed. The
   * countdown itself is deliberately excluded and read from
   * `cooldownRemainingMs`, so a cooling gun does not allocate a state object
   * every frame.
   */
  private publish(): void {
    const previous = this.published;
    if (
      previous.phase === this.phaseValue &&
      previous.aiming === this.aimingValue &&
      previous.ammo === this.ammoValue &&
      previous.target === this.targetValue &&
      previous.lastShot === this.lastShotValue &&
      previous.lastShotObjectId === this.lastShotObjectIdValue &&
      previous.shotsFired === this.shotsFiredValue
    ) {
      return;
    }
    this.published = this.snapshot();
    this.onStateChange?.(this.published);
  }
}
