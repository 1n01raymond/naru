# Import evidence

Records about what an import costs before it finishes: how early a usable
result exists, and what has to be paid for it. Whole-import timings and cache
behaviour live under [`../cache/`](../cache/README.md); this family is about
the shape of the work inside one cold import.

| Record | What it proves |
|---|---|
| [`structure-readiness/`](structure-readiness/README.md) | How early an IFC federation's assembly tree could be published: structure-only reads of every document, with the parse separated from the containment walk, on Digital Hub and sixty5. |
| [`structure-first-emission/`](structure-first-emission/README.md) | That the adapter actually publishes one document's assembly tree before it tessellates that document, watched from outside the process, and what staging costs the run that produces it. |
| [`staged-import-browser/`](staged-import-browser/README.md) | That a headed Studio opened before a cold sixty5 `compile-ifc --staged-preview` spawned can search and select the first staged tree 1.5 s after spawn, keeps following each document's tree, and hands off to the compiled package's own first coarse frame (ADR-0021 gate 4; gate 5 amended to hierarchy-first). |

The design these records inform is
[ADR-0021](../../docs/adr/0021-staged-hierarchy-first-import.md); the import
lifecycle they are measured against is
[ADR-0020](../../docs/adr/0020-cancellable-import-jobs.md).
