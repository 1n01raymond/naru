# `@naru3d/runtime-webgpu`

Direct WebGPU rendering and the Phase 1 compiled glTF runtime boundary.

## Loading contract

- `inspectCompiledHierarchy(value)` validates glTF 2.0 plus
  `madi.experimental.gltf.1` metadata and returns the active occurrence tree
  without requiring geometry bytes. Hierarchy entries and pick evidence carry
  each occurrence's `semanticId` when present, and a package-level
  `extras.madi.properties` pointer (the `madi.package-properties.1` sidecar,
  `docs/COMPILER.md` section 21.2) surfaces as `hierarchy.properties`
  after shape validation — the runtime does not fetch or parse the sidecar
  itself. A document that declares `extras.madi.nodeIdentityDerivation`
  (ADR-0015) has some `semanticId`/`sourceRef` members omitted; both loaders
  reconstruct them from that rule while parsing the document they already hold,
  without a lookup table or a second request, so hierarchy entries, pick
  evidence, and property lookup are identical either way. A node that keeps a
  member explicitly wins over the rule, and an explicit `null` means the
  occurrence has no such identity.
- A document that declares `extras.madi.hierarchy` (ADR-0017) carries its
  mesh-less nodes in a `naru.package-hierarchy.1` sidecar instead of the
  document. `inspectCompiledHierarchy(value, { hierarchy })` takes the parsed
  sidecar and returns the same tree as an unrelocated package; called without
  one it throws `PackageHierarchyError("INVALID_HIERARCHY", ...)` rather than
  returning the drawing nodes as though they were the whole assembly. A caller
  that wants geometry and no tree passes the `"geometry-only"` sentinel in the
  same field and gets an empty tree — the Studio's geometry Worker does this,
  because the tree is read on the main thread that owns the panel. Relocation
  moves only mesh-less nodes, so renderable occurrences stay derivable from the
  document either way.
- `decodeCompiledGltf(value, binary, { representation })` validates the selected
  external-buffer accessor ranges,
  decodes surface and explicit-edge streams, composes node transforms, preserves
  picking identity, and groups nodes by shared mesh. A node may carry `matrix`
  or `translation`; the composed transform is bit-identical either way.
- `prepareCompiledGltfDecoder(value)` validates and traverses the active document
  once, retaining float64 world transforms plus direct target-chunk occurrence
  tables. Its `decode(binary, { targetChunkId })` path touches only the selected
  chunk's occurrences and transforms cached prototype AABB corners rather than
  every vertex for every occurrence; `decodeCompiledGltf` remains the one-shot
  compatibility wrapper. It also publishes `targetChunkResidencyCosts`, the
  decoded and GPU bytes each declared chunk would cost, measured from accessor
  counts alone so a scheduler can refuse a chunk before requesting its range.
- A prototype mesh is split into one primitive per material but stores its
  vertex pool once, so every primitive references the same POSITION and NORMAL
  accessors. Each pool is therefore interleaved once per mesh and the identical
  `Float32Array` is handed to every sibling batch, which structured clone
  preserves across a Worker boundary. `batchResidencyCost` charges such a pool
  once through `sharesSurfaceVertices`, and the renderer keeps one refcounted
  vertex buffer per pool.
- `batchResidencyCost(shape)` is the single formula behind that measurement, the
  renderer's buffer allocation, and the Studio's residency accounting, so a
  predicted cost and the charge for the same decoded batch cannot drift apart.
  `packages/runtime-webgpu/test/compiled-gltf.test.ts` decodes a committed
  fixture and asserts the two agree for every chunk.
- A compiled document is untrusted input, so every reader entry point accepts
  `{ limits }` and holds the package to the ceilings in
  `resolveCompiledPackageLimits`: node, mesh, accessor, buffer-view, and target
  chunk counts are checked against the declaration before anything is
  allocated, and the active-scene traversal is iterative and depth-bounded, so
  a deep or cyclic node graph is rejected rather than overflowing the stack.
  The defaults sit well above the largest package this repository compiles;
  see [ADR-0011](../../docs/adr/0011-remote-package-limits.md). An embedding
  application may pass lower limits, and `defaultCompiledPackageLimits` names
  what it is lowering.
  A reader may accept a malformed package or refuse it through a declared
  error class -- `CompiledGltfError` here, `SpatialDemandIndexError` for the
  demand sidecar -- and nothing else may escape it. A seeded campaign of
  120,000 mutated packages holds all six reader entry points to that contract
  and records 0 uncontrolled outcomes
  ([`artifacts/security/package-fuzz`](../../artifacts/security/package-fuzz/README.md));
  `package-fuzz-campaign.test.ts` reruns a bounded slice of it in `pnpm test`.
