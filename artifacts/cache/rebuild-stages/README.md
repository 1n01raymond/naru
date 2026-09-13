# Changed-discipline rebuild: transport through stored-byte artifacts vs clean

Status: recorded evidence for
[ADR-0019](../../../docs/adr/0019-document-artifact-transport.md) slices 1 and
2 (stored-byte document-artifact verification, then geometry carried as raw
binary regions beside the structure JSON -- `naru.ifc-document-artifact.3`),
measured against the ADR's gates 1-4. The
record compiles a one-document-changed federation of Digital Hub and sixty5
two ways in the same session -- **transport** (every unchanged document
restored from its verified artifact, the changed one re-extracted) and
**clean** (no cache directory at all: every document extracted, nothing looked
up, restored, or published) -- five fresh-process samples per arm, interleaved
per index, using the predeclared-sample protocol of
[`../sixty5/`](../sixty5/README.md). Schema `naru.rebuild-stage-evidence.2`,
mode `fresh-process-changed-discipline-transport-vs-clean-rebuild`.

The previous version of this record (`naru.rebuild-stage-evidence.1`, commit
`69d67e5`) was the ADR's gate 0: the same transport rebuild decomposed into
stages with no clean arm, which fixed the stage shares the ADR argues from and
recorded that the ADR's exploratory attribution did not reproduce. Those
verdicts are stated in the ADR; this version supersedes the file, not the
verdicts. Where this README quotes gate 0 numbers they come from that commit
and from another session, so they are reference only, never a same-session
comparison.

One record per model: [`digital-hub.json`](digital-hub.json) (four-document
`ifc-bench-digital-hub`, MIT; changed discipline `architecture`) and
[`sixty5.json`](sixty5.json) (seven-document, 839.9 MB `ifc-bench-sixty5`,
CC BY 4.0; changed discipline `structure`), both from
`fixtures/external/manifest.json`. Validator: `pnpm cache:stages:check`.
Re-record: `pnpm cache:stages:evidence -- --model digital-hub` and
`-- --model sixty5`, with `NARU_IFC_PYTHON` pointing at the IfcOpenShell
interpreter. The warm-up is a cold extraction of the original federation
(Digital Hub 55.4 s, sixty5 317.4 s); each sample pair then costs
one transport rebuild plus one clean rebuild.

## Verdicts, pinned by the validator

| Gate | Digital Hub | sixty5 |
|---|---|---|
| 1 byte identity | Met: 10 of 11 package files identical, `adapter-report.json` identical outside the one excluded key; package digest `c4b151e5…` in both arms | Met: 10 of 11 package files identical, `adapter-report.json` identical outside the one excluded key; package digest `05707534…` in both arms |
| 2 exact decisions | Met: hits `heating`, `plumbing`, `ventilation`; miss `architecture`; ledger states `verified` ×3, `absent` ×1, identical in all five samples | Met: hits `architecture`, `electrical`, `facade`, `kitchen`, `plumbing`, `ventilation`; miss `structure`; ledger states `verified` ×6, `absent` ×1, identical in all five samples |
| 3 restore cost | Met: adapter load+verify 154.7 ms vs 107.4 ms in-recorder read+gunzip+hash reference, ratio 1.44 (bound 2×) | Met: adapter load+verify 1,436.6 ms vs 1,052.9 ms in-recorder read+gunzip+hash reference, ratio 1.364 (bound 2×) |
| 4 faster than clean, memory no higher | Met: 10,631.0 ms vs 52,570.5 ms whole process (saving 41,939.5 ms, required > 11,026.2); peak working set 0.48 GB vs 1.83 GB | Met: 70,667.5 ms vs 317,588.2 ms whole process (saving 246,920.7 ms, required > 23,595.0); peak working set 3.61 GB vs 5.11 GB |

The Digital Hub package digest is the one the `.1` and `.2` artifact formats
published for the same edit, so neither format change moved a package byte.

## Protocol, fixed before any result was read

- **Process isolation.** Every sample and the warm-up is one fresh
  `node scripts/lib/ifc-cache-sample.mjs` process; the adapter is a fresh
  Python process inside it.
- **Cache state.** The warm-up extracts the original federation once
  (adapter only) so every document artifact is warm. Before each transport
  sample the package cache entries and the changed document's artifact are
  deleted; the unchanged documents' artifacts stay. Each transport sample
  therefore restores every unchanged document and re-extracts the changed
  one, and its package cache lookup is a miss. Each clean sample compiles the
  same changed federation with no cache directory.
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
  file, never the report); compiler stages from `stageTiming: true`. Neither
  touches a package byte: every transport sample's package digest must equal
  the first transport sample's, and every clean sample's the first clean
  sample's.
