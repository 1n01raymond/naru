import { assertPackageUrl, decodePackageHierarchy, openPackageTransport, packageResourceDigest } from "@naru3d/runtime-webgpu";
import type {
  CompiledHierarchyEntry,
  PackageFetch,
  PackageHierarchyEntry,
  PackageTransport,
} from "@naru3d/runtime-webgpu";

/**
 * The Studio's view of a staged import: the `staged.json` manifest an
 * `naru compile-ifc --staged-preview` run rewrites after every document, the
 * per-document hierarchy sidecars it names, and the package handoff it ends on.
 *
 * The compiler owns the format (`packages/compiler/src/staged-preview.ts`); the
 * Studio cannot depend on the compiler in the browser bundle, so the parser here
 * mirrors it field for field and fails closed on anything it does not recognise.
 */
export const stagedImportPreviewSchema = "naru.staged-import-preview.2";
export const stagedImportManifestFilename = "staged.json";

/** How often the manifest is polled while the compile is still running. */
export const defaultStagedImportPollMs = 500;

export interface StagedImportHierarchyRef {
  readonly uri: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly columnsUri: string;
  readonly columnsByteLength: number;
  readonly columnsSha256: string;
}

export interface StagedImportDocument {
  readonly discipline: string;
  readonly uriHint: string;
  readonly documentId: string;
  readonly schema: string;
  readonly sourceDigest: string;
  readonly sourceBytes: number;
  readonly nodeCount: number;
  readonly rootCount: number;
  readonly hierarchy: StagedImportHierarchyRef;
}

export interface StagedImportResource {
  readonly uri: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface StagedImportPackage {
  readonly documentUri: string;
  readonly packageDigest: string;
  readonly resources: readonly StagedImportResource[];
}

export interface StagedImportManifest {
  readonly schemaVersion: typeof stagedImportPreviewSchema;
  readonly jobId: string;
  readonly kind: "ifc-federation";
  readonly disciplines: readonly string[];
  readonly documents: readonly StagedImportDocument[];
  readonly stagedCount: number;
  readonly totalCount: number;
  readonly complete: boolean;
  readonly package?: StagedImportPackage;
}

export type StagedImportErrorCode = "INVALID_STAGED_IMPORT" | "UNSUPPORTED_STAGED_IMPORT";

export class StagedImportError extends Error {
  readonly code: StagedImportErrorCode;

