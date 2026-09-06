# NARU compiled-scene browser proof

This Vite app is the current Phase 1 runtime evidence, despite the historical
`webgpu-spike` directory name. It deliberately does not fetch the Phase 0 Scene
IR JSON.

```text
scene.gltf
  └─ main thread: validate profile, expose hierarchy and source identity
scene.bin
  └─ Worker: validate accessors, decode shared typed-array batches
       └─ direct WebGPU: surfaces, explicit CAD edges, object-ID picking
            └─ Studio slice: orbit/pan/zoom/fit + synchronized selection

progressive package
  └─ coarse.bin → one shared canonical-box batch → first WebGPU frame
       └─ retained coarse chunk bounds → current-view ranking
            └─ scene.bin Range chunks → cancellable Worker decode
                 └─ stable GPU batch reconciliation → bounded residency admission
```

Run it with `pnpm dev`. Use `pnpm browser:matrix` for the reproducible headed
Chrome and Firefox visual/picking check. The default scene is the canonical
MIT-licensed Adafruit PyGamer electronics assembly: 34 shared meshes, 85 part
occurrences, 162,838 triangles, 13,897 explicit CAD edge segments, and direct
joystick-to-source picking. Drag to orbit, Shift-drag or middle-drag to pan,
use the wheel to zoom, and press `F` to fit the current view. Selecting from the
viewport or hierarchy highlights the same occurrence and preserves its source
identity. `H` hides the selection, `I` isolates it, and `Shift+H` restores all
occurrences. These actions compact stable per-prototype visibility tables into
existing instance buffers rather than rebuilding scene resources. Adafruit does
not endorse NARU. Press `C` to enable one world-space section plane; choose its
X/Y/Z axis, drag the normalized position, or flip the retained side. Surfaces,
explicit edges, and GPU picking share the same clipping equation.

The camera chooses a JavaScript-number origin for every frame and sends a
camera-relative f32 projection plus that origin to the renderer. This keeps the
same review controls and section equation stable for site-scale transforms; the
committed ADR-0005 record compares a 0.25 mm gap at the origin and 10,000 km
away through headed Chrome and Firefox (`pnpm precision:check`).

