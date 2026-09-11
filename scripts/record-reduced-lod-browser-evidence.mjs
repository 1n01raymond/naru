/**
 * Records ADR-0025 gate 3: at three predeclared camera distances inside the
 * 1.0/1.5 pixel admit-and-replace band, the Studio frame drawn with the
 * `reduced` level admitted agrees with a `target`-only reference frame, and the
 * object ids picked on a grid are identical. One of the three is a distance at
 * which the two reduced chunks' own declared bounds fall on opposite sides of
 * the admit threshold, so the frame draws one chunk reduced and one exact.
 *
 * Both arms load the committed gate 1 package. The reference arm sets
 * `?lodAdmitPx=1e-9&lodReplacePx=1e-9`: the selector starts on `target` and a
 * projected error never falls to a billionth of a pixel, so the reference frame
 * is pinned to the exact tessellation without any build or code difference
 * between the arms.
 *
 * Usage: node scripts/record-reduced-lod-browser-evidence.mjs
 *          [--browser chrome|firefox] [--scene-dir artifacts/lod/reduced-level/package]
 *          [--output artifacts/lod/reduced-selection] [--headless]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { chromium, firefox } from "playwright";
import { createServer } from "vite";
import { compareFrames, decodePng, geometryCoverage, latticePoints, resolveWindow } from "./lib/png-pixels.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const argument = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};

/**
 * Engine descriptors, the table `record-ifc-browser-evidence.mjs` established.
 * Each record family is written to its own directory so one engine can be
 * re-recorded without disturbing the other.
 */
const BROWSER_ENGINES = {
  chrome: {
    engine: "Blink",
    directory: "blink",
    launch: (headless) => chromium.launch({ channel: "chrome", headless }),
  },
  firefox: {
    engine: "Gecko",
    directory: "gecko",
    launch: (headless) => firefox.launch({ headless }),
  },
};

/**
 * The three camera distances this record is declared over, fixed before any
 * frame was compared, each with the number of chunks it is declared to draw
 * reduced. The package declares a bound per chunk, so the distances are chosen
 * against the largest of them:
 *
 * - `split-band` sits where the coarser chunk's bound projects past the admit
 *   threshold while the finer one's does not, so the frame draws one chunk
 *   reduced and the other exact. That case is the whole reason a package states
 *   a bound per prototype rather than one for the scene.
 * - `admit-threshold` sits just inside the 1.0 pixel admit threshold for the
 *   coarser bound, which is the largest projected error the policy ever draws a
 *   reduced level at, and so the worst case it permits.
 * - `half-threshold` is a plainer distance further out.
 *
 * All three are reached by wheeling out from the fitted view, which is the only
 * camera input this record uses. Wheeling out only lowers a projected error, so
 * no distance depends on the order the others were visited.
 */
const CAMERA_DISTANCES = [
  { label: "split-band", wheelDelta: 150, expectedReducedChunks: 1 },
  { label: "admit-threshold", wheelDelta: 250, expectedReducedChunks: 2 },
  { label: "half-threshold", wheelDelta: 640, expectedReducedChunks: 2 },
];

/** Per-channel allowance, from ADR-0025 gate 3. */
const CHANNEL_TOLERANCE = 8;
/** Gate 3's agreement floor. Asserted over the whole frame and over geometry. */
const REQUIRED_AGREEMENT = 0.99;
const VIEWPORT = { width: 1320, height: 1000 };
const PORT = 4179;

/**
 * A capture of `#viewport` composites the Studio's header, view cube, buttons
 * and status bar over the canvas. Those pixels are identical in both arms, so
 * counting them as drawn geometry would flatter the ratio that matters. The
 * analysis window is the largest rectangle that holds none of them; the
 * recorder asserts that the reference frame's own drawn bounding box sits
 * inside it with margin, and aborts rather than measure a clipped comparison.
 *
 * The bounds come from the rendered chrome rather than from the stylesheet: on
 * this viewport the canvas is 1179x521, the tool buttons end at y=40, the view
 * cube at x=106, and the status bar begins at y=466. The fractions below clear
 * all three. They are deliberately wider than the fitted geometry needs,
 * because the distance where one chunk is reduced and the other is not is the
 * near view, where the model fills most of the frame.
 */
const ANALYSIS_WINDOW = { x0: 0.1, y0: 0.09, x1: 0.98, y1: 0.88 };
/** Pixels of clearance required between the drawn bounding box and the window. */
const WINDOW_MARGIN = 8;
/** Lattice resolution the pick points are drawn from, per axis. */
const PICK_LATTICE_STEPS = 24;

