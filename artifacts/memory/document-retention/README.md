# Document retention experiment protocol

Status: protocol predeclared 2026-09-12, measured the same day. The result is
in [`document-retention.json`](document-retention.json) and summarised under
"Result" below; the contract above it is unchanged from the predeclaration, so a
result cannot have been produced by choosing a threshold afterwards. This
directory holds the measurement contract for the retention experiment described
in the [Phase 2 tracker](../../../docs/PHASE_2.md).

The ownership map the experiment tests is in
[`docs/RUNTIME.md`](../../../docs/RUNTIME.md), under "Who holds the compiled
document". It names, for each representation of a compiled package, the owner
that allocates it, how long that owner keeps it, the consumer it exists for, how
it crosses a thread boundary, and where it is released. Two of its rows describe
work that is done twice or held longer than one consumer needs, and those two
are the only candidates this protocol admits.

Nothing here is a memory cap. The runtime's 64 MiB decoded and GPU budgets bound
admitted target geometry and nothing else; every figure this protocol collects
is outside that bound, and no result recorded under it may be restated as a
total-memory limit.

## Pinned inputs

| Input | Value |
|---|---|
| Package | sixty5, `a2d6c72a6e936ac3ea2a183a1028cc4a06b20985c6d90b16058954323b7c3347`, 657.1 MB, at `output/ifc/sixty5-prb` |
| Package shape | document-carried assembly tree, property sidecar present, no relocated hierarchy sidecar, no spatial demand index |
| Residency budget | the default 64 MiB decoded and GPU budgets, unmodified |
| Delivery | Vite static hosting with HTTP Range support, as in the [memory envelope](../sixty5-envelope/README.md) |
| Engine | headed Chrome 151 (Blink) at 1320x1000 on this Windows x64 host |
| Pinned endpoint | 111 of 234 target chunks, 66,686,508 B decoded, 66,783,808 B GPU, 2,255,235 triangles, 78,173 renderable occurrences |

The same compiled bytes are used by both arms. This experiment changes runtime
retention only; it does not recompile, does not change a delivery format, and
does not move a package digest. If a candidate requires different bytes it is
out of scope here and belongs with the document-serialization work.

A relocated build of the same model exists at `output/ifc/sixty5-relocated`. It
is a second arm only if the candidate under test touches sidecar handling, and
if it is used it is declared in the record with its own digest and its own
baseline; it never replaces the pinned package above.

## Candidates

Exactly one of these is implemented and measured. Both come from the ownership
map, and neither is a new format, a buffer pool, or a budget change.

1. **The main-thread document parse.** A remote document is decoded from bytes
   and parsed twice, once on each thread. The main-thread parse exists to build
   the assembly tree and to read the package's resource pointers; it is released
   when the loader returns, but its peak coincides with nothing else being
   freed. The candidate removes the redundant parse or narrows what it retains.
2. **The scene-replacement overlap.** The open scene is disposed only after the
   replacement document has been fetched, decoded, parsed, and its tree built,
   so a failed load leaves the previous scene on screen. The candidate narrows
   the interval in which a whole previous session coexists with the
   replacement's parse peak, without reintroducing a blanked viewport on a
   failed load.

## Runs

Two sets, because forced collection distorts timing:

- **Memory set.** At least three interleaved baseline/candidate pairs, baseline
  first, alternating, each pair in fresh browser processes and a fresh context.
  Memory is sampled at the phases below.
- **Timing set.** At least three further interleaved pairs with no memory
  sampling of any kind, recording only milestone times.

No number from the memory set is reported as a timing result, and no number from
the timing set is reported as a memory result.

## Phases

Sampled in both arms, in this order, within one session:

| Phase | Sampled when |
|---|---|
| `hierarchy` | the assembly tree is built and the tree view is populated |
| `coarse-frame` | the first coarse frame has been presented |
| `budget-limited` | the resident set has settled at the pinned endpoint |
| `replace-overlap` | the peak observed while the same package is loaded again over the open scene |
| `replace-settled` | the replacement session has settled at the pinned endpoint |
| `disposed` | the scene has been disposed and no new one opened |

Each sample records the browser process-tree working set and private commit, the
main-thread used JS heap, agent-cluster memory where the engine exposes it, the
decoded and GPU residency the runtime reports, and the package retention ledger
the Studio publishes. A quantity an engine does not expose is recorded absent
with its reason, never as zero.

## Failed-run handling

A run is discarded only for a declared, observable fault, recorded with its
reason:

- a console error, page error, or console warning;
- a milestone not reached inside its timeout;
- a resident endpoint differing from the pinned endpoint above.

A run is never discarded for being slow, fast, large, or small. Discards are
counted in the record. If more than one run per arm is discarded, the whole set
is void and restarted; a set is not repaired by topping it up.

## Success threshold

