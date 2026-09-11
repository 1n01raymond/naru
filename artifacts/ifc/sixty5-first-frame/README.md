# sixty5 shared-coarse first-frame evidence

This record closes the 268.0 s first-frame bottleneck named by
`artifacts/ifc/sixty5-browser/` through five changes: a shared coarse batch, a
virtualized assembly list, a residency drain that skips rejected chunks instead
of stopping at the first one, an admission gate that refuses a chunk from its
measured cost before any bytes move, and a vertex pool shared across the
material groups of one prototype. It uses the exact same 657.1 MB compiled
package, digest
`a2d6c72a6e936ac3ea2a183a1028cc4a06b20985c6d90b16058954323b7c3347`.

The runtime now transfers the 448.8 MB glTF source bytes once into a persistent
geometry Worker. For the compiler's existing `prototype-aabb-v1` tier, the
Worker replaces 42,588 decoded prototype batches with one canonical box batch,
78,173 instances, one contiguous transform buffer, and one target-mesh index
table. Target chunks remain ordinary decoded batches. Promoted target instances
mask their matching shared coarse instances; eviction reveals them again.

The scheduler marks a chunk the byte budget rejects and continues draining the
rest of the demand instead of halting, the ready state is stamped only once the
scheduler goes idle, and GPU visibility is reconciled through the changed
batches rather than the whole set. Each target chunk's decoded and GPU cost is
measured once, at load time, from the accessor counts the parsed document
already carries; a chunk whose cost cannot fit the budget under any eviction
the scheduler would perform is skipped where the range request would have been
issued, so it costs no transfer, no decode, and no transient heap.

The compiler splits a prototype mesh into one primitive per material but stores
its vertex pool once, and every primitive references the same POSITION and
NORMAL accessors. The runtime used to interleave and keep that pool once per
material group. It now decodes each pool once per mesh and hands the same
`Float32Array` to every sibling batch; residency charges the pool to the first
group resident and releases it with the last, and the renderer refcounts one
GPU vertex buffer behind them.

## Result

Recorded in headed Chrome 151.0.7922.139 at 1320x1000 on the same Windows x64,
16-CPU, NVIDIA host class as the original record. Each run starts a fresh
browser/context and uses a warm OS file cache, matching the original record's
disclosed cache condition. The previous record on this measure was captured in
Chrome 152.0.7977.64; that build is not installed on the recording host, so the
browser version is not held constant against it.

| Measure | Baseline | Shared coarse | Skip-and-continue | Estimate gate | Vertex pool | This record (3 runs, 2026-09-05) |
|---|---:|---:|---:|---:|---:|---:|
| First coarse frame | 268,013 ms | 12,553 ms | 4,340 ms | 4,471 ms | 4,283 ms | 4,495 / 4,487 / 4,422 ms |
| First coarse frame median | 268,013 ms | 12,796 ms | 4,340 ms | 4,471 ms | 4,283 ms | 4,487 ms |
| Observed p95 (nearest-rank, n=3) | - | 13,378 ms | 4,419 ms | 4,590 ms | 4,331 ms | 4,495 ms |
| Hierarchy-to-coarse median | 264,683 ms | 8,471 ms | 1,954 ms | 2,092 ms | 1,960 ms | 2,215 ms |
| Ready-state median | 323,307 ms | 64,445 ms | 9,601 ms | 8,277 ms | 8,943 ms | 9,104 ms |
| Target chunks admitted | - | - | 93 / 234 | 93 / 234 | 111 / 234 | 111 / 234 |
| Resident triangles | - | - | 1,849,190 | 1,849,190 | 2,255,235 | 2,255,235 |
| Target chunk requests | - | - | 234 | 93 | 111 | 111 |
| Satisfied Range responses | - | - | 245 | 94 | 113 | 113 |
| Used JS heap at ready | - | 1.349-1.362 GB | 1.788 GB | 1.481 GB | 1.625 GB | 0.843 GB |
| Relative first-frame reduction | - | 95.23% | 98.38% | 98.33% | 98.40% | 98.33% |
| Relative first-frame speedup | - | 20.95x | 61.75x | 59.94x | 62.58x | 59.73x |

The resident endpoint is byte-for-byte the one the shared vertex pool
established: bounding the transport changed what the loader is allowed to
accept, not what it accepts here. Every counter below is identical to the
preceding record. What moved is the cost of reading the 448.8 MB document -
half the heap, for about 200 ms of first frame.

The three runs above were recorded on 2026-09-05. The committed
`browser-residency.json` is a later capture: the record was re-run on
2026-09-07 after the Studio camera fix and the view cube, because its
screenshots still showed the mirrored from-below rendering that fix corrected.
The endpoint reproduced exactly, so the comparison above still holds; the
milestones, the Worker decode time, the heap sample, and the centre-canvas pick
are the re-captured ones:

| Measure | 2026-09-05 median of 3 | Committed sample, 2026-09-07 |
|---|---:|---:|
| Hierarchy ready | 2,272 ms | 2,478 ms |
| First coarse frame | 4,487 ms | 4,743 ms |
| Budget-limited ready | 9,104 ms | 9,288 ms |
| Worker geometry decode | 1,117.5 ms | 1,089.8 ms |
| Used JS heap at ready | 0.843 GB | 0.853 GB |
| Centre-canvas pick | beam 148736, 6 entries | facade panel 74388, 44 entries |

