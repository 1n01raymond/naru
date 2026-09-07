# NARU workspace

`@naru3d/workspace` owns the `naru.workspace.2` document (`naru.workspace.1`
is still read and treated as an empty annotation list): a versioned,
non-authoritative record of what an import pointed at and what the user was
looking at. It holds the format, a fail-closed parser, a canonical serializer,
and the pure decision that a reopen makes. It depends on no renderer, no
compiler, and no host API, so the same code runs in the Studio, in Node, and in
an embedder.

The design and its gates are [ADR-0022](../../docs/adr/0022-workspace-manifest.md).

## What a workspace is, and is not

Under [ADR-0002](../../docs/adr/0002-source-and-cache.md) the native CAD/BIM
documents remain source of truth. A workspace stores composition and review
intent: one package reference with the identities the import already computed,
the sources it consumed, and one view. It stores no geometry, no property
values, and no copy of anything a package or a source already holds.

It is also not a cache entry. A whole-package cache hit
([ADR-0009](../../docs/adr/0009-persistent-compiled-cache.md)) proves an
input-to-output identity; it carries no camera, no selection, and no answer to
"did the source move".

## The document

```jsonc
{
  "schemaVersion": "naru.workspace.2",
  "label": "Digital Hub review",
  "package": {
    "reference": { "kind": "url", "href": "https://example.test/digital-hub/" },
    "packageDigest": "<64 lowercase hex>",
    "resources": [{ "path": "scene.bin", "byteLength": 1234, "sha256": "<64 hex>" }]
  },
  "sources": [
    { "key": "architecture", "label": "arc.ifc", "byteLength": 1234, "sha256": "<64 hex>" }
  ],
  "view": {
    "camera": { "yaw": 0, "pitch": 0, "panRight": 0, "panUp": 0, "zoom": 1 },
    "section": { "enabled": false, "axis": "x", "direction": 1, "fraction": 0.5 },
    "hiddenOccurrenceIds": [],
    "selectedOccurrenceId": null,
    "annotations": [{ "position": [58.6, 2.4, -6.6], "text": "Check slab thickness here" }]
  }
}
```

Package and resource identity is copied from `build-report.json`
(`output.packageDigest`, `output.resources[]`); source identity from
`adapter-report.json` (`sources[]`). A workspace never asserts an identity the
pipeline did not compute.

Selection and visibility are keyed by `occurrenceId`, never by node index: node
order is an emission detail, so an index silently rebinds to a different element
after a recompile. The section plane stores an axis, a direction, and a
fraction; its bounds are derived from the scene on reopen, so the document
carries no absolute coordinate.

## Reading and writing

```ts
import { parseWorkspace, serializeWorkspace } from "@naru3d/workspace";

const workspace = parseWorkspace(text);
const bytes = serializeWorkspace(workspace); // canonical, ends with one newline
```

`serializeWorkspace` is deterministic: sources are ordered by key, resources by
path, hidden occurrence ids deduplicated and sorted, keys emitted in a fixed
order, JSON compact, one trailing newline. Two hosts holding the same workspace
write the same bytes. The document carries no timestamp, no host name, no
absolute path, and no user identity.

`parseWorkspace` and `normalizeWorkspace` are fail-closed and throw
`WorkspaceError` with `UNSUPPORTED_SCHEMA`, `INVALID_WORKSPACE`, or
`LIMIT_EXCEEDED`. The parser performs no network access and resolves no
filesystem path. It accepts only `http` and `https` package hrefs without
embedded credentials, and stores a local package as a bare file name rather than
a path. `schemaVersion` is checked first; within a version this repository
issued, an unknown key is refused as corruption rather than ignored. A manifest
that names no source is refused too: it would otherwise reopen as `verified`
with `geometryIsCurrent` true while nothing about that geometry's provenance had
been checked. Every collection and string is bounded by
`defaultWorkspaceParseLimits`, which an embedder may tighten through the
`limits` option.

## Deciding a reopen

```ts
import { evaluateWorkspaceReopen } from "@naru3d/workspace";

const decision = evaluateWorkspaceReopen(workspace, {
  packagePresent: true,
  packageDigest,
  resources,
  resourcesComplete: true,
  sourceInspection: "unavailable",
  occurrenceIds,
});
```

Each part is judged `verified`, `changed`, `missing`, or `unverifiable`, and the
whole reopen resolves to `verified`, `changed-source`, `changed-package`,
`unverifiable`, or `blocked` in the precedence `blocked > changed-source >
changed-package > unverifiable > verified`. Source outranks package because the
source is authoritative: a package that still matches its digest while its
source moved is stale output, not a clean reopen.

`sourceInspection: "unavailable"` means the host cannot inspect sources -- a
browser tab cannot stat a local IFC file -- and never that no source moved. It
yields `unverifiable`, which never collapses into `verified`.
`decision.geometryIsCurrent` is true only in the fully `verified` state, so
stale geometry is never labelled current by omission.

The view is resolved against the occurrence ids the reopened hierarchy actually
carries: ids it no longer holds are reported in `droppedHiddenOccurrenceIds` and
`droppedSelection` rather than silently discarded. Without an
`occurrenceIds` set the view is carried through untouched and
`resolvedAgainstHierarchy` is false.

## Tests

```bash
pnpm test
```

[`test/document.test.ts`](test/document.test.ts) covers the round trip, the
canonical byte equality, and every refusal the trust boundary owes;
[`test/reopen.test.ts`](test/reopen.test.ts) covers the per-part states, the
precedence, the package-observability combinations, and view resolution.

What the tests cannot show is the renderer acting on a reopen decision. That is
recorded once, in a headed browser, in
[`artifacts/workspace/reopen/`](../../artifacts/workspace/reopen/README.md).
