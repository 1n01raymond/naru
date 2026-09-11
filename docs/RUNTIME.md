# WebGPU Runtime

Status: Draft 0.1

## 1. Mission

The browser runtime turns immutable compiled resources into an interactive
engineering scene under explicit network, CPU-memory, GPU-memory, and latency
budgets. It exposes semantic interaction without constructing one mutable
render object for every CAD occurrence.

## 2. Public API sketch

```ts
const runtime = await createNaruRuntime({
  device,
  budgets: {
    networkConcurrency: 8,
    decodedBytes: 512 * MiB,
    gpuBytes: 1024 * MiB,
    persistentCacheBytes: 4 * GiB,
  },
});

const view = runtime.createView({ canvas, camera: "perspective" });
const model = await runtime.open("/models/turbine/manifest.json", {
  signal: abortController.signal,
  onProgress,
});

view.attach(model);
model.visibility.hide([occurrenceId]);
model.selection.replace([occurrenceId]);
view.sections.set([{ normal: [1, 0, 0], distance: 0 }]);

const objectHit = await view.pickObject({ x, y });
const snapHit = await view.snap({ x, y, modes: ["vertex", "edge", "face"] });

await model.when("first-useful-frame");
model.dispose();
runtime.dispose();
```

The final API may differ. Required qualities are explicit ownership, abortable
operations, typed milestones/errors, separate object picking and precise
snapping, and deterministic disposal.

## 3. Packages and ownership

```text
runtime-core
├── manifest/schema validation
├── model tables and semantic API
├── streaming scheduler
├── cache abstraction
├── worker protocol
├── budgets and telemetry
└── backend interfaces

runtime-webgpu
├── GPU allocator
├── pipelines and shaders
├── view/frame graph
├── culling/LOD backend
├── picking and clipping
└── WebGPU capability/device recovery
```

The core can be unit-tested without a GPU. A future native or alternative
renderer may reuse the loader and semantic model.

## 4. Lifecycle and milestones

Model lifecycle:

```text
created
  -> manifest-ready
  -> hierarchy-ready
  -> coarse-renderable
  -> first-useful-frame
  -> target-view-ready
  -> fully-available (optional; may never be requested)
  -> disposing
  -> disposed
```

`first-useful-frame` requires:

- camera fitted or user camera respected;
- recognizable coarse visible content;
- interactive camera controls unblocked;
- hierarchy/search summary ready enough for navigation;
- no requirement that every object or property be downloaded.

Applications receive progress by meaningful stage and byte/residency estimates,
not a misleading single percentage when total demand is view-dependent.

### Reading the assembly tree

`hierarchy-ready` is reached from the glTF document alone for a package the
compiler wrote with its nodes in place. A package compiled with
`--relocate-hierarchy-nodes` ([ADR-0017](adr/0017-relocated-hierarchy-sidecar.md))
keeps only the drawing nodes in the document and carries the tree in a
`naru.package-hierarchy.1` sidecar, so `hierarchy-ready` then also waits on
`hierarchy.json` and `hierarchy.bin`.

The reader never guesses which of the two it is holding. A document that
declares `extras.madi.hierarchy` and is asked for its tree without the sidecar
fails closed with `PackageHierarchyError("INVALID_HIERARCHY", ...)` rather than
returning the drawing nodes as if they were the whole assembly -- silently
short trees are the failure this option would otherwise introduce. Callers
supply the sidecar through `CompiledPackageOptions.hierarchy`.

A caller that wants geometry and no tree at all says so explicitly, by passing
the `"geometry-only"` sentinel in the same field. The Studio's geometry Worker
does exactly that: it decodes on a thread that never renders the tree, so it
declines the tree instead of fetching a sidecar it would discard. The tree is
read once, on the main thread that owns the panel.

Relocation moves only mesh-less nodes, so a document's renderable occurrence
count is still derivable from the document itself either way.

## 5. Threading model

### Main thread

- public API and event delivery;
- camera/input integration provided by host or Studio;
- request priority summaries;
- GPU resource publication and command encoding;
- small model-table updates;
- plugin UI integration.

