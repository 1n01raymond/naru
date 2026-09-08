/**
 * Pure triangle-mesh measurements for the LOD method comparison (issue #126).
 *
 * Everything here works on the Scene IR surface layout the OCCT adapter
 * emits (flat float arrays, a triangle index list, one face source id per
 * triangle) and is deterministic: sampling draws from a seeded generator so a
 * repeated run reproduces every number. Distances are geometric, in the
 * scene's own length unit; nothing here is a certified CAD tolerance.
 */

/** Deterministic 32-bit PRNG (mulberry32); the same seed replays a sample set. */
export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Welds vertices whose coordinates are bit-identical. No tolerance: the
 * adapter's per-face tessellation either reproduces a shared edge point
 * exactly or it does not, and the difference is what the boundary-edge count
 * reports.
 */
export function weldMesh(positions, indices) {
  const remap = new Uint32Array(positions.length / 3);
  const welded = [];
  const seen = new Map();
  for (let vertex = 0; vertex < remap.length; vertex += 1) {
    const key = `${positions[vertex * 3]},${positions[vertex * 3 + 1]},${positions[vertex * 3 + 2]}`;
    let target = seen.get(key);
    if (target === undefined) {
      target = welded.length / 3;
      seen.set(key, target);
      welded.push(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]);
    }
    remap[vertex] = target;
  }
  const weldedIndices = new Uint32Array(indices.length);
  for (let at = 0; at < indices.length; at += 1) weldedIndices[at] = remap[indices[at]];
  return { positions: Float32Array.from(welded), indices: weldedIndices, remap };
}

/** Unit normal of triangle (a, b, c); zero for a degenerate triangle. */
export function triangleNormal(positions, a, b, c) {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az;
  const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  return length === 0 ? [0, 0, 0] : [nx / length, ny / length, nz / length];
}

/**
 * Re-expands an indexed mesh into the adapter's soup layout (three vertices per
 * triangle, flat normals), so a reduced surface is measured and encoded in the
 * same layout as the adapter's own output. Positions are copied, never moved.
 */
export function expandToSoup(positions, indices, faceIds) {
  const triangles = indices.length / 3;
  const outPositions = new Float32Array(triangles * 9);
  const outNormals = new Float32Array(triangles * 9);
  const outIndices = new Uint32Array(triangles * 3);
  const outFaceIds = new Uint32Array(triangles);
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const corners = [indices[triangle * 3], indices[triangle * 3 + 1], indices[triangle * 3 + 2]];
    const normal = triangleNormal(positions, corners[0], corners[1], corners[2]);
    for (let corner = 0; corner < 3; corner += 1) {
      const out = triangle * 3 + corner;
      outPositions.set(positions.subarray(corners[corner] * 3, corners[corner] * 3 + 3), out * 3);
      outNormals.set(normal, out * 3);
      outIndices[out] = out;
    }
    outFaceIds[triangle] = faceIds[triangle];
  }
  return { positions: outPositions, normals: outNormals, indices: outIndices, faceSourceIds: outFaceIds };
}

/**
 * Euler characteristic and edge manifoldness of an indexed mesh. Boundary edges
 * count cracks between independently tessellated faces as well as real open
 * boundaries; a reduction must not change either count.
 */
