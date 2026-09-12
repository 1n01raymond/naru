#!/usr/bin/env node
// Records the document-retention experiment predeclared in
// artifacts/memory/document-retention/README.md.
//
// The protocol is fixed before measurement and this recorder implements it
// literally: two arms built from the same compiled bytes, two run sets because
// forced collection distorts timing, six phases per memory run, and a declared
// discard rule. Nothing here recompiles a package, changes a delivery format,
// or moves a package digest.
//
// Timing inside the memory set is recorded so a reader can see the order of
// events and is declared perturbed: sampling
// performance.measureUserAgentSpecificMemory() forces a garbage collection and
// blocks for seconds at every phase. Only the timing set, which takes no
// samples of any kind, carries comparable milestones.
//
// Usage:
//   node scripts/record-document-retention-evidence.mjs
//   node scripts/record-document-retention-evidence.mjs --experiments pinned
//
// The baseline arm is served from a git worktree checked out at the branch
// base, so both arms differ only in the Studio source under test.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { chromium } from "playwright";
import { createServer } from "vite";

import {
  armIds,
  experimentPhases,
  ledgerDefinitionFailures,
  memoryRunFailures,
  recomputeOutcomes,
  setFailures,
  timingRunFailures,
} from "./lib/document-retention.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const headless = process.argv.includes("--headless");
const outputDirectory = resolve(
  repositoryRoot,
  argValue("--output", "artifacts/memory/document-retention"),
);
const outputFromRoot = relative(repositoryRoot, outputDirectory);
if (
  outputFromRoot === "" ||
  outputFromRoot === ".." ||
  outputFromRoot.startsWith(`..${sep}`) ||
  isAbsolute(outputFromRoot)
) {
  throw new TypeError("Document retention output must remain inside the repository.");
}
if (process.platform !== "win32") {
  throw new Error(
    "Process-tree sampling in this recorder is implemented for Windows only; " +
      "extend sampleProcessTree before recording on another host.",
  );
}

const baselineRoot = resolve(argValue("--baseline-root", "C:/temp/naru-baseline"));
const memoryPairs = Number(argValue("--memory-pairs", "3"));
const timingPairs = Number(argValue("--timing-pairs", "3"));
for (const [flag, value] of [
  ["--memory-pairs", memoryPairs],
  ["--timing-pairs", timingPairs],
]) {
  if (!Number.isInteger(value) || value < 3 || value > 8) {
    throw new TypeError(`${flag} must be a whole number between 3 and 8; the protocol asks for at least three.`);
  }
}

// The pinned endpoint, copied from the protocol. Both packages settle on it —
// the relocated build differs only in the node index it renumbers, which is why
// the picked occurrence is pinned by name and never by node.
const pinnedEndpoint = {
  chunksReady: 111,
  chunksTotal: 234,
  decodedBytes: 66_686_508,
  gpuBytes: 66_783_808,
  triangleCount: "2,255,235",
  occurrenceCount: "78173",
};

// Declared before measurement and not adjustable afterwards.
const successThreshold = {
  peakHeapReductionPercent: 10,
  coarseFrameTolerancePercent: 5,
};

const experimentDefinitions = {
  pinned: {
    id: "pinned",
    label: "sixty5, document-carried assembly tree",
    sceneDirectory: "output/ifc/sixty5-prb",
    expectedPackageDigest:
      "a2d6c72a6e936ac3ea2a183a1028cc4a06b20985c6d90b16058954323b7c3347",
    shape:
      "document-carried assembly tree, property sidecar present, no relocated hierarchy sidecar, no spatial demand index",
  },
  relocated: {
    id: "relocated",
    label: "sixty5, relocated hierarchy sidecar",
    sceneDirectory: "output/ifc/sixty5-relocated",
    expectedPackageDigest:
      "b821e4316a5b59d9119bb1731cb6223952cf18c10d872485462b8a3d078d13f9",
    shape:
      "relocated hierarchy sidecar present, property sidecar present, no spatial demand index",
    // The protocol admits this arm only because the candidate touches sidecar
    // handling. It is declared with its own digest and its own baseline and it
    // never replaces the pinned package.
    secondArmReason:
      "The candidate changes which thread reads the assembly tree, and a relocated package reads it from a sidecar instead of the document.",
  },
};

const requestedExperimentIds = String(argValue("--experiments", "pinned,relocated"))
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
for (const id of requestedExperimentIds) {
  if (!Object.hasOwn(experimentDefinitions, id)) {
    throw new TypeError(`--experiments accepts ${Object.keys(experimentDefinitions).join(", ")}.`);
  }
}
const requestedExperiments = requestedExperimentIds.map((id) => experimentDefinitions[id]);

// The replacement scene the disposed phase opens. It is a small, non-progressive
// package, so the Studio publishes no target residency once it is open; that is
// why the disposed phase records residency absent with a reason.
const replacementSceneDirectory = resolve(repositoryRoot, "artifacts/phase1/adafruit-pygamer");

const viewport = { width: 1320, height: 1000 };
const camera = { wheelDelta: -5000, panX: 400, panY: -300 };
const armPorts = { candidate: 4180, baseline: 4181 };

