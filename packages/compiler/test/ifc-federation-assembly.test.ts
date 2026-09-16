import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  digestCanonicalJson,
  flagFloat,
} from "../src/canonical-json.js";
import type { FloatSourceTable } from "../src/canonical-json.js";
import {
  assembleIfcFederation,
  ifcDocumentArtifactPath,
  ifcDocumentArtifactSchema,
  ifcFederationManifestSchema,
  parseIfcFederationManifest,
} from "../src/ifc-federation-assembly.js";
import type {
  IfcFederationAssembly,
  IfcFederationManifestDocument,
} from "../src/ifc-federation-assembly.js";

const execFileAsync = promisify(execFile);

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function u32(values: readonly number[]): Buffer {
  return Buffer.from(new Uint32Array(values).buffer);
}

function u32View(bytes: Buffer): Uint32Array {
  const column = new Uint32Array(bytes.byteLength / 4);
  Buffer.from(column.buffer).set(bytes);
  return column;
}

function f64(values: readonly number[]): Buffer {
  return Buffer.from(new Float64Array(values).buffer);
}

function f32(values: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function encodedHeap(values: readonly string[]): { heap: Buffer; offsets: number[] } {
  const parts = values.map((value) => Buffer.from(value, "utf8"));
  const offsets = [0];
  for (const part of parts) offsets.push((offsets.at(-1) ?? 0) + part.byteLength);
  return { heap: Buffer.concat(parts), offsets };
}

type Json = Record<string, unknown>;

/**
 * Writes one `naru.ifc-document-artifact.4` file the way the adapter's
 * `write_document_artifact` does: Buffer members of representations and
 * property columns are hoisted out of the structure as their byte lengths,
 * edge positions that share the surface buffer become the alias marker, and
 * the regions follow the structure JSON at eight-byte alignment.
 */
async function writeArtifact(
  cacheDirectory: string,
  keyInput: Json,
  structure: Json,
  floats?: FloatSourceTable,
): Promise<{ key: string; payloadSha256: string; payloadBytes: number; structureBytes: number }> {
  const regions: Buffer[] = [];
  const hoist = (block: Json, field: string): void => {
    const value = block[field];
    if (Buffer.isBuffer(value)) {
      regions.push(value);
      block[field] = value.byteLength;
    }
  };
  const representations = structure.representations as Json[];
  for (const representation of representations) {
    const surface = representation.surface as Json | undefined;
    const edges = representation.edges as Json | undefined;
    if (edges && surface && edges.positions === surface.positions) {
      edges.positions = { $naruAlias: "surface.positions" };
    }
    if (surface) for (const field of ["positions", "indices", "normals"]) hoist(surface, field);
    if (edges) for (const field of ["positions", "segments", "classes", "sourceIds"]) hoist(edges, field);
  }
  const columns = structure.propertyValues as Json;
  for (const field of ["value_heap", "value_offsets", "row_refs", "row_offsets"]) hoist(columns, field);
  const structureBytes = canonicalJsonBytes(structure, floats);
  const parts: Buffer[] = [structureBytes];
  let offset = structureBytes.byteLength;
  const align = (): void => {
    const padding = (8 - (offset % 8)) % 8;
    if (padding > 0) {
      parts.push(Buffer.alloc(padding));
      offset += padding;
    }
  };
  if (regions.length > 0) align();
  for (const region of regions) {
    align();
    parts.push(region);
    offset += region.byteLength;
  }
  const payload = Buffer.concat(parts, offset);
  const key = sha256(canonicalJsonBytes(keyInput));
  const header = {
    key,
    keyInput,
    payloadBytes: payload.byteLength,
    payloadSha256: sha256(payload),
    structureBytes: structureBytes.byteLength,
    schemaVersion: ifcDocumentArtifactSchema,
  };
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(
    join(cacheDirectory, `${key}.json.gz`),
    gzipSync(Buffer.concat([canonicalJsonBytes(header), Buffer.from("\n"), payload])),
  );
  return {
    key,
    payloadSha256: header.payloadSha256,
    payloadBytes: payload.byteLength,
    structureBytes: structureBytes.byteLength,
  };
}

const adapterIdentity = {
  schemaVersion: "naru.ifc-adapter-identity.1",
  name: "IfcOpenShell",
  version: "0.8.5",
  fingerprint: sha256("fake-adapter"),
  toolchain: { ifcopenshell: "0.8.5", numpy: "2.5.2", python: "3.13.2" },
};
const federationOptions = { geometryLibrary: "opencascade", weldVertices: true };

function keyInputFor(discipline: string, sourceDigest: string): Json {
  return {
    schemaVersion: "naru.ifc-document-artifact-key.1",
    discipline,
    sourceDigest,
    uriHint: `${discipline}.ifc`,
    threads: 1,
    adapterFingerprint: adapterIdentity.fingerprint,
  };
}

/** A document payload the way `inspect_documents` publishes one per discipline. */
function documentStructure(
  discipline: string,
  sourceDigest: string,
  properties: { keys: string[]; sets: number[][]; values: string[]; rows: number[][] },
  records: Partial<Json>,
): Json {
  const heap = encodedHeap(properties.values);
  const rowRefs = properties.rows.flat();
  const rowOffsets = [0];
  for (const row of properties.rows) rowOffsets.push((rowOffsets.at(-1) ?? 0) + row.length);
  return {
    sourceDigest,
    timestamp: `2026-09-1${discipline.length}T00:00:00.000Z`,
    document: {
      id: `document:${discipline}`,
      discipline,
      formatVersion: "IFC4",
      units: { length: "m", scaleToMeters: 0.001 },
    },
    semantics: [],
    prototypes: [],
    occurrences: [],
    representations: [],
    materials: [],
    propertyIndex: { keys: properties.keys, sets: properties.sets },
    propertyValues: {
      value_heap: heap.heap,
      value_offsets: u32(heap.offsets),
      row_refs: u32(rowRefs),
      row_offsets: u32(rowOffsets),
      value_count: rowRefs.length,
      row_count: properties.rows.length,
      distinct_value_count: properties.values.length,
    },
    diagnostics: [],
    counts: {
      occurrenceCount: 0,
      semanticCount: 0,
      maxHierarchyDepth: 1,
      propertyValueCount: rowRefs.length,
    },
    prototypeReuse: [],
    ...records,
  };
}

interface Fixture {
  readonly cacheDirectory: string;
  readonly manifestPath: string;
  readonly manifest: Json;
  readonly documents: IfcFederationManifestDocument[];
  readonly architecture: { readonly positions: Buffer; readonly indices: Buffer; readonly segments: Buffer; readonly classes: Buffer };
  readonly structure: { readonly positions: Buffer; readonly indices: Buffer; readonly normals: Buffer; readonly edgePositions: Buffer; readonly segments: Buffer; readonly classes: Buffer; readonly sourceIds: Buffer };
}

/**
 * Two disciplines sharing a material id, interned keys, and encoded values;
 * document order is architecture then structure, but every record id sorts
 * across both so the merge has to interleave them.
 */
async function writeFixture(root: string): Promise<Fixture> {
  const cacheDirectory = join(root, "ifc-documents");
  const architectureDigest = sha256("architecture source");
  const structureDigest = sha256("structure source");
  const architecture = {
    positions: f64([0, 0, 0, 1, 0, 0, 1, 1, 0]),
    indices: u32([0, 1, 2]),
    segments: u32([0, 1, 1, 2, 2, 0]),
    classes: Buffer.from([1, 1, 1]),
  };
  const architectureSurface: Json = {
    positions: architecture.positions,
    indices: architecture.indices,
    normals: null,
  };
  const architectureStructure = documentStructure(
    "architecture",
    architectureDigest,
    {
      keys: ["Pset_Wall.FireRating", "Pset_Wall.IsExternal", "ifc.type"],
      sets: [[0, 2], [1, 2]],
      values: ['"IfcWall"', '"REI60"', "true"],
      rows: [[1, 0], [2, 0]],
    },
    {
      semantics: [
        { id: "semantic:b", target: "occurrence:b", properties: { schema: "naru.ifc-semantic.1", set: 0, row: 0 } },
        { id: "semantic:d", target: "occurrence:d", properties: { schema: "naru.ifc-semantic.1", set: 1, row: 1 } },
      ],
      prototypes: [{ id: "prototype:wall", representation: "representation:wall" }],
      occurrences: [
        { id: "occurrence:b", prototype: "prototype:wall", material: "material:steel", parent: null },
        { id: "occurrence:d", prototype: "prototype:wall", material: "material:steel", parent: "occurrence:b" },
      ],
      representations: [
        {
          id: "representation:wall",
          surface: architectureSurface,
          edges: {
            positions: architecture.positions,
            segments: architecture.segments,
            classes: architecture.classes,
            sourceIds: null,
          },
        },
      ],
      materials: [{ id: "material:steel", name: "Steel (architecture)" }],
      diagnostics: [{ severity: "warning", code: "IFC_UNITS_ASSUMED", message: "mm assumed" }],
      counts: { occurrenceCount: 2, semanticCount: 2, maxHierarchyDepth: 2, propertyValueCount: 4 },
      prototypeReuse: [{ prototypeId: "prototype:wall", occurrenceCount: 2 }],
    },
  );
  const structure = {
    positions: f64([5, 5, 5, 6, 5, 5, 6, 6, 5, 5, 6, 5]),
    indices: u32([0, 1, 2, 0, 2, 3]),
    normals: f32([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    edgePositions: f64([5, 5, 5, 6, 6, 5]),
    segments: u32([0, 1]),
    classes: Buffer.from([2]),
    sourceIds: u32([17]),
  };
  const structureStructure = documentStructure(
    "structure",
    structureDigest,
    {
      keys: ["Pset_Beam.Span", "Pset_Wall.IsExternal", "ifc.type"],
      sets: [[0, 2], [1, 2]],
      values: ['"IfcBeam"', '"IfcWall"', "3.5", "false"],
      rows: [[2, 0], [3, 1]],
    },
    {
      semantics: [
        { id: "semantic:a", target: "occurrence:a", properties: { schema: "naru.ifc-semantic.1", set: 0, row: 0 } },
        { id: "semantic:c", target: "occurrence:c", properties: { schema: "naru.ifc-semantic.1", set: 1, row: 1 } },
      ],
      prototypes: [{ id: "prototype:beam", representation: "representation:beam" }],
      occurrences: [
        { id: "occurrence:a", prototype: "prototype:beam", material: "material:steel", parent: null },
        { id: "occurrence:c", prototype: "prototype:beam", material: "material:concrete", parent: null },
      ],
      representations: [
        {
          id: "representation:beam",
          surface: { positions: structure.positions, indices: structure.indices, normals: structure.normals },
          edges: {
            positions: structure.edgePositions,
            segments: structure.segments,
            classes: structure.classes,
            sourceIds: structure.sourceIds,
          },
        },
        { id: "representation:empty", surface: {}, edges: null },
      ],
      materials: [
        { id: "material:steel", name: "Steel (structure)" },
        { id: "material:concrete", name: "Concrete" },
      ],
      counts: { occurrenceCount: 2, semanticCount: 2, maxHierarchyDepth: 1, propertyValueCount: 4 },
      prototypeReuse: [{ prototypeId: "prototype:beam", occurrenceCount: 2 }],
    },
  );
  const documents: IfcFederationManifestDocument[] = [];
  for (const [discipline, sourceDigest, payload] of [
    ["architecture", architectureDigest, architectureStructure],
    ["structure", structureDigest, structureStructure],
  ] as const) {
    const keyInput = keyInputFor(discipline, sourceDigest);
    const written = await writeArtifact(cacheDirectory, keyInput, payload);
    documents.push({
      discipline,
      uriHint: `${discipline}.ifc`,
      sourceDigest,
      byteLength: 1000 + discipline.length,
      keyInput,
      artifactKey: written.key,
      artifactPayloadSha256: written.payloadSha256,
      outcome: "extracted",
    });
  }
  const manifest: Json = {
    schemaVersion: ifcFederationManifestSchema,
    artifactSchemaVersion: ifcDocumentArtifactSchema,
    adapter: adapterIdentity,
    federation: {
      sourceDigest: sha256(
        canonicalJsonBytes(
          documents.map((document) => ({ discipline: document.discipline, sha256: document.sourceDigest })),
        ),
      ),
      documentOrder: ["architecture", "structure"],
      options: federationOptions,
    },
    documents,
    documentArtifactCache: {
      schemaVersion: ifcDocumentArtifactSchema,
      status: "enabled",
      hits: [],
      misses: ["architecture", "structure"],
    },
  };
  const manifestPath = join(root, "federation-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { cacheDirectory, manifestPath, manifest, documents, architecture, structure };
}

async function assembleFixture(fixture: Fixture, manifest?: string) {
  return assembleIfcFederation({
    manifest: manifest ?? (await readFile(fixture.manifestPath, "utf8")),
    cacheDirectory: fixture.cacheDirectory,
  });
}

function expectAssembled(outcome: Awaited<ReturnType<typeof assembleIfcFederation>>): IfcFederationAssembly {
  expect(outcome.status).toBe("assembled");
  if (outcome.status !== "assembled") throw new Error("unreachable");
  return outcome;
}

interface StreamRef {
  readonly encoding: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

function slice(bytes: Buffer, ref: unknown): Buffer {
  const { byteOffset, byteLength } = ref as StreamRef;
  return bytes.subarray(byteOffset, byteOffset + byteLength);
}

describe("assembleIfcFederation on synthetic artifacts", () => {
  let root: string;
  let fixture: Fixture;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "naru-ifc-assembly-"));
    fixture = await writeFixture(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("parses the manifest it wrote", async () => {
    const manifest = parseIfcFederationManifest(await readFile(fixture.manifestPath, "utf8"));
    expect(manifest.documents.map((document) => document.discipline)).toEqual([
      "architecture",
      "structure",
    ]);
    expect(manifest.adapter.version).toBe("0.8.5");
    expect(ifcDocumentArtifactPath(fixture.cacheDirectory, manifest.documents[0]!)).toBe(
      join(fixture.cacheDirectory, `${fixture.documents[0]!.artifactKey}.json.gz`),
    );
  });

  it("merges records the way extract_federation does", async () => {
    const assembled = expectAssembled(await assembleFixture(fixture));
    const scene = assembled.scene;
    const ids = (key: string) => (scene[key] as Json[]).map((record) => record.id);
    expect(ids("semantics")).toEqual(["semantic:a", "semantic:b", "semantic:c", "semantic:d"]);
    expect(ids("occurrences")).toEqual(["occurrence:a", "occurrence:b", "occurrence:c", "occurrence:d"]);
    expect(ids("prototypes")).toEqual(["prototype:beam", "prototype:wall"]);
    expect(ids("representations")).toEqual(["representation:beam", "representation:empty", "representation:wall"]);
    expect(scene.materials).toEqual([
      { id: "material:concrete", name: "Concrete" },
      { id: "material:steel", name: "Steel (structure)" },
    ]);
    expect((scene.documents as Json[]).map((document) => document.id)).toEqual([
      "document:architecture",
      "document:structure",
    ]);
    const federationDigest = (fixture.manifest.federation as Json).sourceDigest as string;
    expect(scene.sceneId).toBe(`scene:ifc-federation:${federationDigest.slice(0, 16)}`);
    expect(scene.revision).toEqual({
      id: `revision:ifc-federation:${federationDigest.slice(0, 16)}`,
      sourceDigest: `sha256:${federationDigest}`,
      adapter: { name: "IfcOpenShell", version: "0.8.5" },
      createdAt: "2026-09-19T00:00:00.000Z",
      optionsDigest: `sha256:${sha256(canonicalJsonBytes(federationOptions))}`,
    });
    const diagnostics = scene.diagnostics as Json[];
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "IFC_UNITS_ASSUMED",
      "IFC_EDGE_CLASSIFICATION_BOUNDARY_ONLY",
    ]);
  });

  it("remaps interned keys, key sets, and encoded values without re-encoding", async () => {
    const assembled = expectAssembled(await assembleFixture(fixture));
    const scene = assembled.scene;
    expect(scene.propertyIndex).toEqual({
      keys: ["Pset_Beam.Span", "Pset_Wall.FireRating", "Pset_Wall.IsExternal", "ifc.type"],
      sets: [[0, 3], [1, 3], [2, 3]],
    });
    expect((scene.semantics as Json[]).map((semantic) => semantic.properties)).toEqual([
      { schema: "naru.ifc-semantic.1", set: 0, row: 0 },
      { schema: "naru.ifc-semantic.1", set: 1, row: 1 },
      { schema: "naru.ifc-semantic.1", set: 2, row: 2 },
      { schema: "naru.ifc-semantic.1", set: 2, row: 3 },
    ]);
    const columns = scene.propertyValues as Json;
    expect(columns.encoding).toBe("madi.property-columns.1");
    expect([columns.valueCount, columns.rowCount, columns.distinctValueCount]).toEqual([8, 4, 6]);
    const properties = assembled.properties;
    const valueOffsets = u32View(slice(properties, columns.valueOffsets));
    const heap = slice(properties, columns.valueHeap);
    const values = Array.from(valueOffsets.subarray(1), (end, index) =>
      heap.toString("utf8", valueOffsets[index], end),
    );
    // Byte order of the encoded JSON text, each distinct value exactly once.
    expect(values).toEqual(['"IfcBeam"', '"IfcWall"', '"REI60"', "3.5", "false", "true"]);
    const rows = u32View(slice(properties, columns.rows));
    const rowOffsets = u32View(slice(properties, columns.rowOffsets));
    expect([...rowOffsets]).toEqual([0, 2, 4, 6, 8]);
    expect([...rows]).toEqual([3, 0, 2, 1, 4, 1, 5, 1]);
    expect((columns.rows as StreamRef).byteOffset).toBe(0);
    expect((columns.rowOffsets as StreamRef).byteOffset).toBe(32);
    expect((columns.valueOffsets as StreamRef).byteOffset).toBe(56);
    expect((columns.valueHeap as StreamRef).byteOffset).toBe(88);
    expect(properties.byteLength).toBe(88 + heap.byteLength);
  });

  it("packs geometry streams with write_scene's padding and alias rules", async () => {
    const assembled = expectAssembled(await assembleFixture(fixture));
    const [beam, empty, wall] = assembled.scene.representations as Json[];
    const geometry = assembled.geometry;
    const beamSurface = beam!.surface as Json;
    const beamEdges = beam!.edges as Json;
    expect(beamSurface.positions).toEqual({ encoding: "f64le", byteOffset: 0, byteLength: 96 });
    expect(beamSurface.indices).toEqual({ encoding: "u32le", byteOffset: 96, byteLength: 24 });
    expect(beamSurface.normals).toEqual({ encoding: "f32le", byteOffset: 120, byteLength: 48 });
    expect(beamEdges.positions).toEqual({ encoding: "f64le", byteOffset: 168, byteLength: 48 });
    expect(beamEdges.segments).toEqual({ encoding: "u32le", byteOffset: 216, byteLength: 8 });
    expect(beamEdges.classes).toEqual({ encoding: "u8", byteOffset: 224, byteLength: 1 });
    expect(beamEdges.sourceIds).toEqual({ encoding: "u32le", byteOffset: 232, byteLength: 4 });
    expect(empty).toEqual({ id: "representation:empty", surface: {}, edges: null });
    const wallSurface = wall!.surface as Json;
    const wallEdges = wall!.edges as Json;
    expect(wallSurface.positions).toEqual({ encoding: "f64le", byteOffset: 240, byteLength: 72 });
    expect(wallSurface.indices).toEqual({ encoding: "u32le", byteOffset: 312, byteLength: 12 });
    expect(wallSurface.normals).toBeNull();
    expect(wallEdges.positions).toBe(wallSurface.positions);
    expect(wallEdges.segments).toEqual({ encoding: "u32le", byteOffset: 328, byteLength: 24 });
    expect(wallEdges.classes).toEqual({ encoding: "u8", byteOffset: 352, byteLength: 3 });
    expect(wallEdges.sourceIds).toBeNull();
    expect(geometry.byteLength).toBe(355);
    expect(slice(geometry, beamSurface.normals).equals(fixture.structure.normals)).toBe(true);
    expect(slice(geometry, beamEdges.positions).equals(fixture.structure.edgePositions)).toBe(true);
    expect(slice(geometry, wallSurface.positions).equals(fixture.architecture.positions)).toBe(true);
    expect(slice(geometry, wallEdges.classes).equals(fixture.architecture.classes)).toBe(true);
    expect(geometry.subarray(225, 232).equals(Buffer.alloc(7))).toBe(true);
  });

  it("digests the structure as Python's canonical JSON plus a newline", async () => {
    const assembled = expectAssembled(await assembleFixture(fixture));
    const floats: FloatSourceTable = new WeakMap();
    const scene = assembled.scene;
    flagFloat(floats, scene.units as object, "scaleToMeters");
    const rootFrame = scene.rootFrame as { origin: number[]; basis: number[] };
    rootFrame.origin.forEach((_, index) => flagFloat(floats, rootFrame.origin, String(index)));
    rootFrame.basis.forEach((_, index) => flagFloat(floats, rootFrame.basis, String(index)));
    expect(assembled.structure).toEqual(digestCanonicalJson(scene, floats, "\n"));
    const text = canonicalJsonBytes(scene, floats).toString("utf8");
    expect(text).toContain('"units":{"angle":"rad","length":"m","scaleToMeters":1.0}');
    expect(text).toContain('"origin":[0.0,0.0,0.0]');
    expect(text).toContain('"scaleToMeters":0.001');
    expect(text.startsWith('{"diagnostics":[')).toBe(true);
  });

  it("reports the report.6 fields the adapter derives from the merge", async () => {
    const assembled = expectAssembled(await assembleFixture(fixture));
    const report = assembled.report;
    expect(Object.keys(report)).toEqual([
      "adapter",
      "counts",
      "diagnostics",
      "documentArtifactCache",
      "federation",
      "limitations",
      "prototypeReuse",
      "scene",
      "schemaVersion",
      "sources",
    ]);
    expect(report.schemaVersion).toBe("naru.ifc-adapter-report.6");
    expect(report.counts).toEqual({
      documentCount: 2,
      maxHierarchyDepth: 2,
      occurrenceCount: 4,
      propertyDistinctValueCount: 6,
      propertyKeyCount: 4,
      propertySetCount: 3,
      propertyValueCount: 8,
      reusedGeometryOccurrenceCount: 2,
      semanticCount: 4,
    });
    expect(report.diagnostics).toEqual({
      codes: ["IFC_EDGE_CLASSIFICATION_BOUNDARY_ONLY", "IFC_UNITS_ASSUMED"],
      counts: { info: 1, warning: 1 },
    });
    expect((report.sources as Json[]).map((source) => [source.path, source.byteLength, source.schema, source.unitScaleToMeters])).toEqual([
      ["architecture.ifc", 1012, "IFC4", 0.001],
      ["structure.ifc", 1009, "IFC4", 0.001],
    ]);
    expect(report.scene).toEqual({
      encodingVersion: "naru.ifc-scene-ir-split.4",
      structure: assembled.structure,
      geometry: { byteLength: 355, sha256: sha256(assembled.geometry) },
      properties: { byteLength: assembled.properties.byteLength, sha256: sha256(assembled.properties) },
    });
    expect(report.documentArtifactCache).toEqual(fixture.manifest.documentArtifactCache);
    expect(assembled.documents.map((document) => document.discipline)).toEqual(["architecture", "structure"]);
    expect(assembled.documents[0]!.structureBytes).toBeGreaterThan(0);
  });

  it("assembles identically on repeated runs", async () => {
    const first = expectAssembled(await assembleFixture(fixture));
    const second = expectAssembled(await assembleFixture(fixture));
    expect(second.structure).toEqual(first.structure);
    expect(second.geometry.equals(first.geometry)).toBe(true);
    expect(second.properties.equals(first.properties)).toBe(true);
    expect(JSON.stringify(second.report)).toBe(JSON.stringify(first.report));
  });

  it("falls back instead of throwing when an artifact does not verify", async () => {
    const tamperedRoot = await mkdtemp(join(tmpdir(), "naru-ifc-assembly-tamper-"));
    try {
      const tampered = await writeFixture(tamperedRoot);
      const manifestText = await readFile(tampered.manifestPath, "utf8");
      const structurePath = ifcDocumentArtifactPath(tampered.cacheDirectory, tampered.documents[1]!);
      const original = await readFile(structurePath);
      await rm(structurePath);
      expect(await assembleFixture(tampered, manifestText)).toEqual({
        status: "fallback",
        discipline: "structure",
        reason: "absent",
      });
      await writeFile(structurePath, Buffer.from("not gzip"));
      expect(await assembleFixture(tampered, manifestText)).toMatchObject({
        status: "fallback",
        discipline: "structure",
        reason: "unreadable artifact: gzip",
      });
      await writeFile(structurePath, original);
      expect((await assembleFixture(tampered, manifestText)).status).toBe("assembled");

      const manifest = JSON.parse(manifestText) as { documents: Json[] };
      manifest.documents[0]!.artifactPayloadSha256 = sha256("other payload");
      expect(await assembleFixture(tampered, JSON.stringify(manifest))).toEqual({
        status: "fallback",
        discipline: "architecture",
        reason: "payload digest mismatch",
      });
      const swappedKeys = JSON.parse(manifestText) as { documents: Json[] };
      swappedKeys.documents[0]!.artifactKey = swappedKeys.documents[1]!.artifactKey;
      expect(await assembleFixture(tampered, JSON.stringify(swappedKeys))).toEqual({
        status: "fallback",
        discipline: "architecture",
        reason: "key mismatch",
      });
    } finally {
      await rm(tamperedRoot, { recursive: true, force: true });
    }
  });

  it("rejects a manifest that disagrees with itself", async () => {
    const manifestText = await readFile(fixture.manifestPath, "utf8");
    const reordered = JSON.parse(manifestText) as { federation: Json };
    reordered.federation.documentOrder = ["structure", "architecture"];
    expect(() => parseIfcFederationManifest(JSON.stringify(reordered))).toThrow(/assembly order/u);
    const wrongDigest = JSON.parse(manifestText) as { federation: Json };
    wrongDigest.federation.sourceDigest = sha256("other");
    expect(() => parseIfcFederationManifest(JSON.stringify(wrongDigest))).toThrow(/digest/u);
    const wrongSchema = JSON.parse(manifestText) as Json;
    wrongSchema.schemaVersion = "naru.ifc-federation-manifest.2";
    expect(() => parseIfcFederationManifest(JSON.stringify(wrongSchema))).toThrow(/schema version/u);
    const partialCache = JSON.parse(manifestText) as { documentArtifactCache: Json };
    partialCache.documentArtifactCache.misses = ["architecture"];
    expect(() => parseIfcFederationManifest(JSON.stringify(partialCache))).toThrow(/coverage/u);
    await expect(
      assembleIfcFederation({ manifest: JSON.stringify(reordered), cacheDirectory: fixture.cacheDirectory }),
    ).rejects.toThrow(/assembly order/u);
  });
});

const adapterPython = process.env.NARU_IFC_PYTHON;
const adapterScript = fileURLToPath(
  new URL("../../../native/adapter-ifc/tools/extract_federation_scene_ir.py", import.meta.url),
);
const wallFixture = fileURLToPath(new URL("../../../fixtures/ifc/explicit-edge-wall.ifc", import.meta.url));

describe.skipIf(adapterPython === undefined || adapterPython === "")("assembleIfcFederation versus the monolithic adapter", () => {
  it(
    "reproduces the adapter's structure, geometry, properties, and report byte for byte",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "naru-ifc-assembly-adapter-"));
      try {
        const python = adapterPython ?? "python";
        const documents = ["architecture", "structure"].flatMap((discipline) => [
          "--document",
          `${discipline}=${wallFixture}`,
          "--uri-hint",
          `${discipline}=explicit-edge-wall.ifc`,
        ]);
        const monolithic = join(root, "monolithic");
        await mkdir(monolithic);
        await execFileAsync(python, [
          adapterScript,
          ...documents,
          "--scene",
          join(monolithic, "scene-ir.json"),
          "--geometry",
          join(monolithic, "scene-ir-geometry.bin"),
          "--properties",
          join(monolithic, "scene-ir-properties.bin"),
          "--report",
          join(monolithic, "adapter-report.json"),
          "--threads",
          "1",
        ]);
        const cacheDirectory = join(root, "ifc-documents");
        const manifestPath = join(root, "federation-manifest.json");
        await execFileAsync(python, [
          adapterScript,
          ...documents,
          "--document-cache",
          cacheDirectory,
          "--federation-manifest",
          manifestPath,
          "--threads",
          "1",
        ]);
        const assembled = expectAssembled(
          await assembleIfcFederation({
            manifest: await readFile(manifestPath, "utf8"),
            cacheDirectory,
          }),
        );
        const expectedReport = JSON.parse(await readFile(join(monolithic, "adapter-report.json"), "utf8")) as Json;
        const expectedStructure = await readFile(join(monolithic, "scene-ir.json"));
        expect(assembled.structure).toEqual({
          byteLength: expectedStructure.byteLength,
          sha256: sha256(expectedStructure),
        });
        expect(assembled.geometry.equals(await readFile(join(monolithic, "scene-ir-geometry.bin")))).toBe(true);
        expect(assembled.properties.equals(await readFile(join(monolithic, "scene-ir-properties.bin")))).toBe(true);
        const { documentArtifactCache: expectedCache, ...expectedRest } = expectedReport;
        const { documentArtifactCache: actualCache, ...actualRest } = assembled.report;
        expect(JSON.stringify(actualRest, null, 2)).toBe(JSON.stringify(expectedRest, null, 2));
        expect(actualCache).toMatchObject({ status: "enabled", misses: ["architecture", "structure"] });
        expect(expectedCache).not.toEqual(actualCache);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