export function topologySummary(positions, indices) {
  const edges = new Map();
  for (let at = 0; at < indices.length; at += 3) {
    const corners = [indices[at], indices[at + 1], indices[at + 2]];
    for (let corner = 0; corner < 3; corner += 1) {
      const a = corners[corner], b = corners[(corner + 1) % 3];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0;
  for (const count of edges.values()) {
    if (count === 1) boundaryEdges += 1;
    else if (count > 2) nonManifoldEdges += 1;
  }
  const used = new Set(indices);
  const vertices = used.size;
  const triangles = indices.length / 3;
  return { vertices, edges: edges.size, triangles, boundaryEdges, nonManifoldEdges, euler: vertices - edges.size + triangles, referencedVertices: vertices, allocatedVertices: positions.length / 3 };
}

function triangleArea(positions, a, b, c) {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az;
  const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az;
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** Total surface area of an indexed mesh. */
export function surfaceArea(positions, indices) {
  let total = 0;
  for (let at = 0; at < indices.length; at += 3) total += triangleArea(positions, indices[at], indices[at + 1], indices[at + 2]);
  return total;
}

/**
 * Area-weighted uniform surface samples. Each sample carries the triangle it
 * came from so per-face checks can look the face up through the triangle.
 */
export function sampleSurfacePoints(positions, indices, count, random) {
  const triangles = indices.length / 3;
  const cumulative = new Float64Array(triangles);
  let total = 0;
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    total += triangleArea(positions, indices[triangle * 3], indices[triangle * 3 + 1], indices[triangle * 3 + 2]);
    cumulative[triangle] = total;
  }
  const points = new Float64Array(count * 3);
  const triangleOf = new Uint32Array(count);
  for (let sample = 0; sample < count; sample += 1) {
    const pick = random() * total;
    let low = 0, high = triangles - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] < pick) low = mid + 1; else high = mid;
    }
    const a = indices[low * 3], b = indices[low * 3 + 1], c = indices[low * 3 + 2];
    let u = random(), v = random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    for (let axis = 0; axis < 3; axis += 1) {
      points[sample * 3 + axis] = w * positions[a * 3 + axis] + u * positions[b * 3 + axis] + v * positions[c * 3 + axis];
    }
    triangleOf[sample] = low;
  }
  return { points, triangleOf };
}