const browserKey = argument("--browser", "chrome");
const descriptor = BROWSER_ENGINES[browserKey];
if (descriptor === undefined) {
  throw new Error(`unknown --browser ${browserKey}, expected one of ${Object.keys(BROWSER_ENGINES).join(", ")}`);
}
const headless = process.argv.includes("--headless");
const sceneDirectory = resolve(repositoryRoot, argument("--scene-dir", "artifacts/lod/reduced-level/package"));
const artifactDirectory = resolve(
  repositoryRoot,
  argument("--output", "artifacts/lod/reduced-selection"),
  descriptor.directory,
);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Verify the served package against the digests its own build report declares,
 * before a browser sees a byte of it. A record that measured different bytes
 * than the one it names is worse than no record.
 *
 * @returns {{digest: string, resources: {path: string, bytes: number, sha256: string}[]}}
 */
function verifyServedPackage() {
  const report = JSON.parse(readFileSync(resolve(sceneDirectory, "build-report.json"), "utf8"));
  const resources = [];
  for (const resource of report.output.resources) {
    const bytes = readFileSync(resolve(sceneDirectory, resource.path));
    const digest = sha256(bytes);
    if (digest !== resource.sha256) {
      throw new Error(`${resource.path} hashes to ${digest}, build report declares ${resource.sha256}`);
    }
    if (bytes.length !== resource.bytes) {
      throw new Error(`${resource.path} is ${bytes.length} bytes, build report declares ${resource.bytes}`);
    }
    resources.push({ path: resource.path, bytes: bytes.length, sha256: digest });
  }
  return { digest: report.output.packageDigest, resources };
}

/**
 * Read the Studio's published level state. Every figure this record reports
 * about a frame comes from an attribute the Studio publishes for its own sake,
 * not from a hook added for the recorder.
 *
 * @param {import("playwright").Page} page
 */
const readLevelState = (page) =>
  page.evaluate(() => {
    const root = document.documentElement.dataset;
    // An empty attribute means the Studio had nothing to state, which is not
    // the same as a measurement of zero: the deviation is empty whenever no
    // chunk is drawn reduced, so it must read back as null.
    const number = (value) => (value === undefined || value === "" ? null : Number(value));
    return {
      available: root.lodAvailable === "true",
      level: root.lodLevel ?? null,
      projectedErrorPixels: number(root.lodErrorPx),
      worstProjectedErrorPixels: number(root.lodWorstErrorPx),
      admitPixels: number(root.lodAdmitPx),
      replacePixels: number(root.lodReplacePx),
      maxDeviationMeters: number(root.lodDeviationMeters),
      method: root.lodMethod ?? null,
      substitutedChunks: number(root.lodSubstitutes),
      exactOnlyChunks: number(root.lodExactOnly),
      reducedChunks: number(root.lodReducedChunks),
      substitutableChunks: number(root.lodSubstitutableChunks),
      representation: root.geometryRepresentation ?? null,
      residentChunks: number(root.targetChunksReady),
      totalChunks: number(root.targetChunksTotal),
      triangles: Number(
        (document.querySelector("#triangle-count")?.textContent ?? "0").replaceAll(",", ""),
      ),
      status: document.querySelector("#status")?.textContent ?? null,
    };
  });

/**
 * The signature a settled frame has to hold still on. Every field is one the
 * level decision or the residency drain can move, so an unchanged signature
 * across consecutive polls is the evidence that neither is still running.
 *
 * @param {import("playwright").Page} page
 */
const readSignature = (page) =>
  page.evaluate(() => {
    const root = document.documentElement.dataset;
    return [
      root.lodLevel ?? "",
      root.lodReducedChunks ?? "",
      root.geometryRepresentation ?? "",
      root.targetChunksReady ?? "",
      root.targetChunksTotal ?? "",
      document.querySelector("#triangle-count")?.textContent ?? "",
      document.querySelector("#status")?.textContent ?? "",
    ].join("|");
  });

/**
 * Wait for the scene to load and for the level decision and the residency
 * scheduler to stop moving. A momentary `ready === total` is not enough: after
 * a level flip the scheduler re-demands, so the counters can pass through
 * equality while the frame still holds a mixture of levels.
 *
 * @param {import("playwright").Page} page
 */
