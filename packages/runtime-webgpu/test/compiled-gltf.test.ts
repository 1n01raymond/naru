import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  addResidencyCost,
  batchResidencyCost,
  compiledSceneTransferables,
  decodeCompiledGltf,
  defaultCompiledPackageLimits,
  inspectCompiledHierarchy,
  instanceStride,
  prepareCompiledGltfDecoder,
  resolveCompiledPackageLimits,
  validateGpuScene,
} from "../src/index.js";
import type {
  CompiledGltfError,
  GpuPrototypeBatch,
  ResidencyCost,
} from "../src/index.js";

const gltfUrl = new URL(
  "../../../artifacts/phase1/repeated-fasteners/scene.gltf",
  import.meta.url,
);
const binaryUrl = new URL(
  "../../../artifacts/phase1/repeated-fasteners/scene.bin",
  import.meta.url,
);
const progressiveUrl = new URL(
  "../../../artifacts/phase1/repeated-fasteners-ap242/",
  import.meta.url,
);

/**
 * Charges decoded batches the way a residency set does: a vertex pool shared
 * by the material groups of one prototype is one array and one GPU buffer, so
 * it is charged to the first batch that holds it and to no other.
 */
function residencyCostOfBatches(batches: readonly GpuPrototypeBatch[]): ResidencyCost {
  const charged = new Set<Float32Array>();
  return batches.reduce((total, batch) => {
    const sharesSurfaceVertices = charged.has(batch.surfaceVertices);
    charged.add(batch.surfaceVertices);
    return addResidencyCost(
      total,
      batchResidencyCost({
        surfaceVertexBytes: batch.surfaceVertices.byteLength,
        surfaceIndexBytes: batch.surfaceIndices.byteLength,
        edgeVertexBytes: batch.edgeVertices.byteLength,
        instanceCount: batch.instances.length,
        sharesSurfaceVertices,
      }),
    );
  }, { decodedBytes: 0, gpuBytes: 0 });
}

async function loadPackage(): Promise<{ json: unknown; binary: ArrayBuffer }> {
  const [json, bytes] = await Promise.all([
    readFile(gltfUrl, "utf8").then(JSON.parse),
    readFile(binaryUrl),
  ]);
  return {
    json,
    binary: Uint8Array.from(bytes).buffer,
  };
}

