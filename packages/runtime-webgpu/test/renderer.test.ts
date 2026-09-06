import { describe, expect, it } from "vitest";

import {
  defaultFallbackDepthOffset,
  normalizeSectionPlane,
  rebaseSectionPlane,
  resolveFallbackDepthOffset,
} from "../src/index.js";

describe("WebGPU section plane", () => {
  it("normalizes the plane equation without changing its half-space", () => {
    expect(normalizeSectionPlane({ normal: [0, 0, 4], offset: 12 })).toEqual({
      normal: [0, 0, 1],
      offset: 3,
    });
  });

  it("rejects non-finite and zero-length planes", () => {
    expect(() => normalizeSectionPlane({ normal: [0, 0, 0], offset: 1 })).toThrow(
      /must be non-zero/u,
    );
    expect(() => normalizeSectionPlane({ normal: [1, 0, 0], offset: Number.NaN })).toThrow(
      /must be finite/u,
    );
  });

  it("rebases world-space clipping around a large camera origin", () => {
    const world = normalizeSectionPlane({
      normal: [1, 0, 0],
      offset: 10_000_000.000_25,
    });
    expect(rebaseSectionPlane(world, [10_000_000, -7_000_000, 3_000_000])).toEqual({
      normal: [1, 0, 0],
      offset: 0.000_250_000_506_639_480_6,
    });
  });
});

describe("coarse fallback depth offset", () => {
  it("defaults to one 16-bit depth quantum behind resident target detail", () => {
    expect(defaultFallbackDepthOffset).toBe(1 / 65536);
    expect(resolveFallbackDepthOffset(undefined)).toBe(defaultFallbackDepthOffset);
  });

  it("accepts zero (offset disabled) and any finite offset below one", () => {
    expect(resolveFallbackDepthOffset(0)).toBe(0);
    expect(resolveFallbackDepthOffset(0.5)).toBe(0.5);
    expect(resolveFallbackDepthOffset(1 / 1024)).toBe(1 / 1024);
  });

  it("rejects non-finite, negative, and out-of-range offsets instead of guessing", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1e-6, 1, 2]) {
      expect(() => resolveFallbackDepthOffset(value)).toThrow(RangeError);
    }
  });
});
