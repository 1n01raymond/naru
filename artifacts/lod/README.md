# LOD evidence

Records behind the [#76](https://github.com/1n01raymond/naru/issues/76) LOD
slice: the offline method comparison that chose the approach, the gate-1 record
of the `reduced` level the compiler emits under `--reduced-lod`, and the gate-3
browser record of the Studio selecting between that level and the exact one
([ADR-0025](../../docs/adr/0025-shape-preserving-lod-representation.md)).

| Record | Schema | Validator | What it settles |
|---|---|---|---|
| [`method-comparison/`](method-comparison/README.md) | `naru.lod-method-comparison.1` | `pnpm lod:method:check` | OCCT retessellation at declared tolerances versus constrained meshoptimizer simplification on a four-part STEP corpus ([#126](https://github.com/1n01raymond/naru/issues/126)) |
| [`reduced-level/`](reduced-level/README.md) | `naru.reduced-lod-evidence.1` | `pnpm lod:reduced:check` | Two fresh compiles of the corpus with `--reduced-lod 0.001` are byte-identical under `naru.progressive-package.2`; `reduced` is emitted for `thin-plate-holes` and `fillet-bracket`, withheld for `curved-shell` and `planar-control`; 0 Khronos errors (ADR-0025 gate 1) |
| [`reduced-selection/`](reduced-selection/README.md) | `naru.reduced-lod-browser-evidence.2` | `pnpm lod:selection:check` | Headed Chrome and Firefox, three camera distances: frames drawn with `reduced` admitted agree with a `target`-only reference on 99.97% or more of viewport pixels and 99.01% or more of drawn pixels within 8/255, lattice picks per engine return identical object ids, and the nearest distance draws one prototype reduced while the other stays exact because their declared bounds straddle the threshold (ADR-0025 gate 3) |

Every digest in these records is host-local (the OCCT adapter is deterministic
per host, not across hosts); validators pin them so a re-record that moves a
number is a visible event, never a silent retarget.
