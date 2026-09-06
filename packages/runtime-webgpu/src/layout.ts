export interface GpuOccurrenceInstance {
  /** Column-major local-to-world transform; decoded glTF scenes retain f64 translations. */
  readonly transform: Float32Array | Float64Array;
  /** Zero is reserved for the picking background. */
  readonly objectId: number;
  /** Linear RGBA display color for this occurrence. */
  readonly baseColor?: readonly [number, number, number, number];
}

export interface GpuPrototypeBatch {
  /** Interleaved position.xyz + normal.xyz values. */
  readonly surfaceVertices: Float32Array;
  readonly surfaceIndices: Uint32Array;
  /** Non-indexed line-list position.xyz values. */
  readonly edgeVertices: Float32Array;
  /** Instances share the prototype's surface and edge buffers. */
  readonly instances: readonly GpuOccurrenceInstance[];
}

export interface GpuScene {
  /** One immutable geometry batch per renderable prototype. */
  readonly batches: readonly GpuPrototypeBatch[];
  /** One logical object may span material-separated prototype batches. */
  readonly sharedObjectIdsAcrossBatches?: boolean;
}

export const instanceStride = 96;

/** Decoded payload and GPU allocation one batch contributes to a residency set. */
export interface ResidencyCost {
  readonly decodedBytes: number;
  readonly gpuBytes: number;
}

/** Batch payload sizes, which accessor counts already determine before a decode. */
export interface BatchResidencyShape {
  readonly surfaceVertexBytes: number;
  readonly surfaceIndexBytes: number;
  readonly edgeVertexBytes: number;
  readonly instanceCount: number;
  /**
   * True when a batch decoded earlier already charges these vertices. Material
   * groups of one prototype share its vertex pool, so only the batch that owns
   * the pool pays for it -- and the renderer allocates no second buffer, so a
   * sharing batch adds nothing, not even an empty buffer's four bytes.
   */
  readonly sharesSurfaceVertices?: boolean;
}

/** WebGPU allocates whole four-byte buffers, and never an empty one. */
export function alignedBufferByteLength(byteLength: number): number {
  return Math.max(4, Math.ceil(byteLength / 4) * 4);
}

/**
 * Bytes a render target of this size occupies, for the two attachments the
 * renderer always allocates together: a `depth24plus` depth buffer and an
 * `rgba8uint` object-id buffer, both one sample and one mip.
 *
 * `depth24plus` is implementation-defined -- a driver may store 24 or 32 bits
 * -- so the wider layout is charged. The result is therefore an upper bound on
 * the attachment pair, not a driver-exact figure, and any record that reports
 * it has to say so.
 */
export function attachmentPairByteLength(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new RangeError("Attachment size must be given in whole pixels.");
  }
  if (width <= 0 || height <= 0) return 0;
  const pixels = width * height;
  return pixels * 4 + pixels * 4;
}

/**
 * The one residency cost formula. A scheduler charges it from accessor counts
 * before a chunk is fetched and a residency set charges it from the decoded
 * arrays afterwards; the two must agree exactly, or a pre-fetch admission gate
 * would refuse chunks the budget would have taken.
 */
export function batchResidencyCost(shape: BatchResidencyShape): ResidencyCost {
  const instanceBytes = shape.instanceCount * instanceStride;
  const shared = shape.sharesSurfaceVertices === true;
  return {
    decodedBytes:
      (shared ? 0 : shape.surfaceVertexBytes) +
      shape.surfaceIndexBytes +
      shape.edgeVertexBytes +
      instanceBytes,
    gpuBytes:
      (shared ? 0 : alignedBufferByteLength(shape.surfaceVertexBytes)) +
      alignedBufferByteLength(shape.surfaceIndexBytes) +
      alignedBufferByteLength(shape.edgeVertexBytes) +
      alignedBufferByteLength(instanceBytes),
  };
}

export function addResidencyCost(total: ResidencyCost, cost: ResidencyCost): ResidencyCost {
  return {
    decodedBytes: total.decodedBytes + cost.decodedBytes,
    gpuBytes: total.gpuBytes + cost.gpuBytes,
  };
}

/** Splits one finite f64 value into two f32 values whose sum retains its residual. */
export function splitFloat64(value: number): readonly [high: number, low: number] {
  if (!Number.isFinite(value)) throw new TypeError("Split values must be finite.");
  const high = Math.fround(value);
  return [high, Math.fround(value - high)];
}

