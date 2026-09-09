import { beforeAll, describe, expect, it } from "vitest";

import { createRepeatedTriangleScene, edgeClassCode, ids } from "@naru3d/scene-ir";
import type {
  EngineeringScene,
  Representation,
  SourceReference,
  SourceRefId,
} from "@naru3d/scene-ir";

import { compileSceneToGltf, progressivePackageSchema } from "../src/index.js";
import {
  buildReducedRepresentation,
  isReducedLodPrepared,
  prepareReducedLod,
  reducedLodProtocol,
} from "../src/lod/reduce.js";

const cubeHalf = 0.5;
const gridSize = 4;

/**
 * Six faces of a unit cube, each an N x N grid of triangles, with the twelve
 * cube edges declared as explicit boundary edges. The unlocked whole-shape
 * arm can collapse every planar face without leaving the plane, so the
 * outcome is a strict reduction with zero measured deviation.
 */
function subdividedCubeScene(): EngineeringScene {
  const base = createRepeatedTriangleScene();
  const document = base.documents[0]!;
  const prototype = base.prototypes[0]!;
  const original = base.representations[0]!;
  const faceRefs = Array.from({ length: 6 }, (_, index) =>
    ids.sourceRef(`source:face:cube:${index}`),
  );
  const edgeRefs = Array.from({ length: 12 }, (_, index) =>
    ids.sourceRef(`source:edge:cube:${index}`),
  );
  const sourceRefs: SourceReference[] = [
    ...document.sourceRefs.filter((ref) => ref.kind === "part"),
    ...faceRefs.map((id, index) => ({
      id,
      documentId: document.id,
      namespace: "generated",
      value: `cube-face-${index}`,
      kind: "face" as const,
      stability: "revision-local" as const,
    })),
    ...edgeRefs.map((id, index) => ({
      id,
      documentId: document.id,
      namespace: "generated",
      value: `cube-edge-${index}`,
      kind: "edge" as const,
      stability: "revision-local" as const,
    })),
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceSourceIds: number[] = [];
  const faces: readonly (readonly [number[], number[], number[]])[] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  faces.forEach(([normal, u, v], faceIndex) => {
    const firstVertex = positions.length / 3;
    for (let row = 0; row <= gridSize; row += 1) {
      for (let column = 0; column <= gridSize; column += 1) {
        const s = (column / gridSize) * 2 - 1;
        const t = (row / gridSize) * 2 - 1;
        for (let axis = 0; axis < 3; axis += 1) {
          positions.push(
            cubeHalf * (normal[axis]! + s * u[axis]! + t * v[axis]!),
          );
          normals.push(normal[axis]!);
        }
      }
    }
    for (let row = 0; row < gridSize; row += 1) {
      for (let column = 0; column < gridSize; column += 1) {
        const a = firstVertex + row * (gridSize + 1) + column;
        const b = a + 1;
        const c = a + gridSize + 1;
        const d = c + 1;
        indices.push(a, b, d, a, d, c);
        faceSourceIds.push(faceIndex, faceIndex);
      }
    }
  });

  const corners = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ].map((corner) => corner.map((value) => value * cubeHalf));
  const cubeEdges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  const representation: Representation = {
    ...original,
    surface: {
      primitive: "triangles",
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      normals: new Float32Array(normals),
      faceSourceIds: new Uint32Array(faceSourceIds),
      materialGroups: [
        { firstIndex: 0, indexCount: indices.length, materialId: prototype.defaultMaterialId! },
      ],
    },
    edges: {
      positions: new Float32Array(corners.flat()),
      segments: new Uint32Array(cubeEdges.flat()),
      classes: new Uint8Array(cubeEdges.map(() => edgeClassCode.boundary)),
      sourceIds: new Uint32Array(cubeEdges.map((_, index) => 6 + index)),
    },
    bounds: { min: [-cubeHalf, -cubeHalf, -cubeHalf], max: [cubeHalf, cubeHalf, cubeHalf] },
    sourceMap: {
      sourceRefs: [...faceRefs, ...edgeRefs] as SourceRefId[],
      faceSourceIndices: Uint32Array.from(faceRefs, (_, index) => index),
      edgeSourceIndices: Uint32Array.from(edgeRefs, (_, index) => 6 + index),
    },
  };

  return {
    ...base,
    documents: [{ ...document, sourceRefs }],
    prototypes: [
      { ...prototype, localBounds: representation.bounds },
    ],
    representations: [representation],
  };
}

