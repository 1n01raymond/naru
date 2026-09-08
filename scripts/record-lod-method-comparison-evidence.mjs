/**
 * Records the issue #126 LOD method comparison on the redistribution-approved
 * `lod-corpus` STEP fixture: OCCT retessellation at declared tolerances (arm 1)
 * against meshoptimizer simplification of the adapter's own mesh (arm 2), every
 * arm measured against one common high-resolution reference with thresholds
 * that were predeclared before any reduction target was chosen.
 *
 * Nothing here changes the compiler, the adapter, or the runtime: the arms are
 * measured offline and encoded by the unchanged compiler so the encoded bytes
 * and residency costs are the ones the product would pay.
 *
 * Usage: node scripts/record-lod-method-comparison-evidence.mjs
 *          [--work output/lod-method] [--output artifacts/lod/method-comparison]
 *          [--python <cadquery python>]
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, totalmem } from "node:os";
import { relative, resolve } from "node:path";

import { compileSceneToGltf } from "../packages/compiler/dist/index.js";
import { batchResidencyCost } from "../packages/runtime-webgpu/dist/layout.js";
import {
  evaluateThresholds, extractMeshes, measureEncoding, meshoptimizerVersion, referenceIdentity,
  replaceSurfaces, residencyShapeOf, resolveFaceIdentity, runOcctAdapter, sha256Hex,
  simplifyPerFaceLocked, simplifyWholeShape, thresholdsFor,
} from "./lib/lod-experiment.mjs";
import {
  analyticDistance, analyticNormal, compareSilhouettes, computeBounds, createSeededRandom, edgeAlignment,
  rasterizeSilhouette, sampleSurfacePoints, sampledMeshDistance, sectionDistance, sectionSegments,
  silhouetteViews, summarizeDistances, topologySummary, triangleNormal, unsignedNormalAngleDegrees, weldMesh,
} from "./lib/lod-mesh.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`${name} requires a value.`);
  return value;
};
const workDirectory = resolve(repositoryRoot, argument("--work", "output/lod-method"));
const artifactDirectory = resolve(repositoryRoot, argument("--output", "artifacts/lod/method-comparison"));
const pythonExecutable = argument("--python", process.env.NARU_PYTHON ?? resolve(repositoryRoot, "output/cadquery-venv/Scripts/python.exe"));
const adapterScript = resolve(repositoryRoot, "native/adapter-occt/tools/extract_scene_ir.py");
const describerScript = resolve(repositoryRoot, "native/adapter-occt/tools/describe_analytic_faces.py");
const sourcePath = resolve(repositoryRoot, "fixtures/step/lod-corpus.step");

/** Protocol, fixed before any measurement was read. */
const PROTOCOL = {
  reference: { linearTolerance: 0.02, angularTolerance: 0.05 },
  retessellation: [[0.05, 0.1], [0.15, 0.15], [0.5, 0.3], [1.0, 0.5]],
  simplificationInput: { linearTolerance: 0.15, angularTolerance: 0.15 },
  simplification: { targetErrors: [0.5, 1.0], normalWeight: 0.5 },
  sampleCount: 2000, sampleSeed: 1, silhouetteResolution: 256, sectionSamplesPerSegment: 8, repeats: 2,
  identityTolerance: 0.01,
};
const started = process.hrtime.bigint();
const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : value);
const summary = (s) => ({ count: s.count, max: round(s.max), mean: round(s.mean), p50: round(s.p50), p95: round(s.p95) });

/** One adapter run per tolerance pair, repeated so determinism is a measured fact. */
function tessellate(label, linearTolerance, angularTolerance) {
  const runs = [];
  for (let repeat = 0; repeat < PROTOCOL.repeats; repeat += 1) {
    runs.push(runOcctAdapter({
      pythonExecutable, adapterScript, source: sourcePath, linearTolerance, angularTolerance,
      sceneOutput: resolve(workDirectory, `${label}-run${repeat}.scene.json`),
      reportOutput: resolve(workDirectory, `${label}-run${repeat}.report.json`),
      cwd: repositoryRoot,
    }));
  }
  const first = runs[0];
  return {
    linearTolerance, angularTolerance, scene: first.scene, report: first.report,
    adapterMs: runs.map((run) => round(run.elapsedMs, 1)), sceneBytes: first.sceneBytes,
    sceneSha256: runs.map((run) => run.sceneSha256),
    deterministic: runs.every((run) => run.sceneSha256 === first.sceneSha256),
  };
}

