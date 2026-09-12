import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectCompiledHierarchy } from "@naru3d/runtime-webgpu";
import type { CompiledHierarchy, PackageTransportPolicy } from "@naru3d/runtime-webgpu";

import { compileSceneToGltf } from "../../../packages/compiler/src/index.js";
import { hydratePhase0Evidence } from "../../../packages/compiler/src/evidence-input.js";

import { loadDocumentHierarchySidecar } from "../src/hierarchy-sidecar.js";
import {
  openSceneDocument,
  parseSceneUrl,
  resolveSceneResources,
  selectLocalSceneFiles,
  validateLocalBinary,
} from "../src/scene-source.js";
import type { LoadedSceneHierarchy, SceneSource } from "../src/scene-source.js";

/**
 * The load path the Studio drives across two threads: the loader opens the
 * document, the geometry Worker parses it and reads the assembly tree out of it,
 * and the loader then resolves the resources that tree declares. Both halves run
 * in one process here because a Worker module cannot be imported from a test.
 */
async function loadScenePackage(
  source: SceneSource,
  signal?: AbortSignal,
  policy?: PackageTransportPolicy,
): Promise<LoadedSceneHierarchy> {
  const opened = await openSceneDocument(source, signal, policy);
  const document = JSON.parse(
    opened.documentSource.kind === "bytes"
      ? new TextDecoder().decode(opened.documentSource.bytes)
      : await opened.documentSource.file.text(),
  ) as unknown;
  const sidecar = await loadDocumentHierarchySidecar(
    document,
    opened.documentSource.kind === "bytes"
      ? { kind: "url", ...(opened.transport ? { transport: opened.transport } : {}) }
      : {
          kind: "file",
          sidecarFiles: opened.sidecarFiles ?? [],
          binaryFiles: opened.binaryFiles ?? [],
        },
    signal,
  );
  const { hierarchy } = inspectCompiledHierarchy(
    document,
    sidecar ? { hierarchy: sidecar.sidecar } : {},
  );
  return resolveSceneResources(source, opened, {
    hierarchy,
    ...(sidecar ? { relocatedHierarchyBytes: sidecar.byteLength } : {}),
  });
}

const hierarchy = {
  binaryUri: "geometry/scene.bin",
  binaryByteLength: 4,
} as CompiledHierarchy;

describe("compiled scene sources", () => {
  it("resolves relative HTTP URLs and rejects unsupported protocols", () => {
    expect(parseSceneUrl("../package/scene.gltf", "https://example.com/viewer/").href).toBe(
      "https://example.com/package/scene.gltf",
    );
    expect(() => parseSceneUrl("file:///tmp/scene.gltf", "https://example.com/")).toThrow(
      /HTTP or HTTPS/u,
    );
    expect(() => parseSceneUrl(" ", "https://example.com/")).toThrow(/Enter a compiled/u);
  });

  it("selects one local glTF plus its binary and sidecar resources", () => {
    const gltf = new File(["{}"], "scene.gltf");
    const binary = new File([new Uint8Array(4)], "scene.bin");

    expect(selectLocalSceneFiles([binary, gltf])).toEqual({
      kind: "local",
      gltfFile: gltf,
      binaryFiles: [binary],
      sidecarFiles: [],
    });
    expect(() => selectLocalSceneFiles([gltf])).toThrow(/exactly one/u);
    expect(() => selectLocalSceneFiles([gltf, binary, new File([""], "scene.step")])).toThrow(
      /exactly one/u,
    );
    const coarse = new File([new Uint8Array(8)], "coarse.bin");
    const sidecarJson = new File(["{}"], "properties.json");
    const sidecarColumns = new File([new Uint8Array(8)], "properties.bin");
    expect(selectLocalSceneFiles([coarse, sidecarJson, gltf, sidecarColumns, binary])).toEqual({
      kind: "local",
      gltfFile: gltf,
      binaryFiles: [coarse, sidecarColumns, binary],
      sidecarFiles: [sidecarJson],
    });
  });

  it("checks local binary identity and declared byte length", () => {
    expect(() => validateLocalBinary(hierarchy, { name: "scene.bin", size: 4 })).not.toThrow();
    expect(() => validateLocalBinary(hierarchy, { name: "other.bin", size: 4 })).toThrow(
      /expects scene.bin/u,
    );
    expect(() => validateLocalBinary(hierarchy, { name: "scene.bin", size: 3 })).toThrow(
      /must be 4 bytes/u,
    );
    const progressiveHierarchy = {
      ...hierarchy,
      coarseBinaryUri: "geometry/coarse.bin",
      coarseBinaryByteLength: 8,
    } as CompiledHierarchy;
    expect(() =>
      validateLocalBinary(progressiveHierarchy, { name: "coarse.bin", size: 8 }, "coarse"),
    ).not.toThrow();
  });
});

const fixtureUrl = new URL("https://example.com/package/scene.gltf");

function stubDocument(document: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(document), {
          headers: { "Content-Type": "model/gltf+json" },
        }),
    ),
  );
}

