import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createImportJobId,
  createImportJobReporter,
  ImportJobCancelledError,
  importJobEventSchema,
  importJobPlanLength,
  importJobStateRank,
  importJobStates,
  isImportJobCancellation,
  isImportJobTerminalState,
  redactPaths,
  settleImportJobFailure,
  stagedImportPreviewSchema,
} from "../src/import-job.js";
import type {
  ImportJobEvent,
  ImportJobRequest,
  ImportJobStagedPreview,
} from "../src/import-job.js";

const request: ImportJobRequest = {
  kind: "step",
  sources: ["fixtures/step/pygamer.step"],
  outputDirectory: "output/pygamer",
  options: { spatialIndex: true },
};

const completion = {
  packageDigest: "0".repeat(64),
  cache: "disabled",
  prototypeCount: 3,
  renderableOccurrenceCount: 9,
  triangleCount: 120,
} as const;

/** Collects a job's stream, and hands back a reporter wired to it. */
function recordJob(
  overrides: {
    signal?: AbortSignal;
    protectedDirectories?: readonly string[];
  } = {},
) {
  const events: ImportJobEvent[] = [];
  let tick = 0;
  const reporter = createImportJobReporter(
    request,
    {
      onEvent: (event) => events.push(event),
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    },
    overrides.protectedDirectories ?? [],
    () => (tick += 5),
  );
  return { events, reporter };
}

/**
 * Narrows a stream's last event to one terminal shape. The union is
 * discriminated on `state`, so a test that wants a cancellation has to say so.
 */
function terminalEvent<TState extends ImportJobEvent["state"]>(
  events: readonly ImportJobEvent[],
  state: TState,
): Extract<ImportJobEvent, { state: TState }> {
  const event = events.at(-1);
  if (event === undefined) throw new Error("The job emitted no event.");
  if (event.state !== state) {
    throw new Error(`The job ended in ${event.state}, not ${state}.`);
  }
  return event as Extract<ImportJobEvent, { state: TState }>;
}

describe("import job contract", () => {
  it("names one state per lifecycle step and ranks them in order", () => {
    expect([...importJobStates]).toEqual([
      "queued",
      "inspecting",
      "extracting",
      "compiling",
      "verifying",
      "publishing",
      "completed",
      "cancelled",
      "failed",
    ]);
    const working = importJobStates.filter((state) => !isImportJobTerminalState(state));
    const ranks = working.map((state) => importJobStateRank(state));
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(importJobStates.filter((state) => isImportJobTerminalState(state))).toEqual([
      "completed",
      "cancelled",
      "failed",
    ]);
  });

  it("counts a rebuild in six steps and a restore in three", () => {
    expect(importJobPlanLength("rebuild")).toBe(6);
    expect(importJobPlanLength("restore")).toBe(3);
  });
});

describe("import job identity", () => {
  it("derives the same identifier for the same request and a different one otherwise", () => {
    expect(createImportJobId(request)).toBe(createImportJobId({ ...request }));
    expect(createImportJobId(request)).not.toBe(
      createImportJobId({ ...request, sources: ["fixtures/step/other.step"] }),
    );
    expect(createImportJobId(request)).not.toBe(
      createImportJobId({ ...request, options: { spatialIndex: false } }),
    );
  });

  it("ignores the order documents were listed in and drops undefined options", () => {
    const federation: ImportJobRequest = {
      kind: "ifc-federation",
      sources: ["a.ifc", "b.ifc"],
      outputDirectory: "out",
      options: { threads: 6 },
    };
    expect(createImportJobId(federation)).toBe(
      createImportJobId({ ...federation, sources: ["b.ifc", "a.ifc"] }),
    );
    expect(createImportJobId(federation)).toBe(
      createImportJobId({ ...federation, options: { threads: 6, retainSceneIr: undefined } }),
    );
  });

  it("carries no recoverable part of the paths it was derived from", () => {
    const jobId = createImportJobId(request);
    expect(jobId).toMatch(/^[0-9a-f]{16}$/u);
    expect(jobId).not.toContain("pygamer");
    expect(jobId).not.toContain("step");
  });
});

