#!/usr/bin/env node
/**
 * Records the Studio following a COLD sixty5 import through the staged
 * preview (ADR-0021 gate 4, with gate 5 folded in).
 *
 * The recorder starts the Studio (Vite, an EMPTY scene directory) and its own
 * Range + CORS static origin over a fresh working directory, opens the Studio
 * at `?staged=<origin>/staged/staged.json&scene=<origin>/package/scene.gltf`
 * so the page is already watching, and only THEN spawns
 * `naru compile-ifc --staged-preview` with no cache directory. Every timing
 * the record claims is measured on the PAGE clock from the moment the compile
 * was spawned, so it includes the adapter's parse, the compiler's staged
 * publication, the poll interval, the fetch, the digest verification and the
 * DOM build - "end to end, transport included" in the ADR's words.
 *
 * While extraction continues the recorder exercises the tree the way a user
 * would: a search in `#hierarchy-search` and a row selection. The Studio's
 * hierarchy list is flat and virtualized (no expand/collapse exists in the
 * product), so "expand" in the gate's wording maps to search plus selection
 * and the record says so. After the package handoff it waits for the usual
 * hierarchy / coarse-frame / ready milestones, then verifies the staged trees
 * and the package the origin served against the manifest and the build report.
 *
 * Usage:
 *   node scripts/record-staged-import-browser-evidence.mjs \
 *     [--sources output/external-fixtures/ifc-bench-sixty5] \
 *     [--work-dir output/staged-import] \
 *     [--output artifacts/import/staged-import-browser] \
 *     [--browser chrome|firefox] [--headless] [--threads 6] \
 *     [--vite-port 4177] [--origin-port 4178] [--search Wall] \
 *     [--handoff-timeout-ms 1800000]
 *
 * The IFC adapter's Python comes from NARU_IFC_PYTHON (or NARU_PYTHON).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { cpus, freemem, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright";
import { createServer } from "vite";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaVersion = "naru.staged-import-browser-evidence.1";
const mode = "headed-cold-import-staged-tree-then-package";
const stagedManifestSchema = "naru.staged-import-preview.2";
const viewport = { width: 1320, height: 1000 };
const datasetId = "ifc-bench-sixty5";
const uriPrefix = "projects/sixty5";
const federation = [
  ["architecture", "arc.ifc"],
  ["electrical", "electrical.ifc"],
  ["facade", "facade.ifc"],
  ["kitchen", "kitchen.ifc"],
  ["plumbing", "plumbing.ifc"],
  ["structure", "str.ifc"],
  ["ventilation", "ventilation.ifc"],
];
const emissionRecordPath = "artifacts/import/structure-first-emission/sixty5.json";

/**
 * ADR-0021 gate 4's band, quoted before any timing is read. The record
 * measures the first tree from compile spawn to a searchable DOM on the page
 * clock, so it can meet or refute the bound on its own.
 */
const productTarget = {
  source: "ADR-0021 gate 4 (issue #73 acceptance criterion 8)",
  lowerSeconds: 5,
  upperSeconds: 15,
  measures: "compile spawn to the first staged tree usable in the Studio, transport included",
};

const browserEngines = {
  chrome: { id: "chrome", engine: "Blink", launch: (headless) => chromium.launch({ channel: "chrome", headless }) },
  firefox: { id: "firefox", engine: "Gecko", launch: (headless) => firefox.launch({ headless }) },
};

function assert(condition, message) {
  if (!condition) throw new Error(`[staged-import-browser] ${message}`);
}

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

function insideRepository(value, flag) {
  const directory = isAbsolute(value) ? value : resolve(repoRoot, value);
  const inside = relative(repoRoot, directory);
  assert(!inside.startsWith("..") && !isAbsolute(inside), `${flag} must stay inside the repository, got ${value}.`);
  return directory;
}

function positiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  assert(Number.isInteger(parsed) && parsed > 0, `${flag} must be a positive integer.`);
  return parsed;
}

const options = {
  sources: insideRepository(argValue("--sources", `output/external-fixtures/${datasetId}`), "--sources"),
  workDir: insideRepository(argValue("--work-dir", "output/staged-import"), "--work-dir"),
  output: insideRepository(argValue("--output", "artifacts/import/staged-import-browser"), "--output"),
  browser: argValue("--browser", "chrome"),
  headless: process.argv.includes("--headless"),
  threads: positiveInteger(argValue("--threads", "6"), "--threads"),
  vitePort: positiveInteger(argValue("--vite-port", "4177"), "--vite-port"),
  originPort: positiveInteger(argValue("--origin-port", "4178"), "--origin-port"),
  search: argValue("--search", "Wall"),
  handoffTimeoutMs: positiveInteger(argValue("--handoff-timeout-ms", "1800000"), "--handoff-timeout-ms"),
};
const engine = browserEngines[options.browser];
assert(engine, `--browser must be one of ${Object.keys(browserEngines).join(", ")}.`);
assert(options.vitePort !== options.originPort, "--vite-port and --origin-port must differ.");
assert(options.search.trim().length > 0, "--search must not be blank.");

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const portable = (path) => relative(repoRoot, path).split(sep).join("/");
const round = (value) => Number(value.toFixed(1));

