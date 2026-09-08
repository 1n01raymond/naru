import { MeshoptSimplifier } from "meshoptimizer";
import { ids } from "@naru3d/scene-ir";
import type { Representation, SurfaceGeometry } from "@naru3d/scene-ir";

import {
  computeBounds,
  edgeAlignment,
  expandToSoup,
  rasterizeSilhouette,
  compareSilhouettes,
  sampledMeshDistance,
  sectionDistance,
  sectionSegments,
  silhouetteViews,
  topologySummary,
  triangleNormal,
  weldMesh,
  weldSoup,
  type WeldedMesh,
} from "./mesh-measures.js";

/**
 * Fixed measurement protocol of the in-compiler reduction pass. It mirrors
 * `artifacts/lod/method-comparison` (issue #126) so a compiled `reduced`
 * level is admitted by the same mesh-only checks the offline record used.
 * The analytic-face check needs OCCT faces and stays an offline gate.
 */
export const reducedLodProtocol = Object.freeze({
  method: "meshoptimizer-whole-shape-unlocked",
  normalWeight: 0.5,
  sampleCount: 2000,
  sampleSeed: 1,
  silhouetteResolution: 256,
  sectionSamplesPerSegment: 8,
  silhouetteRatioLimit: 0.005,
});

export type ReducedLodRetentionReason =
  | "no-surface"
  | "no-face-source-ids"
  | "no-explicit-edges"
  | "multiple-material-groups"
  | "simplifier-unsupported"
  | "nondeterministic"
  | "no-reduction"
  | "checks-failed";

export interface ReducedLodCheck {
  readonly name: string;
  readonly value: number | null;
  readonly limit: number;
  readonly pass: boolean;
  readonly note: string;
}

export interface ReducedLodReport {
  readonly representationId: string;
  readonly method: string;
  readonly targetErrorSourceUnits: number;
  readonly maxDeviationMeters: number;
  readonly inputTriangles: number;
  readonly outputTriangles: number;
  readonly reportedError: number;
  readonly identityAmbiguous: number;
  readonly identityOrphan: number;
  readonly checks: readonly ReducedLodCheck[];
}

export type ReducedLodOutcome =
  | { readonly outcome: "reduced"; readonly representation: Representation; readonly report: ReducedLodReport }
  | { readonly outcome: "retained"; readonly reason: ReducedLodRetentionReason; readonly report?: ReducedLodReport };

export class ReducedLodError extends Error {
  readonly code = "REDUCED_LOD";

  constructor(message: string) {
    super(message);
    this.name = "ReducedLodError";
  }
}

let simplifierReady = false;

/**
 * Instantiates the meshoptimizer WebAssembly module. `compileSceneToGltf` is
 * synchronous, so a caller that enables `reducedLod` awaits this once before
 * compiling; the synchronous pass throws if it was skipped.
 */
export async function prepareReducedLod(): Promise<void> {
  if (!MeshoptSimplifier.supported) {
    throw new ReducedLodError("meshoptimizer reports no WebAssembly support in this runtime.");
  }
  await MeshoptSimplifier.ready;
  simplifierReady = true;
}

export function isReducedLodPrepared(): boolean {
  return simplifierReady;
}

function at(array: ArrayLike<number>, index: number): number {
  return array[index] ?? 0;
}

export function vertexFaceSets(welded: WeldedMesh, faceSourceIds: ArrayLike<number>): Set<number>[] {
  const sets = Array.from({ length: welded.positions.length / 3 }, () => new Set<number>());
  const triangles = welded.indices.length / 3;
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const face = at(faceSourceIds, triangle);
    for (let corner = 0; corner < 3; corner += 1) {
      sets[at(welded.indices, triangle * 3 + corner)]?.add(face);
    }
  }
  return sets;
}

export interface TriangleFaceClassification {
  readonly faceIds: Uint32Array;
  readonly ambiguous: number;
  readonly orphan: number;
}

export function classifyTriangleFaces(
  faceSets: readonly Set<number>[],
  indices: ArrayLike<number>,
  fallbackFace: number,
): TriangleFaceClassification {
  const triangles = indices.length / 3;
  const faceIds = new Uint32Array(triangles);
  let ambiguous = 0;
  let orphan = 0;
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const first = faceSets[at(indices, triangle * 3)] ?? new Set<number>();
    const second = faceSets[at(indices, triangle * 3 + 1)] ?? new Set<number>();
    const third = faceSets[at(indices, triangle * 3 + 2)] ?? new Set<number>();
    const common = [...first].filter((face) => second.has(face) && third.has(face)).sort((a, b) => a - b);
    if (common.length > 1) ambiguous += 1;
    if (common.length === 0) orphan += 1;
    faceIds[triangle] = common.length >= 1 ? (common[0] ?? fallbackFace) : fallbackFace;
  }
  return { faceIds, ambiguous, orphan };
}

