# Architecture Decision Records

ADRs document decisions that constrain multiple components or are expensive to
reverse. They explain context and trade-offs rather than only the final choice.

## Status values

- **Proposed:** open for design review or awaiting its evidence gate;
- **Accepted:** current project direction;
- **Superseded:** replaced by a newer ADR;
- **Rejected:** considered but not selected.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-product-wedge.md) | Begin with an engineering scene studio/runtime | Accepted |
| [0002](0002-source-and-cache.md) | Source documents remain authoritative | Accepted |
| [0003](0003-webgpu-hot-path.md) | Direct data-oriented WebGPU hot path | Proposed |
| [0004](0004-format-strategy.md) | Standards-first delivery; defer custom format | Accepted |
| [0005](0005-coordinate-precision.md) | Hierarchical local coordinates and camera-relative rendering | Accepted |
| [0006](0006-license.md) | Apache-2.0 for NARU-owned code | Accepted |
| [0007](0007-rebrand-naru.md) | Rebrand to NARU; freeze serialized `madi.*` identifiers | Accepted |
| [0008](0008-spatial-demand-partitioning.md) | Separate spatial demand from shared prototype payload ownership | Proposed |
| [0009](0009-persistent-compiled-cache.md) | Key persistent compiled caches by complete import identity | Accepted |
| [0010](0010-ifc-incremental-dependency-index.md) | Index IFC document dependencies before partial compilation | Proposed |
| [0011](0011-remote-package-limits.md) | Bound remote compiled packages before parsing or allocating | Accepted |
| [0012](0012-mutable-public-fixture-downloads.md) | Pin mutable public-share fixtures by content identity | Proposed |
| [0013](0013-optional-gltf-resource-name-elision.md) | Allow opt-in glTF resource-name elision | Proposed |
| [0014](0014-parquet-cad-corpus-boundary.md) | Treat Parquet CAD corpora as bounded source containers | Proposed |
| [0015](0015-optional-node-identity-and-transform-elision.md) | Allow opt-in node identity and transform elision | Proposed |
| [0016](0016-streamed-gltf-document.md) | Serialize the compiled glTF document as a stream | Accepted |
| [0017](0017-relocated-hierarchy-sidecar.md) | Move the assembly tree into a package sidecar | Accepted |
| [0018](0018-content-addressed-compiled-payloads.md) | Content-address compiled prototype payloads; rebuild the federation | Rejected |
| [0019](0019-document-artifact-transport.md) | Reuse verified per-document Scene IR artifacts across the transport; retire the payload tier | Proposed |
| [0020](0020-cancellable-import-jobs.md) | Report imports as a versioned lifecycle; cancellation stops the adapter tree | Proposed |
| [0021](0021-staged-hierarchy-first-import.md) | Publish an import assembly tree per document, before geometry | Accepted |
| [0022](0022-workspace-manifest.md) | Persist a non-authoritative workspace manifest keyed by source and package identity | Accepted |
| [0023](0023-public-package-delivery-origin.md) | Serve public demo packages from a Cloudflare R2 delivery origin | Accepted |
| [0024](0024-persistent-package-cache.md) | Keep verified package resources in a quota-bounded browser cache tier | Proposed |
| [0025](0025-shape-preserving-lod-representation.md) | Shape-preserving LOD as a declared-error representation | Proposed |

## Phase 0 review

The first evidence review was completed on 2026-08-23. ADRs 0001, 0002, 0004,
and 0006 are accepted because their decisions are implemented or directly
supported by the committed Phase 0 evidence. ADR-0003 remains proposed because
it still needs a comparable Three.js decision record. ADR-0005 was accepted on
2026-08-26 after the committed 0.25 mm / 10,000 km measurement and headed
Chrome/Firefox visual record passed. A feasibility prototype alone is not
treated as evidence of performance or precision advantage.

`pnpm adr:check` verifies that every ADR has a canonical status/date and that
this index matches the individual records.

## Template

```markdown
# ADR-NNNN: Title

Status: Proposed

## Context

## Decision

## Consequences

### Positive

### Negative

## Alternatives considered

## Validation
```
