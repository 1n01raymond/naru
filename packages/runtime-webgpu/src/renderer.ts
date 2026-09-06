import {
  alignedBufferByteLength,
  attachmentPairByteLength,
  decodeObjectId,
  instanceStride,
  packInstanceData,
  packInstanceDataInto,
  splitFloat64,
  validateGpuScene,
  validatePrototypeBatch,
} from "./layout.js";
import type { GpuOccurrenceInstance, GpuPrototypeBatch, GpuScene } from "./layout.js";
import type { GeometryRepresentation } from "./compiled-gltf.js";

/**
 * Default clip-space depth offset applied to fallback batches: 2^-16 of the
 * depth range. With the Studio's orthographic projection the depth range is
 * the padded scene extent, so this is about 1.8 mm on a 116 m scene and 256
 * quanta of a 24-bit depth buffer -- far above the float32 disagreement
 * between a prototype AABB face and the target surface it encloses, and far
 * below anything a bounding-box proxy is expected to resolve.
 */
export const defaultFallbackDepthOffset = 1 / 65536;

/**
 * Validate the fallback depth offset option. The offset is a fraction of
 * clip-space depth: zero disables the fallback pipelines, and one would push
 * every proxy behind the far plane.
 */
export function resolveFallbackDepthOffset(value: number | undefined): number {
  if (value === undefined) return defaultFallbackDepthOffset;
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("fallbackDepthOffset must be a finite number in [0, 1).");
  }
  return value;
}

const surfaceShader = /* wgsl */ `
// Clip-space depth pushed onto fallback (coarse proxy) batches so that target
// detail sharing a plane with a proxy wins the depth test deterministically.
// Pipeline-overridable; the default pipeline pair leaves it at zero.
override fallbackDepthOffset: f32 = 0.0;

struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraOriginHigh: vec4<f32>,
  cameraOriginLow: vec4<f32>,
  sectionPlane: vec4<f32>,
  selectedObjectId: u32,
  sectionEnabled: u32,
  padding0: u32,
  padding1: u32,
};

@group(0) @binding(0) var<uniform> scene: SceneUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) model0: vec4<f32>,
  @location(3) model1: vec4<f32>,
  @location(4) model2: vec4<f32>,
  @location(5) model3: vec4<f32>,
  @location(6) objectId: u32,
  @location(7) baseColor: vec4<f32>,
  @location(8) translationLow: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) @interpolate(flat) objectId: u32,
  @location(2) @interpolate(flat) baseColor: vec4<f32>,
  @location(3) worldPosition: vec3<f32>,
};

@vertex
fn vsMain(input: VertexInput) -> VertexOutput {
  let linear = mat3x3<f32>(input.model0.xyz, input.model1.xyz, input.model2.xyz);
  // Matching high words cancel exactly; preserve the low-word residual directly.
  let highTranslation = select(
    vec3<f32>(0.0),
    input.model3.xyz - scene.cameraOriginHigh.xyz,
    input.model3.xyz != scene.cameraOriginHigh.xyz,
  );
  let relativeTranslation =
    highTranslation + (input.translationLow - scene.cameraOriginLow.xyz);
  let worldPosition = linear * input.position + relativeTranslation;
  var output: VertexOutput;
  output.position = scene.viewProjection * vec4<f32>(worldPosition, 1.0);
  output.position.z += fallbackDepthOffset * output.position.w;
  output.normal = normalize(linear * input.normal);
  output.objectId = input.objectId;
  output.baseColor = input.baseColor;
  output.worldPosition = worldPosition;
  return output;
}

fn clipBySectionPlane(worldPosition: vec3<f32>) {
  if (scene.sectionEnabled != 0u && dot(scene.sectionPlane.xyz, worldPosition) > scene.sectionPlane.w) {
    discard;
  }
}

@fragment
fn fsSurface(input: VertexOutput) -> @location(0) vec4<f32> {
  clipBySectionPlane(input.worldPosition);
  let light = 0.35 + 0.65 * max(dot(normalize(input.normal), normalize(vec3<f32>(0.3, 0.5, 1.0))), 0.0);
  let shaded = input.baseColor.rgb * light;
  let selected = scene.selectedObjectId != 0u && input.objectId == scene.selectedObjectId;
  let color = select(shaded, mix(shaded, vec3<f32>(0.05, 0.72, 1.0), 0.68), selected);
  return vec4<f32>(color, input.baseColor.a);
}

@fragment
fn fsPick(input: VertexOutput) -> @location(0) vec4<u32> {
  clipBySectionPlane(input.worldPosition);
  let id = input.objectId;
  return vec4<u32>(id & 255u, (id >> 8u) & 255u, (id >> 16u) & 255u, (id >> 24u) & 255u);
}
`;

