# NARU compiler

`@naru3d/compiler` is the first Phase 1 source-to-Web compiler slice. Its public
CLI accepts local STEP AP242/AP214 through the OCCT Python adapter and
multi-document IFC2X3/IFC4/IFC4X3 federations through IfcOpenShell; its library
boundary accepts a validated in-memory `EngineeringScene`. These paths emit:

- `scene.gltf`: glTF 2.0 hierarchy, nodes, shared meshes, materials, and NARU
  source/identity metadata in `extras`;
- `scene.bin`: little-endian f32/u32/u8 geometry and mapping accessors; and
- `coarse.bin`: optional prototype AABB surfaces and edges for an early useful
  frame; and
- `incremental-dependencies.json`: IFC-only discipline-to-semantic/prototype/
  chunk invalidation metadata; and
- `build-report.json`: source/compiler identity, options, hashes, counts,
  diagnostics, reuse, and known limits.

The geometry contract follows the
[Khronos glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html):
triangle primitives use mode 4, explicit CAD edge line lists use mode 1, and
multiple occurrence nodes may reference one mesh. The profile does not require
a custom glTF extension. NARU-specific data uses standard `extras` while the
interoperability requirements are measured.

## Reproduce the committed slice

From the repository root:

```sh
python -m pip install -r native/adapter-occt/tools/requirements-evidence.txt
pnpm naru compile fixtures/step/repeated-fasteners-ap242.step \
  --output output/repeated-fasteners-ap242
pnpm phase1:compile:evidence
pnpm phase1:evidence:check
pnpm test
```

The `naru compile` command reads the checksum-locked AP242 assembly through
OCCT STEPCAF/XDE, validates source identity across the adapter boundary, and
writes `scene.gltf`, `scene.bin`, `coarse.bin`, `build-report.json`, and
`adapter-report.json`. Target geometry remains the ordinary glTF node mesh;
`extras.madi.coarseMesh` selects a bounds mesh backed only by `coarse.bin`.
`extras.madi.progressive.targetChunks` maps reusable target prototype meshes to
deterministic byte ranges in `scene.bin`, ordered by occurrence count and then
payload size. The IFC command coalesces adjacent prototype ranges into 512 KiB
requests by default; an oversized individual prototype stays whole rather than
splitting its accessors. Use `--target-chunk-kib` to change that budget. This
allows ordinary HTTP Range delivery without inventing another container or
duplicating target geometry.

The compiler API can set `coarseBounds: true` and `spatialIndex: true`, or both
CLI compile commands can pass `--spatial-index`, to emit `spatial.bin` using
`naru.spatial-demand-index.1`. Its deterministic flat BVH stores float64 world
bounds for every renderable occurrence and maps each leaf to sorted,
deduplicated indexes in `targetChunks`; it does not duplicate or reorder target
geometry by default. `--spatial-leaf-capacity` overrides the default of 64.
For IFC experiments, `--spatial-payload-order` opts into
`spatial-leaf-anchor-v1`: prototypes are ordered by the deterministic BVH leaf
where they occur most often before the existing byte-budget coalescer runs.
This changes target byte ranges without duplicating geometry; historical output
remains byte-identical when the flag is absent. Digital Hub and sixty5 offline
packing records now pass, while localized headed traces remain pending, so
ADR-0008 remains Proposed. Current explicit-edge sixty5 packages also pass
`--compact-json`: it removes insignificant `scene.gltf` whitespace and records
`jsonFormatting: "compact"` in the build report without changing the parsed glTF
document. Pretty output remains the default at every size -- the document is
written as a stream, so it is not bounded by the runtime's maximum string length
-- and historical digests remain unchanged.
Its expanded Scene IR is temporary and is deleted after the package passes
validation. `phase1:compile:evidence` retains the historical small Scene IR
regression path without coarse output. The evidence check validates both plus the
canonical PyGamer package: source and resource hashes, buffer/accessor ranges,
hierarchy, prototype reuse, triangle/edge counts, and official Khronos glTF
validation.

### Persistent compiled-cache foundation

`src/compiled-cache.ts` starts the first priority in the
[import/cache product contract](../../docs/IMPORT_AND_CACHE.md). It derives a
deterministic key from source digests, adapter/compiler identities, and sorted
compile options; publishes immutable flat package resources atomically; and
verifies every byte count and SHA-256 before an atomic restore. Cache corruption
fails before the requested output directory is created; the STEP and IFC
compilers treat a failed restore or publish as a warning and fall back to a
full recompile.

