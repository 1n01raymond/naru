/**
 * Records the ADR-0019 gate evidence for one IFC federation: fresh-process
 * changed-discipline rebuilds through the document-artifact transport (one
 * document edited, every other document's artifact warm), each paired with a
 * clean rebuild of the same changed federation with no cache directory at all,
 * both decomposed into adapter and compiler stages under the predeclared-sample
 * protocol of artifacts/cache/sixty5.
 *
 * One session answers the ADR's gates together: gate 1 (every package resource
 * of the transport rebuild byte-identical to the clean rebuild's, under the
 * closed report exclusion list), gate 2 (exact per-document restore decisions),
 * gate 3 (the adapter's artifact load and verification against one read and
 * one hash of the same stored bytes in this process), and gate 4 (the
 * transport's whole-process median against the clean median and the clean
 * samples' own spread, with peak process-tree memory no higher).
 *
 * Timing is diagnostic: the adapter writes its stage ledger to a separate file
 * only when asked (`--stage-timing`), and the compiler exposes `stages` on its
 * result only when `stageTiming: true`. No package byte, report, or cache key
 * carries a timing, so an instrumented sample produces exactly the package a
 * plain compile does (packages/compiler/test/ifc-federation.test.ts pins it).
 *
 *   node scripts/record-rebuild-stage-evidence.mjs --model digital-hub
 *   node scripts/record-rebuild-stage-evidence.mjs --model sixty5
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, totalmem } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import {
  processTreeSampleMethod,
  startProcessTreeSampler,
} from "./lib/process-tree-sampler.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) throw new TypeError(`[rebuild-stages] ${message}`);
}

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  assert(value && !value.startsWith("--"), `${name} requires a value.`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portable(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

const round = (value) => Number(value.toFixed(1));

/**
 * The same one-entity edit per model as artifacts/cache/payload-reuse, so this
 * record measures exactly the rebuild that record timed as a whole. `gate0`
 * quotes the medians of the gate 0 record this one succeeds
 * (naru.rebuild-stage-evidence.1, commit 69d67e5), the verification baseline
 * ADR-0019 gate 3 names; they were measured in another session and are quoted
 * for reference only, never compared under the gate 4 rule.
 */
const models = {
  "digital-hub": {
    datasetId: "ifc-bench-digital-hub",
    uriPrefix: "projects/digital_hub",
    documents: [
      ["architecture", "arc.ifc"],
      ["heating", "heating.ifc"],
      ["plumbing", "plumbing.ifc"],
      ["ventilation", "ventilation.ifc"],
    ],
    compactJson: false,
    edit: {
      discipline: "architecture",
      entity: "#823= IFCEXTRUDEDAREASOLID(#817,#822,#20,7.77);",
      replacement: "#823= IFCEXTRUDEDAREASOLID(#817,#822,#20,9.77);",
      description: "Extrusion depth 7.77 -> 9.77 of #823, referenced only by #824 (IfcShapeRepresentation 'Body').",
    },
    gate0: {
      processMilliseconds: 19872.9,
      unchangedArtifactLoadMilliseconds: 899.3,
      unchangedArtifactVerifyMilliseconds: 4434.2,
      unchangedArtifactBytes: 14018011,
    },
  },
  sixty5: {
    datasetId: "ifc-bench-sixty5",
    uriPrefix: "projects/sixty5",
    documents: [
      ["architecture", "arc.ifc"],
      ["electrical", "electrical.ifc"],
      ["facade", "facade.ifc"],
      ["kitchen", "kitchen.ifc"],
      ["plumbing", "plumbing.ifc"],
      ["structure", "str.ifc"],
      ["ventilation", "ventilation.ifc"],
    ],
    compactJson: true,
    edit: {
      discipline: "structure",
      entity: "#890= IFCEXTRUDEDAREASOLID(#886,#889,#19,250.);",
      replacement: "#890= IFCEXTRUDEDAREASOLID(#886,#889,#19,350.);",
      description: "Extrusion depth 250 -> 350 of #890, referenced only by #891 (IfcShapeRepresentation 'Body').",
    },
    gate0: {
      processMilliseconds: 126458.5,
      unchangedArtifactLoadMilliseconds: 8310.4,
      unchangedArtifactVerifyMilliseconds: 34204.2,
      unchangedArtifactBytes: 101185491,
    },
  },
};

/**
 * ADR-0018's closed report exclusion list, carried over as ADR-0019 gate 1
 * requires (no additions): the adapter report names which documents it
 * restored, and the clean arm restores none. `build-report.json:compiledPayloadCache`
 * left with the payload tier and is no longer a report field.
 */
const reportExclusions = ["adapter-report.json:documentArtifactCache"];