- `openPackageTransport(documentUrl, policy?)` settles the transfer half of the
  same policy: an HTTP(S) document URL without credentials, resources held to
  the document's own origin, `redirect: "error"`, a package resource content
  type, and byte ceilings applied while the body streams. An embedder chooses
  its own `limits`, announces further `additionalOrigins` for a package split
  across hosts, or supplies the `fetch` itself; `defaultPackageTransferLimits`
  names what it is changing. `transport.describe()` and
  `PackageTransport.fromDescriptor()` carry a policy of resolved values across
  a Worker boundary, so a Worker inherits a policy and cannot widen one. A
  consumer outside the Studio exercises every axis in
  [`artifacts/security/embedder-overrides`](../../artifacts/security/embedder-overrides/README.md).
- `openPersistentPackageCache({ quotaBytes })` opens the verified persistent
  tier of [ADR-0024](../../docs/adr/0024-persistent-package-cache.md) and
  returns `undefined` where Cache Storage is unusable; passed as the policy's
  `persistence`, the transport resolves a request that carries an `expected`
  `{ sha256, byteLength }` from the tier before the network and publishes
  verified network bytes back. A hit is re-hashed against the declared identity
  before it is returned, mismatching bytes are refused, the open scene's
  resources are protected from LRU eviction until `release()`, and `stats()`
  reports encoded persistent bytes apart from decoded/GPU residency.
  `MemoryPersistentPackageStorage` backs the
  [fake-storage tests](test/package-cache.test.ts).
- `compiledSceneTransferables(scene)` lists owned typed-array buffers for a
  zero-copy Worker-to-main-thread transfer.
- `NaruWebGpuRenderer` uploads those batches and renders surfaces, edges, and an
  integer object-ID picking pass directly with WebGPU. `pickPoint(x, y)` adds
  the world-space surface point under the cursor through a transient
  `rgba32float` attachment; `decodeSurfacePoint` restores the float64 camera
  origin on the CPU and returns `null` for a miss.

`setSelection(objectId)` updates a small scene uniform so the selected
occurrence's surfaces and explicit edges are highlighted without repacking
prototype or occurrence buffers. Object ID zero clears selection.

Object-ID rendering is on demand: navigation frames submit surfaces and
optional explicit edges, while a click renders and reads the ID target only
when requested. The renderer also accepts a fixed pixel ratio and can omit edge
uploads so cross-backend benchmark profiles do not silently compare different
resolution or resource contracts.

For allocation-stable occurrence visibility, `updateVisibleInstances()` accepts
dense per-prototype `Int32Array` index tables and counts. It repacks visible
occurrences into reusable CPU staging storage and updates only the active prefix
of each existing GPU instance buffer; prototype geometry buffers remain intact.
An optional `changedBatchIndexes` argument restricts the repack and buffer
writes to the listed batches so a residency admission pays for the batches it
touched, not the whole resident set. Studio uses this path for
hide/isolate/show-all, and render/picking passes skip prototype batches whose
visible instance count is zero.

`reconcileBatches(entries, options)` keeps GPU resources for batches whose key
and batch object are unchanged and uploads only new ones. Each batch is
validated when it is first uploaded rather than on every reconcile, and in
non-shared-ID mode a per-call cross-batch duplicate check preserves the
`setScene` object-ID guarantees; all validation runs before any GPU resource is
destroyed or created, so a rejected reconcile leaves the previous scene intact.

`setSectionPlane({ normal, offset })` enables one world-space clipping plane and
keeps the half-space where `dot(normal, position) <= offset`. The renderer
normalizes the equation and applies the same fragment discard to shaded
surfaces, explicit CAD edges, and the on-demand object-ID pass. Passing
`undefined` disables clipping without rebuilding pipelines or scene buffers.