describe("import job progress accounting", () => {
  it("advances one step per rebuild state and reports the whole plan on completion", () => {
    const { events, reporter } = recordJob();
    reporter.settlePlan("rebuild");
    for (const state of ["queued", "inspecting", "extracting", "compiling", "verifying", "publishing"] as const) {
      reporter.enter(state);
    }
    reporter.completed(completion);
    expect(events.map(({ state }) => state)).toEqual([
      "queued",
      "inspecting",
      "extracting",
      "compiling",
      "verifying",
      "publishing",
      "completed",
    ]);
    expect(events.map(({ progress }) => progress.completed)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(events.map(({ progress }) => progress.total))).toEqual(new Set([6]));
  });

  it("never counts past a restore plan that skips three of the six states", () => {
    const { events, reporter } = recordJob();
    reporter.settlePlan("restore");
    reporter.enter("queued");
    reporter.enter("inspecting");
    reporter.enter("verifying");
    reporter.completed(completion);
    expect(events.map(({ progress }) => progress)).toEqual([
      { completed: 0, total: 3 },
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
  });

  it("leaves the total unknown until the cache decision settles the plan", () => {
    const { events, reporter } = recordJob();
    reporter.enter("queued");
    expect(events[0]?.progress.total).toBeNull();
    reporter.settlePlan("rebuild");
    reporter.enter("inspecting");
    expect(events[1]?.progress.total).toBe(6);
  });

  it("refuses a state the settled plan does not contain", () => {
    const { reporter } = recordJob();
    reporter.settlePlan("restore");
    reporter.enter("queued");
    expect(() => reporter.enter("extracting")).toThrow(/settled on the restore plan/u);
  });

  it("refuses to move backwards or to repeat a state", () => {
    const { reporter } = recordJob();
    reporter.enter("compiling");
    expect(() => reporter.enter("extracting")).toThrow(/cannot move from compiling/u);
    expect(() => reporter.enter("compiling")).toThrow(/cannot move from compiling/u);
  });
});

describe("import job event stream", () => {
  it("stamps every event with the schema, the job, a rising sequence, and a monotonic clock", () => {
    const { events, reporter } = recordJob();
    reporter.settlePlan("rebuild");
    reporter.enter("queued");
    reporter.enter("inspecting");
    reporter.completed(completion);
    expect(events.map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
    for (const event of events) {
      expect(event.schemaVersion).toBe(importJobEventSchema);
      expect(event.jobId).toBe(reporter.jobId);
      expect(event.redaction).toBe("no-filesystem-paths");
    }
    const elapsed = events.map(({ elapsedMs }) => elapsedMs);
    expect(elapsed).toEqual([...elapsed].sort((left, right) => left - right));
  });

  it("is machine readable without parsing any prose", () => {
    const { events, reporter } = recordJob();
    reporter.settlePlan("rebuild");
    reporter.enter("queued");
    reporter.completed(completion);
    const parsed = events.map((event) => JSON.parse(JSON.stringify(event)) as ImportJobEvent);
    expect(parsed.at(-1)).toMatchObject({ state: "completed", result: completion });
  });

  it("repeats the documents it was told about on every later event", () => {
    const { events, reporter } = recordJob();
    reporter.enter("queued");
    reporter.describeDocuments([
      { discipline: "architecture", sha256: "a".repeat(64), byteLength: 1024 },
    ]);
    reporter.enter("inspecting");
    expect(events[0]?.documents).toBeUndefined();
    expect(events[1]?.documents).toEqual([
      { discipline: "architecture", sha256: "a".repeat(64), byteLength: 1024 },
    ]);
  });
});

describe("import job redaction", () => {
  it("substitutes the job's own paths first", () => {
    const source = join("home", "someone", "model.step");
    expect(redactPaths(`could not read ${source}`, [source])).toBe("could not read <path>");
  });

  it("also substitutes a path shape it was never told about", () => {
    const windowsPath = win32.join("C:/", "Users", "someone", "Documents", "model.step");
    expect(redactPaths(`missing ${windowsPath}`)).toBe("missing <path>");
    expect(redactPaths("missing /home/someone/model.step")).toBe("missing <path>");
    expect(redactPaths(win32.join("//server", "share", "model.step"))).toBe("<path>");
  });

  it("leaves text that only looks like a path alone", () => {
    expect(redactPaths("ratio 3/4 of the budget")).toBe("ratio 3/4 of the budget");
    expect(redactPaths("expected AP242 schema")).toBe("expected AP242 schema");
  });

  it("keeps a failure message readable while removing the path from it", () => {
    const { events, reporter } = recordJob();
    const executable = win32.join("C:/", "Python313", "python.exe");
    reporter.enter("queued");
    reporter.failed(
      Object.assign(new Error(`Could not start the STEP adapter with ${executable}: ENOENT`), {
        code: "ADAPTER_MISSING",
      }),
      [executable],
    );
    expect(terminalEvent(events, "failed").failure).toEqual({
      code: "ADAPTER_MISSING",
      message: "Could not start the STEP adapter with <path>: ENOENT",
    });
  });

  it("emits no event whose serialized form contains a path it was given", () => {
    const { events, reporter } = recordJob();
    const outputDirectory = win32.join("C:/", "quarry", "atelier", "out");
    reporter.settlePlan("rebuild");
    reporter.enter("queued");
    reporter.describeDocuments([{ sha256: "b".repeat(64), byteLength: 8 }]);
    reporter.enter("inspecting");
    reporter.failed(new Error(`writing ${outputDirectory} failed`), [outputDirectory]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("quarry");
    expect(serialized).not.toContain("atelier");
    expect(serialized).toContain("<path>");
  });
});

describe("import job cancellation", () => {
  it("refuses to announce a state once cancellation is requested", () => {
    const controller = new AbortController();
    const { events, reporter } = recordJob({ signal: controller.signal });
    reporter.settlePlan("rebuild");
    reporter.enter("queued");
    controller.abort();
    expect(() => reporter.enter("inspecting")).toThrow(ImportJobCancelledError);
    expect(events.map(({ state }) => state)).toEqual(["queued"]);
  });

  it("finishes publication rather than leaving a half-written package behind", async () => {
    const controller = new AbortController();
    const { events, reporter } = recordJob({ signal: controller.signal });
    reporter.settlePlan("rebuild");
    reporter.enter("queued");
    reporter.enter("inspecting");
    reporter.enter("extracting");
    reporter.enter("compiling");
    reporter.enter("verifying");
    controller.abort();
    expect(() => reporter.enter("publishing")).not.toThrow();
    reporter.throwIfCancelled();
    await reporter.cancelled();
    expect(events.at(-1)).toMatchObject({
      state: "cancelled",
      cancellation: { cancelledDuring: "publishing", publishedBeforeCancellation: true },
    });
  });

  it("says the result is already durable when a restored entry was cancelled after the fact", async () => {
    const controller = new AbortController();
    const { events, reporter } = recordJob({ signal: controller.signal });
    reporter.settlePlan("restore");
    reporter.enter("queued");
    reporter.notePublishedResult();
    controller.abort();
    await reporter.cancelled();
    expect(terminalEvent(events, "cancelled").cancellation.publishedBeforeCancellation).toBe(
      true,
    );
  });

  it("is idempotent, so a cancel racing a finished compile emits one terminal event", async () => {
    const { events, reporter } = recordJob();
    reporter.enter("queued");
    await reporter.cancelled();
    await reporter.cancelled();
    reporter.failed(new Error("late"));
    expect(events.filter(({ state }) => state === "cancelled")).toHaveLength(1);
    expect(events.map(({ state }) => state)).toEqual(["queued", "cancelled"]);
  });

  it("removes the temporary output it registered and counts what it removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "naru-job-test-"));
    const scratch = join(root, "scratch");
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, "scene-ir.json"), "{}", "utf8");
    const { events, reporter } = recordJob();
    reporter.enter("queued");
    reporter.registerTemporaryDirectory(scratch);
    await reporter.cancelled();
    expect(terminalEvent(events, "cancelled").cancellation.removedTemporaryDirectories).toBe(1);
    await expect(stat(scratch)).rejects.toThrow();
  });

  it("never removes a directory inside a protected root, however it was registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "naru-job-cache-"));
    const cacheDirectory = join(root, "cache");
    const entry = join(cacheDirectory, "entry");
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, "scene.gltf"), "{}", "utf8");
    const { events, reporter } = recordJob({ protectedDirectories: [cacheDirectory] });
    reporter.enter("queued");
    reporter.registerTemporaryDirectory(entry);
    reporter.registerTemporaryDirectory(cacheDirectory);
    await reporter.cancelled();
    expect(terminalEvent(events, "cancelled").cancellation.removedTemporaryDirectories).toBe(0);
    expect((await stat(entry)).isDirectory()).toBe(true);
  });

  it("normalises whatever the killed adapter raised into one cancellation", async () => {
    const controller = new AbortController();
    const { events, reporter } = recordJob({ signal: controller.signal });
    reporter.settlePlan("rebuild");
    reporter.enter("queued");
    reporter.enter("inspecting");
    reporter.enter("extracting");
    controller.abort();
    const settled = await settleImportJobFailure(
      reporter,
      new Error("IFC federation adapter failed: killed."),
      [],
    );
    expect(isImportJobCancellation(settled)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      state: "cancelled",
      cancellation: { cancelledDuring: "extracting" },
    });
    expect(events.some(({ state }) => state === "failed")).toBe(false);
  });

  it("still reports a genuine failure as a failure", async () => {
    const { events, reporter } = recordJob();
    reporter.enter("queued");
    const settled = await settleImportJobFailure(reporter, new Error("adapter failed"), []);
    expect(isImportJobCancellation(settled)).toBe(false);
    expect(events.at(-1)).toMatchObject({ state: "failed", failure: { code: "COMPILE_FAILED" } });
  });
});

