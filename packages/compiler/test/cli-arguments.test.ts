import { describe, expect, it } from "vitest";

import {
  parseCompileArguments,
  parseIfcCompileArguments,
} from "../src/cli-arguments.js";

describe("naru compile arguments", () => {
  it("reads the positional source and every STEP option", () => {
    expect(
      parseCompileArguments([
        "model.step",
        "--output",
        "out",
        "--python",
        "/usr/bin/python3",
        "--cache",
        ".cache",
        "--linear-tolerance",
        "0.05",
        "--angular-tolerance",
        "0.2",
        "--spatial-index",
        "--spatial-leaf-capacity",
        "32",
        "--relocate-hierarchy-nodes",
        "--json-events",
      ]),
    ).toEqual({
      sourcePath: "model.step",
      outputDirectory: "out",
      pythonExecutable: "/usr/bin/python3",
      cacheDirectory: ".cache",
      linearTolerance: 0.05,
      angularTolerance: 0.2,
      spatialIndex: true,
      spatialLeafCapacity: 32,
      relocateHierarchyNodes: true,
      jsonEvents: true,
    });
  });

  it("accepts options before the source path", () => {
    expect(parseCompileArguments(["--output", "out", "model.step"])).toEqual({
      sourcePath: "model.step",
      outputDirectory: "out",
      spatialIndex: false,
      relocateHierarchyNodes: false,
      jsonEvents: false,
    });
  });

  it("omits absent optional values instead of emitting undefined", () => {
    const parsed = parseCompileArguments(["model.step", "--output", "out"]);
    expect(Object.keys(parsed).sort()).toEqual([
      "jsonEvents",
      "outputDirectory",
      "relocateHierarchyNodes",
      "sourcePath",
      "spatialIndex",
    ]);
  });

  it("requires a source path and an output directory", () => {
    expect(() => parseCompileArguments(["--output", "out"])).toThrow(/Usage:/u);
    expect(() => parseCompileArguments(["model.step"])).toThrow(/--output is required/u);
  });

  it("rejects a second positional argument", () => {
    expect(() => parseCompileArguments(["a.step", "b.step", "--output", "out"])).toThrow(
      /Unexpected argument b\.step/u,
    );
  });

  it("rejects an unknown option and names it", () => {
    expect(() => parseCompileArguments(["model.step", "--nope"])).toThrow(/--nope/u);
  });

  it("does not swallow the next flag as a value", () => {
    expect(() => parseCompileArguments(["model.step", "--output", "--python"])).toThrow(
      /Option '--output' argument is ambiguous/u,
    );
  });

  it("still allows a dash-leading value through the explicit form", () => {
    expect(parseCompileArguments(["model.step", "--output=-out"]).outputDirectory).toBe(
      "-out",
    );
  });

  it("rejects an empty value", () => {
    expect(() => parseCompileArguments(["model.step", "--output", ""])).toThrow(
      /--output requires a value/u,
    );
  });

  it("rejects non-positive tolerances and capacities", () => {
    const base = ["model.step", "--output", "out"];
    expect(() => parseCompileArguments([...base, "--linear-tolerance", "0"])).toThrow(
      /--linear-tolerance requires a positive number/u,
    );
    expect(() => parseCompileArguments([...base, "--angular-tolerance", "abc"])).toThrow(
      /--angular-tolerance requires a positive number/u,
    );
    expect(() =>
      parseCompileArguments([...base, "--spatial-index", "--spatial-leaf-capacity", "1.5"]),
    ).toThrow(/--spatial-leaf-capacity requires a positive integer/u);
  });

  it("requires --spatial-index before a leaf capacity", () => {
    expect(() =>
      parseCompileArguments(["model.step", "--output", "out", "--spatial-leaf-capacity", "32"]),
    ).toThrow(/--spatial-leaf-capacity requires --spatial-index/u);
  });
});

