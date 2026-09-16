# ADR-0010: Index IFC document dependencies before partial compilation

Status: Accepted
Accepted: 2026-09-16

## Context

An unchanged federation can already restore one verified compiled package, but
changing one IFC discipline invalidates the complete cache key. Partial rebuild
is unsafe without a deterministic account of which semantic entities,
prototypes, occurrences, and progressive target chunks came from each source
document. Cross-document semantic relations can also make a nominally local
change affect another discipline.

The current target, coarse, spatial, and property resources are federation-wide
files. A logical dependency record alone does not make their byte ranges
independently reusable: target packing and priority can move ranges, while the
coarse, spatial, and property resources do not yet expose stable per-document
content chunks.

## Decision

- Emit `incremental-dependencies.json` for every IFC federation compile using
  schema `naru.ifc-incremental-dependency-index.1`.
- Map each discipline/source digest to its Scene IR document, semantic,
  prototype, occurrence, target-chunk, coarse-prototype, spatial-occurrence,
  and property-semantic selectors without duplicating those ID arrays. Map
  every prototype back to all contributing documents and its current target
  chunk when one exists.
- Derive provenance only from Scene IR document IDs, source references,
  semantic ownership, representation source maps, and occurrence references.
  A prototype without document provenance is an error, not a global fallback.
- Treat cross-document semantic relations as an undirected reconciliation
  dependency and record the complete transitive component for invalidation.
- Detect source changes, deletion, stable-content rename/relabel, and addition
  deterministically. Ambiguous equal-digest rename candidates remain
  delete/add operations rather than guessed renames.
- Keep the index as derived cache metadata covered by the persistent cache
  manifest. Do not change the frozen Phase 1 compiler-report or glTF profile
  schemas for this additive Phase 2 contract.
- Do not claim partial compilation or byte reuse from this index alone. Reuse
  requires per-document adapter outputs, content-addressed prototype/chunk
  payloads, and reconstruction tests proving byte-identical full packages.
- Store the first per-document adapter output as deterministic canonical JSON
  inside deterministic gzip, keyed by discipline, source digest, URI hint,
  thread count, and the exact adapter/toolchain fingerprint. Verify the key and
  payload digest before loading, publish atomically, and never deserialize an
  executable format such as pickle.

## Consequences

### Positive

- The next compiler slice can select an explicit conservative invalidation set
  instead of inferring ownership from names or buffer offsets.
- Non-geometric hierarchy prototypes and cross-document relationships remain in
  the rebuild plan, not only renderable meshes.
- Whole-package cache hits restore the exact same dependency record without
  running IfcOpenShell.

### Negative

- The index duplicates sorted IDs already present in Scene IR and adds one
  derived JSON resource to IFC outputs and cache entries.
- Current changed-discipline imports still rebuild the federation-level
  property/geometry package, but unchanged documents can skip IfcOpenShell
  parsing and tessellation through their verified extraction artifacts.
- Logical target-chunk IDs are revision-local while federation-wide packing
  remains in use, so they cannot yet authorize physical range reuse.
- Canonical JSON/gzip is safe and dependency-free but may still be expensive to
  parse at real-large scale. A binary or columnar document artifact requires
  measured size, restore-time, and peak-memory evidence before replacing it.

## Alternatives considered

- Infer discipline ownership from prototype ID strings or source filenames.
- Reuse every apparently unchanged byte range without tracking global packing.
- Make any changed discipline invalidate every document indefinitely.
- Put the dependency tables into the frozen Phase 1 build-report schema.

## Validation

Focused compiler tests construct and restore the sidecar through the IFC cache,
check document/prototype/target/property coverage, and prove deterministic
changed, deleted, renamed/relabelled, and cross-document reconciliation
invalidation. The adapter artifact tests reject corruption and identity changes,
preserve shared geometry aliases, and prove cold, warm, and one-document-changed
federation structure/geometry/property bytes equal the corresponding clean
adapter build. Acceptance still requires a partial compiler rebuild that is measurably
cheaper than a clean one while reproducing the complete clean package byte for
byte. The byte-for-byte half is recorded: a changed-discipline rebuild of
Digital Hub and sixty5 through the content-addressed payload store reproduced
every clean package resource ([artifacts/cache/payload-reuse](../../artifacts/cache/payload-reuse/README.md)).
The cheaper half was not met by that store: it restored payloads slower than
the compiler re-encodes them, so
[ADR-0018](0018-content-addressed-compiled-payloads.md) is Rejected by its own
gate. The successor, [ADR-0019](0019-document-artifact-transport.md), makes the
per-document Scene IR artifact -- the unit this index already owns -- the
thing restored, and its gate 4 record
([artifacts/cache/rebuild-stages](../../artifacts/cache/rebuild-stages/README.md))
measures a changed-discipline rebuild against a same-session clean rebuild on
Digital Hub and sixty5. The cheaper half is recorded there after every ADR-0019
slice, with the final slice (in-compiler federation assembly, 2026-09-16)
reproducing the clean package byte for byte while the compiler assembles the
federation from the restored artifacts; that record is what moved this ADR to
Accepted together with ADR-0019.
