import { describe, expect, it } from "vitest";

import type { GpuPrototypeBatch, GpuScene } from "@naru3d/runtime-webgpu";

import { hiddenHierarchyNodeIndices, OccurrenceVisibility } from "../src/visibility.js";

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function batch(objectIds: readonly number[]): GpuPrototypeBatch {
  return {
    surfaceVertices: new Float32Array(),
    surfaceIndices: new Uint32Array(),
    edgeVertices: new Float32Array(),
    instances: objectIds.map((objectId) => ({ transform: identity, objectId })),
  };
}

function scene(): GpuScene {
  return { batches: [batch([1, 2]), batch([3])] };
}

describe("occurrence visibility", () => {
  it("collects the hierarchy rows a review action hid", () => {
    const hidden = hiddenHierarchyNodeIndices(
      [
        { nodeIndex: 10, objectId: 1 },
        { nodeIndex: 20, objectId: 2 },
        { nodeIndex: 30, objectId: 3 },
      ],
      (objectId) => objectId === 1,
    );

    expect(Array.from(hidden)).toEqual([20, 30]);
  });

  it("builds full dense tables initially", () => {
    const visibility = new OccurrenceVisibility(scene());

    expect(Array.from(visibility.counts)).toEqual([2, 1]);
    expect(Array.from(visibility.indicesByBatch[0] ?? [])).toEqual([0, 1]);
    expect(visibility.state()).toEqual({
      mode: "all",
      totalOccurrences: 3,
      visibleOccurrences: 3,
      hiddenOccurrences: 0,
    });
  });

  it("hides one occurrence and reuses the allocated tables", () => {
    const visibility = new OccurrenceVisibility(scene());
    const firstTable = visibility.indicesByBatch[0];
    const counts = visibility.counts;

    visibility.hide(1);

    expect(visibility.indicesByBatch[0]).toBe(firstTable);
    expect(visibility.counts).toBe(counts);
    expect(Array.from(visibility.counts)).toEqual([1, 1]);
    expect(visibility.indicesByBatch[0]?.[0]).toBe(1);
    expect(visibility.isVisible(1)).toBe(false);
    expect(visibility.state().mode).toBe("hidden");
  });

  it("isolates across prototypes and restores all occurrences", () => {
    const visibility = new OccurrenceVisibility(scene());

    visibility.isolate(3);
    expect(Array.from(visibility.counts)).toEqual([0, 1]);
    expect(visibility.state()).toEqual({
      mode: "isolated",
      totalOccurrences: 3,
      visibleOccurrences: 1,
      hiddenOccurrences: 2,
      isolatedObjectId: 3,
    });

    visibility.showAll();
    expect(Array.from(visibility.counts)).toEqual([2, 1]);
    expect(visibility.state().mode).toBe("all");
  });

  it("rejects unknown occurrence IDs", () => {
    const visibility = new OccurrenceVisibility(scene());
    expect(() => visibility.hide(99)).toThrow(/Unknown scene object ID 99/u);
    expect(() => visibility.isolate(0)).toThrow(/Unknown scene object ID 0/u);
  });

  it("counts and filters material-split occurrences once", () => {
    const visibility = new OccurrenceVisibility({
      batches: [batch([1, 2]), batch([1])],
      sharedObjectIdsAcrossBatches: true,
    });

    expect(visibility.state().totalOccurrences).toBe(2);
    expect(visibility.state().visibleOccurrences).toBe(2);
    visibility.hide(1);
    expect(Array.from(visibility.counts)).toEqual([1, 0]);
    expect(visibility.state()).toMatchObject({
      visibleOccurrences: 1,
      hiddenOccurrences: 1,
    });
  });

  it("preserves hidden and isolated intent across a replacement scene", () => {
    const first = new OccurrenceVisibility(scene());
    first.hide(1);
    const hidden = first.snapshot();
    const replacement = new OccurrenceVisibility(scene());

    replacement.restore(hidden);
    expect(replacement.state()).toMatchObject({ mode: "hidden", visibleOccurrences: 2 });
    expect(replacement.isVisible(1)).toBe(false);

    first.isolate(3);
    replacement.restore(first.snapshot());
    expect(replacement.state()).toMatchObject({
      mode: "isolated",
      visibleOccurrences: 1,
      isolatedObjectId: 3,
    });
  });

  it("combines residency masking with user visibility", () => {
    const visibility = new OccurrenceVisibility(
      { batches: [batch([1, 2]), batch([1])], sharedObjectIdsAcrossBatches: true },
      (batchIndex, instanceIndex) => batchIndex !== 0 || instanceIndex !== 0,
    );

    expect(Array.from(visibility.counts)).toEqual([1, 1]);
    expect(visibility.state()).toMatchObject({
      totalOccurrences: 2,
      visibleOccurrences: 2,
    });
    visibility.hide(1);
    expect(Array.from(visibility.counts)).toEqual([1, 0]);
    expect(visibility.state().visibleOccurrences).toBe(1);
  });
});

