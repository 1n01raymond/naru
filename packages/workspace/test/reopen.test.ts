import { describe, expect, it } from "vitest";

import {
  evaluateWorkspaceReopen,
  normalizeWorkspace,
  workspaceSchemaVersion,
  type WorkspaceDocument,
  type WorkspaceObservation,
} from "../src/index.js";

const gltfDigest = "1".repeat(64);
const binDigest = "2".repeat(64);
const packageDigest = "3".repeat(64);
const architectureDigest = "4".repeat(64);
const structureDigest = "5".repeat(64);
const movedDigest = "6".repeat(64);

const saved: WorkspaceDocument = normalizeWorkspace({
  schemaVersion: workspaceSchemaVersion,
  label: "Digital Hub review",
  package: {
    reference: { kind: "url", href: "https://example.test/digital-hub/scene.gltf" },
    packageDigest,
    resources: [
      { path: "scene.gltf", byteLength: 20_562_117, sha256: gltfDigest },
      { path: "scene.bin", byteLength: 22_410_360, sha256: binDigest },
    ],
  },
  sources: [
    { key: "architecture", label: "arc.ifc", byteLength: 9_022_255, sha256: architectureDigest },
    { key: "structure", label: "str.ifc", byteLength: 4_119_887, sha256: structureDigest },
  ],
  view: {
    camera: { yaw: 0.7, pitch: -0.35, panRight: 12.5, panUp: -3.25, zoom: 1.75 },
    section: { enabled: true, axis: "z", direction: -1, fraction: 0.42 },
    hiddenOccurrenceIds: ["occurrence-hidden", "occurrence-gone"],
    selectedOccurrenceId: "occurrence-selected",
    annotations: [],
  },
});

const observedResources = [
  { path: "scene.gltf", byteLength: 20_562_117, sha256: gltfDigest },
  { path: "scene.bin", byteLength: 22_410_360, sha256: binDigest },
];

const observedSources = [
  { key: "architecture", byteLength: 9_022_255, sha256: architectureDigest },
  { key: "structure", byteLength: 4_119_887, sha256: structureDigest },
];

function observation(overrides: Partial<WorkspaceObservation> = {}): WorkspaceObservation {
  return {
    packagePresent: true,
    packageDigest,
    resources: observedResources,
    resourcesComplete: true,
    sourceInspection: "available",
    sources: observedSources,
    ...overrides,
  };
}

describe("workspace reopen", () => {
  it("verifies a reopen where every part was inspected and matched", () => {
    const decision = evaluateWorkspaceReopen(saved, observation());
    expect(decision.state).toBe("verified");
    expect(decision.geometryIsCurrent).toBe(true);
    expect(decision.package.state).toBe("verified");
    expect(decision.sources.map((source) => source.state)).toEqual(["verified", "verified"]);
  });

  it("reports a changed source and refuses to call the geometry current", () => {
    const decision = evaluateWorkspaceReopen(
      saved,
      observation({
        sources: [
          { key: "architecture", byteLength: 9_022_301, sha256: movedDigest },
          { key: "structure", byteLength: 4_119_887, sha256: structureDigest },
        ],
      }),
    );
    expect(decision.state).toBe("changed-source");
    expect(decision.geometryIsCurrent).toBe(false);
    expect(decision.sources[0]?.state).toBe("changed");
    expect(decision.sources[1]?.state).toBe("verified");
    expect(decision.package.state).toBe("verified");
  });

  it("reports a source the host looked for and did not find", () => {
    const decision = evaluateWorkspaceReopen(
      saved,
      observation({ sources: [observedSources[0]!] }),
    );
    expect(decision.state).toBe("changed-source");
    expect(decision.sources[1]?.state).toBe("missing");
  });

  it("separates a source that cannot be inspected from one that matched", () => {
    const decision = evaluateWorkspaceReopen(
      saved,
      observation({ sourceInspection: "unavailable", sources: undefined }),
    );
    expect(decision.state).toBe("unverifiable");
    expect(decision.geometryIsCurrent).toBe(false);
    expect(decision.sources.every((source) => source.state === "unverifiable")).toBe(true);
    expect(decision.package.state).toBe("verified");
  });

  it("reports a moved package resource", () => {
    const decision = evaluateWorkspaceReopen(
      saved,
      observation({
        packageDigest: movedDigest,
        resources: [
          observedResources[0]!,
          { path: "scene.bin", byteLength: 22_410_991, sha256: movedDigest },
        ],
      }),
    );
    expect(decision.state).toBe("changed-package");
    expect(decision.package.state).toBe("changed");
    expect(decision.package.resources).toEqual([
      { path: "scene.bin", state: "changed" },
      { path: "scene.gltf", state: "verified" },
    ]);
    expect(decision.package.observedDigest).toBe(movedDigest);
  });
});