// Every quantity this experiment collects, with the owner that allocates it, how
// long that owner keeps it, and the consumer it exists for. A quantity an engine
// does not expose is declared unsupported here and recorded absent with its
// reason, never as zero.
const ledgerCategories = [
  {
    id: "retention.documentBytes",
    owner: "the thread that parsed the compiled glTF document",
    lifetime: "until the scene it describes is replaced or disposed",
    consumer: "chunk selection in the Worker, and the assembly tree on whichever thread builds it",
    method: "exact-declared",
    note: "Declared Content-Length of scene.gltf, published by the Studio retention ledger.",
  },
  {
    id: "retention.propertyIndexBytes",
    owner: "the main thread property sidecar reader",
    lifetime: "until the scene is replaced or disposed",
    consumer: "property resolution for the selected occurrence",
    method: "exact-declared",
  },
  {
    id: "retention.spatialIndexBytes",
    owner: "the main thread spatial demand source",
    lifetime: "until the scene is replaced or disposed",
    consumer: "view-localized chunk demand",
    method: "exact-declared",
    note: "Zero for both packages in this experiment; neither declares a spatial demand index.",
  },
  {
    id: "retention.relocatedHierarchyBytes",
    owner: "the main thread hierarchy sidecar reader",
    lifetime: "until the assembly tree is built, then the decoded columns are released",
    consumer: "the hierarchy list view",
    method: "exact-declared",
    note: "Zero for the pinned package, which carries its tree in the document.",
  },
  {
    id: "retention.coarseGeometryBytes",
    owner: "the geometry Worker",
    lifetime: "until the scene is replaced or disposed",
    consumer: "the first coarse frame and every unadmitted prototype",
    method: "exact-declared",
  },
  {
    id: "retention.declaredGeometryBytes",
    owner: "the delivery origin, not the page",
    lifetime: "not resident; the figure bounds what Range requests may draw from",
    consumer: "target chunk admission",
    method: "exact-declared",
    note: "Reported for scale. Only admitted chunks are resident, under the 64 MiB budget.",
  },
  {
    id: "page.usedJsHeapBytes",
    owner: "the main thread JavaScript heap",
    lifetime: "the session",
    consumer: "the primary threshold of this experiment",
    method: "browser-estimated",
    note: "performance.memory.usedJSHeapSize, main thread only; it does not see Worker heaps.",
  },
  {
    id: "page.totalJsHeapBytes",
    owner: "the main thread JavaScript heap",
    lifetime: "the session",
    consumer: "context for the used figure; a committed heap is not a live set",
    method: "browser-estimated",
  },
  {
    id: "page.uaMemoryBytes",
    owner: "the whole agent cluster, page and Workers together",
    lifetime: "the session",
    consumer: "the cross-thread total, which moving work between threads should not change",
    method: "browser-estimated",
    note: "performance.measureUserAgentSpecificMemory() forces a collection and blocks for seconds.",
  },
  {
    id: "process.workingSetBytes",
    owner: "the browser process tree",
    lifetime: "the browser session",
    consumer: "reported, not gating; it includes engine allocations this experiment does not govern",
    method: "os-sampled",
  },
  {
    id: "process.privateBytes",
    owner: "the browser process tree",
    lifetime: "the browser session",
    consumer: "reported, not gating",
    method: "os-sampled",
  },
  {
    id: "residency.decodedBytes",
    owner: "the runtime residency scheduler",
    lifetime: "until eviction",
    consumer: "the behaviour guard; it must hold the pinned endpoint in every accepted run",
    method: "exact-counted",
  },
  {
    id: "residency.gpuBytes",
    owner: "the renderer",
    lifetime: "until eviction",
    consumer: "the behaviour guard",
    method: "exact-counted",
  },
  {
    id: "gpu.driverAllocationBytes",
    owner: "the graphics driver",
    lifetime: "unknown to the page",
    consumer: "would bound the true device footprint",
    method: "unsupported",
    unavailableReason:
      "No engine measured here exposes driver-side allocation to a page; the figure is absent, not zero.",
  },
];
const ledgerFailures = ledgerDefinitionFailures(ledgerCategories);
if (ledgerFailures.length > 0) {
  throw new Error(`The retention ledger definition is invalid:\n${ledgerFailures.join("\n")}`);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function verifyPackage(experiment) {
  const sceneDirectory = resolve(repositoryRoot, experiment.sceneDirectory);
  const reportPath = resolve(sceneDirectory, "build-report.json");
  const buildReport = JSON.parse(await readFile(reportPath, "utf8"));
  const packageDigest = buildReport.output.packageDigest;
  if (packageDigest !== experiment.expectedPackageDigest) {
    throw new Error(
      `${experiment.id}: package digest ${packageDigest} is not the pinned ` +
        `${experiment.expectedPackageDigest}; the protocol pins the bytes under test.`,
    );
  }
  const resources = [];
  for (const resource of buildReport.output.resources) {
    const path = resolve(sceneDirectory, resource.path);
    const digest = await sha256File(path);
    if (digest !== resource.sha256) {
      throw new Error(
        `${resource.path} digest ${digest} does not match the build report ${resource.sha256}; ` +
          "recompile the package before recording.",
      );
    }
    resources.push({ path: resource.path, bytes: resource.bytes, sha256: resource.sha256 });
  }
  console.log(
    `[retention] ${experiment.id}: package ${packageDigest.slice(0, 12)} verified against ` +
      `${resources.length} resources`,
  );
  return { sceneDirectory, packageDigest, resources };
}

async function sampleProcessTree(rootPid) {
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
    "Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress";
  let parsed;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    parsed = JSON.parse(stdout);
  } catch (error) {
    return {
      rootPid,
      processCount: 0,
      workingSetBytes: null,
      privateBytes: null,
      unavailableReason: `The process tree could not be sampled: ${String(error)}`,
    };
  }
  const all = Array.isArray(parsed) ? parsed : [parsed];
  const childrenByParent = new Map();
  for (const entry of all) {
    const parent = Number(entry.ParentProcessId);
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(entry);
  }
  const byPid = new Map(all.map((entry) => [Number(entry.ProcessId), entry]));
  const root = byPid.get(rootPid);
  if (!root) {
    return {
      rootPid,
      processCount: 0,
      workingSetBytes: null,
      privateBytes: null,
      unavailableReason: "The launched browser process was no longer listed when sampled.",
    };
  }
  const queue = [root];
  const tree = [];
  while (queue.length > 0) {
    const entry = queue.pop();
    tree.push(entry);
    for (const child of childrenByParent.get(Number(entry.ProcessId)) ?? []) queue.push(child);
  }
  return {
    rootPid,
    processCount: tree.length,
    browserProcessesOnHost: all.length,
    workingSetBytes: tree.reduce((total, entry) => total + Number(entry.WorkingSetSize), 0),
    privateBytes: tree.reduce((total, entry) => total + Number(entry.PrivatePageCount), 0),
  };
}

