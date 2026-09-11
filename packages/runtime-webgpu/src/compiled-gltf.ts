import { addResidencyCost, batchResidencyCost } from "./layout.js";
import type {
  GpuOccurrenceInstance,
  GpuPrototypeBatch,
  GpuScene,
  ResidencyCost,
} from "./layout.js";
import { resolveCompiledPackageLimits } from "./package-limits.js";
import type { CompiledPackageLimits, CompiledPackageOptions } from "./package-limits.js";
import {
  decodePackageHierarchy,
  PackageHierarchyError,
  supportedPackageHierarchySchema,
} from "./package-hierarchy.js";
import type { DecodedPackageHierarchy } from "./package-hierarchy.js";
import { supportedSpatialDemandIndexSchema } from "./spatial-index.js";

const supportedProfile = "madi.experimental.gltf.1";
/** `extras.naru.progressive` schema a reduced-level package declares (ADR-0025). */
export const supportedProgressivePackageSchema = "naru.progressive-package.2";
const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

export type JsonRecord = Record<string, unknown>;

export interface CompiledGltfBuffer {
  readonly uri: string;
  readonly byteLength: number;
}

export interface CompiledGltfBufferView {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
}

export interface CompiledGltfAccessor {
  readonly bufferView: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
  readonly normalized?: boolean;
}

export interface CompiledGltfPrimitive {
  readonly attributes: Readonly<Record<string, number>>;
  readonly indices?: number;
  readonly material?: number;
  readonly mode?: number;
  readonly extras?: JsonRecord;
}

export interface CompiledGltfMesh {
  readonly name?: string;
  readonly primitives: readonly CompiledGltfPrimitive[];
  readonly extras?: JsonRecord;
}

export interface CompiledGltfNode {
  readonly name?: string;
  readonly children?: readonly number[];
  readonly matrix?: readonly number[];
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
  readonly mesh?: number;
  readonly extras?: JsonRecord;
}

export interface CompiledGltfMaterial {
  readonly pbrMetallicRoughness?: {
    readonly baseColorFactor?: readonly number[];
  };
}

export interface CompiledGltfDocument {
  readonly asset: { readonly version: string; readonly generator?: string };
  readonly scene?: number;
  readonly scenes: readonly { readonly name?: string; readonly nodes: readonly number[] }[];
  readonly nodes: readonly CompiledGltfNode[];
  readonly meshes: readonly CompiledGltfMesh[];
  readonly materials: readonly CompiledGltfMaterial[];
  readonly buffers: readonly CompiledGltfBuffer[];
  readonly bufferViews: readonly CompiledGltfBufferView[];
  readonly accessors: readonly CompiledGltfAccessor[];
  readonly extras?: JsonRecord;
}

export interface CompiledHierarchyEntry {
  readonly nodeIndex: number;
  readonly name: string;
  readonly depth: number;
  readonly renderable: boolean;
  readonly occurrenceId: string;
  readonly prototypeId: string;
  readonly semanticId?: string;
  readonly sourceRef?: string;
}

/** Pointer to the package's `madi.package-properties.1` sidecar, when present. */
export interface CompiledPropertiesRef {
  readonly schemaVersion: string;
  readonly uri: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * Pointer to the hierarchy sidecar that carries the occurrences whose nodes
 * left the document. Present only when the package was compiled with
 * `--relocate-hierarchy-nodes`.
 */
export interface CompiledHierarchyRef {
  readonly schemaVersion: typeof supportedPackageHierarchySchema;
  readonly uri: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly entryCount: number;
  readonly relocatedCount: number;
}

/** Pointer to the optional occurrence-to-target-chunk spatial demand index. */
export interface CompiledSpatialIndexRef {
  readonly schemaVersion: typeof supportedSpatialDemandIndexSchema;
  readonly uri: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * The error statement a package makes about its reduced level (ADR-0025).
 *
 * A level with no stated bound is not a level a viewer may draw, so this is
 * present exactly when `reducedChunks` is non-empty. The bound here covers the
 * whole package; each chunk states its own, and a renderer decides per chunk by
 * dividing that one by the world size of a pixel.
 */
export interface CompiledReducedLodRef {
  readonly method: string;
  /** The tolerance the compile asked for, which bounds the sampled p95 only. */
  readonly requestedToleranceMeters: number;
  /** The largest deviation any reduced chunk in this package declares. */
  readonly maxDeviationMeters: number;
}

export interface CompiledTargetChunk {
  readonly id: string;
  readonly buffer: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly meshIndexes: readonly number[];
  /** All prototypes represented by this request. Legacy chunks contain one. */
  readonly prototypeIds: readonly string[];
  /** @deprecated Use prototypeIds; retained for the prototype-range-v1 contract. */
  readonly prototypeId: string;
  readonly occurrenceCount: number;
  readonly priority: number;
  /**
   * The deviation this chunk's geometry stays within (ADR-0025).
   *
   * Present on every reduced chunk and on no target chunk: the exact level has
   * no error to declare. Where a byte budget coalesced several prototypes into
   * one chunk this is the largest of their measured deviations, because a chunk
   * is the finest thing a viewer can fetch.
   */
  readonly maxDeviationMeters?: number;
}

export interface CompiledHierarchy {
  readonly profile: typeof supportedProfile;
  readonly nodeCount: number;
  readonly sceneId: string;
  readonly sourceFormat: string;
  readonly binaryUri: string;
  readonly binaryByteLength: number;
  readonly coarseBinaryUri?: string;
  readonly coarseBinaryByteLength?: number;
  readonly properties?: CompiledPropertiesRef;
  readonly relocatedHierarchy?: CompiledHierarchyRef;
  readonly spatialIndex?: CompiledSpatialIndexRef;
  readonly targetChunks: readonly CompiledTargetChunk[];
  /** Declared-error reduced level (ADR-0025); empty for legacy packages. */
  readonly reducedChunks: readonly CompiledTargetChunk[];
  /** The error statement behind `reducedChunks`; absent when there are none. */
  readonly reducedLod?: CompiledReducedLodRef;
  readonly entries: readonly CompiledHierarchyEntry[];
  readonly renderableOccurrences: number;
  readonly sharedMeshes: number;
}

export interface SceneBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface CompiledObjectEvidence {
  readonly objectId: number;
  readonly nodeIndex: number;
  readonly label: string;
  readonly occurrenceId: string;
  readonly prototypeId: string;
  readonly semanticId?: string;
  readonly sourceRef?: string;
  readonly edgeSourceRefs: readonly string[];
}

export interface CompiledBatchEvidence {
  readonly batchIndex: number;
  readonly meshIndex: number;
  readonly targetMeshIndex: number;
  readonly surfacePrimitiveIndex: number;
  readonly prototypeId: string;
}

export interface DecodedCompiledScene {
  readonly gpuScene: GpuScene;
  readonly bounds: SceneBounds;
  readonly hierarchy: CompiledHierarchy;
  readonly objectEvidence: readonly CompiledObjectEvidence[];
  readonly batchEvidence: readonly CompiledBatchEvidence[];
  readonly summary: {
    readonly prototypeBatches: number;
    readonly partOccurrences: number;
    readonly triangles: number;
    readonly edgeSegments: number;
    readonly binaryBytes: number;
    readonly representation: GeometryRepresentation;
  };
}

export type GeometryRepresentation = "target" | "coarse" | "reduced";

export interface DecodeCompiledGltfOptions {
  readonly representation?: GeometryRepresentation;
  readonly targetChunkId?: string;
}

/**
 * Document-scoped decode state. Active-node transforms and target-chunk
 * occurrence membership are prepared once, then reused for every binary range.
 */
export interface PreparedCompiledGltfDecoder {
  readonly hierarchy: CompiledHierarchy;
  readonly activeNodeCount: number;
  readonly renderableNodeCount: number;
  /**
   * Residency cost each target chunk would add once decoded, keyed by chunk id.
   * Accessor counts determine it, so a scheduler can refuse a chunk the budget
   * cannot hold without spending a range request on it.
   */
  readonly targetChunkResidencyCosts: ReadonlyMap<string, ResidencyCost>;
  decode(
    binary: ArrayBuffer,
    options?: DecodeCompiledGltfOptions,
  ): DecodedCompiledScene;
}

export type CompiledGltfErrorCode =
  | "INVALID_GLTF"
  | "UNSUPPORTED_PROFILE"
  | "UNSUPPORTED_GEOMETRY"
  | "INVALID_BINARY";

export class CompiledGltfError extends Error {
  readonly code: CompiledGltfErrorCode;

