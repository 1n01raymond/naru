# ADR-0008: Separate spatial demand from shared prototype payload ownership

Status: Proposed

## Context

The current progressive package writes target geometry once per prototype in
prototype-ID order, then coalesces adjacent byte ranges into bounded HTTP
request chunks. The browser builds one world-space AABB for each request chunk
from every retained-coarse occurrence that uses one of its prototypes. Camera
navigation can re-rank those chunk bounds and cancel obsolete work, but a
prototype reused across distant parts of a scene gives its chunk a diffuse
bound. A visible portion of that bound can therefore request unrelated target
geometry, and the bound cannot become a useful unit for later screen-space LOD
or draw culling.

NARU must improve spatial locality without duplicating prototype geometry,
breaking occurrence/source identity, regressing the accepted large-coordinate
precision path, or making a custom container the engineering source of truth.
The first spatial contract must also remain optional so historical
`madi.experimental.gltf.1` packages continue to load.

## Decision

1. Treat spatial demand partitions, target payload ownership, and draw clusters
   as separate mappings. One partition does not need to satisfy all three
   concerns.
2. Preserve one target geometry payload per prototype. An occurrence belongs to
   one spatial leaf, while the same prototype or target chunk may be referenced
   by many leaves without duplicating its geometry bytes.
3. Introduce an optional derived-cache sidecar named `spatial.bin`, referenced
   from `extras.madi.progressive.spatialIndex`. The pointer carries schema,
   URI, byte length, and SHA-256 fields using the same integrity pattern as the
   package property sidecar.
4. Name the first sidecar schema `naru.spatial-demand-index.1`. ADR-0007 keeps
   the historical `extras.madi` envelope spelling, but every new schema family
   starts with the `naru.` prefix.
5. Store a deterministic flat BVH over renderable occurrence world bounds.
   Bounds use float64 coordinates. Leaves identify their occurrences and carry
   sorted, deduplicated references to the existing `targetChunks` array. The
   exact binary field layout, allocation limits, and magic/version checks are
   fixed by the paired schema validator rather than by this ADR.
6. Build the index in the compiler from delivered coarse bounds and the emitted
   glTF node transforms. Input occurrences are ordered by stable IDs; split-axis,
   centroid, child-order, and reduction ties have explicit deterministic rules.
7. Query the BVH with camera frustum planes and aggregate a generation-local,
   deduplicated target-chunk demand set. Selection may force an off-screen chunk
   into demand and pin its resident target geometry. Existing Range/Worker
   cancellation and decoded/GPU budgets remain authoritative.
8. Keep packages without the sidecar on the current coarse-chunk-bound scheduler.
   A missing optional index is not an error; a declared index with an invalid
   digest, schema, bound, count, or reference is rejected before allocation.
9. Prepare the active glTF graph once per Worker session: retain composed
   float64 occurrence transforms and direct target-chunk occurrence tables.
   A target Range decode must use that table instead of traversing all active
   nodes. Transferable decode results own transform copies so one completed
   transfer cannot detach the prepared state needed by later chunks.
10. Keep prototype-ID payload order as the compatibility default. An explicit
   `spatial-leaf-anchor-v1` experiment may instead assign each prototype to the
   deterministic BVH leaf containing the most occurrences (earliest DFS leaf
   breaks ties), order prototype payloads by that anchor, and then apply the
   existing byte-budget coalescer. The glTF profile, accessor semantics, and
   one-payload-per-prototype ownership remain unchanged; the selected order is
   declared in progressive metadata and the build report. It cannot become the
   default until real-model requested/off-view-byte evidence passes.
11. Order the demanded chunks by the distance from the view centre to the
   visible leaf's projected centre. An explicit `screen-coverage` policy may
   instead order by the clipped screen area a leaf projects to, selected per
   session and never by default: it renders closer to an unbudgeted reference
   on a close view and further from it on a mid view of the same model
   (`artifacts/spatial-demand/sixty5-demand-priority/`), so it is a recorded
   option, not a decision. Ordering changes which demanded chunks a bound
   budget admits first; it changes neither the demand set nor the package.
12. Spatial draw clustering is later still and requires geometry resources to
   be separable from instance clusters.

## Consequences

### Positive

