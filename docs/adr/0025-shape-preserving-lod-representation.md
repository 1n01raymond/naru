# ADR-0025: Shape-preserving LOD as a declared-error representation

Status: Accepted

Accepted: 2026-09-11

## Context

A compiled package carries two representations per prototype today: `target`,
the display tessellation at the adapter's declared tolerance, chunked and
Range-fetched under the 64 MiB residency budget, and `coarse`, an axis-aligned
box proxy drawn through the fallback depth-offset pipeline while target detail
is absent. The compiler's own build report says so: "The coarse representation
is a prototype AABB, not a shape-preserving LOD." On sixty5 the budget admits
111 of 234 target chunks ([first-frame record](../../artifacts/ifc/sixty5-first-frame/README.md));
everything else is a box. The Scene IR already describes representations by
`purpose` and an `AccuracyDescriptor` whose `kind` is `source-exact`,
`tessellated`, `simplified`, or `derived` ([SCENE_IR §15](../SCENE_IR.md#15-lod-semantics)),
but no compiled representation has ever used `simplified`.

[Issue #76](https://github.com/1n01raymond/naru/issues/76) asks for one
shape-preserving LOD slice whose contract preserves source identity and bounds
visual and edge error, preceded by a Proposed ADR for the serialized ownership
and profile. The method question was settled first by
[#126](https://github.com/1n01raymond/naru/issues/126), recorded in
[`artifacts/lod/method-comparison/`](../../artifacts/lod/method-comparison/README.md)
(`naru.lod-method-comparison.1`, `pnpm lod:method:check`) on a four-part
generated STEP corpus with nine predeclared checks: OCCT retessellation at a
declared tolerance no coarser than 0.15 mm / 0.15 rad is the only method that
passes on the curved part; meshoptimizer 1.2.0 `simplifyWithAttributes`
(normal weight 0.5, boundary unlocked, 1 mm target) passes with zero identity
conflicts only on planar-dominant parts whose CAD boundary edges travel as
explicit edge segments; locking boundary vertices prevents any reduction on
those parts; a QEM error is not a certified CAD tolerance. That record fixes
method and topology class. It does not fix how a reduced representation is
serialized, who owns it, how it is admitted, or how the runtime chooses it,
which is what this ADR decides.

Constraints inherited from earlier decisions:

- [ADR-0004](0004-format-strategy.md): the package stays standard glTF 2.0 with
  extras; no private container.
- [ADR-0007](0007-rebrand-naru.md): `extras.madi.progressive` is frozen; the
  family migrates to a `naru.` identifier at its next schema bump, together
  with its validators and re-recorded evidence.
- [ADR-0008](0008-spatial-demand-partitioning.md): demand is a set of chunks
  ranked from camera state; admission cost is `batchResidencyCost`.
- [ADR-0011](0011-remote-package-limits.md): every resource is digest-declared
  and fetched under fail-closed limits; a new resource joins that contract.
- Geometry reduction is not compression: positions, normals, and indices keep
  today's encoding and precision; no quantization extension or codec enters
  through this decision.

## Decision

### Representation kinds are distinct and each states its error

Four kinds exist and are never conflated:

| Kind | Where it lives | Error statement |
|---|---|---|
| `source-exact` | the STEP or IFC source, reachable only through `sourceRefs` | none needed; it is the reference |
| `tessellated` | today's `target` representation | the adapter's declared linear/angular tolerance |
| `simplified` | the new `reduced` representation | a measured maximum deviation in metres against `target`, plus the method that produced it |
| `derived` | today's `coarse` box proxy | none; it claims no bound and stays a proxy |

A representation without an error statement is a proxy, never a display level.
An operation labelled source-exact never reads a `simplified` or `derived`
surface (COMPILER §11).

### Ownership

The compiler owns generation. The OCCT adapter contributes retessellation at
a declared tolerance; meshoptimizer runs inside the compiler as a library
function, never as `gltfpack` or a separate tool. The runtime and the Studio
only select among what the package declares; nothing simplifies at load time.
The IfcOpenShell adapter is out of scope for the first slice.

### Serialized profile

A `reduced` representation is a third per-prototype level beside `target` and
`coarse`. It is emitted only for prototypes that passed the checks below;
every other prototype keeps `target` alone, deterministically. Its chunks are
laid out and Range-fetched like `target` chunks (own chunk table, own byte
ranges in `scene.bin`), so `batchResidencyCost` prices them without a new
formula and the ADR-0011 transport verifies them under the same declared
digests and limits. Per reduced prototype the document declares, in model
units: `maxDeviationMeters`, `method` (`occt-retessellation` with its linear
and angular tolerance, or `meshopt-simplify` with its target error), and the
triangle counts of both levels, which is the "enough information for
screen-space selection" COMPILER §11 requires.

Because `extras.madi.progressive` is frozen, adding a level is the schema bump
ADR-0007 reserved for this family: the progressive block becomes
`extras.naru.progressive` under a `naru.progressive-package.2` identifier,
readers refuse the old key by identifier as every other bump has, and the
validators and evidence that pin the frozen block are re-recorded in the same
slice. A package without any reduced prototype still serialises the new
identifier, so a reader's acceptance never depends on whether reduction
happened to apply.

### Identity and edges survive reduction

- Occurrence and object identity are unchanged: a reduced batch renders the
  same object ids into the pick attachment, so selection, hide/isolate, storey
  scope, and workspace restore cannot tell which level is drawn.
- `faceSourceIds` are carried per reduced triangle, and a reduced triangle
  maps to exactly one source face (`identity-conflicts` 0), so face-level
  picking and source mapping keep working.
- Explicit edge segments are never re-derived: the reduced level references
  the `target` edge segments verbatim (`edge-boundary-delta` 0), and the
  reduced surface must lie within the declared deviation of that polyline
  (`edge-alignment-max`).
- Precision is unchanged: f32 positions and normals relative to the same
  prototype origin, same index width rules, no quantization.

### Method by topology class, checks decide

The compiler classifies each prototype from the adapter's analytic face
description (`naru.occt-analytic-faces.1`) and the presence of explicit edges:

1. Prototypes whose CAD boundary edges travel as explicit edge segments and
   whose described faces are planar, or planar with cylindrical blends and
   holes, try `meshopt-simplify` first (unlocked boundary, normal weight 0.5,
   target error 1 mm).
2. Every other prototype, and any prototype the first arm failed, tries
   `occt-retessellation` at a declared tolerance no coarser than
   0.15 mm / 0.15 rad.
3. A candidate becomes the `reduced` level only if it passes all nine
   predeclared checks of the method-comparison record against `target`
   (sampled two-sided p95 and max, analytic max, edge boundary delta, edge
   alignment, section, silhouette ratio, hole count, identity conflicts), with
   the record's thresholds, and reduces the triangle count. Otherwise the
   prototype retains `target` alone.

The checks are deterministic (seeded samples, sorted traversal), so two
compilations emit byte-identical packages, and a compiler or library upgrade
that changes a verdict changes the digest visibly.

### Selection and admission

- Screen-space error of a resident level is its declared deviation projected
  through the current camera: for the orthographic Studio camera,
  `maxDeviationMeters / metresPerPixel`; for a perspective camera,
  `maxDeviationMeters * viewportHeightPx / (2 * distance * tan(fov / 2))`
  at the prototype bounds' nearest point.
- A `reduced` level is drawn while its projected error is at most 1.0 px and
  is replaced by `target` once it exceeds 1.5 px; the gap is the hysteresis
  and both thresholds are Studio options with those defaults.
- The selected object is drawn at `target` whenever `target` is resident
  (SCENE_IR §15); a section plane and `pickPoint` read whichever level is
  drawn, and a measurement taken on a `reduced` surface reports the level's
  declared deviation beside the distance.
- Residency: `reduced` and `target` chunks compete under the same 64 MiB
  budget through the unchanged scheduler; the demand ranking prefers the
  `reduced` chunk of a prototype until its projected error demands `target`,
  and evicts the other level of the same prototype first. The default
  large-scene scheduler policy does not change on the strength of a small
  fixture (#76 non-goal).

## Consequences

Positive: detail per resident byte rises on parts the checks admit, boxes
give way to shapes on those parts, and every claim about a reduced surface is
a declared number a validator can pin. Negative: the progressive schema bump
re-records every record that pins the frozen block; compile time grows by the
check suite per prototype; parts that fail every arm look exactly as they do
today, so the improvement is partial by construction; the deviation bound is
per prototype, not per triangle, which keeps the document small but forces
the coarsest face to decide the transition for the whole part.

Alternatives rejected: quantization or `gltfpack` (compression, not
reduction, and a codec change ADR-0004 would have to own); runtime
simplification (moves a determinism-critical step behind an engine);
meshlet or cluster-LOD libraries (not dependencies, and a hierarchy the
package format would have to serialise); replacing the AABB proxy (a non-goal
until this path is proven).

## Validation

Gates, predeclared. Failing gate 1 or gate 3 rejects this ADR
([ADR-0018](0018-content-addressed-compiled-payloads.md) precedent); gates that
close no roadmap exit criterion are unit tests, not fresh-process records.

| Gate | What must hold | State |
|---|---|---|
| 0 | Method and topology class settled on a project-owned fixture with predeclared checks | **Met**: [`artifacts/lod/method-comparison/`](../../artifacts/lod/method-comparison/README.md) |
| 1 | Compiling `fixtures/step/lod-corpus.step` twice yields byte-identical packages under `naru.progressive-package.2`; `reduced` is emitted for the parts the record admits and withheld for `curved-shell` under the meshopt arm; the Khronos validator reports 0 errors; a committed validator pins the digests, per-prototype deviations, and level triangle counts | **Met** (2026-09-08): [`artifacts/lod/reduced-level/`](../../artifacts/lod/reduced-level/README.md), `pnpm lod:reduced:check` |
| 2 | Unit tests cover projected-error hysteresis at both thresholds, selected-object pinning, section and `pickPoint` on a reduced level, edge-segment reuse, same-prototype eviction order, and unsupported-topology retention | **Met** (2026-09-11): hysteresis, threshold resolution, and pinning in [`lod-selection.test.ts`](../../apps/webgpu-spike/test/lod-selection.test.ts); level swap, eviction order, and pinning in [`progressive-residency.test.ts`](../../apps/webgpu-spike/test/progressive-residency.test.ts); section and `pickPoint` inputs, and loader decoding of a reduced chunk, in [`compiled-gltf.test.ts`](../../packages/runtime-webgpu/test/compiled-gltf.test.ts); edge reuse, determinism retention, and unsupported-topology retention in [`reduced-lod.test.ts`](../../packages/compiler/test/reduced-lod.test.ts) |
| 3 | One headed record on the corpus: at two predeclared camera distances, the frame drawn with `reduced` admitted agrees with a `target`-only reference frame on at least 99% of viewport pixels within 8/255 per channel, and picked object ids on a predeclared grid are identical; recorded in Chrome and Firefox, divergences visible in the record | **Met** (2026-09-11): [`artifacts/lod/reduced-selection/`](../../artifacts/lod/reduced-selection/README.md), `pnpm lod:selection:check`. Re-recorded at **three** camera distances once the package began declaring per-prototype bounds. Drawn-geometry agreement 99.0582%, 99.0060%, and 99.2336%; whole-frame agreement 99.9736%, 99.9792%, and 99.9950%; picked ids identical per engine at every distance, 0 disagreements; triangles 6,159 → 4,135 where both chunks are substituted. The nearest distance sits inside the band where the corpus's two bounds straddle the threshold, so `fillet-bracket` (0.7274 px) is drawn reduced while `thin-plate-holes` (1.043 px) stays exact in the same frame, and the validator asserts that mixed case explicitly. Engine divergences carried, not asserted away: Blink captures 614,259 frame pixels against Gecko's 613,738, Gecko lays the geometry out one pixel further left, and Blink's lattice lands one background point at two distances where Gecko's lands none |

### Implementation notes (2026-09-08, compiler and loader slice)

The first slice landed the representation, not the selection. Where it
narrows the Decision above, the narrowing is deliberate and stated here:

- The level is opt-in: `--reduced-lod <meters>` (`reducedLodMeters`, part of
  the compiled-cache key). Only a package compiled with it carries
  `extras.naru.progressive` (`naru.progressive-package.2`); every other
  package keeps `extras.madi.progressive`, so no committed digest moved. The
  loader accepts both blocks, prefers `naru`, and fails closed on any other
  `schemaVersion`.
- One admission arm runs in the compiler: meshoptimizer
  `simplifyWithAttributes`, whole shape, unlocked boundary, absolute error =
  the declared deviation, executed twice so a non-deterministic result
  retains `target`. The checks are the mesh-only subset of the #126 set,
  measured against the prototype's own `target` (sampled two-sided p95 and
  max, edge boundary delta and alignment, section, silhouette ratio, hole
  count, identity conflicts). Analytic-face classification and OCCT
  retessellation stay in the offline method-comparison record; a prototype
  the meshopt arm cannot admit retains `target` with a recorded reason
  (`checks-failed`, `no-reduction`, `nondeterministic`, `no-explicit-edges`,
  `multiple-material-groups`, ...) in `build-report.json` `reducedLod`.
- Explicit edge segments are carried from `target` with identical content but
  re-encoded into the reduced payload, so a reduced chunk is self-contained
  for Range delivery; the reduced surface is welded on exact position and
  normal so it is never larger than its target.
- The reduced chunks follow the target payloads in `scene.bin`, are declared
  in `reducedChunks`, and are priced by the unchanged `batchResidencyCost`.
  The Studio does not select them yet; that switch, with its hysteresis and
  pinning tests and the gate-3 record, is the next slice.

### Implementation notes (2026-09-11, selection slice)

The second slice landed the Studio switch and the gate-3 record. Where it
narrows the Decision above, the narrowing is deliberate and stated here:

- The deviation bound was declared once for the document, so the projected
  error was the same for every prototype and the level decision was one boolean
  per frame: `maxDeviationMeters / metresPerPixel` admitted at 1.0 px and
  replaced at 1.5 px, overridable with `?lodAdmitPx=` and `?lodReplacePx=`.
  **Superseded by the third slice below**, which moved the bound onto each
  chunk; the thresholds and the override parameters are unchanged.
- A prototype with no reduced chunk is never substituted, and the selected
  object is pinned to `target` whatever the camera says, so the level a user is
  inspecting is always the exact one.
- Both levels of a prototype share a residency key, so a promotion of either
  replaces the other in place: the budget never carries a prototype twice, and
  the group being promoted is never its own eviction victim.
- The record's reference arm uses the shipped selector with thresholds no
  projected error can satisfy (`?lodAdmitPx=1e-9&lodReplacePx=1e-9`) rather
  than a second build, so both arms run the same code over the same package.

### Implementation notes (2026-09-11, per-prototype bounds slice)

The third slice moved the bound from the document onto each chunk, which is
what makes the level decision per prototype rather than one boolean per frame:

- Every reduced chunk in `extras.naru.progressive` now carries its own
  `maxDeviationMeters`, measured against that prototype's own `target`. The
  document-level `reducedLod` block states the method, the requested tolerance,
  and the largest of the per-chunk bounds, so the package still answers "how
  wrong can this package be" in one place. A chunk that coalesces several
  prototypes declares the maximum over its members.
- The declared number is the measured sampled maximum, not the request and not
  the p95. `build-report.json` keeps `options.reducedLod.maxDeviationMeters`
  meaning the request: that report belongs to the frozen
  `madi.phase1.compiler-report.1` family ([ADR-0007](0007-rebrand-naru.md)) and
  was deliberately not bumped. The document did bump, from
  `naru.progressive-package.1` to `.2`.
- The Studio evaluates each substitutable chunk against its own bound at the
  same 1.0 px / 1.5 px thresholds, so a frame can draw one prototype reduced
  and another exact. The aggregate `level` a frame reports reads `reduced` only
  when every substitutable chunk is drawn reduced, which is why the mixed frame
  in the record reports `target` while one chunk is substituted.

Out of scope for acceptance: any sixty5 or Digital Hub number. A real-large
measurement, if ever taken, is its own record with its own predeclared
targets and never a default-policy change.

## References

- [SCENE_IR §15](../SCENE_IR.md#15-lod-semantics), [COMPILER §11](../COMPILER.md#11-lod-and-simplification)
- [`describe_analytic_faces.py`](../../native/adapter-occt/tools/describe_analytic_faces.py), [`lod-experiment.mjs`](../../scripts/lib/lod-experiment.mjs)
- [`batchResidencyCost`](../../packages/runtime-webgpu/src/layout.ts)
