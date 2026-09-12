# Memory envelope records

Status: recorded product evidence for Phase 2 exit criterion 3, "forced
low-memory scenario remains functional"
([tracker](../../docs/PHASE_2.md)).

Both records run the same protocol against the same sixty5 package
(`a2d6c72a…`, 657.1 MB) on the same Windows host: three runs under the default
64 MiB residency budget and three under a forced 8 MiB budget, sampled at six
phases each, with every reported byte naming its owner, its lifetime, and the
method that collected it. Neither is a benchmark; they exist to separate what
the runtime admits from what the browser process holds.

| Record | Engine | What it settles |
|---|---|---|
| [`sixty5-envelope/`](sixty5-envelope/README.md) | Chrome 151 / Blink | The ledger itself: 18 categories, five predeclared targets, and the forced-low profile completing hierarchy, coarse rendering, navigation, source-aware selection, and eviction |
| [`sixty5-envelope-gecko/`](sixty5-envelope-gecko/README.md) | Firefox 150 / Gecko | The second-engine repeat: a byte-identical resident set at every settled phase, inside a process 1.97x larger, with heap estimators recorded absent rather than zero |

One validator covers both families and asserts the engine-independent figures
equal each other, so the pair cannot drift apart unnoticed:

```sh
pnpm memory:envelope:check
```

Re-record with `pnpm memory:envelope:evidence` (Blink) or
`pnpm memory:envelope:gecko:evidence` (Gecko). Both need a headed browser and
the compiled package named in each record README.

A third directory holds no record yet.
[`document-retention/`](document-retention/README.md) predeclares the
measurement contract for the retention experiment that follows these two:
the pinned package and options, the two candidates admitted from the runtime
ownership map, paired baseline and candidate runs with memory and timing kept
in separate sets, the sampling phases, how a failed run is handled, and the
threshold below which nothing is landed. It exists before the measurement so
that a result cannot be produced by choosing a threshold afterwards.

What neither record settles: a second operating system, and the graphics
driver's device-side allocation, which no browser exposes and which both
records mark unsupported rather than zero.
