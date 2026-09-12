import {
  compiledSceneTransferables,
  openPackageTransport,
  PackageTransport,
  prepareCompiledGltfDecoder,
} from "@naru3d/runtime-webgpu";
import type {
  CompiledHierarchy,
  GeometryRepresentation,
  PackageTransportDescriptor,
  PreparedCompiledGltfDecoder,
  ResidencyCost,
} from "@naru3d/runtime-webgpu";

import { aggregateCoarseScene } from "./coarse-aggregation.js";
import { transitSceneForResponse } from "./geometry-transfer.js";
import type { GeometryTransitScene } from "./geometry-transfer.js";
import { loadDocumentHierarchySidecar } from "./hierarchy-sidecar.js";
import type { DocumentHierarchyResources } from "./hierarchy-sidecar.js";
import type { GeometryBinarySource, GeometryDocumentSource } from "./scene-source.js";

export type GeometryWorkerRequest =
  | {
      readonly type: "initialize";
      readonly requestId: number;
      readonly source: GeometryDocumentSource;
      /** Transfer policy the scene loader settled; defaults are used without it. */
      readonly transport?: PackageTransportDescriptor;
      /** `.json` files selected beside a local glTF, for a relocated hierarchy. */
      readonly localSidecarFiles?: readonly File[];
      /** `.bin` files selected beside a local glTF, for that sidecar's columns. */
      readonly localBinaryFiles?: readonly File[];
    }
  | {
      readonly type: "decode";
      readonly requestId: number;
      readonly binary: GeometryBinarySource;
      readonly representation: GeometryRepresentation;
      readonly targetChunkId?: string;
    }
  | {
      readonly type: "cancel";
      /** Request id of the in-flight decode whose fetch should be aborted. */
      readonly requestId: number;
    };

export type GeometryWorkerResponse =
  | {
      readonly type: "initialized";
      readonly requestId: number;
      /**
       * The assembly tree this Worker read while parsing the document. It is
       * posted rather than rebuilt so the document is parsed once per scene.
       */
      readonly hierarchy: CompiledHierarchy;
      /** Per-chunk residency cost, so the scheduler can refuse before fetching. */
      readonly targetChunkResidencyCosts: ReadonlyMap<string, ResidencyCost>;
      /** Sidecar bytes a relocated hierarchy cost, for the retention ledger. */
      readonly relocatedHierarchyBytes?: number;
    }
  | {
      readonly type: "ready";
      readonly requestId: number;
      /** Chunk decodes omit the hierarchy; the decoder reattaches its cached copy. */
      readonly scene: GeometryTransitScene;
      readonly coarseInstanceTargetMeshIndexes?: Uint32Array;
      readonly decodeMilliseconds: number;
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly message: string;
      readonly name?: string;
    };

interface WorkerHost {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<GeometryWorkerRequest>) => void,
  ): void;
  postMessage(message: GeometryWorkerResponse, transfer?: readonly Transferable[]): void;
}

const worker = globalThis as unknown as WorkerHost;
let compiledDecoder: PreparedCompiledGltfDecoder | undefined;
let packageTransport: PackageTransport | undefined;
const activeDecodes = new Map<number, AbortController>();

worker.addEventListener("message", (event) => {
  if (event.data.type === "cancel") {
    activeDecodes.get(event.data.requestId)?.abort();
    return;
  }
  void handleRequest(event.data);
});

async function handleRequest(
  request: Exclude<GeometryWorkerRequest, { readonly type: "cancel" }>,
): Promise<void> {
  try {
    if (request.type === "initialize") {
      packageTransport = request.transport
        ? PackageTransport.fromDescriptor(request.transport)
        : undefined;
      const document = await parseDocument(request.source);
      const sidecar = await loadDocumentHierarchySidecar(
        document,
        hierarchyResources(request),
      );
      // One parse per scene: this Worker owns the only copy of the document, so
      // it reads the assembly tree as it walks it and posts the tree back
      // rather than have the main thread parse the same bytes again.
      compiledDecoder = prepareCompiledGltfDecoder(
        document,
        sidecar ? { hierarchy: sidecar.sidecar } : {},
      );
      worker.postMessage({
        type: "initialized",
        requestId: request.requestId,
        hierarchy: compiledDecoder.hierarchy,
        targetChunkResidencyCosts: compiledDecoder.targetChunkResidencyCosts,
        ...(sidecar ? { relocatedHierarchyBytes: sidecar.byteLength } : {}),
      });
      return;
    }
    await decode(request);
  } catch (error) {
    worker.postMessage({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error ? { name: error.name } : {}),
    });
  }
}

/**
 * Parses the compiled document from the bytes the loader handed over. The
 * decoded text is scoped to this call so it becomes collectable as soon as the
 * object graph exists, instead of staying alive beside it for the session.
 */