/** Squared distance from point p to triangle (a, b, c) (Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriangleDistanceSquared(px, py, pz, positions, a, b, c) {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const abx = positions[b * 3] - ax, aby = positions[b * 3 + 1] - ay, abz = positions[b * 3 + 2] - az;
  const acx = positions[c * 3] - ax, acy = positions[c * 3 + 1] - ay, acz = positions[c * 3 + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const sq = (x, y, z) => x * x + y * y + z * z;
  if (d1 <= 0 && d2 <= 0) return sq(apx, apy, apz);
  const bpx = px - positions[b * 3], bpy = py - positions[b * 3 + 1], bpz = pz - positions[b * 3 + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return sq(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return sq(apx - v * abx, apy - v * aby, apz - v * abz);
  }
  const cpx = px - positions[c * 3], cpy = py - positions[c * 3 + 1], cpz = pz - positions[c * 3 + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return sq(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return sq(apx - w * acx, apy - w * acy, apz - w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return sq(bpx - w * (positions[c * 3] - positions[b * 3]), bpy - w * (positions[c * 3 + 1] - positions[b * 3 + 1]), bpz - w * (positions[c * 3 + 2] - positions[b * 3 + 2]));
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator, w = vc * denominator;
  return sq(apx - v * abx - w * acx, apy - v * aby - w * acy, apz - v * abz - w * acz);
}

/** Distance from one point to the closest triangle of a mesh (brute force). */
export function pointMeshDistance(px, py, pz, positions, indices) {
  let best = Infinity;
  for (let at = 0; at < indices.length; at += 3) {
    const d = pointTriangleDistanceSquared(px, py, pz, positions, indices[at], indices[at + 1], indices[at + 2]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Percentile summary of a list of distances; `p95` uses the nearest-rank rule. */
export function summarizeDistances(values) {
  const sorted = Float64Array.from(values).sort();
  const count = sorted.length;
  if (count === 0) return { count: 0, max: null, mean: null, p50: null, p95: null };
  const rank = (p) => sorted[Math.min(count - 1, Math.max(0, Math.ceil(p * count) - 1))];
  let sum = 0;
  for (const value of sorted) sum += value;
  return { count, max: sorted[count - 1], mean: sum / count, p50: rank(0.5), p95: rank(0.95) };
}

/**
 * Two-sided sampled surface distance: samples on A measured to B and samples
 * on B measured to A. Labelled "sampled" by construction; it is not a
 * Hausdorff bound.
 */
export function sampledMeshDistance(a, b, sampleCount, seed) {
  const random = createSeededRandom(seed);
  const oneWay = (from, to) => {
    const { points } = sampleSurfacePoints(from.positions, from.indices, sampleCount, random);
    const distances = new Float64Array(sampleCount);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      distances[sample] = pointMeshDistance(points[sample * 3], points[sample * 3 + 1], points[sample * 3 + 2], to.positions, to.indices);
    }
    return distances;
  };
  const forward = oneWay(a, b);
  const backward = oneWay(b, a);
  const both = new Float64Array(sampleCount * 2);
  both.set(forward, 0);
  both.set(backward, sampleCount);
  return { forward: summarizeDistances(forward), backward: summarizeDistances(backward), twoSided: summarizeDistances(both) };
}

/**
 * Signed-free distance from a point to an analytic face description as the
 * OCCT describer emits it (plane / cylinder / sphere). Non-analytic faces
 * return null so the caller can report "no source-surface check available"
 * instead of silently skipping.
 */
export function analyticDistance(px, py, pz, face) {
  if (face.kind === "plane") {
    const [ox, oy, oz] = face.point, [nx, ny, nz] = face.normal;
    return Math.abs((px - ox) * nx + (py - oy) * ny + (pz - oz) * nz);
  }
  if (face.kind === "cylinder") {
    const [ox, oy, oz] = face.point, [ax, ay, az] = face.axis;
    const dx = px - ox, dy = py - oy, dz = pz - oz;
    const along = dx * ax + dy * ay + dz * az;
    const radial = Math.hypot(dx - along * ax, dy - along * ay, dz - along * az);
    return Math.abs(radial - face.radius);
  }
  if (face.kind === "sphere") {
    const [cx, cy, cz] = face.center;
    return Math.abs(Math.hypot(px - cx, py - cy, pz - cz) - face.radius);
  }
  return null;
}

/** Unit normal of the analytic face at a point on (or near) it; orientation is not resolved. */
export function analyticNormal(px, py, pz, face) {
  if (face.kind === "plane") return face.normal;
  if (face.kind === "cylinder") {
    const [ox, oy, oz] = face.point, [ax, ay, az] = face.axis;
    const dx = px - ox, dy = py - oy, dz = pz - oz;
    const along = dx * ax + dy * ay + dz * az;
    const rx = dx - along * ax, ry = dy - along * ay, rz = dz - along * az;
    const length = Math.hypot(rx, ry, rz);
    return length === 0 ? null : [rx / length, ry / length, rz / length];
  }
  if (face.kind === "sphere") {
    const [cx, cy, cz] = face.center;
    const length = Math.hypot(px - cx, py - cy, pz - cz);
    return length === 0 ? null : [(px - cx) / length, (py - cy) / length, (pz - cz) / length];
  }
  return null;
}

/** Angle in degrees between two unit normals, ignoring orientation. */
export function unsignedNormalAngleDegrees(a, b) {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return (Math.acos(dot) * 180) / Math.PI;
}

const AXIS_VIEWS = {
  "+x": [1, 2], "-x": [1, 2], "+y": [0, 2], "-y": [0, 2], "+z": [0, 1], "-z": [0, 1],
};

/**
 * Orthographic coverage mask of a mesh seen along one world axis, on a square
 * raster over the given bounds. Coverage, not depth: a silhouette is what the
 * outline looks like, and both signs of an axis produce the same mask.
 */
export function rasterizeSilhouette(positions, indices, bounds, view, resolution) {
  const axes = AXIS_VIEWS[view];
  if (!axes) throw new TypeError(`unknown axis view ${view}`);
  const [u, v] = axes;
  const extent = Math.max(bounds.max[u] - bounds.min[u], bounds.max[v] - bounds.min[v]) || 1;
  const scale = resolution / extent;
  const mask = new Uint8Array(resolution * resolution);
  const toRaster = (vertex) => [(positions[vertex * 3 + u] - bounds.min[u]) * scale, (positions[vertex * 3 + v] - bounds.min[v]) * scale];
  for (let at = 0; at < indices.length; at += 3) {
    const [ax, ay] = toRaster(indices[at]), [bx, by] = toRaster(indices[at + 1]), [cx, cy] = toRaster(indices[at + 2]);
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(resolution - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(resolution - 1, Math.ceil(Math.max(ay, by, cy)));
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

/** Pixels covered by exactly one of two masks, and the coverage of the first. */
export function compareSilhouettes(reference, candidate) {
  let referenceCovered = 0, differing = 0;
  for (let at = 0; at < reference.length; at += 1) {
    referenceCovered += reference[at];
    if (reference[at] !== candidate[at]) differing += 1;
  }
  return { referenceCovered, differing, ratio: referenceCovered === 0 ? 0 : differing / referenceCovered };
}

export const silhouetteViews = Object.freeze(Object.keys(AXIS_VIEWS));

/**
 * Intersects a mesh with a plane and returns the section segments as a flat
 * list of point pairs. Triangles touching the plane only at a vertex or lying
 * in it contribute nothing; a section polyline is measured by sampling its
 * segments, so gaps are visible as distance, never hidden.
 */
export function sectionSegments(positions, indices, plane) {
  const [nx, ny, nz] = plane.normal;
  const offset = plane.point[0] * nx + plane.point[1] * ny + plane.point[2] * nz;
  const signed = (vertex) => positions[vertex * 3] * nx + positions[vertex * 3 + 1] * ny + positions[vertex * 3 + 2] * nz - offset;
  const segments = [];
  for (let at = 0; at < indices.length; at += 3) {
    const corners = [indices[at], indices[at + 1], indices[at + 2]];
    const crossings = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const a = corners[corner], b = corners[(corner + 1) % 3];
      const da = signed(a), db = signed(b);
      // A vertex exactly on the plane counts as the positive side, so a cut through
      // a vertex still yields one segment per crossed triangle instead of none.
      if ((da < 0) !== (db < 0)) {
        const t = da / (da - db);
        crossings.push([
          positions[a * 3] + t * (positions[b * 3] - positions[a * 3]),
          positions[a * 3 + 1] + t * (positions[b * 3 + 1] - positions[a * 3 + 1]),
          positions[a * 3 + 2] + t * (positions[b * 3 + 2] - positions[a * 3 + 2]),
        ]);
      }
    }
    if (crossings.length === 2) segments.push(crossings[0], crossings[1]);
  }
  return segments;
}

function pointSegmentDistance(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const lengthSquared = abx * abx + aby * aby + abz * abz;
  let t = lengthSquared === 0 ? 0 : ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * abx, p[1] - a[1] - t * aby, p[2] - a[2] - t * abz);
}

/**
 * Two-sided sampled distance between two section polylines (each a flat
 * segment list). `samplesPerSegment` points per segment, evenly spaced.
 */
export function sectionDistance(referenceSegments, candidateSegments, samplesPerSegment) {
  const oneWay = (from, to) => {
    const distances = [];
    for (let at = 0; at < from.length; at += 2) {
      const a = from[at], b = from[at + 1];
      for (let sample = 0; sample < samplesPerSegment; sample += 1) {
        const t = samplesPerSegment === 1 ? 0.5 : sample / (samplesPerSegment - 1);
        const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
        let best = Infinity;
        for (let other = 0; other < to.length; other += 2) best = Math.min(best, pointSegmentDistance(p, to[other], to[other + 1]));
        distances.push(best);
      }
    }
    return distances;
  };
  const forward = oneWay(referenceSegments, candidateSegments);
  const backward = oneWay(candidateSegments, referenceSegments);
  return {
    referenceSegments: referenceSegments.length / 2,
    candidateSegments: candidateSegments.length / 2,
    forward: summarizeDistances(forward),
    backward: summarizeDistances(backward),
    twoSided: summarizeDistances(forward.concat(backward)),
  };
}

/** Distance of each explicit-edge sample point to the nearest surface triangle. */
export function edgeAlignment(edgePositions, positions, indices) {
  const distances = new Float64Array(edgePositions.length / 3);
  for (let point = 0; point < distances.length; point += 1) {
    distances[point] = pointMeshDistance(edgePositions[point * 3], edgePositions[point * 3 + 1], edgePositions[point * 3 + 2], positions, indices);
  }
  return summarizeDistances(distances);
}

/** Axis-aligned bounds of a position array. */
export function computeBounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < positions.length; at += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[at + axis]);
      max[axis] = Math.max(max[axis], positions[at + axis]);
    }
  }
  return { min, max };
}
