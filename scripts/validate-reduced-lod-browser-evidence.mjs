/**
 * Validates the committed reduced-level browser records (ADR-0025 gate 3).
 *
 * Two record families, one per browser engine, are validated together: the
 * gate asks for the same comparison in Chrome and Firefox, so every figure
 * that describes the scene rather than the engine — the levels chosen, the
 * projected errors, the frame agreement, the pick lattice, the triangle
 * counts — is asserted equal across families field by field rather than
 * pinned twice. What the engine does own (its version, the canvas size, the
 * PNG encoder's bytes, the wall clock) is bounded, pinned per family, or
 * re-hashed, never asserted equal.
 *
 * Both arms are the same build: the reference arm only passes thresholds that
 * can never admit a reduced level. The package digest is HOST-LOCAL and must
 * never be retargeted to make a re-record pass.
 *
 * Since the package declares a deviation bound per prototype, the decision is
 * per chunk and a frame can be mixed. The scene-wide `level` word reads
 * `reduced` only when every substitutable chunk is drawn reduced, so this
 * validator asserts the chunk counts and derives that word from them rather
 * than pinning it — the nearest of the three distances is declared to be the
 * mixed case, and pinning `reduced` there would assert the opposite.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const recordRoot = resolve(repositoryRoot, "artifacts/lod/reduced-selection");

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function assert(condition, message) {
  if (!condition) {
    throw new TypeError(`[lod-selection] ${message}`);
  }
}

// The two engines lay the canvas out one pixel apart (Blink 1179x521, Gecko
// 1178x521), so the frame size, the analysis window in pixels, the drawn
// bounds, and which lattice point falls on background are engine-owned and
// pinned per family. Everything the gate is about — the levels chosen, the
// projected errors, the triangle counts, how many drawn pixels disagree and by
// how much — is engine-independent and asserted equal across the families
// further down.
const FAMILIES = [
  {
    directory: "blink",
    key: "chrome",
    engine: "Blink",
    framePixels: 614259,
    window: { x0: 118, y0: 47, x1: 1155, y1: 458, pixels: 426207 },
    distances: [
      { bounds: { minX: 369, maxX: 819, minY: 101, maxY: 416 }, backgroundPoints: 0 },
      { bounds: { minX: 400, maxX: 787, minY: 123, maxY: 394 }, backgroundPoints: 1 },
      { bounds: { minX: 484, maxX: 699, minY: 184, maxY: 334 }, backgroundPoints: 1 },
    ],
  },
  {
    directory: "gecko",
    key: "firefox",
    engine: "Gecko",
    framePixels: 613738,
    window: { x0: 118, y0: 47, x1: 1154, y1: 458, pixels: 425796 },
    distances: [
      { bounds: { minX: 368, maxX: 818, minY: 101, maxY: 416 }, backgroundPoints: 0 },
      { bounds: { minX: 399, maxX: 786, minY: 123, maxY: 394 }, backgroundPoints: 0 },
      { bounds: { minX: 483, maxX: 698, minY: 184, maxY: 334 }, backgroundPoints: 0 },
    ],
  },
];

const SCHEMA = "naru.reduced-lod-browser-evidence.2";
const MODE = "headed-three-distance-per-chunk-level-agreement";
const POLICY = {
  admitPixels: 1,
  replacePixels: 1.5,
  referenceArmThresholds: { admitPixels: 1e-9, replacePixels: 1e-9 },
  channelTolerance: 8,
  requiredAgreement: 0.99,
  analysisWindow: { x0: 0.1, y0: 0.09, x1: 0.98, y1: 0.88 },
  windowMarginPixels: 8,
  pickLatticeSteps: 24,
};
const VIEWPORT = { width: 1320, height: 1000 };
// This host's compile of `fixtures/step/lod-corpus.step` under
// `--reduced-lod 0.001`; host-local, never retarget.
const PACKAGE_DIGEST = "808c4c01ce9a43534eacf98a09a6351a36ac18c832b2456162a1678bf4a7d4f8";
// The corpus declares two reduced chunks with different bounds — 0.5948 mm for
// the plate and 0.4148 mm for the bracket — which is what makes the near view
// a split band rather than one boolean for the frame.
const PLATE_DEVIATION_METERS = 0.0005947672429085638;
const BRACKET_DEVIATION_METERS = 0.00041477252029056757;

// Three camera distances, chosen from the fitted worst projected error so that
// the nearest one splits the two chunk bounds across the admission threshold.
// `worstProjectedErrorPixels` is the scene's largest declared bound projected
// at that camera and is a property of the camera, not of the arm, so both arms
// report it; `projectedErrorPixels` describes what was actually substituted
// and is null on the reference arm, which substitutes nothing.
const DISTANCES = [
  {
    label: "split-band",
    wheelDelta: 150,
    expectedReducedChunks: 1,
    fittedWorstProjectedErrorPixels: 1.3062,
    worstProjectedErrorPixels: 1.043,
    projectedErrorPixels: 0.7274,
    maxDeviationMeters: BRACKET_DEVIATION_METERS,
    triangles: { reference: 6159, reduced: 5537 },
    frame: { differingPixels: 162 },
    window: { differingPixels: 162 },
    geometry: { pixels: 17201, differingPixels: 162 },
    maximumChannelDelta: 130,
    clearancePixels: 41,
    lattice: { points: 59, objectsPicked: 4 },
  },
  {
    label: "admit-threshold",
    wheelDelta: 250,
    expectedReducedChunks: 2,
    fittedWorstProjectedErrorPixels: 1.3062,
    worstProjectedErrorPixels: 0.8978,
    projectedErrorPixels: 0.8978,
    maxDeviationMeters: PLATE_DEVIATION_METERS,
    triangles: { reference: 6159, reduced: 4135 },
    frame: { differingPixels: 128 },
    window: { differingPixels: 128 },
    geometry: { pixels: 12777, differingPixels: 127 },
    maximumChannelDelta: 152,
    clearancePixels: 63,
    lattice: { points: 59, objectsPicked: 4 },
  },
  {
    label: "half-threshold",
    wheelDelta: 640,
    expectedReducedChunks: 2,
    fittedWorstProjectedErrorPixels: 1.3062,
    worstProjectedErrorPixels: 0.5001,
    projectedErrorPixels: 0.5001,
    maxDeviationMeters: PLATE_DEVIATION_METERS,
    triangles: { reference: 6159, reduced: 4135 },
    frame: { differingPixels: 31 },
    window: { differingPixels: 31 },
    geometry: { pixels: 4045, differingPixels: 31 },
    maximumChannelDelta: 95,
    clearancePixels: 123,
    lattice: { points: 58, objectsPicked: 4 },
  },
];
// The corpus holds four prototypes, two of which carry a reduced level, and
// the whole package stays resident at every distance: what the camera changes
// is which of those two levels is drawn, not what was fetched.
const LEVEL_INVARIANTS = {
  method: "meshoptimizer-whole-shape-unlocked",
  substitutedChunks: 2,
  exactOnlyChunks: 2,
  substitutableChunks: 2,
  residentChunks: 4,
  totalChunks: 4,
};

/** @type {Record<string, any>} */
const records = {};

