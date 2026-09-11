/**
 * Validates the committed reduced-level browser records (ADR-0025 gate 3).
 *
 * Two record families, one per browser engine, are validated together: the
 * gate asks for the same comparison in Chrome and Firefox, so every figure
 * that describes the scene rather than the engine — the levels chosen, the
 * projected errors, the frame agreement, the pick lattice, the triangle
 * counts — is asserted equal across families field by field rather than
 * pinned twice. What the engine does own (its version, the PNG encoder's
 * bytes, the wall clock) is bounded or re-hashed, never pinned.
 *
 * Both arms are the same build: the reference arm only passes thresholds that
 * can never admit a reduced level. The package digest is HOST-LOCAL and must
 * never be retargeted to make a re-record pass.
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
// 1178x521), so the frame size, the drawn bounds, and which lattice point
// falls on background are engine-owned and pinned per family. Everything the
// gate is about — the level chosen, the projected error, the triangle counts,
// how many drawn pixels disagree and by how much — is engine-independent and
// asserted equal across the families further down.
const FAMILIES = [
  {
    directory: "blink",
    key: "chrome",
    engine: "Blink",
    framePixels: 614259,
    distances: [
      { bounds: { minX: 477, maxX: 706, minY: 179, maxY: 339 }, backgroundPoints: 1 },
      { bounds: { minX: 544, maxX: 637, minY: 227, maxY: 291 }, backgroundPoints: 3 },
    ],
  },
  {
    directory: "gecko",
    key: "firefox",
    engine: "Gecko",
    framePixels: 613738,
    distances: [
      { bounds: { minX: 476, maxX: 705, minY: 179, maxY: 339 }, backgroundPoints: 2 },
      { bounds: { minX: 543, maxX: 636, minY: 227, maxY: 291 }, backgroundPoints: 3 },
    ],
  },
];

const SCHEMA = "naru.reduced-lod-browser-evidence.1";
const MODE = "headed-two-distance-level-agreement";
const POLICY = {
  admitPixels: 1,
  replacePixels: 1.5,
  referenceArmThresholds: { admitPixels: 1e-9, replacePixels: 1e-9 },
  channelTolerance: 8,
  requiredAgreement: 0.99,
  analysisWindow: { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.8 },
  windowMarginPixels: 8,
  pickLatticeSteps: 24,
};
const VIEWPORT = { width: 1320, height: 1000 };
// This host's compile of `fixtures/step/lod-corpus.step` under
// `--reduced-lod 0.001`; host-local, never retarget.
const PACKAGE_DIGEST = "de1e6bc0df2cf6cecf91cf0068c7930602da6e0574a9480c8f3d0b59104c0e19";
const DISTANCES = [
  {
    label: "admit-threshold",
    wheelDelta: 600,
    fittedProjectedErrorPixels: 2.1962,
    projectedErrorPixels: 0.8929,
    triangles: { reference: 6159, reduced: 4135 },
    frame: { differingPixels: 35 },
    window: { x0: 295, y0: 130, x1: 884, y1: 417, differingPixels: 35 },
    geometry: { pixels: 4556, differingPixels: 35 },
    maximumChannelDelta: 128,
    clearancePixels: 49,
    lattice: { points: 57, objectsPicked: 4 },
  },
  {
    label: "half-threshold",
    wheelDelta: 1200,
    fittedProjectedErrorPixels: 2.1962,
    projectedErrorPixels: 0.363,
    triangles: { reference: 6159, reduced: 4135 },
    frame: { differingPixels: 5 },
    window: { x0: 295, y0: 130, x1: 884, y1: 417, differingPixels: 5 },
    geometry: { pixels: 803, differingPixels: 5 },
    maximumChannelDelta: 158,
    clearancePixels: 97,
    lattice: { points: 54, objectsPicked: 4 },
  },
];
const LEVEL_INVARIANTS = {
  maxDeviationMeters: 0.001,
  method: "meshoptimizer-whole-shape-unlocked",
  substitutedChunks: 2,
  exactOnlyChunks: 2,
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

  for (const [index, expected] of DISTANCES.entries()) {
    const distance = record.distances[index];
    const where = `${family.directory}/${expected.label}`;
    assert(distance.label === expected.label, `${where} label moved`);
    assert(distance.wheelDelta === expected.wheelDelta, `${where} camera distance moved`);
    assert(distance.fittedProjectedErrorPixels === expected.fittedProjectedErrorPixels, `${where} fitted projected error moved`);

    // Both arms run the same build at the same camera, so the projected error
    // has to agree while the level chosen must not.
    const { reference, reduced } = distance.arms;
    assert(reference.available && reduced.available, `${where} did not offer a reduced level`);
    assert(reference.level === "target" && reference.representation === "target", `${where} reference arm drew a reduced level`);
    assert(reduced.level === "reduced" && reduced.representation === "reduced", `${where} reduced arm did not draw the reduced level`);
    assert(reference.admitPixels === POLICY.referenceArmThresholds.admitPixels, `${where} reference arm thresholds moved`);
    assert(reduced.admitPixels === POLICY.admitPixels && reduced.replacePixels === POLICY.replacePixels, `${where} reduced arm thresholds moved`);
    assert(reference.projectedErrorPixels === expected.projectedErrorPixels, `${where} reference projected error moved`);
    assert(reduced.projectedErrorPixels === expected.projectedErrorPixels, `${where} reduced projected error moved`);
    assert(reduced.projectedErrorPixels <= POLICY.admitPixels, `${where} drew a reduced level above the admission threshold`);
    assert(reference.triangles === expected.triangles.reference, `${where} reference triangle count moved`);
    assert(reduced.triangles === expected.triangles.reduced, `${where} reduced triangle count moved`);
    assert(reduced.triangles < reference.triangles, `${where} the reduced level is not smaller than the exact one`);
    for (const arm of [reference, reduced]) {
      for (const [key, value] of Object.entries(LEVEL_INVARIANTS)) {
        assert(arm[key] === value, `${where} ${key} moved`);
      }
      assert(arm.status === reference.status && arm.status.includes("5 surface batches"), `${where} status line moved`);
    }

    const comparison = distance.frameComparison;
    assert(comparison.channelTolerance === POLICY.channelTolerance, `${where} channel tolerance moved`);
    assert(comparison.frame.pixels === family.framePixels, `${where} frame pixel count moved`);
    assert(comparison.frame.differingPixels === expected.frame.differingPixels, `${where} frame disagreement moved`);
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
    assert(JSON.stringify(window.pixels) === JSON.stringify({ x0: expected.window.x0, y0: expected.window.y0, x1: expected.window.x1, y1: expected.window.y1 }), `${where} analysis window moved`);
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
// The engines do not agree on everything — Blink captures the canvas 521
// pixels larger than Gecko and lays the drawn geometry out one pixel further
// right — so the frame size, the drawn bounds, and which lattice point lands
// on background are compared against the per-family pins above instead, and
// the record carries the difference rather than asserting it away.
const [first, second] = FAMILIES.map((family) => records[family.directory]);
const distinct = (/** @type {number[]} */ ids) => [...new Set(ids)].sort((a, b) => a - b).join(",");
for (const [index, expected] of DISTANCES.entries()) {
  const left = first.distances[index];
  const right = second.distances[index];
  const where = `${expected.label} differs between ${FAMILIES[0].engine} and ${FAMILIES[1].engine}`;

  // Both arms of both engines run the same build against the same package at
  // the same camera, so the whole arm description — level, representation,
  // thresholds, projected error, triangles, status line, the level's own
  // deviation and chunk counts — must match exactly.
  assert(JSON.stringify(left.arms) === JSON.stringify(right.arms), `${where}: the arm descriptions`);
  assert(JSON.stringify(left.analysisWindow) === JSON.stringify(right.analysisWindow), `${where}: the analysis window`);
  assert(left.frameComparison.channelTolerance === right.frameComparison.channelTolerance, `${where}: the channel tolerance`);
  assert(left.frameComparison.maximumChannelDelta === right.frameComparison.maximumChannelDelta, `${where}: the maximum channel delta`);
  assert(JSON.stringify(left.frameComparison.window) === JSON.stringify(right.frameComparison.window), `${where}: the window comparison`);
  for (const field of ["differingPixels", "agreementRatio"]) {
    assert(left.frameComparison.frame[field] === right.frameComparison.frame[field], `${where}: frame ${field}`);
    assert(left.frameComparison.geometry[field] === right.frameComparison.geometry[field], `${where}: drawn ${field}`);
  }
  assert(left.frameComparison.geometry.pixels === right.frameComparison.geometry.pixels, `${where}: the drawn-pixel count`);
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
console.log(
  `[lod-selection] verified ${FAMILIES.length} engines x ${DISTANCES.length} camera distances over package ${PACKAGE_DIGEST.slice(0, 8)}: ` +
    `${drawn - differing}/${drawn} drawn pixels agree within ${POLICY.channelTolerance}/255, ${picks} picked ids identical per engine, ` +
    `triangles ${DISTANCES[0].triangles.reference} -> ${DISTANCES[0].triangles.reduced}`,
);