function sha256File(path) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveDigest(hash.digest("hex")));
  });
}

function gitOutput(...args) {
  const probe = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  assert(probe.status === 0, `git ${args.join(" ")} failed: ${probe.stderr}`);
  return probe.stdout.trim();
}

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

/* ---- sources: pinned assets of the external fixture manifest ---- */

const manifestPath = resolve(repoRoot, "fixtures/external/manifest.json");
const manifestBytes = readFileSync(manifestPath);
const fixtureManifest = JSON.parse(manifestBytes.toString("utf8"));
const dataset = fixtureManifest.datasets.find(({ id }) => id === datasetId);
assert(dataset, `Unknown external fixture dataset ${datasetId}.`);

const sources = [];
for (const [discipline, fileName] of federation) {
  const path = join(options.sources, fileName);
  assert(existsSync(path), `${fileName} is missing under ${portable(options.sources)}.`);
  const digest = await sha256File(path);
  assert(
    dataset.assets.some(({ sha256 }) => sha256 === digest),
    `${fileName} is not a pinned asset of ${datasetId} (sha256 ${digest}).`,
  );
  sources.push({ discipline, fileName, path, uriHint: `${uriPrefix}/${fileName}`, bytes: statSync(path).size, sha256: digest });
}
sources.sort((a, b) => a.discipline.localeCompare(b.discipline));
const expectedEmissionOrder = [...sources]
  .sort((a, b) => a.bytes - b.bytes || a.discipline.localeCompare(b.discipline))
  .map(({ discipline }) => discipline);

const emissionRecord = JSON.parse(readFileSync(resolve(repoRoot, emissionRecordPath), "utf8"));
assert(emissionRecord.schemaVersion === "naru.structure-first-emission.1", `${emissionRecordPath} has an unexpected schema.`);
const emissionNodeCounts = new Map(emissionRecord.documents.map((entry) => [entry.discipline, entry.nodeCount]));

const ifcPython =
  process.env.NARU_IFC_PYTHON ?? process.env.NARU_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const adapterScript = resolve(repoRoot, "native/adapter-ifc/tools/extract_federation_scene_ir.py");
const adapterProbe = spawnSync(ifcPython, [adapterScript, "--identity"], { encoding: "utf8", windowsHide: true });
assert(adapterProbe.status === 0, `IFC adapter --identity failed: ${adapterProbe.stderr}`);
const adapterIdentity = JSON.parse(adapterProbe.stdout);

const compilerCli = resolve(repoRoot, "packages/compiler/dist/cli.js");
assert(existsSync(compilerCli), "packages/compiler/dist/cli.js is missing; run `pnpm --filter @naru3d/compiler build` first.");

/* ---- working directory: fresh, so the compile is cold ---- */

rmSync(options.workDir, { recursive: true, force: true });
const stagedDirectory = join(options.workDir, "staged");
const packageDirectory = join(options.workDir, "package");
const emptySceneDirectory = join(options.workDir, "empty-scene");
mkdirSync(options.workDir, { recursive: true });
mkdirSync(emptySceneDirectory, { recursive: true });
mkdirSync(options.output, { recursive: true });

/* ---- the recorder's own origin: Range + CORS + CORP over the work dir ---- */

const contentTypes = new Map([
  [".gltf", "model/gltf+json"],
  [".json", "application/json"],
  [".bin", "application/octet-stream"],
]);
const viteOrigin = `http://127.0.0.1:${options.vitePort}`;
const originBase = `http://127.0.0.1:${options.originPort}`;
const originRequests = [];

function serveWorkDir(request, response) {
  const url = new URL(request.url ?? "/", originBase);
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const headers = {
    "Access-Control-Allow-Origin": viteOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "range, content-type",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  const finish = (status, body, extra = {}) => {
    originRequests.push({ method: request.method, path: url.pathname, status, range: request.headers.range ?? null });
    response.writeHead(status, { ...headers, ...extra });
    if (request.method === "HEAD" || body === undefined) response.end();
    else response.end(body);
  };
  if (request.method === "OPTIONS") return finish(204);
  if (request.method !== "GET" && request.method !== "HEAD") return finish(405);
  if (segments.some((segment) => segment === ".." || segment === ".")) return finish(404);
  const path = join(options.workDir, ...segments);
  let size;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return finish(404);
    size = stats.size;
  } catch {
    return finish(404);
  }
  const type = contentTypes.get(path.slice(path.lastIndexOf("."))) ?? "application/octet-stream";
  const range = request.headers.range;
  if (range === undefined) {
    if (request.method === "HEAD") return finish(200, undefined, { "Content-Type": type, "Content-Length": String(size) });
    return finish(200, readFileSync(path), { "Content-Type": type, "Content-Length": String(size) });
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) return finish(416, undefined, { "Content-Range": `bytes */${size}` });
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start > end || start >= size) return finish(416, undefined, { "Content-Range": `bytes */${size}` });
  const chunk = Buffer.alloc(end - start + 1);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, chunk, 0, chunk.byteLength, start);
  } finally {
    closeSync(descriptor);
  }
  return finish(206, chunk, {
    "Content-Type": type,
    "Content-Length": String(chunk.byteLength),
    "Content-Range": `bytes ${start}-${end}/${size}`,
  });
}

