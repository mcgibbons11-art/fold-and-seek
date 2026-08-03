import { describe, expect, it } from "vitest";
import {
  CameraSampleSchema,
  DisguiseWireSchema,
  ForgeCommandSchema,
  LIMITS,
  MAX_PANELS,
  MatchCommandSchema,
  MatchPhase,
  MatchSettingsPatchSchema,
  MovementInputSchema,
  PrivateSimEventSchema,
  QuaternionSchema,
  RIG_BONE_NAMES,
  SimEventSchema,
  Vec3Schema,
  createReferenceDisguiseWire,
  decodeDisguiseWire,
  encodeDisguiseWire,
} from "../src";

const envelope = { revision: 12, commandId: "cmd-00000001" };

describe("forge command schema", () => {
  it("accepts one valid payload for every command kind", () => {
    const commands = [
      {
        ...envelope,
        kind: "set_ik_target",
        payload: { handleId: "hand_l", position: [1, 2, 3], enabled: true },
      },
      {
        ...envelope,
        kind: "set_joint_rotation",
        payload: { jointId: "spine_02", rotation: [0, 0, 0, 1] },
      },
      {
        ...envelope,
        kind: "set_segment_form",
        payload: {
          segmentId: "arm_upper_l",
          length: 1.4,
          thickness: 0.3,
          flatten: 0.5,
          taper: 0.2,
          profile: 0.75,
        },
      },
      {
        ...envelope,
        kind: "set_panel_state",
        payload: { panelId: "panel_back", deployed: true, hinge: 1.2 },
      },
      {
        ...envelope,
        kind: "set_anchor",
        payload: {
          anchorId: "anchor_1",
          surfaceId: "shelf_top",
          position: [0.5, 1, -2],
          normal: [0, 1, 0],
        },
      },
      { ...envelope, kind: "remove_anchor", payload: { anchorId: "anchor_1" } },
      {
        ...envelope,
        kind: "assign_material",
        payload: { targetId: "torso", swatchId: "brass_worn", tint: 0.4 },
      },
      { ...envelope, kind: "set_root", payload: { position: [0, 0, 0], rotation: [0, 0, 0, 1] } },
    ];

    for (const command of commands) {
      const parsed = ForgeCommandSchema.safeParse(command);
      expect(parsed.success, `${command.kind} should parse`).toBe(true);
    }
    expect(commands).toHaveLength(8);
  });

  it("rejects an unknown kind and a payload from the wrong kind", () => {
    expect(
      ForgeCommandSchema.safeParse({ ...envelope, kind: "explode", payload: {} }).success,
    ).toBe(false);
    expect(
      ForgeCommandSchema.safeParse({
        ...envelope,
        kind: "remove_anchor",
        payload: { jointId: "spine_02", rotation: [0, 0, 0, 1] },
      }).success,
    ).toBe(false);
  });

  it("rejects NaN, Infinity and out-of-range numbers", () => {
    const rotationCommand = (rotation: unknown) => ({
      ...envelope,
      kind: "set_joint_rotation",
      payload: { jointId: "spine_02", rotation },
    });
    expect(ForgeCommandSchema.safeParse(rotationCommand([Number.NaN, 0, 0, 1])).success).toBe(false);
    expect(
      ForgeCommandSchema.safeParse(rotationCommand([Number.POSITIVE_INFINITY, 0, 0, 1])).success,
    ).toBe(false);
    expect(ForgeCommandSchema.safeParse(rotationCommand([2, 0, 0, 1])).success).toBe(false);
    expect(
      ForgeCommandSchema.safeParse({
        ...envelope,
        revision: 1.5,
        kind: "remove_anchor",
        payload: { anchorId: "a" },
      }).success,
    ).toBe(false);
  });

  it("rejects zero and wrong-length quaternions and vectors", () => {
    expect(QuaternionSchema.safeParse([0, 0, 0, 0]).success).toBe(false);
    expect(QuaternionSchema.safeParse([0, 0, 1]).success).toBe(false);
    expect(QuaternionSchema.safeParse([0, 0, 0, 1, 0]).success).toBe(false);
    expect(QuaternionSchema.safeParse([0, 0, 0, 1]).success).toBe(true);
    expect(Vec3Schema.safeParse([0, 0]).success).toBe(false);
    expect(Vec3Schema.safeParse([0, 0, LIMITS.worldCoordinate + 1]).success).toBe(false);
  });

  // P2: a quaternion off the unit sphere is a hidden scale, not a rotation.
  it("P2 rejects a quaternion that is not normalized", () => {
    const half = Math.SQRT1_2;
    expect(QuaternionSchema.safeParse([half, 0, 0, half]).success).toBe(true);
    expect(QuaternionSchema.safeParse([0.5, 0, 0, 0.5]).success).toBe(false);
    expect(QuaternionSchema.safeParse([0, 0, 0, 0.9]).success).toBe(false);
    // Quantization noise inside the tolerance still parses.
    expect(QuaternionSchema.safeParse([0.0005, 0, 0, 1]).success).toBe(true);
  });

  it("rejects extra keys and oversized identifiers", () => {
    expect(
      ForgeCommandSchema.safeParse({
        ...envelope,
        kind: "remove_anchor",
        payload: { anchorId: "a" },
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      ForgeCommandSchema.safeParse({
        ...envelope,
        kind: "remove_anchor",
        payload: { anchorId: "x".repeat(LIMITS.idLength + 1) },
      }).success,
    ).toBe(false);
    expect(
      ForgeCommandSchema.safeParse({ revision: 1, commandId: "short", kind: "remove_anchor", payload: { anchorId: "a" } })
        .success,
    ).toBe(false);
  });
});

describe("match command schema", () => {
  it("accepts every command the simulation handles", () => {
    const commands = [
      { type: "player_ready", ready: true },
      { type: "set_settings", settings: { forgeMs: 30_000 } },
      { type: "start_match" },
      { type: "lock_disguise", payload: "encoded", revision: 3 },
      { type: "accuse", targetObjectId: "obj_abc" },
      { type: "focus", targetObjectId: null },
      { type: "focus", targetObjectId: "obj_abc" },
      { type: "vote_result", category: "best_disguise", targetPublicObjectId: "obj_abc" },
      { type: "vote_rematch", yes: false },
    ];
    for (const command of commands) {
      expect(MatchCommandSchema.safeParse(command).success, JSON.stringify(command)).toBe(true);
    }
  });

  it("rejects unknown commands, bad categories and oversized poses", () => {
    expect(MatchCommandSchema.safeParse({ type: "detonate" }).success).toBe(false);
    expect(
      MatchCommandSchema.safeParse({
        type: "vote_result",
        category: "most_flammable",
        targetPublicObjectId: "obj_abc",
      }).success,
    ).toBe(false);
    expect(
      MatchCommandSchema.safeParse({
        type: "lock_disguise",
        payload: "x".repeat(LIMITS.encodedPoseLength + 1),
        revision: 1,
      }).success,
    ).toBe(false);
    expect(
      MatchCommandSchema.safeParse({ type: "accuse", targetObjectId: "" }).success,
    ).toBe(false);
  });

  it("validates host settings patches", () => {
    expect(MatchSettingsPatchSchema.safeParse({}).success).toBe(true);
    expect(MatchSettingsPatchSchema.safeParse({ forgeMs: 30_000, warrantsBonus: 3 }).success).toBe(
      true,
    );
    expect(MatchSettingsPatchSchema.safeParse({ forgeMs: -1 }).success).toBe(false);
    expect(MatchSettingsPatchSchema.safeParse({ forgeMs: Number.NaN }).success).toBe(false);
    expect(MatchSettingsPatchSchema.safeParse({ maxPlayers: 1 }).success).toBe(false);
    expect(MatchSettingsPatchSchema.safeParse({ inspectorMoveSpeed: 99 }).success).toBe(false);
    expect(MatchSettingsPatchSchema.safeParse({ baselineScanMs: 12_000 }).success).toBe(false);
  });
});

describe("P1-3 canonical disguise wire", () => {
  /** The decoder's complaint, or "accepted" when the payload was legal. */
  const issueOf = (payload: string): string => {
    const decoded = decodeDisguiseWire(payload);
    return decoded.ok ? "accepted" : decoded.issue;
  };

  /** A pose as loose data, so a test can put an illegal value in one field. */
  const looseReferencePose = (): Record<string, any> =>
    createReferenceDisguiseWire() as unknown as Record<string, any>;

  it("accepts the reference pose and round-trips it through the decoder", () => {
    const pose = createReferenceDisguiseWire(3);
    expect(DisguiseWireSchema.safeParse(pose).success).toBe(true);

    const decoded = decodeDisguiseWire(encodeDisguiseWire(pose));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.pose.revision).toBe(3);
      expect(decoded.pose.joints).toHaveLength(RIG_BONE_NAMES.length);
    }
  });

  it("rejects text that is not a pose at all", () => {
    expect(decodeDisguiseWire("").ok).toBe(false);
    expect(decodeDisguiseWire("pose-0").ok).toBe(false);
    expect(issueOf("{ not json")).toBe("payload_not_json");
    expect(decodeDisguiseWire("[]").ok).toBe(false);
    expect(decodeDisguiseWire("null").ok).toBe(false);
  });

  it("rejects a payload over the byte cap before parsing it", () => {
    expect(issueOf("x".repeat(LIMITS.encodedPoseLength + 1))).toBe("payload_too_large");

    // Multi-byte characters count as their UTF-8 size, not their unit count.
    expect(issueOf("é".repeat(LIMITS.encodedPoseLength - 1))).toBe("payload_too_large");
  });

  it("rejects out-of-range, denormalized and miscounted pose fields", () => {
    const mutated = (change: (pose: Record<string, any>) => void): boolean => {
      const pose = looseReferencePose();
      change(pose);
      return decodeDisguiseWire(JSON.stringify(pose)).ok;
    };

    expect(mutated((pose) => (pose["version"] = 2))).toBe(false);
    expect(mutated((pose) => (pose["rigVersion"] = 99))).toBe(false);
    expect(mutated((pose) => (pose["root"].rotation = [0.5, 0, 0, 0.5]))).toBe(false);
    expect(mutated((pose) => (pose["root"].position = [Number.NaN, 0, 0]))).toBe(false);
    expect(mutated((pose) => pose["joints"].pop())).toBe(false);
    expect(mutated((pose) => pose["joints"].reverse())).toBe(false);
    expect(mutated((pose) => pose["segments"].pop())).toBe(false);
    expect(mutated((pose) => (pose["segments"][0].form.taper = 2))).toBe(false);
    expect(mutated((pose) => (pose["segments"][0].form.length = -0.1))).toBe(false);
    expect(mutated((pose) => (pose["segments"][0].form.profileId = "sphere"))).toBe(false);
    expect(mutated((pose) => (pose["revision"] = 1.5))).toBe(false);
    expect(mutated((pose) => (pose["extra"] = true))).toBe(false);
  });

  it("rejects more panels than there are sockets, and two panels on one socket", () => {
    const panel = (socket: string) => ({
      socketId: socket,
      deployed: 1,
      hingeAngle: 20,
      extension: 0.5,
      width: 0.5,
      height: 0.5,
      profileId: "rectangle",
      materialSlotId: "body",
    });

    const tooMany = looseReferencePose();
    for (let i = 0; i <= MAX_PANELS; i += 1) {
      tooMany["panels"].push(panel(`panel_socket_0${(i % 8) + 1}`));
    }
    expect(decodeDisguiseWire(JSON.stringify(tooMany)).ok).toBe(false);

    const duplicated = looseReferencePose();
    duplicated["panels"].push(panel("panel_socket_01"), panel("panel_socket_01"));
    expect(decodeDisguiseWire(JSON.stringify(duplicated)).ok).toBe(false);
  });

  it("names the offending field so the author can be told what is wrong", () => {
    const pose = looseReferencePose();
    pose["root"].rotation = [0.5, 0, 0, 0.5];
    expect(issueOf(JSON.stringify(pose))).toContain("root.rotation");
  });
});

