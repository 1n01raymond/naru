/**
 * The two LOD arms of issue #126, as functions a recorder and a unit test call
 * the same way: OCCT retessellation at declared tolerances (arm 1) and
 * meshoptimizer simplification of the adapter's own mesh (arm 2). Nothing here
 * changes output precision or a codec: a reduced surface is re-expanded into
 * the adapter's soup layout and encoded by the unchanged compiler.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { MeshoptSimplifier } from "meshoptimizer";

import {
  computeBounds,
  expandToSoup,
  triangleNormal,
  weldMesh,
} from "./lod-mesh.mjs";

export const meshoptimizerVersion = JSON.parse(
  readFileSync(new URL("../../node_modules/meshoptimizer/package.json", import.meta.url), "utf8"),
).version;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Runs the OCCT adapter once at one tolerance pair and reads back what it wrote. */
export function runOcctAdapter({ pythonExecutable, adapterScript, source, linearTolerance, angularTolerance, sceneOutput, reportOutput, cwd }) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(
    pythonExecutable,
    [adapterScript, source, "--scene", sceneOutput, "--report", reportOutput, "--linear-tolerance", String(linearTolerance), "--angular-tolerance", String(angularTolerance)],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (result.status !== 0) {
    throw new Error(`OCCT adapter failed at ${linearTolerance}/${angularTolerance}: ${result.stderr || result.stdout}`);
  }
  const sceneBytes = readFileSync(sceneOutput);
  return {
    elapsedMs,
    sceneBytes: sceneBytes.byteLength,
    sceneSha256: sha256Hex(sceneBytes),
    scene: JSON.parse(sceneBytes.toString("utf8")),
    report: JSON.parse(readFileSync(reportOutput, "utf8")),
  };
}

/**
 * Pulls each part's display representation into typed arrays. `faceSourceIds`
 * index `sourceMap.sourceRefs`, whose first entries are the faces in OCCT
 * order -- the same order the analytic describer walks -- which is asserted
 * here rather than assumed.
 */
export function extractMeshes(scene) {
  const meshes = new Map();
  for (const representation of scene.representations) {
    if (representation.purpose !== "display" || !representation.surface) continue;
    const { surface, edges, sourceMap } = representation;
    const faceCount = sourceMap.sourceRefs.filter((ref) => ref.includes(":face:")).length;
    for (let face = 0; face < faceCount; face += 1) {
      const expected = `:face:${String(face).padStart(3, "0")}`;
      if (!sourceMap.sourceRefs[face].endsWith(expected)) {
        throw new Error(`${representation.id}: sourceRefs[${face}] is not face ${face}`);
      }
    }
    meshes.set(representation.prototypeId, {
      representationId: representation.id,
      prototypeId: representation.prototypeId,
      accuracy: representation.accuracy,
      positions: Float32Array.from(surface.positions),
      indices: Uint32Array.from(surface.indices),
      faceSourceIds: Uint32Array.from(surface.faceSourceIds),
      faceCount,
      edgePositions: Float32Array.from(edges?.positions ?? []),
      edgeSegments: Uint32Array.from(edges?.segments ?? []),
      edgeSourceIds: Uint32Array.from(edges?.sourceIds ?? []),
      sourceRefs: sourceMap.sourceRefs,
    });
  }
  return meshes;
}

/** Bytes the runtime charges for one instance of this surface + edge set. */
export function residencyShapeOf(mesh) {
  return {
    surfaceVertexBytes: (mesh.positions.length / 3) * 6 * 4,
    surfaceIndexBytes: mesh.indices.length * 4,
    edgeVertexBytes: mesh.edgeSegments.length * 3 * 4,
    instanceCount: 1,
  };
}

async function simplifier() {
  await MeshoptSimplifier.ready;
  return MeshoptSimplifier;
}

/** Face sets per welded vertex: which source faces reference each position. */
function vertexFaceSets(welded, faceSourceIds) {
  const sets = Array.from({ length: welded.positions.length / 3 }, () => new Set());
  for (let triangle = 0; triangle < faceSourceIds.length; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) sets[welded.indices[triangle * 3 + corner]].add(faceSourceIds[triangle]);
  }
  return sets;
}

