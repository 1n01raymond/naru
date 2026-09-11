import type {
  CompiledTargetChunk,
  DecodedSpatialDemandIndex,
  DecodedCompiledScene,
  GpuOccurrenceInstance,
  GpuPrototypeBatch,
  SpatialDemandPriority,
} from "@naru3d/runtime-webgpu";
import { querySpatialDemandIndex } from "@naru3d/runtime-webgpu";

import type { CameraRelativeFrame } from "./view.js";

type Vector3 = readonly [number, number, number];

export interface RankedTargetChunk {
  readonly chunk: CompiledTargetChunk;
  /** Lower values are hotter and suitable for residency eviction priority. */
  readonly viewPriority: number;
  readonly visibleBounds: boolean;
  readonly screenDistanceSquared: number;
  /** False for cold chunks retained only to update eviction priority. */
  readonly demanded: boolean;
}

export interface TargetChunkRanker {
  rank(frame: CameraRelativeFrame): readonly RankedTargetChunk[];
}

interface WorldBounds {
  readonly minimum: Vector3;
  readonly maximum: Vector3;
}

interface ChunkLocation {
  readonly chunk: CompiledTargetChunk;
  readonly bounds: WorldBounds;
}

export interface TargetSchedulerEvent {
  /** `skipped` is a `blocked` the gate reached without spending a request. */
  readonly type: "request" | "cancel" | "admit" | "blocked" | "skipped";
  readonly chunkId: string;
  readonly viewPriority: number;
}

export interface TargetSchedulerHooks<Result> {
  readonly isResident: (chunk: CompiledTargetChunk) => boolean;
  /**
   * Whether the residency budget could still take this chunk. Answered from
   * the compiled document before any bytes move, so a chunk that cannot be
   * admitted costs neither a range request nor a decode. Chunks whose cost is
   * unknown must answer true: the loaded result then decides, as before.
   */
  readonly mayAdmit?: (chunk: CompiledTargetChunk, viewPriority: number) => boolean;
  readonly load: (chunk: CompiledTargetChunk, signal: AbortSignal) => Promise<Result>;
  readonly admit: (
    chunk: CompiledTargetChunk,
    result: Result,
    viewPriority: number,
  ) => boolean;
  readonly reprioritize?: (ranked: readonly RankedTargetChunk[]) => void;
  readonly onEvent?: (event: TargetSchedulerEvent) => void;
  readonly onError: (error: unknown) => void;
}

function localBounds(batch: GpuPrototypeBatch): WorldBounds {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < batch.surfaceVertices.length; offset += 6) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = batch.surfaceVertices[offset + axis];
      if (value === undefined) throw new RangeError("Incomplete coarse surface position.");
      minimum[axis] = Math.min(minimum[axis] ?? Infinity, value);
      maximum[axis] = Math.max(maximum[axis] ?? -Infinity, value);
    }
  }
  if (minimum.some((value) => !Number.isFinite(value))) {
    throw new TypeError("A coarse batch must contain finite surface positions.");
  }
  return {
    minimum: [minimum[0] ?? 0, minimum[1] ?? 0, minimum[2] ?? 0],
    maximum: [maximum[0] ?? 0, maximum[1] ?? 0, maximum[2] ?? 0],
  };
}

function transformedPoint(instance: GpuOccurrenceInstance, point: Vector3): Vector3 {
  const transform = instance.transform;
  return [
    (transform[0] ?? 0) * point[0] +
      (transform[4] ?? 0) * point[1] +
      (transform[8] ?? 0) * point[2] +
      (transform[12] ?? 0),
    (transform[1] ?? 0) * point[0] +
      (transform[5] ?? 0) * point[1] +
      (transform[9] ?? 0) * point[2] +
      (transform[13] ?? 0),
    (transform[2] ?? 0) * point[0] +
      (transform[6] ?? 0) * point[1] +
      (transform[10] ?? 0) * point[2] +
      (transform[14] ?? 0),
  ];
}

