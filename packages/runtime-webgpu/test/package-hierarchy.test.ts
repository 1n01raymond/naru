import { describe, expect, it } from "vitest";

import { compileSceneToGltf } from "../../compiler/src/index.js";
import { createRepeatedTriangleScene, ids } from "../../scene-ir/src/index.js";
import type { EngineeringScene } from "../../scene-ir/src/index.js";
import {
  decodePackageHierarchy,
  inspectCompiledHierarchy,
  PackageHierarchyError,
  supportedPackageHierarchySchema,
} from "../src/index.js";
import type { CompiledHierarchyEntry } from "../src/index.js";

const assemblyIds = {
  derived: "occurrence:assembly:derived",
  bespoke: "occurrence:assembly:bespoke",
  anonymous: "occurrence:assembly:anonymous",
} as const;

/**
 * A scene whose assembly nodes draw nothing and whose identities cover all
 * three states relocation has to preserve: reconstructible from the derivation
 * rule, bespoke, and genuinely absent.
 */
function createRelocatableScene(): EngineeringScene {
  const base = createRepeatedTriangleScene();
  const template = base.occurrences[0];
  const prototype = base.prototypes[0];
  const document = base.documents[0];
  const semantic = base.semantics[0];
  const second = base.occurrences[1];
  if (!template || !prototype || !document || !semantic || !second) {
    throw new TypeError("Triangle fixture is incomplete.");
  }
  const assemblyPrototypeId = ids.prototype("prototype:assembly");
  const derivedSemanticId = ids.semantic(`semantic:${assemblyPrototypeId}`);
  const derivedSourceRef = ids.sourceRef(`source:${assemblyPrototypeId}`);
  const bespokeSemanticId = ids.semantic("semantic:bespoke-frame");
  const bespokeSourceRef = ids.sourceRef("source:frame-weldment");
  const sourceRefFor = (id: typeof derivedSourceRef) => ({
    id,
    documentId: document.id,
    namespace: "generated",
    value: id as string,
    kind: "assembly" as const,
    stability: "revision-local" as const,
  });
  const moved = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0.25, -0.5, 1];

  return {
    ...base,
    sceneId: "scene:relocatable-hierarchy",
    documents: [
      {
        ...document,
        sourceRefs: [
          ...document.sourceRefs,
          sourceRefFor(derivedSourceRef),
          sourceRefFor(bespokeSourceRef),
        ],
      },
    ],
    semantics: [
      ...base.semantics,
      { ...semantic, id: derivedSemanticId, sourceRef: derivedSourceRef },
      { ...semantic, id: bespokeSemanticId, sourceRef: bespokeSourceRef },
    ],
    prototypes: [
      ...base.prototypes,
      {
        id: assemblyPrototypeId,
        name: "Assembly prototype",
        representationIds: [],
        localBounds: { min: [0, 0, 0], max: [0, 0, 0] },
        metadata: prototype.metadata,
      },
    ],
    occurrences: [
      {
        ...template,
        id: ids.occurrence(assemblyIds.derived),
        prototypeId: assemblyPrototypeId,
        name: "Derived assembly",
        semanticId: derivedSemanticId,
        sourceRef: derivedSourceRef,
        localTransform: moved(0.75),
        tags: ["assembly", "level-0"],
      },
      {
        ...template,
        id: ids.occurrence(assemblyIds.bespoke),
        parentId: ids.occurrence(assemblyIds.derived),
        prototypeId: assemblyPrototypeId,
        name: "Bespoke assembly",
        semanticId: bespokeSemanticId,
        sourceRef: bespokeSourceRef,
        localTransform: moved(-0.25),
        initialVisibility: false,
        tags: [],
      },
      {
        ...template,
        id: ids.occurrence(assemblyIds.anonymous),
        parentId: ids.occurrence(assemblyIds.derived),
        prototypeId: assemblyPrototypeId,
        name: assemblyIds.anonymous,
        semanticId: undefined,
        sourceRef: undefined,
        localTransform: moved(0.5),
        tags: ["assembly", "level-0"],
      },
      { ...template, parentId: ids.occurrence(assemblyIds.bespoke) },
      { ...second, parentId: ids.occurrence(assemblyIds.anonymous) },
    ],
  } as EngineeringScene;
}

const scene = createRelocatableScene();

function compile(options: Parameters<typeof compileSceneToGltf>[1] = {}) {
  return compileSceneToGltf(scene, options);
}

