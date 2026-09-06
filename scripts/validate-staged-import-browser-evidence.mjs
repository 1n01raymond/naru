/**
 * Validates artifacts/import/staged-import-browser: the ADR-0021 gate 4
 * record -- the Studio usable against a cold sixty5 import, reading each
 * document's staged tree while the compiler is still extracting, then handed
 * the finished package by the same job. Gate 5 is folded in as the honest
 * reading that no per-document coarse geometry exists during import: the
 * coarse frame the record carries is the compiled package's, after handoff.
 *
 * Pins are deliberate. The seven documents, their emission order, source
 * bytes, node counts and root counts are functions of the fixture and of the
 * adapter that reads it, and they are cross-checked against the gate 1 record
 * (artifacts/import/structure-first-emission/sixty5.json) so the two records
 * describe the same trees. The package digest is HOST-LOCAL (this repository
 * has recorded a cross-host eight-byte drift in the adapter's split Scene IR)
 * and is pinned so a re-record on this host must reproduce it; do not retarget
 * it to absorb a moved package -- a moved digest means the compile changed.
 *
 * Timings are host-dependent and are bounded, never pinned. What is enforced
 * is the reading the slice rests on: the first tree lands inside the product
 * target measured end to end from the compile spawn, search and selection were
 * exercised while the compile was provably still running, every staged tree
 * was fetched exactly once over the network after the manifest was first seen
 * missing, the handoff names the same package digest the build report and the
 * Studio saw, the job stream is gapless and ends completed, and no console
 * issue was recorded. The four screenshots are re-hashed against their bytes.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const recordDirectory = resolve(repositoryRoot, "artifacts/import/staged-import-browser");
const emissionRecordPath = resolve(repositoryRoot, "artifacts/import/structure-first-emission/sixty5.json");

const schemaVersion = "naru.staged-import-browser-evidence.1";
const mode = "headed-cold-import-staged-tree-then-package";
const stagedManifestSchema = "naru.staged-import-preview.2";
const jobEventSchema = "naru.import-job-event.2";
const manifestSha256 = "77d7d587d6b32938a371325e281a4584e10c2ff3118a59f300a9da097eb2f478";
/** The product target of ADR-0021 gate 4, restated so a record cannot widen it. */
const productTarget = { lowerSeconds: 5, upperSeconds: 15 };
/** A cold sixty5 compile plus browser on one host; the bound is a sanity ceiling, not a claim. */
const readyCeilingMs = 1_800_000;
const emissionOrder = ["facade", "structure", "kitchen", "electrical", "ventilation", "plumbing", "architecture"];
const screenshotNames = ["stagedTree", "stagedSearch", "coarse", "ready"];

const pinned = {
  datasetId: "ifc-bench-sixty5",
  documentCount: 7,
  // HOST-LOCAL: reproduced by this host's compile, not necessarily by another's.
  packageDigest: "3206ea40835d8ca70a0a82208e397a8dcdcd66351b29b4df0e8102ff910e6454",
  resourceCount: 5,
  // This package (explicit edges, compact JSON) carries 324 target chunks; the
  // pre-E2.1 `output/ifc/sixty5-prb` package the first-frame record uses has 234.
  targetChunksTotal: 324,
};

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const isHex64 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

const label = "[staged-import-browser] sixty5";
const record = JSON.parse(await readFile(resolve(recordDirectory, "sixty5.json"), "utf8"));
const emissionRecord = JSON.parse(await readFile(emissionRecordPath, "utf8"));

check(record.schemaVersion === schemaVersion, `${label}: schemaVersion ${record.schemaVersion}`);
check(record.mode === mode, `${label}: mode ${record.mode}`);
check(record.model === "sixty5", `${label}: model ${record.model}`);
check(record.fixture?.datasetId === pinned.datasetId, `${label}: dataset ${record.fixture?.datasetId}`);
check(record.fixture?.manifest?.sha256 === manifestSha256, `${label}: manifest sha256 ${record.fixture?.manifest?.sha256}`);
check(typeof record.commit?.head === "string" && record.commit.head.length === 40, `${label}: commit head missing`);
check(isHex64(record.adapter?.fingerprint), `${label}: adapter identity missing`);
check(record.browser?.headless === false, `${label}: the record must come from a headed browser`);
check(typeof record.browser?.engine === "string" && record.browser.engine.length > 0, `${label}: browser engine missing`);
check(finite(record.host?.freeMemoryBytesAtStart), `${label}: host.freeMemoryBytesAtStart missing`);
check(typeof record.timingNote === "string" && record.timingNote.includes("memory"), `${label}: timingNote must state the shared-host caveat`);

