// Record-shape rules for the document retention experiment, kept pure so they
// can be unit-tested against fixtures and reused by the recorder and the
// validator without either one becoming the other's authority.
//
// The protocol these rules enforce was predeclared, before any run, in
// artifacts/memory/document-retention/README.md. The rules below encode only
// what that document already says: the phase order, the two-set split, the
// baseline-first alternating pairing, the three declared discard reasons and the
// void rule, the sample shape, and the success threshold with its two guards.
//
// Nothing here substitutes a value it cannot find. A quantity an engine does not
// expose is absent with a reason; turning it into a zero would make the record
// claim a measurement it never took. And no verdict is trusted: every outcome is
// recomputed from the samples, so a recorded verdict cannot be evidence of
// itself.

/** The six phases, in the order the protocol sampled them. */
export const experimentPhases = [
  "hierarchy",
  "coarse-frame",
  "budget-limited",
  "replace-overlap",
  "replace-settled",
  "disposed",
];

/**
 * The phases whose resident set has settled at the pinned endpoint. The coarse
 * frame is sampled as soon as a first frame exists, so how many target chunks
 * have landed by then is a race; the overlap peak and the disposed residual are
 * by definition not settled states either.
 */
export const settledPhases = ["budget-limited", "replace-settled"];

/** The two arms, in the order every pair runs them. Baseline is always first. */
export const armIds = ["baseline", "candidate"];

/**
 * The only reasons a run may be discarded, straight from the protocol. A run is
 * never discarded for being slow, fast, large, or small, so there is no code
 * here that could express that.
 */
export const discardReasons = {
  "console-issue": "a console error, page error, or console warning",
  "milestone-timeout": "a milestone not reached inside its timeout",
  "endpoint-mismatch": "a resident endpoint differing from the pinned endpoint",
};

/** How a byte figure was obtained. Matches the memory envelope's vocabulary. */
export const collectionMethods = {
  "exact-declared": "read from the package's own declaration",
  "exact-counted": "counted by the allocating owner",
  "upper-bound": "the widest layout the owner may have chosen",
  "browser-estimated": "reported by a browser memory interface",
  "os-sampled": "read from the operating system's process table",
  "unsupported": "not exposed by this engine; recorded absent with its reason",
};

export const isByteValue = (value) => Number.isInteger(value) && value >= 0;

/** Lower median, so every reported figure is one of the runs. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Percentage change from a to b, to two places, or null if a is not usable. */
export function percentChange(from, to) {
  if (typeof from !== "number" || typeof to !== "number" || from === 0) return null;
  return Number((((to - from) / from) * 100).toFixed(2));
}

/**
 * One phase sample. The retention ledger must be present and exact, because the
 * Studio reads it from the package's own declarations. Residency, the page heap
 * figures and the process figures may be absent, but only with a reason, and
 * residency may not be absent in a phase whose resident set has settled.
 */
