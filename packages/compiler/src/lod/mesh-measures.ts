/**
 * Pure mesh measures shared by the reduced-LOD admission checks.
 *
 * This is a TypeScript port of `scripts/lib/lod-mesh.mjs`, the module the
 * ADR-0025 gate-0 record (`artifacts/lod/method-comparison`) was measured with.
 * The bodies are kept identical so an in-compiler admission decision and the
 * offline recorder agree to the bit; the duplication is deliberate and noted in
 * `docs/adr/0025-shape-preserving-lod-representation.md`.
 */

export interface WeldedMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly remap: Uint32Array;
}

export interface TriangleSoup {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly faceSourceIds: Uint32Array;
}

export interface TopologySummary {
  readonly triangles: number;
  readonly edges: number;
  readonly boundaryEdges: number;
  readonly nonManifoldEdges: number;
  readonly vertices: number;
  readonly euler: number;
  readonly referencedVertices: number;
  readonly allocatedVertices: number;
}

export interface DistanceSummary {
  readonly count: number;
  readonly max: number | null;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
}

export interface TwoSidedDistance {
  readonly forward: DistanceSummary;
  readonly backward: DistanceSummary;
  readonly twoSided: DistanceSummary;
}

export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface SectionPlane {
  readonly normal: readonly [number, number, number];
  readonly point: readonly [number, number, number];
}

export interface SectionComparison extends TwoSidedDistance {
  readonly referenceSegments: number;
  readonly candidateSegments: number;
}

export interface SilhouetteComparison {
  readonly referenceCovered: number;
  readonly differing: number;
  readonly ratio: number;
}

export type SilhouetteView = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

const AXIS_VIEWS: Readonly<Record<SilhouetteView, readonly [number, number]>> = {
  "+x": [1, 2],
  "-x": [1, 2],
  "+y": [0, 2],
  "-y": [0, 2],
  "+z": [0, 1],
  "-z": [0, 1],
};

export const silhouetteViews: readonly SilhouetteView[] = Object.freeze(
  Object.keys(AXIS_VIEWS) as SilhouetteView[],
);

type Vec = readonly [number, number, number];

function v(array: ArrayLike<number>, index: number): number {
  return array[index] ?? 0;
}

/** mulberry32; the seed makes surface sampling reproducible across runs. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function weldMesh(positions: ArrayLike<number>, indices: ArrayLike<number>): WeldedMesh {
  const keyToIndex = new Map<string, number>();
  const welded: number[] = [];
  const remap = new Uint32Array(positions.length / 3);
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const x = v(positions, vertex * 3);
    const y = v(positions, vertex * 3 + 1);
    const z = v(positions, vertex * 3 + 2);
    const key = `${x},${y},${z}`;
    let index = keyToIndex.get(key);
    if (index === undefined) {
      index = welded.length / 3;
      keyToIndex.set(key, index);
      welded.push(x, y, z);
    }
    remap[vertex] = index;
  }
  const remapped = new Uint32Array(indices.length);
  for (let index = 0; index < indices.length; index += 1) {
    remapped[index] = v(remap, v(indices, index));
  }
  return { positions: Float32Array.from(welded), indices: remapped, remap };
}

export function triangleNormal(positions: ArrayLike<number>, a: number, b: number, c: number): Vec {
  const ax = v(positions, a * 3);
  const ay = v(positions, a * 3 + 1);
  const az = v(positions, a * 3 + 2);
  const ux = v(positions, b * 3) - ax;
  const uy = v(positions, b * 3 + 1) - ay;
  const uz = v(positions, b * 3 + 2) - az;
  const wx = v(positions, c * 3) - ax;
  const wy = v(positions, c * 3 + 1) - ay;
  const wz = v(positions, c * 3 + 2) - az;
  const nx = uy * wz - uz * wy;
  const ny = uz * wx - ux * wz;
  const nz = ux * wy - uy * wx;
  const length = Math.hypot(nx, ny, nz);
  if (length === 0) return [0, 0, 0];
  return [nx / length, ny / length, nz / length];
}

export function expandToSoup(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  faceIds: ArrayLike<number>,
): TriangleSoup {
  const triangles = indices.length / 3;
  const soupPositions = new Float32Array(triangles * 9);
  const soupNormals = new Float32Array(triangles * 9);
  const soupIndices = new Uint32Array(triangles * 3);
  const soupFaces = new Uint32Array(triangles);
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const a = v(indices, triangle * 3);
    const b = v(indices, triangle * 3 + 1);
    const c = v(indices, triangle * 3 + 2);
    const normal = triangleNormal(positions, a, b, c);
    const corners = [a, b, c];
    for (let corner = 0; corner < 3; corner += 1) {
      const source = corners[corner] ?? 0;
      const target = triangle * 3 + corner;
      soupPositions[target * 3] = v(positions, source * 3);
      soupPositions[target * 3 + 1] = v(positions, source * 3 + 1);
      soupPositions[target * 3 + 2] = v(positions, source * 3 + 2);
      soupNormals[target * 3] = normal[0];
      soupNormals[target * 3 + 1] = normal[1];
      soupNormals[target * 3 + 2] = normal[2];
      soupIndices[target] = target;
    }
    soupFaces[triangle] = v(faceIds, triangle);
  }
  return { positions: soupPositions, normals: soupNormals, indices: soupIndices, faceSourceIds: soupFaces };
}

/**
 * Welds a triangle soup on the exact (position, normal) key so a faceted mesh
 * shares vertices within each planar facet again. First-seen order keeps the
 * result deterministic; indices and per-triangle face ids are preserved.
 */
