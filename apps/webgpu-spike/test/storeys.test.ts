import { describe, expect, it } from "vitest";
import type { GpuScene } from "@naru3d/runtime-webgpu";
import {
  collectBuildingStoreys,
  frameBuildingStoreys,
  isBuildingStoreyPrototype,
  objectBoundsByObjectId,
} from "../src/storeys.js";

const storey = "prototype:ifc:architecture-19d7d02d53c2:non-geometric:ifcbuildingstorey";
const site = "prototype:ifc:architecture-19d7d02d53c2:non-geometric:ifcsite";
const wall = "prototype:ifc:architecture-19d7d02d53c2:mesh:0001";

const entries = [
  { nodeIndex: 0, name: "Architecture", depth: 0, prototypeId: site },
  { nodeIndex: 1, name: " Ground ", depth: 1, prototypeId: storey },
  { nodeIndex: 2, name: "Wall A", depth: 2, prototypeId: wall },
  { nodeIndex: 3, name: "Wall B", depth: 2, prototypeId: wall },
  { nodeIndex: 4, name: "Roof", depth: 1, prototypeId: storey },
  { nodeIndex: 5, name: "Slab", depth: 2, prototypeId: wall },
  { nodeIndex: 6, name: "Structure", depth: 0, prototypeId: site },
  { nodeIndex: 7, name: "Ground", depth: 1, prototypeId: storey },
  { nodeIndex: 8, name: "Column", depth: 2, prototypeId: wall },
  { nodeIndex: 9, name: "Empty", depth: 1, prototypeId: storey },
];
const objects = [
  { nodeIndex: 2, objectId: 10 },
  { nodeIndex: 3, objectId: 11 },
  { nodeIndex: 5, objectId: 12 },
  { nodeIndex: 8, objectId: 13 },
];

function translated(objectId: number, x: number, y: number, z: number) {
  return { objectId, transform: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]) };
}

// A unit cube's corner positions, interleaved with a normal, as the coarse batch stores them.
const cube = new Float32Array([-0.5, -0.5, -0.5, 0, 1, 0, 0.5, 0.5, 0.5, 0, 1, 0]);

describe("isBuildingStoreyPrototype", () => {
  it("matches the IFC adapter's storey prototype ids case-insensitively", () => {
    expect(isBuildingStoreyPrototype(storey)).toBe(true);
    expect(isBuildingStoreyPrototype(storey.toUpperCase())).toBe(true);
    expect(isBuildingStoreyPrototype(site)).toBe(false);
    expect(isBuildingStoreyPrototype("prototype:step:mesh:0")).toBe(false);
  });
});

describe("collectBuildingStoreys", () => {
  it("merges storeys by trimmed name across documents and drops empty ones", () => {
    const storeys = collectBuildingStoreys(entries, objects);
    expect(storeys.map((entry) => entry.key)).toEqual(["Ground", "Roof"]);
    expect(storeys[0]).toEqual({
      key: "Ground",
      name: "Ground",
      nodeIndexes: [1, 7],
      objectIds: [10, 11, 13],
    });
    expect(storeys[1]?.objectIds).toEqual([12]);
  });

  it("returns nothing for a hierarchy without storeys", () => {
    expect(collectBuildingStoreys([entries[0]!, entries[2]!], objects)).toEqual([]);
  });
});

describe("objectBoundsByObjectId", () => {
  it("places each batch's local bounds through every instance and unions per object", () => {
    const scene: GpuScene = {
      batches: [
        {
          surfaceVertices: cube,
          surfaceIndices: new Uint32Array(),
          edgeVertices: new Float32Array(),
          instances: [translated(10, 0, 0, 0), translated(10, 4, 0, 0), translated(11, 0, 3, 0)],
        },
        {
          surfaceVertices: new Float32Array(),
          surfaceIndices: new Uint32Array(),
          edgeVertices: new Float32Array([0, 0, 0, 2, 0, 0]),
          instances: [translated(12, 0, 9, 0)],
        },
      ],
    };
    const bounds = objectBoundsByObjectId(scene);
    expect(bounds.get(10)).toEqual({ min: [-0.5, -0.5, -0.5], max: [4.5, 0.5, 0.5] });
    expect(bounds.get(11)).toEqual({ min: [-0.5, 2.5, -0.5], max: [0.5, 3.5, 0.5] });
    expect(bounds.get(12)).toEqual({ min: [0, 9, 0], max: [2, 9, 0] });
  });
});

describe("frameBuildingStoreys", () => {
  it("unions member bounds and orders storeys from the lowest elevation upward", () => {
    const bounds = new Map([
      [10, { min: [0, 0, 0] as const, max: [1, 1, 1] as const }],
      [11, { min: [5, 0, 5] as const, max: [6, 1, 6] as const }],
      [12, { min: [0, 6, 0] as const, max: [6, 7, 6] as const }],
    ]);
    const framed = frameBuildingStoreys(
      [
        { key: "Roof", name: "Roof", nodeIndexes: [4], objectIds: [12] },
        { key: "Ground", name: "Ground", nodeIndexes: [1, 7], objectIds: [10, 11, 13] },
        { key: "Unplaced", name: "Unplaced", nodeIndexes: [20], objectIds: [99] },
      ],
      bounds,
    );
    expect(framed.map((entry) => entry.key)).toEqual(["Ground", "Roof", "Unplaced"]);
    expect(framed[0]?.bounds).toEqual({ min: [0, 0, 0], max: [6, 1, 6] });
    expect(framed[2]?.bounds).toBeUndefined();
  });
});
