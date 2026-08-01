import { describe, expect, it } from "vitest";

import { SEGMENT_BONES } from "../../src/mimic/rig";
import {
  clampSegmentForm,
  createDefaultSegmentForm,
  createDefaultSegmentForms,
  createResolvedSegmentForm,
  FLATTEN_MIN_DEPTH_SCALE,
  isValidSegmentForm,
  normalizedFromScale,
  resolveSegmentForm,
  segmentRange,
  SEGMENT_PROFILE_IDS,
  TAPER_TIP_RANGE,
  type SegmentFormState,
} from "../../src/mimic/segmentForm";

describe("segment defaults", () => {
  it("resolves every default form to the authored rest scale", () => {
    const resolved = createResolvedSegmentForm();
    for (const bone of SEGMENT_BONES) {
      const form = createDefaultSegmentForm(bone);
      resolveSegmentForm(bone, form, resolved);
      expect(resolved.lengthScale, bone).toBeCloseTo(1, 10);
      expect(resolved.widthScale, bone).toBeCloseTo(1, 10);
      expect(resolved.depthScale, bone).toBeCloseTo(1, 10);
      expect(resolved.tipScale, bone).toBeCloseTo(1, 10);
      expect(resolved.twistDeg, bone).toBe(0);
    }
  });

  it("provides one default form per segment slot", () => {
    const forms = createDefaultSegmentForms();
    expect(forms).toHaveLength(SEGMENT_BONES.length);
    expect(forms.every(isValidSegmentForm)).toBe(true);
  });

  it("keeps every authored range straddling the rest scale", () => {
    for (const bone of SEGMENT_BONES) {
      const range = segmentRange(bone);
      expect(range.minLengthScale, bone).toBeLessThan(1);
      expect(range.maxLengthScale, bone).toBeGreaterThan(1);
      expect(range.minWidthScale, bone).toBeLessThan(1);
      expect(range.maxWidthScale, bone).toBeGreaterThan(1);
      expect(range.minDepthScale, bone).toBeLessThan(1);
      expect(range.maxDepthScale, bone).toBeGreaterThan(1);
      expect(SEGMENT_PROFILE_IDS).toContain(range.defaultProfileId);
    }
  });
});

describe("normalized mapping", () => {
  it("hits the range endpoints at 0 and 1", () => {
    const resolved = createResolvedSegmentForm();
    const range = segmentRange("torso_lower");

    const low = createDefaultSegmentForm("torso_lower");
    low.length = 0;
    low.width = 0;
    low.depth = 0;
    resolveSegmentForm("torso_lower", low, resolved);
    expect(resolved.lengthScale).toBeCloseTo(range.minLengthScale, 10);
    expect(resolved.widthScale).toBeCloseTo(range.minWidthScale, 10);

    const high = createDefaultSegmentForm("torso_lower");
    high.length = 1;
    high.width = 1;
    high.depth = 1;
    resolveSegmentForm("torso_lower", high, resolved);
    expect(resolved.lengthScale).toBeCloseTo(range.maxLengthScale, 10);
    expect(resolved.widthScale).toBeCloseTo(range.maxWidthScale, 10);
  });

  it("round-trips a scale through normalizedFromScale", () => {
    const resolved = createResolvedSegmentForm();
    const range = segmentRange("neck");
    const form = createDefaultSegmentForm("neck");
    form.length = normalizedFromScale(2.4, range.minLengthScale, range.maxLengthScale);
    resolveSegmentForm("neck", form, resolved);
    expect(resolved.lengthScale).toBeCloseTo(2.4, 10);
  });

  it("maps flatten onto depth and taper onto the tip", () => {
    const resolved = createResolvedSegmentForm();
    const form = createDefaultSegmentForm("hand_L");
    form.flatten = 1;
    form.taper = -1;
    resolveSegmentForm("hand_L", form, resolved);
    expect(resolved.depthScale).toBeCloseTo(FLATTEN_MIN_DEPTH_SCALE, 10);
    expect(resolved.tipScale).toBeCloseTo(1 - TAPER_TIP_RANGE, 10);
  });

  it("maps twist onto the segment's authored degree range", () => {
    const resolved = createResolvedSegmentForm();
    const form = createDefaultSegmentForm("torso_upper");
    form.twist = 1;
    resolveSegmentForm("torso_upper", form, resolved);
    expect(resolved.twistDeg).toBeCloseTo(segmentRange("torso_upper").maxTwistDeg, 10);

    form.twist = -1;
    resolveSegmentForm("torso_upper", form, resolved);
    expect(resolved.twistDeg).toBeCloseTo(-segmentRange("torso_upper").maxTwistDeg, 10);
  });
});

describe("clamping", () => {
  it("pulls out-of-range values back into the legal box", () => {
    const form: SegmentFormState = {
      length: 5,
      width: -3,
      depth: 1.4,
      flatten: 9,
      taper: -8,
      roundness: 2,
      twist: 4,
      profileId: "capsule",
    };
    clampSegmentForm(form);
    expect(form).toEqual({
      length: 1,
      width: 0,
      depth: 1,
      flatten: 1,
      taper: -1,
      roundness: 1,
      twist: 1,
      profileId: "capsule",
    });
    expect(isValidSegmentForm(form)).toBe(true);
  });

  it("replaces non-finite values with the neutral setting", () => {
    const form = createDefaultSegmentForm("thigh_L");
    form.length = Number.NaN;
    form.taper = Number.POSITIVE_INFINITY;
    form.twist = Number.NEGATIVE_INFINITY;
    clampSegmentForm(form);
    expect(form.length).toBe(0.5);
    expect(form.taper).toBe(0);
    expect(form.twist).toBe(0);
    expect(isValidSegmentForm(form)).toBe(true);
  });

  it("replaces an unknown profile with a known one", () => {
    const form = createDefaultSegmentForm("foot_L");
    const broken = form as unknown as { profileId: string };
    broken.profileId = "spikes";
    expect(isValidSegmentForm(form)).toBe(false);
    clampSegmentForm(form);
    expect(SEGMENT_PROFILE_IDS).toContain(form.profileId);
    expect(isValidSegmentForm(form)).toBe(true);
  });

  it("resolves a corrupted form without producing NaN", () => {
    const resolved = createResolvedSegmentForm();
    const form = createDefaultSegmentForm("neck");
    form.length = Number.NaN;
    form.width = Number.POSITIVE_INFINITY;
    form.flatten = Number.NaN;
    form.twist = Number.NaN;
    form.taper = Number.NaN;
    resolveSegmentForm("neck", form, resolved);
    expect(Number.isFinite(resolved.lengthScale)).toBe(true);
    expect(Number.isFinite(resolved.widthScale)).toBe(true);
    expect(Number.isFinite(resolved.depthScale)).toBe(true);
    expect(Number.isFinite(resolved.twistDeg)).toBe(true);
    expect(Number.isFinite(resolved.tipScale)).toBe(true);
  });
});
