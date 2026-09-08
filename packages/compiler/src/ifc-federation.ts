import { availableParallelism, tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAdapterProcess } from "./adapter-process.js";
import { errorCode } from "./cache-primitives.js";
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
import type { CompileStage } from "./gltf.js";
import { prepareReducedLod } from "./lod/reduce.js";
import { hydrateIfcSceneSplit, ifcSceneSplitEncodingVersion } from "./ifc-scene.js";
import { readIfcStructure } from "./ifc-structure-stream.js";
import {
  StagedPreviewError,
  StagedPreviewWriter,
  watchIfcStructurePreviews,
} from "./staged-preview.js";
import type { StagedPreviewManifest, StagedPreviewPackage } from "./staged-preview.js";
import type { IfcStructureRead } from "./ifc-structure-stream.js";
import { inspectIfcFile } from "./ifc-source.js";
import type { IfcSourceInspection } from "./ifc-source.js";
import {
  createIfcIncrementalDependencyIndex,
  ifcIncrementalDependencyIndexSchema,
  serializeIfcIncrementalDependencyIndex,
} from "./ifc-incremental-dependencies.js";
import type { IfcIncrementalDependencyIndex } from "./ifc-incremental-dependencies.js";
import { writeCompiledPackage } from "./package-output.js";
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
  new URL(
    "../../../native/adapter-ifc/tools/extract_federation_scene_ir.py",
    import.meta.url,
  ),
);
const disciplinePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const defaultIfcTargetChunkByteBudget = 512 * 1024;

export interface IfcFederationDocumentInput {
  readonly discipline: string;
  readonly sourcePath: string;
  readonly uriHint?: string;
}

export interface IfcFederationCompileOptions {
  readonly documents: readonly IfcFederationDocumentInput[];
  readonly outputDirectory: string;
  readonly pythonExecutable?: string;
  readonly adapterScriptPath?: string;
  readonly threads?: number;
  readonly retainSceneIr?: boolean;
  /** Maximum target bytes fetched and decoded in one progressive IFC request. */
  readonly targetChunkByteBudget?: number;
  /** Optional persistent package cache keyed by the complete federation/toolchain identity. */
  readonly cacheDirectory?: string;
  readonly spatialIndex?: boolean;
  readonly spatialLeafCapacity?: number;
  readonly spatialPayloadOrder?: boolean;
  /** Omit insignificant scene.gltf whitespace for real-large packages. */
  readonly compactJson?: boolean;
  /** Omit non-semantic glTF mesh, bufferView, and accessor labels. */
  readonly omitResourceNames?: boolean;
  readonly elideDerivedIdentifiers?: boolean;
  readonly omitDefaultNodeTransforms?: boolean;
  readonly relocateHierarchyNodes?: boolean;
  /** Emit a declared-error `reduced` level (ADR-0025). */
  readonly reducedLodMeters?: number;
  /**
   * Record wall-clock stage durations into the result's `stages`. Timing is
   * diagnostic only: it never enters the adapter report, the build report,
   * the cache key, or the package bytes, so an instrumented compile produces
   * the same package as a plain one.
   */
  readonly stageTiming?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  /** Lifecycle events and cancellation for this compile. */
  readonly job?: ImportJobOptions;
  /**
   * Publish each document's assembly tree into this directory as soon as the
   * adapter has parsed that document, before any tessellation finishes
   * (ADR-0021). The directory must not exist or must be empty; it receives a
   * relocated hierarchy sidecar pair per document plus `staged.json`, is kept
   * with `complete: true` once the compile succeeds, and is removed when the
   * job is cancelled or fails. It is never a compiled package and never a
   * cache tier, and it takes no part in the job id, the cache key, or the
   * package bytes: a compile with staging and one without produce the same
   * package digest.
   */
  readonly stagedPreviewDirectory?: string;
}

export type IfcFederationStageName =
  | "inspectSources"
  | "toolchainIdentity"
  | "cacheLookup"
  | "adapter"
  | "readSceneIr"
  | "hydrate"
  | "compile"
  | "validateCompiled"
  | "dependencyIndex"
  | "writePackage"
  | "writeDependencyIndex"
  | "retainSceneIr"
  | "cachePublish";

export interface IfcAdapterProcessTiming {
  /** Process spawn to the adapter module's first statement (interpreter start). */
  readonly spawnToModuleStartMilliseconds: number;
  /** IfcOpenShell and numpy import cost, measured by the adapter itself. */
  readonly importMilliseconds: number;
  /** Module import end to `main()` start (module-level definitions). */
  readonly importsToMainMilliseconds: number;
  /** `main()` start to the adapter's final stamp (extraction, merge, writes). */
  readonly mainMilliseconds: number;
  /** Final stamp to the process `close` event (interpreter teardown). */
  readonly finishToCloseMilliseconds: number;
  /** The adapter's own `naru.ifc-adapter-stage-timing.1` ledger, verbatim. */
  readonly ledger: unknown;
}

