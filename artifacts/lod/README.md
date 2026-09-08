# LOD evidence

Records that compare geometry-reduction methods before any LOD representation
is serialized. Nothing under this directory changes a compiled package; the
experiments exist to decide what the [#76](https://github.com/1n01raymond/naru/issues/76)
LOD slice may adopt.

| Record | Schema | Validator | What it settles |
|---|---|---|---|
| [`method-comparison/`](method-comparison/README.md) | `naru.lod-method-comparison.1` | `pnpm lod:method:check` | OCCT retessellation at declared tolerances versus constrained meshoptimizer simplification on a four-part STEP corpus ([#126](https://github.com/1n01raymond/naru/issues/126)) |

Every digest in these records is host-local (the OCCT adapter is deterministic
per host, not across hosts); validators pin them so a re-record that moves a
number is a visible event, never a silent retarget.