const edgeShader = /* wgsl */ `
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraOriginHigh: vec4<f32>,
  cameraOriginLow: vec4<f32>,
  sectionPlane: vec4<f32>,
  selectedObjectId: u32,
  sectionEnabled: u32,
  padding0: u32,
  padding1: u32,
};

@group(0) @binding(0) var<uniform> scene: SceneUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(2) model0: vec4<f32>,
  @location(3) model1: vec4<f32>,
  @location(4) model2: vec4<f32>,
  @location(5) model3: vec4<f32>,
  @location(6) objectId: u32,
  @location(7) baseColor: vec4<f32>,
  @location(8) translationLow: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) objectId: u32,
  @location(1) worldPosition: vec3<f32>,
};

@vertex
fn vsMain(input: VertexInput) -> VertexOutput {
  let linear = mat3x3<f32>(input.model0.xyz, input.model1.xyz, input.model2.xyz);
  // Matching high words cancel exactly; preserve the low-word residual directly.
  let highTranslation = select(
    vec3<f32>(0.0),
    input.model3.xyz - scene.cameraOriginHigh.xyz,
    input.model3.xyz != scene.cameraOriginHigh.xyz,
  );
  let relativeTranslation =
    highTranslation + (input.translationLow - scene.cameraOriginLow.xyz);
  let worldPosition = linear * input.position + relativeTranslation;
  var output: VertexOutput;
  output.position = scene.viewProjection * vec4<f32>(worldPosition, 1.0);
  output.objectId = input.objectId;
  output.worldPosition = worldPosition;
  return output;
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4<f32> {
  if (scene.sectionEnabled != 0u && dot(scene.sectionPlane.xyz, input.worldPosition) > scene.sectionPlane.w) {
    discard;
  }
  let selected = scene.selectedObjectId != 0u && input.objectId == scene.selectedObjectId;
  let color = select(vec3<f32>(0.015, 0.035, 0.055), vec3<f32>(0.0, 0.45, 0.72), selected);
  return vec4<f32>(color, 1.0);
}
`;

const instanceBufferLayout: GPUVertexBufferLayout = {
  arrayStride: instanceStride,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 2, offset: 0, format: "float32x4" },
    { shaderLocation: 3, offset: 16, format: "float32x4" },
    { shaderLocation: 4, offset: 32, format: "float32x4" },
    { shaderLocation: 5, offset: 48, format: "float32x4" },
    { shaderLocation: 6, offset: 64, format: "uint32" },
    { shaderLocation: 8, offset: 68, format: "float32x3" },
    { shaderLocation: 7, offset: 80, format: "float32x4" },
  ],
};

export type NaruWebGpuErrorCode =
  | "WEBGPU_UNAVAILABLE"
  | "ADAPTER_UNAVAILABLE"
  | "CONTEXT_UNAVAILABLE"
  | "SCENE_NOT_SET"
  | "TIMESTAMP_QUERY_UNSUPPORTED";

export class NaruWebGpuError extends Error {
  readonly code: NaruWebGpuErrorCode;

  constructor(code: NaruWebGpuErrorCode, message: string) {
    super(message);
    this.name = "NaruWebGpuError";
    this.code = code;
  }
}

export interface Phase0RendererOptions {
  readonly onDeviceLost?: (message: string) => void;
  /** Override the browser device pixel ratio for reproducible benchmark profiles. */
  readonly pixelRatio?: number;
  /**
   * Request the WebGPU "timestamp-query" feature when the adapter exposes it.
   * Render passes may then receive caller-owned timestamp writes. Devices
   * without the feature are still created; passing timestamp writes to
   * render() on such a device raises a typed error.
   */
  readonly requestTimestampQueries?: boolean;
  /**
   * Clip-space depth added to every batch reconciled as `representation:
   * "coarse"`, as a fraction of the depth range. Coarse proxies are prototype
   * bounding boxes, so their faces coincide with the target surfaces of other
   * objects (slab tops, floor layers, window plates) and z-fight them until
   * that detail arrives; pushing proxies back by a fixed offset lets resident
   * detail win the depth test. Zero disables the fallback pipelines. Defaults
   * to `defaultFallbackDepthOffset`.
   */
  readonly fallbackDepthOffset?: number;
}

export interface SetSceneOptions {
  /** Upload explicit CAD edge streams. Defaults to true. */
  readonly includeEdges?: boolean;
}

export interface GpuSceneBatchEntry {
  /** Stable application-owned identity used to retain an uploaded batch. */
  readonly key: string;
  readonly batch: GpuPrototypeBatch;
  /**
   * Which representation the batch carries. `"coarse"` batches draw through
   * the fallback pipelines (see `Phase0RendererOptions.fallbackDepthOffset`).
   * Defaults to `"target"`.
   */
  readonly representation?: GeometryRepresentation;
}