describe("remote scene packages", () => {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../artifacts/phase1/repeated-fasteners/scene.gltf", import.meta.url)),
      "utf8",
    ),
  ) as { buffers: { uri: string; byteLength: number }[] };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves package resources against the document it loaded", async () => {
    stubDocument(fixture);

    const loaded = await loadScenePackage({ kind: "url", gltfUrl: fixtureUrl });

    expect(loaded.targetBinary).toEqual({
      kind: "url",
      href: "https://example.com/package/scene.bin",
    });
    expect(loaded.hierarchy.binaryByteLength).toBe(188_044);
  });

  it("refuses a package that points its buffer at another origin", async () => {
    stubDocument({
      ...fixture,
      buffers: [{ ...fixture.buffers[0], uri: "https://attacker.example/scene.bin" }],
    });

    await expect(loadScenePackage({ kind: "url", gltfUrl: fixtureUrl })).rejects.toThrow(
      /must stay on https:\/\/example\.com/u,
    );
  });

  it("accepts a split-host package only when the embedder announces the host", async () => {
    const split = {
      ...fixture,
      buffers: [{ ...fixture.buffers[0], uri: "https://cdn.example/scene.bin" }],
    };
    stubDocument(split);
    await expect(loadScenePackage({ kind: "url", gltfUrl: fixtureUrl })).rejects.toThrow(
      /must stay on https:\/\/example\.com/u,
    );

    stubDocument(split);
    const loaded = await loadScenePackage({ kind: "url", gltfUrl: fixtureUrl }, undefined, {
      additionalOrigins: ["https://cdn.example"],
    });
    expect(loaded.targetBinary).toEqual({
      kind: "url",
      href: "https://cdn.example/scene.bin",
    });
    // The policy travels with the load, so the Worker fetches under it too.
    expect(loaded.transport?.origins).toEqual([
      "https://example.com",
      "https://cdn.example",
    ]);
  });

  it("refuses a package whose declared resources exceed the reviewed budget", async () => {
    stubDocument(fixture);

    await expect(
      loadScenePackage({ kind: "url", gltfUrl: fixtureUrl }, undefined, {
        limits: { packageBytes: 60_000 },
      }),
    ).rejects.toThrow(/more than 60000 bytes/u);
  });

  // The stub declares no Content-Length, so this exercises the streaming
  // ceiling rather than the declared-length pre-check.
  it("stops reading a document that runs past the reviewed limit", async () => {
    stubDocument(fixture);

    await expect(
      loadScenePackage({ kind: "url", gltfUrl: fixtureUrl }, undefined, {
        limits: { documentBytes: 1_024 },
      }),
    ).rejects.toThrow(/scene\.gltf is larger than 1024 bytes/u);
  });
});

describe("relocated hierarchy packages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function compileRelocated() {
    const scene = hydratePhase0Evidence(
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL("../../../artifacts/occt/repeated-fasteners.scene.json", import.meta.url),
          ),
          "utf8",
        ),
      ) as unknown,
    );
    return compileSceneToGltf(scene, { relocateHierarchyNodes: true });
  }

  function stubPackage(
    compiled: Awaited<ReturnType<typeof compileRelocated>>,
    overrides: Readonly<Record<string, Uint8Array>> = {},
  ): void {
    const encoder = new TextEncoder();
    const resources = new Map<string, [Uint8Array, string]>([
      ["scene.gltf", [encoder.encode(compiled.json.text()), "model/gltf+json"]],
      ["hierarchy.json", [encoder.encode(compiled.hierarchyJson), "application/json"]],
      [
        "hierarchy.bin",
        [compiled.hierarchyBinary as Uint8Array, "application/octet-stream"],
      ],
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const name = (input instanceof URL ? input : new URL(input)).pathname.split("/").pop();
        const served = name === undefined ? undefined : overrides[name] ?? resources.get(name)?.[0];
        if (!served) return new Response(null, { status: 404 });
        const copy = new Uint8Array(served.byteLength);
        copy.set(served);
        return new Response(copy.buffer, {
          headers: {
            "Content-Type": resources.get(name as string)?.[1] ?? "application/octet-stream",
          },
        });
      }),
    );
  }

  it("rebuilds the whole assembly tree from the sidecar beside the document", async () => {
    const compiled = await compileRelocated();
    stubPackage(compiled);

    const loaded = await loadScenePackage({ kind: "url", gltfUrl: fixtureUrl });

    expect(compiled.document.nodes).toHaveLength(11);
    expect(loaded.hierarchy.relocatedHierarchy?.relocatedCount).toBe(2);
    expect(loaded.hierarchy.entries).toHaveLength(compiled.report.counts.occurrenceCount);
    expect(loaded.hierarchy.entries.filter((entry) => entry.renderable)).toHaveLength(
      compiled.report.counts.renderableOccurrenceCount,
    );
  });

  it("refuses a sidecar whose bytes do not match the digest the package declares", async () => {
    const compiled = await compileRelocated();
    const corrupted = new Uint8Array(compiled.hierarchyBinary as Uint8Array);
    const last = corrupted.byteLength - 1;
    corrupted[last] = (corrupted[last] ?? 0) ^ 0xff;
    stubPackage(compiled, { "hierarchy.bin": corrupted });

    await expect(loadScenePackage({ kind: "url", gltfUrl: fixtureUrl })).rejects.toThrow(
      /digest mismatch/u,
    );
  });
});
