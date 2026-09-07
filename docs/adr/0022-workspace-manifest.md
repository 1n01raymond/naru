# ADR-0022: Persist a non-authoritative workspace manifest keyed by source and package identity

Status: Accepted

Accepted: 2026-09-05

## Context

Phase 2 leaves one exit criterion untouched: *a workspace reopens against
unchanged source and detects changed source*. Everything the criterion needs
already exists as separate identities, and none of them is a workspace.

- [ADR-0002](0002-source-and-cache.md) settles ownership: native CAD/BIM
  documents remain source of truth, and NARU data stores composition and review
  intent. A workspace is therefore a record of intent, never an authority on
  what the model contains.
- [ADR-0009](0009-persistent-compiled-cache.md) keys a compiled cache by
  complete import identity. That is an input-to-output map, not a session: it
  answers "may I skip this compile", not "what was the user looking at". The
  tracker records the distinction as a dependency-order rule -- a whole-package
  cache hit is not a saved workspace.
- The compiler already publishes the identities a reopen needs.
  `build-report.json` carries `output.packageDigest` and, per resource,
  `{path, mediaType, bytes, sha256}`; `adapter-report.json` carries, per source,
  `{path, discipline, schema, sha256, byteLength}`. Nothing new has to be
  invented to name what a workspace points at.
- The runtime already carries a stable key for view state.
  `CompiledHierarchyEntry.occurrenceId` survives a recompile; the node index
  beside it does not, because node order follows the document the compiler
  happens to emit.

The crux is a capability, not a format. A browser tab cannot stat a local IFC
file. It can verify everything it fetched -- resource byte lengths and SHA-256
values are already checked before decode ([ADR-0011](0011-remote-package-limits.md))
-- but it cannot, unaided, tell whether the IFC document that produced the
package still hashes to what the import recorded. A design that ignores this
either lies (calls an unchecked source unchanged) or is useless in the one
client that matters (calls every reopen suspect). This ADR takes the third
option: it records what was verified, what was not, and why.

## Decision

Persist a versioned, non-authoritative workspace manifest, and decide a reopen
from it with a pure function over observed evidence.

1. **Schema ownership.** `naru.workspace.1` (now `naru.workspace.2`, see the
   amendment below) is owned by a new runtime-free
   package, `@naru3d/workspace`. It depends on no renderer, no compiler, and no
   host API, so the same parser runs in the Studio, in Node, and in an
   embedder. The identifier is new, so it takes the `naru.` prefix
   ([ADR-0007](0007-rebrand-naru.md)); no frozen `madi.*` identifier moves.
2. **What it stores.** A label; one package reference with its digest and its
   resource list; the sources the import consumed; and one view -- camera,
   section, hidden set, selection. It stores no geometry, no property values,
   no adapter output, and no copy of anything a package or a source already
   holds. It is a pointer plus intent.
3. **What identity it records.** The package by `packageDigest` plus every
   resource as `{path, byteLength, sha256}`; each source by a stable key with
   its `byteLength` and `sha256`. Both are copied from the reports the import
   already wrote, so a workspace never asserts an identity the pipeline did not
   compute. A manifest naming no source is refused on both sides -- the writer
   will not build one and the parser will not accept one -- because it would
   otherwise reopen as `verified` with `geometryIsCurrent` true while nothing
   about that geometry's provenance had been checked.
4. **How view state is keyed.** Selection and visibility are keyed by
   `occurrenceId`. Node indices are never persisted. The section plane is
   stored as axis, direction, and a fraction in `[0, 1]`; its bounds are
   derived from the scene on reopen, so a manifest carries no absolute
   coordinate.
5. **How a reopen is decided.** `evaluateWorkspaceReopen` is pure: it takes the
   parsed document and an observation of what the host could see, and returns a
   per-part verdict plus one overall state. Per part the states are `verified`,
   `changed`, `missing`, and `unverifiable`; overall they are `verified`,
   `changed-source`, `changed-package`, `unverifiable`, and `blocked`, in the
   precedence `blocked > changed-source > changed-package > unverifiable >
   verified`. Source outranks package because the source is authoritative under
   ADR-0002: a package that still matches its digest while its source moved is
   stale output, not a clean reopen.
6. **The host capability, named.** The observation carries
   `sourceInspection: "available" | "unavailable"`. `unavailable` means the host
   cannot inspect sources -- it never means no source moved. It produces
   `unverifiable`, which never collapses into `verified`. The decision exposes
   `geometryIsCurrent`, true only in the fully `verified` state, so stale
   geometry is never labelled current by omission.
