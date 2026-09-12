# Relocating mesh-less hierarchy nodes out of the compiled document

Status: recorded product evidence for the mesh-less node lever; supports
ADR-0017 (Proposed).

The node-field record
([`artifacts/compiler/node-field-elision`](../node-field-elision/README.md))
ranked this lever first, by an **upper bound**: every byte of every node that
carries no mesh, 88,741,293 B or 21.88% of the engineering baseline's
document. An upper bound is not a saving — those nodes are the assembly tree,
and a viewer that shows a tree still has to carry them. This record measures
what happens once they are carried somewhere else.

`--relocate-hierarchy-nodes` moves them into a package sidecar
(`hierarchy.json` + `hierarchy.bin`, `naru.package-hierarchy.1`), the same
shape the property sidecar already uses. The document keeps only the nodes
that draw, each with its composed world matrix baked on, listed flat in the
scene; `children` disappears entirely.

Both models compile from a retained Scene IR split under the engineering
baseline's option policy (compact JSON, omitted resource names, spatial index,
`spatial-leaf-anchor-v1` payload order). `baseline` is today's default output;
`relocated` adds only the new option.

## What it costs and what it recovers

| | Digital Hub | Engineering baseline |
|---|---:|---:|
| Nodes relocated | 8,529 of 13,682 (62.34%) | 163,664 of 268,002 (61.07%) |
| Document, default | 20,562,117 B | 405,570,167 B |
| Document, relocated | 15,871,835 B | 317,466,183 B |
| **Document change** | **−4,690,282 B (−22.81%)** | **−88,103,984 B (−21.72%)** |
| Sidecar added | 3,021,299 B | 64,825,238 B |
| Package, default | 63,180,193 B | 854,447,023 B |
| Package, relocated | 61,511,210 B | 831,168,277 B |
| **Package change** | **−1,668,983 B (−2.64%)** | **−23,278,746 B (−2.72%)** |

Read those two rows together. The document — the resource a client must fetch
and parse in full before it can draw anything — loses roughly the whole
21.88% the ranking predicted. The package loses 2.6–2.7%, because the tree is
still there; it moved. A client that downloads everything saves little. A
client that opens a model and starts drawing parses 317 MB instead of 405 MB
and fetches the 64.8 MB sidecar only when someone reads the tree.

`delta.netMatchesPackage` is the arithmetic that keeps this honest: the
document saving minus the sidecar cost equals the package saving exactly, so
no other resource moved under cover of the comparison.

## Where the document's bytes went

Engineering baseline, from `documentLedger`:

| Member | Change |
|---|---:|
| `nodes` | −88,723,457 B |
| `scenes` | +619,254 B |
| remainder (the `extras.madi.hierarchy` pointer) | +219 B |
| **document** | **−88,103,984 B** |

The node array sheds 88,723,457 B where the mesh-less nodes themselves were
88,741,293 B: 163,664 of the 163,665 leave (one stays as the scene's root
placeholder, 192 B), and the nodes that remain change by a further 17,644 B as
their `children` members vanish and a composed world matrix is baked on. The
same two forces point the other way on Digital Hub, where the retained nodes
shrink by 79,841 B. The flattened scene then has to list all 104,338 retained
roots, which is what the `scenes` growth is. The ledger closes to the byte in
both models, so the record explains its own delta instead of asserting it.

## The tree still says the same thing

`roundTrip` compiles Digital Hub both ways and decodes both through the
runtime loader:

- 13,681 hierarchy entries compared name for name, depth for depth, identity
  for identity — **0 mismatches**;
- 5,152 occurrence world transforms compared element by element with
  `Object.is` — **0 mismatches**;
- identical geometry both ways (3,383 prototype batches, 40,596 triangles,
  3,085,296 B of coarse binary);
- the relocated document holds 5,153 nodes against the default's 13,682, and
  still reports all 5,152 renderable occurrences.

Reading the tree from a relocated package requires its sidecar. The loader
fails closed if the pointer is declared and no sidecar is supplied, and a
caller that only decodes geometry says so (`hierarchy: "geometry-only"`) and
gets an empty tree rather than the handful of nodes that stayed behind — a
partial tree presented as a whole one is the failure the option exists to keep
visible. The Studio is not that caller: since 2026-09-12 its geometry Worker
owns the only parsed copy of the document, so it reads the sidecar there and
posts the decoded tree to the thread that renders the panel.

## Determinism

Each model's relocated variant was compiled twice in separate processes. The
document digest, the package digest, and the `hierarchy.bin` digest are
identical across the repeat in both models (`determinism.identical`).

## Host locality

The byte counts and digests are **host-local**. This Windows host's IFC
adapter emits a Scene IR split a few bytes different from the macOS host's, so
package digests here (`04472c9ad292` default, `f908c7df6728` relocated for the
engineering baseline) do not reproduce on another machine. The validator says
so, and they must not be retargeted to make a re-record pass.

## Reproducing

```
pnpm hierarchy:relocation:evidence
pnpm hierarchy:relocation:check
```

The recorder needs retained Scene IR splits at `output/ifc/digital-hub-split4`
and `output/ifc/engineering-baseline`, compiles six packages in separate 6 GB
processes, and takes roughly seven minutes on this host.
