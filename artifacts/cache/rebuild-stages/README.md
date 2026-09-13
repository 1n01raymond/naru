# Changed-discipline rebuild: transport through stored-byte artifacts vs clean

Status: recorded evidence for
[ADR-0019](../../../docs/adr/0019-document-artifact-transport.md) slices 1, 2,
and 3a (stored-byte document-artifact verification, then geometry carried as
raw binary regions beside the structure JSON, then the property value columns
carried the same way -- `naru.ifc-document-artifact.4`),
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
(Digital Hub 57.2 s, sixty5 313.2 s); each sample pair then costs
one transport rebuild plus one clean rebuild.

## Verdicts, pinned by the validator

| Gate | Digital Hub | sixty5 |
|---|---|---|
| 1 byte identity | Met: 10 of 11 package files identical, `adapter-report.json` identical outside the one excluded key; package digest `c4b151e5…` in both arms | Met: 10 of 11 package files identical, `adapter-report.json` identical outside the one excluded key; package digest `05707534…` in both arms |
| 2 exact decisions | Met: hits `heating`, `plumbing`, `ventilation`; miss `architecture`; ledger states `verified` ×3, `absent` ×1, identical in all five samples | Met: hits `architecture`, `electrical`, `facade`, `kitchen`, `plumbing`, `ventilation`; miss `structure`; ledger states `verified` ×6, `absent` ×1, identical in all five samples |
| 3 restore cost | Met: adapter load+verify 141.6 ms vs 99.8 ms in-recorder read+gunzip+hash reference, ratio 1.419 (bound 2×) | Met: adapter load+verify 1,016.1 ms vs 751.3 ms in-recorder read+gunzip+hash reference, ratio 1.352 (bound 2×) |
| 4 faster than clean, memory no higher | Met: 10,302.4 ms vs 53,754.4 ms whole process (saving 43,452.0 ms, required > 4,434.3); peak working set 0.44 GB vs 1.85 GB | Met: 61,672.4 ms vs 316,082.6 ms whole process (saving 254,410.2 ms, required > 17,402.1); peak working set 2.96 GB vs 4.63 GB |

The Digital Hub package digest is the one every artifact format so far --
`.1`, `.2`, `.3`, and now `.4` -- published for the same edit, so no format
change has moved a package byte.

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
corrupt, truncated, tampered payload, wrong key input, superseded-schema (`.1`)
file at the same path -- each carry a named `artifactInvalidReason` and
re-extract, in
[`test_document_artifact_cache.py`](../../../native/adapter-ifc/tests/test_document_artifact_cache.py).

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
a re-serialization.
The gate is operationalized as a ratio: the adapter's
`artifactLoadMilliseconds + artifactVerifyMilliseconds` over the unchanged
documents against the same read, gunzip, and SHA-256 of the same files
performed in the recorder process once per sample, met when the adapter
median is at most 2× the reference median.

| Unchanged documents, ms (median [min, max]) | Digital Hub | sixty5 |
|---|---|---|
| adapter load (read + gunzip + header) | 115.7 [110.1, 124.0] | 788.5 [771.5, 796.0] |
| adapter verify (one SHA-256 of stored payload bytes) | 25.6 [25.3, 26.1] | 229.5 [227.3, 234.3] |
| adapter load + verify | 141.6 [135.5, 150.1] | 1,016.1 [1,001.0, 1,030.3] |
| recorder reference read + gunzip + hash | 99.8 [99.0, 106.4] | 751.3 [737.7, 806.9] |
| ratio adapter / reference (bound 2.0) | 1.419 | 1.352 |
| adapter parse, ledgered apart | 136.7 [127.2, 152.2] | 3,664.1 [3,606.5, 4,065.9] |
| artifact bytes on disk / payload bytes | 13,241,820 / 64,227,000 | 76,330,857 / 580,107,408 |
| gate 0 (`.1`, commit `69d67e5`, other session) load / verify | 899.3 / 4,434.2 | 8,310.4 / 34,204.2 |

The gate 0 row is the `.1` format's `_canonical_sha256` re-serialization
that this slice replaces, quoted for scale only (Digital Hub verify moved from
4,434.2 to 25.6 ms, sixty5 from 34,204.2 to 229.5 ms); the gate
itself is the same-session ratio.

## Gate 4: whole process against the same-session clean rebuild