export function sampleFailures(label, sample) {
  const failures = [];
  const at = (detail) => `${label}: ${detail}`;
  if (!experimentPhases.includes(sample?.phase)) {
    return [at(`unknown phase ${JSON.stringify(sample?.phase)}`)];
  }
  if (!Number.isInteger(sample.atMilliseconds) || sample.atMilliseconds < 0) {
    failures.push(at("atMilliseconds must be a non-negative integer"));
  }
  if (sample.crossOriginIsolated !== true) {
    failures.push(
      at("crossOriginIsolated must be true, or the agent-cluster estimator measures a different scope"),
    );
  }

  // Residency is published only on the progressive path, and in two stages: the
  // Studio declares the budget and the chunk totals when the scheduler starts,
  // and publishes admitted bytes only once a chunk has been promoted. The
  // measurement is therefore the decoded and GPU pair. It is absent, with its
  // reason, whenever the open package declares no target chunks -- the disposed
  // phase reaches a replacement package that has none -- and whenever a phase
  // reads the dataset before that first promotion. Substituting the renderer's
  // buffer totals, or the recorder's own budget constant, would report a figure
  // the page never published, so a sample says why the measurement is missing
  // instead. A settled phase may not do that, and a measurement must carry the
  // budget it was admitted under.
  const residency = sample.residency ?? {};
  const measuredKeys = ["decodedBytes", "gpuBytes"];
  const residencyRead = measuredKeys.filter((key) => isByteValue(residency[key]));
  if (residencyRead.length === 0) {
    if (typeof residency.unavailableReason !== "string" || residency.unavailableReason.length === 0) {
      failures.push(at("residency is absent and must carry residency.unavailableReason"));
    }
    if (settledPhases.includes(sample.phase)) {
      failures.push(at(`residency must be measured in the settled phase ${sample.phase}`));
    }
  } else if (residencyRead.length < measuredKeys.length) {
    const missing = measuredKeys.filter((key) => !residencyRead.includes(key));
    failures.push(at(`residency is partial: ${missing.join(", ")} must be byte counts beside the rest`));
  } else {
    if (residency.unavailableReason !== undefined) {
      failures.push(at("residency carries a measurement and must not carry unavailableReason"));
    }
    if (!isByteValue(residency.budgetBytes)) {
      failures.push(at("residency carries a measurement and must carry the budget it was admitted under"));
    }
  }
  if (isByteValue(residency.decodedBytes) && isByteValue(residency.budgetBytes)) {
    if (residency.decodedBytes > residency.budgetBytes) {
      failures.push(at("decoded residency exceeds the budget it is admitted under"));
    }
  }
  if (isByteValue(residency.gpuBytes) && isByteValue(residency.budgetBytes)) {
    if (residency.gpuBytes > residency.budgetBytes) {
      failures.push(at("GPU residency exceeds the budget it is admitted under"));
    }
  }

  const ledger = sample.retention ?? {};
  for (const key of ["documentBytes", "propertyIndexBytes", "declaredGeometryBytes"]) {
    if (!isByteValue(ledger[key])) failures.push(at(`retention.${key} must be a byte count`));
  }

  const page = sample.page ?? {};
  for (const [key, reasonKey] of [
    ["usedJsHeapBytes", "usedJsHeapUnavailableReason"],
    ["uaMemoryBytes", "uaMemoryUnavailableReason"],
  ]) {
    const value = page[key];
    if (value === null || value === undefined) {
      if (typeof page[reasonKey] !== "string" || page[reasonKey].length === 0) {
        failures.push(at(`page.${key} is absent and must carry ${reasonKey}`));
      }
    } else if (!isByteValue(value)) {
      failures.push(at(`page.${key} must be a byte count or absent with a reason`));
    }
  }

  const process = sample.process ?? {};
  for (const key of ["workingSetBytes", "privateBytes"]) {
    const value = process[key];
    if (value === null || value === undefined) {
      if (typeof process.unavailableReason !== "string" || process.unavailableReason.length === 0) {
        failures.push(at(`process.${key} is absent and must carry process.unavailableReason`));
      }
    } else if (!isByteValue(value)) {
      failures.push(at(`process.${key} must be a byte count or absent with a reason`));
    }
  }
  return failures;
}

/** The per-run behaviour guard: what both arms must preserve in every run. */
export function behaviourFailures(label, run, endpoint) {
  const failures = [];
  const at = (detail) => `${label}: ${detail}`;
  const behaviour = run?.behaviour ?? {};
  if (!Number.isInteger(behaviour.hierarchyEntryCount) || behaviour.hierarchyEntryCount <= 0) {
    failures.push(at("the assembly tree must be built and counted"));
  }
  if (typeof behaviour.pickedOccurrenceName !== "string" || behaviour.pickedOccurrenceName.length === 0) {
    failures.push(at("source-aware picking must name the picked occurrence"));
  }
  if (!Number.isInteger(behaviour.pickedPropertyEntryCount) || behaviour.pickedPropertyEntryCount <= 0) {
    failures.push(at("property resolution must return entries for the picked occurrence"));
  }
  if (typeof behaviour.selectionDetail !== "string" || behaviour.selectionDetail.length === 0) {
    failures.push(at("selected-object detail must be present"));
  }
  // The pinned endpoint is carried on the run itself, read once the resident set
  // has settled, so the guard reads the same way in the memory set and in the
  // timing set that takes no samples at all.
  for (const [key, expected] of Object.entries(endpoint)) {
    const actual = run?.endpoint?.[key];
    if (actual !== expected) {
      failures.push(
        at(`endpoint ${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`),
      );
    }
  }
  return failures;
}