const heapUnavailableReason =
  "performance.memory is absent; relaunch with --enable-precise-memory-info.";

async function samplePage(page, { skipAgentCluster = false, agentClusterReason = null } = {}) {
  return page.evaluate(
    async ([heapReason, skipCluster, clusterReason]) => {
      const dataset = document.documentElement.dataset;
      const number = (value) => (value === undefined ? null : Number(value));
      const status = document.querySelector("#status");
      const result = {
        statusText: status?.textContent ?? null,
        statusState: status?.getAttribute("data-state") ?? null,
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        retention: {
          documentBytes: number(dataset.packageDocumentBytes),
          propertyIndexBytes: number(dataset.packagePropertyIndexBytes),
          spatialIndexBytes: number(dataset.packageSpatialIndexBytes),
          relocatedHierarchyBytes: number(dataset.packageRelocatedHierarchyBytes),
          coarseGeometryBytes: number(dataset.packageCoarseGeometryBytes),
          declaredGeometryBytes: number(dataset.packageDeclaredGeometryBytes),
        },
        renderer: {
          gpuVertexPoolBytes: number(dataset.rendererGpuVertexPoolBytes),
          gpuBatchBufferBytes: number(dataset.rendererGpuBatchBufferBytes),
          gpuUniformBytes: number(dataset.rendererGpuUniformBytes),
          gpuBufferBytes: number(dataset.rendererGpuBufferBytes),
          gpuAttachmentBytes: number(dataset.rendererGpuAttachmentBytes),
          cpuStagingBytes: number(dataset.rendererCpuStagingBytes),
        },
        residency: {
          budgetBytes: number(dataset.residencyBudgetBytes),
          decodedBytes: number(dataset.residentDecodedBytes),
          gpuBytes: number(dataset.residentGpuBytes),
          budgetReached: dataset.residencyBudgetReached ?? null,
          chunksReady: number(dataset.targetChunksReady),
          chunksTotal: number(dataset.targetChunksTotal),
        },
        page: {
          usedJsHeapBytes: null,
          totalJsHeapBytes: null,
          jsHeapLimitBytes: null,
          uaMemoryBytes: null,
          uaMemoryEntryCount: null,
          uaMemorySampleMilliseconds: null,
        },
      };
      const memory = performance.memory;
      if (memory) {
        result.page.usedJsHeapBytes = memory.usedJSHeapSize;
        result.page.totalJsHeapBytes = memory.totalJSHeapSize;
        result.page.jsHeapLimitBytes = memory.jsHeapSizeLimit;
      } else {
        result.page.usedJsHeapUnavailableReason = heapReason;
      }
      if (skipCluster) {
        result.page.uaMemoryUnavailableReason = clusterReason;
        return result;
      }
      if (typeof performance.measureUserAgentSpecificMemory !== "function") {
        result.page.uaMemoryUnavailableReason =
          "performance.measureUserAgentSpecificMemory is not exposed in this browser.";
        return result;
      }
      try {
        const startedAt = performance.now();
        const measured = await performance.measureUserAgentSpecificMemory();
        result.page.uaMemorySampleMilliseconds = Math.round(performance.now() - startedAt);
        result.page.uaMemoryBytes = measured.bytes;
        result.page.uaMemoryEntryCount = measured.breakdown.length;
      } catch (error) {
        result.page.uaMemoryUnavailableReason = String(error);
      }
      return result;
    },
    [heapUnavailableReason, skipAgentCluster, agentClusterReason],
  );
}

