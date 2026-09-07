/**
 * Validates the browser gate ADR-0017 left open: what moving a federation's
 * assembly tree out of the compiled glTF document does to a real-large package
 * in a browser, and what its sidecar costs.
 *
 * The digests and byte counts below are HOST-LOCAL. This Windows host's IFC
 * adapter emits a Scene IR split a few bytes different from the macOS host's,
 * so neither package digest reproduces elsewhere. Retarget them only together
 * with a deliberate re-record, never to make a failing run pass.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const repositoryRoot = resolve(import.meta.dirname, "..");
const recordDirectory = resolve(repositoryRoot, "artifacts/ifc/relocated-hierarchy-browser");
const recordPath = resolve(recordDirectory, "relocated-hierarchy-browser.json");

function assert(condition, message) {
  if (!condition) throw new TypeError(`[relocated-browser] ${message}`);
}

const recordText = await readFile(recordPath, "utf8");
const record = JSON.parse(recordText);

assert(record.schemaVersion === "naru.relocated-hierarchy-browser.1", "Unknown evidence envelope.");
assert(record.status === "experimental-not-interchange", "Evidence status changed.");
assert(record.mode === "headed-paired-package-first-frame", "Evidence mode changed.");
assert(!/[A-Za-z]:[\\/]/u.test(recordText), "Evidence leaks a machine-local path.");
assert(record.method.host.platform === "win32", "Record was taken on another platform.");
assert(record.method.browser.engine === "Blink", "Record was taken on another engine.");
assert(record.method.browser.headless === false, "A headed browser is what this record claims.");
assert(record.method.runsPerArm === 3, "The protocol is three interleaved runs per arm.");
assert(record.method.interleaved && record.method.freshProcessPerSample, "Protocol changed.");

const arms = new Map(record.arms.map((arm) => [arm.id, arm]));
assert(arms.size === 2 && arms.has("in-place") && arms.has("relocated"), "Both arms are required.");
for (const arm of arms.values()) {
  assert(arm.samples.length === 3, `${arm.id} must carry three samples.`);
}
const inPlace = arms.get("in-place");
const relocated = arms.get("relocated");

/**
 * The endpoint both packages must reach. Relocation may move bytes; it may not
 * change what is drawn, what is resident, or what the network was asked for.
 */
const ENDPOINT = {
  status: "Residency budget reached \u00b7 24326 surface batches retained \u00b7 78173 renderable occurrences",
  targetChunksReady: "111",
  targetSchedulerRequests: "111",
  targetSchedulerSkips: "123",
  residentDecodedBytes: "66686508",
  residentGpuBytes: "66783808",
  triangleCount: "2,255,235",
  // Re-pinned 2026-09-07 after the Studio camera fix (PR #133): the default
  // view now looks from above, so the centre-viewport click lands on a prefab
  // facade wall panel (occurrence 52355 of the facade document, 44 IFC2X3
  // entries) instead of the foundation beam 975347 the mirrored from-below view
  // exposed. Every residency, geometry, and network pin reproduced unchanged.
  occurrenceName: "Selected occurrence:ifc:facade-a9a1b20214da:52355",
};
for (const arm of arms.values()) {
  for (const [index, sample] of arm.samples.entries()) {
    for (const [key, expected] of Object.entries(ENDPOINT)) {
      assert(
        sample[key] === expected,
        `${arm.id} run ${index + 1} ${key} is ${JSON.stringify(sample[key])}, not ${
          JSON.stringify(expected)
        }.`,
      );
    }
    assert(sample.consoleIssues === 0, `${arm.id} run ${index + 1} logged console issues.`);
  }
}
// The recorder's own verdict is not evidence of itself.
assert(
  record.endpoint.counters.every((counter) => counter.matchedInEveryRun),
  "A recorded endpoint counter differed between runs.",
);
assert(record.endpoint.holdsAcrossEveryRun === true, "The recorded endpoint verdict is false.");
assert(
  record.endpoint.counters.length >= 17,
  "The endpoint comparison lost counters.",
);
// Renumbering is the one difference relocation is allowed to make here.
assert(
  record.endpoint.nodeSuffixes["in-place"] !== record.endpoint.nodeSuffixes.relocated,
  "A relocated document keeps only the nodes that draw, so the picked node index must differ.",
);

/** The same lower median the recorder reports, so every figure is one of the runs. */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