export interface ReconcileSceneOptions extends SetSceneOptions {
  /** Allow material-separated batches to retain the same logical occurrence ID. */
  readonly sharedObjectIdsAcrossBatches?: boolean;
}

export interface RenderOptions {
  /** Draw uploaded explicit CAD edge streams. Defaults to true. */
  readonly edges?: boolean;
  /**
   * Attach caller-owned GPU timestamp writes to the surface render pass.
   * Requires a device created with requestTimestampQueries and adapter support.
   */
  readonly timestampWrites?: GPURenderPassTimestampWrites;
  /** Double-precision world origin subtracted before GPU projection. Defaults to zero. */
  readonly cameraOrigin?: readonly [number, number, number];
}

/**
 * Allocation census of renderer-owned resources, split so that each number has
 * one owner and the inclusion relationships between them are stated rather than
 * inferred. Every buffer figure is exact -- WebGPU allocates what was asked for
 * -- while the attachment figure is an upper bound (see
 * `attachmentPairByteLength`).
 */
export interface RendererResourceStats {
  /**
   * Prototype vertex pools, charged once each however many material groups
   * share one. Summing per batch would count the largest sixty5 prototype's
   * pool 111 times.
   */
  readonly gpuVertexPoolBytes: number;
  /** Per-batch index, edge, and instance buffers. Disjoint from the pools. */
  readonly gpuBatchBufferBytes: number;
  /** The single camera uniform buffer, which no batch owns. */
  readonly gpuUniformBytes: number;
  /** The three figures above, and nothing else. */
  readonly gpuBufferBytes: number;
  /**
   * Upper bound on the depth and object-id attachments at the current size.
   * Zero before the first sizing, and excluded from `gpuBufferBytes` because a
   * texture is not a buffer allocation.
   */
  readonly gpuAttachmentBytes: number;
  /** CPU staging memory retained for per-prototype instance re-packing. */
  readonly cpuStagingBytes: number;
  /** Current depth/pick attachment size in pixels, when a frame has rendered. */
  readonly attachmentSizePx: readonly [number, number] | null;
}

/** A world-space half-space that keeps points where dot(normal, position) <= offset. */
export interface SectionPlane {
  readonly normal: readonly [number, number, number];
  readonly offset: number;
}

export interface NormalizedSectionPlane extends SectionPlane {
  readonly normal: readonly [number, number, number];
}

/** Validates and normalizes a section plane without changing its half-space. */
export function normalizeSectionPlane(plane: SectionPlane): NormalizedSectionPlane {
  const [x, y, z] = plane.normal;
  if (![x, y, z, plane.offset].every(Number.isFinite)) {
    throw new TypeError("Section plane values must be finite.");
  }
  const length = Math.hypot(x, y, z);
  if (length <= Number.EPSILON) {
    throw new RangeError("Section plane normal must be non-zero.");
  }
  return {
    normal: [x / length, y / length, z / length],
    offset: plane.offset / length,
  };
}

/** Converts a normalized world-space plane to coordinates relative to one camera origin. */
export function rebaseSectionPlane(
  plane: NormalizedSectionPlane,
  cameraOrigin: ArrayLike<number>,
): NormalizedSectionPlane {
  if (
    cameraOrigin.length !== 3 ||
    Array.from(cameraOrigin).some((value) => !Number.isFinite(value))
  ) {
    throw new TypeError("cameraOrigin must contain three finite values.");
  }
  return {
    normal: plane.normal,
    offset:
      plane.offset -
      plane.normal.reduce(
        (total, value, axis) => total + value * (cameraOrigin[axis] ?? 0),
        0,
      ),
  };
}

/** One vertex buffer, shared by the material groups of a single prototype. */
interface GpuVertexPool {
  readonly buffer: GPUBuffer;
  readonly byteLength: number;
  refCount: number;
}

interface GpuBatchResources {
  readonly key: string;
  readonly source: GpuPrototypeBatch;
  readonly includeEdges: boolean;
  readonly representation: GeometryRepresentation;
  readonly surfaceVertexPool: Float32Array;
  readonly surfaceVertex: GPUBuffer;
  readonly surfaceIndex: GPUBuffer;
  readonly edgeVertex: GPUBuffer;
  readonly instance: GPUBuffer;
  readonly instances: readonly GpuOccurrenceInstance[];
  readonly instanceStaging: ArrayBuffer;
  readonly instanceStagingView: DataView;
  readonly indexCount: number;
  readonly edgeVertexCount: number;
  /** Excludes the shared vertex pool, which `residentGpuBytes` counts once. */
  readonly gpuByteLength: number;
  instanceCount: number;
}

