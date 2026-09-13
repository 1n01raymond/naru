# ADR-0019: Reuse verified per-document Scene IR artifacts across the adapter-compiler transport, retire the compiled payload tier

Status: Proposed

## Context

[ADR-0018](0018-content-addressed-compiled-payloads.md) content-addressed the
compiled prototype payload and was rejected by its own gate 4
([record](../../artifacts/cache/payload-reuse/README.md)): a changed-discipline
rebuild reproduced every clean package byte, but the packaging stage took
2.2-2.4x as long store-warm as clean (Digital Hub 3,184.9 ms against
7,585.0 ms, sixty5 35,202.0 ms against 77,713.5 ms). The Phase 2 tracker asked
for a successor that reuses something cheaper to restore than to rebuild and
named two candidates: laid-out byte ranges above the encoder, or
content-derived prototype ids so an edited document keeps its untouched
payloads.

Before choosing, the warm changed-discipline rebuild was decomposed twice:
first by exploratory single-run probes on this Windows host, then by this
ADR's gate 0 record
([artifacts/cache/rebuild-stages](../../artifacts/cache/rebuild-stages/README.md)),
five fresh-process samples per model with adapter and compiler stage ledgers
that close to the wall clock. The record's medians are the numbers this ADR's
sizing rests on. The probe tables are kept below, labelled superseded,
because gate 0 required stating whether they reproduced: they did not -- nine
of nine comparable rows fall outside the record's own spread on both models,
by 1.3-2.6x -- and the Context was corrected from the record on 2026-09-03 as
gate 0 prescribes. The shape they described survived the correction; the
absolutes did not.

Committed record, medians over five samples (milliseconds, share of the
`compileIfcFederation` wall time):

| Stage | Digital Hub | sixty5 |
|---|---:|---:|
| Compile wall time | 19,763.6 | 126,149.8 |
| Waiting on the adapter subprocess | 15,519.6 (78.5%) | 79,106.6 (62.7%) |
| In-process compiler work | 4,346.1 (22.0%) | 46,582.0 (36.9%) |
| Transport of unchanged documents: artifact verification + load, property index, merge, Scene IR writes, structure re-scan | 9,485 (48.0%) | 97,472 (77.3%) |
| of which artifact verification by canonical re-serialization | 4,434.2 | 34,204.2 |
| of which the compiler's structure stream scan | 2,305.9 | 30,215.2 |
| of which the adapter's structure write | 837.2 | 10,586.1 |
| of which the federation property index | 615.7 | 11,666.2 |
| Re-extracting + publishing the changed document | 7,788 (39.4%) | 9,474 (7.5%) |
| `compileSceneToGltf`, of which the encoder (`buildCompiledPayload`) | 1,065.6 / 451.5 (2.3%) | 10,830.6 / 3,183.7 (2.5%) |
| Document streaming (`measureDocument`) | 222.3 | 2,437.2 |
| `writeCompiledPackage` | 210.7 | 2,388.2 |
| `validateScene` | 127.7 | 1,433.3 |

The record's absolutes are 1.2-1.4x the ADR-0018 record's clean-rebuild
medians on the same host and options (15,673.5 and 95,126.1 ms), uniformly
across adapter and compiler stages, under uncontrolled foreground host load
that the record declares; gate 4 is therefore measured against a clean
rebuild recorded in the same session, never against these absolutes.

Superseded exploratory probe, one run per model, kept for the reproduction
verdict above:

Compiler process, warm changed-discipline clean compile
(`node --cpu-prof scripts/lib/ifc-cache-sample.mjs --config <changed-clean>
--phase probe`, self time summed per frame over the whole run; the same
configurations the ADR-0018 record used, document artifacts warm):