const TIMINGS = ["hierarchyReadyMs", "coarseFrameMs", "readyMs", "usedJsHeapBytes"];
for (const arm of arms.values()) {
  for (const key of TIMINGS) {
    const recomputed = median(arm.samples.map((sample) => sample[key]));
    assert(
      arm.medians[key] === recomputed,
      `${arm.id} median ${key} is ${arm.medians[key]}, but its samples give ${recomputed}.`,
    );
  }
}
for (const key of TIMINGS) {
  const entry = record.comparison[key];
  assert(entry.inPlace === inPlace.medians[key], `comparison ${key} lost the in-place median.`);
  assert(entry.relocated === relocated.medians[key], `comparison ${key} lost the relocated median.`);
  assert(
    entry.delta === entry.relocated - entry.inPlace,
    `comparison ${key} delta does not follow from its medians.`,
  );
}

/**
 * The claim this record makes. Timings are host-sensitive, so they are held as
 * directions and bounds rather than pinned to the millisecond; the byte ledger
 * below is exact because it is a property of the two packages, not of the run.
 */
assert(record.comparison.coarseFrameMs.percent <= -10, "Relocation stopped paying for first frame.");
assert(record.comparison.coarseFrameMs.relocated < 4_200, "Relocated first frame regressed.");
assert(record.comparison.readyMs.relocated < record.comparison.readyMs.inPlace, "Ready regressed.");
assert(
  record.comparison.usedJsHeapBytes.percent <= -15,
  "The smaller document stopped paying for peak heap.",
);
assert(
  record.comparison.hierarchyReadyMs.relocated <= record.comparison.hierarchyReadyMs.inPlace,
  "A fetched sidecar must not delay hierarchy-ready.",
);

const IN_PLACE_TRANSFER = {
  packageDigest: "a2d6c72a6e936ac3ea2a183a1028cc4a06b20985c6d90b16058954323b7c3347",
  packageBytes: 657_116_508,
  documentBytes: 448_823_852,
  hierarchySidecarBytes: 0,
  hierarchyNodes: "in-place",
};
const RELOCATED_TRANSFER = {
  packageDigest: "b821e4316a5b59d9119bb1731cb6223952cf18c10d872485462b8a3d078d13f9",
  packageBytes: 602_277_504,
  documentBytes: 347_731_160,
  hierarchySidecarBytes: 46_253_688,
  hierarchyNodes: "relocated",
};
for (const [arm, expected] of [["inPlace", IN_PLACE_TRANSFER], ["relocated", RELOCATED_TRANSFER]]) {
  for (const [key, value] of Object.entries(expected)) {
    assert(
      record.transfer[arm][key] === value,
      `transfer.${arm}.${key} is ${JSON.stringify(record.transfer[arm][key])}, not ${
        JSON.stringify(value)
      }.`,
    );
  }
}
// The sidecar is a move, not a deletion: what left the document is what it costs.
assert(
  record.transfer.documentDeltaBytes ===
    RELOCATED_TRANSFER.documentBytes - IN_PLACE_TRANSFER.documentBytes,
  "The document delta does not follow from the two documents.",
);
assert(
  record.transfer.packageDeltaBytes ===
    RELOCATED_TRANSFER.packageBytes - IN_PLACE_TRANSFER.packageBytes,
  "The package delta does not follow from the two packages.",
);
assert(
  record.transfer.documentDeltaBytes + record.transfer.sidecarBytes ===
    record.transfer.packageDeltaBytes,
  "Bytes left the document that neither the sidecar nor the package accounts for.",
);

/** Relocation is the only variable, so these four must be the same bytes in both arms. */
const SHARED_RESOURCES = ["scene.bin", "coarse.bin", "properties.json", "properties.bin"];
assert(
  SHARED_RESOURCES.every((path) => record.transfer.byteIdenticalResources.includes(path)),
  "The record no longer names the shared resources it compared.",
);
const digestOf = (arm, path) =>
  record.transfer[arm].resources.find((resource) => resource.path === path)?.sha256;
for (const path of SHARED_RESOURCES) {
  const shared = digestOf("inPlace", path);
  assert(typeof shared === "string", `${path} is missing from the in-place arm.`);
  assert(
    digestOf("relocated", path) === shared,
    `${path} differs between the arms, so relocation is not the only variable.`,
  );
}
assert(digestOf("relocated", "hierarchy.json") !== undefined, "The sidecar header is unrecorded.");
assert(digestOf("inPlace", "hierarchy.bin") === undefined, "The in-place arm must ship no sidecar.");

