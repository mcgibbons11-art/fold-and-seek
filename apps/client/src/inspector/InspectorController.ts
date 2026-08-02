import type { MatchSettings } from "@foldseek/shared";

import { CharacterController, type CharacterMoveInput } from "./CharacterController";
import { BRISK_WALK_MULTIPLIER, type NavData } from "./navData";

export {
  createMoveInput,
  MAX_PITCH_RAD,
  type ClimbState,
  type MoveResolution,
} from "./CharacterController";

/** One frame of Inspector intent, which is the shared character intent (§25.1). */
export type InspectorMoveInput = CharacterMoveInput;

/**
 * The hunting Inspector (§8.1, §26.4). Everything about how the body moves lives
 * in `CharacterController`, which a Mimic walks with too, hop included; what
 * makes this one an Inspector is the speed it goes, `inspectorMoveSpeed` with
 * the §8.1 brisk walk on shift. Both roles jump on the same key with the same
 * physics, and for both the climb links are still the only way up onto things.
 */
export class InspectorController extends CharacterController {
  constructor(navData: NavData, settings: MatchSettings) {
    super(
      navData,
      (input) => settings.inspectorMoveSpeed * (input.brisk ? BRISK_WALK_MULTIPLIER : 1),
    );
  }
}