- **Sample validity.** A transport sample counts only when the process exits
  0, the package cache misses, the artifact hits are exactly the unchanged
  documents and the miss exactly the changed one, no warning is emitted, the
  ledger is present, and the digest matches. A clean sample counts only when
  the process exits 0, both caches report `disabled`, no warning is emitted,
  the ledger is present, and the digest matches. Up to three attempts per
  index and arm; every discarded attempt is recorded (none was discarded on
  either model). Byte identity across the arms is gate 1's verdict, never a
  validity rule.
- **Statistics.** Median, nearest-rank p95, minimum, maximum over the accepted
  samples of each arm. Peak memory is the OS-sampled Windows process tree.
- **Uncontrolled.** Other processes on the host, disk cache state between
  samples, CPU frequency scaling.

## Gate 1: byte identity

Every file the transport rebuild writes is compared with the file the clean
rebuild of the same index writes. The reports in the closed exclusion list --
exactly `adapter-report.json:documentArtifactCache`, the same single entry
the ADR-0018 record used, with no additions -- are compared as canonical JSON
after deleting the excluded key; everything else by SHA-256. Digital Hub:
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
corrupt, truncated, tampered payload, wrong key input, previous-schema (`.2`)
file at the same path -- each carry a named `artifactInvalidReason` and
re-extract, in
[`test_document_artifact_cache.py`](../../../native/adapter-ifc/tests/test_document_artifact_cache.py).

## Gate 3: restore bounded by one read and one hash

`naru.ifc-document-artifact.3` stores one gzip stream: a canonical-JSON header
line (`key`, `keyInput`, `payloadBytes`, `structureBytes`, `payloadSha256`,
`schemaVersion`) followed by exactly `payloadBytes` bytes of payload. Since
slice 2 that payload is the canonical structure JSON, zero padding to an
eight-byte boundary, and then the geometry arrays as raw little-endian binary
regions in a fixed field order, so restoring geometry is a typed-array view
rather than a parse. Verification is the header checks plus one SHA-256 over
the whole stored payload region; the parse happens only afterwards and is
ledgered separately (`artifactParseMilliseconds`), so neither figure can hide
a re-serialization.
The gate is operationalized as a ratio: the adapter's
`artifactLoadMilliseconds + artifactVerifyMilliseconds` over the unchanged
documents against the same read, gunzip, and SHA-256 of the same files
performed in the recorder process once per sample, met when the adapter
median is at most 2× the reference median.

| Unchanged documents, ms (median [min, max]) | Digital Hub | sixty5 |
|---|---|---|
| adapter load (read + gunzip + header) | 126.0 [116.5, 134.1] | 1,108.5 [1,098.2, 1,150.5] |
| adapter verify (one SHA-256 of stored payload bytes) | 28.7 [28.6, 29.1] | 329.0 [328.0, 332.4] |
| adapter load + verify | 154.7 [145.1, 163.2] | 1,436.6 [1,430.7, 1,480.4] |
| recorder reference read + gunzip + hash | 107.4 [103.6, 124.7] | 1,052.9 [1,024.2, 1,107.7] |
| ratio adapter / reference (bound 2.0) | 1.44 | 1.364 |
| adapter parse, ledgered apart | 167.3 [163.3, 202.0] | 3,161.0 [3,106.2, 3,500.1] |
| artifact bytes on disk / payload bytes | 13,178,145 / 72,677,504 | 92,975,427 / 834,931,820 |
| gate 0 (`.1`, commit `69d67e5`, other session) load / verify | 899.3 / 4,434.2 | 8,310.4 / 34,204.2 |

The gate 0 row is the `.1` format's `_canonical_sha256` re-serialization
that this slice replaces, quoted for scale only (Digital Hub verify moved from
4,434.2 to 28.7 ms, sixty5 from 34,204.2 to 329.0 ms); the gate
itself is the same-session ratio.

## Gate 4: whole process against the same-session clean rebuild

| Whole process | Digital Hub transport | Digital Hub clean | sixty5 transport | sixty5 clean |
|---|---|---|---|---|
| process ms, median | 10,631.0 | 52,570.5 | 70,667.5 | 317,588.2 |
| process ms, [min, max] | [10,554.5, 10,651.5] | [50,486.0, 54,161.4] | [70,300.1, 70,919.9] | [312,812.0, 320,677.0] |
| clean spread (max − min) / required saving (> 3×) | | 3,675.4 / 11,026.2 | | 7,865.0 / 23,595.0 |
| saving, ms (ratio transport / clean) | 41,939.5 (0.202) | | 246,920.7 (0.223) | |
| peak working set, median B | 479,895,552 | 1,826,594,816 | 3,610,386,432 | 5,109,145,600 |
| peak private bytes, median B | 969,293,824 | 2,376,212,480 | 4,080,107,520 | 5,767,655,424 |