for (const family of FAMILIES) {
  const directory = resolve(recordRoot, family.directory);
  const record = JSON.parse(readFileSync(resolve(directory, "reduced-lod-browser-evidence.json"), "utf8"));
  records[family.directory] = record;

  assert(record.schemaVersion === SCHEMA, `${family.directory} schema version moved`);
  assert(record.mode === MODE, `${family.directory} mode moved`);
  assert(record.adr === "docs/adr/0025-shape-preserving-lod-representation.md", `${family.directory} does not name ADR-0025`);
  assert(record.gate === "3", `${family.directory} does not name gate 3`);
  assert(record.browser.key === family.key && record.browser.engine === family.engine, `${family.directory} holds the wrong engine`);
  assert(record.browser.headless === false, `${family.directory} was not recorded headed`);
  assert(typeof record.browser.version === "string" && record.browser.version.length > 0, `${family.directory} names no browser version`);
  assert(record.consoleIssues === 0, `${family.directory} reports console or page issues`);
  assert(record.viewport.width === VIEWPORT.width && record.viewport.height === VIEWPORT.height, `${family.directory} viewport moved`);
  assert(JSON.stringify(record.policy) === JSON.stringify(POLICY), `${family.directory} policy moved`);
  assert(record.package.digest === PACKAGE_DIGEST, `${family.directory} package digest moved; it is host-local and must not be retargeted`);
  assert(Array.isArray(record.package.resources) && record.package.resources.length === 3, `${family.directory} package resource list moved`);
  assert(record.distances.length === DISTANCES.length, `${family.directory} distance count moved`);

  const { pixels: familyWindowPixels, ...familyWindowRectangle } = family.window;
  assert(
    (familyWindowRectangle.x1 - familyWindowRectangle.x0) * (familyWindowRectangle.y1 - familyWindowRectangle.y0) === familyWindowPixels,
    `${family.directory} window pixel count does not follow from its own rectangle`,
  );

  for (const [index, expected] of DISTANCES.entries()) {
    const distance = record.distances[index];
    const where = `${family.directory}/${expected.label}`;
    assert(distance.label === expected.label, `${where} label moved`);
    assert(distance.wheelDelta === expected.wheelDelta, `${where} camera distance moved`);
    assert(distance.fittedWorstProjectedErrorPixels === expected.fittedWorstProjectedErrorPixels, `${where} fitted worst projected error moved`);
    assert(distance.expectedReducedChunks === expected.expectedReducedChunks, `${where} the declared reduced-chunk count moved`);

    // Both arms run the same build at the same camera, so the projected error
    // has to agree while the level chosen must not.
    const { reference, reduced } = distance.arms;
    assert(reference.available && reduced.available, `${where} did not offer a reduced level`);
    assert(reference.admitPixels === POLICY.referenceArmThresholds.admitPixels, `${where} reference arm thresholds moved`);
    assert(reduced.admitPixels === POLICY.admitPixels && reduced.replacePixels === POLICY.replacePixels, `${where} reduced arm thresholds moved`);

    // The reference arm substitutes nothing, so it reports no substituted
    // deviation and no substituted projected error at all — null, never zero.
    assert(reference.reducedChunks === 0, `${where} reference arm drew a reduced chunk`);
    assert(reference.representation === "target", `${where} reference arm drew a reduced level`);
    assert(reference.projectedErrorPixels === null, `${where} reference arm reports a substituted projected error`);
    assert(reference.maxDeviationMeters === null, `${where} reference arm reports a substituted deviation`);

    // The reduced arm's decision is per chunk, so the count is the claim and
    // the scene-wide word follows from it rather than being pinned.
    assert(reduced.reducedChunks === expected.expectedReducedChunks, `${where} reduced-chunk count moved`);
    const aggregateLevel = reduced.reducedChunks === reduced.substitutableChunks ? "reduced" : "target";
    assert(reduced.level === aggregateLevel, `${where} the scene-wide level does not follow from the chunk counts`);
    assert(reduced.representation === aggregateLevel, `${where} the drawn representation does not follow from the chunk counts`);
    assert(reduced.maxDeviationMeters === expected.maxDeviationMeters, `${where} the substituted deviation bound moved`);
    assert(reduced.projectedErrorPixels === expected.projectedErrorPixels, `${where} substituted projected error moved`);
    assert(reduced.projectedErrorPixels <= POLICY.admitPixels, `${where} drew a reduced level above the admission threshold`);
    for (const arm of [reference, reduced]) {
      assert(arm.worstProjectedErrorPixels === expected.worstProjectedErrorPixels, `${where} worst projected error moved`);
    }
    assert(reference.triangles === expected.triangles.reference, `${where} reference triangle count moved`);
    assert(reduced.triangles === expected.triangles.reduced, `${where} reduced triangle count moved`);
    assert(reduced.triangles < reference.triangles, `${where} the reduced level is not smaller than the exact one`);
    for (const arm of [reference, reduced]) {
      for (const [key, value] of Object.entries(LEVEL_INVARIANTS)) {
        assert(arm[key] === value, `${where} ${key} moved`);
      }
      assert(arm.status === reference.status && arm.status.includes("5 surface batches"), `${where} status line moved`);
    }

    // The point of a per-prototype bound: at the nearest distance one of the
    // two substitutable chunks projects above the admission threshold and the
    // other below it, so the frame is mixed. A package-wide bound could only
    // have drawn both levels the same way.
    if (expected.expectedReducedChunks < LEVEL_INVARIANTS.substitutableChunks) {
      assert(reduced.worstProjectedErrorPixels > POLICY.admitPixels, `${where} is declared mixed but every bound clears the threshold`);
      assert(reduced.reducedChunks > 0, `${where} is declared mixed but nothing was substituted`);
    } else {
      assert(reduced.worstProjectedErrorPixels <= POLICY.admitPixels, `${where} substituted every chunk while one projects above the threshold`);
    }

    const comparison = distance.frameComparison;
    assert(comparison.channelTolerance === POLICY.channelTolerance, `${where} channel tolerance moved`);
    assert(comparison.frame.pixels === family.framePixels, `${where} frame pixel count moved`);
    assert(comparison.frame.differingPixels === expected.frame.differingPixels, `${where} frame disagreement moved`);
    assert(JSON.stringify({ x0: comparison.window.x0, y0: comparison.window.y0, x1: comparison.window.x1, y1: comparison.window.y1 }) === JSON.stringify(familyWindowRectangle), `${where} window rectangle moved`);
    assert(comparison.window.pixels === family.window.pixels, `${where} window pixel count moved`);
    assert(comparison.window.differingPixels === expected.window.differingPixels, `${where} window disagreement moved`);
    assert(comparison.geometry.pixels === expected.geometry.pixels, `${where} drawn-pixel count moved`);
    assert(comparison.geometry.differingPixels === expected.geometry.differingPixels, `${where} drawn-pixel disagreement moved`);
    assert(JSON.stringify(comparison.geometry.bounds) === JSON.stringify(family.distances[index].bounds), `${where} drawn bounds moved`);
    assert(comparison.maximumChannelDelta === expected.maximumChannelDelta, `${where} maximum channel delta moved`);
    for (const tier of ["frame", "window", "geometry"]) {
      const measured = comparison[tier];
      const ratio = (measured.pixels - measured.differingPixels) / measured.pixels;
      assert(Math.abs(measured.agreementRatio - ratio) < 1e-6, `${where} ${tier} agreement ratio does not follow from its own counts`);
      assert(measured.agreementRatio >= POLICY.requiredAgreement, `${where} ${tier} agreement fell below the required ${POLICY.requiredAgreement}`);
    }

    const window = distance.analysisWindow;
    assert(JSON.stringify(window.fractions) === JSON.stringify(POLICY.analysisWindow), `${where} analysis window fractions moved`);
    assert(JSON.stringify(window.pixels) === JSON.stringify(familyWindowRectangle), `${where} analysis window moved`);
    assert(window.clearancePixels === expected.clearancePixels, `${where} analysis window clearance moved`);
    assert(window.clearancePixels >= POLICY.windowMarginPixels, `${where} drawn geometry reaches the analysis window edge`);

    // The pick half of the gate: one lattice, on drawn geometry, picking the
    // same object ids in both arms.
    const lattice = distance.pickLattice;
    assert(lattice.steps === POLICY.pickLatticeSteps, `${where} pick lattice steps moved`);
    assert(JSON.stringify(lattice.bounds) === JSON.stringify(comparison.geometry.bounds), `${where} pick lattice does not follow the drawn bounds`);
    assert(lattice.points === expected.lattice.points, `${where} pick lattice size moved`);
    assert(lattice.objectsPicked === expected.lattice.objectsPicked, `${where} the lattice stopped covering every corpus part`);
    assert(lattice.backgroundPoints === family.distances[index].backgroundPoints, `${where} background point count moved`);
    assert(lattice.referenceObjectIds.length === lattice.points, `${where} lattice id list is the wrong length`);
    assert(lattice.identical === true && lattice.disagreements.length === 0, `${where} picked ids disagree between the arms`);
    const picked = new Set(lattice.referenceObjectIds.filter((/** @type {number} */ id) => id !== 0));
    assert(picked.size === lattice.objectsPicked, `${where} objectsPicked does not follow from the recorded ids`);
    const background = lattice.referenceObjectIds.filter((/** @type {number} */ id) => id === 0).length;
    assert(background === lattice.backgroundPoints, `${where} backgroundPoints does not follow from the recorded ids`);

    for (const arm of ["reference", "reduced"]) {
      const capture = distance.screenshots[arm];
      const bytes = readFileSync(resolve(directory, capture.file));
      assert(bytes.byteLength === capture.bytes, `${where} ${arm} capture byte count moved`);
      assert(createHash("sha256").update(bytes).digest("hex") === capture.sha256, `${where} ${arm} capture does not match its digest`);
    }
  }
}

