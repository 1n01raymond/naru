# Reduced-level selection in the browser (ADR-0025 gate 3)

Two record families, one per browser engine, of the Studio choosing between the
exact (`target`) and reduced levels of the four-part STEP corpus by projected
error. Recorded on 2026-09-11 against package
`de1e6bc0df2cf6cecf91cf0068c7930602da6e0574a9480c8f3d0b59104c0e19`
(`artifacts/lod/reduced-level/package`, the gate-1 compile of
`fixtures/step/lod-corpus.step` with `--reduced-lod 0.001`).

| File | What it is |
|---|---|
| [`blink/reduced-lod-browser-evidence.json`](blink/reduced-lod-browser-evidence.json) | Chrome 151.0.7922.139, headed |
| [`gecko/reduced-lod-browser-evidence.json`](gecko/reduced-lod-browser-evidence.json) | Firefox 150.0.2, headed |
| `*/admit-threshold-{reference,reduced}.png` | The compared frames at the nearer camera |
| `*/half-threshold-{reference,reduced}.png` | The compared frames at the farther camera |

Schema `naru.reduced-lod-browser-evidence.1`, mode
`headed-two-distance-level-agreement`. Re-record with
`pnpm lod:selection:evidence` (add `--browser firefox` for the Gecko family);
validate both families with `pnpm lod:selection:check`.

## What the gate asks and what was measured

ADR-0025 gate 3: at two predeclared camera distances the frame drawn with
`reduced` admitted agrees with a `target`-only reference frame on at least 99%
of viewport pixels within 8/255 per channel, picked object ids on a predeclared
lattice are identical, and the comparison is recorded in Chrome and Firefox.

Both arms are the **same build and the same package**. The reference arm is
opened with `?lodAdmitPx=1e-9&lodReplacePx=1e-9`, thresholds no projected error
can ever satisfy, so it draws `target` at every distance; the reduced arm is
opened with the shipped defaults (admit 1.0 px, replace 1.5 px). Nothing is
recompiled and no code path differs between the arms.

| | admit-threshold (wheel 600) | half-threshold (wheel 1200) |
|---|---|---|
| Projected error of the reduced level | 0.8929 px | 0.363 px |
| Level drawn, reference / reduced arm | `target` / `reduced` | `target` / `reduced` |
| Triangles, reference → reduced | 6,159 → 4,135 | 6,159 → 4,135 |
| Whole-frame agreement | 99.9943% | 99.9992% |
| Analysis-window agreement | 99.9793% (35 of 169,043) | 99.9970% (5 of 169,043) |
| Drawn-geometry agreement | 99.2318% (35 of 4,556) | 99.3773% (5 of 803) |
| Largest channel difference | 128/255 | 158/255 |
| Lattice points, objects picked | 57, 4 | 54, 4 |
| Picked ids identical | yes, 0 disagreements | yes, 0 disagreements |

Every figure in that table is identical in both engines, and the validator
asserts that equality field by field rather than pinning it twice.

The whole-frame ratio is the number the gate names, and it is the least
demanding of the three: most of the viewport is background. The record
therefore also measures a fixed analysis window (the middle 50% horizontally,
25%–80% vertically) and, tighter still, only the pixels either arm actually
draws geometry into. All three clear 99%. The differences that remain are
silhouette pixels — 35 of them at the nearer camera — which is what a
0.9 px deviation bound predicts.

## Where the engines differ

The gate asks for the comparison in both engines, not for the two engines to
produce the same bytes. They do not, and the record carries the difference:

- Blink captures the canvas 521 pixels larger than Gecko (614,259 against
  613,738 pixels in the frame), so the whole-frame pixel count is pinned per
  family.
- Gecko lays the drawn geometry out one pixel further left: bounds
  `{476…705}` against Blink's `{477…706}` at the nearer camera, `{543…636}`
  against `{544…637}` at the farther one.
- One lattice point consequently lands on background in Gecko that does not in
  Blink at the nearer camera (2 background points against 1), while both
  engines pick the same four corpus parts and the same set of object ids.

Screenshots are **not** byte-comparable across engines and no cross-engine
image equality is claimed.

## Method, honestly

- The two camera distances were declared before any agreement number was read
  and have not been changed since; they are wheel deltas from the fitted view,
  chosen so that the nearer one sits just under the 1.0 px admission threshold
  (fitted error 2.1962 px falls to 0.8929 px) and the farther one well under it.
- A first Gecko run reported pick disagreements. They were a measurement
  artifact, not a rendering one: selecting an object pins it to its exact level
  and promotes its residency asynchronously, so reading the next lattice point
  before that settled sampled a frame that was still changing. The recorder now
  waits for the selection signature to hold still for three consecutive polls
  and two animation frames after every click, clicks the centre of a capture
  pixel rather than its corner, and refuses to compare two arms whose canvas
  rectangles differ. The camera distances, the thresholds, and the agreement
  criterion were not touched.
- Each family was recorded twice. The second run produced byte-identical PNGs
  and a JSON identical apart from `recordedAt` and `elapsedSeconds`.
- The recorder throws if the page reports any console or page error, so
  `consoleIssues: 0` is a checked fact rather than an empty list.
- Timings are not part of the claim and are not pinned; only `elapsedSeconds`
  is recorded, for context.

## Limits

- One host (Windows 11, this machine), one GPU. The package digest is
  host-local; the validator pins it and it must never be retargeted to make a
  re-record pass.
- The corpus is the four-part synthetic STEP model the method comparison used.
  ADR-0025 puts any sixty5 or Digital Hub number out of scope for acceptance,
  and none is claimed here.
- Agreement is measured between two frames of the same scene at the same
  camera. It says nothing about how the level switch looks *while* the camera
  moves; hysteresis is covered by unit tests, not by this record.