async function settle(page) {
  await page.waitForFunction(
    () => {
      const state = document.querySelector("#status")?.getAttribute("data-state");
      return state === "ready" || state === "error";
    },
    undefined,
    { timeout: 120_000 },
  );
  const state = await page.getAttribute("#status", "data-state");
  if (state !== "ready") throw new Error(`Studio settled in state ${state}`);
  const deadline = Date.now() + 120_000;
  let previous = "";
  let stable = 0;
  while (stable < 5) {
    if (Date.now() > deadline) throw new Error(`the frame never held still, last signature ${previous}`);
    await page.waitForTimeout(100);
    const signature = await readSignature(page);
    const complete = await page.evaluate(() => {
      const root = document.documentElement.dataset;
      return root.targetChunksReady === root.targetChunksTotal;
    });
    stable = signature === previous && complete ? stable + 1 : 0;
    previous = signature;
  }
  // Two frames after the last change: one draws the settled decision and the
  // next proves it held.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(undefined)))),
  );
}

/**
 * Click a set of points and read the object id the Studio selects at each.
 * Selection pins the picked prototype to its exact level, so the grid runs
 * after both frames have been captured, never before.
 *
 * Clicks are issued through the canvas locator rather than absolute mouse
 * coordinates: capturing an element screenshot scrolls it into view, so a box
 * read before the capture no longer describes where the canvas sits.
 *
 * @param {import("playwright").Page} page
 * @param {{x: number, y: number}[]} points Points in capture pixels.
 * @returns {Promise<{x: number, y: number, objectId: number}[]>}
 */
async function pickPoints(page, points) {
  const picked = [];
  const viewport = page.locator("#viewport");
  for (const point of points) {
    // Clicking the centre of the capture pixel, not its corner, so that a
    // fractional canvas origin cannot round the hit into the neighbouring
    // texel.
    await viewport.click({ position: { x: point.x + 0.5, y: point.y + 0.5 } });
    await settleSelection(page);
    const objectId = await page.evaluate(() => Number(document.documentElement.dataset.selectedObjectId ?? "0"));
    picked.push({ ...point, objectId });
  }
  return picked;
}

/**
 * Wait for one selection to finish. Selecting an object pins it to its exact
 * level and promotes its residency, so reading the next point before that
 * settles would measure a frame that is still changing.
 *
 * @param {import("playwright").Page} page
 */
async function settleSelection(page) {
  const deadline = Date.now() + 30_000;
  let previous = "";
  let stable = 0;
  while (stable < 3) {
    if (Date.now() > deadline) throw new Error(`a selection never settled, last signature ${previous}`);
    await page.waitForTimeout(100);
    const signature = `${await readSignature(page)}|${await page.evaluate(
      () => document.documentElement.dataset.selectedObjectId ?? "",
    )}`;
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
  }
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(undefined)))),
  );
}

/**
 * The canvas rectangle in client space. Both arms have to agree on it before a
 * point is clicked: a fractional difference would map the same capture pixel
 * to different texels and show up as a false pick divergence.
 *
 * @param {import("playwright").Page} page
 */
const canvasRect = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector("#viewport");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("the viewport canvas is missing");
    const rect = canvas.getBoundingClientRect();
    return {
      left: Number(rect.left.toFixed(3)),
      top: Number(rect.top.toFixed(3)),
      width: Number(rect.width.toFixed(3)),
      height: Number(rect.height.toFixed(3)),
      backingWidth: canvas.width,
      backingHeight: canvas.height,
    };
  });

/**
 * Open one arm at one distance and capture its frame, leaving the page open so
 * both arms can be clicked at the same derived points.
 *
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 * @param {{label: string, wheelDelta: number, expectedReducedChunks: number}} distance
 * @param {{label: string, thresholds: {admit: string, replace: string} | undefined}} arm
 * @param {string[]} issues Collected console and page errors, shared across arms.
 */
