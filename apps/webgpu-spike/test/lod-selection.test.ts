import { describe, expect, it } from "vitest";

import {
  ReducedLodSelector,
  defaultReducedLodThresholds,
  effectiveLevelChunk,
  planReducedChunks,
  projectedErrorPixels,
  resolveReducedLodThresholds,
} from "../src/lod-selection.js";
import { OrthographicOrbitCamera } from "../src/view.js";

describe("projected reduced-level error", () => {
  it("divides the declared deviation by the world size of a pixel", () => {
    expect(projectedErrorPixels(0.001, 0.002)).toBeCloseTo(0.5, 12);
    expect(projectedErrorPixels(0.001, 0.0005)).toBeCloseTo(2, 12);
  });

  it("refuses a scale or a deviation it cannot project", () => {
    expect(() => projectedErrorPixels(0.001, 0)).toThrow(RangeError);
    expect(() => projectedErrorPixels(0.001, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => projectedErrorPixels(Number.NaN, 0.002)).toThrow(RangeError);
    expect(() => projectedErrorPixels(-0.001, 0.002)).toThrow(RangeError);
  });
});

describe("reduced chunk substitution plan", () => {
  const chunk = (id: string, prototypeIds: readonly string[]) => ({ id, prototypeIds });

  it("pairs a target chunk with the reduced chunk over the same prototypes", () => {
    const plan = planReducedChunks(
      [chunk("target:0000:plate", ["plate"]), chunk("target:0001:bracket", ["bracket"])],
      [chunk("reduced:0000:plate", ["plate"]), chunk("reduced:0001:bracket", ["bracket"])],
    );

    expect([...plan.substitutes.keys()]).toEqual(["target:0000:plate", "target:0001:bracket"]);
    expect(plan.substitutes.get("target:0000:plate")?.id).toBe("reduced:0000:plate");
    expect(plan.exactOnly).toEqual([]);
  });

  it("ignores the order prototypes are listed in", () => {
    const plan = planReducedChunks(
      [chunk("target:0000:pair", ["b", "a"])],
      [chunk("reduced:0000:pair", ["a", "b"])],
    );

    expect(plan.substitutes.get("target:0000:pair")?.id).toBe("reduced:0000:pair");
  });

  it("reports a chunk the compiler retained exactly", () => {
    const plan = planReducedChunks(
      [chunk("target:0000:plate", ["plate"]), chunk("target:0001:shell", ["shell"])],
      [chunk("reduced:0000:plate", ["plate"])],
    );

    expect(plan.exactOnly).toEqual(["target:0001:shell"]);
    expect(plan.substitutes.has("target:0001:shell")).toBe(false);
  });

  it("refuses a partial or a widened stand-in rather than misdrawing it", () => {
    const plan = planReducedChunks(
      [chunk("target:0000:pair", ["a", "b"]), chunk("target:0001:single", ["c"])],
      [chunk("reduced:0000:half", ["a"]), chunk("reduced:0001:wide", ["c", "d"])],
    );

    expect(plan.substitutes.size).toBe(0);
    expect(plan.exactOnly).toEqual(["target:0000:pair", "target:0001:single"]);
  });

  it("drops an ambiguous stand-in instead of choosing between duplicates", () => {
    const plan = planReducedChunks(
      [chunk("target:0000:plate", ["plate"])],
      [chunk("reduced:0000:plate", ["plate"]), chunk("reduced:0001:plate", ["plate"])],
    );

    expect(plan.substitutes.size).toBe(0);
    expect(plan.exactOnly).toEqual(["target:0000:plate"]);
  });

  it("plans nothing for a package compiled without the reduced level", () => {
    const plan = planReducedChunks([chunk("target:0000:plate", ["plate"])], []);

    expect(plan.substitutes.size).toBe(0);
    expect(plan.exactOnly).toEqual(["target:0000:plate"]);
  });
});

describe("reduced level thresholds", () => {
  it("defaults to the band ADR-0025 states", () => {
    expect(defaultReducedLodThresholds).toEqual({ admitPixels: 1, replacePixels: 1.5 });
    expect(resolveReducedLodThresholds()).toEqual(defaultReducedLodThresholds);
    expect(resolveReducedLodThresholds(0.5)).toEqual({ admitPixels: 0.5, replacePixels: 1.5 });
  });

  it("refuses a band that would pin a level or flip every frame", () => {
    expect(() => resolveReducedLodThresholds(0)).toThrow(RangeError);
    expect(() => resolveReducedLodThresholds(1, 0)).toThrow(RangeError);
    expect(() => resolveReducedLodThresholds(1.5, 1)).toThrow(RangeError);
    expect(() => resolveReducedLodThresholds(Number.NaN)).toThrow(RangeError);
  });
});

describe("hysteretic level selection", () => {
  it("starts on the exact level until a measurement earns the reduced one", () => {
    const selector = new ReducedLodSelector(0.001);
    expect(selector.selection()).toEqual({
      level: "target",
      projectedErrorPixels: undefined,
      metresPerPixel: undefined,
    });

    // 0.001 m deviation over 0.002 m/px is 0.5 px, inside the 1.0 px band.
    expect(selector.update(0.002)).toBe(true);
    expect(selector.selection().level).toBe("reduced");
    expect(selector.selection().projectedErrorPixels).toBeCloseTo(0.5, 12);
  });

  it("keeps the current level inside the hysteresis gap", () => {
    const selector = new ReducedLodSelector(0.001);
    // 1.2 px: above the admit threshold, so a target view stays exact.
    expect(selector.update(0.001 / 1.2)).toBe(false);
    expect(selector.selection().level).toBe("target");

    selector.update(0.002);
    expect(selector.selection().level).toBe("reduced");
    // The same 1.2 px measurement now keeps the reduced level instead.
    expect(selector.update(0.001 / 1.2)).toBe(false);
    expect(selector.selection().level).toBe("reduced");
  });

  it("replaces the reduced level once the error passes the upper threshold", () => {
    const selector = new ReducedLodSelector(0.001);
    selector.update(0.002);
    expect(selector.selection().level).toBe("reduced");

    // Exactly 1.5 px is still admissible; the contract replaces past it.
    expect(selector.update(0.001 / 1.5)).toBe(false);
    expect(selector.selection().level).toBe("reduced");
    expect(selector.update(0.001 / 1.6)).toBe(true);
    expect(selector.selection().level).toBe("target");
  });

  it("ignores the camera's no-viewport sentinel", () => {
    const selector = new ReducedLodSelector(0.001);
    selector.update(0.002);
    const before = selector.selection();
    expect(selector.update(Number.POSITIVE_INFINITY)).toBe(false);
    expect(selector.update(0)).toBe(false);
    expect(selector.selection()).toEqual(before);
  });

  it("refuses a package that declares no usable deviation", () => {
    expect(() => new ReducedLodSelector(Number.NaN)).toThrow(RangeError);
    expect(() => new ReducedLodSelector(-1)).toThrow(RangeError);
    expect(() => new ReducedLodSelector(0.001, { admitPixels: 2, replacePixels: 1 })).toThrow(
      RangeError,
    );
  });

  it("follows the orthographic camera's own scale as it zooms", () => {
    const camera = new OrthographicOrbitCamera({ min: [0, 0, 0], max: [10, 10, 10] });
    const selector = new ReducedLodSelector(0.001);
    const aspect = 1.32;

    // Fitted to a 10 m box in a 1000 px viewport, one pixel spans centimetres,
    // so a millimetre of declared deviation is far inside the admit band.
    expect(selector.update(camera.metresPerPixel(aspect, 1000))).toBe(true);
    expect(selector.selection().level).toBe("reduced");

    // Zooming in shrinks the world size of a pixel; the camera clamps at 100x.
    camera.zoomBy(-5000);
    expect(selector.update(camera.metresPerPixel(aspect, 1000))).toBe(true);
    expect(selector.selection().level).toBe("target");
    expect(selector.selection().projectedErrorPixels ?? 0).toBeGreaterThan(1.5);
  });
});

describe("selected-object pinning over the level", () => {
  const plate = { id: "target:0000:plate", prototypeIds: ["plate"], meshIndexes: [0, 1] };
  const bracket = { id: "target:0001:bracket", prototypeIds: ["bracket"], meshIndexes: [2] };
  const plan = planReducedChunks(
    [plate, bracket],
    [
      { id: "reduced:0000:plate", prototypeIds: ["plate"], meshIndexes: [0, 1] },
      { id: "reduced:0001:bracket", prototypeIds: ["bracket"], meshIndexes: [2] },
    ],
  );

  it("substitutes every chunk while nothing is pinned", () => {
    expect(effectiveLevelChunk(plate, "reduced", plan).id).toBe("reduced:0000:plate");
    expect(effectiveLevelChunk(bracket, "reduced", plan).id).toBe("reduced:0001:bracket");
  });

  it("keeps a chunk carrying a pinned target mesh exact", () => {
    const pinned = new Set([1]);
    const isPinned = (meshIndexes: readonly number[]) =>
      meshIndexes.some((meshIndex) => pinned.has(meshIndex));

    expect(effectiveLevelChunk(plate, "reduced", plan, isPinned)).toBe(plate);
    expect(effectiveLevelChunk(bracket, "reduced", plan, isPinned).id).toBe(
      "reduced:0001:bracket",
    );

    // Selecting inside the other chunk moves the pin with the selection.
    pinned.clear();
    pinned.add(2);
    expect(effectiveLevelChunk(plate, "reduced", plan, isPinned).id).toBe("reduced:0000:plate");
    expect(effectiveLevelChunk(bracket, "reduced", plan, isPinned)).toBe(bracket);
  });

  it("draws the exact chunk whenever the selector is on the target level", () => {
    expect(effectiveLevelChunk(plate, "target", plan, () => false)).toBe(plate);
  });

  it("keeps a chunk the plan could not pair exact at either level", () => {
    const shell = { id: "target:0002:shell", prototypeIds: ["shell"], meshIndexes: [3] };
    const partial = planReducedChunks([plate, shell], [
      { id: "reduced:0000:plate", prototypeIds: ["plate"], meshIndexes: [0, 1] },
    ]);

    expect(partial.exactOnly).toEqual(["target:0002:shell"]);
    expect(effectiveLevelChunk(shell, "reduced", partial, () => false)).toBe(shell);
  });
});
