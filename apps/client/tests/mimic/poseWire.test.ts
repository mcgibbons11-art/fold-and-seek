import { decodeDisguiseWire } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import {
  createStarterArrangement,
  STARTER_ARRANGEMENT_IDS,
  type StarterArrangementId,
} from "../../src/mimic/disguiseState";
import { decodeDisguiseState, encodeDisguiseState } from "../../src/mimic/poseWire";

/**
 * The Forge authors one representation and the authority validates another, so
 * the only thing that matters here is that every pose the Forge can produce
 * survives the crossing as something the schema accepts.
 */

describe("poseWire", () => {
  it("encodes every starter arrangement into a pose the authority accepts", () => {
    for (const id of STARTER_ARRANGEMENT_IDS) {
      const payload = encodeDisguiseState(createStarterArrangement(id));
      const decoded = decodeDisguiseWire(payload);
      expect(decoded.ok, `${id}: ${decoded.ok ? "" : decoded.issue}`).toBe(true);
    }
  });

  it("round-trips a posed disguise without losing anything the room can see", () => {
    const source = createStarterArrangement("compact");
    source.mapId = "curiosity_shop";
    source.root.position = [1.25, 0.5, -2];
    source.revision = 7;

    const returned = decodeDisguiseState(encodeDisguiseState(source));
    expect(returned).not.toBeNull();
    expect(returned?.root.position).toEqual([1.25, 0.5, -2]);
    expect(returned?.revision).toBe(7);
    expect(returned?.joints).toEqual(source.joints);
    expect(returned?.segments).toEqual(source.segments);
    expect(returned?.materials).toEqual(source.materials);
  });

  it("reports an illegal payload rather than throwing", () => {
    expect(decodeDisguiseState("not json at all")).toBeNull();
    expect(decodeDisguiseState("{}")).toBeNull();
  });

  it("refuses a pose whose joints leave the rig's order", () => {
    const scrambled = createStarterArrangement("upright");
    const [first, second] = [scrambled.joints[0], scrambled.joints[1]];
    if (first === undefined || second === undefined) throw new Error("rig has no joints");
    scrambled.joints[0] = second;
    scrambled.joints[1] = first;

    expect(decodeDisguiseState(encodeDisguiseState(scrambled))).toBeNull();
  });

  it("keeps the arrangement list the Forge and the fallback agree on", () => {
    const fallback: StarterArrangementId = "upright";
    expect(STARTER_ARRANGEMENT_IDS).toContain(fallback);
  });
});
