import { describe, expect, it } from "vitest";

import type {
  DecodedCompiledScene,
  GpuOccurrenceInstance,
  GpuPrototypeBatch,
} from "@naru3d/runtime-webgpu";

import { aggregateCoarseScene } from "../src/coarse-aggregation.js";

const identity = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function boxBatch(
  minimum: readonly [number, number, number],
  maximum: readonly [number, number, number],
  instances: readonly GpuOccurrenceInstance[],
): GpuPrototypeBatch {
  return {
    surfaceVertices: new Float32Array([
      ...minimum, -1, 0, 0,
      ...maximum, 1, 0, 0,
      minimum[0], maximum[1], minimum[2], 0, 1, 0,
    ]),
    surfaceIndices: new Uint32Array([0, 1, 2]),
    edgeVertices: new Float32Array([...minimum, ...maximum]),
    instances,
  };
}

function coarseScene(): DecodedCompiledScene {
  const translated = new Float32Array(identity);
  translated[12] = 10;
  const batches = [
    boxBatch([2, 4, 6], [4, 8, 12], [{ transform: identity, objectId: 1 }]),
    boxBatch([-1, -1, -1], [1, 1, 1], [{ transform: translated, objectId: 2 }]),
  ];
  return {
    gpuScene: { batches },
    bounds: { min: [2, 4, 6], max: [11, 8, 12] },
    hierarchy: {
      profile: "madi.experimental.gltf.1",
      nodeCount: 2,
      sceneId: "coarse-test",
      sourceFormat: "test",
      binaryUri: "scene.bin",
      binaryByteLength: 1,
      targetChunks: [],
      reducedChunks: [],
      entries: [],
      renderableOccurrences: 2,
      sharedMeshes: 2,
    },
    objectEvidence: [],
    batchEvidence: [10, 20].map((targetMeshIndex, batchIndex) => ({
      batchIndex,
      meshIndex: batchIndex + 100,
      targetMeshIndex,
      surfacePrimitiveIndex: 0,
      prototypeId: `prototype:${String(targetMeshIndex)}`,
    })),
    summary: {
      prototypeBatches: 2,
      partOccurrences: 2,
      triangles: 2,
      edgeSegments: 2,
      binaryBytes: 1,
      representation: "coarse",
    },
  };
}

describe("coarse AABB aggregation", () => {
  it("uses one canonical batch and one contiguous transform buffer", () => {
    const aggregated = aggregateCoarseScene(coarseScene());
    const batch = aggregated.gpuScene.batches[0];

    expect(aggregated.gpuScene.batches).toHaveLength(1);
    expect(batch?.surfaceIndices).toHaveLength(36);
    expect(batch?.edgeVertices).toHaveLength(72);
    expect(batch?.instances).toHaveLength(2);
    expect(aggregated.coarseInstanceTargetMeshIndexes).toEqual(new Uint32Array([10, 20]));
    expect(batch?.instances[0]?.transform.buffer).toBe(batch?.instances[1]?.transform.buffer);
    expect(batch?.instances[0]?.transform).toBeInstanceOf(Float64Array);
    expect(Array.from(batch?.instances[0]?.transform ?? [])).toEqual([
      2, 0, 0, 0,
      0, 4, 0, 0,
      0, 0, 6, 0,
      3, 6, 9, 1,
    ]);
    expect(Array.from(batch?.instances[1]?.transform ?? [])).toEqual([
      2, 0, 0, 0,
      0, 2, 0, 0,
      0, 0, 2, 0,
      10, 0, 0, 1,
    ]);
    expect(aggregated.summary).toMatchObject({
      prototypeBatches: 1,
      triangles: 12,
      edgeSegments: 12,
    });
  });

  it("retains large-coordinate residuals while composing coarse bounds", () => {
    const scene = coarseScene();
    const translated = Float64Array.from(identity);
    translated[12] = 10_000_000.000_25;
    const firstBatch = scene.gpuScene.batches[0];
    if (!firstBatch) throw new TypeError("Expected a coarse test batch.");
    const aggregated = aggregateCoarseScene({
      ...scene,
      gpuScene: {
        batches: [{ ...firstBatch, instances: [{ transform: translated, objectId: 1 }] }],
      },
      batchEvidence: [scene.batchEvidence[0]!],
    });

    expect(aggregated.gpuScene.batches[0]?.instances[0]?.transform[12])
      .toBe(10_000_003.000_25);
  });

  it("rejects target geometry", () => {
    const target = {
      ...coarseScene(),
      summary: { ...coarseScene().summary, representation: "target" as const },
    };
    expect(() => aggregateCoarseScene(target)).toThrow(/Only coarse geometry/u);
  });
});
