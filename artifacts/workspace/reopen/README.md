# A workspace saved, reopened, and reopened after an edit

Status: recorded product evidence; closes gate 4 of
[ADR-0022](../../../docs/adr/0022-workspace-manifest.md) and the Phase 2 exit
criterion *a workspace reopens against unchanged source and detects changed
source* ([tracker](../../../docs/PHASE_2.md)).

Gates 0 through 3 of ADR-0022 are unit tests: the manifest serializes
canonically, the trust boundary refuses what it should, the reopen decision
returns the five states in the right precedence, and the Studio's translation
layer captures and restores a view. What none of them can show is the renderer
acting on the result — a person hiding walls in a browser, closing the tab, and
getting that session back. This record is that, in four arms of one run.

## What each arm answers

| Arm | Question | Answer |
|---|---|---|
| `save` | Does the Studio save a manifest that describes the session a person set up? | 1,663 B before the interaction, **1,871 B** after it, digest `5949870b1980…` |
| `unchanged` | Does the same workspace reopen against an unchanged package? | `unverifiable` → **`verified`**, and a re-save byte-identical to what was saved |
| `changedSource` | Does the same workspace report a source that moved under it? | **`changed-source`**, `geometryIsCurrent` false, package still `verified` |
| `reload` | Does a reopen that must load the package first restore the same view? | `unverifiable` → **`verified`**, re-save byte-identical again |

## Method

One headed Chrome 151.0.7922.139 (Blink) at 1320x1000 on Windows, against the
Digital Hub federation compiled to `output/ifc/digital-hub-split4` — four IFC
documents, 67.8 MB of source, package `0e2ed4547e29…`, 84.5 MB over five
resources — served by Vite with Range support at
**`http://127.0.0.1:4176/`**. Before the browser starts, the recorder hashes
every package resource against `build-report.json` and every source document
against `adapter-report.json`, so what the browser is shown is what the
compiler says it compiled.

The origin is pinned because it is *inside the evidence*: a workspace names its
package by URL, so the manifest digests below hold only for this port. A record
served elsewhere is a different record, not a failing one.

The interaction is scripted, so the saved view is reproducible: hide hierarchy
rows 0, 1 and 2 (three `Basiswand:STB 300` walls), select row 3
(`Bodenplatte:STB 300:2398103`), enable the section plane, flip it to −z, set it
to 35%, then drag and wheel the camera to yaw 0.0546 / pitch 0.2555 / zoom
1.4333. Every one of those lands in the manifest, and the validator pins all of
them — including the three occurrence ids and the camera floats.

The edit is one parameter of one entity, the same kind the rebuild-stage
records use: `#823= IFCEXTRUDEDAREASOLID(#817,#822,#20,7.77)` becomes `9.77` in
a copy of `arc.ifc`. The file keeps its **9,022,255 bytes** and changes digest
`19d7d02d53c2…` → `b428d64184f7…`, which is what makes the changed-source arm a
statement about content rather than about size.

## Results

**Save.** The Studio saves `http-127.0.0.1-4176-scene.gltf.naru-workspace.json`
twice: once on the untouched view (1,663 B, `986dad7cbe08…`, *"Saved 0 hidden
occurrence(s) and 4 source(s)"*), once after the interaction (1,871 B,
`5949870b1980…`, *"Saved 3 hidden occurrence(s) and 4 source(s)"*). The two
differ, which is what makes the round trip below a claim about a session rather
than about an empty view. The customized manifest carries
`schemaVersion: "naru.workspace.1"`, the package reference as a URL, the
package digest, all five resource digests, all four source digests, three
hidden occurrence ids, one selection, the section plane, and the camera.

**Reopen against an unchanged package.** Reopening reports **`unverifiable`**
first — the manifest's source digests are a claim the Studio has not yet
checked, and it says so rather than assuming — and restores 3 hidden
occurrences, the selection, the section plane at 35% and the camera, dropping
nothing. Pressing *Check sources* re-reads the four IFC documents and the state
becomes **`verified`** with `geometryIsCurrent: true`. Saving again produces
**1,871 bytes with digest `5949870b1980…`** — byte-identical to what was saved.
That equality is the restoration proof: an approximate restore would serialize
differently.