/** Locks every welded vertex that lies on an explicit-edge sample or is shared between faces. */
function boundaryLocks(welded, faceSets, edgePositions) {
  const lock = new Uint8Array(faceSets.length);
  const onEdge = new Set();
  for (let i = 0; i < edgePositions.length; i += 3) {
    onEdge.add(`${edgePositions[i]}|${edgePositions[i + 1]}|${edgePositions[i + 2]}`);
  }
  for (let v = 0; v < faceSets.length; v += 1) {
    const key = `${welded.positions[v * 3]}|${welded.positions[v * 3 + 1]}|${welded.positions[v * 3 + 2]}`;
    if (faceSets[v].size > 1 || onEdge.has(key)) lock[v] = 1;
  }
  return lock;
}

/**
 * Arm 2a, the constrained arm: each source face is simplified on its own with
 * its border locked, so every output triangle still carries exactly the face
 * it came from and face boundaries never move.
 */
export async function simplifyPerFaceLocked(mesh, targetError) {
  const meshopt = await simplifier();
  const welded = weldMesh(mesh.positions, mesh.indices);
  const perFace = new Map();
  for (let t = 0; t < mesh.faceSourceIds.length; t += 1) {
    const face = mesh.faceSourceIds[t];
    if (!perFace.has(face)) perFace.set(face, []);
    perFace.get(face).push(welded.indices[t * 3], welded.indices[t * 3 + 1], welded.indices[t * 3 + 2]);
  }
  const indexChunks = [];
  const faceChunks = [];
  const faceErrors = [];
  for (const face of [...perFace.keys()].sort((a, b) => a - b)) {
    const faceIndices = Uint32Array.from(perFace.get(face));
    const [reduced, error] = meshopt.simplify(faceIndices, welded.positions, 3, 0, targetError, ["LockBorder", "Sparse", "ErrorAbsolute"]);
    indexChunks.push(reduced);
    faceChunks.push(new Uint32Array(reduced.length / 3).fill(face));
    faceErrors.push({ face, inputTriangles: faceIndices.length / 3, outputTriangles: reduced.length / 3, reportedError: error });
  }
  return finishSimplified(mesh, welded, concat(indexChunks), concat(faceChunks), { method: "meshoptimizer-per-face-locked", targetError, faceErrors, identityConflicts: 0 });
}

/**
 * Arm 2b, the unconstrained arm: the whole welded shape with per-vertex
 * normals as a weighted attribute and locks only where a vertex sits on an
 * explicit edge or is shared by two faces. A triangle's face is the one face
 * all three corners agree on; anything else is an identity conflict.
 */
export async function simplifyWholeShape(mesh, targetError, normalWeight = 0.5, { lockBoundaries = true } = {}) {
  const meshopt = await simplifier();
  const welded = weldMesh(mesh.positions, mesh.indices);
  const faceSets = vertexFaceSets(welded, mesh.faceSourceIds);
  const lock = lockBoundaries ? boundaryLocks(welded, faceSets, mesh.edgePositions) : new Uint8Array(faceSets.length);
  const normals = new Float32Array(welded.positions.length);
  for (let t = 0; t < welded.indices.length; t += 3) {
    const [a, b, c] = [welded.indices[t], welded.indices[t + 1], welded.indices[t + 2]];
    const n = triangleNormal(welded.positions, a, b, c);
    for (const v of [a, b, c]) { normals[v * 3] += n[0]; normals[v * 3 + 1] += n[1]; normals[v * 3 + 2] += n[2]; }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
    normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l;
  }
  const [reduced, reportedError] = meshopt.simplifyWithAttributes(
    welded.indices, welded.positions, 3, normals, 3, [normalWeight, normalWeight, normalWeight], lock, 0, targetError, ["LockBorder", "ErrorAbsolute"],
  );
  const identity = classifyTriangleFaces(faceSets, reduced, mesh.faceSourceIds[0]);
  const lockedVertices = lock.reduce((sum, value) => sum + value, 0);
  const method = lockBoundaries ? "meshoptimizer-whole-shape-locked-boundaries" : "meshoptimizer-whole-shape-unlocked";
  return { ...finishSimplified(mesh, welded, reduced, identity.faceIds, { method, targetError, normalWeight, lockBoundaries, reportedError, lockedVertices, identityConflicts: identity.ambiguous + identity.orphan, identityAmbiguous: identity.ambiguous, identityOrphan: identity.orphan }), candidates: identity.candidates };
}