describe("naru compile-ifc arguments", () => {
  it("collects repeated documents and matches their URI hints", () => {
    expect(
      parseIfcCompileArguments([
        "--document",
        "architecture=arch.ifc",
        "--document",
        "structure=str.ifc",
        "--uri-hint",
        "structure=structural model",
        "--output",
        "out",
        "--threads",
        "6",
        "--target-chunk-kib",
        "256",
        "--compact-json",
        "--omit-resource-names",
        "--elide-derived-identifiers",
        "--omit-default-node-transforms",
        "--relocate-hierarchy-nodes",
        "--retain-scene-ir",
      "--staged-preview",
      "staged",
      ]),
    ).toEqual({
      documents: [
        { discipline: "architecture", sourcePath: "arch.ifc" },
        { discipline: "structure", sourcePath: "str.ifc", uriHint: "structural model" },
      ],
      outputDirectory: "out",
      threads: 6,
      targetChunkByteBudget: 256 * 1024,
      spatialIndex: false,
      spatialPayloadOrder: false,
      compactJson: true,
      omitResourceNames: true,
      elideDerivedIdentifiers: true,
      omitDefaultNodeTransforms: true,
      relocateHierarchyNodes: true,
      retainSceneIr: true,
      stagedPreviewDirectory: "staged",
      jsonEvents: false,
    });
  });

  it("leaves every document-shrinking option off unless asked for", () => {
    const parsed = parseIfcCompileArguments([
      "--document",
      "architecture=arch.ifc",
      "--output",
      "out",
    ]);
    expect(parsed.elideDerivedIdentifiers).toBe(false);
    expect(parsed.omitDefaultNodeTransforms).toBe(false);
    expect(parsed.relocateHierarchyNodes).toBe(false);
  });

  it("preserves the order documents were given in", () => {
    const parsed = parseIfcCompileArguments([
      "--document",
      "z=z.ifc",
      "--document",
      "a=a.ifc",
      "--output",
      "out",
    ]);
    expect(parsed.documents.map(({ discipline }) => discipline)).toEqual(["z", "a"]);
  });

  it("keeps a value that itself contains an equals sign", () => {
    const parsed = parseIfcCompileArguments([
      "--document",
      "architecture=C:=/models/arch.ifc",
      "--output",
      "out",
    ]);
    expect(parsed.documents[0]?.sourcePath).toBe("C:=/models/arch.ifc");
  });

  it("requires at least one document and an output directory", () => {
    expect(() => parseIfcCompileArguments(["--output", "out"])).toThrow(
      /--document is required/u,
    );
    expect(() => parseIfcCompileArguments(["--document", "a=a.ifc"])).toThrow(
      /--output is required/u,
    );
  });

  it("rejects a malformed document pair", () => {
    for (const pair of ["architecture", "=arch.ifc", "architecture="]) {
      expect(() =>
        parseIfcCompileArguments(["--document", pair, "--output", "out"]),
      ).toThrow(/--document requires a name=value pair/u);
    }
  });

  it("rejects duplicate disciplines and duplicate hints", () => {
    expect(() =>
      parseIfcCompileArguments([
        "--document",
        "architecture=a.ifc",
        "--document",
        "architecture=b.ifc",
        "--output",
        "out",
      ]),
    ).toThrow(/Duplicate IFC discipline architecture/u);
    expect(() =>
      parseIfcCompileArguments([
        "--document",
        "architecture=a.ifc",
        "--uri-hint",
        "architecture=one",
        "--uri-hint",
        "architecture=two",
        "--output",
        "out",
      ]),
    ).toThrow(/Duplicate IFC URI hint architecture/u);
  });

  it("rejects a hint with no matching document", () => {
    expect(() =>
      parseIfcCompileArguments([
        "--document",
        "architecture=a.ifc",
        "--uri-hint",
        "structure=nope",
        "--output",
        "out",
      ]),
    ).toThrow(/URI hint structure has no matching IFC document/u);
  });

  it("rejects a positional argument", () => {
    expect(() =>
      parseIfcCompileArguments(["stray.ifc", "--document", "a=a.ifc", "--output", "out"]),
    ).toThrow(/stray\.ifc/u);
  });

  it("requires --spatial-index before its dependent flags", () => {
    const base = ["--document", "a=a.ifc", "--output", "out"];
    expect(() =>
      parseIfcCompileArguments([...base, "--spatial-leaf-capacity", "32"]),
    ).toThrow(/--spatial-leaf-capacity requires --spatial-index/u);
    expect(() => parseIfcCompileArguments([...base, "--spatial-payload-order"])).toThrow(
      /--spatial-payload-order requires --spatial-index/u,
    );
  });

  it("accepts the spatial flags together", () => {
    const parsed = parseIfcCompileArguments([
      "--document",
      "a=a.ifc",
      "--output",
      "out",
      "--spatial-index",
      "--spatial-leaf-capacity",
      "64",
      "--spatial-payload-order",
    ]);
    expect(parsed.spatialIndex).toBe(true);
    expect(parsed.spatialLeafCapacity).toBe(64);
    expect(parsed.spatialPayloadOrder).toBe(true);
  });
});