Declared before measurement and not adjustable afterwards.

- **Primary.** The candidate's median peak main-thread used JS heap across the
  session is at least 10% below the baseline's.
- **Guard, timing.** The candidate's median first coarse frame is no more than
  5% above the baseline's, measured in the timing set.
- **Guard, behaviour.** Both arms preserve the assembly tree, source-aware
  picking and property resolution, selected-object detail, and the pinned
  resident endpoint, in every accepted run.
- **Reported, not gating.** The process-tree working set and private commit at
  each phase, because a browser process figure includes allocator and
  GPU-process behaviour no page-level interface resolves.

A candidate that misses the primary threshold, or that fails either guard, is
not landed. The experiment is then recorded as unsuccessful, with its numbers,
and the complexity it would have added is not merged.

## Result

Recorded 2026-09-12 into
[`document-retention.json`](document-retention.json), schema
`naru.document-retention-evidence.1`, mode
`fresh-process-paired-retention-experiment`. Of the two admitted candidates the
first was implemented and measured: **the main-thread document parse**. The
scene-replacement overlap was left untouched, and remains a sampling phase
rather than a change.

The candidate parses a compiled document once, in the geometry Worker, and lets
the assembly tree cross to the main thread with the Worker's initialization
response. The main thread no longer decodes the document to a string, no longer
parses it, and no longer holds the parsed result until the loader returns.

Twenty-four runs, all accepted, no discards: three interleaved memory pairs and
three interleaved timing pairs per experiment, each run in fresh browser
processes and a fresh context, baseline first and alternating.

### Verdict against the declared threshold

Two experiments, because the candidate changes which thread reads the assembly
tree and a relocated package reads it from a sidecar instead of the document.
The second arm is declared with its own package digest and its own baseline, as
the pinned-inputs section requires; it does not replace the pinned package.

| Experiment | Package | Peak main-thread heap, baseline to candidate | Threshold | First coarse frame, timing set | Tolerance |
|---|---|---|---|---|---|
| `pinned`, document-carried tree | `a2d6c72a…` | 2,122,989,603 → 962,369,086 B, **−54.67%** | −10% | 4,401 → 3,481 ms, **−20.9%** | +5% |
| `relocated`, hierarchy sidecar | `b821e431…` | 1,745,846,014 → 865,013,123 B, **−50.45%** | −10% | 3,919 → 3,233 ms, **−17.5%** | +5% |

The behaviour guard holds in both: every accepted run preserved the assembly
tree, source-aware picking, property resolution, selected-object detail, and the
pinned resident endpoint — 111 of 234 target chunks, 66,686,508 B decoded,
66,783,808 B GPU, 2,255,235 triangles, 78,173 renderable occurrences — with no
console issue. Both experiments record `landed: true`.

### Per-phase medians

Main-thread used JS heap, MiB, baseline to candidate. Exact bytes, the
whole-cluster `measureUserAgentSpecificMemory()` figure, and the process-tree
working set and private commit are in the record.

| Phase | `pinned` | `relocated` |
|---|---|---|
| `hierarchy` | 812.7 → 140.9 | 911.7 → 140.9 |
| `coarse-frame` | 328.8 → 679.6 | 248.6 → 680.2 |
| `budget-limited` | 853.8 → 287.1 | 707.1 → 287.1 |
| `replace-overlap` | 984.8 → 917.8 | 1,546.5 → 824.9 |
| `replace-settled` | 2,024.6 → 469.3 | 1,531.5 → 788.5 |
| `disposed` | 376.1 → 295.3 | 299.2 → 294.1 |

`hierarchy` is where the candidate's shape is clearest: the main thread reaches a
usable assembly tree holding 140.9 MiB instead of 812.7 or 911.7. `coarse-frame`
moves the other way because the candidate has admitted the whole 66,686,508 B
endpoint by the time it paints, while the baseline is still filling it — the same
phase in the baseline holds 20,327,232 B (`pinned`) and 9,197,064 B
(`relocated`) of decoded geometry. `budget-limited` is the fair comparison at
equal residency, and there the candidate holds 287.1 MiB against 853.8 and
707.1.

The whole-cluster figure moves far less than the main-thread heap — at
`budget-limited`, 632.2 → 560.0 MiB (`pinned`) and 509.9 → 553.3 MiB
(`relocated`, i.e. slightly up). That is the honest shape of this change: the
parse moved to the Worker rather than disappearing. The main thread stops paying
for it; the process largely still does. Nothing here is a total-memory result.

The process-tree figures are reported, not gating, and they do not move in one
direction either. At `budget-limited` the candidate's working set is lower in
both experiments (2,535.8 → 2,254.8 MiB `pinned`, 2,351.3 → 2,283.6
`relocated`), but after disposal the relocated candidate sits higher than its
baseline (1,097.6 → 1,429.1 MiB) while the pinned one sits lower (1,804.9 →
1,526.6). A working set after teardown is what the allocator has not returned,
not what the page holds, and this protocol does not treat it as a result.

