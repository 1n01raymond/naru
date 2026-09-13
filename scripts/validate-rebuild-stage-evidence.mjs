/**
 * Validates artifacts/cache/rebuild-stages: the ADR-0019 gate record --
 * fresh-process changed-discipline rebuilds through the document-artifact
 * transport, each paired with a clean rebuild with no cache directory, both
 * decomposed into adapter and compiler stages.
 *
 * Pins are deliberate. The package digests are HOST-LOCAL (the IFC adapter's
 * split Scene IR differs by a few bytes across hosts; see
 * artifacts/spatial-demand/README.md) and must not be retargeted to make a
 * re-record pass. The gate verdicts are pinned from the record: a re-record
 * that flips one is reviewed, not absorbed.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const recordDirectory = resolve(repositoryRoot, "artifacts/cache/rebuild-stages");

const schemaVersion = "naru.rebuild-stage-evidence.2";
const mode = "fresh-process-changed-discipline-transport-vs-clean-rebuild";
const manifestSha256 = "77d7d587d6b32938a371325e281a4584e10c2ff3118a59f300a9da097eb2f478";
const adapterLedgerSchema = "naru.ifc-adapter-stage-timing.1";
const compilerLedgerSchema = "naru.ifc-federation-stage-timing.1";
const documentArtifactSchema = "naru.ifc-document-artifact.4";
const reportExclusions = ["adapter-report.json:documentArtifactCache"];
const compilerStageNames = [
  "inspectSources",
  "toolchainIdentity",
  "cacheLookup",
  "adapter",
  "readSceneIr",
  "hydrate",
  "compile",
  "validateCompiled",
  "dependencyIndex",
  "writePackage",
  "writeDependencyIndex",
  "retainSceneIr",
  "cachePublish",
];
const compileStageNames = ["validateScene", "encodeGeometry", "measureDocument", "other"];
const adapterProcessKeys = ["spawnToModuleStartMilliseconds", "importMilliseconds", "importsToMainMilliseconds", "mainMilliseconds", "finishToCloseMilliseconds"];
const federationKeys = ["mergeMilliseconds", "propertyIndexMilliseconds"];
const writeKeys = ["geometryMilliseconds", "propertiesMilliseconds", "structureMilliseconds", "digestMilliseconds", "reportMilliseconds"];
/** Every package resource both arms must write; the reports are compared outside their excluded keys. */
const expectedOutputs = ["adapter-report.json", "build-report.json", "coarse.bin", "hierarchy.bin", "hierarchy.json", "incremental-dependencies.json", "properties.bin", "properties.json", "scene.bin", "scene.gltf", "spatial.bin"];

const models = {
  "digital-hub": {
    documents: ["architecture", "heating", "plumbing", "ventilation"],
    changedDiscipline: "architecture",
    compactJson: false,
    samples: 5,
    packageDigest: "c4b151e5f5d762e4f431c5f647aaec8a53a43d7bbf9737917e4874a1f022b3bb",
    gates: { gate1: true, gate2: true, gate3: true, gate4: true },
  },
  sixty5: {
    documents: ["architecture", "electrical", "facade", "kitchen", "plumbing", "structure", "ventilation"],
    changedDiscipline: "structure",
    compactJson: true,
    samples: 5,
    packageDigest: "05707534c73ce126da401a79481d0fd6c892bc308a451d6aa2a4b1691bc2439e",
    gates: { gate1: true, gate2: true, gate3: true, gate4: true },
  },
};

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}
const isSha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isMilliseconds = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const machinePath = new RegExp(`^(?:[A-Za-z]:[${String.fromCharCode(92, 92)}/]|/Users/|/home/)`);
function checkDistribution(label, distribution, expectedValues, tolerance = 0.06) {
  check(distribution && Array.isArray(distribution.values), `${label}: distribution is missing`);
  if (!distribution?.values) return;
  check(distribution.values.length === expectedValues.length, `${label}: ${distribution.values.length} values, expected ${expectedValues.length}`);
  for (const [index, value] of expectedValues.entries()) {
    check(Math.abs(distribution.values[index] - value) <= tolerance, `${label}: value ${index} is ${distribution.values[index]}, sample says ${value}`);
  }
  const sorted = [...expectedValues].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  check(Math.abs(distribution.median - median) <= tolerance, `${label}: median ${distribution.median}, recomputed ${median}`);
  check(Math.abs(distribution.minimum - sorted[0]) <= tolerance && Math.abs(distribution.maximum - sorted[sorted.length - 1]) <= tolerance, `${label}: minimum/maximum do not match the values`);
}

