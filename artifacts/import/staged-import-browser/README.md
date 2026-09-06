# The Studio, usable against a cold sixty5 import

Status: recorded evidence for
[ADR-0021](../../../docs/adr/0021-staged-hierarchy-first-import.md) gate 4, with
gate 5 folded into the same record. Schema
`naru.staged-import-browser-evidence.1`, mode
`headed-cold-import-staged-tree-then-package`. One record,
[`sixty5.json`](sixty5.json), with four captures beside it.

The two earlier records in this family priced a tree
([`../structure-readiness/`](../structure-readiness/README.md)) and watched the
adapter publish one ([`../structure-first-emission/`](../structure-first-emission/README.md)).
Neither had a viewer. This record does: a headed Studio is opened on an empty
staged directory *before* a cold `naru compile-ifc --staged-preview` is spawned
on the same host, and every milestone is the page's own clock read from that
spawn instant. Transport, verification, the 500 ms poll interval, and DOM
construction are all inside the number.

The recorder serves the work directory from its own Range- and CORS-capable
static server on a second port (Vite's `publicDir` cannot see files created
after it starts), verifies every staged pair's length and digest from outside
the compiler process, and drives the page through a search and a row selection
while the compile is still running. When the manifest gains its `package`
block the Studio verifies the declared resources against the same manifest and
hands off to the unchanged package loader; the record then waits for the
compiled package's first coarse frame and its ready state, and for the compile
process to exit.

Recorded by `pnpm staged:import:browser:evidence`; validated by
`pnpm staged:import:browser:check`, which is in the `check` chain.

## What the numbers say

Headed Chrome 151.0.7922.139 (Blink) on Windows 11, viewport 1320x1000, IfcOpenShell
0.8.5 at 6 threads, no `--cache`, `--compact-json`, commit `6c7b95b`.
Milliseconds are the page clock from the compile spawn.

| Milestone | ms after spawn |
|---|---:|
| **First tree searchable and selectable** (`facade`, 1,076 nodes shown as 1,077 rows with its document root) | **1,542** |
| Search during import (`Wall`, 353 matches, compile running) | 1,709 |
| Row selection during import (compile running) | 1,793 |
| Seventh (last) tree | 271,504 |
| Manifest complete | 368,108 |
| Package handoff (manifest carries the package block, resources verified) | 417,766 |
| Package hierarchy ready | 420,040 |
| Compiled package's first coarse frame | 422,835 |
| Ready (`targetReady=limited`, budget reached) | 427,743 |
| Compile process exit | 417,937 |

The product target is a first tree inside 5-15 s end to end. 1.5 s is
faster than the band's lower edge, so the record marks `withinBand: false` and
`meetsTarget: true`; the validator requires both to follow from `firstTreeMs`.

Three consecutive runs agreed on every count (trees, nodes, matches, chunks,
requests, bytes, occurrences, responses); only wall clock moved. The committed
run is the median first tree over 1,522/1,542/2,003 ms. Handoff/coarse/ready
spreads: 410,944/417,766/472,096 / 415,940/422,835/477,241 / 420,167/427,743/482,439 ms.

State at ready: 88/324 target chunks resident,
88 requests and 236 pre-fetch skips, 66,986,560 B on the GPU
against a 67,108,864 B budget, 78,173 occurrences, status
"Residency budget reached · 15996 surface batches retained · 78173 renderable occurrences". Package digest `3206ea40835d8ca70a0a82208e397a8dcdcd66351b29b4df0e8102ff910e6454` -- the digest the committed cold samples
in [`../../cache/sixty5/`](../../cache/sixty5/README.md) already carry for this
host, so the staged compile moved no package byte (gate 2 at scale). 0 console
issues.

## What the record does not claim

- **No coarse geometry during import.** Nothing tessellates before the
  package is written, so there is no per-document coarse frame to measure;
  the coarse frame above is the compiled package's own, after handoff. That
  is gate 5's "amend to hierarchy-first" outcome by construction, and the
  ADR now says so. Staged rows read `geometry pending` until handoff.
- **"Expand" is search plus selection.** The Studio's tree is a flat
  virtualized list with no expand/collapse, so the record exercises the tree
  through `#hierarchy-search` and a row click, and states that in
  `protocol.hierarchyInteraction`.
- **One engine, one host, shared memory.** The compile (peaking near 5 GB)
  and the browser share this machine with everything else on it; the record
  carries `host.freeMemoryBytesAtStart` (15.0 GB) and a `timingNote`. A
  second engine and operating system are a
  [Phase 2 evidence debt](../../../docs/PHASE_2.md).
- **Digests are host-local.** This host's sixty5 compile is `3206ea40835d...`;
  the validator pins it and says not to retarget it to make a re-record
  pass.
- **The property sidecar is never fetched.** The Studio resolves
  `properties.json` / `properties.bin` lazily, on a pick with a semantic id,
  and this protocol picks nothing after handoff; `network.packageFetches`
  classifies those two resources `lazy-on-pick` with zero responses and the
  three eager resources with at least one, and the validator checks both.
- **Manifest polls that answer 404 are expected, not console issues.** The
  Studio polls `staged.json` every 500 ms from before the compile spawns, and
  Chrome logs each 404 as a console error that no application code can
  suppress. The recorder counts those messages (manifest URL only, before its
  first 200) in `network.manifestPolls.notFoundConsoleMessages`, reconciles
  the count against the 404 responses, and excludes them from
  `consoleIssues`, which the validator requires to be empty.
- **The screenshots are not pinned.** Chunk arrival at first frame is a
  race; the validator re-hashes the four PNGs against their own bytes and
  pins no literal.

## Files

| File | What it is |
|---|---|
| `sixty5.json` | The record |
| `staged-tree.png` | The first tree, compile running |
| `staged-search.png` | The search during import |
| `coarse.png` | The compiled package's first coarse frame after handoff |
| `ready.png` | The ready state |
