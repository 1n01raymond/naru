# IFC federation adapter slice

This adapter keeps IfcOpenShell behind the same process boundary used for the
OCCT STEP adapter. It reads multiple discipline IFC files into one Engineering
Scene IR while retaining document-scoped source identity.

The first executable slice preserves:

- one source document and SHA-256 identity per discipline;
- IFC GlobalId-backed semantic entities, types, groups, classifications, and
  flattened inherited property sets, with keys and key combinations interned
  once into the scene-level `propertyIndex` (`tools/property_index.py`) and
  the values themselves deduplicated into the binary property column file
  (`madi.ifc-scene-ir-split.3`, `tools/property_columns.py`);
- project/site/building/storey/product containment and local transforms;
- IfcOpenShell local triangulation separated from occurrence placement;
- OpenCascade face-boundary segments as explicit boundary edges, mapped back
  to their originating IFC representation-item STEP ids;
- prototype reuse keyed by IfcOpenShell's geometry identity; and
- source units normalized to a metre/Z-up federation frame.

IfcOpenShell's OpenCascade backend derives these lines from per-face boundary
edges after removing manifold triangle edges; they are not a triangle
wireframe. `naru.ifc-scene-ir-split.4` streams their indices, boundary classes,
and source ids while allowing edge positions to alias the surface position
stream. Analytic curve kinds and sharp/smooth/seam classification remain
deferred and are disclosed as `IFC_EDGE_CLASSIFICATION_BOUNDARY_ONLY`. The
focused proof is `artifacts/ifc/explicit-edges/`; the older real-model records
remain historical split.3 surface-only evidence.

## Degenerate placement handling

Some source `IfcAxis2Placement` entities carry zero-length or parallel axis
vectors; IfcOpenShell's placement projection then divides by a zero-length
normal and produces `NaN` components. `native/adapter-ifc/tools/placement_math.py`
is the single choke point every world, parent, and derived local transform
passes through before serialization: a matrix with any non-finite component is
replaced with the identity matrix, and the adapter appends an
`IFC_DEGENERATE_PLACEMENT` warning naming the affected document and entity.
`write_scene`/`write_report` additionally call `json.dump(..., allow_nan=False)`
as a backstop, so any future gap in the per-value guards fails loudly at write
time (`ValueError`) instead of emitting invalid JSON with a bare `NaN` token.

## Adapter unit tests

`placement_math.py`, `property_index.py`, `property_columns.py`,
`explicit_edges.py`, and the document-artifact storage module remain pure
Python. The suite also runs one pinned IfcOpenShell integration fixture to prove
selective document reuse produces the same federation bytes as a clean build:

```sh
python -m venv output/venv-ifc-test  # or reuse output/venv-ifc
output/venv-ifc-test/Scripts/python -m pip install \
  -r native/adapter-ifc/tools/requirements-dev.txt

pnpm adapter:ifc:test
```

`pnpm adapter:ifc:test` looks for a Python interpreter with `pytest` and
`numpy` importable via `--python <path>`, `NARU_PYTHON`, then plain `python`/
`python3` on `PATH`, and runs `native/adapter-ifc/tests/`. This is separate
from `pnpm check`, the same way `native:check` is: it needs a Python
interpreter present, and CI installs the pinned IfcOpenShell development
requirements and runs it in its own `python-adapter` job.

## Persistent-cache identity

`tools/extract_federation_scene_ir.py --identity` performs no IFC extraction.
It emits `naru.ifc-adapter-identity.1`, whose fingerprint covers the adapter's
extraction, edge, placement, property-index, and property-column modules plus
the IfcOpenShell/numpy/Python/OS/architecture toolchain. The compiler combines
that identity with ordered discipline digests, stable URI hints, and every
compile-affecting option before it permits an adapter-skipping cache hit. An
unknown or malformed identity fails closed rather than reusing output.

## Stage timing (diagnostic only)

