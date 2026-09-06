# NARU API reference

Generated from the TypeScript declarations of the four workspace packages with
[TypeDoc](https://typedoc.org/). The packages are private pre-release packages
(`docs/PHASE_2.md`, "Installable alpha release"); this reference documents the
surface each package exports today, not a published compatibility contract.

| Package | Role |
|---|---|
| `@naru3d/scene-ir` | Engineering Scene IR types, `validateScene`, property columns |
| `@naru3d/runtime-webgpu` | Compiled-glTF loader, package transport policy, direct WebGPU renderer |
| `@naru3d/workspace` | `naru.workspace.1` manifest parser, serializer, reopen decision |
| `@naru3d/compiler` | Scene IR to glTF packaging, import jobs, caches, the `naru` CLI |

Regenerate locally with `pnpm docs:api` (writes to `output/api/`, gitignored).
`pnpm docs:api:check` runs the same build with warnings treated as errors and is
part of `pnpm check`.