Both source paths opt in with `--cache <directory>`. Before lookup, each
adapter's cheap `--identity` reports a fingerprint over its implementation,
pinned native dependencies, Python, OS, and architecture; compiler identity is
a content hash over the compiler's own module files and includes Node and host
class until cross-platform determinism is proven. A verified hit reuses
matching output or restores the package without
running source extraction; a miss compiles normally and publishes only after
package validation. Output-affecting compile options — tessellation tolerances
and the spatial-index family — are part of both keys. IFC cache identity also
includes every discipline digest,
stable URI hint, adapter thread count, chunk budget, JSON formatting, and
retained-intermediate policy. Recorded real-fixture cold/warm and
corrupted-entry evidence on the pinned PyGamer STEP fixture and the
four-document Digital Hub federation closes the ADR-0009 acceptance gate
([record](../../artifacts/cache/README.md), `pnpm cache:check`). At real-large
scale, five fresh-process samples per cache state on the 839.9 MB sixty5
federation median 381.4 s cold, 1.36 s warm, and 89.0 s for a corrupt-entry
fallback, all fifteen producing the same package byte for byte
([record](../../artifacts/cache/sixty5/README.md), `pnpm cache:sixty5:check`);
that record also compiles the same federation once under the default
pretty-printed formatting, producing a 545,470,166 B document against the
runtime's 536,870,888-byte maximum string length, which is possible only because
`scene.gltf` is written as a stream. IFC compilation
also emits `naru.ifc-incremental-dependency-index.1`, and whole-package cache
hits restore it byte-for-byte. That index and its changed/deleted/renamed plus
reconciliation tests are the correctness prerequisite for partial rebuild. On
a whole-package miss, the IFC adapter now reuses verified unchanged document
extractions from `<cache>/ifc-documents`, so only missed disciplines run
IfcOpenShell parsing and tessellation before the deterministic federation merge.
The package resources still compile as one federation, and shared-cache
authorization remains a separate gate.

The content-addressed payload tier of
[ADR-0018](../../docs/adr/0018-content-addressed-compiled-payloads.md) was
implemented behind `--payload-cache <directory>`, rejected by its own gate --
the [acceptance record](../../artifacts/cache/payload-reuse/README.md)
reproduced every clean-package byte on a changed-discipline rebuild of Digital
Hub and sixty5 but restored payloads 2.2-2.4x slower than re-encoding them --
and removed under
[ADR-0019](../../docs/adr/0019-document-artifact-transport.md) on 2026-09-03:
the flag, `compiled-payload-store.ts`, `compiled-payload-cache.ts`, the
`compiledPayloadCache` build-report block, their tests, and the record's
recorder are gone. The record stays committed and validated.

`compileIfcFederation(..., { stageTiming: true })` returns a
`naru.ifc-federation-stage-timing.1` ledger beside the result -- the thirteen
compiler stages from source inspection to cache publication, the compile
sub-stages (`validateScene`, `encodeGeometry`, `measureDocument`), the
structure stream read, and the adapter process parts with the adapter's own
`--stage-timing` ledger. `compileSceneToGltf` takes the stage observer as a
third argument, outside `CompileGltfOptions`, so no timing reaches a package
byte, a build report, or a cache key
([test](test/ifc-federation.test.ts)). The
[rebuild-stages record](../../artifacts/cache/rebuild-stages/README.md) is
its consumer.

Encoding and placement are separate, and that split is what the payload tier
left behind: `buildCompiledPayload` produces one prototype's accessor bytes and
placement-free metadata, `appendCompiledPayload` places them into `scene.bin`,
and `appendGeometry` is exactly those two calls, so offsets and padding are
decided in one place. Compiling Digital Hub after that split reproduces the
baseline package digest recorded in
[artifacts/compiler/node-field-elision](../../artifacts/compiler/node-field-elision/README.md).
`compiledPayloadContentDigest` -- array bytes hashed with their element type,
plus whether the edge positions alias the surface ones -- stays as a tested
pure function, and `src/cache-primitives.ts` keeps the guards the store shared
with the whole-package cache: refused key and path shapes, an `lstat` symlink
check, and staged `mkdtemp` publication with an idempotent rename.

## Compile an IFC federation

Install the separate pinned adapter environment, then repeat `--document` for
each discipline. `--uri-hint` records a stable non-sensitive source label
instead of a local machine path.

