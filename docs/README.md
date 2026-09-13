# NARU Design Documents

Read in this order:

1. [Product requirements](PRODUCT.md) — users, workflows, scope, requirements,
   success metrics, and risks.
2. [System architecture](ARCHITECTURE.md) — boundaries, data flow, runtime,
   precision, security, and compatibility.
3. [Import and cache contract](IMPORT_AND_CACHE.md) — cold import, progressive
   preview, warm reopen, invalidation, and shared-cache product SLOs.
4. [Engineering Scene IR](SCENE_IR.md) — neutral semantic/assembly/
   representation model.
5. [Compiler](COMPILER.md) — source adapters, tessellation, edges, chunking,
   encoding, and validation.
6. [WebGPU runtime](RUNTIME.md) — loading, Workers, GPU resources, rendering,
   picking, clipping, and lifecycle.
7. [Plugin architecture](PLUGINS.md) — capabilities, transactions, UI, analysis,
   and distribution.
8. [Benchmark plan](BENCHMARKS.md) — datasets, baselines, metrics, scenarios,
   and anti-benchmark rules.
9. [Validation tiers](VALIDATION.md) — pull-request, current, historical,
   scheduled, release, and hardware-bound recording responsibilities.
10. [Real-large results matrix](REAL_LARGE_RESULTS.md) — the committed cold/warm
   import, startup, frame, memory, and interaction figures for one real-large
   model, presented together.
11. [Roadmap](ROADMAP.md) — evidence-gated phases and exit criteria.
12. [Phase 0 evidence](PHASE_0.md) — completed exit record, reproduction, and
   known limits.
13. [Phase 1 evidence](PHASE_1.md) — completed vertical-slice evidence and
   known limits.
14. [Phase 1 completion report](PHASE_1_REPORT.md) — exit decision and
   consolidated reproducible performance summary.
15. [Phase 2 tracker](PHASE_2.md) — large-scene priorities, dependencies,
   exit-gate status, and the evidence debt carried into Phase 3.
16. [Phase 2 completion report](PHASE_2_REPORT.md) — exit decision and
   consolidated reproducible performance summary for the large-scene alpha.
17. [Architecture decisions](adr/README.md) — decisions and alternatives.
18. [Branching and releases](BRANCHING.md) — work branches, pull requests,
   merge rules, backports, tags, and enforcement gates.
19. [Translations](TRANSLATIONS.md) — README languages, terminology, and
   maintenance workflow.
20. [API reference](API_REFERENCE.md) — the TypeDoc-generated surface of the
    four workspace packages, published with the demo site at `naru/api/`.

## Documentation rules

- Architecture claims should link to a requirement, ADR, benchmark, or test.
- Accuracy-sensitive behavior must distinguish source-exact, tessellated,
  simplified, and derived results.
- A serialized schema change requires compatibility and migration discussion.
- Performance claims must follow `BENCHMARKS.md`.
- Proprietary models and screenshots are excluded unless redistribution rights
  are explicit.