`--stage-timing <path>` writes a separate `naru.ifc-adapter-stage-timing.1`
ledger: interpreter start and import time, and per document the source read,
artifact load (read plus gunzip plus header), verification (header checks
plus one SHA-256 of the stored payload bytes), parse, restore or extraction,
and publication (`artifactState`, `artifactBytes`, `artifactPayloadBytes`,
`artifactLoadMilliseconds`, `artifactVerifyMilliseconds`,
`artifactParseMilliseconds`, and `artifactInvalidReason` when a stored entry
was refused); then the federation merge, property indexing, and each Scene IR
write. It never enters the adapter report, the Scene IR, or a cache key, so an
instrumented run produces byte-identical output
([integration test](tests/test_document_artifact_integration.py)). The
compiler consumes it through `stageTiming: true` for the
[ADR-0019 rebuild-stage record](../../artifacts/cache/rebuild-stages/README.md).

On a whole-package miss, `naru compile-ifc --cache <directory>` also supplies
`<directory>/ifc-documents` to the adapter. Each
`naru.ifc-document-artifact.4` entry contains the pre-federation extraction for
one discipline in one deterministic gzip, keyed by
discipline, source digest, URI hint, thread count, and the exact adapter
fingerprint. The gzip holds a one-line canonical-JSON header (schema, key,
key input, payload byte length, payload SHA-256, structure byte length)
followed by exactly that many payload bytes: the record structure as canonical
JSON, zero padding to an eight-byte boundary, then each hoisted binary
region as raw little-endian bytes in the dtype the Scene IR packer already
wants: first the mesh arrays, then the document's interned property value heap
with its `value_offsets`, `row_refs`, and `row_offsets` index tables, each
region padded to the same eight-byte boundary. The
loader verifies the stored bytes -- header fields, declared length, and one
SHA-256 over the payload bytes as read -- then parses only the structure
region and re-attaches the regions as typed views over the payload buffer,
so a mesh array or a property heap is never rebuilt element by element, and it
never re-serializes the parsed value to verify it
([ADR-0019](../../docs/adr/0019-document-artifact-transport.md)
slices 1, 2, and 3a, [tests](tests/test_document_artifact_cache.py)). A stored entry
that fails any check is reported as invalid with its reason, treated as a
miss, and re-extracted; the loader never loads executable serialization such
as pickle. Publication is atomic. The key input is unchanged across every
format bump, so an entry an earlier writer left at the same path is refused by its
schema line, re-extracted, and republished -- never silently reused.

Adapter report `naru.ifc-adapter-report.6` records ordered per-document hits and
misses. The compiler requires those lists to cover every selected discipline.
The real explicit-wall integration test proves cold, warm, and one-document-
changed adapter structure/geometry/property bytes equal a clean federation
build. The federation-level property columns and compiled package are still
rebuilt; this tier skips unchanged IfcOpenShell parsing/tessellation but does not
yet reuse old glTF byte ranges.

## Structure readiness (measurement only)

`tools/measure_structure_readiness.py` answers one question and does nothing
else: how long until a document's assembly tree exists? It scans the raw bytes
for the spatial keywords, opens the document with IfcOpenShell, walks
`IfcRelAggregates` and `IfcRelContainedInSpatialStructure` in deterministic
entity order, and serializes the tree, timing each step separately and emitting
`naru.ifc-structure-readiness.1`. It tessellates nothing, reads no properties,
writes no Scene IR, and is never called by a compile -- it exists to keep a
product target honest.

The answer, over both committed federations, is that producing a tree *is*
parsing: 98.46 percent (Digital Hub) and 98.60 percent (sixty5) of the time to a
serialized tree, against 1.3 percent for the walk. See
[artifacts/import/structure-readiness](../../artifacts/import/structure-readiness/README.md)
(`pnpm structure:readiness:check`, re-record with
`pnpm structure:readiness:evidence`), which is gate 0 of
[ADR-0021](../../docs/adr/0021-staged-hierarchy-first-import.md).

## Structure preview (`--structure-preview`)

`--structure-preview <directory>` makes the extraction publish each document's
assembly tree as soon as that document is parsed, before it is tessellated. The
tree is `naru.ifc-structure-preview.1` -- one node per `IfcProduct` and
`IfcProject`, carrying the same occurrence ids, names, and parents the Scene IR
will carry for that document -- written as `structure-<discipline>.json` and
named in an `index.json` (`naru.ifc-structure-preview-index.1`) that declares
each file's length and sha256. Every file is written to a temporary name,
flushed, fsynced, and renamed into place, and the index is rewritten the same
way after each document, so it never names a file that is not complete on disk.
A consumer verifies length and digest before parsing. A consumer may also hold a
file open while the adapter renames over it, which Windows refuses; the rename is
retried for two seconds before the failure is treated as real, so watching an
import cannot break it.

