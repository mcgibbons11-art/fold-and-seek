import { z } from "zod";
import {
  DEFAULT_MATCH_SETTINGS,
  DISGUISE_WIRE_VERSION,
  INNOCENT_REACTION_IDS,
  MAX_PANELS,
  MAX_SEEKER_COUNT,
  MAX_OUTLINE_POINTS,
  MAX_SHAPES,
  PANEL_MAX_HINGE_DEG,
  PANEL_MIN_HINGE_DEG,
  PANEL_PROFILE_IDS,
  PANEL_SOCKET_NAMES,
  RESULT_VOTE_CATEGORIES,
  RIG_BONE_NAMES,
  RIG_CONTRACT_VERSION,
  RIG_SEGMENT_BONES,
  SEGMENT_PROFILE_IDS,
  SHAPE_PROFILE_IDS,
  STARTER_ARRANGEMENT_IDS,
  TAUNT_IDS,
} from "./config";
import {
  decodePaintLayer,
  MAX_PAINT_STROKES,
  PAINT_TARGET_IDS,
  PAINT_WIRE_MAX_BASE64_LENGTH,
  PAINT_WIRE_VERSION,
} from "./paintWire";
import { MatchPhase } from "./phases";

/**
 * Validation for every payload that crosses the network, on both the dedicated
 * server and the host-elected Portals client. Nothing here is left as an
 * unvalidated blob: each Forge command carries a kind-specific payload, and all
 * numeric fields are finite and bounded. Zod 4 rejects NaN and Infinity for
 * z.number() by default, so range bounds are the only extra work.
 */

export const LIMITS = {
  idLength: 64,
  displayNameLength: 32,
  /** Encoded disguise pose, kept under the 8 KB Portals broadcast ceiling. */
  encodedPoseLength: 6_144,
  /**
   * Encoded paint layer. Derived from the paint wire's own ceiling rather than
   * written out, so raising MAX_PAINT_STROKES cannot leave this stale.
   */
  encodedPaintLength: PAINT_WIRE_MAX_BASE64_LENGTH,
  maxRevision: 1_000_000_000,
  /** Authoring-space coordinate limit; map bounds clamp further at quantization. */
  worldCoordinate: 4_096,
  maxTimestamp: 8_640_000_000_000,
  maxSegmentLength: 8,
  maxSegmentThickness: 4,
  maxCount: 4_096,
  maxChangedKeys: 64,
  maxPlayersPerMatch: 64,
  maxAnchors: 16,
  maxMaterialAssignments: 64,
} as const;

const timestamp = z.number().min(0).max(LIMITS.maxTimestamp);
const count = z.number().int().min(0).max(LIMITS.maxCount);
const id = z.string().min(1).max(LIMITS.idLength);
const displayName = z.string().min(1).max(LIMITS.displayNameLength);
const encodedPose = z.string().max(LIMITS.encodedPoseLength);
const revision = z.number().int().min(0).max(LIMITS.maxRevision);
const unitScalar = z.number().min(0).max(1);
const signedUnitScalar = z.number().min(-1).max(1);
const angle = z.number().min(-Math.PI, "angle below -pi").max(Math.PI, "angle above pi");
const coordinate = z.number().min(-LIMITS.worldCoordinate).max(LIMITS.worldCoordinate);

export const Vec3Schema = z.tuple([coordinate, coordinate, coordinate]);

/** Largest deviation from unit length tolerated in a wire quaternion (§7.16). */
export const QUATERNION_UNIT_TOLERANCE = 1e-3;

/**
 * Unit quaternion in x, y, z, w order. A rotation that is not normalized is a
 * scale in disguise, so anything off the unit sphere is rejected (§7.16, §29.4).
 */
export const QuaternionSchema = z
  .tuple([signedUnitScalar, signedUnitScalar, signedUnitScalar, signedUnitScalar])
  .refine(
    ([x, y, z_, w]) => Math.abs(Math.hypot(x, y, z_, w) - 1) <= QUATERNION_UNIT_TOLERANCE,
    { message: "quaternion is not normalized" },
  );

export const DirectionSchema = z
  .tuple([signedUnitScalar, signedUnitScalar, signedUnitScalar])
  .refine(([x, y, z_]) => Math.hypot(x, y, z_) > 1e-6, { message: "direction has zero length" });

