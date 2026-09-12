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

A third directory holds a paired experiment rather than an envelope.
[`document-retention/`](document-retention/README.md) predeclares its
measurement contract — the pinned package and options, the two candidates
admitted from the runtime ownership map, paired baseline and candidate runs with
memory and timing kept in separate sets, the sampling phases, how a failed run is
handled, and the threshold below which nothing is landed — and then records the
result underneath it, so a result cannot have been produced by choosing a
threshold afterwards. Validate with `pnpm memory:retention:check`; re-record with
`pnpm memory:retention:evidence`, which needs a headed browser and a baseline
worktree of the commit the candidate is measured against.

The first of its two candidates, the redundant main-thread document parse, is
measured and landed: peak main-thread used JS heap falls 54.67% on the pinned
sixty5 package and 50.45% on its relocated variant, at the same resident
endpoint and with the first coarse frame faster rather than slower. The second,
the scene-replacement overlap, is untouched.

What none of the three records settles: a second operating system, and the
graphics driver's device-side allocation, which no browser exposes and which all
three mark unsupported rather than zero. The retention experiment adds one
boundary of its own — it measures main-thread retention, and the whole-process
figures it reports alongside are context, not a bound.