describe("compiled glTF runtime boundary", () => {
  it("opens hierarchy and source identity before binary geometry is available", async () => {
    const { json } = await loadPackage();
    const { hierarchy } = inspectCompiledHierarchy(json);

    expect(hierarchy.profile).toBe("madi.experimental.gltf.1");
    expect(hierarchy.sourceFormat).toBe("AP214");
    expect(hierarchy.binaryUri).toBe("scene.bin");
    expect(hierarchy.binaryByteLength).toBe(188_044);
    expect(hierarchy.entries).toHaveLength(12);
    expect(hierarchy.renderableOccurrences).toBe(10);
    expect(hierarchy.sharedMeshes).toBe(3);
    expect(hierarchy.entries.find(({ name }) => name === "fastener-03")).toMatchObject({
      depth: 2,
      renderable: true,
      occurrenceId: "occurrence:madi-repeated-fasteners/fastener-bank/fastener-03",
      prototypeId: "prototype:part:fastener-01",
    });
  });

  it("decodes shared meshes, explicit CAD edges, transforms, and pick evidence", async () => {
    const { json, binary } = await loadPackage();
    const decoded = decodeCompiledGltf(json, binary);

    expect(decoded.gpuScene.batches).toHaveLength(3);
    expect(decoded.summary).toEqual({
      prototypeBatches: 3,
      partOccurrences: 10,
      triangles: 2076,
      edgeSegments: 181,
      binaryBytes: 188_044,
      representation: "target",
    });
    expect(
      Math.max(...decoded.gpuScene.batches.map(({ instances }) => instances.length)),
    ).toBe(8);
    expect(decoded.bounds.min).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(decoded.bounds.min[0]).toBeCloseTo(-0.048, 5);
    expect(decoded.bounds.min[1]).toBeCloseTo(0, 5);
    expect(decoded.bounds.min[2]).toBeCloseTo(-0.028, 5);
    expect(decoded.bounds.max[0]).toBeCloseTo(0.048, 5);
    expect(decoded.bounds.max[1]).toBeCloseTo(0.022, 5);
    expect(decoded.bounds.max[2]).toBeCloseTo(0.028, 5);
    expect(decoded.objectEvidence.find(({ label }) => label === "center-rail")).toMatchObject({
      objectId: 3,
      nodeIndex: 2,
      prototypeId: "prototype:part:center-rail",
    });
    expect(
      decoded.objectEvidence.find(({ label }) => label === "center-rail")?.edgeSourceRefs,
    ).toHaveLength(12);
  });

  it("composes large node translations without reducing them to f32", async () => {
    const { json, binary } = await loadPackage();
    const copy = structuredClone(json) as {
      nodes: { matrix?: number[] }[];
    };
    const translation = 10_000_000.000_25;
    copy.nodes[0]!.matrix = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      translation, -7_000_000, 3_000_000, 1,
    ];
    const decoded = decodeCompiledGltf(copy, binary);
    const first = decoded.gpuScene.batches[0]?.instances[0];

    expect(first?.transform).toBeInstanceOf(Float64Array);
    expect(first?.transform[12]).toBe(translation);
    expect(decoded.bounds.min[0]).toBeCloseTo(translation - 0.048, 6);
    expect(decoded.bounds.max[0]).toBeCloseTo(translation + 0.048, 6);
  });

  it("decodes material-separated surface primitives as one pickable object", async () => {
    const { json, binary } = await loadPackage();
    const copy = structuredClone(json) as {
      meshes: { primitives: Record<string, unknown>[] }[];
      materials: unknown[];
    };
    const mesh = copy.meshes[0];
    const surface = mesh?.primitives[0];
    if (!mesh || !surface) throw new TypeError("Fixture mesh is incomplete.");
    const material = copy.materials.push({
      pbrMetallicRoughness: { baseColorFactor: [0.9, 0.2, 0.1, 1] },
    }) - 1;
    mesh.primitives.splice(1, 0, { ...surface, material });

    const decoded = decodeCompiledGltf(copy, binary);
    const splitBatches = decoded.batchEvidence.filter(({ meshIndex }) => meshIndex === 0);

    expect(splitBatches.map(({ surfacePrimitiveIndex }) => surfacePrimitiveIndex)).toEqual([0, 1]);
    expect(decoded.gpuScene.sharedObjectIdsAcrossBatches).toBe(true);
    expect(decoded.gpuScene.batches).toHaveLength(4);
    expect(decoded.objectEvidence).toHaveLength(10);
    expect(decoded.summary.triangles).toBeGreaterThan(2076);
    expect(
      decoded.gpuScene.batches[1]?.instances[0]?.baseColor,
    ).toEqual([0.9, 0.2, 0.1, 1]);
    expect(() => validateGpuScene(decoded.gpuScene)).not.toThrow();
  });

  it("rejects a truncated binary before exposing GPU buffers", async () => {
    const { json, binary } = await loadPackage();

    expect(() => decodeCompiledGltf(json, binary.slice(0, binary.byteLength - 4))).toThrowError(
      expect.objectContaining<Partial<CompiledGltfError>>({ code: "INVALID_BINARY" }),
    );
  });

  it("decodes coarse bounds before target geometry without changing object identity", async () => {
    const [json, targetBytes, coarseBytes] = await Promise.all([
      readFile(new URL("scene.gltf", progressiveUrl), "utf8").then(JSON.parse),
      readFile(new URL("scene.bin", progressiveUrl)),
      readFile(new URL("coarse.bin", progressiveUrl)),
    ]);
    const { hierarchy } = inspectCompiledHierarchy(json);
    const coarse = decodeCompiledGltf(json, Uint8Array.from(coarseBytes).buffer, {
      representation: "coarse",
    });
    const target = decodeCompiledGltf(json, Uint8Array.from(targetBytes).buffer);

    expect(hierarchy).toMatchObject({
      binaryUri: "scene.bin",
      binaryByteLength: 188_044,
      coarseBinaryUri: "coarse.bin",
      coarseBinaryByteLength: 2_736,
    });
    expect(hierarchy.targetChunks).toHaveLength(3);
    expect(coarse.summary).toEqual({
      prototypeBatches: 3,
      partOccurrences: 10,
      triangles: 36,
      edgeSegments: 36,
      binaryBytes: 2_736,
      representation: "coarse",
    });
    expect(target.summary.representation).toBe("target");
    expect(coarse.objectEvidence.map(({ objectId }) => objectId)).toEqual(
      target.objectEvidence.map(({ objectId }) => objectId),
    );
    expect(coarse.objectEvidence.map(({ occurrenceId }) => occurrenceId)).toEqual(
      target.objectEvidence.map(({ occurrenceId }) => occurrenceId),
    );
    expect(coarse.bounds).toEqual(target.bounds);
    expect(coarse.batchEvidence.map(({ targetMeshIndex }) => targetMeshIndex)).toEqual(
      target.batchEvidence.map(({ targetMeshIndex }) => targetMeshIndex),
    );

    const chunkScenes = hierarchy.targetChunks.map((chunk) =>
      decodeCompiledGltf(
        json,
        Uint8Array.from(
          targetBytes.subarray(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
        ).buffer,
        { targetChunkId: chunk.id },
      ),
    );
    expect(chunkScenes.map(({ summary }) => summary.partOccurrences)).toEqual([8, 1, 1]);
    expect(chunkScenes.reduce((total, value) => total + value.summary.triangles, 0)).toBe(
      target.summary.triangles,
    );
    expect(chunkScenes.reduce((total, value) => total + value.summary.edgeSegments, 0)).toBe(
      target.summary.edgeSegments,
    );
    expect(
      chunkScenes.flatMap(({ objectEvidence }) => objectEvidence.map(({ objectId }) => objectId))
        .sort((left, right) => left - right),
    ).toEqual(target.objectEvidence.map(({ objectId }) => objectId));
  });

  it("prepares active transforms once and decodes repeated target ranges chunk-locally", async () => {
    const [json, targetBytes, coarseBytes] = await Promise.all([
      readFile(new URL("scene.gltf", progressiveUrl), "utf8").then(JSON.parse) as Promise<{
        nodes: unknown[];
      }>,
      readFile(new URL("scene.bin", progressiveUrl)),
      readFile(new URL("coarse.bin", progressiveUrl)),
    ]);
    let nodeReads = 0;
    json.nodes = new Proxy(json.nodes, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) nodeReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const prepared = prepareCompiledGltfDecoder(json);
    const readsAfterPrepare = nodeReads;
    const chunk = prepared.hierarchy.targetChunks.find(({ occurrenceCount }) =>
      occurrenceCount === 1
    );
    if (!chunk) throw new TypeError("Progressive fixture has no single-occurrence chunk.");
    const range = (): ArrayBuffer => Uint8Array.from(
      targetBytes.subarray(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    ).buffer;

    const coarse = prepared.decode(Uint8Array.from(coarseBytes).buffer, {
      representation: "coarse",
    });
    expect(coarse.summary.partOccurrences).toBe(10);
    structuredClone(coarse, { transfer: compiledSceneTransferables(coarse) });

    const first = prepared.decode(range(), { targetChunkId: chunk.id });
    expect(prepared.activeNodeCount).toBe(prepared.hierarchy.nodeCount);
    expect(prepared.renderableNodeCount).toBe(10);
    expect(first.summary.partOccurrences).toBe(1);
    expect(nodeReads).toBe(readsAfterPrepare);

    structuredClone(first, { transfer: compiledSceneTransferables(first) });
    const second = prepared.decode(range(), { targetChunkId: chunk.id });
    expect(second.objectEvidence).toEqual(first.objectEvidence);
    expect(second.gpuScene.batches[0]?.instances[0]?.transform.byteLength).toBe(128);
    expect(nodeReads).toBe(readsAfterPrepare);
  });

  it("releases the caller's node graph once preparation finishes", async () => {
    const [json, targetBytes, coarseBytes] = await Promise.all([
      readFile(new URL("scene.gltf", progressiveUrl), "utf8").then(JSON.parse) as Promise<{
        nodes: unknown[];
        scenes: unknown[];
      }>,
      readFile(new URL("scene.bin", progressiveUrl)),
      readFile(new URL("coarse.bin", progressiveUrl)),
    ]);
    const prepared = prepareCompiledGltfDecoder(json);
    const chunk = prepared.hierarchy.targetChunks[0];
    if (!chunk) throw new TypeError("Progressive fixture has no target chunk.");
    const range = (): ArrayBuffer => Uint8Array.from(
      targetBytes.subarray(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    ).buffer;
    const before = prepared.decode(range(), { targetChunkId: chunk.id });

    // The caller drops the node graph the way a Worker drops its parsed
    // document. A decoder that kept the document itself alive would keep
    // reading these arrays for the rest of the session.
    json.nodes.length = 0;
    json.scenes.length = 0;

    const after = prepared.decode(range(), { targetChunkId: chunk.id });
    expect(after.summary).toEqual(before.summary);
    expect(after.objectEvidence).toEqual(before.objectEvidence);
    const coarse = prepared.decode(Uint8Array.from(coarseBytes).buffer, {
      representation: "coarse",
    });
    expect(coarse.summary.partOccurrences).toBe(10);
  });

  it("measures each target chunk's residency cost before its range is fetched", async () => {
    const [json, targetBytes] = await Promise.all([
      readFile(new URL("scene.gltf", progressiveUrl), "utf8").then(JSON.parse),
      readFile(new URL("scene.bin", progressiveUrl)),
    ]);
    const prepared = prepareCompiledGltfDecoder(json);

    expect([...prepared.targetChunkResidencyCosts.keys()]).toEqual(
      prepared.hierarchy.targetChunks.map(({ id }) => id),
    );
    for (const chunk of prepared.hierarchy.targetChunks) {
      const scene = prepared.decode(
        Uint8Array.from(
          targetBytes.subarray(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
        ).buffer,
        { targetChunkId: chunk.id },
      );
      const decoded = residencyCostOfBatches(scene.gpuScene.batches);

      // The gate refuses chunks on this prediction alone, so an underestimate
      // would drop geometry the budget could have held.
      expect(prepared.targetChunkResidencyCosts.get(chunk.id)).toEqual(decoded);
      expect(scene.summary.edgeSegments).toBeGreaterThan(0);
      expect(decoded.decodedBytes).toBeGreaterThan(0);
    }
  });

  it("shares one vertex pool across the material groups of a prototype", async () => {
    const [json, targetBytes] = await Promise.all([
      readFile(new URL("scene.gltf", progressiveUrl), "utf8").then(JSON.parse),
      readFile(new URL("scene.bin", progressiveUrl)),
    ]);
    // The committed STEP packages carry one material per prototype. IFC
    // federations split a prototype into a surface primitive per material,
    // all reading the accessors the package stores once, so a second group is
    // added here over the same POSITION/NORMAL/index accessors.
    const split = structuredClone(json) as {
      meshes: { primitives: unknown[] }[];
    };
    for (const mesh of split.meshes) {
      mesh.primitives.splice(1, 0, structuredClone(mesh.primitives[0]));
    }

    const single = prepareCompiledGltfDecoder(json);
    const grouped = prepareCompiledGltfDecoder(split);
    const chunk = grouped.hierarchy.targetChunks[0];
    if (!chunk) throw new Error("The progressive package has no target chunk.");
    const range = (): ArrayBuffer =>
      Uint8Array.from(
        targetBytes.subarray(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
      ).buffer;
    const scene = grouped.decode(range(), { targetChunkId: chunk.id });

    const [first, second] = scene.gpuScene.batches;
    expect(scene.gpuScene.batches).toHaveLength(2);
    expect(first?.surfaceVertices.length).toBeGreaterThan(0);
    // Identity, not equality: the residency set and the renderer both charge
    // and release the pool by the array they were handed.
    expect(second?.surfaceVertices).toBe(first?.surfaceVertices);
    expect(compiledSceneTransferables(scene)).toContain(first?.surfaceVertices.buffer);

    // Splitting one prototype into two material groups adds that group's
    // indices and instances -- and none of the vertices it re-reads.
    const singleCost = single.targetChunkResidencyCosts.get(chunk.id);
    const groupedCost = grouped.targetChunkResidencyCosts.get(chunk.id);
    expect(groupedCost).toEqual(residencyCostOfBatches(scene.gpuScene.batches));
    expect((groupedCost?.decodedBytes ?? 0) - (singleCost?.decodedBytes ?? 0)).toBe(
      (first?.surfaceIndices.byteLength ?? 0) + (first?.instances.length ?? 0) * instanceStride,
    );
  });

  it("surfaces semantic references on hierarchy entries and pick evidence", async () => {
    const { json, binary } = await loadPackage();
    const { hierarchy } = inspectCompiledHierarchy(json);
    const decoded = decodeCompiledGltf(json, binary);

    expect(hierarchy.entries.find(({ name }) => name === "fastener-03")?.semanticId).toBe(
      "semantic:prototype:part:fastener-01",
    );
    expect(
      decoded.objectEvidence.find(({ label }) => label === "center-rail")?.semanticId,
    ).toBe("semantic:prototype:part:center-rail");
    // The committed Phase 1 STEP package carries no property sidecar.
    expect(hierarchy.properties).toBeUndefined();
  });

  it("validates and exposes an optional spatial demand sidecar pointer", async () => {
    const json = JSON.parse(await readFile(new URL("scene.gltf", progressiveUrl), "utf8")) as unknown;
    const copy = structuredClone(json) as {
      extras: { madi: { progressive?: Record<string, unknown> } };
    };
    copy.extras.madi.progressive = {
      ...copy.extras.madi.progressive,
      spatialIndex: {
        schemaVersion: "naru.spatial-demand-index.1",
        uri: "spatial.bin",
        byteLength: 512,
        sha256: "a".repeat(64),
      },
    };

    expect(inspectCompiledHierarchy(copy).hierarchy.spatialIndex).toEqual({
      schemaVersion: "naru.spatial-demand-index.1",
      uri: "spatial.bin",
      byteLength: 512,
      sha256: "a".repeat(64),
    });

    const invalid = structuredClone(copy);
    const progressive = invalid.extras.madi.progressive as {
      spatialIndex: { schemaVersion: string };
    };
    progressive.spatialIndex.schemaVersion = "naru.spatial-demand-index.2";
    expect(() => inspectCompiledHierarchy(invalid)).toThrowError(
      expect.objectContaining<Partial<CompiledGltfError>>({ code: "INVALID_GLTF" }),
    );
  });

  it("surfaces a property sidecar pointer from extras.madi.properties", async () => {
    const { json } = await loadPackage();
    const copy = structuredClone(json) as {
      extras: { madi: Record<string, unknown> };
    };
    const pointer = {
      schemaVersion: "madi.package-properties.1",
      uri: "properties.json",
      byteLength: 2_260_991,
      sha256: "a".repeat(64),
    };
    copy.extras.madi.properties = pointer;

    expect(inspectCompiledHierarchy(copy).hierarchy.properties).toEqual(pointer);
  });

  it("rejects a malformed property sidecar pointer", async () => {
    const { json } = await loadPackage();
    const copy = structuredClone(json) as {
      extras: { madi: Record<string, unknown> };
    };
    copy.extras.madi.properties = {
      schemaVersion: "madi.package-properties.1",
      uri: "properties.json",
      byteLength: 2_260_991,
    };

    expect(() => inspectCompiledHierarchy(copy)).toThrowError(
      expect.objectContaining<Partial<CompiledGltfError>>({ code: "INVALID_GLTF" }),
    );
  });

  it("rejects unrecognized MADI extras profiles", async () => {
    const { json } = await loadPackage();
    const copy = structuredClone(json) as {
      extras: { madi: { profile: string } };
    };
    copy.extras.madi.profile = "madi.future.unknown";

    expect(() => inspectCompiledHierarchy(copy)).toThrowError(
      expect.objectContaining<Partial<CompiledGltfError>>({ code: "UNSUPPORTED_PROFILE" }),
    );
  });
});

describe("compiled package structural limits", () => {
  /**
   * The smallest document the boundary accepts: one chain of `depth` nodes,
   * every one an occurrence, so limit behavior can be tested without a fixture.
   */
  function chainedPackage(depth: number): unknown {
    const nodes = Array.from({ length: depth }, (_, index) => ({
      name: `node-${String(index)}`,
      extras: { madi: { occurrenceId: `occurrence-${String(index)}` } },
      ...(index + 1 < depth ? { children: [index + 1] } : {}),
    }));
    return {
      asset: { version: "2.0" },
      extras: { madi: { profile: "madi.experimental.gltf.1", sceneId: "chain" } },
      scene: 0,
      scenes: [{ name: "chain", nodes: [0] }],
      nodes,
      meshes: [],
      materials: [],
      bufferViews: [],
      accessors: [],
      buffers: [{ uri: "scene.bin", byteLength: 64 }],
    };
  }

  it("rejects a package that declares more nodes than the limit", async () => {
    const { json } = await loadPackage();

    expect(() => inspectCompiledHierarchy(json, { limits: { nodes: 4 } })).toThrowError(
      /declares 13 nodes; the limit is 4/u,
    );
    expect(() => inspectCompiledHierarchy(json, { limits: { accessors: 8 } })).toThrowError(
      /declares 24 accessors; the limit is 8/u,
    );
    expect(inspectCompiledHierarchy(json).hierarchy.nodeCount).toBe(13);
  });

  it("rejects a scene nested deeper than the traversal limit", () => {
    expect(() => inspectCompiledHierarchy(chainedPackage(6), { limits: { traversalDepth: 4 } }))
      .toThrowError(/nests deeper than 4 nodes at nodes\[4\]/u);
    expect(
      inspectCompiledHierarchy(chainedPackage(4), { limits: { traversalDepth: 4 } })
        .hierarchy.entries,
    ).toHaveLength(4);
  });

  it("walks a chain far deeper than the JavaScript stack without exhausting it", () => {
    const depth = 200_000;

    const { hierarchy } = inspectCompiledHierarchy(chainedPackage(depth), {
      limits: { nodes: depth, traversalDepth: depth },
    });

    expect(hierarchy.entries).toHaveLength(depth);
    expect(hierarchy.entries[depth - 1]?.depth).toBe(depth - 1);
  });

  it("still separates a cycle from a second parent after the stack rewrite", () => {
    const cyclic = chainedPackage(3) as { nodes: { children?: number[] }[] };
    cyclic.nodes[2] = { ...cyclic.nodes[2], children: [1] };
    const shared = chainedPackage(3) as { nodes: { children?: number[] }[] };
    shared.nodes[0] = { ...shared.nodes[0], children: [1, 2] };

    expect(() => inspectCompiledHierarchy(cyclic)).toThrowError(/Cycle detected at nodes\[1\]/u);
    expect(() => inspectCompiledHierarchy(shared)).toThrowError(
      /nodes\[2\] has more than one active-scene parent/u,
    );
  });

  it("resolves limit overrides over reviewed defaults and rejects unusable ones", () => {
    expect(resolveCompiledPackageLimits()).toEqual(defaultCompiledPackageLimits);
    expect(resolveCompiledPackageLimits({ targetChunks: 8 })).toEqual({
      ...defaultCompiledPackageLimits,
      targetChunks: 8,
    });
    expect(() => resolveCompiledPackageLimits({ nodes: 0 })).toThrowError(
      /nodes limit must be a positive safe integer/u,
    );
    expect(() => resolveCompiledPackageLimits({ meshes: 1.5 })).toThrowError(
      /meshes limit must be a positive safe integer/u,
    );
  });
});

describe("elided node identities and default transforms", () => {
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

  /** A two-node document whose identities exercise one derivation rule. */
  function identityPackage(
    derivation: unknown,
    madi: readonly Record<string, unknown>[],
  ): unknown {
    return {
      asset: { version: "2.0" },
      extras: {
        madi: {
          profile: "madi.experimental.gltf.1",
          sceneId: "identities",
          ...(derivation === undefined ? {} : { nodeIdentityDerivation: derivation }),
        },
      },
      scene: 0,
      scenes: [{ name: "identities", nodes: madi.map((_, index) => index) }],
      nodes: madi.map((extras, index) => ({ name: `node-${String(index)}`, extras: { madi: extras } })),
      meshes: [],
      materials: [],
      bufferViews: [],
      accessors: [],
      buffers: [{ uri: "scene.bin", byteLength: 64 }],
    };
  }

  it("reconstructs both identities from the declared bases", () => {
    const { hierarchy } = inspectCompiledHierarchy(
      identityPackage(
        { semanticId: "prototypeId", sourceRef: "semanticId" },
        [{ occurrenceId: "occurrence:a", prototypeId: "prototype:beam" }],
      ),
    );

    expect(hierarchy.entries[0]).toMatchObject({
      semanticId: "semantic:prototype:beam",
      sourceRef: "source:prototype:beam",
    });
  });

  it("derives sourceRef from the occurrence id when that rule is declared", () => {
    const { hierarchy } = inspectCompiledHierarchy(
      identityPackage({ sourceRef: "occurrenceId" }, [
        { occurrenceId: "occurrence:a", prototypeId: "prototype:beam" },
      ]),
    );

    expect(hierarchy.entries[0]?.semanticId).toBeUndefined();
    expect(hierarchy.entries[0]?.sourceRef).toBe("source:occurrence:a");
  });

  it("keeps a serialized identity and reads null as genuinely absent", () => {
    const { hierarchy } = inspectCompiledHierarchy(
      identityPackage({ semanticId: "prototypeId", sourceRef: "semanticId" }, [
        {
          occurrenceId: "occurrence:a",
          prototypeId: "prototype:beam",
          semanticId: "semantic:bespoke",
          sourceRef: "source:bespoke",
        },
        { occurrenceId: "occurrence:b", prototypeId: "prototype:beam", semanticId: null, sourceRef: null },
      ]),
    );

    expect(hierarchy.entries[0]).toMatchObject({
      semanticId: "semantic:bespoke",
      sourceRef: "source:bespoke",
    });
    expect(hierarchy.entries[1]?.semanticId).toBeUndefined();
    expect(hierarchy.entries[1]?.sourceRef).toBeUndefined();
  });

  it("reconstructs nothing when the document declares no derivation", () => {
    const { hierarchy } = inspectCompiledHierarchy(
      identityPackage(undefined, [{ occurrenceId: "occurrence:a", prototypeId: "prototype:beam" }]),
    );

    expect(hierarchy.entries[0]?.semanticId).toBeUndefined();
    expect(hierarchy.entries[0]?.sourceRef).toBeUndefined();
  });

  it("ignores a derivation base this runtime does not know", () => {
    const { hierarchy } = inspectCompiledHierarchy(
      identityPackage({ semanticId: "occurrenceId", sourceRef: "prototypeId" }, [
        { occurrenceId: "occurrence:a", prototypeId: "prototype:beam" },
      ]),
    );

    expect(hierarchy.entries[0]?.semanticId).toBeUndefined();
    expect(hierarchy.entries[0]?.sourceRef).toBeUndefined();
  });

  it("decodes omitted and translation-only transforms into the same instances", async () => {
    const { json, binary } = await loadPackage();
    const rewritten = JSON.parse(JSON.stringify(json)) as { nodes: { matrix?: number[] }[] };
    let translations = 0;
    let identities = 0;
    for (const node of rewritten.nodes) {
      const matrix = node.matrix;
      if (!matrix) continue;
      if (!IDENTITY.every((value, index) => (index >= 12 && index <= 14) || matrix[index] === value)) {
        continue;
      }
      delete node.matrix;
      if (matrix[12] === 0 && matrix[13] === 0 && matrix[14] === 0) identities += 1;
      else {
        translations += 1;
        (node as { translation?: number[] }).translation = matrix.slice(12, 15);
      }
    }

    expect({ translations, identities }).toEqual({ translations: 8, identities: 4 });
    expect(decodeCompiledGltf(rewritten, binary).gpuScene.batches.map(({ instances }) => instances))
      .toEqual(decodeCompiledGltf(json, binary).gpuScene.batches.map(({ instances }) => instances));
  });

  it("composes rotation and scale in the glTF T * R * S order", async () => {
    const { json, binary } = await loadPackage();
    const rotated = JSON.parse(JSON.stringify(json)) as { nodes: Record<string, unknown>[] };
    const composed = JSON.parse(JSON.stringify(json)) as { nodes: Record<string, unknown>[] };
    // A quarter turn about +Y, doubled, then moved: column-major M = T * R * S.
    for (const node of rotated.nodes) {
      if (node.matrix === undefined) continue;
      node.matrix = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 1, 2, 3, 1];
      break;
    }
    for (const node of composed.nodes) {
      if (node.matrix === undefined) continue;
      delete node.matrix;
      node.translation = [1, 2, 3];
      node.rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
      node.scale = [2, 2, 2];
      break;
    }

    const fromTrs = decodeCompiledGltf(composed, binary).gpuScene.batches[0]?.instances ?? [];
    const fromMatrix = decodeCompiledGltf(rotated, binary).gpuScene.batches[0]?.instances ?? [];

    expect(fromTrs.length).toBeGreaterThan(0);
    expect(fromTrs.length).toBe(fromMatrix.length);
    for (const [index, instance] of fromTrs.entries()) {
      // The quaternion form reproduces the matrix to double precision; it is
      // not bit-identical, which is why the compiler never decomposes one.
      const expected = fromMatrix[index]?.transform ?? [];
      for (const [element, value] of [...instance.transform].entries()) {
        expect(value).toBeCloseTo(expected[element] ?? Number.NaN, 12);
      }
    }
  });
});

/**
 * A seeded malformed-package campaign (artifacts/security/package-fuzz) escaped
 * raw TypeErrors from these shapes: every decode path dereferences a selected
 * primitive and its attributes, so both are now settled once during selection
 * rather than at each of the four call sites that read them.
 */
describe("malformed mesh primitives", () => {
  it("refuses a mesh whose primitive list is not an array", async () => {
    const { json, binary } = await loadPackage();
    const copy = structuredClone(json) as { meshes: { primitives: unknown }[] };
    copy.meshes[0]!.primitives = { 0: {} };

    expect(() => decodeCompiledGltf(copy, binary)).toThrowError(
      expect.objectContaining<Partial<CompiledGltfError>>({ code: "INVALID_GLTF" }),
    );
  });

  it("refuses a null mesh primitive before its mode is read", async () => {
    const { json, binary } = await loadPackage();
    const copy = structuredClone(json) as { meshes: { primitives: unknown[] }[] };
    copy.meshes[0]!.primitives.push(null);

    expect(() => decodeCompiledGltf(copy, binary)).toThrowError(
      expect.objectContaining<Partial<CompiledGltfError>>({ code: "INVALID_GLTF" }),
    );
  });

  it("refuses a selected primitive that declares no attributes object", async () => {
    const { json, binary } = await loadPackage();
    for (const attributes of [undefined, null, false, 4]) {
      const copy = structuredClone(json) as {
        meshes: { primitives: { attributes?: unknown }[] }[];
      };
      const primitive = copy.meshes[0]!.primitives[0]!;
      if (attributes === undefined) delete primitive.attributes;
      else primitive.attributes = attributes;

      expect(() => decodeCompiledGltf(copy, binary)).toThrowError(
        expect.objectContaining<Partial<CompiledGltfError>>({ code: "INVALID_GLTF" }),
      );
    }
  });

  // Measurement reads POSITION off surfaces alone, so an edge primitive with a
  // non-object `attributes` used to pass preparation and fail only once a
  // client happened to request the chunk holding that mesh. Whether a package
  // is accepted must not depend on which range was asked for.
  it("refuses a malformed edge primitive before any range is decoded", async () => {
    const json = JSON.parse(
      await readFile(new URL("scene.gltf", progressiveUrl), "utf8"),
    ) as unknown;
    const copy = structuredClone(json) as {
      meshes: { primitives: { mode?: number; attributes?: unknown }[] }[];
    };
    const edge = copy.meshes
      .flatMap((mesh) => mesh.primitives)
      .find((primitive) => primitive.mode === 1);
    expect(edge).toBeDefined();
    edge!.attributes = false;

    expect(() => prepareCompiledGltfDecoder(copy)).toThrowError(
      expect.objectContaining<Partial<CompiledGltfError>>({ code: "INVALID_GLTF" }),
    );
  });
});

describe("reduced level under naru.progressive-package.2", () => {
  type Chunk = { id: string; meshIndexes: number[]; byteOffset: number; byteLength: number };
  type Doc = {
    meshes: Record<string, unknown>[];
    nodes: { mesh?: number; extras?: { madi?: Record<string, unknown> } }[];
    extras: { madi: Record<string, unknown>; naru?: Record<string, unknown> };
  };

  async function reducedFixture(): Promise<{ json: Doc; chunk: Chunk; bytes: Buffer }> {
    const [json, bytes] = await Promise.all([
      readFile(new URL("scene.gltf", progressiveUrl), "utf8").then(JSON.parse) as Promise<Doc>,
      readFile(new URL("scene.bin", progressiveUrl)),
    ]);
    const progressive = json.extras.madi.progressive as { targetChunks: Chunk[] };
    const chunk = progressive.targetChunks[0]!;
    const reducedId = chunk.id.replace(/^target:/u, "reduced:");
    json.extras.naru = {
      progressive: {
        schemaVersion: "naru.progressive-package.2",
        ...progressive,
        reducedChunks: [{ ...chunk, id: reducedId, maxDeviationMeters: 0.0004 }],
        reducedLod: {
          method: "meshoptimizer-whole-shape-unlocked",
          requestedToleranceMeters: 0.001,
          maxDeviationMeters: 0.0004,
        },
      },
    };
    delete json.extras.madi.progressive;
    for (const node of json.nodes) {
      if (node.mesh !== undefined && chunk.meshIndexes.includes(node.mesh) && node.extras?.madi) {
        node.extras.madi.reducedMesh = node.mesh;
      }
    }
    return { json, chunk: { ...chunk, id: reducedId }, bytes };
  }

  /**
   * Points the reduced chunk at duplicate meshes that reuse the target's
   * accessors. The document then carries two distinct levels of one prototype
   * while the same chunk byte range still decodes, so a test can compare the
   * levels without fabricating geometry the compiler never produced.
   */
  async function distinctMeshReducedFixture(): Promise<{
    json: Doc;
    chunk: Chunk;
    bytes: Buffer;
  }> {
    const fixture = await reducedFixture();
    const { json, chunk } = fixture;
    const duplicates = new Map<number, number>();
    for (const meshIndex of chunk.meshIndexes) {
      duplicates.set(meshIndex, json.meshes.length);
      json.meshes.push(structuredClone(json.meshes[meshIndex]!));
    }
    const progressive = json.extras.naru!.progressive as { reducedChunks: Chunk[] };
    const reducedMeshIndexes = chunk.meshIndexes.map((meshIndex) => duplicates.get(meshIndex)!);
    progressive.reducedChunks[0]!.meshIndexes = reducedMeshIndexes;
    for (const node of json.nodes) {
      const madi = node.extras?.madi;
      if (madi === undefined || node.mesh === undefined) continue;
      const duplicate = duplicates.get(node.mesh);
      if (duplicate !== undefined) madi.reducedMesh = duplicate;
    }
    return { ...fixture, chunk: { ...chunk, meshIndexes: reducedMeshIndexes } };
  }

  it("decodes a reduced chunk with the target's identity and a residency cost", async () => {
    const { json, chunk, bytes } = await reducedFixture();
    const prepared = prepareCompiledGltfDecoder(json);
    expect(prepared.hierarchy.reducedChunks.map(({ id }) => id)).toEqual([chunk.id]);
    const range = Uint8Array.from(
      bytes.subarray(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    ).buffer;
    const reduced = prepared.decode(range, { targetChunkId: chunk.id });
    expect(reduced.summary.representation).toBe("reduced");
    const target = prepared.decode(range.slice(0), {
      targetChunkId: chunk.id.replace(/^reduced:/u, "target:"),
    });
    expect(target.summary.representation).toBe("target");
    expect(reduced.objectEvidence).toEqual(target.objectEvidence);
    expect(prepared.targetChunkResidencyCosts.get(chunk.id)).toEqual(
      prepared.targetChunkResidencyCosts.get(chunk.id.replace(/^reduced:/u, "target:")),
    );
  });

  it("presents one scene at either level, so the section plane and pickPoint read the same objects", async () => {
    const { json, chunk, bytes } = await distinctMeshReducedFixture();
    const prepared = prepareCompiledGltfDecoder(json);
    const targetChunkId = prepared.hierarchy.targetChunks[0]!.id;
    const range = Uint8Array.from(
      bytes.subarray(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    ).buffer;
    const reduced = prepared.decode(range, { targetChunkId: chunk.id });
    const target = prepared.decode(range.slice(0), { targetChunkId });
    expect(reduced.summary.representation).toBe("reduced");
    expect(target.summary.representation).toBe("target");

    // The reduced batches decode meshes of their own level while naming the
    // prototype the target level names.
    expect(reduced.batchEvidence.map(({ meshIndex }) => meshIndex)).not.toEqual(
      target.batchEvidence.map(({ meshIndex }) => meshIndex),
    );
    const identity = (scene: typeof reduced) =>
      scene.batchEvidence.map(({ targetMeshIndex, surfacePrimitiveIndex, prototypeId }) => ({
        targetMeshIndex,
        surfacePrimitiveIndex,
        prototypeId,
      }));
    expect(identity(reduced)).toEqual(identity(target));

    // `pickPoint` resolves the object id an instance writes into the picking
    // attachment, and the section plane clips the world position that same
    // instance transform places. Both are level-independent only if the levels
    // agree on every instance, in the same batch order.
    const instances = (scene: typeof reduced) =>
      scene.gpuScene.batches.map((batch) =>
        batch.instances.map(({ objectId, transform }) => [objectId, Array.from(transform)]),
      );
    expect(instances(reduced)).toEqual(instances(target));
    expect(reduced.objectEvidence).toEqual(target.objectEvidence);
    expect(reduced.bounds).toEqual(target.bounds);
  });

  it("fails closed on an unknown schema version and on a chunk id shared across levels", async () => {
    const wrongSchema = await reducedFixture();
    (wrongSchema.json.extras.naru!.progressive as Record<string, unknown>).schemaVersion =
      "naru.progressive-package.1";
    expect(() => inspectCompiledHierarchy(wrongSchema.json)).toThrowError(
      /schemaVersion must be naru\.progressive-package\.2/u,
    );

    const shared = await reducedFixture();
    const progressive = shared.json.extras.naru!.progressive as { reducedChunks: Chunk[] };
    progressive.reducedChunks[0]!.id = shared.chunk.id.replace(/^reduced:/u, "target:");
    expect(() => prepareCompiledGltfDecoder(shared.json)).toThrowError(
      /both a target and a reduced chunk/u,
    );
  });

  it("states the deviation a reduced level stays within, and refuses one that does not", async () => {
    const stated = await reducedFixture();
    expect(inspectCompiledHierarchy(stated.json).hierarchy.reducedLod).toEqual({
      method: "meshoptimizer-whole-shape-unlocked",
      requestedToleranceMeters: 0.001,
      maxDeviationMeters: 0.0004,
    });
    expect(
      inspectCompiledHierarchy(stated.json).hierarchy.reducedChunks.map(
        ({ maxDeviationMeters }) => maxDeviationMeters,
      ),
    ).toEqual([0.0004]);

    const unbounded = await reducedFixture();
    delete (unbounded.json.extras.naru!.progressive as Record<string, unknown>).reducedLod;
    expect(() => inspectCompiledHierarchy(unbounded.json)).toThrowError(
      /must state the deviation its reduced chunks stay within/u,
    );

    for (const reducedLod of [
      { method: "  ", requestedToleranceMeters: 0.001, maxDeviationMeters: 0.0004 },
      { method: "meshopt", requestedToleranceMeters: 0, maxDeviationMeters: 0.0004 },
      { method: "meshopt", requestedToleranceMeters: 0.001, maxDeviationMeters: 0 },
      { method: "meshopt", requestedToleranceMeters: 0.001, maxDeviationMeters: Number.NaN },
    ]) {
      const invalid = await reducedFixture();
      (invalid.json.extras.naru!.progressive as Record<string, unknown>).reducedLod = reducedLod;
      expect(() => inspectCompiledHierarchy(invalid.json)).toThrowError(
        /must carry a method, a positive requestedToleranceMeters, and a positive maxDeviationMeters/u,
      );
    }

    // A chunk is the finest range a viewer can fetch, so its own bound is what
    // the selector divides by the frame scale; a reduced chunk that states none
    // is refused rather than drawn against the package-wide number.
    const unboundedChunk = await reducedFixture();
    delete (
      (unboundedChunk.json.extras.naru!.progressive as { reducedChunks: Record<string, unknown>[] })
        .reducedChunks[0] as Record<string, unknown>
    ).maxDeviationMeters;
    expect(() => inspectCompiledHierarchy(unboundedChunk.json)).toThrowError(
      /maxDeviationMeters must state a positive deviation/u,
    );
  });
});