export const PlayerRoleSchema = z.enum(["mimic", "inspector", "spectator"]);
export const PlayerLifeStateSchema = z.enum(["active", "caught", "spectating"]);
export const MatchPhaseSchema = z.enum(MatchPhase);
export const ResultVoteCategorySchema = z.enum(RESULT_VOTE_CATEGORIES);
export const InnocentReactionIdSchema = z.enum(INNOCENT_REACTION_IDS);
export const TauntIdSchema = z.enum(TAUNT_IDS);
export const MatchWinnerSchema = z.enum(["inspectors", "mimics"]);

// ------------------------------------------------------------- Forge commands

const forgeEnvelope = {
  revision,
  commandId: z.string().min(8).max(LIMITS.idLength),
};

export const ForgeCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...forgeEnvelope,
    kind: z.literal("set_ik_target"),
    payload: z.strictObject({
      handleId: id,
      position: Vec3Schema,
      enabled: z.boolean(),
    }),
  }),
  z.strictObject({
    ...forgeEnvelope,
    kind: z.literal("set_joint_rotation"),
    payload: z.strictObject({
      jointId: id,
      rotation: QuaternionSchema,
    }),
  }),
  z.strictObject({
    ...forgeEnvelope,
    kind: z.literal("set_segment_form"),
    payload: z.strictObject({
      segmentId: id,
      length: z.number().min(0).max(LIMITS.maxSegmentLength),
      thickness: z.number().min(0).max(LIMITS.maxSegmentThickness),
      flatten: unitScalar,
      taper: unitScalar,
      profile: unitScalar,
    }),
  }),
  z.strictObject({
    ...forgeEnvelope,
    kind: z.literal("set_panel_state"),
    payload: z.strictObject({
      panelId: id,
      deployed: z.boolean(),
      hinge: angle,
    }),
  }),
  z.strictObject({
    ...forgeEnvelope,
    kind: z.literal("set_anchor"),
    payload: z.strictObject({
      anchorId: id,
      surfaceId: id,
      position: Vec3Schema,
      normal: DirectionSchema,
    }),
  }),
  z.strictObject({
    ...forgeEnvelope,
    kind: z.literal("remove_anchor"),
    payload: z.strictObject({ anchorId: id }),
  }),
  z.strictObject({
    ...forgeEnvelope,
    kind: z.literal("assign_material"),
    payload: z.strictObject({
      targetId: id,
      swatchId: id,
      tint: unitScalar,
    }),
  }),
  z.strictObject({
    ...forgeEnvelope,
    kind: z.literal("set_root"),
    payload: z.strictObject({
      position: Vec3Schema,
      rotation: QuaternionSchema,
    }),
  }),
]);

export type ForgeCommand = z.infer<typeof ForgeCommandSchema>;
export type ForgeCommandKind = ForgeCommand["kind"];

export const ForgeSnapshotSchema = z.strictObject({
  revision,
  encodedPose,
});

/**
 * Where an Inspector is looking from, reported to whichever machine is holding
 * authority.
 *
 * The authority checks range and line of sight from an eye position and refuses
 * `inspector_position_unknown` for a player it has never been told about. On
 * the loopback the Inspector *is* the authority, so writing the eye into the
 * local spatial bridge is enough; on both networked transports the Inspector is
 * usually somewhere else, and without this report every shot that client fires
 * is refused.
 *
 * It is a client-reported position, which is the authority model Portals gives
 * us (docs/PORTALS_CONSTRAINTS.md) and which the dedicated server matches so the
 * two transports refuse and allow the same shots. The authority still decides
 * what may be shot from it.
 *
 * Null when the sender stops being an Inspector, so the authority forgets an eye
 * rather than keeping the last one it heard.
 */
export const InspectorEyeSchema = z.strictObject({
  eye: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).nullable(),
});

export type InspectorEyeReport = z.infer<typeof InspectorEyeSchema>;

/**
 * Inbound eye reports allowed per sender per second. A client sends at most one
 * per publication flush, so the honest rate is well under this; the allowance
 * sits above it so ordinary timer jitter does not cost an Inspector their
 * position.
 */
export const MAX_EYE_REPORTS_PER_SECOND = 15;

/**
 * How far the eye must travel before it is worth another message. An Inspector
 * standing still would otherwise spend half their send allowance restating where
 * they already are. Well under the shot tolerances the authority applies.
 */
export const EYE_REPORT_EPSILON_M = 0.01;

/** True when a fresh eye is close enough to the last reported one to say nothing. */
export function eyesAgree(
  left: readonly [number, number, number] | null,
  right: readonly [number, number, number] | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    Math.abs(left[0] - right[0]) < EYE_REPORT_EPSILON_M &&
    Math.abs(left[1] - right[1]) < EYE_REPORT_EPSILON_M &&
    Math.abs(left[2] - right[2]) < EYE_REPORT_EPSILON_M
  );
}

