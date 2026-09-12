import type {
  CompiledHierarchy,
  DecodedCompiledScene,
  GeometryRepresentation,
  ResidencyCost,
} from "@naru3d/runtime-webgpu";

import { adoptTransitScene } from "./geometry-transfer.js";
import type {
  GeometryWorkerRequest,
  GeometryWorkerResponse,
} from "./geometry.worker.js";
import type {
  GeometryBinarySource,
  OpenedSceneDocument,
  PreparedSceneHierarchy,
} from "./scene-source.js";

export interface GeometryDecodeResult {
  readonly scene: DecodedCompiledScene;
  readonly coarseInstanceTargetMeshIndexes?: Uint32Array;
  readonly decodeMilliseconds: number;
}

interface PendingRequest {
  readonly resolve: (response: GeometryWorkerResponse) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

/**
 * Owns the only parsed copy of one glTF document, in one Worker, for the full
 * scene session. The document is parsed on the Worker thread and the assembly
 * tree it reads is posted back, so the main thread never holds a second parse
 * of the same bytes.
 */
export class GeometryDecoder {
  private readonly worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), {
    type: "module",
    name: "naru-compiled-geometry",
  });
  private readonly pending = new Map<number, PendingRequest>();
  private readonly signal: AbortSignal;
  private readonly prepared: Promise<PreparedSceneHierarchy>;
  private nextRequestId = 0;
  private disposed = false;
  /** Assembly tree the Worker read while parsing, cached for every decode. */
  private hierarchy: CompiledHierarchy | undefined;
  private chunkCosts: ReadonlyMap<string, ResidencyCost> = new Map();

  constructor(document: OpenedSceneDocument, signal: AbortSignal) {
    this.signal = signal;
    this.worker.addEventListener("message", this.receive);
    this.worker.addEventListener("error", this.failWorker);
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) {
      const error = new DOMException("Scene load cancelled.", "AbortError");
      this.dispose(error);
      this.prepared = Promise.reject(error);
      void this.prepared.catch(() => undefined);
      return;
    }
    const { documentSource } = document;
    const transfer = documentSource.kind === "bytes" ? [documentSource.bytes] : [];
    this.prepared = this.request(
      {
        type: "initialize",
        requestId: this.requestId(),
        source: documentSource,
        // The policy the scene loader settled travels with the document, so the
        // ranges and sidecars this Worker fetches are held to the same ceilings
        // and origins.
        ...(document.transport ? { transport: document.transport.describe() } : {}),
        // A local package hands over the files beside the glTF, because a
        // relocated assembly tree is read where the document is parsed.
        ...(document.sidecarFiles ? { localSidecarFiles: document.sidecarFiles } : {}),
        ...(document.binaryFiles ? { localBinaryFiles: document.binaryFiles } : {}),
      },
      transfer,
    ).then((response) => {
      if (response.type !== "initialized") {
        throw new Error("The geometry Worker returned an invalid initialization response.");
      }
      this.chunkCosts = response.targetChunkResidencyCosts;
      this.hierarchy = response.hierarchy;
      return {
        hierarchy: response.hierarchy,
        ...(response.relocatedHierarchyBytes === undefined
          ? {}
          : { relocatedHierarchyBytes: response.relocatedHierarchyBytes }),
      };
    });
    // Keep the rejection observed until ready() or decode() forwards it to the
    // load path, which is where a failed parse is reported.
    void this.prepared.catch(() => undefined);
  }

  /**
   * The assembly tree read from the document, once the Worker has parsed it.
   * Resolves after one parse; rejects with the parse failure otherwise.
   */
  ready(): Promise<PreparedSceneHierarchy> {
    return this.prepared;
  }

  /**
   * Residency cost of each target chunk, measured from the parsed document at
   * initialization. Empty until the Worker reports it.
   */
  get targetChunkResidencyCosts(): ReadonlyMap<string, ResidencyCost> {
    return this.chunkCosts;
  }

  async decode(
    binary: GeometryBinarySource,
    representation: GeometryRepresentation,
    targetChunkId?: string,
    signal?: AbortSignal,
  ): Promise<GeometryDecodeResult> {
    await this.prepared;
    if (signal?.aborted) throw new DOMException("Obsolete target request.", "AbortError");
    const response = await this.request({
      type: "decode",
      requestId: this.requestId(),
      binary,
      representation,
      ...(targetChunkId ? { targetChunkId } : {}),
    }, [], signal);
    if (response.type !== "ready") {
      throw new Error("The geometry Worker returned an invalid decode response.");
    }
    const scene = adoptTransitScene(response.scene, this.hierarchy);
    return {
      scene,
      ...(response.coarseInstanceTargetMeshIndexes
        ? { coarseInstanceTargetMeshIndexes: response.coarseInstanceTargetMeshIndexes }
        : {}),
      decodeMilliseconds: response.decodeMilliseconds,
    };
  }

  dispose(reason: Error = new Error("The geometry decoder was disposed.")): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal.removeEventListener("abort", this.abort);
    this.worker.removeEventListener("message", this.receive);
    this.worker.removeEventListener("error", this.failWorker);
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(reason);
    }
    this.pending.clear();
  }

  private readonly abort = (): void => {
    this.dispose(new DOMException("Scene load cancelled.", "AbortError"));
  };

  private readonly receive = (event: MessageEvent<GeometryWorkerResponse>): void => {
    const pending = this.pending.get(event.data.requestId);
    if (!pending) return;
    this.pending.delete(event.data.requestId);
    pending.cleanup();
    if (event.data.type === "error") {
      pending.reject(
        event.data.name === "AbortError"
          ? new DOMException(event.data.message, "AbortError")
          : new Error(event.data.message),
      );
    }
    else pending.resolve(event.data);
  };

  private readonly failWorker = (event: ErrorEvent): void => {
    this.dispose(new Error(event.message || "The geometry Worker failed."));
  };

  private request(
    message: Exclude<GeometryWorkerRequest, { readonly type: "cancel" }>,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
  ): Promise<GeometryWorkerResponse> {
    if (this.disposed) {
      return Promise.reject(new DOMException("Scene load cancelled.", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Obsolete target request.", "AbortError"));
        return;
      }
      const abort = (): void => {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        pending.cleanup();
        this.worker.postMessage({ type: "cancel", requestId: message.requestId });
        reject(new DOMException("Obsolete target request.", "AbortError"));
      };
      const cleanup = (): void => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(message.requestId, { resolve, reject, cleanup });
      try {
        this.worker.postMessage(message, transfer);
      } catch (error) {
        this.pending.delete(message.requestId);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private requestId(): number {
    this.nextRequestId += 1;
    return this.nextRequestId;
  }
}