  constructor(code: CompiledGltfErrorCode, message: string) {
    super(message);
    this.name = "CompiledGltfError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Names a declared profile in a diagnostic. A hostile package can put any JSON
 * value here, and `String()` would report a non-string one as `[object Object]`.
 */
function describeProfile(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined ? "no profile" : JSON.stringify(value);
}

function recordAt(value: unknown, key: string): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function madiExtras(value: { readonly extras?: JsonRecord }): JsonRecord {
  return recordAt(value.extras, "madi") ?? {};
}

function finiteInteger(value: unknown, label: string, maximum?: number): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new CompiledGltfError("INVALID_GLTF", `${label} must be a non-negative integer.`);
  }
  const result = value as number;
  if (maximum !== undefined && result >= maximum) {
    throw new CompiledGltfError("INVALID_GLTF", `${label} references missing index ${result}.`);
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Composes a node transform in the glTF order M = T * R * S.
 *
 * Standard glTF lets a node carry either a matrix or any subset of TRS, and
 * NARU packages compiled with `omitDefaultNodeTransforms` use the translation
 * form for axis-aligned occurrences. Absent members are the glTF defaults, so
 * a node with neither form is the identity.
 */
function composeTrs(node: CompiledGltfNode): readonly number[] | undefined {
  const { translation, rotation, scale } = node;
  if (translation === undefined && rotation === undefined && scale === undefined) {
    return undefined;
  }
  const [tx, ty, tz] = [translation?.[0] ?? 0, translation?.[1] ?? 0, translation?.[2] ?? 0];
  const [x, y, z, w] = [
    rotation?.[0] ?? 0,
    rotation?.[1] ?? 0,
    rotation?.[2] ?? 0,
    rotation?.[3] ?? 1,
  ];
  const [sx, sy, sz] = [scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    (2 * (x * y + z * w)) * sx,
    (2 * (x * z - y * w)) * sx,
    0,
    (2 * (x * y - z * w)) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    (2 * (y * z + x * w)) * sy,
    0,
    (2 * (x * z + y * w)) * sz,
    (2 * (y * z - x * w)) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

/** How a document reconstructs the node identities it does not serialize. */
interface NodeIdentityDerivation {
  readonly semanticId?: "prototypeId";
  readonly sourceRef?: "semanticId" | "occurrenceId";
}

interface NodeIdentity {
  readonly semanticId?: string;
  readonly sourceRef?: string;
}

/**
 * Reads the document-level derivation declaration, ignoring rules this
 * runtime does not know: an unrecognized base leaves the field unreconstructed
 * rather than inventing an identity.
 */
function nodeIdentityDerivationFrom(rootMadi: JsonRecord): NodeIdentityDerivation {
  const declared = recordAt(rootMadi, "nodeIdentityDerivation");
  if (!declared) return {};
  return {
    ...(declared.semanticId === "prototypeId" ? { semanticId: "prototypeId" as const } : {}),
    ...(declared.sourceRef === "semanticId" || declared.sourceRef === "occurrenceId"
      ? { sourceRef: declared.sourceRef }
      : {}),
  };
}

/**
 * Resolves one node identity pair against the declared derivation.
 *
 * A serialized string always wins. Under a declared rule an absent key means
 * "reconstruct me" and an explicit `null` means the occurrence genuinely had
 * no identity, so the pair round-trips exactly either way. `sourceRef` is
 * resolved after `semanticId` because it may derive from it.
 */
function resolveNodeIdentity(
  madi: JsonRecord,
  derivation: NodeIdentityDerivation,
): NodeIdentity {
  const prototypeId = madi.prototypeId;
  const semanticId = typeof madi.semanticId === "string"
    ? madi.semanticId
    : madi.semanticId === undefined &&
        derivation.semanticId === "prototypeId" &&
        typeof prototypeId === "string"
      ? `semantic:${prototypeId}`
      : undefined;
  const base = derivation.sourceRef === "occurrenceId" ? madi.occurrenceId : semanticId;
  const sourceRef = typeof madi.sourceRef === "string"
    ? madi.sourceRef
    : madi.sourceRef === undefined &&
        derivation.sourceRef !== undefined &&
        typeof base === "string"
      ? `source:${base.startsWith("semantic:") ? base.slice("semantic:".length) : base}`
      : undefined;
  return {
    ...(semanticId === undefined ? {} : { semanticId }),
    ...(sourceRef === undefined ? {} : { sourceRef }),
  };
}

function matrixFor(node: CompiledGltfNode, nodeIndex: number): readonly number[] {
  if (node.matrix === undefined) {
    const composed = composeTrs(node);
    if (composed) return composed;
  }
  const matrix = node.matrix ?? identityMatrix;
  if (matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value))) {
    throw new CompiledGltfError(
      "INVALID_GLTF",
      `nodes[${nodeIndex}].matrix must contain 16 finite values.`,
    );
  }
  return matrix;
}

function validateDocumentShape(value: unknown): asserts value is CompiledGltfDocument {
  if (!isRecord(value)) {
    throw new CompiledGltfError("INVALID_GLTF", "Compiled scene JSON must be an object.");
  }
  if (recordAt(value, "asset")?.version !== "2.0") {
    throw new CompiledGltfError("INVALID_GLTF", "Compiled scene must use glTF 2.0.");
  }
  for (const key of ["scenes", "nodes", "meshes", "materials", "buffers", "bufferViews", "accessors"] as const) {
    if (!Array.isArray(value[key])) {
      throw new CompiledGltfError("INVALID_GLTF", `Compiled scene is missing ${key}.`);
    }
  }
  if ((value.buffers as unknown[]).length < 1) {
    throw new CompiledGltfError(
      "UNSUPPORTED_GEOMETRY",
      "The experimental runtime slice requires at least one external glTF buffer.",
    );
  }
}

/** Rejects a declared count before the structures derived from it are built. */
function assertWithinLimit(count: number, limit: number, label: string): void {
  if (count > limit) {
    throw new CompiledGltfError(
      "INVALID_GLTF",
      `The package declares ${count} ${label}; the limit is ${limit}.`,
    );
  }
}

export function parseCompiledGltf(
  value: unknown,
  options: CompiledPackageOptions = {},
): CompiledGltfDocument {
  validateDocumentShape(value);
  const document = value;
  const limits = resolveCompiledPackageLimits(options.limits);
  assertWithinLimit(document.nodes.length, limits.nodes, "nodes");
  assertWithinLimit(document.meshes.length, limits.meshes, "meshes");
  assertWithinLimit(document.accessors.length, limits.accessors, "accessors");
  assertWithinLimit(document.bufferViews.length, limits.bufferViews, "buffer views");
  const rootMadi = recordAt(document.extras, "madi");
  if (rootMadi?.profile !== supportedProfile) {
    throw new CompiledGltfError(
      "UNSUPPORTED_PROFILE",
      `Expected ${supportedProfile}; received ${describeProfile(rootMadi?.profile)}.`,
    );
  }

  const sceneIndex = finiteInteger(document.scene ?? 0, "scene", document.scenes.length);
  const activeScene = document.scenes[sceneIndex];
  if (!activeScene || !Array.isArray(activeScene.nodes)) {
    throw new CompiledGltfError("INVALID_GLTF", "The active glTF scene has no root nodes.");
  }
  for (const root of activeScene.nodes) finiteInteger(root, "scene root", document.nodes.length);

  document.nodes.forEach((node, nodeIndex) => {
    if (!isRecord(node)) {
      throw new CompiledGltfError("INVALID_GLTF", `nodes[${nodeIndex}] must be an object.`);
    }
    matrixFor(node, nodeIndex);
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) {
        throw new CompiledGltfError("INVALID_GLTF", `nodes[${nodeIndex}].children must be an array.`);
      }
      for (const child of node.children) {
        finiteInteger(child, `nodes[${nodeIndex}].children`, document.nodes.length);
      }
    }
    if (node.mesh !== undefined) {
      finiteInteger(node.mesh, `nodes[${nodeIndex}].mesh`, document.meshes.length);
    }
    const coarseMesh = madiExtras(node).coarseMesh;
    if (coarseMesh !== undefined) {
      finiteInteger(
        coarseMesh,
        `nodes[${nodeIndex}].extras.madi.coarseMesh`,
        document.meshes.length,
      );
    }
  });

  document.buffers.forEach((buffer, bufferIndex) => {
    if (
      !isRecord(buffer) ||
      typeof buffer.uri !== "string" ||
      buffer.uri.trim() === "" ||
      !Number.isInteger(buffer.byteLength) ||
      buffer.byteLength <= 0
    ) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `buffers[${bufferIndex}] must have a URI and positive byteLength.`,
      );
    }
  });

  return document;
}

function activeRoots(document: CompiledGltfDocument): readonly number[] {
  return document.scenes[document.scene ?? 0]?.nodes ?? [];
}

interface TraversalFrame {
  readonly nodeIndex: number;
  readonly children: readonly number[];
  readonly childOccurrenceDepth: number;
  cursor: number;
}

/**
 * Walks the active scene with an explicit stack rather than recursion, so an
 * untrusted package that nests deeply fails against the reviewed depth ceiling
 * (ADR-0011) instead of exhausting the JavaScript stack.
 */
function traverseActiveNodes(
  document: CompiledGltfDocument,
  visit: (node: CompiledGltfNode, nodeIndex: number, occurrenceDepth: number) => void,
  limits: CompiledPackageLimits,
): void {
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const stack: TraversalFrame[] = [];

  const enter = (nodeIndex: number, occurrenceDepth: number): void => {
    if (visiting.has(nodeIndex)) {
      throw new CompiledGltfError("INVALID_GLTF", `Cycle detected at nodes[${nodeIndex}].`);
    }
    if (visited.has(nodeIndex)) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `nodes[${nodeIndex}] has more than one active-scene parent.`,
      );
    }
    if (stack.length >= limits.traversalDepth) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `The active scene nests deeper than ${limits.traversalDepth} nodes at nodes[${nodeIndex}].`,
      );
    }
    const node = document.nodes[nodeIndex];
    if (!node) {
      throw new CompiledGltfError("INVALID_GLTF", `Missing nodes[${nodeIndex}].`);
    }
    visiting.add(nodeIndex);
    visited.add(nodeIndex);
    visit(node, nodeIndex, occurrenceDepth);
    const isOccurrence = typeof madiExtras(node).occurrenceId === "string";
    stack.push({
      nodeIndex,
      children: node.children ?? [],
      childOccurrenceDepth: occurrenceDepth + (isOccurrence ? 1 : 0),
      cursor: 0,
    });
  };

  for (const root of activeRoots(document)) {
    enter(root, 0);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as TraversalFrame;
      const child = frame.children[frame.cursor];
      if (child === undefined) {
        visiting.delete(frame.nodeIndex);
        stack.pop();
        continue;
      }
      frame.cursor += 1;
      enter(child, frame.childOccurrenceDepth);
    }
  }
}

