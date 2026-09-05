# Phase 2 Execution and Evidence Tracker

Status: Current (opened 2026-08-28)

Phase 2 turns the completed source-to-browser vertical slice into a usable
large-scene alpha. The [roadmap](ROADMAP.md) remains authoritative for scope and
exit criteria. This tracker owns the current work order, dependencies, and
evidence debt so the completed [Phase 1 tracker](PHASE_1.md) can remain a
historical record.

This document uses four states deliberately:

- **Recorded** means a committed artifact and validator reproduce the claim.
- **Implemented** means focused automated tests cover the behavior, but the
  Phase 2 product gate has not been recorded.
- **Partial** means only part of the stated gate has evidence.
- **Pending** means the capability or its required evidence does not exist yet.

An implementation is not a performance result, and validating a committed
record is not the same as re-running its native or headed recorder.

## North Star

Opening a real-large STEP or IFC source should expose structure and a useful
coarse view quickly, keep expensive import work cancellable, and make unchanged
or localized follow-up work proportional to what changed.

| User path | Product target | Current baseline | Gate state |
|---|---:|---|---|
| First real-large source import | Minutes are allowed | Five fresh-process cold sixty5 imports median 381.4 s, observed p95 385.3 s, peaking at a 5.08 GB process tree ([record](../artifacts/cache/sixty5/README.md)); their medians decompose it into 292.4 s of adapter extraction and 89.0 s of packaging | The cold cost is **Recorded**; the progress, cancellation, and durable-completion contract is **Implemented** under [ADR-0020](adr/0020-cancellable-import-jobs.md) and unit-proved but not yet recorded against this model; background execution is **Pending** |
| Hierarchy and coarse preview during first import | 5–15 s | An already compiled sixty5 package reaches hierarchy/search in 2.3 s and its first coarse frame in a 4.487 s three-run median ([record](../artifacts/ifc/sixty5-first-frame/README.md)). On the import side, the shipping adapter publishes the first document’s assembly tree, verified on disk by a watcher outside the process, 0.690 s after spawn on sixty5 and 0.753 s on Digital Hub, with the whole federation’s last tree at 226.638 s ([record](../artifacts/import/structure-first-emission/README.md)) | The compiled-package path is **Recorded**; the import path’s adapter half is **Recorded** ([ADR-0021](adr/0021-staged-hierarchy-first-import.md) gate 1), the compiler’s verified atomic staged publication is **Unit-proved** (gates 2 and 3), and publishing a tree to a viewer while import continues is **Pending** |
| Reopen unchanged inputs | 1–5 s | Five fresh-process warm sixty5 reopens median 1.36 s of compiler time and 1.43 s including `node` startup, 281× faster than the cold import that published the entry ([record](../artifacts/cache/sixty5/README.md)); mid-size single runs are 1.7 s for PyGamer STEP and 0.5 s for Digital Hub IFC ([record](../artifacts/cache/README.md)) | **Recorded** at real-large scale on one disclosed host |
| Change one IFC discipline | Work proportional to the affected dependency set | Unchanged document extraction can skip IfcOpenShell; federation-wide compiled resources are still rebuilt ([integration test](../native/adapter-ifc/tests/test_document_artifact_integration.py), [ADR-0010](adr/0010-ifc-incremental-dependency-index.md)) | Adapter reuse is **Implemented**; the content-addressed payload tier is **Measured and rejected** ([record](../artifacts/cache/payload-reuse/README.md): byte-identical rebuilds, but restore 2.2–2.4× slower than re-encoding); a reuse unit that pays off is **Pending** |
| Reuse within a team | Avoid duplicate local import when policy permits | A local verified [whole-package cache](../artifacts/cache/README.md) and [document-artifact cache](../native/adapter-ifc/tests/test_document_artifact_cache.py) exist | Authorized shared lookup/publication is **Pending** |

The 4.487 s browser result above starts from an existing compiled package. It
must not be reported as a 4.487 s first source import. The complete product
contract, including cache identity and security, is in
[Import and compiled-cache product contract](IMPORT_AND_CACHE.md).

## Official exit criteria

Phase 2 exits only when all four criteria in the roadmap are recorded. Partial
signals are listed to prevent an adjacent result from being mistaken for a
closed gate.

