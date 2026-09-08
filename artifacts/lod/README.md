# LOD evidence

Records behind the [#76](https://github.com/1n01raymond/naru/issues/76) LOD
slice: the offline method comparison that chose the approach, and the gate-1
record of the `reduced` level the compiler now emits under `--reduced-lod`
([ADR-0025](../../docs/adr/0025-shape-preserving-lod-representation.md)).

| Record | Schema | Validator | What it settles |
|---|---|---|---|
| [`method-comparison/`](method-comparison/README.md) | `naru.lod-method-comparison.1` | `pnpm lod:method:check` | OCCT retessellation at declared tolerances versus constrained meshoptimizer simplification on a four-part STEP corpus ([#126](https://github.com/1n01raymond/naru/issues/126)) |
| [`reduced-level/`](reduced-level/README.md) | `naru.reduced-lod-evidence.1` | `pnpm lod:reduced:check` | Two fresh compiles of the corpus with `--reduced-lod 0.001` are byte-identical under `naru.progressive-package.1`; `reduced` is emitted for `thin-plate-holes` and `fillet-bracket`, withheld for `curved-shell` and `planar-control`; 0 Khronos errors (ADR-0025 gate 1) |

Every digest in these records is host-local (the OCCT adapter is deterministic
per host, not across hosts); validators pin them so a re-record that moves a
number is a visible event, never a silent retarget.