describe("import job staged previews", () => {
  const preview: ImportJobStagedPreview = {
    schemaVersion: stagedImportPreviewSchema,
    discipline: "architecture",
    sha256: "a".repeat(64),
    byteLength: 10,
    nodeCount: 2,
    rootCount: 1,
    hierarchy: {
      sha256: "b".repeat(64),
      byteLength: 20,
      columnsSha256: "c".repeat(64),
      columnsByteLength: 8,
    },
    stagedCount: 1,
    totalCount: 1,
  };

  it("announces a staged tree on the state it was reached in without moving the state", () => {
    const { events, reporter } = recordJob();
    reporter.settlePlan("rebuild");
    reporter.enter("queued");
    reporter.enter("inspecting");
    reporter.enter("extracting");
    reporter.staged(preview);
    reporter.enter("compiling");
    expect(events.map(({ state }) => state)).toEqual([
      "queued",
      "inspecting",
      "extracting",
      "extracting",
      "compiling",
    ]);
    expect(events.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]);
    const announcement = events[3];
    if (announcement === undefined || !("staged" in announcement)) throw new Error("unreachable");
    expect(announcement.schemaVersion).toBe(importJobEventSchema);
    expect(announcement.staged).toEqual(preview);
    expect(announcement.progress).toEqual(events[2]?.progress);
    expect(events.filter((event) => "staged" in event && event.staged !== undefined)).toHaveLength(1);
  });

  it("refuses to stage once cancellation is requested or the job has settled", async () => {
    const controller = new AbortController();
    const { reporter } = recordJob({ signal: controller.signal });
    reporter.settlePlan("rebuild");
    reporter.enter("queued");
    reporter.enter("inspecting");
    reporter.enter("extracting");
    controller.abort();
    expect(() => reporter.staged(preview)).toThrow(ImportJobCancelledError);
    await reporter.cancelled();
    expect(() => reporter.staged(preview)).toThrow(TypeError);
  });
});
