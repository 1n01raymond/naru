// The versioned import-job lifecycle: states, ordering, progress, cancellation.
//
// A host that embeds NARU cannot watch a compile by scraping `[naru]` prose. It
// needs a stream it can parse, a promise that the stream only moves forward,
// and a cancel that actually stops the native adapter. This module owns that
// contract; the two compilers only report into it.
//
// Two rules shape everything here. Progress is counted in lifecycle states, not
// estimated from source size, because nothing measures how long tessellating an
// unseen document takes. And every event is scrubbed of filesystem paths before
// it leaves, because an import event may cross a trust boundary that the source
// document never should.

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const importJobEventSchema = "naru.import-job-event.2";

/** Schema of the staged preview a job may announce while it is still extracting. */
export const stagedImportPreviewSchema = "naru.staged-import-preview.2";

/**
 * Lifecycle states in their only legal order. A job announces a state when it
 * begins that state, may skip states, and never revisits one.
 *
 * `extracting` and `compiling` are skipped when a verified cache entry answers
 * the request. `publishing` is skipped on that same path because restoring an
 * entry verifies every resource and places the directory in one atomic
 * primitive, so there is no separate publication to announce.
 */
export const importJobStates = [
  "queued",
  "inspecting",
  "extracting",
  "compiling",
  "verifying",
  "publishing",
  "completed",
  "cancelled",
  "failed",
] as const;

export type ImportJobState = (typeof importJobStates)[number];

export type ImportJobTerminalState = "completed" | "cancelled" | "failed";

const terminalStates: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

/** Rank within the progression. All three terminal states share the last rank. */
const stateRank: ReadonlyMap<ImportJobState, number> = new Map([
  ["queued", 0],
  ["inspecting", 1],
  ["extracting", 2],
  ["compiling", 3],
  ["verifying", 4],
  ["publishing", 5],
  ["completed", 6],
  ["cancelled", 6],
  ["failed", 6],
]);

export function importJobStateRank(state: ImportJobState): number {
  return stateRank.get(state) ?? -1;
}

export function isImportJobTerminalState(
  state: ImportJobState,
): state is ImportJobTerminalState {
  return terminalStates.has(state);
}

/** The path a job takes once its cache decision is settled. */
export type ImportJobPlan = "rebuild" | "restore";

const planStates: Readonly<Record<ImportJobPlan, readonly ImportJobState[]>> = {
  rebuild: ["queued", "inspecting", "extracting", "compiling", "verifying", "publishing"],
  restore: ["queued", "inspecting", "verifying"],
};

/** How many lifecycle steps a job on this plan reports. */
export function importJobPlanLength(plan: ImportJobPlan): number {
  return planStates[plan].length;
}

/** A source document as an event may describe it: identity, never content. */
export interface ImportJobDocument {
  /** Host-supplied federation label. Absent for a single STEP source. */
  readonly discipline?: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ImportJobProgress {
  /** Lifecycle states already finished. Never decreases within a job. */
  readonly completed: number;
  /**
   * States this job will pass through in total, or `null` while the remaining
   * path is undetermined. It counts steps; it is never an estimate derived from
   * source size, which nothing here measures.
   */
  readonly total: number | null;
}

export interface ImportJobCompletion {
  readonly packageDigest: string;
  readonly cache: string;
  readonly prototypeCount: number;
  readonly renderableOccurrenceCount: number;
  readonly triangleCount: number;
}

export interface ImportJobCancellation {
  /** The state the job was in when cancellation was observed. */
  readonly cancelledDuring: ImportJobState;
  readonly removedTemporaryDirectories: number;
  /**
   * True when the signal arrived during publication. Publication is not
   * interruptible, so the durable result exists and only the job is cancelled.
   */
  readonly publishedBeforeCancellation: boolean;
}

export interface ImportJobFailure {
  readonly code: string;
  /** Redacted the same way every other event field is. */
  readonly message: string;
}

/**
 * One document's hierarchy, verified and published to the staged directory
 * while the adapter is still extracting the federation. Identity, digests, and
 * counts only: the location of the staged directory is the caller's, never the
 * event's, so the payload stays path-free like every other field.
 */
export interface ImportJobStagedPreview {
  readonly schemaVersion: typeof stagedImportPreviewSchema;
  readonly discipline: string;
  /** The source document this tree was read from, as `documents` names it. */
  readonly sha256: string;
  readonly byteLength: number;
  readonly nodeCount: number;
  readonly rootCount: number;
  /** The `naru.package-hierarchy.1` pair a reader verifies before parsing. */
  readonly hierarchy: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly columnsSha256: string;
    readonly columnsByteLength: number;
  };
  /** Documents staged so far, including this one, out of the federation. */
  readonly stagedCount: number;
  readonly totalCount: number;
}

