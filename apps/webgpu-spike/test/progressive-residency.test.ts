import { describe, expect, it } from "vitest";

import type {
  CompiledBatchEvidence,
  DecodedCompiledScene,
  GeometryRepresentation,
  GpuPrototypeBatch,
  ResidencyCost,
} from "@naru3d/runtime-webgpu";

import {
  estimateBatchDecodedBytes,
  estimateBatchGpuBytes,
  ProgressiveResidency,
} from "../src/progressive-residency.js";

function batch(objectId: number, triangles = 1): GpuPrototypeBatch {
  const indices = new Uint32Array(triangles * 3);
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    indices.set([0, 1, 2], triangle * 3);
  }
  return {
    surfaceVertices: new Float32Array([
      0, 0, 0, 0, 1, 0,
      1, 0, 0, 0, 1, 0,
      0, 1, 0, 0, 1, 0,
    ]),
    surfaceIndices: indices,
    edgeVertices: new Float32Array(),
    instances: [{ objectId, transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }],
  };
}

/**
 * Material groups of one prototype, as the decoder emits them: the same vertex
 * pool array handed to every group, with its own indices and instances.
 */
function materialGroups(
  objectIds: readonly number[],
  triangles = 1,
): readonly GpuPrototypeBatch[] {
  const [first, ...rest] = objectIds.map((objectId) => batch(objectId, triangles));
  if (!first) throw new Error("A prototype needs at least one material group.");
  return [first, ...rest.map((group) => ({ ...group, surfaceVertices: first.surfaceVertices }))];
}

function decoded(
  batches: readonly GpuPrototypeBatch[],
  targetMeshIndexes: readonly number[],
  representation: GeometryRepresentation = "target",
): DecodedCompiledScene {
  const primitivesPerMesh = new Map<number, number>();
  const batchEvidence: CompiledBatchEvidence[] = batches.map((_, batchIndex) => {
    const targetMeshIndex = targetMeshIndexes[batchIndex] ?? 0;
    // Repeating a target mesh means repeating its material groups, which the
    // compiler numbers as separate surface primitives of the same prototype.
    const surfacePrimitiveIndex = primitivesPerMesh.get(targetMeshIndex) ?? 0;
    primitivesPerMesh.set(targetMeshIndex, surfacePrimitiveIndex + 1);
    return {
      batchIndex,
      meshIndex: targetMeshIndex,
      targetMeshIndex,
      surfacePrimitiveIndex,
      prototypeId: `prototype:${String(targetMeshIndex)}`,
    };
  });
  return {
    gpuScene: { batches },
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    hierarchy: {
      profile: "madi.experimental.gltf.1",
      nodeCount: batches.length,
      sceneId: "test",
      sourceFormat: "test",
      binaryUri: "scene.bin",
      binaryByteLength: 0,
      targetChunks: [],
      reducedChunks: [],
      entries: [],
      renderableOccurrences: batches.length,
      sharedMeshes: batches.length,
    },
    objectEvidence: [],
    batchEvidence,
    summary: {
      prototypeBatches: batches.length,
      partOccurrences: batches.length,
      triangles: batches.reduce((total, value) => total + value.surfaceIndices.length / 3, 0),
      edgeSegments: 0,
      binaryBytes: 0,
      representation,
    },
  };
}

/** What the scheduler would charge for a chunk carrying these batches. */
function costOf(scene: DecodedCompiledScene): ResidencyCost {
  return scene.gpuScene.batches.reduce<ResidencyCost>(
    (total, value) => ({
      decodedBytes: total.decodedBytes + estimateBatchDecodedBytes(value),
      gpuBytes: total.gpuBytes + estimateBatchGpuBytes(value),
    }),
    { decodedBytes: 0, gpuBytes: 0 },
  );
}

