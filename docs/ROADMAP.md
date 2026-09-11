# Roadmap

Status: Draft 0.1

The roadmap is evidence-gated rather than date-driven. A phase exits when its
criteria are demonstrated in the repository.

## Phase 0 — Architecture and feasibility

Status: Complete (2026-08-23). See the [evidence record](PHASE_0.md).

### Outcomes

- product requirements and scope;
- accepted first architecture decisions;
- selected redistributable STEP fixtures;
- small WebGPU prototype proving surface + explicit edge + object ID rendering;
- OCCT spike proving assembly/prototype/occurrence extraction;
- benchmark harness skeleton.

### Exit criteria

- one STEP assembly produces a validated in-memory Scene IR;
- one prototype appears in multiple occurrences without geometry duplication;
- OCCT source edge references survive into a rendered selection demo;
- direct WebGPU buffer layout and object picking work on two browser engines;
- risks and unsupported source data are reported rather than ignored.

## Phase 1 — Vertical slice (`0.1.0-alpha`)

Status: Complete (2026-08-28). See the
[completion report](PHASE_1_REPORT.md).

### Compiler

Current evidence: the first deterministic package emits standard glTF 2.0 JSON,
external binary geometry, and build reports from local AP242/AP214 through the
isolated OCCT adapter. It preserves hierarchy, prototype reuse, explicit edges,
and source identity; expanded Scene IR is temporary. Direct STEP output now
separates prototype AABB proxies from target geometry in two standard glTF
buffers. Shape-preserving LOD is now implemented opt-in and recorded on a STEP corpus
([ADR-0025](adr/0025-shape-preserving-lod-representation.md)); optional
spatial-demand indexing
and payload ordering were implemented after this initial slice and are tracked
in the [Phase 2 tracker](PHASE_2.md). See the historical
[Phase 1 tracker](PHASE_1.md).

The direct AP242 package also records deterministic prototype byte ranges over
`scene.bin`. The browser promotes each completed HTTP Range while retaining
coarse batches for unresolved prototypes. A selected occurrence can pin its
target detail and demote colder target groups back to retained coarse batches
under the same budgets. Camera-driven chunk-bounds reprioritization and an
optional spatial-demand path are now implemented; a view-independent demand
cost remains pending.

An early IFC risk slice now compiles the qualified four-discipline Digital Hub
federation through isolated IfcOpenShell into the same Scene IR and glTF path.
It proves document-scoped identity, hierarchy, mapped geometry reuse, material
groups, and flattened properties. Its 3,383 prototype ranges now coalesce into
45 static target requests; the browser reconciles stable GPU batches under
separate 64 MiB decoded/GPU admission budgets. A selected target can replace
colder detail with retained coarse fallbacks, preserving visibility and picking
identity. It is not the Phase 3 BIM workflow or, by itself, a Phase 2
performance result. Spatial demand and view-driven scheduling now have separate
Phase 2 evidence; persistent browser cache tiers remain pending. A
focused project-owned IFC4 wall now proves the E2.1 boundary path separately:
12 OpenCascade face-boundary segments survive into glTF with source-item
mapping while six triangle face diagonals are excluded. Analytic curve kinds,
richer edge classification, and a real-model edge re-record remain pending.