async function parseDocument(source: GeometryDocumentSource): Promise<unknown> {
  const text = source.kind === "bytes"
    ? new TextDecoder().decode(source.bytes)
    : await source.file.text();
  return JSON.parse(text) as unknown;
}

/**
 * Where a relocated hierarchy sidecar is read from. A URL scene resolves it
 * under the policy the loader settled; a local scene has to find it among the
 * files the user selected beside the glTF.
 */
function hierarchyResources(
  request: Extract<GeometryWorkerRequest, { readonly type: "initialize" }>,
): DocumentHierarchyResources {
  if (request.source.kind === "file") {
    return {
      kind: "file",
      sidecarFiles: request.localSidecarFiles ?? [],
      binaryFiles: request.localBinaryFiles ?? [],
    };
  }
  return packageTransport
    ? { kind: "url", transport: packageTransport }
    : { kind: "url" };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Obsolete target request.", "AbortError");
}

async function loadBinary(
  source: GeometryBinarySource,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  if (source.kind === "file") {
    const binary = await (source.byteOffset === undefined || source.byteLength === undefined
      ? source.file.arrayBuffer()
      : source.file
          .slice(source.byteOffset, source.byteOffset + source.byteLength)
          .arrayBuffer());
    throwIfAborted(signal);
    return binary;
  }

  // The scene loader already resolved this href against the glTF document and
  // held it to the package origins; the same policy is re-applied here because
  // the Worker fetches on its own. Without one -- a local file scene, or a
  // caller that sent no descriptor -- the reviewed defaults apply.
  const url = new URL(source.href);
  const transport = packageTransport ?? openPackageTransport(url);
  const ranged = source.byteOffset !== undefined && source.byteLength !== undefined;
  const response = await transport.open(url, {
    kind: "binary",
    label: source.href,
    signal,
    ...(ranged
      ? { range: { byteOffset: source.byteOffset, byteLength: source.byteLength } }
      : {}),
  });
  // A served range may hold only what was asked for; a host that answers the
  // whole buffer instead is bounded by the single-resource ceiling.
  const limitBytes = response.status === 206 && source.byteLength !== undefined
    ? source.byteLength
    : transport.limits.resourceBytes;
  const bytes = await transport.read(response, limitBytes, source.href);
  if (!ranged || source.byteOffset === undefined || source.byteLength === undefined) {
    return toArrayBuffer(bytes);
  }
  if (response.status === 206) {
    const expectedEnd = source.byteOffset + source.byteLength - 1;
    const contentRange = response.headers.get("Content-Range");
    const parsedRange = contentRange
      ? /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange)
      : undefined;
    if (
      bytes.byteLength !== source.byteLength ||
      !parsedRange ||
      Number(parsedRange[1]) !== source.byteOffset ||
      Number(parsedRange[2]) !== expectedEnd ||
      Number(parsedRange[3]) <= expectedEnd
    ) {
      throw new Error("Partial geometry response does not match the requested range.");
    }
    return toArrayBuffer(bytes);
  }
  if (response.status === 200 && bytes.byteLength >= source.byteOffset + source.byteLength) {
    return toArrayBuffer(
      bytes.slice(source.byteOffset, source.byteOffset + source.byteLength),
    );
  }
  if (bytes.byteLength !== source.byteLength) {
    throw new Error("Geometry host ignored Range without returning the complete buffer.");
  }
  return toArrayBuffer(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : bytes.slice().buffer;
}

async function decode(
  request: Extract<GeometryWorkerRequest, { readonly type: "decode" }>,
): Promise<void> {
  if (!compiledDecoder) throw new Error("The geometry Worker is not initialized.");
  const cancellation = new AbortController();
  activeDecodes.set(request.requestId, cancellation);
  try {
    const startedAt = performance.now();
    const binary = await loadBinary(request.binary, cancellation.signal);
    throwIfAborted(cancellation.signal);
    const decoded = compiledDecoder.decode(binary, {
      representation: request.representation,
      ...(request.targetChunkId ? { targetChunkId: request.targetChunkId } : {}),
    });
    const aggregated = request.representation === "coarse"
      ? aggregateCoarseScene(decoded)
      : undefined;
    const scene = aggregated ?? decoded;
    const transferables = compiledSceneTransferables(scene);
    const coarseInstanceTargetMeshIndexes = aggregated?.coarseInstanceTargetMeshIndexes;
    if (coarseInstanceTargetMeshIndexes?.buffer instanceof ArrayBuffer) {
      transferables.push(coarseInstanceTargetMeshIndexes.buffer);
    }
    worker.postMessage(
      {
        type: "ready",
        requestId: request.requestId,
        scene: transitSceneForResponse(scene),
        ...(coarseInstanceTargetMeshIndexes ? { coarseInstanceTargetMeshIndexes } : {}),
        decodeMilliseconds: performance.now() - startedAt,
      },
      transferables,
    );
  } finally {
    activeDecodes.delete(request.requestId);
  }
}