// The compile that produced the package: cold, staged, exited cleanly.
check(record.compiler?.command === "compile-ifc", `${label}: compiler command ${record.compiler?.command}`);
check(record.compiler?.stagedPreview === true, `${label}: staged preview was not enabled`);
check(record.compiler?.cache === "none (cold, no --cache)", `${label}: compiler cache ${record.compiler?.cache}`);
check(record.compiler?.exitCode === 0, `${label}: compiler exit code ${record.compiler?.exitCode}`);
check(finite(record.compiler?.elapsedMs) && record.compiler.elapsedMs > 0, `${label}: compiler elapsedMs missing`);

// Documents: pinned against the gate 1 record so both describe the same trees.
const documents = record.documents ?? [];
check(documents.length === pinned.documentCount, `${label}: ${documents.length} documents, pinned ${pinned.documentCount}`);
check(
  JSON.stringify(documents.map((entry) => entry.discipline)) === JSON.stringify(emissionOrder),
  `${label}: document order ${documents.map((entry) => entry.discipline).join(",")}`,
);
check(
  JSON.stringify(record.fixture?.documents?.map((entry) => entry.discipline)) ===
    JSON.stringify([...emissionOrder].sort()),
  `${label}: fixture documents ${record.fixture?.documents?.map((entry) => entry.discipline).join(",")}`,
);
let previousArrival = -1;
let previousBytes = -1;
for (const [rank, entry] of documents.entries()) {
  const gateOne = emissionRecord.documents?.find((row) => row.discipline === entry.discipline);
  const source = record.fixture?.documents?.find((row) => row.discipline === entry.discipline);
  const tag = `${label}: ${entry.discipline}`;
  check(gateOne !== undefined, `${tag} is not in the gate 1 record`);
  check(entry.rank === rank, `${tag} rank ${entry.rank}, expected ${rank}`);
  check(entry.rank === gateOne?.emissionRank, `${tag} rank ${entry.rank}, gate 1 emission rank ${gateOne?.emissionRank}`);
  check(entry.nodeCount === gateOne?.nodeCount, `${tag} nodeCount ${entry.nodeCount}, gate 1 ${gateOne?.nodeCount}`);
  check(entry.rootCount === gateOne?.rootCount, `${tag} rootCount ${entry.rootCount}, gate 1 ${gateOne?.rootCount}`);
  check(entry.sourceBytes === gateOne?.sourceBytes, `${tag} sourceBytes ${entry.sourceBytes}, gate 1 ${gateOne?.sourceBytes}`);
  check(entry.sourceDigest === gateOne?.sourceDigest, `${tag} sourceDigest ${entry.sourceDigest}, gate 1 ${gateOne?.sourceDigest}`);
  check(entry.sourceDigest === source?.sha256 && entry.sourceBytes === source?.bytes, `${tag} does not match the fixture document it names`);
  check(entry.sourceBytes > previousBytes, `${tag} breaks the ascending-size emission order`);
  check(finite(entry.arrivalMs) && entry.arrivalMs > previousArrival, `${tag} arrived at ${entry.arrivalMs} ms, not after the previous tree`);
  check(finite(entry.adapterStagedElapsedMs) && entry.adapterStagedElapsedMs <= entry.arrivalMs, `${tag} arrived in the Studio before the adapter staged it`);
  check(isHex64(entry.hierarchy?.sha256) && isHex64(entry.hierarchy?.columnsSha256), `${tag} hierarchy digests missing`);
  check(entry.hierarchy?.byteLength > 0 && entry.hierarchy?.columnsByteLength > 0, `${tag} hierarchy byte lengths missing`);
  check(entry.hierarchy?.uri === `hierarchy-${entry.discipline}.json`, `${tag} hierarchy uri ${entry.hierarchy?.uri}`);
  check(entry.hierarchy?.columnsUri === `hierarchy-${entry.discipline}.bin`, `${tag} columns uri ${entry.hierarchy?.columnsUri}`);
  previousArrival = entry.arrivalMs;
  previousBytes = entry.sourceBytes;
}