Both arms are fresh processes recorded in this session, interleaved per
index. The clean arm's cost is dominated by extracting the unchanged
documents (Digital Hub `heating` 13,091.0 ms, `plumbing` 25,105.6 ms,
`ventilation` 5,111.6 ms against the changed `architecture` 4,123.8 ms), which
is exactly the work the artifact tier removes; the transport arm pays
restore (load + verify + parse, 326.5 ms over three documents on Digital Hub)
plus the publish of the re-extracted document (739.2 ms).

Both arms are re-recorded in every session that reports this gate, because
the host's foreground load moves the absolutes: the clean Digital Hub median
was 50,028.4 ms in the slice-1 session and 52,570.5 ms in the slice-2 one. That
is why the rule compares against a same-session clean arm and never against a
committed absolute; neither figure is a regression of the other.

What this gate does **not** establish: the `.1` record never measured a clean
arm, so whether slice 1 alone flipped the verdict is not recorded. Slice 1's
own effect is gate 3's verify column, slice 2's is its parse column. Neither
slice is what carries this gate -- the tier's saving is the extraction it
skips, and it already cleared the bar after slice 1 -- so slice 2's job here is
to show the saving did not shrink. Gate 4 is re-run after every slice and its
rule does not change: a failure at any slice marks ADR-0019 Rejected.

## Where the time goes (medians over five samples, ms)

Digital Hub, transport arm against clean arm. Compiler stages sum with
`unattributed` to the compile total; adapter ledger stages sit inside the
adapter process's `main`; every closure check held in all ten samples.

| Stage | Transport | Clean |
|---|---|---|
| whole process | 10,631.0 | 52,570.5 |
| compile total (in-process) | 10,520.5 | 52,444.2 |
| harness overhead (process − compile) | 109.5 | 131.3 |
| `adapter` stage (spawn to close) | 6,952.0 | 49,395.9 |
| adapter interpreter start + imports | 66.6 + 240.2 | 74.1 + 247.8 |
| adapter `main` | 6,559.7 | 48,981.6 |
| changed `architecture` extract / publish | 4,109.0 / 739.2 | 4,123.8 / — |
| unchanged `heating` load / verify / parse or extract | 43.7 / 11.2 / 68.4 | 13,091.0 |
| unchanged `plumbing` load / verify / parse or extract | 58.3 / 11.5 / 42.1 | 25,105.6 |
| unchanged `ventilation` load / verify / parse or extract | 21.8 / 6.0 / 56.5 | 5,111.6 |
| federation merge / property index | 5.4 / 449.9 | 6.6 / 553.5 |
| Scene IR writes: structure / geometry / properties / digest | 670.0 / 77.5 / 8.9 / 59.5 | 706.0 / 250.0 / 9.1 / 57.9 |
| `toolchainIdentity` / `cacheLookup` / `cachePublish` | 401.0 / 0.5 / 71.8 | 0.0 / 0.0 / 0.0 |
| `readSceneIr` (structure scan inside it) | 1,931.7 (1,926.9) | 1,924.1 (1,919.3) |
| `compile`: validate / encode / measure / other | 94.8 / 336.5 / 195.2 / 231.4 | 94.6 / 338.7 / 184.1 / 226.1 |
| `dependencyIndex` / `writePackage` / `writeDependencyIndex` | 35.6 / 168.5 / 10.1 | 34.6 / 171.3 / 9.3 |
| in-process compiler work (compile total − adapter stage) | 3,534.3 | 3,075.3 |

The in-process compiler work is the same in both arms apart from the cache
identity and publish stages (`toolchainIdentity` 401.0 ms hashes the
compiler module directory; `cachePublish` 71.8 ms), which the clean arm skips
because it has no cache directory; that 473 ms is the transport arm's price
for a warm package cache on the next reopen.

Slice 2 shows up in three places on this model, against the slice-1 record at
commit `f38e673`. The artifact parse it targets fell from 650.6 to 167.3 ms
over the three unchanged documents, because geometry is now a typed-array view
of stored bytes instead of JSON number lists; the artifacts got smaller with
it (14,018,134 to 13,178,145 bytes on disk, 85,976,206 to 72,677,504 payload
bytes), which also moved load from 167.5 to 126.0 ms and verify from 34.1 to
28.7 ms. The unlooked-for third place is the adapter's own Scene IR geometry
write, 232.2 to 77.5 ms: restored geometry now reaches the writer as typed
arrays, so it no longer converts Python lists. What slice 2 did **not** move is
the compiler's structure scan (`readSceneIr`, 1.9 s here, flat across both arms
and both records) -- that is slice 3's target, not this one's.

