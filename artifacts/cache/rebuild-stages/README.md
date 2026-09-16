# Changed-discipline rebuild: transport through stored-byte artifacts vs clean

Status: recorded evidence for
[ADR-0019](../../../docs/adr/0019-document-artifact-transport.md) slices 1, 2,
3a, and 3b (stored-byte document-artifact verification, then geometry carried
as raw binary regions beside the structure JSON, then the property value
columns carried the same way -- `naru.ifc-document-artifact.4` -- and finally
the federation assembled in the compiler from those artifacts instead of read
back from a merged Scene IR the adapter writes), measured against the ADR's
gates 1-4. The record compiles a one-document-changed federation of Digital
Hub and sixty5 two ways in the same session -- **transport** (every unchanged
document restored from its verified artifact, the changed one re-extracted,
the adapter emitting a `naru.ifc-federation-manifest.1` and the compiler
assembling the package from the artifacts) and **clean** (no cache directory
at all: every document extracted, the adapter merging and writing the Scene IR,
nothing looked up, restored, or published) -- five fresh-process samples per
arm, interleaved per index, using the predeclared-sample protocol of
[`../sixty5/`](../sixty5/README.md). Schema `naru.rebuild-stage-evidence.3`,
mode `fresh-process-changed-discipline-transport-vs-clean-rebuild`.

The previous version of this record (`naru.rebuild-stage-evidence.1`, commit
`69d67e5`) was the ADR's gate 0: the same transport rebuild decomposed into
stages with no clean arm, which fixed the stage shares the ADR argues from and
recorded that the ADR's exploratory attribution did not reproduce. Those
verdicts are stated in the ADR; this version supersedes the file, not the
verdicts. Where this README quotes gate 0 numbers, or the slice 3a record at
commit `e64adcc`, they come from that commit and from another session, so they
are reference only, never a same-session comparison.

One record per model: [`digital-hub.json`](digital-hub.json) (four-document
`ifc-bench-digital-hub`, MIT; changed discipline `architecture`) and
[`sixty5.json`](sixty5.json) (seven-document, 839.9 MB `ifc-bench-sixty5`,
CC BY 4.0; changed discipline `structure`), both from
`fixtures/external/manifest.json`. Validator: `pnpm cache:stages:check`.
Re-record: `pnpm cache:stages:evidence -- --model digital-hub` and
`-- --model sixty5`, with `NARU_IFC_PYTHON` pointing at the IfcOpenShell
interpreter. The warm-up is a cold extraction of the original federation
(Digital Hub 52.1 s, sixty5 324.2 s); each sample pair then costs
one transport rebuild plus one clean rebuild.

## Verdicts, pinned by the validator

| Gate | Digital Hub | sixty5 |
|---|---|---|
| 1 byte identity | Met: 10 of 11 package files identical, `adapter-report.json` identical outside the one excluded key; package digest `c4b151e5…` in both arms | Met: 10 of 11 package files identical, `adapter-report.json` identical outside the one excluded key; package digest `05707534…` in both arms |
| 2 exact decisions | Met: hits `heating`, `plumbing`, `ventilation`; miss `architecture`; ledger states `verified` ×3, `absent` ×1, identical in all five samples; the compiler assembled all four documents in all five samples | Met: hits `architecture`, `electrical`, `facade`, `kitchen`, `plumbing`, `ventilation`; miss `structure`; ledger states `verified` ×6, `absent` ×1, identical in all five samples; the compiler assembled all seven documents in all five samples |
| 3 restore cost | Met: adapter load+verify 142.6 ms vs 100.6 ms in-recorder read+gunzip+hash reference, ratio 1.417 (bound 2×) | Met: adapter load+verify 1,019.3 ms vs 790.6 ms reference, ratio 1.289 (bound 2×) |
| 4 faster than clean, memory no higher | Met: 9,268.1 ms vs 51,334.8 ms whole process (saving 42,066.7 ms, required > 13,192.5); peak working set 0.43 GB vs 1.84 GB | Met: 54,056.5 ms vs 312,209.0 ms (saving 258,152.5 ms, required > 42,564.6); peak working set 3.26 GB vs 4.62 GB |

The Digital Hub package digest is the one every artifact format so far --
`.1`, `.2`, `.3`, and `.4` -- published for the same edit, and slice 3b
reproduces it once more with the package assembled by the compiler, so no
format change and no change of assembler has moved a package byte. The same
holds for sixty5's digest.