```sh
python -m venv output/venv-ifc
output/venv-ifc/Scripts/python -m pip install \
  -r native/adapter-ifc/tools/requirements-evidence.txt

pnpm naru compile-ifc \
  --document architecture=path/to/architecture.ifc \
  --uri-hint architecture=models/architecture.ifc \
  --document plumbing=path/to/plumbing.ifc \
  --uri-hint plumbing=models/plumbing.ifc \
  --python output/venv-ifc/Scripts/python \
  --threads 4 \
  --target-chunk-kib 512 \
  --spatial-index \
  --spatial-payload-order \
  --omit-resource-names \
  --cache output/naru-compiled-cache \
  --output output/ifc/federation
```

The command preflights every Part 21 envelope, verifies adapter/source digests,
validates the intermediate Scene IR, emits the compiled package and adapter
report, and deletes Scene IR unless `--retain-scene-ir` is requested. When a
cache is selected, retained intermediates are included only when that option is
part of the key. The qualified four-discipline result is under
`artifacts/ifc/digital-hub/`.

For very large federations, `--omit-resource-names` removes only the optional
glTF `name` fields on meshes, buffer views, and accessors. Scene, node, and
material names remain available, as do all `extras` identity and source-mapping
records. The option is part of the compiled-cache key; without it, output stays
byte-identical to the named default package.

`--elide-derived-identifiers` and `--omit-default-node-transforms` reduce the
node array the same way: the first declares one derivation rule in the document
and omits every `extras.madi.semanticId`/`sourceRef` that rule reconstructs, the
second omits an identity `matrix` and writes `translation` where the transform is
a pure translation. The runtime rebuilds both from the document it already
parsed, so picking, the assembly tree, and property lookup are unaffected. Both
options are part of the compiled-cache key and both leave default output
byte-identical. See the [document byte-split
record](../../artifacts/compiler/node-field-elision/README.md) for what they
recover on a real federation, and ADR-0015 for the contract.

That record also measured the larger lever those two options leave alone: the
mesh-less hierarchy nodes are 21.88% of the engineering-baseline document.
`--relocate-hierarchy-nodes` (API: `relocateHierarchyNodes: true`,
[ADR-0017](../../docs/adr/0017-relocated-hierarchy-sidecar.md)) moves them into
a package sidecar and flattens what remains, so the document holds the drawing
nodes with composed world matrices and no `children`. On the engineering
baseline the document falls 405,570,167 to 317,466,183 B (-21.72%) and the
package falls 2.72% after the 64,825,238 B sidecar is charged — the tree is
carried, not deleted. The option is off by default, is part of the
compiled-cache key, and changes the package digest when it is on. See the
[relocation record](../../artifacts/compiler/hierarchy-relocation/README.md).
What the smaller document is worth to a viewer was then measured on paired
sixty5 packages in a headed browser: first coarse frame 4,408 -> 3,703 ms
(-15.99%) and peak JS heap -20.30%, with the sidecar fetched once per session
([browser record](../../artifacts/ifc/relocated-hierarchy-browser/README.md)).
It stays off by default until `naru.package-hierarchy.1` leaves
`experimental-not-interchange`.

The committed [engineering-scale qualification
record](../../artifacts/ifc/engineering-baseline/README.md) uses this option
together with compact JSON, a spatial index, and spatial-leaf payload order.
After explicitly fetching the two large source datasets, reproduce it with
`pnpm ifc:engineering:compile`, record the reports with
`pnpm ifc:engineering:evidence`, and run the strict offline gate with
`pnpm ifc:engineering:check`. The measured 31-document package passes the Phase
2 occurrence/triangle/prototype floors and Khronos validation; public Studio
delivery is not part of that record.

### Split Scene IR transport

The IFC adapter does not hand back one expanded JSON document. It writes a
structure-only JSON file whose representation surfaces hold
`{encoding, byteOffset, byteLength}` references into a separate little-endian
geometry file, plus a binary property value column file, and reports a SHA-256
for each of the three. The compiler verifies the digests and then resolves the
references into typed-array views without copying the coordinate data.

