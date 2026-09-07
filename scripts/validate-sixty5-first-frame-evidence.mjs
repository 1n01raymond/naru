import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDirectory = fileURLToPath(
  new URL("../artifacts/ifc/sixty5-first-frame", import.meta.url),
);
const evidence = JSON.parse(
  await readFile(resolve(evidenceDirectory, "browser-residency.json"), "utf8"),
);
const buildReport = JSON.parse(
  await readFile(
    fileURLToPath(new URL("../artifacts/ifc/sixty5/build-report.json", import.meta.url)),
    "utf8",
  ),
);

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
  "First-frame evidence must use the digest-pinned sixty5 package.",
);
assert(
  evidence.browser.id === "chrome" &&
    evidence.browser.engine === "Blink" &&
    evidence.browser.headless === false,
  "The first-frame record must come from headed Chrome/Blink.",
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
// Ratcheted from 15 s / 10 s once the assembly list stopped materializing one
// element per hierarchy entry; the record itself presents at 4.340 s.
assert(
  coarseFrameMs <= 8_000 && coarseFrameMs - hierarchyReadyMs <= 4_000,
  "The shared-coarse record must present its first frame within 8 s overall and 4 s of hierarchy.",
);
// Sharing one vertex pool across a prototype's material groups leaves the
// record settling at 8.943 s (median of three runs: 8.887 s, 8.943 s,
// 9.077 s) while admitting 18 more chunks than the per-material copies did.
assert(readyMs <= 20_000, "The settled record must reach its ready state within 20 s.");

const { dataset } = evidence.snapshot;
const budgetBytes = Number(dataset.residencyBudgetBytes);
assert(
  dataset.hierarchyReady === "true" &&
    dataset.coarseReady === "true" &&
    dataset.targetReady === "limited" &&
    dataset.residencyBudgetReached === "true",
  "The optimized record must reach a budget-limited rendered state through coarse residency.",
);
assert(
  dataset.targetChunksReady === "111" && dataset.targetChunksTotal === "234",
  "The pooled resident set must admit the recorded 111/234 target chunk set.",
);
// Estimate-gated prefetch: every demanded chunk is still considered exactly
// once per demand signature, but the ones the budget cannot take are refused
// from their measured cost, so they cost neither a range request nor a decode.
// Charging each vertex pool once moves 18 of those chunks from skipped to
// admitted -- and leaves no chunk that exceeds the budget on its own.
assert(
  dataset.targetSchedulerRequests === "111" &&
    dataset.targetSchedulerSkips === "123" &&
    Number(dataset.targetSchedulerRequests) + Number(dataset.targetSchedulerSkips) ===
      Number(dataset.targetChunksTotal),
  "The gate must skip the 123 chunks the full budget cannot take and request the 111 it admits.",
);
assert(
  dataset.residentDecodedBytes === "66686508" &&
    dataset.residentGpuBytes === "66783808" &&
    Number(dataset.residentDecodedBytes) <= budgetBytes &&
    Number(dataset.residentGpuBytes) <= budgetBytes,
  "The deterministic optimized resident set must remain inside both 64 MiB budgets.",
);
assert(
  evidence.snapshot.occurrenceCount === "78173" &&
    dataset.visibleOccurrences === "78173" &&
    evidence.snapshot.prototypeCount === "42435",
  "The optimized record must retain every sixty5 occurrence and prototype identity.",
);
assert(
  evidence.snapshot.triangleCount === "2,255,235" && evidence.snapshot.edgeCount === "12",
  "The optimized resident frame must report its deterministic shared-coarse geometry counts.",
);
assert(
  evidence.snapshot.statusState === "ready" &&
    evidence.snapshot.statusStage === "rendered" &&
    evidence.snapshot.status ===
      "Residency budget reached · 24326 surface batches retained · 78173 renderable occurrences",
  "The optimized scene must reach its deterministic rendered ready state.",
);
// Re-pinned 2026-09-07 after the Studio camera fix (PR #133): the default view
// now looks from above, so the centre-viewport click lands on a prefab facade
// wall panel (occurrence 52355 of the facade document, 44 IFC2X3 entries)
// instead of the foundation beam 148736 the mirrored from-below view exposed.
// Every residency, geometry, and network pin above reproduced unchanged.
assert(
  Number(evidence.picking?.selectedObjectId) === 74388 &&
    /occurrence:ifc:facade-a9a1b20214da:52355 · node 74387 · ID 74388/u.test(
      evidence.picking?.selection ?? "",
    ),
  "Picking must resolve the same prefab facade wall panel.",
);
assert(
  evidence.semanticProperties?.state === "resolved" &&
    evidence.semanticProperties.entryCount === 44 &&
    evidence.semanticProperties.sampleEntries.some(
      (entry) =>
        entry.key === "ArchiCADProperties.ARCHICAD IFC ID" &&
        entry.value === "03fHlBRZ6jLAkrnk5k3AQm",
    ),
  "The picked wall panel must resolve its 44 IFC2X3 property entries.",
);

const rangeResponses = evidence.binaryRequests.filter(
  (request) => request.resource.startsWith("scene.bin") && request.range !== null,
);
// 113 = the 111 admitted chunks, the one the selection path pins after
// picking, and that chunk's second fetch. Fetching every demanded chunk cost
// 245 responses before the gate, for 93 chunks.
assert(
  rangeResponses.length === 113 &&
    rangeResponses.every(
      (request) => request.status === 206 && /^bytes=\d+-\d+$/u.test(request.range),
    ),
  "Every promoted target chunk must come from a satisfied HTTP Range request.",
);
// Fetching and decoding every demanded chunk peaked at 1.788 GB. The gate cut
// that to 1.481 GB; pooled vertices raise it again to 1.625 GB because 18 more
// chunks are now admitted and their decoded payload is retained, not discarded.
assert(
  evidence.snapshot.usedJsHeapBytes <= 1_750_000_000,
  "The pooled record must stay below the heap the fetch-everything drain reached.",
);
assert(
  Array.isArray(evidence.consoleIssues) && evidence.consoleIssues.length === 0,
  "The first-frame record must be free of console and page errors.",
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
  `[sixty5-first-frame] validated: ${(coarseFrameMs / 1000).toFixed(3)}s coarse frame · ` +
    `${dataset.targetChunksReady}/${dataset.targetChunksTotal} target chunks · ` +
    `${dataset.targetSchedulerRequests} requested, ${dataset.targetSchedulerSkips} skipped · ` +
    `${dataset.visibleOccurrences} visible occurrences`,
);