| Stage | Digital Hub | sixty5 |
|---|---:|---:|
| Compile wall time (`compileMilliseconds`) | 10,140 ms | 99,851 ms |
| Idle, waiting for the adapter subprocess | 6,988 ms | 62,787 ms |
| In-process compiler work | 3,195 ms | 37,109 ms |
| Structure stream scan (`ifc-structure-stream` frames, self) | ~1,240 ms | ~15,100 ms |
| Garbage collector + microtask pump (self) | 744 ms | 11,347 ms |
| `compileSceneToGltf` (inclusive) | 780 ms | 6,849 ms |
| of which `buildCompiledPayload` (the encoder) | 236 ms | 1,229 ms |
| Document streaming (`streamJsonInto`, inclusive) | 298 ms | 2,950 ms |
| `writeCompiledPackage` (inclusive) | 139 ms | 1,392 ms |
| `validateScene` (inclusive) | 92 ms | 1,018 ms |

Adapter process, warm document artifacts. Today `read_document_artifact`
verifies an artifact by re-serializing its parsed payload canonically and
hashing that text (`_canonical_sha256`). A Python script timed the three
candidate verification methods per stored artifact, one run, every artifact in
the two ADR-0018 caches (Digital Hub 6 files, 18,677,859 B gzipped; sixty5 8
files, 104,800,624 B):

| Method, summed over the cache | Digital Hub | sixty5 |
|---|---:|---:|
| `gzip.open` + `json.load` (the parse the adapter needs anyway) | 1.05 s | 7.59 s |
| Canonical re-serialization + SHA-256 (what runs today) | 4.66 s | 27.25 s |
| SHA-256 over the gunzipped stored bytes | 0.24 s | 1.50 s |

A plain warm adapter run of the Digital Hub changed configuration, all four
artifacts hit, took 6.7 s of wall time in the same session.

Store I/O over the ADR-0018 Digital Hub payload store (3,383 entries,
35,961,456 B, two runs): reading and hashing every entry 578-622 ms; reading
only 463-543 ms; `stat` only 35-39 ms; hashing the same bytes as one buffer
14.1-14.4 ms; copying them 3.4-3.5 ms. Restore cost was per-file overhead,
not hashing.

Three conclusions follow, and they decide this ADR.

1. **The encoder is not the lever.** `buildCompiledPayload` is 6.8 percent of
   the compiler's in-process time on sixty5 and 2.5 percent of the rebuild
   wall time (10.4 and 2.3 percent on Digital Hub) in the record. Any reuse
   unit that sits at or below the encoder -- restored payloads, laid-out
   `scene.bin` byte ranges, or a higher hit rate through content-derived
   prototype ids -- is capped there, and ADR-0018's store spent more than
   that ceiling on I/O before it restored a single byte. The tracker's two
   named candidates cannot pass gate 4 whatever their hit rate.
2. **The transport is the lever.** On a changed-discipline rebuild every
   unchanged document is verified by re-serialization (34.2 s on sixty5 in
   the record, 44 percent of the adapter's main; the probe put hashing the
   stored bytes at 18-20x less), re-merged and re-indexed into the federation
   (property index 11.7 s), re-written as the split Scene IR (structure write
   10.6 s), then re-scanned by the compiler's streaming reader (30.2 s of wall
   time on sixty5, 65 percent of the compiler's in-process work; 2.3 s and 53
   percent on Digital Hub). Together that is 77 percent of a sixty5 rebuild
   and 48 percent of a Digital Hub one. Only the changed document needs any
   of that.
3. **Restore must be one read and one hash.** A store of many small files
   pays per-file overhead that dwarfs the hashing it exists to do. The
   artifact cache already stores one file per document; the successor keeps
   that shape and removes the re-serialization.

## Decision

The reuse unit is the **verified per-document Scene IR artifact** that the
IFC adapter already publishes under `--cache`
(`naru.ifc-document-artifact.1`), promoted from "skip tessellation" to "skip
the transport": an unchanged document is verified by one digest over its
stored bytes and reaches the compiler without being re-serialized, re-merged,
re-written, or re-scanned. Compiled bytes are never reused; every package
resource is still laid out from the current scene, which keeps ADR-0018's
proven byte-identity contract and ADR-0010's rule that federation-global
packing is rebuilt.