- Repeated prototype geometry remains shared even when its occurrences occupy
  many spatial leaves.
- Camera work scales with visited spatial nodes and visible candidates rather
  than all occurrences in a steady localized view.
- The same spatial hierarchy can later supply screen-space LOD demand and draw
  cluster candidates without making those policies part of the first slice.
- Historical packages and evidence remain readable through the existing
  scheduler fallback.
- A separate digest-linked sidecar remains an inspectable derived cache under
  the standards-first format strategy.

### Negative

- The package gains one resource and one integrity-checked fetch before indexed
  scheduling can begin.
- A fit-to-scene view can legitimately visit most of the hierarchy; the index
  does not make an all-visible scene spatially selective.
- A leaf can still demand unrelated bytes when the compatibility payload order
  mixes prototypes with different spatial demand. The leaf-anchor experiment
  reduces this on the focused oracle, Digital Hub, and sixty5, but localized
  camera traces still need to show the same benefit through the browser.
- Large or scene-spanning occurrences can overlap many queries and need explicit
  isolation/tuning in the builder.
- Compiler and runtime must maintain a versioned binary decoder and strict
  allocation limits.

## Alternatives considered

- **Duplicate prototype geometry into spatial cells.** Rejected because it
  destroys the project's validated instancing and memory advantages.
- **Build the primary index in every browser session.** Rejected as the default
  because it repeats deterministic compiler work during startup and spends the
  remaining margin in the real-large first-frame budget. Runtime construction
  remains a possible experiment, not the package contract.
- **Continue using one aggregate AABB per target chunk.** Retained as the legacy
  fallback, but it cannot distinguish distant occurrences that share a chunk.
- **Adopt 3D Tiles or a custom NARU container immediately.** Deferred by
  ADR-0004 until measured gaps justify a broader delivery-format commitment.
- **Use one uniform grid or octree as the permanent policy.** Deferred because
  long, sparse, and highly anisotropic engineering scenes need evidence before
  a fixed subdivision policy is frozen.

## Validation

The ADR remains Proposed until a vertical evidence slice proves all of the
following:

The focused `artifacts/spatial-demand/` record already proves deterministic
sidecar generation without target/coarse byte changes, strict no-false-negative
unit/oracle coverage, localized work reduction, single-chunk delivery, and
obsolete-Range cancellation in headed Chrome and Firefox. The transform-only
scenario does not close the nested/ADR-0005 or Digital Hub/sixty5 gates below.
The compiler unit oracle additionally proves deterministic leaf-anchor packing,
coarse-byte stability, one payload per prototype, and a localized 2→1 chunk
reduction. The Digital Hub offline leaf census proves 71→66 chunks,
1,458→882 leaf chunk references, and 637,689,824→383,315,164 summed off-view
bytes with unchanged coarse output. It is not a headed camera trace, and the
single compile timings are diagnostic rather than performance evidence.
Separate headed Chrome full-fit runs also reproduce 71→66 target Ranges with
equal resident bytes, picking, and property resolution and no console issues.
Because each is one run and the fitted view visits every leaf, they do not close
the localized-query or repeated first-frame timing gates. The current split.4
sixty5 census covers 2,048 leaves and reduces leaf chunk references
34,167→21,246 and summed off-view bytes
15,972,343,228→9,668,115,064 (−39.47%), with unchanged useful, target, and
coarse bytes and a byte-identical repeat. Its compatibility/leaf-anchor global
chunk counts are 324/325, so the decision depends on local demand rather than a
claim that total request count always falls. Both compact-JSON packages pass
Khronos validation with zero errors and warnings. After removing the full
188,319-record hierarchy rescan from each target promotion, separate headed
Chrome sixty5 runs now complete selection and property resolution: compatibility
records a 6,417 ms coarse frame / 20,899 ms budget-limited ready state and
leaf-anchor records 6,503 / 21,369 ms, with no console issue. The initial fit
still intersects all 2,048 leaves, and each result is a single run, so neither
localized camera reduction nor the required three-run p95 is yet proven.