| Roadmap criterion | Current evidence | Missing before exit | State |
|---|---|---|---|
| Public engineering baseline: 100k+ renderable geometric occurrences, 10M+ submitted triangles, and 10k+ geometric prototypes | The qualified [31-document sixty5 Design + Engineering package](../artifacts/ifc/engineering-baseline/README.md) passes all three floors together: 104,337 renderable occurrences, 46,059,890 submitted triangles, and 66,396 geometric prototypes; it reports 10,394,938 unique triangles and Khronos validation at 0 errors / 0 warnings | The delivery path now exists in the repository: [ADR-0023](adr/0023-public-package-delivery-origin.md) (Accepted 2026-09-05) fixes a delivery-origin contract, `deploy-demo.yml` verifies every declared resource's SHA-256 at a configured origin and builds the Studio to open the package cross-origin, and `pnpm demo:smoke --package-origin` asserts that contract from outside. The origin exists (`https://packages.blacktanlabs.com/naru/digital-hub/v1/`), the deploy verifies it, and the [public-demo browser record](../artifacts/public-demo/digital-hub-origin/README.md) shows the deployed Studio opening the Digital Hub package cross-origin to a first frame and a pick (ADR-0023 gates 1-3). The baseline itself is delivered the same way: the [engineering-baseline origin record](../artifacts/public-demo/engineering-baseline-origin/README.md) (`pnpm demo:baseline:check`) shows the deployed Studio opening the 31-document package from `https://packages.blacktanlabs.com/naru/engineering-baseline/v1/` through its scene query, every one of the six resources (854,447,023 bytes, this host's compile `04472c9ad292…` of the sources the macOS qualification record compiled to `6d23bffd6632…`; both digests pinned) verified at the origin before and after the run, to hierarchy at 13,736 ms, first coarse frame at 19,955 ms, the budget-limited ready state at 29,026 ms with 82 of 626 chunks resident under 64 MiB over 82 `206` Range responses, and a pick with 9 resolved property entries, 0 console issues, identical endpoint over three runs (gate 4) | Nothing for the criterion. The public package is one host's bytes rather than the macOS qualification record's (cross-host adapter drift, tracked below), the record is one engine on one operating system, and the milestones are bounded, not pinned | **Met** |
| Cold/warm startup, frame, memory, and interaction results published | The [real-large results matrix](REAL_LARGE_RESULTS.md) presents the [first-frame](../artifacts/ifc/sixty5-first-frame/README.md), [localized-demand](../artifacts/spatial-demand/sixty5-localized/README.md), [memory-envelope](../artifacts/memory/sixty5-envelope/README.md), and five-sample [cold/warm/corrupt cache](../artifacts/cache/sixty5/README.md) records together, and the [Gecko first-frame record](../artifacts/ifc/sixty5-first-frame-gecko/README.md) repeats the startup and frame half on a second engine, which admits a byte-identical resident set, while the [Gecko memory envelope](../artifacts/memory/sixty5-envelope-gecko/README.md) does the same for the memory half | A repeat on a second operating system; the matrix itself spans four different compilations, so it is not an end-to-end timeline | **Partial** |
| Forced low-memory scenario remains functional | The [memory envelope](../artifacts/memory/sixty5-envelope/README.md) records three default-budget and three forced-low 8 MiB sixty5 runs: hierarchy, coarse rendering, navigation, source-aware selection, and eviction all complete in both profiles, and every reported byte names its owner, lifetime, and collection method rather than folding unmeasurable categories into zero; the [Gecko repeat](../artifacts/memory/sixty5-envelope-gecko/README.md) records both profiles on a second engine and admits a byte-identical resident set at every settled phase, which is the estimator-independent figure this criterion asks for, and reports that this engine does not meet the predeclared 4 GiB process working-set ceiling | A repeat on a second operating system; GPU driver allocation stays unavailable on every engine measured | **Partial** |
| Workspace reopens against unchanged source and detects changed source | [Cache tests](../packages/compiler/test/compiled-cache.test.ts) inspect source identity, and [IFC dependency tests](../packages/compiler/test/ifc-incremental-dependencies.test.ts) detect changed/deleted/renamed inputs. The manifest itself now exists: [`@naru3d/workspace`](../packages/workspace/README.md) owns `naru.workspace.1` under [ADR-0022](adr/0022-workspace-manifest.md), with a canonical serializer, a fail-closed parser, and a pure reopen decision whose per-part states keep `unverifiable` distinct from `verified` ([format tests](../packages/workspace/test/document.test.ts), [decision tests](../packages/workspace/test/reopen.test.ts)). The Studio now saves a workspace, reopens one, and can inspect picked source files to turn `unverifiable` into a real verdict; the capture, reopen, and portability contract it calls is covered by [session tests](../apps/webgpu-spike/test/workspace-session.test.ts) over the committed report shapes ([reader tests](../apps/webgpu-spike/test/package-identity.test.ts)). A [browser record](../artifacts/workspace/reopen/README.md) (`naru.workspace-reopen-evidence.1`) now shows a saved session reopened against an unchanged package as `unverifiable` then `verified` with a byte-identical re-save, the same workspace reopened after a same-length source edit as `changed-source` with `geometryIsCurrent` false over a still `verified` package, and the reload restore path producing a byte-identical screenshot, so [ADR-0022](adr/0022-workspace-manifest.md) is **Accepted** | Repeat on a second engine and at real-large scale | **Met** |

No percentage-complete claim is derived from this table. The gates differ too
much in risk and effort for a raw item count to be meaningful.

## Workstreams

### A. Trustworthy incremental import