// Both arms run the same dev-server setup and differ only in the Studio source
// they serve, which is what keeps them comparable. The committed Vite config
// cannot be reused directly: it derives the repository root from its own
// location, it reads one NARU_SCENE_DIR that two concurrent servers would fight
// over, and it has no route for the replacement package the disposed phase
// opens. So the config is inlined, identically for both arms, and carries the
// same cross-origin headers the committed config sets — the page must be
// cross-origin isolated for the agent-cluster estimator to be callable at all.
function replacementPackagePlugin() {
  return {
    name: "naru-document-retention-replacement-package",
    configureServer(server) {
      server.middlewares.use("/pygamer", async (request, response, next) => {
        const requested = new URL(request.url ?? "/", "http://127.0.0.1/").pathname;
        const name = requested.replace(/^\/+/, "");
        if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
          next();
          return;
        }
        let bytes;
        try {
          bytes = await readFile(resolve(replacementSceneDirectory, name));
        } catch {
          next();
          return;
        }
        const type = name.endsWith(".gltf")
          ? "model/gltf+json"
          : name.endsWith(".json")
            ? "application/json"
            : "application/octet-stream";
        response.setHeader("Content-Type", type);
        response.setHeader("Accept-Ranges", "bytes");
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        if (range) {
          const start = Number(range[1]);
          const end = range[2] === "" ? bytes.byteLength - 1 : Number(range[2]);
          const slice = bytes.subarray(start, end + 1);
          response.statusCode = 206;
          response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.byteLength}`);
          response.setHeader("Content-Length", String(slice.byteLength));
          response.end(slice);
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Length", String(bytes.byteLength));
        response.end(bytes);
      });
    },
  };
}

async function startArmServer(arm, armRoot, sceneDirectory) {
  const server = await createServer({
    configFile: false,
    logLevel: "error",
    root: resolve(armRoot, "apps/webgpu-spike"),
    publicDir: sceneDirectory,
    plugins: [replacementPackagePlugin()],
    server: {
      host: "127.0.0.1",
      port: armPorts[arm],
      strictPort: true,
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
      },
    },
  });
  await server.listen();
  return server;
}

async function armHead(armRoot) {
  const { stdout } = await execFileAsync("git", ["-C", armRoot, "rev-parse", "HEAD"]);
  return stdout.trim();
}

const armRoots = { candidate: repositoryRoot, baseline: baselineRoot };

async function readEndpoint(page) {
  return page.evaluate(() => {
    const dataset = document.documentElement.dataset;
    const number = (value) => (value === undefined ? null : Number(value));
    const status = document.querySelector("#status")?.textContent ?? "";
    const triangles = /([\d,]+) triangles/.exec(status);
    const occurrences = /(\d+) renderable occurrences/.exec(status);
    return {
      chunksReady: number(dataset.targetChunksReady),
      chunksTotal: number(dataset.targetChunksTotal),
      decodedBytes: number(dataset.residentDecodedBytes),
      gpuBytes: number(dataset.residentGpuBytes),
      triangleCount: triangles?.[1] ?? null,
      occurrenceCount: occurrences?.[1] ?? null,
    };
  });
}

// Watches the counters the scheduler publishes and reports whether they stopped
// moving, returning its verdict instead of throwing so the caller decides
// whether a still-churning phase is fatal. Copied from the memory envelope
// recorder deliberately: both records must mean the same thing by "settled".
const settleKeys = ["status", "requests", "skips", "chunksReady", "residentGpuBytes"];

async function settle(page, quietChecks, intervalMs, timeoutMs) {
  const startedWaitingAt = Date.now();
  const deadline = startedWaitingAt + timeoutMs;
  let priorState = null;
  let observation = null;
  let firstObservation = null;
  let quiet = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(intervalMs);
    observation = await page.evaluate(() => {
      const root = document.documentElement.dataset;
      return [
        document.querySelector("#status")?.getAttribute("data-state") ?? "",
        root.targetSchedulerRequests ?? "",
        root.targetSchedulerSkips ?? "",
        root.targetChunksReady ?? "",
        root.residentGpuBytes ?? "",
      ];
    });
    firstObservation ??= observation;
    const state = observation.join("|");
    quiet = priorState === state ? quiet + 1 : 0;
    priorState = state;
    if (quiet >= quietChecks && observation[0] === "ready") {
      return { settled: true, waitedMilliseconds: Date.now() - startedWaitingAt, state };
    }
  }
  const moving = (firstObservation ?? [])
    .map((value, at) => (value === observation?.[at] ? null : settleKeys[at]))
    .filter((key) => key !== null);
  const seconds = Math.round(timeoutMs / 1000);
  const reason = observation?.[0] === "ready"
    ? `The status reached ready, but ${moving.join(", ") || "the counters"} still changed during the ${seconds} s wait.`
    : `The status stayed ${JSON.stringify(observation?.[0] ?? "")} for the whole ${seconds} s wait, with ${moving.join(", ") || "no counter"} still changing.`;
  return {
    settled: false,
    waitedMilliseconds: Date.now() - startedWaitingAt,
    state: (observation ?? []).join("|"),
    firstState: (firstObservation ?? []).join("|"),
    movingCounters: moving,
    reason,
  };
}

// A milestone that is not reached inside its timeout is one of the protocol's
// three declared discard reasons, so every wait raises the same error class and
// the run loop can tell a discard from a fault in the recorder.
class MilestoneTimeout extends Error {
  constructor(detail) {
    super(detail);
    this.name = "MilestoneTimeout";
  }
}

async function awaitMilestone(page, description, predicate, argument, timeoutMs) {
  try {
    await page.waitForFunction(predicate, argument, { timeout: timeoutMs });
  } catch (error) {
    throw new MilestoneTimeout(`${description} was not reached within ${Math.round(timeoutMs / 1000)} s (${String(error)})`);
  }
}

async function settleOrDiscard(page, phase, quietChecks, intervalMs, timeoutMs) {
  const quiescence = await settle(page, quietChecks, intervalMs, timeoutMs);
  if (!quiescence.settled) {
    throw new MilestoneTimeout(`the resident set never settled before ${phase}: ${quiescence.reason}`);
  }
  return quiescence;
}

// Residency is published only on the progressive path. When the open package
// declares no target chunks the sample says why the figure is missing; it never
// substitutes the renderer's buffer totals or the recorder's budget constant.
function normalizeResidency(residency, absentReason) {
  const read = ["budgetBytes", "decodedBytes", "gpuBytes"].filter((key) =>
    Number.isInteger(residency?.[key]) && residency[key] >= 0,
  );
  if (read.length === 3) return residency;
  if (read.length === 0) return { unavailableReason: absentReason };
  throw new Error(`The page published a partial residency dataset: ${JSON.stringify(residency)}.`);
}

const launchArguments = ["--enable-precise-memory-info"];

// A fresh browser process per run, as the protocol requires. The server handle
// is kept because the process-tree sample is rooted at the launched browser and
// a connected browser does not expose that pid.
async function withBrowser(run) {
  const server = await chromium.launchServer({ channel: "chrome", headless, args: launchArguments });
  const browser = await chromium.connect(server.wsEndpoint());
  try {
    return await run({ browser, rootPid: server.process().pid, version: browser.version() });
  } finally {
    await browser.close();
    await server.close();
  }
}

// One drive sequence serves both sets so the two arms cannot drift apart in
// anything but sampling. In the timing set `sample` is a no-op, which is how the
// protocol's "no memory sampling of any kind" is enforced rather than promised:
// the recorded run then carries no samples at all and the validator rejects it
// if it does.
async function driveRun({
  mode,
  arm,
  experiment,
  runIndex,
  browser,
  rootPid,
  port,
  captureDirectory,
}) {
  const label = `${experiment.id}/${mode}/${arm}#${runIndex}`;
  const consoleIssues = [];
  const screenshots = {};
  const samples = [];
  const milestones = {};
  const startedAt = Date.now();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      consoleIssues.push({ level: message.type(), message: message.text() });
    }
  });
  page.on("pageerror", (error) => consoleIssues.push({ level: "pageerror", message: error.message }));

  const screenshot = async (name) => {
    // Only the first memory pair captures. Every run of one arm writes into the
    // same directory, so a later run would leave the record pinning digests of
    // bytes that are no longer on disk.
    if (mode !== "memory" || runIndex !== 0) return;
    const bytes = await page.screenshot({ type: "png", timeout: 120_000 });
    await writeFile(resolve(captureDirectory, name), bytes);
    screenshots[name] = {
      path: `${experiment.id}/${arm}/${name}`,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };

  const buildSample = (phase, atMilliseconds, pageSample, processSample, residencyAbsentReason) => {
    const residency = normalizeResidency(pageSample.residency, residencyAbsentReason);
    if (residency.unavailableReason !== undefined && !residency.unavailableReason) {
      throw new Error(`${label} ${phase}: residency is absent and no reason was declared for it.`);
    }
    return { phase, atMilliseconds, ...pageSample, residency, process: processSample };
  };

  const sample = async (phase, { residencyAbsentReason = null, ...options } = {}) => {
    if (mode !== "memory") return null;
    const atMilliseconds = Date.now() - startedAt;
    const pageSample = await samplePage(page, options);
    const processSample = await sampleProcessTree(rootPid);
    const built = buildSample(phase, atMilliseconds, pageSample, processSample, residencyAbsentReason);
    samples.push(built);
    console.log(
      `[retention] ${label} ${phase} +${(atMilliseconds / 1000).toFixed(1)}s ` +
        `heap ${built.page.usedJsHeapBytes} ua ${built.page.uaMemoryBytes} ` +
        `ws ${built.process.workingSetBytes}`,
    );
    return built;
  };

  const viewerUrl = new URL(`http://127.0.0.1:${port}/`);
  viewerUrl.searchParams.set("scene", new URL("scene.gltf", viewerUrl).href);
  await page.goto(viewerUrl.href, { waitUntil: "domcontentloaded" });

  await awaitMilestone(
    page,
    "the assembly tree",
    () => document.documentElement.dataset.hierarchyReady === "true",
    undefined,
    600_000,
  );
  milestones.hierarchyReadyMs = Date.now() - startedAt;
  await sample("hierarchy");

  await awaitMilestone(
    page,
    "the first coarse frame",
    () =>
      document.documentElement.dataset.coarseReady === "true" ||
      document.querySelector("#status")?.getAttribute("data-state") === "error",
    undefined,
    1_200_000,
  );
  milestones.coarseFrameMs = Date.now() - startedAt;
  // Captured before the memory sample: the agent-cluster estimator forces a
  // collection that blocks for seconds, and a capture queued behind it would
  // file a later frame under the coarse phase.
  await screenshot("coarse-frame.png");
  await sample("coarse-frame");

  await settleOrDiscard(page, "budget-limited", 3, 1_000, 1_800_000);
  milestones.readyMs = Date.now() - startedAt;
  await sample("budget-limited");
  await screenshot("budget-limited.png");

  // Read before the camera moves, so the run's endpoint is the settled default
  // view the protocol pins rather than whatever the navigated view admits.
  const endpoint = await readEndpoint(page);

  const canvas = page.locator("#viewport");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error(`${label} found no visible viewport canvas.`);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, camera.wheelDelta);
  await page.waitForTimeout(500);
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(centerX + camera.panX / 2, centerY + camera.panY / 2, { steps: 8 });
  await page.mouse.move(centerX + camera.panX, centerY + camera.panY, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await settleOrDiscard(page, "the navigated view", 3, 1_000, 1_800_000);

  const readSelection = () =>
    page.evaluate(() => ({
      selectedObjectId: document.documentElement.dataset.selectedObjectId ?? "0",
      selectionResidency: document.documentElement.dataset.selectionResidency ?? null,
    }));
  const clickAndAwaitSelection = async (x, y) => {
    const before = await readSelection();
    await canvas.click({ position: { x, y } });
    try {
      await page.waitForFunction(
        (previous) => (document.documentElement.dataset.selectedObjectId ?? "0") !== previous,
        before.selectedObjectId,
        { timeout: 5_000 },
      );
    } catch {
      return null;
    }
    const after = await readSelection();
    if (after.selectedObjectId === "0") return null;
    try {
      await page.waitForFunction(
        () => document.documentElement.dataset.selectionResidency !== "loading",
        undefined,
        { timeout: 120_000 },
      );
    } catch {
      return null;
    }
    return readSelection();
  };
  let selection = null;
  for (const offset of [0, -0.12, 0.12]) {
    selection = await clickAndAwaitSelection(
      bounds.width / 2 + bounds.width * offset,
      bounds.height / 2 + bounds.height * offset,
    );
    if (selection) break;
  }
  if (!selection) {
    throw new MilestoneTimeout(`${label} could not select an occurrence near the view centre.`);
  }
  await awaitMilestone(
    page,
    "the selected object's properties",
    () => {
      const entries = document.querySelector("#semantic-property-entries");
      if (entries instanceof HTMLElement && !entries.hidden) return true;
      const state = document.querySelector("#semantic-property-status")?.getAttribute("data-state");
      return state === "absent" || state === "error";
    },
    undefined,
    300_000,
  );
  // The behaviour guard: the assembly tree, source-aware picking, property
  // resolution and selected-object detail must survive in both arms. The picked
  // occurrence is read by name; the glTF node index is never compared, because
  // the relocated package renumbers it.
  const behaviour = await page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const entries = document.querySelector("#semantic-property-entries");
    const resolved = entries instanceof HTMLElement && !entries.hidden;
    const hierarchyResult = text("#hierarchy-result");
    const count = /^(\d+)/.exec(hierarchyResult);
    return {
      hierarchyEntryCount: count ? Number(count[1]) : null,
      hierarchyResult,
      pickedOccurrenceName: text("#property-occurrence"),
      pickedPropertyEntryCount: resolved ? entries.children.length : 0,
      pickedPropertyState:
        document.querySelector("#semantic-property-status")?.getAttribute("data-state") ?? null,
      selectionDetail: text("#property-name"),
      selectedObjectId: text("#property-object-id"),
      sourceRef: text("#property-source-ref"),
    };
  });
  await screenshot("selection.png");

  if (mode === "memory") {
    // The overlap window is the peak observed while the same package is loaded
    // again over the open scene. The agent-cluster estimator is skipped here and
    // only here: it forces a collection that blocks for seconds, longer than the
    // window it would be describing, so sampling it would end that window.
    const overlapReason =
      "The agent-cluster estimator forces a collection that blocks for seconds, " +
      "longer than the replacement overlap window it would be measuring.";
    const overlapStartedAt = Date.now();
    await page.fill("#scene-url", viewerUrl.searchParams.get("scene") ?? "");
    await page.click("#open-scene-url");
    let overlapPeak = null;
    let overlapPolls = 0;
    const overlapDeadline = overlapStartedAt + 1_800_000;
    while (Date.now() < overlapDeadline) {
      const stillOpen = await page.evaluate(
        () => document.documentElement.dataset.coarseReady === "true",
      );
      if (!stillOpen) break;
      const atMilliseconds = Date.now() - startedAt;
      const pageSample = await samplePage(page, {
        skipAgentCluster: true,
        agentClusterReason: overlapReason,
      });
      const processSample = await sampleProcessTree(rootPid);
      const candidateSample = buildSample(
        "replace-overlap",
        atMilliseconds,
        pageSample,
        processSample,
        null,
      );
      overlapPolls += 1;
      const heap = candidateSample.page.usedJsHeapBytes;
      const best = overlapPeak?.page.usedJsHeapBytes;
      if (overlapPeak === null || (Number.isInteger(heap) && (!Number.isInteger(best) || heap > best))) {
        overlapPeak = candidateSample;
      }
      await page.waitForTimeout(500);
    }
    if (overlapPeak === null) {
      throw new MilestoneTimeout(
        `${label} observed no replacement overlap: the open scene was gone before the first poll.`,
      );
    }
    // The recorded overlap sample is one real observation, the highest-heap poll
    // of the window, never an average of the polls.
    overlapPeak.overlap = {
      pollCount: overlapPolls,
      windowMilliseconds: Date.now() - overlapStartedAt,
      selectedBy: "highest main-thread used JS heap",
    };
    samples.push(overlapPeak);
    console.log(
      `[retention] ${label} replace-overlap peak heap ${overlapPeak.page.usedJsHeapBytes} ` +
        `over ${overlapPolls} polls in ${overlapPeak.overlap.windowMilliseconds} ms`,
    );

    await awaitMilestone(
      page,
      "the replacement's coarse frame",
      () => document.documentElement.dataset.coarseReady === "true",
      undefined,
      1_200_000,
    );
    await settleOrDiscard(page, "replace-settled", 3, 1_000, 1_800_000);
    await sample("replace-settled");
    await screenshot("replace-settled.png");

    // Disposal is reached by opening a different, non-progressive package: the
    // Studio has no close command, and adding one would be product code the
    // protocol forbids mid-experiment. The replacement declares no target
    // chunks, so residency is genuinely unpublishable in this phase.
    await page.click("#open-pygamer-scene");
    await awaitMilestone(
      page,
      "the open scene's teardown",
      () => document.documentElement.dataset.hierarchyReady !== "true",
      undefined,
      600_000,
    );
    await awaitMilestone(
      page,
      "the replacement package's assembly tree",
      () => document.documentElement.dataset.hierarchyReady === "true",
      undefined,
      600_000,
    );
    await sample("disposed", {
      residencyAbsentReason:
        "The open package declares no target chunks, so the Studio publishes no " +
        "target residency; the renderer's buffer totals are not substituted for it.",
    });
    await screenshot("disposed.png");
  }

  await context.close();

  const readableHeaps = samples
    .map((entry) => entry.page.usedJsHeapBytes)
    .filter((value) => Number.isInteger(value) && value >= 0);
  const run = {
    arm,
    runIndex,
    milestones,
    endpoint,
    behaviour,
    consoleIssues,
    samples,
  };
  if (mode === "memory") {
    run.peakUsedJsHeapBytes = readableHeaps.length === 0 ? null : Math.max(...readableHeaps);
    run.screenshots = screenshots;
    // Declared perturbed: an agent-cluster sample blocks for seconds, so these
    // milestones describe a sampled session. Timing results come from the timing
    // set, which takes no samples at all.
    run.milestonesArePerturbedBySampling = true;
  }
  return run;
}

