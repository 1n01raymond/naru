import { describe, expect, it } from "vitest";

import {
  classifyTriangleFaces,
  evaluateThresholds,
  resolveFaceIdentity,
  simplifyPerFaceLocked,
  simplifyWholeShape,
  thresholdsFor,
} from "../../../scripts/lib/lod-experiment.mjs";
import {
  analyticDistance,
  compareSilhouettes,
  computeBounds,
  expandToSoup,
  rasterizeSilhouette,
  sectionDistance,
  sectionSegments,
  topologySummary,
  weldMesh,
} from "../../../scripts/lib/lod-mesh.mjs";

/** Unit cube as 12 welded triangles; face id = cube side (0..5). */
function cube() {
  const p = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const indices: number[] = [];
  const faceIds: number[] = [];
  quads.forEach((q, face) => {
    indices.push(q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!);
    faceIds.push(face, face);
  });
  return { positions: Float32Array.from(p), indices: Uint32Array.from(indices), faceIds: Uint32Array.from(faceIds) };
}

/** Planar n x n grid on z = 0 with every interior vertex free; one face. */
function grid(n: number, face = 0) {
  const positions: number[] = [];
  for (let y = 0; y <= n; y += 1) for (let x = 0; x <= n; x += 1) positions.push(x, y, 0);
  const indices: number[] = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const a = y * (n + 1) + x;
      indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  }
  const faceIds = new Uint32Array(indices.length / 3).fill(face);
  return expandToSoup(Float32Array.from(positions), Uint32Array.from(indices), faceIds);
}

/** The adapter mesh shape `extractMeshes` returns, with no explicit edges. */
function asMesh(soup: ReturnType<typeof grid>) {
  return { ...soup, edgePositions: new Float32Array(0), edgeSegments: new Uint32Array(0) };
}

describe("lod mesh measures", () => {
  it("welds a triangle soup back to a closed cube", () => {
    const c = cube();
    const soup = expandToSoup(c.positions, c.indices, c.faceIds);
    expect(soup.positions.length).toBe(36 * 3);
    const welded = weldMesh(soup.positions, soup.indices);
    const topology = topologySummary(welded.positions, welded.indices);
    expect(topology).toMatchObject({ vertices: 8, triangles: 12, edges: 18, boundaryEdges: 0, nonManifoldEdges: 0, euler: 2 });
  });

  it("measures analytic distances in closed form", () => {
    expect(analyticDistance(1, 2, 3.5, { kind: "plane", point: [0, 0, 3], normal: [0, 0, 1] })).toBeCloseTo(0.5);
    expect(analyticDistance(3, 4, 9, { kind: "cylinder", point: [0, 0, 0], axis: [0, 0, 1], radius: 4 })).toBeCloseTo(1);
    expect(analyticDistance(0, 3, 4, { kind: "sphere", center: [0, 0, 0], radius: 6 })).toBeCloseTo(1);
    expect(analyticDistance(0, 0, 0, { kind: "torus" })).toBeNull();
  });

  it("sees a missing triangle in the silhouette and nothing in an identical mesh", () => {
    const c = cube();
    const bounds = computeBounds(c.positions);
    const full = rasterizeSilhouette(c.positions, c.indices, bounds, "+z", 32);
    expect(compareSilhouettes(full, rasterizeSilhouette(c.positions, c.indices, bounds, "+z", 32)).ratio).toBe(0);
    const oneTriangle = rasterizeSilhouette(c.positions, c.indices.subarray(0, 3), bounds, "+z", 32);
    expect(compareSilhouettes(full, oneTriangle).ratio).toBeGreaterThan(0.3);
  });

  it("keeps section segments when the plane passes through vertices", () => {
    const c = cube();
    const segments = sectionSegments(c.positions, c.indices, { point: [0.5, 0.5, 0.5], normal: [1, 0, -1] });
    let length = 0;
    for (let at = 0; at < segments.length; at += 2) {
      const a = segments[at] as number[];
      const b = segments[at + 1] as number[];
      length += Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0), (b[2] ?? 0) - (a[2] ?? 0));
    }
    expect(length).toBeCloseTo(2 + 2 * Math.SQRT2, 6);
  });

  it("sections a cube into eight segments that measure zero against themselves", () => {
    const c = cube();
    const plane = { point: [0.5, 0.5, 0.5], normal: [0, 0, 1] };
    const segments = sectionSegments(c.positions, c.indices, plane);
    expect(segments.length / 2).toBe(8);
    expect(sectionDistance(segments, segments, 3).twoSided.max).toBe(0);
  });
});