export function weldSoup(soup: TriangleSoup): TriangleSoup {
  const lookup = new Map<string, number>();
  const positions: number[] = [];
  const normals: number[] = [];
  const indices = new Uint32Array(soup.indices.length);
  for (let corner = 0; corner < soup.indices.length; corner += 1) {
    const source = soup.indices[corner] ?? 0;
    const p = [0, 1, 2].map((axis) => soup.positions[source * 3 + axis] ?? 0);
    const n = [0, 1, 2].map((axis) => soup.normals[source * 3 + axis] ?? 0);
    const key = `${p.join(",")}|${n.join(",")}`;
    let vertex = lookup.get(key);
    if (vertex === undefined) {
      vertex = positions.length / 3;
      lookup.set(key, vertex);
      positions.push(...p);
      normals.push(...n);
    }
    indices[corner] = vertex;
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices,
    faceSourceIds: soup.faceSourceIds,
  };
}

export function topologySummary(positions: ArrayLike<number>, indices: ArrayLike<number>): TopologySummary {
  const edgeCounts = new Map<string, number>();
  const referenced = new Set<number>();
  const triangles = indices.length / 3;
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const corners = [v(indices, triangle * 3), v(indices, triangle * 3 + 1), v(indices, triangle * 3 + 2)];
    for (let corner = 0; corner < 3; corner += 1) {
      const a = corners[corner] ?? 0;
      const b = corners[(corner + 1) % 3] ?? 0;
      referenced.add(a);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) boundaryEdges += 1;
    if (count > 2) nonManifoldEdges += 1;
  }
  const vertices = referenced.size;
  const edges = edgeCounts.size;
  return {
    triangles,
    edges,
    boundaryEdges,
    nonManifoldEdges,
    vertices,
    euler: vertices - edges + triangles,
    referencedVertices: vertices,
    allocatedVertices: positions.length / 3,
  };
}

export function triangleArea(positions: ArrayLike<number>, a: number, b: number, c: number): number {
  const ax = v(positions, a * 3);
  const ay = v(positions, a * 3 + 1);
  const az = v(positions, a * 3 + 2);
  const ux = v(positions, b * 3) - ax;
  const uy = v(positions, b * 3 + 1) - ay;
  const uz = v(positions, b * 3 + 2) - az;
  const wx = v(positions, c * 3) - ax;
  const wy = v(positions, c * 3 + 1) - ay;
  const wz = v(positions, c * 3 + 2) - az;
  const nx = uy * wz - uz * wy;
  const ny = uz * wx - ux * wz;
  const nz = ux * wy - uy * wx;
  return 0.5 * Math.hypot(nx, ny, nz);
}

export function surfaceArea(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let total = 0;
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    total += triangleArea(
      positions,
      v(indices, triangle * 3),
      v(indices, triangle * 3 + 1),
      v(indices, triangle * 3 + 2),
    );
  }
  return total;
}

export function sampleSurfacePoints(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  count: number,
  random: () => number,
): { points: Float64Array; triangleOf: Uint32Array } {
  const triangles = indices.length / 3;
  const cumulative = new Float64Array(triangles);
  let total = 0;
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    total += triangleArea(
      positions,
      v(indices, triangle * 3),
      v(indices, triangle * 3 + 1),
      v(indices, triangle * 3 + 2),
    );
    cumulative[triangle] = total;
  }
  const points = new Float64Array(count * 3);
  const triangleOf = new Uint32Array(count);
  for (let sample = 0; sample < count; sample += 1) {
    const pick = random() * total;
    let low = 0;
    let high = triangles - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (v(cumulative, mid) >= pick) high = mid;
      else low = mid + 1;
    }
    const triangle = low;
    const a = v(indices, triangle * 3);
    const b = v(indices, triangle * 3 + 1);
    const c = v(indices, triangle * 3 + 2);
    let u = random();
    let w2 = random();
    if (u + w2 > 1) {
      u = 1 - u;
      w2 = 1 - w2;
    }
    const w = 1 - u - w2;
    for (let axis = 0; axis < 3; axis += 1) {
      points[sample * 3 + axis] =
        w * v(positions, a * 3 + axis) + u * v(positions, b * 3 + axis) + w2 * v(positions, c * 3 + axis);
    }
    triangleOf[sample] = triangle;
  }
  return { points, triangleOf };
}