interface ProgressiveExtras {
  readonly record: JsonRecord;
  readonly path: "extras.naru.progressive" | "extras.madi.progressive";
}

/**
 * A package declares its progressive layout under `extras.naru.progressive`
 * (`naru.progressive-package.2`, ADR-0025) or, for the frozen legacy family,
 * `extras.madi.progressive` (ADR-0007). A `naru` block with any other schema
 * version fails closed; the legacy block is never consulted when it exists.
 */
function progressiveExtrasFor(document: CompiledGltfDocument): ProgressiveExtras | undefined {
  const naru = recordAt(recordAt(document.extras, "naru"), "progressive");
  if (naru) {
    if (naru.schemaVersion !== supportedProgressivePackageSchema) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `extras.naru.progressive.schemaVersion must be ${supportedProgressivePackageSchema}.`,
      );
    }
    return { record: naru, path: "extras.naru.progressive" };
  }
  const madi = recordAt(recordAt(document.extras, "madi"), "progressive");
  return madi ? { record: madi, path: "extras.madi.progressive" } : undefined;
}

function chunksFor(
  progressive: ProgressiveExtras | undefined,
  key: "targetChunks" | "reducedChunks",
  document: CompiledGltfDocument,
  targetBufferIndex: number,
  limits: CompiledPackageLimits,
): readonly CompiledTargetChunk[] {
  const level = key === "targetChunks" ? "target" : "reduced";
  const declared = progressive?.record[key];
  if (progressive === undefined || declared === undefined) return [];
  if (!Array.isArray(declared)) {
    throw new CompiledGltfError("INVALID_GLTF", `${progressive.path}.${key} must be an array.`);
  }
  assertWithinLimit(declared.length, limits.targetChunks, `${level} chunks`);
  const targetBuffer = document.buffers[targetBufferIndex];
  if (!targetBuffer) throw new CompiledGltfError("INVALID_GLTF", "Missing target buffer.");
  const ids = new Set<string>();
  const claimedMeshes = new Set<number>();
  const chunks = declared.map((value, chunkIndex) => {
    if (!isRecord(value)) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `${progressive.path}.${key}[${chunkIndex}] must be an object.`,
      );
    }
    const label = `${progressive.path}.${key}[${chunkIndex}]`;
    if (typeof value.id !== "string" || value.id.trim() === "" || ids.has(value.id)) {
      throw new CompiledGltfError("INVALID_GLTF", `${label}.id must be unique and non-empty.`);
    }
    ids.add(value.id);
    if (typeof value.prototypeId !== "string" || value.prototypeId.trim() === "") {
      throw new CompiledGltfError("INVALID_GLTF", `${label}.prototypeId must be non-empty.`);
    }
    const prototypeIds = value.prototypeIds === undefined
      ? [value.prototypeId]
      : stringArray(value.prototypeIds);
    if (
      prototypeIds.length === 0 ||
      prototypeIds.some((prototypeId) => prototypeId.trim() === "") ||
      new Set(prototypeIds).size !== prototypeIds.length ||
      prototypeIds[0] !== value.prototypeId
    ) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `${label}.prototypeIds must be unique, non-empty, and start with prototypeId.`,
      );
    }
    const buffer = finiteInteger(value.buffer, `${label}.buffer`, document.buffers.length);
    if (buffer !== targetBufferIndex) {
      throw new CompiledGltfError("INVALID_GLTF", `${label}.buffer must select the target buffer.`);
    }
    const byteOffset = finiteInteger(value.byteOffset, `${label}.byteOffset`);
    if (!Number.isInteger(value.byteLength) || (value.byteLength as number) <= 0) {
      throw new CompiledGltfError("INVALID_GLTF", `${label}.byteLength must be positive.`);
    }
    const byteLength = value.byteLength as number;
    if (byteOffset + byteLength > targetBuffer.byteLength) {
      throw new CompiledGltfError("INVALID_GLTF", `${label} exceeds the target buffer.`);
    }
    if (!Array.isArray(value.meshIndexes) || value.meshIndexes.length === 0) {
      throw new CompiledGltfError("INVALID_GLTF", `${label}.meshIndexes must not be empty.`);
    }
    let maxDeviationMeters: number | undefined;
    if (level === "target") {
      if (value.maxDeviationMeters !== undefined) {
        throw new CompiledGltfError(
          "INVALID_GLTF",
          `${label}.maxDeviationMeters must not be stated for the exact level.`,
        );
      }
    } else if (
      typeof value.maxDeviationMeters !== "number" ||
      !Number.isFinite(value.maxDeviationMeters) ||
      value.maxDeviationMeters <= 0
    ) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `${label}.maxDeviationMeters must state a positive deviation.`,
      );
    } else {
      maxDeviationMeters = value.maxDeviationMeters;
    }
    const meshIndexes = value.meshIndexes.map((meshIndex) => {
      const result = finiteInteger(meshIndex, `${label}.meshIndexes`, document.meshes.length);
      if (claimedMeshes.has(result)) {
        throw new CompiledGltfError(
          "INVALID_GLTF",
          `meshes[${result}] belongs to more than one ${level} chunk.`,
        );
      }
      claimedMeshes.add(result);
      return result;
    });
    return {
      id: value.id,
      buffer,
      byteOffset,
      byteLength,
      meshIndexes,
      prototypeIds,
      prototypeId: value.prototypeId,
      occurrenceCount: finiteInteger(value.occurrenceCount, `${label}.occurrenceCount`),
      priority: finiteInteger(value.priority, `${label}.priority`),
      ...(maxDeviationMeters === undefined ? {} : { maxDeviationMeters }),
    };
  });
  return chunks.sort(
    (left, right) => left.priority - right.priority || left.id.localeCompare(right.id, "en"),
  );
}

function propertiesRefFor(rootMadi: JsonRecord): CompiledPropertiesRef | undefined {
  if (rootMadi.properties === undefined) return undefined;
  const properties = recordAt(rootMadi, "properties");
  if (
    !properties ||
    typeof properties.schemaVersion !== "string" ||
    properties.schemaVersion.trim() === "" ||
    typeof properties.uri !== "string" ||
    properties.uri.trim() === "" ||
    !Number.isInteger(properties.byteLength) ||
    (properties.byteLength as number) <= 0 ||
    typeof properties.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(properties.sha256)
  ) {
    throw new CompiledGltfError(
      "INVALID_GLTF",
      "extras.madi.properties must carry schemaVersion, uri, byteLength, and sha256.",
    );
  }
  return {
    schemaVersion: properties.schemaVersion,
    uri: properties.uri,
    byteLength: properties.byteLength as number,
    sha256: properties.sha256,
  };
}

/**
 * Reads the reduced level's error statement, refusing chunks without one.
 *
 * The whole point of the level is that its deviation is measured rather than
 * assumed, so a package that ships reduced chunks and no bound is malformed:
 * accepting it would leave a viewer to invent the number the record exists to
 * state.
 */
function reducedLodRefFor(
  progressive: ProgressiveExtras | undefined,
  reducedChunkCount: number,
): CompiledReducedLodRef | undefined {
  const reducedLod = progressive ? recordAt(progressive.record, "reducedLod") : undefined;
  if (!reducedLod) {
    if (reducedChunkCount === 0) return undefined;
    throw new CompiledGltfError(
      "INVALID_GLTF",
      `${progressive?.path ?? "progressive"}.reducedLod must state the deviation its reduced chunks stay within.`,
    );
  }
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  if (
    typeof reducedLod.method !== "string" ||
    reducedLod.method.trim() === "" ||
    !positive(reducedLod.maxDeviationMeters) ||
    !positive(reducedLod.requestedToleranceMeters)
  ) {
    throw new CompiledGltfError(
      "INVALID_GLTF",
      `${progressive?.path ?? "progressive"}.reducedLod must carry a method, a positive requestedToleranceMeters, and a positive maxDeviationMeters.`,
    );
  }
  return {
    method: reducedLod.method,
    requestedToleranceMeters: reducedLod.requestedToleranceMeters,
    maxDeviationMeters: reducedLod.maxDeviationMeters,
  };
}

function spatialIndexRefFor(progressive: ProgressiveExtras | undefined): CompiledSpatialIndexRef | undefined {
  if (progressive?.record.spatialIndex === undefined) return undefined;
  const spatialIndex = recordAt(progressive.record, "spatialIndex");
  if (
    !spatialIndex ||
    spatialIndex.schemaVersion !== supportedSpatialDemandIndexSchema ||
    typeof spatialIndex.uri !== "string" ||
    spatialIndex.uri.trim() === "" ||
    !Number.isInteger(spatialIndex.byteLength) ||
    (spatialIndex.byteLength as number) <= 0 ||
    typeof spatialIndex.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(spatialIndex.sha256)
  ) {
    throw new CompiledGltfError(
      "INVALID_GLTF",
      `${progressive.path}.spatialIndex must use ${supportedSpatialDemandIndexSchema} and carry uri, byteLength, and sha256.`,
    );
  }
  return {
    schemaVersion: supportedSpatialDemandIndexSchema,
    uri: spatialIndex.uri,
    byteLength: spatialIndex.byteLength as number,
    sha256: spatialIndex.sha256,
  };
}