### Workers

- fetch where worker networking is appropriate;
- decompression and binary validation;
- semantic/index decoding;
- optional BVH/spatial acceleration construction;
- transformation into upload-ready typed arrays;
- expensive queries and snapping candidates.

Transferable buffers avoid copies. SharedArrayBuffer is optional because it
requires deployment headers; the baseline works without it.

### One transfer policy per opened package

A remote package is untrusted input, so a host settles a single
`PackageTransport` when it opens the document and every later fetch reads that
object: the resources the document declares, both sidecars, the demand index,
and the byte ranges a Worker requests on its own. The policy names the ceilings,
the origins a package may span, and optionally the transfer itself; it crosses
the Worker boundary as a descriptor of already-resolved values, so a Worker
inherits a policy and cannot widen one. Defaults and the reasoning behind them
are [ADR-0011](adr/0011-remote-package-limits.md); a consumer outside the Studio
exercises the override axes in
[`artifacts/security/embedder-overrides`](../artifacts/security/embedder-overrides/README.md).

### Who holds the compiled document

The document exists in several representations at once, and each one names an
owner, a consumer, and a release point:

| Representation | Owner | Crosses the boundary as | Released |
|---|---|---|---|
| Response bytes | scene loader | transferred to the Worker | at transfer; the main thread has no copy |
| Decoded text | Worker, during initialization | never | when `JSON.parse` returns |
| Parsed glTF object graph | Worker, during initialization | never | when preparation returns |
| Prepared decoder state | Worker, whole session | never | when the Worker is terminated |
| Assembly tree | main thread | structured-cloned once, then cached | with the scene |
| Decoded geometry | Worker to main thread | transferred per chunk | on eviction |

Preparation is the only step that reads `nodes` and `scenes`: it walks the
active roots once, composes world transforms, and writes the occurrence tables
the decoder uses from then on. Every later read is `buffers`, `bufferViews`,
`accessors`, `meshes`, `materials`, or `extras`. The prepared state therefore
keeps a shallow copy of the document without those two arrays, so a caller that
drops its own reference releases the node graph for the rest of the session
instead of paying for it until the decoder is discarded.

Measured on this repository's Node harness — parse the document, prepare a
geometry-only decoder, drop the caller's reference, collect, and read
`heapUsed` — retained heap falls by 99.47 MiB of 455.96 (21.8%) on the 657.1 MB
sixty5 package, 41.00 MiB of 337.65 on its relocated-hierarchy variant, and
6.84 MiB of 37.49 on Digital Hub, with the decoded summary, object and batch
evidence, and scene bounds identical before and after. Those are retained-heap
figures for one process, not whole-application memory: the budgets below still
bound admitted geometry alone.

## 6. Streaming scheduler

The scheduler combines demand signals:

```text
priority =
  visibility contribution
  + screen-space error
  + selected / hovered / measured boost
  + hierarchy/search request
  + motion prediction
  + starvation age
  - network cost
  - decode cost
  - residency pressure
```

It operates with bounded queues:

- manifest/index requests;
- compressed chunk fetches;
- decode tasks;
- GPU uploads;
- eviction candidates.

Cancellation is cooperative at every boundary. A camera move can demote or
cancel work before decode/upload, while partially useful shared prototype data
may remain requested.

### Choosing a geometry level

A package compiled with `--reduced-lod <meters>` carries a third per-prototype
level beside `coarse` and `target`, and the level a prototype draws at is a
projected-error decision rather than a budget one
([ADR-0025](adr/0025-shape-preserving-lod-representation.md)). Every reduced
chunk declares its own measured `maxDeviationMeters`, so the error on screen is
that chunk's bound over `metresPerPixel` and the decision is made per chunk: a
chunk is substituted while its own error stays at or below 1.0 px and is
replaced by `target` once it exceeds 1.5 px. Two chunks whose bounds straddle
the threshold therefore draw at different levels in the same frame. The gap is
hysteresis, so a camera resting near the threshold does not oscillate between
levels; both thresholds are overridable per session with `?lodAdmitPx=` and
`?lodReplacePx=`.