/* ---- servers, browser, page ---- */

const startedAt = performance.now();
const startedWall = new Date().toISOString();
const freeMemoryAtStart = freemem();
const consoleIssues = [];
const expectedNotFound = [];
const pageResponses = [];
const jobEvents = [];
const compileStderr = [];
let compile = null;
let origin = null;
let vite = null;
let browser = null;

const listenOrigin = () =>
  new Promise((ready, fail) => {
    origin = createHttpServer(serveWorkDir);
    origin.once("error", fail);
    origin.listen(options.originPort, "127.0.0.1", ready);
  });

const timelineInitScript = () => {
  const timeline = [];
  window.__naruStagedTimeline = timeline;
  const watched = new Set([
    "data-staged-state",
    "data-staged-documents",
    "data-staged-package-at",
    "data-hierarchy-ready",
    "data-coarse-ready",
    "data-target-ready",
    "data-state",
  ]);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target;
      if (!(target instanceof Element)) continue;
      const isRoot = target === document.documentElement;
      const isStatus = target.id === "status";
      if (!isRoot && !isStatus) continue;
      if (!watched.has(mutation.attributeName ?? "")) continue;
      timeline.push({
        ms: performance.now(),
        element: isRoot ? "root" : "status",
        attribute: mutation.attributeName,
        value: target.getAttribute(mutation.attributeName),
      });
    }
  }).observe(document, { attributes: true, subtree: true });
};

const killCompile = () => {
  if (!compile || compile.exitCode !== null || compile.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(compile.pid)], { windowsHide: true });
  } else {
    compile.kill("SIGKILL");
  }
};

