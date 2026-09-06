import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openPropertyValueColumns,
  parsePackageProperties,
  resolvePropertyEntries,
} from "@naru3d/scene-ir";
import { describe, expect, it, vi } from "vitest";

import { compileIfcFederation } from "../src/ifc-federation.js";
import { importJobEventSchema } from "../src/import-job.js";
import type { ImportJobEvent } from "../src/import-job.js";
import {
  StagedPreviewError,
  stagedHierarchyColumnsFilename,
  stagedHierarchyFilename,
  stagedPreviewManifestFilename,
} from "../src/staged-preview.js";
import { decodePackageHierarchy } from "../../runtime-webgpu/src/package-hierarchy.js";

const sceneTemplatePath = fileURLToPath(
  new URL("../../../artifacts/occt/repeated-fasteners.scene.json", import.meta.url),
);

const fakeAdapterSource = (adapterCountPath: string) => `import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const moduleStartedAtMs = Date.now();
const args = process.argv.slice(2);
if (args.includes("--identity")) {
  console.log(JSON.stringify({
    schemaVersion: "naru.ifc-adapter-identity.1",
    name: "IfcOpenShell",
    version: "test",
    fingerprint: "2".repeat(64),
  }));
  process.exit(0);
}
const option = (name) => args[args.indexOf(name) + 1];
const adapterCount = Number(await readFile(${JSON.stringify(adapterCountPath)}, "utf8"));
await writeFile(${JSON.stringify(adapterCountPath)}, String(adapterCount + 1));
const documentCache = args.includes("--document-cache")
  ? option("--document-cache")
  : undefined;
if (documentCache) {
  await mkdir(documentCache, { recursive: true });
  await writeFile(documentCache + "/fake-marker", "document-cache-enabled");
}
const documentArgument = option("--document");
const uriArgument = option("--uri-hint");
const discipline = documentArgument.slice(0, documentArgument.indexOf("="));
const sourcePath = documentArgument.slice(documentArgument.indexOf("=") + 1);
const uriHint = uriArgument.slice(uriArgument.indexOf("=") + 1);
const source = await readFile(sourcePath);
const sourceDigest = createHash("sha256").update(source).digest("hex");
const federationDigest = "a".repeat(64);
const scene = JSON.parse(await readFile(${JSON.stringify(sceneTemplatePath)}, "utf8"));
scene.revision.sourceDigest = "sha256:" + federationDigest;
scene.revision.adapter = { name: "IfcOpenShell", version: "test" };
scene.documents = scene.documents.map((document) => ({
  ...document,
  uriHint,
  displayName: "architecture.ifc",
  format: "IFC",
  formatVersion: "IFC4",
  sourceDigest: "sha256:" + sourceDigest,
}));

// Mirrors split.3 property columns: distinct keys and key-sets interned into
// the scene-level propertyIndex, semantics keeping only set ids plus a row
// into the external binary value columns.
const keys = [...new Set(
  scene.semantics.flatMap((semantic) => Object.keys(semantic.properties.entries)),
)].sort();
const keyIndexes = new Map(keys.map((key, index) => [key, index]));
const sets = [];
const setIndexes = new Map();
const valueRows = [];
scene.semantics = scene.semantics.map((semantic, row) => {
  const sorted = Object.keys(semantic.properties.entries).sort();
  const tuple = sorted.map((key) => keyIndexes.get(key));
  const token = tuple.join(",");
  if (!setIndexes.has(token)) {
    setIndexes.set(token, sets.length);
    sets.push(tuple);
  }
  valueRows.push(sorted.map((key) => semantic.properties.entries[key]));
  return {
    ...semantic,
    properties: {
      schema: semantic.properties.schema,
      set: setIndexes.get(token),
      row,
    },
  };
});
scene.propertyIndex = { keys, sets };

// Canonical compact JSON with sorted keys, matching the Python encoder.
const canonical = (value) => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(
      (key) => JSON.stringify(key) + ":" + canonical(value[key]),
    ).join(",") + "}";
  }
  return JSON.stringify(value);
};
const encodedRows = valueRows.map((row) => row.map((value) => Buffer.from(canonical(value), "utf8")));
const distinct = [...new Map(
  encodedRows.flat().map((encoded) => [encoded.toString("binary"), encoded]),
).values()].sort(Buffer.compare);
const positions = new Map(distinct.map((encoded, index) => [encoded.toString("binary"), index]));
const rowRefs = [];
const rowOffsets = [0];
for (const row of encodedRows) {
  for (const encoded of row) rowRefs.push(positions.get(encoded.toString("binary")));
  rowOffsets.push(rowRefs.length);
}
const valueOffsets = [0];
for (const encoded of distinct) valueOffsets.push(valueOffsets.at(-1) + encoded.byteLength);
const propertyStreams = [];
let propertyLength = 0;
const appendProperty = (payload, encoding) => {
  while (propertyLength % 8) {
    propertyStreams.push(Buffer.alloc(1));
    propertyLength += 1;
  }
  const entry = { encoding, byteOffset: propertyLength, byteLength: payload.byteLength };
  propertyStreams.push(payload);
  propertyLength += payload.byteLength;
  return entry;
};
scene.propertyValues = {
  encoding: "madi.property-columns.1",
  valueCount: rowRefs.length,
  rowCount: encodedRows.length,
  distinctValueCount: distinct.length,
  rows: appendProperty(Buffer.from(Uint32Array.from(rowRefs).buffer), "u32le"),
  rowOffsets: appendProperty(Buffer.from(Uint32Array.from(rowOffsets).buffer), "u32le"),
  valueOffsets: appendProperty(Buffer.from(Uint32Array.from(valueOffsets).buffer), "u32le"),
  valueHeap: appendProperty(Buffer.concat(distinct), "utf8-json"),
};
const properties = Buffer.concat(propertyStreams);

// Mirrors the adapter transport: surface-only representations whose streams
// are little-endian references into one concatenated geometry file.
const streams = [];
let geometryLength = 0;
const append = (values, Ctor, encoding) => {
  while (geometryLength % 8) {
    streams.push(Buffer.alloc(1));
    geometryLength += 1;
  }
  const payload = Buffer.from(Ctor.from(values).buffer);
  const entry = { encoding, byteOffset: geometryLength, byteLength: payload.byteLength };
  streams.push(payload);
  geometryLength += payload.byteLength;
  return entry;
};
scene.representations = scene.representations.map((representation) => {
  const { edges, ...rest } = representation;
  const { faceSourceIds, uvs, colorIds, ...surface } = representation.surface;
  return {
    ...rest,
    surface: {
      ...surface,
      positions: append(surface.positions, Float64Array, "f64le"),
      indices: append(surface.indices, Uint32Array, "u32le"),
      normals: append(surface.normals, Float32Array, "f32le"),
    },
  };
});
if (args.includes("--structure-preview")) {
  const previewDirectory = option("--structure-preview");
  await mkdir(previewDirectory, { recursive: true });
  const tamper = process.env.NARU_FAKE_PREVIEW ?? "";
  const ids = scene.occurrences.map((occurrence) => occurrence.id);
  const nodes = scene.occurrences.map((occurrence) => ({
    id: occurrence.id,
    type: "IfcBuildingElementProxy",
    parent: occurrence.parentId === undefined ? null : ids.indexOf(occurrence.parentId),
    name: occurrence.name,
  }));
  const preview = {
    schemaVersion: "naru.ifc-structure-preview.1",
    discipline: tamper === "wrong-discipline" ? "plumbing" : discipline,
    uriHint,
    documentId: scene.documents[0].id,
    sourceDigest: tamper === "wrong-source" ? "b".repeat(64) : sourceDigest,
    sourceBytes: source.byteLength,
    schema: "IFC4",
    nodes,
  };
  const previewBytes = Buffer.from(JSON.stringify(preview), "utf8");
  const previewFilename = "structure-" + discipline + ".json";
  await writeFile(previewDirectory + "/" + previewFilename, previewBytes);
  const rootCount = nodes.filter((node) => node.parent === null).length;
  await writeFile(previewDirectory + "/index.json", JSON.stringify({
    schemaVersion: "naru.ifc-structure-preview-index.1",
    disciplines: [discipline],
    emissionOrder: [discipline],
    complete: true,
    documents: [{
      discipline,
      path: previewFilename,
      sha256: tamper === "digest-mismatch"
        ? "c".repeat(64)
        : createHash("sha256").update(previewBytes).digest("hex"),
      byteLength: previewBytes.byteLength,
      nodeCount: nodes.length,
      rootCount,
    }],
  }));
  if (process.env.NARU_FAKE_PREVIEW_HOLD) {
    const { existsSync } = await import("node:fs");
    while (!existsSync(process.env.NARU_FAKE_PREVIEW_HOLD)) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
}
const structure = Buffer.from(JSON.stringify(scene) + "\\n", "utf8");
const geometry = Buffer.concat(streams);
await writeFile(option("--scene"), structure);
await writeFile(option("--geometry"), geometry);
await writeFile(option("--properties"), properties);
const identify = (bytes) => ({
  byteLength: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
await writeFile(option("--report"), JSON.stringify({
  schemaVersion: "naru.ifc-adapter-report.6",
  federation: { sourceDigest: federationDigest },
  sources: [{
    discipline,
    path: uriHint,
    byteLength: source.byteLength,
    sha256: sourceDigest,
    schema: "IFC4",
  }],
  documentArtifactCache: {
    schemaVersion: "naru.ifc-document-artifact.2",
    status: documentCache ? "enabled" : "disabled",
    hits: [],
    misses: documentCache ? [discipline] : [],
  },
  scene: {
    encodingVersion: "naru.ifc-scene-ir-split.4",
    structure: identify(structure),
    geometry: identify(geometry),
    properties: identify(properties),
  },
}));
if (args.includes("--stage-timing")) {
  const finishedAtMs = Date.now();
  await writeFile(option("--stage-timing"), JSON.stringify({
    schemaVersion: "naru.ifc-adapter-stage-timing.1",
    wallClock: {
      moduleStartedAtMs,
      importsFinishedAtMs: moduleStartedAtMs,
      mainStartedAtMs: moduleStartedAtMs,
      finishedAtMs,
    },
    importMilliseconds: 0,
    documents: [{ discipline, outcome: "extracted", extractMilliseconds: 1 }],
    federation: { mergeMilliseconds: 0, propertyIndexMilliseconds: 0 },
    write: {},
  }));
}
`;