## Protocol, fixed before any result was read

- **Process isolation.** Every sample and the warm-up is one fresh
  `node scripts/lib/ifc-cache-sample.mjs` process; the adapter is a fresh
  Python process inside it.
- **Cache state.** The warm-up extracts the original federation once
  (adapter only) so every document artifact is warm. Before each transport
  sample the package cache entries and the changed document's artifact are
  deleted; the unchanged documents' artifacts stay. Each transport sample
  therefore restores every unchanged document and re-extracts the changed
  one, its package cache lookup is a miss, and it runs the adapter in
  manifest mode (`--federation-manifest`) with the compiler assembling the
  federation from the artifacts (`assembleFederation: true`). Each clean
  sample compiles the same changed federation with no cache directory, so
  the adapter merges and writes the Scene IR itself and the compiler reads it
  back.
- **Clean arm definition.** "Clean" means no cache directory: the document
  artifact tier under test and the whole-package cache are both disabled.
  This is the analogue of the ADR-0018 record's "no store" arm for the tier
  ADR-0019 introduces; a clean arm that still restored artifacts would
  measure the tier against itself.
- **Ordering.** Per index: reset, transport sample, then clean sample, so
  host drift over the session lands on both arms alike.
- **Change.** Digital Hub `architecture` `#823= IFCEXTRUDEDAREASOLID(...,7.77)`
  → `9.77` (referenced only by `#824`, an `IfcShapeRepresentation` body);
  sixty5 `structure` `#890= IFCEXTRUDEDAREASOLID(...,250.)` → `350.`, compiled
  with `--compact-json` as every sixty5 record is.
- **Timing.** Adapter stages come from `--stage-timing` (a separate ledger
  file, never the report); compiler stages from `stageTiming: true`, ledger
  `naru.ifc-federation-stage-timing.2`, whose `assembleFederation` stage is
  the compiler-side restore, merge, and canonical serialization. Neither
  touches a package byte: every transport sample's package digest must equal
  the first transport sample's, and every clean sample's the first clean
  sample's.
- **Sample validity.** A transport sample counts only when the process exits
  0, the package cache misses, the artifact hits are exactly the unchanged
  documents and the miss exactly the changed one, the compiler reports the
  federation assembled from the artifacts (no monolithic fallback), no
  warning is emitted, the ledger is present, and the digest matches. A clean
  sample counts only when the process exits 0, both caches report `disabled`,
  no federation assembly took place, no warning is emitted, the ledger is
  present, and the digest matches. Up to three attempts per index and arm;
  every discarded attempt is recorded (none was discarded on either model).
  Byte identity across the arms is gate 1's verdict, never a validity rule.
- **Statistics.** Median, nearest-rank p95, minimum, maximum over the accepted
  samples of each arm. Peak memory is the OS-sampled Windows process tree.
- **Uncontrolled.** Other processes on the host, disk cache state between
  samples, CPU frequency scaling.

## Gate 1: byte identity

Every file the transport rebuild writes is compared with the file the clean
rebuild of the same index writes. The reports in the closed exclusion list --
exactly `adapter-report.json:documentArtifactCache`, the same single entry
the ADR-0018 record used, with no additions -- are compared as canonical JSON
after deleting the excluded key; everything else by SHA-256. This is the gate
that slice 3b changes the meaning of: in the transport arm the compiler now
merges the documents, remaps the interned property columns, and re-serializes
the canonical structure JSON (on Digital Hub 3,767,113 + 10,407,517 +
6,330,282 + 8,163,306 = 28,668,218 structure bytes across the four artifacts),
and the clean arm's files are the adapter's own. Digital Hub:
`build-report.json`, `coarse.bin`, `hierarchy.bin`, `hierarchy.json`,
`incremental-dependencies.json`, `properties.bin`, `properties.json`,
`scene.bin`, `scene.gltf`, and `spatial.bin` identical in all five pairs,
`adapter-report.json` identical outside the excluded key, both arms' package
digest `c4b151e5f5d762e4f431c5f647aaec8a53a43d7bbf9737917e4874a1f022b3bb`.
sixty5: `adapter-report.json` identical-outside-excluded-keys, `build-report.json` identical, `coarse.bin` identical, `hierarchy.bin` identical, `hierarchy.json` identical, `incremental-dependencies.json` identical, `properties.bin` identical, `properties.json` identical, `scene.bin` identical, `scene.gltf` identical, `spatial.bin` identical, in all five pairs; package digest `05707534c73ce126da401a79481d0fd6c892bc308a451d6aa2a4b1691bc2439e` in both arms.