// The discard rules, applied to a completed run. Anything not named here is a
// recorder fault, not a protocol discard: the protocol discards a run only for a
// declared, observable fault, and never for being slow, fast, large, or small.
function discardReasonFor(run, mode) {
  if ((run.consoleIssues ?? []).length !== 0) {
    return {
      reason: "console-issue",
      detail: run.consoleIssues.map((issue) => `${issue.level}: ${issue.message}`).join(" | "),
    };
  }
  for (const [key, expected] of Object.entries(pinnedEndpoint)) {
    const observed = run.endpoint?.[key];
    if (observed !== expected) {
      return {
        reason: "endpoint-mismatch",
        detail: `${key} ${JSON.stringify(observed)} is not the pinned ${JSON.stringify(expected)}`,
      };
    }
  }
  const failures = mode === "memory"
    ? memoryRunFailures("run", run)
    : timingRunFailures("run", run);
  if (failures.length !== 0) {
    // A contract violation is not a discard reason. Failing loudly here keeps a
    // malformed run out of the record instead of letting the validator find it.
    throw new Error(`the recorder produced a run the record shape rejects:\n  ${failures.join("\n  ")}`);
  }
  return null;
}

// One set: interleaved pairs, baseline first, each run in a fresh browser
// process and a fresh context. A discarded run is retried once in the same pair
// slot, so the accepted runs stay alternating; a second discard in one arm voids
// the set rather than being topped up.
async function recordSet({ mode, experiment, pairs, captureRoot }) {
  const attempts = [];
  const runsByArm = Object.fromEntries(armIds.map((arm) => [arm, []]));
  const discardsByArm = Object.fromEntries(armIds.map((arm) => [arm, 0]));

  for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
    for (const arm of armIds) {
      let accepted = false;
      while (!accepted) {
        const attemptIndex = attempts.length + 1;
        const label = `${experiment.id}/${mode}/${arm} pair ${pairIndex + 1} attempt ${attemptIndex}`;
        console.log(`[retention] ${label} starting`);
        let run;
        let thrown = null;
        try {
          run = await withBrowser(({ browser, rootPid, version }) => {
            browserVersions.add(version);
            return driveRun({
              mode,
              arm,
              experiment,
              runIndex: pairIndex,
              browser,
              rootPid,
              port: armPorts[arm],
              captureDirectory: resolve(captureRoot, arm),
            });
          });
        } catch (error) {
          if (!(error instanceof MilestoneTimeout)) throw error;
          thrown = error;
        }
        const discard = thrown
          ? { reason: "milestone-timeout", detail: thrown.message }
          : discardReasonFor(run, mode);
        attempts.push({
          index: attemptIndex,
          pairIndex,
          arm,
          accepted: discard === null,
          discardReason: discard === null ? null : discard.reason,
          detail: discard === null ? null : discard.detail,
        });
        if (discard === null) {
          runsByArm[arm].push(run);
          accepted = true;
          console.log(`[retention] ${label} accepted`);
          continue;
        }
        discardsByArm[arm] += 1;
        console.log(`[retention] ${label} discarded (${discard.reason}): ${discard.detail}`);
        if (discardsByArm[arm] > 1) {
          throw new Error(
            `${experiment.id}/${mode}: ${arm} discarded ${discardsByArm[arm]} runs. ` +
              "The protocol voids the whole set past one discard; restart it rather than topping it up.",
          );
        }
      }
    }
  }

  const set = {
    mode,
    pairs,
    discardedRuns: attempts.filter((attempt) => attempt.accepted === false).length,
    attempts,
    arms: Object.fromEntries(armIds.map((arm) => [arm, { runs: runsByArm[arm] }])),
  };
  const failures = setFailures(`${experiment.id}/${mode}`, set, { minimumPairs: pairs });
  if (failures.length !== 0) {
    throw new Error(`the ${mode} set does not satisfy the protocol:\n  ${failures.join("\n  ")}`);
  }
  return set;
}

