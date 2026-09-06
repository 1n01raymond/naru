export {
  addResidencyCost,
  alignedBufferByteLength,
  attachmentPairByteLength,
  batchResidencyCost,
  decodeObjectId,
  instanceStride,
  packInstanceData,
  packInstanceDataInto,
  splitFloat64,
  validateGpuScene,
  validatePrototypeBatch,
} from "./layout.js";
export type {
  BatchResidencyShape,
  GpuOccurrenceInstance,
  GpuPrototypeBatch,
  GpuScene,
  ResidencyCost,
} from "./layout.js";
export {
  CompiledGltfError,
  compiledSceneTransferables,
  decodeCompiledGltf,
  inspectCompiledHierarchy,
  readCompiledHierarchyRef,
  parseCompiledGltf,
  prepareCompiledGltfDecoder,
} from "./compiled-gltf.js";
export {
  defaultCompiledPackageLimits,
  resolveCompiledPackageLimits,
} from "./package-limits.js";
export type {
  CompiledHierarchySidecar,
  CompiledPackageLimitOverrides,
  CompiledPackageLimits,
  CompiledPackageOptions,
} from "./package-limits.js";
export {
  assertPackageBudget,
  assertPackageOrigin,
  assertPackageUrl,
  defaultPackageTransferLimits,
  fetchPackageResource,
  openPackageResponse,
  openPackageTransport,
  PackageTransport,
  packageResourceDigest,
  readBoundedBody,
  resolvePackageResourceUrl,
  resolvePackageTransferLimits,
} from "./package-transport.js";
export type {
  DeclaredPackageResource,
  PackageFetch,
  PackageResourceKind,
  PackageResponseRequest,
  PackageTransferLimitOverrides,
  PackageTransferLimits,
  PackageTransportDescriptor,
  PackageTransportPolicy,
} from "./package-transport.js";
export {
  decodeSpatialDemandIndex,
  querySpatialDemandIndex,
  SpatialDemandIndexError,
  supportedSpatialDemandIndexSchema,
} from "./spatial-index.js";
export {
  decodePackageHierarchy,
  PackageHierarchyError,
  supportedPackageHierarchySchema,
} from "./package-hierarchy.js";
export type {
  DecodedPackageHierarchy,
  DecodePackageHierarchyOptions,
  PackageHierarchyEntry,
  PackageHierarchyErrorCode,
  RelocatedHierarchyNode,
} from "./package-hierarchy.js";
export type {
  DecodedSpatialDemandIndex,
  DecodeSpatialDemandIndexOptions,
  SpatialDemandPriority,
  SpatialDemandQueryCandidate,
  SpatialDemandQueryFrame,
  SpatialDemandQueryOptions,
  SpatialDemandQueryResult,
} from "./spatial-index.js";
export type {
  CompiledGltfDocument,
  CompiledGltfErrorCode,
  CompiledBatchEvidence,
  DecodeCompiledGltfOptions,
  CompiledHierarchy,
  CompiledHierarchyEntry,
  CompiledObjectEvidence,
  CompiledHierarchyRef,
  CompiledPropertiesRef,
  CompiledSpatialIndexRef,
  CompiledTargetChunk,
  DecodedCompiledScene,
  GeometryRepresentation,
  PreparedCompiledGltfDecoder,
  SceneBounds,
} from "./compiled-gltf.js";
export {
  defaultFallbackDepthOffset,
  NaruWebGpuError,
  normalizeSectionPlane,
  rebaseSectionPlane,
  resolveFallbackDepthOffset,
  Phase0Renderer,
  Phase0Renderer as NaruWebGpuRenderer,
} from "./renderer.js";
export type {
  NaruWebGpuErrorCode,
  NormalizedSectionPlane,
  Phase0RendererOptions,
  Phase0RendererOptions as NaruWebGpuRendererOptions,
  GpuSceneBatchEntry,
  ReconcileSceneOptions,
  RenderOptions,
  RendererResourceStats,
  SectionPlane,
  SetSceneOptions,
} from "./renderer.js";