// Milestones: ordered, finite, and the product target read from the record's own figure.
const milestones = record.milestones ?? {};
const milestoneOrder = ["firstTreeMs", "lastTreeMs", "stagedCompleteMs", "packageHandoffMs", "hierarchyReadyMs", "coarseFrameMs", "readyMs"];
for (const name of milestoneOrder) check(finite(milestones[name]) && milestones[name] >= 0, `${label}: milestones.${name} is ${milestones[name]}`);
for (let index = 1; index < milestoneOrder.length; index += 1) {
  const [before, after] = [milestoneOrder[index - 1], milestoneOrder[index]];
  check(milestones[before] <= milestones[after], `${label}: ${before} (${milestones[before]}) is after ${after} (${milestones[after]})`);
}
check(finite(milestones.compileExitMs) && milestones.compileExitMs >= milestones.packageHandoffMs, `${label}: compile exited before the handoff`);
check(milestones.readyMs <= readyCeilingMs, `${label}: readyMs ${milestones.readyMs} over the ${readyCeilingMs} ms ceiling`);

const target = record.productTarget ?? {};
check(target.lowerSeconds === productTarget.lowerSeconds && target.upperSeconds === productTarget.upperSeconds, `${label}: product target ${target.lowerSeconds}-${target.upperSeconds} s was moved`);
check(target.firstTreeMs === milestones.firstTreeMs, `${label}: productTarget.firstTreeMs ${target.firstTreeMs} != milestones.firstTreeMs ${milestones.firstTreeMs}`);
const meets = milestones.firstTreeMs <= productTarget.upperSeconds * 1_000;
const inside = meets && milestones.firstTreeMs >= productTarget.lowerSeconds * 1_000;
check(target.meetsTarget === meets, `${label}: productTarget.meetsTarget ${target.meetsTarget} does not follow from ${milestones.firstTreeMs} ms`);
check(target.withinBand === inside, `${label}: productTarget.withinBand ${target.withinBand} does not follow from ${milestones.firstTreeMs} ms`);
check(meets === true, `${label}: first tree at ${milestones.firstTreeMs} ms misses the ${productTarget.upperSeconds} s target (gate 4 fails, the ADR is not loosened)`);

const firstTree = record.firstTree ?? {};
check(firstTree.discipline === emissionOrder[0], `${label}: first tree was ${firstTree.discipline}`);
// The Studio publishes staged ROWS (`data-staged-nodes`), which include one synthetic document-root row per tree;
// the manifest counts the document's nodes, so the first tree shows exactly one more row than nodes.
check(firstTree.nodeCount === (documents[0]?.nodeCount ?? -1) + 1, `${label}: first tree rows ${firstTree.nodeCount} != nodes ${documents[0]?.nodeCount} + 1`);
check(firstTree.ms === milestones.firstTreeMs, `${label}: firstTree.ms ${firstTree.ms} != milestones.firstTreeMs`);
check(firstTree.stagedCount === 1 && firstTree.totalCount === pinned.documentCount, `${label}: first tree counts ${firstTree.stagedCount}/${firstTree.totalCount}`);
check(firstTree.compileRunning === true, `${label}: the compile was not running when the first tree was read`);
// Two observers stamp the first tree: the recorder's dataset poll (`firstTreeMs`) and the page's own attribute
// timeline (`arrivalMs`). They read the same event through different mechanisms, so they agree within a bound, not exactly.
const firstTreeObserverSkewMs = 100;
check(Number.isFinite(documents[0]?.arrivalMs) && Math.abs(documents[0].arrivalMs - milestones.firstTreeMs) <= firstTreeObserverSkewMs, `${label}: first tree arrival ${documents[0]?.arrivalMs} is not within ${firstTreeObserverSkewMs} ms of firstTreeMs ${milestones.firstTreeMs}`);
check(documents.at(-1)?.arrivalMs === milestones.lastTreeMs, `${label}: last tree arrival ${documents.at(-1)?.arrivalMs} != lastTreeMs`);