Two rules bound what substitution can affect. A prototype with no reduced chunk
is never substituted, and the selected object is pinned to `target` whatever the
camera says, so the geometry a user is inspecting, measuring, or sectioning is
always the exact one. Both levels of a prototype share a residency key, so
promoting either replaces the other in place: the budget never charges a
prototype twice, and a level swap is not an eviction.

## 7. Cache tiers

```text
remote/static source
    ↓
persistent compressed cache
    ↓
compressed in-memory queue
    ↓
decoded CPU cache
    ↓
GPU residency
```

Each tier has independent accounting and eviction. Content hashes allow cache
reuse across workspace revisions and model manifests. Selected content,
currently visible target LOD, and resources with active operations are pinned.

The persistent tier is `PersistentPackageCache`
([ADR-0024](adr/0024-persistent-package-cache.md)): a content-addressed
Cache Storage store under the embedding application's origin, keyed by the
SHA-256 and byte length the package document declares. The ADR-0011 transport
resolves a digest-declared resource there before the network and publishes
verified network bytes to it afterwards; a hit is re-hashed against the same
declared identity before any parser or decoder sees it, and mismatching bytes
are deleted and counted as an invalidated miss. Entries are evicted
least-recently-used under an explicit quota (256 MiB by default), the open
scene's resources are protected until the next load, and a publish that cannot
fit beside the protected set is refused. Persisted encoded bytes are reported
by the tier's own statistics and never enter the decoded or GPU totals above.
Today only the property, hierarchy, and spatial-index sidecars declare a
digest, so the document and both geometry buffers stay network-only
([fake-storage tests](../packages/runtime-webgpu/test/package-cache.test.ts)).

### Residency budgets are not a process bound

The decoded and GPU budgets bound admitted target geometry and nothing else.
The compiled document, the property sidecar, the hierarchy, the render
attachments, the staging arrays, and the browser process that holds all of them
are outside that accounting, so a residency figure must never be reported as
whole-application memory.

The [memory envelope](../artifacts/memory/sixty5-envelope/README.md) measures
both quantities in the same runs. Over three headed Chrome runs on the 657.1 MB
sixty5 package, target residency at the default 64 MiB budget is 66,686,508
decoded bytes inside a browser process tree whose working set medians
2,586,112,000 B — 2.58% of it. Each of the eighteen categories in that record
names its owner, lifetime, and collection method; the graphics driver's
device-side allocation has no interface that reports it and is recorded as
unavailable rather than as zero.

The [Gecko repeat](../artifacts/memory/sixty5-envelope-gecko/README.md) runs
the same six phases in headed Firefox 150 against the same package on the same
host. It admits the same 66,686,508 decoded and 66,783,808 GPU bytes - the
resident set is byte-identical at every settled phase of both profiles — inside
a process tree whose working set medians 5,104,345,088 B, so the same residency
is 1.31% of that process rather than 2.58%. What the runtime decides is
engine-independent; the process around it is not, which is why every
whole-process figure here names its engine. Gecko exposes neither
`performance.memory` nor `measureUserAgentSpecificMemory()`, so that record
carries no heap figure at all and the operating system's sample carries the
bound alone. It also reports the one predeclared target this engine does not
meet: the 4 GiB process working-set ceiling, exceeded in both profiles and
already at the hierarchy phase, before a single target chunk is admitted.

Repeating the same six phases under a forced 8 MiB budget keeps all 78,173
renderable occurrences visible through shared coarse geometry, completes
navigation, selection, and eviction, and reports the budget-limited state it is
actually in. A budget too small to hold the view is expected to constrain
detail, not to strand the scheduler in a loading state.

## 8. Model tables

The runtime decodes semantic convenience on demand while retaining dense tables
for scale.

Typical columns:

- occurrence parent/prototype/semantic indices;
- local transform or transform handle;
- world transform cache for visible/changed occurrences;
- visibility, selection, emphasis, and availability bitsets;
- bounds and spatial node references;
- representation/chunk references;
- source reference and property-page references.

Tree APIs return paged handles and iterators. They do not recursively materialize
the entire hierarchy as nested JS objects.

## 9. GPU resource model

### Allocation

- pooled storage, vertex, index, edge, and staging buffers;
- alignment-aware suballocation with explicit ownership per chunk;
- deferred destruction after submitted GPU work is complete;
- fragmentation stats and controlled compaction/rebuild;
- resource labels in development builds.

### Scene state

- transforms and object flags in storage buffers;
- representation/draw metadata indexed by dense IDs;
- material table with compact overrides;
- chunk-local decode parameters/origins;
- per-view visibility/LOD outputs;
- object ID mapping for picking.

TypeGPU can define typed buffer layouts and shader functions, but raw WebGPU
resources remain reachable behind a narrow backend seam.

## 10. Visibility and drawing strategy

Implementation order:

1. CPU coarse frustum culling over a compact spatial hierarchy.
2. Large batches and prototype instancing.
3. Reusable render bundles or bounded command templates where useful.
4. GPU fine culling and LOD classification after profiling.
5. Occlusion techniques only when their latency and pass cost win on target
   scenes.

Compute-generated indirect arguments can set non-visible batches to zero, but
the architecture does not assume native-style multi-draw-indirect availability.
The benchmark suite records CPU command encode time and draw count separately.

## 11. Render passes

### Surface pass

- engineering-friendly physically based or simple shaded materials;
- reversed depth where supported/beneficial;
- coarse fallback proxies drawn behind resident target detail: a batch tagged
  `representation: "coarse"` goes through a second pipeline pair whose vertex
  stage adds `fallbackDepthOffset` (default 1/65536 of clip depth, about one
  16-bit quantum) so a prototype AABB face coplanar with a resident surface
  loses the depth test instead of fighting it; `0` disables the offset and the
  resolver rejects anything outside `[0, 1)`
  ([test](../packages/runtime-webgpu/test/renderer.test.ts));
- camera-relative transforms;
- clip distances/discard policy consistent with section passes;
- object/feature IDs available to optional attachments.

### Edge pass

- explicit boundary/sharp/seam edge streams;
- stable screen-space widths implemented as expanded geometry or shader logic;
- depth comparison/bias policy that avoids z-fighting;
- runtime silhouette classification as a separate optional feature;
- selected/emphasized edge styling without material duplication.

### Transparency and emphasis

The initial renderer uses controlled sorted/coarse transparency suitable for
ghosting and selected context. Order-independent transparency is evaluated only
if engineering workflows justify its memory/pass cost.

### Overlay pass

Annotations, measurements, axes, grids, manipulators, and plugin overlays use a
separate API and resource budget. DOM labels and GPU overlays can coexist.

## 12. Picking

### Object picking

- render compact occurrence/object ID into an integer or encoded target;
- read a small pixel region asynchronously;
- map dense GPU ID to occurrence and semantic/source references;
- pipeline readbacks to avoid blocking the render loop;
- allow on-demand pass for click and optional lower-rate hover updates.

### Surface-point picking

`pickPoint(clientX, clientY)` extends object picking with the world-space
surface point under the cursor, in metres. The pass renders the same batches
through a second entry point that writes the object ID and the
camera-relative fragment position into two colour attachments; the position
attachment is `rgba32float`, created for the call and destroyed with its
readback buffer, so `resourceStats()` and the recorded memory envelopes do not
change. `decodeSurfacePoint` adds the float64 camera origin back on the CPU
(ADR-0005: the GPU only ever sees camera-relative coordinates), returns `null`
for a miss, and is unit-tested in
[`layout.test.ts`](../packages/runtime-webgpu/test/layout.test.ts). The Studio
builds its distance measurement on this call (`M`, two clicks); the
measurement state machine and the length formatting are pure and tested in
[`measurement.test.ts`](../apps/webgpu-spike/test/measurement.test.ts).
Precision is that of the float32 camera-relative fragment, which the
camera-relative record bounds; the point is a rasterized surface sample, not a
snapped vertex or edge.