sixty5, same layout:

| Stage | Transport | Clean |
|---|---|---|
| whole process | 70,667.5 | 317,588.2 |
| compile total (in-process) | 70,422.4 | 317,190.4 |
| harness overhead (process − compile) | 230.5 | 397.8 |
| `adapter` stage (spawn to close) | 32,152.0 | 279,711.0 |
| adapter interpreter start + imports | 70.8 + 236.8 | 75.5 + 242.3 |
| adapter `main` | 31,206.6 | 278,718.5 |
| unchanged `architecture` load / verify / parse or extract | 396.3 / 104.5 / 932.7 | 68,331.6 |
| unchanged `electrical` load / verify / parse or extract | 173.8 / 63.5 / 591.4 | 41,553.9 |
| unchanged `facade` load / verify / parse or extract | 5.8 / 1.8 / 14.0 | 1,215.4 |
| unchanged `kitchen` load / verify / parse or extract | 39.8 / 10.4 / 51.2 | 15,806.2 |
| unchanged `plumbing` load / verify / parse or extract | 319.5 / 99.3 / 1,058.2 | 77,343.9 |
| changed `structure` extract / publish | 5,913.0 / 916.3 | 5,529.8 / — |
| unchanged `ventilation` load / verify / parse or extract | 168.4 / 49.5 / 491.7 | 46,007.2 |
| federation merge / property index | 82.8 / 9,208.9 | 99.0 / 10,155.8 |
| Scene IR writes: structure / geometry / properties / digest | 8,640.9 / 564.9 / 113.1 / 379.1 | 8,974.3 / 1,579.4 / 114.4 / 387.7 |
| `toolchainIdentity` / `cacheLookup` / `cachePublish` | 407.7 / 0.3 / 623.6 | 0 / 0 / 0 |
| `readSceneIr` (structure scan inside it) | 25,251.1 (25,208.2) | 25,174.3 (25,133.6) |
| `compile`: validate / encode / measure / other | 1,121.0 / 2,513.4 / 1,905.0 / 2,921.7 | 1,140.8 / 2,545.6 / 2,102.5 / 3,000.6 |
| `dependencyIndex` / `writePackage` / `writeDependencyIndex` | 783.4 / 1,779.6 / 109.9 | 774.9 / 1,758.0 / 111.3 |
| in-process compiler work (compile total − adapter stage) | 38,270.4 | 37,479.4 |

The same three places move on sixty5, at the scale that makes them worth the
format bump. Artifact parse over the six unchanged documents fell from 5,482.0
to 3,161.0 ms; the artifacts shrank from 101,185,751 to 92,975,427 bytes on
disk and from 898,258,653 to 834,931,820 payload bytes, which carried load
from 1,312.1 to 1,108.5 ms and verify from 353.0 to 329.0 ms; and the adapter's
Scene IR geometry write fell from 1,369.3 to 564.9 ms. `readSceneIr` is flat
again -- 25,251.1 ms in the transport arm against 25,174.3 in the clean one,
with the structure scan inside it 25,208.2 against 25,133.6 -- which is the
25-second reason slice 3 exists.

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
  decided against them.
- `workingTreeClean` is `false` in both records: they were recorded on the
  slice branch before its commit, as every evidence record that changes the
  code it measures must be.

## Files

- `digital-hub.json`, `sixty5.json`: the records (schema
  `naru.rebuild-stage-evidence.2`), each carrying the fixture manifest digest
  and per-document source digests, the changed-document edit, adapter
  identity, compile options, the protocol text, warm-up, every accepted and
  discarded sample of both arms with its full stage ledger, closure checks,
  distributions, and the four gate blocks.
- Recorder: [`scripts/record-rebuild-stage-evidence.mjs`](../../../scripts/record-rebuild-stage-evidence.mjs),
  over [`scripts/lib/ifc-cache-sample.mjs`](../../../scripts/lib/ifc-cache-sample.mjs)
  and [`scripts/lib/process-tree-sampler.mjs`](../../../scripts/lib/process-tree-sampler.mjs).
- Validator: [`scripts/validate-rebuild-stage-evidence.mjs`](../../../scripts/validate-rebuild-stage-evidence.mjs)
  (`pnpm cache:stages:check`), which pins package digests, sample counts,
  closure, the exclusion list, the decision block, the gate 3 bound, and the
  gate 4 arithmetic and verdicts.