export function validatePrototypeBatch(batch: GpuPrototypeBatch): void {
  if (batch.surfaceVertices.length % 6 !== 0) {
    throw new TypeError("surfaceVertices must use position.xyz + normal.xyz records.");
  }
  if (batch.surfaceIndices.length % 3 !== 0) {
    throw new TypeError("surfaceIndices must contain triangle triplets.");
  }
  if (batch.edgeVertices.length % 6 !== 0) {
    throw new TypeError("edgeVertices must contain line-list vertex pairs.");
  }

  const vertexCount = batch.surfaceVertices.length / 6;
  for (const index of batch.surfaceIndices) {
    if (index >= vertexCount) {
      throw new RangeError(`Surface vertex index ${index} exceeds ${vertexCount}.`);
    }
  }

  const objectIds = new Set<number>();
  for (const instance of batch.instances) {
    if (
      instance.transform.length !== 16 ||
      instance.transform.some((value) => !Number.isFinite(value))
    ) {
      throw new TypeError("Each occurrence transform must contain 16 finite values.");
    }
    if (!Number.isInteger(instance.objectId) || instance.objectId <= 0) {
      throw new RangeError("Occurrence object IDs must be positive uint32 values.");
    }
    if (instance.objectId > 0xffff_ffff) {
      throw new RangeError("Occurrence object IDs must fit in uint32.");
    }
    if (objectIds.has(instance.objectId)) {
      throw new RangeError(`Duplicate occurrence object ID ${instance.objectId}.`);
    }
    if (
      instance.baseColor &&
      (instance.baseColor.length !== 4 ||
        instance.baseColor.some((value) => !Number.isFinite(value)))
    ) {
      throw new TypeError("Occurrence base colors must contain four finite values.");
    }
    objectIds.add(instance.objectId);
  }
}

export function validateGpuScene(scene: GpuScene): void {
  if (scene.batches.length === 0) {
    throw new TypeError("A GPU scene must contain at least one prototype batch.");
  }

  const objectIds = new Set<number>();
  for (const batch of scene.batches) {
    validatePrototypeBatch(batch);
    for (const instance of batch.instances) {
      if (!scene.sharedObjectIdsAcrossBatches && objectIds.has(instance.objectId)) {
        throw new RangeError(`Duplicate scene object ID ${instance.objectId}.`);
      }
      objectIds.add(instance.objectId);
    }
  }
}

export function packInstanceData(
  instances: readonly GpuOccurrenceInstance[],
): ArrayBuffer {
  const data = new ArrayBuffer(instances.length * instanceStride);
  packInstanceDataInto(instances, new DataView(data));
  return data;
}

/** Packs either all instances or a dense index table into reusable storage. */
export function packInstanceDataInto(
  instances: readonly GpuOccurrenceInstance[],
  target: DataView,
  sourceIndices?: ArrayLike<number>,
  sourceCount = sourceIndices?.length ?? instances.length,
): number {
  if (!Number.isInteger(sourceCount) || sourceCount < 0) {
    throw new RangeError("sourceCount must be a non-negative integer.");
  }
  if (sourceIndices && sourceCount > sourceIndices.length) {
    throw new RangeError("sourceCount exceeds the source index table.");
  }
  if (sourceCount * instanceStride > target.byteLength) {
    throw new RangeError("The target view is too small for the packed instances.");
  }

  for (let outputIndex = 0; outputIndex < sourceCount; outputIndex += 1) {
    const sourceIndex = sourceIndices?.[outputIndex] ?? outputIndex;
    const instance = instances[sourceIndex];
    if (!instance) throw new RangeError(`Instance index ${sourceIndex} is out of range.`);
    const base = outputIndex * instanceStride;
    instance.transform.forEach((value, matrixIndex) => {
      const [high] = matrixIndex >= 12 && matrixIndex <= 14
        ? splitFloat64(value)
        : [Math.fround(value)];
      target.setFloat32(base + matrixIndex * 4, high, true);
    });
    target.setUint32(base + 64, instance.objectId, true);
    for (let axis = 0; axis < 3; axis += 1) {
      const [, low] = splitFloat64(instance.transform[12 + axis] ?? 0);
      // Reuse the instance record's existing 12-byte alignment gap.
      target.setFloat32(base + 68 + axis * 4, low, true);
    }
    const color = instance.baseColor ?? [0.16, 0.55, 0.92, 1.0];
    color.forEach((value, channel) => {
      target.setFloat32(base + 80 + channel * 4, value, true);
    });
  }

  return sourceCount * instanceStride;
}

export function decodeObjectId(pixel: ArrayLike<number>): number {
  const r = pixel[0] ?? 0;
  const g = pixel[1] ?? 0;
  const b = pixel[2] ?? 0;
  const a = pixel[3] ?? 0;
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
}

/**
 * Decodes one texel of the surface-point attachment the renderer writes during
 * `pickPoint`: xyz hold the camera-relative f32 position, w is 1 where a
 * surface fragment survived depth and section tests and 0 (the clear value)
 * where only background was hit. The camera origin is added back in JavaScript
 * numbers so the result carries ADR-0005 precision, not f32 precision.
 */
export function decodeSurfacePoint(
  texel: ArrayLike<number>,
  cameraOrigin: ArrayLike<number>,
): readonly [number, number, number] | null {
  if (texel.length < 4) throw new RangeError("A surface-point texel has four channels.");
  if (cameraOrigin.length < 3) throw new RangeError("A camera origin has three components.");
  if ((texel[3] ?? 0) !== 1) return null;
  const point: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const value = (cameraOrigin[axis] ?? 0) + (texel[axis] ?? 0);
    if (!Number.isFinite(value)) return null;
    point[axis] = value;
  }
  return point;
}