### Precise snapping

Snapping is not the same as object picking. It may use:

- primitive ID and barycentric data;
- CPU BVH over resident display geometry;
- edge/vertex acceleration structures;
- source-exact evaluation through an optional service/adapter session.

Every result carries `accuracy.kind` and tolerance.

## 13. Sections and clipping

P0 supports visual clipping against one plane. P1 separates:

- surface clipping;
- section outline extraction;
- cap rendering;
- exact vs display-derived intersection;
- multiple planes/boxes.

A simple shader discard must not be labeled an exact section. Cap generation may
use stencil/multipass display techniques or compiler/runtime geometry, with
accuracy disclosed.

## 14. Precision

The runtime keeps camera and scene anchors in JavaScript number (double),
composes decoded glTF node transforms into `Float64Array` values, and uploads
local f32 geometry. Instance translations and the per-frame camera origin are
split into f32 high/low pairs before the vertex shader subtracts them. The low
instance component reuses the existing 12-byte alignment gap, so the 96-byte
instance stride is unchanged. Section planes are rebased to the same origin and
surface, explicit-edge, and object-ID passes share the relative vertex path.

For each view:

1. choose camera-relative origin;
2. compose occurrence/document transforms in double precision;
3. split or subtract large translation before f32 upload;
4. decode quantized positions relative to prototype/chunk origin;
5. validate that estimated projected error remains below profile tolerance.

Bounds and scheduling use double-precision CPU representations where large
coordinate ranges require them.

The committed ADR-0005 record validates this path with a 0.25 mm gap at a
10,000 km offset: 0.000000387 mm measurement error and byte-identical near/far
canvases through navigation, picking, and sectioning in headed Chrome and
Firefox. See `artifacts/precision/large-coordinates/` and
`pnpm precision:check`.

## 15. Multiple views

One runtime/model can serve multiple canvases or viewports. Immutable geometry
and material resources are shared on one device; cameras, clip state,
visibility overrides, LOD demand, and pick targets are per view. The scheduler
merges demand while enforcing a configurable fairness policy.

## 16. Device and capability management

Startup records:

- adapter/device limits and optional features;
- buffer/texture limits;
- timestamp query support;
- compression texture features;
- preferred canvas format;
- profile compatibility.

The compiler profile declares minimum runtime requirements. The runtime can
choose an alternate payload profile when the manifest offers one.

On `device.lost`:

1. stop submissions and reject pending GPU operations with typed status;
2. retain semantic/model state and reusable compressed/decoded data within
   budgets;
3. request a replacement adapter/device according to host policy;
4. recreate pipelines, allocators, and visible resident chunks;
5. emit degraded/recovered events.

## 17. Error handling

Public errors contain:

- stable code;
- user-safe message;
- stage and affected model/chunk/object when known;
- recoverable flag and retry guidance;
- underlying cause in development mode without leaking sensitive metadata.

One malformed optional chunk should not invalidate an otherwise usable model.
Required hierarchy/schema failure stops model open.

## 18. Plugin-facing capabilities

Runtime capabilities include:

- read scene hierarchy and properties;
- observe selection/view/progress;
- request object visibility/emphasis transactions;
- add overlay renderables with quotas;
- register commands and analysis results;
- request network or source access only when host grants it.

Plugins never receive mutable GPU allocator internals. Advanced renderer plugins
may be added later behind a reviewed unsafe/experimental capability.

## 19. Testing

### Unit

- scheduler priorities and starvation;
- budget accounting and eviction;
- model table queries;
- ID/source mapping;
- manifest/feature negotiation;
- coordinate conversions;
- lifecycle and disposal.

### Integration

- deterministic manifest/chunk fixture load;
- corrupted/truncated chunk rejection;
- worker cancellation and transfer;
- GPU buffer allocation/release;
- device loss simulation;
- multi-view demand merging.

