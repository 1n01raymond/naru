# Phase 2 completion report

Status: Complete (2026-09-12)

Phase 2 turns the Phase 1 vertical slice into a usable large-scene alpha. NARU
publishes a source-derived engineering package from a delivery origin, opens it
in a deployed browser Studio, keeps it useful under a fixed residency budget and
under a forced low-memory profile, and saves and reopens a workspace that
verifies its own sources. This is an alpha milestone, not a production-readiness
or universal renderer-performance claim.

The detailed capability ledger, work order, and evidence debt remain in [the
Phase 2 tracker](PHASE_2.md), and they are not emptied by this report. This
report closes the four roadmap exit criteria and presents the already-reviewed
records as one public, reproducible summary.

## Exit decision

| Roadmap criterion | Reproducible evidence | Result |
|---|---|---|
| One redistributable source-derived engineering package with at least 100,000 renderable geometric occurrences, 10,000,000 submitted triangles, and 10,000 geometric prototypes, with unique triangle count reported alongside | The 31-document sixty5 Design + Engineering qualification records 104,337 renderable occurrences, 46,059,890 submitted triangles, 66,396 geometric prototypes, and 10,394,938 unique triangles with 0 Khronos errors or warnings ([qualification](../artifacts/ifc/engineering-baseline/README.md)); the deployed Studio opens those bytes from the accepted delivery origin, verifying all six resources ([public-origin record](../artifacts/public-demo/engineering-baseline-origin/README.md), [ADR-0023](adr/0023-public-package-delivery-origin.md)) | Passed |
| Cold/warm startup, frame, memory, and interaction results published | One matrix collects cold and warm import distributions, first frames in two engines, localized demand, and memory ([results matrix](REAL_LARGE_RESULTS.md)), each row backed by its own committed record and validator | Passed |
| Forced low-memory scenario remains functional | A forced `?residencyMiB=8` profile keeps 4 of 234 chunks resident with all 78,173 occurrences still visible and navigation, selection, and eviction all completing, in Chrome ([envelope](../artifacts/memory/sixty5-envelope/README.md)) and Firefox ([repeat](../artifacts/memory/sixty5-envelope-gecko/README.md)) | Passed |
| Workspace reopens against unchanged source and detects changed source | A headed round trip saves a customized session, reopens it byte-identically with every part restored and its sources moving from `unverifiable` to `verified`, and reports `changed-source` with `geometryIsCurrent: false` after a same-length edit to one IFC document ([record](../artifacts/workspace/reopen/README.md), Accepted [ADR-0022](adr/0022-workspace-manifest.md)) | Passed |

All four criteria are demonstrated by records checked through `pnpm check` plus
the deployed-site `pnpm demo:smoke` check. Phase 2 therefore exits and Phase 3
becomes current.

The second and third criteria were scoped by the project owner on 2026-09-12 to
results published for one disclosed host across two browser engines. A repeat on
a second operating system remains worth doing and stays listed as evidence debt
in the tracker; it no longer holds either criterion open. Every startup and
memory figure below is Windows x64 on one discrete-GPU host, and nothing here
supports a cross-platform statement.

## Performance summary

These numbers were not re-run or averaged for this report. Each row links to the
record containing its samples, environment, limitations, and reproduction
command.