| Whole process | Digital Hub transport | Digital Hub clean | sixty5 transport | sixty5 clean |
|---|---|---|---|---|
| process ms, median | 10,302.4 | 53,754.4 | 61,672.4 | 316,082.6 |
| process ms, [min, max] | [10,250.5, 10,373.8] | [52,925.9, 54,404.0] | [61,200.8, 62,097.0] | [315,233.9, 321,034.6] |
| clean spread (max − min) / required saving (> 3×) | | 1,478.1 / 4,434.3 | | 5,800.7 / 17,402.1 |
| saving, ms (ratio transport / clean) | 43,452.0 (0.192) | | 254,410.2 (0.195) | |
| peak working set, median B | 441,708,544 | 1,853,497,344 | 2,961,584,128 | 4,626,833,408 |
| peak private bytes, median B | 905,908,224 | 2,394,624,000 | 3,208,630,272 | 5,283,778,560 |

Both arms are fresh processes recorded in this session, interleaved per
index. The clean arm's cost is dominated by extracting the unchanged
documents (Digital Hub `heating` 13,694.4 ms, `plumbing` 25,709.8 ms,
`ventilation` 5,417.3 ms against the changed `architecture` 4,189.4 ms), which
is exactly the work the artifact tier removes; the transport arm pays
restore (load + verify + parse, 273.1 ms over three documents on Digital Hub)
plus the publish of the re-extracted document (725.9 ms).

Both arms are re-recorded in every session that reports this gate, because
the host's foreground load moves the absolutes: the clean Digital Hub median
was 50,028.4 ms in the slice-1 session, 52,570.5 ms in the slice-2 one, and
53,754.4 ms in the slice-3a one. That is why the rule compares against a
same-session clean arm and never against a committed absolute; neither figure
is a regression of the other.

What this gate does **not** establish: the `.1` record never measured a clean
arm, so whether slice 1 alone flipped the verdict is not recorded. Slice 1's
own effect is gate 3's verify column, and slices 2 and 3a both move its parse
and byte columns. No slice is what carries this gate --
the tier's saving is the extraction it skips, and it already cleared the bar
after slice 1 -- so each later slice's job here is to show the saving did not
shrink. Gate 4 is re-run after every slice and its rule does not change: a
failure at any slice marks ADR-0019 Rejected.

## Where the time goes (medians over five samples, ms)

Digital Hub, transport arm against clean arm. Compiler stages sum with
`unattributed` to the compile total; adapter ledger stages sit inside the
adapter process's `main`; every closure check held in all ten samples.

| Stage | Transport | Clean |
|---|---|---|
| whole process | 10,302.4 | 53,754.4 |
| compile total (in-process) | 10,191.6 | 53,623.5 |
| harness overhead (process − compile) | 107.4 | 130.9 |
| `adapter` stage (spawn to close) | 6,611.3 | 50,501.4 |
| adapter interpreter start + imports | 69.0 + 237.8 | 76.3 + 241.1 |
| adapter `main` | 6,226.8 | 50,087.2 |
| changed `architecture` extract / publish | 4,234.8 / 725.9 | 4,189.4 / — |
| unchanged `heating` load / verify / parse or extract | 42.8 / 9.9 / 58.7 | 13,694.4 |
| unchanged `plumbing` load / verify / parse or extract | 54.5 / 10.8 / 31.4 | 25,709.8 |
| unchanged `ventilation` load / verify / parse or extract | 16.7 / 4.9 / 43.4 | 5,417.3 |
| federation merge / property index | 7.0 / 62.2 | 9.1 / 63.0 |
| Scene IR writes: structure / geometry / properties / digest | 674.7 / 82.2 / 9.8 / 57.9 | 713.9 / 245.3 / 8.8 / 57.5 |
| `toolchainIdentity` / `cacheLookup` / `cachePublish` | 401.9 / 0.6 / 71.6 | 0.0 / 0.0 / 0.0 |
| `readSceneIr` (structure scan inside it) | 1,934.8 (1,929.7) | 1,936.0 (1,930.7) |
| `compile`: validate / encode / measure / other | 92.6 / 322.2 / 178.3 / 232.3 | 93.8 / 328.8 / 185.0 / 234.0 |
| `dependencyIndex` / `writePackage` / `writeDependencyIndex` | 34.2 / 175.0 / 9.5 | 34.6 / 167.0 / 9.0 |
| in-process compiler work (compile total − adapter stage) | 3,566.4 | 3,082.1 |

The in-process compiler work is the same in both arms apart from the cache
identity and publish stages (`toolchainIdentity` 401.9 ms hashes the
compiler module directory; `cachePublish` 71.6 ms), which the clean arm skips
because it has no cache directory; that 473 ms is the transport arm's price
for a warm package cache on the next reopen.