// ----------------------------------------------------- canonical disguise wire

/**
 * Canonical wire form of a disguise pose (§7.16). The authoring model in
 * apps/client/src/mimic/disguiseState.ts is the producer and this schema is the
 * contract every consumer validates against, so a locked pose is structurally
 * checked before it is ever stored or republished. The payload travels as JSON
 * text in the `lock_disguise` command, which is why the decoder below owns both
 * the size cap and the parse.
 *
 * It checks structure and legality only. Whether a disguise is convincing is
 * never judged here (§7.16).
 */

const jointRotation = z.strictObject({
  bone: z.enum(RIG_BONE_NAMES),
  rotation: QuaternionSchema,
});

const segmentForm = z.strictObject({
  length: unitScalar,
  width: unitScalar,
  depth: unitScalar,
  flatten: unitScalar,
  taper: signedUnitScalar,
  roundness: unitScalar,
  twist: signedUnitScalar,
  profileId: z.enum(SEGMENT_PROFILE_IDS),
});

const segmentSlot = z.strictObject({
  bone: z.enum(RIG_SEGMENT_BONES),
  form: segmentForm,
});

const panelSnapTarget = z.strictObject({
  kind: z.enum(["panel", "surface"]),
  targetId: id,
  offset: Vec3Schema,
  normal: DirectionSchema,
});

const panelState = z.strictObject({
  socketId: z.enum(PANEL_SOCKET_NAMES),
  deployed: unitScalar,
  hingeAngle: z.number().min(PANEL_MIN_HINGE_DEG).max(PANEL_MAX_HINGE_DEG),
  extension: unitScalar,
  width: unitScalar,
  height: unitScalar,
  profileId: z.enum(PANEL_PROFILE_IDS),
  snapTarget: panelSnapTarget.optional(),
  materialSlotId: id,
});

/**
 * One primitive in a disguise: what it is, which bone carries it, and where it
 * sits in that bone's frame.
 *
 * `rotation` and `scale` are what a gizmo drives, and between them they say
 * everything the old `hingeAngle`, `width` and `height` did, more legibly and
 * without pinning the shape to a socket.
 */
const shapeInstance = z.strictObject({
  /** Stable across edits, so an object list and Duplicate have something to name. */
  id,
  profileId: z.enum(SHAPE_PROFILE_IDS),
  /** Attached, so the construction travels with the body rather than shearing off it. */
  bone: z.enum(RIG_BONE_NAMES),
  position: Vec3Schema,
  rotation: QuaternionSchema,
  scale: Vec3Schema,
  materialSlotId: id,
  /**
   * The outline a drawn solid was swept from, in its own local units, closed
   * and extruded by the renderer. Absent on the primitives.
   */
  outline: z
    .array(z.tuple([z.number(), z.number()]))
    .max(MAX_OUTLINE_POINTS)
    .optional(),
});

const anchorState = z.strictObject({
  id,
  bone: z.enum(RIG_BONE_NAMES),
  objectId: id,
  uv: z.tuple([unitScalar, unitScalar]),
  normalOffset: z.number().min(-LIMITS.maxSegmentLength).max(LIMITS.maxSegmentLength),
  localRotation: QuaternionSchema,
  positionToleranceM: z.number().min(0).max(LIMITS.maxSegmentLength),
  angularToleranceDeg: z.number().min(0).max(180),
});

const materialAssignment = z.strictObject({
  slotId: id,
  swatchId: id,
});

export const DisguiseWireSchema = z
  .strictObject({
    version: z.literal(DISGUISE_WIRE_VERSION),
    rigVersion: z.literal(RIG_CONTRACT_VERSION),
    mapId: z.string().max(LIMITS.idLength),
    mapVersion: count,
    root: z.strictObject({ position: Vec3Schema, rotation: QuaternionSchema }),
    joints: z.array(jointRotation).length(RIG_BONE_NAMES.length),
    segments: z.array(segmentSlot).length(RIG_SEGMENT_BONES.length),
    panels: z.array(panelState).max(MAX_PANELS),
    /**
     * Optional while the Forge migrates off panels. A pose authored by an older
     * build carries none and still validates, so the two can coexist for
     * exactly as long as the changeover takes and no longer.
     */
    shapes: z.array(shapeInstance).max(MAX_SHAPES).optional(),
    anchors: z.array(anchorState).max(LIMITS.maxAnchors),
    materials: z.array(materialAssignment).max(LIMITS.maxMaterialAssignments),
    revision,
  })
  .refine(
    (pose) => pose.joints.every((joint, index) => joint.bone === RIG_BONE_NAMES[index]),
    { message: "joints are not in rig contract order", path: ["joints"] },
  )
  .refine(
    (pose) => pose.segments.every((segment, index) => segment.bone === RIG_SEGMENT_BONES[index]),
    { message: "segments are not in rig contract order", path: ["segments"] },
  )
  .refine(
    (pose) => new Set(pose.panels.map((panel) => panel.socketId)).size === pose.panels.length,
    { message: "two panels share one socket", path: ["panels"] },
  );

