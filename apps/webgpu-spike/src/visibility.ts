import type { GpuScene } from "@naru3d/runtime-webgpu";

export type VisibilityMode = "all" | "hidden" | "isolated";

export interface VisibilityState {
  readonly mode: VisibilityMode;
  readonly totalOccurrences: number;
  readonly visibleOccurrences: number;
  readonly hiddenOccurrences: number;
  readonly isolatedObjectId?: number;
  /** Size of the active scope (a storey, for example); absent when unscoped. */
  readonly scopedOccurrences?: number;
}

export interface OccurrenceVisibilitySnapshot {
  readonly hiddenObjectIds: readonly number[];
  readonly isolatedObjectId?: number;
}

export type InstanceVisibilityFilter = (
  batchIndex: number,
  instanceIndex: number,
) => boolean;

export interface ResidencyVisibilityUpdate {
  readonly visibility: OccurrenceVisibility;
  /** Batch indexes whose instance tables changed and need a GPU re-upload. */
  readonly changedBatchIndexes: readonly number[];
}

interface ResidencyReuse {
  readonly previous: OccurrenceVisibility;
  readonly filterChangedBatchIndexes: readonly number[];
}

export interface HierarchyVisibilityEntry {
  readonly nodeIndex: number;
  readonly objectId: number;
}

/** Collects the hierarchy rows a review action hid, for the list view to mark. */
export function hiddenHierarchyNodeIndices(
  entries: readonly HierarchyVisibilityEntry[],
  isVisible: (objectId: number) => boolean,
): ReadonlySet<number> {
  const hidden = new Set<number>();
  for (const entry of entries) {
    if (!isVisible(entry.objectId)) hidden.add(entry.nodeIndex);
  }
  return hidden;
}

/**
 * Builds dense per-prototype instance tables without allocating during review
 * actions. The renderer consumes these tables through updateVisibleInstances().
 */
export class OccurrenceVisibility {
  readonly indicesByBatch: readonly Int32Array[];
  readonly counts: Uint32Array;

  private readonly scene: GpuScene;
  private readonly instanceFilter?: InstanceVisibilityFilter;
  private readonly objectIds: Set<number>;
  private readonly hiddenObjectIds = new Set<number>();
  private isolatedObjectId?: number;
  private scopeObjectIds?: ReadonlySet<number>;
  private visibleOccurrences = 0;
  private residencyChangedBatchIndexes?: readonly number[];

  constructor(
    scene: GpuScene,
    instanceFilter?: InstanceVisibilityFilter,
    residencyReuse?: ResidencyReuse,
  ) {
    this.scene = scene;
    this.instanceFilter = instanceFilter;
    if (residencyReuse) {
      this.objectIds = residencyReuse.previous.objectIds;
      this.counts = new Uint32Array(scene.batches.length);
      this.indicesByBatch = this.buildResidencyTables(residencyReuse);
      return;
    }
    this.objectIds = new Set<number>();
    this.indicesByBatch = scene.batches.map(
      (batch) => new Int32Array(batch.instances.length),
    );
    this.counts = new Uint32Array(scene.batches.length);
    for (const batch of scene.batches) {
      for (const instance of batch.instances) {
        if (
          !scene.sharedObjectIdsAcrossBatches &&
          this.objectIds.has(instance.objectId)
        ) {
          throw new RangeError(`Duplicate scene object ID ${instance.objectId}.`);
        }
        this.objectIds.add(instance.objectId);
      }
    }
    this.rebuildTables();
  }

  /**
   * Rebuilds visibility for a scene whose batch list changed only through
   * residency (chunk admissions and evictions). Instance tables of batches the
   * previous scene already carried are reused by object identity; only new
   * batches and the listed filter-changed batch indexes are recomputed.
   *
   * Contract: the distinct object-id universe must be unchanged (target-batch
   * ids are a subset of the coarse ids they replace), and `previous` must not
   * be used afterwards — its tables now belong to the returned instance.
   */
  static forResidencyUpdate(
    previous: OccurrenceVisibility,
    scene: GpuScene,
    instanceFilter?: InstanceVisibilityFilter,
    filterChangedBatchIndexes: readonly number[] = [],
  ): ResidencyVisibilityUpdate {
    const visibility = new OccurrenceVisibility(scene, instanceFilter, {
      previous,
      filterChangedBatchIndexes,
    });
    return {
      visibility,
      changedBatchIndexes: visibility.residencyChangedBatchIndexes ?? [],
    };
  }