describe("meshoptimizer arms", () => {
  it("reduces a planar face while keeping its border and face identity, deterministically", async () => {
    const mesh = asMesh(grid(6));
    const first = await simplifyPerFaceLocked(mesh, 0.01);
    const second = await simplifyPerFaceLocked(mesh, 0.01);
    expect(first.inputTriangles).toBe(72);
    expect(first.outputTriangles).toBeLessThan(72);
    expect(first.outputTriangles).toBeGreaterThanOrEqual(2);
    expect(Array.from(new Set(first.faceSourceIds))).toEqual([0]);
    const welded = weldMesh(first.positions, first.indices);
    const border = new Set<string>();
    for (let v = 0; v < welded.positions.length; v += 3) {
      const [x, y] = [welded.positions[v]!, welded.positions[v + 1]!];
      if (x === 0 || y === 0 || x === 6 || y === 6) border.add(`${x},${y}`);
    }
    expect(border.size).toBe(24);
    expect(Array.from(second.indices)).toEqual(Array.from(first.indices));
    expect(Array.from(second.positions)).toEqual(Array.from(first.positions));
  });

  it("classifies whole-shape triangles by the face their corners share", async () => {
    const mesh = asMesh(grid(4));
    const reduced = await simplifyWholeShape(mesh, 0.01, 0.5, { lockBoundaries: false });
    expect(reduced.outputTriangles).toBeLessThan(32);
    expect(reduced.detail).toMatchObject({ method: "meshoptimizer-whole-shape-unlocked", identityConflicts: 0 });
    expect(reduced.candidates.every((c: number[]) => c.length === 1 && c[0] === 0)).toBe(true);

    const sets = [new Set([0, 1]), new Set([0, 1]), new Set([0, 1]), new Set([2])];
    const classified = classifyTriangleFaces(sets, Uint32Array.from([0, 1, 2, 0, 1, 3]), 9);
    expect(classified).toMatchObject({ ambiguous: 1, orphan: 1 });
    expect(Array.from(classified.faceIds)).toEqual([0, 9]);
  });

  it("resolves an ambiguous triangle to the nearest analytic face and counts the rest as conflicts", () => {
    const reduced = {
      welded: { positions: Float32Array.from([0, 0, 5, 1, 0, 5, 0, 1, 5, 0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2, 3, 4, 5]) },
      candidates: [[0, 1], []],
      faceSourceIds: Uint32Array.from([0, 0]),
      detail: { identityConflicts: 1 },
    };
    const faces = [{ kind: "plane", point: [0, 0, 0], normal: [0, 0, 1] }, { kind: "plane", point: [0, 0, 5], normal: [0, 0, 1] }];
    const result = resolveFaceIdentity(reduced, faces, 0.1, analyticDistance);
    expect(result).toMatchObject({ conflicts: 1, resolved: 1 });
    expect(Array.from(result.faceSourceIds!)).toEqual([1, 0]);
  });
});

describe("predeclared thresholds", () => {
  it("fails closed on a missing measurement and passes only inside every limit", () => {
    const thresholds = thresholdsFor(0.5, 0.15);
    expect(thresholds.map((t) => t.name)).toContain("normal-p95-degrees");
    const measured: Record<string, number> = Object.fromEntries(thresholds.map((t) => [t.name, 0]));
    expect(evaluateThresholds(thresholds, measured).allPass).toBe(true);
    measured["sampled-two-sided-max"] = 1.5;
    const failed = evaluateThresholds(thresholds, measured);
    expect(failed.allPass).toBe(false);
    expect(failed.checks.filter((c: { pass: boolean }) => !c.pass).map((c: { name: string }) => c.name)).toEqual(["sampled-two-sided-max"]);
    delete measured["section-p95"];
    expect(evaluateThresholds(thresholds, measured).checks.find((c: { name: string }) => c.name === "section-p95")?.pass).toBe(false);
  });
});