function createBuffer(
  device: GPUDevice,
  label: string,
  source: ArrayBufferView<ArrayBufferLike> | ArrayBuffer,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const byteLength = source.byteLength;
  const buffer = device.createBuffer({
    label,
    size: alignedBufferByteLength(byteLength),
    usage: usage | GPUBufferUsage.COPY_DST,
  });
  if (byteLength > 0) {
    const sourceBytes =
      source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const upload = new Uint8Array(sourceBytes);
    device.queue.writeBuffer(buffer, 0, upload);
  }
  return buffer;
}

export class Phase0Renderer {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly cameraBuffer: GPUBuffer;
  private readonly cameraBindGroup: GPUBindGroup;
  private readonly surfacePipeline: GPURenderPipeline;
  private readonly edgePipeline: GPURenderPipeline;
  private readonly pickPipeline: GPURenderPipeline;
  /** Surface pipeline for `"coarse"` batches; the surface pipeline itself when the offset is zero. */
  private readonly fallbackSurfacePipeline: GPURenderPipeline;
  /** Pick pipeline for `"coarse"` batches, so picks agree with what is visible. */
  private readonly fallbackPickPipeline: GPURenderPipeline;
  readonly fallbackDepthOffset: number;
  private readonly pixelRatio?: number;
  private readonly lastViewProjection = new Float32Array(16);
  private readonly lastCameraOrigin = new Float64Array(3);
  private readonly uniformData = new ArrayBuffer(128);
  private readonly uniformMatrix = new Float32Array(this.uniformData, 0, 16);
  private readonly uniformCameraOriginHigh = new Float32Array(this.uniformData, 64, 4);
  private readonly uniformCameraOriginLow = new Float32Array(this.uniformData, 80, 4);
  private readonly uniformSectionPlane = new Float32Array(this.uniformData, 96, 4);
  private readonly uniformFlags = new Uint32Array(this.uniformData, 112, 4);
  private batches: GpuBatchResources[] = [];
  /**
   * Vertex buffers keyed by the decoded array they hold. The decoder gives one
   * prototype's material groups the identical interleaved array, so uploading
   * per batch would allocate the same vertices once per material -- 111 times
   * for the largest sixty5 prototype. Refcounts release a buffer with its last
   * batch instead.
   */
  private readonly vertexPools = new Map<Float32Array, GpuVertexPool>();
  private hasRendered = false;
  private selectedObjectId = 0;
  private sectionPlane?: NormalizedSectionPlane;
  private depthTexture?: GPUTexture;
  private pickTexture?: GPUTexture;
  private targetWidth = 0;
  private targetHeight = 0;
  private destroyed = false;