/** Ericson, Real-Time Collision Detection 5.1.5. */
export function pointTriangleDistanceSquared(
  px: number,
  py: number,
  pz: number,
  positions: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
): number {
  const ax = v(positions, a * 3);
  const ay = v(positions, a * 3 + 1);
  const az = v(positions, a * 3 + 2);
  const bx = v(positions, b * 3);
  const by = v(positions, b * 3 + 1);
  const bz = v(positions, b * 3 + 2);
  const cx = v(positions, c * 3);
  const cy = v(positions, c * 3 + 1);
  const cz = v(positions, c * 3 + 2);
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    const qx = ax + t * abx - px;
    const qy = ay + t * aby - py;
    const qz = az + t * abz - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    const qx = ax + t * acx - px;
    const qy = ay + t * acy - py;
    const qz = az + t * acz - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = bx + t * (cx - bx) - px;
    const qy = by + t * (cy - by) - py;
    const qz = bz + t * (cz - bz) - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const denominator = 1 / (va + vb + vc);
  const s = vb * denominator;
  const t = vc * denominator;
  const qx = ax + abx * s + acx * t - px;
  const qy = ay + aby * s + acy * t - py;
  const qz = az + abz * s + acz * t - pz;
  return qx * qx + qy * qy + qz * qz;
}

export function pointMeshDistance(
  px: number,
  py: number,
  pz: number,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    const distance = pointTriangleDistanceSquared(
      px,
      py,
      pz,
      positions,
      v(indices, triangle * 3),
      v(indices, triangle * 3 + 1),
      v(indices, triangle * 3 + 2),
    );
    if (distance < best) best = distance;
  }
  return Math.sqrt(best);
}

export function summarizeDistances(values: ArrayLike<number>): DistanceSummary {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  if (n === 0) return { count: 0, max: null, mean: null, p50: null, p95: null };
  let sum = 0;
  for (let index = 0; index < n; index += 1) sum += v(sorted, index);
  const rank = (p: number): number => v(sorted, Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1)));
  return { count: n, max: v(sorted, n - 1), mean: sum / n, p50: rank(0.5), p95: rank(0.95) };
}

function concatDistances(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export interface MeshLike {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}

export function sampledMeshDistance(
  a: MeshLike,
  b: MeshLike,
  sampleCount: number,
  seed: number,
): TwoSidedDistance {
  const random = createSeededRandom(seed);
  const forwardSamples = sampleSurfacePoints(a.positions, a.indices, sampleCount, random);
  const forward = new Float64Array(sampleCount);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    forward[sample] = pointMeshDistance(
      v(forwardSamples.points, sample * 3),
      v(forwardSamples.points, sample * 3 + 1),
      v(forwardSamples.points, sample * 3 + 2),
      b.positions,
      b.indices,
    );
  }
  const backwardSamples = sampleSurfacePoints(b.positions, b.indices, sampleCount, random);
  const backward = new Float64Array(sampleCount);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    backward[sample] = pointMeshDistance(
      v(backwardSamples.points, sample * 3),
      v(backwardSamples.points, sample * 3 + 1),
      v(backwardSamples.points, sample * 3 + 2),
      a.positions,
      a.indices,
    );
  }
  return {
    forward: summarizeDistances(forward),
    backward: summarizeDistances(backward),
    twoSided: summarizeDistances(concatDistances(forward, backward)),
  };
}

export function rasterizeSilhouette(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  bounds: Bounds,
  view: SilhouetteView,
  resolution: number,
): Uint8Array {
  const [uAxis, vAxis] = AXIS_VIEWS[view];
  const uMin = bounds.min[uAxis] ?? 0;
  const vMin = bounds.min[vAxis] ?? 0;
  const extent = Math.max((bounds.max[uAxis] ?? 0) - uMin, (bounds.max[vAxis] ?? 0) - vMin) || 1;
  const scale = resolution / extent;
  const mask = new Uint8Array(resolution * resolution);
  const toRaster = (vertex: number): readonly [number, number] => [
    (v(positions, vertex * 3 + uAxis) - uMin) * scale,
    (v(positions, vertex * 3 + vAxis) - vMin) * scale,
  ];
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    const [ax, ay] = toRaster(v(indices, triangle * 3));
    const [bx, by] = toRaster(v(indices, triangle * 3 + 1));
    const [cx, cy] = toRaster(v(indices, triangle * 3 + 2));
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(resolution - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(resolution - 1, Math.ceil(Math.max(ay, by, cy)));
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (area === 0) continue;
    for (let y = minY; y <= maxY; y += 1) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) mask[y * resolution + x] = 1;
      }
    }
  }
  return mask;
}