### Visual

- canonical images for surfaces, CAD edges, selection, sections, precision, and
  LOD transitions across supported browsers/GPUs;
- thresholds account for backend rasterization differences while preserving
  semantic pixels and gross geometry.

### Performance

- startup milestones;
- navigation frame distributions;
- main-thread long tasks;
- decode throughput;
- CPU/GPU memory peaks;
- picking latency;
- behavior under forced low budgets.

## 20. First implementation slice

- one model and one view;
- direct WebGPU surface and explicit edge rendering;
- fixed chunk layout with simple allocators;
- manifest/hierarchy load followed by coarse and display chunks;
- a `reduced` level in packages compiled with `--reduced-lod`, Range-fetched
  and priced by the same `batchResidencyCost` as a target chunk, substituted
  while its declared deviation projects to 1.0 px or less and replaced by
  `target` past 1.5 px
  ([ADR-0025](adr/0025-shape-preserving-lod-representation.md));
- Worker decode;
- CPU coarse culling and prototype instancing;
- object-ID click picking;
- hide/isolate/select and one clip plane;
- stats overlay and deterministic disposal.

No GPU compute culling is required to call the first slice successful. It is
added only when a public benchmark shows the bottleneck.

The Phase 1 evidence app now opens the compiled glTF node graph before geometry,
decodes the external binary in a Worker, transfers three reusable prototype
batches, and renders per-occurrence transforms, source colors, explicit CAD
edges, an isometric bounds fit, and integer object picking. Selecting an
occurrence resolves its glTF node and revision-local OCCT edge references.
Visibility, navigation, clipping, hierarchy inspection, and local/URL package
opening are implemented. One persistent geometry Worker validates the glTF,
composes active-node float64 transforms, and builds direct target-chunk
occurrence tables once for the scene session. Coarse and whole-target decodes
reuse the prepared renderable list; each target Range decode visits only its
indexed occurrences rather than traversing the active node graph again. Result
transforms are cloned at the Worker transfer boundary so transferring one
decoded chunk cannot detach the prepared session state. When a document
declares `extras.madi.nodeIdentityDerivation` (ADR-0015), the same traversal
reconstructs every omitted `semanticId` and `sourceRef` from that rule, and a
node carrying `translation` instead of `matrix` composes to the identical
float64 transform; picking, the assembly tree, and property lookup see no
difference, proven occurrence by occurrence in
`artifacts/compiler/node-field-elision/`. Prototype-local surface
bounds are also cached once; each occurrence transforms eight AABB corners
instead of every vertex, conservatively matching the coarse-bounds contract. For the
compiler's `prototype-aabb-v1` tier, it collapses prototype AABBs into one
canonical box batch with contiguous occurrence transforms and target-mesh
indexes. Target prototype ranges are fetched and decoded one at a time;
promoted targets mask their matching coarse instances, and eviction reveals
those instances again while preserving node-derived object IDs. Coarse
instances that stay visible because their own target is not resident are
drawn one depth quantum behind every resident target surface, so a proxy box
face lying in the plane of a neighbour's loaded wall or slab no longer
speckles through it while the budget holds
([test](../apps/webgpu-spike/test/progressive-residency.test.ts)). Selecting an
unresolved occurrence can pin its requested target and demote colder target
groups within the same decoded/GPU budgets. Scene replacement or explicit
user cancellation aborts the active range, terminates the session Worker, and
prevents later ranges from starting. Packages without an ADR-0008 index keep
the existing camera scheduler, which ranks each target chunk from
retained-coarse bounds built once per scene. An indexed package instead fetches
and verifies `spatial.bin` after the coarse frame, conservatively traverses its
float64 BVH in the camera-relative frustum, and requests only the deduplicated
chunks referenced by visible leaves. Cold chunks remain in the residency order
but are not fetched. Orbit, pan, zoom, fit, and resize re-query demand and
re-rank resident eviction priority; if the hottest nonresident chunk changes,
the old HTTP Range and Worker decode are aborted before its replacement is
admitted. A budget-blocked demand signature prevents an unchanged camera update
from refetching the same rejected chunk; selection resume or a changed demand
order reopens scheduling. Prefetch is estimate-gated: each chunk's decoded and
GPU cost is derived once from the document's accessor counts, and a chunk that
exceeds the free headroom with no colder unpinned group available to evict is
skipped where its range request would have been issued. Because promotion only
ever displaces groups colder than the incoming priority, that condition is
exactly the one under which admission could not succeed, so the gate changes
what is transferred and never what becomes resident. A prototype's vertex pool
is decoded once per mesh and shared by the material groups that reference the
same accessors, so both that estimate and the resident charge count it once;
the renderer holds one refcounted vertex buffer behind the sibling batches and
releases it with the last of them. Without that sharing the sixty5 package's
largest chunk charged 75,373,776 bytes for 673,080 distinct vertex bytes and
no eviction order could admit it. Spatial draw clusters, screen-space LOD, persistent cache tiers, and
a broader eviction policy remain unimplemented. The focused transform-only
record under `artifacts/spatial-demand/` passes in headed Chrome and Firefox;
Digital Hub and sixty5 also pass offline co-demand censuses. A headed Digital
Hub localized trace now measures what a real localized view demands: 109 of 255
BVH nodes, 28 of 128 leaves, 1,129 of 5,152 occurrences, and 52 of 71 chunks
under the default payload order against 42 of 66 under leaf-anchor ordering, at
p95 0.085 ms per query over 48 navigation frames
(`artifacts/spatial-demand/digital-hub-localized/`). Repeating it over sixty5,
where the 120,707,064 target bytes cannot fit the 67,108,864-byte budget, shows
the same reduction deciding what is fetched at all: 889 of 4,095 nodes, 184 of
2,048 leaves, 7,026 of 78,173 occurrences, and 209 of 234 chunks against 152
under leaf-anchor ordering, with every window inside the budget and the first
coarse frame unmoved at 4.213-4.388 s
(`artifacts/spatial-demand/sixty5-localized/`). A non-Blink repeat and the
nested-view ADR-0005 cross-check are still pending, so ADR-0008 remains
Proposed.