/** One accepted run of the memory set: the phases in order, and no console issue. */
export function memoryRunFailures(label, run) {
  const failures = [];
  const at = (detail) => `${label}: ${detail}`;
  const phases = (run?.samples ?? []).map((sample) => sample.phase);
  if (JSON.stringify(phases) !== JSON.stringify(experimentPhases)) {
    failures.push(at(`phases ${JSON.stringify(phases)} are not the declared order`));
  }
  if ((run?.consoleIssues ?? []).length !== 0) {
    failures.push(at("an accepted run carries console issues, which the protocol discards"));
  }
  if (!isByteValue(run?.peakUsedJsHeapBytes)) {
    failures.push(at("peakUsedJsHeapBytes must be a byte count"));
  } else {
    const observed = (run.samples ?? [])
      .map((sample) => sample.page?.usedJsHeapBytes)
      .filter((value) => isByteValue(value));
    const peak = observed.length === 0 ? null : Math.max(...observed);
    if (peak !== run.peakUsedJsHeapBytes) {
      failures.push(
        at(`peakUsedJsHeapBytes ${run.peakUsedJsHeapBytes} is not the maximum sampled ${peak}`),
      );
    }
  }
  for (const sample of run?.samples ?? []) {
    failures.push(...sampleFailures(`${label} ${sample.phase}`, sample));
  }
  // A settled sample and the run's endpoint must agree, or the run reports a
  // residency it did not sample.
  for (const phase of settledPhases) {
    const sample = (run?.samples ?? []).find((entry) => entry.phase === phase);
    if (!sample) continue;
    for (const key of ["chunksReady", "decodedBytes", "gpuBytes"]) {
      const recorded = run?.endpoint?.[key];
      const sampled = sample.residency?.[key];
      if (recorded !== undefined && sampled !== recorded) {
        failures.push(
          at(`${phase} residency.${key} ${JSON.stringify(sampled)} disagrees with the run endpoint ${JSON.stringify(recorded)}`),
        );
      }
    }
  }
  return failures;
}

/** One accepted run of the timing set: milestones only, and no memory sampling. */
export function timingRunFailures(label, run) {
  const failures = [];
  const at = (detail) => `${label}: ${detail}`;
  const milestones = run?.milestones ?? {};
  for (const key of ["hierarchyReadyMs", "coarseFrameMs", "readyMs"]) {
    if (!Number.isInteger(milestones[key]) || milestones[key] < 0) {
      failures.push(at(`milestones.${key} must be a non-negative integer`));
    }
  }
  if (Number.isInteger(milestones.hierarchyReadyMs) && Number.isInteger(milestones.coarseFrameMs)) {
    if (milestones.hierarchyReadyMs > milestones.coarseFrameMs) {
      failures.push(at("the assembly tree cannot be built after the first coarse frame"));
    }
  }
  if (Number.isInteger(milestones.coarseFrameMs) && Number.isInteger(milestones.readyMs)) {
    if (milestones.coarseFrameMs > milestones.readyMs) {
      failures.push(at("the first coarse frame cannot be presented after the resident set settles"));
    }
  }
  if ((run?.samples ?? []).length !== 0) {
    failures.push(at("the timing set must carry no memory samples of any kind"));
  }
  if ((run?.consoleIssues ?? []).length !== 0) {
    failures.push(at("an accepted run carries console issues, which the protocol discards"));
  }
  return failures;
}