export type DisguiseWire = z.infer<typeof DisguiseWireSchema>;

export type DisguiseWireDecoding =
  | { readonly ok: true; readonly pose: DisguiseWire }
  | { readonly ok: false; readonly issue: string };

const poseTextEncoder = new TextEncoder();

/** UTF-8 size of a payload, which is what the byte caps in §36.5 are stated in. */
export function encodedPoseByteLength(payload: string): number {
  return poseTextEncoder.encode(payload).length;
}

/**
 * Parses and validates an encoded pose. Returns the reason rather than throwing,
 * so a rejected lock can be reported to its author as a forge rejection.
 */
export function decodeDisguiseWire(payload: string): DisguiseWireDecoding {
  // A UTF-8 encoding is never shorter than the string's UTF-16 unit count, so
  // this test rejects an oversized payload before anything is allocated.
  if (payload.length > LIMITS.encodedPoseLength) return { ok: false, issue: "payload_too_large" };
  if (encodedPoseByteLength(payload) > LIMITS.encodedPoseLength) {
    return { ok: false, issue: "payload_too_large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, issue: "payload_not_json" };
  }

  const result = DisguiseWireSchema.safeParse(parsed);
  if (result.success) return { ok: true, pose: result.data };

  const first = result.error.issues[0];
  const where = first === undefined ? "" : first.path.join(".");
  const message = first?.message ?? "invalid pose";
  return { ok: false, issue: where.length > 0 ? `${where}: ${message}` : message };
}

export function encodeDisguiseWire(pose: DisguiseWire): string {
  return JSON.stringify(pose);
}

/**
 * Schema-valid reference pose. It is the shape a consumer can build against and
 * the fixture the simulation tests lock, not an authored starting arrangement:
 * those live in the Forge and are named by DEFAULT_ARRANGEMENT_ID.
 */
export function createReferenceDisguiseWire(revisionValue = 0): DisguiseWire {
  return {
    version: DISGUISE_WIRE_VERSION,
    rigVersion: RIG_CONTRACT_VERSION,
    mapId: "",
    mapVersion: 0,
    root: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    joints: RIG_BONE_NAMES.map((bone) => ({
      bone,
      rotation: [0, 0, 0, 1] as [number, number, number, number],
    })),
    segments: RIG_SEGMENT_BONES.map((bone) => ({
      bone,
      form: {
        length: 0.5,
        width: 0.5,
        depth: 0.5,
        flatten: 0,
        taper: 0,
        roundness: 0.5,
        twist: 0,
        profileId: "capsule" as const,
      },
    })),
    panels: [],
    anchors: [],
    materials: [{ slotId: "body", swatchId: "mimic_porcelain" }],
    revision: revisionValue,
  };
}

// ------------------------------------------------------------- paint layer

/**
 * Structural contract for a body-painting layer (CLAUDE.md override 3). The
 * compact encoding lives in ./paintWire.ts; this is what a validator checks a
 * decoded layer against, and `EncodedPaintLayerSchema` is what it checks the
 * transported text against before decoding anything.
 *
 * Like the disguise wire it judges legality, never artistry: a layer is valid
 * when every stroke names a real paint target and stays inside its UV square.
 */

const paintTargetIndex = z
  .number()
  .int()
  .min(0)
  .max(PAINT_TARGET_IDS.length - 1);

export const PaintStrokeWireSchema = z.strictObject({
  target: paintTargetIndex,
  u: unitScalar,
  v: unitScalar,
  radius: unitScalar,
  color: z.tuple([unitScalar, unitScalar, unitScalar]),
  opacity: unitScalar,
  /** Material response painted with the colour; the renderer inverts smoothness. */
  metallic: unitScalar,
  smoothness: unitScalar,
  /** How much the stroke glows, in its own colour. */
  emissive: unitScalar,
  erase: z.boolean(),
  /** Sampled while the pointer was already down, so a replay draws the join. */
  continued: z.boolean(),
});

export const PaintLayerWireSchema = z.strictObject({
  version: z.literal(PAINT_WIRE_VERSION),
  strokes: z.array(PaintStrokeWireSchema).max(MAX_PAINT_STROKES),
});

export const EncodedPaintLayerSchema = z.string().max(PAINT_WIRE_MAX_BASE64_LENGTH);

/**
 * A Mimic's latest body-paint layer, as the transports carry it. The parallel
 * of ForgeSnapshotSchema, and coalesced the same way: one whole stroke log per
 * send, never one send per brush stamp. The revision is the layer's own,
 * because paint and pose are authored independently.
 */
export const PaintUpdateSchema = z.strictObject({
  revision,
  encodedPaint: EncodedPaintLayerSchema,
});

export type PaintLayerWirePayload = z.infer<typeof PaintLayerWireSchema>;

export type PaintLayerWireDecoding =
  | { readonly ok: true; readonly layer: PaintLayerWirePayload }
  | { readonly ok: false; readonly issue: string };

/**
 * Decodes and then validates, so a peer's layer is checked twice: once by the
 * byte reader, which can only produce in-range values, and once by the schema,
 * which is the contract the rest of the game reads.
 */
export function decodePaintLayerWire(payload: string): PaintLayerWireDecoding {
  const decoded = decodePaintLayer(payload);
  if (!decoded.ok) return decoded;

  const result = PaintLayerWireSchema.safeParse(decoded.layer);
  if (result.success) return { ok: true, layer: result.data };

  const first = result.error.issues[0];
  const where = first === undefined ? "" : first.path.join(".");
  const message = first?.message ?? "invalid paint layer";
  return { ok: false, issue: where.length > 0 ? `${where}: ${message}` : message };
}

// ------------------------------------------------------------- match commands

const settingsValue = z.number().int().min(0).max(LIMITS.maxTimestamp);

export const MatchSettingsPatchSchema = z
  .strictObject({
    maxPlayers: z.number().int().min(2).max(LIMITS.maxPlayersPerMatch),
    /** One or two seekers per round; the simulation enforces the seat floor. */
    seekerCount: z.number().int().min(1).max(MAX_SEEKER_COUNT),
    mapIntroMs: settingsValue,
    roleRevealMs: settingsValue,
    forgeMs: settingsValue,
    lockGraceMs: settingsValue,
    inspectionIntroMs: settingsValue,
    inspectionMs: settingsValue,
    revealMs: settingsValue,
    resultsMs: settingsValue,
    rematchVoteMs: settingsValue,
    warrantsBonus: z.number().int().min(0).max(16),
    wrongAccusationCooldownMs: settingsValue,
    reconnectGraceMs: settingsValue,
  })
  .partial();

export const MatchCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("player_ready"), ready: z.boolean() }),
  z.strictObject({ type: z.literal("set_settings"), settings: MatchSettingsPatchSchema }),
  z.strictObject({ type: z.literal("start_match") }),
  z.strictObject({ type: z.literal("lock_disguise"), payload: encodedPose, revision }),
  z.strictObject({ type: z.literal("accuse"), targetObjectId: id }),
  z.strictObject({ type: z.literal("focus"), targetObjectId: id.nullable() }),
  z.strictObject({ type: z.literal("grapple"), target: Vec3Schema }),
  z.strictObject({
    type: z.literal("vote_result"),
    category: ResultVoteCategorySchema,
    targetPublicObjectId: id,
  }),
  z.strictObject({ type: z.literal("vote_rematch"), yes: z.boolean() }),
  z.strictObject({ type: z.literal("taunt"), tauntId: TauntIdSchema }),
  z.strictObject({ type: z.literal("claim_restock") }),
]);