`render(viewProjection, { cameraOrigin })` accepts a double-precision world
origin. Decoded node transforms compose in JavaScript number precision, while
the 96-byte instance record stores translation high/low f32 components (the low
component reuses the existing alignment gap). Surface, edge, section, and pick
passes subtract a matching high/low camera origin before projection. The
project-owned 0.25 mm / 10,000 km headed Chrome/Firefox record is checked by
`pnpm precision:check`.

The current experimental decoder accepts a target-only package or a progressive
package with separate target and coarse external buffers. A package compiled
with `--reduced-lod` declares `extras.naru.progressive` under
`naru.progressive-package.1` instead, adding `reducedChunks`: a third
per-prototype level the decoder fetches, decodes, and prices exactly like a
target chunk. Nothing selects it yet
([ADR-0025](../../docs/adr/0025-shape-preserving-lod-representation.md)). The progressive slice
uses `extras.madi.coarseMesh` and preserves node-derived object IDs while the
renderer replaces prototype AABBs with target meshes. A batch handed to
`reconcileBatches` with `representation: "coarse"` is drawn and picked through
a fallback pipeline pair that offsets clip depth by the renderer's
`fallbackDepthOffset` (default `1 / 65536`; `resolveFallbackDepthOffset`
validates the option and `0` disables it), so a proxy face coplanar with a
resident target surface cannot z-fight it. When target chunk metadata
is present, `targetChunkId` decodes only one declared byte range and its mesh
occurrences. The session Worker prepares document transforms and chunk
membership once, then reuses that state across coarse and target decodes. Each
result receives its own transform arrays so zero-copy transfer cannot detach
the prepared state. The browser requests those ranges sequentially, displays each
promotion before requesting the next, and falls back safely when a host returns
the complete buffer with HTTP 200. The Studio builds retained-coarse chunk
bounds once, ranks them in the current camera, keeps one Range/decode active at
a time, and aborts that request through the Worker when navigation makes another chunk
hotter. Changing scenes terminates the active Worker and its fetch; explicit
cancellation uses the same boundary. Intentional
renderer destruction does not surface as a device-loss error. Per mesh, the decoder
accepts one indexed `TRIANGLES` primitive plus at most one indexed `LINES`
primitive. It is not a general-purpose glTF loader. Unsupported profiles and
layouts fail with a typed `CompiledGltfError` instead of silently dropping
engineering data.

The package boundary also recognizes the optional
`extras.madi.progressive.spatialIndex` pointer and strictly decodes
`naru.spatial-demand-index.1`. The decoder preserves float64 bounds and rejects
invalid sizes, allocation limits, unreachable/cyclic nodes, duplicate
occurrence ownership, and out-of-range glTF or target-chunk references before
exposing query arrays. The Studio authenticates the SHA-256, performs a
camera-relative frustum traversal, requests only the deduplicated chunks of
visible leaves, and keeps non-demanded chunks cold for eviction. Packages
without the optional index retain aggregate retained-coarse chunk scheduling.
The indexed browser path has unit/oracle coverage plus the focused headed
Chrome/Firefox record under `artifacts/spatial-demand/`. Digital Hub and
sixty5 pass offline co-demand censuses, and both have headed localized camera
traces under `artifacts/spatial-demand/{digital-hub,sixty5}-localized/`; a
non-Blink localized repeat is still pending.

`querySpatialDemandIndex` returns each candidate chunk with both the squared
screen distance to the view centre and the largest clipped normalized-device
area (0 through 4) any of its visible leaves projects to, and orders them by the
requested `SpatialDemandPriority`: `"screen-distance"` (the default, and the
historical order byte for byte) or `"screen-coverage"`, which sorts by area and
falls back to distance and then chunk index so the order stays total. Coverage
prices an axis-aligned bound, so it over-estimates a slanted box and gives any
bound that straddles the eye plane the whole view; it ranks demand rather than
measuring a chunk's pixels. Which policy renders closer to an unbudgeted
reference depends on the view — see
`artifacts/spatial-demand/sixty5-demand-priority/`.

Run `pnpm test` for package and committed-fixture regression coverage. The
headed cross-engine path is recorded by `pnpm browser:matrix`; the focused
large-coordinate path is recorded by `pnpm precision:evidence`.
