// The second-engine repeat of the real-large first-frame protocol. Everything
// this record shares with `artifacts/ifc/sixty5-first-frame` is asserted at the
// same pinned value, because a result that is genuinely engine-independent must
// not drift when the engine changes. Only the milestones, the heap reading, and
// the picked object are allowed to differ: the first two are checked against
// what Gecko can actually report rather than against Blink's numbers, and the
// pick is pinned per engine because the centre pixel sits on the seam between
// two adjacent prefab facade panels (re-pinned 2026-09-07, see below).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDirectory = fileURLToPath(
  new URL("../artifacts/ifc/sixty5-first-frame-gecko", import.meta.url),
);
const evidence = JSON.parse(
  await readFile(resolve(evidenceDirectory, "browser-residency.json"), "utf8"),
);
const blink = JSON.parse(
  await readFile(
    fileURLToPath(
      new URL("../artifacts/ifc/sixty5-first-frame/browser-residency.json", import.meta.url),
    ),
    "utf8",
  ),
);
const buildReport = JSON.parse(
  await readFile(
    fileURLToPath(new URL("../artifacts/ifc/sixty5/build-report.json", import.meta.url)),
    "utf8",
  ),
);

const RANGE_HEADER = new RegExp("^bytes=\\d+-\\d+$", "u");

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

assert(
  evidence.schemaVersion === "madi.ifc-browser-residency.2",
  "Unsupported IFC browser evidence schema.",
);
assert(
  evidence.source.packageDigest === buildReport.output.packageDigest &&
    JSON.stringify(evidence.source.resources) === JSON.stringify(buildReport.output.resources),
  "The Gecko repeat must open the digest-pinned sixty5 package.",
);
// A repeat is only a repeat if both engines opened the same bytes.
assert(
  evidence.source.packageDigest === blink.source.packageDigest,
  "The Gecko repeat must open the same package the Blink record opened.",
);
assert(
  evidence.browser.id === "firefox" &&
    evidence.browser.engine === "Gecko" &&
    evidence.browser.headless === false &&
    evidence.browser.version.startsWith("150.") &&
    JSON.stringify(evidence.browser.viewport) === JSON.stringify(blink.browser.viewport),
  "The repeat must come from headed Firefox 150 (Gecko) at the Blink record's viewport.",
);
assert(
  evidence.host.platform === "win32" && blink.host.platform === "win32",
  "This record closes the engine half only; both records still run on Windows.",
);

const { hierarchyReadyMs, coarseFrameMs, readyMs } = evidence.milestones;
assert(
  Number.isFinite(hierarchyReadyMs) &&
    Number.isFinite(coarseFrameMs) &&
    Number.isFinite(readyMs) &&
    0 < hierarchyReadyMs &&
    hierarchyReadyMs < coarseFrameMs &&
    coarseFrameMs < readyMs,
  "Milestones must record hierarchy before coarse before ready.",
);
// Gecko is slower than Blink at every milestone on this host and the record
// says so rather than hiding it. The committed run is the median of three
// (coarse 6.348 s / 6.801 s / 7.413 s; ready 12.729 s / 13.712 s / 13.977 s),
// so these bounds are this engine's measured envelope, not the Blink budget.
assert(
  coarseFrameMs <= 12_000 && coarseFrameMs - hierarchyReadyMs <= 6_000,
  "The Gecko repeat must present a first coarse frame within 12 s, and within 6 s of hierarchy.",
);
assert(readyMs <= 30_000, "The Gecko repeat must reach its budget-limited ready state within 30 s.");