The adapter boundary now uses a split Scene IR transport — structure-only JSON
plus a digest-linked binary geometry file — which reproduces the same compiled
package while halving the document the compiler must parse. That was enough to
qualify the 839.9 MB seven-discipline `sixty5` federation as a source and to
extract 4.87M unique triangles from it, and it exposed the next boundary: the
initial 631.9 MB structure document was larger than one JavaScript string. The
compiler streams that document record by record; interning property keys
and key combinations at scene level shrank the structure to 419.5 MB — back
under one string, with the boundary crossing preserved in history — and
moving the property values into a deduplicated binary column file shrank it
further to 345.5 MB, with the compiler verifying the columns without ever
materializing a value. The compiled package republishes those properties as a
`madi.package-properties.1` sidecar (`properties.json` + the column file byte
for byte), so viewers resolve a picked occurrence's property sets without any
Scene IR intermediate; the Studio does exactly that, lazily per selection.
sixty5 compiles end to end into 608.2 MB of Khronos-validated core glTF
resources (`scene.gltf`, `scene.bin`, and `coarse.bin`), or a 657.1 MB compiled
package including the property sidecar. Headed Chrome consumes that package:
all 78,173 renderable occurrences render, the separate fixed 64 MiB target
decoded/GPU admission budgets hold, and picking
resolves the selected occurrence's lazily fetched property sets. The original
268.0 s first coarse frame (`artifacts/ifc/sixty5-browser/`) is reduced to a
4.743 s first coarse frame by shared coarse residency, a persistent document
Worker, a virtualized assembly list, skip-and-continue residency admission,
estimate-gated prefetch that skips the chunks the budget cannot hold, and a
vertex pool shared across a prototype's material groups, which raises the
resident endpoint to 111 of 234 chunks
(`artifacts/ifc/sixty5-first-frame/`).
Headed Firefox consumes the same package and settles on a byte-identical
resident set at about 1.28x the first frame, so the residency budget tracks
measured bytes rather than one engine’s behaviour
(`artifacts/ifc/sixty5-first-frame-gecko/`). Every real-large figure the phase
has recorded is presented together in `docs/REAL_LARGE_RESULTS.md`.

- local STEP AP242 input;
- XDE hierarchy, names, colors, units, transforms;
- coarse and target display tessellation;
- explicit CAD edges;
- deterministic manifest, hierarchy index, and fixed binary chunks;
- independent validator and build report.

### Runtime

Current evidence: the browser reads the compiled glTF hierarchy first, decodes
`scene.bin` in a Worker, transfers shared typed-array batches to direct WebGPU,
and preserves source-aware object picking in headed Chrome and Firefox. Orbit,
pan, zoom, fit, synchronized selection, hide/isolate, and one section plane are
implemented. Hierarchy/source-identity search and occurrence properties are
also available, including lazily resolved IFC property sets from the package
sidecar (search over property values is a deliberate Phase 1 exclusion). The
Studio opens shareable HTTP(S) scene URLs and validated local `.gltf`
packages with all declared `.bin` and `.json` resources without uploading
them. A delayed-network browser record proves a coarse WebGPU frame before the
target request completes and a mixed coarse/target frame after one prototype
range. User/scene replacement cancellation now stops an active range and its
Worker. Coalesced range promotion does not rebuild unchanged GPU buffers and
has a fixed admission cap. A selected occurrence can pin a requested target
chunk and replace colder target detail with retained coarse fallbacks;
camera navigation now re-ranks retained-coarse chunk bounds, cancels an
obsolete active Range/Worker decode, and applies the same order to residency
eviction. Packages carrying the Proposed ADR-0008 sidecar now fetch and
authenticate it after the coarse frame, query only frustum-intersecting BVH
leaves, demand their deduplicated target chunks, and retain all other chunks as
a cold eviction tail. A focused transform-only scenario now reproduces 3→1
candidate chunks with obsolete-Range cancellation in headed Chrome and Firefox
(`artifacts/spatial-demand/`), and a headed Digital Hub localized trace records
109/255 nodes, 28/128 leaves, 1,129/5,152 occurrences, and 52 of 71 demanded
chunks against 42 of 66 under leaf-anchor ordering
(`artifacts/spatial-demand/digital-hub-localized/`). The sixty5 repeat, where
the budget binds, records 184/2,048 leaves, 7,026/78,173 occurrences, and 209 of
234 demanded chunks against 152 under leaf-anchor ordering, inside the budget
and without moving the first coarse frame
(`artifacts/spatial-demand/sixty5-localized/`). An opt-in screen-space demand
ordering is now recorded against an unbudgeted reference render: it wins
decisively on a close view (99.12% pixel agreement against 64.95%) and loses on
a mid view (93.86% against 96.31%), so it ships behind
`?demandPriority=screen-coverage` with the default ordering unchanged
(`artifacts/spatial-demand/sixty5-demand-priority/`). A non-Blink localized
repeat, a view-independent demand cost, and persistent cache tiers remain
pending. The session Worker now also prepares
active float64 transforms and direct chunk occurrence tables once, so target
Range decodes no longer traverse the document node graph; transferred result
buffers remain isolated from that prepared state. The compiler also has an
opt-in `spatial-leaf-anchor-v1` payload order that feeds deterministic BVH leaf
co-demand back into the existing byte-budget coalescer. Its focused 2→1 chunk
oracle and Digital Hub offline census pass: 71→66 chunks, 1,458→882 leaf chunk
references, and 39.89% less summed leaf off-view payload. The current explicit-edge
sixty5 census independently records 34,167→21,246 leaf chunk references and
39.47% less summed off-view payload while global chunks change 324→325.
Localized headed sixty5 evidence is now recorded. Headed full-fit
integration pairs pass for both models: Digital Hub records 71→66 target Ranges,
while sixty5 records 6,417/6,503 ms coarse frames and completes budget-limited
selection/property checks after target promotion stopped rescanning all 188,319
hierarchy records. The fitted sixty5 view sees every leaf and does not improve
Range count (45→46); the localized repeated record above is therefore the
relevant demand result. A non-Blink real-model repeat remains pending.