This removes the decimal round-trip for every coordinate, and the compiler
never holds the structure document as one string either: a record-streaming
reader (`src/ifc-structure-stream.ts`) walks the file in bounded chunks and
parses one record at a time, so a structure above the JavaScript maximum
string length compiles the same way a small one does (the sixty5 federation's
split.1 structure measured 631.9 MB against the 536,870,888 code-unit ceiling;
property indexing has since brought it to 419.5 MB, and the reader still
protects against any future crossing). Since `madi.ifc-scene-ir-split.2` the
structure also interns property keys and key combinations once into a
scene-level `propertyIndex` instead of repeating key text per entity, and
since `madi.ifc-scene-ir-split.3` the property values themselves live in a
third binary column file (`madi.property-columns.1`): each semantic entity
carries only `{set, row}`, and the compiler checks every row's arity against
its interned key set through typed-array views without materializing a single
value (values decode lazily through `resolvePropertyEntries` /
`openPropertyValueColumns` in `@naru3d/scene-ir`). The observable
`EngineeringScene` contract is unchanged apart from those tables, so the split
exists only between the adapter and its consumers. `--retain-scene-ir`
therefore writes `scene-ir.json`, `scene-ir-geometry.bin`, and
`scene-ir-properties.bin`; the JSON alone is not a loadable scene.

`naru.ifc-scene-ir-split.4` adds explicit OpenCascade face-boundary streams.
Edge positions may alias the surface position range; indices, boundary classes,
and IFC representation-item source ids remain separate typed-array views. The
compiler still accepts historical split.3 reports so existing Digital Hub,
sixty5, and public-demo packages remain reproducible. The focused split.4
record is checked by `pnpm ifc:edges:check`.

### Package property sidecar

A compiled package built from a column-bag scene republishes the properties as
two additional package resources (`docs/COMPILER.md` section 21.2):
`properties.bin` — the adapter column file byte for byte — and
`properties.json`, a `madi.package-properties.1` document holding the interned
property index plus a sorted columnar semantic table, parsed and validated by
`parsePackageProperties` in `@naru3d/scene-ir`. `scene.gltf` points at the
sidecar through `extras.madi.properties`, both resources join
`output.resources` and the package digest, and `compileSceneToGltf` refuses a
column-bag scene without `options.propertyColumns` (and the reverse). Inline
`PropertyBag` scenes — the STEP path — emit no sidecar and are byte-identical
to before; the glTF profile and report schema are unchanged.

### Package hierarchy sidecar

`--relocate-hierarchy-nodes` republishes the assembly tree as two further
resources (`docs/COMPILER.md` section 21.3): `hierarchy.bin`, the entries as
columns, and `hierarchy.json`, a `naru.package-hierarchy.1` header holding the
scene identity, the section table, the interned tag sets, and the entry and
relocated counts. `scene.gltf` points at it through `extras.madi.hierarchy`,
both resources join `output.resources` and the package digest after the
property sidecar, and both participate in compiled-cache identity. Reading the
tree back then requires the sidecar; `@naru3d/runtime-webgpu` fails closed
rather than mistaking the drawing nodes for the whole assembly.

## Watch and cancel an import

Both compile commands accept a lifecycle observer, and both emit the same
versioned event stream, `naru.import-job-event.2`
([ADR-0020](../../docs/adr/0020-cancellable-import-jobs.md), Proposed):

```ts
import { compileIfcFederation, isImportJobCancellation } from "@naru3d/compiler";

const controller = new AbortController();
try {
  await compileIfcFederation({
    documents,
    outputDirectory,
    job: { signal: controller.signal, onEvent: (event) => console.log(event.state) },
  });
} catch (error) {
  if (isImportJobCancellation(error)) {
    // error.cancelledDuring names the state the job stopped in.
  }
}
```

Nine states run in one order — `queued`, `inspecting`, `extracting`,
`compiling`, `verifying`, `publishing`, then exactly one of `completed`,
`cancelled`, `failed`. A job announces a state when it begins it, may skip
states, and never revisits one; a cache restore skips `extracting`,
`compiling`, and `publishing`, because restoring an entry verifies every
resource and places the directory in one atomic primitive. Every event carries
a gapless zero-based `sequence`, monotonic `elapsedMs`, and a `progress` pair
whose `total` is `null` until the cache decision settles and then counts
lifecycle steps: six on a rebuild, three on a restore. It is a step count, never
an estimate from source size, because nothing here measures how long
tessellating an unseen document takes.

Events name their sources by digest and byte length rather than by path, and
every string leaving the module — failure messages included — is scrubbed of
filesystem paths and marked `redaction: "no-filesystem-paths"`, so an event may
cross a trust boundary the source document never should.

`--json-events` writes that stream to stdout as newline-delimited JSON and moves
every human line to stderr, so a caller can pipe one and read the other:

```bash
pnpm naru compile-ifc --document architecture=a.ifc --output out --json-events 2>/dev/null
```

