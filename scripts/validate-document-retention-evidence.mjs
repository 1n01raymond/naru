// Validates the document retention experiment: the paired baseline/candidate
// record that measures what a compiled package costs a browser beyond the
// geometry the residency budget admits.
//
// The protocol this record answers to was predeclared, before any measurement,
// in artifacts/memory/document-retention/README.md. That is the whole point of
// the record, so this validator asserts the record still carries the protocol's
// own terms -- the pinned inputs, the pinned resident endpoint, the phase list,
// the two separated run sets, the discard rules, and the success threshold --
// and then recomputes the verdict from the samples instead of trusting the
// verdict the recorder wrote.
//
// Nothing here is a memory cap. The runtime's 64 MiB decoded and GPU budgets
// bound admitted target geometry and nothing else; every figure this record
// carries is outside that bound, and none of it may be restated as a
// total-memory limit.
//
// Digests, counts, and the threshold below are pinned on purpose. A re-record
// that changes them must update this file deliberately -- never loosen a check
// to make a run pass, and never retarget a package digest silently: both sixty5
// packages this host compiles are host-local, and swapping one changes what the
// record is evidence of.
//
// The record-shape rules live in scripts/lib/document-retention.mjs so they can
// be unit-tested against fixtures; this file owns the pins and the file system.
//
//   pnpm memory:retention:check
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  armIds,
  behaviourFailures,
  experimentPhases,
  ledgerDefinitionFailures,
  memoryRunFailures,
  recomputeOutcomes,
  setFailures,
  timingRunFailures,
} from "./lib/document-retention.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const recordDirectory = resolve(repositoryRoot, "artifacts/memory/document-retention");

// Copied from the protocol, which pins the resident endpoint both packages
// settle on. A run that lands anywhere else is a discarded run, not a new
// endpoint to pin here.
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

// The two packages the protocol admits, each with its own digest and its own
// baseline. The relocated arm exists only because the candidate changes which
// thread reads the assembly tree; it never replaces the pinned package.
const expectedExperiments = [
  {
    id: "pinned",
    sceneDirectory: "output/ifc/sixty5-prb",
    packageDigest: "a2d6c72a6e936ac3ea2a183a1028cc4a06b20985c6d90b16058954323b7c3347",
    resourceBytes: {
      "scene.gltf": 448_823_852,
      "scene.bin": 120_707_064,
      "coarse.bin": 38_700_720,
      "properties.json": 17_705_010,
      "properties.bin": 31_179_862,
    },
    requiresSecondArmReason: false,
  },
  {
    id: "relocated",
    sceneDirectory: "output/ifc/sixty5-relocated",
    packageDigest: "b821e4316a5b59d9119bb1731cb6223952cf18c10d872485462b8a3d078d13f9",
    resourceBytes: {
      "scene.gltf": 347_731_160,
      "scene.bin": 120_707_064,
      "coarse.bin": 38_700_720,
      "properties.json": 17_705_010,
      "properties.bin": 31_179_862,
      "hierarchy.json": 3_192,
      "hierarchy.bin": 46_250_496,
    },
    requiresSecondArmReason: true,
  },
];

// The category the record accounts for without measuring. Recording a zero here
// would be the one fabrication this record exists to avoid.
const unsupportedLedgerIds = ["gpu.driverAllocationBytes"];

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}
function expect(actual, expected, label) {
  check(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
  );
}
function expectDeep(actual, expected, label) {
  expect(JSON.stringify(actual), JSON.stringify(expected), label);
}

const recordPath = resolve(recordDirectory, "document-retention.json");
const record = JSON.parse(readFileSync(recordPath, "utf8"));

expect(record.schema, "naru.document-retention-evidence.1", "record schema");
expect(record.mode, "fresh-process-paired-retention-experiment", "record mode");
check(
  typeof record.recordedAt === "string" && record.recordedAt.length > 0,
  "record recordedAt must be a non-empty timestamp",
);

// The candidate is named in the record, not inferred from a branch name, so a
// later reader can tell what was measured without the pull request beside it.
expect(record.candidate?.id, "single-document-parse", "candidate id");
check(
  typeof record.candidate?.summary === "string" && record.candidate.summary.length > 40,
  "the candidate must carry a summary of what it changes",
);
expect(
  record.candidate?.protocol,
  "artifacts/memory/document-retention/README.md",
  "candidate protocol pointer",
);

// The protocol pins one engine on one host. That is a limit of the record, not a
// property of the runtime, and it is pinned here so a re-record on another host
// has to say so deliberately.
expect(record.host?.platform, "win32", "host platform");
expect(record.host?.headless, false, "host headless");
check(Array.isArray(record.host?.browsers) && record.host.browsers.length > 0, "host browsers must be recorded");
for (const version of record.host?.browsers ?? []) {
  check(
    typeof version === "string" && version.startsWith("151."),
    `host browser ${JSON.stringify(version)}: the protocol pins headed Chrome 151`,
  );
}