function describeFaces() {
  const output = resolve(workDirectory, "analytic-faces.json");
  const result = spawnSync(pythonExecutable, [describerScript, sourcePath, "--output", output], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`describer failed: ${result.stderr || result.stdout}`);
  return readFile(output, "utf8").then((text) => JSON.parse(text).prototypes);
}

/** Geometry measures of one arm mesh against the reference mesh of the same part. */
function measurePart(candidate, reference, faces, angularTolerance) {
  const welded = weldMesh(candidate.positions, candidate.indices);
  const referenceWelded = weldMesh(reference.positions, reference.indices);
  const topology = topologySummary(welded.positions, welded.indices);
  const referenceTopology = topologySummary(referenceWelded.positions, referenceWelded.indices);
  const distance = sampledMeshDistance(candidate, reference, PROTOCOL.sampleCount, PROTOCOL.sampleSeed);

  const random = createSeededRandom(PROTOCOL.sampleSeed);
  const { points, triangleOf } = sampleSurfacePoints(candidate.positions, candidate.indices, PROTOCOL.sampleCount, random);
  const analytic = new Float64Array(PROTOCOL.sampleCount);
  const normals = new Float64Array(PROTOCOL.sampleCount);
  let analyticUnavailable = 0;
  for (let s = 0; s < PROTOCOL.sampleCount; s += 1) {
    const face = faces[candidate.faceSourceIds[triangleOf[s]]];
    const d = face ? analyticDistance(points[s * 3], points[s * 3 + 1], points[s * 3 + 2], face) : null;
    if (d === null) { analyticUnavailable += 1; analytic[s] = NaN; normals[s] = NaN; continue; }
    analytic[s] = d;
    const t = triangleOf[s];
    const n = triangleNormal(candidate.positions, candidate.indices[t * 3], candidate.indices[t * 3 + 1], candidate.indices[t * 3 + 2]);
    normals[s] = unsignedNormalAngleDegrees(n, analyticNormal(points[s * 3], points[s * 3 + 1], points[s * 3 + 2], face));
  }
  const finite = (values) => summarizeDistances(values.filter((v) => Number.isFinite(v)));

  const bounds = computeBounds(reference.positions);
  const centre = bounds.min.map((v, axis) => (v + bounds.max[axis]) / 2);
  const sections = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((normal) => {
    const plane = { point: centre, normal };
    return sectionDistance(
      sectionSegments(reference.positions, reference.indices, plane),
      sectionSegments(candidate.positions, candidate.indices, plane), PROTOCOL.sectionSamplesPerSegment,
    );
  });
  const silhouettes = silhouetteViews.map((view) => compareSilhouettes(
    rasterizeSilhouette(reference.positions, reference.indices, bounds, view, PROTOCOL.silhouetteResolution),
    rasterizeSilhouette(candidate.positions, candidate.indices, bounds, view, PROTOCOL.silhouetteResolution),
  ));
  const edges = candidate.edgePositions.length > 0 ? edgeAlignment(candidate.edgePositions, candidate.positions, candidate.indices) : null;
  const cost = batchResidencyCost(residencyShapeOf(candidate));
  return {
    triangles: candidate.indices.length / 3, weldedVertices: topology.vertices, edgeSegments: candidate.edgeSegments.length / 2,
    residency: { decodedBytes: cost.decodedBytes, gpuBytes: cost.gpuBytes },
    sampledDistance: { forward: summary(distance.forward), backward: summary(distance.backward), twoSided: summary(distance.twoSided) },
    analytic: { distance: summary(finite(analytic)), normalDegrees: summary(finite(normals)), unavailableSamples: analyticUnavailable },
    edgeAlignment: edges ? summary(edges) : null,
    section: sections.map((s) => ({ referenceSegments: s.referenceSegments, candidateSegments: s.candidateSegments, twoSided: summary(s.twoSided) })),
    silhouette: silhouettes.map((s, at) => ({ view: silhouetteViews[at], referenceCovered: s.referenceCovered, differing: s.differing, ratio: round(s.ratio, 5) })),
    topology, referenceTopology,
    measured: {
      "sampled-two-sided-p95": distance.twoSided.p95, "sampled-two-sided-max": distance.twoSided.max,
      "analytic-max": analyticUnavailable === 0 ? finite(analytic).max : NaN,
      "edge-alignment-p95": edges ? edges.p95 : NaN,
      "section-p95": Math.max(...sections.map((s) => s.twoSided.p95)),
      "silhouette-ratio-max": Math.max(...silhouettes.map((s) => s.ratio)),
      "topology-euler-delta": Math.abs(topology.euler - referenceTopology.euler),
      "topology-boundary-delta": Math.abs(topology.boundaryEdges - referenceTopology.boundaryEdges),
      ...(angularTolerance === undefined ? {} : { "normal-p95-degrees": analyticUnavailable === 0 ? finite(normals).p95 : NaN }),
    },
  };
}