const { dataset } = evidence.snapshot;
const blinkDataset = blink.snapshot.dataset;
const budgetBytes = Number(dataset.residencyBudgetBytes);
assert(
  dataset.hierarchyReady === "true" &&
    dataset.coarseReady === "true" &&
    dataset.targetReady === "limited" &&
    dataset.residencyBudgetReached === "true",
  "The Gecko repeat must reach a budget-limited rendered state through coarse residency.",
);
// The point of a second-engine repeat. Chunk admission is decided from measured
// decoded and GPU cost against a byte budget, so a second engine has to reach
// the same resident set from the same package, not merely a similar one.
for (const key of [
  "targetChunksReady",
  "targetChunksTotal",
  "targetSchedulerRequests",
  "targetSchedulerSkips",
  "residentDecodedBytes",
  "residentGpuBytes",
  "residencyBudgetBytes",
  "visibleOccurrences",
]) {
  assert(
    dataset[key] === blinkDataset[key],
    `Engine-independent residency figure ${key} drifted: ${dataset[key]} against Blink ${blinkDataset[key]}.`,
  );
}
assert(
  dataset.targetChunksReady === "111" &&
    dataset.targetChunksTotal === "234" &&
    dataset.targetSchedulerRequests === "111" &&
    dataset.targetSchedulerSkips === "123" &&
    Number(dataset.targetSchedulerRequests) + Number(dataset.targetSchedulerSkips) ===
      Number(dataset.targetChunksTotal),
  "Both engines must admit the same 111 of 234 chunks and skip the same 123 before fetching them.",
);
assert(
  dataset.residentDecodedBytes === "66686508" &&
    dataset.residentGpuBytes === "66783808" &&
    Number(dataset.residentDecodedBytes) <= budgetBytes &&
    Number(dataset.residentGpuBytes) <= budgetBytes,
  "The Gecko resident set must hold the pinned bytes inside both 64 MiB budgets.",
);
assert(
  evidence.snapshot.occurrenceCount === blink.snapshot.occurrenceCount &&
    evidence.snapshot.prototypeCount === blink.snapshot.prototypeCount &&
    evidence.snapshot.occurrenceCount === "78173" &&
    evidence.snapshot.prototypeCount === "42435",
  "The Gecko repeat must retain every sixty5 occurrence and prototype identity.",
);
assert(
  evidence.snapshot.triangleCount === blink.snapshot.triangleCount &&
    evidence.snapshot.edgeCount === blink.snapshot.edgeCount &&
    evidence.snapshot.triangleCount === "2,255,235" &&
    evidence.snapshot.edgeCount === "12",
  "Both engines must rasterize the same resident geometry counts.",
);
assert(
  evidence.snapshot.statusState === "ready" &&
    evidence.snapshot.statusStage === "rendered" &&
    evidence.snapshot.status === blink.snapshot.status &&
    evidence.snapshot.status ===
      "Residency budget reached · 24326 surface batches retained · 78173 renderable occurrences",
  "The Gecko repeat must settle on the same deterministic rendered ready state.",
);
// Re-pinned 2026-09-07 after the Studio camera fix (PR #133). From above, the
// centre-viewport pixel sits on the seam between two adjacent prefab facade
// wall panels: Blink resolves occurrence 52355 (ID 74388) and Gecko resolves
// its neighbour 52255 (ID 74387), stable over three runs per engine. The pick
// is therefore pinned PER ENGINE and no longer asserted equal across them;
// what stays engine-independent is that both are facade wall panels of the
// same document with 44 IFC2X3 entries each. Before the fix both engines hit
// foundation beam 148736 (6 entries).
assert(
  Number(blink.picking?.selectedObjectId) === 74388 &&
    Number(evidence.picking?.selectedObjectId) === 74387 &&
    /occurrence:ifc:facade-a9a1b20214da:52255 · node 74386 · ID 74387/u.test(
      evidence.picking?.selection ?? "",
    ),
  "A centre-viewport pick must resolve the neighbouring facade wall panel on Gecko.",
);
assert(
  evidence.semanticProperties?.state === "resolved" &&
    evidence.semanticProperties.entryCount === blink.semanticProperties.entryCount &&
    evidence.semanticProperties.entryCount === 44 &&
    evidence.semanticProperties.sampleEntries.some(
      (entry) =>
        entry.key === "ArchiCADProperties.ARCHICAD IFC ID" &&
        entry.value === "0af$dCa21PeFVGJ5imB0my",
    ),
  "The picked wall panel must resolve 44 IFC2X3 property entries from the sidecar.",
);

const rangeResponses = evidence.binaryRequests.filter(
  (request) => request.resource.startsWith("scene.bin") && request.range !== null,
);
assert(
  rangeResponses.length === 113 &&
    rangeResponses.every(
      (request) => request.status === 206 && RANGE_HEADER.test(request.range),
    ),
  "The Gecko repeat must promote its chunks through the same 113 satisfied Range requests.",
);
// Gecko exposes neither performance.memory nor measureUserAgentSpecificMemory(),
// so this record reports no heap figure rather than a zero. An estimator-free
// resident-set number is the job of the memory-envelope record, not of a
// browser's own accounting, and that repeat is still owed.
assert(
  evidence.snapshot.usedJsHeapBytes === null && evidence.snapshot.totalJsHeapBytes === null,
  "Gecko reports no JS heap, and the record must say so instead of recording a zero.",
);
assert(
  Number.isFinite(blink.snapshot.usedJsHeapBytes),
  "The Blink record must keep the heap reading this record cannot take.",
);
assert(
  Array.isArray(evidence.consoleIssues) && evidence.consoleIssues.length === 0,
  "The Gecko repeat must be free of console and page errors.",
);

for (const [label, screenshot] of Object.entries(evidence.screenshots)) {
  const bytes = await readFile(resolve(evidenceDirectory, screenshot.path));
  assert(
    bytes.byteLength === screenshot.bytes &&
      createHash("sha256").update(bytes).digest("hex") === screenshot.sha256,
    `Screenshot ${label} (${screenshot.path}) does not match its recorded digest.`,
  );
}

console.log(
  `[sixty5-first-frame-gecko] validated: Firefox ${evidence.browser.version} · ` +
    `first coarse frame ${(coarseFrameMs / 1000).toFixed(3)} s against Blink ` +
    `${(blink.milestones.coarseFrameMs / 1000).toFixed(3)} s · identical endpoint ` +
    `${dataset.targetChunksReady}/${dataset.targetChunksTotal} chunks, ` +
    `${dataset.residentDecodedBytes} decoded bytes, ${evidence.snapshot.triangleCount} triangles`,
);
