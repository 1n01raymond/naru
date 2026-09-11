# Real-large results matrix

Phase 2 exits on four criteria ([tracker](PHASE_2.md)). The second asks for
"cold/warm startup, frame, memory, and interaction results published", and
names what was missing: **one coherent matrix that presents them together**,
and a repeat on a second engine. This document is that matrix. It adds no measurement of its own; every figure below is read from a
committed record, and every record is linked from the row that quotes it.

The matrix is deliberately narrow. It covers one model, sixty5, because that
is the only real-large federation every one of these records was taken
against. Digital Hub, the STEP fixtures, and the benchmark harness results are
not folded in.

## The model

sixty5 is a seven-document IFC federation, 839.9 MB of source, compiling to a
package whose glTF document alone is 448.8 MB. It carries 78,173 renderable
occurrences, 42,435 geometric prototypes, and 234 target geometry chunks.

## The matrix

| Stage | Measure | Figure | Engine / process | Record |
|---|---|---:|---|---|
| Import | Cold import, fresh process, median of 5 | 381.4 s | Node 22.14 CLI | [cache](../artifacts/cache/sixty5/README.md) |
| Import | Cold import, observed p95 (n=5) | 385.3 s | Node 22.14 CLI | [cache](../artifacts/cache/sixty5/README.md) |
| Import | Cold import, peak process-tree working set | 5.08 GB | Node + Python adapter tree | [cache](../artifacts/cache/sixty5/README.md) |
| Import | Warm reopen, compiler time, median of 5 | 1.36 s | Node 22.14 CLI | [cache](../artifacts/cache/sixty5/README.md) |
| Import | Warm reopen, whole process incl. startup | 1.43 s | Node 22.14 CLI | [cache](../artifacts/cache/sixty5/README.md) |
| Import | Corrupt cache entry, warn and rebuild | 89.0 s | Node 22.14 CLI | [cache](../artifacts/cache/sixty5/README.md) |
| Startup | Hierarchy and search ready | 2.272 s | Chrome 151 / Blink | [first frame](../artifacts/ifc/sixty5-first-frame/README.md) |
| Startup | Hierarchy and search ready | 3.396 s | Firefox 150 / Gecko | [first frame, Gecko](../artifacts/ifc/sixty5-first-frame-gecko/README.md) |
| Frame | First coarse frame, median of 3 | 4.487 s | Chrome 151 / Blink | [first frame](../artifacts/ifc/sixty5-first-frame/README.md) |
| Frame | First coarse frame, median of 3 | 6.801 s | Firefox 150 / Gecko | [first frame, Gecko](../artifacts/ifc/sixty5-first-frame-gecko/README.md) |
| Frame | Budget-limited ready state | 9.190 s | Chrome 151 / Blink | [first frame](../artifacts/ifc/sixty5-first-frame/README.md) |
| Frame | Budget-limited ready state | 13.712 s | Firefox 150 / Gecko | [first frame, Gecko](../artifacts/ifc/sixty5-first-frame-gecko/README.md) |
| Frame | Target chunks admitted of 234 | 111 | both engines, identical | [Gecko repeat](../artifacts/ifc/sixty5-first-frame-gecko/README.md) |
| Frame | Resident triangles | 2,255,235 | both engines, identical | [Gecko repeat](../artifacts/ifc/sixty5-first-frame-gecko/README.md) |
| Memory | Process working set at budget-limited state, median of 3 | 2.586 GB | Chrome 151 / Blink, OS-sampled | [envelope](../artifacts/memory/sixty5-envelope/README.md) |
| Memory | Process working set at budget-limited state, median of 3 | 5.104 GB | Firefox 150 / Gecko, OS-sampled | [envelope, Gecko](../artifacts/memory/sixty5-envelope-gecko/README.md) |
| Memory | Resident decoded / GPU bytes under a 64 MiB budget | 66,686,508 / 66,783,808 B | both engines, identical | [envelope, Gecko](../artifacts/memory/sixty5-envelope-gecko/README.md) |
| Memory | Residency share of process working set | 2.58% / 1.31% | Blink / Gecko, derived | [envelope, Gecko](../artifacts/memory/sixty5-envelope-gecko/README.md) |
| Memory | Forced-low 8 MiB budget: working set | 1.440 GB | Chrome 151 / Blink, OS-sampled | [envelope](../artifacts/memory/sixty5-envelope/README.md) |
| Memory | Forced-low 8 MiB budget: working set | 4.701 GB | Firefox 150 / Gecko, OS-sampled | [envelope, Gecko](../artifacts/memory/sixty5-envelope-gecko/README.md) |
| Memory | Forced-low 8 MiB budget: chunks admitted, occurrences visible | 4 / 234, 78,173 | both engines, identical | [envelope, Gecko](../artifacts/memory/sixty5-envelope-gecko/README.md) |
| Memory | Predeclared memory targets met | 5 of 5 / 4 of 5 | Blink / Gecko | [envelope, Gecko](../artifacts/memory/sixty5-envelope-gecko/README.md) |
| Interaction | Navigation demand query, p50 / p95 over 48 samples | 0.295 / 0.405 ms | Chrome 151, compatibility order | [localized](../artifacts/spatial-demand/sixty5-localized/README.md) |
| Interaction | Navigation demand query, p50 / p95 over 48 samples | 0.195 / 0.330 ms | Chrome 151, leaf-anchor order | [localized](../artifacts/spatial-demand/sixty5-localized/README.md) |
| Interaction | Localized view: candidate chunks, of 234 fitted | 209 / 152 | compatibility / leaf-anchor | [localized](../artifacts/spatial-demand/sixty5-localized/README.md) |
| Interaction | Localized view: demanded bytes, of 120,707,064 fitted | 107,337,264 / 78,875,544 B | compatibility / leaf-anchor | [localized](../artifacts/spatial-demand/sixty5-localized/README.md) |
| Interaction | Selection resolves source properties | 6 IFC2X3 entries | both engines, identical | [Gecko repeat](../artifacts/ifc/sixty5-first-frame-gecko/README.md) |