/**
 * Reads the relocated-hierarchy pointer without building the assembly tree.
 *
 * A loader has to fetch the sidecar before it can ask for the tree, and the
 * tree API refuses to answer without it -- so the pointer is readable on its
 * own. Only the pointer is validated here; the document itself is validated
 * when the tree is read.
 */
export function readCompiledHierarchyRef(value: unknown): CompiledHierarchyRef | undefined {
  const extras = recordAt(value, "extras");
  const rootMadi = recordAt(extras, "madi");
  return rootMadi ? hierarchyRefFor(rootMadi) : undefined;
}

function hierarchyRefFor(rootMadi: JsonRecord): CompiledHierarchyRef | undefined {
  if (rootMadi.hierarchy === undefined) return undefined;
  const hierarchy = recordAt(rootMadi, "hierarchy");
  if (
    !hierarchy ||
    hierarchy.schemaVersion !== supportedPackageHierarchySchema ||
    typeof hierarchy.uri !== "string" ||
    hierarchy.uri.trim() === "" ||
    !Number.isInteger(hierarchy.byteLength) ||
    (hierarchy.byteLength as number) <= 0 ||
    typeof hierarchy.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(hierarchy.sha256) ||
    !Number.isInteger(hierarchy.entryCount) ||
    (hierarchy.entryCount as number) < 0 ||
    !Number.isInteger(hierarchy.relocatedCount) ||
    (hierarchy.relocatedCount as number) < 0
  ) {
    throw new CompiledGltfError(
      "INVALID_GLTF",
      `extras.madi.hierarchy must use ${supportedPackageHierarchySchema} and carry uri, byteLength, sha256, entryCount, and relocatedCount.`,
    );
  }
  return {
    schemaVersion: supportedPackageHierarchySchema,
    uri: hierarchy.uri,
    byteLength: hierarchy.byteLength as number,
    sha256: hierarchy.sha256,
    entryCount: hierarchy.entryCount as number,
    relocatedCount: hierarchy.relocatedCount as number,
  };
}

/**
 * Rebuilds the assembly tree a relocated package cannot express on its own.
 *
 * The document keeps only the nodes that draw something, and relocation
 * flattens those to scene roots, so document traversal reports depth 0 for
 * every one of them. The sidecar therefore owns both the order and the depth
 * of every entry, and the document contributes what only it knows: whether a
 * node draws, and the name and identity it serialized.
 */
function mergedHierarchyEntries(
  document: CompiledGltfDocument,
  documentEntries: readonly CompiledHierarchyEntry[],
  ref: CompiledHierarchyRef,
  sidecar: DecodedPackageHierarchy,
  derivation: NodeIdentityDerivation,
): readonly CompiledHierarchyEntry[] {
  if (sidecar.documentNodeCount !== document.nodes.length) {
    throw new PackageHierarchyError(
      "INVALID_HIERARCHY",
      "The hierarchy sidecar was built for a document with a different node count.",
    );
  }
  if (sidecar.entries.length !== ref.entryCount || sidecar.relocatedCount !== ref.relocatedCount) {
    throw new PackageHierarchyError(
      "INVALID_HIERARCHY",
      "The hierarchy sidecar does not hold the entries the document declares.",
    );
  }
  const byNodeIndex = new Map(documentEntries.map((entry) => [entry.nodeIndex, entry]));
  const entries: CompiledHierarchyEntry[] = [];
  // Relocated entries have no node, but the Studio keys rows, selection, and
  // search by `nodeIndex`; indexes past the document keep that key unique
  // without pretending the entry can be looked up in the node array.
  let syntheticNodeIndex = document.nodes.length;
  const seen = new Set<number>();
  for (const entry of sidecar.entries) {
    if (entry.relocated) {
      const { relocated } = entry;
      const identity = resolveNodeIdentity(
        {
          occurrenceId: relocated.occurrenceId,
          prototypeId: relocated.prototypeId,
          ...("semanticId" in relocated ? { semanticId: relocated.semanticId } : {}),
          ...("sourceRef" in relocated ? { sourceRef: relocated.sourceRef } : {}),
        },
        derivation,
      );
      entries.push({
        nodeIndex: syntheticNodeIndex,
        name: relocated.name,
        depth: entry.depth,
        renderable: false,
        occurrenceId: relocated.occurrenceId,
        prototypeId: relocated.prototypeId,
        ...identity,
      });
      syntheticNodeIndex += 1;
      continue;
    }
    const retained = entry.nodeIndex === undefined ? undefined : byNodeIndex.get(entry.nodeIndex);
    if (!retained || seen.has(retained.nodeIndex)) {
      throw new PackageHierarchyError(
        "INVALID_HIERARCHY",
        "The hierarchy sidecar names a document node the active scene does not carry.",
      );
    }
    seen.add(retained.nodeIndex);
    entries.push({ ...retained, depth: entry.depth });
  }
  if (seen.size !== documentEntries.length) {
    throw new PackageHierarchyError(
      "INVALID_HIERARCHY",
      "The hierarchy sidecar leaves document occurrences out of the assembly tree.",
    );
  }
  return entries;
}

export function inspectCompiledHierarchy(
  value: unknown,
  options: CompiledPackageOptions = {},
): {
  readonly document: CompiledGltfDocument;
  readonly hierarchy: CompiledHierarchy;
} {
  const limits = resolveCompiledPackageLimits(options.limits);
  const document = parseCompiledGltf(value, options);
  const rootMadi = recordAt(document.extras, "madi") ?? {};
  const progressive = progressiveExtrasFor(document);
  const targetBufferIndex = progressive
    ? finiteInteger(
        progressive.record.targetBuffer,
        `${progressive.path}.targetBuffer`,
        document.buffers.length,
      )
    : 0;
  const coarseBufferIndex = progressive
    ? finiteInteger(
        progressive.record.coarseBuffer,
        `${progressive.path}.coarseBuffer`,
        document.buffers.length,
      )
    : undefined;
  const targetChunks = chunksFor(progressive, "targetChunks", document, targetBufferIndex, limits);
  const reducedChunks = chunksFor(progressive, "reducedChunks", document, targetBufferIndex, limits);
  const derivation = nodeIdentityDerivationFrom(rootMadi);
  const relocatedHierarchy = hierarchyRefFor(rootMadi);
  const documentEntries: CompiledHierarchyEntry[] = [];
  const renderedMeshes = new Set<number>();

  traverseActiveNodes(
    document,
    (node, nodeIndex, depth) => {
      const madi = madiExtras(node);
      if (typeof madi.occurrenceId !== "string") return;
      const identity = resolveNodeIdentity(madi, derivation);
      if (node.mesh !== undefined) renderedMeshes.add(node.mesh);
      documentEntries.push({
        nodeIndex,
        name: node.name ?? madi.occurrenceId,
        depth,
        renderable: node.mesh !== undefined,
        occurrenceId: madi.occurrenceId,
        prototypeId: typeof madi.prototypeId === "string" ? madi.prototypeId : "unknown",
        ...identity,
      });
    },
    limits,
  );

  // Fail closed: a package that declares a sidecar has no complete tree in the
  // document, so reporting the nodes that stayed behind would silently answer a
  // different question than the caller asked. A caller that says it is decoding
  // geometry only gets no tree at all instead, which cannot be misread.
  const sidecar = options.hierarchy === "geometry-only" ? undefined : options.hierarchy;
  if (relocatedHierarchy && !sidecar && options.hierarchy !== "geometry-only") {
    throw new PackageHierarchyError(
      "INVALID_HIERARCHY",
      "The package declares a relocated hierarchy; its sidecar must be supplied to read the assembly tree.",
    );
  }
  const entries = !relocatedHierarchy
    ? documentEntries
    : sidecar
      ? mergedHierarchyEntries(
          document,
          documentEntries,
          relocatedHierarchy,
          decodePackageHierarchy(sidecar.json, sidecar.columns, { maxEntries: limits.nodes }),
          derivation,
        )
      : [];

  const documents = Array.isArray(rootMadi.documents) ? rootMadi.documents : [];
  const source = documents.find(isRecord);
  const format = typeof source?.format === "string" ? source.format : "source";
  const formatVersion =
    typeof source?.formatVersion === "string" ? source.formatVersion : undefined;
  const buffer = document.buffers[targetBufferIndex];
  if (!buffer) throw new CompiledGltfError("INVALID_GLTF", "Missing glTF buffer.");
  const coarseBuffer = coarseBufferIndex === undefined
    ? undefined
    : document.buffers[coarseBufferIndex];
  const properties = propertiesRefFor(rootMadi);
  const spatialIndex = spatialIndexRefFor(progressive);
  const reducedLod = reducedLodRefFor(progressive, reducedChunks.length);
  if (
    targetChunks.length > 0 &&
    [...renderedMeshes].some(
      (meshIndex) => !targetChunks.some((chunk) => chunk.meshIndexes.includes(meshIndex)),
    )
  ) {
    throw new CompiledGltfError(
      "INVALID_GLTF",
      "Progressive target chunks do not cover every renderable target mesh.",
    );
  }

  return {
    document,
    hierarchy: {
      profile: supportedProfile,
      nodeCount: document.nodes.length,
      sceneId:
        typeof rootMadi.sceneId === "string"
          ? rootMadi.sceneId
          : document.scenes[document.scene ?? 0]?.name ?? "compiled-scene",
      sourceFormat: formatVersion ?? format,
      binaryUri: buffer.uri,
      binaryByteLength: buffer.byteLength,
      ...(coarseBuffer
        ? {
            coarseBinaryUri: coarseBuffer.uri,
            coarseBinaryByteLength: coarseBuffer.byteLength,
          }
        : {}),
      ...(properties ? { properties } : {}),
      ...(relocatedHierarchy ? { relocatedHierarchy } : {}),
      ...(spatialIndex ? { spatialIndex } : {}),
      targetChunks,
      reducedChunks,
      ...(reducedLod ? { reducedLod } : {}),
      entries,
      // Relocation moves only the nodes that draw nothing, so the document
      // always holds every renderable occurrence -- including when the tree
      // above was left empty on purpose.
      renderableOccurrences: documentEntries.filter(({ renderable }) => renderable).length,
      sharedMeshes: renderedMeshes.size,
    },
  };
}

