import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAdapterProcess } from "./adapter-process.js";
import { hydratePhase0Evidence } from "./evidence-input.js";
import {
  createImportJobReporter,
  ImportJobCancelledError,
  settleImportJobFailure,
} from "./import-job.js";
import type {
  ImportJobCompletion,
  ImportJobOptions,
  ImportJobReporter,
} from "./import-job.js";
import { compileSceneToGltf } from "./gltf.js";
import { prepareReducedLod } from "./lod/reduce.js";
import { writeCompiledPackage } from "./package-output.js";
import { inspectStepFile } from "./step-source.js";
import type { StepSourceInspection } from "./step-source.js";
import type { CompileGltfOptions, CompilerBuildReport } from "./types.js";
import { validateCompiledGltf } from "./validate.js";
import {
  createCompiledCacheKey,
  currentCompilerCacheIdentity,
  publishCompiledCacheEntry,
  restoreCompiledCacheEntry,
} from "./compiled-cache.js";
import type {
  CompilationCacheResult,
  CompiledCacheKeyInput,
  CompiledCacheToolInput,
} from "./compiled-cache.js";

const defaultAdapterScript = fileURLToPath(
  new URL("../../../native/adapter-occt/tools/extract_scene_ir.py", import.meta.url),
);

export interface StepCompileOptions {
  readonly sourcePath: string;
  readonly outputDirectory: string;
  readonly pythonExecutable?: string;
  readonly adapterScriptPath?: string;
  readonly linearTolerance?: number;
  readonly angularTolerance?: number;
  /** Optional persistent package cache. Existing output is reused only after full verification. */
  readonly cacheDirectory?: string;
  readonly spatialIndex?: boolean;
  readonly spatialLeafCapacity?: number;
  readonly relocateHierarchyNodes?: boolean;
  /** Emit a declared-error `reduced` level (ADR-0025). */
  readonly reducedLodMeters?: number;
  readonly environment?: NodeJS.ProcessEnv;
  /** Lifecycle events and cancellation for this compile. */
  readonly job?: ImportJobOptions;
}

export interface StepCompilationResult {
  readonly source: StepSourceInspection;
  readonly outputDirectory: string;
  readonly report: CompilerBuildReport;
  readonly adapterReport: unknown;
  readonly cache: CompilationCacheResult;
}

function positiveTolerance(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return result;
}

async function runAdapter(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  const run = await runAdapterProcess({
    executable,
    arguments: arguments_,
    environment,
    label: "OCCT STEP adapter",
    startLabel: "OCCT adapter",
    missingModule: {
      pattern: /ModuleNotFoundError.*(?:cadquery|OCP)/su,
      message:
        "The selected Python environment does not provide CadQuery/OCP. " +
        "Install native/adapter-occt/tools/requirements-evidence.txt in that environment.",
    },
    ...(signal === undefined ? {} : { signal }),
  });
  return run.stdout;
}

interface OcctAdapterIdentity {
  readonly schemaVersion: "naru.occt-adapter-identity.1";
  readonly name: string;
  readonly version: string;
  readonly fingerprint: string;
}

