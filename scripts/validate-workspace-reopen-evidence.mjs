/**
 * Validates the browser gate ADR-0022 left open: a workspace saved in the
 * Studio, reopened against an unchanged package, and reopened again after one
 * of its source documents was edited.
 *
 * Two families of pin below do not travel:
 *
 *   - The package digest and the four source digests are HOST-LOCAL. This
 *     Windows host's IFC adapter emits a Scene IR a few bytes different from
 *     the macOS host's, so the Digital Hub package it compiles is not the one
 *     `artifacts/ifc/digital-hub` records. Retarget them only together with a
 *     deliberate re-record, never to make a failing run pass.
 *   - The manifest digests include the origin, because a workspace names its
 *     package by URL. A record served on another port is a different record,
 *     which is why the origin itself is pinned.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const repositoryRoot = resolve(import.meta.dirname, "..");
const recordDirectory = resolve(repositoryRoot, "artifacts/workspace/reopen");
const recordPath = resolve(recordDirectory, "workspace-reopen.json");

function assert(condition, message) {
  if (!condition) throw new TypeError(`[workspace-reopen] ${message}`);
}

const recordText = await readFile(recordPath, "utf8");
const record = JSON.parse(recordText);

assert(record.schemaVersion === "naru.workspace-reopen-evidence.1", "Unknown evidence envelope.");
assert(record.mode === "headed-workspace-round-trip", "Evidence mode changed.");
/**
 * A workspace names its package by URL, so the record legitimately contains
 * `http://`. The guard therefore looks for a drive letter that stands alone,
 * which a URL scheme never does.
 */
assert(
  !/(?:^|[^A-Za-z])[A-Za-z]:[\\/]/u.test(recordText),
  "Evidence leaks a machine-local path.",
);
assert(record.host.platform === "win32", "Record was taken on another platform.");
assert(record.browser.engine === "Blink", "Record was taken on another engine.");
assert(record.browser.headless === false, "A headed browser is what this record claims.");
assert(
  record.browser.viewport.width === 1320 && record.browser.viewport.height === 1000,
  "Viewport changed, so the hierarchy rows the interaction clicks may differ.",
);
assert(record.consoleIssues.length === 0, "The browser logged console issues.");

const PACKAGE_DIGEST = "0e2ed4547e298908744ce7d9075900b1c55a4e88f26af7a6bef2ea7ee6c6595d";
const ORIGIN = "http://127.0.0.1:4176/";
const PACKAGE_HREF = "http://127.0.0.1:4176/scene.gltf";

assert(record.served.origin === ORIGIN, `Record was served from ${record.served.origin}.`);
assert(record.served.packageHref === PACKAGE_HREF, "Package href changed.");
assert(record.served.packageDigest === PACKAGE_DIGEST, "Package digest changed.");

const RESOURCES = {
  "scene.gltf": [41903482, "580262628478689792bfee41c1281c37ae9c4aab17c0a75a135922ba33154fa3"],
  "scene.bin": [35962344, "e6cb5f6943f03a14ccccc7be950646dac84ad22536891ad5423e48e5113747f7"],
  "coarse.bin": [3085296, "5e4fb16db1660f3278a3761f9699c4eb7f003220006d9c082106935e72770284"],
  "properties.json": [1246277, "10b1f579eda1c085fdd115031ea416edf14e82b5a2b7b4e1ac0ec80f7af70675"],
  "properties.bin": [2260991, "712fea65ca4b9de75683a01ee79f4fff5ae6f89b0c29cbd0b38a83bb586d07c1"],
};
assert(record.served.resources.length === 5, "The package carries five resources.");
for (const resource of record.served.resources) {
  const expected = RESOURCES[resource.path];
  assert(expected !== undefined, `Unexpected package resource ${resource.path}.`);
  assert(resource.bytes === expected[0], `${resource.path} is ${resource.bytes} B.`);
  assert(resource.sha256 === expected[1], `${resource.path} digest changed.`);
}

const SOURCES = {
  "arc.ifc": ["architecture", 9022255, "19d7d02d53c2b88e86890ee236297b12bbb0f7748030cd32ff6a22762e9966bb"],
  "heating.ifc": ["heating", 20890415, "a5603e8f6aa4cbf63aece92f92f503e9a578702d8fe96a6d4661490f1843710d"],
  "plumbing.ifc": ["plumbing", 25178864, "0b1d6b0abd8d4cc3f5f798c7581bed2b39b40110ba6348d5470bbef646cfed79"],
  "ventilation.ifc": [
    "ventilation",
    12737833,
    "c0a1807875957c4154d45d14a3b5ed480dd3178a5bdc3262302a7eccf76d5cb1",
  ],
};
assert(record.federation.documentCount === 4, "The federation is four documents.");
for (const source of record.federation.sources) {
  const expected = SOURCES[source.label];
  assert(expected !== undefined, `Unexpected federation source ${source.label}.`);
  assert(source.discipline === expected[0], `${source.label} discipline changed.`);
  assert(source.byteLength === expected[1], `${source.label} is ${source.byteLength} B.`);
  assert(source.sha256 === expected[2], `${source.label} digest changed.`);
}