export interface ImportJobEventBase {
  readonly schemaVersion: typeof importJobEventSchema;
  /** Stable across repeated runs of the same request. */
  readonly jobId: string;
  /** Gapless and zero-based, so a host can detect a dropped event. */
  readonly sequence: number;
  /** Monotonic milliseconds since the job began. */
  readonly elapsedMs: number;
  readonly progress: ImportJobProgress;
  /** Names the policy every field of this event passed through. */
  readonly redaction: "no-filesystem-paths";
  readonly documents?: readonly ImportJobDocument[];
}

export type ImportJobEvent =
  | (ImportJobEventBase & {
      readonly state: Exclude<ImportJobState, ImportJobTerminalState>;
      /**
       * Present on the one kind of event that repeats its state: a staged
       * preview announced without the job moving on. Sequence stays gapless and
       * progress is unchanged, because staging is not a lifecycle step.
       */
      readonly staged?: ImportJobStagedPreview;
    })
  | (ImportJobEventBase & {
      readonly state: "completed";
      readonly result: ImportJobCompletion;
    })
  | (ImportJobEventBase & {
      readonly state: "cancelled";
      readonly cancellation: ImportJobCancellation;
    })
  | (ImportJobEventBase & {
      readonly state: "failed";
      readonly failure: ImportJobFailure;
    });

export type ImportJobListener = (event: ImportJobEvent) => void;

/** Thrown by a compiler whose job was cancelled. */
export class ImportJobCancelledError extends Error {
  readonly code = "IMPORT_CANCELLED";
  readonly cancelledDuring: ImportJobState;

  constructor(cancelledDuring: ImportJobState) {
    super(`Import cancelled during ${cancelledDuring}.`);
    this.name = "ImportJobCancelledError";
    this.cancelledDuring = cancelledDuring;
  }
}

export function isImportJobCancellation(error: unknown): error is ImportJobCancelledError {
  return error instanceof ImportJobCancelledError;
}

/**
 * Absolute filesystem paths, in the three shapes the compilers actually emit:
 * a Windows drive path, a UNC or extended-length path, and a POSIX path of at
 * least two segments. They are a backstop. The reliable defence is substituting
 * the job's own known paths, which happens first.
 */