function multiplyMatrices(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const result = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) {
        value += (a[index * 4 + row] ?? 0) * (b[column * 4 + index] ?? 0);
      }
      result[column * 4 + row] = value;
    }
  }
  return result;
}

function transformPoint(
  matrix: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] {
  return [
    (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0),
    (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0),
    (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0),
  ];
}

class BinaryAccessors {
  readonly document: CompiledGltfDocument;
  readonly binary: ArrayBuffer;
  readonly bufferIndex: number;
  readonly baseByteOffset: number;
  private readonly data: DataView;

  constructor(
    document: CompiledGltfDocument,
    binary: ArrayBuffer,
    bufferIndex: number,
    range?: { readonly byteOffset: number; readonly byteLength: number },
  ) {
    const resource = document.buffers[bufferIndex];
    const expected = range?.byteLength ?? resource?.byteLength;
    const baseByteOffset = range?.byteOffset ?? 0;
    if (
      expected === undefined ||
      binary.byteLength !== expected ||
      !resource ||
      baseByteOffset + expected > resource.byteLength
    ) {
      throw new CompiledGltfError(
        "INVALID_BINARY",
        `${resource?.uri ?? `buffer ${bufferIndex}`} byteLength must be ${String(expected)}; ` +
          `received ${binary.byteLength}.`,
      );
    }
    this.document = document;
    this.binary = binary;
    this.bufferIndex = bufferIndex;
    this.baseByteOffset = baseByteOffset;
    this.data = new DataView(binary);
  }

  float32Vec3(accessorIndex: number, label: string): Float32Array {
    const layout = this.layout(accessorIndex, 5126, "VEC3", label);
    const result = new Float32Array(layout.count * 3);
    for (let item = 0; item < layout.count; item += 1) {
      for (let component = 0; component < 3; component += 1) {
        result[item * 3 + component] = this.data.getFloat32(
          layout.start + item * layout.stride + component * 4,
          true,
        );
      }
    }
    return result;
  }

  uint32Scalar(accessorIndex: number, label: string): Uint32Array {
    const layout = this.layout(accessorIndex, 5125, "SCALAR", label);
    const result = new Uint32Array(layout.count);
    for (let item = 0; item < layout.count; item += 1) {
      result[item] = this.data.getUint32(layout.start + item * layout.stride, true);
    }
    return result;
  }

  private layout(
    accessorIndex: number,
    componentType: number,
    type: string,
    label: string,
  ): { readonly start: number; readonly stride: number; readonly count: number } {
    finiteInteger(accessorIndex, `${label} accessor`, this.document.accessors.length);
    const accessor = this.document.accessors[accessorIndex];
    if (!accessor || accessor.componentType !== componentType || accessor.type !== type) {
      throw new CompiledGltfError(
        "UNSUPPORTED_GEOMETRY",
        `${label} must use ${type} component type ${componentType}.`,
      );
    }
    if (!Number.isInteger(accessor.count) || accessor.count <= 0 || accessor.normalized) {
      throw new CompiledGltfError("INVALID_GLTF", `${label} accessor metadata is invalid.`);
    }
    finiteInteger(accessor.bufferView, `${label} bufferView`, this.document.bufferViews.length);
    const bufferView = this.document.bufferViews[accessor.bufferView];
    if (!bufferView || bufferView.buffer !== this.bufferIndex) {
      throw new CompiledGltfError(
        "UNSUPPORTED_GEOMETRY",
        `${label} must use the selected geometry buffer ${this.bufferIndex}.`,
      );
    }
    const components = type === "VEC3" ? 3 : 1;
    const elementBytes = components * 4;
    const stride = bufferView.byteStride ?? elementBytes;
    const viewStart = bufferView.byteOffset ?? 0;
    const absoluteStart = viewStart + (accessor.byteOffset ?? 0);
    const absoluteEnd = absoluteStart + (accessor.count - 1) * stride + elementBytes;
    const viewEnd = viewStart + bufferView.byteLength;
    const rangeEnd = this.baseByteOffset + this.binary.byteLength;
    if (
      !Number.isInteger(viewStart) ||
      !Number.isInteger(bufferView.byteLength) ||
      !Number.isInteger(absoluteStart) ||
      !Number.isInteger(stride) ||
      absoluteStart < viewStart ||
      stride < elementBytes ||
      absoluteEnd > viewEnd ||
      absoluteStart < this.baseByteOffset ||
      absoluteEnd > rangeEnd
    ) {
      throw new CompiledGltfError(
        "INVALID_BINARY",
        `${label} accessor exceeds ${this.document.buffers[this.bufferIndex]?.uri ?? "binary"}.`,
      );
    }
    return {
      start: absoluteStart - this.baseByteOffset,
      stride,
      count: accessor.count,
    };
  }
}

function interleaveSurface(positions: Float32Array, normals?: Float32Array): Float32Array {
  if (normals && normals.length !== positions.length) {
    throw new CompiledGltfError(
      "INVALID_GLTF",
      "Surface POSITION and NORMAL accessors must have equal counts.",
    );
  }
  const result = new Float32Array((positions.length / 3) * 6);
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const source = vertex * 3;
    const target = vertex * 6;
    result[target] = positions[source] ?? 0;
    result[target + 1] = positions[source + 1] ?? 0;
    result[target + 2] = positions[source + 2] ?? 0;
    result[target + 3] = normals?.[source] ?? 0;
    result[target + 4] = normals?.[source + 1] ?? 1;
    result[target + 5] = normals?.[source + 2] ?? 0;
  }
  return result;
}

function expandEdges(positions: Float32Array, indices: Uint32Array): Float32Array {
  if (indices.length % 2 !== 0) {
    throw new CompiledGltfError("INVALID_GLTF", "CAD edge indices must contain line pairs.");
  }
  const result = new Float32Array(indices.length * 3);
  indices.forEach((vertexIndex, indexOffset) => {
    const source = vertexIndex * 3;
    if (source + 2 >= positions.length) {
      throw new CompiledGltfError(
        "INVALID_BINARY",
        `CAD edge vertex index ${vertexIndex} is out of range.`,
      );
    }
    const target = indexOffset * 3;
    result[target] = positions[source] ?? 0;
    result[target + 1] = positions[source + 1] ?? 0;
    result[target + 2] = positions[source + 2] ?? 0;
  });
  return result;
}

function surfaceColor(
  document: CompiledGltfDocument,
  primitive: CompiledGltfPrimitive,
): readonly [number, number, number, number] {
  const material =
    primitive.material === undefined ? undefined : document.materials[primitive.material];
  const value = material?.pbrMetallicRoughness?.baseColorFactor;
  return value?.length === 4 && value.every(Number.isFinite)
    ? [value[0] ?? 0.55, value[1] ?? 0.62, value[2] ?? 0.68, value[3] ?? 1]
    : [0.55, 0.62, 0.68, 1];
}

interface DecodedSurfaceGeometry {
  readonly surfaceVertices: Float32Array;
  readonly surfaceIndices: Uint32Array;
  readonly bounds: SceneBounds;
  readonly color: readonly [number, number, number, number];
  readonly primitiveIndex: number;
}

function positionBounds(positions: Float32Array): SceneBounds {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[offset + axis];
      if (value === undefined || !Number.isFinite(value)) {
        throw new CompiledGltfError("INVALID_BINARY", "Surface position is not finite.");
      }
      minimum[axis] = Math.min(minimum[axis] ?? Infinity, value);
      maximum[axis] = Math.max(maximum[axis] ?? -Infinity, value);
    }
  }
  return { min: minimum, max: maximum };
}

/**
 * Identifies the vertex pool a surface primitive reads. Material groups of one
 * prototype reference the same POSITION/NORMAL accessors, and the compiler
 * stores that pool once, so decoding it once per pair reproduces the packaged
 * layout instead of one copy per material.
 */
function vertexPoolKey(primitive: CompiledGltfPrimitive): string {
  return `${String(primitive.attributes.POSITION)}:${String(primitive.attributes.NORMAL)}`;
}

interface DecodedVertexPool {
  /** Interleaved position.xyz + normal.xyz values, shared by sibling batches. */
  readonly vertices: Float32Array;
  readonly vertexCount: number;
  readonly bounds: SceneBounds;
}

interface DecodedMeshGeometry {
  readonly surfaces: readonly DecodedSurfaceGeometry[];
  readonly edgeVertices: Float32Array;
  readonly edgeSourceRefs: readonly string[];
}