/** Whole-corpus encoding through the unchanged compiler, twice, plus the residency sum. */
async function encodeCorpus(scene) {
  const runs = [];
  for (let repeat = 0; repeat < PROTOCOL.repeats; repeat += 1) runs.push(await measureEncoding(scene, compileSceneToGltf));
  const first = runs[0];
  return {
    compileMs: runs.map((run) => round(run.compileMs, 1)),
    documentBytes: first.documentBytes, binaryBytes: first.binaryBytes, coarseBytes: first.coarseBytes, encodedBytes: first.encodedBytes,
    documentSha256: first.documentSha256, binarySha256: first.binarySha256,
    deterministic: runs.every((run) => run.documentSha256 === first.documentSha256 && run.binarySha256 === first.binarySha256),
  };
}

function partName(prototypeId) {
  return prototypeId.split(":").at(-1);
}

/** Arm 1: one retessellation at a declared tolerance pair, measured per part. */
function retessellationArm(pair, referenceMeshes, faces) {
  const [linearTolerance, angularTolerance] = pair;
  const run = tessellate(`arm1-${linearTolerance}-${angularTolerance}`, linearTolerance, angularTolerance);
  const thresholds = thresholdsFor(linearTolerance, angularTolerance);
  const parts = {};
  for (const [prototypeId, mesh] of extractMeshes(run.scene)) {
    const part = partName(prototypeId);
    const measures = measurePart(mesh, referenceMeshes.get(prototypeId), faces[prototypeId].faces, angularTolerance);
    const identity = referenceIdentity(mesh);
    measures.measured["identity-conflicts"] = identity.orphan;
    const verdict = evaluateThresholds(thresholds, measures.measured);
    parts[part] = { ...measures, identity: { ambiguous: identity.ambiguous, orphan: identity.orphan, exactByConstruction: true }, checks: verdict.checks, pass: verdict.allPass };
  }
  return {
    arm: "occt-retessellation", label: `occt-${linearTolerance}-${angularTolerance}`, options: { linearTolerance, angularTolerance },
    thresholds, adapterMs: run.adapterMs, sceneBytes: run.sceneBytes, sceneSha256: run.sceneSha256, deterministic: run.deterministic,
    parts, scene: run.scene,
  };
}

