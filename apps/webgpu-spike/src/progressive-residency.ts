import { batchResidencyCost } from "@naru3d/runtime-webgpu";
import type {
  CompiledBatchEvidence,
  DecodedCompiledScene,
  GeometryRepresentation,
  GpuPrototypeBatch,
  ResidencyCost,
} from "@naru3d/runtime-webgpu";

export const defaultProgressiveResidencyBudget = 64 * 1024 * 1024;

export interface ResidentBatch {
  readonly key: string;
  readonly batch: GpuPrototypeBatch;
  /**
   * The representation the batch was decoded from. Coarse fallbacks are
   * prototype bounding boxes and are drawn through the renderer's fallback
   * pipelines so resident target detail wins any shared plane.
   */
  readonly representation: GeometryRepresentation;
  readonly evidence: Omit<CompiledBatchEvidence, "batchIndex">;
}

export interface ResidencyBudget {
  /** Maximum decoded typed-array payload retained by the runtime. */
  readonly decodedBytes: number;
  /** Maximum geometry and instance buffer allocation submitted to WebGPU. */
  readonly gpuBytes: number;
}

export interface ResidencySnapshot {
  readonly entries: readonly ResidentBatch[];
  /** Target mesh groups currently replacing their coarse fallbacks. */
  readonly targetMeshIndexes: readonly number[];
  /** Target mesh groups protected from eviction by the current selection. */
  readonly pinnedTargetMeshIndexes: readonly number[];
  readonly decodedBytes: number;
  readonly gpuBytes: number;
  readonly triangles: number;
  readonly edgeSegments: number;
}

export interface PromotionResult extends ResidencySnapshot {
  readonly admitted: boolean;
  /** Target groups replaced with their retained coarse fallback for this admission. */
  readonly evictedTargetMeshIndexes: readonly number[];
}

export interface PromotionOptions {
  /** Lower values are hotter; compiled or view-derived chunk priority is suitable here. */
  readonly priority?: number;
  /** Make this request's target groups eviction-proof until the next selection boost. */
  readonly pin?: boolean;
}

export interface ResidencyPriority {
  readonly targetMeshIndexes: readonly number[];
  readonly priority: number;
}

export interface ProgressiveResidencyOptions {
  /** Keep one shared coarse batch resident and mask its promoted instances. */
  readonly aggregateCoarse?: boolean;
}

/**
 * Charges one decoded batch through the shared cost formula the compiled
 * decoder also applies to accessor counts, so a chunk measured before its
 * fetch and the same chunk after its decode cost exactly the same.
 */
function costOfBatch(batch: GpuPrototypeBatch, sharesSurfaceVertices = false): ResidencyCost {
  return batchResidencyCost({
    surfaceVertexBytes: batch.surfaceVertices.byteLength,
    surfaceIndexBytes: batch.surfaceIndices.byteLength,
    edgeVertexBytes: batch.edgeVertices.byteLength,
    instanceCount: batch.instances.length,
    sharesSurfaceVertices,
  });
}

/** Exact source payload used to create the four renderer buffers for one batch. */
export function estimateBatchDecodedBytes(batch: GpuPrototypeBatch): number {
  return costOfBatch(batch).decodedBytes;
}

/** WebGPU's four-byte buffer alignment is included in this conservative estimate. */
export function estimateBatchGpuBytes(batch: GpuPrototypeBatch): number {
  return costOfBatch(batch).gpuBytes;
}

export function residentBatchKey(
  evidence: Omit<CompiledBatchEvidence, "batchIndex">,
): string {
  return `${evidence.targetMeshIndex}:${evidence.surfacePrimitiveIndex}`;
}

function ordered(entries: ReadonlyMap<string, ResidentBatch>): readonly ResidentBatch[] {
  return [...entries.values()].sort(
    (left, right) =>
      left.evidence.targetMeshIndex - right.evidence.targetMeshIndex ||
      left.evidence.surfacePrimitiveIndex - right.evidence.surfacePrimitiveIndex,
  );
}

/**
 * Running byte/triangle sums over one entry map. Every term is an integer
 * (index counts are triangle triples, edge vertices are segment sextets), so
 * incremental adds and removes stay exact in any order.
 */