describe("progressive residency", () => {
  it("replaces coarse batches atomically and keeps both tiers below budget", () => {
    const coarse = decoded([batch(1), batch(2)], [0, 1]);
    const targetMeshZero = decoded([batch(1, 20)], [0]);
    const targetMeshOneTooLarge = decoded([batch(2, 30)], [1]);
    const residency = new ProgressiveResidency(coarse, { decodedBytes: 800, gpuBytes: 800 });

    const promoted = residency.promote(targetMeshZero, { priority: 0 });
    expect(promoted.admitted).toBe(true);
    expect(promoted.entries.map(({ key }) => key)).toEqual(["0:0", "1:0"]);
    expect(promoted.triangles).toBe(21);
    expect(promoted.decodedBytes).toBeLessThanOrEqual(800);
    expect(promoted.gpuBytes).toBeLessThanOrEqual(800);

    const rejected = residency.promote(targetMeshOneTooLarge, { priority: 1 });
    expect(rejected.admitted).toBe(false);
    expect(rejected.entries.map(({ key }) => key)).toEqual(["0:0", "1:0"]);
    expect(rejected.triangles).toBe(21);
  });

  it("tags each resident entry with the representation its scene decoded", () => {
    const coarse = decoded([batch(1), batch(2)], [0, 1], "coarse");
    const residency = new ProgressiveResidency(coarse, { decodedBytes: 800, gpuBytes: 800 });
    expect(residency.current().entries.map(({ representation }) => representation)).toEqual([
      "coarse",
      "coarse",
    ]);

    const promoted = residency.promote(decoded([batch(1, 20)], [0]), { priority: 0 });
    expect(promoted.entries.map(({ key, representation }) => `${key}:${representation}`)).toEqual([
      "0:0:target",
      "1:0:coarse",
    ]);
  });

  it("refuses a chunk larger than the whole budget before it is fetched", () => {
    const residency = new ProgressiveResidency(decoded([batch(1), batch(2)], [0, 1]), {
      decodedBytes: 400,
      gpuBytes: 400,
    });
    const oversized = decoded([batch(2, 30)], [1]);
    const cost = costOf(oversized);

    expect(cost.decodedBytes).toBeGreaterThan(400);
    // No eviction order reaches it: its own bytes outlast every other group.
    expect(residency.mayAdmit(cost, 0)).toBe(false);
    expect(residency.mayAdmit(cost, 7)).toBe(false);
    expect(residency.promote(oversized, { priority: 0 }).admitted).toBe(false);
  });

  it("admits a chunk that fits the free headroom", () => {
    const residency = new ProgressiveResidency(decoded([batch(1), batch(2)], [0, 1]), {
      decodedBytes: 800,
      gpuBytes: 800,
    });
    const target = decoded([batch(1, 20)], [0]);

    expect(residency.mayAdmit(costOf(target), 0)).toBe(true);
    expect(residency.promote(target, { priority: 0 }).admitted).toBe(true);
  });

  it("refuses a chunk that outgrows the headroom with nothing colder to evict", () => {
    const residency = new ProgressiveResidency(decoded([batch(1), batch(2)], [0, 1]), {
      decodedBytes: 800,
      gpuBytes: 800,
    });
    expect(residency.promote(decoded([batch(1, 20)], [0]), { priority: 0 }).admitted).toBe(true);

    const colder = decoded([batch(2, 20)], [1]);
    expect(residency.mayAdmit(costOf(colder), 5)).toBe(false);
    expect(residency.promote(colder, { priority: 5 }).admitted).toBe(false);
  });

  it("admits a chunk hotter than a resident group the budget could evict", () => {
    const residency = new ProgressiveResidency(decoded([batch(1), batch(2)], [0, 1]), {
      decodedBytes: 800,
      gpuBytes: 800,
    });
    expect(residency.promote(decoded([batch(1, 20)], [0]), { priority: 9 }).admitted).toBe(true);

    const hotter = decoded([batch(2, 10)], [1]);
    expect(residency.mayAdmit(costOf(hotter), 0)).toBe(true);
    const promoted = residency.promote(hotter, { priority: 0 });
    expect(promoted.admitted).toBe(true);
    expect(promoted.evictedTargetMeshIndexes).toEqual([0]);
  });

  it("rejects an invalid priority rather than guessing at admission", () => {
    const residency = new ProgressiveResidency(decoded([batch(1)], [0]), {
      decodedBytes: 800,
      gpuBytes: 800,
    });
    expect(() => residency.mayAdmit({ decodedBytes: 4, gpuBytes: 4 }, -1)).toThrow(TypeError);
  });

  it("evicts colder detail for a selected target while retaining its coarse fallback", () => {
    const coarse = decoded([batch(1), batch(2)], [0, 1]);
    const firstTarget = decoded([batch(1, 20)], [0]);
    const selectedTarget = decoded([batch(2, 20)], [1]);
    const residency = new ProgressiveResidency(coarse, { decodedBytes: 800, gpuBytes: 800 });

    expect(residency.promote(firstTarget, { priority: 0 }).admitted).toBe(true);
    const selected = residency.promote(selectedTarget, { priority: 1, pin: true });

    expect(selected.admitted).toBe(true);
    expect(selected.evictedTargetMeshIndexes).toEqual([0]);
    expect(selected.targetMeshIndexes).toEqual([1]);
    expect(selected.pinnedTargetMeshIndexes).toEqual([1]);
    expect(selected.entries.map(({ key }) => key)).toEqual(["0:0", "1:0"]);
    expect(selected.triangles).toBe(21);
    expect(selected.decodedBytes).toBeLessThanOrEqual(800);
    expect(selected.gpuBytes).toBeLessThanOrEqual(800);
  });

  it("evicts detail made colder by a changed view priority", () => {
    const coarse = decoded([batch(1), batch(2)], [0, 1]);
    const firstTarget = decoded([batch(1, 20)], [0]);
    const secondTarget = decoded([batch(2, 20)], [1]);
    const residency = new ProgressiveResidency(coarse, { decodedBytes: 800, gpuBytes: 800 });

    expect(residency.promote(firstTarget, { priority: 0 }).admitted).toBe(true);
    residency.reprioritize([
      { targetMeshIndexes: [0], priority: 1 },
      { targetMeshIndexes: [1], priority: 0 },
    ]);
    const promoted = residency.promote(secondTarget, { priority: 0 });

    expect(promoted.admitted).toBe(true);
    expect(promoted.evictedTargetMeshIndexes).toEqual([0]);
    expect(promoted.targetMeshIndexes).toEqual([1]);
  });

  it("accounts for decoder payload and aligned GPU buffers separately", () => {
    const value = batch(1);
    expect(estimateBatchDecodedBytes(value)).toBe(180);
    expect(estimateBatchGpuBytes(value)).toBe(184);
  });

  it("keeps incremental totals equal to a full recount across admissions and evictions", () => {
    const coarseBatches = [batch(1), batch(2), batch(3)];
    const coarse = decoded(coarseBatches, [0, 1, 2]);
    const residency = new ProgressiveResidency(coarse, { decodedBytes: 1000, gpuBytes: 800 });
    const recount = (
      entries: readonly { readonly batch: GpuPrototypeBatch }[],
      promotedTargetMeshes: readonly number[],
    ): { decodedBytes: number; gpuBytes: number; triangles: number; edgeSegments: number } => ({
      decodedBytes:
        entries.reduce((total, { batch: value }) => total + estimateBatchDecodedBytes(value), 0) +
        promotedTargetMeshes.reduce(
          (total, mesh) => total + estimateBatchDecodedBytes(coarseBatches[mesh] as GpuPrototypeBatch),
          0,
        ),
      gpuBytes: entries.reduce(
        (total, { batch: value }) => total + estimateBatchGpuBytes(value),
        0,
      ),
      triangles: entries.reduce(
        (total, { batch: value }) => total + value.surfaceIndices.length / 3,
        0,
      ),
      edgeSegments: entries.reduce(
        (total, { batch: value }) => total + value.edgeVertices.length / 6,
        0,
      ),
    });
    const expectConsistent = (snapshot: ReturnType<ProgressiveResidency["current"]>): void => {
      expect({
        decodedBytes: snapshot.decodedBytes,
        gpuBytes: snapshot.gpuBytes,
        triangles: snapshot.triangles,
        edgeSegments: snapshot.edgeSegments,
      }).toEqual(recount(snapshot.entries, snapshot.targetMeshIndexes));
    };

    expectConsistent(residency.current());

    const admitted = residency.promote(decoded([batch(1, 20)], [0]), { priority: 1 });
    expect(admitted.admitted).toBe(true);
    expectConsistent(admitted);

    const evicting = residency.promote(decoded([batch(2, 20)], [1]), { priority: 2, pin: true });
    expect(evicting.admitted).toBe(true);
    expect(evicting.evictedTargetMeshIndexes).toEqual([0]);
    expectConsistent(evicting);

    const rejected = residency.promote(decoded([batch(3, 30)], [2]), { priority: 3 });
    expect(rejected.admitted).toBe(false);
    expectConsistent(rejected);
    expectConsistent(residency.current());
  });

  it("keeps incremental totals exact in aggregate-coarse mode", () => {
    const coarse = decoded([batch(9, 2)], [-1]);
    const residency = new ProgressiveResidency(
      coarse,
      { decodedBytes: 800, gpuBytes: 800 },
      { aggregateCoarse: true },
    );
    const expectConsistent = (snapshot: ReturnType<ProgressiveResidency["current"]>): void => {
      expect(snapshot.decodedBytes).toBe(
        snapshot.entries.reduce(
          (total, { batch: value }) => total + estimateBatchDecodedBytes(value),
          0,
        ),
      );
      expect(snapshot.triangles).toBe(
        snapshot.entries.reduce(
          (total, { batch: value }) => total + value.surfaceIndices.length / 3,
          0,
        ),
      );
    };

    expectConsistent(residency.promote(decoded([batch(1, 20)], [0]), { priority: 1 }));
    const selected = residency.promote(decoded([batch(2, 20)], [1]), { priority: 2, pin: true });
    expect(selected.evictedTargetMeshIndexes).toEqual([0]);
    expectConsistent(selected);
    expectConsistent(residency.current());
  });

  it("keeps an aggregated coarse batch while target groups are promoted and evicted", () => {
    const coarse = decoded([batch(1)], [-1]);
    const firstTarget = decoded([batch(1, 20)], [0]);
    const selectedTarget = decoded([batch(2, 20)], [1]);
    const residency = new ProgressiveResidency(
      coarse,
      { decodedBytes: 800, gpuBytes: 800 },
      { aggregateCoarse: true },
    );

    const first = residency.promote(firstTarget, { priority: 0 });
    expect(first.entries.map(({ key }) => key)).toEqual(["coarse:aggregate", "0:0"]);

    const selected = residency.promote(selectedTarget, { priority: 1, pin: true });
    expect(selected.admitted).toBe(true);
    expect(selected.evictedTargetMeshIndexes).toEqual([0]);
    expect(selected.targetMeshIndexes).toEqual([1]);
    expect(selected.entries.map(({ key }) => key)).toEqual(["coarse:aggregate", "1:0"]);
  });

  it("charges a shared vertex pool once and releases it with its last group", () => {
    const coarse = decoded([batch(1), batch(2)], [0, 1]);
    const base = new ProgressiveResidency(coarse, {
      decodedBytes: 4_096,
      gpuBytes: 4_096,
    }).current();
    const groups = materialGroups([10, 11, 12], 2);
    const residency = new ProgressiveResidency(coarse, {
      decodedBytes: 4_096,
      gpuBytes: 4_096,
    });

    const promoted = residency.promote(decoded(groups, [0, 0, 0]), { priority: 0 });
    expect(promoted.admitted).toBe(true);
    // Mesh 0 keeps its retained coarse fallback, three material groups
    // arrived, and the pool all three read is charged once: 72 pool bytes,
    // then 24 index and 96 instance bytes per group.
    expect(promoted.decodedBytes).toBe(base.decodedBytes + 72 + 3 * (24 + 96));
    expect(promoted.triangles).toBe(1 + 3 * 2);

    // Displacing the groups returns everything they took, the pool included.
    const replacement = batch(20);
    const restored = residency.promote(decoded([replacement], [0]), { priority: 0 });
    expect(restored.admitted).toBe(true);
    expect(restored.decodedBytes).toBe(
      base.decodedBytes + estimateBatchDecodedBytes(replacement),
    );
  });

  it("drops a departing group's own bytes and keeps the pool its siblings read", () => {
    const coarse = decoded([batch(1), batch(2)], [0, 1]);
    const groups = materialGroups([10, 11], 2);
    const residency = new ProgressiveResidency(coarse, {
      decodedBytes: 4_096,
      gpuBytes: 4_096,
    });
    const both = residency.promote(decoded(groups, [0, 0]), { priority: 0 });

    // Re-promoting mesh 0 with one of the two groups drops that group's own
    // bytes and keeps the pool, which the surviving group still reads.
    const one = residency.promote(decoded([groups[0] as GpuPrototypeBatch], [0]), {
      priority: 0,
    });
    expect(one.admitted).toBe(true);
    expect(both.decodedBytes - one.decodedBytes).toBe(24 + 96);
  });
});
