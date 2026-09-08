// Argument parsing for the `naru` CLI.
//
// Node's own `parseArgs` owns the tokenizing: which flags take a value, which
// repeat, and what an unknown flag is. What stays here is the part a generic
// parser cannot know -- that `--threads` must be a positive integer, that
// `--document` carries a `name=path` pair, and that a leaf capacity without a
// spatial index is a mistake rather than a default.

import { parseArgs } from "node:util";

export const usage = `Usage:
  naru compile <source.step> --output <directory> [options]
  naru compile-ifc --document <discipline=source.ifc>... --output <directory> [options]

STEP options:
  --python <executable>          Python environment containing CadQuery/OCP
  --cache <directory>           Reuse verified packages by source/toolchain/options
  --linear-tolerance <mm>        Tessellation tolerance (default: 0.15)
  --angular-tolerance <radians>  Angular tolerance (default: 0.15)

IFC options:
  --document <name=path.ifc>     Repeat once per federation discipline
  --uri-hint <name=value>        Optional non-sensitive source label
  --python <executable>          Python environment containing IfcOpenShell
  --cache <directory>            Reuse verified federation packages
  --threads <count>              Geometry iterator threads (default: up to 8)
  --target-chunk-kib <count>     Coalesced target request budget (default: 512)
  --spatial-payload-order        Co-locate target payloads by dominant BVH leaf
  --compact-json                 Omit insignificant scene.gltf whitespace
  --omit-resource-names          Omit mesh/bufferView/accessor display names
  --elide-derived-identifiers    Omit node identities the loader reconstructs
  --omit-default-node-transforms Omit identity matrices; emit pure translations
  --retain-scene-ir              Keep the split intermediate pair under output
  --staged-preview <directory>   Publish each document's tree there as soon as it parses

General options:
  --spatial-index                Emit the optional occurrence demand BVH
  --spatial-leaf-capacity <n>    Maximum occurrences per BVH leaf (default: 64)
  --relocate-hierarchy-nodes     Move mesh-less nodes into a hierarchy sidecar
  --reduced-lod <meters>         Emit a reduced level within this measured deviation
  --json-events                  Write import lifecycle events to stdout as NDJSON
  --help                         Show this help`;

export interface CompileArguments {
  readonly sourcePath: string;
  readonly outputDirectory: string;
  readonly pythonExecutable?: string;
  readonly linearTolerance?: number;
  readonly angularTolerance?: number;
  readonly cacheDirectory?: string;
  readonly spatialIndex: boolean;
  readonly spatialLeafCapacity?: number;
  readonly relocateHierarchyNodes: boolean;
  readonly reducedLodMeters?: number;
  readonly jsonEvents: boolean;
}

export interface IfcCompileArguments {
  readonly documents: readonly {
    readonly discipline: string;
    readonly sourcePath: string;
    readonly uriHint?: string;
  }[];
  readonly outputDirectory: string;
  readonly pythonExecutable?: string;
  readonly threads?: number;
  readonly targetChunkByteBudget?: number;
  readonly cacheDirectory?: string;
  readonly spatialIndex: boolean;
  readonly spatialLeafCapacity?: number;
  readonly spatialPayloadOrder: boolean;
  readonly compactJson: boolean;
  readonly omitResourceNames: boolean;
  readonly elideDerivedIdentifiers: boolean;
  readonly omitDefaultNodeTransforms: boolean;
  readonly relocateHierarchyNodes: boolean;
  readonly reducedLodMeters?: number;
  readonly retainSceneIr: boolean;
  readonly stagedPreviewDirectory?: string;
  readonly jsonEvents: boolean;
}

const sharedOptions = {
  output: { type: "string" },
  python: { type: "string" },
  cache: { type: "string" },
  "spatial-index": { type: "boolean" },
  "spatial-leaf-capacity": { type: "string" },
  "relocate-hierarchy-nodes": { type: "boolean" },
  "reduced-lod": { type: "string" },
  "json-events": { type: "boolean" },
} as const;

