import { describe, expect, it } from "vitest";

import {
  encodeStagedHierarchy,
  type IfcStructurePreview,
} from "../../../packages/compiler/src/index.js";
import {
  assertStagedPackageMatches,
  parseStagedImportManifest,
  parseStagedManifestUrl,
  stagedHierarchyEntries,
  StagedImportError,
  stagedImportPreviewSchema,
  watchStagedImport,
  type StagedImportDocument,
  type StagedImportManifest,
  type StagedImportTree,
} from "../src/staged-import.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const manifestUrl = new URL("http://127.0.0.1:4178/staged/staged.json");

function preview(discipline: string, sourceDigest: string, sourceBytes: number): IfcStructurePreview {
  return {
    schemaVersion: "naru.ifc-structure-preview.1",
    discipline,
    uriHint: `projects/demo/${discipline}.ifc`,
    documentId: `${discipline}-doc`,
    sourceDigest,
    sourceBytes,
    schema: "IFC2X3",
    nodes: [
      { id: `${discipline}-project`, type: "IfcProject", parent: null, name: "Project" },
      { id: `${discipline}-site`, type: "IfcSite", parent: 0, name: "Site" },
      { id: `${discipline}-wall`, type: "IfcWall", parent: 1, name: `${discipline} wall` },
      { id: `${discipline}-slab`, type: "IfcSlab", parent: 1 },
    ],
  };
}