const protocol = record.protocol ?? {};
check(
  typeof protocol.note === "string" && protocol.note.includes("memory cap"),
  "the protocol note must keep saying that nothing in this record is a memory cap",
);
expectDeep(protocol.pinnedEndpoint, pinnedEndpoint, "protocol pinned endpoint");
expectDeep(protocol.successThreshold, successThreshold, "protocol success threshold");
expectDeep(protocol.phases, experimentPhases, "protocol phases");
check(
  Number.isInteger(protocol.memoryPairs) && protocol.memoryPairs >= 3,
  `protocol memoryPairs: the protocol asks for at least three pairs, found ${JSON.stringify(protocol.memoryPairs)}`,
);
check(
  Number.isInteger(protocol.timingPairs) && protocol.timingPairs >= 3,
  `protocol timingPairs: the protocol asks for at least three pairs, found ${JSON.stringify(protocol.timingPairs)}`,
);
expectDeep(protocol.viewport, { width: 1320, height: 1000 }, "protocol viewport");
expectDeep(protocol.camera, { wheelDelta: -5000, panX: 400, panY: -300 }, "protocol camera");

for (const failure of ledgerDefinitionFailures(protocol.ledger ?? [])) {
  failures.push(`protocol ledger: ${failure}`);
}
expectDeep(
  (protocol.ledger ?? [])
    .filter((category) => category.method === "unsupported")
    .map((category) => category.id)
    .sort(),
  unsupportedLedgerIds,
  "protocol ledger unsupported categories",
);

check(
  Array.isArray(record.experiments) && record.experiments.length === expectedExperiments.length,
  `the record must carry ${expectedExperiments.length} experiments, found ${record.experiments?.length}`,
);

for (const [index, expected] of expectedExperiments.entries()) {
  const experiment = record.experiments?.[index];
  if (!experiment) continue;
  const label = `experiment ${expected.id}`;
  expect(experiment.id, expected.id, `${label}: id`);
  check(
    typeof experiment.label === "string" && experiment.label.length > 0,
    `${label}: must carry a human label`,
  );
  check(
    typeof experiment.shape === "string" && experiment.shape.length > 0,
    `${label}: must declare the package shape it measures`,
  );

  // The relocated package is admitted as a second arm only because the candidate
  // changes which thread reads the assembly tree. The record has to say so.
  if (expected.requiresSecondArmReason) {
    check(
      typeof experiment.secondArmReason === "string" && experiment.secondArmReason.length > 0,
      `${label}: a second arm must declare why the protocol admits it`,
    );
  } else {
    expect(experiment.secondArmReason, undefined, `${label}: secondArmReason`);
  }

  // Host-local digests. Both were compiled on this host and neither may be
  // retargeted to make a re-record pass: a different digest is a different
  // package, and the record would then be evidence about something else.
  expect(experiment.package?.digest, expected.packageDigest, `${label}: package digest`);
  expect(experiment.package?.sceneDirectory, expected.sceneDirectory, `${label}: scene directory`);

  const resources = new Map(
    (experiment.package?.resources ?? []).map((resource) => [resource.path, resource]),
  );
  expectDeep(
    [...resources.keys()].sort(),
    Object.keys(expected.resourceBytes).sort(),
    `${label}: package resources`,
  );
  for (const [path, bytes] of Object.entries(expected.resourceBytes)) {
    const resource = resources.get(path);
    if (!resource) continue;
    expect(resource.bytes, bytes, `${label}: ${path} bytes`);
    check(
      typeof resource.sha256 === "string" && /^[0-9a-f]{64}$/.test(resource.sha256),
      `${label}: ${path} must carry a sha256`,
    );
  }

  // Two commits, two servers. A record whose arms resolve to one commit measured
  // the same code twice, whatever the numbers say.
  for (const arm of armIds) {
    const armRecord = experiment.arms?.[arm];
    check(
      typeof armRecord?.commit === "string" && /^[0-9a-f]{7,40}$/.test(armRecord.commit),
      `${label}/${arm}: must record the commit it served`,
    );
    expect(armRecord?.port, arm === "candidate" ? 4180 : 4181, `${label}/${arm}: port`);
  }
  check(
    experiment.arms?.baseline?.commit !== experiment.arms?.candidate?.commit,
    `${label}: both arms resolve to the same commit; nothing was compared`,
  );
}