interface PreparedRenderableNode {
  readonly ordinal: number;
  readonly nodeIndex: number;
  readonly targetMeshIndex: number;
  readonly coarseMeshIndex?: number;
  readonly reducedMeshIndex?: number;
  readonly worldTransform: Float64Array;
  readonly label: string;
  readonly occurrenceId: string;
  readonly prototypeId?: string;
  readonly semanticId?: string;
  readonly sourceRef?: string;
}

interface PreparedCompiledGltfState {
  readonly document: CompiledGltfDocument;
  readonly hierarchy: CompiledHierarchy;
  readonly targetChunkResidencyCosts: ReadonlyMap<string, ResidencyCost>;
  readonly activeNodeCount: number;
  readonly renderableNodes: readonly PreparedRenderableNode[];
  readonly renderableNodesByTargetChunk: ReadonlyMap<
    string,
    readonly PreparedRenderableNode[]
  >;
  readonly targetChunksById: ReadonlyMap<string, CompiledTargetChunk>;
  readonly renderableNodesByReducedChunk: ReadonlyMap<
    string,
    readonly PreparedRenderableNode[]
  >;
  readonly reducedChunksById: ReadonlyMap<string, CompiledTargetChunk>;
}

interface SelectedMeshPrimitives {
  readonly surfaces: readonly {
    readonly primitive: CompiledGltfPrimitive;
    readonly primitiveIndex: number;
  }[];
  /** At most one LINES primitive, whose vertices attach to the first surface. */
  readonly edge?: CompiledGltfPrimitive;
}

/**
 * The batch decomposition of one mesh. Decoding and pre-fetch measurement both
 * read it, so a batch can never be measured under one rule and decoded under
 * another.
 */
function selectMeshPrimitives(
  mesh: CompiledGltfMesh,
  meshIndex: number,
): SelectedMeshPrimitives {
  // `Array.isArray` narrows a `readonly T[]` to `any[]`, so the element type is
  // restored explicitly once the shape is known.
  const declaredPrimitives: unknown = mesh.primitives;
  if (!Array.isArray(declaredPrimitives)) {
    throw new CompiledGltfError("INVALID_GLTF", `meshes[${meshIndex}].primitives is missing.`);
  }
  const primitives = declaredPrimitives as readonly CompiledGltfPrimitive[];
  for (const [primitiveIndex, primitive] of primitives.entries()) {
    // Selection reads `mode` off every element, so each one has to be an object
    // before the two filters below can run at all.
    if (!isRecord(primitive)) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `meshes[${meshIndex}].primitives[${primitiveIndex}] is not an object.`,
      );
    }
  }
  const indexed = primitives.map((primitive, primitiveIndex) => ({ primitive, primitiveIndex }));
  const surfaces = indexed.filter(({ primitive }) => (primitive.mode ?? 4) === 4);
  const edges = indexed.filter(({ primitive }) => primitive.mode === 1);
  if (surfaces.length === 0 || edges.length > 1) {
    throw new CompiledGltfError(
      "UNSUPPORTED_GEOMETRY",
      `meshes[${meshIndex}] must contain TRIANGLES primitives and at most one LINES primitive.`,
    );
  }
  // Batch measurement and both decode paths read `attributes.POSITION` off a
  // selected primitive without a further guard, so the shape is settled once
  // here instead of at four call sites. A primitive neither filter selected is
  // never dereferenced, so it is left alone rather than made a rejection.
  for (const { primitive, primitiveIndex } of [...surfaces, ...edges]) {
    if (!isRecord(primitive.attributes)) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `meshes[${meshIndex}].primitives[${primitiveIndex}] must declare attributes.`,
      );
    }
  }
  return { surfaces, ...(edges[0] ? { edge: edges[0].primitive } : {}) };
}

/** Element count of one accessor, without reading the bytes it describes. */
function accessorItemCount(
  document: CompiledGltfDocument,
  accessorIndex: number | undefined,
  label: string,
): number {
  finiteInteger(accessorIndex, `${label} accessor`, document.accessors.length);
  const accessor = document.accessors[accessorIndex as number];
  if (!accessor || !Number.isInteger(accessor.count) || accessor.count <= 0) {
    throw new CompiledGltfError("INVALID_GLTF", `${label} accessor metadata is invalid.`);
  }
  return accessor.count;
}

/**
 * Residency cost of one mesh's batches, derived from accessor counts alone.
 * `decodeMesh` interleaves POSITION with NORMAL into six floats per vertex,
 * reads surface indices as u32, and expands each edge index into a full
 * position, so every decoded length is a fixed multiple of a declared count.
 */
function measureMeshBatches(
  document: CompiledGltfDocument,
  mesh: CompiledGltfMesh,
  meshIndex: number,
  instanceCount: number,
): ResidencyCost {
  const { surfaces, edge } = selectMeshPrimitives(mesh, meshIndex);
  const edgeVertexBytes = edge
    ? accessorItemCount(document, edge.indices, `meshes[${meshIndex}] edge indices`) * 3 * 4
    : 0;
  // `decodeMesh` decodes one vertex pool per attribute pair and hands the same
  // array to every material group that references it, so the pool is charged
  // to the first group alone -- exactly as the decoded batches then charge it.
  const chargedPools = new Set<string>();
  let cost: ResidencyCost = { decodedBytes: 0, gpuBytes: 0 };
  surfaces.forEach(({ primitive, primitiveIndex }, order) => {
    const label = `meshes[${meshIndex}].primitives[${primitiveIndex}]`;
    const poolKey = vertexPoolKey(primitive);
    const sharesSurfaceVertices = chargedPools.has(poolKey);
    chargedPools.add(poolKey);
    cost = addResidencyCost(
      cost,
      batchResidencyCost({
        surfaceVertexBytes:
          accessorItemCount(document, primitive.attributes.POSITION, `${label} POSITION`) * 6 * 4,
        surfaceIndexBytes:
          accessorItemCount(document, primitive.indices, `${label} surface indices`) * 4,
        edgeVertexBytes: order === 0 ? edgeVertexBytes : 0,
        instanceCount,
        sharesSurfaceVertices,
      }),
    );
  });
  return cost;
}

/**
 * Residency cost of every chunk of one level, known before any range is
 * fetched. Reduced chunks are priced by the same formula as target chunks.
 */
function measureChunks(
  document: CompiledGltfDocument,
  chunks: readonly CompiledTargetChunk[],
  renderableNodesByChunk: ReadonlyMap<string, readonly PreparedRenderableNode[]>,
  meshIndexOf: (node: PreparedRenderableNode) => number,
  costs: Map<string, ResidencyCost>,
): void {
  for (const chunk of chunks) {
    const occurrencesByMesh = new Map<number, number>();
    for (const node of renderableNodesByChunk.get(chunk.id) ?? []) {
      const meshIndex = meshIndexOf(node);
      occurrencesByMesh.set(meshIndex, (occurrencesByMesh.get(meshIndex) ?? 0) + 1);
    }
    let cost: ResidencyCost = { decodedBytes: 0, gpuBytes: 0 };
    for (const [meshIndex, instanceCount] of occurrencesByMesh) {
      const mesh = document.meshes[meshIndex];
      if (!mesh) throw new CompiledGltfError("INVALID_GLTF", `Missing meshes[${meshIndex}].`);
      // A mesh belongs to exactly one chunk, so no cost is measured twice.
      cost = addResidencyCost(
        cost,
        measureMeshBatches(document, mesh, meshIndex, instanceCount),
      );
    }
    costs.set(chunk.id, cost);
  }
}

