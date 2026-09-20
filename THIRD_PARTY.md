# Third-party dependencies

This file records current bootstrap tooling and architectural intent. The
lockfile is the exact dependency inventory; `pnpm licenses list` reports the
resolved license set.

## TypeScript toolchain

These are development/build dependencies and are not shipped as an OCCT or
browser runtime bundle by themselves.

| Dependency | Version | License | Purpose |
|---|---:|---|---|
| TypeScript | 6.0.3 | Apache-2.0 | strict package compilation |
| Vite | 8.3.0 | MIT | WebGPU spike development and production build |
| Vitest | 4.1.11 | MIT | unit tests |
| ESLint / `@eslint/js` | 10.11.0 / 10.0.1 | MIT | static analysis |
| `typescript-eslint` | 8.70.0 | MIT | TypeScript lint integration |
| `@webgpu/types` | 0.1.74 | BSD-3-Clause | WebGPU API declarations |
| Khronos `gltf-validator` | 2.0.0-dev.3.10 | Apache-2.0 | official glTF 2.0 schema and binary validation for compiler evidence |

Versions are pinned in `package.json` and `pnpm-lock.yaml`. Updates must pass
the complete check and browser smoke path and must not introduce an incompatible
runtime license.

## STEP adapter and fixture authoring tools

These tools generate the committed STEP fixtures and implement the current
local STEP compiler adapter. They are not pnpm dependencies, are not required
by normal CI, and are not bundled into the browser runtime.

| Dependency | Version | Package license | Purpose |
|---|---:|---|---|
| CadQuery | 2.8.0 | Apache-2.0 | XDE assembly import/tessellation helpers and authored fixture export |
| `cadquery-ocp` | 7.9.3.1.1 | Apache-2.0 package metadata | Python OCCT binding for the local STEP adapter and fixture generation |

The generated models and generator source are original NARU contributions under
Apache-2.0. Their provenance, exact checksums, and regeneration policy are in
`fixtures/step/`.

## IFC adapter tool

IfcOpenShell 0.8.5 is pinned in
`native/adapter-ifc/tools/requirements-evidence.txt` and used by the isolated
IFC federation adapter. Its package is LGPL-3.0-or-later and uses Open CASCADE
for geometry processing. It is not installed by normal CI and is not bundled
into NARU's browser runtime. Distribution of an adapter environment must retain
the applicable IfcOpenShell and Open CASCADE notices and license terms.

## Third-party STEP fixture

`fixtures/step/adafruit-pygamer.step` is an unmodified copy of the Adafruit
PyGamer CAD assembly from `adafruit/Adafruit_CAD_Parts`, pinned to commit
`a94289fc02e7312f11647eb5e68f5c5ec06cabb6`. It remains copyright Adafruit
Industries and is redistributed under the MIT License. The full notice is in
`fixtures/step/licenses/adafruit-cad-parts-MIT.txt`; the source URL, license URL,
artifact path, and SHA-256 digest are locked in the fixture manifest. Adafruit
does not endorse NARU.

## External reference fixtures

Large NIST and IFC-Bench reference sources are download-on-demand and remain in
the ignored `output/external-fixtures/` cache; NARU does not redistribute those
binaries. `fixtures/external/manifest.json` pins source identity, byte length,
SHA-256, license, and attribution. The repository retains the NIST use notice,
the Digital Hub MIT notice, and the `sixty5` CC BY 4.0 notice next to the
manifest. Committed qualification artifacts contain aggregate inspection data,
not source geometry.

## Open CASCADE Technology

The current local STEP adapter uses Open CASCADE Technology (OCCT) through the
pinned Python binding; the production-boundary C++ target remains in progress.
OCCT is licensed under LGPL-2.1 with an additional exception. The adapter and
distribution process must preserve required notices and make the license
available to recipients. OCCT types must not cross the neutral adapter boundary
into the browser runtime API.

## TypeGPU and WebGPU

TypeGPU is being evaluated as a type-safe implementation aid for WebGPU buffer
schemas and shaders. It is not part of the serialized scene contract. Runtime
code must retain a narrow abstraction over raw WebGPU so that TypeGPU can be
upgraded or replaced without invalidating caches or public scene semantics.

## Candidate codecs and standards

- glTF 2.x and relevant extensions;
- 3D Tiles spatial and metadata concepts;
- meshoptimizer / EXT_meshopt_compression;
- Draco where its decode and random-access trade-offs are favorable;
- KTX2 / Basis Universal for textures; and
- a schema library such as FlatBuffers only after the logical IR stabilizes.

Every dependency added to implementation must be recorded with version,
license, distribution obligations, security update path, and browser/native
footprint.
