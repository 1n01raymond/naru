# sixty5 Design + Engineering scale qualification

This record qualifies a reproducible, source-derived IFC package against the
Phase 2 engineering-scale floor. It combines the seven qualified sixty5 Design
documents with the complete 24-document Geelen Beton and Aarts cohort from the
official SDK-S1 Engineering share. The cohort was fixed before compilation; its
semantic-only documents remain in the selection instead of being filtered by
observed geometry.

The sources are CC BY 4.0 and remain outside Git. Their revisions, attribution,
byte lengths, and SHA-256 digests are pinned in the [external fixture
manifest](../../../fixtures/external/manifest.json). The official Engineering
source census is recorded separately in [fixture qualification
evidence](../../fixtures/external/sixty5-engineering.json).
The first-party CC BY 4.0 grant permits sharing and adapting the source,
including redistribution of derived compiled geometry, properties, and
screenshots, provided the required attribution and license notice accompany the
publication. This record preserves that attribution; publishing those derived
resources is the remaining delivery step, not a licensing workaround.

## Result

| Measure | Recorded value | Gate |
|---|---:|---:|
| Source documents | 31 (7 Design + 24 Engineering) | — |
| Source bytes | 899,467,071 | — |
| Renderable geometric occurrences | 104,337 | >= 100,000 |
| Geometric prototypes | 66,396 | >= 10,000 |
| Submitted triangles | 46,059,890 | >= 10,000,000 |
| Unique triangles (`triangleCount`) | 10,394,938 | reported alongside |
| Package bytes | 854,446,743 | — |
| `scene.gltf` bytes | 405,570,167 | < 536,870,888 recorded Node/V8 string limit |
| Spatial-demand index | 4,095 nodes / 2,048 leaves / 21,922 chunk references | 104,337 indexed occurrences |
| Khronos glTF Validator | 0 errors / 0 warnings | clean |

The compiled package digest is
`6d23bffd6632345f8b2714684abbbb3b68ef59158beee4474b87b381f4df9acf`.
The package uses compact glTF JSON, omits optional resource names, emits the
float64 occurrence spatial index, and orders target payloads by deterministic
spatial-leaf anchors. Node/material names and source identity remain present.
The decoded index has depth 11, leaf capacity 64, and root bounds
`[-2.2400381565, -30.3999996185, -62.0700503503]` to
`[42.2852108480, 57.9000015259, 0.5]` metres.

This is package qualification, not a startup, frame-time, memory, or renderer
comparison. The 854.4 MB package is not committed. It is now served from the
delivery origin and opened through the deployed Studio in a separate
[browser record](../../public-demo/engineering-baseline-origin/README.md),
which closes the Phase 2 public-baseline exit criterion; the published bytes
are the publishing host's compile rather than this record's, and both digests
are pinned where they are claimed.

West Riverside Hospital is excluded because its upstream publisher does not
state redistribution terms; no source-derived geometry, properties, screenshot,
or evidence from it is committed. CadQuarry remains a separate source-derived
synthetic STEP/OCCT breadth control and cannot substitute for this real-source
gate.

## Reproduce

Install the pinned IFC adapter environment, fetch both large datasets explicitly,
then compile and record:

```sh
python3 -m venv output/venv-ifc
output/venv-ifc/bin/python -m pip install \
  -r native/adapter-ifc/tools/requirements-evidence.txt
pnpm fixtures:external fetch ifc-bench-sixty5 --allow-large
pnpm fixtures:external fetch sixty5-engineering --allow-large
pnpm ifc:engineering:compile -- \
  --python output/venv-ifc/bin/python \
  --threads 6
pnpm ifc:engineering:evidence
pnpm ifc:engineering:check
```

Windows contributors should use `output/venv-ifc/Scripts/python` for
`--python`. The compile output and source downloads stay under the ignored
`output/` directory. The recorder commits only the adapter report, compiler
report, and validation envelope; the offline validator pins their identities,
counts, source selection, package resource digests, and Khronos result.

Host details and the exact source/document identities are in
[`validation-report.json`](validation-report.json). The strict offline gate is
`pnpm ifc:engineering:check`.
