# ADR-0026: Own the streamed-scene lifecycle in an experimental runtime session

Status: Proposed

Reviewed: 2026-09-21

## Context

`@naru3d/runtime-webgpu` exports primitives: the renderer, the compiled-glTF
decoder, the bounded package transport, the persistent cache tier, and the
spatial demand query. The behavior that turns those into an open scene lives in
the Studio. At `9caeb44`:

- `apps/webgpu-spike/src/main.ts` holds one 1,530-line `loadScene` closure that
  opens the document, starts the geometry Worker, builds the residency and
  scheduler state, and wires roughly thirty DOM listeners and the `data-*`
  attributes the browser evidence records read;
- `GeometryDecoder`, `ProgressiveResidency`, `CameraTargetScheduler`, both
  chunk view indexes, `ReducedLodSelector`, the coarse aggregation, and the
  document/resource resolution in `scene-source.ts` are Studio modules. A scan
  of their imports shows they depend only on `@naru3d/runtime-webgpu`, each
  other, and one type (`CameraRelativeFrame`) from `view.ts`; the only
  non-portable line is the Vite-specific
  `new Worker(new URL("./geometry.worker.ts", import.meta.url))`.

An embedder therefore has to re-assemble session behavior itself, including
rules the Studio learned from evidence: the replacement document is fetched and
parsed *before* the open scene is disposed, so a failed load leaves the previous
scene on screen ([RUNTIME.md](../RUNTIME.md#5-threading-model)); the renderer is
created only after that dispose, because a canvas has one context; a selected
occurrence is pinned to `target` so a LOD flip never downgrades it
([ADR-0025](0025-shape-preserving-lod-representation.md)); and a stale decode
must not be admitted into a newer scene.

[`tools/package-embedder`](../../tools/package-embedder/README.md) already
proves that the *loader and transport* are reachable outside the Studio, but it
is headless: it opens no Worker, holds no residency, and renders nothing. The
Phase 3 exit criterion "runtime embedded in an app other than Studio"
([ROADMAP.md](../ROADMAP.md)) needs the streamed lifecycle, which is what issue
#122 asks to extract.

## Decision

Add an **experimental** session layer to `@naru3d/runtime-webgpu` under
`packages/runtime-webgpu/src/session/`, exported from the package entry point
and marked `@experimental` in its TSDoc. It is not a new package: the session
has no dependency the runtime does not already have, and a second package would
add a build, TypeDoc, and versioning surface before there is a second consumer
to justify it.

### Ownership

| Concern | Owner |
|---|---|
| Canvas element, camera and input, render loop timing, every DOM node | Host |
| Tree, search, properties, section, measurement, annotations, storeys, workspace, staged import | Host (Studio keeps them) |
| Document open under a transport policy, Worker lifetime, decode requests | Session |
| Renderer creation order, batch reconciliation, residency, LOD selection, view-priority scheduling | Session |
| Selection pinning and visibility as they affect residency | Session |
| Disposal of everything the session created | Session |

### Shape

```ts
const host = createSceneSessionHost({
  canvas,                       // host-owned; the session only configures its context
  createGeometryWorker,         // () => Worker; see "Worker entry"
  transport, packageLimits, persistence,   // ADR-0011 / ADR-0024 policies, all optional
  residencyBudget,              // { decodedBytes, gpuBytes }
  demandPriority, lodThresholds, fallbackDepthOffset,
});

const session = await host.open(source, { signal });   // replaces the open session
session.hierarchy;             // CompiledHierarchy, available once open() resolves
session.renderer;              // read-only handle for draw and pick calls
session.updateView(frame);     // host pushes its CameraRelativeFrame and viewport
session.select(occurrenceId);  // pins target residency; undefined clears
session.setVisibility(update); // hidden/isolated occurrence ids
session.snapshot();            // stage, residency, scheduler, LOD counters
session.on(event, listener);   // "stage" | "residency" | "scheduler" | "error" | "device-lost"
session.dispose();             // idempotent
host.dispose();
```

- **Replace.** `host.open` while a session is open keeps the current session
  rendering until the replacement has been fetched, parsed, and its tree built;
  it then disposes the current session and only afterwards creates the
  replacement renderer. A replacement that fails or is cancelled before that
  point leaves the current session untouched.
- **Cancel.** `open` honours its `AbortSignal`; a later `open` supersedes an
  earlier pending one. Completions that arrive for a superseded or disposed
  session are dropped, never admitted.
- **Errors.** `open` rejects with the loader's existing error classes
  (`CompiledGltfError`, transport errors, `AbortError`). After open, scheduler
  and device failures are events, because no caller is awaiting them.
- **Compatibility.** The session reads packages exactly as the Studio does
  today. It introduces no schema ID, no package field, and no serialized
  identifier ([ADR-0007](0007-rebrand-naru.md) is untouched).

### Out of scope

One session per canvas. `naru.workspace.2` binds exactly one compiled package
([ADR-0022](0022-workspace-manifest.md)) and the CLI compiles STEP
(`compile`) and IFC (`compile-ifc`) into separate packages, so the Phase 3
criterion "STEP and IFC sources coexist in one workspace" will need either
several packages composed in one view or a mixed-format compile. This ADR
decides neither. It keeps the long-lived host separate from the per-package
session so that a later additive `open` does not have to break this surface.

### Worker entry

The package ships the Worker body as a subpath export
(`@naru3d/runtime-webgpu/geometry-worker`), and the host passes a
`createGeometryWorker` factory. How a module Worker URL is resolved is a
bundler decision the library cannot make portably; the Studio keeps its Vite
idiom in one line of host code.

### Dependency direction

`session/` may import the rest of `runtime-webgpu` and nothing else. An ESLint
override for `packages/runtime-webgpu/src/session/**` restricts the `document`
and `window` globals and any import resolving outside the package, so UI
orchestration cannot re-enter. `Worker`, `AbortSignal`, and `GPU*` stay
allowed. `CameraRelativeFrame` moves into the runtime as a plain data type; the
orbit camera that produces it stays in the Studio.

The Studio keeps publishing every `data-*` attribute it publishes today by
mapping session events and `snapshot()` onto them, so committed browser
evidence keeps validating without re-recording.

### Slices

1. Move the DOM-free modules and their tests into `session/` behind the lint
   boundary; the Studio imports them from the package. No behavior change.
2. Extract `createSceneSessionHost` from `loadScene`; the Studio becomes its
   first consumer.
3. Add a minimal second consumer under `apps/` that imports only the published
   entry point, and record both consumers in a headed browser.

## Consequences

### Positive

- An embedder gets the evidence-derived ordering rules instead of rediscovering
  them.
- `main.ts` shrinks to UI wiring, and session behavior becomes unit-testable
  with a fake Worker and renderer instead of only through headed records.
- The Phase 3 embedding criterion becomes provable in this repository.

### Negative

- The runtime's public surface grows while the API is still moving;
  `@experimental` and the absence of a published npm release are the only
  compatibility statement until Phase 4.
- TypeDoc runs with `treatWarningsAsErrors`, so every type reachable from the
  session surface must be exported deliberately.
- Slice 2 rewrites the path every browser record exercises. A regression there
  is caught only by re-running headed validators, which CI does not do.
- A first-party second consumer proves the boundary is sufficient. Like the
  package embedder, it does not stand in for adoption by an unrelated
  application.

## Alternatives considered

- **A separate `@naru3d/scene-session` package.** Cleaner import graph, but it
  adds a build and documentation surface with no independent dependency set.
  Revisit when the session needs something the renderer must not depend on.
- **Let the session own the camera and the render loop.** Simpler for a
  trivial embedder, but it fixes an orthographic orbit camera and a
  `requestAnimationFrame` cadence into the library, which a host with its own
  view or an offscreen loop cannot use.
- **Construct the Worker inside the library.** Works under Vite for source
  imports, but not reliably for a package consumed from `dist`, and not under
  other bundlers.
- **Leave orchestration in the Studio and document the recipe.** No API risk,
  but the ordering rules stay untested outside headed records and the
  embedding criterion stays unprovable.

## Validation

The ADR moves to Accepted when all of the following hold:

1. **Boundary.** `pnpm lint` fails when a file under
   `packages/runtime-webgpu/src/session/` references `document`, `window`, or
   an `apps/` module; neither the library nor the second consumer imports
   `apps/webgpu-spike`.
2. **Lifecycle tests.** Unit tests with a fake Worker and renderer cover
   replacement during fetch and during decode, stale-completion suppression,
   idempotent disposal, listener cleanup, and selection pinning surviving
   eviction pressure.
3. **No evidence drift.** The committed Studio browser validators
   (`staged:import:browser:check` in the current tier; `browser:evidence:check`,
   `ifc:browser:check`, `hierarchy:browser:check`, and `demo:browser:check` in
   the historical tier of `scripts/lib/validation-tiers.mjs`) pass unchanged
   after slice 2, and a headed Studio run on the small licensed fixture shows
   the same `data-*` facts as before.
4. **Second consumer.** One headed record on a small licensed fixture shows the
   second consumer performing open, select, visibility change, progress and
   error reporting, a non-default budget, replace, and dispose, with zero
   console errors. Whether that record also closes the Phase 3 exit criterion
   is the maintainer's scoping decision, not this ADR's.
