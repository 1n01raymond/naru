import { describe, expect, it } from "vitest";

import {
  armIds,
  behaviourFailures,
  experimentPhases,
  ledgerDefinitionFailures,
  median,
  memoryRunFailures,
  percentChange,
  recomputeOutcomes,
  sampleFailures,
  setFailures,
  settledPhases,
  timingRunFailures,
} from "../../../scripts/lib/document-retention.mjs";

// The endpoint the protocol pins. Both sixty5 packages settle here, so a run
// that lands anywhere else is a discarded run rather than a new endpoint.
const endpoint = {
  chunksReady: 111,
  chunksTotal: 234,
  decodedBytes: 66_686_508,
  gpuBytes: 66_783_808,
  triangleCount: "2,255,235",
  occurrenceCount: "78173",
};

const budgetBytes = 67_108_864;

function residency(overrides: Record<string, unknown> = {}) {
  return {
    budgetBytes,
    chunksReady: endpoint.chunksReady,
    decodedBytes: endpoint.decodedBytes,
    gpuBytes: endpoint.gpuBytes,
    ...overrides,
  };
}

function sample(overrides: Record<string, unknown> = {}) {
  return {
    phase: "budget-limited",
    atMilliseconds: 12_000,
    crossOriginIsolated: true,
    residency: residency(),
    retention: {
      documentBytes: 448_823_852,
      propertyIndexBytes: 17_705_010,
      declaredGeometryBytes: 120_707_064,
    },
    page: { usedJsHeapBytes: 900_000_000, uaMemoryBytes: 1_200_000_000 },
    process: { workingSetBytes: 2_500_000_000, privateBytes: 8_000_000_000 },
    ...overrides,
  };
}

function behaviour(overrides: Record<string, unknown> = {}) {
  return {
    hierarchyEntryCount: 78_173,
    pickedOccurrenceName: "ifc:facade-a9a1b20214da:52355",
    pickedPropertyEntryCount: 44,
    selectionDetail: "74387 · ID 74388",
    ...overrides,
  };
}

// Six phase samples whose highest main-thread heap is the peak the protocol
// compares. The overlap phase is the peak on purpose: that is where the
// replacement package is open over the one already loaded.
function memoryRun(peak: number, overrides: Record<string, unknown> = {}) {
  const fractions = [0.2, 0.4, 0.6, 1, 0.7, 0.3];
  const heaps = fractions.map((fraction) => Math.round(peak * fraction));
  const samples = experimentPhases.map((phase, index) =>
    sample({
      phase,
      atMilliseconds: (index + 1) * 1_000,
      page: {
        usedJsHeapBytes: heaps[index] ?? 0,
        uaMemoryBytes: (heaps[index] ?? 0) + 300_000_000,
      },
      ...(phase === "disposed"
        ? {
            residency: {
              unavailableReason:
                "The open package declares no target chunks, so the Studio publishes no target residency.",
            },
          }
        : {}),
    }),
  );
  return {
    arm: "candidate",
    runIndex: 0,
    milestones: { hierarchyReadyMs: 2_400, coarseFrameMs: 4_500, readyMs: 9_100 },
    endpoint: { ...endpoint },
    behaviour: behaviour(),
    consoleIssues: [],
    samples,
    peakUsedJsHeapBytes: Math.max(...heaps),
    ...overrides,
  };
}

function timingRun(coarseFrameMs: number, overrides: Record<string, unknown> = {}) {
  return {
    arm: "candidate",
    runIndex: 0,
    milestones: {
      hierarchyReadyMs: Math.round(coarseFrameMs * 0.5),
      coarseFrameMs,
      readyMs: coarseFrameMs * 2,
    },
    endpoint: { ...endpoint },
    behaviour: behaviour(),
    consoleIssues: [],
    samples: [],
    ...overrides,
  };
}