The [public demo site](https://1n01raymond.github.io/naru/) opens with a
static landing page (`apps/demo-landing`) whose evidence cards reuse committed
record screenshots; the Studio itself is served under `studio/` with the
qualified Digital Hub IFC federation by default and PyGamer available as a
secondary scene (`studio/?scene=pygamer/scene.gltf`). The deployment verifies
the Digital Hub package digests before publishing, then checks the live
landing page, Studio assets, every declared package resource, and binary HTTP
Range delivery with `pnpm demo:smoke`.

Where that default package is served from is deployment configuration, not
application behaviour. With the repository variable `NARU_PACKAGE_ORIGIN`
unset, the package is copied into the Pages site artifact and the Studio opens
it site-relative, which is the arrangement the 1 GB site limit bounds. Set the
variable to an HTTPS prefix and the deployment instead verifies every declared
resource's SHA-256 at that origin, builds the Studio to open the package
cross-origin, and runs `pnpm demo:smoke --package-origin <url>`, which asserts
the delivery contract
[ADR-0023](../../docs/adr/0023-public-package-delivery-origin.md) sets out: no
redirect, an exact `Content-Length`, an allowlisted `Content-Type`,
`Access-Control-Allow-Origin` covering the site origin,
`Access-Control-Expose-Headers` carrying `Content-Range`, and an honest `206`.
That exposed header is not optional. The geometry Worker refuses a range
response whose `Content-Range` it cannot read, so an origin that omits it
produces a page that renders its shell and never receives geometry.

The smoke check reads headers; whether the deployed Studio actually reaches a
picture across those origins is a browser question, and the
[public-demo browser record](../../artifacts/public-demo/digital-hub-origin/README.md)
answers it: headed Chrome opens the deployed Studio with no query, reads the
Digital Hub package from the origin through the bundle's own default scene
URL, and reaches hierarchy, a first coarse frame, ready with every chunk
resident over `206` Range responses, and a pick with resolved properties, with
every origin resource verified against the committed build report before and
after the run. `pnpm demo:browser:check` validates that record; re-record it
against the live site and origin with `pnpm demo:browser:evidence`. The
[engineering-baseline origin record](../../artifacts/public-demo/engineering-baseline-origin/README.md)
repeats that against the 854,447,023-byte engineering baseline, opened through
the scene query rather than the default scene: the budget-limited ready state
with 82 of 626 chunks resident under 64 MiB over 82 `206` Range responses, and
a pick with resolved properties. `pnpm demo:baseline:check` validates it;
re-record with `pnpm demo:baseline:evidence`.

The live origin is a Cloudflare R2 bucket behind `packages.blacktanlabs.com`,
provisioned with `wrangler` on 2026-09-05, and reproducing it is four steps:
`wrangler r2 bucket create <bucket>`; `wrangler r2 bucket cors set <bucket>
--file cors.json` with the R2 API shape `{"rules":[{"allowed":{"origins":[...],
"methods":["GET","HEAD"],"headers":["range","content-type"]},"exposeHeaders":
["Content-Range","Content-Length","ETag","Accept-Ranges"],"maxAgeSeconds":3600}]}`
where the origins list carries the Pages site and any local development
origin; `wrangler r2 bucket domain add <bucket> --domain <host> --zone-id <id>`
for a hostname in a zone the account already holds, followed by
`wrangler r2 bucket domain update <bucket> --domain <host> --min-tls 1.2`
because a new custom domain accepts TLS 1.0 by default; then one
`wrangler r2 object put <bucket>/<prefix>/<file> --file <path> --content-type
<type> --remote` per declared resource, with `model/gltf+json` for the
document, `application/json` for `properties.json`, and
`application/octet-stream` for every binary. `--remote` is not optional:
without it wrangler 4 writes to its local Miniflare store and the public
hostname keeps answering 404. Upload the package whose digests the committed
build report names, never a local recompile, and put the fixture's license and
attribution beside it (`LICENSE.txt`, `ATTRIBUTION.txt`); the prefix is
immutable once a deploy has verified it, so a new package gets a new prefix.

The Scene Inspector searches hierarchy names, occurrence/prototype IDs, and
source references as soon as `scene.gltf` is available; geometry residency is
not required. Press `/` to focus search and Enter to select its first renderable
result. Viewport, tree, and search selection populate the same source-identity
property panel, including glTF node/object IDs and a bounded preview of
revision-local CAD edge references.

The assembly tree is virtualized: only the rows its scrollport covers exist as
elements, and the rest of the list is two spacers. The sixty5 federation has
188,319 rows, which used to be 565,134 elements; a host with accessibility mode
enabled then spent minutes walking that tree before the first frame could be
painted, because the browser process stops servicing its own network sockets
while it does. Arrow, Home, and End move a roving focus across the whole list
rather than the rendered window, so keyboard and screen-reader users still
reach every row, and search, review visibility, and picked-row reveal all
address rows by position. Row names ellipsize instead of wrapping, so every row
is the same height and the window arithmetic
(`apps/webgpu-spike/src/hierarchy-list.ts`, `pnpm test`) stays exact. The
measured effect on the sixty5 first frame is in
`artifacts/ifc/sixty5-first-frame/README.md`.

When the package carries the property sidecar (`properties.json` +
`properties.bin`, `docs/COMPILER.md` section 21.2), selecting an occurrence
also resolves its IFC property sets: the sidecar is fetched lazily on the
first selection, and both resources must match their declared byte lengths and
SHA-256 digests before JSON parsing or column decoding. Each later lookup
decodes only the selected occurrence's rows through `resolvePropertyEntries`.
These digest checks verify package integrity; they are not a signature or a
claim about who published the glTF. Search deliberately does not index property
values in Phase 1 — it stays hierarchy-metadata-only, and property resolution
stays selection-driven so the 31.2 MB sixty5 column file is never scanned
wholesale on the main thread.

To serve another locally compiled package as `/scene.gltf`, set
`NARU_SCENE_DIR` to an absolute path or a repository-relative directory before
starting Vite. For example, in PowerShell:

```powershell
$env:NARU_SCENE_DIR = "output/ifc/digital-hub"
pnpm dev
```

`VITE_NARU_DEFAULT_SCENE_URL` does the same for a *built* Studio: when set it
must be an absolute HTTP(S) URL naming a compiled glTF document, and the app
opens that package instead of `${BASE_URL}scene.gltf`. A value that is not
usable -- relative, credential-bearing, carrying a query or fragment, or not
naming a `.gltf` document -- fails the build instead of silently falling back
to the site-relative default (`apps/webgpu-spike/src/default-scene.ts`,
`pnpm test`).

The runtime preserves one pickable occurrence ID across material-separated
surface batches. One session Worker validates the glTF document, composes its
float64 world transforms, and indexes target-chunk occurrence membership once.
Every later Range decode reuses that state and visits only the selected chunk's
renderable occurrences; transferred results clone only their occurrence
transforms so the prepared state remains attached. Chunk decode responses omit
the document hierarchy — it crosses the Worker boundary once and the decoder
reattaches its cached copy, so per-admission messages carry only the chunk's
own batches. A package compiled with `--relocate-hierarchy-nodes` (ADR-0017)
carries its assembly tree in a sidecar rather than the document: both load
paths fetch or require `hierarchy.json` before the tree is read — the URL path
holds each of its two resources to the single-resource ceiling and the local
path names the missing file — and the Worker declines the tree outright with
the `"geometry-only"` option, because it decodes on a thread that never renders
the panel. Reading the tree that way costs one 46 MB fetch and 29 ms of
hierarchy-ready on the sixty5 federation, and buys a 15.99% faster first frame
against a 100 MB smaller document
([record](../../artifacts/ifc/relocated-hierarchy-browser/README.md)). Prototype-local surface
bounds are cached once and only eight corners are transformed per occurrence,
rather than rescanning every vertex. IFC compilation coalesces adjacent prototype ranges
into deterministic requests (512 KiB by default), while the existing
`prototype-aabb-v1` tier is collapsed at runtime into one canonical box batch
with contiguous occurrence transforms. The browser enforces separate 64 MiB
decoded and GPU admission budgets. Those budgets bound admitted target
geometry, not the browser process: the memory envelope measures both in the
same runs, on [Blink](../../artifacts/memory/sixty5-envelope/README.md) and on
[Gecko](../../artifacts/memory/sixty5-envelope-gecko/README.md), which admit
identical resident bytes inside processes of very different size. Promoted targets mask matching coarse
instances; evicting colder target groups reveals those shared fallbacks again,
so visibility intent and stable object IDs survive every batch update. An
admission is delta-priced end to end: residency totals update incrementally,
visibility tables of unchanged batches are reused by object identity (only the
shared coarse mask and new batches recompute), and the renderer re-packs and
re-uploads instance buffers for the changed batches only. Target
promotion reuses the hierarchy's node lookup and does not rescan DOM visibility
markers because residency changes no user visibility intent. Add
`?residencyMiB=5` to force a small budget during local exploration; the same
knob at 8 MiB is the recorded forced-low profile, where hierarchy, coarse
rendering, navigation, selection, and eviction all still complete. Under any
budget the coarse proxies that remain visible are drawn one depth quantum
behind resident target detail (`?fallbackDepthOffset=` overrides the
renderer's `1/65536`, `0` disables it, and `data-fallback-depth-offset`
reports the value in force), which removes the speckle a proxy box face
produced where it shared a plane with a loaded neighbour. Orbit,
pan, zoom, fit, and resize rank visible retained-coarse chunk bounds by distance
from the view center. If the hottest nonresident chunk
changes, the scheduler aborts the obsolete HTTP Range and Worker decode before
starting its replacement; the same order re-ranks eviction priority. An
unchanged camera does not retry a demand signature already blocked by the
residency budget. Before a range is requested at all, the chunk's measured
decoded and GPU cost is tested against the budget: a chunk that cannot fit the
free headroom, and for which no colder unpinned group could be evicted, is
skipped without a transfer or a decode. The gate refuses only what admission
would certainly reject, so the resident set is unchanged; `data-target-scheduler-skips`
counts the skipped chunks beside `data-target-scheduler-requests`. Both that
price and the resident charge count a prototype's vertex pool once however many
material groups read it, which is what lets a large multi-material prototype be
admitted at all: the largest sixty5 chunk cost 75,373,776 bytes when each group
kept its own copy of one 673,080-byte pool. Packages
with `naru.spatial-demand-index.1` instead authenticate `spatial.bin`, query
only frustum-visible BVH leaves, and keep cold chunks out of the fetch queue.
The focused headed record plus Digital Hub and sixty5 offline co-demand
censuses and their headed localized camera traces are under
`artifacts/spatial-demand/`. Those packages also accept
`?demandPriority=screen-coverage`, which admits the demanded chunks by the
screen area their leaves cover instead of by distance from the view centre;
`data-target-scheduler-demand-priority` reports the policy in force. It is
opt-in because the recorded outcome is view-dependent — 99.12% pixel agreement
with an unbudgeted reference render against the default's 64.95% on a close
view, and 93.86% against 96.31% on a mid view
(`artifacts/spatial-demand/sixty5-demand-priority/`). Persistent cache tiers,
spatial draw clusters, and screen-space LOD remain Phase 2 work.

## Open another compiled scene

Use **Open URL** for an HTTP(S) `scene.gltf`. A successful URL is retained in
the page's `?scene=` query so the view can be reopened or shared; the remote
host must allow cross-origin requests for both the glTF and its external binary.

A remote package is untrusted input, so every fetch the Studio makes for one --
the document, each byte range, and both sidecars -- goes through a single
transport policy ([ADR-0011](../../docs/adr/0011-remote-package-limits.md)):
the URL must be HTTP(S) without credentials, every resource the document
declares must resolve to the document's own origin, redirects are not followed,
the response must carry a package resource content type rather than a document
type such as an error page, and the body is held to a byte ceiling while it
streams -- a resource that declares a `Content-Length` is read into exactly
that many bytes, and one that declares none is cut off at the limit. The
document's declared resources are also checked against a package-wide byte and
count budget before the first of them is requested. The defaults are far above
the largest package this repository compiles. The Studio takes them unchanged:
it settles one `PackageTransport` per load and carries it through the document,
both sidecars, the demand index, and every geometry range the Worker fetches,
passing no overrides of its own. An embedding application chooses its own
ceilings, announces a second host, or supplies the transfer -- exercised by a
consumer outside this app in
[`artifacts/security/embedder-overrides`](../../artifacts/security/embedder-overrides/README.md).

Use **Open local package** to select exactly one NARU-profile `.gltf` and all of
its external `.bin` and `.json` resources (including the optional
`properties.json` / `properties.bin` sidecar pair and `spatial.bin`). The browser validates each
declared file name and byte length before sending local `File` objects to the
geometry Worker.
Declared property and spatial sidecars are also checked against their SHA-256
digests before they are parsed or decoded.
Local files stay on the client and do not create a shareable URL. This is a
compiled scene workflow; direct STEP AP242/AP214 input belongs to the compiler.
For progressive packages, local `File.slice()` provides the same target chunk
boundary without network requests. **Cancel** aborts the active hierarchy or
geometry load, terminates its Worker, and prevents later target ranges from
starting.

## Save and reopen a workspace

The workspace bar saves the current session as a `naru.workspace.1` manifest and
reopens one ([ADR-0022](../../docs/adr/0022-workspace-manifest.md),
[`@naru3d/workspace`](../../packages/workspace/README.md)). A workspace is a
pointer plus intent: the package it was saved against, the sources that import
consumed, and one view — camera, section, hidden set, selection. It carries no
geometry, no absolute path, no timestamp, and no host name.

**Save workspace** downloads the manifest. Package and source identity are read
from the import's own `build-report.json` and `adapter-report.json` rather than
from the scene, so the Studio never asserts an identity the pipeline did not
compute; a package whose reports do not name every source with a digest and a
byte length — an OCCT STEP package states one source with no byte length —
refuses to be saved and says which half is missing. Visibility and selection are
stored by `occurrenceId`, never by node index, so a recompile of the same source
still resolves them.

**Open workspace** reads a manifest. If it names the package already open, the
view is restored immediately; if it names an HTTP(S) package, the Studio loads
that package first and then restores; if it names a local package, the browser
cannot reach a file by name, so the status asks for the file to be re-picked
through **Compiled files**. Occurrence ids the reopened hierarchy no longer
carries are reported as dropped rather than silently discarded.

**Check sources** picks the source documents themselves and hashes them in the
browser. Until that happens a reopen reports `unverifiable`, never `verified`,
because a tab cannot stat a local IFC file and calling an unchecked source
unchanged would be a lie. A partial selection stays `unverifiable` as a whole —
inspecting some sources and reporting the rest as clean would be a different
lie. Once hashed, a moved source reopens as `changed-source` with
`geometryIsCurrent` false even when the package still matches its digest,
because the source is authoritative
([ADR-0002](../../docs/adr/0002-source-and-cache.md)).

Isolation has no field in `naru.workspace.1`. Saving while an occurrence is
isolated persists only the explicit hidden set, and the status says so at the
moment of saving instead of restoring a different view later.

The reopen verdict is published on the document element for tests and
recordings: `data-workspace-state`, `data-workspace-geometry-current`,
`data-workspace-package`, `data-workspace-sources`,
`data-workspace-source-inspection`, `data-workspace-hidden-occurrences`,
`data-workspace-dropped-occurrences`, `data-workspace-dropped-selection`,
`data-workspace-selected-object`, and `data-workspace-saved`.

One headed browser record exercises all of that end to end:
[`artifacts/workspace/reopen/`](../../artifacts/workspace/reopen/README.md)
saves a session of three hidden walls, one selected slab, a section plane and a
moved camera; reopens it against the unchanged Digital Hub package as
`unverifiable`, then `verified` after **Check sources**, re-saving the identical
1,871 bytes; reopens it after a same-length edit to one IFC document as
`changed-source` with `geometryIsCurrent` false over a still-verified package;
and reopens it once more through a page reload so both restore paths are
recorded. Validate it with `pnpm workspace:reopen:check`.