| Capability | Current state | Next acceptance gate |
|---|---|---|
| Verified whole-package cache | **Recorded** under accepted [ADR-0009](adr/0009-persistent-compiled-cache.md): [warm restore evidence](../artifacts/cache/README.md) is byte-identical and corruption fails closed, and a [real-large five-sample distribution](../artifacts/cache/sixty5/README.md) adds cold/warm/corrupt medians, cache footprint, and process-tree peak memory; [focused storage tests](../packages/compiler/test/compiled-cache.test.ts) cover identity and restore rules | Break the restore itself into stages, and repeat the distribution on a second host class |
| IFC dependency ownership | **Implemented** under proposed [ADR-0010](adr/0010-ifc-incremental-dependency-index.md), including [changed/deleted/renamed/reconciliation tests](../packages/compiler/test/ifc-incremental-dependencies.test.ts) | Keep the index conservative while physical payload ownership is introduced |
| Per-document IFC extraction reuse | **Recorded** under proposed [ADR-0019](adr/0019-document-artifact-transport.md) slice 1: artifacts are `naru.ifc-document-artifact.2`, verified by header checks and one SHA-256 over the stored payload bytes before any parse ([tests](../native/adapter-ifc/tests/test_document_artifact_cache.py), [clean adapter-merge equivalence](../native/adapter-ifc/tests/test_document_artifact_integration.py)); the [rebuild record](../artifacts/cache/rebuild-stages/README.md) measures a changed-discipline rebuild against a same-session clean rebuild on Digital Hub (11,102.2 vs 50,028.4 ms whole process, peak working set 0.64 vs 1.83 GB, unchanged-document verification 34.1 ms) and sixty5 (72,993.4 vs 320,064.2 ms, 4.15 vs 5.08 GB, verification 353.0 ms), byte-identical packages in both arms | Column-form structure (slice 2) and in-compiler federation assembly (slice 3) |
| Real-large document serialization | **Recorded** under accepted [ADR-0016](adr/0016-streamed-gltf-document.md): the compiler emits `scene.gltf` as a stream of bounded chunks instead of building it as one string, so the [sixty5 record](../artifacts/cache/sixty5/README.md) now compiles the default pretty-printed federation document at 545,470,166 B - 8,599,278 B past the runtime's 536,870,888-byte maximum string length - while the compact package stays byte-identical over fifteen samples; [differential tests](../packages/compiler/test/json-stream.test.ts) compare every chunk against `JSON.stringify` | Give the report, property, and dependency documents the same bounded treatment before any of them approaches the same limit |
| Assembly-tree transport | **Recorded** under accepted [ADR-0017](adr/0017-relocated-hierarchy-sidecar.md): `--relocate-hierarchy-nodes` moves mesh-less nodes into a `naru.package-hierarchy.1` sidecar, taking the engineering baseline's document from 405,570,167 to 317,466,183 B (-21.72%) and the whole package down 2.72% once the 64,825,238 B sidecar is charged against it ([record](../artifacts/compiler/hierarchy-relocation/README.md)); a Digital Hub round trip returns 13,681 entries and 5,152 world transforms with 0 mismatches. Paired sixty5 packages in a headed browser then measured what the smaller document buys: first coarse frame 4,408 -> 3,703 ms (-15.99%), peak JS heap -20.30%, sidecar fetched once per run ahead of the coarse payload, identical endpoint over 17 counters ([record](../artifacts/ifc/relocated-hierarchy-browser/README.md)) | Flip the default in its own slice, together with promoting `naru.package-hierarchy.1` out of `experimental-not-interchange` and the package re-digests that forces |
| Content-addressed compiled payloads | **Recorded and rejected** under [ADR-0018](adr/0018-content-addressed-compiled-payloads.md): changed-discipline rebuilds of Digital Hub (2,664 of 3,383 payloads restored) and sixty5 (40,066 of 42,435) reproduced every clean-package byte over 26 comparisons with exact store decisions, but packaging took 3,184.9 ms clean vs 7,585.0 ms store-warm on Digital Hub and 35,202.0 vs 77,713.5 ms on sixty5 ([record](../artifacts/cache/payload-reuse/README.md)) — verifying a stored payload costs more than re-encoding it from the parsed scene, so the ADR's own gate 4 rejects it; `--payload-cache`, its store, its selection logic, its tests, and its recorder are removed under ADR-0019 (2026-09-03); the encoder/placement split ([test](../packages/compiler/test/compiled-payload.test.ts)) and the record's validator stay | Successor designed as [ADR-0019](adr/0019-document-artifact-transport.md) (Proposed): reuse the verified per-document Scene IR artifact across the adapter–compiler transport and remove `--payload-cache`; its gate 0 [stage decomposition](../artifacts/cache/rebuild-stages/README.md) is recorded (unchanged-document transport 48.0 percent of a Digital Hub rebuild, 77.3 percent of a sixty5 one; encoder 2.3 and 2.5 percent), and the `--payload-cache` removal has landed, so the next slices are the three transport slices |
| Import lifecycle | **Implemented, unit-proved** under [ADR-0020](adr/0020-cancellable-import-jobs.md) (Proposed): both compilers report a versioned `naru.import-job-event.2` stream - nine ordered states, gapless sequence, monotonic elapsed time, progress counted in lifecycle steps rather than estimated from source size, every field scrubbed of filesystem paths - and `--json-events` emits it as newline-delimited JSON. Cancelling terminates the adapter and every process it started ([tests](../packages/compiler/test/import-job-cancellation.test.ts) prove descendant death by binding the port the descendant held), removes the temporary Scene IR directory, and leaves a configured cache entry byte-identical; publication is deliberately uninterruptible because the package writer is not atomic, and the event reports that | Drive it from a second consumer outside this CLI and record a cancellation against a real-large sixty5 extraction - the ADR's two open gates |
| Progressive cold-import preview | **Adapter and compiler halves implemented** under proposed [ADR-0021](adr/0021-staged-hierarchy-first-import.md). The [structure-readiness record](../artifacts/import/structure-readiness/README.md) settled the shape — producing a tree is parsing (98.5 percent; the containment walk is 1.3), so a whole-federation tree is 40,474.9 ms on sixty5 and no schedule beats its largest single document at 15,030.3 ms — and `--structure-preview` now acts on it: the [first-emission record](../artifacts/import/structure-first-emission/README.md) watches the adapter from outside the process and verifies sixty5’s first tree on disk at 0.690 s, every document’s tree published before that document’s own extraction finished, and every per-document node count equal to the same run’s Scene IR occurrence count. Both arms’ outputs are byte-identical (36 comparisons per model, no exclusions); staging costs sixty5 22.4 s and 1.17 GB of peak, attributed in the record to inspecting the largest document last rather than to building trees. `--staged-preview` then carries each tree into a verified, atomically published `naru.package-hierarchy.1` pair under a `staged.json` manifest and a `staged` event on the `naru.import-job-event.2` stream; [tests](../packages/compiler/test/ifc-federation.test.ts) pin an identical package digest, resources, and bytes with staging on and off (gate 2), refusal of a misidentified or tampered tree, and a cancel after staging that removes the directory with the split while a cache entry survives (gate 3, [test](../packages/compiler/test/import-job-cancellation.test.ts)) | Read the staged directory in the Studio while the compile continues, and record it once against a cold sixty5 import (gate 4, with gate 5 folded into the same record) |
| Shared compiled cache | **Pending** and intentionally later | Require verified local immutable payloads plus authorization, tenant isolation, provenance, quota, and observability contracts first |