Slice 3a shows up in four places on this model, against the slice-2 record at
commit `e6a78dd`. Property interning moved out of the federation pass and into
each document's own extraction, so the federation's `property index` stage fell
from 553.5 to 63.0 ms in the clean arm and from 449.9 to 62.2 ms in the
transport arm, while the changed document's extract rose slightly to carry that
work (clean `architecture` 4,123.8 to 4,189.4 ms). Because the artifact now
stores property values as a raw byte heap with three offset columns instead of
as JSON inside the document, its payload shrank from 72,677,504 to 64,227,000
bytes and its parse fell from 167.3 to 136.7 ms, with load 126.0 to 115.7 ms
and verify 28.7 to 25.6 ms. The on-disk artifact nevertheless grew slightly,
13,178,145 to 13,241,820 bytes. Only the two byte counts are measured; the
likely reason is that the three binary offset columns compress less well than
the escaped text they replaced. Either way, unlike slice 2 -- where payload
bytes and file bytes fell together -- this slice trades a little gzip for a
cheaper parse.
What slice 3a did **not** move is the compiler's structure scan (`readSceneIr`,
1.9 s here, flat across both arms and all three records) -- that is slice 3b's
target, not this one's.

sixty5, same layout:

| Stage | Transport | Clean |
|---|---|---|
| whole process | 61,672.4 | 316,082.6 |
| compile total (in-process) | 61,432.6 | 315,687.4 |
| harness overhead (process − compile) | 233.0 | 407.3 |
| `adapter` stage (spawn to close) | 23,163.0 | 278,307.3 |
| adapter interpreter start + imports | 69.6 + 233.8 | 74.3 + 243.7 |
| adapter `main` | 22,306.3 | 277,320.8 |
| unchanged `architecture` load / verify / parse or extract | 167.5 / 45.5 / 419.7 | 72,985.4 |
| unchanged `electrical` load / verify / parse or extract | 151.7 / 52.1 / 541.0 | 43,499.8 |
| unchanged `facade` load / verify / parse or extract | 3.7 / 1.0 / 7.7 | 1,264.8 |
| unchanged `kitchen` load / verify / parse or extract | 34.0 / 8.1 / 32.4 | 15,537.8 |
| unchanged `plumbing` load / verify / parse or extract | 262.5 / 78.9 / 1,487.4 | 77,655.8 |
| changed `structure` extract / publish | 5,331.8 / 932.0 | 5,558.8 / — |
| unchanged `ventilation` load / verify / parse or extract | 155.8 / 43.0 / 1,160.9 | 48,054.0 |
| federation merge / property index | 98.9 / 1,045.2 | 136.6 / 962.3 |
| Scene IR writes: structure / geometry / properties / digest | 8,620.8 / 544.4 / 115.4 / 371.7 | 9,069.1 / 1,595.6 / 127.1 / 382.5 |
| `toolchainIdentity` / `cacheLookup` / `cachePublish` | 408.7 / 0.3 / 610.9 | 0 / 0 / 0 |
| `readSceneIr` (structure scan inside it) | 25,191.9 (25,149.4) | 25,203.4 (25,162.8) |
| `compile`: validate / encode / measure / other | 1,124.0 / 2,498.1 / 1,888.9 / 2,978.9 | 1,121.6 / 2,541.6 / 2,043.8 / 3,169.7 |
| `dependencyIndex` / `writePackage` / `writeDependencyIndex` | 777.6 / 1,760.0 / 109.0 | 777.1 / 1,720.2 / 112.6 |
| in-process compiler work (compile total − adapter stage) | 38,049.2 | 37,366.9 |

The same places move on sixty5, at the scale that makes them worth the format
bump, and one of them moves the other way. Property interning again left the
federation pass: `property index` fell from 10,155.8 to 962.3 ms in the clean
arm and from 9,208.9 to 1,045.2 ms in the transport arm, with the changed
document's extract carrying that work instead (clean `structure` 5,529.8 to
5,558.8 ms). The artifacts shrank on both counts here -- 92,975,427 to
76,330,857 bytes on disk and 834,931,820 to 580,107,408 payload bytes -- and
load fell from 1,108.5 to 788.5 ms and verify from 329.0 to 229.5 ms. Artifact
parse, however, **rose** from 3,161.0 to 3,664.1 ms, the opposite sign from
Digital Hub's 167.3 to 136.7 ms. Only the four numbers are measured; the likely
reason is that this model's 580 MB value heap has to be cut back into per-row
values at parse time, which at Digital Hub's 64 MB costs less than the JSON
decode it replaced and at this scale costs more. The whole-process transport
median still improved, 70,667.5 to 61,672.4 ms, because load, verify, and the
federation pass gave back more than parse took. And `readSceneIr` is flat again
-- 25,191.9 ms in the transport arm against 25,203.4 in the clean one, with the
structure scan inside it 25,149.4 against 25,162.8 -- which is the 25-second
reason slice 3b exists.

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