The decision has three parts, landed as separate slices in this order, each
measured against gate 0 before the next begins:

1. **Verify stored bytes, never a re-serialization.** The artifact schema
   moves to `naru.ifc-document-artifact.2`: one gzip stream holding a
   canonical-JSON header line (key, key input, payload length, payload
   SHA-256, schema) followed by exactly that many payload bytes, and a read
   verifies the header and hashes the stored bytes before anything is parsed,
   instead of dumping the parsed object again. The key-input comparison and
   the schema check stay; the key input itself is unchanged, so a `.1` file at
   the same path is refused by its schema line, re-extracted, and republished.
   **Landed 2026-09-03** (adapter only;
   [tests](../../native/adapter-ifc/tests/test_document_artifact_cache.py),
   compiler pin in `ifc-federation.ts`): unchanged-document verification on
   Digital Hub went from 4,434.2 ms in the gate 0 record to 34.1 ms, and on
   sixty5 from 34,204.2 ms to 353.0 ms
   ([record](../../artifacts/cache/rebuild-stages/README.md)).
2. **Column-form structure so hydration is a view, not a parse.** The
   artifact's structure-bearing records (prototypes, occurrences, semantics,
   representations, document metadata) are stored the way the property
   columns (`madi.property-columns.1`) and the relocated hierarchy
   (`naru.package-hierarchy.1`) already are: fixed-width typed columns plus
   one string table, with geometry and property values in the binary
   sidecars they already occupy. The compiler restores a document by reading
   its file once, hashing it once, and taking typed-array views. This is
   what removes the structure scan; a per-document JSON artifact would move
   the same bytes through the same scanner.
   **Landed 2026-09-13** as `naru.ifc-document-artifact.3` (adapter only;
   [tests](../../native/adapter-ifc/tests/test_document_artifact_cache.py),
   compiler pin in `ifc-federation.ts`), narrower than this bullet reads: the
   structure records stayed canonical JSON and only the bulk numeric geometry
   regions became raw little-endian typed views, for the reason recorded under
   *Implementation notes* below. Artifact parse fell from 650.6 to 167.3 ms on
   Digital Hub and from 5,482.0 to 3,161.0 ms on sixty5, with the artifacts
   themselves smaller (Digital Hub 14,018,134 to 13,178,145 bytes, sixty5
   101,185,751 to 92,975,427) and no package byte moved
   ([record](../../artifacts/cache/rebuild-stages/README.md)).
3. **Assemble the federation in the compiler.** The adapter keeps ownership
   of extraction and of each document's artifact. For a rebuild it emits a
   federation manifest -- document order, per-document artifact key and
   digest, federation digest, adapter identity and options -- and re-extracts
   only the documents whose key misses. The compiler hydrates each verified
   artifact and performs the federation merge that `extract_federation`
   performs today (sorted record ids, material dedup, property-key interning)
   in-process. Where the adapter still writes a monolithic split Scene IR
   (no cache directory, or a consumer that asks for it), nothing changes.
   **Slice 3a landed 2026-09-13** as `naru.ifc-document-artifact.4`: property
   interning and value encoding moved into the per-document pass, so the
   artifact carries a document-local key table plus the deduped value heap and
   its three `u32` index tables as raw regions, and the federation pass is a
   remap over pre-encoded byte strings. That is the prerequisite for assembling
   the merge in TypeScript, for the reason recorded under *Implementation
   notes* below. The manifest and the in-compiler merge are slice 3b.

`--payload-cache` **is removed.** Its ceiling is the encoder's share, so no
tuning can pass gate 4; a flag that can never be recommended is an option
surface, a cache-key input, a build-report block, and a test suite to
maintain for no outcome. The encoder/placement split
(`buildCompiledPayload` / `appendCompiledPayload`) and the shared cache
primitives stay: they moved no bytes and one place still decides offsets and
padding. The ADR-0018 record stays committed as the measurement that closed
that tier; its README will note that the recorder is retired with the flag.

## Resource ownership

