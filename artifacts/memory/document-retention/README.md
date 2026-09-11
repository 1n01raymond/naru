# Document retention experiment protocol

Status: protocol predeclared 2026-09-12. No record exists yet. This directory
holds the measurement contract for the retention experiment described in the
[Phase 2 tracker](../../../docs/PHASE_2.md), written before any run so that a
result cannot be produced by choosing a threshold afterwards.

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

## What this protocol cannot settle

One engine and one operating system. A cross-engine memory difference measured
under it is a difference, not a cause: no attribution is claimed without
evidence that isolates it. And the geometry budgets stay what they are — a bound
on admitted target geometry, not on the process.