// Interactions: the tree was searchable and selectable while extraction continued.
const interactions = record.interactions ?? {};
const search = interactions.searchDuringImport ?? {};
check(typeof search.query === "string" && search.query.length > 0, `${label}: search query missing`);
check(Number.isSafeInteger(search.matches) && search.matches > 0, `${label}: search during import matched ${search.matches}`);
check(search.compileRunning === true, `${label}: search ran after the compile had exited`);
check(search.stagedCount >= 1 && search.stagedCount < pinned.documentCount, `${label}: search ran with ${search.stagedCount} of ${pinned.documentCount} trees, not during import`);
check(finite(search.ms) && search.ms >= milestones.firstTreeMs && search.ms < milestones.lastTreeMs, `${label}: search at ${search.ms} ms is outside the import window`);
const selection = interactions.selectionDuringImport ?? {};
check(typeof selection.occurrenceId === "string" && selection.occurrenceId.length > 0, `${label}: selection occurrenceId missing`);
check(/staged preview, geometry pending/.test(selection.selectionText ?? ""), `${label}: selection text "${selection.selectionText}" does not say geometry is pending`);
check(selection.compileRunning === true, `${label}: selection happened after the compile had exited`);
check(finite(selection.ms) && selection.ms < milestones.lastTreeMs, `${label}: selection at ${selection.ms} ms is outside the import window`);
const searchAfter = interactions.searchAfterLastTree ?? {};
check(searchAfter.stagedCount === pinned.documentCount && searchAfter.matches >= search.matches, `${label}: search over all trees matched ${searchAfter.matches} (< ${search.matches} during import)`);

// Protocol statements the numbers depend on.
const protocol = record.protocol ?? {};
check(protocol.pollMs === 500, `${label}: pollMs ${protocol.pollMs}`);
check(finite(protocol.watchStartedBeforeSpawnMs) && protocol.watchStartedBeforeSpawnMs < 0, `${label}: the Studio was not watching before the compile spawned`);
check(Number.isSafeInteger(protocol.manifestPollsBeforeSpawn) && protocol.manifestPollsBeforeSpawn > 0, `${label}: no manifest poll before the spawn`);
check(typeof protocol.clock === "string" && protocol.clock.includes("spawn"), `${label}: protocol.clock must define the spawn-relative clock`);
check(typeof protocol.hierarchyInteraction === "string" && protocol.hierarchyInteraction.includes("no expand/collapse"), `${label}: protocol must state how 'expand and search' was exercised`);
check(typeof protocol.coarsePreview === "string" && protocol.coarsePreview.includes("No per-document coarse geometry"), `${label}: protocol must state the gate 5 reading`);

// Network: the manifest was polled through a 404 into a 200, every tree fetched exactly once,
// and the package came from the origin with CORS and honest Range responses.
const network = record.network ?? {};
const manifestPolls = network.manifestPolls ?? {};
const isStatusCounts = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((count) => Number.isSafeInteger(count) && count > 0);
const manifestStatuses = manifestPolls.statuses ?? {};
check(isStatusCounts(manifestStatuses), `${label}: manifest poll statuses must be a status -> count object`);
check(Number.isSafeInteger(manifestStatuses["404"]) && manifestStatuses["404"] > 0 && Number.isSafeInteger(manifestStatuses["200"]) && manifestStatuses["200"] > 0, `${label}: manifest polls saw statuses ${JSON.stringify(manifestStatuses)}, expected both 404 and 200`);
check(manifestPolls.notFoundConsoleMessages === manifestStatuses["404"], `${label}: ${manifestPolls.notFoundConsoleMessages} manifest 404 console messages != ${manifestStatuses["404"]} 404 responses`);
check(typeof protocol.manifestNotFound === "string" && /404/.test(protocol.manifestNotFound) && /suppress/.test(protocol.manifestNotFound), `${label}: protocol.manifestNotFound does not explain the expected manifest 404 console messages`);
check(manifestPolls.accessControlAllowOrigin === record.servers?.studio, `${label}: manifest ACAO ${manifestPolls.accessControlAllowOrigin} != Studio ${record.servers?.studio}`);
const hierarchyFetches = Array.isArray(network.hierarchyFetches) ? network.hierarchyFetches : [];
check(hierarchyFetches.length === pinned.documentCount * 2, `${label}: ${hierarchyFetches.length} hierarchy resource fetch summaries, expected ${pinned.documentCount * 2}`);
for (const fetch of hierarchyFetches) {
  check(fetch.responses === 1 && isStatusCounts(fetch.statuses) && Object.keys(fetch.statuses).join() === "200" && fetch.statuses["200"] === 1, `${label}: ${fetch.path} fetched ${fetch.responses} times with ${JSON.stringify(fetch.statuses)}`);
  check(fetch.accessControlAllowOrigin === record.servers?.studio, `${label}: ${fetch.path} ACAO ${fetch.accessControlAllowOrigin}`);
}
const packageFetches = Array.isArray(network.packageFetches) ? network.packageFetches : [];
check(packageFetches.length > 0, `${label}: no package fetches recorded`);
const sceneBin = packageFetches.find((fetch) => /scene\.bin$/.test(fetch.path ?? ""));
check(sceneBin !== undefined && sceneBin.rangeRequests > 0 && sceneBin.contentRangeResponses === sceneBin.rangeRequests && isStatusCounts(sceneBin.statuses) && (sceneBin.statuses["206"] ?? 0) > 0, `${label}: scene.bin Range delivery ${JSON.stringify(sceneBin)}`);
const eagerFetches = packageFetches.filter((fetch) => fetch.loading === "eager");
const lazyFetches = packageFetches.filter((fetch) => fetch.loading === "lazy-on-pick");
check(eagerFetches.length + lazyFetches.length === packageFetches.length, `${label}: every package fetch summary must be eager or lazy-on-pick`);
check(eagerFetches.length === 3 && eagerFetches.every((fetch) => fetch.responses > 0), `${label}: expected scene.gltf, coarse.bin, and scene.bin fetched eagerly, saw ${JSON.stringify(eagerFetches.map((fetch) => [fetch.path, fetch.responses]))}`);
for (const fetch of eagerFetches) check(fetch.accessControlAllowOrigin === record.servers?.studio, `${label}: ${fetch.path} ACAO ${fetch.accessControlAllowOrigin}`);
check(lazyFetches.length === 2 && lazyFetches.every((fetch) => /properties\.(json|bin)$/.test(fetch.path ?? "") && fetch.responses === 0), `${label}: the property sidecar is resolved on a pick and this record never picks after handoff, so both its resources must be lazy and unfetched, saw ${JSON.stringify(lazyFetches.map((fetch) => [fetch.path, fetch.responses]))}`);
const serverSide = network.serverSide ?? {};
check(Number.isSafeInteger(serverSide.manifestPollsBeforeSpawn) && serverSide.manifestPollsBeforeSpawn === protocol.manifestPollsBeforeSpawn, `${label}: server-side polls before spawn ${serverSide.manifestPollsBeforeSpawn} != page-side ${protocol.manifestPollsBeforeSpawn}`);
check(Number.isSafeInteger(serverSide.rangeRequests) && serverSide.rangeRequests >= sceneBin?.rangeRequests, `${label}: server-side range requests ${serverSide.rangeRequests}`);