interface ResidencyTotals {
  decodedBytes: number;
  gpuBytes: number;
  triangles: number;
  edgeSegments: number;
  /** Retained coarse fallbacks of promoted target groups (legacy mode only). */
  fallbackDecodedBytes: number;
  /**
   * Resident batches per shared vertex pool, by array identity. The decoder
   * hands one prototype's material groups the same interleaved array, and the
   * renderer allocates one buffer for it, so the pool is charged while at
   * least one of those batches is resident and released with the last of them.
   */
  vertexPools: Map<Float32Array, number>;
}

function addBatchToTotals(totals: ResidencyTotals, batch: GpuPrototypeBatch): void {
  const resident = totals.vertexPools.get(batch.surfaceVertices) ?? 0;
  totals.vertexPools.set(batch.surfaceVertices, resident + 1);
  const cost = costOfBatch(batch, resident > 0);
  totals.decodedBytes += cost.decodedBytes;
  totals.gpuBytes += cost.gpuBytes;
  totals.triangles += batch.surfaceIndices.length / 3;
  totals.edgeSegments += batch.edgeVertices.length / 6;
}

function removeBatchFromTotals(totals: ResidencyTotals, batch: GpuPrototypeBatch): void {
  // Charges are fungible: the pool costs the same whichever sibling paid for
  // it, so the departing batch keeps the charge exactly when siblings remain.
  const remaining = (totals.vertexPools.get(batch.surfaceVertices) ?? 1) - 1;
  if (remaining > 0) totals.vertexPools.set(batch.surfaceVertices, remaining);
  else totals.vertexPools.delete(batch.surfaceVertices);
  const cost = costOfBatch(batch, remaining > 0);
  totals.decodedBytes -= cost.decodedBytes;
  totals.gpuBytes -= cost.gpuBytes;
  totals.triangles -= batch.surfaceIndices.length / 3;
  totals.edgeSegments -= batch.edgeVertices.length / 6;
}

function entriesFromScene(scene: DecodedCompiledScene): readonly ResidentBatch[] {
  return scene.batchEvidence.map((identity) => {
    const batch = scene.gpuScene.batches[identity.batchIndex];
    if (!batch) throw new Error("Compiled geometry batch identity is incomplete.");
    const { batchIndex: _, ...evidence } = identity;
    return {
      key: residentBatchKey(evidence),
      batch,
      representation: scene.summary.representation,
      evidence,
    };
  });
}

/**
 * Holds the current coarse/target mix. The legacy path retains per-target
 * coarse batches; aggregate mode keeps one shared coarse batch and lets the
 * visibility layer mask promoted instances. Both paths can displace colder
 * target groups without losing pickable identity or exceeding either budget.
 *
 * Budget totals are maintained incrementally so an admission costs work
 * proportional to the entries it adds, removes, or evicts — never a full
 * recount of the resident set per eviction probe.
 */
export class ProgressiveResidency {
  readonly budget: ResidencyBudget;
  private readonly entries = new Map<string, ResidentBatch>();
  private readonly coarseEntriesByTargetMesh = new Map<number, readonly ResidentBatch[]>();
  private readonly coarseDecodedBytesByTargetMesh = new Map<number, number>();
  private readonly targetMeshIndexes = new Set<number>();
  /**
   * Mesh indexes whose decoded batches are resident, whatever level drew
   * them. Residency keys every group on its target mesh, but a chunk names
   * the meshes of its own level (ADR-0025), so a reduced chunk can only ask
   * "am I resident?" against the meshes it actually carries.
   */
  private readonly residentMeshIndexes = new Set<number>();
  private readonly pinnedTargetMeshIndexes = new Set<number>();
  private readonly priorityByTargetMesh = new Map<number, number>();
  private readonly lastTouchedByTargetMesh = new Map<number, number>();
  private totals: ResidencyTotals = {
    decodedBytes: 0,
    gpuBytes: 0,
    triangles: 0,
    edgeSegments: 0,
    fallbackDecodedBytes: 0,
    vertexPools: new Map(),
  };
  private readonly aggregateCoarse: boolean;
  private touchSequence = 0;