### Timing, and one cost the guard does not cover

From the timing set only. No number below comes from the memory set, whose
milestones carry `milestonesArePerturbedBySampling: true` because forced
collection and `measureUserAgentSpecificMemory()` distort them.

| Milestone | `pinned` | `relocated` |
|---|---|---|
| Assembly tree ready | 2,214 → 2,725 ms | 2,324 → 2,491 ms |
| First coarse frame | 4,401 → 3,481 ms | 3,919 → 3,233 ms |
| Budget-limited ready | 13,596 → 11,589 ms | 13,129 → 11,396 ms |

The assembly tree arrives **later** on the candidate — 511 ms later on the
pinned package, 167 ms on the relocated one — because it now waits for the
Worker's initialization response instead of being parsed on the main thread
while the Worker starts. No declared guard covers that milestone; the timing
guard is first coarse frame alone. It is a real cost, and it is stated here
rather than left to be read out of the JSON. Both later milestones improve.


### Deviations and measurement decisions

Everything the runs did that this protocol did not say in advance, so that the
record is readable without the recorder source.

1. **`replace-overlap` is sampled without `measureUserAgentSpecificMemory()`.**
   That call has blocked for as long as 14,055 ms on this host, which is longer
   than the overlap interval it would be measuring. The phase instead polls the
   main-thread heap every 500 ms until the replacement's coarse frame appears
   and keeps the single highest-heap poll, recorded per run as `overlap`
   (`pollCount`, `windowMilliseconds`, `selectedBy`). The windows were short:
   `pinned` baseline 2,769 / 2,354 / 2,140 ms over **one poll each**, `pinned`
   candidate 3,519 / 3,400 / 3,450 ms over three, and all six `relocated`
   windows over two (baseline 2,481 / 2,664 / 2,474 ms, candidate 2,782 /
   2,760 / 2,630 ms). A one-poll sample is a single observation inside the
   interval, not its maximum; `uaMemoryBytes` is recorded absent for this phase
   with that reason.
2. **`disposed` records admitted bytes absent with a stated reason.** After
   disposal the Studio publishes no residency pair, so the phase declares the
   absence rather than writing zero.
3. **`hierarchy` records admitted bytes absent for the same reason.** The
   scheduler publishes its budget and totals before it admits a chunk, and the
   tree is ready before that.
4. **`coarse-frame` may record them absent too.** It did not need to in either
   set — every accepted run had admitted bytes by first paint — but the phase
   permits it, because the budget is published before the first promotion.
5. **The `disposed` transition is witnessed indirectly.** The Studio's
   `hierarchyReady` dataset key is written but never cleared, so it cannot
   witness a teardown. The phase waits on the occurrence count clearing
   together with the hierarchy stage state.
6. **Only the first memory pair of each arm carries screenshots.** Five
   captures per arm per experiment — `coarse-frame`, `budget-limited`,
   `replace-settled`, `selection`, `disposed` — are enough to show the
   behaviour guard held; taking them in every run would add I/O to the
   sampled runs for no further evidence.
7. **Memory-set milestones are published but not used.** Every memory run
   carries `milestonesArePerturbedBySampling: true`. The set's own medians
   (baseline 2,289 / 4,509 / 18,934 ms against candidate 2,833 / 15,472 /
   34,945 ms on the pinned package) are recorded for completeness and are not
   a timing result; the protocol's second set exists precisely because they
   are not.
8. **The endpoint triangle total is read from `#triangle-count`.** The status
   line never carries one, so the pinned triangle figure comes from the
   element that publishes it.
9. **The measured candidate is not the first commit of the candidate.** A
   scene replacement on the candidate left the replacement renderer
   configuring a canvas context the previous renderer still owned, which is a
   candidate-only fault and would have failed the behaviour guard in every
   run. It was found and fixed before any valid set existed. The claim in the
   original candidate commit that no device overlap occurs is withdrawn; the
   fix is what makes it true.
10. **The pinned set here is the fifth attempt at that arm.** The four earlier
    sets were void, not discarded: each stopped on a fault in the harness, and
    a harness fault is not one of the three observable faults this protocol
    declares as grounds for discarding a run. A void set restarts from zero
    and contributes nothing, so no run from them appears here and none was
    topped up. The record's `discardedRuns` is 0 in all four sets because no
    accepted-set run was ever thrown away.

## What this protocol cannot settle

One engine and one operating system. A cross-engine memory difference measured
under it is a difference, not a cause: no attribution is claimed without
evidence that isolates it. And the geometry budgets stay what they are — a bound
on admitted target geometry, not on the process.
