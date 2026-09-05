import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { errorCode } from "./cache-primitives.js";
import { buildHierarchySidecar, type HierarchySidecarEntry } from "./hierarchy-sidecar.js";
import { stagedImportPreviewSchema, type ImportJobStagedPreview } from "./import-job.js";

/**
 * Staged import preview (ADR-0021).
 *
 * While the IFC adapter extracts a federation it can publish each document's
 * assembly tree as soon as that document is parsed. This module is the
 * compiler's side of that hand-off: it watches the adapter's preview
 * directory, verifies every tree by length and digest before parsing it,
 * re-encodes it into the `naru.package-hierarchy.1` sidecar pair the runtime
 * already reads, and publishes the pair atomically under a manifest.
 *
 * A staged directory is never a compiled package: it carries no `scene.gltf`,
 * no `scene.bin`, and no digest chain, and it is never a cache tier. The
 * completed import supersedes it.
 */

/** The per-document tree the IFC adapter publishes while it extracts. */
export const ifcStructurePreviewSchema = "naru.ifc-structure-preview.1";
export const ifcStructurePreviewIndexSchema = "naru.ifc-structure-preview-index.1";
export const ifcStructurePreviewIndexFilename = "index.json";
/** Manifest of a staged directory, rewritten after every published document. */
export const stagedPreviewManifestFilename = "staged.json";

export class StagedPreviewError extends Error {
  readonly code = "INVALID_STAGED_PREVIEW";

  constructor(message: string) {
    super(message);
    this.name = "StagedPreviewError";
  }
}

export interface IfcStructurePreviewNode {
  readonly id: string;
  readonly type: string;
  /** Index of the parent in `nodes`, or `null` for a root. */
  readonly parent: number | null;
  readonly name?: string;
}

export interface IfcStructurePreview {
  readonly schemaVersion: typeof ifcStructurePreviewSchema;
  readonly discipline: string;
  readonly uriHint: string;
  readonly documentId: string;
  readonly sourceDigest: string;
  readonly sourceBytes: number;
  readonly schema: string;
  readonly nodes: readonly IfcStructurePreviewNode[];
}

/** One entry of the adapter's `index.json`. */
export interface IfcStructurePreviewDescriptor {
  readonly discipline: string;
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly nodeCount: number;
  readonly rootCount: number;
}

/** The inspected source a preview must identify itself against. */
export interface StagedPreviewSource {
  readonly discipline: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface StagedPreviewDocument {
  readonly discipline: string;
  readonly uriHint: string;
  readonly documentId: string;
  readonly schema: string;
  readonly sourceDigest: string;
  readonly sourceBytes: number;
  readonly nodeCount: number;
  readonly rootCount: number;
  readonly hierarchy: {
    readonly uri: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly columnsUri: string;
    readonly columnsByteLength: number;
    readonly columnsSha256: string;
  };
}

export interface StagedPreviewManifest {
  readonly schemaVersion: typeof stagedImportPreviewSchema;
  readonly jobId: string;
  readonly kind: "ifc-federation";
  readonly disciplines: readonly string[];
  /** Documents in emission order; every one is verified and complete on disk. */
  readonly documents: readonly StagedPreviewDocument[];
  readonly stagedCount: number;
  readonly totalCount: number;
  readonly complete: boolean;
}

export function ifcStructurePreviewFilename(discipline: string): string {
  return `structure-${discipline}.json`;
}

export function stagedHierarchyFilename(discipline: string): string {
  return `hierarchy-${discipline}.json`;
}

export function stagedHierarchyColumnsFilename(discipline: string): string {
  return `hierarchy-${discipline}.bin`;
}

const sha256Pattern = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StagedPreviewError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StagedPreviewError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!sha256Pattern.test(text)) {
    throw new StagedPreviewError(`${label} must be a lowercase hex SHA-256.`);
  }
  return text;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseIfcStructurePreviewDescriptor(value: unknown): IfcStructurePreviewDescriptor {
  if (!isRecord(value)) {
    throw new StagedPreviewError("Structure preview index entries must be objects.");
  }
  const discipline = requireString(value.discipline, "Structure preview index discipline");
  const path = requireString(value.path, `Structure preview ${discipline} path`);
  if (path !== ifcStructurePreviewFilename(discipline)) {
    throw new StagedPreviewError(
      `Structure preview ${discipline} must be published as ${ifcStructurePreviewFilename(discipline)}, not ${path}.`,
    );
  }
  return {
    discipline,
    path,
    sha256: requireDigest(value.sha256, `Structure preview ${discipline} sha256`),
    byteLength: requireCount(value.byteLength, `Structure preview ${discipline} byteLength`),
    nodeCount: requireCount(value.nodeCount, `Structure preview ${discipline} nodeCount`),
    rootCount: requireCount(value.rootCount, `Structure preview ${discipline} rootCount`),
  };
}

