import { describe, expect, it } from "vitest";

import { compiledSceneTransferables } from "@naru3d/runtime-webgpu";
import type { DecodedCompiledScene } from "@naru3d/runtime-webgpu";

import { adoptTransitScene, transitSceneForResponse } from "../src/geometry-transfer.js";

function decodedScene(surfaceVertices = new Float32Array()): DecodedCompiledScene {
  return {
    gpuScene: {
      batches: [
        {
          surfaceVertices,
          surfaceIndices: new Uint32Array(),
          edgeVertices: new Float32Array(),
          instances: [],
        },
      ],
    },
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    hierarchy: {
      profile: "madi.experimental.gltf.1",
      nodeCount: 0,
      sceneId: "test",
      sourceFormat: "test",
      binaryUri: "scene.bin",
      binaryByteLength: 0,
      targetChunks: [],
      reducedChunks: [],
      entries: [],
      renderableOccurrences: 0,
      sharedMeshes: 0,
    },
    objectEvidence: [],
    batchEvidence: [],
    summary: {
      prototypeBatches: 1,
      partOccurrences: 0,
      triangles: 0,
      edgeSegments: 0,
      binaryBytes: 0,
      representation: "target",
    },
  };
}

describe("geometry transfer protocol", () => {
  it("omits the hierarchy from decode responses without copying payload fields", () => {
    const scene = decodedScene();
    const transit = transitSceneForResponse(scene);

    expect("hierarchy" in transit).toBe(false);
    expect(transit.gpuScene).toBe(scene.gpuScene);
    expect(transit.batchEvidence).toBe(scene.batchEvidence);
    expect(transit.summary).toBe(scene.summary);
  });

  it("reattaches the hierarchy the Worker posted when it parsed the document", () => {
    const scene = decodedScene();

    const adopted = adoptTransitScene(transitSceneForResponse(scene), scene.hierarchy);

    expect(adopted.hierarchy).toBe(scene.hierarchy);
    expect(adopted.gpuScene).toBe(scene.gpuScene);
  });

  it("keeps sibling material groups on one vertex pool across the Worker boundary", () => {
    // The decoder hands one prototype's material groups the identical array
    // and the residency set charges the pool by that identity, so the
    // structured clone postMessage performs has to preserve it -- with the
    // transfer list `compiledSceneTransferables` builds, which lists each
    // buffer once, as well as without one.
    const pool = new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0]);
    const decoded = decodedScene(pool);
    const [group] = decoded.gpuScene.batches;
    if (!group) throw new Error("The decoded scene has no batch.");
    const scene = {
      ...decoded,
      gpuScene: {
        ...decoded.gpuScene,
        batches: [group, { ...group, surfaceIndices: new Uint32Array([0, 1, 0]) }],
      },
    };
    const transit = transitSceneForResponse(scene);
    const transferables = compiledSceneTransferables(scene);
    expect(transferables.filter((buffer) => buffer === pool.buffer)).toHaveLength(1);

    const poolLength = pool.length;
    for (const clone of [
      structuredClone(transit),
      // Transferring detaches `pool`, so nothing may read it after this.
      structuredClone(transit, { transfer: transferables }),
    ]) {
      const [first, second] = clone.gpuScene.batches;
      expect(first?.surfaceVertices).toHaveLength(poolLength);
      expect(second?.surfaceVertices).toBe(first?.surfaceVertices);
    }
  });

  it("rejects a decode response that arrives before the hierarchy is known", () => {
    const transit = transitSceneForResponse(decodedScene());

    expect(() => adoptTransitScene(transit, undefined)).toThrow(
      /omitted the scene hierarchy before it was cached/u,
    );
  });
});