export function compareSilhouettes(reference: Uint8Array, candidate: Uint8Array): SilhouetteComparison {
  let referenceCovered = 0;
  let differing = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const r = v(reference, index);
    const c = v(candidate, index);
    if (r === 1) referenceCovered += 1;
    if (r !== c) differing += 1;
  }
  return { referenceCovered, differing, ratio: referenceCovered === 0 ? 0 : differing / referenceCovered };
}

export function sectionSegments(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  plane: SectionPlane,
): Vec[] {
  const [nx, ny, nz] = plane.normal;
  const offset = plane.point[0] * nx + plane.point[1] * ny + plane.point[2] * nz;
  const distanceOf = (vertex: number): number =>
    v(positions, vertex * 3) * nx + v(positions, vertex * 3 + 1) * ny + v(positions, vertex * 3 + 2) * nz - offset;
  const segments: Vec[] = [];
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    const corners = [v(indices, triangle * 3), v(indices, triangle * 3 + 1), v(indices, triangle * 3 + 2)];
    const crossings: Vec[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const a = corners[corner] ?? 0;
      const b = corners[(corner + 1) % 3] ?? 0;
      const da = distanceOf(a);
      const db = distanceOf(b);
      if (da < 0 !== db < 0) {
        const t = da / (da - db);
        crossings.push([
          v(positions, a * 3) + t * (v(positions, b * 3) - v(positions, a * 3)),
          v(positions, a * 3 + 1) + t * (v(positions, b * 3 + 1) - v(positions, a * 3 + 1)),
          v(positions, a * 3 + 2) + t * (v(positions, b * 3 + 2) - v(positions, a * 3 + 2)),
        ]);
      }
    }
    if (crossings.length === 2) {
      segments.push(crossings[0] as Vec, crossings[1] as Vec);
    }
  }
  return segments;
}

export function pointSegmentDistance(p: Vec, a: Vec, b: Vec): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const lengthSquared = abx * abx + aby * aby + abz * abz;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (apx * abx + apy * aby + apz * abz) / lengthSquared));
  const qx = a[0] + t * abx - p[0];
  const qy = a[1] + t * aby - p[1];
  const qz = a[2] + t * abz - p[2];
  return Math.hypot(qx, qy, qz);
}

function pointSegmentsDistance(p: Vec, segments: readonly Vec[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < segments.length; index += 2) {
    const distance = pointSegmentDistance(p, segments[index] as Vec, segments[index + 1] as Vec);
    if (distance < best) best = distance;
  }
  return best;
}

function sampleSegments(segments: readonly Vec[], samplesPerSegment: number): Vec[] {
  const samples: Vec[] = [];
  for (let index = 0; index + 1 < segments.length; index += 2) {
    const a = segments[index] as Vec;
    const b = segments[index + 1] as Vec;
    for (let sample = 0; sample < samplesPerSegment; sample += 1) {
      const t = samplesPerSegment === 1 ? 0.5 : sample / (samplesPerSegment - 1);
      samples.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  return samples;
}

export function sectionDistance(
  referenceSegments: readonly Vec[],
  candidateSegments: readonly Vec[],
  samplesPerSegment: number,
): SectionComparison {
  const forwardSamples = sampleSegments(referenceSegments, samplesPerSegment);
  const backwardSamples = sampleSegments(candidateSegments, samplesPerSegment);
  const forward = Float64Array.from(forwardSamples, (p) => pointSegmentsDistance(p, candidateSegments));
  const backward = Float64Array.from(backwardSamples, (p) => pointSegmentsDistance(p, referenceSegments));
  return {
    referenceSegments: referenceSegments.length / 2,
    candidateSegments: candidateSegments.length / 2,
    forward: summarizeDistances(forward),
    backward: summarizeDistances(backward),
    twoSided: summarizeDistances(concatDistances(forward, backward)),
  };
}

export function edgeAlignment(
  edgePositions: ArrayLike<number>,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): DistanceSummary {
  const count = edgePositions.length / 3;
  const distances = new Float64Array(count);
  for (let point = 0; point < count; point += 1) {
    distances[point] = pointMeshDistance(
      v(edgePositions, point * 3),
      v(edgePositions, point * 3 + 1),
      v(edgePositions, point * 3 + 2),
      positions,
      indices,
    );
  }
  return summarizeDistances(distances);
}

export function computeBounds(positions: ArrayLike<number>): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = v(positions, vertex * 3 + axis);
      if (value < (min[axis] ?? Infinity)) min[axis] = value;
      if (value > (max[axis] ?? -Infinity)) max[axis] = value;
    }
  }
  return { min, max };
}