ADR-0010 remains Proposed: complete clean-package byte equivalence under a
changed discipline is recorded, but the payload tier that was to make the
rebuild cheaper was rejected on cost, so a successor reuse unit is still owed. Its logical index and document cache do not
authorize reuse of old glTF byte ranges by themselves.

### B. Bounded large-scene fidelity

| Capability | Current state | Next acceptance gate |
|---|---|---|
| Fixed target-geometry residency | **Recorded**: [sixty5 target promotion](../artifacts/ifc/sixty5-browser/README.md) remains inside separate 64 MiB decoded/GPU admission budgets while coarse fallback remains visible, and the [memory envelope](../artifacts/memory/sixty5-envelope/README.md) separates those budgets from observed process memory across a default and a forced-low 8 MiB profile, and the [Gecko repeat](../artifacts/memory/sixty5-envelope-gecko/README.md) reproduces both profiles on a second engine with a byte-identical resident set | Repeat the ledger on a second operating system, then decide whether any category it ranks is worth optimizing |
| Spatial demand | **Recorded** on [focused Chrome/Firefox](../artifacts/spatial-demand/README.md) and [real-large Chrome](../artifacts/spatial-demand/sixty5-localized/README.md) paths under proposed [ADR-0008](adr/0008-spatial-demand-partitioning.md) | Repeat a localized real-model trace in a non-Blink engine and cross-check nested large-coordinate transforms |
| Demand ordering | **Recorded** as opt-in: [projected-area ordering](../artifacts/spatial-demand/sixty5-demand-priority/README.md) wins one pose and loses another | Define and record a view-independent screen-space-error or blended cost before changing the default |
| Shape-preserving LOD | **Pending** | Define geometric/screen error, identity and edge behavior, compiler representation, and reference-image gates |
| Persistent browser cache and cache-aware eviction | **Pending** | Define storage quota, digest verification, version invalidation, and interaction with memory residency |
| Broader selection residency | **Pending** | Multi-selection pinning must have a bounded policy and retain coarse visibility under pressure |

The fixed 64 MiB measurements apply to progressive target geometry admitted by
the runtime. They are not a claim that total process memory is bounded at every
scene size: the [memory envelope](../artifacts/memory/sixty5-envelope/README.md)
measures both quantities in the same runs and reports the geometry residency as
a small share of the browser's working set: 2.58% there, and 1.31% in the
[Gecko repeat](../artifacts/memory/sixty5-envelope-gecko/README.md), whose
resident bytes are identical.

### C. Product and contributor platform