## Gate 2: exact decisions

Every accepted transport sample reports the unchanged documents as artifact
hits and the changed document as the only miss, and its ledger names each
unchanged artifact `verified` and the changed one `absent`; the record pins
that the decision block is identical across samples. The refusal paths --
corrupt, truncated, tampered payload, wrong key input, superseded-schema (`.1`)
file at the same path -- each carry a named `artifactInvalidReason` and
re-extract, in
[`test_document_artifact_cache.py`](../../../native/adapter-ifc/tests/test_document_artifact_cache.py).
Since slice 3b the compiler's own verdict is pinned as well: every transport
sample's `assembly` block is `assembled` and names every document, and every
clean sample's is `null`; a compiler-side mismatch would instead have recorded
a `fallback` with its reason and one monolithic adapter run, which the validity
rule rejects and the
[fallback test](../../../packages/compiler/test/ifc-federation.test.ts)
exercises on a deliberately corrupted artifact.

## Gate 3: restore bounded by one read and one hash

`naru.ifc-document-artifact.4` stores one gzip stream: a canonical-JSON header
line (`key`, `keyInput`, `payloadBytes`, `structureBytes`, `payloadSha256`,
`schemaVersion`) followed by exactly `payloadBytes` bytes of payload. That
payload is the canonical structure JSON and then, each padded to an eight-byte
boundary, the geometry arrays and -- since slice 3a -- the property value heap
with its three offset columns, all as raw little-endian binary regions in a
fixed field order, so restoring geometry or a property value is a typed-array
view rather than a parse. Verification is the header checks plus one SHA-256 over
the whole stored payload region; the parse happens only afterwards and is
ledgered separately (`artifactParseMilliseconds`), so neither figure can hide
a re-serialization. In manifest mode the adapter still performs exactly this
verification before it writes the manifest, so the gate measures the same
adapter stages in both slices; the compiler's second verification of the same
files sits inside `assembleFederation` and is reported under gate 4.
The gate is operationalized as a ratio: the adapter's
`artifactLoadMilliseconds + artifactVerifyMilliseconds` over the unchanged
documents against the same read, gunzip, and SHA-256 of the same files
performed in the recorder process once per sample, met when the adapter
median is at most 2× the reference median.

| Unchanged documents, ms (median [min, max]) | Digital Hub | sixty5 |
|---|---|---|
| adapter load (read + gunzip + header) | 117.2 [107.5, 127.3] | 787.7 [770.4, 813.2] |
| adapter verify (one SHA-256 of stored payload bytes) | 25.3 [25.3, 25.5] | 231.0 [227.3, 231.9] |
| adapter load + verify | 142.6 [132.8, 152.6] | 1,019.3 [998.7, 1,044.2] |
| recorder reference read + gunzip + hash | 100.6 [95.7, 104.1] | 790.6 [767.3, 804.7] |
| ratio adapter / reference (bound 2.0) | 1.417 | 1.289 |
| adapter parse, ledgered apart | 134.8 [125.7, 138.2] | 2,639.2 [2,489.3, 2,758.6] |
| artifact bytes on disk / payload bytes | 13,241,792 / 64,227,000 | 76,330,858 / 580,107,408 |
| gate 0 (`.1`, commit `69d67e5`, other session) load / verify | 899.3 / 4,434.2 | 8,310.4 / 34,204.2 |

The gate 0 row is the `.1` format's `_canonical_sha256` re-serialization
that slice 1 replaced, quoted for scale only (Digital Hub verify moved from
4,434.2 to 25.3 ms, sixty5 from 34,204.2 to 231.0 ms); the gate
itself is the same-session ratio.

## Gate 4: whole process against the same-session clean rebuild