function sidecarOptions(compiled: ReturnType<typeof compile>) {
  if (!compiled.hierarchyJson || !compiled.hierarchyBinary) {
    throw new TypeError("The compilation did not emit a hierarchy sidecar.");
  }
  return { hierarchy: { json: compiled.hierarchyJson, columns: compiled.hierarchyBinary } };
}

/** Everything the tree carries except the node index, which relocation moves. */
/** Node indexes are renumbered by relocation; everything else must survive. */
function treeShape(entries: readonly CompiledHierarchyEntry[]) {
  return entries.map(({ nodeIndex: _nodeIndex, ...rest }) => rest);
}

describe("relocated hierarchy sidecar", () => {
  it("reproduces the assembly tree the document no longer carries", () => {
    const kept = compile();
    const relocated = compile({ relocateHierarchyNodes: true });
    const keptTree = inspectCompiledHierarchy(kept.document);
    const relocatedTree = inspectCompiledHierarchy(
      relocated.document,
      sidecarOptions(relocated),
    );

    // Three assembly occurrences leave; the source frame and two meshes stay.
    expect(relocated.document.nodes).toHaveLength(kept.document.nodes.length - 3);
    expect(treeShape(relocatedTree.hierarchy.entries)).toEqual(
      treeShape(keptTree.hierarchy.entries),
    );
    expect(relocatedTree.hierarchy.entries.map(({ depth }) => depth)).toEqual([0, 1, 2, 1, 2]);
    expect(relocatedTree.hierarchy.renderableOccurrences).toBe(2);
    expect(relocatedTree.hierarchy.relocatedHierarchy).toEqual({
      schemaVersion: supportedPackageHierarchySchema,
      uri: "hierarchy.json",
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      entryCount: 5,
      relocatedCount: 3,
    });
  });

  it("keeps every identity state a derivation rule leaves ambiguous", () => {
    const kept = compile({ elideDerivedIdentifiers: true });
    const relocated = compile({
      elideDerivedIdentifiers: true,
      relocateHierarchyNodes: true,
    });
    const relocatedTree = inspectCompiledHierarchy(
      relocated.document,
      sidecarOptions(relocated),
    );

    expect(treeShape(relocatedTree.hierarchy.entries)).toEqual(
      treeShape(inspectCompiledHierarchy(kept.document).hierarchy.entries),
    );
    const identities = Object.fromEntries(
      relocatedTree.hierarchy.entries.map((entry) => [
        entry.occurrenceId,
        [entry.semanticId, entry.sourceRef],
      ]),
    );
    expect(identities[assemblyIds.derived]).toEqual([
      "semantic:prototype:assembly",
      "source:prototype:assembly",
    ]);
    expect(identities[assemblyIds.bespoke]).toEqual([
      "semantic:bespoke-frame",
      "source:frame-weldment",
    ]);
    expect(identities[assemblyIds.anonymous]).toEqual([undefined, undefined]);
  });

  it("refuses to report a tree when the declared sidecar is missing", () => {
    const relocated = compile({ relocateHierarchyNodes: true });

    expect(() => inspectCompiledHierarchy(relocated.document)).toThrow(PackageHierarchyError);
    expect(() => inspectCompiledHierarchy(relocated.document)).toThrow(
      /sidecar must be supplied/u,
    );
  });

  it("answers a geometry-only caller with no tree instead of a partial one", () => {
    const relocated = compile({ relocateHierarchyNodes: true });
    const { hierarchy } = inspectCompiledHierarchy(relocated.document, {
      hierarchy: "geometry-only",
    });

    // The Worker decodes byte ranges without the sidecar; handing it the three
    // nodes that stayed behind would look exactly like a complete small tree.
    expect(hierarchy.entries).toEqual([]);
    expect(hierarchy.relocatedHierarchy?.entryCount).toBe(5);
    // Relocation moves only nodes that draw nothing, so this stays exact.
    expect(hierarchy.renderableOccurrences).toBe(2);
  });
});