const stepOptions = {
  ...sharedOptions,
  "linear-tolerance": { type: "string" },
  "angular-tolerance": { type: "string" },
} as const;

const ifcOptions = {
  ...sharedOptions,
  document: { type: "string", multiple: true },
  "uri-hint": { type: "string", multiple: true },
  threads: { type: "string" },
  "target-chunk-kib": { type: "string" },
  "spatial-payload-order": { type: "boolean" },
  "compact-json": { type: "boolean" },
  "omit-resource-names": { type: "boolean" },
  "elide-derived-identifiers": { type: "boolean" },
  "omit-default-node-transforms": { type: "boolean" },
  "retain-scene-ir": { type: "boolean" },
  "staged-preview": { type: "string" },
} as const;

/**
 * `parseArgs` reports an unknown flag, a value given to a boolean, and an
 * unexpected positional with a precise message; each becomes the same
 * usage-carrying `TypeError` the rest of this module throws.
 */
function tokenize<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new TypeError(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage}`,
      { cause: error },
    );
  }
}

/**
 * `parseArgs` already rejects a dash-leading value as ambiguous and points at
 * `--option=-value` for the deliberate case, so only the empty string is left:
 * it parses cleanly and would name an empty path.
 */
function requireValue(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === "") throw new TypeError(`--${option} requires a value.`);
  return value;
}

function numericOption(value: string | undefined, option: string): number | undefined {
  const text = requireValue(value, option);
  if (text === undefined) return undefined;
  const result = Number(text);
  if (!Number.isFinite(result) || result <= 0) {
    throw new TypeError(`--${option} requires a positive number.`);
  }
  return result;
}

function integerOption(value: string | undefined, option: string): number | undefined {
  const text = requireValue(value, option);
  if (text === undefined) return undefined;
  const result = Number(text);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError(`--${option} requires a positive integer.`);
  }
  return result;
}

function keyValuePairs(
  values: readonly string[] | undefined,
  option: string,
  duplicateMessage: (key: string) => string,
): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const raw of values ?? []) {
    const value = requireValue(raw, option);
    if (value === undefined) continue;
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new TypeError(`--${option} requires a name=value pair.`);
    }
    const key = value.slice(0, separator);
    if (pairs.has(key)) throw new TypeError(duplicateMessage(key));
    pairs.set(key, value.slice(separator + 1));
  }
  return pairs;
}

function assertSpatialDependants(
  spatialIndex: boolean,
  leafCapacity: number | undefined,
  payloadOrder = false,
): void {
  if (leafCapacity !== undefined && !spatialIndex) {
    throw new TypeError(`--spatial-leaf-capacity requires --spatial-index.\n\n${usage}`);
  }
  if (payloadOrder && !spatialIndex) {
    throw new TypeError(`--spatial-payload-order requires --spatial-index.\n\n${usage}`);
  }
}

export function parseCompileArguments(argumentList: readonly string[]): CompileArguments {
  const { values, positionals } = tokenize(() =>
    parseArgs({
      args: [...argumentList],
      options: stepOptions,
      allowPositionals: true,
      strict: true,
    }),
  );

  const [sourcePath, ...extraPositionals] = positionals;
  if (sourcePath === undefined) throw new TypeError(usage);
  if (extraPositionals.length > 0) {
    throw new TypeError(`Unexpected argument ${extraPositionals[0] ?? ""}.\n\n${usage}`);
  }

  const outputDirectory = requireValue(values.output, "output");
  if (outputDirectory === undefined) throw new TypeError(`--output is required.\n\n${usage}`);

  const pythonExecutable = requireValue(values.python, "python");
  const cacheDirectory = requireValue(values.cache, "cache");
  const linearTolerance = numericOption(values["linear-tolerance"], "linear-tolerance");
  const angularTolerance = numericOption(values["angular-tolerance"], "angular-tolerance");
  const spatialIndex = values["spatial-index"] ?? false;
  const reducedLodMeters = numericOption(values["reduced-lod"], "reduced-lod");
  const spatialLeafCapacity = integerOption(
    values["spatial-leaf-capacity"],
    "spatial-leaf-capacity",
  );
  assertSpatialDependants(spatialIndex, spatialLeafCapacity);

  return {
    sourcePath,
    outputDirectory,
    ...(pythonExecutable ? { pythonExecutable } : {}),
    ...(linearTolerance === undefined ? {} : { linearTolerance }),
    ...(angularTolerance === undefined ? {} : { angularTolerance }),
    ...(cacheDirectory ? { cacheDirectory } : {}),
    spatialIndex,
    ...(spatialLeafCapacity === undefined ? {} : { spatialLeafCapacity }),
    relocateHierarchyNodes: values["relocate-hierarchy-nodes"] ?? false,
    ...(reducedLodMeters === undefined ? {} : { reducedLodMeters }),
    jsonEvents: values["json-events"] ?? false,
  };
}

export function parseIfcCompileArguments(
  argumentList: readonly string[],
): IfcCompileArguments {
  const { values } = tokenize(() =>
    parseArgs({
      args: [...argumentList],
      options: ifcOptions,
      allowPositionals: false,
      strict: true,
    }),
  );

  const documents = keyValuePairs(
    values.document,
    "document",
    (discipline) => `Duplicate IFC discipline ${discipline}.`,
  );
  if (documents.size === 0) throw new TypeError(`--document is required.\n\n${usage}`);

  const uriHints = keyValuePairs(
    values["uri-hint"],
    "uri-hint",
    (discipline) => `Duplicate IFC URI hint ${discipline}.`,
  );
  for (const discipline of uriHints.keys()) {
    if (!documents.has(discipline)) {
      throw new TypeError(`URI hint ${discipline} has no matching IFC document.`);
    }
  }

  const outputDirectory = requireValue(values.output, "output");
  if (outputDirectory === undefined) throw new TypeError(`--output is required.\n\n${usage}`);

  const pythonExecutable = requireValue(values.python, "python");
  const cacheDirectory = requireValue(values.cache, "cache");
  const stagedPreviewDirectory = requireValue(values["staged-preview"], "staged-preview");
  const threads = integerOption(values.threads, "threads");
  const targetChunkKib = integerOption(values["target-chunk-kib"], "target-chunk-kib");
  const spatialIndex = values["spatial-index"] ?? false;
  const reducedLodMeters = numericOption(values["reduced-lod"], "reduced-lod");
  const spatialLeafCapacity = integerOption(
    values["spatial-leaf-capacity"],
    "spatial-leaf-capacity",
  );
  const spatialPayloadOrder = values["spatial-payload-order"] ?? false;
  assertSpatialDependants(spatialIndex, spatialLeafCapacity, spatialPayloadOrder);

  return {
    documents: [...documents.entries()].map(([discipline, sourcePath]) => {
      const uriHint = uriHints.get(discipline);
      return {
        discipline,
        sourcePath,
        ...(uriHint === undefined ? {} : { uriHint }),
      };
    }),
    outputDirectory,
    ...(pythonExecutable ? { pythonExecutable } : {}),
    ...(threads === undefined ? {} : { threads }),
    ...(targetChunkKib === undefined ? {} : { targetChunkByteBudget: targetChunkKib * 1024 }),
    ...(cacheDirectory ? { cacheDirectory } : {}),
    spatialIndex,
    ...(spatialLeafCapacity === undefined ? {} : { spatialLeafCapacity }),
    spatialPayloadOrder,
    compactJson: values["compact-json"] ?? false,
    omitResourceNames: values["omit-resource-names"] ?? false,
    elideDerivedIdentifiers: values["elide-derived-identifiers"] ?? false,
    omitDefaultNodeTransforms: values["omit-default-node-transforms"] ?? false,
    relocateHierarchyNodes: values["relocate-hierarchy-nodes"] ?? false,
    ...(reducedLodMeters === undefined ? {} : { reducedLodMeters }),
    retainSceneIr: values["retain-scene-ir"] ?? false,
    ...(stagedPreviewDirectory ? { stagedPreviewDirectory } : {}),
    jsonEvents: values["json-events"] ?? false,
  };
}