try {
  await listenOrigin();
  process.env.NARU_SCENE_DIR = relative(repoRoot, emptySceneDirectory);
  vite = await createServer({
    configFile: resolve(repoRoot, "apps/webgpu-spike/vite.config.ts"),
    logLevel: "error",
    root: resolve(repoRoot, "apps/webgpu-spike"),
    server: { host: "127.0.0.1", port: options.vitePort, strictPort: true },
  });
  await vite.listen();

  browser = await engine.launch(options.headless);
  const context = await browser.newContext({ viewport });
  await context.addInitScript(timelineInitScript);
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    // The Studio polls staged.json until the compile publishes it, and Chrome reports
    // every 404 as a console error no application code can suppress. Exactly those
    // messages are expected: the manifest URL, before its first 200. They are counted
    // and reconciled against the page's 404 responses below; anything else is an issue.
    const location = message.location();
    const manifestPublished = pageResponses.some((entry) => entry.path === "/staged/staged.json" && entry.status === 200);
    if (message.type() === "error" && /status of 404/.test(message.text()) && location?.url === stagedUrl && !manifestPublished) {
      expectedNotFound.push({ url: location.url, text: message.text() });
      return;
    }
    consoleIssues.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => consoleIssues.push({ type: "pageerror", text: String(error) }));
  page.on("crash", () => consoleIssues.push({ type: "crash", text: "page crashed" }));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== originBase) return;
    const headers = response.headers();
    pageResponses.push({
      path: url.pathname,
      status: response.status(),
      range: response.request().headers()["range"] ?? null,
      contentRange: headers["content-range"] ?? null,
      contentType: headers["content-type"] ?? null,
      accessControlAllowOrigin: headers["access-control-allow-origin"] ?? null,
      accessControlExposeHeaders: headers["access-control-expose-headers"] ?? null,
    });
  });

  /* ---- open the Studio FIRST, already watching an absent manifest ---- */

  const sceneUrl = `${originBase}/package/scene.gltf`;
  const stagedUrl = `${originBase}/staged/staged.json`;
  const studioUrl = new URL(`${viteOrigin}/`);
  studioUrl.searchParams.set("scene", sceneUrl);
  studioUrl.searchParams.set("staged", stagedUrl);
  // Every wait fails fast on a Studio error state (staged import or status)
  // and on a compile that exits non-zero, quoting the status text, instead of
  // sitting silently until its own timeout.
  let compileFailure = new Promise(() => {});
  const waitFor = async (predicate, timeout, argument = null) => {
    const outcome = await Promise.race([
      page
        .waitForFunction(
          ({ source, argument: inner }) => {
            const root = document.documentElement.dataset;
            const status = document.querySelector("#status");
            if (root.stagedState === "error" || status?.dataset.state === "error") {
              return { failed: `${root.stagedState === "error" ? "staged import" : "status"} error: ${status?.textContent?.trim() ?? ""}` };
            }
            // The predicate travels as source text so one page function can wrap it.
            const check = new Function(`return (${source})`)();
            return check(inner) ? { ok: true } : null;
          },
          { source: predicate.toString(), argument },
          { timeout },
        )
        .then((handle) => handle.jsonValue()),
      compileFailure,
    ]);
    if (outcome.failed) throw new Error(`The Studio entered an error state while the recorder waited: ${outcome.failed}`);
  };
  const note = (message) => process.stderr.write(`[staged-import-browser] ${message}\n`);
  const rootDataset = () => page.evaluate(() => ({ ...document.documentElement.dataset }));
  const pageNow = () => page.evaluate(() => performance.now());
  const textOf = (selector) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, selector);
  const screenshot = async (name) => {
    const file = join(options.output, name);
    await page.screenshot({ path: file });
    const bytes = readFileSync(file);
    return { file: name, bytes: bytes.length, sha256: sha256Hex(bytes) };
  };

  await page.goto(studioUrl.href, { waitUntil: "load" });
  await waitFor(
    () => document.documentElement.dataset.sceneSource === "staged" && document.documentElement.dataset.stagedState === "waiting",
    60_000,
  );
  // Let the watcher poll the absent manifest a few times: the record shows the
  // Studio waiting on a 404, not racing a manifest that already existed.
  await sleep(1_500);
  const pollsBeforeSpawn = originRequests.filter((entry) => entry.path === "/staged/staged.json").length;
  assert(pollsBeforeSpawn > 0, "The Studio never polled staged.json before the compile was spawned.");
  const watchStartedAt = Number((await rootDataset()).stagedWatchStartedAt);

  /* ---- spawn the cold compile; the page clock at spawn is time zero ---- */

  const compileArguments = [
    compilerCli,
    "compile-ifc",
    ...sources.flatMap((source) => [
      "--document",
      `${source.discipline}=${source.path}`,
      "--uri-hint",
      `${source.discipline}=${source.uriHint}`,
    ]),
    "--output",
    packageDirectory,
    "--staged-preview",
    stagedDirectory,
    "--json-events",
    "--compact-json",
    "--threads",
    String(options.threads),
  ];
  const pageClockAtSpawn = await pageNow();
  const spawnedWall = new Date().toISOString();
  const spawnedAt = performance.now();
  compile = spawn(process.execPath, compileArguments, {
    cwd: repoRoot,
    env: { ...process.env, NARU_IFC_PYTHON: ifcPython },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const compileExit = new Promise((settle) => {
    compile.on("close", (code, signal) => settle({ code, signal, ms: round(performance.now() - spawnedAt) }));
  });
  compileFailure = compileExit.then((exit) =>
    exit.code === 0
      ? new Promise(() => {})
      : Promise.reject(new Error(`The compile exited with code ${exit.code} (signal ${exit.signal}) while the recorder waited. Last stderr: ${compileStderr.slice(-5).join(" | ")}`)),
  );
  note(`compile spawned (${sources.length} sources)`);
  let stdoutRest = "";
  compile.stdout.setEncoding("utf8");
  compile.stdout.on("data", (chunk) => {
    stdoutRest += chunk;
    const lines = stdoutRest.split("\n");
    stdoutRest = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      jobEvents.push({ ...event, recorderMs: round(performance.now() - spawnedAt) });
    }
  });
  compile.stderr.setEncoding("utf8");
  compile.stderr.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) compileStderr.push(line.trimEnd());
    }
    if (compileStderr.length > 400) compileStderr.splice(0, compileStderr.length - 400);
  });
  const compileRunning = () => compile.exitCode === null && compile.signalCode === null;
  const sinceSpawn = (pageMs) => round(pageMs - pageClockAtSpawn);

  /* ---- first tree: the gate-4 measurement, then use it while extraction continues ---- */

  await waitFor(() => document.documentElement.dataset.stagedFirstTreeAt !== undefined, 180_000);
  const firstTreeDataset = await rootDataset();
  const firstTree = {
    discipline: firstTreeDataset.stagedFirstTreeDiscipline,
    nodeCount: Number(firstTreeDataset.stagedNodes),
    stagedCount: Number(firstTreeDataset.stagedCount),
    totalCount: Number(firstTreeDataset.stagedTotal),
    ms: sinceSpawn(Number(firstTreeDataset.stagedFirstTreeAt)),
    status: await textOf("#status"),
    hierarchyTitle: await textOf("#hierarchy-title"),
    hierarchyResult: await textOf("#hierarchy-result"),
    compileRunning: compileRunning(),
  };
  assert(firstTree.compileRunning, "The compile had already exited when the first tree arrived.");
  note(`first tree ${firstTree.discipline} (${firstTree.nodeCount} nodes) at ${firstTree.ms} ms`);
  const screenshots = { stagedTree: await screenshot("staged-tree.png") };

  const searchDuringImport = async (label) => {
    await page.fill("#hierarchy-search", "");
    await page.fill("#hierarchy-search", options.search);
    await waitFor(
      (query) => {
        const matches = document.documentElement.dataset.hierarchyMatches;
        const text = document.querySelector("#hierarchy-search-result")?.textContent ?? "";
        return matches !== undefined && matches !== "" && /match/.test(text) && document.querySelector("#hierarchy-search")?.value === query;
      },
      30_000,
      options.search,
    );
    const dataset = await rootDataset();
    return {
      label,
      query: options.search,
      matches: Number(dataset.hierarchyMatches),
      resultText: await textOf("#hierarchy-search-result"),
      stagedCount: Number(dataset.stagedCount),
      totalCount: Number(dataset.stagedTotal),
      ms: sinceSpawn(await pageNow()),
      compileRunning: compileRunning(),
    };
  };

  const search = await searchDuringImport("first-tree");
  assert(search.matches > 0, `Searching "${options.search}" matched nothing in the first staged tree.`);
  screenshots.stagedSearch = await screenshot("staged-search.png");

  const firstRow = page.locator("#hierarchy li[data-node-index]").first();
  await firstRow.click();
  await waitFor(() => document.documentElement.dataset.stagedSelection !== undefined, 30_000);
  const selectionDataset = await rootDataset();
  const selection = {
    occurrenceId: selectionDataset.stagedSelection,
    rowLabel: await firstRow.getAttribute("aria-label"),
    selectionText: await textOf("#selection"),
    stagedCount: Number(selectionDataset.stagedCount),
    ms: sinceSpawn(await pageNow()),
    compileRunning: compileRunning(),
  };
  assert(/staged preview, geometry pending/.test(selection.selectionText ?? ""), "Selecting a staged row did not report a pending-geometry selection.");
  await page.fill("#hierarchy-search", "");

  /* ---- every remaining tree ---- */

  await waitFor(() => document.documentElement.dataset.stagedCompleteAt !== undefined, options.handoffTimeoutMs);
  const completeDataset = await rootDataset();
  note(`all ${completeDataset.stagedTotal} trees staged`);
  const searchAtComplete = await searchDuringImport("all-trees");
  await page.fill("#hierarchy-search", "");
  const arrivalTimeline = await page.evaluate(() => window.__naruStagedTimeline.slice());
  const arrivals = [];
  const seenDisciplines = new Set();
  for (const entry of arrivalTimeline) {
    if (entry.element !== "root" || entry.attribute !== "data-staged-documents" || !entry.value) continue;
    for (const discipline of entry.value.split(",")) {
      if (seenDisciplines.has(discipline)) continue;
      seenDisciplines.add(discipline);
      arrivals.push({ discipline, rank: arrivals.length, ms: sinceSpawn(entry.ms) });
    }
  }
  assert(arrivals.length === sources.length, `Expected ${sources.length} staged trees, saw ${arrivals.length}.`);

  /* ---- package handoff -> the unchanged load path ---- */

  await waitFor(() => document.documentElement.dataset.stagedState === "package", options.handoffTimeoutMs);
  const handoffDataset = await rootDataset();
  note("package handoff");
  await waitFor(() => document.documentElement.dataset.hierarchyReady === "true", 600_000);
  await waitFor(
    () => document.documentElement.dataset.coarseReady === "true" || document.documentElement.dataset.targetReady === "true",
    600_000,
  );
  screenshots.coarse = await screenshot("coarse.png");
  await waitFor(() => document.querySelector("#status")?.dataset.state === "ready", 900_000);
  note("ready");
  screenshots.ready = await screenshot("ready.png");

  const exit = await Promise.race([compileExit, sleep(600_000).then(() => null)]);
  assert(exit !== null, "The compile did not exit within 10 minutes of the Studio reaching ready.");
  assert(exit.code === 0, `The compile exited with code ${exit.code} (signal ${exit.signal}). Last stderr: ${compileStderr.slice(-5).join(" | ")}`);
  const finalEvent = jobEvents.at(-1);
  assert(finalEvent?.state === "completed", `The job stream ended in "${finalEvent?.state}", not "completed".`);
  assert(jobEvents.every((event, index) => event.sequence === index), "Job event sequence is not gapless.");
  const stagedEvents = jobEvents.filter((event) => event.staged);
  assert(stagedEvents.length === sources.length, `Expected ${sources.length} staged job events, saw ${stagedEvents.length}.`);

  const timeline = await page.evaluate(() => window.__naruStagedTimeline.slice());
  const firstTimelineMs = (element, attribute, value) => {
    const entry = timeline.find((item) => item.element === element && item.attribute === attribute && item.value === value);
    return entry ? sinceSpawn(entry.ms) : null;
  };
  const milestones = {
    firstTreeMs: firstTree.ms,
    lastTreeMs: arrivals.at(-1).ms,
    stagedCompleteMs: sinceSpawn(Number(completeDataset.stagedCompleteAt)),
    packageHandoffMs: sinceSpawn(Number(handoffDataset.stagedPackageAt)),
    hierarchyReadyMs: firstTimelineMs("root", "data-hierarchy-ready", "true"),
    coarseFrameMs: firstTimelineMs("root", "data-coarse-ready", "true") ?? firstTimelineMs("root", "data-target-ready", "true"),
    readyMs: firstTimelineMs("status", "data-state", "ready"),
    compileExitMs: exit.ms,
  };
  for (const [name, value] of Object.entries(milestones)) {
    assert(typeof value === "number" && Number.isFinite(value), `Milestone ${name} was not measured.`);
  }
  assert(milestones.packageHandoffMs >= milestones.stagedCompleteMs, "The package handoff preceded the last tree.");
  assert(milestones.readyMs >= milestones.packageHandoffMs, "ready stamped before the package handoff.");

  const stateAtReady = await page.evaluate(() => {
    const root = document.documentElement.dataset;
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
    return {
      sceneSource: root.sceneSource ?? null,
      stagedState: root.stagedState ?? null,
      stagedPackageDigest: root.stagedPackageDigest ?? null,
      hierarchyReady: root.hierarchyReady ?? null,
      coarseReady: root.coarseReady ?? null,
      targetReady: root.targetReady ?? null,
      targetChunksTotal: Number(root.targetChunksTotal ?? 0),
      targetChunksReady: Number(root.targetChunksReady ?? 0),
      targetSchedulerRequests: Number(root.targetSchedulerRequests ?? 0),
      targetSchedulerSkips: Number(root.targetSchedulerSkips ?? 0),
      residentDecodedBytes: Number(root.residentDecodedBytes ?? 0),
      residentGpuBytes: Number(root.residentGpuBytes ?? 0),
      residencyBudgetBytes: Number(root.residencyBudgetBytes ?? 0),
      residencyBudgetReached: root.residencyBudgetReached ?? null,
      visibleOccurrences: Number(root.visibleOccurrences ?? 0),
      status: text("#status"),
      sceneSourceKind: text("#scene-source-kind"),
      sceneSourceLabel: text("#scene-source-label"),
      prototypeCount: text("#prototype-count"),
      occurrenceCount: text("#occurrence-count"),
      triangleCount: text("#triangle-count"),
      edgeCount: text("#edge-count"),
      gpuAdapter: text("#gpu-adapter"),
    };
  });
  assert(stateAtReady.sceneSource !== "staged", "The Studio never left the staged source after the handoff.");

  /* ---- verify what the compile left on disk against what the Studio consumed ---- */

  const manifest = JSON.parse(readFileSync(join(stagedDirectory, "staged.json"), "utf8"));
  assert(manifest.schemaVersion === stagedManifestSchema, `staged.json schema is ${manifest.schemaVersion}.`);
  assert(manifest.jobId === finalEvent.jobId, "staged.json jobId differs from the job stream.");
  assert(manifest.complete === true && manifest.stagedCount === manifest.totalCount, "staged.json is not complete.");
  assert(manifest.documents.length === sources.length, `staged.json lists ${manifest.documents.length} documents.`);
  const manifestOrder = manifest.documents.map((entry) => entry.discipline);
  assert(
    JSON.stringify(manifestOrder) === JSON.stringify(expectedEmissionOrder),
    `staged.json emission order ${manifestOrder.join(",")} differs from ascending source size ${expectedEmissionOrder.join(",")}.`,
  );
  assert(JSON.stringify(arrivals.map((a) => a.discipline)) === JSON.stringify(manifestOrder), "The Studio saw trees in an order that differs from staged.json.");
  const sourcesByDiscipline = new Map(sources.map((source) => [source.discipline, source]));
  for (const entry of manifest.documents) {
    const source = sourcesByDiscipline.get(entry.discipline);
    assert(source !== undefined, `staged.json names an unknown discipline ${entry.discipline}.`);
    assert(entry.sourceDigest === source.sha256 && entry.sourceBytes === source.bytes, `staged.json ${entry.discipline} names a different source.`);
    assert(entry.nodeCount === emissionNodeCounts.get(entry.discipline), `${entry.discipline} nodeCount ${entry.nodeCount} differs from the emission record.`);
    for (const [uriKey, lengthKey, digestKey] of [["uri", "byteLength", "sha256"], ["columnsUri", "columnsByteLength", "columnsSha256"]]) {
      const file = join(stagedDirectory, entry.hierarchy[uriKey]);
      assert(statSync(file).size === entry.hierarchy[lengthKey], `${entry.hierarchy[uriKey]} length differs from staged.json.`);
      assert((await sha256File(file)) === entry.hierarchy[digestKey], `${entry.hierarchy[uriKey]} digest differs from staged.json.`);
    }
  }
  const stagedDocuments = manifest.documents.map((entry, rank) => ({
    rank,
    discipline: entry.discipline,
    uriHint: entry.uriHint,
    documentId: entry.documentId,
    schema: entry.schema,
    sourceDigest: entry.sourceDigest,
    sourceBytes: entry.sourceBytes,
    nodeCount: entry.nodeCount,
    rootCount: entry.rootCount,
    hierarchy: entry.hierarchy,
    arrivalMs: arrivals[rank].ms,
    adapterStagedElapsedMs: stagedEvents.find((event) => event.staged.discipline === entry.discipline)?.elapsedMs ?? null,
  }));

  const buildReport = JSON.parse(readFileSync(join(packageDirectory, "build-report.json"), "utf8"));
  assert(manifest.package, "staged.json carries no package handoff.");
  assert(manifest.package.documentUri === "scene.gltf", `Handoff document is ${manifest.package.documentUri}.`);
  assert(manifest.package.packageDigest === buildReport.output.packageDigest, "Handoff packageDigest differs from build-report.json.");
  assert(stateAtReady.stagedPackageDigest === manifest.package.packageDigest, "The Studio recorded a different handoff digest.");
  const reportResources = new Map(buildReport.output.resources.map((entry) => [entry.path, entry]));
  const packageResources = [];
  for (const resource of manifest.package.resources) {
    const reported = reportResources.get(resource.uri);
    assert(reported !== undefined, `Handoff resource ${resource.uri} is not in build-report.json.`);
    assert(reported.bytes === resource.byteLength && reported.sha256 === resource.sha256, `Handoff resource ${resource.uri} differs from build-report.json.`);
    const file = join(packageDirectory, resource.uri);
    assert(statSync(file).size === resource.byteLength && (await sha256File(file)) === resource.sha256, `${resource.uri} on disk differs from the handoff.`);
    packageResources.push({ uri: resource.uri, byteLength: resource.byteLength, sha256: resource.sha256, mediaType: reported.mediaType });
  }
  assert(packageResources.length === buildReport.output.resources.length, "The handoff lists fewer resources than build-report.json.");

  /* ---- network: what the page actually fetched from the origin ---- */

  const summarizePath = (path) => {
    const entries = pageResponses.filter((entry) => entry.path === path);
    const statuses = {};
    for (const entry of entries) statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
    return {
      path,
      responses: entries.length,
      statuses,
      rangeRequests: entries.filter((entry) => entry.range !== null).length,
      contentRangeResponses: entries.filter((entry) => entry.contentRange !== null).length,
      contentType: entries.find((entry) => entry.status < 300)?.contentType ?? null,
      accessControlAllowOrigin: entries.find((entry) => entry.status < 300)?.accessControlAllowOrigin ?? null,
    };
  };
  const declaredPaths = new Set([
    "/staged/staged.json",
    ...manifest.documents.flatMap((entry) => [`/staged/${entry.hierarchy.uri}`, `/staged/${entry.hierarchy.columnsUri}`]),
    ...packageResources.map((resource) => `/package/${resource.uri}`),
  ]);
  const undeclared = [...new Set(pageResponses.map((entry) => entry.path))].filter((path) => !declaredPaths.has(path));
  assert(undeclared.length === 0, `The page fetched undeclared origin paths: ${undeclared.join(", ")}`);
  const manifestPolls = { ...summarizePath("/staged/staged.json"), notFoundConsoleMessages: expectedNotFound.length };
  assert((manifestPolls.statuses["404"] ?? 0) > 0 && (manifestPolls.statuses["200"] ?? 0) > 0, "staged.json polling never crossed from 404 to 200.");
  assert(
    expectedNotFound.length === manifestPolls.statuses["404"],
    `Chrome logged ${expectedNotFound.length} manifest 404 errors but the page saw ${manifestPolls.statuses["404"]} 404 responses.`,
  );
  const hierarchyFetches = manifest.documents.flatMap((entry) => [
    summarizePath(`/staged/${entry.hierarchy.uri}`),
    summarizePath(`/staged/${entry.hierarchy.columnsUri}`),
  ]);
  for (const fetched of hierarchyFetches) {
    assert(fetched.responses === 1 && fetched.statuses["200"] === 1, `${fetched.path} was fetched ${fetched.responses} times.`);
  }
  // The Studio reads the document, the coarse buffer, and Range slices of scene.bin to reach
  // ready; the property sidecar (properties.json/.bin) is resolved lazily on a pick, and this
  // record never picks after the handoff, so those two resources are declared lazy and are
  // expected to stay unfetched -- a fetch of them here would mean the loader changed.
  const lazyResource = (uri) => /(^|\/)properties\.(json|bin)$/.test(uri);
  const packageFetches = packageResources.map((resource) => ({
    ...summarizePath(`/package/${resource.uri}`),
    loading: lazyResource(resource.uri) ? "lazy-on-pick" : "eager",
  }));
  for (const fetched of packageFetches) {
    if (fetched.loading === "eager") {
      assert(fetched.responses > 0, `${fetched.path} was never fetched after the handoff.`);
      assert(fetched.accessControlAllowOrigin === viteOrigin, `${fetched.path} lacked the CORS header the Studio origin needs.`);
    } else {
      assert(fetched.responses === 0, `${fetched.path} is lazy (resolved on a pick) yet was fetched ${fetched.responses} times without one.`);
    }
  }
  const serverSide = {
    requests: originRequests.length,
    manifestPollsBeforeSpawn: pollsBeforeSpawn,
    manifestPollsTotal: originRequests.filter((entry) => entry.path === "/staged/staged.json").length,
    rangeRequests: originRequests.filter((entry) => entry.range !== null).length,
    statuses: originRequests.reduce((acc, entry) => ({ ...acc, [entry.status]: (acc[entry.status] ?? 0) + 1 }), {}),
  };

  /* ---- the record ---- */

  const withinBand = firstTree.ms >= productTarget.lowerSeconds * 1_000 && firstTree.ms <= productTarget.upperSeconds * 1_000;
  // The band is a ceiling with an expectation attached: a tree earlier than 5 s meets
  // the target, it does not miss it. Both readings are recorded so neither is inferred.
  const meetsTarget = firstTree.ms <= productTarget.upperSeconds * 1_000;
  const record = {
    schemaVersion,
    mode,
    recordedAt: startedWall,
    model: "sixty5",
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? null,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtStart: freeMemoryAtStart,
    },
    commit: { head: gitOutput("rev-parse", "HEAD"), workingTreeClean: gitOutput("status", "--porcelain") === "" },
    browser: { id: options.browser, engine: engine.engine, version: browser.version(), headless: options.headless, viewport },
    fixture: {
      datasetId,
      manifest: { path: "fixtures/external/manifest.json", sha256: sha256Hex(manifestBytes) },
      documents: sources.map(({ discipline, uriHint, bytes, sha256 }) => ({ discipline, uriHint, bytes, sha256 })),
    },
    adapter: adapterIdentity,
    compiler: {
      cli: "packages/compiler/dist/cli.js",
      command: "compile-ifc",
      threads: options.threads,
      compactJson: true,
      cache: "none (cold, no --cache)",
      stagedPreview: true,
      spawnedAt: spawnedWall,
      exitCode: exit.code,
      elapsedMs: exit.ms,
    },
    servers: { studio: viteOrigin, origin: originBase, studioUrl: studioUrl.href, sceneUrl, stagedUrl },
    productTarget: { ...productTarget, firstTreeMs: firstTree.ms, withinBand, meetsTarget },
    protocol: {
      clock: "Every *Ms figure is the Studio page's performance.now() minus its value read immediately before the compile process was spawned; spawn latency, adapter parse, staged publish, the poll interval, transport, digest verification, and DOM construction are all inside it.",
      pollMs: 500,
      watchStartedBeforeSpawnMs: sinceSpawn(watchStartedAt),
      manifestPollsBeforeSpawn: pollsBeforeSpawn,
      hierarchyInteraction: "The Studio hierarchy list is a flat, depth-indented, virtualized list with no expand/collapse; gate 4's 'expand and search' is exercised as search plus row selection.",
      manifestNotFound: "Polling staged.json before the compile publishes it answers 404; Chrome logs each as a console error that no application code can suppress, so those messages (manifest URL only, before its first 200) are counted in network.manifestPolls.notFoundConsoleMessages, reconciled against the 404 responses, and excluded from consoleIssues.",
      coarsePreview: "No per-document coarse geometry exists during import; coarseFrameMs is the first coarse frame of the compiled package after the handoff, measured end to end from the same spawn instant.",
    },
    milestones,
    firstTree,
    documents: stagedDocuments,
    interactions: { searchDuringImport: search, selectionDuringImport: selection, searchAfterLastTree: searchAtComplete },
    jobEvents: jobEvents.map(({ schemaVersion: eventSchema, jobId, sequence, elapsedMs, state, progress, staged, recorderMs }) => ({
      schemaVersion: eventSchema, jobId, sequence, elapsedMs, state, progress, staged: staged ?? null, recorderMs,
    })),
    stagedManifest: {
      schemaVersion: manifest.schemaVersion,
      jobId: manifest.jobId,
      stagedCount: manifest.stagedCount,
      totalCount: manifest.totalCount,
      complete: manifest.complete,
      package: { documentUri: manifest.package.documentUri, packageDigest: manifest.package.packageDigest, resources: packageResources },
    },
    buildReport: { schemaVersion: buildReport.schemaVersion, packageDigest: buildReport.output.packageDigest, resourceCount: buildReport.output.resources.length },
    network: { manifestPolls, hierarchyFetches, packageFetches, serverSide },
    stateAtReady,
    screenshots,
    consoleIssues,
    timingNote:
      "Single host, single engine; the compile (about 5 GB peak) and the browser share this machine, so every milestone after the first tree is inflated by memory pressure when free memory is low. freeMemoryBytesAtStart says how low it was.",
    elapsedSeconds: round((performance.now() - startedAt) / 1_000),
  };
  assert(consoleIssues.length === 0, `Console issues: ${JSON.stringify(consoleIssues)}`);
  const recordPath = join(options.output, "sixty5.json");
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `[staged-import-browser] first tree ${firstTree.discipline} ${firstTree.nodeCount} nodes at ${firstTree.ms} ms ` +
      `(target <= ${productTarget.upperSeconds} s: ${meetsTarget ? "met" : "missed"}; band ${productTarget.lowerSeconds}-${productTarget.upperSeconds} s: ${withinBand ? "inside" : "outside"}), ` +
      `last tree ${milestones.lastTreeMs} ms, handoff ${milestones.packageHandoffMs} ms, coarse ${milestones.coarseFrameMs} ms, ready ${milestones.readyMs} ms, ` +
      `compile ${exit.ms} ms -> ${portable(recordPath)}`,
  );
} finally {
  killCompile();
  if (browser) await browser.close().catch(() => {});
  if (vite) await vite.close().catch(() => {});
  if (origin) await new Promise((done) => origin.close(done));
}
