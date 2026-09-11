/**
 * Records ADR-0025 gate 1: compiling `fixtures/step/lod-corpus.step` twice with
 * `--reduced-lod <meters>` yields byte-identical packages under
 * `naru.progressive-package.2`, a `reduced` level is emitted for the admitted
 * parts and withheld for the ones the #126 checks refuse, and the Khronos glTF
 * validator reports zero errors. The first run's package is copied beside the
 * record so the validator can re-hash committed bytes.
 *
 * Usage: node scripts/record-reduced-lod-evidence.mjs
 *          [--work output/reduced-lod] [--output artifacts/lod/reduced-level]
 *          [--python <cadquery python>] [--deviation 0.001]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateBytes, version as gltfValidatorVersion } from "gltf-validator";

const repositoryRoot = resolve(import.meta.dirname, "..");
const argument = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};
const workDirectory = resolve(repositoryRoot, argument("--work", "output/reduced-lod"));
const artifactDirectory = resolve(repositoryRoot, argument("--output", "artifacts/lod/reduced-level"));
const pythonExecutable = argument(
  "--python",
  process.env.NARU_PYTHON ?? resolve(repositoryRoot, "output/cadquery-venv/Scripts/python.exe"),
);
const maxDeviationMeters = Number(argument("--deviation", "0.001"));
const sourcePath = resolve(repositoryRoot, "fixtures/step/lod-corpus.step");
const cliPath = resolve(repositoryRoot, "packages/compiler/dist/cli.js");
const PACKAGE_FILES = ["scene.gltf", "scene.bin", "coarse.bin", "build-report.json", "adapter-report.json"];
const REPEATS = 2;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const started = process.hrtime.bigint();

function compile(run) {
  const output = resolve(workDirectory, `run${run}`);
  rmSync(output, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [cliPath, "compile", sourcePath, "--output", output, "--python", pythonExecutable,
      "--reduced-lod", String(maxDeviationMeters)],
    { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`run ${run} failed (${result.status}): ${result.stderr}`);
  }
  const files = Object.fromEntries(PACKAGE_FILES.map((name) => {
    const bytes = readFileSync(resolve(output, name));
    return [name, { bytes: bytes.byteLength, sha256: sha256(bytes) }];
  }));
  return { output, files };
}

mkdirSync(workDirectory, { recursive: true });
const runs = [];
for (let run = 1; run <= REPEATS; run += 1) {
  runs.push(compile(run));
  console.log(`[reduced-lod] run ${run} compiled`);
}
const identical = runs.every((run) => JSON.stringify(run.files) === JSON.stringify(runs[0].files));
if (!identical) {
  throw new Error(`the ${REPEATS} runs differ: ${JSON.stringify(runs.map((run) => run.files))}`);
}

const first = runs[0].output;
const document = JSON.parse(readFileSync(resolve(first, "scene.gltf"), "utf8"));
const report = JSON.parse(readFileSync(resolve(first, "build-report.json"), "utf8"));
const validation = await validateBytes(readFileSync(resolve(first, "scene.gltf")), {
  uri: "scene.gltf",
  format: "gltf",
  writeTimestamp: false,
  maxIssues: 100,
  externalResourceFunction: async (uri) => {
    if (uri === "scene.bin" || uri === "coarse.bin") return readFileSync(resolve(first, uri));
    throw new TypeError(`Unexpected package resource ${uri}.`);
  },
});
if (validation.issues.numErrors !== 0) {
  throw new Error(`glTF validation failed: ${JSON.stringify(validation.issues.messages)}`);
}

const progressive = document.extras?.naru?.progressive;
if (progressive?.schemaVersion !== "naru.progressive-package.2" || document.extras?.madi?.progressive) {
  throw new Error("the package must carry extras.naru.progressive alone.");
}
const chunkSummary = (chunk) => ({
  id: chunk.id,
  prototypeId: chunk.prototypeId,
  byteLength: chunk.byteLength,
  // Recorded per chunk, not once for the package: a chunk is the finest range
  // a viewer can fetch, so its own declared deviation is what a level decision
  // divides by the frame scale.
  ...(chunk.maxDeviationMeters === undefined ? {} : { maxDeviationMeters: chunk.maxDeviationMeters }),
  triangles: chunk.meshIndexes.reduce((sum, meshIndex) => sum + document.meshes[meshIndex].primitives
    .filter((primitive) => (primitive.mode ?? 4) === 4)
    .reduce((count, primitive) => count + document.accessors[primitive.indices].count / 3, 0), 0),
});

const sourceBytes = readFileSync(sourcePath);
const record = {
  schemaVersion: "naru.reduced-lod-evidence.1",
  mode: "fresh-process-double-compile-reduced-level",
  recordedAt: new Date().toISOString(),
  adr: "docs/adr/0025-shape-preserving-lod-representation.md",
  source: { path: "fixtures/step/lod-corpus.step", bytes: sourceBytes.byteLength, sha256: sha256(sourceBytes) },
  options: { reducedLod: report.options.reducedLod, progressiveRepresentation: report.options.progressiveRepresentation },
  toolchain: { compiler: report.compiler, meshoptimizer: "1.2.0", gltfValidator: gltfValidatorVersion(), node: process.version, platform: process.platform },
  determinism: { repeats: REPEATS, identical, files: runs[0].files },
  packageDigest: report.output.packageDigest,
  gltfValidation: { errors: validation.issues.numErrors, warnings: validation.issues.numWarnings },
  progressive: {
    schemaVersion: progressive.schemaVersion,
    strategy: progressive.strategy,
    reducedLod: progressive.reducedLod,
    targetChunks: progressive.targetChunks.map(chunkSummary),
    reducedChunks: progressive.reducedChunks.map(chunkSummary),
  },
  counts: report.counts,
  prototypes: report.reducedLod,
  elapsedSeconds: Number((Number(process.hrtime.bigint() - started) / 1e9).toFixed(1)),
};

mkdirSync(resolve(artifactDirectory, "package"), { recursive: true });
for (const name of PACKAGE_FILES) {
  copyFileSync(resolve(first, name), resolve(artifactDirectory, "package", name));
}
writeFileSync(resolve(artifactDirectory, "reduced-lod-evidence.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(`[reduced-lod] package ${record.packageDigest.slice(0, 12)} identical over ${REPEATS} runs; `
  + `${record.progressive.reducedChunks.length} reduced chunks; ${record.elapsedSeconds}s`);
