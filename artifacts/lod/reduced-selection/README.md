# Reduced-level selection in the browser (ADR-0025 gate 3)

Two record families, one per browser engine, of the Studio choosing between the
exact (`target`) and reduced levels of the four-part STEP corpus by projected
error, **per prototype**. Recorded on 2026-09-11 against package
`808c4c01ce9a43534eacf98a09a6351a36ac18c832b2456162a1678bf4a7d4f8`
(`artifacts/lod/reduced-level/package`, the gate-1 compile of
`fixtures/step/lod-corpus.step` with `--reduced-lod 0.001`).

| File | What it is |
|---|---|
| [`blink/reduced-lod-browser-evidence.json`](blink/reduced-lod-browser-evidence.json) | Chrome 151.0.7922.139, headed |
| [`gecko/reduced-lod-browser-evidence.json`](gecko/reduced-lod-browser-evidence.json) | Firefox 150.0.2, headed |
| `*/split-band-{reference,reduced}.png` | The compared frames at the nearest camera, where the two bounds straddle the threshold |
| `*/admit-threshold-{reference,reduced}.png` | The compared frames at the middle camera |
| `*/half-threshold-{reference,reduced}.png` | The compared frames at the farthest camera |

Schema `naru.reduced-lod-browser-evidence.2`, mode
`headed-three-distance-per-chunk-level-agreement`. Re-record with
`pnpm lod:selection:evidence` (add `--browser firefox` for the Gecko family);
validate both families with `pnpm lod:selection:check`.

## What the gate asks and what was measured

ADR-0025 gate 3: at predeclared camera distances the frame drawn with `reduced`
admitted agrees with a `target`-only reference frame on at least 99% of viewport
pixels within 8/255 per channel, picked object ids on a predeclared lattice are
identical, and the comparison is recorded in Chrome and Firefox.

Both arms are the **same build and the same package**. The reference arm is
opened with `?lodAdmitPx=1e-9&lodReplacePx=1e-9`, thresholds no projected error
can ever satisfy, so it draws `target` at every distance; the reduced arm is
opened with the shipped defaults (admit 1.0 px, replace 1.5 px) and no
parameters at all. Nothing is recompiled and no code path differs between the
arms.

| | split-band (wheel 150) | admit-threshold (wheel 250) | half-threshold (wheel 640) |
|---|---|---|---|
| Reduced chunks drawn, of 2 substitutable | 1 | 2 | 2 |
| Declared bound of the substituted chunks | 0.415 mm | 0.595 mm | 0.595 mm |
| Projected error of what was substituted | 0.7274 px | 0.8978 px | 0.5001 px |
| Worst projected error in the frame | 1.043 px | 0.8978 px | 0.5001 px |
| Level drawn, reference / reduced arm | `target` / `target` (mixed) | `target` / `reduced` | `target` / `reduced` |
| Triangles, reference → reduced | 6,159 → 5,537 | 6,159 → 4,135 | 6,159 → 4,135 |
| Whole-frame agreement | 99.9736% | 99.9792% | 99.9950% |
| Analysis-window agreement | 99.9620% (162 of 426,207) | 99.9700% (128 of 426,207) | 99.9927% (31 of 426,207) |
| Drawn-geometry agreement | 99.0582% (162 of 17,201) | 99.0060% (127 of 12,777) | 99.2336% (31 of 4,045) |
| Largest channel difference | 130/255 | 152/255 | 95/255 |
| Lattice points, objects picked | 59, 4 | 59, 4 | 58, 4 |
| Picked ids identical | yes, 0 disagreements | yes, 0 disagreements | yes, 0 disagreements |

Every figure in that table except the window pixel count is identical in both
engines, and the validator asserts that equality field by field rather than
pinning it twice. The window counts differ by one pixel column
(426,207 against 425,796) because the engines report the canvas one pixel apart;
see *Where the engines differ*.

## The split-band frame is the point of the slice

The package declares a deviation bound **per prototype**, not one number for the
whole package. The two reducible parts carry different bounds — the thin plate
0.595 mm, the fillet bracket 0.415 mm — so there is a band of camera distances
where one projects above the 1.0 px admission threshold and the other below it.
The `split-band` distance sits in that band: the bracket is drawn reduced at
0.7274 px while the plate, at 1.043 px, stays exact, and the frame carries both
levels at once. Triangles fall to 5,537 rather than 4,135, and the scene-wide
`data-geometry-level` still reads `target` because not every substitutable
chunk was substituted.

A package-wide bound could not have produced that frame. It would have had to
draw both parts reduced (accepting the plate's 1.043 px, above the threshold) or
both exact (paying for the bracket's triangles at no visible benefit). The
validator asserts the mixed case explicitly instead of taking the agreement
ratio on trust.

## Three ratios, and which one the gate names

The whole-frame ratio is the number the gate names, and it is the least
demanding of the three: most of the viewport is background. The record
therefore also measures a fixed analysis window and, tighter still, only the
pixels either arm actually draws geometry into. All three clear 99% at all
three distances; the drawn-geometry ratio at `admit-threshold`, 99.0060%, is
the worst case and it is the one the shipped 1.0 px threshold is expected to
produce. The differences that remain are silhouette pixels.

The analysis window is the fractional rectangle
`{x0: 0.1, y0: 0.09, x1: 0.98, y1: 0.88}` of the capture. Its edges were
measured from rendered chrome rather than guessed: the tool buttons end at
y = 40, the view cube occupies x < 106, and the status bar begins at y = 466 on
a 1179×521 canvas. The window excludes all of them and still clears the drawn
geometry by 41 pixels on every side at every distance. This matters because the
drawn-geometry measurement takes the whole image's modal colour as background,
so any Studio chrome left inside the window would be counted as geometry.

## Where the engines differ

The gate asks for the comparison in both engines, not for the two engines to
produce the same bytes. They do not, and the record carries the difference:

- Blink captures the canvas 521 pixels larger than Gecko (614,259 against
  613,738 pixels in the frame), so the whole-frame and window pixel counts are
  pinned per family.
- Gecko lays the drawn geometry out one pixel further left: bounds
  `{368…818}` against Blink's `{369…819}` at the nearest camera, and the same
  one-pixel offset at the other two.
- Blink's lattice consequently lands one point on background at
  `admit-threshold` and `half-threshold` where Gecko's lands none. Both engines
  pick the same four corpus parts and the same set of object ids (3, 4, 5, 6) at
  every distance, which is what the cross-engine assertion compares; the
  background count itself is pinned per family.

Screenshots are **not** byte-comparable across engines and no cross-engine
image equality is claimed.

## Method, honestly

- The three camera distances were declared before any agreement number was read
  and have not been changed since; they are wheel deltas from the fitted view.
  From the fitted camera the worst bound in the scene projects to 1.3062 px, so
  every distance recorded here is a zoom-out. They were chosen so that one falls
  inside the band where the two bounds straddle the threshold, one sits just
  under the threshold with both substituted, and one well under it.
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
- The mixed frame is produced by two prototypes whose bounds differ by 0.18 mm.
  Nothing here measures how often a real model's bounds spread far enough to
  put a camera inside such a band.
