# ADR-0017: Move the assembly tree into a package sidecar

Status: Accepted
Accepted: 2026-08-29

## Context

ADR-0015's record
([`artifacts/compiler/node-field-elision`](../../artifacts/compiler/node-field-elision/README.md))
measured where a federation's compiled glTF document spends its bytes and
ranked the levers against that split. The largest candidate by a wide margin
was not a field but a class of node: the 163,665 nodes of the engineering
baseline that carry no mesh — the assembly tree — at 88,741,293 B, 21.88% of
the 405,570,167 B document. That figure is an upper bound, not a saving. Those
nodes are what the Studio's tree panel shows, what search walks, and what a
selected part is named by; a viewer cannot simply drop them.

The document is nonetheless the wrong place for them. It is the one resource a
client must fetch and parse in full before it can draw anything: the loader
reads it as a single string, so its size sets both the time to first frame and
a hard ceiling — V8's 536,870,888-byte maximum string length, which ADR-0016
already had to stream around. Meanwhile the tree is read on the main thread,
after the first frame, and never by the geometry Worker at all.

The package already has the shape for this. Properties moved out of the
document in E2.2b as `properties.json` + `properties.bin`, a compact JSON
header over columnar bytes, pointed at from `extras.madi` and folded into the
package digest and the compiled-cache key. Nothing about the assembly tree
argues for a different mechanism.

## Decision

Add an opt-in compiler option, `--relocate-hierarchy-nodes`, that writes the
mesh-less nodes to a package sidecar — `hierarchy.json` + `hierarchy.bin`,
schema `naru.package-hierarchy.1` — instead of into the document.

- The document keeps only the nodes that draw. Each carries its composed world
  matrix, so the runtime needs no ancestor to place it, and `children`
  disappears from the document entirely; every retained node is a scene root.
- The document declares `extras.madi.hierarchy` with the header's URI, byte
  length, and digest, plus the entry and relocated counts, so a client can see
  what it will fetch before fetching it; the header in turn names the columns
  resource. The build report records `options.hierarchyNodes: "relocated"`
  beside its URIs, both sidecar resources appear in the resource list, and both
  are folded into the package digest and the compiled-cache key exactly as the
  property sidecar is.
- The option defaults **off**. Turning it on changes the package digest, so it
  is a deliberate choice, never an implicit one — the same rule ADR-0013 and
  ADR-0015 follow.
- `inspectCompiledHierarchy` fails closed. If the document declares the
  pointer and no sidecar is supplied, it throws
  `PackageHierarchyError("INVALID_HIERARCHY")` rather than answering with the
  nodes that happened to stay behind.
- A caller that decodes geometry and never reads the tree declares
  `hierarchy: "geometry-only"` and gets an **empty** tree. Returning the
  retained nodes to it would look exactly like a complete small tree, which is
  the failure this option exists to keep visible. The Studio's geometry Worker
  was that caller when this decision was taken; since the document-retention
  work of 2026-09-12 it parses the document itself, so it reads the sidecar
  there and posts the tree back instead of declining it. The sentinel remains
  part of the reader's contract for callers that only decode geometry.
- `renderableOccurrences` is derived from the document, not from the tree, so
  it stays exact for a geometry-only caller. That is sound precisely because
  relocation moves only nodes that draw nothing.

## Consequences

### Positive

Measured in
[`artifacts/compiler/hierarchy-relocation`](../../artifacts/compiler/hierarchy-relocation/README.md)
(`naru.hierarchy-relocation.1`):

- The engineering baseline's document drops 88,103,984 B, from 405,570,167 to
  317,466,183 (−21.72%); Digital Hub's drops 4,690,282 B (−22.81%). Nearly the
  whole ranked bound is realised where it matters most — the resource on the
  critical path to the first frame.
- 163,664 of 268,002 nodes (61.07%) leave the document; the tree the client can
  still read is unchanged, entry for entry.
- The geometry Worker no longer parses the assembly tree at all.
- Both models compile byte-identically on repeat, sidecar included.

### Negative

- The whole package saves only 2.6–2.7% (−23,278,746 B on the engineering
  baseline, −1,668,983 B on Digital Hub), because the tree still has to be
  carried: the sidecar costs 64,825,238 B and 3,021,299 B respectively. A
  client that downloads everything gains almost nothing. The record states
  this next to the document figure rather than under it, and asserts the
  arithmetic (`netMatchesPackage`) so the two cannot drift apart.
