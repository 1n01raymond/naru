import type { RendererResourceStats } from "@naru3d/runtime-webgpu";

import type { LoadedSceneHierarchy } from "./scene-source.js";

/**
 * Bytes of the compiled package this session keeps, or streams, per resource.
 *
 * Every figure is a declared or measured transfer size, never an estimate of
 * what the parsed form costs in the JavaScript heap: a document of `n` bytes
 * becomes objects of some other size that only the engine can report.
 */
export interface PackageRetentionBytes {
  /**
   * The compiled glTF document as transferred. The main thread parses it to
   * read the hierarchy and hands the same bytes to the Worker, which retains
   * the parsed form for the session. Taken from the length recorded at load,
   * because the transfer detaches the buffer the loader held.
   */
  readonly documentBytes: number;
  /** The property sidecar index, retained so a selection can be resolved. */
  readonly propertyIndexBytes: number;
  /** The spatial demand index, retained so navigation can be answered. */
  readonly spatialIndexBytes: number;
  /**
   * The relocated hierarchy sidecar, JSON header plus columns, for a package
   * that carries its assembly tree outside the document. Zero when the tree is
   * in the document. These bytes are read once on the main thread and dropped:
   * the figure is what crossed the network, not what the decoded tree costs.
   */
  readonly relocatedHierarchyBytes: number;
  /**
   * Coarse geometry declared by the document, zero when the package carries no
   * coarse level. Like the target binary this bounds the range requests.
   */
  readonly coarseGeometryBytes: number;
  /**
   * Geometry declared by the document. Only the admitted part is ever resident,
   * so this bounds the range requests, not the memory.
   */
  readonly declaredGeometryBytes: number;
}

/** Byte counts this session can state exactly, from declared resource sizes. */
export function packageRetentionBytes(loaded: LoadedSceneHierarchy): PackageRetentionBytes {
  const { documentByteLength, hierarchy } = loaded;
  return {
    documentBytes: documentByteLength,
    propertyIndexBytes: hierarchy.properties?.byteLength ?? 0,
    spatialIndexBytes: hierarchy.spatialIndex?.byteLength ?? 0,
    relocatedHierarchyBytes: loaded.relocatedHierarchyBytes ?? 0,
    coarseGeometryBytes: hierarchy.coarseBinaryByteLength ?? 0,
    declaredGeometryBytes: hierarchy.binaryByteLength,
  };
}

/**
 * The dataset keys a memory sample reads. They are published as strings on the
 * document element like every other Studio telemetry value, so a recorder needs
 * no page-scoped hook to sample them.
 */
export const memoryLedgerDatasetKeys = [
  "packageDocumentBytes",
  "packagePropertyIndexBytes",
  "packageSpatialIndexBytes",
  "packageRelocatedHierarchyBytes",
  "packageCoarseGeometryBytes",
  "packageDeclaredGeometryBytes",
  "rendererGpuVertexPoolBytes",
  "rendererGpuBatchBufferBytes",
  "rendererGpuUniformBytes",
  "rendererGpuBufferBytes",
  "rendererGpuAttachmentBytes",
  "rendererCpuStagingBytes",
] as const;

export type MemoryLedgerDatasetKey = (typeof memoryLedgerDatasetKeys)[number];

export function packageRetentionDataset(
  retention: PackageRetentionBytes,
): Partial<Record<MemoryLedgerDatasetKey, string>> {
  return {
    packageDocumentBytes: String(retention.documentBytes),
    packagePropertyIndexBytes: String(retention.propertyIndexBytes),
    packageSpatialIndexBytes: String(retention.spatialIndexBytes),
    packageRelocatedHierarchyBytes: String(retention.relocatedHierarchyBytes),
    packageCoarseGeometryBytes: String(retention.coarseGeometryBytes),
    packageDeclaredGeometryBytes: String(retention.declaredGeometryBytes),
  };
}

/**
 * The renderer's own allocations. `rendererGpuBufferBytes` is the sum of the
 * three buffer categories and nothing else; the attachment figure stays outside
 * it because a texture is not a buffer allocation and is an upper bound.
 */
export function rendererMemoryDataset(
  stats: RendererResourceStats,
): Partial<Record<MemoryLedgerDatasetKey, string>> {
  return {
    rendererGpuVertexPoolBytes: String(stats.gpuVertexPoolBytes),
    rendererGpuBatchBufferBytes: String(stats.gpuBatchBufferBytes),
    rendererGpuUniformBytes: String(stats.gpuUniformBytes),
    rendererGpuBufferBytes: String(stats.gpuBufferBytes),
    rendererGpuAttachmentBytes: String(stats.gpuAttachmentBytes),
    rendererCpuStagingBytes: String(stats.cpuStagingBytes),
  };
}

/**
 * Writes a sample onto the telemetry surface. The target is a parameter so the
 * key set can be exercised without a DOM; the Studio always passes the document
 * element, like every other telemetry value it publishes.
 */
export function publishMemoryDataset(
  values: Partial<Record<MemoryLedgerDatasetKey, string>>,
  target: Record<string, string | undefined> = document.documentElement.dataset,
): void {
  for (const [key, value] of Object.entries(values)) target[key] = value;
}

export function clearMemoryDataset(
  target: Record<string, string | undefined> = document.documentElement.dataset,
): void {
  for (const key of memoryLedgerDatasetKeys) delete target[key];
}
