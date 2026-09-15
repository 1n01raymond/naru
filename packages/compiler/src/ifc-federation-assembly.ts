import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { propertyColumnsEncoding } from "@naru3d/scene-ir";

import {
  canonicalJsonBytes,
  canonicalJsonEquals,
  compareCodePoints,
  digestCanonicalJson,
  flagFloat,
  parseCanonicalJson,
} from "./canonical-json.js";
import type { CanonicalJsonDigest, FloatSourceTable } from "./canonical-json.js";
import { ifcSceneSplitEncodingVersion } from "./ifc-scene.js";

/**
 * In-compiler IFC federation assembly (ADR-0019 slice 3b).
 *
 * The adapter's manifest mode names each document's verified cache artifact
 * instead of merging the federation and writing the split Scene IR itself.
 * This module hydrates those artifacts and reproduces, byte for byte, the
 * structure, geometry, and property column bytes and the adapter report that
 * the monolithic adapter path would have written: the same merge rules
 * (`extract_federation`), the same key and value column merges
 * (`merge_property_indexes`, `merge_property_value_columns`), the same
 * packing (`write_scene`), and Python's canonical JSON. No structure file is
 * written; its digest is streamed.
 *
 * Every artifact check that fails is a fallback signal, never an error: the
 * caller re-runs the monolithic adapter path instead. Only inconsistencies in
 * the manifest itself, and the limits the adapter would also refuse, throw.
 */

export const ifcFederationManifestSchema = "naru.ifc-federation-manifest.1";
export const ifcDocumentArtifactSchema = "naru.ifc-document-artifact.4";
const adapterIdentitySchema = "naru.ifc-adapter-identity.1";
const adapterReportSchema = "naru.ifc-adapter-report.6";
const adapterName = "IfcOpenShell";
const surfacePositionAlias = "surface.positions";
const REGION_ALIGNMENT = 8;
const U32_LIMIT = 2 ** 32;
const digestPattern = /^[a-f0-9]{64}$/u;

type GeometryEncoding = "f64le" | "f32le" | "u32le" | "u8";

/** Hoisted geometry fields in packing order, with their stored dtype. */
const GEOMETRY_FIELD_LAYOUT: readonly (readonly [
  part: "surface" | "edges",
  field: string,
  encoding: GeometryEncoding,
  itemSize: number,
])[] = [
  ["surface", "positions", "f64le", 8],
  ["surface", "indices", "u32le", 4],
  ["surface", "normals", "f32le", 4],
  ["edges", "positions", "f64le", 8],
  ["edges", "segments", "u32le", 4],
  ["edges", "classes", "u8", 1],
  ["edges", "sourceIds", "u32le", 4],
];

/** Hoisted property column fields in storage order. */
const PROPERTY_FIELD_LAYOUT: readonly (readonly [field: string, itemSize: number])[] = [
  ["value_heap", 1],
  ["value_offsets", 4],
  ["row_refs", 4],
  ["row_offsets", 4],
];

export interface IfcFederationManifestDocument {
  readonly discipline: string;
  readonly uriHint: string;
  readonly sourceDigest: string;
  readonly byteLength: number;
  readonly keyInput: Record<string, unknown>;
  readonly artifactKey: string;
  readonly artifactPayloadSha256: string;
  readonly outcome: "restored" | "extracted";
}

export interface IfcFederationManifestAdapter {
  readonly schemaVersion: typeof adapterIdentitySchema;
  readonly name: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly toolchain: Record<string, unknown>;
}

export interface IfcFederationManifestIdentity {
  readonly sourceDigest: string;
  readonly documentOrder: readonly string[];
  readonly options: Record<string, unknown>;
}

export interface IfcDocumentArtifactCacheResult {
  readonly schemaVersion: typeof ifcDocumentArtifactSchema;
  readonly status: "enabled";
  readonly hits: readonly string[];
  readonly misses: readonly string[];
}

export interface IfcFederationManifest {
  readonly schemaVersion: typeof ifcFederationManifestSchema;
  readonly artifactSchemaVersion: typeof ifcDocumentArtifactSchema;
  readonly adapter: IfcFederationManifestAdapter;
  readonly federation: IfcFederationManifestIdentity;
  readonly documents: readonly IfcFederationManifestDocument[];
  readonly documentArtifactCache: IfcDocumentArtifactCacheResult;
}

export interface IfcFederationAssemblyDocument {
  readonly discipline: string;
  readonly artifactKey: string;
  /** Compressed artifact file size. */
  readonly artifactBytes: number;
  readonly payloadBytes: number;
  readonly structureBytes: number;
}

export interface IfcFederationAssembly {
  readonly status: "assembled";
  /** The split structure, as `JSON.parse` of the adapter's scene file would return it. */
  readonly scene: Record<string, unknown>;
  /** Digest of the canonical structure JSON plus its trailing newline. */
  readonly structure: CanonicalJsonDigest;
  readonly geometry: Buffer;
  readonly properties: Buffer;
  /** The `naru.ifc-adapter-report.6` report, including `scene` digests. */
  readonly report: Record<string, unknown>;
  readonly documents: readonly IfcFederationAssemblyDocument[];
}