// The record-shape rules the protocol implies -- phases complete and in order,
// baseline-first alternation, at most one discard per arm, a timing run carrying
// no memory samples, residency present in every settled phase -- live in the
// library so they can be unit-tested. Running them here is what stops a
// hand-edited record from passing.
for (const experiment of record.experiments ?? []) {
  const label = `experiment ${experiment.id}`;
  for (const [setName, minimumPairs, runFailures] of [
    ["memorySet", protocol.memoryPairs, memoryRunFailures],
    ["timingSet", protocol.timingPairs, timingRunFailures],
  ]) {
    const set = experiment[setName];
    if (!set) {
      failures.push(`${label}: ${setName} is missing`);
      continue;
    }
    expect(set.mode, setName === "memorySet" ? "memory" : "timing", `${label}/${setName}: mode`);
    for (const failure of setFailures(`${label}/${setName}`, set, { minimumPairs })) {
      failures.push(failure);
    }
    for (const arm of armIds) {
      for (const [index, run] of (set.arms?.[arm]?.runs ?? []).entries()) {
        const runLabel = `${label}/${setName}/${arm}/run ${index}`;
        for (const failure of runFailures(runLabel, run)) failures.push(failure);
        // The behaviour guard is not a shape rule: both arms must still show the
        // assembly tree, resolve properties for a picked occurrence, and settle on
        // the pinned endpoint, in every accepted run of both sets.
        for (const failure of behaviourFailures(runLabel, run, pinnedEndpoint)) {
          failures.push(failure);
        }
      }
    }
  }

  // Exactly one memory run per arm carries captures: every run of an arm writes
  // into the same directory, so pinning a later run's digests would pin bytes
  // that are no longer on disk.
  for (const arm of armIds) {
    const captured = (experiment.memorySet?.arms?.[arm]?.runs ?? []).filter(
      (run) => run.screenshots && Object.keys(run.screenshots).length > 0,
    );
    check(
      captured.length === 1,
      `${label}/${arm}: exactly one memory run must carry screenshots, found ${captured.length}`,
    );
    for (const run of (experiment.timingSet?.arms?.[arm]?.runs ?? [])) {
      check(
        run.screenshots === undefined,
        `${label}/${arm}: a timing run must carry no screenshots`,
      );
    }
  }
}

// The verdict is recomputed from the samples rather than read from the record.
// The threshold was declared before measurement and is not adjustable
// afterwards, so a record whose stated outcome disagrees with its own numbers is
// invalid, whichever way it disagrees.
for (const experiment of record.experiments ?? []) {
  const label = `experiment ${experiment.id}`;
  const recomputed = recomputeOutcomes(experiment, { ...successThreshold, endpoint: pinnedEndpoint });
  expectDeep(experiment.outcomes, recomputed, `${label}: outcomes recomputed from the samples`);

  const outcomes = experiment.outcomes ?? {};
  expect(
    outcomes.landed,
    Boolean(outcomes.primary?.met && outcomes.timingGuard?.met && outcomes.behaviourGuard?.met),
    `${label}: landed must follow the primary threshold and both guards`,
  );
}

// Every capture is re-hashed from disk. The screenshots are the only part of this
// record a reader can look at, so a stale or replaced PNG has to fail here.
for (const experiment of record.experiments ?? []) {
  for (const arm of armIds) {
    for (const run of experiment.memorySet?.arms?.[arm]?.runs ?? []) {
      for (const [name, capture] of Object.entries(run.screenshots ?? {})) {
        const label = `experiment ${experiment.id}/${arm}/${name}`;
        expect(capture.path, `${experiment.id}/${arm}/${name}`, `${label}: path`);
        let bytes;
        try {
          bytes = readFileSync(resolve(recordDirectory, capture.path));
        } catch (error) {
          failures.push(`${label}: cannot read ${capture.path} (${error.code ?? error.message})`);
          continue;
        }
        expect(bytes.byteLength, capture.bytes, `${label}: bytes`);
        expect(createHash("sha256").update(bytes).digest("hex"), capture.sha256, `${label}: sha256`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Document retention evidence is invalid:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const summary = (record.experiments ?? [])
  .map((experiment) => {
    const primary = experiment.outcomes?.primary ?? {};
    const timing = experiment.outcomes?.timingGuard ?? {};
    return (
      `${experiment.id}: peak heap ${primary.percentChange}% ` +
      `(${primary.baselineBytes} -> ${primary.candidateBytes} B), ` +
      `coarse frame ${timing.percentChange}% ` +
      `(${timing.baselineMilliseconds} -> ${timing.candidateMilliseconds} ms), ` +
      `landed ${experiment.outcomes?.landed}`
    );
  })
  .join("; ");
console.log(
  `[document-retention] ${record.experiments?.length} experiments, ` +
    `${protocol.memoryPairs} memory pairs and ${protocol.timingPairs} timing pairs per arm, ` +
    `threshold ${successThreshold.peakHeapReductionPercent}% peak heap with a ` +
    `${successThreshold.coarseFrameTolerancePercent}% first-frame tolerance. ${summary}`,
);
