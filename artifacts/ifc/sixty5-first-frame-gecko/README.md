# sixty5 first-frame evidence on a second engine (Gecko)

`docs/PHASE_2.md` asks for the published startup, frame, memory, and
interaction figures to be repeated "on a second engine and operating system".
This record closes the engine half of that repeat: it runs the committed
first-frame protocol of `artifacts/ifc/sixty5-first-frame/` unchanged, on the
same host, against the same 657.1 MB compiled package, digest
`a2d6c72a6e936ac3ea2a183a1028cc4a06b20985c6d90b16058954323b7c3347` - and
opens it in Firefox 150.0.2 (Gecko) instead of Chrome 151 (Blink).

The operating system half is **not** closed. Both records are Windows x64 on
one host, and `docs/PHASE_2.md` carries that as outstanding evidence debt.

The recorder is the same script. It gained a `--browser chrome|firefox`
selector whose entire engine difference is one launch descriptor; the Chrome
path keeps its previous launch options verbatim, so no committed Blink record,
digest, or timing moved and none was re-recorded.

## Result

Recorded in headed Firefox 150.0.2 at 1320x1000 on the same Windows x64,
16-CPU, NVIDIA host as the Blink record, each run from a fresh browser and
context against a warm OS file cache.

Both committed samples were re-captured on 2026-09-07, after the Studio camera
fix and the view cube, because their screenshots still showed the mirrored
from-below rendering. The endpoint reproduced on both engines; the milestones,
decode times, and the centre-canvas pick below are the re-captured ones, and
the 2026-09-05 distribution that established this comparison is kept further
down.

| Measure | Blink (Chrome 151) | Gecko (Firefox 150) | Gecko / Blink |
|---|---:|---:|---:|
| Hierarchy ready | 2,478 ms | 3,122 ms | 1.26x |
| First coarse frame | 4,743 ms | 6,093 ms | 1.28x |
| Budget-limited ready | 9,288 ms | 11,914 ms | 1.28x |
| Worker geometry decode | 1,089.8 ms | 1,761.9 ms | 1.62x |
| Target chunks admitted | 111 / 234 | 111 / 234 | identical |
| Decoded resident bytes | 66,686,508 | 66,686,508 | identical |
| GPU resident bytes | 66,783,808 | 66,783,808 | identical |
| Resident triangles | 2,255,235 | 2,255,235 | identical |
| Visible occurrences | 78,173 | 78,173 | identical |
| Satisfied Range responses | 113 | 113 | identical |
| Used JS heap at ready | 852,514,277 B | not exposed | - |
| Console and page errors | 0 | 0 | identical |

**The two engines settle on a byte-identical endpoint.** Every figure the
runtime decides for itself - which 111 of the 234 target chunks are admitted,
which 123 are refused before a byte moves, how many bytes they occupy in memory
and on the GPU, how many triangles are resident, how many IFC2X3 properties a
centre-canvas pick resolves, and the exact ready status string - is the same
value in both records. The one figure the two engines do not share is which
element that pick lands on: from above the centre pixel sits on the seam
between two adjacent prefab facade wall panels, and each engine resolves one
of them, stably over three runs. What differs is wall-clock
time and what each browser is willing to report about itself.

That is the result the criterion asks for. Admission is decided from measured
decoded and GPU cost against a byte budget, so a second engine reaching a
different resident set would have meant the budget was tracking something
browser-specific. It does not.

The 2026-09-05 capture set was three runs per engine, and its reviewed
artifact was the 6,801 ms run - the median of three on all three milestones,
not only on the headline one:

| Run | Hierarchy ready | First coarse frame | Budget-limited ready |
|---|---:|---:|---:|
| 1 | 3,977 ms | 7,413 ms | 13,977 ms |
| 2 (committed) | 3,396 ms | 6,801 ms | 13,712 ms |
| 3 | 3,332 ms | 6,348 ms | 12,729 ms |
| Median | 3,396 ms | 6,801 ms | 13,712 ms |
| Observed p95 (nearest-rank, n=3) | 3,977 ms | 7,413 ms | 13,977 ms |

The 2026-09-07 re-capture was three runs per engine as well; the endpoint and
the pick were stable across them, but their milestone distribution was not
carried into the record, so no median or p95 is claimed for the newer set and
the distribution above stays the recorded one.

All three runs reach the identical endpoint recorded above, so the resident
state below is the recorded state of every one of them:

- 78,173 / 78,173 visible renderable occurrences;
- 111 of 234 target chunks admitted, 123 refused from their measured cost
  before any range request, from 113 satisfied HTTP Range responses;
- 66,686,508 decoded bytes and 66,783,808 GPU bytes under separate 64 MiB
  budgets - 325,056 bytes of GPU headroom left;
- 2,255,235 unique resident triangles and 12 shared coarse edge segments;
- a centre-canvas prefab facade panel pick resolving the same 44 IFC2X3
  property entries from the property sidecar - Gecko lands on object 74387 and
  Blink on its neighbour 74388;
- zero console warnings, console errors, or page errors.

## What Gecko does not report

Two fields are null in this record and are recorded as unavailable rather than
as zero:

- **JS heap.** `performance.memory` is a Blink extension and Gecko implements
  neither it nor `measureUserAgentSpecificMemory()`. This record therefore
  carries no heap figure at all. The validator asserts both heap fields are
  `null`, so a future engine that starts reporting a heap cannot slip in
  unnoticed, and it asserts the Blink record still carries the reading this one
  cannot take. A resident-set figure that does not depend on any browser's own
  estimator is the job of the memory envelope, whose Gecko repeat is now
  recorded in [`sixty5-envelope-gecko`](../../memory/sixty5-envelope-gecko/README.md):
  there the OS-sampled process tree carries the whole bound, and the two
  engines hold identical resident bytes inside processes of very different
  size.
- **GPU adapter identity.** Firefox reports an adapter with empty vendor,
  architecture, and description, and `isFallbackAdapter` as null, so this
  record names the adapter only as "WebGPU adapter". No claim is made here
  about which physical GPU served the run or whether it was a fallback adapter;
  the Blink record's `nvidia` identification has no counterpart.

## Reproduce

Recreate the package as described by `artifacts/ifc/sixty5/README.md`, then
run:

```sh
pnpm ifc:first-frame:gecko:evidence -- --scene-dir output/ifc/sixty5-prb
pnpm ifc:first-frame:gecko:check
```

The recorder verifies every package resource against the committed build report
before opening headed Firefox. `coarse-frame.png`, `budget-limited.png`, and
`picked.png` are digest-pinned by `browser-residency.json`.

`scripts/validate-sixty5-first-frame-gecko-evidence.mjs` reads the Blink record
alongside this one and asserts the shared figures against it directly, not only
against literals, so the two records cannot drift apart silently. Where a
literal is pinned as well, it is pinned at the same value the Blink validator
uses.

## Limits

- This closes the **engine** half of the second-engine repeat only. Both
  records are Windows x64 on one discrete-GPU host; the operating-system half
  needs a second host and remains outstanding.
- Timings are a two-engine comparison on one host, not a browser benchmark and
  not an ADR-0003 renderer decision. On the committed samples Gecko is about
  1.3x slower than Blink at every milestone and 1.62x slower at Worker geometry
  decode, against about 1.5x and 2.18x on the 2026-09-05 distribution; runs on
  one machine do not establish why.
- Memory is not compared. Gecko exposes no heap estimator, so the memory half
  of the exit criterion is untouched by this record.
- The screenshots are not compared across engines. Text rasterization and
  draw order on coincident surfaces differ between engines, so each record
  digests its own captures.