The re-capture was three runs per engine, and the endpoint and the pick were
stable across them; their milestone distribution was not carried into the
record, so the distribution rows above remain the 2026-09-05 ones and no
median or p95 is claimed for the newer set. Against the 268,013 ms baseline the
committed sample is a 98.23% reduction, a 56.51x speedup.

All runs, on both capture dates, reach an identical resident endpoint, so the
state below is the recorded state of every one of them:

- 78,173 / 78,173 visible renderable occurrences;
- 111 of 234 target chunks admitted, from 113 satisfied HTTP Range responses;
- 66,686,508 decoded bytes and 66,783,808 GPU bytes under separate 64 MiB
  budgets - 325,056 bytes of GPU headroom left;
- 2,255,235 unique resident triangles and 12 shared coarse edge segments;
- the same centre-canvas prefab facade panel pick, object 74388, resolving 44
  IFC2X3 property entries from the property sidecar;
- zero console warnings, console errors, or page errors.

Main-page used JS heap at the ready sample was 0.853 GB for the committed
capture and 0.843 GB for the 2026-09-05 reviewed run (0.835-0.853 GB across
those three), against 1.625 GB for the same resident set before the loader was
bounded. The saving is the document read itself: the bounded reader fills one
buffer of exactly the declared `Content-Length`, where
`Response.arrayBuffer()` accumulated the 448.8 MB body and then concatenated
it. The first coarse frame pays about 200 ms for that copy (4,487 ms against
4,283 ms on the 2026-09-05 runs), and the ready state about 160 ms. The validator
holds the heap under 1.75 GB; the exact figure depends on GC timing and is
recorded rather than pinned.

### What sharing the pool changes

Measured over all 234 target chunks of this package, from the accessor counts
alone:

| Chunk cost | Per material group | Shared pool |
|---|---:|---:|
| Total decoded cost | 230,730,336 B | 129,154,008 B |
| Largest single chunk | 75,373,776 B | 1,334,976 B |
| Chunks over the 64 MiB budget on their own | 1 | 0 |

The 75 MB chunk is one prototype with 111 material groups over a 28,045-vertex
pool: 673,080 distinct vertex bytes charged 111 times. No eviction order could
ever admit it, which is why the preceding record documented it as permanently
unadmittable. It now costs 1.3 MB and is admitted like any other chunk.

Sharing is always within one mesh, and a mesh belongs to exactly one target
chunk and one residency group, so nothing here spans chunk lifetimes. The
identity of the interleaved array is what carries the sharing: a unit test
asserts it survives the structured clone out of the geometry Worker, including
the transfer list, which lists each buffer once.

### The rest of the resident set

The assembly tree used to materialize one element per hierarchy entry: 565,134
elements for this federation's 188,319 entries, 78,173 of them exposed as
accessible buttons. A host whose accessibility mode is enabled then spends
minutes walking that tree before the first frame can be painted, because the
browser process stops servicing its own network sockets while it does. The
Studio now renders only the rows its scrollport covers, so the panel holds
roughly thirty elements regardless of federation size.

A drain tries every demanded chunk exactly once per demand signature, and 123
of the 234 are refused from their measured cost instead of after their decode.
The scheduler counts them: `targetSchedulerRequests` is 111 and
`targetSchedulerSkips` is 123, and the two sum to the demanded 234. The
prediction is exact rather than heuristic - every decoded array length is a
fixed multiple of a glTF accessor count, so the same formula that charges a
resident batch also prices an unfetched one, and a runtime test decodes a
committed fixture and asserts the two agree for every chunk, sharing included.
The gate is otherwise deliberately optimistic - a chunk is refused only when
the budget's free headroom cannot take it and no colder unpinned group exists
to evict - because refusing a chunk the budget would have taken would drop
geometry that fits.

## Reproduce

Recreate the package as described by `artifacts/ifc/sixty5/README.md`, then run:

```sh
pnpm ifc:first-frame:evidence -- --scene-dir output/ifc/sixty5-prb
pnpm ifc:first-frame:check
```

The recorder verifies every package resource against the committed build report
before opening headed Chrome. `coarse-frame.png`, `budget-limited.png`, and
`picked.png` are digest-pinned by `browser-residency.json`.

## Limits

- This is a Chrome/Blink result on one discrete-GPU Windows host, not an
  ADR-0003 renderer decision or a cross-browser performance claim.
  `../sixty5-first-frame-gecko/` repeats it in Firefox on the same host and the
  same package: the resident set is byte-identical, the wall clock is not.
- The optimization applies only to the compiler's existing
  `prototype-aabb-v1` coarse representation. Target geometry and the serialized
  glTF profile are unchanged.
- Spatial LOD, compression, and shape-preserving coarse geometry remain future
  work. So does raising the resident endpoint further: 123 of 234 chunks still
  do not fit a 64 MiB budget. No chunk in this package is indivisible any more,
  so the remaining lever is the budget policy itself rather than chunk shape.
- `artifacts/ifc/sixty5-browser/` was recorded before the list was virtualized,
  so its 268.0 s first frame and 323.3 s ready state describe the superseded
  DOM behavior. It is kept as the baseline this record is measured against.