// Baseline-first alternating pairs, which is the only accepted order.
function buildSet(
  mode: "memory" | "timing",
  peaks: Record<string, number>,
  pairs = 3,
) {
  const attempts: Record<string, unknown>[] = [];
  const arms: Record<string, { runs: Record<string, unknown>[] }> = {
    baseline: { runs: [] },
    candidate: { runs: [] },
  };
  let index = 0;
  for (let pair = 0; pair < pairs; pair += 1) {
    for (const arm of armIds) {
      attempts.push({ index, arm, accepted: true, discardReason: null });
      index += 1;
      const overrides = { arm, runIndex: pair };
      arms[arm]?.runs.push(
        mode === "memory"
          ? memoryRun(peaks[arm] ?? 0, overrides)
          : timingRun(peaks[arm] ?? 0, overrides),
      );
    }
  }
  return { attempts, arms };
}

function ledgerCategories(count = 12) {
  return Array.from({ length: count }, (unused, index) => ({
    id: `category.${index}`,
    owner: "the Studio",
    lifetime: "until the scene is replaced",
    consumer: "the compiled-glTF loader",
    method: "exact-counted",
    unavailableReason: null,
  }));
}

function experimentFixture() {
  return {
    memorySet: buildSet("memory", { baseline: 1_500_000_000, candidate: 1_200_000_000 }),
    timingSet: buildSet("timing", { baseline: 4_500, candidate: 4_400 }),
  };
}

const thresholds = {
  peakHeapReductionPercent: 10,
  coarseFrameTolerancePercent: 5,
  endpoint,
};

