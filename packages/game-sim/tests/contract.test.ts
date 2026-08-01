import { describe, expect, it } from "vitest";
import {
  MatchCommandSchema,
  MatchPhase,
  SimEventSchema,
  type MatchCommandPayload,
} from "@foldseek/shared";
import type { MatchCommand } from "../src";
import { Harness } from "./harness";

/** A parsed network command must be usable as a simulation command with no cast. */
function acceptParsedCommand(parsed: MatchCommandPayload): MatchCommand {
  return parsed;
}

describe("shared schema contract", () => {
  it("validates every event emitted during a complete round", () => {
    const harness = new Harness({ players: 6, seed: 313 });
    harness.toInspection();

    const inspector = harness.inspectorIds()[0] as string;
    harness.tick(2_000);
    harness.command(inspector, { type: "accuse", targetObjectId: "prop-lamp" });
    harness.tick(3_000);
    harness.command(inspector, {
      type: "accuse",
      targetObjectId: harness.objectIdOf(harness.mimicIds()[0] as string),
    });
    harness.command(inspector, { type: "focus", targetObjectId: "prop-clock" });
    harness.tickUntil(MatchPhase.RematchVote);
    for (const playerId of harness.playerIds) {
      harness.command(playerId, { type: "vote_rematch", yes: true });
    }
    harness.tickUntil(MatchPhase.Forge);

    expect(harness.log.length).toBeGreaterThan(30);
    for (const event of harness.log) {
      const parsed = SimEventSchema.safeParse(event);
      expect(parsed.success, `${event.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("feeds schema-parsed commands straight into the simulation", () => {
    const harness = new Harness({ players: 3, seed: 317 });
    const wire = [
      { type: "player_ready", ready: true },
      { type: "start_match" },
    ];

    for (const raw of wire) {
      const parsed = MatchCommandSchema.parse(raw);
      const command = acceptParsedCommand(parsed);
      if (command.type === "player_ready") {
        for (const playerId of harness.playerIds) {
          expect(harness.command(playerId, command).accepted).toBe(true);
        }
      } else {
        expect(harness.command(harness.hostId, command).accepted).toBe(true);
      }
    }
    expect(harness.phase()).toBe(MatchPhase.Loading);
  });
});
