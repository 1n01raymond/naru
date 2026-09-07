import { createHash } from "node:crypto";

import {
  evaluateWorkspaceReopen,
  parseWorkspace,
  serializeWorkspace,
  workspaceSchemaVersion,
} from "@naru3d/workspace";
import type {
  ObservedSource,
  WorkspaceCamera,
  WorkspaceDocument,
  WorkspacePackageResource,
  WorkspaceSection,
  WorkspaceSource,
} from "@naru3d/workspace";
import { describe, expect, it } from "vitest";

import {
  captureWorkspace,
  inspectWorkspaceSources,
  observeWorkspace,
  resolveRestoredObjects,
  type ReadableSourceFile,
} from "../src/workspace-session.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const camera: WorkspaceCamera = {
  yaw: 0.75,
  pitch: -0.25,
  panRight: 12.5,
  panUp: -3,
  zoom: 2.5,
};

const section: WorkspaceSection = {
  enabled: true,
  axis: "y",
  direction: -1,
  fraction: 0.375,
};

const resources: readonly WorkspacePackageResource[] = [
  { path: "scene.gltf", byteLength: 34_184_035, sha256: sha256("scene.gltf") },
  { path: "scene.bin", byteLength: 22_410_360, sha256: sha256("scene.bin") },
];

const sources: readonly WorkspaceSource[] = [
  {
    key: "architecture",
    label: "arc.ifc",
    byteLength: 9_022_255,
    sha256: sha256("arc.ifc"),
  },
  {
    key: "structure",
    label: "str.ifc",
    byteLength: 4_103_991,
    sha256: sha256("str.ifc"),
  },
];

/** The occurrence ids a small loaded scene would carry, keyed by object id. */
const occurrenceById = new Map<number, string>([
  [1, "architecture:wall-a"],
  [2, "architecture:wall-b"],
  [3, "structure:beam-a"],
  [4, "structure:beam-b"],
]);

function occurrenceIdOf(objectId: number): string | undefined {
  return occurrenceById.get(objectId);
}

function objectIdOf(occurrenceId: string): number | undefined {
  for (const [objectId, candidate] of occurrenceById) {
    if (candidate === occurrenceId) return objectId;
  }
  return undefined;
}

function capture(overrides: Partial<Parameters<typeof captureWorkspace>[0]> = {}) {
  return captureWorkspace({
    label: "Digital Hub",
    reference: { kind: "local", fileName: "scene.gltf" },
    packageDigest: sha256("package"),
    resources,
    sources,
    camera,
    section,
    annotations: [],
    hiddenObjectIds: [3, 1],
    selectedObjectId: 2,
    occurrenceIdOf,
    ...overrides,
  });
}

function observedFrom(document: WorkspaceDocument): readonly ObservedSource[] {
  return document.sources.map((source) => ({
    key: source.key,
    byteLength: source.byteLength,
    sha256: source.sha256,
  }));
}

function textFile(name: string, text: string): ReadableSourceFile {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  };
}

describe("captureWorkspace", () => {
  it("refuses to write a workspace that names no source", () => {
    expect(() => capture({ sources: [] })).toThrow(TypeError);
  });

  it("names the hidden set and the selection by occurrence", () => {
    const captured = capture();
    expect(captured.document.schemaVersion).toBe(workspaceSchemaVersion);
    expect(captured.document.view.hiddenOccurrenceIds).toEqual([
      "structure:beam-a",
      "architecture:wall-a",
    ]);
    expect(captured.document.view.selectedOccurrenceId).toBe("architecture:wall-b");
    expect(captured.unnamedHiddenObjectIds).toEqual([]);
    expect(captured.unnamedSelection).toBe(false);
  });

  it("reports the objects the scene carries no occurrence id for", () => {
    const captured = capture({ hiddenObjectIds: [1, 99], selectedObjectId: 98 });
    expect(captured.document.view.hiddenOccurrenceIds).toEqual(["architecture:wall-a"]);
    expect(captured.unnamedHiddenObjectIds).toEqual([99]);
    expect(captured.document.view.selectedOccurrenceId).toBeNull();
    expect(captured.unnamedSelection).toBe(true);
  });

  it("records no selection as null rather than as object zero", () => {
    const captured = capture({ selectedObjectId: 0 });
    expect(captured.document.view.selectedOccurrenceId).toBeNull();
    expect(captured.unnamedSelection).toBe(false);
  });
});

describe("observeWorkspace", () => {
  it("omits resources so no whole-resource digest is claimed", () => {
    const observation = observeWorkspace({
      packagePresent: true,
      packageDigest: sha256("package"),
      occurrenceIds: new Set(occurrenceById.values()),
      inspectedSources: undefined,
    });
    expect(observation.resources).toBeUndefined();
    expect(observation.sourceInspection).toBe("unavailable");
    expect(observation.sources).toBeUndefined();
  });

  it("reports inspection as available once sources were hashed", () => {
    const observation = observeWorkspace({
      packagePresent: true,
      packageDigest: sha256("package"),
      occurrenceIds: undefined,
      inspectedSources: observedFrom(capture().document),
    });
    expect(observation.sourceInspection).toBe("available");
    expect(observation.sources).toHaveLength(2);
  });
});