const deviation = 0.001;

describe("reduced LOD level", () => {
  beforeAll(async () => {
    await prepareReducedLod();
    expect(isReducedLodPrepared()).toBe(true);
  });

  it("reduces a subdivided cube in place, carries identity and edges verbatim", () => {
    const scene = subdividedCubeScene();
    const representation = scene.representations[0]!;
    const outcome = buildReducedRepresentation(representation, deviation, 1);
    expect(outcome.outcome).toBe("reduced");
    if (outcome.outcome !== "reduced") return;

    const { report, representation: reduced } = outcome;
    expect(report.method).toBe(reducedLodProtocol.method);
    expect(report.inputTriangles).toBe(6 * gridSize * gridSize * 2);
    expect(report.outputTriangles).toBeLessThan(report.inputTriangles);
    expect(report.checks.every((check) => check.pass)).toBe(true);
    expect(report.identityAmbiguous).toBe(0);
    expect(report.identityOrphan).toBe(0);

    expect(reduced.id).toBe(`${representation.id}#reduced`);
    expect(reduced.accuracy.kind).toBe("simplified");
    expect(reduced.accuracy.notes).toContain(`method=${reducedLodProtocol.method}`);
    expect(reduced.edges).toBe(representation.edges);
    expect(reduced.surface!.indices.length).toBe(report.outputTriangles * 3);
    expect(reduced.surface!.faceSourceIds!.length).toBe(report.outputTriangles);
    expect(new Set(reduced.surface!.faceSourceIds)).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(reduced.surface!.materialGroups).toEqual([
      { firstIndex: 0, indexCount: report.outputTriangles * 3, materialId: representation.surface!.materialGroups![0]!.materialId },
    ]);

    const again = buildReducedRepresentation(representation, deviation, 1);
    expect(again.outcome).toBe("reduced");
    if (again.outcome === "reduced") {
      expect(again.representation.surface!.indices).toEqual(reduced.surface!.indices);
      expect(again.representation.surface!.positions).toEqual(reduced.surface!.positions);
    }
  });

  it("retains unsupported topology with a named reason", () => {
    const scene = subdividedCubeScene();
    const cube = scene.representations[0]!;
    const withoutFaceIds: Representation = {
      ...cube,
      surface: { ...cube.surface!, faceSourceIds: undefined },
    };
    expect(buildReducedRepresentation(withoutFaceIds, deviation, 1)).toMatchObject({
      outcome: "retained",
      reason: "no-face-source-ids",
    });
    const withoutEdges: Representation = { ...cube, edges: undefined };
    expect(buildReducedRepresentation(withoutEdges, deviation, 1)).toMatchObject({
      outcome: "retained",
      reason: "no-explicit-edges",
    });
    const groups = cube.surface!.materialGroups![0]!;
    const twoGroups: Representation = {
      ...cube,
      surface: {
        ...cube.surface!,
        materialGroups: [
          { ...groups, indexCount: 3 },
          { ...groups, firstIndex: 3, indexCount: groups.indexCount - 3 },
        ],
      },
    };
    expect(buildReducedRepresentation(twoGroups, deviation, 1)).toMatchObject({
      outcome: "retained",
      reason: "multiple-material-groups",
    });
    const triangle = createRepeatedTriangleScene().representations[0]!;
    const single = buildReducedRepresentation(triangle, deviation, 1);
    expect(single.outcome).toBe("retained");
    if (single.outcome === "retained") {
      expect(single.reason).toBe("no-reduction");
      expect(single.report?.inputTriangles).toBe(1);
    }
  });

  it("packages a reduced level under naru.progressive-package.1 deterministically", () => {
    const options = {
      coarseBounds: true,
      reducedLod: { maxDeviationMeters: deviation },
    };
    const first = compileSceneToGltf(subdividedCubeScene(), options);
    const second = compileSceneToGltf(subdividedCubeScene(), options);
    expect(first.report.output.packageDigest).toBe(second.report.output.packageDigest);
    expect(first.json.text()).toBe(second.json.text());

    const document = JSON.parse(first.json.text()) as {
      extras: { naru?: { progressive?: Record<string, unknown> }; madi?: Record<string, unknown> };
      nodes: { extras?: { madi?: { coarseMesh?: number; reducedMesh?: number } } }[];
    };
    const progressive = document.extras.naru?.progressive;
    expect(progressive).toBeDefined();
    expect(document.extras.madi?.progressive).toBeUndefined();
    expect(progressive).toMatchObject({
      schemaVersion: progressivePackageSchema,
      strategy: "prototype-aabb-reduced-v1",
      targetBuffer: 0,
      coarseBuffer: 1,
      reducedLod: { method: reducedLodProtocol.method, maxDeviationMeters: deviation },
    });
    const targetChunks = progressive!.targetChunks as { id: string; byteOffset: number; byteLength: number }[];
    const reducedChunks = progressive!.reducedChunks as { id: string; byteOffset: number; byteLength: number }[];
    expect(targetChunks.map((chunk) => chunk.id)).toEqual(["target:0000:prototype:triangle"]);
    expect(reducedChunks.map((chunk) => chunk.id)).toEqual(["reduced:0000:prototype:triangle"]);
    expect(reducedChunks[0]!.byteOffset).toBeGreaterThanOrEqual(
      targetChunks[0]!.byteOffset + targetChunks[0]!.byteLength,
    );
    expect(reducedChunks[0]!.byteLength).toBeLessThan(targetChunks[0]!.byteLength);

    const meshNodes = document.nodes.filter((node) => node.extras?.madi?.coarseMesh !== undefined);
    expect(meshNodes).toHaveLength(2);
    for (const node of meshNodes) {
      expect(typeof node.extras!.madi!.reducedMesh).toBe("number");
      expect(node.extras!.madi!.reducedMesh).not.toBe(node.extras!.madi!.coarseMesh);
    }

    expect(first.report.options.progressiveRepresentation).toBe("prototype-aabb-reduced-v1");
    expect(first.report.options.reducedLod).toEqual({ method: reducedLodProtocol.method, maxDeviationMeters: deviation });
    expect(first.report.reducedLod).toHaveLength(1);
    expect(first.report.reducedLod![0]).toMatchObject({
      prototypeId: "prototype:triangle",
      outcome: "reduced",
      inputTriangles: 6 * gridSize * gridSize * 2,
    });
    expect(first.report.counts.reducedChunkCount).toBe(1);
    expect(first.report.counts.reducedPrototypeCount).toBe(1);
    expect(first.report.counts.reducedTriangleCount).toBe(first.report.reducedLod![0]!.outputTriangles);
  });

  it("keeps the legacy extras.madi.progressive block when no reduced level is requested", () => {
    const compiled = compileSceneToGltf(subdividedCubeScene(), {
      coarseBounds: true,
    });
    const document = JSON.parse(compiled.json.text()) as {
      extras: { naru?: Record<string, unknown>; madi: { progressive: { strategy: string } } };
    };
    expect(document.extras.naru?.progressive).toBeUndefined();
    expect(document.extras.madi.progressive.strategy).toBe("prototype-aabb-v1");
    expect(compiled.report.options.progressiveRepresentation).toBe("prototype-aabb-v1");
    expect(compiled.report.options.reducedLod).toBeUndefined();
  });
});
