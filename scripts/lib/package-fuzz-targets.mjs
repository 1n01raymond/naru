/**
 * The campaign itself: which committed packages are mutated, which reader each
 * mutation is pushed through, and which error classes count as a controlled
 * refusal.
 *
 * The evidence recorder and the unit suite both build their targets here, so a
 * campaign that passes in CI is the same campaign the record reports. The
 * runtime is injected rather than imported for the same reason the harness is
 * runtime-free: the recorder drives the built package, the suite drives the
 * sources.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The declared failure contract. `CompiledGltfError` is what the glTF loader
 * promises for any package it refuses; `SpatialDemandIndexError` is the same
 * promise for the demand sidecar. Anything else escaping a reader is a defect.
 */
export const controlledErrorNames = Object.freeze([
  "CompiledGltfError",
  "SpatialDemandIndexError",
]);

/**
 * Committed packages small enough to mutate tens of thousands of times, chosen
 * to cover the shapes the readers branch on: explicit LINES edges and a target
 * chunk, a plain single-buffer STEP package, and an AP242 package with a coarse
 * buffer and several chunks.
 */
export const fuzzCorpora = Object.freeze([
  { id: "explicit-edges", directory: "artifacts/ifc/explicit-edges", coarse: true },
  { id: "repeated-fasteners", directory: "artifacts/phase1/repeated-fasteners", coarse: false },
  {
    id: "repeated-fasteners-ap242",
    directory: "artifacts/phase1/repeated-fasteners-ap242",
    coarse: true,
  },
]);

export async function loadFuzzCorpora(repositoryRoot, corpora = fuzzCorpora) {
  const loaded = [];
  for (const corpus of corpora) {
    const directory = resolve(repositoryRoot, corpus.directory);
    const document = JSON.parse(await readFile(resolve(directory, "scene.gltf"), "utf8"));
    const target = new Uint8Array(await readFile(resolve(directory, "scene.bin")));
    const coarse = corpus.coarse
      ? new Uint8Array(await readFile(resolve(directory, "coarse.bin")))
      : undefined;
    loaded.push({ ...corpus, document, target, ...(coarse ? { coarse } : {}) });
  }
  return loaded;
}

/** `mutateBinary` always returns a fresh exact-length array, so this is a view. */
function asArrayBuffer(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
}

/**
 * The bytes a residency client would have Range-fetched for one chunk. The
 * declared range is read defensively and any unusable value falls back to the
 * whole buffer, because a throw raised here would be miscounted as a reader
 * defect rather than as the malformed input it came from.
 */
function chunkSlice(document, chunkId, bytes) {
  const chunks = document?.extras?.naru?.progressive?.targetChunks ?? document?.extras?.madi?.progressive?.targetChunks;
  if (!Array.isArray(chunks)) return bytes;
  const chunk = chunks.find(
    (entry) => entry !== null && typeof entry === "object" && entry.id === chunkId,
  );
  const byteOffset = chunk?.byteOffset;
  const byteLength = chunk?.byteLength;
  if (!Number.isInteger(byteOffset) || !Number.isInteger(byteLength)) return bytes;
  if (byteOffset < 0 || byteLength < 0 || byteOffset + byteLength > bytes.byteLength) return bytes;
  return bytes.subarray(byteOffset, byteOffset + byteLength);
}

/**
 * A fixed occurrence set for the demand sidecar. The committed packages carry
 * no `spatial.bin` -- the two that do are federation-scale and gitignored --
 * so the seed is synthesized from the compiler's own encoder, which keeps the
 * bytes a real v1 index rather than a hand-written approximation.
 */
export function spatialDemandSeed(encodeSpatialDemandIndex, occurrenceCount = 128, chunkCount = 8) {
  const occurrences = Array.from({ length: occurrenceCount }, (_unused, at) => ({
    id: `occurrence:${String(at).padStart(4, "0")}`,
    nodeIndex: at,
    minimum: [at, 0, 0],
    maximum: [at + 1, 1, 1],
    targetChunkIndex: at % chunkCount,
  }));
  const encoded = encodeSpatialDemandIndex(occurrences, { leafCapacity: 8 });
  return {
    bytes: encoded.bytes,
    options: { gltfNodeCount: occurrenceCount, targetChunkCount: chunkCount },
  };
}

/** An arbitrary but fixed view, so a query is exercised on every decode. */
const queryFrame = Object.freeze({
  viewProjection: Object.freeze([
    0.5, 0, 0, 0,
    0, 0.5, 0, 0,
    0, 0, -0.01, 0,
    0, 0, 0.5, 1,
  ]),
  origin: Object.freeze([0, 0, 0]),
});

/**
 * Builds one target per reader entry point. `spatial` is optional because the
 * seed needs the compiler's encoder; a caller without it fuzzes the glTF
 * readers only, and the ledger says so by naming fewer targets.
 */
export function buildPackageFuzzTargets({ corpora, runtime, spatial }) {
  const targets = [];
  for (const corpus of corpora) {
    targets.push({
      id: `${corpus.id}/target`,
      document: corpus.document,
      binary: corpus.target,
      run({ document, binary }) {
        const parsed = runtime.parseCompiledGltf(document);
        runtime.inspectCompiledHierarchy(parsed);
        const decoder = runtime.prepareCompiledGltfDecoder(document);
        // The chunk id comes from the prepared decoder, never from the mutated
        // document: reading it back out by hand would let the harness itself
        // throw and be miscounted as a reader defect.
        const [firstChunk] = decoder.targetChunkResidencyCosts.keys();
        // A package that declares chunks is decoded the way a residency client
        // decodes it, one Range at a time; one that declares none is decoded
        // whole, which is the path the benchmark and the STEP packages take.
        const payload = firstChunk === undefined
          ? binary
          : chunkSlice(document, firstChunk, binary);
        decoder.decode(asArrayBuffer(payload), {
          representation: "target",
          ...(firstChunk === undefined ? {} : { targetChunkId: firstChunk }),
        });
      },
    });
    if (!corpus.coarse) continue;
    targets.push({
      id: `${corpus.id}/coarse`,
      document: corpus.document,
      binary: corpus.coarse,
      run({ document, binary }) {
        runtime.decodeCompiledGltf(document, asArrayBuffer(binary), {
          representation: "coarse",
        });
      },
    });
  }
  if (spatial) {
    targets.push({
      id: "spatial-demand-index",
      binary: spatial.bytes,
      run({ binary }) {
        const index = runtime.decodeSpatialDemandIndex(binary, spatial.options);
        runtime.querySpatialDemandIndex(index, queryFrame);
      },
    });
  }
  return targets;
}