  constructor(
    coarse: DecodedCompiledScene,
    budget: ResidencyBudget,
    options: ProgressiveResidencyOptions = {},
  ) {
    if (
      !Number.isSafeInteger(budget.decodedBytes) ||
      !Number.isSafeInteger(budget.gpuBytes) ||
      budget.decodedBytes < 4 ||
      budget.gpuBytes < 4
    ) {
      throw new TypeError("Residency budgets must be integer values of at least four bytes.");
    }
    this.budget = budget;
    this.aggregateCoarse = options.aggregateCoarse === true;
    // A pool belongs to one mesh and a mesh to one target group, so charging
    // each pool once globally charges each fallback group once.
    const chargedCoarsePools = new Set<Float32Array>();
    for (const entry of entriesFromScene(coarse)) {
      const residencyEntry = this.aggregateCoarse
        ? { ...entry, key: "coarse:aggregate" }
        : entry;
      if (this.entries.has(residencyEntry.key)) {
        throw new RangeError(`Duplicate coarse residency key ${residencyEntry.key}.`);
      }
      this.entries.set(residencyEntry.key, residencyEntry);
      addBatchToTotals(this.totals, residencyEntry.batch);
      if (this.aggregateCoarse) continue;
      const targetMeshIndex = entry.evidence.targetMeshIndex;
      const group = this.coarseEntriesByTargetMesh.get(targetMeshIndex) ?? [];
      this.coarseEntriesByTargetMesh.set(targetMeshIndex, [...group, entry]);
      const sharesSurfaceVertices = chargedCoarsePools.has(entry.batch.surfaceVertices);
      chargedCoarsePools.add(entry.batch.surfaceVertices);
      this.coarseDecodedBytesByTargetMesh.set(
        targetMeshIndex,
        (this.coarseDecodedBytesByTargetMesh.get(targetMeshIndex) ?? 0) +
          costOfBatch(entry.batch, sharesSurfaceVertices).decodedBytes,
      );
    }
    if (
      this.totals.decodedBytes > budget.decodedBytes ||
      this.totals.gpuBytes > budget.gpuBytes
    ) {
      throw new RangeError("The coarse representation exceeds the configured residency budget.");
    }
  }

  current(): ResidencySnapshot {
    return {
      entries: ordered(this.entries),
      targetMeshIndexes: [...this.targetMeshIndexes].sort((left, right) => left - right),
      pinnedTargetMeshIndexes: [...this.pinnedTargetMeshIndexes].sort(
        (left, right) => left - right,
      ),
      decodedBytes: this.totals.decodedBytes + this.totals.fallbackDecodedBytes,
      gpuBytes: this.totals.gpuBytes,
      triangles: this.totals.triangles,
      edgeSegments: this.totals.edgeSegments,
    };
  }

  /**
   * Whether an admission of `cost` at `priority` could still succeed.
   *
   * `promote` only ever displaces groups colder than the incoming priority, so
   * when none exists the free headroom is the entire answer and a larger chunk
   * cannot be admitted under any eviction order. The test is deliberately
   * optimistic everywhere else -- an unknown group priority counts as
   * evictable, and a legacy-mode coarse fallback is not charged -- because a
   * caller uses it to skip a fetch, and refusing a chunk `promote` would have
   * taken would drop geometry the budget could hold.
   */
  mayAdmit(cost: ResidencyCost, priority: number): boolean {
    if (!Number.isSafeInteger(priority) || priority < 0) {
      throw new TypeError("Target residency priority must be a non-negative safe integer.");
    }
    if (
      cost.decodedBytes > this.budget.decodedBytes ||
      cost.gpuBytes > this.budget.gpuBytes
    ) {
      // Its own bytes outlast every eviction; no view of this scene admits it.
      return false;
    }
    if (
      cost.decodedBytes <=
        this.budget.decodedBytes - this.totals.decodedBytes - this.totals.fallbackDecodedBytes &&
      cost.gpuBytes <= this.budget.gpuBytes - this.totals.gpuBytes
    ) {
      return true;
    }
    return this.hasColderGroup(priority);
  }

  private hasColderGroup(priority: number): boolean {
    for (const targetMeshIndex of this.targetMeshIndexes) {
      if (this.pinnedTargetMeshIndexes.has(targetMeshIndex)) continue;
      const meshPriority =
        this.priorityByTargetMesh.get(targetMeshIndex) ?? Number.MAX_SAFE_INTEGER;
      if (meshPriority > priority) return true;
    }
    return false;
  }

  hasTargetMeshes(targetMeshIndexes: readonly number[]): boolean {
    return targetMeshIndexes.every((targetMeshIndex) => this.targetMeshIndexes.has(targetMeshIndex));
  }