function targetBounds(
  scene: DecodedCompiledScene,
  aggregateTargetMeshIndexes?: Uint32Array,
): ReadonlyMap<number, WorldBounds> {
  const bounds = new Map<
    number,
    { minimum: [number, number, number]; maximum: [number, number, number] }
  >();
  const append = (
    targetMeshIndex: number,
    instance: GpuOccurrenceInstance,
    local: WorldBounds,
  ): void => {
    const group = bounds.get(targetMeshIndex) ?? {
      minimum: [Infinity, Infinity, Infinity],
      maximum: [-Infinity, -Infinity, -Infinity],
    };
    for (const x of [local.minimum[0], local.maximum[0]]) {
      for (const y of [local.minimum[1], local.maximum[1]]) {
        for (const z of [local.minimum[2], local.maximum[2]]) {
          const point = transformedPoint(instance, [x, y, z]);
          for (const axis of [0, 1, 2] as const) {
            group.minimum[axis] = Math.min(group.minimum[axis], point[axis]);
            group.maximum[axis] = Math.max(group.maximum[axis], point[axis]);
          }
        }
      }
    }
    bounds.set(targetMeshIndex, group);
  };

  if (aggregateTargetMeshIndexes) {
    const batch = scene.gpuScene.batches[0];
    if (!batch || batch.instances.length !== aggregateTargetMeshIndexes.length) {
      throw new RangeError("Aggregated coarse target-mesh indexes do not match its instances.");
    }
    const local = localBounds(batch);
    batch.instances.forEach((instance, index) => {
      const targetMeshIndex = aggregateTargetMeshIndexes[index];
      if (targetMeshIndex === undefined) throw new RangeError("Missing aggregate target mesh index.");
      append(targetMeshIndex, instance, local);
    });
    return bounds;
  }

  scene.batchEvidence.forEach((evidence, batchIndex) => {
    const batch = scene.gpuScene.batches[batchIndex];
    if (!batch) throw new RangeError(`Missing coarse batch ${batchIndex}.`);
    const local = localBounds(batch);
    for (const instance of batch.instances) append(evidence.targetMeshIndex, instance, local);
  });
  return bounds;
}

function projectedPoint(
  frame: CameraRelativeFrame,
  center: Vector3,
): Vector3 {
  const x = center[0] - frame.origin[0];
  const y = center[1] - frame.origin[1];
  const z = center[2] - frame.origin[2];
  const matrix = frame.viewProjection;
  const projectedX =
    (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0);
  const projectedY =
    (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0);
  const projectedZ =
    (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0);
  return [projectedX, projectedY, projectedZ];
}

function projectedBounds(
  frame: CameraRelativeFrame,
  bounds: WorldBounds,
): { readonly visible: boolean; readonly distanceSquared: number } {
  const projectedMinimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const projectedMaximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const x of [bounds.minimum[0], bounds.maximum[0]]) {
    for (const y of [bounds.minimum[1], bounds.maximum[1]]) {
      for (const z of [bounds.minimum[2], bounds.maximum[2]]) {
        const point = projectedPoint(frame, [x, y, z]);
        for (const axis of [0, 1, 2] as const) {
          projectedMinimum[axis] = Math.min(projectedMinimum[axis], point[axis]);
          projectedMaximum[axis] = Math.max(projectedMaximum[axis], point[axis]);
        }
      }
    }
  }
  const screenX = (projectedMinimum[0] + projectedMaximum[0]) / 2;
  const screenY = (projectedMinimum[1] + projectedMaximum[1]) / 2;
  return {
    visible:
      (projectedMaximum[0] ?? -Infinity) >= -1 &&
      (projectedMinimum[0] ?? Infinity) <= 1 &&
      (projectedMaximum[1] ?? -Infinity) >= -1 &&
      (projectedMinimum[1] ?? Infinity) <= 1 &&
      (projectedMaximum[2] ?? -Infinity) >= 0 &&
      (projectedMinimum[2] ?? Infinity) <= 1,
    distanceSquared: screenX * screenX + screenY * screenY,
  };
}

/** Chunk bounds built once from retained coarse occurrences; no target bytes are needed. */
export class TargetChunkViewIndex implements TargetChunkRanker {
  private readonly locations: readonly ChunkLocation[];

  constructor(
    chunks: readonly CompiledTargetChunk[],
    coarse: DecodedCompiledScene,
    aggregateTargetMeshIndexes?: Uint32Array,
  ) {
    const boundsByTargetMesh = targetBounds(coarse, aggregateTargetMeshIndexes);
    this.locations = chunks.map((chunk) => {
      const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
      const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (const targetMeshIndex of chunk.meshIndexes) {
        const bounds = boundsByTargetMesh.get(targetMeshIndex);
        if (!bounds) continue;
        for (const axis of [0, 1, 2] as const) {
          minimum[axis] = Math.min(minimum[axis], bounds.minimum[axis]);
          maximum[axis] = Math.max(maximum[axis], bounds.maximum[axis]);
        }
      }
      if (minimum.some((value) => !Number.isFinite(value))) {
        throw new RangeError(`Target chunk ${chunk.id} has no retained coarse bounds.`);
      }
      return {
        chunk,
        bounds: { minimum, maximum },
      };
    });
  }

