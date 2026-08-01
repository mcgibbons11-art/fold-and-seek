import { INNOCENT_REACTION_IDS, type InnocentReactionId } from "./constants";

/**
 * The canonical object registry §36.5 requires. Only an object the map declares
 * or a disguise the simulation itself created can be focused or accused, so a
 * client cannot invent a target and cannot spend a warrant on something that
 * does not exist.
 */

export interface RegisteredObject {
  readonly objectId: string;
  /** Reactions this prop may play when it is wrongly accused (§5.10). */
  readonly innocentReactionIds: readonly InnocentReactionId[];
}

export interface ObjectRegistry {
  readonly mapId: string;
  readonly objects: readonly RegisteredObject[];
}

/**
 * Stand-in registry for tests and for hosts running before a production map
 * exists: one prop for each reaction listed in §5.10.
 */
export const DEFAULT_OBJECT_REGISTRY: ObjectRegistry = {
  mapId: "test_room",
  objects: [
    { objectId: "prop-lamp", innocentReactionIds: ["lamp_turns_on"] },
    { objectId: "prop-clock", innocentReactionIds: ["clock_chimes"] },
    { objectId: "prop-kettle", innocentReactionIds: ["kettle_whistles"] },
    { objectId: "prop-chair", innocentReactionIds: ["chair_squeaks"] },
    { objectId: "prop-vase", innocentReactionIds: ["vase_dust_puff"] },
  ],
};

/** Reactions to draw from for a prop that declares none of its own. */
export function reactionsFor(entry: RegisteredObject | undefined): readonly InnocentReactionId[] {
  if (entry === undefined || entry.innocentReactionIds.length === 0) return INNOCENT_REACTION_IDS;
  return entry.innocentReactionIds;
}