export type MatchCommandPayload = z.infer<typeof MatchCommandSchema>;

// -------------------------------------------------------- movement and camera

export const MovementInputSchema = z.strictObject({
  sequence: z.number().int().min(0).max(LIMITS.maxRevision),
  /** Local move axes, already normalized by the client. */
  move: z.tuple([signedUnitScalar, signedUnitScalar]),
  yaw: angle,
  pitch: angle,
  brisk: z.boolean(),
  deltaMs: z.number().min(0).max(1_000),
});

export const CameraSampleSchema = z.strictObject({
  yaw: angle,
  pitch: angle,
  at: timestamp,
});

// --------------------------------------------------------------- match events

const eventBase = {
  seq: z.number().int().min(0),
  at: timestamp,
};

export const DisguiseSourceSchema = z.enum([
  "player_lock",
  "recovered_pose",
  "default_arrangement",
]);

export const StarterArrangementIdSchema = z.enum(STARTER_ARRANGEMENT_IDS);

export const DisguiseOwnershipSchema = z.strictObject({
  publicObjectId: id,
  publicPlayerId: id,
  displayName,
  /** How long this disguise lasted, known once the round reaches the reveal. */
  survivalSeconds: count,
});

export const PlayerResultSchema = z.strictObject({
  publicPlayerId: id,
  displayName,
  role: PlayerRoleSchema,
  score: z.number().int(),
  survivalSeconds: count,
  fullRoundSurvival: z.boolean(),
  directLookEscapes: count,
  closePasses: count,
  peerStyleVotes: count,
  correctAccusations: count,
  wrongAccusations: count,
  uniqueObjectsFocused: count,
  /** The disguise this player wore. Null for Inspectors. Results are post-reveal. */
  publicObjectId: id.nullable(),
  /** Seconds this hider spent inside an Inspector's focus, unresolved (§6.2). */
  lineOfSightSeconds: count,
  /** Taunts performed while actually being watched. */
  observedTaunts: count,
});

