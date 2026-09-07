import { describe, expect, it } from "vitest";

import {
  WorkspaceError,
  normalizeWorkspace,
  parseWorkspace,
  serializeWorkspace,
  workspaceSchemaVersion,
} from "../src/index.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

function view(): Record<string, unknown> {
  return {
    camera: { yaw: 0.7, pitch: -0.35, panRight: 12.5, panUp: -3.25, zoom: 1.75 },
    section: { enabled: true, axis: "z", direction: -1, fraction: 0.42 },
    hiddenOccurrenceIds: ["occurrence-2", "occurrence-1"],
    selectedOccurrenceId: "occurrence-9",
    annotations: [],
  };
}

function workspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: workspaceSchemaVersion,
    label: "Digital Hub review",
    package: {
      reference: { kind: "url", href: "https://example.test/digital-hub/scene.gltf" },
      packageDigest: digestA,
      resources: [
        { path: "scene.gltf", byteLength: 20_562_117, sha256: digestB },
        { path: "scene.bin", byteLength: 22_410_360, sha256: digestC },
      ],
    },
    sources: [
      { key: "architecture", label: "arc.ifc", byteLength: 9_022_255, sha256: digestB },
      { key: "structure", label: "str.ifc", byteLength: 4_119_887, sha256: digestC },
    ],
    view: view(),
    ...overrides,
  };
}

function expectRefusal(build: () => unknown, code: string, fragment: string): void {
  let thrown: unknown;
  try {
    build();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkspaceError);
  const error = thrown as WorkspaceError;
  expect(error.code).toBe(code);
  expect(error.message).toContain(fragment);
}