- The adapter owns extraction and the per-document artifact. Its key is
  unchanged in substance: artifact schema, discipline, source digest, URI
  hint, thread count, and adapter fingerprint. Ownership therefore coincides
  with the document selectors ADR-0010 already records; a discipline that is
  renamed, relabelled, or re-pointed misses exactly as today.
- The compiler owns the federation merge, hydration, validation, and every
  package resource. It trusts an artifact only after the byte digest and the
  key input match; a mismatch is a warning and a re-extraction of that
  document, never an error, mirroring the whole-package cache
  ([ADR-0009](0009-persistent-compiled-cache.md)).
- The merge the compiler performs must be the merge the adapter performs. The
  proof is gate 1: a federation assembled from artifacts and one written
  monolithically by the adapter compile to byte-identical packages.

## Invalidation

| Change | Effect |
|---|---|
| Source bytes of one document | That document misses; the others restore by digest. |
| Adapter fingerprint, thread count, or extraction options | Every document misses (the key changes). |
| Artifact schema bump | Every document misses once: the schema line is checked before the key, so a previous-format file at the same path is refused and republished. |
| Corrupt or truncated artifact | Digest mismatch, warning, re-extraction of that document. |
| Cross-document semantic relation touching an unchanged document | The document artifact is unaffected; the compiler's merge and ADR-0010's reconciliation set decide the package-level consequences, exactly as they do for a monolithic scene. |
| Compiler identity or compile options | No artifact effect; the whole-package cache misses and the compiler re-lays out the package from restored artifacts. |

## Consequences

### Positive

- The reuse unit is the one the invalidation index already understands: a
  document. No second identity scheme, no content digest over geometry, no
  store of thousands of small files.
- Restore is bounded by one sequential read and one SHA-256 of the stored
  bytes. Measured after slice 2 (gate 3): Digital Hub load + verify of the
  three unchanged artifacts 154.7 [145.1, 163.2] ms against a 107.4
  [103.6, 124.7] ms read + gunzip + hash of the same files in the recorder
  process (1.44x); sixty5 1,436.6 [1,430.7, 1,480.4] ms against 1,052.9
  [1,024.2, 1,107.7] ms (1.364x). After slice 1 the same figures were
  201.6 against 143.8 ms (1.402x) and 1,665.1 against 1,256.0 ms (1.326x).
- The compiler stops scanning unchanged documents' structure JSON, the single
  largest in-process cost of a rebuild, and the adapter stops re-writing the
  federation it did not change.
- ADR-0018's byte-identity protocol carries over unchanged, so the successor
  is measured against the same bar with the same comparison tooling.
- Removing `--payload-cache` deletes an option that measurement showed can
  never be recommended.

### Negative

- Format bumps on the artifact, one per transport slice and each a cold
  namespace, so every user re-extracts once. Slices 1 and 2 took the same
  lineage to `.2` and then `.3` at the same path rather than introducing a
  second transport, which is why there is one bump per slice and not one per
  format.
- The federation merge exists in two implementations, Python for the
  monolithic path and TypeScript for the artifact path, and they must stay
  byte-equivalent; gate 1 pins it, and every later adapter change to the merge
  must re-run that comparison.
- The compiler hydrates a real-large federation from N files instead of three;
  peak memory could rise if hydration copies where it should view. Gate 4's
  memory rule makes that a rejection, not a regression.
- Slice 3 is the largest change to `packages/compiler/src/ifc-federation.ts`
  since the streaming reader; the tracker sequences it last so slices 1 and 2
  can land and be measured on their own.

## Alternatives considered

- **Laid-out `scene.bin` byte ranges above the encoder**, the tracker's first
  candidate. Reusing a document's contiguous payload segment saves encoding
  and appending (1.3 s of 37.1 s in-process on sixty5) and, at best, part of
  the buffer hashing; the document JSON that names those ranges is still
  streamed in full unless it is templated, and the structure scan that
  dominates is untouched. Capped near one tenth of the compiler's in-process
  time; rejected as the lever. It stays available as an additive after the
  transport is fixed, if gate 0 then shows encoding has become significant.
