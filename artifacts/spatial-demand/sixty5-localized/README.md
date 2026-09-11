# sixty5 localized camera trace

Status: reviewed focused evidence; ADR-0008 remains Proposed.

`../digital-hub-localized/` showed what the BVH scheduler demands once the
camera stops looking at the whole model, but on a federation small enough to
sit inside the 64 MiB residency budget whole. This record repeats the same
trace on sixty5, where the budget binds: the fitted view demands 234 chunks and
120,707,064 target bytes, and the client can hold about a hundred of them. A
localized view therefore changes what is actually fetched, not only what is
nominally demanded.

Both traces drive the same federation through the same scripted camera move,
once over the default `compatibility` payload order and once over opt-in
`spatial-leaf-anchor-v1`. Everything is measured in a headed browser against a
served package; nothing here is an offline estimate. The recorder reads the
counters the Studio already publishes on the document element
(`data-spatial-nodes-visited`, `-leaves-visible`, `-occurrences-tested`,
`-candidate-chunks`, `-query-milliseconds`, and the scheduler's demand list),
so no application code exists for this record to test.

## What was recorded

| Window | What the camera shows |
|---|---|
| `fitted` | the fit-to-model pose the Studio opens with, after `ready` |
| `localized` | one wheel zoom of -5,000 and a 400 x -300 px shift-pan into the model |
| `navigation` | 12 short orbit drags from the localized pose, 48 queries |

A wheel delta of -5,000 saturates the Studio's zoom clamp, so the localized
window is the closest view the application allows. Demanded bytes are priced
from `extras.madi.progressive.targetChunks`: the recorder sums the payload
lengths of the chunk ids the scheduler demands, which is what a cold client
would fetch for that view.

## sixty5, headed Chrome 151.0.7922.139, Windows 11

| Metric | Fitted | Localized | Reduction |
|---|---:|---:|---:|
| BVH nodes visited | 4,095 / 4,095 | 889 | -78.3% |
| Leaves visible | 2,048 / 2,048 | 184 | -91.0% |
| Occurrences tested | 78,173 / 78,173 | 7,026 | -91.0% |
| Candidate chunks (compatibility) | 234 / 234 | 209 | -10.7% |
| Demanded bytes (compatibility) | 120,707,064 | 107,337,264 | -11.1% |
| Candidate chunks (leaf-anchor) | 234 / 234 | 152 | -35.0% |
| Demanded bytes (leaf-anchor) | 120,707,064 | 78,875,544 | -34.7% |

Both orders pack the same 120,707,064 target bytes into 234 chunks and both
resolve the same localized view -- 184 leaves, 7,026 occurrences -- so the
chunk and byte columns are a controlled comparison of packing alone. On that
identical view `spatial-leaf-anchor-v1` demands 152 chunks instead of 209
(-27.3%) and 78,875,544 bytes instead of 107,337,264 (-26.5%). Both margins are
larger than Digital Hub's (-19.2% and -12.8%), which is what ADR-0008 predicted:
prototype-ordered chunks mix occurrences from across a whole site, and the
bigger the site, the more of each chunk a close view does not need.

Compatibility ordering barely narrows the demand at all -- 209 of 234 chunks
for a view that touches 9.0% of the occurrences -- because almost every
prototype-range chunk still has some occurrence in frame. That is the failure
mode leaf-anchor ordering exists to fix, and it is only visible at this scale.

## What the budget does to the demand

Digital Hub fits the residency budget whole, so its demand was also its
traffic. sixty5 does not: 120,707,064 target bytes cannot fit in 67,108,864,
so the scheduler admits chunks in priority order and estimate-gated prefetch
skips the rest before requesting them. Demand and traffic are therefore
different numbers here, and both are recorded.

| Window | Compatibility | Leaf-anchor |
|---|---:|---:|
| Fitted chunks admitted / requested / skipped | 108 / 108 / 126 | 106 / 106 / 128 |
| Fitted resident bytes (decoded / GPU) | 66,943,668 / 67,020,600 | 66,999,984 / 67,078,424 |
| Localized chunks resident | 106 | 103 |
| Localized `scene.bin` Range responses | 55 | 22 |
| Localized resident bytes (decoded / GPU) | 67,026,048 / 67,106,272 | 67,027,692 / 67,103,956 |
| Navigation end-pose chunks / bytes demanded | 217 / 111,897,972 | 182 / 94,150,116 |
| Peak JS heap | 693,065,527 B | 593,869,709 B |

Every window in both orders ends at or under the 67,108,864-byte budget, and
`schedulerRequests + schedulerSkips` equals the 234-chunk census in the fitted
window of both, so nothing was fetched that could not be admitted. The
localized Range column is the practical consequence of the demand reduction:
moving into the model costs 55 additional ranged reads under compatibility
ordering and 22 under leaf-anchor ordering, because more of what the closer
view wants is already resident.

Because the budget binds, the two orders end up holding *different* chunks and
therefore render different geometry from the same view -- 2,180,160 triangles
against 2,182,636, and 22,240 retained surface batches against 20,081. That is
expected and is the reason this record does not assert pixel or triangle
equality between the orders, only that both stay inside the budget. The
Digital Hub record, where nothing is ever evicted, does assert equality.

## Query cost

Localized query medians stay well under a millisecond on a 2,048-leaf,
78,173-occurrence index: p50 0.265 ms (compatibility) and p50 0.305 ms
(leaf-anchor) over 17 samples each. The compatibility p95 is 1.955 ms, its
single slowest sample, against 0.485 ms for leaf-anchor; with 17 samples the
p95 is one observation and is reported as such, not as a bound. The 48
navigation queries per order run p50 0.280 ms / p95 0.390 ms and p50 0.300 ms /
p95 0.405 ms. No navigation sample tested all 78,173 occurrences -- the largest
tested 9,991 -- so the BVH never degenerated into the linear fallback during
the trace.

## First frame

ADR-0008 gates the payload-order option on the first coarse frame not
regressing. The committed samples were re-captured on 2026-09-07 after the
Studio camera fix and the view cube; every localized count above reproduced
unchanged, and the wall clock is that capture's: 2.222 s hierarchy / 4.300 s
coarse frame / 7.933 s ready (compatibility) and 2.223 / 4.812 / 9.496
(leaf-anchor) -- both far inside the 15-second bound the decision records -- against 4.743 s for the non-spatial sixty5 package in
`../../ifc/sixty5-first-frame/`. Adding the index and reordering the payload
costs nothing measurable at the first frame.

## Reproducing

The packages are compiled from the retained split Scene IR, one order per
process -- a single sixty5 compile peaks near 3 GB, so compiling both in one
process does not fit this host:

```
pnpm spatial:package --input output/ifc/sixty5 \
  --output output/ifc/sixty5-spatial/compatibility --payload-order compatibility
pnpm spatial:package --input output/ifc/sixty5 \
  --output output/ifc/sixty5-spatial/spatial-leaf-anchor --payload-order spatial-leaf-anchor
```

Then record each order in a headed browser and validate:

```
pnpm spatial:localized:evidence -- --label compatibility \
  --scene-dir output/ifc/sixty5-spatial/compatibility \
  --output output/spatial-localized-sixty5/compatibility \
  --wheel-delta -5000 --pan-x 400 --pan-y -300
pnpm spatial:localized:check
```

`pnpm spatial:localized:check` validates this record and the Digital Hub one
against `scripts/validate-spatial-localized-trace-evidence.mjs`, which pins the
counts, bytes, digests, and screenshot hashes above.

## Honest limits

- **The package digests are host-local.** This host compiles sixty5 to
  `4fa4c67c…` and `1fdbb5a8…`; the IFC adapter's split Scene IR differs by a
  handful of bytes across hosts, so a different machine will produce different
  digests from the same fixture. Determinism is proven per host, not across
  hosts. The validator must not be silently retargeted to make a re-record on
  another machine pass.
- **Edge counts read 12** because this host's retained sixty5 split predates
  the explicit-edge adapter change (PR #42). The trace measures demand and
  residency, not edge coverage.
- **Screenshots are not byte-stable across runs** at this scale, so the pair
  committed here is one run per order; the validator pins their hashes, not a
  cross-run equality.
- **One host, one browser.** Headed Chrome 151.0.7922.139 on Windows 11 with an
  NVIDIA adapter. Firefox and Safari reproduction of the localized trace is
  still open, and so is the nested-view interaction with ADR-0005
  camera-relative precision. ADR-0008 stays `Proposed` until those close.
- The camera move is scripted and fixed; it is one localized view, not a
  survey of viewpoints.