| Capability | Current state | Next acceptance gate |
|---|---|---|
| Public Studio | **Recorded** in the [Phase 1 exit evidence](PHASE_1_REPORT.md#exit-decision) for the deployed Digital Hub/PyGamer paths; the [Studio guide](../apps/webgpu-spike/README.md) documents the live smoke check. Delivery is no longer tied to the site artifact: under [ADR-0023](adr/0023-public-package-delivery-origin.md) (Accepted) the deployment reads a package origin from the repository variable `NARU_PACKAGE_ORIGIN`, verifies each declared resource's SHA-256 there, builds the Studio with an absolute default scene URL ([tests](../apps/webgpu-spike/test/default-scene.test.ts)), and smoke-checks redirects, `Content-Length`, `Content-Type`, CORS, the exposed `Content-Range`, and an honest `206` from outside; unset, the deployment behaves exactly as before. The origin exists since 2026-09-05: a Cloudflare R2 bucket behind `packages.blacktanlabs.com` serves the Digital Hub package at its committed digests with the CORS rule and exposed `Content-Range` the contract requires, and `NARU_PACKAGE_ORIGIN` names it. The first deployment that read the variable (2026-09-05, run 33954446446) verified the digests at the origin and passed the smoke check from outside, closing ADR-0023 gates 1 and 2. The [public-demo browser record](../artifacts/public-demo/digital-hub-origin/README.md) (`pnpm demo:browser:check`) closed gate 3 the same day: headed Chrome opens the deployed Studio with no query and reads the package cross-origin to hierarchy (2,676 ms), first coarse frame (3,717 ms), ready with 45/45 chunks over 45 `206` Range responses (7,729 ms), and a pick with 18 resolved property entries, 0 console issues, every origin resource verified against the committed build report before and after the run. The [engineering-baseline origin record](../artifacts/public-demo/engineering-baseline-origin/README.md) (`pnpm demo:baseline:check`) closed gate 4: the 854,447,023-byte 31-document package is published at `https://packages.blacktanlabs.com/naru/engineering-baseline/v1/` beside its CC BY 4.0 license and attribution, and headed Chrome opens it through the Studio's scene query to hierarchy (13,736 ms), first coarse frame (19,955 ms), and the budget-limited ready state (29,026 ms, 82/626 chunks over 82 `206` Range responses) with a pick of 9 entries and 0 console issues; the deployed default scene stays Digital Hub | A second engine or operating system against the deployed site, and stable public-network timings; the engineering package on the origin is this host's compile, not the macOS qualification record's bytes |
| Sidecar integrity | Spatial and property sidecar loaders verify declared byte lengths and SHA-256 values before decode; [property-sidecar tests](../apps/webgpu-spike/test/property-sidecar.test.ts) cover local and URL same-length mutations | Preserve the fail-closed checks while remote limits expand to geometry, coarse resources, and aggregate package work |
| Untrusted package limits | **Recorded** under [ADR-0011](adr/0011-remote-package-limits.md): one transport policy (same origin, `redirect: "error"`, content-type allowlist, byte ceilings enforced while the body streams) covers every Studio fetch, and the compiled-glTF reader bounds node/mesh/accessor/buffer-view/chunk counts and traversal depth; [transport tests](../packages/runtime-webgpu/test/package-transport.test.ts) and [structural tests](../packages/runtime-webgpu/test/compiled-gltf.test.ts) cover each branch. Malformed-package behavior is recorded in [`artifacts/security/package-fuzz`](../artifacts/security/package-fuzz/README.md) (120,000 seeded mutations, 0 uncontrolled outcomes), and the policy is now embedder-facing: [`artifacts/security/embedder-overrides`](../artifacts/security/embedder-overrides/README.md) drives it from [`tools/package-embedder`](../tools/package-embedder), a consumer outside the Studio -- five committed packages open on the reviewed defaults and ten scenarios exercise the ceiling, origin, and transfer axes. Both records run in the check chain (`pnpm fuzz:check`, `pnpm embedder:check`) | Exercise the same policy from a consumer outside this repository, and extend it to any resource kind a package gains |
| Workspace | **Recorded in a browser** under accepted [ADR-0022](adr/0022-workspace-manifest.md): [`@naru3d/workspace`](../packages/workspace/README.md) is a runtime-free package holding `naru.workspace.1` -- package digest and per-resource identity copied from `build-report.json`, source identity from `adapter-report.json`, view state keyed by `occurrenceId` rather than node index -- a deterministic serializer, a parser that performs no network access and resolves no path, and `evaluateWorkspaceReopen`, whose five-state precedence puts a moved source above a moved package and reports `geometryIsCurrent` only when everything verified. The Studio saves and reopens through that package, reads package and source identity from the two import reports rather than from the scene, and reports the occurrence ids a reopened hierarchy no longer carries as dropped | Repeat the [round-trip record](../artifacts/workspace/reopen/README.md) on a second engine and at real-large scale |
| Framework-neutral embedding | **Pending** | Publish and test one application outside the reference Studio |
| Installable alpha release | **Pending**; workspace packages remain private pre-release packages | Define the supported public surface, compatibility policy, release notes, and installation smoke test |
| Contributor issue workflow | **Established**: the `Phase 2 — Large-scene alpha (0.2.x)` milestone, the `area:`/`priority:`/`status:` label taxonomy, the issue forms under [`.github/ISSUE_TEMPLATE`](../.github/ISSUE_TEMPLATE), and a reviewed `status:ready` queue exist; this tracker owns outcomes, issues own independently assignable work with acceptance criteria | Keep each open issue's status label and each epic checklist in step with merged work, so the queue never lists a blocker that has already landed |
| Documentation link integrity | **Recorded**: `pnpm docs:links:check` resolves every repository-local Markdown link and heading anchor against Git's tracked paths, offline, and `pnpm check` runs it; [focused tests](../tools/markdown-links/test/markdown-links.test.ts) cover fences, percent encoding, duplicate headings, Unicode anchors, and repository escapes | Extend the same portable gate to any generated documentation the repository starts publishing |

## Dependency order

| Outcome | Required predecessors | Why the order matters |
|---|---|---|
| Partial IFC package rebuild | Dependency index and per-document artifacts (**Implemented**) → a compiled reuse unit (content-addressed payloads **Measured and rejected**; successor verified per-document artifacts **Recorded** for slice 1 of three) → conservative invalidation/reconstruction → clean-package equivalence (**Recorded** for the rejected unit and for slice 1) | Logical provenance cannot prove that revision-local byte ranges are reusable |
| Preview during cold import | Import lifecycle contract (landed, [ADR-0020](adr/0020-cancellable-import-jobs.md)) → cancellable background adapter → stable hierarchy/coarse publication point (per document; the adapter half is recorded and the compiler’s staged publication unit-proved, [ADR-0021](adr/0021-staged-hierarchy-first-import.md)) → Studio progress UI | Publishing partial output without lifecycle and cleanup rules can expose incomplete or stale cache entries |
| Shape-preserving LOD | Error/identity contract → compiler representation → scheduler admission → visual and interaction evidence | An ordering heuristic is not an LOD representation and cannot establish fidelity |
| Persistent browser cache | Package integrity verification and resource limits → quota/version policy → cache-aware scheduler | Persisting unbounded or integrity-unverified remote resources enlarges the trust boundary |
| Workspace reopen | Stable source/cache identities (**Implemented**) → workspace manifest and reopen decision (**Implemented**, [ADR-0022](adr/0022-workspace-manifest.md), off any host path) → Studio save/reopen wiring (**Implemented**) → Studio reopen evidence (**Recorded**) | A whole-package cache hit is not a saved workspace |
| Shared team cache | Immutable local payload reuse → authorization/provenance contract → remote lookup/publication → isolation evidence | Content knowledge must never imply access to proprietary source-derived data |
| Public `0.2.x` alpha | Integrity/resource hardening plus all four exit records | Package availability alone is not the evidence-gated alpha exit |

## Prioritized plan

### Now — close correctness and make the next performance claim measurable

1. Land the successor to the rejected payload tier that
   [ADR-0019](adr/0019-document-artifact-transport.md) (Proposed) designs. Its
   gate 0 [stage decomposition](../artifacts/cache/rebuild-stages/README.md)
   of a changed-discipline rebuild — five fresh-process samples per model —
   puts the encoder at 2.3 percent (Digital Hub) and 2.5 percent (sixty5) of
   the rebuild and the adapter–compiler transport of unchanged documents —
   re-serialization verification, federation re-merge and re-write, structure
   re-scan — at 48.0 and 77.3 percent of it, so the reuse unit is the
   verified per-document Scene IR artifact rather than either option the
   tracker named before. The exploratory probe the ADR was written from did
   not reproduce inside the record's spread, and the ADR's Context was
   corrected from the record as gate 0 prescribes. The `--payload-cache`
   removal has landed (flag, store, selection, tests, and recorder gone; the
   encoder/placement split and cache primitives stay). Slice 1, stored-byte
   verification (`naru.ifc-document-artifact.2`), landed 2026-09-03 and the
   record was re-recorded as `naru.rebuild-stage-evidence.2` with a
   same-session clean arm: gates 1-3 met on both models, gate 4
   met (Digital Hub 11,102.2 against 50,028.4 ms, sixty5
   72,993.4 against 320,064.2 ms, peak memory lower in both). Remaining
   slices, in order: column-form structure (the 1.9 s Digital Hub structure
   scan the record still shows in `readSceneIr`) and in-compiler federation
   assembly. The ADR's gate 4 is the same predeclared bar after every slice: a
   lower whole-process rebuild median on Digital Hub and sixty5 with peak
   memory no higher, measured against a clean rebuild recorded in the same
   session, or the ADR is Rejected like its predecessor.

### Next — finish the user-visible import loop and bounded fidelity

1. Rebuild one changed IFC discipline measurably cheaper than a clean
   compile; byte identity of every resulting package resource is already
   recorded for the rejected payload tier and is the bar
   [ADR-0019](adr/0019-document-artifact-transport.md) keeps (its gates 1 and 4).
2. Run import in a cancellable background process, and close the two open gates
   of [ADR-0020](adr/0020-cancellable-import-jobs.md). The events themselves are
   defined and implemented: `naru.import-job-event.2`, nine ordered states,
   step-counted progress, path-scrubbed fields, `--json-events` on both
   compile commands, and a cancel that stops the adapter tree while never
   removing a verified cache entry. What remains is a consumer outside this CLI
   and a cancellation recorded against a real-large sixty5 extraction rather
   than a fixture-scale one.
3. Publish hierarchy/search and coarse preview during that cold import inside
   the 5–15 s product target, along the lines
   [ADR-0021](adr/0021-staged-hierarchy-first-import.md) (Proposed) designs. Its
   gate 0 [structure-readiness record](../artifacts/import/structure-readiness/README.md)
   — five fresh-process samples per model — settles the shape: producing a
   tree is parsing (98.46 and 98.60 percent of the time; the containment walk is
   1.3 percent and serializing it 0.1), so the whole sixty5 federation needs
   40,474.9 ms and no schedule beats its largest single document at 15,030.3 ms,
   while the first document is ready in 278.5 ms. The unit of publication is
   therefore one document’s tree, reusing the `naru.package-hierarchy.1`
   sidecar and ADR-0020’s cancellation rules. The first of three slices has
   landed: `--structure-preview` publishes each tree before tessellating its
   document, and the
   [first-emission record](../artifacts/import/structure-first-emission/README.md)
   verifies it from outside the process — sixty5’s first tree on disk at
   0.690 s, byte-identical adapter output with staging on and off, and a
   measured price of 22.4 s and 1.17 GB of peak on sixty5 that the record
   attributes to the emission reorder rather than to building trees. The second
   has landed too: `--staged-preview` verifies each tree by digest, publishes
   it atomically as a `naru.package-hierarchy.1` pair under a manifest, and
   reports it as a `staged` event, with unit tests pinning gate 2 (a package
   digest, resources, and bytes identical with staging on and off) and gate 3
   (a cancel after staging that leaves no staged directory, no partial
   package, no live adapter descendant, and an untouched cache entry).
   Remaining: the Studio background-import UI reading that directory, and one
   browser record against a cold sixty5 import that carries gate 4 and gate 5
   together. Gate 4 rejects the ADR on failure rather than relaxing it; coarse
   preview stays unmeasured until that record.
4. Deliver one shape-preserving LOD vertical slice with an explicit error and
   identity contract.
5. Add persistent browser cache tiers and cache-aware eviction after resource
   integrity verification and limits are complete.
6. Close the most decision-relevant evidence debt and blockers: non-Blink
   real-large spatial demand, nested precision, a second-engine repeat of the
   memory ledger, and public Studio delivery of the qualified
   engineering-scale package.
7. Qualify the registered CadQuarry 1k STEP corpus through a bounded Parquet
   scanner, then compile its extracted parts as a CAD breadth/control record.
   Keep that synthetic corpus separate from the real public-baseline gate.
8. Make relocation the compiler default. Both halves of
   [ADR-0017](adr/0017-relocated-hierarchy-sidecar.md) are now measured — the
   document drops 21.72% offline
   ([record](../artifacts/compiler/hierarchy-relocation/README.md)) and a paired
   browser record puts that at -15.99% on first frame and -20.30% on peak heap
   ([record](../artifacts/ifc/relocated-hierarchy-browser/README.md)) — so what
   is left is the cost of flipping it: `naru.package-hierarchy.1` has to leave
   `experimental-not-interchange`, and every committed package digest, the
   deployed demo release asset, and the records that pin them have to be
   re-recorded together.

### Later — expand only after the core loop is reproducible

- authorized shared compiled cache;
- multi-selection residency and multi-view;
- improved sections, measurement, and snapping;
- property-value search and richer BIM/PMI schemas;
- framework-neutral embedding and a supported package/CLI release; and
- the broader hardware/browser matrix required for the final ADR-0003 decision.

## Evidence debt

Evidence debt means the behavior exists but the repository does not yet carry
the decision-quality record needed for the intended claim. It is different from
a missing capability; background import, LOD, workspace persistence, shared
cache, and remote-resource limits are implementation backlog, not evidence
debt.

| Debt | Record needed | Decision or claim blocked |
|---|---|---|
| Real-large document-artifact reuse | Cold, warm, and one-document-changed extraction with clean-merge equivalence on a disclosed large fixture; the [rebuild record](../artifacts/cache/rebuild-stages/README.md) measures the one-document-changed case against a same-session clean rebuild (artifact bytes, per-document load, verification, and parse time, peak working set) on sixty5; what is not recorded is a cold-then-warm series of the artifact tier alone | Cost and scalability of the per-document reuse tier beyond the changed-discipline case; the parse and structure-scan costs the record leaves are ADR-0019 slices 2 and 3 |
| Cross-platform real-large startup | Repeat the [first-frame record](../artifacts/ifc/sixty5-first-frame/README.md) on a second operating system with the same package and viewport; the [Gecko repeat](../artifacts/ifc/sixty5-first-frame-gecko/README.md) closes the second-engine half on this Windows host only, and both engines were driven from the same Windows machine | Phase 2 exit criterion for published cold/warm startup, frame, memory, and interaction results |
| Cross-platform memory envelope | Repeat the [phase-sampled memory ledger](../artifacts/memory/sixty5-envelope/README.md) on a second operating system; the [Gecko repeat](../artifacts/memory/sixty5-envelope-gecko/README.md) closes the second-engine half on this Windows host only, carries no heap figure because that engine exposes neither estimator, and does not meet the predeclared 4 GiB process working-set ceiling | A memory claim that is not specific to one Windows host |
| Workspace round trip beyond one host | Repeat the [reopen record](../artifacts/workspace/reopen/README.md) on a second engine and against a real-large package; the committed record is headed Chrome on Windows over the 84.5 MB Digital Hub package, and its manifest digests depend on the serving origin | A reopen claim that is not specific to one engine, one host, and one package size |
| Cross-browser localized demand | Repeated Firefox or another non-Blink real-model localized trace with request order, query p50/p95, residency, and console results | ADR-0008 acceptance |
| Spatial precision cross-check | Nested-transform spatial bounds on the accepted ADR-0005 10,000 km fixture with no false negatives | ADR-0008 acceptance |
| Node-field elision at engineering scale | Re-record `artifacts/ifc/engineering-baseline/` on the host that produced it, with `--elide-derived-identifiers` and `--omit-default-node-transforms` declared, so the option pair is proven on the same package the qualification pins; the levers are measured on this Windows host, whose IFC split differs from that record's by a few bytes | ADR-0015 acceptance |
| Partial-rebuild saving | The [rebuild record](../artifacts/cache/rebuild-stages/README.md) shows a changed-discipline rebuild faster than a same-session clean rebuild with lower peak memory after ADR-0019 slice 1 on both models; the gate is re-run after slices 2 and 3, and only the record that closes slice 3 accepts | ADR-0010 acceptance, through [ADR-0019](adr/0019-document-artifact-transport.md) gate 4 |
| Current-toolchain large packages | Re-record Digital Hub and sixty5 with the current split.4 explicit-edge toolchain and synchronize the deployed package digest | Current-schema real-model claims |
| Real-large import cancellation | Cancel a cold sixty5 IFC compile mid-extraction and record that the adapter tree is gone, the temporary split removed, and the configured cache directory byte-identical; the [unit tests](../packages/compiler/test/import-job-cancellation.test.ts) prove the mechanism at fixture scale only | [ADR-0020](adr/0020-cancellable-import-jobs.md) acceptance |
| Renderer reference-hardware matrix | Repeat the existing harness on more disclosed discrete/integrated profiles with explicit edges and bounded residency | Hardware/browser portion of ADR-0003 acceptance or revision |

## Capability and external blockers

These items require implementation, diagnosis, licensed input, or a supported
external environment before recording alone can close them. They are not
evidence debt.

| Blocker | Required change or external condition | Gate blocked |
|---|---|---|
| Public engineering-package bytes | Delivery is closed under [ADR-0023](adr/0023-public-package-delivery-origin.md) (Accepted 2026-09-05; the [engineering-baseline origin record](../artifacts/public-demo/engineering-baseline-origin/README.md) carries gate 4), but the package at `https://packages.blacktanlabs.com/naru/engineering-baseline/v1/` is this Windows host's compile (`04472c9ad292…`, 854,447,023 bytes) rather than the macOS [qualification record](../artifacts/ifc/engineering-baseline/README.md)'s bytes (`6d23bffd6632…`, 854,446,743 bytes): four resources are byte-identical, `scene.gltf` differs at the same length, `scene.bin` by 280 bytes, the cross-host adapter drift the localized-trace records already document. A public package whose digest equals a committed qualification record needs either cross-host determinism or a qualification re-record on the publishing host | Public bytes that a committed record qualifies, not only verifies |
| CAD breadth corpus qualification | Implement ADR-0014's bounded Parquet scanner, inspect the pinned CadQuarry 1k STEP corpus, and measure extracted-part compile outcomes without equating rows to prototypes | STEP/OCCT diversity coverage; explicitly not the real public-baseline gate |
| Cross-host IFC drift | Diagnose or deliberately scope the recorded 8-byte macOS/Windows Scene IR difference ([record](../artifacts/spatial-demand/digital-hub-localized/README.md)) | Cross-host cache portability claim |
| Real Safari rendering | Run on a Safari/macOS combination that exposes WebGPU under supported default settings; the current Sequoia record proves only graceful unsupported behavior | Safari renderer-conformance claim |

Every performance record follows [the benchmark rules](BENCHMARKS.md): disclose
input provenance, cache state, hardware/software, exact command and commit,
individual samples, median/p95, and limitations. Large or license-restricted
inputs remain outside Git and enter through the external fixture manifest.

## Execution contract

- The roadmap carries phase scope and exit criteria.
- This tracker carries current work order, dependency state, and evidence debt.
- ADRs carry public-format, trust-boundary, dependency, and major-technology
  decisions.
- GitHub issues carry reviewed, independently assignable work with explicit
  acceptance and validation steps; speculative Phase 3/4 ideas stay in the
  roadmap until they are ready to schedule.
- Pull requests carry implementation and only the validation results actually
  run for that change.
- Committed artifacts carry measured facts and remain explicit about host,
  browser, cache, and fixture boundaries.

The ready issue queue should stay intentionally small even if the roadmap is
large. Opening an issue is a promise that the maintainer can explain its scope,
review a contribution, and recognize completion.