/** The adapter's index: every listed document is already complete on disk. */
export function parseIfcStructurePreviewIndex(value: unknown): {
  readonly complete: boolean;
  readonly documents: readonly IfcStructurePreviewDescriptor[];
} {
  if (!isRecord(value) || value.schemaVersion !== ifcStructurePreviewIndexSchema) {
    throw new StagedPreviewError(
      `Structure preview index must declare schemaVersion ${ifcStructurePreviewIndexSchema}.`,
    );
  }
  if (!Array.isArray(value.documents)) {
    throw new StagedPreviewError("Structure preview index must list documents.");
  }
  const documents = value.documents.map(parseIfcStructurePreviewDescriptor);
  const seen = new Set<string>();
  for (const document of documents) {
    if (seen.has(document.discipline)) {
      throw new StagedPreviewError(
        `Structure preview index lists ${document.discipline} twice.`,
      );
    }
    seen.add(document.discipline);
  }
  return { complete: value.complete === true, documents };
}

/**
 * Verify and parse one published tree. Length and digest are checked against
 * the index entry before the bytes are parsed, and the tree must identify the
 * inspected source it was extracted from: a preview for a document that is not
 * part of this federation, or whose source digest differs, is refused.
 */
export function parseIfcStructurePreview(
  bytes: Uint8Array,
  descriptor: IfcStructurePreviewDescriptor,
  sources: ReadonlyMap<string, StagedPreviewSource>,
): IfcStructurePreview {
  const label = `Structure preview ${descriptor.discipline}`;
  if (bytes.byteLength !== descriptor.byteLength) {
    throw new StagedPreviewError(
      `${label} is ${bytes.byteLength} bytes but its index declares ${descriptor.byteLength}.`,
    );
  }
  const digest = sha256Hex(bytes);
  if (digest !== descriptor.sha256) {
    throw new StagedPreviewError(`${label} digest ${digest} does not match its index entry.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new StagedPreviewError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value) || value.schemaVersion !== ifcStructurePreviewSchema) {
    throw new StagedPreviewError(`${label} must declare schemaVersion ${ifcStructurePreviewSchema}.`);
  }
  const discipline = requireString(value.discipline, `${label} discipline`);
  if (discipline !== descriptor.discipline) {
    throw new StagedPreviewError(`${label} names discipline ${discipline}.`);
  }
  const source = sources.get(discipline);
  if (source === undefined) {
    throw new StagedPreviewError(`${label} is not a document of this federation.`);
  }
  const sourceDigest = requireDigest(value.sourceDigest, `${label} sourceDigest`);
  const sourceBytes = requireCount(value.sourceBytes, `${label} sourceBytes`);
  if (sourceDigest !== source.sha256 || sourceBytes !== source.byteLength) {
    throw new StagedPreviewError(
      `${label} identifies source ${sourceDigest} (${sourceBytes} bytes) but the inspected document is ${source.sha256} (${source.byteLength} bytes).`,
    );
  }
  const rawNodes: unknown = value.nodes;
  if (!Array.isArray(rawNodes)) {
    throw new StagedPreviewError(`${label} must list nodes.`);
  }
  if (rawNodes.length !== descriptor.nodeCount) {
    throw new StagedPreviewError(
      `${label} lists ${rawNodes.length} nodes but its index declares ${descriptor.nodeCount}.`,
    );
  }
  const ids = new Set<string>();
  let rootCount = 0;
  const nodes = rawNodes.map((entry: unknown, index: number): IfcStructurePreviewNode => {
    if (!isRecord(entry)) {
      throw new StagedPreviewError(`${label} node ${index} must be an object.`);
    }
    const id = requireString(entry.id, `${label} node ${index} id`);
    if (ids.has(id)) {
      throw new StagedPreviewError(`${label} lists node ${id} twice.`);
    }
    ids.add(id);
    const type = requireString(entry.type, `${label} node ${index} type`);
    let parent: number | null = null;
    if (entry.parent !== null) {
      parent = requireCount(entry.parent, `${label} node ${index} parent`);
      if (parent >= rawNodes.length || parent === index) {
        throw new StagedPreviewError(`${label} node ${index} names parent ${parent}, which is not another node.`);
      }
    } else {
      rootCount += 1;
    }
    if (entry.name !== undefined && typeof entry.name !== "string") {
      throw new StagedPreviewError(`${label} node ${index} name must be a string.`);
    }
    return entry.name === undefined ? { id, type, parent } : { id, type, parent, name: entry.name };
  });
  if (rootCount !== descriptor.rootCount) {
    throw new StagedPreviewError(
      `${label} has ${rootCount} roots but its index declares ${descriptor.rootCount}.`,
    );
  }
  return {
    schemaVersion: ifcStructurePreviewSchema,
    discipline,
    uriHint: requireString(value.uriHint, `${label} uriHint`),
    documentId: requireString(value.documentId, `${label} documentId`),
    sourceDigest,
    sourceBytes,
    schema: requireString(value.schema, `${label} schema`),
    nodes,
  };
}

const identityTransform: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Re-encode one verified tree as a fully relocated `naru.package-hierarchy.1`
 * sidecar: `documentNodeCount` is zero because no document exists yet, and
 * every entry is relocated. The preview carries a node's IFC class and name
 * only, so the prototype column names the class (`preview:ifc:<class>`), the
 * identity columns are omitted rather than invented, and every local
 * transform is the identity: a staged tree is navigable structure, not
 * geometry placement.
 */
export function encodeStagedHierarchy(preview: IfcStructurePreview): {
  readonly sidecar: ReturnType<typeof buildHierarchySidecar>;
  readonly rootCount: number;
} {
  const { nodes } = preview;
  const children: number[][] = nodes.map(() => []);
  const roots: number[] = [];
  nodes.forEach((node, index) => {
    if (node.parent === null) {
      roots.push(index);
    } else {
      children[node.parent]?.push(index);
    }
  });
  const entries: HierarchySidecarEntry[] = [];
  const stack: { readonly index: number; readonly depth: number }[] = [];
  for (let position = roots.length - 1; position >= 0; position -= 1) {
    stack.push({ index: roots[position] as number, depth: 0 });
  }
  while (stack.length > 0) {
    const { index, depth } = stack.pop() as { index: number; depth: number };
    const node = nodes[index] as IfcStructurePreviewNode;
    entries.push({
      depth,
      relocated: {
        name: node.name ?? node.id,
        occurrenceId: node.id,
        prototypeId: `preview:ifc:${node.type.toLowerCase()}`,
        initialVisibility: true,
        tags: ["ifc", "preview", preview.discipline, node.type.toLowerCase()],
        localTransform: identityTransform,
      },
    });
    const nested = children[index] as number[];
    for (let position = nested.length - 1; position >= 0; position -= 1) {
      stack.push({ index: nested[position] as number, depth: depth + 1 });
    }
  }
  if (entries.length !== nodes.length) {
    throw new StagedPreviewError(
      `Structure preview ${preview.discipline} reaches ${entries.length} of ${nodes.length} nodes from its roots; the parent links form a cycle.`,
    );
  }
  const sidecar = buildHierarchySidecar({
    sceneId: preview.documentId,
    revisionId: preview.sourceDigest,
    sourceDigest: preview.sourceDigest,
    documentNodeCount: 0,
    columnsUri: stagedHierarchyColumnsFilename(preview.discipline),
    entries,
  });
  return { sidecar, rootCount: roots.length };
}

const retryableReplaceCodes: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
let temporaryCounter = 0;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

/**
 * Write a whole file, then move it over its final name. A reader never sees a
 * partial file. On Windows a reader holding the previous file makes the
 * replace fail transiently, so it is retried for a bounded time.
 */
async function replaceFile(directory: string, name: string, bytes: Uint8Array): Promise<void> {
  temporaryCounter += 1;
  const temporary = join(directory, `.${name}.${process.pid}.${temporaryCounter}.tmp`);
  await writeFile(temporary, bytes);
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await rename(temporary, join(directory, name));
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !retryableReplaceCodes.has(code) || Date.now() >= deadline) {
        throw error;
      }
      await delay(5);
    }
  }
}

export interface StagedPreviewWriterOptions {
  readonly directory: string;
  readonly jobId: string;
  readonly disciplines: readonly string[];
}

/**
 * Publishes verified trees into one staged directory. Each sidecar pair is
 * written atomically and the manifest is rewritten after it, so the manifest
 * only ever names files that are complete on disk and carries their length
 * and digest for a reader to verify before parsing.
 */
export class StagedPreviewWriter {
  readonly directory: string;
  readonly #jobId: string;
  readonly #disciplines: readonly string[];
  readonly #documents: StagedPreviewDocument[] = [];

  private constructor(options: StagedPreviewWriterOptions) {
    this.directory = options.directory;
    this.#jobId = options.jobId;
    this.#disciplines = [...new Set(options.disciplines)].sort();
    if (this.#disciplines.length !== options.disciplines.length) {
      throw new StagedPreviewError("Staged preview disciplines must be distinct.");
    }
  }

  static async open(options: StagedPreviewWriterOptions): Promise<StagedPreviewWriter> {
    const writer = new StagedPreviewWriter(options);
    await mkdir(options.directory, { recursive: true });
    await writer.#writeManifest(false);
    return writer;
  }

  manifest(): StagedPreviewManifest {
    return this.#manifest(this.#documents.length === this.#disciplines.length);
  }

  async stage(preview: IfcStructurePreview): Promise<ImportJobStagedPreview> {
    const { discipline } = preview;
    if (!this.#disciplines.includes(discipline)) {
      throw new StagedPreviewError(`Staged preview for ${discipline} is not a document of this job.`);
    }
    if (this.#documents.some((document) => document.discipline === discipline)) {
      throw new StagedPreviewError(`Staged preview for ${discipline} was already published.`);
    }
    const { sidecar, rootCount } = encodeStagedHierarchy(preview);
    const columnsUri = stagedHierarchyColumnsFilename(discipline);
    const uri = stagedHierarchyFilename(discipline);
    await replaceFile(this.directory, columnsUri, sidecar.binary);
    await replaceFile(this.directory, uri, sidecar.jsonBytes);
    this.#documents.push({
      discipline,
      uriHint: preview.uriHint,
      documentId: preview.documentId,
      schema: preview.schema,
      sourceDigest: preview.sourceDigest,
      sourceBytes: preview.sourceBytes,
      nodeCount: preview.nodes.length,
      rootCount,
      hierarchy: {
        uri,
        byteLength: sidecar.jsonBytes.byteLength,
        sha256: sidecar.jsonDigest,
        columnsUri,
        columnsByteLength: sidecar.binary.byteLength,
        columnsSha256: sidecar.binaryDigest,
      },
    });
    await this.#writeManifest(false);
    return {
      schemaVersion: stagedImportPreviewSchema,
      discipline,
      sha256: preview.sourceDigest,
      byteLength: preview.sourceBytes,
      nodeCount: preview.nodes.length,
      rootCount,
      hierarchy: {
        sha256: sidecar.jsonDigest,
        byteLength: sidecar.jsonBytes.byteLength,
        columnsSha256: sidecar.binaryDigest,
        columnsByteLength: sidecar.binary.byteLength,
      },
      stagedCount: this.#documents.length,
      totalCount: this.#disciplines.length,
    };
  }

  /** Mark the directory complete; refused while any document is still missing. */
  async complete(): Promise<StagedPreviewManifest> {
    if (this.#documents.length !== this.#disciplines.length) {
      const missing = this.#disciplines.filter(
        (discipline) => !this.#documents.some((document) => document.discipline === discipline),
      );
      throw new StagedPreviewError(
        `Staged preview is missing ${missing.join(", ")}; the adapter published ${this.#documents.length} of ${this.#disciplines.length} trees.`,
      );
    }
    await this.#writeManifest(true);
    return this.manifest();
  }

  #manifest(complete: boolean): StagedPreviewManifest {
    return {
      schemaVersion: stagedImportPreviewSchema,
      jobId: this.#jobId,
      kind: "ifc-federation",
      disciplines: this.#disciplines,
      documents: [...this.#documents],
      stagedCount: this.#documents.length,
      totalCount: this.#disciplines.length,
      complete,
    };
  }

  async #writeManifest(complete: boolean): Promise<void> {
    const text = `${JSON.stringify(this.#manifest(complete), null, 2)}\n`;
    await replaceFile(this.directory, stagedPreviewManifestFilename, new TextEncoder().encode(text));
  }
}