const save = record.arms.save;
const BASELINE_DIGEST = "986dad7cbe08d3db871b7760d381f7f23ee1d5feab2c786194e9be0d4ae69cd4";
const CUSTOMIZED_DIGEST = "5949870b198007e704f13237e0c8fa41899fcac8044449373ad729ed01f4d8c1";
const MANIFEST_FILE_NAME = "http-127.0.0.1-4176-scene.gltf.naru-workspace.json";

assert(save.baseline.fileName === MANIFEST_FILE_NAME, "Manifest file name changed.");
assert(save.baseline.byteLength === 1663, `Baseline manifest is ${save.baseline.byteLength} B.`);
assert(save.baseline.sha256 === BASELINE_DIGEST, "Baseline manifest digest changed.");
assert(
  save.baseline.hiddenOccurrenceIds === 0 &&
    save.baseline.selectedOccurrenceId === null &&
    save.baseline.sectionEnabled === false,
  "The baseline manifest is supposed to describe an untouched session.",
);
assert(
  save.baseline.statusText ===
    "Saved 0 hidden occurrence(s) and 4 source(s) for http://127.0.0.1:4176/scene.gltf.",
  "Baseline save status changed.",
);

/**
 * The interaction has to change the manifest, or byte identity after a reopen
 * would be a statement about an empty view.
 */
assert(save.customized.byteLength === 1871, `Customized manifest is ${save.customized.byteLength} B.`);
assert(save.customized.sha256 === CUSTOMIZED_DIGEST, "Customized manifest digest changed.");
assert(save.customized.sha256 !== save.baseline.sha256, "The interaction changed nothing.");
assert(
  save.customized.statusText ===
    "Saved 3 hidden occurrence(s) and 4 source(s) for http://127.0.0.1:4176/scene.gltf.",
  "Customized save status changed.",
);
assert(save.savedFlag === "true", "The Studio did not stamp the saved flag.");
assert(save.customized.schemaVersion === "naru.workspace.1", "Manifest schema changed.");
assert(save.customized.label === PACKAGE_HREF, "Manifest label changed.");
assert(
  save.customized.packageReference.kind === "url" &&
    save.customized.packageReference.href === PACKAGE_HREF,
  "Manifest package reference changed.",
);
assert(save.customized.packageDigest === PACKAGE_DIGEST, "Manifest package digest changed.");
assert(save.customized.resources.length === 5, "Manifest records five resources.");
assert(save.customized.sources.length === 4, "Manifest records four sources.");

const HIDDEN_ROWS = [
  [0, "Select Basiswand:STB 300:2397830"],
  [1, "Select Basiswand:STB 300:2397918"],
  [2, "Select Basiswand:STB 300:2397985"],
];
assert(save.interaction.hiddenRows.length === 3, "Three rows are hidden.");
for (const [index, [position, label]] of HIDDEN_ROWS.entries()) {
  const row = save.interaction.hiddenRows[index];
  assert(row.position === position, `Hidden row ${index} moved to position ${row.position}.`);
  assert(row.label === label, `Hidden row ${index} is ${JSON.stringify(row.label)}.`);
}
assert(
  save.interaction.selectedRow.position === 3 &&
    save.interaction.selectedRow.label === "Select Bodenplatte:STB 300:2398103",
  "The selected row changed.",
);

const VIEW = {
  camera: {
    yaw: 0.05460183660255161,
    pitch: 0.2554797086703875,
    panRight: 0,
    panUp: 0,
    zoom: 1.4333294145603401,
  },
  section: { enabled: true, axis: "z", direction: -1, fraction: 0.35 },
  hiddenOccurrenceIds: [
    "occurrence:ifc:architecture-19d7d02d53c2:14748",
    "occurrence:ifc:architecture-19d7d02d53c2:14942",
    "occurrence:ifc:architecture-19d7d02d53c2:15047",
  ],
  selectedOccurrenceId: "occurrence:ifc:architecture-19d7d02d53c2:15155",
};
assert(
  JSON.stringify(save.customized.view) === JSON.stringify(VIEW),
  `The saved view is ${JSON.stringify(save.customized.view)}.`,
);