  rank(frame: CameraRelativeFrame): readonly RankedTargetChunk[] {
    const scored = this.locations.map(({ chunk, bounds }) => {
      const projection = projectedBounds(frame, bounds);
      return {
        chunk,
        visibleBounds: projection.visible,
        screenDistanceSquared: projection.distanceSquared,
      };
    });
    scored.sort(
      (left, right) =>
        Number(right.visibleBounds) - Number(left.visibleBounds) ||
        left.screenDistanceSquared - right.screenDistanceSquared ||
        left.chunk.priority - right.chunk.priority ||
        left.chunk.id.localeCompare(right.chunk.id, "en"),
    );
    return scored.map((entry, viewPriority) => ({ ...entry, viewPriority, demanded: true }));
  }
}

export interface SpatialTargetQueryStats {
  readonly visitedNodeCount: number;
  readonly visibleLeafCount: number;
  readonly testedOccurrenceCount: number;
  readonly candidateChunkCount: number;
  readonly queryMilliseconds: number;
}

/** Ranks only frustum-demanded chunks hot while retaining a stable cold eviction tail. */
export class SpatialTargetChunkViewIndex implements TargetChunkRanker {
  private readonly chunks: readonly CompiledTargetChunk[];
  private readonly spatial: DecodedSpatialDemandIndex;
  private readonly priority: SpatialDemandPriority;
  private readonly coldOrder: readonly number[];
  private latest: SpatialTargetQueryStats = {
    visitedNodeCount: 0,
    visibleLeafCount: 0,
    testedOccurrenceCount: 0,
    candidateChunkCount: 0,
    queryMilliseconds: 0,
  };

  constructor(
    chunks: readonly CompiledTargetChunk[],
    spatial: DecodedSpatialDemandIndex,
    priority: SpatialDemandPriority = "screen-distance",
  ) {
    this.chunks = chunks;
    this.spatial = spatial;
    this.priority = priority;
    this.coldOrder = chunks
      .map((_chunk, index) => index)
      .sort(
        (left, right) =>
          chunks[left]!.priority - chunks[right]!.priority ||
          chunks[left]!.id.localeCompare(chunks[right]!.id, "en"),
      );
  }

  queryStats(): SpatialTargetQueryStats {
    return this.latest;
  }