describe("P1-7 private event schema", () => {
  it("validates the three private deliveries", () => {
    const events = [
      {
        seq: 1,
        at: 0,
        type: "role_assigned",
        round: 0,
        role: "mimic",
        publicPlayerId: "p_1",
        teammatePublicIds: ["p_2"],
      },
      {
        seq: 2,
        at: 1,
        type: "own_disguise_locked",
        publicObjectId: "obj_1",
        autoLocked: true,
        source: "default_arrangement",
        defaultArrangementId: "upright",
      },
      {
        seq: 3,
        at: 2,
        type: "disguise_owners",
        owners: [
          {
            publicObjectId: "obj_1",
            publicPlayerId: "p_1",
            displayName: "Visitor 1",
            survivalSeconds: 42,
          },
        ],
      },
    ];
    for (const event of events) {
      expect(PrivateSimEventSchema.safeParse(event).success, event.type).toBe(true);
    }
    expect(
      PrivateSimEventSchema.safeParse({ seq: 1, at: 0, type: "roles_assigned", round: 0 }).success,
    ).toBe(false);
  });

  it("keeps role deliveries out of the public event union", () => {
    expect(
      SimEventSchema.safeParse({
        seq: 1,
        at: 0,
        type: "roles_assigned",
        round: 0,
        inspectorPublicIds: ["p_1"],
        mimicCount: 3,
        deliveries: [{ playerId: "player-1", role: "mimic", teammatePublicIds: [] }],
      }).success,
    ).toBe(false);
  });
});