| Whole process | Digital Hub transport | Digital Hub clean | sixty5 transport | sixty5 clean |
|---|---|---|---|---|
| process ms, median | 9,268.1 | 51,334.8 | 54,056.5 | 312,209.0 |
| process ms, [min, max] | [9,138.1, 9,458.9] | [50,473.4, 54,870.9] | [50,626.5, 54,725.8] | [311,640.7, 325,828.9] |
| clean spread (max − min) / required saving (> 3×) | | 4,397.5 / 13,192.5 |  | 14,188.2 / 42,564.6 |
| saving, ms (ratio transport / clean) | 42,066.7 (0.181) | | 258,152.5 (0.173) |  |
| peak working set, median B | 434,372,608 | 1,838,301,184 | 3,257,085,952 | 4,620,410,880 |
| peak private bytes, median B | 903,065,600 | 2,398,482,432 | 3,445,227,520 | 5,285,433,344 |

Both arms are fresh processes recorded in this session, interleaved per
index. The clean arm's cost is dominated by extracting the unchanged
documents (Digital Hub `heating` 13,062.8 ms, `plumbing` 23,746.4 ms,
`ventilation` 5,227.8 ms against the changed `architecture` 4,282.0 ms), which
is exactly the work the artifact tier removes; the transport arm pays
restore (load + verify + parse, 266.4 ms over three documents on Digital Hub)
plus the publish of the re-extracted document (725.0 ms), and since slice 3b
the compiler's assembly of the federation (1,817.7 ms) in place of the
adapter's merge, Scene IR writes, and the compiler's read of that Scene IR.

Both arms are re-recorded in every session that reports this gate, because
the host's foreground load moves the absolutes: the clean Digital Hub median
was 50,028.4 ms in the slice-1 session, 52,570.5 ms in the slice-2 one,
53,754.4 ms in the slice-3a one, and 51,334.8 ms in this one. That is why the
rule compares against a same-session clean arm and never against a committed
absolute; neither figure is a regression of the other.

What this gate does **not** establish: the `.1` record never measured a clean
arm, so whether slice 1 alone flipped the verdict is not recorded. Slice 1's
own effect is gate 3's verify column, slices 2 and 3a both move its parse
and byte columns, and slice 3b moves the transport arm's adapter and compiler
stage rows below. No slice is what carries this gate --
the tier's saving is the extraction it skips, and it already cleared the bar
after slice 1 -- so each later slice's job here is to show the saving did not
shrink. Gate 4 is re-run after every slice and its rule does not change: a
failure at any slice marks ADR-0019 Rejected. This is the record that closes
slice 3b, and with it the ADR.

## Where the time goes (medians over five samples, ms)

Digital Hub, transport arm against clean arm. Compiler stages sum with
`unattributed` to the compile total; adapter ledger stages sit inside the
adapter process's `main`; every closure check held in all ten samples. In the
transport arm the adapter has no federation merge, property index, or Scene IR
write stages -- it writes the manifest -- and the compiler has no `readSceneIr`;
the clean arm has no `assembleFederation`.

| Stage | Transport | Clean |
|---|---|---|
| whole process | 9,268.1 | 51,334.8 |
| compile total (in-process) | 9,171.9 | 51,223.3 |
| harness overhead (process − compile) | 98.6 | 115.4 |
| `adapter` stage (spawn to close) | 5,670.2 | 48,061.3 |
| adapter interpreter start + imports | 58.5 + 220.0 | 62.7 + 225.2 |
| adapter `main` | 5,357.0 | 47,672.2 |
| changed `architecture` extract / publish | 4,227.9 / 725.0 | 4,282.0 / — |
| unchanged `heating` load / verify / parse or extract | 39.0 / 9.8 / 56.7 | 13,062.8 |
| unchanged `plumbing` load / verify / parse or extract | 56.1 / 10.7 / 32.6 | 23,746.4 |
| unchanged `ventilation` load / verify / parse or extract | 17.3 / 4.9 / 39.3 | 5,227.8 |
| federation merge / property index (adapter) | — | 9.1 / 55.3 |
| adapter writes: manifest, or structure / geometry / properties / digest | manifest 0.8 | 691.5 / 244.8 / 9.1 / 59.5 |
| `toolchainIdentity` / `cacheLookup` / `cachePublish` | 363.4 / 0.3 / 75.0 | 0.0 / 0.0 / 0.0 |
| `assembleFederation` (compiler restore + merge + serialize) | 1,817.7 | 0.0 |
| `readSceneIr` (structure scan inside it) | 0.0 (0.0) | 1,919.4 (1,914.2) |
| `compile`: validate / encode / measure / other | 111.2 / 331.5 / 193.4 / 261.4 | 95.3 / 342.4 / 192.9 / 217.8 |
| `dependencyIndex` / `writePackage` / `writeDependencyIndex` | 47.7 / 173.3 / 8.7 | 34.9 / 175.7 / 8.6 |
| in-process compiler work (compile total − adapter stage) | 3,499.6 | 3,092.1 |