/**
 * Set-level rules: the pairing the protocol demands, the declared discard
 * reasons, and the void rule. A set is not repaired by topping it up, so more
 * than one discard in an arm is a failure of the set rather than of a run.
 */
export function setFailures(label, set, { minimumPairs = 3 } = {}) {
  const failures = [];
  const at = (detail) => `${label}: ${detail}`;
  const attempts = set?.attempts ?? [];
  if (attempts.length === 0) return [at("no run attempts recorded")];

  for (const attempt of attempts) {
    if (!armIds.includes(attempt.arm)) {
      failures.push(at(`attempt ${attempt.index}: unknown arm ${JSON.stringify(attempt.arm)}`));
    }
    if (attempt.accepted === false) {
      if (!Object.hasOwn(discardReasons, attempt.discardReason)) {
        failures.push(
          at(`attempt ${attempt.index}: ${JSON.stringify(attempt.discardReason)} is not a declared discard reason`),
        );
      }
    } else if (attempt.accepted !== true) {
      failures.push(at(`attempt ${attempt.index}: accepted must be true or false`));
    } else if (attempt.discardReason !== null && attempt.discardReason !== undefined) {
      failures.push(at(`attempt ${attempt.index}: an accepted run must carry no discard reason`));
    }
  }

  for (const arm of armIds) {
    const discarded = attempts.filter((attempt) => attempt.arm === arm && attempt.accepted === false);
    if (discarded.length > 1) {
      failures.push(
        at(`${arm} discarded ${discarded.length} runs; the protocol voids the whole set past one`),
      );
    }
  }

  const acceptedArms = attempts.filter((attempt) => attempt.accepted === true).map((attempt) => attempt.arm);
  const expectedOrder = acceptedArms.map((unused, index) => armIds[index % armIds.length]);
  if (JSON.stringify(acceptedArms) !== JSON.stringify(expectedOrder)) {
    failures.push(
      at(`accepted runs ${JSON.stringify(acceptedArms)} are not baseline-first alternating pairs`),
    );
  }

  for (const arm of armIds) {
    const runs = set?.arms?.[arm]?.runs ?? [];
    const accepted = acceptedArms.filter((entry) => entry === arm).length;
    if (runs.length !== accepted) {
      failures.push(at(`${arm} carries ${runs.length} runs but ${accepted} accepted attempts`));
    }
    if (runs.length < minimumPairs) {
      failures.push(at(`${arm} has ${runs.length} accepted runs; the protocol requires ${minimumPairs}`));
    }
  }
  const counts = armIds.map((arm) => set?.arms?.[arm]?.runs?.length ?? 0);
  if (new Set(counts).size !== 1) {
    failures.push(at(`the arms are unpaired: ${JSON.stringify(counts)}`));
  }
  return failures;
}

/**
 * The ledger definition: every byte quantity the record reports names the owner
 * that allocates it, how long that owner keeps it, the consumer it exists for,
 * and how the figure was obtained. A quantity an engine does not expose is
 * `unsupported` with a reason and a null value, never a zero.
 */
export function ledgerDefinitionFailures(categories, { minimumCategories = 12 } = {}) {
  const failures = [];
  if (!Array.isArray(categories) || categories.length < minimumCategories) {
    return [`ledger: expected at least ${minimumCategories} categories, found ${categories?.length ?? 0}`];
  }
  const seen = new Set();
  for (const category of categories) {
    const at = (detail) => `ledger ${category?.id ?? "<unnamed>"}: ${detail}`;
    if (typeof category?.id !== "string" || category.id.length === 0) {
      failures.push("ledger: a category has no id");
      continue;
    }
    if (seen.has(category.id)) failures.push(at("duplicate category id"));
    seen.add(category.id);
    for (const key of ["owner", "lifetime", "consumer"]) {
      if (typeof category[key] !== "string" || category[key].length === 0) {
        failures.push(at(`${key} must say who or what, in words`));
      }
    }
    if (!Object.hasOwn(collectionMethods, category.method)) {
      failures.push(at(`method ${JSON.stringify(category.method)} is not a declared collection method`));
    }
    if (category.method === "unsupported") {
      if (typeof category.unavailableReason !== "string" || category.unavailableReason.length === 0) {
        failures.push(at("an unsupported quantity must carry its reason"));
      }
    } else if (category.unavailableReason !== null && category.unavailableReason !== undefined) {
      failures.push(at("a supported quantity must not carry an unavailability reason"));
    }
  }
  return failures;
}