export interface IfcFederationAssemblyFallback {
  readonly status: "fallback";
  readonly discipline: string;
  readonly reason: string;
}

export type IfcFederationAssemblyOutcome = IfcFederationAssembly | IfcFederationAssemblyFallback;

export interface AssembleIfcFederationOptions {
  /** The manifest file's text, as the adapter wrote it. */
  readonly manifest: string;
  /** The `--document-cache` directory the manifest was assembled from. */
  readonly cacheDirectory: string;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlainInteger(value: unknown, floats: FloatSourceTable, holder: object, key: string): value is number {
  return typeof value === "number" && Number.isInteger(value) && !floats.get(holder)?.has(key);
}

function aligned(offset: number): number {
  const remainder = offset % REGION_ALIGNMENT;
  return remainder === 0 ? offset : offset + (REGION_ALIGNMENT - remainder);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function federationSourceDigest(
  pairs: readonly (readonly [discipline: string, sha256: string])[],
): string {
  return sha256Hex(
    canonicalJsonBytes(pairs.map(([discipline, sha256]) => ({ discipline, sha256 }))),
  );
}

function parseManifestDocument(value: unknown, index: number): IfcFederationManifestDocument {
  if (!isRecord(value)) {
    throw new TypeError(`IFC federation manifest document ${String(index)} is not an object.`);
  }
  const {
    discipline,
    uriHint,
    sourceDigest,
    byteLength,
    keyInput,
    artifactKey,
    artifactPayloadSha256,
    outcome,
  } = value;
  if (
    typeof discipline !== "string" ||
    typeof uriHint !== "string" ||
    typeof sourceDigest !== "string" ||
    !digestPattern.test(sourceDigest) ||
    typeof byteLength !== "number" ||
    !Number.isInteger(byteLength) ||
    byteLength < 0 ||
    !isRecord(keyInput) ||
    typeof artifactKey !== "string" ||
    !digestPattern.test(artifactKey) ||
    typeof artifactPayloadSha256 !== "string" ||
    !digestPattern.test(artifactPayloadSha256) ||
    (outcome !== "restored" && outcome !== "extracted")
  ) {
    throw new TypeError(`IFC federation manifest document ${String(index)} is malformed.`);
  }
  return {
    discipline,
    uriHint,
    sourceDigest,
    byteLength,
    keyInput,
    artifactKey,
    artifactPayloadSha256,
    outcome,
  };
}

function parseManifest(text: string): { manifest: IfcFederationManifest; floats: FloatSourceTable } {
  const { value, floats } = parseCanonicalJson(text);
  if (!isRecord(value)) {
    throw new TypeError("IFC federation manifest is not an object.");
  }
  if (value.schemaVersion !== ifcFederationManifestSchema) {
    throw new TypeError("IFC federation manifest has an unsupported schema version.");
  }
  if (value.artifactSchemaVersion !== ifcDocumentArtifactSchema) {
    throw new TypeError("IFC federation manifest names an unsupported artifact schema.");
  }
  const adapter = value.adapter;
  if (
    !isRecord(adapter) ||
    adapter.schemaVersion !== adapterIdentitySchema ||
    adapter.name !== adapterName ||
    typeof adapter.version !== "string" ||
    adapter.version === "" ||
    typeof adapter.fingerprint !== "string" ||
    !digestPattern.test(adapter.fingerprint) ||
    !isRecord(adapter.toolchain)
  ) {
    throw new TypeError("IFC federation manifest has an invalid adapter identity.");
  }
  const federation = value.federation;
  if (
    !isRecord(federation) ||
    typeof federation.sourceDigest !== "string" ||
    !isStringArray(federation.documentOrder) ||
    !isRecord(federation.options)
  ) {
    throw new TypeError("IFC federation manifest has an invalid federation identity.");
  }
  if (!Array.isArray(value.documents)) {
    throw new TypeError("IFC federation manifest has no documents array.");
  }
  const documents = value.documents.map(parseManifestDocument);
  const disciplines = documents.map((document) => document.discipline);
  if (
    disciplines.length === 0 ||
    disciplines.length !== new Set(disciplines).size ||
    disciplines.some((discipline, index) => {
      const previous = disciplines[index - 1];
      return previous !== undefined && compareCodePoints(previous, discipline) >= 0;
    }) ||
    federation.documentOrder.length !== disciplines.length ||
    federation.documentOrder.some((discipline, index) => discipline !== disciplines[index])
  ) {
    throw new TypeError("IFC federation manifest document order is not the assembly order.");
  }
  const expectedDigest = federationSourceDigest(
    documents.map((document) => [document.discipline, document.sourceDigest] as const),
  );
  if (federation.sourceDigest !== expectedDigest) {
    throw new TypeError("IFC federation manifest digest does not match its documents.");
  }
  const cache = value.documentArtifactCache;
  if (
    !isRecord(cache) ||
    cache.schemaVersion !== ifcDocumentArtifactSchema ||
    cache.status !== "enabled" ||
    !isStringArray(cache.hits) ||
    !isStringArray(cache.misses)
  ) {
    throw new TypeError("IFC federation manifest has an invalid document artifact cache result.");
  }
  const covered = [...cache.hits, ...cache.misses].sort(compareCodePoints);
  if (
    covered.length !== disciplines.length ||
    covered.some((discipline, index) => discipline !== disciplines[index])
  ) {
    throw new TypeError("IFC federation manifest document artifact cache coverage is incomplete.");
  }
  return {
    manifest: {
      schemaVersion: ifcFederationManifestSchema,
      artifactSchemaVersion: ifcDocumentArtifactSchema,
      adapter: {
        schemaVersion: adapterIdentitySchema,
        name: adapter.name,
        version: adapter.version,
        fingerprint: adapter.fingerprint,
        toolchain: adapter.toolchain,
      },
      federation: {
        sourceDigest: federation.sourceDigest,
        documentOrder: federation.documentOrder,
        options: federation.options,
      },
      documents,
      documentArtifactCache: {
        schemaVersion: ifcDocumentArtifactSchema,
        status: "enabled",
        hits: cache.hits,
        misses: cache.misses,
      },
    },
    floats,
  };
}

/** Parses and validates a `naru.ifc-federation-manifest.1` document; throws on any inconsistency. */
export function parseIfcFederationManifest(text: string): IfcFederationManifest {
  return parseManifest(text).manifest;
}

/** Path of the artifact the manifest names for `document`. */
export function ifcDocumentArtifactPath(
  cacheDirectory: string,
  document: IfcFederationManifestDocument,
): string {
  return join(cacheDirectory, `${document.artifactKey}.json.gz`);
}

interface PropertyColumns {
  readonly valueHeap: Buffer;
  readonly valueOffsets: Uint32Array;
  readonly rowRefs: Uint32Array;
  readonly rowOffsets: Uint32Array;
}

interface PropertyIndex {
  readonly keys: readonly string[];
  readonly sets: readonly (readonly number[])[];
}

interface DocumentPayload {
  readonly discipline: string;
  readonly timestamp: string | null;
  readonly document: Record<string, unknown>;
  readonly semantics: Record<string, unknown>[];
  readonly prototypes: Record<string, unknown>[];
  readonly occurrences: Record<string, unknown>[];
  readonly representations: Record<string, unknown>[];
  readonly materials: Record<string, unknown>[];
  readonly propertyIndex: PropertyIndex;
  readonly propertyValues: PropertyColumns;
  readonly diagnostics: Record<string, unknown>[];
  readonly counts: Record<string, unknown>;
  readonly prototypeReuse: Record<string, unknown>[];
}

interface LoadedArtifact {
  readonly payload: DocumentPayload;
  readonly document: IfcFederationAssemblyDocument;
}

type ArtifactLoad =
  | { readonly ok: true; readonly artifact: LoadedArtifact }
  | { readonly ok: false; readonly reason: string };

const gunzipAsync = promisify(gunzip);

function readU32Column(bytes: Buffer): Uint32Array {
  // Regions are eight-aligned within the payload, not within the pooled
  // ArrayBuffer the payload sits in, so a direct view could be misaligned.
  const column = new Uint32Array(bytes.byteLength / 4);
  Buffer.from(column.buffer).set(bytes);
  return column;
}

/** Restores hoisted arrays as views over `payload`; false when the lengths do not describe it. */
function attachPayloadRegions(
  structure: Record<string, unknown>,
  payload: Buffer,
  start: number,
  floats: FloatSourceTable,
): boolean {
  const available = payload.byteLength - start;
  if (available < 0) return false;
  const fields: (readonly [block: Record<string, unknown>, field: string, itemSize: number])[] = [];
  const representations = structure.representations;
  if (Array.isArray(representations)) {
    for (const representation of representations) {
      if (!isRecord(representation)) continue;
      for (const [part, field, , itemSize] of GEOMETRY_FIELD_LAYOUT) {
        const block = representation[part];
        if (isRecord(block)) fields.push([block, field, itemSize]);
      }
    }
  }
  const columns = structure.propertyValues;
  if (isRecord(columns)) {
    for (const [field, itemSize] of PROPERTY_FIELD_LAYOUT) fields.push([columns, field, itemSize]);
  }
  let offset = 0;
  for (const [block, field, itemSize] of fields) {
    const length = block[field];
    if (!isPlainInteger(length, floats, block, field)) continue;
    if (length < 0 || length % itemSize !== 0) return false;
    offset = aligned(offset);
    if (offset + length > available) return false;
    block[field] = payload.subarray(start + offset, start + offset + length);
    offset += length;
  }
  return offset === available;
}

function restoreSurfaceAliases(representations: readonly Record<string, unknown>[]): void {
  for (const representation of representations) {
    const surface = representation.surface;
    const edges = representation.edges;
    if (!isRecord(surface) || !isRecord(edges)) continue;
    const marker = edges.positions;
    if (
      isRecord(marker) &&
      Object.keys(marker).length === 1 &&
      marker.$naruAlias === surfacePositionAlias
    ) {
      edges.positions = surface.positions;
    }
  }
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

function isU32Buffer(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.byteLength % 4 === 0;
}

function asDocumentPayload(
  structure: Record<string, unknown>,
  discipline: string,
): DocumentPayload | null {
  const {
    timestamp,
    document,
    semantics,
    prototypes,
    occurrences,
    representations,
    materials,
    propertyIndex,
    propertyValues,
    diagnostics,
    counts,
    prototypeReuse,
  } = structure;
  if (
    (typeof timestamp !== "string" && timestamp !== null) ||
    !isRecord(document) ||
    !isRecordArray(semantics) ||
    !isRecordArray(prototypes) ||
    !isRecordArray(occurrences) ||
    !isRecordArray(representations) ||
    !isRecordArray(materials) ||
    !isRecord(propertyIndex) ||
    !isStringArray(propertyIndex.keys) ||
    !Array.isArray(propertyIndex.sets) ||
    !propertyIndex.sets.every(
      (entry) => Array.isArray(entry) && entry.every((key) => Number.isInteger(key)),
    ) ||
    !isRecord(propertyValues) ||
    !Buffer.isBuffer(propertyValues.value_heap) ||
    !isU32Buffer(propertyValues.value_offsets) ||
    !isU32Buffer(propertyValues.row_refs) ||
    !isU32Buffer(propertyValues.row_offsets) ||
    !isRecordArray(diagnostics) ||
    !isRecord(counts) ||
    !isRecordArray(prototypeReuse)
  ) {
    return null;
  }
  return {
    discipline,
    timestamp,
    document,
    semantics,
    prototypes,
    occurrences,
    representations,
    materials,
    propertyIndex: {
      keys: propertyIndex.keys,
      sets: propertyIndex.sets as number[][],
    },
    propertyValues: {
      valueHeap: propertyValues.value_heap,
      valueOffsets: readU32Column(propertyValues.value_offsets),
      rowRefs: readU32Column(propertyValues.row_refs),
      rowOffsets: readU32Column(propertyValues.row_offsets),
    },
    diagnostics,
    counts,
    prototypeReuse,
  };
}

async function loadDocumentArtifact(
  cacheDirectory: string,
  entry: IfcFederationManifestDocument,
  manifestFloats: FloatSourceTable,
  floats: FloatSourceTable,
): Promise<ArtifactLoad> {
  const path = ifcDocumentArtifactPath(cacheDirectory, entry);
  let compressed: Buffer;
  try {
    compressed = await readFile(path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return { ok: false, reason: code === "ENOENT" ? "absent" : `unreadable artifact: ${code}` };
  }
  let decompressed: Buffer;
  try {
    decompressed = await gunzipAsync(compressed);
  } catch {
    return { ok: false, reason: "unreadable artifact: gzip" };
  }
  const newline = decompressed.indexOf(0x0a);
  if (newline < 0) return { ok: false, reason: "header is not an object" };
  let header: unknown;
  let headerFloats: FloatSourceTable;
  try {
    ({ value: header, floats: headerFloats } = parseCanonicalJson(
      decompressed.toString("utf8", 0, newline),
    ));
  } catch {
    return { ok: false, reason: "header is not an object" };
  }
  if (!isRecord(header)) return { ok: false, reason: "header is not an object" };
  if (header.schemaVersion !== ifcDocumentArtifactSchema) {
    return { ok: false, reason: "schema mismatch" };
  }
  const keyInputBytes = canonicalJsonBytes(entry.keyInput, manifestFloats);
  const expectedKey = sha256Hex(keyInputBytes);
  if (header.key !== expectedKey || entry.artifactKey !== expectedKey) {
    return { ok: false, reason: "key mismatch" };
  }
  if (
    !isRecord(header.keyInput) ||
    !canonicalJsonBytes(header.keyInput, headerFloats).equals(keyInputBytes)
  ) {
    return { ok: false, reason: "key input mismatch" };
  }
  const { payloadBytes, payloadSha256, structureBytes } = header;
  if (!isPlainInteger(payloadBytes, headerFloats, header, "payloadBytes") || payloadBytes < 0) {
    return { ok: false, reason: "payloadBytes is not a byte count" };
  }
  if (typeof payloadSha256 !== "string") {
    return { ok: false, reason: "payloadSha256 is not a digest" };
  }
  if (
    !isPlainInteger(structureBytes, headerFloats, header, "structureBytes") ||
    structureBytes < 0 ||
    structureBytes > payloadBytes
  ) {
    return { ok: false, reason: "structureBytes is not a byte count within the payload" };
  }
  const payload = decompressed.subarray(newline + 1);
  if (payload.byteLength !== payloadBytes) {
    return { ok: false, reason: "payload length mismatch" };
  }
  if (payloadSha256 !== entry.artifactPayloadSha256 || sha256Hex(payload) !== payloadSha256) {
    return { ok: false, reason: "payload digest mismatch" };
  }
  const structureText = payload.toString("utf8", 0, structureBytes);
  let structure: unknown;
  try {
    ({ value: structure } = parseCanonicalJson(structureText, floats));
  } catch {
    return { ok: false, reason: "structure is not a JSON object" };
  }
  if (!isRecord(structure)) return { ok: false, reason: "structure is not a JSON object" };
  // The parse is exact only if the structure serializes back to its own bytes.
  if (!canonicalJsonEquals(structure, floats, payload.subarray(0, structureBytes))) {
    return { ok: false, reason: "structure bytes do not round-trip" };
  }
  const regionsStart =
    payload.byteLength === structureBytes ? structureBytes : aligned(structureBytes);
  if (!attachPayloadRegions(structure, payload, regionsStart, floats)) {
    return { ok: false, reason: "region lengths do not describe the stored bytes" };
  }
  const documentPayload = asDocumentPayload(structure, entry.discipline);
  if (documentPayload === null) {
    return { ok: false, reason: "structure is not a document payload" };
  }
  if (structure.sourceDigest !== entry.sourceDigest) {
    return { ok: false, reason: "source digest mismatch" };
  }
  restoreSurfaceAliases(documentPayload.representations);
  return {
    ok: true,
    artifact: {
      payload: documentPayload,
      document: {
        discipline: entry.discipline,
        artifactKey: entry.artifactKey,
        artifactBytes: compressed.byteLength,
        payloadBytes,
        structureBytes,
      },
    },
  };
}

function compareIntegerTuples(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Port of `merge_property_indexes`: the union index plus each document's set remap. */
function mergePropertyIndexes(indexes: readonly PropertyIndex[]): {
  readonly propertyIndex: { readonly keys: string[]; readonly sets: number[][] };
  readonly setRemaps: number[][];
} {
  const keys = [...new Set(indexes.flatMap((index) => index.keys))].sort(compareCodePoints);
  const keyPositions = new Map(keys.map((key, position) => [key, position]));
  const remappedSets = indexes.map((index) =>
    index.sets.map((entry) =>
      entry.map((local) => {
        const position = keyPositions.get(index.keys[local] ?? "");
        if (position === undefined) {
          throw new RangeError("IFC document property set references an unknown key.");
        }
        return position;
      }),
    ),
  );
  const distinct = new Map<string, number[]>();
  for (const document of remappedSets) {
    for (const entry of document) distinct.set(entry.join(","), entry);
  }
  const sets = [...distinct.values()].sort(compareIntegerTuples);
  const setPositions = new Map(sets.map((entry, position) => [entry.join(","), position]));
  const setRemaps = remappedSets.map((document) =>
    document.map((entry) => setPositions.get(entry.join(",")) ?? -1),
  );
  return { propertyIndex: { keys, sets }, setRemaps };
}

interface MergedPropertyColumns extends PropertyColumns {
  readonly valueCount: number;
  readonly rowCount: number;
  readonly distinctValueCount: number;
}

/** Port of `merge_property_value_columns`: encoded values are moved, never re-encoded. */
function mergePropertyValueColumns(
  columns: readonly PropertyColumns[],
  rows: readonly (readonly [document: number, localRow: number])[],
): MergedPropertyColumns {
  // Byte strings keyed by their Latin-1 spelling sort exactly as Python sorts
  // `bytes`: code unit by code unit, shorter prefix first.
  const distinct = new Map<string, Buffer>();
  const documentKeys = columns.map((entry) => {
    const keys: string[] = [];
    for (let index = 0; index + 1 < entry.valueOffsets.length; index += 1) {
      const start = entry.valueOffsets[index] ?? 0;
      const end = entry.valueOffsets[index + 1] ?? 0;
      const key = entry.valueHeap.toString("latin1", start, end);
      keys.push(key);
      if (!distinct.has(key)) distinct.set(key, entry.valueHeap.subarray(start, end));
    }
    return keys;
  });
  const sortedKeys = [...distinct.keys()].sort();
  const positions = new Map(sortedKeys.map((key, index) => [key, index]));
  const remaps = documentKeys.map((keys) => keys.map((key) => positions.get(key) ?? 0));

  let valueCount = 0;
  const rowOffsets = new Uint32Array(rows.length + 1);
  rows.forEach(([document, localRow], row) => {
    const entry = columns[document];
    if (entry === undefined) throw new RangeError("IFC property row names an unknown document.");
    const start = entry.rowOffsets[localRow];
    const end = entry.rowOffsets[localRow + 1];
    if (start === undefined || end === undefined || end < start) {
      throw new RangeError("IFC property row is outside its document's columns.");
    }
    valueCount += end - start;
    rowOffsets[row + 1] = valueCount;
  });
  if (valueCount >= U32_LIMIT) {
    throw new RangeError("Property value columns exceed the u32 value count limit.");
  }
  const rowRefs = new Uint32Array(valueCount);
  let cursor = 0;
  for (const [document, localRow] of rows) {
    const entry = columns[document];
    const remap = remaps[document];
    if (entry === undefined || remap === undefined) continue;
    const start = entry.rowOffsets[localRow] ?? 0;
    const end = entry.rowOffsets[localRow + 1] ?? 0;
    for (let position = start; position < end; position += 1) {
      const local = entry.rowRefs[position];
      const merged = local === undefined ? undefined : remap[local];
      if (merged === undefined) {
        throw new RangeError("IFC property row references an unknown encoded value.");
      }
      rowRefs[cursor] = merged;
      cursor += 1;
    }
  }
  const valueOffsets = new Uint32Array(sortedKeys.length + 1);
  const heapParts: Buffer[] = [];
  let heapLength = 0;
  sortedKeys.forEach((key, index) => {
    const encoded = distinct.get(key);
    if (encoded === undefined) return;
    heapParts.push(encoded);
    heapLength += encoded.byteLength;
    valueOffsets[index + 1] = heapLength;
  });
  if (heapLength >= U32_LIMIT) {
    throw new RangeError("Property value columns exceed the u32 value heap bytes limit.");
  }
  if (rows.length >= U32_LIMIT) {
    throw new RangeError("Property value columns exceed the u32 row count limit.");
  }
  return {
    valueHeap: Buffer.concat(heapParts, heapLength),
    valueOffsets,
    rowRefs,
    rowOffsets,
    valueCount,
    rowCount: rows.length,
    distinctValueCount: sortedKeys.length,
  };
}

function recordId(record: Record<string, unknown>, label: string): string {
  const id = record.id;
  if (typeof id !== "string") throw new TypeError(`IFC ${label} record has no string id.`);
  return id;
}

function sortedById(
  records: readonly Record<string, unknown>[],
  label: string,
): Record<string, unknown>[] {
  return [...records].sort((left, right) =>
    compareCodePoints(recordId(left, label), recordId(right, label)),
  );
}

const ROOT_FRAME_ORIGIN = [0, 0, 0];
const ROOT_FRAME_BASIS = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function rootFrame(floats: FloatSourceTable): Record<string, unknown> {
  const origin = [...ROOT_FRAME_ORIGIN];
  const basis = [...ROOT_FRAME_BASIS];
  origin.forEach((_, index) => flagFloat(floats, origin, String(index)));
  basis.forEach((_, index) => flagFloat(floats, basis, String(index)));
  return { origin, basis, handedness: "right", upAxis: "Z" };
}

interface StreamRef {
  readonly encoding: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

/** Packs regions the way `write_scene` does: every start padded to eight bytes. */
class RegionWriter {
  private readonly chunks: Buffer[] = [];
  private offset = 0;

  append(bytes: Uint8Array, encoding: string): StreamRef {
    const padding = aligned(this.offset) - this.offset;
    if (padding > 0) {
      this.chunks.push(Buffer.alloc(padding));
      this.offset += padding;
    }
    const entry = { encoding, byteOffset: this.offset, byteLength: bytes.byteLength };
    this.chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.offset += bytes.byteLength;
    return entry;
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks, this.offset);
  }
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function packGeometry(representations: readonly Record<string, unknown>[]): Buffer {
  const writer = new RegionWriter();
  const region = (value: unknown, encoding: GeometryEncoding, label: string): StreamRef => {
    if (!Buffer.isBuffer(value)) {
      throw new TypeError(`IFC representation ${label} is not a restored region.`);
    }
    return writer.append(value, encoding);
  };
  for (const representation of representations) {
    const surface = representation.surface;
    if (!isRecord(surface) || isEmptyRecord(surface)) continue;
    const positions = surface.positions;
    const positionsRef = region(positions, "f64le", "surface.positions");
    surface.positions = positionsRef;
    surface.indices = region(surface.indices, "u32le", "surface.indices");
    if (surface.normals !== null && surface.normals !== undefined) {
      surface.normals = region(surface.normals, "f32le", "surface.normals");
    }
    const edges = representation.edges;
    if (!isRecord(edges)) continue;
    edges.positions =
      edges.positions === positions
        ? positionsRef
        : region(edges.positions, "f64le", "edges.positions");
    edges.segments = region(edges.segments, "u32le", "edges.segments");
    edges.classes = region(edges.classes, "u8", "edges.classes");
    if (edges.sourceIds !== null && edges.sourceIds !== undefined) {
      edges.sourceIds = region(edges.sourceIds, "u32le", "edges.sourceIds");
    }
  }
  return writer.finish();
}

function packProperties(columns: MergedPropertyColumns): {
  readonly header: Record<string, unknown>;
  readonly bytes: Buffer;
} {
  const writer = new RegionWriter();
  const u32 = (values: Uint32Array): StreamRef =>
    writer.append(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), "u32le");
  const header = {
    encoding: propertyColumnsEncoding,
    valueCount: columns.valueCount,
    rowCount: columns.rowCount,
    distinctValueCount: columns.distinctValueCount,
    rows: u32(columns.rowRefs),
    rowOffsets: u32(columns.rowOffsets),
    valueOffsets: u32(columns.valueOffsets),
    valueHeap: writer.append(columns.valueHeap, "utf8-json"),
  };
  return { header, bytes: writer.finish() };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    sorted[key] = sortKeysDeep(value[key]);
  }
  return sorted;
}

function integerCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`IFC document count ${label} is not an integer.`);
  }
  return value;
}

/**
 * Hydrates the artifacts a manifest names and assembles the federation.
 *
 * Returns the assembled transport, or a fallback signal naming the first
 * document whose artifact could not be verified or restored. Manifest
 * inconsistencies and the u32 column limits throw, as the adapter would.
 */
export async function assembleIfcFederation(
  options: AssembleIfcFederationOptions,
): Promise<IfcFederationAssemblyOutcome> {
  const { manifest, floats: manifestFloats } = parseManifest(options.manifest);
  const floats: FloatSourceTable = new WeakMap();
  const artifacts: LoadedArtifact[] = [];
  for (const entry of manifest.documents) {
    options.signal?.throwIfAborted();
    const loaded = await loadDocumentArtifact(
      options.cacheDirectory,
      entry,
      manifestFloats,
      floats,
    );
    if (!loaded.ok) {
      return { status: "fallback", discipline: entry.discipline, reason: loaded.reason };
    }
    artifacts.push(loaded.artifact);
  }
  const extracted = artifacts.map(({ payload }) => payload);

  // Each document interned its own keys and encoded its own values, so a
  // semantic's `set` and `row` are local to its document; the cross-document
  // sort loses that provenance, so record it first (`extract_federation`).
  extracted.forEach((item, position) => {
    for (const record of item.semantics) {
      const properties = record.properties;
      if (!isRecord(properties)) {
        throw new TypeError("IFC semantic record has no property reference.");
      }
      properties.document = position;
    }
  });
  const federationDigest = manifest.federation.sourceDigest;
  const identity = federationDigest.slice(0, 16);
  const createdAtCandidates = extracted
    .map((item) => item.timestamp)
    .filter((timestamp): timestamp is string => typeof timestamp === "string" && timestamp !== "")
    .sort(compareCodePoints);
  const units = { length: "m", angle: "rad", scaleToMeters: 1 };
  flagFloat(floats, units, "scaleToMeters");
  const semantics = sortedById(
    extracted.flatMap((item) => item.semantics),
    "semantic",
  );
  const materialsById = new Map<string, Record<string, unknown>>();
  for (const item of extracted) {
    for (const record of item.materials) materialsById.set(recordId(record, "material"), record);
  }
  const representations = sortedById(
    extracted.flatMap((item) => item.representations),
    "representation",
  );
  const diagnostics: Record<string, unknown>[] = [
    ...extracted.flatMap((item) => item.diagnostics),
    {
      severity: "info",
      code: "IFC_EDGE_CLASSIFICATION_BOUNDARY_ONLY",
      message:
        "IfcOpenShell OpenCascade face-boundary segments are explicit edges; " +
        "analytic curve kinds and sharp/smooth/seam classes are not yet retained.",
      data: {
        schema: "naru.ifc-adapter.2",
        entries: { handling: "tessellated-boundary-segments" },
      },
    },
  ];

  const { propertyIndex, setRemaps } = mergePropertyIndexes(
    extracted.map((item) => item.propertyIndex),
  );
  const rows = semantics.map((semantic) => {
    const properties = semantic.properties as Record<string, unknown>;
    const document = properties.document;
    const row = properties.row;
    if (typeof document !== "number" || typeof row !== "number" || !Number.isInteger(row)) {
      throw new TypeError("IFC semantic record has an invalid property row.");
    }
    return [document, row] as const;
  });
  const columns = mergePropertyValueColumns(
    extracted.map((item) => item.propertyValues),
    rows,
  );
  const mergedSets: number[] = [];
  semantics.forEach((semantic, row) => {
    const properties = semantic.properties as Record<string, unknown>;
    const document = properties.document as number;
    const localSet = properties.set;
    const mergedSet =
      typeof localSet === "number" ? setRemaps[document]?.[localSet] : undefined;
    if (mergedSet === undefined || mergedSet < 0) {
      throw new RangeError("IFC semantic record references an unknown property set.");
    }
    mergedSets.push(mergedSet);
    semantic.properties = { schema: properties.schema, set: mergedSet, row };
  });
  const expectedValueCount = mergedSets.reduce(
    (total, mergedSet) => total + (propertyIndex.sets[mergedSet]?.length ?? 0),
    0,
  );
  if (expectedValueCount !== columns.valueCount) {
    throw new RangeError(
      "Property value columns lost values: key sets expect " +
        `${String(expectedValueCount)}, encoded ${String(columns.valueCount)}.`,
    );
  }

  const geometry = packGeometry(representations);
  const { header: propertyValues, bytes: properties } = packProperties(columns);
  const scene: Record<string, unknown> = {
    schemaVersion: "0.1",
    sceneId: `scene:ifc-federation:${identity}`,
    revision: {
      id: `revision:ifc-federation:${identity}`,
      sourceDigest: `sha256:${federationDigest}`,
      adapter: { name: adapterName, version: manifest.adapter.version },
      createdAt: createdAtCandidates.at(-1) ?? "1970-01-01T00:00:00.000Z",
      optionsDigest: `sha256:${sha256Hex(canonicalJsonBytes(manifest.federation.options, manifestFloats))}`,
    },
    units,
    rootFrame: rootFrame(floats),
    documents: extracted.map((item) => item.document),
    prototypes: sortedById(
      extracted.flatMap((item) => item.prototypes),
      "prototype",
    ),
    occurrences: sortedById(
      extracted.flatMap((item) => item.occurrences),
      "occurrence",
    ),
    semantics,
    representations,
    materials: sortedById([...materialsById.values()], "material"),
    diagnostics,
    propertyIndex,
    propertyValues,
  };
  const structure = digestCanonicalJson(scene, floats, "\n");

  const totals = new Map<string, number>();
  for (const item of extracted) {
    for (const [key, value] of Object.entries(item.counts)) {
      if (key === "maxHierarchyDepth") continue;
      totals.set(key, (totals.get(key) ?? 0) + integerCount(value, key));
    }
  }
  totals.set("documentCount", extracted.length);
  totals.set(
    "maxHierarchyDepth",
    extracted.reduce(
      (depth, item) => Math.max(depth, integerCount(item.counts.maxHierarchyDepth, "maxHierarchyDepth")),
      0,
    ),
  );
  totals.set(
    "reusedGeometryOccurrenceCount",
    extracted.reduce(
      (total, item) =>
        total +
        item.prototypeReuse.reduce(
          (reused, record) =>
            reused + Math.max(0, integerCount(record.occurrenceCount, "occurrenceCount") - 1),
          0,
        ),
      0,
    ),
  );
  totals.set("propertyKeyCount", propertyIndex.keys.length);
  totals.set("propertySetCount", propertyIndex.sets.length);
  totals.set("propertyDistinctValueCount", columns.distinctValueCount);
  const severityCounts = new Map<string, number>();
  const codes = new Set<string>();
  for (const diagnostic of diagnostics) {
    const severity = diagnostic.severity;
    const code = diagnostic.code;
    if (typeof severity !== "string" || typeof code !== "string") {
      throw new TypeError("IFC diagnostic record has no severity and code.");
    }
    severityCounts.set(severity, (severityCounts.get(severity) ?? 0) + 1);
    codes.add(code);
  }
  const report = sortKeysDeep({
    schemaVersion: adapterReportSchema,
    adapter: {
      name: adapterName,
      version: manifest.adapter.version,
      geometryLibrary: "opencascade",
    },
    federation: {
      sourceDigest: federationDigest,
      documentOrder: manifest.federation.documentOrder,
      options: manifest.federation.options,
    },
    sources: manifest.documents.map((entry, index) => {
      const item = extracted[index];
      const document = item?.document ?? {};
      const documentUnits = isRecord(document.units) ? document.units : {};
      return {
        discipline: entry.discipline,
        path: entry.uriHint,
        byteLength: entry.byteLength,
        sha256: entry.sourceDigest,
        schema: document.formatVersion,
        unitScaleToMeters: documentUnits.scaleToMeters,
        counts: item?.counts,
      };
    }),
    documentArtifactCache: manifest.documentArtifactCache,
    counts: Object.fromEntries(totals),
    prototypeReuse: extracted.flatMap((item) => item.prototypeReuse.slice(0, 20)),
    diagnostics: {
      counts: Object.fromEntries(severityCounts),
      codes: [...codes].sort(compareCodePoints),
    },
    limitations: [
      "IFC edges retain tessellated OpenCascade face boundaries and source " +
        "representation-item ids, but not analytic curve kinds or " +
        "sharp/smooth/seam classification.",
      "Properties are flattened for the first queryable semantic slice; " +
        "keys and key-sets are interned into the scene propertyIndex and " +
        "the values live in the binary property column file.",
      "Cross-document object reconciliation is document-scoped and not inferred from names.",
    ],
    scene: {
      encodingVersion: ifcSceneSplitEncodingVersion,
      structure,
      geometry: { byteLength: geometry.byteLength, sha256: sha256Hex(geometry) },
      properties: { byteLength: properties.byteLength, sha256: sha256Hex(properties) },
    },
  }) as Record<string, unknown>;
  return {
    status: "assembled",
    scene,
    structure,
    geometry,
    properties,
    report,
    documents: artifacts.map(({ document }) => document),
  };
}
