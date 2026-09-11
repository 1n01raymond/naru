# Reduced LOD level (ADR-0025 gate 1, issue #76)

Record: `reduced-lod-evidence.json` (`naru.reduced-lod-evidence.1`, mode
`fresh-process-double-compile-reduced-level`). Re-record with
`pnpm lod:reduced:evidence` (about 5 s, needs the STEP adapter Python at
`output/cadquery-venv/Scripts/python.exe` or `NARU_PYTHON`); validate with
`pnpm lod:reduced:check`. The first run's package is committed under
`package/` so the validator re-hashes bytes rather than trusting the record.

## Fixed inputs

- Source: `fixtures/step/lod-corpus.step` (114,233 B, sha256 `02c78ff7…`),
  the four-part corpus of [`method-comparison/`](../method-comparison/README.md).
- Command: `naru compile <corpus> --reduced-lod 0.001`, run twice in fresh
  processes. Every other option at its default.
- Admission: meshoptimizer 1.2.0 `simplifyWithAttributes` (whole shape,
  unlocked boundary, normal weight 0.5, absolute error 1 mm), run twice per
  prototype so a non-deterministic result retains `target`; then the
  mesh-only checks of the method-comparison record against the prototype's
  own `target` (sampled two-sided p95 and max at 2,000 seeded samples, edge
  boundary delta, edge alignment, section, silhouette ratio 0.005, hole
  count, identity conflicts). Analytic-face and OCCT retessellation checks
  stay in the offline record; they are not part of a compile.

## Results

Both compiles produce package `808c4c01ce9a…` (scene.gltf 102,026 B,
scene.bin 578,988 B, coarse.bin 3,648 B, build-report.json 4,116 B,
adapter-report.json 1,501 B), the Khronos validator reports 0 errors and 0
warnings, and the document carries `extras.naru.progressive`
(`naru.progressive-package.2`, strategy `prototype-aabb-reduced-v1`) with no
`extras.madi.progressive` block.

| Prototype | Outcome | Target tris | Reduced tris | Sampled p95 (m) | Sampled max (m) |
|---|---|---|---|---|---|
| `thin-plate-holes` | reduced | 1,712 | 310 | 6.0e-16 | 5.95e-4 |
| `fillet-bracket` | reduced | 784 | 162 | 1.68e-5 | 4.15e-4 |
| `curved-shell` | retained (`checks-failed`) | 3,623 | - | 1.0017e-3 | 1.4526e-3 |
| `planar-control` | retained (`no-reduction`) | 28 | - | 0 | 0 |

| Level | Chunks | Bytes | Triangles |
|---|---|---|---|
| `target` | 4 | 547,352 | 6,147 |
| `reduced` | 2 | 31,636 | 472 |

Each reduced chunk declares its **own** measured bound in the document —
0.000595 m for `thin-plate-holes`, 0.000415 m for `fillet-bracket` — and the
document-level `reducedLod` block states the method, the 0.001 m request, and
the largest of the per-chunk bounds. The declared number is the measured
sampled maximum against that prototype's own `target`, not the request.

The reduced chunks follow the target payloads in `scene.bin` and are declared
in `extras.naru.progressive.reducedChunks`, so the loader Range-fetches them
like target chunks and prices them with the unchanged `batchResidencyCost`.

## What this record does not claim

- Digests are host-local (the OCCT adapter differs across hosts by a few
  bytes); the validator pins them and says not to retarget.
- This record covers the compile only. What the Studio then draws is
  [`reduced-selection/`](../reduced-selection/README.md) (ADR-0025 gate 3).
- Explicit edge segments are carried from `target` verbatim in content but
  re-encoded into the reduced payload, so a reduced chunk is self-contained.
- `build-report.json` still records `options.reducedLod.maxDeviationMeters` as
  the 0.001 m *request*: that report belongs to the frozen
  `madi.phase1.compiler-report.1` family (ADR-0007) and was deliberately not
  bumped for this slice. The measured bounds live in the document, which did
  bump.