The in-process compiler work differs between the arms by the cache identity
and publish stages (`toolchainIdentity` 363.4 ms hashes the compiler module
directory; `cachePublish` 75.0 ms), which the clean arm skips because it has
no cache directory, and by `assembleFederation` standing where `readSceneIr`
stood: 1,817.7 ms to restore, verify, merge, and re-serialize four artifacts
against 1,919.4 ms to scan the merged structure the adapter wrote.

Slice 3b shows up in two places on this model, against the slice-3a record at
commit `e64adcc` (another session, reference only). The transport arm's adapter
stage fell from 6,611.3 to 5,670.2 ms because manifest mode has no federation
merge (7.0 ms), no property index (62.2 ms), and no Scene IR writes (structure
674.7, geometry 82.2, properties 9.8, digest 57.9 ms): the adapter verifies the
artifacts, re-extracts and publishes the changed document, and writes a
manifest in 0.8 ms. On the compiler side `readSceneIr` (1,934.8 ms in that
record) is gone and `assembleFederation` costs 1,817.7 ms -- the same order of
work, because the compiler must still produce the canonical structure text the
package digest is computed from, only now from four artifacts instead of one
merged file. The transport whole-process median moved from 10,302.4 to
9,268.1 ms between the two sessions; only the adapter-write and merge
removal is attributable to the slice, the rest is host drift the clean arm
also shows (53,754.4 to 51,334.8 ms). Gate 3's columns did not move (load
115.7 to 117.2 ms, verify 25.6 to 25.3, parse 136.7 to 134.8), as they should
not: the adapter's verification is the same code in both modes.

sixty5, same layout:

| Stage | Transport | Clean |
|---|---|---|
| whole process | 54,056.5 | 312,209.0 |
| compile total (in-process) | 53,823.3 | 311,847.3 |
| harness overhead (process − compile) | 233.2 | 380.9 |
| `adapter` stage (spawn to close) | 11,457.3 | 274,441.5 |
| adapter interpreter start + imports | 58.3 + 219.2 | 63.9 + 223.2 |
| adapter `main` | 11,127.7 | 273,494.3 |
| unchanged `architecture` load / verify / parse or extract | 170.6 / 45.9 / 435.7 | 71,901.7 |
| unchanged `electrical` load / verify / parse or extract | 153.4 / 52.3 / 534.9 | 43,518.3 |
| unchanged `facade` load / verify / parse or extract | 3.7 / 1.0 / 7.2 | 1,267.1 |
| unchanged `kitchen` load / verify / parse or extract | 34.6 / 8.1 / 28.0 | 15,216.5 |
| unchanged `plumbing` load / verify / parse or extract | 263.3 / 78.9 / 1,056.9 | 76,906.1 |
| changed `structure` extract / publish | 5,598.9 / 939.1 | 5,319.9 / — |
| unchanged `ventilation` load / verify / parse or extract | 161.8 / 43.7 / 557.0 | 46,733.7 |
| federation merge / property index (adapter) | — | 145.9 / 956.1 |
| adapter writes: manifest, or structure / geometry / properties / digest | manifest 0.8 | 9,114.7 / 1,592.7 / 117.8 / 389.9 |
| `toolchainIdentity` / `cacheLookup` / `cachePublish` | 379.5 / 0.3 / 922.3 | 0.0 / 0.0 / 0.0 |
| `assembleFederation` (compiler restore + merge + serialize) | 25,990.8 | 0.0 |
| `readSceneIr` (structure scan inside it) | 0.0 (0.0) | 25,424.6 (25,382.8) |
| `compile`: validate / encode / measure / other | 1,404.3 / 3,101.9 / 2,123.4 / 3,936.0 | 1,121.1 / 2,634.2 / 2,060.9 / 3,114.1 |
| `dependencyIndex` / `writePackage` / `writeDependencyIndex` | 1,140.8 / 1,907.2 / 210.6 | 838.7 / 1,701.6 / 107.1 |
| in-process compiler work (compile total − adapter stage) | 42,363.3 | 37,370.8 |