/**
 * Both reopen arms report what the Studio knew before any source was hashed and
 * what it knew afterwards. The intermediate state is part of the claim: the
 * Studio refuses to call geometry current on evidence it does not have.
 */
const UNINSPECTED = {
  state: "unverifiable",
  geometryIsCurrent: "false",
  package: "verified",
  sources: "unverifiable",
  sourceInspection: "unavailable",
  hiddenOccurrences: "3",
  droppedOccurrences: "0",
  droppedSelection: "false",
  kindLabel: "UNVERIFIABLE",
  statusState: "warning",
};
const INSPECTED = {
  state: "verified",
  geometryIsCurrent: "true",
  package: "verified",
  sources: "verified",
  sourceInspection: "available",
  hiddenOccurrences: "3",
  droppedOccurrences: "0",
  droppedSelection: "false",
  kindLabel: "VERIFIED",
  statusState: null,
};
const SELECTION_TEXT = "Selected Bodenplatte:STB 300:2398103 \u00b7 node 158 \u00b7 ID 159 \u00b7 0 CAD edge refs";

function assertState(armLabel, phase, observed, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert(
      observed[key] === value,
      `${armLabel} ${phase} ${key} is ${JSON.stringify(observed[key])}, not ${JSON.stringify(value)}.`,
    );
  }
  assert(observed.sceneUrl === PACKAGE_HREF, `${armLabel} ${phase} loaded ${observed.sceneUrl}.`);
  assert(observed.selectionText === SELECTION_TEXT, `${armLabel} ${phase} restored another selection.`);
  assert(observed.sectionEnabled === "true", `${armLabel} ${phase} lost the section plane.`);
  assert(observed.sectionPosition === 35, `${armLabel} ${phase} section is at ${observed.sectionPosition}.`);
}

const UNINSPECTED_STATUS =
  "http://127.0.0.1:4176/scene.gltf reopened as unverifiable. No source document was checked, " +
  'so its 4 source(s) are unverifiable; use "Check sources" to pick them. Restored 3 hidden ' +
  "occurrence(s) and the selection.";
const VERIFIED_STATUS =
  "http://127.0.0.1:4176/scene.gltf reopened as verified. All 4 source(s) match. Restored 3 " +
  "hidden occurrence(s) and the selection.";

for (const armLabel of ["unchanged", "reload"]) {
  const arm = record.arms[armLabel];
  assertState(armLabel, "before inspection", arm.beforeSourceInspection, UNINSPECTED);
  assert(
    arm.beforeSourceInspection.statusText === UNINSPECTED_STATUS,
    `${armLabel} uninspected status changed.`,
  );
  assertState(armLabel, "after inspection", arm.afterSourceInspection, INSPECTED);
  assert(
    arm.afterSourceInspection.statusText === VERIFIED_STATUS,
    `${armLabel} verified status changed.`,
  );
  assert(arm.resaved.fileName === MANIFEST_FILE_NAME, `${armLabel} re-save named another file.`);
  assert(arm.resaved.byteLength === 1871, `${armLabel} re-save is ${arm.resaved.byteLength} B.`);
  assert(arm.resaved.sha256 === CUSTOMIZED_DIGEST, `${armLabel} re-save digest changed.`);
  assert(arm.manifestIsByteIdentical === true, `${armLabel} did not restore the saved view.`);
}

const unchanged = record.arms.unchanged;
assert(unchanged.inspectedSources.length === 4, "The unchanged arm inspects four sources.");
for (const source of unchanged.inspectedSources) {
  const expected = SOURCES[source.label];
  assert(expected !== undefined, `Unexpected inspected source ${source.label}.`);
  assert(source.sha256 === expected[2], `${source.label} was not the source that was compiled.`);
}

/**
 * ADR-0002 puts the native documents above the package, so a changed source
 * outranks a package whose digest still matches.
 */