describe("resolveRestoredObjects", () => {
  it("maps occurrences back to object ids in ascending order", () => {
    const restored = resolveRestoredObjects(
      {
        camera,
        section,
        hiddenOccurrenceIds: ["structure:beam-a", "architecture:wall-a"],
        droppedHiddenOccurrenceIds: [],
        selectedOccurrenceId: "architecture:wall-b",
        droppedSelection: false,
        resolvedAgainstHierarchy: true,
        annotations: [],
      },
      objectIdOf,
    );
    expect(restored.hiddenObjectIds).toEqual([1, 3]);
    expect(restored.selectedObjectId).toBe(2);
    expect(restored.droppedOccurrenceIds).toEqual([]);
    expect(restored.droppedSelection).toBe(false);
  });

  it("reports ids the reopened batches cannot act on rather than discarding them", () => {
    const restored = resolveRestoredObjects(
      {
        camera,
        section,
        hiddenOccurrenceIds: ["architecture:wall-a", "architecture:wall-gone"],
        droppedHiddenOccurrenceIds: ["structure:beam-removed"],
        selectedOccurrenceId: "structure:beam-gone",
        droppedSelection: false,
        resolvedAgainstHierarchy: true,
        annotations: [],
      },
      objectIdOf,
    );
    expect(restored.hiddenObjectIds).toEqual([1]);
    expect(restored.selectedObjectId).toBe(0);
    expect(restored.droppedOccurrenceIds).toEqual([
      "structure:beam-removed",
      "architecture:wall-gone",
      "structure:beam-gone",
    ]);
    expect(restored.droppedSelection).toBe(true);
  });

  it("keeps a selection the resolution already dropped reported as dropped", () => {
    const restored = resolveRestoredObjects(
      {
        camera,
        section,
        hiddenOccurrenceIds: [],
        droppedHiddenOccurrenceIds: [],
        selectedOccurrenceId: null,
        droppedSelection: true,
        resolvedAgainstHierarchy: true,
        annotations: [],
      },
      objectIdOf,
    );
    expect(restored.selectedObjectId).toBe(0);
    expect(restored.droppedSelection).toBe(true);
  });
});

/**
 * The round trip ADR-0022 gate 1 names, at the scale a unit test can hold: the
 * Studio's own translation layer, serialization, the parser, the reopen
 * decision, and the translation back. What this cannot show is the renderer
 * acting on the result, which is why the browser record is a separate slice.
 */
describe("workspace round trip", () => {
  it("restores camera, section, hidden set, and selection against an unchanged package", () => {
    const captured = capture();
    const document = parseWorkspace(serializeWorkspace(captured.document));
    const decision = evaluateWorkspaceReopen(
      document,
      observeWorkspace({
        packagePresent: true,
        packageDigest: captured.document.package.packageDigest,
        occurrenceIds: new Set(occurrenceById.values()),
        inspectedSources: observedFrom(captured.document),
      }),
    );

    expect(decision.state).toBe("verified");
    expect(decision.geometryIsCurrent).toBe(true);
    expect(decision.view.camera).toEqual(camera);
    expect(decision.view.section).toEqual(section);

    const restored = resolveRestoredObjects(decision.view, objectIdOf);
    expect(restored.hiddenObjectIds).toEqual([1, 3]);
    expect(restored.selectedObjectId).toBe(2);
    expect(restored.droppedOccurrenceIds).toEqual([]);
    expect(restored.droppedSelection).toBe(false);
  });

  it("drops the ids a recompiled hierarchy no longer carries and says which", () => {
    const captured = capture();
    const decision = evaluateWorkspaceReopen(
      parseWorkspace(serializeWorkspace(captured.document)),
      observeWorkspace({
        packagePresent: true,
        packageDigest: captured.document.package.packageDigest,
        occurrenceIds: new Set(["architecture:wall-a", "architecture:wall-b"]),
        inspectedSources: observedFrom(captured.document),
      }),
    );
    const restored = resolveRestoredObjects(decision.view, objectIdOf);
    expect(restored.hiddenObjectIds).toEqual([1]);
    expect(restored.droppedOccurrenceIds).toEqual(["structure:beam-a"]);
    expect(restored.selectedObjectId).toBe(2);
  });
});