  /**
   * Whether every decoded mesh of a chunk is resident, at any level. Callers
   * that mean "this prototype has target detail" want `hasTargetMeshes`; a
   * caller holding a chunk of an unknown level wants this.
   */
  hasMeshes(meshIndexes: readonly number[]): boolean {
    return meshIndexes.every((meshIndex) => this.residentMeshIndexes.has(meshIndex));
  }

  /** Whether any of these target groups is pinned by the current selection. */
  hasPinnedTargetMeshes(targetMeshIndexes: readonly number[]): boolean {
    return targetMeshIndexes.some((targetMeshIndex) =>
      this.pinnedTargetMeshIndexes.has(targetMeshIndex),
    );
  }

  /** Pins already-resident target groups after selecting an object. */
  pinTargetMeshes(targetMeshIndexes: readonly number[]): void {
    this.pinnedTargetMeshIndexes.clear();
    for (const targetMeshIndex of targetMeshIndexes) {
      if (!this.targetMeshIndexes.has(targetMeshIndex)) continue;
      this.pinnedTargetMeshIndexes.add(targetMeshIndex);
      this.touch(targetMeshIndex);
    }
  }

  /** Re-ranks resident detail after the camera/view priority order changes. */
  reprioritize(groups: readonly ResidencyPriority[]): void {
    for (const group of groups) {
      if (!Number.isSafeInteger(group.priority) || group.priority < 0) {
        throw new TypeError("Target residency priority must be a non-negative safe integer.");
      }
      for (const targetMeshIndex of group.targetMeshIndexes) {
        if (this.targetMeshIndexes.has(targetMeshIndex)) {
          this.priorityByTargetMesh.set(targetMeshIndex, group.priority);
        }
      }
    }
  }

  promote(target: DecodedCompiledScene, options: PromotionOptions = {}): PromotionResult {
    const priority = options.priority ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(priority) || priority < 0) {
      throw new TypeError("Target residency priority must be a non-negative safe integer.");
    }
    const replacements = entriesFromScene(target);
    const targetMeshes = new Set(
      replacements.map(({ evidence }) => evidence.targetMeshIndex),
    );
    const candidate = new Map(this.entries);
    const totals: ResidencyTotals = {
      ...this.totals,
      vertexPools: new Map(this.totals.vertexPools),
    };
    const keysByTargetMesh = new Map<number, string[]>();
    for (const entry of candidate.values()) {
      const keys = keysByTargetMesh.get(entry.evidence.targetMeshIndex);
      if (keys) keys.push(entry.key);
      else keysByTargetMesh.set(entry.evidence.targetMeshIndex, [entry.key]);
    }
    const removeEntry = (key: string): void => {
      const entry = candidate.get(key);
      if (!entry) return;
      candidate.delete(key);
      removeBatchFromTotals(totals, entry.batch);
    };
    const addEntry = (entry: ResidentBatch): void => {
      removeEntry(entry.key);
      candidate.set(entry.key, entry);
      addBatchToTotals(totals, entry.batch);
      const keys = keysByTargetMesh.get(entry.evidence.targetMeshIndex);
      if (keys) keys.push(entry.key);
      else keysByTargetMesh.set(entry.evidence.targetMeshIndex, [entry.key]);
    };
    const removeTargetMesh = (targetMeshIndex: number): void => {
      for (const key of keysByTargetMesh.get(targetMeshIndex) ?? []) removeEntry(key);
      keysByTargetMesh.delete(targetMeshIndex);
    };

    for (const targetMeshIndex of targetMeshes) removeTargetMesh(targetMeshIndex);
    for (const replacement of replacements) addEntry(replacement);
    const candidateTargetMeshes = new Set(this.targetMeshIndexes);
    for (const targetMeshIndex of targetMeshes) {
      if (candidateTargetMeshes.has(targetMeshIndex)) continue;
      candidateTargetMeshes.add(targetMeshIndex);
      totals.fallbackDecodedBytes +=
        this.coarseDecodedBytesByTargetMesh.get(targetMeshIndex) ?? 0;
    }
    const candidatePins = options.pin
      ? new Set(targetMeshes)
      : new Set(
          [...this.pinnedTargetMeshIndexes].filter((targetMeshIndex) =>
            candidateTargetMeshes.has(targetMeshIndex),
          ),
        );
    const candidatePriorities = new Map(this.priorityByTargetMesh);
    const candidateTouches = new Map(this.lastTouchedByTargetMesh);
    for (const targetMeshIndex of targetMeshes) {
      candidatePriorities.set(targetMeshIndex, priority);
      candidateTouches.set(targetMeshIndex, this.nextTouch());
    }