for (const [modelId, expected] of Object.entries(models)) {
  const label = `[rebuild-stages] ${modelId}`;
  let record;
  try {
    record = JSON.parse(await readFile(resolve(recordDirectory, `${modelId}.json`), "utf8"));
  } catch (error) {
    failures.push(`${label}: cannot read record: ${error.message}`);
    continue;
  }
  check(record.schemaVersion === schemaVersion, `${label}: schemaVersion ${record.schemaVersion}, expected ${schemaVersion}`);
  check(record.mode === mode, `${label}: mode ${record.mode}`);
  check(record.model === modelId, `${label}: model ${record.model}`);
  check(record.fixture?.manifest?.sha256 === manifestSha256, `${label}: fixture manifest sha256 ${record.fixture?.manifest?.sha256}`);
  check(sameSet((record.fixture?.documents ?? []).map((d) => d.discipline), expected.documents), `${label}: fixture documents ${JSON.stringify(record.fixture?.documents?.map((d) => d.discipline))}`);
  for (const document of record.fixture?.documents ?? []) check(isSha256(document.sha256) && document.bytes > 0, `${label}: fixture document ${document.discipline} lacks a digest`);
  check(record.changedDocument?.discipline === expected.changedDiscipline, `${label}: changed discipline ${record.changedDocument?.discipline}`);
  check(isSha256(record.changedDocument?.originalSha256) && isSha256(record.changedDocument?.changedSha256) && record.changedDocument.originalSha256 !== record.changedDocument.changedSha256, `${label}: changed document digests`);
  check(record.changedDocument?.edit?.entity && record.changedDocument?.edit?.replacement && record.changedDocument.edit.entity !== record.changedDocument.edit.replacement, `${label}: edit is not a change`);
  check(record.compileOptions?.compactJson === expected.compactJson, `${label}: compactJson ${record.compileOptions?.compactJson}`);
  check(record.compileOptions?.spatialIndex === true && record.compileOptions?.relocateHierarchyNodes === true, `${label}: compile options`);
  check(record.compileOptions?.cleanArmCacheDirectory === null, `${label}: the clean arm must declare no cache directory`);
  for (const value of [record.compileOptions?.cacheDirectory, record.compileOptions?.pythonExecutable]) {
    check(typeof value === "string" && !machinePath.test(value), `${label}: machine path leaked: ${value}`);
  }
  check(typeof record.commit?.head === "string" && /^[0-9a-f]{40}$/.test(record.commit.head), `${label}: commit head`);
  check(record.adapter?.schemaVersion === "naru.ifc-adapter-identity.1" && isSha256(record.adapter?.fingerprint), `${label}: adapter identity`);
  check(JSON.stringify(record.reportExclusions) === JSON.stringify(reportExclusions), `${label}: reportExclusions ${JSON.stringify(record.reportExclusions)}, expected ${JSON.stringify(reportExclusions)}`);
  check(record.packageDigest === expected.packageDigest, `${label}: packageDigest ${record.packageDigest}, pinned ${expected.packageDigest}`);
  check(record.cleanPackageDigest === expected.packageDigest, `${label}: cleanPackageDigest ${record.cleanPackageDigest}, pinned ${expected.packageDigest}`);
  check(record.protocol?.ordering && record.protocol?.sampleValidity && record.protocol?.cacheState, `${label}: protocol text is incomplete`);

  const unchanged = expected.documents.filter((d) => d !== expected.changedDiscipline);
  check(record.warmUp?.artifacts === expected.documents.length, `${label}: warm-up published ${record.warmUp?.artifacts} artifacts`);
  check(sameSet(record.warmUp?.documentArtifactCache?.misses ?? [], expected.documents), `${label}: warm-up must extract every document cold`);
  check(Array.isArray(record.discardedSamples) && record.discardedSamples.length === 0, `${label}: ${record.discardedSamples?.length} discarded samples recorded, expected none`);

  function checkLedgers(arm, sample, index) {
    const tag = `${label}: ${arm}[${index}]`;
    check(sample.index === index + 1 && sample.exitCode === 0, `${tag}: index/exit`);
    check(sample.warnings?.length === 0, `${tag}: warnings ${JSON.stringify(sample.warnings)}`);
    check(sample.processMilliseconds >= sample.compileMilliseconds, `${tag}: process wall below compile wall`);
    check(sample.peakWorkingSetBytes > 0 && sample.maxProcessCount >= 2, `${tag}: memory sample`);
    check(sample.outputFiles && sameSet(Object.keys(sample.outputFiles), expectedOutputs), `${tag}: output files ${JSON.stringify(Object.keys(sample.outputFiles ?? {}))}`);
    for (const [name, file] of Object.entries(sample.outputFiles ?? {})) {
      check(isSha256(file.sha256) && file.bytes > 0, `${tag}: ${name} digest`);
      const excluded = reportExclusions.filter((e) => e.startsWith(`${name}:`)).map((e) => e.slice(name.length + 1));
      check(JSON.stringify(file.excludedKeys ?? []) === JSON.stringify(excluded), `${tag}: ${name} excludedKeys ${JSON.stringify(file.excludedKeys)}`);
      if (excluded.length > 0) check(isSha256(file.semanticSha256), `${tag}: ${name} semantic digest`);
    }
    const { stages } = sample;
    check(stages?.schemaVersion === compilerLedgerSchema, `${tag}: compiler ledger schema ${stages?.schemaVersion}`);
    check(stages && sameSet(Object.keys(stages.stages ?? {}), compilerStageNames), `${tag}: compiler stage names`);
    check(stages && sameSet(Object.keys(stages.compileStages ?? {}), compileStageNames), `${tag}: compile stage names`);
    if (!stages?.stages) return;
    for (const name of compilerStageNames) check(isMilliseconds(stages.stages[name]), `${tag}: stage ${name}`);
    check(Math.abs(sum(compilerStageNames.map((n) => stages.stages[n])) + stages.unattributedMilliseconds - stages.totalMilliseconds) < 0.01, `${tag}: compiler stages do not close`);
    check(Math.abs(sum(compileStageNames.map((n) => stages.compileStages[n])) - stages.stages.compile) < 0.01, `${tag}: compile sub-stages do not close`);
    check(stages.structureReadMilliseconds <= stages.stages.readSceneIr + 0.01, `${tag}: structure read exceeds readSceneIr`);
    const adapter = stages.adapter;
    check(adapter && adapterProcessKeys.every((k) => isMilliseconds(adapter[k])), `${tag}: adapter process phases`);
    check(adapter?.ledger?.schemaVersion === adapterLedgerSchema, `${tag}: adapter ledger schema ${adapter?.ledger?.schemaVersion}`);
    check(sum(adapterProcessKeys.map((k) => adapter?.[k] ?? 0)) <= stages.stages.adapter + 5, `${tag}: adapter process exceeds the adapter stage`);
    const ledger = adapter?.ledger;
    check(ledger && sameSet(Object.keys(ledger.federation ?? {}), federationKeys) && sameSet(Object.keys(ledger.write ?? {}), writeKeys), `${tag}: adapter ledger keys`);
    check(ledger && sameSet((ledger.documents ?? []).map((d) => d.discipline), expected.documents), `${tag}: ledger documents`);
    for (const document of ledger?.documents ?? []) {
      const documentTag = `${tag}: ${document.discipline}`;
      check(isMilliseconds(document.readMilliseconds) && document.sourceBytes > 0, `${documentTag}: read/source bytes`);
      if (arm === "transport" && document.discipline !== expected.changedDiscipline) {
        check(document.outcome === "restored" && document.artifactState === "verified", `${documentTag}: expected a verified restore, got ${document.outcome}/${document.artifactState}`);
        check(isMilliseconds(document.artifactLoadMilliseconds) && isMilliseconds(document.artifactVerifyMilliseconds) && isMilliseconds(document.artifactParseMilliseconds) && isMilliseconds(document.restoreMilliseconds), `${documentTag}: artifact timings`);
        check(document.artifactBytes > 0 && document.artifactPayloadBytes > document.artifactBytes, `${documentTag}: artifact bytes ${document.artifactBytes} / payload ${document.artifactPayloadBytes}`);
        check(document.artifactInvalidReason === undefined, `${documentTag}: a verified artifact carries an invalid reason`);
      } else if (arm === "transport") {
        check(document.outcome === "extracted" && document.artifactState === "absent", `${documentTag}: expected extraction of the changed document, got ${document.outcome}/${document.artifactState}`);
        check(document.extractMilliseconds > 0 && isMilliseconds(document.publishMilliseconds), `${documentTag}: extraction timings`);
      } else {
        check(document.outcome === "extracted" && document.artifactState === undefined, `${documentTag}: the clean arm must extract without artifacts, got ${document.outcome}/${document.artifactState}`);
        check(document.extractMilliseconds > 0 && document.publishMilliseconds === undefined, `${documentTag}: clean extraction timings`);
      }
    }
  }

  const samples = record.samples ?? [];
  const cleanSamples = record.cleanSamples ?? [];
  check(samples.length === expected.samples, `${label}: ${samples.length} transport samples, expected ${expected.samples}`);
  check(cleanSamples.length === expected.samples, `${label}: ${cleanSamples.length} clean samples, expected ${expected.samples}`);
  for (const [index, sample] of samples.entries()) {
    const tag = `${label}: transport[${index}]`;
    check(sample.packageDigest === expected.packageDigest, `${tag}: packageDigest ${sample.packageDigest}`);
    check(sample.cache?.status === "miss", `${tag}: package cache ${sample.cache?.status}`);
    check(sample.documentArtifactCache?.status === "enabled", `${tag}: document artifact cache ${sample.documentArtifactCache?.status}`);
    check(sameSet(sample.documentArtifactCache?.hits ?? [], unchanged), `${tag}: hits ${JSON.stringify(sample.documentArtifactCache?.hits)}`);
    check(sameSet(sample.documentArtifactCache?.misses ?? [], [expected.changedDiscipline]), `${tag}: misses ${JSON.stringify(sample.documentArtifactCache?.misses)}`);
    check(sample.stages?.stages?.cacheLookup > 0 && sample.stages?.stages?.cachePublish > 0, `${tag}: cache lookup/publish stages`);
    checkLedgers("transport", sample, index);
  }
  for (const [index, sample] of cleanSamples.entries()) {
    const tag = `${label}: clean[${index}]`;
    check(sample.packageDigest === expected.packageDigest, `${tag}: packageDigest ${sample.packageDigest}`);
    check(sample.cache?.status === "disabled", `${tag}: package cache ${sample.cache?.status}`);
    check(sample.documentArtifactCache?.status === "disabled" && (sample.documentArtifactCache?.hits ?? []).length === 0 && (sample.documentArtifactCache?.misses ?? []).length === 0, `${tag}: document artifact cache ${JSON.stringify(sample.documentArtifactCache)}`);
    check(sample.stages?.stages?.cacheLookup === 0 && sample.stages?.stages?.cachePublish === 0, `${tag}: a clean sample must spend nothing on cache lookup/publish`);
    checkLedgers("clean", sample, index);
  }
  for (const [arm, closures] of [["closure", record.closure], ["cleanClosure", record.cleanClosure]]) {
    check(Array.isArray(closures) && closures.length === expected.samples && closures.every((c) => c.met === true), `${label}: ${arm} not met on every sample`);
  }

  // Distributions of both arms recompute from their samples.
  const ledgerDocument = (sample, discipline) => sample.stages.adapter.ledger.documents.find((d) => d.discipline === discipline);
  function checkDistributions(arm, set, distributions) {
    if (set.length !== expected.samples || !distributions) return;
    const tag = `${label}: ${arm} distributions`;
    checkDistribution(`${tag}.whole.processMilliseconds`, distributions.whole?.processMilliseconds, set.map((s) => s.processMilliseconds));
    checkDistribution(`${tag}.whole.compileMilliseconds`, distributions.whole?.compileMilliseconds, set.map((s) => s.compileMilliseconds));
    checkDistribution(`${tag}.whole.totalMilliseconds`, distributions.whole?.totalMilliseconds, set.map((s) => s.stages.totalMilliseconds));
    checkDistribution(`${tag}.whole.peakWorkingSetBytes`, distributions.whole?.peakWorkingSetBytes, set.map((s) => s.peakWorkingSetBytes));
    checkDistribution(`${tag}.whole.inProcessCompilerWorkMilliseconds`, distributions.whole?.inProcessCompilerWorkMilliseconds, set.map((s) => s.stages.totalMilliseconds - s.stages.stages.adapter));
    for (const name of compilerStageNames) checkDistribution(`${tag}.compilerStages.${name}`, distributions.compilerStages?.[name], set.map((s) => s.stages.stages[name]));
    for (const name of compileStageNames) checkDistribution(`${tag}.compileStages.${name}`, distributions.compileStages?.[name], set.map((s) => s.stages.compileStages[name]));
    for (const key of adapterProcessKeys) checkDistribution(`${tag}.adapterProcess.${key}`, distributions.adapterProcess?.[key], set.map((s) => s.stages.adapter[key]));
    for (const key of federationKeys) checkDistribution(`${tag}.adapterFederation.${key}`, distributions.adapterFederation?.[key], set.map((s) => s.stages.adapter.ledger.federation[key]));
    for (const key of writeKeys) checkDistribution(`${tag}.adapterWrite.${key}`, distributions.adapterWrite?.[key], set.map((s) => s.stages.adapter.ledger.write[key]));
    for (const discipline of expected.documents) {
      const first = ledgerDocument(set[0], discipline);
      check(distributions.adapterDocuments?.[discipline]?.outcome === first.outcome, `${tag}.adapterDocuments.${discipline}: outcome`);
      for (const key of Object.keys(first).filter((k) => typeof first[k] === "number")) {
        checkDistribution(`${tag}.adapterDocuments.${discipline}.${key}`, distributions.adapterDocuments?.[discipline]?.[key], set.map((s) => ledgerDocument(s, discipline)[key]));
      }
    }
  }
  checkDistributions("transport", samples, record.distributions);
  checkDistributions("clean", cleanSamples, record.cleanDistributions);
  if (samples.length === expected.samples && record.distributions) {
    const unchangedSum = (sample, key) => sum(unchanged.map((d) => ledgerDocument(sample, d)[key]));
    for (const key of ["artifactLoadMilliseconds", "artifactVerifyMilliseconds", "artifactParseMilliseconds"]) {
      checkDistribution(`${label}: distributions.unchanged.${key}`, record.distributions[`unchanged${key[0].toUpperCase()}${key.slice(1)}`], samples.map((s) => unchangedSum(s, key)));
    }
    check(record.distributions.unchangedArtifactBytes === unchangedSum(samples[0], "artifactBytes"), `${label}: unchangedArtifactBytes`);
    check(record.distributions.unchangedArtifactPayloadBytes === unchangedSum(samples[0], "artifactPayloadBytes"), `${label}: unchangedArtifactPayloadBytes`);
  }

  // Gates.
  const gates = record.gates ?? {};
  const gate1 = gates.gate1;
  check(gate1 && JSON.stringify(gate1.reportExclusions) === JSON.stringify(reportExclusions), `${label}: gate 1 exclusion list`);
  check(gate1?.transportPackageDigest === expected.packageDigest && gate1?.cleanPackageDigest === expected.packageDigest && gate1?.packageDigestsIdentical === true, `${label}: gate 1 package digests`);
  check(Array.isArray(gate1?.pairs) && gate1.pairs.length === expected.samples, `${label}: gate 1 pairs`);
  for (const pair of gate1?.pairs ?? []) {
    check(sameSet(pair.files.map((f) => f.name), expectedOutputs), `${label}: gate 1 pair ${pair.index} files`);
    for (const file of pair.files) {
      const excluded = reportExclusions.some((e) => e.startsWith(`${file.name}:`));
      check(file.verdict === (excluded ? "identical-outside-excluded-keys" : "identical"), `${label}: gate 1 pair ${pair.index} ${file.name} ${file.verdict}`);
    }
    check(pair.met === true, `${label}: gate 1 pair ${pair.index} not met`);
    // The verdicts must match the digests the samples recorded.
    const transport = samples[pair.index - 1];
    const clean = cleanSamples[pair.index - 1];
    if (transport?.outputFiles && clean?.outputFiles) {
      for (const file of pair.files) {
        const t = transport.outputFiles[file.name];
        const c = clean.outputFiles[file.name];
        const identical = file.verdict === "identical" ? t?.sha256 === c?.sha256 : t?.semanticSha256 === c?.semanticSha256 && t?.sha256 !== undefined;
        check(identical, `${label}: gate 1 pair ${pair.index} ${file.name} verdict does not follow from the sample digests`);
      }
    }
  }
  check(gate1?.met === expected.gates.gate1, `${label}: gate 1 met=${gate1?.met}, pinned ${expected.gates.gate1}`);

  const gate2 = gates.gate2;
  check(gate2?.everySampleIdentical === true && gate2?.met === expected.gates.gate2, `${label}: gate 2`);
  check(gate2 && sameSet(gate2.decisions?.hits ?? [], unchanged) && sameSet(gate2.decisions?.misses ?? [], [expected.changedDiscipline]), `${label}: gate 2 decisions`);
  check(gate2 && unchanged.every((d) => gate2.artifactStates?.[d] === "verified") && gate2.artifactStates?.[expected.changedDiscipline] === "absent", `${label}: gate 2 artifact states`);

  const gate3 = gates.gate3;
  check(gate3?.artifactSchema === documentArtifactSchema, `${label}: gate 3 artifact schema ${gate3?.artifactSchema}`);
  check(gate3 && sameSet(Object.keys(gate3.reference?.documents ?? {}), unchanged), `${label}: gate 3 reference documents`);
  for (const [discipline, reference] of Object.entries(gate3?.reference?.documents ?? {})) {
    const ledger = samples[0] && ledgerDocument(samples[0], discipline);
    check(reference.schemaVersion === documentArtifactSchema, `${label}: gate 3 ${discipline} schema`);
    check(ledger && reference.fileBytes === ledger.artifactBytes && reference.payloadBytes === ledger.artifactPayloadBytes, `${label}: gate 3 ${discipline} bytes differ from the adapter ledger`);
    check(reference.milliseconds?.values?.length === expected.samples && reference.milliseconds.values.every(isMilliseconds), `${label}: gate 3 ${discipline} reference timings`);
  }
  if (gate3?.reference?.totalMilliseconds && gate3.adapter?.loadPlusVerifyMilliseconds) {
    const recomputedRatio = gate3.adapter.loadPlusVerifyMilliseconds.median / gate3.reference.totalMilliseconds.median;
    check(Math.abs(gate3.ratioAdapterToReference - recomputedRatio) < 0.002, `${label}: gate 3 ratio ${gate3.ratioAdapterToReference}, recomputed ${recomputedRatio}`);
    check(gate3.met === (gate3.adapter.loadPlusVerifyMilliseconds.median <= 2 * gate3.reference.totalMilliseconds.median), `${label}: gate 3 verdict does not follow from its rule`);
    if (samples.length === expected.samples) {
      const unchangedSum = (sample, key) => sum(unchanged.map((d) => ledgerDocument(sample, d)[key]));
      checkDistribution(`${label}: gate 3 adapter.loadPlusVerifyMilliseconds`, gate3.adapter.loadPlusVerifyMilliseconds, samples.map((s) => unchangedSum(s, "artifactLoadMilliseconds") + unchangedSum(s, "artifactVerifyMilliseconds")));
    }
  }
  check(gate3?.gate0?.unchangedArtifactVerifyMilliseconds > 0 && typeof gate3?.gate0?.source === "string", `${label}: gate 3 gate-0 reference`);
  check(gate3?.met === expected.gates.gate3, `${label}: gate 3 met=${gate3?.met}, pinned ${expected.gates.gate3}`);

  const gate4 = gates.gate4;
  if (gate4 && record.distributions?.whole && record.cleanDistributions?.whole) {
    const transportProcess = record.distributions.whole.processMilliseconds;
    const cleanProcess = record.cleanDistributions.whole.processMilliseconds;
    check(gate4.transport?.processMedianMilliseconds === transportProcess.median && gate4.clean?.processMedianMilliseconds === cleanProcess.median, `${label}: gate 4 medians differ from the distributions`);
    const spread = cleanProcess.maximum - cleanProcess.minimum;
    check(Math.abs(gate4.clean?.spreadMilliseconds - spread) < 0.11, `${label}: gate 4 clean spread ${gate4.clean?.spreadMilliseconds}, recomputed ${spread}`);
    const saving = cleanProcess.median - transportProcess.median;
    check(Math.abs(gate4.savingMilliseconds - saving) < 0.11, `${label}: gate 4 saving ${gate4.savingMilliseconds}, recomputed ${saving}`);
    check(gate4.fasterByMoreThanThreeSpreads === saving > 3 * spread, `${label}: gate 4 spread verdict does not follow from its rule`);
    const memoryVerdict = record.distributions.whole.peakWorkingSetBytes.median <= record.cleanDistributions.whole.peakWorkingSetBytes.median;
    check(gate4.peakMemoryNoHigher === memoryVerdict, `${label}: gate 4 memory verdict does not follow from the distributions`);
    check(gate4.met === (gate4.fasterByMoreThanThreeSpreads && gate4.peakMemoryNoHigher), `${label}: gate 4 verdict does not follow from its two conditions`);
    check(gate4.slice === "3a", `${label}: gate 4 slice ${gate4.slice}`);
  } else {
    failures.push(`${label}: gate 4 block or distributions missing`);
  }
  check(gate4?.met === expected.gates.gate4, `${label}: gate 4 met=${gate4?.met}, pinned ${expected.gates.gate4}`);
}

if (failures.length > 0) {
  console.error(failures.map((f) => `  ${f}`).join("\n"));
  console.error(`[rebuild-stages] ${failures.length} failure(s).`);
  process.exit(1);
}
console.log(`[rebuild-stages] ${Object.keys(models).length} records: ${Object.entries(models).map(([id, m]) => `${id} gates ${Object.values(m.gates).map((g) => (g ? "met" : "not met")).join("/")}`).join("; ")}`);
