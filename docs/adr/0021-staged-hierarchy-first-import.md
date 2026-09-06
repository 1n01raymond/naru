# ADR-0021: Publish an import's assembly tree per document, before geometry

Status: Proposed

Reviewed: 2026-09-04

## Context

Issue #73 asks for the product behaviour behind a cold import: while a real-large
IFC federation is being extracted, the user should see the assembly tree and a
coarse preview instead of a spinner, and should be able to cancel. The lifecycle
and cancellation halves landed with ADR-0020; what was missing was the shape of
the thing to publish early, and any measurement of whether the target is
reachable at all.

Its acceptance criterion 8 sets the product target: a usable hierarchy in
**5 to 15 seconds**. Nothing in this repository measured how long an assembly
tree takes to produce, so the design question was open in the worst way -- a
plausible answer ("walk the spatial containment relations, they are only a few
dozen entities") sits next to a very different real one.

[artifacts/import/structure-readiness](../../artifacts/import/structure-readiness/README.md)
measures it, on both committed IFC federations, five fresh-process samples each.
The numbers decide the design:

| | Digital Hub (4 docs, 67.8 MB) | sixty5 (7 docs, 839.9 MB) |
|---|---|---|
| Whole federation, sequential | 2,455.9 ms | 40,474.9 ms |
| Estimated six-thread makespan | 805.4 ms | 15,030.3 ms |
| First document ready | 315.0 ms (architecture) | 278.5 ms (facade) |
| Parse share of ready | 98.46% | 98.60% |
| Containment walk share | 1.26% | 1.25% |
| Structure share of the cold adapter | 5.46% | 14.33% |

Three readings, and each one closes off a design:

**Parsing is the whole cost.** The walk that produces the tree is 31.0 ms on
Digital Hub and 506.2 ms on sixty5 -- 1.3% of the time. Serializing it is 1.9 and
32.2 ms. Every millisecond that matters is spent by IfcOpenShell turning STEP
text into an entity graph. There is no smarter query, no cheaper traversal, and
no index that helps: the cost is paid before the first relation can be read.

**A whole-federation tree cannot meet the target on sixty5, and threads cannot
fix it.** 40.5 s sequential is far outside the band, and the estimated six-thread
makespan is 15,030.3 ms -- which is exactly the time of the single largest
document (`arc.ifc`, 342.7 MB). A schedule cannot finish before its longest job,
so no amount of parallelism brings the *whole* tree inside 15 s. The estimate is
arithmetic over measured per-document durations, not a measured parallel run, and
the record says so; but the bound it establishes is a floor, and a real parallel
run can only be slower.

**A per-document tree is ready almost immediately.** The first document is ready
in 278.5 ms on sixty5 and 315.0 ms on Digital Hub -- two orders of magnitude
inside the band, on the harder model. Parse throughput is 20-29 MB/s across all
eleven documents, so a document's tree arrives roughly in proportion to its size,
and the smallest arrives first.

That is the finding this ADR is built on: **the unit of early publication is one
document's assembly tree, not the federation's.** Digital Hub could publish the
whole tree at once and meet the target; sixty5 cannot, and sixty5 is the model
the phase exists to serve.

## Decision

### The staged unit is one document's assembly tree

A cold import publishes a *staged preview* incrementally: as each document is
parsed, its assembly tree becomes readable, before any document is tessellated
and long before the package is written. The preview grows document by document
and is complete when the last tree lands; it never waits for geometry.

The federation-wide tree is not a publication point. On Digital Hub it happens
to arrive in 2.5 s, but designing to that number would produce a product that
works on the small model and shows nothing for 40 s on the large one.

### Emission order is by ascending source size; assembly order does not move

The adapter emits structure for the smallest document first, because ready time
tracks source bytes at 20-29 MB/s on this host and the smallest tree is therefore
the earliest useful thing a user can see. Ordering is a scheduling choice, not a
progress estimate -- ADR-0020 refused to derive `progress` from source bytes and
that stands; nothing here reports a percentage or an ETA.

Emission order must not touch **assembly** order. `parse_inputs` sorts documents
by discipline and the durable Scene IR is built in that order; determinism is a
feature, so the staged path reorders what is *published early* and leaves what is
*written* exactly where it was. A compile with the preview enabled and one
without must produce the same package digest, byte for byte.

### The staged preview reuses the relocated hierarchy sidecar

The preview is not a new tree format. ADR-0017 already moved the assembly tree
out of the glTF document into `naru.package-hierarchy.1` -- a `hierarchy.json`
header plus `hierarchy.bin` columns, readable standalone by
`packages/runtime-webgpu/src/package-hierarchy.ts`. A staged preview is that same
pair, published per document, plus a small manifest naming which documents it
already covers.

Reusing it means the Studio reads one tree format, the preview and the final
package agree by construction, and a preview cannot drift into a second,
half-supported hierarchy encoding.

### A preview is a distinct artifact and can never be mistaken for a package

The staged directory carries its own schema identifier and is never a compiled
package: it has no `scene.gltf`, no `scene.bin`, and no digest chain. A consumer
that asks for a package and is handed a preview fails closed, the way
ADR-0011's transport already refuses a document whose shape it did not expect.

Each staged resource is published atomically -- written to a temporary name and
renamed into place -- and its `sha256` and byte length are recorded in the
manifest that names it, so a reader verifies before parsing, exactly as
ADR-0019's `naru.ifc-document-artifact.2` verifies stored bytes before
`json.loads`. A half-written preview is therefore unobservable rather than
merely unlikely.

### Cancellation semantics come from ADR-0020 unchanged

Preview publication points are atomic, so a cancel between them leaves nothing
partial and the staged directory is registered for removal the way the temporary
Scene IR directory already is. The uninterruptible section stays exactly where
ADR-0020 put it -- around the final `writeCompiledPackage` -- and does not grow:
staging adds cancellation-safe checkpoints, it does not add uncancellable work.

A cancelled import removes its preview. A completed import supersedes it with the
durable package; the preview is disposable by design and is never a cache tier.

### Coarse geometry preview is scoped per document too, and is not yet measured

Issue #73 asks for hierarchy *and* a coarse preview. This ADR commits to the
hierarchy half on measured ground and states the other half honestly: the
structure record measures no tessellation at all, and geometry is the bulk of the
282.5 s sixty5 cold adapter. A whole-federation coarse frame inside 5-15 s is
very unlikely; a per-document coarse frame may be reachable, and nothing here
knows. It gets its own gate below, and if the measurement says no, the product
claim narrows to hierarchy-first rather than the gate being loosened.

## Consequences

### Positive

- The first assembly tree reaches a viewer in well under a second on both
  committed federations, against a 5-15 s target, because it no longer waits for
  six other documents or for any geometry.
- The preview is the tree format the runtime already reads, so the Studio gains a
  progressive import without gaining a second hierarchy encoding.
- Staged resources are verified and atomically published, so an import that is
  cancelled or crashes leaves either a complete preview or none.
- Cold imports become inspectable while they run: the tree names what the adapter
  has already understood, which is also the first useful signal that a source is
  wrong.

### Negative

- The adapter emits structure before tessellation per document rather than
  writing one split at the end, which is a real change to its control flow. It is
  also, measured, a real change to peak memory: sixty5's staged process peaks
  1.17 GB higher (+24.8%) and runs 22.4 s longer (+7.75%) than the same
  extraction without staging, while Digital Hub is unaffected (+0.06 GB, and
  0.19% faster). The cost is not the tree building -- writing every sixty5 tree
  takes 201.9 ms, and staging a single document costs nothing measurable -- it is
  the emission order below. The largest document is now inspected last, with six
  documents' Scene IR already accumulated, instead of first into an empty
  accumulator, and every one of sixty5's seven documents moved in the direction
  its rank change predicts. This is the price of a first tree at 0.690 s instead
  of 23.6 s, and it is paid on the model that needs the feature.
- Emission order by size and assembly order by discipline are now two different
  orders in one process. The determinism gate below exists because that is
  precisely where a byte could move. The adapter-level half is now measured --
  36 byte-identical output comparisons per model with no excluded field -- and
  the package half is gate 2.
- A preview is written and then thrown away on every cold import. It is small
  (1,732,203 B of tree for Digital Hub, 25,618,528 B for sixty5) but it is work
  the clean path does not do.
- Digital Hub gains almost nothing: its whole tree already lands in 2.5 s. The
  complexity is paid for by the large model, which is the one that needs it.

## Alternatives considered

**Publish the whole federation's tree, then geometry.** The obvious design, and
the record rejects it: 40,474.9 ms on sixty5 against a 15 s upper bound.

**Parallelise document parsing across threads or processes.** The estimated
six-thread makespan is 15,030.3 ms -- the largest document alone -- so it does not
reach the band even in the arithmetic best case, and running several
IfcOpenShell readers over 839.9 MB of IFC at once on a 31 GB host is a memory
risk this repository has already been careful about. Parallelism remains
worthwhile for total throughput; it is not an answer to first-tree latency.

**Optimise the containment walk.** It is 1.25-1.26% of ready time. There is
nothing there to win.

**Scan the STEP text for the tree instead of parsing it.** Measured, and
genuinely fast: a raw byte scan of the whole sixty5 federation takes 554.2 ms
against 40,474.9 ms of parsing, and on all eleven documents the scan's
`IFCRELAGGREGATES` and `IFCRELCONTAINEDINSPATIALSTRUCTURE` counts equal the
parsed relation counts exactly. That is a striking result and it is still not a
tree: counting relation entities is not resolving their references, their
inverse attributes, or the storeys and elements they point at, and doing so would
mean maintaining a second, unverified IFC reader beside IfcOpenShell -- a new
correctness and trust surface for a preview. Recorded as measured context and
deliberately not adopted; if it is ever worth building, it is worth its own ADR.

**Stream the tree over the adapter's stdout instead of staging files.** It avoids
the staged directory, and it makes the preview unavailable to anything that did
not witness the run -- no reload, no second consumer, and no bounded resource for
the loader ADR-0011 hardened. Files that are verified and atomically published
are the cheaper contract.

## Validation

The adapter half is implemented: `--structure-preview <directory>` publishes one
document's tree before tessellating that document. The compiler half is too:
`--staged-preview <directory>` (`stagedPreviewDirectory` on
`compileIfcFederation`) watches that emission, verifies each tree by length and
digest before parsing it, re-encodes it as the `naru.package-hierarchy.1`
sidecar pair, publishes the pair atomically under a `staged.json` manifest
(`naru.staged-import-preview.1`), and reports it as a `staged` event on the
import job stream, which bumped to `naru.import-job-event.2` for it
([packages/compiler/src/staged-preview.ts](../../packages/compiler/src/staged-preview.ts)).
Nothing downstream of the compiler is -- no Studio, no viewer. Two records
stand behind the design. The first prices an assembly tree without building the machinery:
[artifacts/import/structure-readiness](../../artifacts/import/structure-readiness/README.md),
recorded by
[scripts/record-structure-readiness-evidence.mjs](../../scripts/record-structure-readiness-evidence.mjs)
through
[native/adapter-ifc/tools/measure_structure_readiness.py](../../native/adapter-ifc/tools/measure_structure_readiness.py)
and pinned by
[scripts/validate-structure-readiness-evidence.mjs](../../scripts/validate-structure-readiness-evidence.mjs)
(`pnpm structure:readiness:check`, in the `check` chain). Five fresh-process
samples per model after a discarded warm-up, none discarded; per-document entry,
root, and relation counts are identical across every sample, so only time varies.

The second measures the shipping adapter doing it, watched from outside the
process:
[artifacts/import/structure-first-emission](../../artifacts/import/structure-first-emission/README.md),
recorded by
[scripts/record-structure-first-emission-evidence.mjs](../../scripts/record-structure-first-emission-evidence.mjs)
and pinned by
[scripts/validate-structure-first-emission-evidence.mjs](../../scripts/validate-structure-first-emission-evidence.mjs)
(`pnpm structure:first-emission:check`, in the `check` chain). Same protocol,
plus a `plain` arm without staging so the record says what staging costs as well
as what it delivers.

Both records measure the adapter side of a tree and nothing else. Neither
measures transport to a viewer, property or classification association,
geometry, a real parallel run, or a cold page cache. They carry those exclusions
themselves rather than leaving them to be inferred.

This ADR stays **Proposed**. Its gates, declared before the work:

0. **Met.** A committed record establishes how long an assembly tree takes on
   both federations, decomposed into parse, walk, and serialize, against issue
   #73's 5-15 s target. It records an honest miss: the whole-federation tree is
   outside the band on sixty5 (40,474.9 ms sequential, 15,030.3 ms estimated
   threaded) and inside it on Digital Hub (2,455.9 ms).
1. **Met.** The adapter emits one document's structure before tessellating
   anything, and a committed record shows it: sixty5's first tree is verified on
   disk 0.690 s after process spawn and Digital Hub's at 0.753 s, both inside the
   band; every document in every staged sample published its tree before its own
   extraction finished; and every per-document node count equals the occurrence
   count the same run's Scene IR carries for that document. The record also
   states the two things this gate does not buy -- the *whole* federation's tree
   still lands at 226.638 s on sixty5, outside the band, and staging costs that
   model 22.4 s and 1.17 GB of peak. An earlier draft of this gate asked
   for equality with gate 0's counts, which was wrong: gate 0 walked spatial
   containment (`IfcRelAggregates` and `IfcRelContainedInSpatialStructure`
   participants), while a staged tree carries every occurrence, so the two
   numbers differ by construction -- 783 against 1,027 on Digital Hub's
   architecture document. The equality that matters is the one that makes a
   preview node the same node the finished package draws, so that is what the
   record pins; gate 0's count is recorded beside it rather than dropped.
2. **Met at unit scale.** A compile with staging enabled and one without produce
   the same package digest, the same `output.resources`, and byte-identical
   `scene.gltf` and `scene.bin`; the staged directory is not part of the job
   identity or the cache key, and a cache hit never opens one
   ([test](../../packages/compiler/test/ifc-federation.test.ts), "staged import
   preview"). The adapter-level half was recorded on both real federations
   (gate 1's 36 byte-identical comparisons per model); the package-level half
   is a unit test rather than a fresh-process record, on the Phase 2 routing
   decision that a gate which does not close an exit criterion is proved by
   test. The same tests refuse a tree whose digest, source identity, or
   discipline disagrees with the inspected source (`StagedPreviewError`,
   `INVALID_STAGED_PREVIEW`, with the failure event carrying no path), and
   refuse to stage into a non-empty directory.
3. **Met.** An import cancelled after a tree was staged rejects with the
   cancellation error, the staged directory and the temporary split are gone
   (`removedTemporaryDirectories: 2`), no `scene.gltf` exists, the adapter's
   descendant is dead -- proved by binding the port it held, the way ADR-0020's
   tests do -- and a pre-existing cache entry is untouched
   ([test](../../packages/compiler/test/import-job-cancellation.test.ts),
   "cancelling a federation import after a tree was staged").
4. **The product claim.** A browser record shows the Studio usable against a cold
   sixty5 import: a tree the user can expand and search while extraction
   continues, with the first tree inside 5-15 s measured end to end, transport
   included.
5. **Coarse preview.** A per-document coarse frame measured on sixty5. If it
   cannot reach the band, this ADR is amended to claim hierarchy-first only, and
   the product target for coarse geometry is restated rather than relaxed.

Failing gate 2 or gate 4 rejects this ADR rather than loosening it, on the
precedent ADR-0018 set: a design that misses the gate it declared is rejected by
that gate, and the measurement stays committed.
