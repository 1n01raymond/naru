# Persistent import-cache evidence

Status: recorded product evidence; closes the ADR-0009 acceptance gate.

This record proves the `--cache` contract from ADR-0009 on the two pinned real
inputs the gate names: the licensed Adafruit PyGamer STEP fixture
(`fixtures/step/adafruit-pygamer.step`) and the qualified four-document Digital
Hub IFC federation from `fixtures/external/manifest.json`. For each source the
recorder runs the same compilation three times against one cache directory:

1. **cold** — empty cache; the run must report a `miss` and publish an entry;
2. **warm** — a fresh output directory; the run must report a `hit`, resolve
   the same cache key, and restore every package resource byte-identically;
3. **corrupted entry** — the first byte of the cached `scene.gltf` is flipped;
   the run must fail closed: report the failed restore, fall back to a full
   recompile whose output is byte-identical to the cold run, and leave the
   corrupt entry unpublishable (manifest intact, resource digest mismatched),
   so later runs stay misses until the host quarantines the entry.

| Source | Cold compile | Warm restore | Speedup | Corrupted-entry recompile |
|---|---:|---:|---:|---:|
| STEP PyGamer (OCCT adapter) | 19.9 s | 1.7 s | 11.4× | 19.6 s |
| IFC Digital Hub, 4 documents (IfcOpenShell) | 46.3 s | 0.5 s | 96.2× | 44.7 s |

All three runs per source produced the same package digest, and the cold,
warm, and fallback outputs were byte-identical file by file (STEP package
`f99ccb9c…`, IFC package `0e2ed454…`). Timings are single runs on one host
(Windows x64, Ryzen 7 9800X3D, Node 22.14.0) and are published as the recorded
cold/warm observation the gate asks for, not as a benchmark distribution.

The recorded IFC package digest `0e2ed454…` is the current-toolchain Digital
Hub package (`naru.ifc-adapter-report.5`, `naru.ifc-scene-ir-split.4` with
explicit edges). It deliberately differs from
`artifacts/ifc/digital-hub/build-report.json` (`9b988666…`), which is a
pre-E2.1 record extracted with `includeEdges: false`; refreshing that
federation record — and the deployed demo package its digests verify — is
tracked as its own slice.

These are mid-size single runs. The real-large distribution lives beside them
in [`sixty5/`](sixty5/README.md): five fresh-process samples per cache state on
the seven-document, 839.9 MB sixty5 federation — cold median 381.4 s, warm
median 1.36 s, corrupt-entry median 89.0 s — with cache footprint,
process-tree peak memory, and the 1–5 s unchanged-reopen verdict.

The changed-discipline question — does the content-addressed payload store
make a one-document rebuild cheaper — is answered in
[`payload-reuse/`](payload-reuse/README.md): on Digital Hub and sixty5 every
store-enabled rebuild reproduced the clean package byte for byte, but restoring
verified payloads took 2.2–2.4× the packaging time of re-encoding them, so
ADR-0018 is rejected by its own gate.
[ADR-0019](../../docs/adr/0019-document-artifact-transport.md) named the
successor reuse unit and removed the flag together with this record's recorder
(2026-09-03), so the record is historical: its validator still checks it, but
it cannot be re-recorded from the current tree.

`rebuild-stages/` is ADR-0019's gate record (`naru.rebuild-stage-evidence.2`):
the same changed-discipline rebuild compiled through restored
`naru.ifc-document-artifact.3` artifacts and, interleaved in the same
session, with no cache directory at all, five fresh-process samples per arm
per model, each decomposed into adapter stages (interpreter start,
changed-document extraction, per-document artifact load, verification, and
parse, merge, property index, Scene IR writes) and compiler stages (structure
read, hydration, encoding, document streaming, package write) with the
sampled process tree. It carries the ADR's gates 1-4 as pinned verdicts,
validated by `scripts/validate-rebuild-stage-evidence.mjs`. Its `.1`
predecessor (commit `69d67e5`) was the ADR's gate 0 decomposition and
recorded that the exploratory probe the ADR was written from did not
reproduce within the record's spread, which the ADR's Context states.

Adapter identities are embedded in the record (`naru.occt-adapter-identity.1`:
cadquery 2.8.0 / OCP 7.9.3.1; `naru.ifc-adapter-identity.1`: IfcOpenShell
0.8.5), and the compiler contributes its content-hashed identity to each cache
key, so the record is invalidated by any toolchain change rather than by a
hand-bumped version string.

Reproduce (the recorder rebuilds the compiler first, needs the local adapter
virtual environments via `NARU_PYTHON` / `NARU_IFC_PYTHON`, and works under the
gitignored `output/cache-evidence/` directory):

```sh
pnpm cache:evidence
pnpm cache:check
```

`scripts/validate-import-cache-evidence.mjs` pins the source digests against
both fixture manifests, the adapter identities, both package digests, the
three-run shape, the fail-closed warning, and the byte-identity claims, and
rejects any machine-local path in the committed JSON.