const transientIndexCodes: ReadonlySet<string> = new Set(["ENOENT", "EPERM", "EACCES", "EBUSY"]);

async function readIndex(path: string): Promise<ReturnType<typeof parseIfcStructurePreviewIndex> | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && transientIndexCodes.has(code)) {
      return undefined;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new StagedPreviewError(
      `Structure preview index is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseIfcStructurePreviewIndex(value);
}

export interface WatchIfcStructurePreviewsOptions {
  /** The directory the adapter was told to publish into. */
  readonly directory: string;
  readonly sources: readonly StagedPreviewSource[];
  /** Settles when the adapter process has exited, however it exited. */
  readonly until: Promise<unknown>;
  readonly intervalMs?: number;
  /** Called once per verified document, in the adapter's emission order. */
  readonly onPreview: (
    preview: IfcStructurePreview,
    descriptor: IfcStructurePreviewDescriptor,
  ) => Promise<void>;
}

/**
 * Poll the adapter's preview index until the adapter has exited, handing each
 * newly listed document to `onPreview` after verifying it. The index is read
 * once more after the adapter settles, so a tree published just before exit
 * is never missed. Any malformed index or tree rejects the watch: a preview
 * that cannot be verified is an import failure, not a skipped preview.
 */
export async function watchIfcStructurePreviews(
  options: WatchIfcStructurePreviewsOptions,
): Promise<number> {
  const { directory, until, onPreview } = options;
  const intervalMs = options.intervalMs ?? 250;
  const sources = new Map(options.sources.map((source) => [source.discipline, source]));
  const indexPath = join(directory, ifcStructurePreviewIndexFilename);
  const consumed = new Set<string>();
  let settled = false;
  const done = until.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (;;) {
    const finalPass = settled;
    const index = await readIndex(indexPath);
    if (index !== undefined) {
      for (const descriptor of index.documents) {
        if (consumed.has(descriptor.discipline)) {
          continue;
        }
        const bytes = await readFile(join(directory, descriptor.path));
        const preview = parseIfcStructurePreview(bytes, descriptor, sources);
        consumed.add(descriptor.discipline);
        await onPreview(preview, descriptor);
      }
    }
    if (finalPass) {
      return consumed.size;
    }
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, intervalMs);
      void done.then(() => {
        clearTimeout(timer);
        resolveWait();
      });
    });
  }
}