- A relocated package is two resources larger, and a consumer that reads the
  tree must fetch a second file. Existing consumers are unaffected only
  because the option is off by default.
- The tree is no longer human-readable in `scene.gltf`. Inspecting a relocated
  package's structure means decoding columnar bytes.
- Flattening loses the document's parent/child links. The sidecar carries the
  depth of every entry, which is what the tree panel and search need, but a
  consumer that wanted glTF-native nesting no longer has it.

## Alternatives considered

**Leave the tree in the document and compress the fields instead** (ADR-0015's
levers). Measured at 5.78% of the document combined — real, additive, and
already shipped, but a quarter of what relocation reaches, and it does not
take the tree off the first-frame path at all.

**Drop mesh-less nodes entirely.** The largest possible saving and the wrong
product: the tree panel, search, and selection naming are what a BIM
federation is opened for.

**Stream the tree from the existing property sidecar.** One fewer resource,
but it welds two independently useful things together: a viewer that shows a
tree and no properties would fetch both, and the property columns' schema
would have to carry structure it has no other reason to model.

**Make relocation the default.** Still rejected, but no longer for want of
evidence. The browser record below shows the smaller document is worth having,
so the remaining objection is only about when: flipping the default re-digests
every committed package and the deployed demo's release asset, and
`naru.package-hierarchy.1` is still `status: experimental-not-interchange`.
The default moves in its own slice, together with that schema's promotion and
the re-records it forces, not as a side effect of this one.

## Validation

Gate: `pnpm hierarchy:relocation:check` over
`artifacts/compiler/hierarchy-relocation/hierarchy-relocation.json`
(`naru.hierarchy-relocation.1`), wired into `pnpm check`.

Met by the record:

- document and package deltas on both models, with the sidecar charged
  against the bytes it removes (`documentBytes + sidecarBytes ===
  packageBytes`, asserted);
- a `documentLedger` that closes to the byte, so the delta is explained
  (`nodes` −88,723,457, `scenes` +619,254, pointer +219 on the engineering
  baseline);
- round trip on Digital Hub through the runtime loader: 13,681 hierarchy
  entries compared name, depth, and identity for identity, and 5,152
  occurrence world transforms compared element by element with `Object.is` —
  0 mismatches, identical decoded geometry;
- byte-identical repeat compiles for both models.

Second gate, which closed this ADR: `pnpm hierarchy:browser:check` over
`artifacts/ifc/relocated-hierarchy-browser/relocated-hierarchy-browser.json`
(`naru.relocated-hierarchy-browser.1`), also wired into `pnpm check`. Two
sixty5 packages compiled from the same split, differing only in where the
mesh-less nodes live -- `scene.bin`, `coarse.bin`, `properties.json`, and
`properties.bin` byte-identical between them -- run three times each,
interleaved, in fresh headed Chrome processes:

- first coarse frame 4,702 -> 3,966 ms (-15.65%), peak JS heap 856,279,408 ->
  697,327,573 B (-18.56%), budget-limited ready 9,953 -> 9,834 ms; the arms'
  spreads do not overlap on either headline;
- hierarchy-ready 2,313 -> 2,290 ms: reading the tree from a fetched sidecar
  costs about what reading it from the document did, which is the honest
  reading of a -0.99% move;
- `hierarchy.bin` fetched exactly once per run, as response 3 of 118, ahead of
  `coarse.bin`, and never fetched by the in-place arm -- both derived per run
  from the response stream;
- the same endpoint over 17 counters in all six runs (111 of 234 chunks,
  66,686,508 decoded / 66,783,808 GPU bytes, 2,255,235 triangles, the same
  picked occurrence and its 44 property entries), 0 console issues.

Both arms were re-captured on 2026-09-07, after the Studio camera fix and the
view cube; every counter above reproduced and the wall-clock and heap figures
are that capture's.

The one deliberate difference is the picked node index (74387 -> 37247): a
relocated document keeps only the nodes that draw, so they are renumbered.

Both records' digests are host-local to this Windows host, as their validators
state. What remains open is not this decision but the default question above,
which is a separate slice.