describe("IFC federation compiler orchestration", () => {
  it("validates adapter identity and writes a compiled package", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "naru-ifc-test-"));
    try {
      const sourcePath = join(temporaryDirectory, "architecture.ifc");
      const adapterPath = join(temporaryDirectory, "fake-ifc-adapter.mjs");
      const outputDirectory = join(temporaryDirectory, "compiled");
      const cachedOutputDirectory = join(temporaryDirectory, "compiled-cached");
      const relabeledOutputDirectory = join(temporaryDirectory, "compiled-relabeled");
      const unnamedOutputDirectory = join(temporaryDirectory, "compiled-unnamed");
      const cacheDirectory = join(temporaryDirectory, "cache");
      const adapterCountPath = join(temporaryDirectory, "adapter-count.txt");
      await writeFile(adapterCountPath, "0", "utf8");
      await writeFile(
        sourcePath,
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
        "utf8",
      );
      await writeFile(adapterPath, fakeAdapterSource(adapterCountPath), "utf8");

      const result = await compileIfcFederation({
        documents: [
          {
            discipline: "architecture",
            sourcePath,
            uriHint: "projects/digital_hub/arc.ifc",
          },
        ],
        outputDirectory,
        pythonExecutable: process.execPath,
        adapterScriptPath: adapterPath,
        retainSceneIr: true,
        cacheDirectory,
        spatialIndex: true,
        spatialLeafCapacity: 2,
        spatialPayloadOrder: true,
        compactJson: true,
      });
      const cached = await compileIfcFederation({
        documents: [
          {
            discipline: "architecture",
            sourcePath,
            uriHint: "projects/digital_hub/arc.ifc",
          },
        ],
        outputDirectory: cachedOutputDirectory,
        pythonExecutable: process.execPath,
        adapterScriptPath: adapterPath,
        retainSceneIr: true,
        cacheDirectory,
        spatialIndex: true,
        spatialLeafCapacity: 2,
        spatialPayloadOrder: true,
        compactJson: true,
      });

      expect(result.sources[0]).toMatchObject({
        discipline: "architecture",
        schema: "IFC4",
        uriHint: "projects/digital_hub/arc.ifc",
      });
      expect(result.adapterReport).toMatchObject({
        documentArtifactCache: {
          status: "enabled",
          misses: ["architecture"],
        },
        sceneIrValidation: { ok: true, errorCount: 0, warningCount: 0 },
      });
      expect(result.cache).toMatchObject({ status: "miss" });
      expect(cached.cache).toEqual({ status: "hit", key: result.cache.key });
      expect(cached.report.output.packageDigest).toBe(result.report.output.packageDigest);
      expect(await readFile(adapterCountPath, "utf8")).toBe("1");
      await expect(
        readFile(join(cacheDirectory, "ifc-documents", "fake-marker"), "utf8"),
      ).resolves.toBe("document-cache-enabled");
      await expect(readFile(join(cachedOutputDirectory, "scene-ir.json"))).resolves.toEqual(
        await readFile(join(outputDirectory, "scene-ir.json")),
      );
      const relabeled = await compileIfcFederation({
        documents: [
          {
            discipline: "architecture",
            sourcePath,
            uriHint: "projects/digital_hub/architecture-renamed.ifc",
          },
        ],
        outputDirectory: relabeledOutputDirectory,
        pythonExecutable: process.execPath,
        adapterScriptPath: adapterPath,
        retainSceneIr: true,
        cacheDirectory,
        spatialIndex: true,
        spatialLeafCapacity: 2,
        spatialPayloadOrder: true,
        compactJson: true,
      });
      expect(relabeled.cache.status).toBe("miss");
      expect(relabeled.cache.key).not.toBe(result.cache.key);
      expect(await readFile(adapterCountPath, "utf8")).toBe("2");

      const unnamed = await compileIfcFederation({
        documents: [
          {
            discipline: "architecture",
            sourcePath,
            uriHint: "projects/digital_hub/arc.ifc",
          },
        ],
        outputDirectory: unnamedOutputDirectory,
        pythonExecutable: process.execPath,
        adapterScriptPath: adapterPath,
        retainSceneIr: true,
        cacheDirectory,
        spatialIndex: true,
        spatialLeafCapacity: 2,
        spatialPayloadOrder: true,
        compactJson: true,
        omitResourceNames: true,
      });
      const unnamedGltf = JSON.parse(
        await readFile(join(unnamedOutputDirectory, "scene.gltf"), "utf8"),
      );
      expect(unnamed.cache.status).toBe("miss");
      expect(unnamed.cache.key).not.toBe(result.cache.key);
      expect(unnamed.report.options.resourceNames).toBe("omitted");
      expect(unnamedGltf.meshes.every((mesh: { name?: string }) => mesh.name === undefined))
        .toBe(true);
      expect(unnamedGltf.bufferViews.every(
        (bufferView: { name?: string }) => bufferView.name === undefined,
      )).toBe(true);
      expect(unnamedGltf.accessors.every(
        (accessor: { name?: string }) => accessor.name === undefined,
      )).toBe(true);
      expect(unnamedGltf.nodes.some((node: { name?: string }) => node.name !== undefined))
        .toBe(true);
      expect(await readFile(adapterCountPath, "utf8")).toBe("3");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await writeFile(
          join(cacheDirectory, String(result.cache.key), "scene.gltf"),
          "corrupted",
          "utf8",
        );
        const recovered = await compileIfcFederation({
          documents: [
            {
              discipline: "architecture",
              sourcePath,
              uriHint: "projects/digital_hub/arc.ifc",
            },
          ],
          outputDirectory: join(temporaryDirectory, "compiled-recovered"),
          pythonExecutable: process.execPath,
          adapterScriptPath: adapterPath,
          retainSceneIr: true,
          cacheDirectory,
          spatialIndex: true,
          spatialLeafCapacity: 2,
          spatialPayloadOrder: true,
          compactJson: true,
        });
        expect(recovered.cache).toEqual({ status: "miss", key: result.cache.key });
        expect(recovered.report.output.packageDigest).toBe(
          result.report.output.packageDigest,
        );
        expect(await readFile(adapterCountPath, "utf8")).toBe("4");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("cache restore failed"),
        );
      } finally {
        warnSpy.mockRestore();
      }
      expect(result.report.counts).toMatchObject({
        compiledPrototypeCount: 3,
        renderableOccurrenceCount: 10,
        triangleCount: 2076,
      });
      const [
        gltf,
        retainedScene,
        retainedGeometry,
        retainedProperties,
        adapterReport,
        packageProperties,
        packageColumns,
        spatialIndex,
        dependencyIndex,
      ] = await Promise.all([
        readFile(join(outputDirectory, "scene.gltf"), "utf8").then(JSON.parse),
        readFile(join(outputDirectory, "scene-ir.json"), "utf8").then(JSON.parse),
        readFile(join(outputDirectory, "scene-ir-geometry.bin")),
        readFile(join(outputDirectory, "scene-ir-properties.bin")),
        readFile(join(outputDirectory, "adapter-report.json"), "utf8").then(JSON.parse),
        readFile(join(outputDirectory, "properties.json"), "utf8"),
        readFile(join(outputDirectory, "properties.bin")),
        readFile(join(outputDirectory, "spatial.bin")),
        readFile(join(outputDirectory, "incremental-dependencies.json"), "utf8").then(
          JSON.parse,
        ),
      ]);
      expect(gltf.asset.generator).toContain("IfcOpenShell federation slice");
      expect(gltf.extras.madi.progressive.spatialIndex).toMatchObject({
        schemaVersion: "naru.spatial-demand-index.1",
        byteLength: spatialIndex.byteLength,
      });
      expect(gltf.extras.madi.progressive.targetPayloadOrder).toBe(
        "spatial-leaf-anchor-v1",
      );
      expect(result.report.options.targetPayloadOrder).toBe("spatial-leaf-anchor-v1");
      expect(result.report.options.jsonFormatting).toBe("compact");
      expect(dependencyIndex).toEqual(result.dependencyIndex);
      expect(cached.dependencyIndex).toEqual(result.dependencyIndex);
      expect(dependencyIndex).toMatchObject({
        schemaVersion: "naru.ifc-incremental-dependency-index.1",
        scene: { packageDigest: result.report.output.packageDigest },
        documents: [
          {
            discipline: "architecture",
            sourceDigest: `sha256:${result.sources[0]?.sha256}`,
            uriHint: "projects/digital_hub/arc.ifc",
          },
        ],
      });
      expect(dependencyIndex.documents[0].prototypeIds).toHaveLength(
        result.report.counts.prototypeCount,
      );
      expect(dependencyIndex.documents[0].targetChunkIds).toHaveLength(
        result.report.counts.targetChunkCount ?? 0,
      );
      expect(dependencyIndex.documents[0].semanticIds).toHaveLength(
        retainedScene.semantics.length,
      );
      // The package carries the property sidecar: a pointer in the glTF
      // extras, the parsed document, and the adapter column file verbatim.
      expect(gltf.extras.madi.properties).toMatchObject({
        schemaVersion: "madi.package-properties.1",
        uri: "properties.json",
        byteLength: Buffer.byteLength(packageProperties, "utf8"),
      });
      expect(packageColumns.equals(retainedProperties)).toBe(true);
      const sidecar = parsePackageProperties(JSON.parse(packageProperties));
      const sidecarReader = openPropertyValueColumns(sidecar.propertyValues, packageColumns);
      const sidecarIndex = sidecar.semanticIds.indexOf(retainedScene.semantics[0].id);
      expect(sidecarIndex).toBeGreaterThanOrEqual(0);
      expect(
        resolvePropertyEntries(
          {
            set: sidecar.semanticSets[sidecarIndex] as number,
            row: sidecar.semanticRows[sidecarIndex] as number,
          },
          sidecar.propertyIndex,
          sidecarReader,
        ),
      ).toEqual(
        JSON.parse(await readFile(sceneTemplatePath, "utf8")).semantics[0].properties.entries,
      );
      expect(retainedScene.documents[0].format).toBe("IFC");
      expect(adapterReport.sceneIrValidation.ok).toBe(true);
      // The retained structure keeps column properties plus the scene tables;
      // the values themselves live only in the retained column file.
      expect(retainedScene.propertyIndex.keys.length).toBeGreaterThan(0);
      expect(retainedScene.semantics[0].properties.set).toBeTypeOf("number");
      expect(retainedScene.semantics[0].properties.row).toBeTypeOf("number");
      expect(retainedScene.semantics[0].properties.entries).toBeUndefined();
      expect(retainedScene.semantics[0].properties.values).toBeUndefined();
      const columns = openPropertyValueColumns(
        retainedScene.propertyValues,
        retainedProperties,
      );
      expect(columns.rowCount).toBe(retainedScene.semantics.length);
      const template = JSON.parse(await readFile(sceneTemplatePath, "utf8"));
      expect(
        resolvePropertyEntries(
          retainedScene.semantics[0].properties,
          retainedScene.propertyIndex,
          columns,
        ),
      ).toEqual(template.semantics[0].properties.entries);
      // The retained structure keeps references, not expanded coordinate arrays.
      expect(retainedScene.representations[0].surface.positions).toMatchObject({
        encoding: "f64le",
        byteOffset: 0,
      });
      expect(retainedGeometry.byteLength).toBeGreaterThan(
        retainedScene.representations[0].surface.positions.byteLength,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("records stage timing beside the result without touching the package", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "naru-ifc-timing-"));
    try {
      const sourcePath = join(temporaryDirectory, "architecture.ifc");
      const adapterPath = join(temporaryDirectory, "fake-ifc-adapter.mjs");
      const adapterCountPath = join(temporaryDirectory, "adapter-count.txt");
      await writeFile(adapterCountPath, "0", "utf8");
      await writeFile(
        sourcePath,
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
        "utf8",
      );
      await writeFile(adapterPath, fakeAdapterSource(adapterCountPath), "utf8");
      const documents = [{ discipline: "architecture", sourcePath, uriHint: "arc.ifc" }];
      const shared = {
        documents,
        pythonExecutable: process.execPath,
        adapterScriptPath: adapterPath,
        spatialIndex: true,
      };

      const plain = await compileIfcFederation({
        ...shared,
        outputDirectory: join(temporaryDirectory, "plain"),
      });
      const timed = await compileIfcFederation({
        ...shared,
        outputDirectory: join(temporaryDirectory, "timed"),
        stageTiming: true,
      });

      expect(plain.stages).toBeUndefined();
      expect(timed.report.output.packageDigest).toBe(plain.report.output.packageDigest);
      expect(JSON.stringify(timed.report)).not.toContain("stageTiming");
      expect(
        await readFile(join(temporaryDirectory, "timed", "build-report.json"), "utf8"),
      ).not.toMatch(/Milliseconds|stages/);

      const stages = timed.stages;
      expect(stages?.schemaVersion).toBe("naru.ifc-federation-stage-timing.1");
      if (!stages) throw new Error("stages missing");
      const stageNames = Object.keys(stages.stages).sort();
      expect(stageNames).toEqual(
        [
          "adapter",
          "cacheLookup",
          "cachePublish",
          "compile",
          "dependencyIndex",
          "hydrate",
          "inspectSources",
          "readSceneIr",
          "retainSceneIr",
          "toolchainIdentity",
          "validateCompiled",
          "writeDependencyIndex",
          "writePackage",
        ].sort(),
      );
      const attributed = Object.values(stages.stages).reduce((sum, value) => sum + value, 0);
      expect(attributed + stages.unattributedMilliseconds).toBeCloseTo(stages.totalMilliseconds, 6);
      expect(stages.unattributedMilliseconds).toBeGreaterThanOrEqual(0);
      expect(stages.stages.cacheLookup).toBe(0);
      expect(stages.stages.cachePublish).toBe(0);
      expect(stages.stages.retainSceneIr).toBe(0);
      expect(stages.structureReadMilliseconds).toBeLessThanOrEqual(stages.stages.readSceneIr);
      const compileSubStages = Object.values(stages.compileStages).reduce(
        (sum, value) => sum + value,
        0,
      );
      expect(compileSubStages).toBeCloseTo(stages.stages.compile, 6);
      expect(stages.compileStages.other).toBeGreaterThanOrEqual(0);

      const adapter = stages.adapter;
      if (!adapter) throw new Error("adapter timing missing");
      expect(adapter.importMilliseconds).toBe(0);
      expect(adapter.mainMilliseconds).toBeGreaterThanOrEqual(0);
      expect(adapter.spawnToModuleStartMilliseconds).toBeGreaterThanOrEqual(0);
      expect(adapter.finishToCloseMilliseconds).toBeGreaterThanOrEqual(0);
      expect(
        adapter.spawnToModuleStartMilliseconds +
          adapter.importsToMainMilliseconds +
          adapter.mainMilliseconds +
          adapter.finishToCloseMilliseconds,
      ).toBeLessThanOrEqual(stages.stages.adapter + 1);
      expect((adapter.ledger as { documents: unknown[] }).documents).toEqual([
        { discipline: "architecture", outcome: "extracted", extractMilliseconds: 1 },
      ]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate discipline identities before starting the adapter", async () => {
    await expect(
      compileIfcFederation({
        documents: [
          { discipline: "architecture", sourcePath: "missing-a.ifc" },
          { discipline: "architecture", sourcePath: "missing-b.ifc" },
        ],
        outputDirectory: "unused",
      }),
    ).rejects.toThrow(/Duplicate IFC discipline/u);
  });
});

