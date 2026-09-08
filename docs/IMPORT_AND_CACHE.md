# Import and compiled-cache product contract

Status: Phase 2 contract; cache-store plus STEP/IFC whole-package integration
implemented, and the persistent-cache acceptance gate is closed by recorded
real-toolchain evidence ([record](../artifacts/cache/README.md),
[ADR-0009](adr/0009-persistent-compiled-cache.md), Accepted).

## 1. User promise

Opening engineering source and reopening derived content are different product
paths. NARU may spend minutes translating a real-large source for the first
time, but it must not repeat that work when the authoritative inputs and all
compile-affecting identities are unchanged.

| Scenario | Product target | Required behavior |
|---|---:|---|
| First real-large import | minutes allowed | visible progress, cancellation, background execution, and a durable result |
| First import, hierarchy and coarse preview | 5–15 seconds | hierarchy/search before full geometry; recognizable coarse frame while import continues |
| Reopen with unchanged inputs | 1–5 seconds | validate source/cache identity and open the compiled cache without running the source adapter |
| One IFC discipline changed | proportional to the change | re-inspect every source identity, then rebuild only affected document/prototype/chunk dependencies |
| Team reuse | no duplicate local import when policy permits | resolve a verified shared content-addressed entry, then retain a local copy |

These are product SLOs, not claims about current evidence. Cold and warm results
must be reported separately under [the benchmark rules](BENCHMARKS.md). The
current-toolchain real-large boundary is five fresh-process sixty5 imports
per cache state on one disclosed Windows host: cold median 381.4 s, warm
median 1.36 s, corrupt-entry fallback median 89.0 s
([evidence](../artifacts/cache/sixty5/README.md)). The older 302-second
end-to-end sixty5 split.1 diagnostic on a warm OS file cache
([evidence](../artifacts/ifc/sixty5/README.md)) is not that distribution and
is superseded by it. Shared coarse residency, a
virtualized assembly list, skip-and-continue admission, estimate-gated
prefetch, and a shared prototype vertex pool later record a 4.487-second first
frame ([evidence](../artifacts/ifc/sixty5-first-frame/README.md)). The recorded cache
evidence proves compile-level warm reopens on the pinned mid-size fixtures
(0.5 s for the Digital Hub federation, 1.7 s for the PyGamer STEP fixture —
[record](../artifacts/cache/README.md)), and the sixty5 distribution meets the
1–5 s reopen SLO at real-large scale on the harder whole-process reading:
1,429 ms including `node` startup, 281× faster than the cold import that
published the entry.

## 2. User-visible lifecycle

```text
Open STEP/IFC
  -> inspect source envelopes and digests
  -> resolve local/shared cache key
     -> hit: verify manifest/resources -> open hierarchy/coarse package
     -> miss: start cancellable adapter job
              -> publish hierarchy/coarse progress
              -> compile immutable package
              -> verify and atomically publish cache entry
              -> open published entry
```

The Studio owns progress, cancellation, retry, and notifications. Adapters run
outside the browser trust boundary. Cancellation must stop child processes and
remove unpublished temporary output; it must never remove a previously
validated cache entry.

The compiler side of that promise is implemented and versioned. Both compilers
accept an import job and report a `naru.import-job-event.2` stream through it:
nine states in one legal order (`queued`, `inspecting`, `extracting`,
`compiling`, `verifying`, `publishing`, then one of `completed`,
`cancelled`, `failed`), each event carrying a gapless sequence, monotonic
elapsed milliseconds, and a step-counted progress pair whose total is six on a
rebuild and three on a cache restore. Progress counts lifecycle steps, never an
estimate derived from source size, because nothing measures how long
tessellating an unseen document takes. Every event field is scrubbed of
filesystem paths before it leaves the module, so an import event may cross a
trust boundary the source document never should. `naru compile` and
`naru compile-ifc` expose the stream with `--json-events` as newline-delimited
JSON on stdout, with human lines moved to stderr.

Cancellation reaches the process tree. An aborted job terminates the adapter and
every process it started, removes the temporary Scene IR directory it was
extracting into, and leaves a configured cache directory untouched. The one
uninterruptible section is publication: the package writer is not atomic, so a
cancel observed midway would leave a directory that looks like a package and is
not one. That section runs to the end and the cancellation event reports
`publishedBeforeCancellation`. Contract and gates:
[ADR-0020](adr/0020-cancellable-import-jobs.md), still Proposed.