function cornerNormals(welded: WeldedMesh): Float32Array {
  const normals = new Float32Array(welded.positions.length);
  const triangles = welded.indices.length / 3;
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const normal = triangleNormal(
      welded.positions,
      at(welded.indices, triangle * 3),
      at(welded.indices, triangle * 3 + 1),
      at(welded.indices, triangle * 3 + 2),
    );
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = at(welded.indices, triangle * 3 + corner);
      normals[vertex * 3] = at(normals, vertex * 3) + normal[0];
      normals[vertex * 3 + 1] = at(normals, vertex * 3 + 1) + normal[1];
      normals[vertex * 3 + 2] = at(normals, vertex * 3 + 2) + normal[2];
    }
  }
  for (let vertex = 0; vertex < normals.length; vertex += 3) {
    const x = at(normals, vertex);
    const y = at(normals, vertex + 1);
    const z = at(normals, vertex + 2);
    const length = Math.hypot(x, y, z) || 1;
    normals[vertex] = x / length;
    normals[vertex + 1] = y / length;
    normals[vertex + 2] = z / length;
  }
  return normals;
}

interface SimplifiedMesh {
  readonly welded: WeldedMesh;
  readonly indices: Uint32Array;
  readonly reportedError: number;
}

function simplifyWholeShapeUnlocked(welded: WeldedMesh, targetError: number): SimplifiedMesh {
  const weight = reducedLodProtocol.normalWeight;
  const [indices, reportedError] = MeshoptSimplifier.simplifyWithAttributes(
    welded.indices,
    welded.positions,
    3,
    cornerNormals(welded),
    3,
    [weight, weight, weight],
    null,
    0,
    targetError,
    ["LockBorder", "ErrorAbsolute"],
  );
  return { welded, indices, reportedError };
}

