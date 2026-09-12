import { decodeSpatialDemandIndex, openPackageTransport } from "@naru3d/runtime-webgpu";
import type {
  CompiledHierarchy,
  CompiledSpatialIndexRef,
  DecodedSpatialDemandIndex,
  PackageTransport,
} from "@naru3d/runtime-webgpu";

import { resourceFileName } from "./resource-name.js";

export type SpatialDemandSource =
  | {
      readonly kind: "url";
      readonly ref: CompiledSpatialIndexRef;
      readonly url: URL;
      /** Settled by the loader that fetched the glTF; defaulted when absent. */
      readonly transport?: PackageTransport;
    }
  | {
      readonly kind: "file";
      readonly ref: CompiledSpatialIndexRef;
      readonly file: File;
    };

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function readBytes(source: SpatialDemandSource, signal?: AbortSignal): Promise<Uint8Array> {
  if (source.kind === "file") return new Uint8Array(await source.file.arrayBuffer());
  const transport = source.transport ?? openPackageTransport(source.url);
  // The declared length is the ceiling: a longer body is refused while it
  // streams, and the digest below still has to match afterwards.
  return transport.fetchResource(source.url, {
    kind: "binary",
    label: source.url.href,
    limitBytes: transport.resourceLimit(source.ref.byteLength),
    expected: { sha256: source.ref.sha256, byteLength: source.ref.byteLength },
    ...(signal ? { signal } : {}),
  });
}

/** Loads, authenticates, and decodes the optional compiler-built demand index. */
export async function loadSpatialDemandIndex(
  source: SpatialDemandSource,
  hierarchy: CompiledHierarchy,
  signal?: AbortSignal,
): Promise<DecodedSpatialDemandIndex> {
  if (source.kind === "file" && source.file.name !== resourceFileName(source.ref.uri)) {
    throw new TypeError(`The glTF expects ${resourceFileName(source.ref.uri)}; selected binary is ${source.file.name}.`);
  }
  const bytes = await readBytes(source, signal);
  if (bytes.byteLength !== source.ref.byteLength) {
    throw new RangeError(
      `${source.ref.uri} must be ${String(source.ref.byteLength)} bytes; received ${String(bytes.byteLength)}.`,
    );
  }
  const digest = await sha256(bytes);
  if (digest !== source.ref.sha256) {
    throw new TypeError(`Spatial demand index digest mismatch for ${source.ref.uri}.`);
  }
  return decodeSpatialDemandIndex(bytes, {
    gltfNodeCount: hierarchy.nodeCount,
    targetChunkCount: hierarchy.targetChunks.length,
    expectedOccurrenceCount: hierarchy.renderableOccurrences,
  });
}