## The second-engine repeat

The frame and memory rows above are recorded twice, on two engines, from the
same package on the same host. The comparison is the point of the repeat:

| | Chrome 151 (Blink) | Firefox 150 (Gecko) |
|---|---:|---:|
| Hierarchy ready | 2.272 s | 3.396 s |
| First coarse frame | 4.487 s | 6.801 s |
| Budget-limited ready | 9.190 s | 13.712 s |
| Worker geometry decode | 1,117.5 ms | 2,440.7 ms |
| Target chunks admitted | 111 / 234 | 111 / 234 |
| Chunks refused before fetch | 123 | 123 |
| Decoded / GPU resident bytes | 66,686,508 / 66,783,808 | 66,686,508 / 66,783,808 |
| Resident triangles | 2,255,235 | 2,255,235 |
| Visible occurrences | 78,173 | 78,173 |
| Satisfied Range responses | 113 | 113 |
| Used JS heap at ready | 852,946,064 B | not exposed by the engine |
| Console and page errors | 0 | 0 |

Gecko is about 1.5x slower than Blink at every milestone on this host, and
2.18x slower at Worker geometry decode. Everything the runtime decides for
itself is identical: the same 111 chunks are admitted, the same 123 are refused
before a byte moves, the same bytes are resident, the same triangles are drawn,
the same element is picked and resolves the same six properties, and the ready
status string matches character for character. Admission is computed from
measured decoded and GPU cost against a byte budget, so a second engine
reaching a different resident set would have meant the budget was tracking
something browser-specific. It is not.

The [memory ledger](../artifacts/memory/README.md) is repeated the same way,
six phases in each of two budget profiles, sampled at the budget-limited state:

| | Chrome 151 (Blink) | Firefox 150 (Gecko) |
|---|---:|---:|
| Process working set, 64 MiB budget | 2,586,112,000 B | 5,104,345,088 B |
| Process working set, 8 MiB budget | 1,439,883,264 B | 4,701,130,752 B |
| Process private commit, 64 MiB budget | 8,339,120,128 B | 11,447,386,112 B |
| Resident decoded bytes, 64 MiB budget | 66,686,508 | 66,686,508 |
| Resident decoded bytes, 8 MiB budget | 8,249,400 | 8,249,400 |
| Residency share of working set | 2.58% | 1.31% |
| Used JS heap | 847,065,463 B | not exposed by the engine |
| Predeclared targets met | 5 of 5 | 4 of 5 |

The resident set is byte-identical at all eight settled profile and phase
points, so the estimator-independent resident figure the exit criterion asks
for is the runtime's own count, now confirmed on two engines. The process
holding it does not carry across: Gecko's working set is 1.97x Blink's under
the default budget and 3.26x under the forced-low one, and the 4 GiB process
working-set ceiling the ledger predeclares is the one target Gecko misses. It
is exceeded in both profiles and already at the hierarchy phase, before any
target chunk is admitted, so the breach is not residency; the ceiling was left
where it stood rather than widened to accommodate a second engine.

## What this matrix does not establish

- **It is not an end-to-end timeline.** The rows come from four different
  compilations of the same source federation - package digests `3206ea40…`
  (import rows), `a2d6c72a…` (frame and memory rows), and `4fa4c67c…` /
  `1fdbb5a8…` (interaction rows, one per payload order). They were compiled
  with different options at different commits. Adding an import figure to a
  startup figure would describe a run nobody performed.
- **One operating system.** Every record here is Windows x64 on one
  discrete-GPU host, so nothing in this matrix supports a cross-platform
  statement. A second-operating-system repeat is still worth doing and is
  tracked as evidence debt in [the Phase 2 tracker](PHASE_2.md); a 2026-09-12
  scope decision made it non-blocking for the exit criterion, not unnecessary.
- **Whole-process memory is engine-specific.** The resident bytes match on both
  engines, but the process around them does not, and Gecko exposes neither
  `performance.memory` nor `measureUserAgentSpecificMemory()`, so heap and
  agent-cluster rows stay Blink-only and the OS-sampled tree walk carries the
  whole bound there. No memory figure in this document should be quoted without
  its engine.
- **GPU driver allocation is unavailable.** No browser exposes it, and the
  envelope record marks it unsupported rather than zero.
- **These are not benchmark results.** Nothing here is an [ADR-0003](adr/0003-webgpu-hot-path.md)
  renderer decision or a comparison against another viewer; those live under
  `artifacts/benchmarks/` with their own rules.

## Reproduce

Every row is validated by the check chain, so `pnpm check` re-verifies the
figures this document quotes. To re-record an individual row:

```sh
pnpm cache:sixty5:evidence
pnpm ifc:first-frame:evidence -- --scene-dir output/ifc/sixty5-prb
pnpm ifc:first-frame:gecko:evidence -- --scene-dir output/ifc/sixty5-prb
pnpm memory:envelope:evidence
pnpm memory:envelope:gecko:evidence
pnpm spatial:localized:evidence
```

The cold-import recorder takes roughly 40 minutes; the browser recorders need a
headed browser and the compiled package each names in its record README.