function sameIndices(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function limitCheck(name: string, value: number | null, limit: number, note: string): ReducedLodCheck {
  const pass = typeof value === "number" && Number.isFinite(value) && value <= limit;
  return { name, value, limit, pass, note };
}

interface MeasuredCandidate {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly identityAmbiguous: number;
  readonly identityOrphan: number;
}

interface MeasuredReference {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  readonly edgePositions: ArrayLike<number>;
}

/**
 * The eight mesh-only checks of the #126 protocol against the prototype's own
 * `target` mesh. A section whose distance summary is empty fails closed
 * (`null`), where the offline recorder's `Math.max` would have coerced it to 0.
 */
export function measureAgainstTarget(
  candidate: MeasuredCandidate,
  reference: MeasuredReference,
  tolerance: number,
): readonly ReducedLodCheck[] {
  const candidateWelded = weldMesh(candidate.positions, candidate.indices);
  const referenceWelded = weldMesh(reference.positions, reference.indices);
  const topology = topologySummary(candidateWelded.positions, candidateWelded.indices);
  const referenceTopology = topologySummary(referenceWelded.positions, referenceWelded.indices);
  const distance = sampledMeshDistance(candidate, reference, reducedLodProtocol.sampleCount, reducedLodProtocol.sampleSeed);
  const bounds = computeBounds(reference.positions);
  const centre: readonly [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const planes: readonly (readonly [number, number, number])[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let sectionP95: number | null = 0;
  for (const normal of planes) {
    const plane = { normal, point: centre };
    const section = sectionDistance(
      sectionSegments(reference.positions, reference.indices, plane),
      sectionSegments(candidate.positions, candidate.indices, plane),
      reducedLodProtocol.sectionSamplesPerSegment,
    );
    const p95 = section.twoSided.p95;
    sectionP95 = sectionP95 === null || p95 === null ? null : Math.max(sectionP95, p95);
  }
  let silhouetteRatio = 0;
  for (const view of silhouetteViews) {
    const resolution = reducedLodProtocol.silhouetteResolution;
    const comparison = compareSilhouettes(
      rasterizeSilhouette(reference.positions, reference.indices, bounds, view, resolution),
      rasterizeSilhouette(candidate.positions, candidate.indices, bounds, view, resolution),
    );
    silhouetteRatio = Math.max(silhouetteRatio, comparison.ratio);
  }
  const edges =
    reference.edgePositions.length > 0
      ? edgeAlignment(reference.edgePositions, candidate.positions, candidate.indices).p95
      : null;
  return [
    limitCheck("sampled-two-sided-p95", distance.twoSided.p95, tolerance, "sampled mesh distance to the reference, not a Hausdorff bound"),
    limitCheck("sampled-two-sided-max", distance.twoSided.max, 2 * tolerance, "sampled"),
    limitCheck("edge-alignment-p95", edges, tolerance, "explicit-edge samples against the reduced surface"),
    limitCheck("section-p95", sectionP95, tolerance, "sampled section-curve distance to the reference section"),
    limitCheck(
      "silhouette-ratio-max",
      silhouetteRatio,
      reducedLodProtocol.silhouetteRatioLimit,
      "differing pixels over reference coverage, worst of six axis views",
    ),
    limitCheck("identity-conflicts", candidate.identityAmbiguous + candidate.identityOrphan, 0, "triangles whose corners disagree on the source face"),
    limitCheck("topology-euler-delta", Math.abs(topology.euler - referenceTopology.euler), 0, "Euler characteristic after exact weld, versus the reference"),
    limitCheck(
      "topology-boundary-delta",
      Math.abs(topology.boundaryEdges - referenceTopology.boundaryEdges),
      0,
      "boundary edge count after exact weld, versus the reference",
    ),
  ];
}

function retained(reason: ReducedLodRetentionReason, report?: ReducedLodReport): ReducedLodOutcome {
  return report ? { outcome: "retained", reason, report } : { outcome: "retained", reason };
}

/**
 * Builds the `reduced` representation of one prototype from its `target`
 * representation, or explains deterministically why the target is retained.
 * `maxDeviationMeters` is the declared error; `scaleToMeters` converts it into
 * the representation's own units, in which every measurement is taken.
 */
export function buildReducedRepresentation(
  representation: Representation,
  maxDeviationMeters: number,
  scaleToMeters: number,
): ReducedLodOutcome {
  if (!simplifierReady) {
    throw new ReducedLodError("reduced LOD requested before prepareReducedLod() resolved.");
  }
  const surface = representation.surface;
  if (!surface || surface.indices.length < 3) return retained("no-surface");
  if (!surface.faceSourceIds) return retained("no-face-source-ids");
  if (!representation.edges || representation.edges.segments.length === 0) return retained("no-explicit-edges");
  const groups = surface.materialGroups ?? [];
  if (groups.length > 1) return retained("multiple-material-groups");
  if (!MeshoptSimplifier.supported) return retained("simplifier-unsupported");

  const targetError = maxDeviationMeters / scaleToMeters;
  const welded = weldMesh(surface.positions, surface.indices);
  const first = simplifyWholeShapeUnlocked(welded, targetError);
  const second = simplifyWholeShapeUnlocked(welded, targetError);
  if (!sameIndices(first.indices, second.indices) || first.reportedError !== second.reportedError) {
    return retained("nondeterministic");
  }
  const inputTriangles = surface.indices.length / 3;
  const outputTriangles = first.indices.length / 3;
  const faceSets = vertexFaceSets(welded, surface.faceSourceIds);
  const classification = classifyTriangleFaces(faceSets, first.indices, at(surface.faceSourceIds, 0));
  const soup = expandToSoup(welded.positions, first.indices, classification.faceIds);
  const checks = measureAgainstTarget(
    {
      positions: soup.positions,
      indices: soup.indices,
      identityAmbiguous: classification.ambiguous,
      identityOrphan: classification.orphan,
    },
    { positions: surface.positions, indices: surface.indices, edgePositions: representation.edges.positions },
    targetError,
  );
  const report: ReducedLodReport = {
    representationId: representation.id,
    method: reducedLodProtocol.method,
    targetErrorSourceUnits: targetError,
    maxDeviationMeters,
    inputTriangles,
    outputTriangles,
    reportedError: first.reportedError,
    identityAmbiguous: classification.ambiguous,
    identityOrphan: classification.orphan,
    checks,
  };
  if (outputTriangles >= inputTriangles) return retained("no-reduction", report);
  if (!checks.every((check) => check.pass)) return retained("checks-failed", report);

  const compact = weldSoup(soup);
  const bounds = computeBounds(compact.positions);
  const group = groups[0];
  const reducedSurface: SurfaceGeometry = {
    primitive: "triangles",
    positions: compact.positions,
    normals: compact.normals,
    indices: compact.indices,
    faceSourceIds: compact.faceSourceIds,
    ...(group ? { materialGroups: [{ firstIndex: 0, indexCount: compact.indices.length, materialId: group.materialId }] } : {}),
  };
  const sourceMap = representation.sourceMap
    ? { ...representation.sourceMap, faceSourceIndices: Uint32Array.from(soup.faceSourceIds) }
    : undefined;
  const p95 = checks.find((check) => check.name === "sampled-two-sided-p95")?.value ?? null;
  const reduced: Representation = {
    id: ids.representation(`${representation.id}#reduced`),
    prototypeId: representation.prototypeId,
    purpose: representation.purpose,
    accuracy: {
      kind: "simplified",
      linearTolerance: targetError,
      ...(representation.accuracy.unit ? { unit: representation.accuracy.unit } : {}),
      notes: [
        `method=${reducedLodProtocol.method}`,
        `maxDeviationMeters=${maxDeviationMeters}`,
        `sampledTwoSidedP95=${p95 === null ? "null" : String(p95)}`,
      ],
    },
    localFrame: representation.localFrame,
    surface: reducedSurface,
    edges: representation.edges,
    bounds: {
      min: [bounds.min[0], bounds.min[1], bounds.min[2]],
      max: [bounds.max[0], bounds.max[1], bounds.max[2]],
    },
    ...(sourceMap ? { sourceMap } : {}),
  };
  return { outcome: "reduced", representation: reduced, report };
}