/** A federation fixture: one IFC source, the fake adapter, and its call counter. */
async function stagedFixture() {
  const root = await mkdtemp(join(tmpdir(), "naru-ifc-staged-"));
  const sourcePath = join(root, "architecture.ifc");
  const adapterPath = join(root, "fake-ifc-adapter.mjs");
  const adapterCountPath = join(root, "adapter-count.txt");
  await writeFile(adapterCountPath, "0", "utf8");
  await writeFile(
    sourcePath,
    "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
    "utf8",
  );
  await writeFile(adapterPath, fakeAdapterSource(adapterCountPath), "utf8");
  const source = await readFile(sourcePath);
  const compile = (
    outputDirectory: string,
    overrides: Partial<Parameters<typeof compileIfcFederation>[0]> = {},
  ) =>
    compileIfcFederation({
      documents: [{ discipline: "architecture", sourcePath, uriHint: "projects/arc.ifc" }],
      outputDirectory: join(root, outputDirectory),
      pythonExecutable: process.execPath,
      adapterScriptPath: adapterPath,
      compactJson: true,
      ...overrides,
    });
  return {
    root,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    sourceBytes: source.byteLength,
    adapterCountPath,
    compile,
  };
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const stagedOf = (event: ImportJobEvent) => ("staged" in event ? event.staged : undefined);

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("staged import preview", () => {
  it("publishes a verified tree before compiling, and the package bytes do not move", async () => {
    const fixture = await stagedFixture();
    try {
      const stagedDirectory = join(fixture.root, "staged");
      const events: ImportJobEvent[] = [];
      const staged = await fixture.compile("compiled-staged", {
        stagedPreviewDirectory: stagedDirectory,
        job: { onEvent: (event) => events.push(event) },
      });
      const plainEvents: ImportJobEvent[] = [];
      const plain = await fixture.compile("compiled-plain", {
        job: { onEvent: (event) => plainEvents.push(event) },
      });

      // The event stream: one staged announcement, before any compiling.
      const stagedEvents = events.filter((event) => stagedOf(event) !== undefined);
      expect(stagedEvents).toHaveLength(1);
      const announcement = stagedEvents[0];
      if (announcement === undefined) throw new Error("unreachable");
      const stagedPreview = stagedOf(announcement);
      expect(announcement.state).toBe("extracting");
      expect(announcement.schemaVersion).toBe(importJobEventSchema);
      expect(events.indexOf(announcement)).toBeLessThan(
        events.findIndex((event) => event.state === "compiling"),
      );
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
      expect(stagedPreview).toMatchObject({
        schemaVersion: "naru.staged-import-preview.2",
        discipline: "architecture",
        sha256: fixture.sourceSha256,
        byteLength: fixture.sourceBytes,
        nodeCount: 12,
        rootCount: 1,
        stagedCount: 1,
        totalCount: 1,
      });
      expect(JSON.stringify(announcement)).not.toContain(fixture.root);
      expect(JSON.stringify(announcement)).not.toContain("architecture.ifc");

      // The staged directory: manifest, one verified sidecar pair, and the
      // package handoff the compile appended after writing the package.
      const manifest = staged.stagedPreview;
      if (manifest === undefined) throw new Error("expected a staged preview manifest");
      expect(manifest.complete).toBe(true);
      expect(manifest.package).toEqual({
        documentUri: "scene.gltf",
        packageDigest: staged.report.output.packageDigest,
        resources: staged.report.output.resources.map((resource) => ({
          uri: resource.path,
          byteLength: resource.bytes,
          sha256: resource.sha256,
        })),
      });
      expect(manifest.package?.packageDigest).toBe(plain.report.output.packageDigest);
      expect(manifest.jobId).toBe(events[0]?.jobId);
      expect(manifest.disciplines).toEqual(["architecture"]);
      expect(manifest.stagedCount).toBe(1);
      expect(manifest.totalCount).toBe(1);
      const manifestOnDisk: unknown = JSON.parse(
        await readFile(join(stagedDirectory, stagedPreviewManifestFilename), "utf8"),
      );
      expect(manifestOnDisk).toEqual(manifest);
      const document = manifest.documents[0];
      if (document === undefined) throw new Error("expected one staged document");
      expect(document.sourceDigest).toBe(fixture.sourceSha256);
      expect(document.sourceBytes).toBe(fixture.sourceBytes);
      expect(document.hierarchy.uri).toBe(stagedHierarchyFilename("architecture"));
      expect(document.hierarchy.columnsUri).toBe(stagedHierarchyColumnsFilename("architecture"));
      const hierarchyBytes = await readFile(join(stagedDirectory, document.hierarchy.uri));
      const columnBytes = await readFile(join(stagedDirectory, document.hierarchy.columnsUri));
      expect(hierarchyBytes.byteLength).toBe(document.hierarchy.byteLength);
      expect(columnBytes.byteLength).toBe(document.hierarchy.columnsByteLength);
      expect(sha256Of(hierarchyBytes)).toBe(document.hierarchy.sha256);
      expect(sha256Of(columnBytes)).toBe(document.hierarchy.columnsSha256);
      expect(stagedPreview?.hierarchy).toEqual({
        sha256: document.hierarchy.sha256,
        byteLength: document.hierarchy.byteLength,
        columnsSha256: document.hierarchy.columnsSha256,
        columnsByteLength: document.hierarchy.columnsByteLength,
      });
      const decoded = decodePackageHierarchy(
        JSON.parse(hierarchyBytes.toString("utf8")),
        new Uint8Array(columnBytes),
        { maxEntries: 64 },
      );
      expect(decoded.entries).toHaveLength(12);
      expect(decoded.documentNodeCount).toBe(0);
      expect(decoded.relocatedCount).toBe(12);
      expect(decoded.sceneId).toBe("document:sha256:de177178a4bb86a6");
      expect(decoded.sourceDigest).toBe(fixture.sourceSha256);
      expect(decoded.entries[0]?.depth).toBe(0);
      expect(decoded.entries.filter((entry) => entry.depth === 0)).toHaveLength(1);
      const stagedFiles = (await readdir(stagedDirectory)).sort();
      expect(stagedFiles).toEqual([
        stagedHierarchyColumnsFilename("architecture"),
        stagedHierarchyFilename("architecture"),
        stagedPreviewManifestFilename,
      ]);

      // Gate 2: the compiled package does not know staging happened.
      expect(plain.stagedPreview).toBeUndefined();
      expect(staged.report.output.packageDigest).toBe(plain.report.output.packageDigest);
      expect(staged.report.output.resources).toEqual(plain.report.output.resources);
      for (const resource of ["scene.gltf", "scene.bin"]) {
        const left = await readFile(join(fixture.root, "compiled-staged", resource));
        const right = await readFile(join(fixture.root, "compiled-plain", resource));
        expect(left.equals(right)).toBe(true);
      }
      expect(plainEvents.some((event) => stagedOf(event) !== undefined)).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["digest-mismatch", /sha256|digest/i],
    ["wrong-source", /source/i],
    ["wrong-discipline", /discipline/i],
  ])("refuses a tree the adapter emitted that does not verify (%s)", async (mode, pattern) => {
    const fixture = await stagedFixture();
    try {
      const stagedDirectory = join(fixture.root, "staged");
      const events: ImportJobEvent[] = [];
      await expect(
        fixture.compile("compiled", {
          stagedPreviewDirectory: stagedDirectory,
          environment: { ...process.env, NARU_FAKE_PREVIEW: mode },
          job: { onEvent: (event) => events.push(event) },
        }),
      ).rejects.toMatchObject({ name: "StagedPreviewError", code: "INVALID_STAGED_PREVIEW", message: pattern });
      expect(await exists(stagedDirectory)).toBe(false);
      expect(await exists(join(fixture.root, "compiled", "scene.gltf"))).toBe(false);
      const last = events.at(-1);
      expect(last?.state).toBe("failed");
      if (last?.state !== "failed") throw new Error("unreachable");
      expect(last.failure.code).toBe("INVALID_STAGED_PREVIEW");
      expect(last.failure.message).not.toContain(fixture.root);
      expect(last.failure.message).not.toContain(stagedDirectory);
      expect(events.some((event) => stagedOf(event) !== undefined)).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses to publish into a staged directory that already holds files", async () => {
    const fixture = await stagedFixture();
    try {
      const stagedDirectory = join(fixture.root, "staged");
      await mkdir(stagedDirectory, { recursive: true });
      await writeFile(join(stagedDirectory, "keep.txt"), "not ours", "utf8");
      await expect(
        fixture.compile("compiled", { stagedPreviewDirectory: stagedDirectory }),
      ).rejects.toBeInstanceOf(StagedPreviewError);
      expect(await readFile(join(stagedDirectory, "keep.txt"), "utf8")).toBe("not ours");
      expect(await readFile(fixture.adapterCountPath, "utf8")).toBe("0");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("never opens a staged directory when the package restores from the cache", async () => {
    const fixture = await stagedFixture();
    try {
      const cacheDirectory = join(fixture.root, "cache");
      const first = await fixture.compile("compiled-cold", { cacheDirectory });
      expect(first.cache.status).toBe("miss");
      const stagedDirectory = join(fixture.root, "staged");
      const warm = await fixture.compile("compiled-warm", {
        cacheDirectory,
        stagedPreviewDirectory: stagedDirectory,
      });
      expect(warm.cache).toEqual({ status: "hit", key: first.cache.key });
      expect(warm.stagedPreview).toBeUndefined();
      expect(await exists(stagedDirectory)).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