interface Staged {
  readonly document: StagedImportDocument;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

function stage(source: IfcStructurePreview): Staged {
  const { sidecar, rootCount } = encodeStagedHierarchy(source);
  const uri = `hierarchy-${source.discipline}.json`;
  const columnsUri = `hierarchy-${source.discipline}.bin`;
  return {
    document: {
      discipline: source.discipline,
      uriHint: source.uriHint,
      documentId: source.documentId,
      schema: source.schema,
      sourceDigest: source.sourceDigest,
      sourceBytes: source.sourceBytes,
      nodeCount: source.nodes.length,
      rootCount,
      hierarchy: {
        uri,
        byteLength: sidecar.jsonBytes.byteLength,
        sha256: sidecar.jsonDigest,
        columnsUri,
        columnsByteLength: sidecar.binary.byteLength,
        columnsSha256: sidecar.binaryDigest,
      },
    },
    files: new Map([
      [uri, sidecar.jsonBytes],
      [columnsUri, sidecar.binary],
    ]),
  };
}

function manifest(
  documents: readonly StagedImportDocument[],
  disciplines: readonly string[],
  handoff?: StagedImportManifest["package"],
): Record<string, unknown> {
  const complete = documents.length === disciplines.length;
  return {
    schemaVersion: stagedImportPreviewSchema,
    jobId: "0123456789abcdef",
    kind: "ifc-federation",
    disciplines: [...disciplines],
    documents: documents.map((document) => ({ ...document })),
    stagedCount: documents.length,
    totalCount: disciplines.length,
    complete,
    ...(handoff ? { package: handoff } : {}),
  };
}

const handoff: NonNullable<StagedImportManifest["package"]> = {
  documentUri: "scene.gltf",
  packageDigest: digestC,
  resources: [
    { uri: "scene.gltf", byteLength: 10, sha256: digestA },
    { uri: "scene.bin", byteLength: 20, sha256: digestB },
  ],
};

const facade = stage(preview("facade", digestA, 100));
const structure = stage(preview("structure", digestB, 200));

describe("parseStagedImportManifest", () => {
  it("accepts a partial manifest and a complete one carrying its package", () => {
    const partial = parseStagedImportManifest(manifest([facade.document], ["facade", "structure"]));
    expect(partial.complete).toBe(false);
    expect(partial.package).toBeUndefined();
    const full = parseStagedImportManifest(
      manifest([facade.document, structure.document], ["facade", "structure"], handoff),
    );
    expect(full.complete).toBe(true);
    expect(full.package?.packageDigest).toBe(digestC);
  });

  it("accepts the writer's last staged manifest, all counts equal but not yet marked complete", () => {
    const staged = parseStagedImportManifest({
      ...manifest([facade.document, structure.document], ["facade", "structure"]),
      complete: false,
    });
    expect(staged.complete).toBe(false);
    expect(staged.stagedCount).toBe(staged.totalCount);
    expect(staged.package).toBeUndefined();
    expect(() =>
      parseStagedImportManifest({
        ...manifest([facade.document, structure.document], ["facade", "structure"], handoff),
        complete: false,
      }),
    ).toThrow(/cannot precede completion/u);
  });

  it("refuses the previous schema by name", () => {
    const value = { ...manifest([facade.document], ["facade"]), schemaVersion: "naru.staged-import-preview.1" };
    expect(() => parseStagedImportManifest(value)).toThrow(StagedImportError);
    try {
      parseStagedImportManifest(value);
    } catch (error) {
      expect((error as StagedImportError).code).toBe("UNSUPPORTED_STAGED_IMPORT");
    }
  });

  it("refuses sidecar names that could leave the staged directory", () => {
    for (const uri of ["../hierarchy.json", "a/b.json", "http://x/y.json", "hierarchy.json?x", ".hidden"]) {
      const value = manifest(
        [{ ...facade.document, hierarchy: { ...facade.document.hierarchy, uri } }],
        ["facade"],
      );
      expect(() => parseStagedImportManifest(value)).toThrow(StagedImportError);
    }
  });

  it("refuses counts that disagree with the document list", () => {
    expect(() =>
      parseStagedImportManifest({ ...manifest([facade.document], ["facade", "structure"]), stagedCount: 2 }),
    ).toThrow(/stagedCount/u);
    expect(() =>
      parseStagedImportManifest({ ...manifest([facade.document], ["facade", "structure"]), complete: true }),
    ).toThrow(StagedImportError);
    expect(() =>
      parseStagedImportManifest(manifest([facade.document], ["structure", "facade"])),
    ).toThrow(StagedImportError);
  });

  it("refuses a package handoff before the last tree", () => {
    expect(() =>
      parseStagedImportManifest(manifest([facade.document], ["facade", "structure"], handoff)),
    ).toThrow(StagedImportError);
  });
});

describe("parseStagedManifestUrl", () => {
  it("resolves the manifest against the page and requires the manifest file itself", () => {
    const url = parseStagedManifestUrl("/work/staged/staged.json", "http://localhost:5173/?scene=x");
    expect(url.href).toBe("http://localhost:5173/work/staged/staged.json");
    expect(parseStagedManifestUrl("http://127.0.0.1:4178/s/staged.json", "http://localhost:5173/").port).toBe("4178");
  });

  it("refuses queries, other file names, and credentials", () => {
    const base = "http://localhost:5173/";
    expect(() => parseStagedManifestUrl("http://h/staged/staged.json?x=1", base)).toThrow(StagedImportError);
    expect(() => parseStagedManifestUrl("http://h/staged/index.json", base)).toThrow(StagedImportError);
    expect(() => parseStagedManifestUrl("http://u:p@h/staged/staged.json", base)).toThrow();
    expect(() => parseStagedManifestUrl("", base)).toThrow(StagedImportError);
  });
});

describe("assertStagedPackageMatches", () => {
  it("accepts the scene the handoff names and refuses another document", () => {
    expect(() =>
      assertStagedPackageMatches(new URL("http://127.0.0.1:4178/package/scene.gltf"), handoff),
    ).not.toThrow();
    expect(() =>
      assertStagedPackageMatches(new URL("http://127.0.0.1:4178/package/other.gltf"), handoff),
    ).toThrow(StagedImportError);
  });
});

/** An in-memory staged directory served the way the recorder's origin does. */
function origin(store: Map<string, Uint8Array | string>) {
  const requests: string[] = [];
  const transfer = (url: URL): Promise<Response> => {
    const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    requests.push(name);
    const entry = store.get(name);
    if (entry === undefined) {
      return Promise.resolve(new Response("<html>fallback</html>", { status: 404, headers: { "Content-Type": "text/html" } }));
    }
    const bytes = typeof entry === "string" ? new TextEncoder().encode(entry) : entry;
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const type = name.endsWith(".json") ? "application/json" : "application/octet-stream";
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": type, "Content-Length": String(bytes.byteLength) },
      }),
    );
  };
  return { requests, transfer };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function session(store: Map<string, Uint8Array | string>) {
  const served = origin(store);
  const controller = new AbortController();
  const trees: StagedImportTree[] = [];
  const events: string[] = [];
  const errors: Error[] = [];
  let packageDigest: string | undefined;
  const watch = watchStagedImport(
    manifestUrl,
    {
      onManifest: (value) => events.push(`manifest:${String(value.stagedCount)}/${String(value.totalCount)}`),
      onTree: (tree) => {
        trees.push(tree);
        events.push(`tree:${tree.document.discipline}`);
      },
      onPackage: (value) => {
        packageDigest = value.packageDigest;
        events.push("package");
      },
      onError: (error) => errors.push(error),
    },
    { signal: controller.signal, intervalMs: 1, fetch: served.transfer },
  );
  return { watch, controller, trees, events, errors, requests: served.requests, packageDigest: () => packageDigest };
}