`artifacts/spatial-demand/digital-hub-localized/` closes the localized-query
gate for the four-discipline federation in headed Chrome 151 on Windows. One
scripted zoom and pan take the query from the fitted 255/255 nodes, 128/128
leaves, and 5,152/5,152 occurrences down to 109 nodes, 28 leaves, and 1,129
occurrences. On that identical view the compatibility package demands 52 of its
71 chunks (23,065,180 of 35,962,344 target bytes) and the leaf-anchor package 42
of its 66 (20,111,204 bytes), which is the first browser-side confirmation that
the offline off-view census predicts real demand rather than only offline
totals. Across 48 navigation queries the cost is p50 0.035 ms / p95 0.085 ms
(compatibility) and p50 0.035 ms / p95 0.080 ms (leaf-anchor), no navigation
frame falls back to a total-occurrence traversal, residency and console output
stay unchanged while the camera moves, and every pinned counter repeated across
three runs per payload order. Digital Hub fits the residency budget whole, so
the trace makes no first-frame claim.

`artifacts/spatial-demand/sixty5-localized/` closes that gate on the federation
where the residency budget binds. The fitted view demands all 234 chunks and
120,707,064 target bytes against a 67,108,864-byte budget, so estimate-gated
prefetch skips what it cannot admit and a localized view changes what is
fetched, not only what is demanded. The same scripted zoom and pan take the
query from 4,095/4,095 nodes, 2,048/2,048 leaves, and 78,173/78,173 occurrences
down to 889 nodes, 184 leaves, and 7,026 occurrences. On that identical view the
compatibility package demands 209 of its 234 chunks (107,337,264 bytes) and the
leaf-anchor package 152 (78,875,544 bytes): 27.3% fewer chunks and 26.5% fewer
bytes, a wider margin than Digital Hub's, which is what the off-view census
predicts as a site grows. Localized navigation costs p50 0.280 ms / p95 0.390 ms
(compatibility) and p50 0.300 ms / p95 0.405 ms (leaf-anchor) over 48 queries,
with no total-occurrence fallback. Every window of both orders ends at or under
the residency budget, and the committed samples reach their first coarse frame
at 4.300 s (compatibility) and 4.812 s (leaf-anchor), far inside the 15-second
bound this decision requires. Because the budget evicts, the two
orders hold different chunk sets and render 2,180,160 against 2,182,636
triangles from the same view; the record states that rather than asserting
equality. Firefox and Safari reproduction of a localized trace and the
nested/ADR-0005 cross-check remain open.

- every renderable occurrence is indexed exactly once, every leaf bound contains
  its references, and BVH queries have no false negatives against a brute-force
  frustum oracle;
- two compilations produce byte-identical `spatial.bin` output, and input-order
  permutations do not change the result;
- the index-only compile keeps `scene.bin` and `coarse.bin` byte-identical while
  a prototype referenced by multiple leaves still owns one target Range;
- nested transforms, source-axis conversion, and the ADR-0005 10,000 km fixture
  retain finite float64 bounds and the accepted precision result;
- localized camera traces visit strictly fewer spatial nodes, leaves,
  occurrences, and candidate chunks than their recorded totals, without a
  total-occurrence traversal in the steady navigation path;
- camera changes still cancel obsolete HTTP Range and Worker decode work, and
  selection pinning, picking/source identity, coarse fallback, and the fixed
  decoded/GPU budgets remain intact;
- headed Chrome and Firefox reproduce the request sequence with no console
  warnings or errors, while legacy packages retain their current behavior;
- Digital Hub and sixty5 publish index size/build cost and
  compatibility-order versus leaf-anchor requested/off-view bytes; the Digital
  Hub and sixty5 localized headed traces publish query p50/p95 and candidate
  reduction, the sixty5 trace measuring demand where the residency budget binds.
  The sixty5 first coarse frame must remain at or below 15 seconds on the same
  recorded host class, which the committed samples do at 4.300 s
  (compatibility) and 4.812 s (leaf-anchor).

This evidence may accept the spatial-demand decision only. It does not by
itself make an ADR-0003 renderer-performance claim, prove screen-space LOD, or
prove spatial draw clustering. The demand-ordering record
(`artifacts/spatial-demand/sixty5-demand-priority/`) is outside this gate: it
compares two orderings of an already-decided demand set, and its own outcome is
view-dependent, so no ordering may become the default on it.