const modelId = argumentValue("--model", "digital-hub");
const model = models[modelId];
assert(model, `--model must be one of ${Object.keys(models).join(", ")}.`);
const sampleCount = Number(argumentValue("--samples", "5"));
assert(Number.isSafeInteger(sampleCount) && sampleCount >= 1, "--samples must be a positive integer.");
const maximumAttempts = 3;
const threads = Number(argumentValue("--threads", "6"));
assert(Number.isSafeInteger(threads) && threads >= 1, "--threads must be a positive integer.");
const artifactDirectory = resolve(repositoryRoot, argumentValue("--output", "artifacts/cache/rebuild-stages"));
const workingRoot = resolve(repositoryRoot, "output/rebuild-stages", modelId);
const cacheDirectory = join(workingRoot, "cache");
const documentArtifactDirectory = join(cacheDirectory, "ifc-documents");
const changedDirectory = join(workingRoot, "changed");

const manifestPath = resolve(repositoryRoot, "fixtures/external/manifest.json");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const dataset = manifest.datasets.find(({ id }) => id === model.datasetId);
assert(dataset, `Unknown external fixture dataset ${model.datasetId}.`);

const documents = model.documents.map(([discipline, fileName]) => ({
  discipline,
  fileName,
  sourcePath: `output/external-fixtures/${model.datasetId}/${fileName}`,
  uriHint: `${model.uriPrefix}/${fileName}`,
}));
const sourceIdentities = [];
for (const document of documents) {
  const bytes = await readFile(resolve(repositoryRoot, document.sourcePath));
  const digest = sha256(bytes);
  assert(
    dataset.assets.some(({ sha256: assetDigest }) => assetDigest === digest),
    `${document.fileName} is not a pinned asset of ${model.datasetId}.`,
  );
  sourceIdentities.push({ discipline: document.discipline, uriHint: document.uriHint, bytes: bytes.byteLength, sha256: digest });
}

const changedDocument = documents.find(({ discipline }) => discipline === model.edit.discipline);
assert(changedDocument, "The edited discipline is not part of the federation.");
const unchangedDisciplines = documents.map((d) => d.discipline).filter((d) => d !== changedDocument.discipline);
await mkdir(changedDirectory, { recursive: true });
const originalText = (await readFile(resolve(repositoryRoot, changedDocument.sourcePath))).toString("latin1");
assert(originalText.split(model.edit.entity).length === 2, `${changedDocument.fileName} must contain the edited entity exactly once.`);
const changedBytes = Buffer.from(originalText.replace(model.edit.entity, model.edit.replacement), "latin1");
const changedPath = join(changedDirectory, changedDocument.fileName);
await writeFile(changedPath, changedBytes);
const original = sourceIdentities.find((s) => s.discipline === changedDocument.discipline);
const changedIdentity = {
  discipline: changedDocument.discipline,
  fileName: changedDocument.fileName,
  uriHint: changedDocument.uriHint,
  edit: model.edit,
  originalBytes: original.bytes,
  originalSha256: original.sha256,
  changedBytes: changedBytes.byteLength,
  changedSha256: sha256(changedBytes),
};

const ifcPython = process.env.NARU_IFC_PYTHON ?? process.env.NARU_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const adapterScript = resolve(repositoryRoot, "native/adapter-ifc/tools/extract_federation_scene_ir.py");
const adapterProbe = spawnSync(ifcPython, [adapterScript, "--identity"], { encoding: "utf8", windowsHide: true });
assert(adapterProbe.status === 0, `IFC adapter --identity failed: ${adapterProbe.stderr}`);
const adapterIdentity = JSON.parse(adapterProbe.stdout);

function gitOutput(...args) {
  const probe = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
  assert(probe.status === 0, `git ${args.join(" ")} failed: ${probe.stderr}`);
  return probe.stdout.trim();
}