async function openArm(browser, baseUrl, distance, arm, issues) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      issues.push(`${arm.label}/${distance.label} console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => issues.push(`${arm.label}/${distance.label} pageerror: ${error.message}`));
  page.on("crash", () => issues.push(`${arm.label}/${distance.label} page crashed`));
  const url = new URL(baseUrl);
  url.searchParams.set("scene", new URL("scene.gltf", baseUrl).href);
  if (arm.thresholds !== undefined) {
    url.searchParams.set("lodAdmitPx", arm.thresholds.admit);
    url.searchParams.set("lodReplacePx", arm.thresholds.replace);
  }
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await settle(page);
  const fitted = await readLevelState(page);
  const viewport = page.locator("#viewport");
  await viewport.hover();
  await page.mouse.wheel(0, distance.wheelDelta);
  await settle(page);
  const state = await readLevelState(page);
  const frame = await viewport.screenshot();
  return { context, page, fitted, state, frame, url: url.href };
}

const ARMS = [
  { key: "reference", label: "target-only", thresholds: { admit: "1e-9", replace: "1e-9" } },
  { key: "reduced", label: "reduced-admitted", thresholds: undefined },
];

const started = process.hrtime.bigint();
const servedPackage = verifyServedPackage();
process.env.NARU_SCENE_DIR = relative(repositoryRoot, sceneDirectory).replaceAll("\\", "/");

const server = await createServer({
  configFile: resolve(repositoryRoot, "apps/webgpu-spike/vite.config.ts"),
  logLevel: "error",
  root: resolve(repositoryRoot, "apps/webgpu-spike"),
  server: { host: "127.0.0.1", port: PORT, strictPort: true },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${PORT}/`;

const browser = await descriptor.launch(headless);
/** @type {string[]} */
const issues = [];
/** @type {Record<string, unknown>[]} */
const distances = [];
const browserVersion = browser.version();
try {
  rmSync(artifactDirectory, { force: true, recursive: true });
  mkdirSync(artifactDirectory, { recursive: true });
  for (const distance of CAMERA_DISTANCES) {
    /** @type {Record<string, Awaited<ReturnType<typeof openArm>>>} */
    const opened = {};
    try {
      for (const arm of ARMS) {
        opened[arm.key] = await openArm(browser, baseUrl, distance, arm, issues);
        writeFileSync(resolve(artifactDirectory, `${distance.label}-${arm.key}.png`), opened[arm.key].frame);
      }
      const reference = opened.reference;
      const reduced = opened.reduced;
      if (reference === undefined || reduced === undefined) throw new Error("an arm produced no capture");
      // The level is per chunk, so the arms are checked on the chunk counts
      // rather than on the scene-wide word: `reduced` is reported only when
      // every substitutable chunk is reduced, which is exactly what the
      // split-band distance is declared not to be.
      if (reference.state.reducedChunks !== 0) {
        throw new Error(`the reference arm drew ${reference.state.reducedChunks} chunks reduced, expected none`);
      }
      if (reduced.state.reducedChunks !== distance.expectedReducedChunks) {
        throw new Error(
          `the reduced arm drew ${reduced.state.reducedChunks} of ${reduced.state.substitutableChunks} chunks ` +
            `reduced at a worst projected error of ${reduced.state.worstProjectedErrorPixels} px, ` +
            `expected ${distance.expectedReducedChunks}`,
        );
      }
      const expectedLevel = reduced.state.reducedChunks === reduced.state.substitutableChunks ? "reduced" : "target";
      if (reduced.state.level !== expectedLevel) {
        throw new Error(`the reduced arm reports level ${reduced.state.level}, expected ${expectedLevel}`);
      }
      const referenceImage = decodePng(reference.frame);
      const window = resolveWindow(referenceImage, ANALYSIS_WINDOW);
      const coverage = geometryCoverage(referenceImage, window, CHANNEL_TOLERANCE);
      if (coverage.bounds === null) throw new Error("the reference frame draws nothing inside the analysis window");
      const clearance = Math.min(
        coverage.bounds.minX - window.x0,
        window.x1 - 1 - coverage.bounds.maxX,
        coverage.bounds.minY - window.y0,
        window.y1 - 1 - coverage.bounds.maxY,
      );
      if (clearance < WINDOW_MARGIN) {
        throw new Error(
          `the drawn bounding box ${JSON.stringify(coverage.bounds)} clears the analysis window ` +
            `${JSON.stringify(window)} by ${clearance} px, ${WINDOW_MARGIN} required`,
        );
      }
      const points = latticePoints(referenceImage, coverage.bounds, PICK_LATTICE_STEPS, CHANNEL_TOLERANCE);
      if (points.length === 0) throw new Error("the lattice found no interior point to pick");
      const comparison = compareFrames(referenceImage, decodePng(reduced.frame), {
        tolerance: CHANNEL_TOLERANCE,
        window,
      });
      const referenceRect = await canvasRect(reference.page);
      const reducedRect = await canvasRect(reduced.page);
      if (JSON.stringify(referenceRect) !== JSON.stringify(reducedRect)) {
        throw new Error(
          `the two arms lay the canvas out differently, ${JSON.stringify(referenceRect)} against ` +
            `${JSON.stringify(reducedRect)}; a pick comparison across them would not be meaningful`,
        );
      }
      const referencePicks = await pickPoints(reference.page, points);
      const reducedPicks = await pickPoints(reduced.page, points);
      const disagreements = referencePicks
        .map((point, index) => ({ point, reduced: reducedPicks[index]?.objectId ?? null }))
        .filter((entry) => entry.point.objectId !== entry.reduced)
        .map((entry) => ({ x: entry.point.x, y: entry.point.y, reference: entry.point.objectId, reduced: entry.reduced }));
      distances.push({
        label: distance.label,
        wheelDelta: distance.wheelDelta,
        expectedReducedChunks: distance.expectedReducedChunks,
        fittedWorstProjectedErrorPixels: reduced.fitted.worstProjectedErrorPixels,
        arms: {
          reference: { url: reference.url, ...reference.state },
          reduced: { url: reduced.url, ...reduced.state },
        },
        frameComparison: comparison,
        analysisWindow: { fractions: ANALYSIS_WINDOW, pixels: window, clearancePixels: clearance },
        pickLattice: {
          steps: PICK_LATTICE_STEPS,
          bounds: coverage.bounds,
          points: points.length,
          objectsPicked: new Set(referencePicks.map((pick) => pick.objectId).filter((id) => id !== 0)).size,
          backgroundPoints: referencePicks.filter((pick) => pick.objectId === 0).length,
          identical: disagreements.length === 0,
          disagreements,
          referenceObjectIds: referencePicks.map((pick) => pick.objectId),
        },
        screenshots: Object.fromEntries(
          ARMS.map((arm) => {
            const file = `${distance.label}-${arm.key}.png`;
            const bytes = readFileSync(resolve(artifactDirectory, file));
            return [arm.key, { file, bytes: bytes.length, sha256: sha256(bytes) }];
          }),
        ),
      });
    } finally {
      for (const arm of ARMS) await opened[arm.key]?.context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (issues.length > 0) {
  throw new Error(`the browser reported ${issues.length} console or page issues:\n${issues.join("\n")}`);
}

const record = {
  schemaVersion: "naru.reduced-lod-browser-evidence.2",
  mode: "headed-three-distance-per-chunk-level-agreement",
  recordedAt: new Date().toISOString(),
  adr: "docs/adr/0025-shape-preserving-lod-representation.md",
  gate: "3",
  host: { platform: process.platform, arch: process.arch, node: process.version },
  browser: { key: browserKey, engine: descriptor.engine, version: browserVersion, headless },
  viewport: VIEWPORT,
  package: {
    sceneDirectory: relative(repositoryRoot, sceneDirectory).replaceAll("\\", "/"),
    digest: servedPackage.digest,
    resources: servedPackage.resources,
  },
  policy: {
    admitPixels: 1,
    replacePixels: 1.5,
    referenceArmThresholds: { admitPixels: 1e-9, replacePixels: 1e-9 },
    channelTolerance: CHANNEL_TOLERANCE,
    requiredAgreement: REQUIRED_AGREEMENT,
    analysisWindow: ANALYSIS_WINDOW,
    windowMarginPixels: WINDOW_MARGIN,
    pickLatticeSteps: PICK_LATTICE_STEPS,
  },
  distances,
  consoleIssues: issues.length,
  elapsedSeconds: Number((Number(process.hrtime.bigint() - started) / 1e9).toFixed(1)),
};

writeFileSync(
  resolve(artifactDirectory, "reduced-lod-browser-evidence.json"),
  `${JSON.stringify(record, null, 2)}\n`,
);

for (const distance of distances) {
  const comparison = distance.frameComparison;
  console.log(
    `${descriptor.engine} ${distance.label}: ${distance.arms.reduced.reducedChunks} of ` +
      `${distance.arms.reduced.substitutableChunks} chunks reduced, worst ` +
      `${distance.arms.reduced.worstProjectedErrorPixels} px, ` +
      `frame ${(comparison.frame.agreementRatio * 100).toFixed(3)}% ` +
      `window ${(comparison.window.agreementRatio * 100).toFixed(3)}% ` +
      `geometry ${(comparison.geometry.agreementRatio * 100).toFixed(3)}% ` +
      `(${comparison.geometry.differingPixels} of ${comparison.geometry.pixels} drawn differ, ` +
      `max delta ${comparison.maximumChannelDelta}), ` +
      `${distance.pickLattice.points} picks on ${distance.pickLattice.objectsPicked} objects ` +
      `${distance.pickLattice.identical ? "identical" : `${distance.pickLattice.disagreements.length} disagree`}, ` +
      `triangles ${distance.arms.reference.triangles} -> ${distance.arms.reduced.triangles}`,
  );
}
console.log(`wrote ${relative(repositoryRoot, artifactDirectory).replaceAll("\\", "/")}`);