    const fitsBudget = (): boolean =>
      totals.decodedBytes + totals.fallbackDecodedBytes <= this.budget.decodedBytes &&
      totals.gpuBytes <= this.budget.gpuBytes;
    const evictedTargetMeshIndexes: number[] = [];
    while (!fitsBudget()) {
      const eviction = this.selectEviction(
        candidateTargetMeshes,
        targetMeshes,
        candidatePins,
        candidatePriorities,
        candidateTouches,
        priority,
        options.pin === true,
      );
      if (eviction === undefined) {
        return { admitted: false, evictedTargetMeshIndexes: [], ...this.current() };
      }
      removeTargetMesh(eviction);
      if (!this.aggregateCoarse) {
        const coarse = this.coarseEntriesByTargetMesh.get(eviction);
        if (!coarse) {
          throw new RangeError(`Missing coarse fallback for target mesh ${eviction}.`);
        }
        for (const entry of coarse) addEntry(entry);
      }
      totals.fallbackDecodedBytes -= this.coarseDecodedBytesByTargetMesh.get(eviction) ?? 0;
      candidateTargetMeshes.delete(eviction);
      candidatePins.delete(eviction);
      candidatePriorities.delete(eviction);
      candidateTouches.delete(eviction);
      evictedTargetMeshIndexes.push(eviction);
    }

    this.entries.clear();
    for (const [key, entry] of candidate) this.entries.set(key, entry);
    this.totals = totals;
    this.replaceSet(this.targetMeshIndexes, candidateTargetMeshes);
    this.residentMeshIndexes.clear();
    for (const entry of this.entries.values()) {
      this.residentMeshIndexes.add(entry.evidence.meshIndex);
    }
    this.replaceSet(this.pinnedTargetMeshIndexes, candidatePins);
    this.replaceMap(this.priorityByTargetMesh, candidatePriorities);
    this.replaceMap(this.lastTouchedByTargetMesh, candidateTouches);
    return { admitted: true, evictedTargetMeshIndexes, ...this.current() };
  }

  /** Coldest evictable group: highest priority value, then oldest touch, then index. */
  private selectEviction(
    candidateTargetMeshes: ReadonlySet<number>,
    incomingTargetMeshes: ReadonlySet<number>,
    candidatePins: ReadonlySet<number>,
    candidatePriorities: ReadonlyMap<number, number>,
    candidateTouches: ReadonlyMap<number, number>,
    incomingPriority: number,
    pinning: boolean,
  ): number | undefined {
    const compare = (left: number, right: number): number =>
      (candidatePriorities.get(right) ?? Number.MAX_SAFE_INTEGER) -
        (candidatePriorities.get(left) ?? Number.MAX_SAFE_INTEGER) ||
      (candidateTouches.get(left) ?? 0) - (candidateTouches.get(right) ?? 0) ||
      left - right;
    let selected: number | undefined;
    for (const targetMeshIndex of candidateTargetMeshes) {
      if (incomingTargetMeshes.has(targetMeshIndex)) continue;
      if (candidatePins.has(targetMeshIndex)) continue;
      const meshPriority = candidatePriorities.get(targetMeshIndex) ?? incomingPriority;
      if (!pinning && meshPriority <= incomingPriority) continue;
      if (selected === undefined || compare(targetMeshIndex, selected) < 0) {
        selected = targetMeshIndex;
      }
    }
    return selected;
  }

  private touch(targetMeshIndex: number): void {
    this.lastTouchedByTargetMesh.set(targetMeshIndex, this.nextTouch());
  }

  private nextTouch(): number {
    this.touchSequence += 1;
    return this.touchSequence;
  }

  private replaceSet(target: Set<number>, source: ReadonlySet<number>): void {
    target.clear();
    for (const value of source) target.add(value);
  }

  private replaceMap(target: Map<number, number>, source: ReadonlyMap<number, number>): void {
    target.clear();
    for (const [key, value] of source) target.set(key, value);
  }
}
