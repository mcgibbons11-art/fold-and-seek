import { describe, expect, it } from "vitest";

import {
  inspectorActionForFrame,
} from "../../src/inspector/InspectorAvatar";
import type { InspectorBodyFrame } from "../../src/inspector/InspectorBody";

const STILL: InspectorBodyFrame = {
  speedMps: 0,
  speedCapMps: 1,
  airborne: false,
  climbing: false,
  landingSpeed: 0,
  pitch: 0,
  aimAmount: 0,
};

describe("authored Inspector action selection", () => {
  it("moves from rifle idle into running at the first meaningful movement", () => {
    expect(inspectorActionForFrame(STILL)).toBe("rifle-idle");
    expect(inspectorActionForFrame({ ...STILL, speedMps: 0.04 })).toBe("rifle-idle");
    expect(inspectorActionForFrame({ ...STILL, speedMps: 0.06 })).toBe("run");
  });

  it("gives airborne and climbing actions priority over ground speed", () => {
    expect(inspectorActionForFrame({ ...STILL, speedMps: 1, airborne: true })).toBe("jump");
    expect(
      inspectorActionForFrame({ ...STILL, speedMps: 1, airborne: true, climbing: true }),
    ).toBe("climb");
  });
});
