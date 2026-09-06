import { describe, expect, it } from "vitest";

import {
  attachmentPairByteLength,
  decodeObjectId,
  decodeSurfacePoint,
  instanceStride,
  packInstanceData,
  packInstanceDataInto,
  splitFloat64,
  validateGpuScene,
  validatePrototypeBatch,
} from "../src/index.js";
import type { GpuPrototypeBatch } from "../src/index.js";

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function createBatch(): GpuPrototypeBatch {
  return {
    surfaceVertices: new Float32Array([
      0, 0, 0, 0, 0, 1,
      1, 0, 0, 0, 0, 1,
      0, 1, 0, 0, 0, 1,
    ]),
    surfaceIndices: new Uint32Array([0, 1, 2]),
    edgeVertices: new Float32Array([0, 0, 0, 1, 0, 0]),
    instances: [
      {
        transform: identity,
        objectId: 0x0403_0201,
        baseColor: [0.25, 0.5, 0.75, 1],
      },
      { transform: identity, objectId: 9 },
    ],
  };
}

describe("WebGPU packed layouts", () => {
  it("packs transforms once per occurrence with a uint32 object ID", () => {
    const packed = packInstanceData(createBatch().instances);
    const view = new DataView(packed);

    expect(packed.byteLength).toBe(instanceStride * 2);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getUint32(64, true)).toBe(0x0403_0201);
    expect(view.getFloat32(80, true)).toBe(0.25);
    expect(view.getFloat32(84, true)).toBe(0.5);
    expect(view.getFloat32(88, true)).toBe(0.75);
    expect(view.getFloat32(92, true)).toBe(1);
    expect(view.getUint32(instanceStride + 64, true)).toBe(9);
    expect(view.getFloat32(instanceStride + 80, true)).toBeCloseTo(0.16);
  });

  it("stores a large translation as high/low f32 without growing the instance record", () => {
    const translation = 10_000_000.000_25;
    const transform = Float64Array.from(identity);
    transform[12] = translation;
    const packed = packInstanceData([{ transform, objectId: 1 }]);
    const view = new DataView(packed);
    const high = view.getFloat32(48, true);
    const low = view.getFloat32(68, true);

    expect(packed.byteLength).toBe(96);
    expect(high).toBe(10_000_000);
    expect(Math.abs(high + low - translation)).toBeLessThan(1e-10);
    expect(splitFloat64(translation)).toEqual([high, low]);
  });

  it("packs a dense visibility index table into reusable storage", () => {
    const instances = createBatch().instances;
    const target = new ArrayBuffer(instances.length * 96);
    const bytes = packInstanceDataInto(instances, new DataView(target), new Int32Array([0]), 1);
    expect(bytes).toBe(96);
    expect(new DataView(target).getUint32(64, true)).toBe(instances[0]?.objectId);
  });

  it("decodes the picking color without signed overflow", () => {
    expect(decodeObjectId([1, 2, 3, 4])).toBe(0x0403_0201);
    expect(decodeObjectId([255, 255, 255, 255])).toBe(0xffff_ffff);
  });

  it("decodes a surface-point texel against the camera origin in float64", () => {
    const origin = [10_000_000, -2_500_000.5, 0.25];
    expect(decodeSurfacePoint([1.5, -0.25, 3, 1], origin)).toEqual([10_000_001.5, -2_500_000.75, 3.25]);
    expect(decodeSurfacePoint([0, 0, 0, 1], origin)).toEqual(origin);
  });

  it("reports background where the surface-point marker is clear", () => {
    expect(decodeSurfacePoint([0, 0, 0, 0], [0, 0, 0])).toBeNull();
    expect(decodeSurfacePoint([4, 5, 6, 0.5], [0, 0, 0])).toBeNull();
    expect(decodeSurfacePoint([Number.NaN, 0, 0, 1], [0, 0, 0])).toBeNull();
    expect(() => decodeSurfacePoint([0, 0, 0], [0, 0, 0])).toThrow(RangeError);
    expect(() => decodeSurfacePoint([0, 0, 0, 1], [0, 0])).toThrow(RangeError);
  });

  it("rejects duplicate occurrence IDs", () => {
    const batch = createBatch();
    expect(() =>
      validatePrototypeBatch({
        ...batch,
        instances: [
          { transform: identity, objectId: 7 },
          { transform: identity, objectId: 7 },
        ],
      }),
    ).toThrow(/Duplicate occurrence object ID/u);
  });

  it("rejects duplicate object IDs across prototype batches", () => {
    const batch = createBatch();
    expect(() =>
      validateGpuScene({
        batches: [
          batch,
          {
            ...batch,
            instances: [{ transform: identity, objectId: 9 }],
          },
        ],
      }),
    ).toThrow(/Duplicate scene object ID/u);
  });

  it("allows one logical object to span declared material batches", () => {
    const batch = createBatch();
    expect(() =>
      validateGpuScene({
        batches: [
          batch,
          {
            ...batch,
            instances: [{ transform: identity, objectId: 9 }],
          },
        ],
        sharedObjectIdsAcrossBatches: true,
      }),
    ).not.toThrow();
  });
});

describe("attachment pair byte length", () => {
  it("charges four bytes per pixel for each of the two attachments", () => {
    expect(attachmentPairByteLength(1_320, 1_000)).toBe(1_320 * 1_000 * 8);
  });

  it("reports nothing before a render target has been sized", () => {
    expect(attachmentPairByteLength(0, 0)).toBe(0);
    expect(attachmentPairByteLength(1_320, 0)).toBe(0);
    expect(attachmentPairByteLength(-1, 1_000)).toBe(0);
  });

  it("refuses a fractional pixel size rather than reporting a fractional byte", () => {
    expect(() => attachmentPairByteLength(1_320.5, 1_000)).toThrow(RangeError);
  });
});
