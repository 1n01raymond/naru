# Digital Hub localized camera trace

Status: reviewed focused evidence; ADR-0008 remains Proposed.

This record answers the ADR-0008 gate that the earlier spatial records left
open: what the BVH scheduler actually demands once the camera stops looking at
the whole model. The two committed traces drive the same Digital Hub federation
through the same scripted camera move, once over the default `compatibility`
payload order and once over opt-in `spatial-leaf-anchor-v1`. Everything is
measured in a headed browser against a served package; nothing here is an
offline estimate.

The recorder reads the counters the Studio already publishes on the document
element (`data-spatial-nodes-visited`, `-leaves-visible`, `-occurrences-tested`,
`-candidate-chunks`, `-query-milliseconds`, and the scheduler's demand list), so
no application code exists for this record to test.

## What was recorded

| Window | What the camera shows |
|---|---|
| `fitted` | the fit-to-model pose the Studio opens with, after `ready` |
| `localized` | one wheel zoom of −2,600 and a 300 × −200 px shift-pan into the model |
| `navigation` | 12 short orbit drags from the localized pose, 48 queries |

Demanded bytes are priced from `extras.madi.progressive.targetChunks`: the
recorder sums the payload lengths of the chunk ids the scheduler demands, which
is what a cold client would fetch for that view. In these runs the whole model
already fits the 64 MiB residency budget, so the localized windows issued zero
new Range requests — the reduction is in demand, not in this run's traffic.

## Digital Hub, headed Chrome 151.0.7922.139, Windows 11

| Metric | Fitted | Localized | Reduction |
|---|---:|---:|---:|
| BVH nodes visited | 255 / 255 | 109 | −57.3% |
| Leaves visible | 128 / 128 | 28 | −78.1% |
| Occurrences tested | 5,152 / 5,152 | 1,129 | −78.1% |
| Candidate chunks (compatibility) | 71 / 71 | 52 | −26.8% |
| Demanded bytes (compatibility) | 35,962,344 | 23,065,180 | −35.9% |
| Candidate chunks (leaf-anchor) | 66 / 66 | 42 | −36.4% |
| Demanded bytes (leaf-anchor) | 35,962,344 | 20,111,204 | −44.1% |

Both orders pack the same 35,962,344 target bytes and both resolve the same
localized view — 28 leaves, 1,129 occurrences — so the chunk and byte columns
are a controlled comparison of packing alone. On that identical view
`spatial-leaf-anchor-v1` demands 42 chunks instead of 52 (−19.2%) and
20,111,204 bytes instead of 23,065,180 (−12.8%). This is the browser-side
counterpart of the offline off-view-byte census in `../digital-hub-packing.json`.

Query cost stayed far below a frame: across the 48 navigation queries the
compatibility run measured p50 0.040 ms and p95 0.085 ms, the leaf-anchor run
p50 0.035 ms and p95 0.085 ms, and no navigation frame ever fell back to
testing all 5,152 occurrences. Residency did not move while the camera did
(48,494,280 decoded / 48,495,284 GPU bytes in every window of both runs), and
neither run emitted a console warning or error.

First-frame milestones are reported for context only, not as a claim about
packing: hierarchy 0.42 s / 0.43 s, first coarse frame 0.66 s / 0.67 s, ready
1.25 s / 1.23 s. Digital Hub is small enough that the residency budget is never
the constraint here. These are the 2026-09-07 re-capture after the Studio
camera fix and the view cube; every chunk, byte, and occurrence count above
reproduced unchanged from the original capture.

## Repeatability

Three runs per payload order preceded the committed pair. Every counter this
record pins was identical in all three: 255/128/5,152 fitted, 109/28/1,129
localized, 52 and 42 candidate chunks, 23,065,180 and 20,111,204 demanded
bytes, and byte-identical screenshots within each order. Only the wall-clock
milestones and the sub-0.1 ms query timings varied. The committed records come
from a later run of each order, made with the recorder in the form committed
here; their screenshots are byte-identical to the three earlier runs.

The two screenshot pairs are not byte-identical across payload orders: 79 of
1,320,000 pixels differ, from draw order on coincident surfaces. The view,
triangle count (913,532) and edge count (1,042,404) are the same.

## Host divergence from the committed packing record

`../digital-hub-packing.json` was recorded on macOS. Re-extracting the same
qualified Digital Hub sources with the same adapter on this Windows host
produced a Scene IR that differs: `scene-ir.json` 29,843,011 bytes
(`b8ec9c53…`) against the recorded 29,843,019 (`e05447c7…`), and geometry
`4f6ddbe9…` against `f478be1e…` at the identical 41,692,760 bytes. Prototype,
occurrence, triangle, and edge counts match exactly, `properties.bin` is
byte-identical (`712fea65…`), the compiled target and coarse payloads have the
identical byte lengths, and both `spatial.bin` sidecars are byte-identical to
the committed pins (`7e3be0ef…`, `86a09efb…`) — so the BVH itself reproduces
across hosts. The compiled package digests still differ, so this record pins
its own: `0a68506d…` (compatibility, 71 chunks) and `56f813e1…`
(leaf-anchor, 66 chunks). Cross-host adapter byte reproducibility is not
proven and is tracked in `docs/PHASE_1.md`.

## Reproduce

Retain a Digital Hub split Scene IR with the current adapter, compile the two
payload orders, then trace each:

```sh
node scripts/record-spatial-ifc-packing-evidence.mjs \
  --input output/ifc/digital-hub-split4 \
  --output output/ifc/digital-hub-spatial-analysis
pnpm spatial:localized:evidence -- --label compatibility \
  --output output/spatial-localized/compatibility \
  --wheel-delta -2600 --pan-x 300 --pan-y -200
pnpm spatial:localized:evidence -- --label spatial-leaf-anchor \
  --output output/spatial-localized/spatial-leaf-anchor --port 4177 \
  --wheel-delta -2600 --pan-x 300 --pan-y -200
pnpm spatial:localized:check
```

## What this does not prove

The trace covers one 5,152-occurrence federation on one host in one engine. It
says nothing about the sixty5 federation, where the residency budget does bind
and a localized view would change what is actually fetched; nothing about
Firefox or Safari; and nothing about first-frame time, which this model is too
small to stress. ADR-0008 stays Proposed until those land.
