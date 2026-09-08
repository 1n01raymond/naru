/**
 * Validates the committed ADR-0025 gate-1 record (issue #76): compiling
 * `fixtures/step/lod-corpus.step` twice with `--reduced-lod 0.001` yields
 * byte-identical packages under `naru.progressive-package.1`, the `reduced`
 * level is emitted for the two admitted parts and withheld for the two the
 * checks refuse, and the Khronos validator reports zero errors.
 *
 * The validator re-hashes the committed package beside the record and parses
 * its document, so the pins below are checked against bytes, not against the
 * recorder's own claims. Digests are HOST-LOCAL (the OCCT adapter's output
 * differs across hosts by a few bytes) and must never be retargeted to make a
 * re-record pass; a changed outcome, count, or deviation is a finding to
 * report, not a pin to move.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const recordDirectory = resolve(repositoryRoot, "artifacts/lod/reduced-level");
const recordPath = resolve(recordDirectory, "reduced-lod-evidence.json");

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function assert(condition, message) {
  if (!condition) {
    throw new TypeError(`[reduced-lod] ${message}`);
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const record = JSON.parse(readFileSync(recordPath, "utf8"));

const SOURCE = {
  path: "fixtures/step/lod-corpus.step",
  bytes: 114233,
  sha256: "02c78ff73b23eb0ceab0c73cf0af43a75bdf1877db0d2425131b30766450129c",
};
const OPTIONS = {
  reducedLod: { method: "meshoptimizer-whole-shape-unlocked", maxDeviationMeters: 0.001 },
  progressiveRepresentation: "prototype-aabb-reduced-v1",
};
const PROGRESSIVE_SCHEMA = "naru.progressive-package.1";
// Host-local package identity (Windows, Node 22, OCCT adapter of this host).
// Do not retarget; a differing digest on another host is a determinism
// finding to record beside this one, not a pin to move.
const EXPECTED_PACKAGE_DIGEST = "de1e6bc0df2cf6cecf91cf0068c7930602da6e0574a9480c8f3d0b59104c0e19";
const EXPECTED_FILES = {
  "scene.gltf": { bytes: 101850, sha256: "bbeb7e7ff2a3034ca6c8a7980386aca353d378fef7d3c39276d0a2408afa1032" },
  "scene.bin": { bytes: 578988, sha256: "605a834d17258bf2bbd65e8d8dd157c149653ff4c6c00b67814825b88708affb" },
  "coarse.bin": { bytes: 3648, sha256: "4ed33c1be1ddeea9ffcdbe38155b054f2a2fe63b6bbfcb7703799df496cb3cfa" },
  "build-report.json": { bytes: 4116, sha256: "960a86661763c02466f858e3db76888f9ce652cea6baa5aeb12884acb917c695" },
  "adapter-report.json": { bytes: 1501, sha256: "cee2ce28e76650997e746d2809d3f1904f2e52fff1e5bf5e6da508b14610eed2" },
};
const EXPECTED_TARGET_CHUNKS = [
  { id: "target:0000:prototype:part:curved-shell", byteLength: 319900, triangles: 3623 },
  { id: "target:0001:prototype:part:thin-plate-holes", byteLength: 153208, triangles: 1712 },
  { id: "target:0002:prototype:part:fillet-bracket", byteLength: 70892, triangles: 784 },
  { id: "target:0003:prototype:part:planar-control", byteLength: 3352, triangles: 28 },
];
const EXPECTED_REDUCED_CHUNKS = [
  { id: "reduced:0000:prototype:part:thin-plate-holes", byteLength: 19992, triangles: 310 },
  { id: "reduced:0001:prototype:part:fillet-bracket", byteLength: 11644, triangles: 162 },
];
const EXPECTED_PROTOTYPES = {
  "prototype:part:curved-shell": { outcome: "retained", reason: "checks-failed", inputTriangles: 3623, outputTriangles: 0 },
  "prototype:part:fillet-bracket": { outcome: "reduced", inputTriangles: 784, outputTriangles: 162 },
  "prototype:part:planar-control": { outcome: "retained", reason: "no-reduction", inputTriangles: 28, outputTriangles: 0 },
  "prototype:part:thin-plate-holes": { outcome: "reduced", inputTriangles: 1712, outputTriangles: 310 },
};
const EXPECTED_COUNTS = {
  prototypeCount: 5,
  compiledPrototypeCount: 4,
  triangleCount: 6147,
  edgeSegmentCount: 217,
  targetChunkCount: 4,
  reducedChunkCount: 2,
  reducedPrototypeCount: 2,
  reducedTriangleCount: 472,
};

assert(record.schemaVersion === "naru.reduced-lod-evidence.1", "unexpected schemaVersion");
assert(record.mode === "fresh-process-double-compile-reduced-level", "unexpected mode");
assert(record.adr === "docs/adr/0025-shape-preserving-lod-representation.md", "record must cite ADR-0025");
assert(JSON.stringify(record.source) === JSON.stringify(SOURCE), "source path/bytes/sha256 changed");
assert(JSON.stringify(record.options) === JSON.stringify(OPTIONS), "compile options changed");
assert(record.toolchain?.meshoptimizer === "1.2.0", "meshoptimizer version changed");
assert(typeof record.toolchain?.gltfValidator === "string", "gltfValidator version missing");

const sourceBytes = readFileSync(resolve(repositoryRoot, SOURCE.path));
assert(sourceBytes.byteLength === SOURCE.bytes && sha256(sourceBytes) === SOURCE.sha256,
  "fixtures/step/lod-corpus.step does not match the recorded source");

assert(record.determinism?.repeats === 2 && record.determinism.identical === true,
  "determinism requires two identical fresh-process compiles");
assert(record.packageDigest === EXPECTED_PACKAGE_DIGEST, "packageDigest changed (host-local; do not retarget)");
for (const [name, expected] of Object.entries(EXPECTED_FILES)) {
  const recorded = record.determinism.files?.[name];
  assert(recorded?.bytes === expected.bytes && recorded?.sha256 === expected.sha256,
    `determinism.files["${name}"] changed (host-local; do not retarget)`);
  const bytes = readFileSync(resolve(recordDirectory, "package", name));
  assert(bytes.byteLength === expected.bytes && sha256(bytes) === expected.sha256,
    `committed package/${name} does not match the record`);
}
assert(record.gltfValidation?.errors === 0, "Khronos glTF validation must report zero errors");

const document = JSON.parse(readFileSync(resolve(recordDirectory, "package/scene.gltf"), "utf8"));
const progressive = document.extras?.naru?.progressive;
assert(progressive?.schemaVersion === PROGRESSIVE_SCHEMA, `document must carry ${PROGRESSIVE_SCHEMA}`);
assert(document.extras?.madi?.progressive === undefined, "document must not carry extras.madi.progressive");
assert(progressive.strategy === OPTIONS.progressiveRepresentation, "progressive strategy changed");
assert(JSON.stringify(progressive.reducedLod) === JSON.stringify(OPTIONS.reducedLod),
  "progressive.reducedLod must repeat the compile options");
assert(record.progressive?.schemaVersion === PROGRESSIVE_SCHEMA && record.progressive.strategy === progressive.strategy,
  "record.progressive disagrees with the document");

const trianglesOf = (chunk) => chunk.meshIndexes.reduce((sum, meshIndex) => sum + document.meshes[meshIndex].primitives
  .filter((primitive) => (primitive.mode ?? 4) === 4)
  .reduce((count, primitive) => count + document.accessors[primitive.indices].count / 3, 0), 0);
const checkChunks = (level, expectedList) => {
  const documentChunks = progressive[`${level}Chunks`];
  const recordChunks = record.progressive[`${level}Chunks`];
  assert(Array.isArray(documentChunks) && documentChunks.length === expectedList.length,
    `document declares ${documentChunks?.length} ${level} chunks, expected ${expectedList.length}`);
  assert(Array.isArray(recordChunks) && recordChunks.length === expectedList.length,
    `record lists ${recordChunks?.length} ${level} chunks, expected ${expectedList.length}`);
  expectedList.forEach((expected, index) => {
    const chunk = documentChunks[index];
    const recorded = recordChunks[index];
    assert(chunk.id === expected.id && chunk.byteLength === expected.byteLength,
      `${level} chunk ${index} is ${chunk.id}/${chunk.byteLength}, expected ${expected.id}/${expected.byteLength}`);
    assert(trianglesOf(chunk) === expected.triangles, `${chunk.id} carries ${trianglesOf(chunk)} triangles, expected ${expected.triangles}`);
    assert(recorded.id === chunk.id && recorded.byteLength === chunk.byteLength && recorded.triangles === expected.triangles,
      `record.progressive.${level}Chunks[${index}] disagrees with the document`);
  });
};
checkChunks("target", EXPECTED_TARGET_CHUNKS);
checkChunks("reduced", EXPECTED_REDUCED_CHUNKS);
for (const reduced of progressive.reducedChunks) {
  const target = progressive.targetChunks.find((chunk) => chunk.prototypeId === reduced.prototypeId);
  assert(target !== undefined && reduced.byteLength < target.byteLength,
    `${reduced.id} must be smaller than its target chunk`);
}
const reducedIds = new Set(progressive.reducedChunks.map((chunk) => chunk.prototypeId));
assert(!reducedIds.has("prototype:part:curved-shell") && !reducedIds.has("prototype:part:planar-control"),
  "retained prototypes must not have a reduced chunk");

assert(Array.isArray(record.prototypes) && record.prototypes.length === Object.keys(EXPECTED_PROTOTYPES).length,
  "prototype outcome list changed");
for (const entry of record.prototypes) {
  const expected = EXPECTED_PROTOTYPES[entry.prototypeId];
  assert(expected !== undefined, `unexpected prototype ${entry.prototypeId}`);
  assert(entry.outcome === expected.outcome && entry.reason === expected.reason,
    `${entry.prototypeId} outcome changed: ${entry.outcome}/${entry.reason ?? "-"}`);
  assert(entry.inputTriangles === expected.inputTriangles && entry.outputTriangles === expected.outputTriangles,
    `${entry.prototypeId} triangle counts changed`);
  assert(Number.isFinite(entry.sampledTwoSidedP95Meters) && Number.isFinite(entry.sampledTwoSidedMaxMeters),
    `${entry.prototypeId} must carry sampled deviations`);
  assert((reducedIds.has(entry.prototypeId)) === (entry.outcome === "reduced"),
    `${entry.prototypeId} outcome disagrees with the document's reduced chunks`);
  if (entry.outcome === "reduced") {
    assert(entry.sampledTwoSidedP95Meters <= OPTIONS.reducedLod.maxDeviationMeters,
      `${entry.prototypeId} was admitted above the declared deviation`);
  }
}
assert(record.prototypes.find((entry) => entry.prototypeId === "prototype:part:curved-shell").sampledTwoSidedP95Meters
  > OPTIONS.reducedLod.maxDeviationMeters, "curved-shell must be retained because its p95 exceeds the bound");

for (const [key, value] of Object.entries(EXPECTED_COUNTS)) {
  assert(record.counts?.[key] === value, `counts.${key} is ${record.counts?.[key]}, expected ${value}`);
}
const report = JSON.parse(readFileSync(resolve(recordDirectory, "package/build-report.json"), "utf8"));
assert(report.output?.packageDigest === EXPECTED_PACKAGE_DIGEST, "committed build-report digest disagrees with the record");
assert(JSON.stringify(report.reducedLod) === JSON.stringify(record.prototypes), "record.prototypes must equal the build report's reducedLod");

console.log(`[reduced-lod] ${progressive.reducedChunks.length} reduced / ${progressive.targetChunks.length} target chunks, `
  + `package ${record.packageDigest.slice(0, 12)} identical over ${record.determinism.repeats} runs, 0 glTF errors`);