Slice 3b on sixty5, against the slice-3a record at commit `e64adcc` (another
session, reference only). The transport arm's adapter stage fell from 23,163.0
to 11,457.3 ms: manifest mode has no federation merge (98.9 ms in that record),
no property index (1,045.2 ms), and no Scene IR writes (structure 8,620.8,
geometry 544.4, properties 115.4, digest 371.7 ms), and the inspection loop
releases each document after naming its artifact instead of holding seven for
the merge. On the compiler side `readSceneIr` (25,191.9 ms in that record,
25,424.6 ms in this session's clean arm) is gone and `assembleFederation` costs
25,990.8 ms: restoring, verifying, merging, and canonically re-serializing
362,856,725 structure bytes across seven artifacts is the same order of work as
scanning the merged structure the adapter used to write, so on this model the
slice's saving is the adapter's, not the compiler's. The transport
whole-process median moved from 61,672.4 to 54,056.5 ms between the two
sessions, less than the adapter-stage drop, because the assembly costs more than
the scan it replaced and the compiler stages behind it run slower: the
transport arm's in-process compiler work is 42,363.3 ms against the clean arm's
37,370.8 ms, carrying the cache identity and publish stages (379.5 and 922.3 ms)
and `compile`, `dependencyIndex`, and `writePackage` stages that run 1.7, 0.3,
and 0.2 s slower than the clean arm's, which this record does not attribute
further. The clean arm moved from 316,082.6 to 312,209.0 ms, so part of the
whole-process difference is host drift both arms show. Peak working set in the
transport arm rose from 2.96 to 3.26 GB -- the compiler now holds the seven
artifact payloads and the assembled structure at once -- and stays 1.36 GB
under the clean arm's 4.62 GB, so gate 4's memory clause holds with less margin
than at slice 3a. Gate 3's load and verify columns did not move (788.5 to
787.7 ms, 229.5 to 231.0 ms); the parse column fell from 3,664.1 to 2,639.2 ms,
and the only change on that path is that the manifest loop drops each document
after inspecting it -- whether that or session drift explains the difference is
not separated by this record.

## Caveats carried in the JSON

- Package digests are host-local (the IFC adapter's split Scene IR differs by
  a few bytes across hosts, as every IFC record since the localized traces
  notes); the validator pins them and its comment says not to retarget.
- Host load was not controlled. The interleaved ordering makes drift land on
  both arms, and both arms' minimum-to-maximum spread is recorded; gate 4's
  bar is three clean spreads, so a noisy session raises the bar rather than
  the verdict.
- The gate 0 figures quoted here come from the `.1` artifact format at commit
  `69d67e5`, another session on the same host; these records carry them under
  `gates.gate3.gate0` with `source` naming that provenance, and no gate is
  decided against them. The slice-3a figures quoted come from commit
  `e64adcc`, likewise another session.
- The arms are no longer the same code path end to end: the transport arm's
  package is assembled by the compiler and the clean arm's by the adapter.
  That is the point of the slice, and gate 1 is what makes the comparison
  legitimate -- both arms write the same bytes.
- `workingTreeClean` is `false` in both records: they were recorded on the
  slice branch before its commit, as every evidence record that changes the
  code it measures must be.

## Files

- `digital-hub.json`, `sixty5.json`: the records (schema
  `naru.rebuild-stage-evidence.3`), each carrying the fixture manifest digest
  and per-document source digests, the changed-document edit, adapter
  identity, compile options (`assembleFederation: true`), the protocol text,
  warm-up, every accepted and discarded sample of both arms with its full
  stage ledger and, for transport samples, the compiler's `assembly` block,
  closure checks, distributions, and the four gate blocks.
- Recorder: [`scripts/record-rebuild-stage-evidence.mjs`](../../../scripts/record-rebuild-stage-evidence.mjs),
  over [`scripts/lib/ifc-cache-sample.mjs`](../../../scripts/lib/ifc-cache-sample.mjs)
  and [`scripts/lib/process-tree-sampler.mjs`](../../../scripts/lib/process-tree-sampler.mjs).
- Validator: [`scripts/validate-rebuild-stage-evidence.mjs`](../../../scripts/validate-rebuild-stage-evidence.mjs)
  (`pnpm cache:stages:check`), which pins package digests, sample counts,
  closure, the exclusion list, the decision block, the assembly verdicts of
  both arms, the gate 3 bound, and the gate 4 arithmetic and verdicts.