  rank(frame: CameraRelativeFrame): readonly RankedTargetChunk[] {
    const started = performance.now();
    const query = querySpatialDemandIndex(this.spatial, frame, { priority: this.priority });
    this.latest = {
      visitedNodeCount: query.visitedNodeCount,
      visibleLeafCount: query.visibleLeafCount,
      testedOccurrenceCount: query.testedOccurrenceCount,
      candidateChunkCount: query.candidates.length,
      queryMilliseconds: performance.now() - started,
    };
    const demanded = new Set(query.candidates.map(({ targetChunkIndex }) => targetChunkIndex));
    const hot = query.candidates.map(({ targetChunkIndex, screenDistanceSquared }) => {
      const chunk = this.chunks[targetChunkIndex];
      if (!chunk) throw new RangeError(`Spatial demand references missing chunk ${targetChunkIndex}.`);
      // The query already ordered the candidates by the configured policy; the
      // scheduler keeps that order and does not re-sort demanded chunks.
      return { chunk, visibleBounds: true, screenDistanceSquared, demanded: true };
    });
    const cold = this.coldOrder
      .filter((index) => !demanded.has(index))
      .map((index) => ({
        chunk: this.chunks[index]!,
        visibleBounds: false,
        screenDistanceSquared: Infinity,
        demanded: false,
      }));
    return [...hot, ...cold].map((entry, viewPriority) => ({ ...entry, viewPriority }));
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Runs one Range/decode at a time and aborts it when a new view makes it obsolete. */
export class CameraTargetScheduler<Result> {
  private readonly index: TargetChunkRanker;
  private readonly hooks: TargetSchedulerHooks<Result>;
  private ranked: readonly RankedTargetChunk[] = [];
  private rankCursor = 0;
  private active:
    | {
        readonly chunkId: string;
        readonly controller: AbortController;
        readonly viewPriority: number;
      }
    | undefined;
  private running: Promise<void> | undefined;
  private rerun = false;
  private paused = false;
  private stopped = false;
  private blockedDemandSignature: string | undefined;
  private latestDemandSignature = "";
  private readonly rejectedChunkIds = new Set<string>();

  constructor(index: TargetChunkRanker, hooks: TargetSchedulerHooks<Result>) {
    this.index = index;
    this.hooks = hooks;
  }

  update(frame: CameraRelativeFrame): void {
    if (this.stopped) return;
    const ranked = this.index.rank(frame);
    const demandSignature = this.signature(ranked);
    if (demandSignature !== this.latestDemandSignature) {
      this.latestDemandSignature = demandSignature;
      this.rejectedChunkIds.clear();
    }
    this.ranked = ranked;
    this.rankCursor = 0;
    this.hooks.reprioritize?.(this.ranked);
    if (this.blockedDemandSignature === demandSignature) return;
    this.blockedDemandSignature = undefined;
    const next = this.ranked.find(
      ({ chunk, demanded }) =>
        demanded && !this.rejectedChunkIds.has(chunk.id) && !this.hooks.isResident(chunk),
    );
    if (
      this.active &&
      !this.active.controller.signal.aborted &&
      this.active.chunkId !== next?.chunk.id
    ) {
      this.active.controller.abort();
      this.hooks.onEvent?.({
        type: "cancel",
        chunkId: this.active.chunkId,
        viewPriority: this.active.viewPriority,
      });
    }
    this.ensureRun();
  }

  pause(): void {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.active?.controller.abort();
  }

  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.blockedDemandSignature = undefined;
    this.rejectedChunkIds.clear();
    this.rankCursor = 0;
    this.ensureRun();
  }

  /**
   * Forget which chunks the budget rejected and re-examine the current demand.
   *
   * A level switch (ADR-0025) can change what `isResident` and `mayAdmit`
   * answer without changing the ranking, and `update` returns early while the
   * demand signature still matches the one that blocked the drain. Callers that
   * change residency out from under the scheduler call this so the next frame
   * is examined again.
   */
  invalidateResidency(): void {
    if (this.stopped || this.paused) return;
    this.blockedDemandSignature = undefined;
    this.rejectedChunkIds.clear();
    this.rankCursor = 0;
    this.ensureRun();
  }

  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** True while the current demand still contains chunks the budget rejected. */
  get blocked(): boolean {
    return this.blockedDemandSignature !== undefined && this.rejectedChunkIds.size > 0;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.active?.controller.abort();
    this.active = undefined;
    this.blockedDemandSignature = undefined;
    this.rejectedChunkIds.clear();
  }

  private ensureRun(): void {
    if (this.paused || this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        this.ensureRun();
      }
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && !this.paused) {
      let ranked: RankedTargetChunk | undefined;
      while (this.rankCursor < this.ranked.length) {
        const candidate = this.ranked[this.rankCursor];
        this.rankCursor += 1;
        if (
          candidate?.demanded &&
          !this.rejectedChunkIds.has(candidate.chunk.id) &&
          !this.hooks.isResident(candidate.chunk)
        ) {
          ranked = candidate;
          break;
        }
      }
      if (!ranked) {
        // Every remaining demanded chunk is resident or was rejected by the
        // budget; only a demand change can make a rejected chunk fit again.
        if (this.rejectedChunkIds.size > 0) {
          this.blockedDemandSignature = this.latestDemandSignature;
        }
        return;
      }
      if (this.hooks.mayAdmit && !this.hooks.mayAdmit(ranked.chunk, ranked.viewPriority)) {
        // Estimate-gated prefetch: the budget already refuses this chunk, so
        // fetching and decoding it could only end in the rejection below.
        this.rejectedChunkIds.add(ranked.chunk.id);
        this.hooks.onEvent?.({
          type: "skipped",
          chunkId: ranked.chunk.id,
          viewPriority: ranked.viewPriority,
        });
        continue;
      }
      const controller = new AbortController();
      this.active = {
        chunkId: ranked.chunk.id,
        controller,
        viewPriority: ranked.viewPriority,
      };
      this.hooks.onEvent?.({
        type: "request",
        chunkId: ranked.chunk.id,
        viewPriority: ranked.viewPriority,
      });
      try {
        const result = await this.hooks.load(ranked.chunk, controller.signal);
        if (controller.signal.aborted || this.stopped) continue;
        const current = this.ranked.find(({ chunk }) => chunk.id === ranked.chunk.id);
        if (!current) continue;
        const admitted = this.hooks.admit(
          ranked.chunk,
          result,
          current.viewPriority,
        );
        this.hooks.onEvent?.({
          type: admitted ? "admit" : "blocked",
          chunkId: ranked.chunk.id,
          viewPriority: current.viewPriority,
        });
        if (!admitted) {
          // Skip-and-continue: a chunk the budget cannot take right now must
          // not starve smaller chunks ranked behind it.
          this.rejectedChunkIds.add(ranked.chunk.id);
          continue;
        }
      } catch (error) {
        if (!isAbortError(error)) {
          this.hooks.onError(error);
          return;
        }
      } finally {
        if (this.active?.controller === controller) this.active = undefined;
      }
    }
  }

  private signature(ranked: readonly RankedTargetChunk[]): string {
    return ranked
      .filter(({ demanded }) => demanded)
      .map(({ chunk }) => chunk.id)
      .join("\u0000");
  }
}