const COUNTERS = {
  "snapshot.prototypeCount": "42435",
  "snapshot.occurrenceCount": "78173",
  "snapshot.edgeCount": "12",
  "snapshot.dataset.targetChunksTotal": "234",
  "snapshot.dataset.residencyBudgetBytes": "67108864",
  "snapshot.dataset.visibleOccurrences": "78173",
  "semanticProperties.entryCount": 44,
};
for (const [key, value] of Object.entries(COUNTERS)) {
  const counter = record.endpoint.counters.find((entry) => entry.key === key);
  assert(counter !== undefined, `The endpoint comparison dropped ${key}.`);
  assert(
    counter.value === value,
    `${key} is ${JSON.stringify(counter.value)}, not ${JSON.stringify(value)}.`,
  );
}
// 111 chunks admitted out of 234 demanded, and 123 refused before their Range.
assert(
  Number(ENDPOINT.targetSchedulerRequests) + Number(ENDPOINT.targetSchedulerSkips) === 234,
  "Requests and skips no longer account for every demanded chunk.",
);

const RANGED_SCENE_RESPONSES = 113;
for (const arm of arms.values()) {
  const sidecar = arm.id === "relocated";
  for (const [index, sample] of arm.samples.entries()) {
    const where = `${arm.id} run ${index + 1}`;
    const ranged = sample.requestLedger.find(
      (entry) => entry.resource === "scene.bin" && entry.status === 206,
    );
    assert(
      ranged?.count === RANGED_SCENE_RESPONSES,
      `${where} served ${ranged?.count} ranged scene.bin responses, not ${RANGED_SCENE_RESPONSES}.`,
    );
    const sidecarEntry = sample.requestLedger.find((entry) => entry.resource === "hierarchy.bin");
    assert(
      sidecar ? sidecarEntry?.count === 1 : sidecarEntry === undefined,
      `${where} ${sidecar ? "must fetch the sidecar exactly once" : "must not fetch a sidecar"}.`,
    );
    assert(
      sidecar
        ? sample.sidecarResponseIndex >= 0 &&
          sample.sidecarResponseIndex < sample.coarseResponseIndex
        : sample.sidecarResponseIndex === -1,
      `${where} sidecar ordering is not what the record claims.`,
    );
  }
}
const sidecarFetch = record.sidecarFetch;
assert(sidecarFetch.resource === "hierarchy.bin", "The sidecar payload was renamed.");
assert(sidecarFetch.bytes === 46_250_496, `The sidecar is ${sidecarFetch.bytes} B.`);
assert(
  sidecarFetch.requestsPerRun.length === 3 &&
    sidecarFetch.requestsPerRun.every((count) => count === 1),
  "The sidecar must be fetched once per run: it is read, not streamed.",
);
assert(
  sidecarFetch.responseIndexPerRun.every(
    (at, run) => at === relocated.samples[run].sidecarResponseIndex,
  ),
  "The recorded sidecar response order does not match the samples.",
);
assert(sidecarFetch.precedesCoarsePayload === true, "The sidecar no longer precedes coarse.bin.");
assert(sidecarFetch.absentFromInPlaceArm === true, "The in-place arm fetched a sidecar.");

assert(record.publishedRun.arm === "relocated", "The committed capture must show the new path.");
// `index` is the human-readable run number the recorder prints, so it is 1-based.
const published = relocated.samples[record.publishedRun.index - 1];
assert(published !== undefined, "The published run is not one of the samples.");
assert(
  published.coarseFrameMs === relocated.medians.coarseFrameMs,
  "The published run is not the median first frame it claims to be.",
);
assert(record.consoleIssues.length === 6, "Every run's console must be accounted for.");
assert(record.consoleIssues.every((count) => count === 0), "A run logged console issues.");

for (const [name, capture] of Object.entries(record.screenshots)) {
  const bytes = await readFile(resolve(recordDirectory, capture.path));
  assert(bytes.byteLength === capture.bytes, `${name} capture is ${bytes.byteLength} B on disk.`);
  assert(
    createHash("sha256").update(bytes).digest("hex") === capture.sha256,
    `${name} capture does not match its recorded digest.`,
  );
}
assert(
  published.budgetLimitedScreenshotSha256 === record.screenshots.budgetLimited.sha256,
  "The committed capture did not come from the published run.",
);

console.log(
  `[relocated-browser] ${record.arms.length} arms x ${record.method.runsPerArm} runs: first frame ` +
    `${record.comparison.coarseFrameMs.inPlace} -> ${record.comparison.coarseFrameMs.relocated} ms ` +
    `(${record.comparison.coarseFrameMs.percent}%), document ${record.transfer.inPlace.documentBytes}` +
    ` -> ${record.transfer.relocated.documentBytes} B, sidecar ${sidecarFetch.bytes} B once per run, ` +
    `endpoint identical over ${record.endpoint.counters.length} counters`,
);