/** Arm 2: one meshoptimizer method at one target error over the default adapter mesh. */
async function simplificationArm(method, targetError, inputMeshes, inputScene, referenceMeshes, faces) {
  const thresholds = thresholdsFor(targetError, undefined);
  const parts = {};
  const replacements = new Map();
  let deterministic = true;
  for (const [prototypeId, mesh] of inputMeshes) {
    const reduce = () => (method === "per-face-locked"
      ? simplifyPerFaceLocked(mesh, targetError)
      : simplifyWholeShape(mesh, targetError, PROTOCOL.simplification.normalWeight, { lockBoundaries: method === "whole-shape-locked" }));
    const reduced = await reduce();
    const again = await reduce();
    const digest = (r) => sha256Hex(new Uint8Array(r.indices.buffer)) + sha256Hex(new Uint8Array(r.positions.buffer));
    if (digest(reduced) !== digest(again)) deterministic = false;
    const identity = resolveFaceIdentity(reduced, faces[prototypeId].faces, PROTOCOL.identityTolerance, analyticDistance);
    const faceSourceIds = identity.faceSourceIds ?? reduced.faceSourceIds;
    const candidate = { ...reduced, faceSourceIds, edgePositions: mesh.edgePositions, edgeSegments: mesh.edgeSegments };
    const measures = measurePart(candidate, referenceMeshes.get(prototypeId), faces[prototypeId].faces, undefined);
    measures.measured["identity-conflicts"] = identity.conflicts;
    const verdict = evaluateThresholds(thresholds, measures.measured);
    const { faceErrors, ...detail } = reduced.detail;
    parts[partName(prototypeId)] = {
      ...measures, inputTriangles: reduced.inputTriangles, reduction: round(1 - reduced.outputTriangles / reduced.inputTriangles, 4),
      detail: { ...detail, identityResolvedByAnalyticFace: identity.resolved, faceErrorMax: faceErrors ? round(Math.max(...faceErrors), 4) : undefined },
      edgeStream: "unchanged adapter edges over a simplified surface", checks: verdict.checks, pass: verdict.allPass,
    };
    replacements.set(prototypeId, candidate);
  }
  const label = `meshopt-${method}-${targetError}`;
  return {
    arm: "meshoptimizer-simplification", label, options: { method, targetError, normalWeight: PROTOCOL.simplification.normalWeight, input: PROTOCOL.simplificationInput },
    thresholds, deterministic, parts, scene: replaceSurfaces(inputScene, replacements),
  };
}

function stripScene(arm) {
  const { scene: _scene, ...rest } = arm;
  return rest;
}

/** Per part: the passing arm with the fewest triangles, else full detail. */
function selectPerPart(arms, partNames) {
  const selected = {};
  for (const part of partNames) {
    const passing = arms.filter((arm) => arm.parts[part]?.pass).map((arm) => ({ label: arm.label, arm: arm.arm, triangles: arm.parts[part].triangles }));
    passing.sort((a, b) => a.triangles - b.triangles || a.label.localeCompare(b.label));
    const tiedLabels = passing.filter((p) => p.triangles === passing[0]?.triangles).map((p) => p.label);
    selected[part] = passing.length > 0
      ? { ...passing[0], tie: tiedLabels.length > 1, tiedLabels, passingArms: passing.map((p) => p.label) }
      : { label: "full-detail", arm: "reference", tie: false, tiedLabels: [], passingArms: [] };
  }
  return selected;
}