/**
 * Recompute the success threshold and its two guards from the samples. The
 * thresholds were declared before measurement and are passed in rather than
 * read out of the record, so a recorded verdict can never be evidence of
 * itself. The process figures come back reported but not gating, because a
 * browser process figure includes allocator and GPU-process behaviour no
 * page-level interface resolves.
 */
export function recomputeOutcomes(experiment, { peakHeapReductionPercent, coarseFrameTolerancePercent, endpoint }) {
  const memoryRuns = (arm) => experiment?.memorySet?.arms?.[arm]?.runs ?? [];
  const timingRuns = (arm) => experiment?.timingSet?.arms?.[arm]?.runs ?? [];

  const peaks = Object.fromEntries(
    armIds.map((arm) => [arm, median(memoryRuns(arm).map((run) => run.peakUsedJsHeapBytes))]),
  );
  const peakPercent = percentChange(peaks.baseline, peaks.candidate);
  const primary = {
    metric: "median peak main-thread used JS heap across the session",
    baselineBytes: peaks.baseline,
    candidateBytes: peaks.candidate,
    percentChange: peakPercent,
    thresholdPercent: -peakHeapReductionPercent,
    met: typeof peakPercent === "number" && peakPercent <= -peakHeapReductionPercent,
  };

  const coarse = Object.fromEntries(
    armIds.map((arm) => [arm, median(timingRuns(arm).map((run) => run.milestones?.coarseFrameMs))]),
  );
  const coarsePercent = percentChange(coarse.baseline, coarse.candidate);
  const timingGuard = {
    metric: "median first coarse frame, measured in the timing set",
    baselineMilliseconds: coarse.baseline,
    candidateMilliseconds: coarse.candidate,
    percentChange: coarsePercent,
    tolerancePercent: coarseFrameTolerancePercent,
    met: typeof coarsePercent === "number" && coarsePercent <= coarseFrameTolerancePercent,
  };

  const behaviourProblems = [];
  for (const [setId, runsOf] of [["memory", memoryRuns], ["timing", timingRuns]]) {
    for (const arm of armIds) {
      runsOf(arm).forEach((run, index) => {
        behaviourProblems.push(...behaviourFailures(`${setId} ${arm} run ${index + 1}`, run, endpoint));
      });
    }
  }
  const behaviourGuard = {
    metric: "assembly tree, source-aware picking and property resolution, selected-object detail, and the pinned resident endpoint in every accepted run",
    problems: behaviourProblems,
    met: behaviourProblems.length === 0,
  };

  const reported = { phases: {} };
  for (const phase of experimentPhases) {
    reported.phases[phase] = Object.fromEntries(
      armIds.map((arm) => {
        const samples = memoryRuns(arm)
          .map((run) => (run.samples ?? []).find((sample) => sample.phase === phase))
          .filter((sample) => sample !== undefined);
        const figure = (path) =>
          median(
            samples
              .map((sample) => path.split(".").reduce((node, key) => node?.[key], sample))
              .filter((value) => isByteValue(value)),
          );
        return [arm, {
          workingSetBytes: figure("process.workingSetBytes"),
          privateBytes: figure("process.privateBytes"),
          usedJsHeapBytes: figure("page.usedJsHeapBytes"),
          uaMemoryBytes: figure("page.uaMemoryBytes"),
          decodedBytes: figure("residency.decodedBytes"),
          gpuBytes: figure("residency.gpuBytes"),
        }];
      }),
    );
  }

  return {
    primary,
    timingGuard,
    behaviourGuard,
    reported,
    landed: primary.met && timingGuard.met && behaviourGuard.met,
  };
}