// Job stream: gapless, terminal completed, exactly one staged event per document in emission order.
const jobEvents = Array.isArray(record.jobEvents) ? record.jobEvents : [];
check(jobEvents.length > 0, `${label}: no job events`);
jobEvents.forEach((event, index) => {
  check(event.schemaVersion === jobEventSchema, `${label}: jobEvents[${index}] schema ${event.schemaVersion}`);
  check(event.sequence === index, `${label}: jobEvents[${index}] sequence ${event.sequence}`);
  check(index === 0 || event.elapsedMs >= jobEvents[index - 1].elapsedMs, `${label}: jobEvents[${index}] elapsedMs went backwards`);
});
check(jobEvents.at(-1)?.state === "completed", `${label}: last job state ${jobEvents.at(-1)?.state}`);
const stagedEvents = jobEvents.filter((event) => event.staged !== null && event.staged !== undefined);
check(stagedEvents.length === pinned.documentCount, `${label}: ${stagedEvents.length} staged job events`);
stagedEvents.forEach((event, index) => {
  check(event.state === "extracting", `${label}: staged event ${index} in state ${event.state}`);
  check(event.staged.discipline === emissionOrder[index], `${label}: staged event ${index} is ${event.staged.discipline}`);
  check(event.staged.stagedCount === index + 1 && event.staged.totalCount === pinned.documentCount, `${label}: staged event ${index} counts ${event.staged.stagedCount}/${event.staged.totalCount}`);
});
const jobIds = new Set(jobEvents.map((event) => event.jobId));
check(jobIds.size === 1, `${label}: ${jobIds.size} distinct job ids`);