async function main() {
  await mkdir(workDirectory, { recursive: true });
  await mkdir(artifactDirectory, { recursive: true });
  const sourceBytes = await readFile(sourcePath);
  const faces = await describeFaces();
  const reference = tessellate("reference", PROTOCOL.reference.linearTolerance, PROTOCOL.reference.angularTolerance);
  const referenceMeshes = extractMeshes(reference.scene);
  const partNames = [...referenceMeshes.keys()].map(partName);
  const referenceParts = {};
  for (const [prototypeId, mesh] of referenceMeshes) {
    const identity = referenceIdentity(mesh);
    const shape = residencyShapeOf(mesh);
    referenceParts[partName(prototypeId)] = {
      prototypeId, triangles: mesh.indices.length / 3, edgeSegments: mesh.edgeSegments.length, faces: mesh.faceCount,
      topology: topologySummary(weldMesh(mesh.positions, mesh.indices).positions, weldMesh(mesh.positions, mesh.indices).indices),
      identity, residency: batchResidencyCost(shape),
    };
  }
  const referenceEncoding = await encodeCorpus(reference.scene);
  console.log(`[lod-method] reference ${reference.deterministic ? "deterministic" : "NON-DETERMINISTIC"} ${round(elapsedMs() / 1000, 1)} s`);

  const arms = [];
  for (const pair of PROTOCOL.retessellation) {
    const arm = retessellationArm(pair, referenceMeshes, faces);
    arm.encoding = await encodeCorpus(arm.scene);
    arms.push(arm);
    console.log(`[lod-method] ${arm.label} ${Object.values(arm.parts).filter((p) => p.pass).length}/${partNames.length} pass ${round(elapsedMs() / 1000, 1)} s`);
  }
  const input = tessellate("arm2-input", PROTOCOL.simplificationInput.linearTolerance, PROTOCOL.simplificationInput.angularTolerance);
  const inputMeshes = extractMeshes(input.scene);
  for (const method of ["per-face-locked", "whole-shape-locked", "whole-shape-unlocked"]) {
    for (const targetError of PROTOCOL.simplification.targetErrors) {
      const arm = await simplificationArm(method, targetError, inputMeshes, input.scene, referenceMeshes, faces);
      arm.encoding = await encodeCorpus(arm.scene);
      arms.push(arm);
      console.log(`[lod-method] ${arm.label} ${Object.values(arm.parts).filter((p) => p.pass).length}/${partNames.length} pass ${round(elapsedMs() / 1000, 1)} s`);
    }
  }
  const selected = selectPerPart(arms, partNames);
  const report = reference.report;
  const record = {
    schemaVersion: "naru.lod-method-comparison.1",
    mode: "offline-tolerance-and-simplification-comparison",
    recordedAt: new Date().toISOString(),
    elapsedSeconds: round(elapsedMs() / 1000, 1),
    source: { path: relative(repositoryRoot, sourcePath).replaceAll("\\", "/"), sha256: sha256Hex(sourceBytes), bytes: sourceBytes.length, units: "mm", format: report.source.format },
    toolchain: { adapter: reference.scene.revision.adapter, occt: report.toolchain, compiler: "0.0.0", meshoptimizer: meshoptimizerVersion, node: process.version },
    host: { platform: process.platform, architecture: process.arch, node: process.version, cpuCount: availableParallelism(), cpuModel: cpus()[0].model, totalMemoryBytes: totalmem() },
    protocol: PROTOCOL,
    thresholdRule: "thresholdsFor(t, angular): sampled two-sided p95 <= t, max <= 2t, analytic max <= t, edge p95 <= t, section p95 <= t, silhouette ratio <= 0.005, identity conflicts 0, Euler and boundary deltas 0, normal p95 <= 2*angular (retessellation only); t = linear tolerance (arm 1) or target error (arm 2). Predeclared before any reduction target was chosen; sampled distances are sampled, not certified.",
    identityRule: "Occurrence identity is the instance id, independent of every representation index; face identity is source:<prototype>:face:<i>; a simplified triangle keeps its face id when all three welded vertices agree, otherwise it is assigned to the nearest analytic face within identityTolerance, and a triangle with no such face is an identity conflict.",
    reference: { options: PROTOCOL.reference, adapterMs: reference.adapterMs, sceneBytes: reference.sceneBytes, sceneSha256: reference.sceneSha256, deterministic: reference.deterministic, encoding: referenceEncoding, parts: referenceParts },
    simplificationInput: { options: PROTOCOL.simplificationInput, adapterMs: input.adapterMs, sceneSha256: input.sceneSha256, deterministic: input.deterministic },
    arms: arms.map(stripScene),
    selected,
  };
  const json = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(resolve(artifactDirectory, "lod-method-comparison.json"), json);
  console.log(`[lod-method] wrote ${json.length} B in ${record.elapsedSeconds} s`);
}

await main();