export const ResultVoteTalliesSchema = z.strictObject({
  best_disguise: z.record(id, count),
  funniest_attempt: z.record(id, count),
  most_audacious: z.record(id, count),
});

export const MatchResultsSchema = z.strictObject({
  round: count,
  winner: MatchWinnerSchema,
  inspectionDurationMs: timestamp,
  timeRemainingMs: timestamp,
  players: z.array(PlayerResultSchema).max(LIMITS.maxPlayersPerMatch),
  // Default on decode for a rolling deployment; current authorities always
  // publish it, while an older room can still fall back to live vote events.
  voteTallies: ResultVoteTalliesSchema.default(() => ({
    best_disguise: {},
    funniest_attempt: {},
    most_audacious: {},
  })),
});

export const SimEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...eventBase,
    type: z.literal("player_joined"),
    publicPlayerId: id,
    displayName,
    isHost: z.boolean(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("player_left"),
    publicPlayerId: id,
    reason: z.enum(["left", "reconnect_timeout", "removed"]),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("player_connection_changed"),
    publicPlayerId: id,
    connected: z.boolean(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("player_ready_changed"),
    publicPlayerId: id,
    ready: z.boolean(),
  }),
  z.strictObject({ ...eventBase, type: z.literal("host_changed"), publicPlayerId: id }),
  z.strictObject({
    ...eventBase,
    type: z.literal("settings_changed"),
    changedKeys: z.array(z.string().min(1).max(LIMITS.idLength)).max(LIMITS.maxChangedKeys),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("phase_changed"),
    phase: MatchPhaseSchema,
    previousPhase: MatchPhaseSchema,
    phaseEndsAt: timestamp,
    round: count,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("roles_assigned"),
    round: count,
    // Inspectors are public knowledge; Mimics are a count and nothing more.
    inspectorPublicIds: z.array(id).max(LIMITS.maxPlayersPerMatch),
    mimicCount: count,
  }),
  z.strictObject({ ...eventBase, type: z.literal("baseline_started"), endsAt: timestamp }),
  z.strictObject({ ...eventBase, type: z.literal("forge_started"), endsAt: timestamp }),
  // Whether a lock was automatic is a tell about its owner, so it is private.
  z.strictObject({ ...eventBase, type: z.literal("disguise_locked"), publicObjectId: id }),
  // A hider adjusted itself during the hunt. The geometry itself travels in
  // public state; this only says which object changed and how current it is.
  z.strictObject({
    ...eventBase,
    type: z.literal("disguise_updated"),
    publicObjectId: id,
    revision,
    moved: z.boolean(),
    /** True when the paint layer changed rather than the pose. */
    painted: z.boolean(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("missed_finds_update"),
    entries: z
      .array(
        z.strictObject({ displayName, publicPlayerId: id, points: count }),
      )
      .max(LIMITS.maxPlayersPerMatch),
    /** When the next board lands, so a countdown can be truthful. */
    nextUpdateAtMs: timestamp,
    /** The reveal board, which carries exact rather than bucketed points. */
    final: z.boolean(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("taunt_performed"),
    publicObjectId: id,
    tauntId: TauntIdSchema,
    seed: z.number().int().min(0),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("inspection_started"),
    endsAt: timestamp,
    warrantsRemaining: count,
    mimicsRemaining: count,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("accusation_resolved"),
    inspectorPublicId: id,
    correct: z.boolean(),
    targetObjectId: id,
    warrantsRemaining: count,
    revealedPlayerPublicId: id.optional(),
    /** Present on a wrong accusation, matching the innocent_reaction event. */
    reactionId: InnocentReactionIdSchema.optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("innocent_reaction"),
    objectId: id,
    reactionId: InnocentReactionIdSchema,
    seed: z.number().int().min(0),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("mimic_caught"),
    publicObjectId: id,
    publicPlayerId: id,
    survivalSeconds: count,
    mimicsRemaining: count,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("direct_look_escape"),
    publicObjectId: id,
    inspectorPublicId: id,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("close_pass"),
    publicObjectId: id,
    inspectorPublicId: id,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("warrant_restock"),
    inspectorPublicId: id,
    warrantsRemaining: count,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("result_vote_cast"),
    voterPublicId: id,
    category: ResultVoteCategorySchema,
    targetPublicObjectId: id,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("rematch_vote_cast"),
    voterPublicId: id,
    yes: z.boolean(),
    yesVotes: count,
    totalVoters: count,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("match_ended"),
    winner: MatchWinnerSchema,
    results: MatchResultsSchema,
  }),
  z.strictObject({ ...eventBase, type: z.literal("rematch_started"), round: count }),
]);