/** A sample config; `withCache` off is the clean arm: no package cache, no document artifacts, nothing to restore. */
async function writeConfig(name, documentSet, withCache) {
  const configPath = join(workingRoot, `config-${name}.json`);
  const selected = documents.map((document) => ({
    discipline: document.discipline,
    sourcePath: documentSet === "changed" && document.discipline === changedDocument.discipline ? portable(changedPath) : document.sourcePath,
    uriHint: document.uriHint,
  }));
  const config = {
    ...(withCache ? { cacheDirectory: portable(cacheDirectory) } : {}),
    threads,
    compactJson: model.compactJson,
    spatialIndex: true,
    relocateHierarchyNodes: true,
    pythonExecutable: ifcPython,
    documents: selected,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

async function listNames(directory) {
  try {
    return (await readdir(directory)).sort((a, b) => a.localeCompare(b, "en"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function streamDigest(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Every file a sample wrote: byte digest, plus a digest outside the excluded keys for the reports the exclusion list names. */
async function describeOutput(directory) {
  const files = {};
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    assert(entry.isFile(), `unexpected non-file output ${entry.name}`);
    const path = join(directory, entry.name);
    const file = await streamDigest(path);
    const excludedKeys = reportExclusions.filter((e) => e.startsWith(`${entry.name}:`)).map((e) => e.slice(entry.name.length + 1));
    if (excludedKeys.length > 0) {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      for (const key of excludedKeys) delete parsed[key];
      file.excludedKeys = excludedKeys;
      file.semanticSha256 = sha256(canonicalJson(parsed));
    }
    files[entry.name] = file;
  }
  return files;
}

const sampler = startProcessTreeSampler({ intervalMilliseconds: 500 });

/** One fresh node process; returns the sample runner's result plus process wall, peak memory, and the output file digests. */
async function runSample(phase, index, configPath, extraArguments) {
  const label = `${phase}#${index}`;
  const outputDirectory = join(workingRoot, "sample");
  const resultPath = join(workingRoot, "sample-result.json");
  await rm(outputDirectory, { recursive: true, force: true });
  await rm(resultPath, { force: true });
  await mkdir(outputDirectory, { recursive: true });
  console.log(`[rebuild-stages] ${label} ...`);
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [resolve(repositoryRoot, "scripts/lib/ifc-cache-sample.mjs"), "--config", configPath, "--result", resultPath, "--output", portable(outputDirectory), "--phase", phase, ...extraArguments],
    { cwd: repositoryRoot, stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
  );
  const observation = sampler.observe(child.pid);
  const exitCode = await new Promise((settle) => child.on("exit", (code) => settle(code ?? -1)));
  const processMilliseconds = round(performance.now() - startedAt);
  const memory = observation.close();
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  const outputFiles = exitCode === 0 && !extraArguments.includes("--adapter-only") ? await describeOutput(outputDirectory) : undefined;
  await rm(outputDirectory, { recursive: true, force: true });
  console.log(`[rebuild-stages] ${label}: exit ${exitCode}, ${(processMilliseconds / 1000).toFixed(1)} s, peak tree ${(memory.peakWorkingSetBytes / 1e9).toFixed(2)} GB`);
  return { phase, index, exitCode, processMilliseconds, memory, ...(outputFiles ? { outputFiles } : {}), ...result };
}

/** Reset the cache to "every unchanged artifact warm, nothing else": no package entry, no changed-document artifact. */
async function resetCacheState(originalArtifacts) {
  for (const name of await listNames(cacheDirectory)) {
    if (name !== "ifc-documents") await rm(join(cacheDirectory, name), { recursive: true, force: true });
  }
  for (const name of await listNames(documentArtifactDirectory)) {
    if (!originalArtifacts.includes(name)) await rm(join(documentArtifactDirectory, name), { force: true });
  }
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Why a transport sample is not the rebuild the protocol requires; empty when it is. */
function transportSampleFailures(sample, packageDigest) {
  const failures = [];
  if (sample.exitCode !== 0) failures.push(`exit ${sample.exitCode}: ${sample.failure?.message ?? "unknown"}`);
  if (failures.length > 0) return failures;
  if (sample.cache?.status !== "miss") failures.push(`package cache status ${sample.cache?.status}, expected miss`);
  const artifacts = sample.documentArtifactCache ?? {};
  if (!sameSet(artifacts.misses ?? [], [changedDocument.discipline])) failures.push(`document artifact misses ${JSON.stringify(artifacts.misses)}, expected [${changedDocument.discipline}]`);
  if (!sameSet(artifacts.hits ?? [], unchangedDisciplines)) failures.push(`document artifact hits ${JSON.stringify(artifacts.hits)}, expected the unchanged documents`);
  if (sample.warnings.length > 0) failures.push(`warnings: ${sample.warnings.join(" | ")}`);
  if (!sample.stages) failures.push("the result carries no stage ledger");
  if (packageDigest && sample.report.output.packageDigest !== packageDigest) failures.push(`packageDigest ${sample.report.output.packageDigest} != ${packageDigest}`);
  return failures;
}

/** Why a clean sample is not the compile the protocol requires; byte identity to the transport arm is gate 1's verdict, not a validity rule. */
function cleanSampleFailures(sample, cleanPackageDigest) {
  const failures = [];
  if (sample.exitCode !== 0) failures.push(`exit ${sample.exitCode}: ${sample.failure?.message ?? "unknown"}`);
  if (failures.length > 0) return failures;
  if (sample.cache?.status !== "disabled") failures.push(`package cache status ${sample.cache?.status}, expected disabled`);
  const artifacts = sample.documentArtifactCache ?? {};
  if (artifacts.status !== "disabled" || (artifacts.hits ?? []).length > 0 || (artifacts.misses ?? []).length > 0) failures.push(`document artifact cache ${JSON.stringify(artifacts)}, expected disabled with no decisions`);
  if (sample.warnings.length > 0) failures.push(`warnings: ${sample.warnings.join(" | ")}`);
  if (!sample.stages) failures.push("the result carries no stage ledger");
  if (cleanPackageDigest && sample.report.output.packageDigest !== cleanPackageDigest) failures.push(`packageDigest ${sample.report.output.packageDigest} != ${cleanPackageDigest}`);
  return failures;
}

// ---------------------------------------------------------------------------
// Warm-up: extract the ORIGINAL federation once (adapter only, fresh process)
// so every unchanged document's artifact is warm before the first sample.
// ---------------------------------------------------------------------------
await rm(cacheDirectory, { recursive: true, force: true });
await mkdir(workingRoot, { recursive: true });
const originalConfig = await writeConfig("original", "original", true);
const changedConfig = await writeConfig("changed", "changed", true);
const cleanConfig = await writeConfig("clean", "changed", false);
const warmUpSample = await runSample("warm-up-original-extraction", 1, originalConfig, ["--adapter-only"]);
assert(warmUpSample.exitCode === 0, `warm-up failed: ${warmUpSample.failure?.message ?? "unknown"}`);
assert(sameSet(warmUpSample.documentArtifactCache.misses, documents.map((d) => d.discipline)), "the warm-up must extract every document cold");
const originalArtifacts = await listNames(documentArtifactDirectory);
assert(originalArtifacts.length === documents.length, `expected ${documents.length} document artifacts after warm-up, found ${originalArtifacts.length}`);
const warmUp = {
  adapterMilliseconds: warmUpSample.adapterMilliseconds,
  processMilliseconds: warmUpSample.processMilliseconds,
  peakWorkingSetBytes: warmUpSample.memory.peakWorkingSetBytes,
  documentArtifactCache: warmUpSample.documentArtifactCache,
  artifacts: originalArtifacts.length,
};

// ---------------------------------------------------------------------------
// Samples: per index, one fresh-process transport rebuild (artifacts warm,
// package cache reset) immediately followed by one fresh-process clean rebuild
// of the same changed federation with no cache directory. Interleaving keeps
// host drift from landing on one arm only.
// ---------------------------------------------------------------------------
const samples = [];
const cleanSamples = [];
const discarded = [];
let packageDigest;
let cleanPackageDigest;
async function acceptSample(phase, index, configPath, failuresOf, prepare) {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    await prepare();
    const sample = await runSample(phase, index, configPath, ["--stage-timing"]);
    const failures = failuresOf(sample);
    if (failures.length === 0) return sample;
    console.log(`[rebuild-stages] ${phase}#${index} attempt ${attempt} discarded: ${failures.join("; ")}`);
    discarded.push({ phase, index, attempt, failures, exitCode: sample.exitCode, processMilliseconds: sample.processMilliseconds });
  }
  assert(false, `${phase} sample ${index} failed ${maximumAttempts} times`);
}
for (let index = 1; index <= sampleCount; index += 1) {
  const transport = await acceptSample("changed-rebuild", index, changedConfig, (s) => transportSampleFailures(s, packageDigest), () => resetCacheState(originalArtifacts));
  packageDigest ??= transport.report.output.packageDigest;
  samples.push(transport);
  const clean = await acceptSample("clean-rebuild", index, cleanConfig, (s) => cleanSampleFailures(s, cleanPackageDigest), async () => {});
  cleanPackageDigest ??= clean.report.output.packageDigest;
  cleanSamples.push(clean);
}
sampler.stop();

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    values,
    median: sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)],
    minimum: sorted[0],
    maximum: sorted[sorted.length - 1],
  };
}
const sum = (values) => values.reduce((total, value) => total + value, 0);
const adapterProcessKeys = ["spawnToModuleStartMilliseconds", "importMilliseconds", "importsToMainMilliseconds", "mainMilliseconds", "finishToCloseMilliseconds"];
const ledgerDocument = (sample, discipline) => sample.stages.adapter.ledger.documents.find((d) => d.discipline === discipline);
const documentAccounted = (d) => sum(Object.entries(d).filter(([k, v]) => k.endsWith("Milliseconds") && typeof v === "number").map(([, v]) => v));
const adapterAccounted = (sample) => {
  const { ledger } = sample.stages.adapter;
  return sum(ledger.documents.map(documentAccounted)) + sum(Object.values(ledger.federation)) + sum(Object.values(ledger.write));
};
const compilerStageNames = Object.keys(samples[0].stages.stages);
const compileStageNames = Object.keys(samples[0].stages.compileStages);

/** Bookkeeping identities every sample must satisfy; tolerances absorb float rounding and the gaps between timers. */
function closure(sample, arm) {
  const { stages } = sample;
  const attributed = sum(compilerStageNames.map((name) => stages.stages[name]));
  const adapter = stages.adapter;
  const adapterProcess = sum(adapterProcessKeys.map((key) => adapter[key]));
  const ledgerDocuments = adapter.ledger.documents;
  const checks = {
    compilerStagesPlusUnattributedEqualTotal: Math.abs(attributed + stages.unattributedMilliseconds - stages.totalMilliseconds) < 0.01,
    unattributedNonNegative: stages.unattributedMilliseconds >= 0,
    compileSubStagesEqualCompile: Math.abs(sum(compileStageNames.map((name) => stages.compileStages[name])) - stages.stages.compile) < 0.01,
    structureReadWithinReadSceneIr: stages.structureReadMilliseconds <= stages.stages.readSceneIr + 0.01,
    totalWithinCompileMilliseconds: stages.totalMilliseconds <= sample.compileMilliseconds + 0.1,
    adapterProcessWithinAdapterStage: adapterProcess <= stages.stages.adapter + 5,
    adapterLedgerWithinMain: adapterAccounted(sample) <= adapter.mainMilliseconds + 5,
    ledgerNamesEveryDocument: sameSet(ledgerDocuments.map((d) => d.discipline), documents.map((d) => d.discipline)),
    ...(arm === "transport"
      ? {
          changedDocumentExtracted: ledgerDocument(sample, changedDocument.discipline)?.outcome === "extracted" && ledgerDocument(sample, changedDocument.discipline)?.artifactState === "absent",
          unchangedDocumentsRestoredVerified: unchangedDisciplines.every((d) => ledgerDocument(sample, d)?.outcome === "restored" && ledgerDocument(sample, d)?.artifactState === "verified"),
        }
      : {
          everyDocumentExtractedWithoutArtifacts: ledgerDocuments.every((d) => d.outcome === "extracted" && d.artifactState === undefined),
        }),
  };
  return { ...checks, met: Object.values(checks).every(Boolean) };
}
const closures = samples.map((s) => closure(s, "transport"));
const cleanClosures = cleanSamples.map((s) => closure(s, "clean"));
assert(closures.every((c) => c.met), `transport ledger closure failed: ${JSON.stringify(closures.filter((c) => !c.met))}`);
assert(cleanClosures.every((c) => c.met), `clean ledger closure failed: ${JSON.stringify(cleanClosures.filter((c) => !c.met))}`);

// ---------------------------------------------------------------------------
// Distributions over the accepted samples of one arm (median, p95
// nearest-rank, min, max).
// ---------------------------------------------------------------------------
function distributionsOver(set) {
  const over = (pick) => distribution(set.map((s) => round(pick(s))));
  const overKeys = (keys, pick) => Object.fromEntries(keys.map((key) => [key, over((s) => pick(s)[key])]));
  const first = set[0];
  const documentKeys = (discipline) => Object.keys(ledgerDocument(first, discipline)).filter((k) => typeof ledgerDocument(first, discipline)[k] === "number");
  return {
    whole: {
      processMilliseconds: over((s) => s.processMilliseconds),
      compileMilliseconds: over((s) => s.compileMilliseconds),
      totalMilliseconds: over((s) => s.stages.totalMilliseconds),
      harnessOverheadMilliseconds: over((s) => s.processMilliseconds - s.compileMilliseconds),
      inProcessCompilerWorkMilliseconds: over((s) => s.stages.totalMilliseconds - s.stages.stages.adapter),
      peakWorkingSetBytes: over((s) => s.memory.peakWorkingSetBytes),
      peakPrivateBytes: over((s) => s.memory.peakPrivateBytes),
    },
    compilerStages: overKeys(compilerStageNames, (s) => s.stages.stages),
    unattributedMilliseconds: over((s) => s.stages.unattributedMilliseconds),
    structureReadMilliseconds: over((s) => s.stages.structureReadMilliseconds),
    compileStages: overKeys(compileStageNames, (s) => s.stages.compileStages),
    adapterProcess: overKeys(adapterProcessKeys, (s) => s.stages.adapter),
    adapterMainUnattributedMilliseconds: over((s) => s.stages.adapter.mainMilliseconds - adapterAccounted(s)),
    adapterDocuments: Object.fromEntries(
      documents.map(({ discipline }) => [
        discipline,
        {
          outcome: ledgerDocument(first, discipline).outcome,
          ...(ledgerDocument(first, discipline).artifactState ? { artifactState: ledgerDocument(first, discipline).artifactState } : {}),
          ...overKeys(documentKeys(discipline), (s) => ledgerDocument(s, discipline)),
        },
      ]),
    ),
    adapterFederation: overKeys(Object.keys(first.stages.adapter.ledger.federation), (s) => s.stages.adapter.ledger.federation),
    adapterWrite: overKeys(Object.keys(first.stages.adapter.ledger.write), (s) => s.stages.adapter.ledger.write),
  };
}
const overTransport = (pick) => distribution(samples.map((s) => round(pick(s))));
const unchangedSum = (sample, key) => sum(unchangedDisciplines.map((d) => ledgerDocument(sample, d)[key] ?? 0));
const distributions = {
  ...distributionsOver(samples),
  // ADR-0019 gate 3: what loading, verifying, and parsing every unchanged document's artifact costs now.
  unchangedArtifactLoadMilliseconds: overTransport((s) => unchangedSum(s, "artifactLoadMilliseconds")),
  unchangedArtifactVerifyMilliseconds: overTransport((s) => unchangedSum(s, "artifactVerifyMilliseconds")),
  unchangedArtifactParseMilliseconds: overTransport((s) => unchangedSum(s, "artifactParseMilliseconds")),
  unchangedArtifactBytes: unchangedSum(samples[0], "artifactBytes"),
  unchangedArtifactPayloadBytes: unchangedSum(samples[0], "artifactPayloadBytes"),
};
const cleanDistributions = distributionsOver(cleanSamples);

// ---------------------------------------------------------------------------
// Gate 1: every package resource of a transport rebuild is byte-identical to
// the clean rebuild paired with it; the reports the exclusion list names are
// compared outside their excluded keys.
// ---------------------------------------------------------------------------
function compareOutputs(transport, clean) {
  const names = [...new Set([...Object.keys(transport.outputFiles), ...Object.keys(clean.outputFiles)])].sort((a, b) => a.localeCompare(b, "en"));
  const files = names.map((name) => {
    const t = transport.outputFiles[name];
    const c = clean.outputFiles[name];
    if (!t || !c) return { name, verdict: t ? "missing-in-clean" : "missing-in-transport" };
    if (t.sha256 === c.sha256) return { name, bytes: t.bytes, sha256: t.sha256, verdict: "identical" };
    if (t.semanticSha256 && t.semanticSha256 === c.semanticSha256) return { name, bytes: t.bytes, excludedKeys: t.excludedKeys, verdict: "identical-outside-excluded-keys" };
    return { name, transportSha256: t.sha256, cleanSha256: c.sha256, verdict: "different" };
  });
  return { index: transport.index, files, met: files.every((f) => f.verdict.startsWith("identical")) };
}
const gate1Pairs = samples.map((s, i) => compareOutputs(s, cleanSamples[i]));
const gate1 = {
  rule: "Every file the transport rebuild wrote has the same SHA-256 as the file the clean rebuild of the same index wrote, except that the reports named in reportExclusions are compared after deleting the excluded keys (canonical JSON). Package digests of both arms are recorded as well.",
  reportExclusions,
  transportPackageDigest: packageDigest,
  cleanPackageDigest,
  packageDigestsIdentical: packageDigest === cleanPackageDigest,
  resources: gate1Pairs[0].files.map(({ name, verdict, bytes }) => ({ name, verdict, ...(bytes !== undefined ? { bytes } : {}) })),
  pairs: gate1Pairs,
  met: packageDigest === cleanPackageDigest && gate1Pairs.every((pair) => pair.met),
};

// Gate 2: the adapter reported exactly the restore decisions the cache state dictates, in every accepted sample.
const gate2 = {
  rule: "Every accepted transport sample reports the unchanged documents as artifact hits and the changed document as the only miss; its ledger names each unchanged artifact verified and the changed one absent. Corrupt, truncated, tampered, wrong-key, and previous-schema artifacts are refused with a named reason and re-extracted in native/adapter-ifc/tests/test_document_artifact_cache.py.",
  decisions: samples[0].documentArtifactCache,
  everySampleIdentical: samples.every((s) => canonicalJson(s.documentArtifactCache) === canonicalJson(samples[0].documentArtifactCache)),
  artifactStates: Object.fromEntries(documents.map(({ discipline }) => [discipline, ledgerDocument(samples[0], discipline).artifactState])),
  met: samples.every((s) => transportSampleFailures(s, packageDigest).length === 0) && closures.every((c) => c.met),
};

// ---------------------------------------------------------------------------
// Gate 3: the adapter's load + verify of an unchanged artifact against one
// read, one gunzip, and one SHA-256 of the same stored file in this process.
// ---------------------------------------------------------------------------
function readAndHashArtifact(path) {
  const startedAt = performance.now();
  const stored = readFileSync(path);
  const content = gunzipSync(stored);
  const newline = content.indexOf(10);
  const header = JSON.parse(content.subarray(0, newline).toString("utf8"));
  const payload = content.subarray(newline + 1);
  const digest = sha256(payload);
  return {
    discipline: header.keyInput.discipline,
    schemaVersion: header.schemaVersion,
    fileBytes: stored.byteLength,
    payloadBytes: payload.byteLength,
    payloadLengthMatches: payload.byteLength === header.payloadBytes,
    digestMatches: digest === header.payloadSha256,
    milliseconds: round(performance.now() - startedAt),
  };
}
const referenceRuns = [];
for (let repeat = 0; repeat < sampleCount; repeat += 1) {
  const run = originalArtifacts.map((name) => readAndHashArtifact(join(documentArtifactDirectory, name))).filter((r) => unchangedDisciplines.includes(r.discipline));
  assert(run.length === unchangedDisciplines.length && run.every((r) => r.digestMatches && r.payloadLengthMatches), "the unchanged artifacts did not verify in the recorder");
  referenceRuns.push(run);
}
const referenceDocuments = Object.fromEntries(
  unchangedDisciplines.map((discipline) => {
    const rows = referenceRuns.map((run) => run.find((r) => r.discipline === discipline));
    return [discipline, { schemaVersion: rows[0].schemaVersion, fileBytes: rows[0].fileBytes, payloadBytes: rows[0].payloadBytes, milliseconds: distribution(rows.map((r) => r.milliseconds)) }];
  }),
);
const referenceTotal = distribution(referenceRuns.map((run) => round(sum(run.map((r) => r.milliseconds)))));
const adapterLoadPlusVerify = overTransport((s) => unchangedSum(s, "artifactLoadMilliseconds") + unchangedSum(s, "artifactVerifyMilliseconds"));
const gate3 = {
  rule: "For the unchanged documents, the adapter's artifactLoadMilliseconds + artifactVerifyMilliseconds (one gzip read, one header line, one SHA-256 over the stored payload bytes; naru.ifc-document-artifact.3) is compared with the same read, gunzip, and hash of the same files performed in this recorder process, repeated once per sample. Met when the adapter median is at most 2x the reference median. Parsing is ledgered separately (artifactParseMilliseconds), so neither figure hides a re-serialization; the artifact format itself is pinned by native/adapter-ifc/tests/test_document_artifact_cache.py.",
  artifactSchema: referenceDocuments[unchangedDisciplines[0]].schemaVersion,
  adapter: {
    loadMilliseconds: distributions.unchangedArtifactLoadMilliseconds,
    verifyMilliseconds: distributions.unchangedArtifactVerifyMilliseconds,
    loadPlusVerifyMilliseconds: adapterLoadPlusVerify,
    parseMilliseconds: distributions.unchangedArtifactParseMilliseconds,
    artifactBytes: distributions.unchangedArtifactBytes,
    artifactPayloadBytes: distributions.unchangedArtifactPayloadBytes,
  },
  reference: { documents: referenceDocuments, totalMilliseconds: referenceTotal },
  ratioAdapterToReference: Number((adapterLoadPlusVerify.median / referenceTotal.median).toFixed(3)),
  gate0: {
    ...model.gate0,
    source: "artifacts/cache/rebuild-stages, naru.rebuild-stage-evidence.1 at commit 69d67e5 (another session; reference only)",
    verifyRatioToGate0: Number((distributions.unchangedArtifactVerifyMilliseconds.median / model.gate0.unchangedArtifactVerifyMilliseconds).toFixed(3)),
  },
  met: adapterLoadPlusVerify.median <= 2 * referenceTotal.median,
};

// ---------------------------------------------------------------------------
// Gate 4: the transport arm's whole-process median against the clean arm's,
// by more than three times the clean samples' own spread, with peak memory no
// higher. A failure is recorded, not absorbed: the ADR marks itself Rejected.
// ---------------------------------------------------------------------------
const transportProcess = distributions.whole.processMilliseconds;
const cleanProcess = cleanDistributions.whole.processMilliseconds;
const cleanSpread = round(cleanProcess.maximum - cleanProcess.minimum);
const saving = round(cleanProcess.median - transportProcess.median);
const gate4 = {
  rule: "The whole-process median of the transport rebuild is lower than the clean rebuild median by more than three times the clean samples' spread (maximum minus minimum), and the transport median peak process-tree working set is no higher than the clean median. Both arms are fresh processes recorded in this session, interleaved per index.",
  slice: 2,
  transport: {
    processMedianMilliseconds: transportProcess.median,
    processMinimumMilliseconds: transportProcess.minimum,
    processMaximumMilliseconds: transportProcess.maximum,
    peakWorkingSetMedianBytes: distributions.whole.peakWorkingSetBytes.median,
  },
  clean: {
    processMedianMilliseconds: cleanProcess.median,
    processMinimumMilliseconds: cleanProcess.minimum,
    processMaximumMilliseconds: cleanProcess.maximum,
    spreadMilliseconds: cleanSpread,
    peakWorkingSetMedianBytes: cleanDistributions.whole.peakWorkingSetBytes.median,
  },
  savingMilliseconds: saving,
  savingRatio: Number((transportProcess.median / cleanProcess.median).toFixed(3)),
  requiredSavingMilliseconds: round(3 * cleanSpread),
  fasterByMoreThanThreeSpreads: saving > 3 * cleanSpread,
  peakMemoryNoHigher: distributions.whole.peakWorkingSetBytes.median <= cleanDistributions.whole.peakWorkingSetBytes.median,
};
gate4.met = gate4.fasterByMoreThanThreeSpreads && gate4.peakMemoryNoHigher;

const protocol = {
  processIsolation: "Every sample and the warm-up is one fresh `node scripts/lib/ifc-cache-sample.mjs` process; the adapter is a fresh Python process inside it.",
  cacheState: "Warm-up extracts the ORIGINAL federation once (adapter only) so every document artifact is warm. Before each transport sample the package cache entries and the changed document's artifact are deleted; the unchanged documents' artifacts stay. Each transport sample therefore restores every unchanged document and re-extracts the changed one, and its package cache lookup is a miss. Each clean sample compiles the same changed federation with no cache directory: nothing is looked up, restored, or published.",
  ordering: "Per index: reset, transport sample, then clean sample, so host drift over the session lands on both arms alike.",
  change: `${changedDocument.discipline}: ${JSON.stringify(model.edit.entity)} -> ${JSON.stringify(model.edit.replacement)}`,
  timing: "Adapter stages come from `--stage-timing` (a separate ledger file, never the report); compiler stages from `stageTiming: true` on compileIfcFederation. Neither touches a package byte: every transport sample's packageDigest must equal the first transport sample's, and every clean sample's the first clean sample's.",
  sampleValidity: "A transport sample counts only when the process exits 0, the package cache misses, the document artifact hits are exactly the unchanged documents and the miss is exactly the changed one, no warning is emitted, the stage ledger is present, and the package digest equals the first transport sample's. A clean sample counts only when the process exits 0, the package cache and the document artifact cache are disabled, no warning is emitted, the stage ledger is present, and the package digest equals the first clean sample's. Up to 3 attempts per index and arm; every discarded attempt is recorded. Byte identity across the arms is gate 1's verdict, never a validity rule.",
  statistics: "median; p95 nearest-rank; minimum; maximum over the accepted samples of each arm",
  peakMemory: processTreeSampleMethod,
  uncontrolled: "Other processes on the host, disk cache state between samples, and CPU frequency scaling.",
};

const sampleRecord = (s) => ({
  index: s.index,
  exitCode: s.exitCode,
  processMilliseconds: s.processMilliseconds,
  compileMilliseconds: s.compileMilliseconds,
  peakWorkingSetBytes: s.memory.peakWorkingSetBytes,
  peakPrivateBytes: s.memory.peakPrivateBytes,
  maxProcessCount: s.memory.maxProcessCount,
  packageDigest: s.report.output.packageDigest,
  cache: s.cache,
  documentArtifactCache: s.documentArtifactCache,
  warnings: s.warnings,
  outputFiles: s.outputFiles,
  stages: s.stages,
});

const evidence = {
  schemaVersion: "naru.rebuild-stage-evidence.2",
  mode: "fresh-process-changed-discipline-transport-vs-clean-rebuild",
  recordedAt: new Date().toISOString(),
  model: modelId,
  host: {
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    cpuCount: availableParallelism(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    totalMemoryBytes: totalmem(),
  },
  commit: {
    head: gitOutput("rev-parse", "HEAD"),
    describe: gitOutput("log", "-1", "--pretty=%s"),
    workingTreeClean: gitOutput("status", "--porcelain") === "",
  },
  fixture: {
    datasetId: model.datasetId,
    manifest: { path: "fixtures/external/manifest.json", sha256: sha256(manifestBytes) },
    license: dataset.license,
    documents: sourceIdentities,
  },
  changedDocument: changedIdentity,
  adapter: adapterIdentity,
  compileOptions: {
    threads,
    compactJson: model.compactJson,
    spatialIndex: true,
    relocateHierarchyNodes: true,
    cacheDirectory: portable(cacheDirectory),
    cleanArmCacheDirectory: null,
    pythonExecutable: isAbsolute(ifcPython) && !relative(repositoryRoot, ifcPython).startsWith("..") ? portable(ifcPython) : basename(ifcPython),
  },
  protocol,
  reportExclusions,
  packageDigest,
  cleanPackageDigest,
  warmUp,
  samples: samples.map(sampleRecord),
  cleanSamples: cleanSamples.map(sampleRecord),
  discardedSamples: discarded,
  closure: closures,
  cleanClosure: cleanClosures,
  distributions,
  cleanDistributions,
  gates: { gate1, gate2, gate3, gate4 },
};

await mkdir(artifactDirectory, { recursive: true });
const recordPath = resolve(artifactDirectory, `${modelId}.json`);
await writeFile(recordPath, `${JSON.stringify(evidence, null, 2)}\n`);
const seconds = (ms) => (ms / 1000).toFixed(1);
console.log(
  `[rebuild-stages] ${modelId}: ${samples.length} transport + ${cleanSamples.length} clean samples, ${discarded.length} discarded; ` +
    `transport process ${seconds(transportProcess.median)} s (adapter ${seconds(distributions.compilerStages.adapter.median)} s, compiler work ${seconds(distributions.whole.inProcessCompilerWorkMilliseconds.median)} s, peak ${(distributions.whole.peakWorkingSetBytes.median / 1e9).toFixed(2)} GB); ` +
    `clean process ${seconds(cleanProcess.median)} s [${seconds(cleanProcess.minimum)}, ${seconds(cleanProcess.maximum)}] (peak ${(cleanDistributions.whole.peakWorkingSetBytes.median / 1e9).toFixed(2)} GB)`,
);
console.log(`[rebuild-stages] gate 1 ${gate1.met ? "met" : "NOT met"}: ${gate1.resources.map((r) => `${r.name} ${r.verdict}`).join(", ")}`);
console.log(`[rebuild-stages] gate 2 ${gate2.met ? "met" : "NOT met"}: hits ${JSON.stringify(gate2.decisions.hits)}, misses ${JSON.stringify(gate2.decisions.misses)}`);
console.log(`[rebuild-stages] gate 3 ${gate3.met ? "met" : "NOT met"}: adapter load+verify ${adapterLoadPlusVerify.median} ms (verify ${distributions.unchangedArtifactVerifyMilliseconds.median}, parse ${distributions.unchangedArtifactParseMilliseconds.median}) vs reference ${referenceTotal.median} ms -> ${gate3.ratioAdapterToReference}x; gate 0 verify was ${model.gate0.unchangedArtifactVerifyMilliseconds} ms`);
console.log(`[rebuild-stages] gate 4 ${gate4.met ? "met" : "NOT met"}: saving ${seconds(saving)} s (ratio ${gate4.savingRatio}) vs required > ${seconds(3 * cleanSpread)} s (3 x clean spread ${seconds(cleanSpread)} s); peak memory ${gate4.peakMemoryNoHigher ? "no higher" : "HIGHER"}`);
console.log(`[rebuild-stages] wrote ${portable(recordPath)}`);
