# IFC federation evidence

This directory contains compact, reviewable evidence from real IFC federation
runs. Source IFC files, intermediate Scene IR, and compiled geometry remain
outside Git because they are large reproducible inputs or derived caches.

| Dataset | Evidence role |
|---|---|
| `explicit-edges/` | Focused project-owned IFC boundary-edge extraction and glTF proof |
| `digital-hub/` | First four-discipline IFC → Scene IR → glTF vertical slice |
| `sixty5/` | First real-large seven-discipline extraction and the measured compiler boundary |
| `sixty5-browser/` | Original real-large browser/residency record and 268.0 s first-frame baseline |
| `sixty5-first-frame/` | Shared-coarse, virtualized-list, skip-and-continue, estimate-gate, and shared-vertex-pool follow-up: 4.743 s first frame and 111 of 234 resident chunks on the identical package |
| `sixty5-first-frame-gecko/` | Firefox/Gecko repeat of `sixty5-first-frame/` on the same package and host: a byte-identical resident set at 111 of 234 chunks, about 1.28x the first frame |
| `relocated-hierarchy-browser/` | Paired sixty5 packages that differ only in whether the assembly tree is in the document: −15.65% first frame, −18.56% peak heap, ADR-0017's browser gate |

Normal CI runs `pnpm ifc:edges:check` and `pnpm ifc:federation:check` without
downloading IFC files or installing IfcOpenShell. Re-recording evidence requires
the project-owned or pinned external fixture and Python adapter documented in
the dataset directory.