export type SimEventPayload = z.infer<typeof SimEventSchema>;

/**
 * Events addressed to exactly one player. The simulation keeps them in a
 * per-player queue so a transport cannot broadcast one by mistake: there is no
 * shape in which a secret rides along inside a public event (§27.5, §29.3).
 */
export const PrivateSimEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...eventBase,
    type: z.literal("role_assigned"),
    round: count,
    role: PlayerRoleSchema,
    publicPlayerId: id,
    teammatePublicIds: z.array(id).max(LIMITS.maxPlayersPerMatch),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("own_disguise_locked"),
    publicObjectId: id,
    autoLocked: z.boolean(),
    source: DisguiseSourceSchema,
    defaultArrangementId: StarterArrangementIdSchema.nullable(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("disguise_owners"),
    owners: z.array(DisguiseOwnershipSchema).max(LIMITS.maxPlayersPerMatch),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("watched"),
    /** 0 unobserved, 1 in the Inspector's cone, 2 held at close range. */
    level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("hunt_hint"),
    closePasses: count,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("opening_hint"),
    hidden: count,
    elevated: count,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("close_pass_jackpot"),
    inspectorPublicId: id,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("taunt_streak"),
    streak: count,
  }),
]);

export type PrivateSimEventPayload = z.infer<typeof PrivateSimEventSchema>;

// ------------------------------------------------------- host migration state

/**
 * Validation for a match snapshot (§27.11). On a dedicated server a snapshot
 * never leaves the process, but under Portals the outgoing host hands it to
 * whichever client takes over, so it arrives as untrusted input from a peer and
 * has to be checked before it becomes authoritative state.
 *
 * The checks are structural: shape, types, and no injected keys. Ranges are
 * deliberately loose, because this describes internal state mid-round rather
 * than a player's command, and a bound guessed too tight here would reject a
 * legitimate room. Cross-room confusion is caught separately by the format
 * version and the map id, which the restoring simulation compares itself.
 */

const settingsNumber = z.number();

export const MatchSettingsSchema = z.strictObject(
  Object.fromEntries(
    Object.keys(DEFAULT_MATCH_SETTINGS).map((key) => [key, settingsNumber]),
  ) as Record<keyof typeof DEFAULT_MATCH_SETTINGS, typeof settingsNumber>,
);

/** Simulation time, which callers may tick with a fractional millisecond. */
const simTime = z.number();
const counter = z.number().int().min(0);
const uint32 = z.number().int().min(0).max(4_294_967_295);

const SnapshotStatsSchema = z.strictObject({
  e: counter,
  c: counter,
  v: counter,
  ca: counter,
  wa: counter,
  f: z.array(id).max(LIMITS.maxCount),
  /** Accumulated line-of-sight milliseconds, and taunts counted while watched. */
  los: z.number().min(0),
  ot: counter,
  cj: counter,
});