const changed = record.arms.changedSource;
assert(changed.edit.label === "arc.ifc", "The edit moved to another document.");
assert(
  changed.edit.originalSha256 === SOURCES["arc.ifc"][2],
  "The edit did not start from the compiled source.",
);
assert(
  changed.edit.editedSha256 === "b428d64184f73a8ef5250efc64b3f9d2a9186cb3bca35296705023284dcd932c",
  "The edited source digest changed.",
);
assert(
  changed.edit.byteLength === SOURCES["arc.ifc"][1] && changed.edit.byteLengthUnchanged === true,
  "A same-length edit is what makes this a digest claim rather than a size claim.",
);
assert(changed.inspectedSources.length === 4, "The changed arm inspects four sources.");
assert(
  changed.inspectedSources.filter((source) => source.edited).length === 1,
  "Exactly one source is supposed to have moved.",
);
for (const source of changed.inspectedSources) {
  const expected = source.edited ? changed.edit.editedSha256 : SOURCES[source.label][2];
  assert(source.sha256 === expected, `${source.label} digest changed.`);
}
assertState("changed source", "after inspection", changed.state, {
  state: "changed-source",
  geometryIsCurrent: "false",
  package: "verified",
  sources: "changed",
  sourceInspection: "available",
  hiddenOccurrences: "3",
  droppedOccurrences: "0",
  droppedSelection: "false",
  kindLabel: "CHANGED-SOURCE",
  statusState: "warning",
});
assert(
  changed.state.statusText ===
    "http://127.0.0.1:4176/scene.gltf reopened as changed-source. Source evidence: arc.ifc " +
      "(changed). Restored 3 hidden occurrence(s) and the selection.",
  "Changed-source status changed.",
);

/**
 * The reload arm boots the Studio on a different URL so the reopen has to load
 * the package before it can restore anything. Both reopen paths in the Studio
 * are therefore covered, not just the in-place one.
 */
const reload = record.arms.reload;
assert(
  reload.bootSceneUrl === "http://127.0.0.1:4176/scene.gltf?reopen=1",
  `The reload arm booted on ${reload.bootSceneUrl}.`,
);
assert(
  reload.manifestReferenceHref === PACKAGE_HREF,
  "The manifest no longer names the package the reload arm booted beside.",
);
assert(
  reload.loadedPackageAgain === true,
  "The reload arm restored in place, so it proves nothing the unchanged arm does not.",
);

// Re-pinned 2026-09-07 with the record re-taken after the Studio camera fix
// (the default view used to be mirrored and seen from below). Every count and
// digest in the JSON reproduced; only the pictures changed.
const CAPTURES = {
  "arms.save.screenshots.customized": [
    save.screenshots.customized,
    "f9f9250c8a684540cf0ce97903806a4ee83bc24936c44440f93be4f863246f93",
  ],
  "arms.unchanged.screenshot": [
    unchanged.screenshot,
    "0bdfe32150d112c57aafd41efa179693afd5350fd046354f930d660ad309d69d",
  ],
  "arms.changedSource.screenshot": [
    changed.screenshot,
    "a2236c6e1254c3a65da2f1171e03279154432be4651512032ee95781d8150514",
  ],
  "arms.reload.screenshot": [
    reload.screenshot,
    "0bdfe32150d112c57aafd41efa179693afd5350fd046354f930d660ad309d69d",
  ],
};
for (const [name, [capture, digest]] of Object.entries(CAPTURES)) {
  assert(capture.sha256 === digest, `${name} digest changed.`);
}
assert(
  unchanged.screenshot.sha256 === reload.screenshot.sha256,
  "The two reopen paths are supposed to put the same picture on screen.",
);

/**
 * Every capture is checked against its own recorded digest. Only four of the
 * five are pinned to a literal: `save-baseline.png` is taken the moment the
 * scene reports ready, and chunk arrival at that moment is a race, so four
 * consecutive runs produced three different images of it. The four captures
 * that carry the claims reproduced byte-identically across all four runs.
 */
const captures = [
  save.screenshots.baseline,
  save.screenshots.customized,
  unchanged.screenshot,
  changed.screenshot,
  reload.screenshot,
];
for (const capture of captures) {
  const bytes = await readFile(resolve(recordDirectory, capture.path));
  assert(bytes.byteLength === capture.bytes, `${capture.path} is ${bytes.byteLength} B on disk.`);
  assert(
    createHash("sha256").update(bytes).digest("hex") === capture.sha256,
    `${capture.path} does not match its recorded digest.`,
  );
}

console.log(
  `[workspace-reopen] ${record.browser.id} ${record.browser.version} over package ` +
    `${PACKAGE_DIGEST.slice(0, 12)} and ${record.federation.documentCount} sources: saved ` +
    `${save.customized.byteLength} B manifest ${CUSTOMIZED_DIGEST.slice(0, 12)}, unchanged reopen ` +
    `${unchanged.beforeSourceInspection.state} -> ${unchanged.afterSourceInspection.state}, ` +
    `reload reopen ${reload.beforeSourceInspection.state} -> ${reload.afterSourceInspection.state}, ` +
    `both re-saved byte-identical, edited source reported ${changed.state.state} with ` +
    `geometryIsCurrent ${changed.state.geometryIsCurrent} over a ${changed.state.package} package`,
);