describe("median and percentChange", () => {
  it("takes the lower median so every reported figure is one of the runs", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it("reports change to two places and refuses a zero base", () => {
    expect(percentChange(1_000, 900)).toBe(-10);
    expect(percentChange(4_500, 4_400)).toBe(-2.22);
    expect(percentChange(0, 900)).toBeNull();
  });
});

describe("sampleFailures", () => {
  it("accepts a settled sample with every quantity measured", () => {
    expect(sampleFailures("s", sample())).toEqual([]);
  });

  it("refuses a phase the protocol never declared", () => {
    const failures = sampleFailures("s", sample({ phase: "warm-up" }));
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("warm-up");
  });

  it("refuses a sample taken outside cross-origin isolation", () => {
    const failures = sampleFailures("s", sample({ crossOriginIsolated: false }));
    expect(failures.join("\n")).toContain("crossOriginIsolated");
  });

  it("accepts absent residency outside the settled phases when it carries a reason", () => {
    const absent = sample({
      phase: "disposed",
      residency: { unavailableReason: "the open package declares no target chunks" },
    });
    expect(sampleFailures("s", absent)).toEqual([]);
  });

  it("refuses absent residency that declares no reason", () => {
    // The hierarchy milestone is reached before the scheduler admits a chunk, so
    // its residency is genuinely absent; a recorder that omits the reason must be
    // refused rather than having the absence read as zero.
    for (const missing of [undefined, null, ""]) {
      const absent = sample({
        phase: "hierarchy",
        residency: { unavailableReason: missing },
      });
      expect(sampleFailures("s", absent).join("\n")).toContain(
        "residency.unavailableReason",
      );
    }
  });

  it("refuses absent residency in a settled phase", () => {
    for (const phase of settledPhases) {
      const absent = sample({
        phase,
        residency: { unavailableReason: "not measured" },
      });
      expect(sampleFailures("s", absent).join("\n")).toContain("settled phase");
    }
  });

  it("refuses partial residency", () => {
    const partial = sample({ residency: { budgetBytes, decodedBytes: 1 } });
    expect(sampleFailures("s", partial).join("\n")).toContain("partial");
  });

  it("accepts the declared budget before the first promotion when the absence carries a reason", () => {
    // The Studio publishes the budget and the chunk totals when the progressive
    // scheduler starts, and the admitted byte counts only once it promotes a
    // chunk. A coarse-frame sample can land inside that window; keeping what the
    // page did publish is not a partial measurement, and it is not zero either.
    const declared = sample({
      phase: "coarse-frame",
      residency: {
        budgetBytes,
        chunksReady: 0,
        chunksTotal: 234,
        decodedBytes: null,
        gpuBytes: null,
        unavailableReason: "the scheduler has admitted no chunk yet",
      },
    });
    expect(sampleFailures("s", declared)).toEqual([]);
  });

  it("refuses a residency measurement that carries no budget", () => {
    const unbounded = sample({ residency: residency({ budgetBytes: null }) });
    expect(sampleFailures("s", unbounded).join("\n")).toContain(
      "must carry the budget it was admitted under",
    );
  });

  it("refuses residency that is both measured and declared unavailable", () => {
    const both = sample({ residency: residency({ unavailableReason: "unclear" }) });
    expect(sampleFailures("s", both).join("\n")).toContain("unavailableReason");
  });

  it("refuses decoded bytes above the budget they are admitted under", () => {
    const over = sample({ residency: residency({ decodedBytes: budgetBytes + 1 }) });
    expect(sampleFailures("s", over).join("\n")).toContain("exceeds the budget");
  });

  it("accepts an absent heap estimator that carries its reason", () => {
    const absent = sample({
      page: {
        usedJsHeapBytes: null,
        usedJsHeapUnavailableReason: "this engine exposes no performance.memory",
        uaMemoryBytes: 1,
      },
    });
    expect(sampleFailures("s", absent)).toEqual([]);
  });

  it("refuses an absent heap estimator with no reason, which would read as zero", () => {
    const absent = sample({ page: { usedJsHeapBytes: null, uaMemoryBytes: 1 } });
    expect(sampleFailures("s", absent).join("\n")).toContain("usedJsHeapUnavailableReason");
  });

  it("refuses an absent process sample with no reason", () => {
    const absent = sample({ process: { workingSetBytes: null, privateBytes: null } });
    expect(sampleFailures("s", absent).join("\n")).toContain("unavailableReason");
  });
});

describe("memoryRunFailures", () => {
  it("accepts a run that sampled every phase in order", () => {
    expect(memoryRunFailures("m", memoryRun(1_000_000_000))).toEqual([]);
  });

  it("refuses phases sampled out of the declared order", () => {
    const run = memoryRun(1_000_000_000);
    const samples = [...(run.samples as Record<string, unknown>[])].reverse();
    const failures = memoryRunFailures("m", { ...run, samples });
    expect(failures.join("\n")).toContain("not the declared order");
  });

  it("refuses a peak that is not the maximum sample", () => {
    const run = memoryRun(1_000_000_000);
    const failures = memoryRunFailures("m", { ...run, peakUsedJsHeapBytes: 1 });
    expect(failures.join("\n")).toContain("is not the maximum sampled");
  });

  it("refuses a settled residency that disagrees with the run endpoint", () => {
    const run = memoryRun(1_000_000_000);
    const samples = (run.samples as Record<string, unknown>[]).map((entry) =>
      entry.phase === "budget-limited"
        ? { ...entry, residency: residency({ chunksReady: 110 }) }
        : entry,
    );
    const failures = memoryRunFailures("m", { ...run, samples });
    expect(failures.join("\n")).toContain("disagrees with the run endpoint");
  });

  it("refuses a run that carries console issues, which the protocol discards", () => {
    const run = memoryRun(1_000_000_000);
    const failures = memoryRunFailures("m", { ...run, consoleIssues: ["a warning"] });
    expect(failures.join("\n")).toContain("console issues");
  });
});

describe("timingRunFailures", () => {
  it("accepts a run that recorded milestones and nothing else", () => {
    expect(timingRunFailures("t", timingRun(4_400))).toEqual([]);
  });

  it("refuses any memory sample in the timing set", () => {
    const run = timingRun(4_400);
    const failures = timingRunFailures("t", { ...run, samples: [sample()] });
    expect(failures.join("\n")).toContain("no memory samples");
  });

  it("refuses an assembly tree built after the first coarse frame", () => {
    const run = timingRun(4_400, {
      milestones: { hierarchyReadyMs: 5_000, coarseFrameMs: 4_400, readyMs: 9_000 },
    });
    expect(timingRunFailures("t", run).join("\n")).toContain(
      "cannot be built after the first coarse frame",
    );
  });

  it("refuses a coarse frame presented after the resident set settled", () => {
    const run = timingRun(4_400, {
      milestones: { hierarchyReadyMs: 2_000, coarseFrameMs: 9_000, readyMs: 4_400 },
    });
    expect(timingRunFailures("t", run).join("\n")).toContain("after the resident set");
  });

  it("refuses a missing milestone", () => {
    const run = timingRun(4_400, {
      milestones: { hierarchyReadyMs: 2_000, coarseFrameMs: 4_400 },
    });
    expect(timingRunFailures("t", run).join("\n")).toContain("readyMs");
  });
});

describe("behaviourFailures", () => {
  it("accepts a run that preserved the tree, picking, properties and the endpoint", () => {
    expect(behaviourFailures("b", memoryRun(1), endpoint)).toEqual([]);
  });

  it("refuses a run that settled on a different endpoint", () => {
    const run = { ...memoryRun(1), endpoint: { ...endpoint, chunksReady: 93 } };
    const failures = behaviourFailures("b", run, endpoint);
    expect(failures.join("\n")).toContain("endpoint chunksReady");
  });

  it("refuses a run whose picked occurrence resolved no properties", () => {
    const run = { ...memoryRun(1), behaviour: behaviour({ pickedPropertyEntryCount: 0 }) };
    const failures = behaviourFailures("b", run, endpoint);
    expect(failures.join("\n")).toContain("property resolution");
  });

  it("refuses a run with no assembly tree", () => {
    const run = { ...memoryRun(1), behaviour: behaviour({ hierarchyEntryCount: 0 }) };
    expect(behaviourFailures("b", run, endpoint).join("\n")).toContain("assembly tree");
  });
});

describe("setFailures", () => {
  it("accepts three interleaved baseline-first pairs", () => {
    const set = buildSet("memory", { baseline: 1_500_000_000, candidate: 1_200_000_000 });
    expect(setFailures("memory set", set)).toEqual([]);
  });

  it("refuses candidate-first ordering", () => {
    const set = buildSet("memory", { baseline: 1, candidate: 1 });
    const attempts = set.attempts.map((attempt, index) => ({
      ...attempt,
      arm: index % 2 === 0 ? "candidate" : "baseline",
    }));
    const failures = setFailures("memory set", { ...set, attempts });
    expect(failures.join("\n")).toContain("baseline-first alternating pairs");
  });

  it("accounts for one discarded run per arm without voiding the set", () => {
    const set = buildSet("memory", { baseline: 1, candidate: 1 });
    const attempts = [
      { index: -1, arm: "baseline", accepted: false, discardReason: "endpoint-mismatch" },
      ...set.attempts,
    ];
    expect(setFailures("memory set", { ...set, attempts })).toEqual([]);
  });

  it("voids a set that discarded more than one run in an arm", () => {
    const set = buildSet("memory", { baseline: 1, candidate: 1 });
    const attempts = [
      { index: -2, arm: "baseline", accepted: false, discardReason: "console-issue" },
      { index: -1, arm: "baseline", accepted: false, discardReason: "milestone-timeout" },
      ...set.attempts,
    ];
    const failures = setFailures("memory set", { ...set, attempts });
    expect(failures.join("\n")).toContain("voids the whole set");
  });

  it("refuses a discard reason the protocol never declared", () => {
    const set = buildSet("memory", { baseline: 1, candidate: 1 });
    const attempts = [
      { index: -1, arm: "baseline", accepted: false, discardReason: "too slow" },
      ...set.attempts,
    ];
    const failures = setFailures("memory set", { ...set, attempts });
    expect(failures.join("\n")).toContain("not a declared discard reason");
  });

  it("refuses fewer pairs than the protocol requires", () => {
    const set = buildSet("memory", { baseline: 1, candidate: 1 }, 2);
    const failures = setFailures("memory set", set);
    expect(failures.join("\n")).toContain("the protocol requires 3");
  });
});

describe("ledgerDefinitionFailures", () => {
  it("accepts twelve categories that each name owner, lifetime and consumer", () => {
    expect(ledgerDefinitionFailures(ledgerCategories())).toEqual([]);
  });

  it("refuses fewer categories than the ledger declares", () => {
    const failures = ledgerDefinitionFailures(ledgerCategories(11));
    expect(failures.join("\n")).toContain("at least 12 categories");
  });

  it("refuses an unsupported quantity with no reason, which would read as zero", () => {
    const categories = ledgerCategories();
    categories[0] = { ...(categories[0] ?? {}), method: "unsupported", unavailableReason: null } as never;
    const failures = ledgerDefinitionFailures(categories);
    expect(failures.join("\n")).toContain("must carry its reason");
  });

  it("refuses a measured quantity that claims to be unavailable", () => {
    const categories = ledgerCategories();
    categories[1] = { ...(categories[1] ?? {}), unavailableReason: "sometimes" } as never;
    const failures = ledgerDefinitionFailures(categories);
    expect(failures.join("\n")).toContain("must not carry an unavailability reason");
  });

  it("refuses a duplicated category id", () => {
    const categories = ledgerCategories();
    categories[2] = { ...(categories[2] ?? {}), id: "category.1" } as never;
    const failures = ledgerDefinitionFailures(categories);
    expect(failures.join("\n")).toContain("duplicate category id");
  });
});

describe("recomputeOutcomes", () => {
  it("lands a candidate that clears the threshold and both guards", () => {
    const outcomes = recomputeOutcomes(experimentFixture(), thresholds);
    expect(outcomes.primary.percentChange).toBe(-20);
    expect(outcomes.primary.met).toBe(true);
    expect(outcomes.timingGuard.percentChange).toBe(-2.22);
    expect(outcomes.timingGuard.met).toBe(true);
    expect(outcomes.behaviourGuard.problems).toEqual([]);
    expect(outcomes.landed).toBe(true);
  });

  it("does not land a reduction short of the declared threshold", () => {
    const experiment = {
      memorySet: buildSet("memory", { baseline: 1_000_000_000, candidate: 950_000_000 }),
      timingSet: buildSet("timing", { baseline: 4_500, candidate: 4_400 }),
    };
    const outcomes = recomputeOutcomes(experiment, thresholds);
    expect(outcomes.primary.percentChange).toBe(-5);
    expect(outcomes.primary.met).toBe(false);
    expect(outcomes.landed).toBe(false);
  });

  it("does not land a candidate that fails the timing guard", () => {
    const experiment = {
      memorySet: buildSet("memory", { baseline: 1_500_000_000, candidate: 1_200_000_000 }),
      timingSet: buildSet("timing", { baseline: 4_000, candidate: 4_320 }),
    };
    const outcomes = recomputeOutcomes(experiment, thresholds);
    expect(outcomes.primary.met).toBe(true);
    expect(outcomes.timingGuard.percentChange).toBe(8);
    expect(outcomes.timingGuard.met).toBe(false);
    expect(outcomes.landed).toBe(false);
  });

  it("carries a behaviour problem found in the timing set into the guard", () => {
    const experiment = experimentFixture();
    const runs = experiment.timingSet.arms.candidate?.runs ?? [];
    runs[0] = { ...(runs[0] ?? {}), endpoint: { ...endpoint, gpuBytes: 1 } };
    const outcomes = recomputeOutcomes(experiment, thresholds);
    expect(outcomes.behaviourGuard.met).toBe(false);
    expect(outcomes.behaviourGuard.problems.join("\n")).toContain("timing candidate run 1");
    expect(outcomes.landed).toBe(false);
  });

  it("reports a per-arm median for every phase without gating on it", () => {
    const outcomes = recomputeOutcomes(experimentFixture(), thresholds);
    const phases = outcomes.reported.phases as Record<
      string,
      Record<string, Record<string, number | null>>
    >;
    expect(Object.keys(phases)).toEqual([...experimentPhases]);
    const overlap = phases["replace-overlap"];
    expect(overlap?.baseline?.usedJsHeapBytes).toBe(1_500_000_000);
    expect(overlap?.candidate?.usedJsHeapBytes).toBe(1_200_000_000);
    // The disposed phase declares its residency absent, so the median is null
    // rather than a zero that would read as an empty measurement.
    expect(phases.disposed?.candidate?.decodedBytes).toBeNull();
    expect(phases["budget-limited"]?.candidate?.decodedBytes).toBe(endpoint.decodedBytes);
  });
});
