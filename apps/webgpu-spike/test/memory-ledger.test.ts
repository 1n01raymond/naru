import { describe, expect, it } from "vitest";

import type {
  CompiledHierarchy,
  CompiledPropertiesRef,
  CompiledSpatialIndexRef,
  RendererResourceStats,
} from "@naru3d/runtime-webgpu";

import {
  clearMemoryDataset,
  memoryLedgerDatasetKeys,
  packageRetentionBytes,
  packageRetentionDataset,
  publishMemoryDataset,
  rendererMemoryDataset,
} from "../src/memory-ledger.js";
import type { LoadedSceneHierarchy } from "../src/scene-source.js";

const propertiesRef: CompiledPropertiesRef = {
  schemaVersion: "madi.package-properties.1",
  uri: "properties.json",
  byteLength: 2_260_991,
  sha256: "712fea65",
};

const spatialIndexRef: CompiledSpatialIndexRef = {
  schemaVersion: "naru.spatial-demand-index.1",
  uri: "spatial.bin",
  byteLength: 7_403,
  sha256: "7e3be0ef",
};

function loadedScene(
  overrides: {
    readonly documentBytes?: number;
    readonly properties?: CompiledPropertiesRef;
    readonly spatialIndex?: CompiledSpatialIndexRef;
    readonly coarseBytes?: number;
    readonly relocatedHierarchyBytes?: number;
  } = {},
): LoadedSceneHierarchy {
  const hierarchy = {
    binaryByteLength: 120_707_064,
    ...(overrides.coarseBytes === undefined
      ? {}
      : { coarseBinaryByteLength: overrides.coarseBytes }),
    ...(overrides.properties ? { properties: overrides.properties } : {}),
    ...(overrides.spatialIndex ? { spatialIndex: overrides.spatialIndex } : {}),
  } as unknown as CompiledHierarchy;
  return {
    documentSource: { kind: "bytes", bytes: { byteLength: 0 } },
    documentByteLength: overrides.documentBytes ?? 448_800_000,
    hierarchy,
    ...(overrides.relocatedHierarchyBytes === undefined
      ? {}
      : { relocatedHierarchyBytes: overrides.relocatedHierarchyBytes }),
  } as unknown as LoadedSceneHierarchy;
}

const rendererStats: RendererResourceStats = {
  gpuVertexPoolBytes: 40_000_000,
  gpuBatchBufferBytes: 26_700_000,
  gpuUniformBytes: 256,
  gpuBufferBytes: 66_700_256,
  gpuAttachmentBytes: 10_560_000,
  cpuStagingBytes: 1_024,
  attachmentSizePx: [1_320, 1_000],
};

describe("package retention bytes", () => {
  it("reports every declared resource size, with sidecars present", () => {
    expect(
      packageRetentionBytes(
        loadedScene({
          properties: propertiesRef,
          spatialIndex: spatialIndexRef,
          coarseBytes: 5_878_260,
          relocatedHierarchyBytes: 3_021_299,
        }),
      ),
    ).toEqual({
      documentBytes: 448_800_000,
      propertyIndexBytes: 2_260_991,
      spatialIndexBytes: 7_403,
      relocatedHierarchyBytes: 3_021_299,
      coarseGeometryBytes: 5_878_260,
      declaredGeometryBytes: 120_707_064,
    });
  });

  it("reports zero, not a missing key, for a package without sidecars", () => {
    const retention = packageRetentionBytes(loadedScene());

    expect(retention.propertyIndexBytes).toBe(0);
    expect(retention.spatialIndexBytes).toBe(0);
    expect(retention.relocatedHierarchyBytes).toBe(0);
    expect(retention.coarseGeometryBytes).toBe(0);
  });

  it("counts a relocated assembly tree even though nothing retains its bytes", () => {
    // The sidecar is fetched, verified, decoded, and dropped on the main
    // thread. The ledger records what crossed the network so a sample can
    // separate transferred bytes from what the session goes on holding.
    const relocated = loadedScene({ relocatedHierarchyBytes: 64_825_238 });

    expect(packageRetentionBytes(relocated).relocatedHierarchyBytes).toBe(64_825_238);
  });

  it("survives the transfer that detaches the document buffer", () => {
    // The Worker takes ownership of the bytes on initialize, after which the
    // buffer the loader held reads as zero length.
    const transferred = loadedScene({ documentBytes: 448_823_852 });

    expect(packageRetentionBytes(transferred).documentBytes).toBe(448_823_852);
  });

  it("measures a local document from the file rather than a buffer", () => {
    const local = {
      documentSource: { kind: "file", file: { size: 63_186_959 } },
      documentByteLength: 63_186_959,
      hierarchy: { binaryByteLength: 1 } as unknown as CompiledHierarchy,
    } as unknown as LoadedSceneHierarchy;

    expect(packageRetentionBytes(local).documentBytes).toBe(63_186_959);
  });
});

describe("memory ledger dataset", () => {
  it("publishes package retention under its six keys", () => {
    expect(
      packageRetentionDataset(
        packageRetentionBytes(
          loadedScene({ properties: propertiesRef, coarseBytes: 5_878_260 }),
        ),
      ),
    ).toEqual({
      packageDocumentBytes: "448800000",
      packagePropertyIndexBytes: "2260991",
      packageSpatialIndexBytes: "0",
      packageRelocatedHierarchyBytes: "0",
      packageCoarseGeometryBytes: "5878260",
      packageDeclaredGeometryBytes: "120707064",
    });
  });

  it("keeps the attachment upper bound outside the buffer total it publishes", () => {
    const published = rendererMemoryDataset(rendererStats);

    expect(Number(published.rendererGpuBufferBytes)).toBe(
      Number(published.rendererGpuVertexPoolBytes) +
        Number(published.rendererGpuBatchBufferBytes) +
        Number(published.rendererGpuUniformBytes),
    );
    expect(published.rendererGpuAttachmentBytes).toBe("10560000");
  });

  it("covers the declared key set exactly, with no key written twice", () => {
    const written = [
      ...Object.keys(packageRetentionDataset(packageRetentionBytes(loadedScene()))),
      ...Object.keys(rendererMemoryDataset(rendererStats)),
    ];

    expect(new Set(written).size).toBe(written.length);
    expect(written.sort()).toEqual([...memoryLedgerDatasetKeys].sort());
  });

  it("clears every key it published, leaving other telemetry alone", () => {
    const dataset: Record<string, string | undefined> = { coarseReady: "true" };
    publishMemoryDataset(packageRetentionDataset(packageRetentionBytes(loadedScene())), dataset);
    publishMemoryDataset(rendererMemoryDataset(rendererStats), dataset);

    expect(Object.keys(dataset)).toHaveLength(memoryLedgerDatasetKeys.length + 1);

    clearMemoryDataset(dataset);

    expect(Object.keys(dataset)).toEqual(["coarseReady"]);
  });
});