describe("watchStagedImport", () => {
  it("delivers each tree as it is staged, verified by length and digest, then hands off the package", async () => {
    const store = new Map<string, Uint8Array | string>();
    const disciplines = ["facade", "structure"];
    const run = session(store);
    // The manifest does not exist yet: the SPA fallback answers 404 text/html.
    await until(() => run.requests.filter((name) => name === "staged.json").length >= 3, "three polls");
    expect(run.events).toEqual([]);
    for (const [name, bytes] of facade.files) store.set(name, bytes);
    store.set("staged.json", JSON.stringify(manifest([facade.document], disciplines)));
    await until(() => run.trees.length === 1, "the first tree");
    expect(run.events.slice(0, 2)).toEqual(["manifest:1/2", "tree:facade"]);
    expect(run.trees[0]?.entries.map((entry) => entry.depth)).toEqual([0, 1, 2, 2]);
    expect(run.trees[0]?.entries[2]?.relocated?.name).toBe("facade wall");
    for (const [name, bytes] of structure.files) store.set(name, bytes);
    store.set("staged.json", JSON.stringify(manifest([facade.document, structure.document], disciplines, handoff)));
    await run.watch.done;
    expect(run.errors).toEqual([]);
    expect(run.trees.map((tree) => tree.document.discipline)).toEqual(["facade", "structure"]);
    expect(run.events.at(-1)).toBe("package");
    expect(run.packageDigest()).toBe(digestC);
    // Each sidecar was fetched exactly once; the manifest was polled repeatedly.
    expect(run.requests.filter((name) => name === "hierarchy-facade.json")).toHaveLength(1);
    expect(run.requests.filter((name) => name === "hierarchy-structure.bin")).toHaveLength(1);
    expect(run.requests.filter((name) => name === "staged.json").length).toBeGreaterThan(2);
    expect(run.watch.trees).toHaveLength(2);
  });

  it("reports a tampered sidecar instead of decoding it", async () => {
    const store = new Map<string, Uint8Array | string>();
    for (const [name, bytes] of facade.files) store.set(name, bytes);
    const tampered = new Uint8Array(facade.files.get("hierarchy-facade.bin") as Uint8Array);
    tampered[tampered.byteLength - 1] = (tampered[tampered.byteLength - 1] as number) ^ 0xff;
    store.set("hierarchy-facade.bin", tampered);
    store.set("staged.json", JSON.stringify(manifest([facade.document], ["facade"], handoff)));
    const run = session(store);
    await run.watch.done;
    expect(run.trees).toEqual([]);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]?.message).toMatch(/digest mismatch/u);
  });

  it("treats a manifest that parses but fails the schema as a hard error", async () => {
    const store = new Map<string, Uint8Array | string>();
    store.set("staged.json", JSON.stringify({ ...manifest([], ["facade"]), stagedCount: 1 }));
    const run = session(store);
    await run.watch.done;
    expect(run.errors[0]).toBeInstanceOf(StagedImportError);
  });

  it("stops quietly when aborted", async () => {
    const store = new Map<string, Uint8Array | string>();
    const run = session(store);
    await until(() => run.requests.length >= 2, "two polls");
    run.controller.abort();
    await run.watch.done;
    expect(run.errors).toEqual([]);
    expect(run.events).toEqual([]);
  });
});

describe("stagedHierarchyEntries", () => {
  it("prefixes each document with a root row and nests its tree beneath it", async () => {
    const store = new Map<string, Uint8Array | string>();
    for (const staged of [facade, structure]) for (const [name, bytes] of staged.files) store.set(name, bytes);
    store.set("staged.json", JSON.stringify(manifest([facade.document, structure.document], ["facade", "structure"], handoff)));
    const run = session(store);
    await run.watch.done;
    const entries = stagedHierarchyEntries(run.trees);
    expect(entries).toHaveLength(10);
    expect(entries.map((entry) => entry.nodeIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(entries[0]).toMatchObject({ depth: 0, name: "facade · facade.ifc", occurrenceId: "staged:facade", renderable: false });
    expect(entries.slice(1, 5).map((entry) => entry.depth)).toEqual([1, 2, 3, 3]);
    expect(entries[5]).toMatchObject({ depth: 0, occurrenceId: "staged:structure" });
    expect(entries[8]?.name).toBe("structure wall");
    expect(entries[9]?.name).toBe("structure-slab");
    expect(entries.every((entry) => !entry.renderable)).toBe(true);
  });
});