- **Content-derived prototype ids**, the tracker's second candidate. This
  raises the hit rate of a tier whose ceiling is the encoder's share, so it
  cannot change the gate 4 outcome. It may still be adopted later for
  identity stability across edits (ADR-0010's rename cases), as its own ADR.
- **Fix only the verification and stop.** Slice 1 alone is the cheapest
  change and probably the largest single saving on the adapter side, but it
  leaves the federation rewrite and the compiler's full structure scan; it is
  the first slice, not the decision.
- **Column-form federation structure without per-document artifacts.** Cuts
  the scan, keeps the adapter re-merging and re-writing every document, and
  ties invalidation to the federation. Rejected; the column form is adopted at
  document granularity instead.
- **Keep `--payload-cache` as an off-by-default experiment.** Rejected: the
  measurement is complete and its ceiling is known.

## Validation

The gates are predeclared here, before any slice lands, and a failed gate 4
rejects this ADR the way it rejected ADR-0018; no gate may be loosened to pass.

- **Gate 0, before any transport code:** a committed record decomposing a
  changed-discipline rebuild of Digital Hub and sixty5 into stages --
  adapter: interpreter start, changed-document extraction, artifact
  verification, merge, Scene IR write; compiler: structure read, hydration
  and validation, packaging, document streaming, package write -- with the
  fresh-process, predeclared-sample protocol of
  [artifacts/cache/sixty5](../../artifacts/cache/sixty5/README.md). It fixes
  the stage shares every later gate is argued against and closes the
  "real-large reopen stage breakdown" evidence debt in [PHASE_2](../PHASE_2.md).
  The exploratory attribution above must reproduce within the record's own
  spread or the Context of this ADR is corrected before slice 1.
  **Met 2026-09-03**
  ([record](../../artifacts/cache/rebuild-stages/README.md), validator
  `pnpm cache:stages:check`): five samples per model, zero discarded, every
  closure check held. The exploratory attribution did **not** reproduce (nine
  of nine rows outside the spread on both models) and the Context was
  corrected from the record; the shape it argued -- encoder 2.3-2.5 percent,
  unchanged-document transport 48 and 77 percent -- held.
- **Gate 1, byte identity:** every package resource of a changed-discipline
  rebuild through restored artifacts is byte-identical to a clean compile on
  both models, with the ADR-0018 record's closed report-exclusion list and no
  additions to it. Slice 3 additionally proves the compiler-side merge equals
  the adapter's on a federation with cross-document relations, shared
  materials, and interned property keys. **Slice 1: met 2026-09-03** on both
  models -- every package file byte-identical across five interleaved
  transport/clean pairs, `adapter-report.json` identical outside the one
  excluded key, Digital Hub package digest `c4b151e5...` (the gate 0 record's
  digest, so the format change moved no byte), sixty5 `05707534...` (likewise its gate 0 digest).
  **Slice 2: met 2026-09-13** -- both digests reproduced unchanged
  (`c4b151e5...`, `05707534...`), so the second format change also moved no
  package byte; on sixty5 ten of the eleven package files are byte-identical
  across the five pairs and `adapter-report.json` is identical outside the
  same excluded key. **Slice 3a: met 2026-09-13** -- both digests reproduced a
  third time (`c4b151e5...`, `05707534...`), so moving property interning and
  value encoding into the per-document pass moved no package byte either; on
  both models ten of the eleven package files are byte-identical across the
  five interleaved pairs and `adapter-report.json` is identical outside the
  same excluded key.
- **Gate 2, exact decisions:** the adapter report names every document's
  restore or extraction and its reason; a corrupt artifact warns and
  re-extracts; a wrong key never restores. **Slice 1: met 2026-09-03** -- the
  record pins hits/misses and per-document ledger states (`verified` /
  `absent`) identical across samples on both models; the refusal reasons for
  corrupt, truncated, tampered, wrong-key, and previous-schema artifacts are
  unit-tested. **Slice 2: met 2026-09-13** -- three verified restores and one
  miss on Digital Hub, six and one on sixty5, identical across all five
  samples on both models; a `.2` artifact is refused by its schema line and
  republished at the same path, which both warm-ups confirm (seven misses,
  zero hits). **Slice 3a: met 2026-09-13** -- the same decisions under
  `naru.ifc-document-artifact.4`: on Digital Hub `heating`, `plumbing`, and
  `ventilation` verified against `architecture` absent, on sixty5 six verified
  against `structure` absent, identical across all five samples on both
  models, and the `.3` files are refused by their schema line and republished
  at the same path (both warm-ups zero hits, four and seven misses).
- **Gate 3, restore cost:** the verification stage of an unchanged document,
  measured in the gate 0 decomposition, is bounded by one read and one hash
  of its stored bytes -- no stage re-serializes, re-parses for verification,
  or opens more than one file per document. Operationalized in the record as
  a same-session ratio: adapter load + verify against the recorder's own
  read + gunzip + hash of the same files, met at 2x or better, with the parse
  ledgered apart so nothing hides inside it. **Slice 1: met 2026-09-03** --
  Digital Hub 1.402x, sixty5 1.326x. **Slice 2: met 2026-09-13** -- Digital
  Hub 1.44x, sixty5 1.364x, both inside the 2x bound, with the ledgered parse
  down from 650.6 to 167.3 ms and from 5,482.0 to 3,161.0 ms. **Slice 3a: met
  2026-09-13** -- Digital Hub 1.419x, sixty5 1.352x; verification itself is
  25.6 ms and 229.5 ms, against the gate 0 decomposition's 4,434.2 and
  34,204.2 ms, and the ledgered parse is 136.7 and 3,664.1 ms -- Digital Hub's
  fell again from 167.3 ms, sixty5's rose from 3,161.0 ms while its load fell
  from 1,108.5 to 788.5 ms and its verification from 329.0 to 229.5 ms. The
  record reports both directions and states which four numbers are measured.
- **Gate 4, the same rule as ADR-0018:** after each slice, the whole-process
  median of a changed-discipline rebuild is lower than the clean rebuild
  median on Digital Hub and on sixty5, by more than three times the clean
  samples' own spread (maximum minus minimum), with peak process-tree memory
  no higher. The record that closes slice 3 moves this ADR and
  [ADR-0010](0010-ifc-incremental-dependency-index.md) to Accepted; a failure
  at any slice records the measurement and marks this ADR Rejected. The
  clean arm is a compile with no cache directory -- neither the document
  artifact tier under test nor the whole-package cache -- the analogue of the
  ADR-0018 record's no-store arm. **Slice 1: met
  2026-09-03** -- Digital Hub 11,102.2 ms against 50,028.4 ms (saving
  38,926.2 ms, three clean spreads 11,122.8 ms; peak working set 0.64 GB
  against 1.83 GB); sixty5 72,993.4 ms against 320,064.2 ms (saving
  247,070.8 ms, three spreads 26,603.7 ms; peak 4.15 GB
  against 5.08 GB). The gate 0 record had no clean arm, so whether
  slice 1 alone changed this verdict is not recorded; slice 1's own effect is
  gate 3's verification column. **Slice 2: met 2026-09-13** -- Digital Hub
  10,631.0 ms against 52,570.5 ms (saving 41,939.5 ms, three clean spreads
  11,026.2 ms; peak working set 0.48 GB against 1.83 GB); sixty5 70,667.5 ms
  against 317,588.2 ms (saving 246,920.7 ms, three spreads 23,595.0 ms; peak
  3.61 GB against 5.11 GB). The clean arm is re-measured in each session, so
  its medians moved between the two slices; only the same-session pair is a
  comparison. **Slice 3a: met 2026-09-13** -- Digital Hub 10,302.4 ms against
  53,754.4 ms (saving 43,452.0 ms, three clean spreads 4,434.3 ms; peak
  working set 0.44 GB against 1.85 GB); sixty5 61,672.4 ms against
  316,082.6 ms (saving 254,410.2 ms, three spreads 17,402.1 ms; peak 2.96 GB
  against 4.63 GB). Slice 3b is the only slice left, and the record that
  closes it decides this ADR.

The removal of `--payload-cache` is its own slice and needs no gate beyond
`pnpm check`: the ADR-0018 record's validator keeps validating the committed
record, and the record README states that the recorder is retired. That
slice landed on 2026-09-03: `--payload-cache` is gone from both commands, the
store, the selection logic, the `compiledPayloadCache` report block, their
tests, and `scripts/record-payload-reuse-evidence.mjs` are deleted, and
`pnpm cache:payload:check` still validates the committed record.

### Implementation notes (2026-09-13, column-form structure slice)

Where it narrows the Decision above, the narrowing is deliberate and stated
here:

- **Geometry moves to raw regions at known paths; the structure records stay
  canonical JSON.** The Decision asks for fixed-width typed columns plus one
  string table over every structure-bearing record. What landed
  (`naru.ifc-document-artifact.3`) keeps the structure records as the
  canonical JSON the previous format already verified, adds a
  `structureBytes` header field, and appends the bulk numeric arrays --
  surface positions, indices, normals, edge positions, segments, classes, and
  source ids, at the bounded paths
  `payload["representations"][i]["surface"|"edges"][field]` -- as raw
  little-endian regions padded to eight bytes. The payload SHA-256 still
  covers the whole payload region, so the verification contract of slice 1 is
  unchanged. The reason is composition, measured on the corpus before the code
  was written: `json.loads` is C, so a pure-Python column decoder loses on
  record-shaped data (dicts and short strings) and wins enormously on bulk
  numbers, where a typed-array view replaces one Python object per element.
  Digital Hub's documents carry 20.7 bulk numbers per record item and the
  largest sixty5 document 2.2, so the numeric arrays are where the parse time
  is. Because the hoisted paths are known and bounded, re-attaching the views
  after the JSON parse is O(representations), not O(records).
- **One namespace lineage, not two transports.** The Negative consequences
  above predicted two format bumps; there is one lineage, `.1` to `.2`
  (slice 1) to `.3` (this slice), at the same path, each earlier file refused
  by its schema line and republished. `document_artifact_cache.py` is inside
  the adapter's self-hash set (`extract_federation_scene_ir.py`), so the bump
  is a cold namespace; both warm-ups confirm it (Digital Hub 0 hits and 4
  misses, sixty5 0 hits and 7 misses).

### Implementation notes (2026-09-13, per-document property columns slice)

Slice 3a moves no bytes and adds no gate; it exists because slice 3b is
impossible without it.

- **Property values must be moved, never re-encoded.** `properties.bin` is the
  adapter's own `encode_property_value` output, and the compiler copies it
  through untouched. Python and JavaScript do not agree on the canonical JSON
  of a number (`1.0` against `1`, `1e+16` against `10000000000000000`), so a
  TypeScript federation merge that re-encoded a property value would change
  `properties.bin` and every package digest with it. Interning and encoding
  therefore happen once, in the per-document pass that already owns the
  document's records, and the artifact stores the result: a document-local key
  table, the deduped value heap, and `value_offsets`, `row_refs`, and
  `row_offsets` as `u32` regions beside the geometry regions slice 2
  introduced. The federation pass sorts and dedupes opaque byte sequences and
  remaps indices -- an operation TypeScript reproduces exactly.
- **The equivalence is asserted, not assumed.** Six unit tests assert that the
  merge of per-document columns equals a single pass over their concatenation,
  heap bytes included, under an interleaved federation row order. That is
  gate 1 in miniature; gate 1 itself is unchanged and still the proof.
- **The lineage extends to `.4` at the same path**, still a cold namespace by
  the adapter self-hash. `ledger.federation` still carries exactly
  `mergeMilliseconds` and `propertyIndexMilliseconds`; the latter now times
  only the merge, because the encoding it used to include has moved into the
  per-document stages.