7. **Migration.** `schemaVersion` is checked first and any value this build was
   not written for is refused with `UNSUPPORTED_SCHEMA`. Within a version this
   repository issued, an unknown key is refused as corruption or tampering
   rather than ignored. A future version announces itself through
   `schemaVersion`; that is the only forward channel, and adding a field costs a
   schema bump.
8. **Portability.** The document carries no timestamp, no host name, no
   absolute path, and no user identity. A URL package is stored as its href; a
   local package is stored as a bare file name, never a path, because a path is
   not a capability and a host layout is not portable. Serialization is
   canonical -- sources ordered by key, resources by path, hidden occurrence ids
   deduplicated and sorted, a fixed key order, compact JSON, one trailing
   newline -- so the same workspace serializes to the same bytes anywhere.
9. **Trust limits.** The parser performs no network access, resolves no
   filesystem path, and accepts only `http` and `https` package hrefs without
   embedded credentials. Every collection and every string is bounded by
   `defaultWorkspaceParseLimits`, which an embedder may tighten. Length ceilings
   bound work; patterns decide validity; a wrong shape is refused rather than
   repaired.

## Amendment 2026-09-08: `naru.workspace.2`

The view gained `annotations`, an ordered list of `{ position, text }` notes
anchored to world-space surface points (at most 10,000 notes of at most 1,024
characters each, `LIMIT_EXCEEDED` past either bound). The schema id moved to
`naru.workspace.2`; the parser still accepts `naru.workspace.1` and reads it
as an empty annotation list, but the serializer only ever writes `.2`. The
[round-trip record](../../artifacts/workspace/reopen/README.md) was re-taken
under the new schema and reproduced every count and state; both manifests grew
by exactly the 17 bytes of the empty list.

## Consequences

### Positive

- The one Phase 2 exit criterion with no artifact behind it gains a concrete,
  testable contract, and the contract is small enough to land before any Studio
  code changes.
- A reopen states what it verified. "This package is the one you saved, and its
  source could not be checked here" is an honest sentence a browser can say;
  "unchanged" is not.
- The manifest is portable by construction. Two hosts that hold the same
  package and sources reach the same verdict from the same bytes, because the
  document contains nothing host-specific to disagree about.
- Keying view state by `occurrenceId` makes a workspace survive a recompile of
  the same source, which is the case the criterion is actually about.
- A runtime-free package keeps the format usable by an embedder, a CLI, or a
  test without pulling in WebGPU, and keeps the trust boundary in one file.

### Negative

- A browser reopen against local sources reports `unverifiable`, not
  `verified`, until a host capability exists to hash the source. That is the
  honest state, but it means the pleasant case is unavailable in the default
  client until a later slice supplies the capability.
- Storing a bare file name means a local package cannot be re-fetched
  automatically; the user re-picks the file. This is deliberate -- a persisted
  path is both unportable and a small filesystem oracle -- but it is friction.
- Refusing unknown keys forbids additive forward compatibility inside a
  version. A new optional field is a schema bump with a parser change, not a
  quiet addition.
- The section plane is restored by fraction, so reopening against a scene with
  different bounds moves the plane in world units. Preserving the absolute
  offset instead would break the more common case, a recompile of the same
  model whose bounds shifted slightly.
- `occurrenceId` stability is inherited, not enforced here. If an adapter
  changes how it derives occurrence identity, saved selections and hidden sets
  degrade to dropped ids -- reported, but dropped.
- Isolation is not a field. The manifest stores the hidden set, so a
  workspace saved while one occurrence is isolated persists only the explicit
  hidden set and reopens with everything else visible. The Studio says so at the
  moment of saving rather than restoring a different view silently; carrying
  isolation would cost a schema bump under item 7.
- A workspace can only be saved from a package whose reports name every source
  with a digest and a byte length. An OCCT STEP package states one source
  without a byte length, so saving refuses and names the gap instead of writing
  a manifest whose source half could never be verified.

## Alternatives considered

- **Persist node indices.** Smallest possible manifest, and wrong: node order is
  an emission detail, so a recompile silently rebinds a saved selection to a
  different element. Rejected.
- **Ignore unknown keys.** The tolerant reading is attractive across versions,
  but within a version this repository issued, an unrecognized key is corruption
  or tampering, and ignoring it hides both. `schemaVersion` already carries the
  version conversation. Rejected.