// Every browser this recording actually launched. The record names the engine it
// measured rather than the engine the host happens to have installed.
const browserVersions = new Set();

async function recordExperiment(experiment) {
  const captureRoot = resolve(outputDirectory, experiment.id);
  for (const arm of armIds) {
    await mkdir(resolve(captureRoot, arm), { recursive: true });
  }

  const pkg = await verifyPackage(experiment);
  const heads = {};
  for (const arm of armIds) {
    heads[arm] = await armHead(armRoots[arm]);
  }
  if (heads.baseline === heads.candidate) {
    throw new Error(
      `both arms resolve to ${heads.candidate}; the baseline worktree is not checked out at the base commit.`,
    );
  }

  const servers = {};
  try {
    for (const arm of armIds) {
      servers[arm] = await startArmServer(arm, armRoots[arm], pkg.sceneDirectory);
      console.log(`[retention] ${experiment.id}/${arm} served from ${armRoots[arm]} on ${armPorts[arm]}`);
    }

    // The memory set first, then the timing set: the protocol keeps them apart so
    // no number from one is reported as a result of the other.
    const memorySet = await recordSet({ mode: "memory", experiment, pairs: memoryPairs, captureRoot });
    const timingSet = await recordSet({ mode: "timing", experiment, pairs: timingPairs, captureRoot });

    const recorded = {
      id: experiment.id,
      label: experiment.label,
      shape: experiment.shape,
      ...(experiment.secondArmReason ? { secondArmReason: experiment.secondArmReason } : {}),
      package: {
        digest: pkg.packageDigest,
        sceneDirectory: relative(repositoryRoot, pkg.sceneDirectory).split(sep).join("/"),
        resources: pkg.resources,
      },
      arms: Object.fromEntries(
        armIds.map((arm) => [arm, {
          commit: heads[arm],
          root: arm === "candidate" ? "." : relative(repositoryRoot, armRoots[arm]) || armRoots[arm],
          port: armPorts[arm],
        }]),
      ),
      memorySet,
      timingSet,
    };
    recorded.outcomes = recomputeOutcomes(recorded, { ...successThreshold, endpoint: pinnedEndpoint });
    return recorded;
  } finally {
    for (const arm of Object.keys(servers)) {
      await servers[arm].close();
    }
  }
}