describe("workspace reopen precedence", () => {
  it("blocks when the package cannot be opened at all", () => {
    const decision = evaluateWorkspaceReopen(
      saved,
      observation({ packagePresent: false, packageDigest: undefined, resources: undefined }),
    );
    expect(decision.state).toBe("blocked");
    expect(decision.package.resources.every((resource) => resource.state === "missing")).toBe(true);
  });

  it("reports the source ahead of the package when both moved", () => {
    const decision = evaluateWorkspaceReopen(
      saved,
      observation({
        packageDigest: movedDigest,
        sources: [
          { key: "architecture", byteLength: 9_022_301, sha256: movedDigest },
          { key: "structure", byteLength: 4_119_887, sha256: structureDigest },
        ],
      }),
    );
    expect(decision.state).toBe("changed-source");
    expect(decision.package.state).toBe("changed");
  });

  it("leaves the package unverifiable when neither a digest nor a complete list is observed", () => {
    const withoutDigest = evaluateWorkspaceReopen(
      saved,
      observation({ packageDigest: undefined, resourcesComplete: false }),
    );
    expect(withoutDigest.state).toBe("unverifiable");
    expect(withoutDigest.package.state).toBe("unverifiable");

    const listOnly = evaluateWorkspaceReopen(saved, observation({ packageDigest: undefined }));
    expect(listOnly.state).toBe("verified");

    const digestOnly = evaluateWorkspaceReopen(
      saved,
      observation({ resources: undefined, resourcesComplete: undefined }),
    );
    expect(digestOnly.state).toBe("verified");
    expect(digestOnly.package.resources.every((r) => r.state === "unverifiable")).toBe(true);
  });

  it("notices a resource the saved package never carried", () => {
    const decision = evaluateWorkspaceReopen(
      saved,
      observation({
        resources: [
          ...observedResources,
          { path: "properties.bin", byteLength: 2_260_991, sha256: movedDigest },
        ],
      }),
    );
    expect(decision.state).toBe("changed-package");
  });
});

describe("workspace view resolution", () => {
  it("keeps the references the reopened hierarchy still carries", () => {
    const decision = evaluateWorkspaceReopen(
      saved,
      observation({
        occurrenceIds: new Set(["occurrence-hidden", "occurrence-selected", "occurrence-other"]),
      }),
    );
    expect(decision.view.resolvedAgainstHierarchy).toBe(true);
    expect(decision.view.hiddenOccurrenceIds).toEqual(["occurrence-hidden"]);
    expect(decision.view.droppedHiddenOccurrenceIds).toEqual(["occurrence-gone"]);
    expect(decision.view.selectedOccurrenceId).toBe("occurrence-selected");
    expect(decision.view.droppedSelection).toBe(false);
  });

  it("drops a selection the reopened hierarchy no longer carries", () => {
    const decision = evaluateWorkspaceReopen(
      saved,
      observation({ occurrenceIds: new Set(["occurrence-hidden"]) }),
    );
    expect(decision.view.selectedOccurrenceId).toBeNull();
    expect(decision.view.droppedSelection).toBe(true);
  });

  it("drops nothing when no hierarchy was supplied", () => {
    const decision = evaluateWorkspaceReopen(saved, observation());
    expect(decision.view.resolvedAgainstHierarchy).toBe(false);
    expect(decision.view.hiddenOccurrenceIds).toEqual(saved.view.hiddenOccurrenceIds);
    expect(decision.view.droppedHiddenOccurrenceIds).toEqual([]);
    expect(decision.view.droppedSelection).toBe(false);
  });

  it("carries camera and section through untouched", () => {
    const decision = evaluateWorkspaceReopen(
      saved,
      observation({ occurrenceIds: new Set<string>() }),
    );
    expect(decision.view.camera).toEqual(saved.view.camera);
    expect(decision.view.section).toEqual(saved.view.section);
  });
});