The camera-relative precision path is now decision evidence for ADR-0005. A
project-owned 0.25 mm gap is retained at a 10,000 km offset with
0.000000387 mm measured error, while headed Chrome and Firefox reproduce
byte-identical near/far frames through navigation, sectioning, and picking.
The record is `artifacts/precision/large-coordinates/`; real Safari remains a
graceful unsupported-browser capability result because Safari 26.6.1 on
macOS Sequoia does not expose WebGPU under the recorded default settings
(Apple enables it by default only from Safari 26 on macOS 26 Tahoe).

- manifest/hierarchy-first loading;
- Worker decode;
- direct WebGPU surfaces and edges;
- CPU frustum culling, prototype instancing, bounded buffer pools;
- click object picking;
- selection, hide/isolate, assembly tree, one section plane;
- disposal and basic device-loss handling;
- local stats overlay.

### Studio

Current evidence: the [public GitHub Pages demo](https://1n01raymond.github.io/naru/)
opens the qualified Digital Hub package by default and PyGamer as a secondary
scene. The deployment verifies the package digests before publishing and
smoke-checks the live app, package resources, and HTTP Range delivery.

- open local/URL compiled scene;
- orbit/pan/zoom and fit;
- hierarchy search and properties;
- selection/hide/isolate/section;
- diagnostic and performance panels.

### Exit criteria

- public end-to-end demo;
- useful frame before full target geometry is resident;
- source occurrence selection maps back to source reference;
- no total-scene traversal in the steady navigation hot path;
- reproducible benchmark report.

All five criteria are closed by the [Phase 1 completion
report](PHASE_1_REPORT.md). Known limits and proposed ADR gates remain visible
without extending the completed vertical-slice scope.

## Phase 2 — Large-scene alpha (`0.2.x`)

Status: Current. Detailed implementation state, dependencies, prioritized work,
and evidence debt live in the [Phase 2 tracker](PHASE_2.md).

- content-addressed persistent cache under the
  [import/cache product contract](IMPORT_AND_CACHE.md): cancellable background
  cold import, hierarchy/coarse preview in 5–15 s, unchanged reopen in 1–5 s,
  dependency-safe per-discipline rebuild, and later authorized shared reuse;
- view-prioritized scheduling and cancellation of obsolete camera work;
- dynamic target-geometry budgets, total-memory accounting, and persistent
  browser cache tiers;
- spatial/draw clustering;
- screen-space LOD policy;
- broader selected-object residency policy and multi-selection pinning;
- multi-view support;
- improved sections, measurement, and snapping;
- workspace with sources, views, selection sets, and annotations;
- framework-neutral embedding examples.

Current scale evidence: the [31-document sixty5 Design + Engineering
qualification](../artifacts/ifc/engineering-baseline/README.md) records 104,337
renderable geometric occurrences, 46,059,890 submitted triangles, 66,396
geometric prototypes, and 10,394,938 unique triangles in a Khronos-clean
package. That package is now served from the delivery origin accepted in
[ADR-0023](adr/0023-public-package-delivery-origin.md) and opened through the
deployed Studio in a [browser record](../artifacts/public-demo/engineering-baseline-origin/README.md),
so the first exit criterion is met. The published bytes are the publishing
host's compile rather than the macOS qualification's; both digests are pinned,
and the reconciliation is tracked as a limitation in the
[Phase 2 tracker](PHASE_2.md).

That package's 405,570,167-byte compiled document is now split member by member
([record](../artifacts/compiler/node-field-elision/README.md)): its 268,002
nodes are 36.2% of the document, and two opt-in compiler options (ADR-0015)
remove 23,459,373 B (5.78%) of it while the runtime reconstructs every elided
identity and transform exactly. The same measurement ranks mesh-less hierarchy
nodes (21.88%) above both levers, so document size is measured, not solved.

### Exit criteria

- one redistributable source-derived engineering package with at least 100,000
  renderable geometric occurrences, 10,000,000 submitted triangles, and 10,000
  geometric prototypes, with unique triangle count reported alongside;
- cold/warm startup, frame, memory, and interaction results published;
- forced low-memory scenario remains functional;
- workspace reopens against unchanged source and detects changed source.

## Phase 3 — Open platform beta (`0.3.x`)

- plugin manifest, capabilities, commands, panels, namespaced workspace data;
- worker analysis API and bounded overlays;
- production-grade IFC adapter and BIM property workflow;
- glTF/standards-based input/output profile;
- self-host deployment example;
- source resolver/compile service contract;
- safe mode and plugin compatibility diagnostics;
- broader browser/GPU conformance matrix.

### Exit criteria

- two non-core plugins maintained independently;
- runtime embedded in an app other than Studio;
- STEP and IFC sources coexist in one workspace;
- private-network deployment documentation validated by a design partner.

## Phase 4 — Production hardening (`0.4+`)

- schema/API compatibility policy backed by tests;
- fuzzed decoders and parser isolation guidance;
- incremental compilation/chunk reuse where adapters support it;
- revision comparison and identity confidence tools;
- signed/self-hosted plugin distribution;
- accessibility and localization completion for Studio core;
- release, migration, and long-term support policy.

## Future workbenches

These are explicitly outside the initial critical path:

- exact section/measurement service backed by B-Rep;
- assembly composition and constraints;
- sketch and parametric feature editing;
- drawing/PMI/GD&T workbench;
- clash/clearance and rules engines;
- point clouds and simulation result fields;
- collaborative review and issue federation;
- agent-accessible engineering commands.

## Workstreams

The implementation can be organized into parallel but integrated tracks:

| Track | First responsibility |
|---|---|
| IR & schema | typed IDs, validation, fixtures, manifest experiments |
| OCCT adapter | STEP assembly, tessellation, edge/source mapping |
| Compiler | normalization, instancing, chunking, reports |
| Runtime core | loading, tables, scheduling, cache, Workers |
| WebGPU | allocators, surfaces, edges, picking, clipping |
| Studio | reference UX, tree, properties, diagnostics |
| Benchmarks | datasets, traces, baselines, result publication |
| Plugins | capability model and first example after vertical slice |

## Go/no-go checkpoints

### After Phase 0

Decision: continue to Phase 1. The 2026-08-23 evidence review connected source
identity, explicit edges, and direct WebGPU rendering without making OCCT a
browser dependency. ADR-0003 remains proposed until its narrower performance
gate is measured. ADR-0005 was accepted on 2026-08-26 after its 0.25 mm detail
at 10,000 km precision gate passed in headed Chrome and Firefox.

### After Phase 1

Decision: continue to Phase 2. The 2026-08-28 evidence review closed all five
vertical-slice criteria, including the public reproducible performance report
([record](PHASE_1_REPORT.md)). Standards-based glTF remains the delivery
boundary and the compiled cache stays derived. ADR-0003 remains Proposed: the
Phase 1 report publishes the divergent browser/hardware results instead of
turning an exploratory comparison into a renderer-decision claim.

### After Phase 2

Decide whether NARU's strongest adoption path is Studio, embedded runtime, or
compiler infrastructure. Preserve all three boundaries, but concentrate
maintainer resources where external use appears.