/** Compile sub-stages the timing ledger serializes (pinned by its schema). */
export type LedgerCompileStage = Exclude<CompileStage, "reduceGeometry">;

export interface IfcFederationStageTiming {
  readonly schemaVersion: "naru.ifc-federation-stage-timing.1";
  /** Entry of `compileIfcFederation` to its return; excludes temp-dir cleanup. */
  readonly totalMilliseconds: number;
  readonly stages: Readonly<Record<IfcFederationStageName, number>>;
  /** Milliseconds of `totalMilliseconds` outside every named stage. */
  readonly unattributedMilliseconds: number;
  /** The structure stream scan, one component of `readSceneIr`. */
  readonly structureReadMilliseconds: number;
  /** Sub-stages of `compile`; `other` closes the ledger. */
  readonly compileStages: Readonly<Record<LedgerCompileStage | "other", number>>;
  /** Present when the adapter ran (a package-cache hit skips it). */
  readonly adapter?: IfcAdapterProcessTiming;
}

export interface InspectedIfcFederationDocument extends IfcSourceInspection {
  readonly discipline: string;
  readonly uriHint: string;
}

export interface IfcFederationCompilationResult {
  readonly sources: readonly InspectedIfcFederationDocument[];
  readonly outputDirectory: string;
  readonly report: CompilerBuildReport;
  readonly adapterReport: unknown;
  readonly dependencyIndex: IfcIncrementalDependencyIndex;
  readonly cache: CompilationCacheResult;
  /** Only when `stageTiming` was requested. */
  readonly stages?: IfcFederationStageTiming;
  /** Only when `stagedPreviewDirectory` was requested and the compile rebuilt. */
  readonly stagedPreview?: StagedPreviewManifest;
}