async function inspectAdapterIdentity(
  executable: string,
  adapterScriptPath: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<OcctAdapterIdentity> {
  const serialized = await runAdapter(
    executable,
    [adapterScriptPath, "--identity"],
    environment,
    signal,
  );
  const value = parseJson(serialized.trim(), "OCCT adapter identity");
  if (typeof value !== "object" || value === null) {
    throw new TypeError("OCCT adapter identity must be an object.");
  }
  const identity = value as Partial<OcctAdapterIdentity>;
  if (
    identity.schemaVersion !== "naru.occt-adapter-identity.1" ||
    typeof identity.name !== "string" ||
    identity.name === "" ||
    typeof identity.version !== "string" ||
    identity.version === "" ||
    typeof identity.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(identity.fingerprint)
  ) {
    throw new TypeError("OCCT adapter returned an invalid cache identity.");
  }
  return identity as OcctAdapterIdentity;
}

function cacheInput(
  inspection: StepSourceInspection,
  identity: OcctAdapterIdentity,
  compiler: CompiledCacheToolInput,
  linearTolerance: number,
  angularTolerance: number,
  options: StepCompileOptions,
): CompiledCacheKeyInput {
  return {
    sources: [{ scope: "step", sha256: inspection.sha256 }],
    adapter: {
      name: identity.name,
      version: `${identity.version}+${identity.fingerprint}`,
    },
    compiler,
    options: {
      linearTolerance,
      angularTolerance,
      coarseBounds: true,
      uriHint: basename(inspection.sourcePath),
      spatialIndex: options.spatialIndex === true,
      ...(options.spatialLeafCapacity === undefined
        ? {}
        : { spatialLeafCapacity: options.spatialLeafCapacity }),
      ...(options.relocateHierarchyNodes === true ? { relocateHierarchyNodes: true } : {}),
      ...(options.reducedLodMeters === undefined ? {} : { reducedLodMeters: options.reducedLodMeters }),
    },
  };
}

function cacheFailureDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireBuildReport(value: unknown, sourceDigest: string): CompilerBuildReport {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Cached build report must be an object.");
  }
  const report = value as Partial<CompilerBuildReport>;
  if (
    report.source?.sourceDigest !== `sha256:${sourceDigest}` ||
    typeof report.output?.packageDigest !== "string"
  ) {
    throw new TypeError("Cached build report source/package identity changed.");
  }
  return report as CompilerBuildReport;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON.`, { cause: error });
  }
}

function assertAdapterIdentity(
  adapterReport: unknown,
  inspection: StepSourceInspection,
): void {
  if (typeof adapterReport !== "object" || adapterReport === null) {
    throw new TypeError("OCCT adapter report must be an object.");
  }
  const source = (adapterReport as { readonly source?: unknown }).source;
  if (typeof source !== "object" || source === null) {
    throw new TypeError("OCCT adapter report is missing source identity.");
  }
  const record = source as { readonly sha256?: unknown; readonly format?: unknown };
  if (record.sha256 !== inspection.sha256) {
    throw new TypeError("OCCT adapter report source digest does not match the STEP input.");
  }
  if (record.format !== `STEP ${inspection.schema}`) {
    throw new TypeError("OCCT adapter report schema does not match the STEP header.");
  }
}

/**
 * Compiles one STEP file into a package directory.
 *
 * The lifecycle a caller can observe is described by `options.job`. Nothing
 * about the compiled result depends on it: a job with no listener and no signal
 * behaves exactly as this function did before it had one.
 */
export async function compileStepFile(
  options: StepCompileOptions,
): Promise<StepCompilationResult> {
  const reporter = createImportJobReporter(
    {
      kind: "step",
      sources: [options.sourcePath],
      outputDirectory: options.outputDirectory,
      options: {
        linearTolerance: options.linearTolerance,
        angularTolerance: options.angularTolerance,
        spatialIndex: options.spatialIndex,
        spatialLeafCapacity: options.spatialLeafCapacity,
        relocateHierarchyNodes: options.relocateHierarchyNodes,
        reducedLodMeters: options.reducedLodMeters,
      },
    },
    options.job,
    options.cacheDirectory === undefined ? [] : [options.cacheDirectory],
  );
  try {
    return await runStepCompile(options, reporter);
  } catch (error) {
    throw await settleImportJobFailure(reporter, error, [
      options.sourcePath,
      options.outputDirectory,
      ...(options.cacheDirectory === undefined ? [] : [options.cacheDirectory]),
    ]);
  }
}

async function runStepCompile(
  options: StepCompileOptions,
  reporter: ImportJobReporter,
): Promise<StepCompilationResult> {
  const signal = options.job?.signal;
  reporter.enter("queued");
  reporter.enter("inspecting");
  const inspection = await inspectStepFile(options.sourcePath);
  reporter.describeDocuments([
    { sha256: inspection.sha256, byteLength: inspection.byteLength },
  ]);
  const sourcePath = inspection.sourcePath;
  const outputDirectory = resolve(options.outputDirectory);
  const linearTolerance = positiveTolerance(
    options.linearTolerance,
    0.15,
    "Linear tolerance",
  );
  const angularTolerance = positiveTolerance(
    options.angularTolerance,
    0.15,
    "Angular tolerance",
  );
  const pythonExecutable =
    options.pythonExecutable ??
    process.env.NARU_PYTHON ??
    (process.platform === "win32" ? "python" : "python3");
  const adapterScriptPath = resolve(options.adapterScriptPath ?? defaultAdapterScript);
  const environment = options.environment ?? process.env;
  let cacheKeyInput: CompiledCacheKeyInput | undefined;
  let cacheKey: string | undefined;
  const identity = options.cacheDirectory
    ? await inspectAdapterIdentity(pythonExecutable, adapterScriptPath, environment, signal)
    : undefined;
  const compiler = identity ? await currentCompilerCacheIdentity() : undefined;
  if (options.cacheDirectory && identity && compiler) {
    cacheKeyInput = cacheInput(
      inspection,
      identity,
      compiler,
      linearTolerance,
      angularTolerance,
      options,
    );
    cacheKey = createCompiledCacheKey(cacheKeyInput);
    const restored = await restoreVerifiedPackage({
      cacheDirectory: options.cacheDirectory,
      key: cacheKey,
      outputDirectory,
      sourceDigest: inspection.sha256,
    });
    if (restored) {
      reporter.notePublishedResult();
      // The restore plan announces `verifying` once the entry has been verified
      // rather than before, because a verification that fails becomes a rebuild
      // and a host must never observe a state the job then abandons.
      reporter.settlePlan("restore");
      reporter.enter("verifying");
      if (reporter.cancellationRequested) {
        throw new ImportJobCancelledError(reporter.state);
      }
      reporter.completed(completionOf(restored.report, "hit"));
      return {
        source: inspection,
        outputDirectory,
        report: restored.report,
        adapterReport: restored.adapterReport,
        cache: { status: "hit", key: cacheKey },
      };
    }
  }
  reporter.settlePlan("rebuild");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "naru-step-"));
  reporter.registerTemporaryDirectory(temporaryDirectory);
  const scenePath = join(temporaryDirectory, "scene-ir.json");
  const adapterReportPath = join(temporaryDirectory, "adapter-report.json");
  try {
    reporter.enter("extracting");
    await runAdapter(
      pythonExecutable,
      [
        adapterScriptPath,
        sourcePath,
        "--scene",
        scenePath,
        "--report",
        adapterReportPath,
        "--linear-tolerance",
        String(linearTolerance),
        "--angular-tolerance",
        String(angularTolerance),
        "--uri-hint",
        basename(sourcePath),
      ],
      environment,
      signal,
    );
    reporter.enter("compiling");
    const [serializedScene, serializedAdapterReport] = await Promise.all([
      readFile(scenePath, "utf8"),
      readFile(adapterReportPath, "utf8"),
    ]);
    const adapterReport = parseJson(serializedAdapterReport, "OCCT adapter report");
    assertAdapterIdentity(adapterReport, inspection);
    const scene = hydratePhase0Evidence(parseJson(serializedScene, "OCCT Scene IR"));
    if (scene.revision.sourceDigest !== `sha256:${inspection.sha256}`) {
      throw new TypeError("OCCT Scene IR source digest does not match the STEP input.");
    }
    const compileOptions: CompileGltfOptions = {
      coarseBounds: true,
      ...(options.spatialIndex === true ? { spatialIndex: true } : {}),
      ...(options.spatialLeafCapacity === undefined
        ? {}
        : { spatialLeafCapacity: options.spatialLeafCapacity }),
      ...(options.relocateHierarchyNodes === true ? { relocateHierarchyNodes: true } : {}),
      ...(options.reducedLodMeters === undefined
        ? {}
        : { reducedLod: { maxDeviationMeters: options.reducedLodMeters } }),
    };
    if (compileOptions.reducedLod) await prepareReducedLod();
    const compiled = compileSceneToGltf(scene, compileOptions);
    reporter.enter("verifying");
    const validation = validateCompiledGltf(
      compiled.document,
      compiled.coarseBinary
        ? [compiled.binary, compiled.coarseBinary]
        : compiled.binary,
    );
    if (!validation.ok) {
      throw new TypeError(
        `Compiled glTF validation failed: ${validation.issues
          .slice(0, 5)
          .map(({ code, path }) => `${code} at ${path}`)
          .join(", ")}`,
      );
    }
    // Publication is uninterruptible: everything from here writes the durable
    // result, and a cancel observed midway is the one way to leave a partly
    // written package behind.
    reporter.enter("publishing");
    await writeCompiledPackage(compiled, outputDirectory, adapterReport);
    if (cacheKeyInput && cacheKey) {
      try {
        await publishCompiledCacheEntry({
          cacheDirectory: options.cacheDirectory as string,
          packageDirectory: outputDirectory,
          input: cacheKeyInput,
          packageDigest: compiled.report.output.packageDigest,
          resourcePaths: [
            ...compiled.report.output.resources.map(({ path }) => path),
            "adapter-report.json",
            "build-report.json",
          ],
        });
      } catch (error) {
        console.warn(
          `[naru] cache publish failed (${cacheFailureDetails(error)}); ` +
            "compiled output kept without a cache entry.",
        );
      }
    }
    if (reporter.cancellationRequested) {
      throw new ImportJobCancelledError(reporter.state);
    }
    reporter.completed(completionOf(compiled.report, cacheKey ? "miss" : "disabled"));
    return {
      source: inspection,
      outputDirectory,
      report: compiled.report,
      adapterReport,
      cache: cacheKey ? { status: "miss", key: cacheKey } : { status: "disabled" },
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

interface RestoredPackage {
  readonly report: CompilerBuildReport;
  readonly adapterReport: unknown;
}

/**
 * Restores a cache entry and cross-checks it, or returns undefined so the
 * caller rebuilds. Verification lives here, ahead of any lifecycle event, so a
 * rejected entry costs the host a warning rather than a state it cannot leave.
 */
async function restoreVerifiedPackage(request: {
  readonly cacheDirectory: string;
  readonly key: string;
  readonly outputDirectory: string;
  readonly sourceDigest: string;
}): Promise<RestoredPackage | undefined> {
  try {
    const restored = await restoreCompiledCacheEntry({
      cacheDirectory: request.cacheDirectory,
      key: request.key,
      outputDirectory: request.outputDirectory,
    });
    if (!restored) return undefined;
    const [serializedBuildReport, serializedAdapterReport] = await Promise.all([
      readFile(resolve(request.outputDirectory, "build-report.json"), "utf8"),
      readFile(resolve(request.outputDirectory, "adapter-report.json"), "utf8"),
    ]);
    const report = requireBuildReport(
      parseJson(serializedBuildReport, "Cached build report"),
      request.sourceDigest,
    );
    if (report.output.packageDigest !== restored.packageDigest) {
      throw new TypeError("Cached package digest does not match its manifest.");
    }
    return {
      report,
      adapterReport: parseJson(serializedAdapterReport, "Cached adapter report"),
    };
  } catch (error) {
    console.warn(
      `[naru] cache restore failed (${cacheFailureDetails(error)}); recompiling.`,
    );
    return undefined;
  }
}

function completionOf(report: CompilerBuildReport, cache: string): ImportJobCompletion {
  return {
    packageDigest: report.output.packageDigest,
    cache,
    prototypeCount: report.counts.prototypeCount,
    renderableOccurrenceCount: report.counts.renderableOccurrenceCount,
    triangleCount: report.counts.triangleCount,
  };
}