The scheduler orders that demand before the budget cuts it off. The default
policy ranks a visible leaf by the squared distance from the view centre to its
projected centre; `?demandPriority=screen-coverage` instead ranks by the
clipped normalized-device area the leaf's bounds project to, aggregated per
chunk as a maximum, with the distance rank as the tiebreak so the ordering
stays total and deterministic. Coverage is a ranking signal, not a measurement:
it prices an axis-aligned bound, attributes a leaf's area to every chunk that
leaf references, and gives any bound straddling the eye plane the whole view.
Both policies were recorded against a 192 MiB reference render of the same pose
at a 64 MiB budget: on a close view area ordering agrees with that reference in
99.12% of pixels against 64.95%, and on a mid view it loses, 93.86% against
96.31% (`artifacts/spatial-demand/sixty5-demand-priority/`). Area ordering is
therefore opt-in and the default ordering is unchanged; a demand cost that
blends the two is unimplemented.

The reproducible browser smoke command is `pnpm browser:matrix`. Its committed
Phase 1 run covers Chrome/Blink and Firefox/Gecko with the same compiled package,
hierarchy-before-binary assertion, viewport, pick coordinate, expected
occurrence/source mapping, and console-error policy. See
`artifacts/browser-matrix` for exact versions, adapter disclosure, screenshots,
and hashes. A separate real-Safari probe, `pnpm safari:compatibility`, uses the
macOS-provided SafariDriver. The reviewed Safari 26.6.1 default-settings run on
macOS Sequoia loads all 87 hierarchy records but does not expose
`navigator.gpu` — Apple enables WebGPU by default only in Safari 26 on
macOS 26 (Tahoe) and newer OS releases — then reaches the expected
unsupported-browser diagnostic; it is capability/failure evidence, not
rendering conformance.