/** ADR-0022 gate 2, at unit scale: a real source edit must not read as current. */
describe("changed-source detection", () => {
  it("reopens as changed-source with geometry not current when one source moved", () => {
    const captured = capture();
    const document = parseWorkspace(serializeWorkspace(captured.document));
    const observed = observedFrom(document).map((source, index) =>
      index === 1
        ? { ...source, byteLength: source.byteLength + 8, sha256: sha256("str.ifc edited") }
        : source,
    );
    const decision = evaluateWorkspaceReopen(
      document,
      observeWorkspace({
        packagePresent: true,
        packageDigest: captured.document.package.packageDigest,
        occurrenceIds: new Set(occurrenceById.values()),
        inspectedSources: observed,
      }),
    );

    expect(decision.state).toBe("changed-source");
    expect(decision.geometryIsCurrent).toBe(false);
    expect(decision.package.state).toBe("verified");
    expect(decision.sources.map((source) => [source.label, source.state])).toEqual([
      ["arc.ifc", "verified"],
      ["str.ifc", "changed"],
    ]);
  });

  it("keeps an uninspected source unverifiable rather than verified", () => {
    const captured = capture();
    const decision = evaluateWorkspaceReopen(
      parseWorkspace(serializeWorkspace(captured.document)),
      observeWorkspace({
        packagePresent: true,
        packageDigest: captured.document.package.packageDigest,
        occurrenceIds: new Set(occurrenceById.values()),
        inspectedSources: undefined,
      }),
    );
    expect(decision.state).toBe("unverifiable");
    expect(decision.geometryIsCurrent).toBe(false);
    expect(decision.sources.every((source) => source.state === "unverifiable")).toBe(true);
  });
});

const backslash = String.fromCharCode(92);
const isoTimestamp = /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}/u;

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, into);
  else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      collectStrings(entry, into);
    }
  }
}

/**
 * ADR-0022 gate 3. A manifest another host wrote must parse here and
 * re-serialize to the same bytes, and the absence of a host detail is asserted
 * over the whole document rather than assumed from the writer's intent.
 */
describe("portability", () => {
  const foreign =
    `{"schemaVersion":"${workspaceSchemaVersion}","label":"Digital Hub",` +
    `"package":{"reference":{"kind":"local","fileName":"scene.gltf"},` +
    `"packageDigest":"${sha256("package")}","resources":[` +
    `{"path":"scene.gltf","byteLength":34184035,"sha256":"${sha256("scene.gltf")}"}]},` +
    `"sources":[{"key":"architecture","label":"arc.ifc","byteLength":9022255,` +
    `"sha256":"${sha256("arc.ifc")}"}],` +
    `"view":{"camera":{"yaw":0.75,"pitch":-0.25,"panRight":12.5,"panUp":-3,"zoom":2.5},` +
    `"section":{"enabled":true,"axis":"y","direction":-1,"fraction":0.375},` +
    `"hiddenOccurrenceIds":["architecture:wall-a"],` +
    `"selectedOccurrenceId":"architecture:wall-b","annotations":[]}}` +
    "\n";

  it("re-serializes a manifest written elsewhere to identical bytes", () => {
    expect(serializeWorkspace(parseWorkspace(foreign))).toBe(foreign);
  });

  it("carries no host path, no timestamp, and no user identity", () => {
    const strings: string[] = [];
    collectStrings(JSON.parse(serializeWorkspace(capture().document)), strings);
    for (const value of strings) {
      expect(value).not.toContain(backslash);
      expect(value).not.toContain("/");
      expect(value).not.toMatch(isoTimestamp);
    }
    expect(strings).not.toContain("recordedAt");
    expect(strings).not.toContain("host");
  });
});

describe("inspectWorkspaceSources", () => {
  it("hashes every source the manifest names", async () => {
    const document = capture().document;
    const inspection = await inspectWorkspaceSources(document, [
      textFile("str.ifc", "structure"),
      textFile("arc.ifc", "architecture"),
    ]);
    expect(inspection.reasons).toEqual([]);
    expect(inspection.sources).toEqual([
      { key: "architecture", byteLength: 12, sha256: sha256("architecture") },
      { key: "structure", byteLength: 9, sha256: sha256("structure") },
    ]);
  });

  it("refuses a partial selection rather than judging an unpicked source missing", async () => {
    const inspection = await inspectWorkspaceSources(capture().document, [
      textFile("arc.ifc", "architecture"),
    ]);
    expect(inspection.sources).toBeUndefined();
    expect(inspection.reasons).toEqual(["str.ifc was not among the selected files."]);
  });

  it("refuses two selected files that carry one name", async () => {
    const inspection = await inspectWorkspaceSources(capture().document, [
      textFile("arc.ifc", "architecture"),
      textFile("arc.ifc", "architecture again"),
      textFile("str.ifc", "structure"),
    ]);
    expect(inspection.sources).toBeUndefined();
    expect(inspection.reasons).toEqual(["More than one selected file is called arc.ifc."]);
  });

  it("refuses a manifest whose sources cannot be told apart by file name", async () => {
    const collidingSources: readonly WorkspaceSource[] = [
      { key: "architecture", label: "model.ifc", byteLength: 4, sha256: sha256("a") },
      { key: "structure", label: "model.ifc", byteLength: 4, sha256: sha256("b") },
    ];
    const inspection = await inspectWorkspaceSources(
      capture({ sources: collidingSources }).document,
      [textFile("model.ifc", "either")],
    );
    expect(inspection.sources).toBeUndefined();
    expect(inspection.reasons).toHaveLength(2);
    expect(inspection.reasons[0]).toContain("more than one source called model.ifc");
  });
});