  private buildResidencyTables(reuse: ResidencyReuse): readonly Int32Array[] {
    const { previous } = reuse;
    for (const objectId of previous.hiddenObjectIds) this.hiddenObjectIds.add(objectId);
    this.isolatedObjectId = previous.isolatedObjectId;
    this.scopeObjectIds = previous.scopeObjectIds;
    // Distinct visible ids are invariant under residency swaps: an admitted
    // mesh's coarse instances become masked while its target instances appear,
    // and an evicted mesh's coarse instances unmask again.
    this.visibleOccurrences = previous.visibleOccurrences;
    const priorTables = new Map<
      GpuScene["batches"][number],
      { readonly indices: Int32Array; readonly count: number }
    >();
    previous.scene.batches.forEach((batch, batchIndex) => {
      const indices = previous.indicesByBatch[batchIndex];
      const count = previous.counts[batchIndex];
      if (indices && count !== undefined) priorTables.set(batch, { indices, count });
    });
    const filterChanged = new Set(reuse.filterChangedBatchIndexes);
    const changed: number[] = [];
    const tables = this.scene.batches.map((batch, batchIndex) => {
      const prior = priorTables.get(batch);
      if (prior && !filterChanged.has(batchIndex)) {
        this.counts[batchIndex] = prior.count;
        return prior.indices;
      }
      changed.push(batchIndex);
      const indices = prior?.indices ?? new Int32Array(batch.instances.length);
      let count = 0;
      batch.instances.forEach((instance, sourceIndex) => {
        if (!this.objectIds.has(instance.objectId)) {
          throw new RangeError(`Unknown scene object ID ${instance.objectId}.`);
        }
        if (
          this.isVisibleKnown(instance.objectId) &&
          (this.instanceFilter?.(batchIndex, sourceIndex) ?? true)
        ) {
          indices[count] = sourceIndex;
          count += 1;
        }
      });
      this.counts[batchIndex] = count;
      return indices;
    });
    this.residencyChangedBatchIndexes = changed;
    return tables;
  }

  hide(objectId: number): void {
    this.requireObject(objectId);
    this.isolatedObjectId = undefined;
    this.hiddenObjectIds.add(objectId);
    this.rebuildTables();
  }

  isolate(objectId: number): void {
    this.requireObject(objectId);
    this.isolatedObjectId = objectId;
    this.rebuildTables();
  }

  showAll(): void {
    this.hiddenObjectIds.clear();
    this.isolatedObjectId = undefined;
    this.rebuildTables();
  }

  /**
   * Whether this scene carries the occurrence at all, so a restore can report
   * what it dropped instead of throwing on an id the reopened package lost.
   */
  knows(objectId: number): boolean {
    return this.objectIds.has(objectId);
  }

  /**
   * Restricts rendering to a scope of object IDs (a building storey), on top of
   * the hide/isolate intent. The scope is view state, not workspace intent: it
   * survives residency updates but is excluded from `snapshot()`, so the
   * workspace manifest never carries it. Passing `undefined` lifts the scope.
   */
  setScope(objectIds: ReadonlySet<number> | undefined): void {
    if (objectIds !== undefined) {
      for (const objectId of objectIds) this.requireObject(objectId);
    }
    this.scopeObjectIds = objectIds;
    this.rebuildTables();
  }

  scope(): ReadonlySet<number> | undefined {
    return this.scopeObjectIds;
  }

  isVisible(objectId: number): boolean {
    return this.objectIds.has(objectId) && this.isVisibleKnown(objectId);
  }

  private isVisibleKnown(objectId: number): boolean {
    if (this.scopeObjectIds !== undefined && !this.scopeObjectIds.has(objectId)) {
      return false;
    }
    return this.isolatedObjectId === undefined
      ? !this.hiddenObjectIds.has(objectId)
      : this.isolatedObjectId === objectId;
  }

  state(): VisibilityState {
    const mode =
      this.isolatedObjectId !== undefined
        ? "isolated"
        : this.hiddenObjectIds.size > 0
          ? "hidden"
          : "all";
    return {
      mode,
      totalOccurrences: this.objectIds.size,
      visibleOccurrences: this.visibleOccurrences,
      hiddenOccurrences: this.objectIds.size - this.visibleOccurrences,
      ...(this.isolatedObjectId === undefined
        ? {}
        : { isolatedObjectId: this.isolatedObjectId }),
      ...(this.scopeObjectIds === undefined
        ? {}
        : { scopedOccurrences: this.scopeObjectIds.size }),
    };
  }

  /** Captures user visibility intent before residency changes rebuild batch tables. */
  snapshot(): OccurrenceVisibilitySnapshot {
    return {
      hiddenObjectIds: [...this.hiddenObjectIds].sort((left, right) => left - right),
      ...(this.isolatedObjectId === undefined ? {} : { isolatedObjectId: this.isolatedObjectId }),
    };
  }

  /** Reapplies visibility intent to a scene with replacement GPU batches. */
  restore(snapshot: OccurrenceVisibilitySnapshot): void {
    this.hiddenObjectIds.clear();
    for (const objectId of snapshot.hiddenObjectIds) {
      this.requireObject(objectId);
      this.hiddenObjectIds.add(objectId);
    }
    if (snapshot.isolatedObjectId !== undefined) {
      this.requireObject(snapshot.isolatedObjectId);
    }
    this.isolatedObjectId = snapshot.isolatedObjectId;
    this.rebuildTables();
  }

  private rebuildTables(): void {
    const visibleObjectIds = new Set<number>();
    this.scene.batches.forEach((batch, batchIndex) => {
      const indices = this.indicesByBatch[batchIndex];
      if (!indices) throw new RangeError(`Missing visibility table ${batchIndex}.`);
      let count = 0;
      batch.instances.forEach((instance, sourceIndex) => {
        if (
          this.isVisible(instance.objectId) &&
          (this.instanceFilter?.(batchIndex, sourceIndex) ?? true)
        ) {
          indices[count] = sourceIndex;
          count += 1;
          visibleObjectIds.add(instance.objectId);
        }
      });
      this.counts[batchIndex] = count;
    });
    this.visibleOccurrences = visibleObjectIds.size;
  }

  private requireObject(objectId: number): void {
    if (!this.objectIds.has(objectId)) {
      throw new RangeError(`Unknown scene object ID ${objectId}.`);
    }
  }
}