function decodeMesh(
  document: CompiledGltfDocument,
  accessors: BinaryAccessors,
  mesh: CompiledGltfMesh,
  meshIndex: number,
): DecodedMeshGeometry {
  const { surfaces, edge } = selectMeshPrimitives(mesh, meshIndex);
  // One prototype's material groups index a single vertex pool that the
  // package stores once. Decoding it per group copied it per material -- the
  // largest sixty5 prototype has 111 groups over one 673 KB pool, so its
  // batches cost 75 MB instead of 1.3 MB. Sibling batches share one array.
  const vertexPools = new Map<string, DecodedVertexPool>();
  const decodedSurfaces = surfaces.map(({ primitive: surface, primitiveIndex }) => {
    if (surface.indices === undefined) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `meshes[${meshIndex}].primitives[${primitiveIndex}] surface is not indexed.`,
      );
    }
    const positionAccessor = surface.attributes.POSITION;
    if (positionAccessor === undefined) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `meshes[${meshIndex}].primitives[${primitiveIndex}] has no POSITION accessor.`,
      );
    }
    const poolKey = vertexPoolKey(surface);
    let pool = vertexPools.get(poolKey);
    if (!pool) {
      const positions = accessors.float32Vec3(
        positionAccessor,
        `meshes[${meshIndex}].primitives[${primitiveIndex}] POSITION`,
      );
      const normals =
        surface.attributes.NORMAL === undefined
          ? undefined
          : accessors.float32Vec3(
              surface.attributes.NORMAL,
              `meshes[${meshIndex}].primitives[${primitiveIndex}] NORMAL`,
            );
      pool = {
        vertices: interleaveSurface(positions, normals),
        vertexCount: positions.length / 3,
        bounds: positionBounds(positions),
      };
      vertexPools.set(poolKey, pool);
    }
    const surfaceIndices = accessors.uint32Scalar(
      surface.indices,
      `meshes[${meshIndex}].primitives[${primitiveIndex}] surface indices`,
    );
    if (surfaceIndices.length % 3 !== 0) {
      throw new CompiledGltfError("INVALID_GLTF", "Surface indices must contain triangles.");
    }
    for (const index of surfaceIndices) {
      if (index >= pool.vertexCount) {
        throw new CompiledGltfError(
          "INVALID_BINARY",
          `Surface vertex index ${index} is out of range.`,
        );
      }
    }
    return {
      surfaceVertices: pool.vertices,
      surfaceIndices,
      bounds: pool.bounds,
      color: surfaceColor(document, surface),
      primitiveIndex,
    };
  });

  let edgeVertices: Float32Array<ArrayBufferLike> = new Float32Array();
  let edgeSourceRefs: readonly string[] = [];
  if (edge) {
    const edgePositionAccessor = edge.attributes.POSITION;
    if (edgePositionAccessor === undefined || edge.indices === undefined) {
      throw new CompiledGltfError("INVALID_GLTF", `meshes[${meshIndex}] edge stream is incomplete.`);
    }
    const edgePositions = accessors.float32Vec3(
      edgePositionAccessor,
      `meshes[${meshIndex}] edge POSITION`,
    );
    const edgeIndices = accessors.uint32Scalar(
      edge.indices,
      `meshes[${meshIndex}] edge indices`,
    );
    edgeVertices = expandEdges(edgePositions, edgeIndices);
    const edgeMadi = recordAt(edge.extras, "madi") ?? {};
    const sourceRefs = stringArray(edgeMadi.sourceRefs);
    if (Number.isInteger(edgeMadi.edgeSourceAccessor)) {
      const sourceIds = accessors.uint32Scalar(
        edgeMadi.edgeSourceAccessor as number,
        `meshes[${meshIndex}] edge source IDs`,
      );
      edgeSourceRefs = [
        ...new Set(
          Array.from(sourceIds, (sourceId) => {
            const sourceRef = sourceRefs[sourceId];
            if (sourceRef === undefined) {
              throw new CompiledGltfError(
                "INVALID_BINARY",
                `CAD edge source ID ${sourceId} is out of range.`,
              );
            }
            return sourceRef;
          }),
        ),
      ];
    } else {
      edgeSourceRefs = sourceRefs.filter((sourceRef) => sourceRef.includes(":edge:"));
    }
  }

  return {
    surfaces: decodedSurfaces,
    edgeVertices,
    edgeSourceRefs,
  };
}

function prepareCompiledGltfState(
  value: unknown,
  options: CompiledPackageOptions,
): PreparedCompiledGltfState {
  // Inspection already bounded this node graph's depth, so the transform walk
  // below recurses over an already-limited tree.
  const { document, hierarchy } = inspectCompiledHierarchy(value, options);
  const derivation = nodeIdentityDerivationFrom(recordAt(document.extras, "madi") ?? {});
  const renderableNodes: PreparedRenderableNode[] = [];
  const renderableNodesByTargetMesh = new Map<number, PreparedRenderableNode[]>();
  let activeNodeCount = 0;

  const traverse = (
    nodeIndex: number,
    parentTransform: ArrayLike<number>,
    activePath: Set<number>,
  ): void => {
    if (activePath.has(nodeIndex)) {
      throw new CompiledGltfError("INVALID_GLTF", `Cycle detected at nodes[${nodeIndex}].`);
    }
    const node = document.nodes[nodeIndex];
    if (!node) throw new CompiledGltfError("INVALID_GLTF", `Missing nodes[${nodeIndex}].`);
    activeNodeCount += 1;
    const path = new Set(activePath).add(nodeIndex);
    const worldTransform = multiplyMatrices(parentTransform, matrixFor(node, nodeIndex));

    if (node.mesh !== undefined) {
      const targetMeshIndex = node.mesh;
      const nodeMadi = madiExtras(node);
      const identity = resolveNodeIdentity(nodeMadi, derivation);
      const occurrenceId =
        typeof nodeMadi.occurrenceId === "string"
          ? nodeMadi.occurrenceId
          : `gltf-node:${nodeIndex}`;
      const prepared: PreparedRenderableNode = {
        ordinal: renderableNodes.length,
        nodeIndex,
        targetMeshIndex,
        ...(nodeMadi.coarseMesh === undefined
          ? {}
          : {
              coarseMeshIndex: finiteInteger(
                nodeMadi.coarseMesh,
                `nodes[${nodeIndex}].extras.madi.coarseMesh`,
                document.meshes.length,
              ),
            }),
        ...(nodeMadi.reducedMesh === undefined
          ? {}
          : {
              reducedMeshIndex: finiteInteger(
                nodeMadi.reducedMesh,
                `nodes[${nodeIndex}].extras.madi.reducedMesh`,
                document.meshes.length,
              ),
            }),
        worldTransform,
        label: node.name ?? occurrenceId,
        occurrenceId,
        ...(typeof nodeMadi.prototypeId === "string"
          ? { prototypeId: nodeMadi.prototypeId }
          : {}),
        ...identity,
      };
      renderableNodes.push(prepared);
      const meshNodes = renderableNodesByTargetMesh.get(targetMeshIndex) ?? [];
      meshNodes.push(prepared);
      renderableNodesByTargetMesh.set(targetMeshIndex, meshNodes);
    }

    for (const child of node.children ?? []) traverse(child, worldTransform, path);
  };

  for (const root of activeRoots(document)) traverse(root, identityMatrix, new Set());

  const indexChunks = (
    chunks: readonly CompiledTargetChunk[],
    nodesByMesh: ReadonlyMap<number, readonly PreparedRenderableNode[]>,
  ) => {
    const nodesByChunk = new Map<string, readonly PreparedRenderableNode[]>();
    const chunksById = new Map<string, CompiledTargetChunk>();
    for (const chunk of chunks) {
      chunksById.set(chunk.id, chunk);
      nodesByChunk.set(
        chunk.id,
        chunk.meshIndexes
          .flatMap((meshIndex) => nodesByMesh.get(meshIndex) ?? [])
          .sort((left, right) => left.ordinal - right.ordinal),
      );
    }
    return { nodesByChunk, chunksById };
  };
  const target = indexChunks(hierarchy.targetChunks, renderableNodesByTargetMesh);
  // Reduced chunks list reduced mesh indexes; nodes reach them through
  // `extras.madi.reducedMesh`, so index the nodes by that mesh first.
  const renderableNodesByReducedMesh = new Map<number, PreparedRenderableNode[]>();
  for (const prepared of renderableNodes) {
    if (prepared.reducedMeshIndex === undefined) continue;
    const meshNodes = renderableNodesByReducedMesh.get(prepared.reducedMeshIndex) ?? [];
    meshNodes.push(prepared);
    renderableNodesByReducedMesh.set(prepared.reducedMeshIndex, meshNodes);
  }
  const reduced = indexChunks(hierarchy.reducedChunks, renderableNodesByReducedMesh);
  for (const chunkId of reduced.chunksById.keys()) {
    if (target.chunksById.has(chunkId)) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `Chunk ${chunkId} is declared as both a target and a reduced chunk.`,
      );
    }
  }

  const targetChunkResidencyCosts = new Map<string, ResidencyCost>();
  measureChunks(
    document,
    hierarchy.targetChunks,
    target.nodesByChunk,
    (node) => node.targetMeshIndex,
    targetChunkResidencyCosts,
  );
  measureChunks(
    document,
    hierarchy.reducedChunks,
    reduced.nodesByChunk,
    (node) => node.reducedMeshIndex ?? node.targetMeshIndex,
    targetChunkResidencyCosts,
  );

  return {
    document,
    hierarchy,
    targetChunkResidencyCosts,
    activeNodeCount,
    renderableNodes,
    renderableNodesByTargetChunk: target.nodesByChunk,
    targetChunksById: target.chunksById,
    renderableNodesByReducedChunk: reduced.nodesByChunk,
    reducedChunksById: reduced.chunksById,
  };
}

/**
 * Validates and indexes one compiled document for repeated coarse/target range
 * decoding. Target-chunk decodes touch only the occurrences assigned to that
 * chunk; they do not walk the active scene graph again.
 */
export function prepareCompiledGltfDecoder(
  value: unknown,
  options: CompiledPackageOptions = {},
): PreparedCompiledGltfDecoder {
  const state = prepareCompiledGltfState(value, options);
  return {
    hierarchy: state.hierarchy,
    activeNodeCount: state.activeNodeCount,
    renderableNodeCount: state.renderableNodes.length,
    targetChunkResidencyCosts: state.targetChunkResidencyCosts,
    decode: (binary, options = {}) => decodePreparedCompiledGltf(state, binary, options),
  };
}

export function decodeCompiledGltf(
  value: unknown,
  binary: ArrayBuffer,
  options: DecodeCompiledGltfOptions & CompiledPackageOptions = {},
): DecodedCompiledScene {
  return prepareCompiledGltfDecoder(value, options).decode(binary, options);
}