describe("residency visibility updates", () => {
  const coarseBatch = batch([1, 2, 3]);
  const maskPromoted = (promoted: readonly number[]) => {
    const masked = new Set(promoted);
    return (batchIndex: number, instanceIndex: number): boolean =>
      batchIndex !== 0 || !masked.has(instanceIndex);
  };

  it("reuses unchanged tables and recomputes only new and filter-changed batches", () => {
    const initial = new OccurrenceVisibility(
      { batches: [coarseBatch], sharedObjectIdsAcrossBatches: true },
      maskPromoted([]),
    );
    const coarseTable = initial.indicesByBatch[0];
    const targetOne = batch([1]);

    const first = OccurrenceVisibility.forResidencyUpdate(
      initial,
      { batches: [coarseBatch, targetOne], sharedObjectIdsAcrossBatches: true },
      maskPromoted([0]),
      [0],
    );
    expect(first.changedBatchIndexes).toEqual([0, 1]);
    expect(first.visibility.indicesByBatch[0]).toBe(coarseTable);
    expect(Array.from(first.visibility.counts)).toEqual([2, 1]);
    expect(first.visibility.state()).toMatchObject({
      totalOccurrences: 3,
      visibleOccurrences: 3,
    });

    const targetTable = first.visibility.indicesByBatch[1];
    const targetTwo = batch([2]);
    const second = OccurrenceVisibility.forResidencyUpdate(
      first.visibility,
      { batches: [coarseBatch, targetOne, targetTwo], sharedObjectIdsAcrossBatches: true },
      maskPromoted([0, 1]),
      [0],
    );
    expect(second.changedBatchIndexes).toEqual([0, 2]);
    expect(second.visibility.indicesByBatch[1]).toBe(targetTable);
    expect(Array.from(second.visibility.counts)).toEqual([1, 1, 1]);
    expect(second.visibility.state().visibleOccurrences).toBe(3);
  });

  it("preserves hidden and isolated intent across residency updates", () => {
    const initial = new OccurrenceVisibility(
      { batches: [coarseBatch], sharedObjectIdsAcrossBatches: true },
      maskPromoted([]),
    );
    initial.hide(2);

    const hidden = OccurrenceVisibility.forResidencyUpdate(
      initial,
      { batches: [coarseBatch, batch([2])], sharedObjectIdsAcrossBatches: true },
      maskPromoted([1]),
      [0],
    );
    expect(hidden.visibility.isVisible(2)).toBe(false);
    expect(Array.from(hidden.visibility.counts)).toEqual([2, 0]);
    expect(hidden.visibility.state()).toMatchObject({
      mode: "hidden",
      visibleOccurrences: 2,
    });

    hidden.visibility.isolate(3);
    const isolated = OccurrenceVisibility.forResidencyUpdate(
      hidden.visibility,
      { batches: [coarseBatch], sharedObjectIdsAcrossBatches: true },
      maskPromoted([]),
      [0],
    );
    expect(isolated.visibility.state()).toMatchObject({
      mode: "isolated",
      isolatedObjectId: 3,
    });
    expect(Array.from(isolated.visibility.counts)).toEqual([1]);
  });

  it("keeps a storey scope across residency updates and leaves snapshots untouched", () => {
    const initial = new OccurrenceVisibility(
      { batches: [coarseBatch], sharedObjectIdsAcrossBatches: true },
      maskPromoted([]),
    );
    initial.setScope(new Set([1, 2]));
    expect(initial.isVisible(3)).toBe(false);
    expect(Array.from(initial.counts)).toEqual([2]);
    expect(initial.state()).toEqual({
      mode: "all",
      totalOccurrences: 3,
      visibleOccurrences: 2,
      hiddenOccurrences: 1,
      scopedOccurrences: 2,
    });
    expect(initial.snapshot()).toEqual({ hiddenObjectIds: [] });

    initial.hide(1);
    const updated = OccurrenceVisibility.forResidencyUpdate(
      initial,
      { batches: [coarseBatch, batch([2]), batch([3])], sharedObjectIdsAcrossBatches: true },
      maskPromoted([1, 2]),
      [0],
    );
    expect(updated.visibility.scope()).toBe(initial.scope());
    expect(Array.from(updated.visibility.counts)).toEqual([0, 1, 0]);
    expect(updated.visibility.state()).toMatchObject({ mode: "hidden", scopedOccurrences: 2 });

    updated.visibility.restore(updated.visibility.snapshot());
    expect(updated.visibility.isVisible(3)).toBe(false);

    updated.visibility.setScope(undefined);
    expect(Array.from(updated.visibility.counts)).toEqual([0, 1, 1]);
    expect(updated.visibility.state().scopedOccurrences).toBeUndefined();
    expect(() => updated.visibility.setScope(new Set([42]))).toThrow(/Unknown scene object ID 42/u);
  });

  it("rejects object IDs outside the established scene universe", () => {
    const initial = new OccurrenceVisibility(
      { batches: [coarseBatch], sharedObjectIdsAcrossBatches: true },
      maskPromoted([]),
    );

    expect(() =>
      OccurrenceVisibility.forResidencyUpdate(
        initial,
        { batches: [coarseBatch, batch([99])], sharedObjectIdsAcrossBatches: true },
        maskPromoted([0]),
        [0],
      ),
    ).toThrow(/Unknown scene object ID 99/u);
  });
});