const absolutePathPatterns: readonly RegExp[] = [
  /\\\\[^\s"',;)\]]+/gu,
  /[A-Za-z]:[\\/][^\s"',;)\]]*/gu,
  /(?<![\w:/])\/(?:[\w.@+-]+\/)+[\w.@+-]*/gu,
];

/**
 * Replaces the job's own paths, then anything else path-shaped, with `<path>`.
 * Adapter failures quote the interpreter and the file it could not read, so a
 * failure message is the one place a path reliably reaches an event.
 */
export function redactPaths(text: string, knownPaths: readonly string[] = []): string {
  let result = text;
  const literals = [...new Set(knownPaths.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  for (const literal of literals) {
    result = result.split(literal).join("<path>");
    const alternate = literal.includes("\\") ? literal.split("\\").join("/") : undefined;
    if (alternate !== undefined && alternate !== literal) {
      result = result.split(alternate).join("<path>");
    }
  }
  for (const pattern of absolutePathPatterns) {
    result = result.replace(pattern, "<path>");
  }
  return result;
}

/**
 * A stable identity for one import request. The same request run twice reports
 * the same job, which makes an event stream reproducible in a test and lets a
 * host correlate a retry with what it retried. The inputs are hashed, so the
 * identifier carries no recoverable path.
 */
export interface ImportJobRequest {
  readonly kind: "step" | "ifc-federation";
  /** Source documents, resolved and sorted before hashing. */
  readonly sources: readonly string[];
  readonly outputDirectory: string;
  /** Options that change the result. Undefined values are dropped. */
  readonly options?: Readonly<Record<string, unknown>>;
}

export function createImportJobId(request: ImportJobRequest): string {
  const canonical = JSON.stringify([
    request.kind,
    request.sources.map((source) => resolve(source)).sort(),
    resolve(request.outputDirectory),
    Object.entries(request.options ?? {})
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/** What a caller passes to give a compile a lifecycle. All parts are optional. */
export interface ImportJobOptions {
  /** Overrides the identifier derived from the request. */
  readonly jobId?: string;
  readonly onEvent?: ImportJobListener;
  readonly signal?: AbortSignal;
}

interface ImportJobReporterOptions extends ImportJobOptions {
  readonly jobId: string;
  /** Monotonic clock. Injected so a test can assert exact elapsed values. */
  readonly now?: () => number;
  /**
   * Directories cancellation must never remove, whatever is registered with it.
   * A configured cache lives here: its entries are verified and durable, and a
   * cancelled job has no business deleting one.
   */
  readonly protectedDirectories?: readonly string[];
}

/**
 * Drives one job's event stream. The compilers hold one of these and call
 * `enter` at each boundary; everything else about ordering, progress counting,
 * redaction, and cancellation timing is decided here.
 */
export class ImportJobReporter {
  readonly jobId: string;

  readonly #listener: ImportJobListener | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #protected: readonly string[];
  readonly #temporaryDirectories = new Set<string>();

  #sequence = 0;
  #elapsed = 0;
  #state: ImportJobState = "queued";
  #completedStates = 0;
  #total: number | null = null;
  #documents: readonly ImportJobDocument[] | undefined;
  #plan: ImportJobPlan | undefined;
  #publishing = false;
  #settled = false;

  constructor(options: ImportJobReporterOptions) {
    this.jobId = options.jobId;
    this.#listener = options.onEvent;
    this.#signal = options.signal;
    this.#now = options.now ?? (() => performance.now());
    this.#startedAt = this.#now();
    this.#protected = (options.protectedDirectories ?? []).map((directory) =>
      resolve(directory),
    );
  }

  get state(): ImportJobState {
    return this.#state;
  }

  /** True once the signal has fired, whether or not it has been acted on. */
  get cancellationRequested(): boolean {
    return this.#signal?.aborted === true;
  }

  /** Identity of the documents this job reads, for every later event. */
  describeDocuments(documents: readonly ImportJobDocument[]): void {
    this.#documents = documents;
  }

  /** Fixes the step total once the cache decision has chosen a path. */
  settlePlan(plan: ImportJobPlan): void {
    if (this.#plan !== undefined && this.#plan !== plan) {
      throw new TypeError(`Import job ${this.jobId} already settled on the ${this.#plan} plan.`);
    }
    this.#plan = plan;
    this.#total = importJobPlanLength(plan);
  }

  registerTemporaryDirectory(directory: string): void {
    this.#temporaryDirectories.add(resolve(directory));
  }

  /**
   * Records that a durable result exists although no `publishing` state was
   * announced. The restore plan uses it: a cache entry is placed by one atomic
   * primitive, so there is no publication step to report, but a cancel from
   * here on must still say the output is there.
   */
  notePublishedResult(): void {
    this.#publishing = true;
  }

  /**
   * Throws if cancellation has been requested. Called before each state is
   * announced so a cancelled job never reports work it will not do. Inside the
   * publication section it does nothing: see `enter`.
   */
  throwIfCancelled(): void {
    if (this.cancellationRequested && !this.#publishing) {
      throw new ImportJobCancelledError(this.#state);
    }
  }

  /**
   * Announces a state.
   *
   * Entering `publishing` opens an uninterruptible section. From there the job
   * finishes writing and verifying its output, because observing a cancel
   * midway through publication is the one way to leave a half-written package
   * on disk. A cancel requested during publication is honoured afterwards, and
   * the cancellation event says the durable result already exists.
   */
  enter(state: Exclude<ImportJobState, ImportJobTerminalState>): void {
    if (state !== "publishing") this.throwIfCancelled();
    this.#advanceTo(state);
    if (state === "publishing") this.#publishing = true;
    this.#emit({});
  }

  /**
   * Announces a staged preview without leaving the current state. This is the
   * only event that repeats a state, and it may only do so while the job is
   * still running: a settled job has nothing left to stage.
   */
  staged(preview: ImportJobStagedPreview): void {
    if (this.#settled) {
      throw new TypeError(
        `Import job ${this.jobId} already reached ${this.#state} and cannot stage a preview.`,
      );
    }
    this.throwIfCancelled();
    this.#emit({ staged: preview });
  }

  /** Announces success. Only legal after the result is durable and verified. */
  completed(result: ImportJobCompletion): void {
    this.#advanceTo("completed");
    this.#emit({ result });
  }

  /**
   * Removes every registered temporary directory, then announces cancellation.
   * Idempotent: a second call on a settled job is a no-op, so a cancel racing a
   * finished compile cannot produce a second terminal event.
   */
  async cancelled(cancelledDuring: ImportJobState = this.#state): Promise<void> {
    if (this.#settled) return;
    const removedTemporaryDirectories = await this.discardTemporaryOutput();
    const publishedBeforeCancellation = this.#publishing;
    this.#advanceTo("cancelled");
    this.#emit({
      cancellation: {
        cancelledDuring,
        removedTemporaryDirectories,
        publishedBeforeCancellation,
      },
    });
  }

  /** Announces failure, with the message redacted like every other field. */
  failed(error: unknown, knownPaths: readonly string[] = []): void {
    if (this.#settled) return;
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "COMPILE_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    this.#advanceTo("failed");
    this.#emit({ failure: { code, message: redactPaths(message, knownPaths) } });
  }

  /**
   * Removes the temporary directories this job registered and returns how many
   * it removed. A directory inside a protected root is left alone: cancelling
   * an import must never cost a host an entry it had already verified.
   */
  async discardTemporaryOutput(): Promise<number> {
    let removed = 0;
    for (const directory of this.#temporaryDirectories) {
      if (this.#isProtected(directory)) continue;
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    this.#temporaryDirectories.clear();
    return removed;
  }

  /** True when `directory` is a protected root or sits underneath one. */
  #isProtected(directory: string): boolean {
    return this.#protected.some((root) => {
      const offset = relative(root, directory);
      return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
    });
  }

  #advanceTo(state: ImportJobState): void {
    if (this.#settled) {
      throw new TypeError(
        `Import job ${this.jobId} already reached ${this.#state} and cannot enter ${state}.`,
      );
    }
    const next = importJobStateRank(state);
    const current = importJobStateRank(this.#state);
    if (next < current || (next === current && this.#sequence > 0)) {
      throw new TypeError(
        `Import job ${this.jobId} cannot move from ${this.#state} to ${state}.`,
      );
    }
    const plan = this.#plan;
    if (plan !== undefined && !isImportJobTerminalState(state) && !planStates[plan].includes(state)) {
      throw new TypeError(
        `Import job ${this.jobId} settled on the ${plan} plan and cannot enter ${state}.`,
      );
    }
    this.#completedStates = this.#progressFor(state);
    this.#state = state;
    this.#settled = isImportJobTerminalState(state);
  }

  /**
   * Steps finished on entering `state`. A job that reaches `completed` reports
   * every step of its plan; one that cancels or fails keeps the count it had,
   * because the steps it never ran did not become finished by stopping.
   */
  #progressFor(state: ImportJobState): number {
    if (isImportJobTerminalState(state)) {
      return state === "completed" && this.#total !== null
        ? this.#total
        : this.#completedStates;
    }
    const plan = this.#plan;
    if (plan === undefined) return importJobStateRank(state);
    const index = planStates[plan].indexOf(state);
    return index < 0 ? this.#completedStates : index;
  }

  #emit(extra: {
    readonly result?: ImportJobCompletion;
    readonly cancellation?: ImportJobCancellation;
    readonly failure?: ImportJobFailure;
    readonly staged?: ImportJobStagedPreview;
  }): void {
    // Clamped so a non-monotonic clock cannot make elapsed time run backwards.
    const elapsedMs = Math.max(this.#elapsed, Math.round(this.#now() - this.#startedAt));
    this.#elapsed = elapsedMs;
    const event = {
      schemaVersion: importJobEventSchema,
      jobId: this.jobId,
      sequence: this.#sequence,
      elapsedMs,
      state: this.#state,
      progress: { completed: this.#completedStates, total: this.#total },
      redaction: "no-filesystem-paths",
      ...(this.#documents === undefined ? {} : { documents: this.#documents }),
      ...extra,
    } as ImportJobEvent;
    this.#sequence += 1;
    this.#listener?.(event);
  }
}

/** Builds a reporter, deriving the job identifier when the caller supplied none. */
export function createImportJobReporter(
  request: ImportJobRequest,
  options: ImportJobOptions | undefined,
  protectedDirectories: readonly string[] = [],
  now?: () => number,
): ImportJobReporter {
  return new ImportJobReporter({
    ...options,
    jobId: options?.jobId ?? createImportJobId(request),
    protectedDirectories,
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * Reports a compile that ended badly and returns the error its caller should
 * throw.
 *
 * A cancelled job is normalised here: whatever the adapter or the filesystem
 * raised once the process tree was killed, the caller sees one
 * `ImportJobCancelledError`, and the event stream ends in `cancelled` rather
 * than `failed`. The function is safe to call on a job that already settled,
 * which is what makes cancellation idempotent under a race.
 */
export async function settleImportJobFailure(
  reporter: ImportJobReporter,
  error: unknown,
  knownPaths: readonly string[],
): Promise<unknown> {
  if (isImportJobCancellation(error)) {
    await reporter.cancelled(error.cancelledDuring);
    return error;
  }
  if (reporter.cancellationRequested) {
    const cancelledDuring = reporter.state;
    await reporter.cancelled(cancelledDuring);
    return new ImportJobCancelledError(cancelledDuring);
  }
  reporter.failed(error, knownPaths);
  return error;
}