// The engine-independent half of the gate: every figure that describes the
// scene rather than the engine has to be identical across the two families.
// The engines do not agree on everything — Blink captures the canvas one pixel
// wider than Gecko and lays the drawn geometry out one pixel further right — so
// the frame size, the analysis window in pixels, the drawn bounds, and which
// lattice point lands on background are compared against the per-family pins
// above instead, and the record carries the difference rather than asserting it
// away. That one pixel also moves the frame and window agreement ratios in
// their sixth decimal, because the denominators differ; the counts of
// disagreeing pixels do not move, and neither does the ratio over drawn
// geometry, whose denominator the engines agree on.
const [first, second] = FAMILIES.map((family) => records[family.directory]);
// Background hits are engine-owned — one engine's lattice lands a point just
// outside the silhouette where the other does not — and are pinned per family
// above, so the cross-engine comparison is over the parts actually picked.
const distinct = (/** @type {number[]} */ ids) =>
  [...new Set(ids.filter((id) => id !== 0))].sort((a, b) => a - b).join(",");
for (const [index, expected] of DISTANCES.entries()) {
  const left = first.distances[index];
  const right = second.distances[index];
  const where = `${expected.label} differs between ${FAMILIES[0].engine} and ${FAMILIES[1].engine}`;

  // Both arms of both engines run the same build against the same package at
  // the same camera, so the whole arm description — level, representation,
  // thresholds, projected error, triangles, status line, the substituted
  // deviation and every chunk count — must match exactly.
  assert(JSON.stringify(left.arms) === JSON.stringify(right.arms), `${where}: the arm descriptions`);
  assert(left.fittedWorstProjectedErrorPixels === right.fittedWorstProjectedErrorPixels, `${where}: the fitted worst projected error`);
  assert(left.expectedReducedChunks === right.expectedReducedChunks, `${where}: the declared reduced-chunk count`);
  assert(JSON.stringify(left.analysisWindow.fractions) === JSON.stringify(right.analysisWindow.fractions), `${where}: the analysis window fractions`);
  assert(left.analysisWindow.clearancePixels === right.analysisWindow.clearancePixels, `${where}: the analysis window clearance`);
  assert(left.frameComparison.channelTolerance === right.frameComparison.channelTolerance, `${where}: the channel tolerance`);
  assert(left.frameComparison.maximumChannelDelta === right.frameComparison.maximumChannelDelta, `${where}: the maximum channel delta`);
  assert(left.frameComparison.frame.differingPixels === right.frameComparison.frame.differingPixels, `${where}: frame differingPixels`);
  assert(left.frameComparison.window.differingPixels === right.frameComparison.window.differingPixels, `${where}: window differingPixels`);
  for (const field of ["pixels", "differingPixels", "agreementRatio"]) {
    assert(left.frameComparison.geometry[field] === right.frameComparison.geometry[field], `${where}: drawn ${field}`);
  }
  for (const field of ["steps", "points", "objectsPicked", "identical"]) {
    assert(left.pickLattice[field] === right.pickLattice[field], `${where}: pick lattice ${field}`);
  }
  assert(
    distinct(left.pickLattice.referenceObjectIds) === distinct(right.pickLattice.referenceObjectIds),
    `${where}: the set of picked object ids`,
  );
}
assert(first.package.digest === second.package.digest, "the engines opened different packages");

const differing = DISTANCES.reduce((sum, distance) => sum + distance.geometry.differingPixels, 0);
const drawn = DISTANCES.reduce((sum, distance) => sum + distance.geometry.pixels, 0);
const picks = DISTANCES.reduce((sum, distance) => sum + distance.lattice.points, 0);
const mixed = DISTANCES.filter((distance) => distance.expectedReducedChunks < LEVEL_INVARIANTS.substitutableChunks).length;
console.log(
  `[lod-selection] verified ${FAMILIES.length} engines x ${DISTANCES.length} camera distances over package ${PACKAGE_DIGEST.slice(0, 8)}: ` +
    `${drawn - differing}/${drawn} drawn pixels agree within ${POLICY.channelTolerance}/255, ${picks} picked ids identical per engine, ` +
    `${mixed} of ${DISTANCES.length} distances draw a mixed frame, triangles ${DISTANCES[0].triangles.reference} -> ${DISTANCES[1].triangles.reduced}`,
);