Documents are *emitted* smallest source first, so the first tree appears as
early as the federation allows. They are still *assembled* in the discipline
order `parse_inputs` returns, and every list the inspection returns is sorted
before use, so the Scene IR, the geometry and property binaries, and the
adapter report are byte-identical with the flag and without it. The flag is off
by default; with it absent, nothing in the path changes.

Emitting smallest first is not free at real-large scale, because it also decides
which document is *inspected* when. On sixty5 the flag costs 22.4 s (+7.75%) and
1.17 GB of peak working set (+24.8%): the largest document is inspected last,
with six documents' Scene IR already accumulated, instead of first into an empty
accumulator. Writing the trees themselves costs 201.9 ms. Digital Hub, whose
documents barely reorder, is unaffected. That is the price of a first tree at
0.690 s instead of 23.6 s, and the record below measures it rather than assuming
it away.

See [artifacts/import/structure-first-emission](../../artifacts/import/structure-first-emission/README.md)
(`pnpm structure:first-emission:check`, re-record with
`pnpm structure:first-emission:evidence`), which is gate 1 of
[ADR-0021](../../docs/adr/0021-staged-hierarchy-first-import.md).

## Reproduce the Digital Hub extraction

Fetch the external fixture, create an isolated Python environment, and use the
public compiler command documented in `packages/compiler/README.md`:

```sh
pnpm fixtures:external fetch ifc-bench-digital-hub
python -m venv output/venv-ifc
output/venv-ifc/Scripts/python -m pip install \
  -r native/adapter-ifc/tools/requirements-evidence.txt

pnpm naru compile-ifc \
  --document architecture=output/external-fixtures/ifc-bench-digital-hub/arc.ifc \
  --uri-hint architecture=projects/digital_hub/arc.ifc \
  --document heating=output/external-fixtures/ifc-bench-digital-hub/heating.ifc \
  --uri-hint heating=projects/digital_hub/heating.ifc \
  --document plumbing=output/external-fixtures/ifc-bench-digital-hub/plumbing.ifc \
  --uri-hint plumbing=projects/digital_hub/plumbing.ifc \
  --document ventilation=output/external-fixtures/ifc-bench-digital-hub/ventilation.ifc \
  --uri-hint ventilation=projects/digital_hub/ventilation.ifc \
  --python output/venv-ifc/Scripts/python \
  --threads 4 \
  --cache output/naru-compiled-cache \
  --output output/ifc/digital-hub
```

The Scene IR is a large disposable intermediate and stays under `output/`. The
adapter writes it as a split triple rather than one document: `--scene`
receives structure-only JSON whose representation geometry streams hold
`{encoding, byteOffset, byteLength}` references, `--geometry` receives the
concatenated little-endian streams those references point into, and
`--properties` receives the binary property value columns
(`madi.property-columns.1`): every distinct semantic property value encoded
once as canonical compact JSON in a byte-sorted UTF-8 heap, with u32 reference
and offset columns joining each semantic's row back to its interned key set.
Keys and values are interned once per document and the federation pass dedupes
and re-sorts the already encoded bytes, so a document's artifact can carry its
own columns and nothing re-encodes a value
([ADR-0019](../../docs/adr/0019-document-artifact-transport.md) slice 3a).
Every stream starts on an eight-byte boundary so the compiler can take
typed-array views without copying, and the report carries a SHA-256 for each
of the three files. Reviewed counts and hashes live under `artifacts/ifc/`;
normal CI validates those compact records without installing IfcOpenShell or
downloading the IFC sources.

For the small project-owned E2.1 record, use the command in
`artifacts/ifc/explicit-edges/README.md`; `pnpm ifc:edges:check` independently
proves that six triangle face diagonals are absent from the 12 explicit wall
boundaries.

IfcOpenShell is LGPL-3.0-or-later. It is an adapter dependency and is not
bundled into NARU's browser runtime.