// Manifest, build report, and the state the Studio settled in: one package digest everywhere.
const manifest = record.stagedManifest ?? {};
check(manifest.schemaVersion === stagedManifestSchema, `${label}: staged manifest schema ${manifest.schemaVersion}`);
check(jobIds.has(manifest.jobId), `${label}: manifest jobId ${manifest.jobId} is not the job stream's`);
check(manifest.complete === true && manifest.stagedCount === pinned.documentCount && manifest.totalCount === pinned.documentCount, `${label}: manifest ${manifest.stagedCount}/${manifest.totalCount} complete=${manifest.complete}`);
check(manifest.package?.documentUri === "scene.gltf", `${label}: manifest package documentUri ${manifest.package?.documentUri}`);
const digest = manifest.package?.packageDigest;
check(isHex64(digest), `${label}: manifest package digest ${digest}`);
check(digest === record.buildReport?.packageDigest, `${label}: build report digest ${record.buildReport?.packageDigest} != manifest ${digest}`);
check(digest === record.stateAtReady?.stagedPackageDigest, `${label}: Studio handed off to ${record.stateAtReady?.stagedPackageDigest}, manifest says ${digest}`);
check(digest === pinned.packageDigest, `${label}: package digest ${digest} != pinned ${pinned.packageDigest} (host-local; do not retarget silently)`);
const resources = Array.isArray(manifest.package?.resources) ? manifest.package.resources : [];
check(resources.length === pinned.resourceCount && record.buildReport?.resourceCount === pinned.resourceCount, `${label}: ${resources.length} manifest resources / ${record.buildReport?.resourceCount} build-report resources, pinned ${pinned.resourceCount}`);
for (const resource of resources) check(isHex64(resource.sha256) && Number.isSafeInteger(resource.byteLength) && resource.byteLength > 0, `${label}: resource ${resource.uri} digest/length`);

// Studio state at ready and the screenshots that carry the claims.
const state = record.stateAtReady ?? {};
check(state.sceneSource !== "staged" && state.stagedState === "package", `${label}: Studio still on the staged source (${state.sceneSource} / ${state.stagedState})`);
check(state.hierarchyReady === "true" && state.coarseReady === "true", `${label}: hierarchy/coarse not ready at the end (${state.hierarchyReady}/${state.coarseReady})`);
check(typeof state.status === "string" && /Residency budget reached|ready/i.test(state.status), `${label}: status at the end is "${state.status}"`);
check(state.targetReady === "limited" || state.targetReady === "true", `${label}: targetReady ${state.targetReady}`);
check(Number(String(state.occurrenceCount ?? "").replace(/[^0-9]/g, "")) === 78_173, `${label}: occurrenceCount ${state.occurrenceCount}`);
check(state.targetChunksTotal === pinned.targetChunksTotal, `${label}: targetChunksTotal ${state.targetChunksTotal}`);
check(Number.isSafeInteger(state.targetChunksReady) && state.targetChunksReady > 0 && state.targetChunksReady <= state.targetChunksTotal, `${label}: targetChunksReady ${state.targetChunksReady}`);
check(state.targetSchedulerRequests + state.targetSchedulerSkips === state.targetChunksTotal, `${label}: requests ${state.targetSchedulerRequests} + skips ${state.targetSchedulerSkips} != ${state.targetChunksTotal}`);
check(state.residentGpuBytes <= state.residencyBudgetBytes, `${label}: GPU bytes ${state.residentGpuBytes} over budget ${state.residencyBudgetBytes}`);
check(Array.isArray(record.consoleIssues) && record.consoleIssues.length === 0, `${label}: ${record.consoleIssues?.length} console issues`);
check(typeof record.timingNote === "string" && record.timingNote.includes("memory"), `${label}: timingNote must state the memory-pressure caveat`);

const screenshots = record.screenshots ?? {};
for (const name of screenshotNames) {
  const entry = screenshots[name];
  if (entry === undefined || typeof entry.file !== "string") { check(false, `${label}: screenshots.${name} missing`); continue; }
  const path = resolve(recordDirectory, entry.file);
  let bytes;
  try { bytes = await readFile(path); } catch (error) { check(false, `${label}: cannot read ${entry.file}: ${error instanceof Error ? error.message : String(error)}`); continue; }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  check(bytes.length === entry.bytes, `${label}: ${entry.file} is ${bytes.length} B, record says ${entry.bytes}`);
  check(sha256 === entry.sha256, `${label}: ${entry.file} sha256 ${sha256} != recorded ${entry.sha256}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[staged-import-browser] FAIL ${failure}`);
  process.exit(1);
}
console.log(`[staged-import-browser] first tree ${milestones.firstTreeMs} ms (${firstTree.discipline}, ${firstTree.nodeCount} rows; target <= ${productTarget.upperSeconds} s met), last tree ${milestones.lastTreeMs} ms, handoff ${milestones.packageHandoffMs} ms, coarse ${milestones.coarseFrameMs} ms, ready ${milestones.readyMs} ms, ${state.targetChunksReady}/${state.targetChunksTotal} chunks, package ${digest.slice(0, 12)}…`);