describe("event and transport schemas", () => {
  it("accepts representative simulation events", () => {
    const events = [
      {
        seq: 1,
        at: 0,
        type: "phase_changed",
        phase: MatchPhase.Forge,
        previousPhase: MatchPhase.BaselineScan,
        phaseEndsAt: 55_000,
        round: 0,
      },
      {
        seq: 2,
        at: 10,
        type: "accusation_resolved",
        inspectorPublicId: "p_1",
        correct: true,
        targetObjectId: "obj_1",
        warrantsRemaining: 4,
        revealedPlayerPublicId: "p_2",
      },
      {
        seq: 3,
        at: 11,
        type: "innocent_reaction",
        objectId: "prop_lamp",
        reactionId: "lamp_turns_on",
        seed: 12_345,
      },
      {
        seq: 4,
        at: 12,
        type: "match_ended",
        winner: "inspectors",
        results: {
          round: 0,
          winner: "inspectors",
          inspectionDurationMs: 15_000,
          timeRemainingMs: 60_000,
          players: [
            {
              publicPlayerId: "p_1",
              displayName: "Visitor 1",
              role: "inspector",
              score: -150,
              survivalSeconds: 0,
              fullRoundSurvival: false,
              directLookEscapes: 0,
              closePasses: 0,
              peerStyleVotes: 0,
              correctAccusations: 0,
              wrongAccusations: 1,
              uniqueObjectsFocused: 3,
              publicObjectId: null,
              lineOfSightSeconds: 0,
              observedTaunts: 0,
            },
          ],
        },
      },
    ];
    for (const event of events) {
      expect(SimEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
    }
  });

  it("rejects events with a bad phase, missing envelope or negative counts", () => {
    expect(
      SimEventSchema.safeParse({
        seq: 1,
        at: 0,
        type: "phase_changed",
        phase: "intermission",
        previousPhase: MatchPhase.Forge,
        phaseEndsAt: 0,
        round: 0,
      }).success,
    ).toBe(false);
    expect(
      SimEventSchema.safeParse({ type: "rematch_started", round: 1 }).success,
    ).toBe(false);
    expect(
      SimEventSchema.safeParse({ seq: 1, at: 0, type: "rematch_started", round: -1 }).success,
    ).toBe(false);
  });

  it("bounds movement and camera samples", () => {
    expect(
      MovementInputSchema.safeParse({
        sequence: 10,
        move: [0, 1],
        yaw: 1,
        pitch: -0.5,
        brisk: true,
        deltaMs: 16,
      }).success,
    ).toBe(true);
    expect(
      MovementInputSchema.safeParse({
        sequence: 10,
        move: [0, 4],
        yaw: 1,
        pitch: 0,
        brisk: true,
        deltaMs: 16,
      }).success,
    ).toBe(false);
    expect(CameraSampleSchema.safeParse({ yaw: 10, pitch: 0, at: 1 }).success).toBe(false);
    expect(CameraSampleSchema.safeParse({ yaw: 1, pitch: 0, at: 1 }).success).toBe(true);
  });
});