| Question | Recorded result | Evidence boundary |
|---|---|---|
| What does a first real-large import cost, and what does reopening it cost? | Five fresh-process cold sixty5 imports median 381.4 s with an observed p95 of 385.3 s, peaking at a 5.08 GB process tree and decomposing into 292.4 s of adapter extraction and 89.0 s of packaging; five warm reopens median 1.36 s of compiler time and 1.43 s including `node` startup, 281 times faster, and a corrupt entry falls back to an 89.0 s rebuild | Five samples per state on one Windows host; every sample published the same package digest ([record](../artifacts/cache/sixty5/README.md)) |
| Is structure usable while a cold import is still running? | A headed Studio opened before a cold sixty5 `compile-ifc --staged-preview` spawned shows the first document's tree searchable and selectable 1.5 s after spawn and the seventh at 271.5 s, then hands off to the compiled package at 417.8 s, its first coarse frame at 422.8 s, and its budget-limited ready state at 427.7 s with 0 console issues | One Chrome run pair on one Windows host; no per-document coarse geometry exists before the package ([record](../artifacts/import/staged-import-browser/README.md)) |
| Does a real-large scene become useful before full detail, in more than one engine? | sixty5 reaches hierarchy at 2,478 ms, its first coarse frame at 4,743 ms, and its budget-limited ready state at 9,288 ms in Chrome, with 111 of 234 target chunks and 2,255,235 triangles resident under separate 64 MiB decoded and GPU budgets; Firefox settles on the identical resident set at 3,122 / 6,093 / 11,914 ms, about 1.28 times the Chrome coarse frame | Two engines driven from the same Windows discrete-GPU host; not a cross-platform or p95 claim ([Chrome](../artifacts/ifc/sixty5-first-frame/README.md), [Firefox](../artifacts/ifc/sixty5-first-frame-gecko/README.md)) |
| What does the whole process cost, and does the budget bound it? | At the budget-limited phase Chrome's process tree working set medians 2,586,112,000 B, of which resident geometry is 2.58%; Firefox medians 5,104,345,088 B for a byte-identical settled resident set at eight profile and phase points, a 1.31% share, and misses the predeclared 4 GiB working-set ceiling at 5,486,096,384 B | Reported, not widened; GPU driver allocation is unavailable on every engine measured ([Chrome](../artifacts/memory/sixty5-envelope/README.md), [Firefox](../artifacts/memory/sixty5-envelope-gecko/README.md)) |
| Does localized navigation avoid whole-scene work? | A localized sixty5 camera trace visits 889 nodes, 184 of 2,048 leaves, and 7,026 of 78,173 occurrences; leaf-anchor packing demands 152 chunks and 78,875,544 B against 209 chunks and 107,337,264 B under compatibility order, 27.3% fewer chunks and 26.5% fewer bytes, with navigation queries at a 0.300 ms p50 and 0.405 ms p95 | Three headed Chrome runs per order on one Windows host ([record](../artifacts/spatial-demand/sixty5-localized/README.md)) |
| Can a reduced level replace target detail without changing what the user sees or picks? | At three camera distances the drawn geometry agrees with the target-only reference on 99.06%, 99.01%, and 99.23% of pixels while triangles fall from 6,159 to 5,537, 4,135, and 4,135, and every picked identifier is identical with 0 disagreements in both Chrome and Firefox | A generated LOD corpus, not an industrial assembly ([record](../artifacts/lod/reduced-selection/README.md), [ADR-0025](adr/0025-shape-preserving-lod-representation.md)) |

The renderer comparison remains `exploratory-not-adr-decision`, and ADR-0003
remains Proposed. Phase 2 publishes divergent browser and hardware results
rather than converting them into a renderer-decision claim.

## Reproduce

Portable validation, including every committed evidence validator:

```sh
pnpm check
```

Focused records used by this report:

```sh
pnpm ifc:engineering:check
pnpm demo:baseline:check
pnpm cache:sixty5:check
pnpm staged:import:browser:check
pnpm ifc:first-frame:check
pnpm ifc:first-frame:gecko:check
pnpm memory:envelope:check
pnpm spatial:localized:check
pnpm lod:selection:check
pnpm workspace:reopen:check
pnpm demo:smoke
```

The headed recorders need the browsers, native adapter environments, external
fixtures, and host conditions documented by each linked artifact. A validator
rechecks committed measurements; it does not recreate a headed or native run.
Several records pin host-local package digests deliberately, and those digests
must not be retargeted to make a re-record pass.

## Phase 3 handoff

Phase 2 completion does not claim that the following work is unnecessary. It
states that it is not required to close the large-scene alpha criteria:

- a second operating system for the startup, memory, workspace, staged-import,
  and localized-demand records, and a broader browser and GPU conformance
  matrix with the ADR-0003 decision that depends on it;
- dependency-safe per-discipline IFC rebuild beyond adapter reuse, which is the
  remaining gate on [ADR-0010](adr/0010-ifc-incremental-dependency-index.md) and
  on slices 2 and 3 of [ADR-0019](adr/0019-document-artifact-transport.md);
- a browser record of the persistent package cache tier, the open gate on
  [ADR-0024](adr/0024-persistent-package-cache.md);
- an import consumer outside the CLI and a real-large cancellation record, the
  open gates on [ADR-0020](adr/0020-cancellable-import-jobs.md);
- production-grade IFC adapter and BIM property workflow, plugin manifest,
  panels, bounded overlays, and safe mode; and
- accessibility and localization completion for Studio core, which the roadmap
  places in Phase 4.

Those are Phase 3 or later gates in [the roadmap](ROADMAP.md), and the surviving
evidence debt is listed in the [Phase 2 tracker](PHASE_2.md). A future failure in
one of them does not retroactively change the evidence recorded here.