/**
 * Resolves ambiguous triangles of a whole-shape arm against the analytic
 * source faces: an ambiguous triangle goes to the candidate face nearest its
 * centroid, and stays a conflict when no candidate lies within `tolerance` or
 * when its corners share no face at all. Per-face arms never need this.
 */
export function resolveFaceIdentity(reduced, faces, tolerance, analyticDistance) {
  if (!reduced.candidates) return { conflicts: reduced.detail.identityConflicts, resolved: 0 };
  const { positions, indices } = reduced.welded;
  const faceIds = new Uint32Array(reduced.candidates.length);
  let conflicts = 0;
  let resolved = 0;
  for (let t = 0; t < faceIds.length; t += 1) {
    const candidates = reduced.candidates[t];
    if (candidates.length === 1) { faceIds[t] = candidates[0]; continue; }
    if (candidates.length === 0) { conflicts += 1; faceIds[t] = reduced.faceSourceIds[0]; continue; }
    let cx = 0; let cy = 0; let cz = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const v = indices[t * 3 + corner] * 3;
      cx += positions[v] / 3; cy += positions[v + 1] / 3; cz += positions[v + 2] / 3;
    }
    let best = candidates[0]; let bestDistance = Number.POSITIVE_INFINITY;
    for (const face of candidates) {
      const d = analyticDistance(cx, cy, cz, faces[face]);
      if (d !== null && d < bestDistance) { bestDistance = d; best = face; }
    }
    faceIds[t] = best;
    if (bestDistance <= tolerance) resolved += 1; else conflicts += 1;
  }
  const soup = expandToSoup(positions, indices, faceIds);
  return { conflicts, resolved, faceSourceIds: soup.faceSourceIds };
}

/**
 * Assigns each triangle the one source face all three corners share.
 * `ambiguous` counts triangles whose corners share more than one face (all
 * three on a face boundary), `orphan` those whose corners share none.
 */
export function classifyTriangleFaces(faceSets, indices, fallbackFace) {
  const faceIds = new Uint32Array(indices.length / 3);
  const candidates = [];
  let ambiguous = 0;
  let orphan = 0;
  for (let t = 0; t < faceIds.length; t += 1) {
    let common = [...faceSets[indices[t * 3]]];
    for (let corner = 1; corner < 3; corner += 1) {
      const set = faceSets[indices[t * 3 + corner]];
      common = common.filter((face) => set.has(face));
    }
    if (common.length > 1) ambiguous += 1;
    if (common.length === 0) orphan += 1;
    candidates.push(common.sort((a, b) => a - b));
    faceIds[t] = common.length >= 1 ? common[0] : fallbackFace;
  }
  return { faceIds, candidates, ambiguous, orphan };
}

/** The same classification over the adapter's own mesh: its baseline of seam triangles. */
export function referenceIdentity(mesh) {
  const welded = weldMesh(mesh.positions, mesh.indices);
  const faceSets = vertexFaceSets(welded, mesh.faceSourceIds);
  const { ambiguous, orphan } = classifyTriangleFaces(faceSets, welded.indices, mesh.faceSourceIds[0]);
  return { ambiguous, orphan, lockedVertices: boundaryLocks(welded, faceSets, mesh.edgePositions).reduce((a, b) => a + b, 0), weldedVertices: faceSets.length };
}