const SnapshotPlayerSchema = z.strictObject({
  i: id,
  p: id,
  n: displayName,
  h: z.boolean(),
  c: z.boolean(),
  d: simTime.nullable(),
  y: z.boolean(),
  r: PlayerRoleSchema,
  l: PlayerLifeStateSchema,
  j: counter,
  jr: z.number().int(),
  li: z.number().int(),
  ir: counter,
  o: id.nullable(),
  vp: z.tuple([encodedPose, revision]).nullable(),
  /** Latest paint recorded before the disguise manifested. */
  vt: z.tuple([EncodedPaintLayerSchema, revision]).nullable(),
  ct: simTime.nullable(),
  st: SnapshotStatsSchema,
  /** Taunt cooldown clock and forge-command rate clock. */
  tt: simTime.nullable(),
  /** Bait streak: current run, best run, and the seeker's restock flag. */
  ts: counter,
  tb: counter,
  rk: z.boolean(),
  fu: simTime.nullable(),
  /** Last watched level delivered, and when, for the change throttle. */
  wl: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  wa: simTime.nullable(),
});

const SnapshotDisguiseSchema = z.strictObject({
  o: id,
  /** Null once the owner has left; the disguise itself stays (§27.9). */
  ow: id.nullable(),
  op: id,
  on: displayName,
  e: encodedPose,
  rv: revision,
  /** Paint layer and its own revision, parallel to the pose and its revision. */
  pt: EncodedPaintLayerSchema.nullable(),
  pv: revision,
  s: DisguiseSourceSchema,
  a: StarterArrangementIdSchema.nullable(),
  al: z.boolean(),
  lk: simTime,
  ct: simTime.nullable(),
  /** Root position of the current pose, and when it last moved (§creep cap). */
  rp: Vec3Schema,
  mv: simTime,
});

const nestedClocks = z.array(z.tuple([id, z.array(z.tuple([id, simTime])).max(LIMITS.maxCount)]));

export const MatchSnapshotSchema = z.strictObject({
  v: z.number().int(),
  map: z.string().max(LIMITS.idLength),
  /** Locked poses were left out and must be supplied from public state. */
  po: z.boolean(),
  s: MatchSettingsSchema,
  sd: uint32,
  rc: uint32,
  sq: counter,
  nj: counter,
  t: simTime,
  r: counter,
  ph: MatchPhaseSchema,
  pe: simTime,
  /** Warrants each seeker was issued, and what each has left, keyed by seat. */
  wi: z.number().int(),
  wp: z.array(z.tuple([id, z.number().int()])).max(LIMITS.maxPlayersPerMatch),
  /** Warrants the round started with, so a late joiner can render spent rounds. */
  wt: z.number().int(),
  /** Next missed-finds board time, and how many have been published. */
  mf: simTime,
  mc: counter,
  is: simTime,
  ie: simTime,
  ix: simTime,
  lg: simTime,
  fd: simTime,
  ac: counter,
  op: z.array(id).max(LIMITS.maxPlayersPerMatch),
  pl: z.array(SnapshotPlayerSchema).max(LIMITS.maxPlayersPerMatch),
  dg: z.array(SnapshotDisguiseSchema).max(LIMITS.maxPlayersPerMatch),
  ro: z.array(z.tuple([id, z.enum(["mimic", "innocent"])])).max(LIMITS.maxCount),
  ar: z.array(z.tuple([id, simTime])).max(LIMITS.maxPlayersPerMatch),
  fh: z.array(z.tuple([id, id, simTime])).max(LIMITS.maxPlayersPerMatch),
  pes: z.array(z.tuple([id, id, simTime])).max(LIMITS.maxCount),
  le: nestedClocks.max(LIMITS.maxPlayersPerMatch),
  lc: nestedClocks.max(LIMITS.maxPlayersPerMatch),
  /** Close-pass pair counts, paid jackpot pairs, and the hint round. */
  cpn: z
    .array(z.tuple([id, z.array(z.tuple([id, counter])).max(LIMITS.maxCount)]))
    .max(LIMITS.maxPlayersPerMatch),
  cpj: z.array(z.string().max(LIMITS.idLength * 2 + 1)).max(LIMITS.maxCount),
  hh: z.number().int(),
  oh: z.number().int().optional(),
  rv: z
    .array(z.tuple([id, z.array(z.tuple([ResultVoteCategorySchema, id])).max(LIMITS.maxCount)]))
    .max(LIMITS.maxPlayersPerMatch),
  rm: z.array(z.tuple([id, z.boolean()])).max(LIMITS.maxPlayersPerMatch),
  rs: MatchResultsSchema.nullable(),
  qp: z.array(SimEventSchema).max(LIMITS.maxCount),
  qv: z
    .array(z.tuple([id, z.array(PrivateSimEventSchema).max(LIMITS.maxCount)]))
    .max(LIMITS.maxPlayersPerMatch),
});

export type MatchSnapshotPayload = z.infer<typeof MatchSnapshotSchema>;