// Part files, written the moment an experiment completes. A recording of both
// arms of both experiments takes well over half an hour, and a fault in the
// second experiment must not discard the first one's runs.
function partPath(experimentId) {
  return resolve(outputDirectory, `document-retention.${experimentId}.part.json`);
}

async function readPart(experimentId) {
  try {
    return JSON.parse(await readFile(partPath(experimentId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const startedAt = Date.now();
  const experiments = [];
  for (const experiment of requestedExperiments) {
    const recorded = await recordExperiment(experiment);
    await writeFile(partPath(experiment.id), `${JSON.stringify(recorded, null, 2)}\n`, "utf8");
    experiments.push(recorded);
    const outcome = recorded.outcomes;
    console.log(
      `[retention] ${experiment.id}: peak heap ${outcome.primary.baselineBytes} -> ` +
        `${outcome.primary.candidateBytes} (${outcome.primary.percentChange}%), ` +
        `coarse frame ${outcome.timingGuard.baselineMilliseconds} -> ` +
        `${outcome.timingGuard.candidateMilliseconds} ms (${outcome.timingGuard.percentChange}%), ` +
        `landed ${outcome.landed}`,
    );
  }

  // An experiment recorded in an earlier invocation is carried forward from its
  // part file rather than being silently dropped from the record.
  for (const definition of Object.values(experimentDefinitions)) {
    if (experiments.some((entry) => entry.id === definition.id)) continue;
    const carried = await readPart(definition.id);
    if (carried) {
      console.log(`[retention] ${definition.id}: carried forward from its part file`);
      experiments.push(carried);
    }
  }
  experiments.sort(
    (left, right) =>
      Object.keys(experimentDefinitions).indexOf(left.id) -
      Object.keys(experimentDefinitions).indexOf(right.id),
  );

  const record = {
    schema: "naru.document-retention-evidence.1",
    recordedAt: new Date().toISOString(),
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    mode: "fresh-process-paired-retention-experiment",
    candidate: {
      id: "single-document-parse",
      summary:
        "The remote document is parsed once, in the geometry Worker, and the main " +
        "thread reads the assembly tree and the property index from what the Worker " +
        "returns instead of parsing the same bytes again.",
      protocol: `${outputFromRoot.split(sep).join("/")}/README.md`,
    },
    host: {
      platform: process.platform,
      architecture: process.arch,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      nodeVersion: process.version,
      browsers: [...browserVersions].sort(),
      headless,
    },
    protocol: {
      note:
        "Nothing here is a memory cap. The runtime's 64 MiB decoded and GPU budgets " +
        "bound admitted target geometry and nothing else; every figure below is " +
        "outside that bound and none of it may be restated as a total-memory limit.",
      pinnedEndpoint,
      successThreshold,
      phases: experimentPhases,
      memoryPairs,
      timingPairs,
      viewport,
      camera,
      ledger: ledgerCategories,
    },
    experiments,
  };

  const recordPath = resolve(outputDirectory, "document-retention.json");
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`[retention] wrote ${relative(repositoryRoot, recordPath).split(sep).join("/")}`);

  // The part files exist so a fault in the second experiment cannot discard the
  // first one's runs. Once the whole record carries every experiment they are
  // redundant, and they are not evidence, so they do not stay beside it.
  if (experiments.length === Object.keys(experimentDefinitions).length) {
    for (const definition of Object.values(experimentDefinitions)) {
      await unlink(partPath(definition.id)).catch(() => {});
    }
  }
}

await main();