**Reopen after a source edit.** With the edited `arc.ifc` in place and nothing
else changed, the same workspace reopens as **`changed-source`**:
`geometryIsCurrent: false`, `sources: changed`, and — importantly —
`package: verified`. The package is intact; the document it was compiled from
is not, so [ADR-0002](../../../docs/adr/0002-source-and-cache.md) precedence
makes the native document win. The status line names the document:
*"Source evidence: arc.ifc (changed)."* The view is still restored, so a person
sees their session and a warning, not an error page.

**Reopen through a reload.** Booting on `scene.gltf?reopen=1` forces the other
of the Studio's two reopen paths — the package is loaded first and the
workspace restored onto it, instead of restored in place. Same result:
`unverifiable` → `verified`, same byte-identical re-save, and
`reopen-after-reload.png` is **byte-identical to `reopen-unchanged.png`**
(`0bdfe32150d1…`). Two code paths, one picture.

The run took 8.9 s end to end with **0 console issues**; milestones are
369/592 ms (save), 336/541 (unchanged), 335/545 (changed source), 340/545
(reload) for hierarchy and ready.

## What this does not show

- **One engine, one operating system.** Headed Chrome 151 on Windows. Cross-engine
  and cross-platform startup evidence lives in
  [`docs/REAL_LARGE_RESULTS.md`](../../../docs/REAL_LARGE_RESULTS.md); this record
  adds nothing to it.
- **Digital Hub is not real-large.** 84.5 MB of package against sixty5's 657 MB.
  The workspace format is size-independent, but this record does not claim a
  reopen time at real-large scale.
- **The manifest is not authoritative.** It records digests; it does not carry
  geometry, and a `verified` state is a statement about the four documents
  present on this host at this moment.
- **Digests here are host-local.** This Windows host compiles Digital Hub to
  `0e2ed4547e29…`, which is not the digest the macOS packing records carry — the
  cross-host adapter difference recorded in
  [`artifacts/spatial-demand/digital-hub-localized`](../../spatial-demand/digital-hub-localized/README.md).
  The manifest digests additionally depend on the serving origin. A re-record
  elsewhere must re-derive these pins, never retarget them silently.
- **`save-baseline.png` is not reproducible.** It is captured the moment `ready`
  is stamped, and which target chunks have arrived by then is a race: four runs
  produced three digests. The validator checks it against its own recorded bytes
  but pins no literal. The four captures that carry the claims —
  `save-customized`, `reopen-unchanged`, `reopen-changed-source`,
  `reopen-after-reload` — are byte-stable across runs and are pinned.

Everything else reproduced field for field across four consecutive runs on
2026-09-05; only `capturedAt` and that one screenshot moved. The committed
sample was re-taken once on 2026-09-07 after the Studio camera fix (the default
view had been mirrored and seen from below): every count, state, and digest
reproduced the 2026-09-05 record, and only the timings and the pictures moved.
The four pinned captures were re-pinned to the new pictures deliberately.

## Files

| File | What it is |
|---|---|
| `workspace-reopen.json` | The record (`naru.workspace-reopen-evidence.1`) |
| `save-baseline.png` | The untouched view, before the interaction (not pinned; see above) |
| `save-customized.png` | The saved session: three walls hidden, one slab selected, section at 35% |
| `reopen-unchanged.png` | The same session reopened against the unchanged package |
| `reopen-changed-source.png` | The same session reopened after the `arc.ifc` edit |
| `reopen-after-reload.png` | The reload path — byte-identical to `reopen-unchanged.png` |

## Reproducing

```
pnpm naru compile-ifc --input architecture=<arc.ifc> --input heating=<heating.ifc> \
  --input plumbing=<plumbing.ifc> --input ventilation=<ventilation.ifc> \
  --output output/ifc/digital-hub-split4
pnpm workspace:reopen:evidence
pnpm workspace:reopen:check
```

The recorder serves the package on port 4176, drives headed Chrome, and writes
the record and the five captures. It never modifies a source document: the edit
is made in a copy under its own work directory, and the arms that must see the
original documents are pointed at the originals. It fails closed if a resource
or source digest disagrees with the compiler's own reports before the browser
ever starts, if the edit changes the file's byte length, or if a reopened
workspace re-saves to anything but the bytes that were saved.
