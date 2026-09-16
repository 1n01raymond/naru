/**
 * Compiles one IFC federation sample in its own process.
 *
 * Every cache state this record measures has to start from a process that has
 * never compiled anything: a second compile inside one process reuses a warm
 * module graph, a grown V8 heap, and an operating-system file cache that a
 * user reopening a model tomorrow does not have. The recorder therefore spawns
 * this script once per sample and reads the JSON it leaves behind.
 *
 * `--adapter-only` runs the IFC adapter alone, with the arguments the compiler
 * would pass it, so a recorder can separate extraction from packaging by
 * difference: the compiler reports no stage timing of its own.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`${name} requires a value.`);
  return value;
}

const configPath = resolve(repositoryRoot, argument("--config"));
const resultPath = resolve(repositoryRoot, argument("--result"));
const outputDirectory = resolve(repositoryRoot, argument("--output"));
const phase = argument("--phase");
const config = JSON.parse(await readFile(configPath, "utf8"));
// The probe run asks for the compiler's default glTF formatting; every sample
// run uses the compact formatting the config pins.
const compactJson = !process.argv.includes("--pretty") && config.compactJson === true;
const adapterOnly = process.argv.includes("--adapter-only");
// `--stage-timing` asks the compiler (and through it the adapter) for the
// diagnostic stage ledger; it never reaches the package or its reports.
const stageTiming = process.argv.includes("--stage-timing");

const documents = config.documents.map((document) => ({
  discipline: document.discipline,
  sourcePath: resolve(repositoryRoot, document.sourcePath),
  uriHint: document.uriHint,
}));
const cacheDirectory = config.cacheDirectory
  ? resolve(repositoryRoot, config.cacheDirectory)
  : undefined;

/** Committed evidence must stay portable: strip machine-absolute path prefixes. */
function portableText(text) {
  return text
    .replaceAll(repositoryRoot, "<repository>")
    .replaceAll(repositoryRoot.replaceAll("\\", "/"), "<repository>")
    // Stack frames name modules by file URL, whose path is percent-encoded.
    .replaceAll(pathToFileURL(repositoryRoot).href, "<repository>")
    .replaceAll(/[A-Za-z]:[/][^\s")]*/gu, "<path>");
}

async function writeResult(result) {
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

if (adapterOnly) {
  // Exactly the invocation `compileIfcFederation` makes, minus the compiler.
  const pythonExecutable =
    config.pythonExecutable ??
    process.env.NARU_IFC_PYTHON ??
    process.env.NARU_PYTHON ??
    (process.platform === "win32" ? "python" : "python3");
  const adapterScript = resolve(
    repositoryRoot,
    "native/adapter-ifc/tools/extract_federation_scene_ir.py",
  );
  const reportPath = join(outputDirectory, "adapter-report.json");
  const startedAt = performance.now();
  const child = spawn(
    pythonExecutable,
    [
      adapterScript,
      ...documents.flatMap(({ discipline, sourcePath, uriHint }) => [
        "--document",
        `${discipline}=${sourcePath}`,
        "--uri-hint",
        `${discipline}=${uriHint}`,
      ]),
      "--scene", join(outputDirectory, "scene-ir.json"),
      "--geometry", join(outputDirectory, "scene-ir-geometry.bin"),
      "--properties", join(outputDirectory, "scene-ir-properties.bin"),
      "--report", reportPath,
      ...(cacheDirectory ? ["--document-cache", resolve(cacheDirectory, "ifc-documents")] : []),
      "--threads", String(config.threads),
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
  );
  const exitCode = await new Promise((settle) => child.on("exit", (code) => settle(code ?? -1)));
  const adapterMilliseconds = Number((performance.now() - startedAt).toFixed(1));
  const adapterReport = exitCode === 0 ? JSON.parse(await readFile(reportPath, "utf8")) : undefined;
  await writeResult({
    phase,
    adapterOnly: true,
    adapterMilliseconds,
    warnings: [],
    ...(exitCode === 0
      ? { documentArtifactCache: adapterReport.documentArtifactCache ?? null }
      : { failure: { name: "AdapterError", message: `adapter exited with ${exitCode}` } }),
  });
  if (exitCode !== 0) process.exitCode = 1;
} else {
  await compileSample();
}

async function compileSample() {
  const { compileIfcFederation } = await import(
    pathToFileURL(resolve(repositoryRoot, "packages/compiler/dist/index.js")).href,
  );
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => {
    warnings.push(portableText(parts.map(String).join(" ")));
    originalWarn(...parts);
  };

  let result;
  let failure;
  const startedAt = performance.now();
  try {
    result = await compileIfcFederation({
      documents,
      outputDirectory,
      ...(cacheDirectory ? { cacheDirectory } : {}),
      threads: config.threads,
      ...(compactJson ? { compactJson: true } : {}),
      ...(config.spatialIndex ? { spatialIndex: true } : {}),
      ...(config.relocateHierarchyNodes ? { relocateHierarchyNodes: true } : {}),
      ...(config.pythonExecutable ? { pythonExecutable: config.pythonExecutable } : {}),
      ...(stageTiming ? { stageTiming: true } : {}),
      ...(config.assembleFederation ? { assembleFederation: true } : {}),
    });
  } catch (error) {
    failure = {
      name: error instanceof Error ? error.name : "Error",
      message: portableText(error instanceof Error ? error.message : String(error)),
      stack: portableText(error instanceof Error ? (error.stack ?? "") : ""),
    };
  }
  const compileMilliseconds = Number((performance.now() - startedAt).toFixed(1));
  console.warn = originalWarn;

  await writeResult({
    phase,
    compactJson,
    compileMilliseconds,
    warnings,
    ...(failure ? { failure } : {}),
    ...(result
      ? {
          cache: result.cache,
          ...(result.stages ? { stages: result.stages } : {}),
          report: result.report,
          // The adapter keeps its own per-document artifact cache, so a run
          // records which documents it inspected and which it restored.
          documentArtifactCache: result.adapterReport?.documentArtifactCache ?? null,
          // With `assembleFederation`, the compiler says whether it assembled the
          // package from those artifacts or fell back to the monolithic adapter.
          assembly: result.assembly ?? null,
          sources: result.sources.map(({ discipline, uriHint, sha256, byteLength }) => ({
            discipline,
            uriHint,
            sha256,
            byteLength,
          })),
        }
      : {}),
  });
  if (failure) process.exitCode = 1;
}