The first `SIGINT` or `SIGTERM` cancels the job instead of killing the process,
which is what lets the compiler stop the adapter it started; a second is not
intercepted. A cancelled run exits 130.

Cancelling terminates the adapter and every process it started, removes the
temporary Scene IR directory the job was extracting into, and never removes a
previously verified cache entry. Publication is the one section that is not
interruptible: the package writer is not atomic, so a cancel observed midway
would leave a directory that looks like a package and is not one. That section
runs to the end and the cancellation event reports
`publishedBeforeCancellation: true`.

### Stage each document's tree while the federation extracts

`naru compile-ifc --staged-preview <directory>` (`stagedPreviewDirectory` on
`compileIfcFederation`) asks the adapter for `--structure-preview` and watches
that emission from the compiler
([ADR-0021](../../docs/adr/0021-staged-hierarchy-first-import.md), Proposed).
Each document's tree is verified by byte length and SHA-256 before it is
parsed, checked against the inspected source's discipline, digest, and size,
re-encoded as the `naru.package-hierarchy.1` sidecar pair the runtime already
decodes (`hierarchy-<discipline>.json` + `.bin`), and published atomically --
temporary name, then rename -- under a `staged.json` manifest
(`naru.staged-import-preview.1`) that records every file's length and digest,
rewritten after each document with `complete` flipping at the end. The same
event stream reports it: a second `extracting` event carrying `staged`
(discipline, source digest and size, node and root counts, sidecar digests,
`stagedCount`/`totalCount`), the only event that repeats a state.

The directory must be empty or absent. It is never a package -- no
`scene.gltf`, no `scene.bin`, no digest chain -- and never a cache tier: a
cache hit does not open it, a cancel removes it with the temporary split, and a
completed import supersedes it. A tree whose digest, source identity, or
discipline disagrees with the inspected source fails the compile with
`StagedPreviewError` (`INVALID_STAGED_PREVIEW`), and the `failed` event names
no path. The package a staged compile writes is byte-identical to one that never
staged, and the staged directory is part of neither the job identity nor the
cache key ([tests](test/ifc-federation.test.ts)).

## Current limits

- The direct STEP command currently depends on the pinned CadQuery/OCP Python
  adapter. Moving the proven extraction behavior into the native C++ adapter
  remains production hardening work.
- The IFC command currently depends on pinned IfcOpenShell 0.8.5. IFC topology
  edge classification and cross-document reconciliation remain explicit
  follow-up work. A degenerate source
  `IfcAxis2Placement` (zero-length or parallel axes) is replaced with an
  identity transform and reported as `IFC_DEGENERATE_PLACEMENT`; the adapter
  never hands the compiler a non-finite matrix
  (`native/adapter-ifc/README.md`).
- The split transport requires a little-endian host. The structure document
  streams record by record, property keys are interned, and property values
  stay in the binary column file — the hydrated scene never materializes them
  — but the occurrence and semantic records themselves stay resident during
  compilation. The largest recorded compile — the sixty5 federation with
  4,503,078 property values (`artifacts/ifc/sixty5/`) — peaked at
  3,845,181,440 bytes (≈3.6 GB, sampled at 2 s intervals) compiler working
  set inside the default 64-bit Node 22 heap with no `--max-old-space-size`
  override (4,043,804,672 bytes on the split.1 631.9 MB structure, commit
  `41e6973`); expect peak memory to scale with occurrence and semantic record
  counts, not with geometry bytes.
- The first coarse representation is a per-prototype AABB, not a
  shape-preserving LOD. IFC target ranges are coalesced with a static initial
  priority. The optional occurrence spatial index is implemented at the API
  and decoder boundary, but the CLI, recorded packages, and browser scheduler
  do not consume it yet; compression and screen-space policy also remain
  pending. The browser applies a fixed decoded/GPU admission budget and
  retains coarse fallbacks when it reaches that cap; eviction and cache policy
  are Phase 2 follow-up work.
- Local geometry and transform linear components are f32. Node translations
  stay as ordinary glTF JSON numbers when f32 delivery error would exceed the
  10 nm budget, allowing the NARU loader to compose and camera-rebase them in
  JavaScript number precision. The 0.25 mm / 10,000 km ADR-0005 record is
  checked by `pnpm precision:check`.
- `extras.madi` is an experimental profile, not a public interchange standard.
- The browser runtime proves coarse-first promotion on the direct AP242 package;
  the canonical PyGamer benchmark remains a monolithic target-only baseline.