function decodePreparedCompiledGltf(
  state: PreparedCompiledGltfState,
  binary: ArrayBuffer,
  options: DecodeCompiledGltfOptions,
): DecodedCompiledScene {
  const { document, hierarchy } = state;
  if ((options.representation ?? "target") === "coarse" && options.targetChunkId !== undefined) {
    throw new CompiledGltfError(
      "UNSUPPORTED_GEOMETRY",
      "A target chunk cannot be decoded as a coarse representation.",
    );
  }
  // A chunk id names its level: a reduced chunk always decodes the reduced
  // level, whatever `representation` the caller passed.
  const reducedChunk = options.targetChunkId === undefined
    ? undefined
    : state.reducedChunksById.get(options.targetChunkId);
  const targetChunk = options.targetChunkId === undefined || reducedChunk
    ? undefined
    : state.targetChunksById.get(options.targetChunkId);
  if (options.targetChunkId !== undefined && !targetChunk && !reducedChunk) {
    throw new CompiledGltfError(
      "INVALID_GLTF",
      `Unknown target chunk ${options.targetChunkId}.`,
    );
  }
  const representation: GeometryRepresentation = reducedChunk
    ? "reduced"
    : options.representation ?? "target";
  const chunk = targetChunk ?? reducedChunk;
  const progressive = progressiveExtrasFor(document);
  const bufferIndex = chunk?.buffer ?? (representation === "coarse"
    ? finiteInteger(
        progressive?.record.coarseBuffer,
        `${progressive?.path ?? "extras.madi.progressive"}.coarseBuffer`,
        document.buffers.length,
      )
    : progressive
      ? finiteInteger(
          progressive.record.targetBuffer,
          `${progressive.path}.targetBuffer`,
          document.buffers.length,
        )
      : 0);
  const accessors = new BinaryAccessors(document, binary, bufferIndex, chunk);
  const selectedRenderableNodes = targetChunk
    ? state.renderableNodesByTargetChunk.get(targetChunk.id) ?? []
    : reducedChunk
      ? state.renderableNodesByReducedChunk.get(reducedChunk.id) ?? []
      : state.renderableNodes;
  const meshGeometry = new Map<number, DecodedMeshGeometry>();
  const instances = new Map<
    string,
    {
      readonly meshIndex: number;
      readonly surfacePrimitiveIndex: number;
      readonly values: GpuOccurrenceInstance[];
    }
  >();
  const targetMeshByDecodedMesh = new Map<number, number>();
  const objectEvidence: CompiledObjectEvidence[] = [];
  const boundsMin = [Infinity, Infinity, Infinity];
  const boundsMax = [-Infinity, -Infinity, -Infinity];

  for (const prepared of selectedRenderableNodes) {
    const {
      nodeIndex,
      targetMeshIndex,
      worldTransform,
      occurrenceId,
    } = prepared;
    const meshIndex = representation === "coarse"
      ? finiteInteger(
          prepared.coarseMeshIndex,
          `nodes[${nodeIndex}].extras.madi.coarseMesh`,
          document.meshes.length,
        )
      : representation === "reduced"
        ? // A whole-buffer reduced decode falls back to the target mesh for
          // nodes whose prototype retained its target (ADR-0025).
          prepared.reducedMeshIndex ?? targetMeshIndex
        : targetMeshIndex;
    const mesh = document.meshes[meshIndex];
    if (!mesh) throw new CompiledGltfError("INVALID_GLTF", `Missing meshes[${meshIndex}].`);
    const geometry = meshGeometry.get(meshIndex) ?? decodeMesh(document, accessors, mesh, meshIndex);
    meshGeometry.set(meshIndex, geometry);
    const objectId = nodeIndex + 1;
    const meshMadi = madiExtras(mesh);
    const prototypeId =
      prepared.prototypeId !== undefined
        ? prepared.prototypeId
        : typeof meshMadi.prototypeId === "string"
          ? meshMadi.prototypeId
          : `gltf-mesh:${meshIndex}`;
    for (const surface of geometry.surfaces) {
        const batchKey = `${meshIndex}:${surface.primitiveIndex}`;
        const batchInstances = instances.get(batchKey) ?? {
          meshIndex,
          surfacePrimitiveIndex: surface.primitiveIndex,
          values: [],
        };
        batchInstances.values.push({
          // The decoded scene is transferred out of the Worker. Keep the
          // prepared transform attached for subsequent range decodes.
          transform: worldTransform.slice(),
          objectId,
          baseColor: surface.color,
        });
        instances.set(batchKey, batchInstances);
    }
    const existingTargetMesh = targetMeshByDecodedMesh.get(meshIndex);
    if (existingTargetMesh !== undefined && existingTargetMesh !== targetMeshIndex) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `Decoded mesh ${meshIndex} maps to multiple target meshes.`,
      );
    }
    targetMeshByDecodedMesh.set(meshIndex, targetMeshIndex);
    objectEvidence.push({
      objectId,
      nodeIndex,
      label: prepared.label,
      occurrenceId,
      prototypeId,
      ...(prepared.semanticId !== undefined ? { semanticId: prepared.semanticId } : {}),
      ...(prepared.sourceRef !== undefined ? { sourceRef: prepared.sourceRef } : {}),
      edgeSourceRefs: geometry.edgeSourceRefs,
    });

    for (const surface of geometry.surfaces) {
      // A target chunk can contain thousands of instances of one prototype.
      // Transform its cached local AABB corners instead of every vertex for
      // every occurrence. The result is conservative under rotation and
      // exactly matches the compiler's coarse-bounds representation.
      for (const x of [surface.bounds.min[0], surface.bounds.max[0]]) {
        for (const y of [surface.bounds.min[1], surface.bounds.max[1]]) {
          for (const z of [surface.bounds.min[2], surface.bounds.max[2]]) {
            const point = transformPoint(worldTransform, x, y, z);
            for (let axis = 0; axis < 3; axis += 1) {
              boundsMin[axis] = Math.min(boundsMin[axis] ?? Infinity, point[axis] ?? 0);
              boundsMax[axis] = Math.max(boundsMax[axis] ?? -Infinity, point[axis] ?? 0);
            }
          }
        }
      }
    }
  }
  if (objectEvidence.length === 0 || boundsMin.some((value) => !Number.isFinite(value))) {
    throw new CompiledGltfError("UNSUPPORTED_GEOMETRY", "Compiled scene has no renderable geometry.");
  }

  const batchEntries = [...instances.values()].sort(
    (left, right) =>
      left.meshIndex - right.meshIndex ||
      left.surfacePrimitiveIndex - right.surfacePrimitiveIndex,
  );
  const batches: GpuPrototypeBatch[] = batchEntries.map((entry) => {
    const geometry = meshGeometry.get(entry.meshIndex);
    if (!geometry) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `Missing decoded mesh ${entry.meshIndex}.`,
      );
    }
    const surface = geometry.surfaces.find(
      ({ primitiveIndex }) => primitiveIndex === entry.surfacePrimitiveIndex,
    );
    if (!surface) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `Missing decoded surface ${entry.meshIndex}:${entry.surfacePrimitiveIndex}.`,
      );
    }
    return {
      surfaceVertices: surface.surfaceVertices,
      surfaceIndices: surface.surfaceIndices,
      edgeVertices:
        entry.surfacePrimitiveIndex === geometry.surfaces[0]?.primitiveIndex
          ? geometry.edgeVertices
          : new Float32Array(),
      instances: entry.values,
    };
  });
  const batchEvidence: CompiledBatchEvidence[] = batchEntries.map((entry, batchIndex) => {
    const mesh = document.meshes[entry.meshIndex];
    const targetMeshIndex = targetMeshByDecodedMesh.get(entry.meshIndex);
    if (!mesh || targetMeshIndex === undefined) {
      throw new CompiledGltfError(
        "INVALID_GLTF",
        `Missing batch identity for mesh ${entry.meshIndex}.`,
      );
    }
    const meshMadi = madiExtras(mesh);
    return {
      batchIndex,
      meshIndex: entry.meshIndex,
      targetMeshIndex,
      surfacePrimitiveIndex: entry.surfacePrimitiveIndex,
      prototypeId:
        typeof meshMadi.prototypeId === "string"
          ? meshMadi.prototypeId
          : `gltf-mesh:${targetMeshIndex}`,
    };
  });
  const triangles = [...meshGeometry.values()].reduce(
    (total, geometry) =>
      total +
      geometry.surfaces.reduce(
        (surfaceTotal, surface) => surfaceTotal + surface.surfaceIndices.length / 3,
        0,
      ),
    0,
  );
  const edgeSegments = [...meshGeometry.values()].reduce(
    (total, geometry) => total + geometry.edgeVertices.length / 6,
    0,
  );

  return {
    gpuScene: {
      batches,
      sharedObjectIdsAcrossBatches: batchEntries.some(
        (entry) => (meshGeometry.get(entry.meshIndex)?.surfaces.length ?? 0) > 1,
      ),
    },
    bounds: {
      min: [boundsMin[0] ?? 0, boundsMin[1] ?? 0, boundsMin[2] ?? 0],
      max: [boundsMax[0] ?? 0, boundsMax[1] ?? 0, boundsMax[2] ?? 0],
    },
    hierarchy,
    objectEvidence: objectEvidence.sort((left, right) => left.nodeIndex - right.nodeIndex),
    batchEvidence,
    summary: {
      prototypeBatches: batches.length,
      partOccurrences: objectEvidence.length,
      triangles,
      edgeSegments,
      binaryBytes: binary.byteLength,
      representation,
    },
  };
}

export function compiledSceneTransferables(scene: DecodedCompiledScene): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (view: ArrayBufferView<ArrayBufferLike>): void => {
    if (view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  };
  for (const batch of scene.gpuScene.batches) {
    add(batch.surfaceVertices);
    add(batch.surfaceIndices);
    add(batch.edgeVertices);
    for (const instance of batch.instances) add(instance.transform);
  }
  return [...buffers];
}