  constructor(code: StagedImportErrorCode, message: string) {
    super(message);
    this.name = "StagedImportError";
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new StagedImportError("INVALID_STAGED_IMPORT", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sha256Pattern = /^[0-9a-f]{64}$/u;
const disciplinePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function stringAt(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") invalid(`${label}.${key} must be a non-empty string.`);
  return value;
}

function countAt(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(`${label}.${key} must be a non-negative integer.`);
  }
  return value;
}

function digestAt(record: Record<string, unknown>, key: string, label: string): string {
  const value = stringAt(record, key, label);
  if (!sha256Pattern.test(value)) invalid(`${label}.${key} must be a lowercase SHA-256 hex digest.`);
  return value;
}

/**
 * A sidecar URI is a bare file name beside the manifest. Anything with a path
 * separator, a parent reference, a scheme, or a query would let a manifest
 * point the Studio outside the staged directory it was opened on.
 */
function fileNameAt(record: Record<string, unknown>, key: string, label: string): string {
  const value = stringAt(record, key, label);
  if (
    value.includes("/") ||
    value.includes(":") ||
    value.includes("?") ||
    value.includes("#") ||
    value === "." ||
    value === ".." ||
    value.startsWith(".")
  ) {
    invalid(`${label}.${key} must be a plain file name beside the manifest.`);
  }
  return value;
}

function parseHierarchyRef(value: unknown, label: string): StagedImportHierarchyRef {
  if (!isRecord(value)) invalid(`${label} must be an object.`);
  return {
    uri: fileNameAt(value, "uri", label),
    byteLength: countAt(value, "byteLength", label),
    sha256: digestAt(value, "sha256", label),
    columnsUri: fileNameAt(value, "columnsUri", label),
    columnsByteLength: countAt(value, "columnsByteLength", label),
    columnsSha256: digestAt(value, "columnsSha256", label),
  };
}

function parseDocument(value: unknown, index: number): StagedImportDocument {
  const label = `documents[${index}]`;
  if (!isRecord(value)) invalid(`${label} must be an object.`);
  const discipline = stringAt(value, "discipline", label);
  if (!disciplinePattern.test(discipline)) invalid(`${label}.discipline must be a lowercase kebab-case label.`);
  const nodeCount = countAt(value, "nodeCount", label);
  const rootCount = countAt(value, "rootCount", label);
  if (rootCount > nodeCount) invalid(`${label}.rootCount cannot exceed nodeCount.`);
  if (nodeCount > 0 && rootCount === 0) invalid(`${label} stages ${nodeCount} nodes without a root.`);
  return {
    discipline,
    uriHint: stringAt(value, "uriHint", label),
    documentId: stringAt(value, "documentId", label),
    schema: stringAt(value, "schema", label),
    sourceDigest: digestAt(value, "sourceDigest", label),
    sourceBytes: countAt(value, "sourceBytes", label),
    nodeCount,
    rootCount,
    hierarchy: parseHierarchyRef(value["hierarchy"], `${label}.hierarchy`),
  };
}

function parsePackage(value: unknown): StagedImportPackage {
  const label = "package";
  if (!isRecord(value)) invalid(`${label} must be an object.`);
  const documentUri = fileNameAt(value, "documentUri", label);
  const packageDigest = digestAt(value, "packageDigest", label);
  const rawResources = value["resources"];
  if (!Array.isArray(rawResources) || rawResources.length === 0) invalid(`${label}.resources must be a non-empty array.`);
  const resources = rawResources.map((resource, index) => {
    const resourceLabel = `${label}.resources[${index}]`;
    if (!isRecord(resource)) invalid(`${resourceLabel} must be an object.`);
    return {
      uri: fileNameAt(resource, "uri", resourceLabel),
      byteLength: countAt(resource, "byteLength", resourceLabel),
      sha256: digestAt(resource, "sha256", resourceLabel),
    };
  });
  if (new Set(resources.map((resource) => resource.uri)).size !== resources.length) {
    invalid(`${label}.resources must not repeat a uri.`);
  }
  if (!resources.some((resource) => resource.uri === documentUri)) {
    invalid(`${label}.documentUri ${documentUri} is not among the package resources.`);
  }
  return { documentUri, packageDigest, resources };
}

/**
 * Parses a `staged.json` manifest. Fails closed: an unknown schema, a count
 * that does not add up, a discipline outside the declared set, a sidecar URI
 * that could leave the directory, or a package handoff before completion all
 * throw a {@link StagedImportError}.
 */
export function parseStagedImportManifest(value: unknown): StagedImportManifest {
  if (!isRecord(value)) invalid("A staged import manifest must be an object.");
  const schemaVersion = value["schemaVersion"];
  if (schemaVersion !== stagedImportPreviewSchema) {
    throw new StagedImportError(
      "UNSUPPORTED_STAGED_IMPORT",
      `Unsupported staged import manifest ${String(schemaVersion)}; expected ${stagedImportPreviewSchema}.`,
    );
  }
  const jobId = stringAt(value, "jobId", "manifest");
  if (value["kind"] !== "ifc-federation") invalid("manifest.kind must be ifc-federation.");
  const rawDisciplines = value["disciplines"];
  if (!Array.isArray(rawDisciplines) || rawDisciplines.length === 0) invalid("manifest.disciplines must be a non-empty array.");
  const disciplines = rawDisciplines.map((discipline, index) => {
    if (typeof discipline !== "string" || !disciplinePattern.test(discipline)) {
      invalid(`manifest.disciplines[${index}] must be a lowercase kebab-case label.`);
    }
    if (index > 0 && discipline <= (rawDisciplines[index - 1] as string)) {
      invalid("manifest.disciplines must be sorted and distinct.");
    }
    return discipline;
  });
  const rawDocuments = value["documents"];
  if (!Array.isArray(rawDocuments)) invalid("manifest.documents must be an array.");
  const documents = rawDocuments.map((document, index) => parseDocument(document, index));
  const seen = new Set<string>();
  for (const document of documents) {
    if (!disciplines.includes(document.discipline)) {
      invalid(`documents stage ${document.discipline}, which manifest.disciplines does not declare.`);
    }
    if (seen.has(document.discipline)) invalid(`documents stage ${document.discipline} twice.`);
    seen.add(document.discipline);
  }
  const stagedCount = countAt(value, "stagedCount", "manifest");
  const totalCount = countAt(value, "totalCount", "manifest");
  if (totalCount !== disciplines.length) invalid("manifest.totalCount must equal the number of disciplines.");
  if (stagedCount !== documents.length) invalid("manifest.stagedCount must equal the number of staged documents.");
  const complete = value["complete"];
  if (typeof complete !== "boolean") invalid("manifest.complete must be a boolean.");
  // The writer stages the last document (counts equal, complete still false)
  // and only then marks completion, so the rule holds in one direction.
  if (complete && stagedCount !== totalCount) invalid("manifest.complete disagrees with the staged counts.");
  const rawPackage = value["package"];
  const manifest: StagedImportManifest = {
    schemaVersion: stagedImportPreviewSchema,
    jobId,
    kind: "ifc-federation",
    disciplines,
    documents,
    stagedCount,
    totalCount,
    complete,
  };
  if (rawPackage === undefined) return manifest;
  if (!complete) invalid("manifest.package cannot precede completion.");
  return { ...manifest, package: parsePackage(rawPackage) };
}

/** A decoded, verified per-document tree the session hands to the Studio. */
export interface StagedImportTree {
  readonly document: StagedImportDocument;
  readonly entries: readonly PackageHierarchyEntry[];
  /** Milliseconds on the caller's clock when the tree became usable. */
  readonly readyAt: number;
}

/**
 * Checks that the package the manifest hands off is the one the Studio was
 * asked to open. The manifest names its document relative to the package
 * directory, which the staged directory does not know, so the caller supplies
 * the scene URL it was booted with and the check is by file name.
 */
export function assertStagedPackageMatches(sceneUrl: URL, handoff: StagedImportPackage): void {
  assertPackageUrl(sceneUrl, "staged package");
  const fileName = sceneUrl.pathname.slice(sceneUrl.pathname.lastIndexOf("/") + 1);
  if (fileName !== handoff.documentUri) {
    invalid(`The staged package hands off ${handoff.documentUri} but the Studio was asked to open ${fileName}.`);
  }
}

function documentRowName(document: StagedImportDocument): string {
  const hint = document.uriHint.slice(document.uriHint.lastIndexOf("/") + 1);
  return hint === "" ? document.discipline : `${document.discipline} · ${hint}`;
}

/**
 * Flattens the staged trees into the hierarchy-list entry shape the Studio's
 * search index and list view already consume. Each document contributes one
 * synthetic root row followed by its tree, so a partially staged federation
 * reads as a forest that grows as documents arrive. Node indexes are positions
 * in the returned list and restart from zero on every rebuild.
 */
export function stagedHierarchyEntries(trees: readonly StagedImportTree[]): CompiledHierarchyEntry[] {
  const entries: CompiledHierarchyEntry[] = [];
  for (const tree of trees) {
    entries.push({
      nodeIndex: entries.length,
      name: documentRowName(tree.document),
      depth: 0,
      renderable: false,
      occurrenceId: `staged:${tree.document.discipline}`,
      prototypeId: "preview:ifc:document",
    });
    for (const entry of tree.entries) {
      const relocated = entry.relocated;
      if (relocated === undefined) {
        invalid(`Staged tree ${tree.document.discipline} carries a document-node reference; staged trees are fully relocated.`);
      }
      entries.push({
        nodeIndex: entries.length,
        name: relocated.name,
        depth: entry.depth + 1,
        renderable: false,
        occurrenceId: relocated.occurrenceId,
        prototypeId: relocated.prototypeId,
      });
    }
  }
  return entries;
}

export interface StagedImportCallbacks {
  /** Every manifest the poll accepted, in arrival order, including repeats. */
  onManifest?: (manifest: StagedImportManifest) => void;
  /** A document's tree, decoded and verified, in emission order. */
  onTree?: (tree: StagedImportTree, trees: readonly StagedImportTree[]) => void;
  /** The package handoff; the session stops polling after this. */
  onPackage?: (handoff: StagedImportPackage, manifest: StagedImportManifest) => void;
  /** A fail-closed error; the session stops polling after this. */
  onError?: (error: Error) => void;
}

export interface StagedImportSessionOptions {
  readonly signal: AbortSignal;
  readonly intervalMs?: number;
  /** Replaces the global fetch for every manifest poll and sidecar read. */
  readonly fetch?: PackageFetch;
  /** Clock for `readyAt`; defaults to `performance.now`. */
  readonly now?: () => number;
}

export interface StagedImportSession {
  /** Resolves when the session stops: on package handoff, error, or abort. */
  readonly done: Promise<void>;
  readonly trees: readonly StagedImportTree[];
}

async function verifiedBytes(
  transport: PackageTransport,
  manifestUrl: URL,
  uri: string,
  kind: "json" | "binary",
  byteLength: number,
  sha256: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const url = transport.resolveResourceUrl(uri, manifestUrl, uri);
  const bytes = await transport.fetchResource(url, {
    kind,
    label: uri,
    limitBytes: transport.resourceLimit(byteLength),
    signal,
  });
  if (bytes.byteLength !== byteLength) {
    throw new RangeError(`${uri} must be ${String(byteLength)} bytes; received ${String(bytes.byteLength)}.`);
  }
  if ((await packageResourceDigest(bytes)) !== sha256) {
    throw new TypeError(`Staged hierarchy digest mismatch for ${uri}.`);
  }
  return bytes;
}

async function loadStagedTree(
  transport: PackageTransport,
  manifestUrl: URL,
  document: StagedImportDocument,
  signal: AbortSignal,
  now: () => number,
): Promise<StagedImportTree> {
  const { hierarchy } = document;
  const jsonBytes = await verifiedBytes(
    transport, manifestUrl, hierarchy.uri, "json", hierarchy.byteLength, hierarchy.sha256, signal,
  );
  const columns = await verifiedBytes(
    transport, manifestUrl, hierarchy.columnsUri, "binary",
    hierarchy.columnsByteLength, hierarchy.columnsSha256, signal,
  );
  const decoded = decodePackageHierarchy(
    JSON.parse(new TextDecoder().decode(jsonBytes)) as unknown,
    columns,
    { maxEntries: document.nodeCount },
  );
  if (decoded.entries.length !== document.nodeCount || decoded.relocatedCount !== document.nodeCount) {
    invalid(
      `${hierarchy.uri} decodes ${String(decoded.entries.length)} entries ` +
        `(${String(decoded.relocatedCount)} relocated); the manifest staged ${String(document.nodeCount)}.`,
    );
  }
  if (decoded.sourceDigest !== document.sourceDigest) {
    invalid(`${hierarchy.uri} was staged from source ${decoded.sourceDigest}; the manifest names ${document.sourceDigest}.`);
  }
  return { document, entries: decoded.entries, readyAt: now() };
}

/**
 * Reads a manifest once. A missing or not-yet-written manifest (a non-OK
 * status, or a body that is not JSON because the dev server answered with its
 * HTML fallback) is "not yet"; anything that parses but fails the schema is a
 * hard error, because a compile never writes an invalid manifest.
 */
async function pollManifest(
  transfer: PackageFetch,
  manifestUrl: URL,
  signal: AbortSignal,
): Promise<StagedImportManifest | undefined> {
  const response = await transfer(manifestUrl, { cache: "no-store", redirect: "error", signal });
  if (!response.ok) return undefined;
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return parseStagedImportManifest(value);
}

function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Follows a staged import from its manifest URL until the compile hands off
 * its package, fails, or the caller aborts.
 *
 * Every manifest read is fail-closed; every tree is bounded by its declared
 * length, authenticated by its declared digest, and decoded by the runtime's
 * `naru.package-hierarchy.1` reader before the Studio sees it. Trees are
 * delivered in the manifest's emission order and never re-fetched: a document
 * already delivered is matched by discipline and skipped.
 */
export function watchStagedImport(
  manifestUrl: URL,
  callbacks: StagedImportCallbacks,
  options: StagedImportSessionOptions,
): StagedImportSession {
  assertPackageUrl(manifestUrl, "staged import manifest");
  const { signal } = options;
  const intervalMs = options.intervalMs ?? defaultStagedImportPollMs;
  const now = options.now ?? ((): number => performance.now());
  const transfer: PackageFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const transport = openPackageTransport(manifestUrl, options.fetch ? { fetch: options.fetch } : {});
  const trees: StagedImportTree[] = [];

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      let manifest: StagedImportManifest | undefined;
      try {
        manifest = await pollManifest(transfer, manifestUrl, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof StagedImportError) throw error;
        // A transport failure (server not up yet, connection reset) is retried.
        manifest = undefined;
      }
      if (manifest !== undefined) {
        callbacks.onManifest?.(manifest);
        for (const document of manifest.documents) {
          if (signal.aborted) return;
          if (trees.some((tree) => tree.document.discipline === document.discipline)) continue;
          const tree = await loadStagedTree(transport, manifestUrl, document, signal, now);
          trees.push(tree);
          callbacks.onTree?.(tree, trees);
        }
        if (manifest.package !== undefined) {
          if (trees.length !== manifest.totalCount) {
            invalid("The staged package handoff arrived before every tree was delivered.");
          }
          callbacks.onPackage?.(manifest.package, manifest);
          return;
        }
      }
      await abortable(intervalMs, signal);
    }
  };

  const done = run().catch((error: unknown) => {
    if (signal.aborted) return;
    callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
  });
  return { done, trees };
}

/**
 * Resolves a `?staged=` value to the manifest URL. The value must name the
 * manifest file itself, on a credential-free HTTP(S) origin, so the sidecars
 * it declares resolve beside it.
 */
export function parseStagedManifestUrl(value: string, baseHref: string): URL {
  const trimmed = value.trim();
  if (trimmed === "") invalid("A staged import manifest URL is required.");
  let url: URL;
  try {
    url = new URL(trimmed, baseHref);
  } catch {
    invalid(`"${trimmed}" is not a URL.`);
  }
  assertPackageUrl(url, "staged import manifest");
  if (!url.pathname.endsWith(`/${stagedImportManifestFilename}`)) {
    invalid(`A staged import manifest URL must end with /${stagedImportManifestFilename}.`);
  }
  if (url.search !== "" || url.hash !== "") invalid("A staged import manifest URL must not carry a query or fragment.");
  return url;
}