describe("workspace manifest", () => {
  it("round trips through canonical text", () => {
    const text = serializeWorkspace(workspace());
    const parsed = parseWorkspace(text);
    expect(parsed).toEqual(normalizeWorkspace(workspace()));
    expect(serializeWorkspace(parsed)).toBe(text);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("serializes the same state to the same bytes whatever order it arrives in", () => {
    const first = serializeWorkspace(workspace());
    const shuffled = workspace({
      package: {
        packageDigest: digestA,
        resources: [
          { sha256: digestC, path: "scene.bin", byteLength: 22_410_360 },
          { sha256: digestB, path: "scene.gltf", byteLength: 20_562_117 },
        ],
        reference: { href: "https://example.test/digital-hub/scene.gltf", kind: "url" },
      },
      sources: [
        { key: "structure", label: "str.ifc", byteLength: 4_119_887, sha256: digestC },
        { key: "architecture", label: "arc.ifc", byteLength: 9_022_255, sha256: digestB },
      ],
    });
    expect(serializeWorkspace(shuffled)).toBe(first);
  });

  it("deduplicates and sorts hidden occurrences", () => {
    const parsed = normalizeWorkspace(
      workspace({
        view: {
          ...(workspace()["view"] as Record<string, unknown>),
          hiddenOccurrenceIds: ["b", "a", "b", "c", "a"],
        },
      }),
    );
    expect(parsed.view.hiddenOccurrenceIds).toEqual(["a", "b", "c"]);
  });

  it("refuses a schema version it was not written for", () => {
    expectRefusal(
      () => normalizeWorkspace(workspace({ schemaVersion: "naru.workspace.3" })),
      "UNSUPPORTED_SCHEMA",
      "naru.workspace.2",
    );
    expectRefusal(
      () => normalizeWorkspace(workspace({ schemaVersion: undefined })),
      "UNSUPPORTED_SCHEMA",
      "schemaVersion",
    );
  });

  it("reads a naru.workspace.1 manifest as one with no annotations and rewrites it as .2", () => {
    const { annotations: _dropped, ...legacyView } = view();
    const parsed = normalizeWorkspace(
      workspace({ schemaVersion: "naru.workspace.1", view: legacyView }),
    );
    expect(parsed.schemaVersion).toBe("naru.workspace.2");
    expect(parsed.view.annotations).toEqual([]);
    expect(serializeWorkspace(parsed)).toContain('"schemaVersion":"naru.workspace.2"');
  });

  it("keeps annotations in order and refuses malformed ones", () => {
    const parsed = normalizeWorkspace(
      workspace({
        view: {
          ...view(),
          annotations: [
            { position: [1, 2, 3], text: "second" },
            { position: [-0.5, 0, 12.25], text: "first" },
          ],
        },
      }),
    );
    expect(parsed.view.annotations).toEqual([
      { position: [1, 2, 3], text: "second" },
      { position: [-0.5, 0, 12.25], text: "first" },
    ]);
    const withAnnotations = (annotations: unknown) =>
      normalizeWorkspace(workspace({ view: { ...view(), annotations } }));
    expectRefusal(() => withAnnotations([{ position: [1, 2, 3], text: "x", color: "red" }]), "INVALID_WORKSPACE", "color");
    expectRefusal(() => withAnnotations([{ position: [1, Number.NaN, 3], text: "x" }]), "INVALID_WORKSPACE", "position");
    expectRefusal(() => withAnnotations([{ position: [1, 2], text: "x" }]), "INVALID_WORKSPACE", "position");
    expectRefusal(() => withAnnotations([{ position: [1, 2, 3], text: "   " }]), "INVALID_WORKSPACE", "text");
    expectRefusal(
      () => withAnnotations([{ position: [1, 2, 3], text: "x".repeat(1025) }]),
      "LIMIT_EXCEEDED",
      "text",
    );
    expectRefusal(
      () => withAnnotations(Array.from({ length: 10_001 }, () => ({ position: [0, 0, 0], text: "n" }))),
      "LIMIT_EXCEEDED",
      "annotations",
    );
  });

  it("refuses an unknown key rather than ignoring it", () => {
    expectRefusal(
      () => normalizeWorkspace(workspace({ retainedScript: "alert(1)" })),
      "INVALID_WORKSPACE",
      "retainedScript",
    );
  });
});

describe("workspace trust boundary", () => {
  function withReference(reference: unknown): Record<string, unknown> {
    return workspace({
      package: { ...(workspace()["package"] as Record<string, unknown>), reference },
    });
  }

  it("accepts only http and https package references", () => {
    for (const href of [
      "file:///C:/models/scene.gltf",
      "javascript:fetch('https://example.test')",
      "data:application/json,{}",
    ]) {
      expectRefusal(
        () => normalizeWorkspace(withReference({ kind: "url", href })),
        "INVALID_WORKSPACE",
        "workspace.package.reference.href",
      );
    }
  });

  it("refuses credentials embedded in a package reference", () => {
    expectRefusal(
      () => normalizeWorkspace(withReference({ kind: "url", href: "https://u:p@example.test/a.gltf" })),
      "INVALID_WORKSPACE",
      "credentials",
    );
  });

  it("stores a bare file name for a local package, never a path", () => {
    for (const fileName of ["../../secrets/scene.gltf", "C:/models/scene.gltf", ".."]) {
      expectRefusal(
        () => normalizeWorkspace(withReference({ kind: "local", fileName })),
        "INVALID_WORKSPACE",
        "workspace.package.reference.fileName",
      );
    }
    expect(
      normalizeWorkspace(withReference({ kind: "local", fileName: "scene.gltf" })).package
        .reference,
    ).toEqual({ kind: "local", fileName: "scene.gltf" });
  });

  it("refuses a digest that is not a lowercase hex SHA-256", () => {
    for (const sha256 of [digestA.toUpperCase(), "abc", `${digestA}00`]) {
      expectRefusal(
        () =>
          normalizeWorkspace(
            workspace({
              sources: [{ key: "architecture", label: "arc.ifc", byteLength: 1, sha256 }],
            }),
          ),
        "INVALID_WORKSPACE",
        "sha256",
      );
    }
  });

  it("refuses repeated source keys and repeated resource paths", () => {
    expectRefusal(
      () =>
        normalizeWorkspace(
          workspace({
            sources: [
              { key: "architecture", label: "a.ifc", byteLength: 1, sha256: digestB },
              { key: "architecture", label: "b.ifc", byteLength: 2, sha256: digestC },
            ],
          }),
        ),
      "INVALID_WORKSPACE",
      "repeats",
    );
  });

  it("refuses a manifest that names no source", () => {
    expectRefusal(
      () => normalizeWorkspace(workspace({ sources: [] })),
      "INVALID_WORKSPACE",
      "must name at least one source",
    );
  });
});

describe("workspace parse limits", () => {
  it("bounds the manifest before parsing it", () => {
    expectRefusal(
      () => parseWorkspace("x".repeat(64), { limits: { documentCharacters: 16 } }),
      "LIMIT_EXCEEDED",
      "64 characters",
    );
  });

  it("bounds each collection", () => {
    expectRefusal(
      () => normalizeWorkspace(workspace(), { limits: { sourceCount: 1 } }),
      "LIMIT_EXCEEDED",
      "workspace.sources declares 2 entries",
    );
    expectRefusal(
      () => normalizeWorkspace(workspace(), { limits: { resourceCount: 1 } }),
      "LIMIT_EXCEEDED",
      "workspace.package.resources declares 2 entries",
    );
    expectRefusal(
      () => normalizeWorkspace(workspace(), { limits: { hiddenOccurrenceCount: 1 } }),
      "LIMIT_EXCEEDED",
      "workspace.view.hiddenOccurrenceIds declares 2 entries",
    );
  });

  it("reports invalid JSON without leaking the parser's internals", () => {
    expectRefusal(() => parseWorkspace("{"), "INVALID_WORKSPACE", "not valid JSON");
  });
});

describe("workspace view state", () => {
  function withView(view: Record<string, unknown>): Record<string, unknown> {
    return workspace({ view: { ...(workspace()["view"] as Record<string, unknown>), ...view } });
  }

  it("refuses a section fraction outside the plane", () => {
    expectRefusal(
      () => normalizeWorkspace(withView({ section: { enabled: true, axis: "z", direction: 1, fraction: 1.5 } })),
      "INVALID_WORKSPACE",
      "between 0 and 1",
    );
  });

  it("refuses a non-finite camera value", () => {
    expectRefusal(
      () => normalizeWorkspace(withView({ camera: { yaw: Number.NaN, pitch: 0, panRight: 0, panUp: 0, zoom: 1 } })),
      "INVALID_WORKSPACE",
      "finite number",
    );
  });

  it("keeps an absent selection explicit", () => {
    expect(normalizeWorkspace(withView({ selectedOccurrenceId: null })).view.selectedOccurrenceId).toBeNull();
  });
});