- **Store absolute source paths and reopen them directly.** Convenient on one
  desktop, unportable everywhere else, and it records host layout in a document
  meant to be shareable. Rejected in favour of a key plus a digest, with
  re-selection left to the host.
- **Fold `unverifiable` into `verified`.** Would make a browser reopen look
  clean while a source may have moved -- exactly the failure the criterion
  exists to catch. Rejected.
- **Fold `unverifiable` into `changed`.** Safe but useless: every browser reopen
  would warn, so the warning would carry no information. Rejected.
- **Reuse a compiled cache entry as the workspace.** The tracker already rules
  this out: a cache hit proves an input-to-output identity, not a session, and
  it holds no view, no selection, and no user intent. Rejected.
- **Embed the manifest inside the compiled package.** The package is
  content-addressed output; a workspace mutates every time the camera moves.
  Storing them together would either break the package digest or freeze the
  workspace. Rejected.

## Validation

Per the Phase 2 routing decision that evidence which does not close a roadmap
exit criterion is a test rather than a fresh-process record, gates 0 through 3
are unit tests in this repository and gate 4 is the single browser record. The
Studio half of gates 1 through 3 is proven over the translation layer the
Studio calls -- `apps/webgpu-spike/src/workspace-session.ts`, whose reader of
the two import reports is covered against their committed shapes by
[`apps/webgpu-spike/test/package-identity.test.ts`](../../apps/webgpu-spike/test/package-identity.test.ts)
-- because a unit test can exercise the decision but not the renderer acting on
it.

0. **Schema and decision contract.** Met by this slice:
   [`packages/workspace/test/document.test.ts`](../../packages/workspace/test/document.test.ts)
   covers canonical byte-identical serialization regardless of input ordering,
   every refusal the trust boundary owes (foreign `schemaVersion`, unknown key,
   non-`http(s)` and credentialed references, path-shaped local names, malformed
   digests, duplicate keys, each limit), and
   [`packages/workspace/test/reopen.test.ts`](../../packages/workspace/test/reopen.test.ts)
   covers the four per-part states, the five-state precedence, and
   `geometryIsCurrent`.
1. **Studio round trip.** Met at the translation layer by
   [`apps/webgpu-spike/test/workspace-session.test.ts`](../../apps/webgpu-spike/test/workspace-session.test.ts),
   which captures a view the Studio would capture, serializes it, reopens it
   against unchanged evidence, and resolves the restored occurrence ids back to
   the object ids the renderer uses: camera, section, hidden set, and selection
   all restored, and the ids a recompiled hierarchy no longer carries reported
   as dropped rather than silently discarded. What that test cannot show is the
   renderer acting on the result, which is what gate 4 records.
2. **Changed-source detection through the Studio.** Met at the translation
   layer by the same test file: a captured workspace whose observed source bytes
   moved reopens as `changed-source` with `geometryIsCurrent` false while the
   package half still reads `verified`, and sources the host could not inspect
   read `unverifiable` rather than `verified`. The real single-parameter IFC
   edit -- the one the rebuild-stage records already use -- belongs to gate 4.
3. **Portability.** Met by the same test file, which round-trips a manifest this
   host did not write back to identical bytes and asserts over every string in a
   serialized document that no path separator, no backslash, and no timestamp
   appears, and that no `recordedAt` or `host` key exists.
4. **The exit criterion.** Met by
   [`artifacts/workspace/reopen/`](../../artifacts/workspace/reopen/README.md)
   (`naru.workspace-reopen-evidence.1`, `pnpm workspace:reopen:check`): one
   headed Chrome 151 run over the Digital Hub package `0e2ed4547e29...` saves a
   session of three hidden walls, one selected slab, a section plane at 35% and
   a moved camera as an 1,871-byte manifest; reopens it against the unchanged
   package as `unverifiable`, then `verified` once the four sources are
   inspected, restoring every part and re-saving the same 1,871 bytes with the
   same digest; reopens it after a same-length `7.77 -> 9.77` extrusion edit to
   `arc.ifc` as `changed-source` with `geometryIsCurrent` false while the
   package still reads `verified`; and reopens it once more through a forced
   reload so both of the Studio's restore paths are recorded, producing a
   screenshot byte-identical to the unchanged arm. Zero console issues.

Failing gate 1 or gate 2 rejects this ADR rather than loosening it, on the
precedent [ADR-0018](0018-content-addressed-compiled-payloads.md) set: a design
that misses the gate it declared is rejected by that gate, and the measurement
stays committed.