  private constructor(
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    adapter: GPUAdapter,
    device: GPUDevice,
    options: Phase0RendererOptions,
  ) {
    this.canvas = canvas;
    this.context = context;
    this.adapter = adapter;
    this.device = device;
    this.pixelRatio = options.pixelRatio;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device,
      format: this.format,
      alphaMode: "opaque",
    });

    const surfaceModule = device.createShaderModule({
      label: "NARU surface + picking shader",
      code: surfaceShader,
    });
    const edgeModule = device.createShaderModule({
      label: "NARU explicit edge shader",
      code: edgeShader,
    });
    this.cameraBuffer = device.createBuffer({
      label: "NARU scene uniforms",
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroupLayout = device.createBindGroupLayout({
      label: "NARU camera bind-group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({
      label: "NARU pipeline layout",
      bindGroupLayouts: [bindGroupLayout],
    });
    this.cameraBindGroup = device.createBindGroup({
      label: "NARU camera bind group",
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    const surfaceBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: 24,
        stepMode: "vertex",
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x3" },
        ],
      },
      instanceBufferLayout,
    ];
    const surfacePipeline = (
      label: string,
      entryPoint: "fsSurface" | "fsPick",
      fallbackDepthOffset: number,
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: pipelineLayout,
        vertex: {
          module: surfaceModule,
          entryPoint: "vsMain",
          buffers: surfaceBuffers,
          constants: { fallbackDepthOffset },
        },
        fragment: {
          module: surfaceModule,
          entryPoint,
          targets: [{ format: entryPoint === "fsPick" ? "rgba8uint" : this.format }],
        },
        primitive: { topology: "triangle-list", cullMode: "back" },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: true,
          depthCompare: "less",
        },
      });
    this.surfacePipeline = surfacePipeline("NARU shaded surface pipeline", "fsSurface", 0);
    this.pickPipeline = surfacePipeline("NARU object ID pipeline", "fsPick", 0);
    this.fallbackDepthOffset = resolveFallbackDepthOffset(options.fallbackDepthOffset);
    if (this.fallbackDepthOffset === 0) {
      this.fallbackSurfacePipeline = this.surfacePipeline;
      this.fallbackPickPipeline = this.pickPipeline;
    } else {
      this.fallbackSurfacePipeline = surfacePipeline(
        "NARU fallback surface pipeline",
        "fsSurface",
        this.fallbackDepthOffset,
      );
      this.fallbackPickPipeline = surfacePipeline(
        "NARU fallback object ID pipeline",
        "fsPick",
        this.fallbackDepthOffset,
      );
    }
    this.edgePipeline = device.createRenderPipeline({
      label: "NARU explicit edge pipeline",
      layout: pipelineLayout,
      vertex: {
        module: edgeModule,
        entryPoint: "vsMain",
        buffers: [
          {
            arrayStride: 12,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
          },
          instanceBufferLayout,
        ],
      },
      fragment: {
        module: edgeModule,
        entryPoint: "fsMain",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "line-list" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });

    void device.lost.then((info) => {
      if (!this.destroyed) options.onDeviceLost?.(info.message || info.reason);
    });
  }

  static async create(
    canvas: HTMLCanvasElement,
    options: Phase0RendererOptions = {},
  ): Promise<Phase0Renderer> {
    if (
      options.pixelRatio !== undefined &&
      (!Number.isFinite(options.pixelRatio) || options.pixelRatio <= 0)
    ) {
      throw new RangeError("pixelRatio must be a positive finite number.");
    }
    resolveFallbackDepthOffset(options.fallbackDepthOffset);
    if (!navigator.gpu) {
      throw new NaruWebGpuError(
        "WEBGPU_UNAVAILABLE",
        "WebGPU is unavailable in this browser.",
      );
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new NaruWebGpuError(
        "ADAPTER_UNAVAILABLE",
        "No compatible WebGPU adapter was found.",
      );
    }
    const requestTimestamps =
      (options.requestTimestampQueries ?? false) && adapter.features.has("timestamp-query");
    const device = await adapter.requestDevice(
      requestTimestamps ? { requiredFeatures: ["timestamp-query"] } : {},
    );
    const context = canvas.getContext("webgpu");
    if (!context) {
      device.destroy();
      throw new NaruWebGpuError(
        "CONTEXT_UNAVAILABLE",
        "The canvas could not create a WebGPU context.",
      );
    }
    return new Phase0Renderer(canvas, context, adapter, device, options);
  }

  setScene(
    sceneOrBatch: GpuScene | GpuPrototypeBatch,
    options: SetSceneOptions = {},
  ): void {
    const scene: GpuScene =
      "batches" in sceneOrBatch ? sceneOrBatch : { batches: [sceneOrBatch] };
    validateGpuScene(scene);
    const includeEdges = options.includeEdges ?? true;
    this.destroyBatches();
    this.batches = scene.batches.map((batch, index) =>
      this.createBatchResources(`scene:${String(index)}`, batch, includeEdges, "target"),
    );
  }

  /**
   * Reconciles application-keyed batches without re-uploading untouched GPU
   * resources. This is the residency boundary used by progressive loaders.
   *
   * A batch is validated when it is first uploaded, not on every reconcile:
   * retained batches are treated as immutable, so admission cost scales with
   * the batches that actually change rather than the whole resident set. All
   * validation runs before any GPU resource is destroyed or created.
   */
  reconcileBatches(
    entries: readonly GpuSceneBatchEntry[],
    options: ReconcileSceneOptions = {},
  ): void {
    const keys = new Set<string>();
    for (const { key } of entries) {
      if (key.trim() === "" || keys.has(key)) {
        throw new TypeError("Reconciled GPU batch keys must be unique and non-empty.");
      }
      keys.add(key);
    }
    if (entries.length === 0) {
      throw new TypeError("A GPU scene must contain at least one prototype batch.");
    }
    const includeEdges = options.includeEdges ?? true;
    const remaining = new Map(this.batches.map((resource) => [resource.key, resource]));
    const planned = entries.map(({ key, batch, representation = "target" }) => {
      const current = remaining.get(key);
      remaining.delete(key);
      const reuse =
        current !== undefined &&
        current.source === batch &&
        current.includeEdges === includeEdges &&
        current.representation === representation;
      return { key, batch, representation, current, reuse };
    });
    for (const { batch, reuse } of planned) {
      if (!reuse) validatePrototypeBatch(batch);
    }
    if (options.sharedObjectIdsAcrossBatches !== true) {
      const objectIds = new Set<number>();
      const claim = (batch: GpuPrototypeBatch): void => {
        for (const instance of batch.instances) {
          if (objectIds.has(instance.objectId)) {
            throw new RangeError(`Duplicate scene object ID ${instance.objectId}.`);
          }
          objectIds.add(instance.objectId);
        }
      };
      for (const { batch, reuse } of planned) if (reuse) claim(batch);
      for (const { batch, reuse } of planned) if (!reuse) claim(batch);
    }
    const next = planned.map(({ key, batch, representation, current, reuse }) => {
      if (reuse && current) return current;
      // Acquire before releasing: a replacement that reads the same vertex
      // pool keeps its refcount above zero, so the buffer is never destroyed
      // and re-uploaded for geometry that never left the resident set.
      const resources = this.createBatchResources(key, batch, includeEdges, representation);
      if (current) this.destroyBatch(current);
      return resources;
    });
    for (const stale of remaining.values()) this.destroyBatch(stale);
    this.batches = next;
  }

  /** Estimated buffer allocation currently retained by this renderer. */
  get residentGpuBytes(): number {
    let total = this.batches.reduce((sum, batch) => sum + batch.gpuByteLength, 0);
    for (const pool of this.vertexPools.values()) total += pool.byteLength;
    return total;
  }

  /**
   * Re-packs visible occurrences from dense per-prototype index tables. When
   * `changedBatchIndexes` is provided, only those batches are re-packed and
   * re-uploaded; every other batch keeps its current GPU packing and count.
   */
  updateVisibleInstances(
    indicesByBatch: readonly Int32Array[],
    counts: Uint32Array,
    changedBatchIndexes?: readonly number[],
  ): void {
    if (indicesByBatch.length !== this.batches.length || counts.length !== this.batches.length) {
      throw new RangeError("Visibility tables must match the uploaded prototype count.");
    }
    const apply = (batchIndex: number): void => {
      const batch = this.batches[batchIndex];
      const indices = indicesByBatch[batchIndex];
      const count = counts[batchIndex] ?? 0;
      if (!batch || !indices || count > indices.length || count > batch.instances.length) {
        throw new RangeError(`Invalid visibility count for prototype ${batchIndex}.`);
      }
      const byteLength = packInstanceDataInto(
        batch.instances,
        batch.instanceStagingView,
        indices,
        count,
      );
      if (byteLength > 0) {
        this.device.queue.writeBuffer(batch.instance, 0, batch.instanceStaging, 0, byteLength);
      }
      batch.instanceCount = count;
    };
    if (changedBatchIndexes === undefined) {
      for (let batchIndex = 0; batchIndex < this.batches.length; batchIndex += 1) {
        apply(batchIndex);
      }
      return;
    }
    const applied = new Set<number>();
    for (const batchIndex of changedBatchIndexes) {
      if (
        !Number.isInteger(batchIndex) ||
        batchIndex < 0 ||
        batchIndex >= this.batches.length
      ) {
        throw new RangeError(`Invalid changed batch index ${String(batchIndex)}.`);
      }
      if (applied.has(batchIndex)) continue;
      applied.add(batchIndex);
      apply(batchIndex);
    }
  }

  /** Selects an occurrence for surface and explicit-edge highlighting. Zero clears selection. */
  setSelection(objectId: number): void {
    if (!Number.isInteger(objectId) || objectId < 0 || objectId > 0xffff_ffff) {
      throw new RangeError("Selected object ID must fit in uint32.");
    }
    this.selectedObjectId = objectId;
  }

  /** Enables one world-space section plane. Passing undefined disables clipping. */
  setSectionPlane(plane?: SectionPlane): void {
    this.sectionPlane = plane ? normalizeSectionPlane(plane) : undefined;
  }

  render(viewProjection: Float32Array, options: RenderOptions = {}): void {
    if (this.batches.length === 0) {
      throw new NaruWebGpuError("SCENE_NOT_SET", "Call setScene before render.");
    }
    if (viewProjection.length !== 16) {
      throw new TypeError("viewProjection must contain 16 float32 values.");
    }
    const cameraOrigin = options.cameraOrigin ?? [0, 0, 0];
    if (cameraOrigin.length !== 3 || cameraOrigin.some((value) => !Number.isFinite(value))) {
      throw new TypeError("cameraOrigin must contain three finite values.");
    }
    this.lastViewProjection.set(viewProjection);
    this.lastCameraOrigin.set(cameraOrigin);
    this.hasRendered = true;
    this.ensureTargets();
    if (!this.depthTexture) return;

    if (options.timestampWrites && !this.device.features.has("timestamp-query")) {
      throw new NaruWebGpuError(
        "TIMESTAMP_QUERY_UNSUPPORTED",
        "Pass timestamp writes require a device created with requestTimestampQueries.",
      );
    }

    this.writeUniforms(viewProjection, cameraOrigin);
    const encoder = this.device.createCommandEncoder({ label: "NARU frame" });
    const colorView = this.context.getCurrentTexture().createView();
    const depthView = this.depthTexture.createView();

    const surfacePass = encoder.beginRenderPass({
      label: "NARU surfaces and explicit edges",
      colorAttachments: [
        {
          view: colorView,
          clearValue: { r: 0.94, g: 0.96, b: 0.98, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
      ...(options.timestampWrites ? { timestampWrites: options.timestampWrites } : {}),
    });
    for (const batch of this.batches) {
      if (batch.instanceCount === 0) continue;
      this.bindBatch(
        surfacePass,
        batch.representation === "coarse" ? this.fallbackSurfacePipeline : this.surfacePipeline,
        batch,
      );
      surfacePass.drawIndexed(batch.indexCount, batch.instanceCount);
    }
    if (options.edges ?? true) {
      for (const batch of this.batches) {
        if (batch.edgeVertexCount === 0 || batch.instanceCount === 0) continue;
        surfacePass.setPipeline(this.edgePipeline);
        surfacePass.setBindGroup(0, this.cameraBindGroup);
        surfacePass.setVertexBuffer(0, batch.edgeVertex);
        surfacePass.setVertexBuffer(1, batch.instance);
        surfacePass.draw(batch.edgeVertexCount, batch.instanceCount);
      }
    }
    surfacePass.end();

    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Byte census of renderer-owned resources. Vertex pools are walked from the
   * pool map rather than from the batches that reference them: several material
   * groups hold the same `GPUBuffer`, so a per-batch sum reports allocations
   * that were never made.
   *
   * It does not include caller-owned decoded typed arrays; those are charged by
   * the residency set that retains them.
   */
  resourceStats(): RendererResourceStats {
    let gpuVertexPoolBytes = 0;
    for (const pool of this.vertexPools.values()) gpuVertexPoolBytes += pool.buffer.size;
    let gpuBatchBufferBytes = 0;
    let cpuStagingBytes = 0;
    for (const batch of this.batches) {
      gpuBatchBufferBytes += batch.surfaceIndex.size + batch.edgeVertex.size +
        batch.instance.size;
      cpuStagingBytes += batch.instanceStaging.byteLength;
    }
    const gpuUniformBytes = this.cameraBuffer.size;
    return {
      gpuVertexPoolBytes,
      gpuBatchBufferBytes,
      gpuUniformBytes,
      gpuBufferBytes: gpuVertexPoolBytes + gpuBatchBufferBytes + gpuUniformBytes,
      gpuAttachmentBytes: attachmentPairByteLength(this.targetWidth, this.targetHeight),
      cpuStagingBytes,
      attachmentSizePx:
        this.targetWidth > 0 && this.targetHeight > 0
          ? [this.targetWidth, this.targetHeight]
          : null,
    };
  }

  async pick(clientX: number, clientY: number): Promise<number> {
    if (
      !this.pickTexture ||
      !this.depthTexture ||
      !this.hasRendered ||
      this.targetWidth === 0 ||
      this.targetHeight === 0
    ) {
      return 0;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 0;
    const x = Math.max(
      0,
      Math.min(this.targetWidth - 1, Math.floor(((clientX - rect.left) / rect.width) * this.targetWidth)),
    );
    const y = Math.max(
      0,
      Math.min(this.targetHeight - 1, Math.floor(((clientY - rect.top) / rect.height) * this.targetHeight)),
    );
    this.writeUniforms(this.lastViewProjection, this.lastCameraOrigin);
    const readback = this.device.createBuffer({
      label: "NARU pick readback",
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder({ label: "NARU on-demand pick" });
    const pickPass = encoder.beginRenderPass({
      label: "NARU object ID pass",
      colorAttachments: [
        {
          view: this.pickTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    for (const batch of this.batches) {
      if (batch.instanceCount === 0) continue;
      this.bindBatch(
        pickPass,
        batch.representation === "coarse" ? this.fallbackPickPipeline : this.pickPipeline,
        batch,
      );
      pickPass.drawIndexed(batch.indexCount, batch.instanceCount);
    }
    pickPass.end();
    encoder.copyTextureToBuffer(
      { texture: this.pickTexture, origin: { x, y } },
      { buffer: readback, bytesPerRow: 256 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    this.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const id = decodeObjectId(new Uint8Array(readback.getMappedRange(), 0, 4));
    readback.unmap();
    readback.destroy();
    return id;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyBatches();
    this.depthTexture?.destroy();
    this.pickTexture?.destroy();
    this.cameraBuffer.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }

  private bindBatch(
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    batch: GpuBatchResources,
  ): void {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.cameraBindGroup);
    pass.setVertexBuffer(0, batch.surfaceVertex);
    pass.setVertexBuffer(1, batch.instance);
    pass.setIndexBuffer(batch.surfaceIndex, "uint32");
  }

  private writeUniforms(
    viewProjection: Float32Array,
    cameraOrigin: ArrayLike<number>,
  ): void {
    this.uniformMatrix.set(viewProjection);
    this.uniformFlags[0] = this.selectedObjectId;
    this.uniformFlags[1] = this.sectionPlane ? 1 : 0;
    if (this.sectionPlane) {
      const relativePlane = rebaseSectionPlane(this.sectionPlane, cameraOrigin);
      this.uniformSectionPlane.set(relativePlane.normal, 0);
      this.uniformSectionPlane[3] = relativePlane.offset;
    } else {
      this.uniformSectionPlane.fill(0);
    }
    for (let axis = 0; axis < 3; axis += 1) {
      const [high, low] = splitFloat64(cameraOrigin[axis] ?? 0);
      this.uniformCameraOriginHigh[axis] = high;
      this.uniformCameraOriginLow[axis] = low;
    }
    this.device.queue.writeBuffer(this.cameraBuffer, 0, this.uniformData);
  }

  private ensureTargets(): void {
    const ratio = this.pixelRatio ?? Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * ratio));
    if (width === this.targetWidth && height === this.targetHeight) return;

    this.canvas.width = width;
    this.canvas.height = height;
    this.targetWidth = width;
    this.targetHeight = height;
    this.depthTexture?.destroy();
    this.pickTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      label: "NARU depth target",
      size: [width, height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.pickTexture = this.device.createTexture({
      label: "NARU object ID target",
      size: [width, height],
      format: "rgba8uint",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }

  private destroyBatches(): void {
    for (const batch of this.batches) this.destroyBatch(batch);
    this.batches = [];
  }

  private createBatchResources(
    key: string,
    batch: GpuPrototypeBatch,
    includeEdges: boolean,
    representation: GeometryRepresentation,
  ): GpuBatchResources {
    const uploadedEdges = includeEdges ? batch.edgeVertices : new Float32Array();
    const instanceData = packInstanceData(batch.instances);
    const instanceStaging = new ArrayBuffer(batch.instances.length * instanceStride);
    const surfaceVertexPool = this.acquireVertexPool(key, batch.surfaceVertices);
    return {
      key,
      source: batch,
      includeEdges,
      representation,
      surfaceVertexPool: batch.surfaceVertices,
      surfaceVertex: surfaceVertexPool.buffer,
      surfaceIndex: createBuffer(
        this.device,
        `NARU ${key} surface indices`,
        batch.surfaceIndices,
        GPUBufferUsage.INDEX,
      ),
      edgeVertex: createBuffer(
        this.device,
        `NARU ${key} explicit edges`,
        uploadedEdges,
        GPUBufferUsage.VERTEX,
      ),
      instance: createBuffer(
        this.device,
        `NARU ${key} occurrences`,
        instanceData,
        GPUBufferUsage.VERTEX,
      ),
      instances: batch.instances,
      instanceStaging,
      instanceStagingView: new DataView(instanceStaging),
      indexCount: batch.surfaceIndices.length,
      edgeVertexCount: uploadedEdges.length / 3,
      gpuByteLength:
        alignedBufferByteLength(batch.surfaceIndices.byteLength) +
        alignedBufferByteLength(uploadedEdges.byteLength) +
        alignedBufferByteLength(instanceData.byteLength),
      instanceCount: batch.instances.length,
    };
  }

  private acquireVertexPool(key: string, vertices: Float32Array): GpuVertexPool {
    const existing = this.vertexPools.get(vertices);
    if (existing) {
      existing.refCount += 1;
      return existing;
    }
    const pool: GpuVertexPool = {
      buffer: createBuffer(
        this.device,
        `NARU ${key} surface vertices`,
        vertices,
        GPUBufferUsage.VERTEX,
      ),
      byteLength: alignedBufferByteLength(vertices.byteLength),
      refCount: 1,
    };
    this.vertexPools.set(vertices, pool);
    return pool;
  }

  private destroyBatch(batch: GpuBatchResources): void {
    const pool = this.vertexPools.get(batch.surfaceVertexPool);
    if (pool) {
      pool.refCount -= 1;
      if (pool.refCount <= 0) {
        this.vertexPools.delete(batch.surfaceVertexPool);
        pool.buffer.destroy();
      }
    }
    batch.surfaceIndex.destroy();
    batch.edgeVertex.destroy();
    batch.instance.destroy();
  }
}