What that lifecycle does not yet do is show anything while it runs. The shape of
the missing half is now measured rather than assumed: producing an assembly tree
from an IFC document is parsing it, at 98.46 percent (Digital Hub) and 98.60
percent (sixty5) of the time to a serialized tree, with the containment walk at
1.3 percent and serialization at 0.1
([record](../artifacts/import/structure-readiness/README.md), five fresh-process
samples per model). So the whole sixty5 federation needs 40,474.9 ms of adapter
time before its complete tree exists, and threads cannot rescue it — the
estimated six-thread makespan, 15,030.3 ms, is exactly the time of the single
largest document. One document's tree, by contrast, is ready in 278.5 ms.

[ADR-0021](adr/0021-staged-hierarchy-first-import.md) (Accepted) therefore makes
the unit of early publication one document rather than the federation: the
adapter emits a document's structure before tessellating anything, smallest
source first, and each tree is published as a `naru.package-hierarchy.1` pair
(ADR-0017's sidecar, reused rather than reinvented) written atomically and
verified by digest before use. A staged preview is never a compiled package and
never a cache tier — a cancelled import removes it, a completed one supersedes
it — and the final package must stay byte-identical to a compile that never
staged anything.

The adapter half of that design ships behind `--structure-preview <directory>`,
and a second record measures it doing the work rather than modelling it
([record](../artifacts/import/structure-first-emission/README.md), the same
five-sample protocol plus a `plain` arm without staging). A watcher outside the
process verified sixty5's first tree on disk 0.690 s after spawn and Digital
Hub's at 0.753 s, both inside the target; every document in every staged sample
published its tree before its own extraction finished; and every per-document
node count equals the occurrence count the same run's Scene IR carries. Both
arms produce byte-identical adapter output, 36 comparisons per model with no
excluded field — the adapter-level half of ADR-0021's determinism gate. Its
package-level half is now unit-proved: `--staged-preview <directory>` on
`naru compile-ifc` makes the compiler watch that emission, verify each tree by
length and digest before parsing it, re-encode it as the
`naru.package-hierarchy.1` sidecar pair, publish the pair atomically under a
`staged.json` manifest, and report it as a `staged` event on the job stream;
a compile with the directory and one without produce the same package digest,
the same resources, and byte-identical `scene.gltf`/`scene.bin`, a cache hit
never stages, a tampered or misidentified tree is refused with
`INVALID_STAGED_PREVIEW`, and a cancel after staging removes the directory
with the split while a pre-existing cache entry survives
([tests](../packages/compiler/test/ifc-federation.test.ts),
[cancellation](../packages/compiler/test/import-job-cancellation.test.ts)). Staging is not free at real-large scale: the
sixty5 run costs 22.4 s (+7.75%) and 1.17 GB of peak working set (+24.8%), which
the record attributes to the emission reorder — the largest document is
inspected last, with the rest of the federation already accumulated — rather
than to building trees, since writing every sixty5 tree takes 201.9 ms and
staging one document alone costs nothing measurable. Digital Hub is unaffected.
The Studio reads a staged directory while the compile continues: opened with
`?staged=<manifest>` beside `?scene=`, it polls `staged.json`, verifies and
shows each tree as it lands, and hands off to the unchanged package loader
once the manifest carries the finished package
([Studio guide](../apps/webgpu-spike/README.md#follow-a-staged-import)). The
[browser record](../artifacts/import/staged-import-browser/README.md)
measures that end to end against a cold sixty5 import: first tree 1.5 s
after spawn, package handoff 417.8 s, coarse frame 422.8 s. The
Studio follows an externally launched CLI import; native job start, cancel, and
retry through a host remain open. Coarse geometry during import is not
claimed: nothing tessellates before the package exists, so ADR-0021 is amended
to hierarchy-first.

## 3. Cache identity and invalidation

A hit is valid only when the deterministic key includes every input capable of
changing output:

- ordered source roles and SHA-256 digests, never local absolute paths;
- adapter name and exact version/toolchain fingerprint;
- compiler name and cache-compatible version;
- compile-affecting options such as tessellation, edge, coordinate, chunking,
  property, and LOD policies;
- every serialized-output option, so two JSON policies over one Scene IR cannot
  alias a single entry: compact JSON, omitted resource names (ADR-0013), and
  the node identity/transform elision pair (ADR-0015); and
- cache schema major version.

Stable source labels such as IFC URI hints and the current STEP basename are
inputs because the current glTF profile serializes them. Absolute machine path,
output directory, and UI state are not inputs. Thread count may be excluded only
after determinism evidence proves it cannot change output. Unknown or incomplete
identities are cache misses.

`packages/compiler/src/compiled-cache.ts` implements the first storage slice:
`naru.compiled-cache-entry.1` keys normalized inputs, records every package
resource byte count and SHA-256, verifies the complete entry before restore,
and publishes/restores through same-parent temporary directories and atomic
rename. Its tests prove key determinism, idempotent publish, successful restore,
and storage-layer rejection of corrupted entries; the STEP and IFC compile
orchestrations report a damaged or unreadable entry and fall back to a full
recompile, so a broken cache degrades to a miss instead of blocking compilation.
The STEP and IFC CLIs can opt in with
`--cache`. Each adapter exposes a cheap `--identity`: OCCT fingerprints its
implementation and pinned CadQuery/OCP toolchain, while IFC fingerprints its
extraction modules and pinned IfcOpenShell/numpy toolchain; both include Python,
OS, and architecture. The compiler identity is a content hash over the
compiler's own module files and also includes Node/OS/architecture
until cross-platform determinism is proven. An unchanged second compile reuses
verified existing output or atomically restores it without running extraction.
Focused tests prove this orchestration for STEP and a single-document IFC
federation, and the recorded cold/warm/corruption runs with the pinned native
toolchains close that gate ([record](../artifacts/cache/README.md)).

## 4. Storage and security

- Cache entries are immutable and addressed by their 64-character lowercase
  SHA-256 key.
- A manifest is trusted only after schema, key reproduction, path policy, byte
  count, and resource digest verification.
- Resource paths are portable single-file names in version 1. Absolute paths,
  traversal, symlinks, and implicit external dependencies are rejected.
- A reader never observes partially published output. Corrupt or incompatible
  entries fail closed and are eligible for quarantine/rebuild by the host.
- Source documents remain authoritative under [ADR-0002](adr/0002-source-and-cache.md).
  Deleting the cache must lose no authored engineering information.
- A shared cache must enforce repository/tenant authorization independently of
  content identity. Knowing a digest does not grant access to source-derived
  geometry or properties.
- The browser-side persistent tier ([ADR-0024](adr/0024-persistent-package-cache.md))
  follows the same rule from the other side: it is partitioned by the
  application's origin, keyed by declared SHA-256 and byte length, re-verifies
  every hit before decode, refuses bytes that miss their declared identity,
  and degrades any storage failure to a miss so it can never block a scene.

## 5. Incremental and shared-cache stages

The first key represents a complete compiled package. Incremental IFC rebuilds
require a second dependency index before they are safe:

1. source discipline digest -> semantic/prototype identities;
2. prototype identity -> target/coarse/spatial/property chunks;
3. compiler policy -> dependency version;
4. federation reconciliation -> cross-document invalidation set.

The index must have determinism and deletion/rename tests before it can drive
reuse. A changed discipline misses the whole-package cache; verified
per-document artifacts can already avoid extracting unchanged documents, while
federation-wide package reconstruction still runs.

The first index contract is now implemented as
`incremental-dependencies.json` (`naru.ifc-incremental-dependency-index.1`,
[ADR-0010](adr/0010-ifc-incremental-dependency-index.md)). It maps each
discipline to semantic, prototype, occurrence, current target-chunk,
coarse-prototype, spatial-occurrence, and property-semantic selectors, and
expands cross-document semantic relations to a transitive reconciliation set.
Focused tests cover changed, deleted, and renamed/relabelled inputs plus
reconciliation invalidation, and unchanged whole-package cache hits restore the
index byte-for-byte. The adapter now also keeps verified per-document extraction
artifacts under the selected cache (`naru.ifc-document-artifact.2`, verified by
header checks and one SHA-256 over the stored payload bytes before any parse;
[ADR-0019](adr/0019-document-artifact-transport.md) slice 1): unchanged
disciplines skip IfcOpenShell parsing and tessellation, while changed,
renamed, or corrupt identities miss.
An actual two-discipline fixture proves cold/warm and one-document-changed merge
bytes equal a clean adapter build. Federation-wide target/coarse/spatial/property
payloads are still laid out as a whole; the rejected payload tier reused encoded
prototype bytes, not byte ranges, and complete-package equivalence remains the
bar before any old range is reused.

The payload contract was **implemented, measured, rejected as the reuse unit,
and removed** (see the end of this section).
[ADR-0018](adr/0018-content-addressed-compiled-payloads.md) content-addressed
one unit only, the prototype payload -- the accessor bytes and placement-free
accessor metadata `appendGeometry` produces -- and rebuilt every other package
resource from the current scene on every compile. Byte offsets, bufferView and
accessor indices, target-chunk membership, coarse aggregation, spatial leaves,
interned property columns, and the relocated hierarchy are all
federation-global, so `scene.bin` is re-laid out from restored payload bytes in
the current prototype order rather than copied. Reuse is decided by content,
not by the invalidation plan: the dependency index chooses which documents to
re-extract, and a wrong plan can only cost extra extraction work, never yield a
wrong payload. That ADR also fixed the acceptance evidence, including a
measured packaging saving that had to exceed the store's own verification cost
or the decision is rejected -- and it did not
([record](../artifacts/cache/payload-reuse/README.md)): changed-discipline
rebuilds of Digital Hub and sixty5 reproduced every clean package byte, with
2,664 of 3,383 and 40,066 of 42,435 payloads restored, but packaging took
2.2-2.4x as long as re-encoding from the parsed scene. Once the adapter's
document-artifact cache has removed tessellation from the rebuild path,
encoding a payload is a typed-array copy while restoring one reads and hashes
every byte. ADR-0018 is Rejected. Its successor,
[ADR-0019](adr/0019-document-artifact-transport.md), sizes the levers from the
committed [rebuild stage record](../artifacts/cache/rebuild-stages/README.md)
-- the encoder is 2.3 percent of a Digital Hub rebuild and 2.5 percent of a
sixty5 one, the adapter-compiler transport of unchanged documents 48.0 and
77.3 percent -- and
decides to reuse the verified per-document Scene IR artifact instead and to
remove `--payload-cache`. That removal landed on 2026-09-03; what follows is
what the compiler kept and what the retired tier was.

What the compiler kept is the encoder split. `buildCompiledPayload` is the
only geometry encoder, and `appendGeometry` is that build followed by
`appendCompiledPayload`, so every payload reaches `scene.bin` through one
append path and one place decides offsets and padding; Digital Hub still
compiles to the `digital-hub` baseline digest recorded in
[artifacts/compiler/node-field-elision](../artifacts/compiler/node-field-elision/README.md),
so the split moved no bytes. `compiledPayloadContentDigest` stays as a tested
pure function, and the guards the store shared with the whole-package cache
(refused key and path shapes, `lstat` symlink refusal, staged publication with
an idempotent rename) stay in `cache-primitives.ts`, now serving that cache
alone.

What was removed, so the description does not outlive the code: the
`naru.compiled-payload-entry.1` store and its verified restore, the
per-prototype selection inside the packaging loop, `--payload-cache
<directory>` on both commands, the `build-report.json:compiledPayloadCache`
telemetry block, their unit tests, and the recorder behind the acceptance
record. The record itself stays committed and validated
(`pnpm cache:payload:check`); it cannot be re-recorded.

That acceptance record exists and rejected the tier; the successor is
[ADR-0019](adr/0019-document-artifact-transport.md), landed in slices. Its
gate 0 stage decomposition put artifact verification at 4,434.2 ms on Digital
Hub and 34,204.2 ms on sixty5 (29 and 44 percent of the adapter's main) under
the `.1` artifact format, which re-serialized the parsed object to verify it.
Slice 1 (`naru.ifc-document-artifact.2`, verification of the stored bytes
before any parse) is recorded in the
[rebuild record](../artifacts/cache/rebuild-stages/README.md): verification
34.1 ms on Digital Hub and 353.0 ms on sixty5, byte-identical
packages against a same-session clean rebuild (no cache directory), exact
per-document restore decisions, and a whole-process rebuild of 11,102.2 ms
against 50,028.4 ms clean on Digital Hub and 72,993.4 against
320,064.2 ms on sixty5 with lower peak memory. Slices 2 (column-form
structure) and 3 (in-compiler federation assembly) follow under the same
gate 4; ADR-0010 stays Proposed until the record that closes slice 3.

Shared lookup reuses the same manifest and resource hashes. The resolution
order is local verified entry, authorized shared entry, then local compilation.
Uploads occur only after local verification and explicit host policy; NARU does
not upload proprietary sources as part of cache publication.

## 6. Delivery-format boundary

The cache is not a replacement CAD/BIM interchange format. Standard glTF
delivery remains available, and a cache may contain the existing `scene.gltf`,
geometry, coarse, spatial, and property resources unchanged. General object
encodings such as BSON are not the target: repeated numeric tables should move
to measured columnar binary resources only when they beat the standards-based
profile under [ADR-0004](adr/0004-format-strategy.md).

## 7. Implementation order and acceptance gates

1. **Persistent source-digest cache:** storage foundation, OCCT/IFC identities,
   and STEP/IFC whole-package integration implemented; pinned real-fixture
   cold/warm and corruption evidence recorded
   ([record](../artifacts/cache/README.md)).
2. **Columnar hierarchy sidecar:** opt-in relocation has offline and paired
   browser evidence under accepted [ADR-0017](adr/0017-relocated-hierarchy-sidecar.md);
   changing the default still requires coordinated schema-profile and evidence updates.
3. **Incremental IFC compilation:** discipline dependency index plus changed,
   deleted, renamed, and reconciliation tests implemented; verified independent
   adapter document reuse and clean adapter-merge equivalence implemented;
   complete-package equivalence under a changed discipline is recorded for the
   content-addressed payload tier, which was then rejected on cost. ADR-0019
   slice 1 now records a cheaper changed-discipline rebuild with lower peak
   memory against a same-session clean arm; slices 2–3 remain.
4. **Standards export:** retain glTF; evaluate GLB, GPU instancing, and mesh
   compression without making the cache an interchange claim.
5. **Cancellable, observable import jobs:** versioned lifecycle events and a
   cancel that stops the adapter tree implemented and unit-proved
   ([ADR-0020](adr/0020-cancellable-import-jobs.md)); a second consumer and a
   real-large cancellation record remain.
6. **Staged hierarchy-first preview:** structure-first adapter emission
   implemented behind `--structure-preview` and recorded
   ([ADR-0021](adr/0021-staged-hierarchy-first-import.md),
   [readiness](../artifacts/import/structure-readiness/README.md),
   [first emission](../artifacts/import/structure-first-emission/README.md)),
   and the compiler's verified atomic staged publication behind
   `--staged-preview` unit-proved for determinism and cancellation, and the
   Studio background import
   [recorded](../artifacts/import/staged-import-browser/README.md) end to end
   against a cold sixty5 import (ADR-0021 accepted, hierarchy-first); host job
   control and coarse preview during extraction remain open.
7. **Shared cache:** authenticated lookup/publication, tenant isolation,
   provenance, quotas, eviction, and observability.

Focused tests already prove an unchanged STEP and single-document IFC input
skip extraction, preserve the package digest, invalidate changed compile
identity, and reject corrupted entries at the storage layer while the
orchestration falls back to recompilation. The persistent-cache gate is closed:
the pinned PyGamer STEP fixture and the four-document Digital Hub federation
reproduce those properties with published cold/warm timings and a fail-closed
corrupted-entry recompile ([record](../artifacts/cache/README.md), validated by
`pnpm cache:check`). The real-large product gate is closed on one host class
by five fresh-process samples per cache state, with cache footprint and
process-tree peak memory ([record](../artifacts/cache/sixty5/README.md),
validated by `pnpm cache:sixty5:check`). That record also measures the largest
document the compiler produces: explicit IFC boundary edges push the sixty5
glTF document past the runtime's maximum string length, and because the
compiler writes it as a stream rather than building it as one string
(accepted [ADR-0016](adr/0016-streamed-gltf-document.md)) that federation now
imports under the default formatting, at 545,470,166 B against a
536,870,888-byte limit. `--compact-json` remains an option that removes
insignificant whitespace, not a requirement for importing a large model.