function concat(chunks) {
  const out = new Uint32Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function finishSimplified(mesh, welded, indices, faceIds, detail) {
  const soup = expandToSoup(welded.positions, indices, faceIds);
  return {
    ...mesh,
    detail,
    welded: { positions: welded.positions, indices },
    positions: soup.positions,
    normals: soup.normals,
    indices: soup.indices,
    faceSourceIds: soup.faceSourceIds,
    inputTriangles: mesh.indices.length / 3,
    outputTriangles: indices.length / 3,
  };
}

/**
 * Rewrites the display representations of one scene with reduced surfaces.
 * Edges, source maps, occurrences, and identifiers are untouched; only the
 * surface arrays and the accuracy note change, so picking still resolves the
 * same occurrence and the same `faceSourceIds` vocabulary.
 */
export function replaceSurfaces(scene, replacements) {
  const copy = structuredClone(scene);
  for (const representation of copy.representations) {
    const reduced = replacements.get(representation.prototypeId);
    if (!reduced) continue;
    representation.surface.positions = Array.from(reduced.positions);
    representation.surface.normals = Array.from(reduced.normals);
    representation.surface.indices = Array.from(reduced.indices);
    representation.surface.faceSourceIds = Array.from(reduced.faceSourceIds);
    representation.surface.materialGroups = [{ firstIndex: 0, indexCount: reduced.indices.length, materialId: representation.surface.materialGroups[0].materialId }];
    representation.sourceMap.faceSourceIndices = Array.from(reduced.faceSourceIds);
    representation.bounds = computeBounds(reduced.positions);
    representation.accuracy.notes = [...(representation.accuracy.notes ?? []), `${reduced.detail.method} targetError=${reduced.detail.targetError} mm over the adapter mesh`];
  }
  return copy;
}

/** Encoded bytes and wall time of the unchanged compiler over one scene. */
export async function measureEncoding(scene, compileSceneToGltf) {
  const startedAt = process.hrtime.bigint();
  const compiled = await compileSceneToGltf(scene, { compactJson: true });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const binary = compiled.binary;
  return {
    compileMs: elapsedMs,
    documentBytes: compiled.json.bytes,
    binaryBytes: binary.byteLength,
    coarseBytes: compiled.coarseBinary?.byteLength ?? 0,
    encodedBytes: compiled.json.bytes + binary.byteLength + (compiled.coarseBinary?.byteLength ?? 0),
    documentSha256: compiled.json.sha256,
    binarySha256: sha256Hex(binary),
  };
}

/**
 * The predeclared thresholds. `t` is the arm's declared linear tolerance
 * (arm 1) or its target error (arm 2), in millimetres; `angular` is the arm's
 * declared angular tolerance in radians when it has one.
 */
export function thresholdsFor(t, angular) {
  const checks = [
    { name: "sampled-two-sided-p95", limit: t, note: "sampled mesh distance to the reference, not a Hausdorff bound" },
    { name: "sampled-two-sided-max", limit: 2 * t, note: "sampled" },
    { name: "analytic-max", limit: t, note: "triangle-interior samples against their own analytic source face" },
    { name: "edge-alignment-p95", limit: t, note: "explicit-edge samples against the arm surface" },
    { name: "section-p95", limit: t, note: "sampled section-curve distance to the reference section" },
    { name: "silhouette-ratio-max", limit: 0.005, note: "differing pixels over reference coverage, worst of six axis views" },
    { name: "identity-conflicts", limit: 0, note: "triangles whose corners disagree on the source face" },
    { name: "topology-euler-delta", limit: 0, note: "Euler characteristic after exact weld, versus the reference" },
    { name: "topology-boundary-delta", limit: 0, note: "boundary edge count after exact weld, versus the reference" },
  ];
  if (angular !== undefined) checks.push({ name: "normal-p95-degrees", limit: (2 * angular * 180) / Math.PI, note: "sampled normal deviation against the analytic face normal" });
  return checks;
}

/** Applies the thresholds to measured values; a missing measurement fails closed. */
export function evaluateThresholds(thresholds, measured) {
  const results = thresholds.map(({ name, limit, note }) => {
    const value = measured[name];
    const pass = typeof value === "number" && Number.isFinite(value) && value <= limit;
    return { name, value: value ?? null, limit, pass, note };
  });
  return { checks: results, allPass: results.every((c) => c.pass) };
}