describe("hierarchy sidecar decoding", () => {
  const compiled = compile({ relocateHierarchyNodes: true });
  const columns = compiled.hierarchyBinary as Uint8Array;
  const header = () => JSON.parse(compiled.hierarchyJson as string) as Record<string, unknown>;

  it("decodes the compiler's own sidecar", () => {
    const decoded = decodePackageHierarchy(compiled.hierarchyJson, columns, {
      maxEntries: 1_000,
    });

    expect(decoded.entries).toHaveLength(5);
    expect(decoded.relocatedCount).toBe(3);
    expect(decoded.documentNodeCount).toBe(compiled.document.nodes.length);
    const bespoke = decoded.entries
      .map(({ relocated }) => relocated)
      .find((node) => node?.occurrenceId === assemblyIds.bespoke);
    expect(bespoke?.initialVisibility).toBe(false);
    expect(bespoke?.tags).toEqual([]);
    expect([...(bespoke?.localTransform ?? [])]).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.25, 0.25, -0.5, 1,
    ]);
  });

  it("keeps an omitted identity key distinguishable from an explicit null", () => {
    const elided = compile({ elideDerivedIdentifiers: true, relocateHierarchyNodes: true });
    const decoded = decodePackageHierarchy(elided.hierarchyJson, elided.hierarchyBinary as Uint8Array, {
      maxEntries: 1_000,
    });
    const node = (occurrenceId: string) => {
      const found = decoded.entries
        .map(({ relocated }) => relocated)
        .find((candidate) => candidate?.occurrenceId === occurrenceId);
      if (!found) throw new TypeError(`${occurrenceId} did not survive relocation.`);
      return found;
    };

    // The loader tells the two absent states apart with the `in` operator, so
    // an omitted field has to stay an absent *own* property: a prototype
    // accessor or an `undefined` initializer would make both states look alike.
    const derived = node(assemblyIds.derived);
    expect("semanticId" in derived).toBe(false);
    expect("sourceRef" in derived).toBe(false);
    const anonymous = node(assemblyIds.anonymous);
    expect("semanticId" in anonymous).toBe(true);
    expect(anonymous.semanticId).toBeNull();
    expect(anonymous.sourceRef).toBeNull();
    expect(node(assemblyIds.bespoke).semanticId).toBe("semantic:bespoke-frame");
  });

  it("hands every reader of a transform its own copy", () => {
    const decoded = decodePackageHierarchy(compiled.hierarchyJson, columns, { maxEntries: 1_000 });
    const node = decoded.entries
      .map(({ relocated }) => relocated)
      .find((candidate) => candidate?.occurrenceId === assemblyIds.bespoke);
    if (!node) throw new TypeError("The bespoke assembly did not survive relocation.");

    const first = node.localTransform;
    const second = node.localTransform;
    expect(second).not.toBe(first);
    // The copies come out of one shared table, so a caller that writes into the
    // one it was handed must not be able to reach any other node's transform.
    first[12] = 42;
    expect(node.localTransform[12]).toBe(-0.25);
  });

  it("reads a sidecar handed over on an unaligned slice", () => {
    const padded = new Uint8Array(columns.byteLength + 1);
    padded.set(columns, 1);

    expect(
      decodePackageHierarchy(compiled.hierarchyJson, padded.subarray(1), {
        maxEntries: 1_000,
      }).entries,
    ).toHaveLength(5);
  });

  it("refuses a schema it does not implement", () => {
    expect(() =>
      decodePackageHierarchy(
        { ...header(), schemaVersion: "naru.package-hierarchy.2" },
        columns,
        { maxEntries: 1_000 },
      ),
    ).toThrow(/naru.package-hierarchy.1/u);
  });

  it("refuses a header that disagrees with the bytes it was given", () => {
    expect(() => decodePackageHierarchy(compiled.hierarchyJson, columns.slice(0, 32), {
      maxEntries: 1_000,
    })).toThrow(PackageHierarchyError);
    const moved = header();
    const sections = moved.sections as Record<string, Record<string, number>>;
    expect(() =>
      decodePackageHierarchy(
        { ...moved, sections: { ...sections, depths: { ...sections.depths, byteOffset: 2 } } },
        columns,
        { maxEntries: 1_000 },
      ),
    ).toThrow(/4-byte boundary/u);
    expect(() =>
      decodePackageHierarchy({ ...moved, entryCount: 4 }, columns, { maxEntries: 1_000 }),
    ).toThrow(PackageHierarchyError);
  });

  it("refuses a sidecar larger than the caller's entry ceiling", () => {
    expect(() =>
      decodePackageHierarchy(compiled.hierarchyJson, columns, { maxEntries: 4 }),
    ).toThrow(/entryCount/u);
  });

  it("refuses a node column that points outside the document", () => {
    const sections = header().sections as Record<string, { byteOffset: number }>;
    const bytes = columns.slice();
    new DataView(bytes.buffer).setUint32(sections.nodeIndexes?.byteOffset ?? 0, 99, true);

    expect(() =>
      inspectCompiledHierarchy(compiled.document, {
        hierarchy: { json: compiled.hierarchyJson, columns: bytes },
      }),
    ).toThrow(PackageHierarchyError);
  });
});