const incrementalDependencyIndexFilename = "incremental-dependencies.json";

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON.`, { cause: error });
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function positiveThreads(value: number | undefined): number {
  const result = value ?? Math.max(1, Math.min(8, availableParallelism()));
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError("IFC adapter threads must be a positive integer.");
  }
  return result;
}

async function inspectDocuments(
  documents: readonly IfcFederationDocumentInput[],
): Promise<readonly InspectedIfcFederationDocument[]> {
  if (documents.length === 0) {
    throw new TypeError("An IFC federation requires at least one document.");
  }
  const disciplines = new Set<string>();
  const paths = new Set<string>();
  const sources = await Promise.all(
    documents.map(async (document) => {
      if (!disciplinePattern.test(document.discipline)) {
        throw new TypeError(`Invalid IFC discipline ${document.discipline}.`);
      }
      if (disciplines.has(document.discipline)) {
        throw new TypeError(`Duplicate IFC discipline ${document.discipline}.`);
      }
      disciplines.add(document.discipline);
      const inspection = await inspectIfcFile(document.sourcePath);
      if (paths.has(inspection.sourcePath)) {
        throw new TypeError(`Duplicate IFC source path ${inspection.sourcePath}.`);
      }
      paths.add(inspection.sourcePath);
      return {
        ...inspection,
        discipline: document.discipline,
        uriHint: document.uriHint ?? basename(inspection.sourcePath),
      };
    }),
  );
  return sources.sort((left, right) => left.discipline.localeCompare(right.discipline, "en"));
}

interface AdapterRun {
  readonly stdout: string;
  /** `Date.now()` immediately before `spawn`, comparable with the adapter's own stamps. */
  readonly spawnedAtMs: number;
  readonly closedAtMs: number;
}

async function runAdapter(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<AdapterRun> {
  return await runAdapterProcess({
    executable,
    arguments: arguments_,
    environment,
    label: "IFC federation adapter",
    startLabel: "IFC adapter",
    missingModule: {
      pattern: /ModuleNotFoundError.*ifcopenshell/su,
      message:
        "The selected Python environment does not provide IfcOpenShell. " +
        "Install native/adapter-ifc/tools/requirements-evidence.txt in that environment.",
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

interface IfcAdapterIdentity {
  readonly schemaVersion: "naru.ifc-adapter-identity.1";
  readonly name: string;
  readonly version: string;
  readonly fingerprint: string;
}

async function inspectAdapterToolchain(
  executable: string,
  adapterScriptPath: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<IfcAdapterIdentity> {
  const { stdout: serialized } = await runAdapter(
    executable,
    [adapterScriptPath, "--identity"],
    environment,
    signal,
  );
  const value = parseJson(serialized.trim(), "IFC adapter identity");
  if (typeof value !== "object" || value === null) {
    throw new TypeError("IFC adapter identity must be an object.");
  }
  const identity = value as Partial<IfcAdapterIdentity>;
  if (
    identity.schemaVersion !== "naru.ifc-adapter-identity.1" ||
    typeof identity.name !== "string" ||
    identity.name === "" ||
    typeof identity.version !== "string" ||
    identity.version === "" ||
    typeof identity.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(identity.fingerprint)
  ) {
    throw new TypeError("IFC adapter returned an invalid cache identity.");
  }
  return identity as IfcAdapterIdentity;
}

function federationCacheInput(
  sources: readonly InspectedIfcFederationDocument[],
  identity: IfcAdapterIdentity,
  compiler: CompiledCacheToolInput,
  threads: number,
  targetChunkByteBudget: number,
  retainSceneIr: boolean,
  options: IfcFederationCompileOptions,
): CompiledCacheKeyInput {
  return {
    sources: sources.map(({ discipline, sha256 }) => ({ scope: discipline, sha256 })),
    adapter: {
      name: identity.name,
      version: `${identity.version}+${identity.fingerprint}`,
    },
    compiler,
    options: {
      threads,
      targetChunkByteBudget,
      retainSceneIr,
      coarseBounds: true,
      spatialIndex: options.spatialIndex === true,
      ...(options.spatialLeafCapacity === undefined
        ? {}
        : { spatialLeafCapacity: options.spatialLeafCapacity }),
      spatialPayloadOrder: options.spatialPayloadOrder === true,
      compactJson: options.compactJson === true,
      ...(options.omitResourceNames === true ? { omitResourceNames: true } : {}),
      ...(options.elideDerivedIdentifiers === true ? { elideDerivedIdentifiers: true } : {}),
      ...(options.omitDefaultNodeTransforms === true
        ? { omitDefaultNodeTransforms: true }
        : {}),
      ...(options.relocateHierarchyNodes === true ? { relocateHierarchyNodes: true } : {}),
      ...(options.reducedLodMeters === undefined ? {} : { reducedLodMeters: options.reducedLodMeters }),
      ...Object.fromEntries(
        sources.map(({ discipline, uriHint }) => [`uriHint.${discipline}`, uriHint]),
      ),
    },
  };
}

function cacheFailureDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireCachedBuildReport(value: unknown, packageDigest: string): CompilerBuildReport {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Cached IFC build report must be an object.");
  }
  const report = value as Partial<CompilerBuildReport>;
  if (report.output?.packageDigest !== packageDigest) {
    throw new TypeError("Cached IFC build report does not match its package manifest.");
  }
  return report as CompilerBuildReport;
}

function requireCachedDependencyIndex(
  value: unknown,
  packageDigest: string,
): IfcIncrementalDependencyIndex {
  const index = asRecord(value, "Cached IFC incremental dependency index");
  const scene = asRecord(index.scene, "Cached IFC incremental dependency scene identity");
  if (
    index.schemaVersion !== ifcIncrementalDependencyIndexSchema ||
    scene.packageDigest !== packageDigest ||
    !Array.isArray(index.documents) ||
    !Array.isArray(index.prototypes)
  ) {
    throw new TypeError("Cached IFC incremental dependency index is incompatible.");
  }
  return index as unknown as IfcIncrementalDependencyIndex;
}

function assertAdapterIdentity(
  adapterReport: unknown,
  sources: readonly InspectedIfcFederationDocument[],
  structure: IfcStructureRead,
  geometry: Buffer,
  properties: Buffer,
): { readonly report: Record<string, unknown>; readonly federationDigest: string } {
  const report = asRecord(adapterReport, "IFC adapter report");
  const expectedSceneEncoding = new Map<string, string>([
    ["madi.ifc-adapter-report.4", "madi.ifc-scene-ir-split.3"],
    ["naru.ifc-adapter-report.5", ifcSceneSplitEncodingVersion],
    ["naru.ifc-adapter-report.6", ifcSceneSplitEncodingVersion],
  ]).get(String(report.schemaVersion));
  if (expectedSceneEncoding === undefined) {
    throw new TypeError("IFC adapter report has an unsupported schema version.");
  }
  if (!Array.isArray(report.sources) || report.sources.length !== sources.length) {
    throw new TypeError("IFC adapter report does not cover every selected source.");
  }
  const reportSources = new Map(
    report.sources.map((value) => {
      const source = asRecord(value, "IFC adapter report source");
      return [source.discipline, source];
    }),
  );
  for (const source of sources) {
    const actual = reportSources.get(source.discipline);
    if (
      actual?.sha256 !== source.sha256 ||
      actual.byteLength !== source.byteLength ||
      actual.schema !== source.schema ||
      actual.path !== source.uriHint
    ) {
      throw new TypeError(`IFC adapter identity mismatch for ${source.discipline}.`);
    }
  }
  if (report.schemaVersion === "naru.ifc-adapter-report.6") {
    const cache = asRecord(
      report.documentArtifactCache,
      "IFC adapter document artifact cache result",
    );
    const hits = cache.hits;
    const misses = cache.misses;
    if (
      cache.schemaVersion !== "naru.ifc-document-artifact.2" ||
      (cache.status !== "enabled" && cache.status !== "disabled") ||
      !Array.isArray(hits) ||
      hits.some((discipline) => typeof discipline !== "string") ||
      !Array.isArray(misses) ||
      misses.some((discipline) => typeof discipline !== "string")
    ) {
      throw new TypeError("IFC adapter returned an invalid document artifact cache result.");
    }
    // Both arrays were just proven to hold only strings.
    const covered = [...(hits as readonly string[]), ...(misses as readonly string[])].sort(
      (left, right) => left.localeCompare(right, "en"),
    );
    const expected = cache.status === "enabled"
      ? sources.map(({ discipline }) => discipline)
      : [];
    if (
      covered.length !== new Set(covered).size ||
      covered.length !== expected.length ||
      covered.some((discipline, index) => discipline !== expected[index])
    ) {
      throw new TypeError("IFC adapter document artifact cache coverage is incomplete.");
    }
  }
  const federation = asRecord(report.federation, "IFC adapter federation identity");
  if (typeof federation.sourceDigest !== "string") {
    throw new TypeError("IFC adapter report is missing its federation digest.");
  }
  const scene = asRecord(report.scene, "IFC adapter scene identity");
  if (scene.encodingVersion !== expectedSceneEncoding) {
    throw new TypeError("IFC adapter scene transport version is unsupported.");
  }
  const structureIdentity = asRecord(scene.structure, "IFC scene structure identity");
  const geometryIdentity = asRecord(scene.geometry, "IFC scene geometry identity");
  const propertiesIdentity = asRecord(scene.properties, "IFC scene properties identity");
  for (const [identity, byteLength, sha256, label] of [
    [structureIdentity, structure.byteLength, structure.sha256, "structure"] as const,
    [
      geometryIdentity,
      geometry.byteLength,
      createHash("sha256").update(geometry).digest("hex"),
      "geometry",
    ] as const,
    [
      propertiesIdentity,
      properties.byteLength,
      createHash("sha256").update(properties).digest("hex"),
      "properties",
    ] as const,
  ]) {
    if (identity.byteLength !== byteLength || identity.sha256 !== sha256) {
      throw new TypeError(`IFC adapter ${label} digest does not match its report.`);
    }
  }
  return { report, federationDigest: federation.sourceDigest };
}

const federationStageNames: readonly IfcFederationStageName[] = [
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

class StageLedger {
  private readonly startedAt = performance.now();
  private readonly durations = new Map<IfcFederationStageName, number>();
  structureReadMilliseconds = 0;
  /** Ledger keys are pinned by `naru.ifc-federation-stage-timing.1`; `reduceGeometry` folds into `other`. */
  readonly compileStages: Record<LedgerCompileStage, number> = {
    validateScene: 0,
    encodeGeometry: 0,
    measureDocument: 0,
  };
  adapter: IfcAdapterProcessTiming | undefined;

  async time<T>(stage: IfcFederationStageName, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.record(stage, performance.now() - started);
    }
  }

  timeSync<T>(stage: IfcFederationStageName, work: () => T): T {
    const started = performance.now();
    try {
      return work();
    } finally {
      this.record(stage, performance.now() - started);
    }
  }

  finish(): IfcFederationStageTiming {
    const totalMilliseconds = performance.now() - this.startedAt;
    const stages = Object.fromEntries(
      federationStageNames.map((stage) => [stage, this.durations.get(stage) ?? 0]),
    ) as Record<IfcFederationStageName, number>;
    const attributed = federationStageNames.reduce((sum, stage) => sum + stages[stage], 0);
    const compileSubStages =
      this.compileStages.validateScene +
      this.compileStages.encodeGeometry +
      this.compileStages.measureDocument;
    return {
      schemaVersion: "naru.ifc-federation-stage-timing.1",
      totalMilliseconds,
      stages,
      unattributedMilliseconds: totalMilliseconds - attributed,
      structureReadMilliseconds: this.structureReadMilliseconds,
      compileStages: { ...this.compileStages, other: stages.compile - compileSubStages },
      ...(this.adapter ? { adapter: this.adapter } : {}),
    };
  }

  private record(stage: IfcFederationStageName, milliseconds: number): void {
    this.durations.set(stage, (this.durations.get(stage) ?? 0) + milliseconds);
  }
}

/** The package handoff a staged manifest carries: document, digest, and every resource. */
function stagedPackageHandoff(report: CompilerBuildReport): StagedPreviewPackage {
  return {
    documentUri: "scene.gltf",
    packageDigest: report.output.packageDigest,
    resources: report.output.resources.map((resource) => ({
      uri: resource.path,
      byteLength: resource.bytes,
      sha256: resource.sha256,
    })),
  };
}

async function stage<T>(
  ledger: StageLedger | undefined,
  name: IfcFederationStageName,
  work: () => Promise<T>,
): Promise<T> {
  return ledger ? await ledger.time(name, work) : await work();
}

function stageSync<T>(
  ledger: StageLedger | undefined,
  name: IfcFederationStageName,
  work: () => T,
): T {
  return ledger ? ledger.timeSync(name, work) : work();
}

interface AdapterWallClock {
  readonly moduleStartedAtMs: number;
  readonly importsFinishedAtMs: number;
  readonly mainStartedAtMs: number;
  readonly finishedAtMs: number;
}

async function readAdapterTiming(path: string, run: AdapterRun): Promise<IfcAdapterProcessTiming> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    throw new TypeError("The IFC adapter did not write the requested stage-timing ledger.", {
      cause: error,
    });
  }
  const ledger = parseJson(serialized, "IFC adapter stage timing") as {
    schemaVersion?: unknown;
    wallClock?: Partial<Record<keyof AdapterWallClock, unknown>>;
    importMilliseconds?: unknown;
  };
  const wallClock = ledger.wallClock;
  const isMs = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  if (
    ledger.schemaVersion !== "naru.ifc-adapter-stage-timing.1" ||
    !wallClock ||
    !isMs(wallClock.moduleStartedAtMs) ||
    !isMs(wallClock.importsFinishedAtMs) ||
    !isMs(wallClock.mainStartedAtMs) ||
    !isMs(wallClock.finishedAtMs) ||
    !isMs(ledger.importMilliseconds)
  ) {
    throw new TypeError("IFC adapter stage timing ledger has an unexpected shape.");
  }
  return {
    spawnToModuleStartMilliseconds: wallClock.moduleStartedAtMs - run.spawnedAtMs,
    importMilliseconds: ledger.importMilliseconds,
    importsToMainMilliseconds: wallClock.mainStartedAtMs - wallClock.importsFinishedAtMs,
    mainMilliseconds: wallClock.finishedAtMs - wallClock.mainStartedAtMs,
    finishToCloseMilliseconds: run.closedAtMs - wallClock.finishedAtMs,
    ledger,
  };
}

interface RestoredFederationPackage {
  readonly report: CompilerBuildReport;
  readonly adapterReport: unknown;
  readonly dependencyIndex: IfcIncrementalDependencyIndex;
}

/**
 * Restores a cache entry and cross-checks it, or returns undefined so the
 * caller rebuilds. Verification lives here, ahead of any lifecycle event, so a
 * rejected entry costs the host a warning rather than a state it cannot leave.
 */
async function restoreVerifiedFederationPackage(request: {
  readonly cacheDirectory: string;
  readonly key: string;
  readonly outputDirectory: string;
  readonly ledger: StageLedger | undefined;
}): Promise<RestoredFederationPackage | undefined> {
  try {
    const restored = await stage(request.ledger, "cacheLookup", () =>
      restoreCompiledCacheEntry({
        cacheDirectory: request.cacheDirectory,
        key: request.key,
        outputDirectory: request.outputDirectory,
      }),
    );
    if (!restored) return undefined;
    const [serializedBuildReport, serializedAdapterReport, serializedDependencyIndex] =
      await Promise.all([
        readFile(resolve(request.outputDirectory, "build-report.json"), "utf8"),
        readFile(resolve(request.outputDirectory, "adapter-report.json"), "utf8"),
        readFile(
          resolve(request.outputDirectory, incrementalDependencyIndexFilename),
          "utf8",
        ),
      ]);
    const report = requireCachedBuildReport(
      parseJson(serializedBuildReport, "Cached IFC build report"),
      restored.packageDigest,
    );
    return {
      report,
      adapterReport: parseJson(serializedAdapterReport, "Cached IFC adapter report"),
      dependencyIndex: requireCachedDependencyIndex(
        parseJson(serializedDependencyIndex, "Cached IFC incremental dependency index"),
        report.output.packageDigest,
      ),
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

/**
 * Compiles an IFC federation into a package directory.
 *
 * The lifecycle a caller can observe is described by `options.job`. Nothing
 * about the compiled result depends on it: a job with no listener and no signal
 * behaves exactly as this function did before it had one.
 */
export async function compileIfcFederation(
  options: IfcFederationCompileOptions,
): Promise<IfcFederationCompilationResult> {
  const reporter = createImportJobReporter(
    {
      kind: "ifc-federation",
      sources: options.documents.map(({ sourcePath }) => sourcePath),
      outputDirectory: options.outputDirectory,
      options: {
        threads: options.threads,
        targetChunkByteBudget: options.targetChunkByteBudget,
        retainSceneIr: options.retainSceneIr,
        spatialIndex: options.spatialIndex,
        spatialLeafCapacity: options.spatialLeafCapacity,
        spatialPayloadOrder: options.spatialPayloadOrder,
        compactJson: options.compactJson,
        omitResourceNames: options.omitResourceNames,
        elideDerivedIdentifiers: options.elideDerivedIdentifiers,
        omitDefaultNodeTransforms: options.omitDefaultNodeTransforms,
        relocateHierarchyNodes: options.relocateHierarchyNodes,
        reducedLodMeters: options.reducedLodMeters,
      },
    },
    options.job,
    options.cacheDirectory === undefined ? [] : [options.cacheDirectory],
  );
  try {
    return await runIfcFederationCompile(options, reporter);
  } catch (error) {
    throw await settleImportJobFailure(reporter, error, [
      ...options.documents.map(({ sourcePath }) => sourcePath),
      options.outputDirectory,
      ...(options.cacheDirectory === undefined ? [] : [options.cacheDirectory]),
      ...(options.stagedPreviewDirectory === undefined ? [] : [options.stagedPreviewDirectory]),
    ]);
  }
}

async function runIfcFederationCompile(
  options: IfcFederationCompileOptions,
  reporter: ImportJobReporter,
): Promise<IfcFederationCompilationResult> {
  const signal = options.job?.signal;
  const ledger = options.stageTiming === true ? new StageLedger() : undefined;
  reporter.enter("queued");
  reporter.enter("inspecting");
  const sources = await stage(ledger, "inspectSources", () =>
    inspectDocuments(options.documents),
  );
  reporter.describeDocuments(
    sources.map((source) => ({
      discipline: source.discipline,
      sha256: source.sha256,
      byteLength: source.byteLength,
    })),
  );
  const threads = positiveThreads(options.threads);
  const outputDirectory = resolve(options.outputDirectory);
  const targetChunkByteBudget =
    options.targetChunkByteBudget ?? defaultIfcTargetChunkByteBudget;
  const retainSceneIr = options.retainSceneIr === true;
  const pythonExecutable =
    options.pythonExecutable ??
    process.env.NARU_IFC_PYTHON ??
    process.env.NARU_PYTHON ??
    (process.platform === "win32" ? "python" : "python3");
  const adapterScriptPath = resolve(options.adapterScriptPath ?? defaultAdapterScript);
  const environment = options.environment ?? process.env;
  let cacheKeyInput: CompiledCacheKeyInput | undefined;
  let cacheKey: string | undefined;
  const { adapterToolchain, compiler } = await stage(ledger, "toolchainIdentity", async () => {
    const toolchain = options.cacheDirectory
      ? await inspectAdapterToolchain(
          pythonExecutable,
          adapterScriptPath,
          environment,
          signal,
        )
      : undefined;
    return {
      adapterToolchain: toolchain,
      compiler: toolchain ? await currentCompilerCacheIdentity() : undefined,
    };
  });
  if (options.cacheDirectory && adapterToolchain && compiler) {
    cacheKeyInput = federationCacheInput(
      sources,
      adapterToolchain,
      compiler,
      threads,
      targetChunkByteBudget,
      retainSceneIr,
      options,
    );
    cacheKey = createCompiledCacheKey(cacheKeyInput);
    const restored = await restoreVerifiedFederationPackage({
      cacheDirectory: options.cacheDirectory,
      key: cacheKey,
      outputDirectory,
      ledger,
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
        sources,
        outputDirectory,
        report: restored.report,
        dependencyIndex: restored.dependencyIndex,
        adapterReport: restored.adapterReport,
        cache: { status: "hit", key: cacheKey },
        ...(ledger ? { stages: ledger.finish() } : {}),
      };
    }
  }
  reporter.settlePlan("rebuild");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "naru-ifc-"));
  reporter.registerTemporaryDirectory(temporaryDirectory);
  const stagedWriter =
    options.stagedPreviewDirectory === undefined
      ? undefined
      : await openStagedPreview(options.stagedPreviewDirectory, reporter, sources);
  const previewDirectory = join(temporaryDirectory, "structure-preview");
  const scenePath = join(temporaryDirectory, "scene-ir.json");
  const geometryPath = join(temporaryDirectory, "scene-ir-geometry.bin");
  const propertiesPath = join(temporaryDirectory, "scene-ir-properties.bin");
  const adapterReportPath = join(temporaryDirectory, "adapter-report.json");
  const stageTimingPath = join(temporaryDirectory, "stage-timing.json");
  try {
    const sourceArguments = sources.flatMap((source) => [
      "--document",
      `${source.discipline}=${source.sourcePath}`,
      "--uri-hint",
      `${source.discipline}=${source.uriHint}`,
    ]);
    reporter.enter("extracting");
    const adapterArguments = [
      adapterScriptPath,
      ...sourceArguments,
      "--scene",
      scenePath,
      "--geometry",
      geometryPath,
      "--properties",
      propertiesPath,
      "--report",
      adapterReportPath,
      ...(options.cacheDirectory
        ? ["--document-cache", resolve(options.cacheDirectory, "ifc-documents")]
        : []),
      "--threads",
      String(threads),
      ...(ledger ? ["--stage-timing", stageTimingPath] : []),
      ...(stagedWriter ? ["--structure-preview", previewDirectory] : []),
    ];
    const adapterRun = await stage(ledger, "adapter", () =>
      stagedWriter
        ? runAdapterWithStagedPreviews({
            run: (adapterSignal) =>
              runAdapter(pythonExecutable, adapterArguments, environment, adapterSignal),
            previewDirectory,
            sources,
            writer: stagedWriter,
            reporter,
            signal,
          })
        : runAdapter(pythonExecutable, adapterArguments, environment, signal),
    );
    if (ledger) ledger.adapter = await readAdapterTiming(stageTimingPath, adapterRun);
    reporter.enter("compiling");
    // The structure document is never read or parsed as one string: the
    // streaming reader parses it record by record and hashes it on the way
    // through. Before property indexing (`madi.ifc-scene-ir-split.2`) a
    // real-large federation reached 632 MB against V8's 536,870,888-code-unit
    // string limit, and the reader keeps the compiler safe if a future
    // federation crosses it again.
    const [structure, geometry, properties, serializedAdapterReport] = await stage(
      ledger,
      "readSceneIr",
      () =>
        Promise.all([
          ledger
            ? (async () => {
                const started = performance.now();
                try {
                  return await readIfcStructure(scenePath);
                } finally {
                  ledger.structureReadMilliseconds = performance.now() - started;
                }
              })()
            : readIfcStructure(scenePath),
          readFile(geometryPath),
          readFile(propertiesPath),
          readFile(adapterReportPath, "utf8"),
        ]),
    );
    const parsedAdapterReport = parseJson(serializedAdapterReport, "IFC adapter report");
    const identity = assertAdapterIdentity(
      parsedAdapterReport,
      sources,
      structure,
      geometry,
      properties,
    );
    const scene = stageSync(ledger, "hydrate", () =>
      hydrateIfcSceneSplit(structure.value, geometry, properties),
    );
    if (scene.revision.sourceDigest !== `sha256:${identity.federationDigest}`) {
      throw new TypeError("IFC Scene IR federation digest does not match the adapter report.");
    }
    const sceneDocumentDigests = new Set(
      scene.documents.map((document) => document.sourceDigest),
    );
    for (const source of sources) {
      if (!sceneDocumentDigests.has(`sha256:${source.sha256}`)) {
        throw new TypeError(`IFC Scene IR is missing source ${source.discipline}.`);
      }
    }

    const compileOptions: CompileGltfOptions = {
      coarseBounds: true,
      generator: "MADI compiler 0.0.0 / IfcOpenShell federation slice",
      targetChunkByteBudget,
      ...(options.spatialIndex === true ? { spatialIndex: true } : {}),
      ...(options.spatialLeafCapacity === undefined
        ? {}
        : { spatialLeafCapacity: options.spatialLeafCapacity }),
      ...(options.spatialPayloadOrder === true ? { spatialPayloadOrder: true } : {}),
      ...(options.compactJson === true ? { compactJson: true } : {}),
      ...(options.omitResourceNames === true ? { omitResourceNames: true } : {}),
      ...(options.elideDerivedIdentifiers === true ? { elideDerivedIdentifiers: true } : {}),
      ...(options.omitDefaultNodeTransforms === true
        ? { omitDefaultNodeTransforms: true }
        : {}),
      ...(options.relocateHierarchyNodes === true ? { relocateHierarchyNodes: true } : {}),
      ...(options.reducedLodMeters === undefined
        ? {}
        : { reducedLod: { maxDeviationMeters: options.reducedLodMeters } }),
      // The package carries the adapter's value column file byte-verbatim as
      // a lazy property sidecar; the compiler still never materializes a
      // property value.
      propertyColumns: properties,
    };
    if (compileOptions.reducedLod) await prepareReducedLod();
    const compiled = stageSync(ledger, "compile", () =>
      compileSceneToGltf(
        scene,
        compileOptions,
        ledger
          ? (compileStage, milliseconds) => {
              if (compileStage !== "reduceGeometry") ledger.compileStages[compileStage] += milliseconds;
            }
          : undefined,
      ),
    );
    reporter.enter("verifying");
    const validation = stageSync(ledger, "validateCompiled", () =>
      validateCompiledGltf(
        compiled.document,
        compiled.coarseBinary
          ? [compiled.binary, compiled.coarseBinary]
          : compiled.binary,
      ),
    );
    if (!validation.ok) {
      throw new TypeError(
        `Compiled IFC glTF validation failed: ${validation.issues
          .slice(0, 5)
          .map(({ code, path }) => `${code} at ${path}`)
          .join(", ")}`,
      );
    }

    const adapterReport = {
      ...identity.report,
      // Derived from the validation `compileSceneToGltf` already ran (it
      // throws before reaching this point when the scene does not validate),
      // so the scene is no longer validated twice.
      sceneIrValidation: {
        ok: true,
        errorCount: 0,
        warningCount: compiled.sceneValidation.issues.filter(
          ({ severity }) => severity === "warning",
        ).length,
      },
    };
    const dependencyIndex = stageSync(ledger, "dependencyIndex", () =>
      createIfcIncrementalDependencyIndex(
        scene,
        sources,
        compiled.document,
        compiled.report.output.packageDigest,
      ),
    );
    // Publication is uninterruptible: everything from here writes the durable
    // result, and a cancel observed midway is the one way to leave a partly
    // written package behind.
    reporter.enter("publishing");
    await stage(ledger, "writePackage", async () => {
      await writeCompiledPackage(compiled, outputDirectory, adapterReport);
      // The handoff is the last write of the stage: a reader that finds it in
      // `staged.json` finds every resource it names already on disk.
      if (stagedWriter) {
        await stagedWriter.publishPackage(stagedPackageHandoff(compiled.report));
      }
    });
    await stage(ledger, "writeDependencyIndex", () =>
      writeFile(
        resolve(outputDirectory, incrementalDependencyIndexFilename),
        serializeIfcIncrementalDependencyIndex(dependencyIndex),
        "utf8",
      ),
    );
    if (retainSceneIr) {
      await stage(ledger, "retainSceneIr", () =>
        Promise.all([
          copyFile(scenePath, resolve(outputDirectory, "scene-ir.json")),
          copyFile(geometryPath, resolve(outputDirectory, "scene-ir-geometry.bin")),
          copyFile(propertiesPath, resolve(outputDirectory, "scene-ir-properties.bin")),
        ]),
      );
    }
    if (cacheKeyInput && cacheKey) {
      const publishInput = cacheKeyInput;
      try {
        await stage(ledger, "cachePublish", () =>
          publishCompiledCacheEntry({
            cacheDirectory: options.cacheDirectory as string,
            packageDirectory: outputDirectory,
            input: publishInput,
            packageDigest: compiled.report.output.packageDigest,
            resourcePaths: [
              ...compiled.report.output.resources.map(({ path }) => path),
              "adapter-report.json",
              "build-report.json",
              incrementalDependencyIndexFilename,
              ...(retainSceneIr
                ? ["scene-ir.json", "scene-ir-geometry.bin", "scene-ir-properties.bin"]
                : []),
            ],
          }),
        );
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
    reporter.completed(
      completionOf(compiled.report, cacheKey ? "miss" : "disabled"),
    );
    return {
      sources,
      outputDirectory,
      report: compiled.report,
      adapterReport,
      dependencyIndex,
      cache: cacheKey ? { status: "miss", key: cacheKey } : { status: "disabled" },
      ...(ledger ? { stages: ledger.finish() } : {}),
      ...(stagedWriter ? { stagedPreview: stagedWriter.manifest() } : {}),
    };
  } catch (error) {
    // A staged directory only ever outlives a compile that completed: on any
    // other exit it is removed, whether the reporter's cancellation path has
    // already done so or not (issue #73 criterion 5).
    if (stagedWriter) {
      await rm(stagedWriter.directory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Opens the staged preview directory for a rebuild. An existing directory is
 * accepted only when it is empty: the compile registers it for removal on
 * cancellation, and it never deletes bytes it did not write.
 */
async function openStagedPreview(
  directory: string,
  reporter: ImportJobReporter,
  sources: readonly InspectedIfcFederationDocument[],
): Promise<StagedPreviewWriter> {
  const resolved = resolve(directory);
  let existing: string[] = [];
  try {
    existing = await readdir(resolved);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (existing.length > 0) {
    throw new StagedPreviewError(
      "The staged preview directory must not exist or must be empty; refusing to publish into one that holds files.",
    );
  }
  reporter.registerTemporaryDirectory(resolved);
  return await StagedPreviewWriter.open({
    directory: resolved,
    jobId: reporter.jobId,
    disciplines: sources.map((source) => source.discipline),
  });
}

/**
 * Runs the adapter while a watcher turns each tree it publishes into a
 * verified staged sidecar pair and a `staged` job event. The watcher owns an
 * abort controller for the adapter: a tree that fails verification, or a
 * cancellation surfacing through `reporter.staged`, stops the adapter tree
 * the same way the caller's signal would, and the watcher's error wins over
 * the adapter's resulting exit error. The watcher reads the index once more
 * after the adapter exits, so nothing published just before exit is lost,
 * and `complete()` refuses an adapter that exited without every document.
 */
async function runAdapterWithStagedPreviews(request: {
  readonly run: (signal: AbortSignal) => Promise<AdapterRun>;
  readonly previewDirectory: string;
  readonly sources: readonly InspectedIfcFederationDocument[];
  readonly writer: StagedPreviewWriter;
  readonly reporter: ImportJobReporter;
  readonly signal: AbortSignal | undefined;
}): Promise<AdapterRun> {
  const { run, previewDirectory, sources, writer, reporter, signal } = request;
  const controller = new AbortController();
  const forward = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  let watchError: Error | undefined;
  try {
    const adapter = run(controller.signal);
    const watch = watchIfcStructurePreviews({
      directory: previewDirectory,
      sources: sources.map(({ discipline, sha256, byteLength }) => ({
        discipline,
        sha256,
        byteLength,
      })),
      until: adapter.then(
        () => undefined,
        () => undefined,
      ),
      onPreview: async (preview) => {
        reporter.staged(await writer.stage(preview));
      },
    }).catch((error: unknown) => {
      watchError = error instanceof Error ? error : new Error(String(error));
      controller.abort(error);
    });
    let adapterRun: AdapterRun;
    try {
      adapterRun = await adapter;
    } catch (error) {
      await watch;
      throw watchError ?? error;
    }
    await watch;
    if (watchError !== undefined) throw watchError;
    await writer.complete();
    return adapterRun;
  } finally {
    signal?.removeEventListener("abort", forward);
  }
}
