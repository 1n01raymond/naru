import type { GpuScene, SceneBounds } from "@naru3d/runtime-webgpu";

/** The hierarchy fields a storey walk needs, in the package's preorder. */
export interface StoreyHierarchyEntry {
  readonly nodeIndex: number;
  readonly name: string;
  readonly depth: number;
  readonly prototypeId: string;
}

/** The evidence fields that map a renderable node to its scene object ID. */
export interface StoreyObjectEntry {
  readonly nodeIndex: number;
  readonly objectId: number;
}

export interface BuildingStorey {
  /** Trimmed storey name; storeys with the same name across documents merge. */
  readonly key: string;
  readonly name: string;
  /** One hierarchy node per discipline document that declares this storey. */
  readonly nodeIndexes: readonly number[];
  /** Renderable occurrences under those nodes, ascending, without duplicates. */
  readonly objectIds: readonly number[];
  /** World-space union of the member occurrences' bounds, when any are known. */
  readonly bounds?: SceneBounds;
}

const storeyPrototypePattern = /:non-geometric:ifcbuildingstorey$/i;

/** True for the IFC adapter's non-geometric `IfcBuildingStorey` prototypes. */
export function isBuildingStoreyPrototype(prototypeId: string): boolean {
  return storeyPrototypePattern.test(prototypeId);
}

interface MutableBounds {
  min: [number, number, number];
  max: [number, number, number];
}

function emptyBounds(): MutableBounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function extendBounds(bounds: MutableBounds, x: number, y: number, z: number): void {
  if (x < bounds.min[0]) bounds.min[0] = x;
  if (y < bounds.min[1]) bounds.min[1] = y;
  if (z < bounds.min[2]) bounds.min[2] = z;
  if (x > bounds.max[0]) bounds.max[0] = x;
  if (y > bounds.max[1]) bounds.max[1] = y;
  if (z > bounds.max[2]) bounds.max[2] = z;
}

function freezeBounds(bounds: MutableBounds): SceneBounds {
  return { min: [...bounds.min], max: [...bounds.max] };
}

/**
 * Groups the package hierarchy into building storeys.
 *
 * Every discipline document of a federation carries its own storey nodes, so
 * storeys are merged by trimmed name; the members of a storey are the
 * renderable occurrences in its preorder subtree. Storeys without renderable
 * members are dropped, because selecting one would render nothing. The
 * result is ordered by name; `frameBuildingStoreys` reorders it by elevation.
 */
export function collectBuildingStoreys(
  entries: readonly StoreyHierarchyEntry[],
  objects: readonly StoreyObjectEntry[],
): BuildingStorey[] {
  const objectIdByNode = new Map<number, number>();
  for (const object of objects) objectIdByNode.set(object.nodeIndex, object.objectId);
  const groups = new Map<string, { nodeIndexes: number[]; objectIds: Set<number> }>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || !isBuildingStoreyPrototype(entry.prototypeId)) continue;
    const key = entry.name.trim();
    let group = groups.get(key);
    if (!group) {
      group = { nodeIndexes: [], objectIds: new Set<number>() };
      groups.set(key, group);
    }
    group.nodeIndexes.push(entry.nodeIndex);
    for (let member = index + 1; member < entries.length; member += 1) {
      const candidate = entries[member];
      if (!candidate || candidate.depth <= entry.depth) break;
      const objectId = objectIdByNode.get(candidate.nodeIndex);
      if (objectId !== undefined) group.objectIds.add(objectId);
    }
  }
  return [...groups.entries()]
    .filter(([, group]) => group.objectIds.size > 0)
    .map(([key, group]) => ({
      key,
      name: key,
      nodeIndexes: group.nodeIndexes,
      objectIds: [...group.objectIds].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.key.localeCompare(right.key, "en"));
}

function localBatchBounds(
  surfaceVertices: ArrayLike<number>,
  edgeVertices: ArrayLike<number>,
): MutableBounds | undefined {
  const bounds = emptyBounds();
  let seen = false;
  // Surface vertices interleave position and normal; edge vertices are positions.
  for (let offset = 0; offset + 2 < surfaceVertices.length; offset += 6) {
    extendBounds(bounds, surfaceVertices[offset] ?? 0, surfaceVertices[offset + 1] ?? 0, surfaceVertices[offset + 2] ?? 0);
    seen = true;
  }
  if (!seen) {
    for (let offset = 0; offset + 2 < edgeVertices.length; offset += 3) {
      extendBounds(bounds, edgeVertices[offset] ?? 0, edgeVertices[offset + 1] ?? 0, edgeVertices[offset + 2] ?? 0);
      seen = true;
    }
  }
  return seen ? bounds : undefined;
}

/**
 * World-space bounds per scene object: each batch's local vertex bounds
 * transformed by every instance (column-major 4x4), unioned per object. On
 * the aggregated coarse scene the local bounds are the unit cube, so this is
 * the prototype box placed by the coarse instance transform; on a target
 * scene it is the transformed vertex bounds.
 */
export function objectBoundsByObjectId(scene: GpuScene): Map<number, SceneBounds> {
  const accumulated = new Map<number, MutableBounds>();
  for (const batch of scene.batches) {
    const local = localBatchBounds(batch.surfaceVertices, batch.edgeVertices);
    if (!local) continue;
    for (const instance of batch.instances) {
      const m = instance.transform;
      let bounds = accumulated.get(instance.objectId);
      if (!bounds) {
        bounds = emptyBounds();
        accumulated.set(instance.objectId, bounds);
      }
      for (const x of [local.min[0], local.max[0]]) {
        for (const y of [local.min[1], local.max[1]]) {
          for (const z of [local.min[2], local.max[2]]) {
            extendBounds(
              bounds,
              (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
              (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
              (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
            );
          }
        }
      }
    }
  }
  const result = new Map<number, SceneBounds>();
  for (const [objectId, bounds] of accumulated) result.set(objectId, freezeBounds(bounds));
  return result;
}

/**
 * Attaches the union of member bounds to each storey and orders storeys by
 * elevation (lowest world Y first, then name), the order a storey picker
 * lists them in. A storey whose members have no known bounds keeps no
 * `bounds` and sorts after the framed ones.
 */
export function frameBuildingStoreys(
  storeys: readonly BuildingStorey[],
  boundsByObjectId: ReadonlyMap<number, SceneBounds>,
): BuildingStorey[] {
  const framed = storeys.map((storey) => {
    const union = emptyBounds();
    let seen = false;
    for (const objectId of storey.objectIds) {
      const bounds = boundsByObjectId.get(objectId);
      if (!bounds) continue;
      extendBounds(union, bounds.min[0], bounds.min[1], bounds.min[2]);
      extendBounds(union, bounds.max[0], bounds.max[1], bounds.max[2]);
      seen = true;
    }
    return seen ? { ...storey, bounds: freezeBounds(union) } : storey;
  });
  return framed.sort((left, right) => {
    const leftY = left.bounds?.min[1] ?? Infinity;
    const rightY = right.bounds?.min[1] ?? Infinity;
    if (leftY !== rightY) return leftY - rightY;
    return left.key.localeCompare(right.key, "en");
  });
}
