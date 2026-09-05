#!/usr/bin/env node

import {
  parseCompileArguments,
  parseIfcCompileArguments,
  usage,
} from "./cli-arguments.js";
import { isImportJobCancellation } from "./import-job.js";
import type { ImportJobEvent, ImportJobOptions } from "./import-job.js";
import { compileStepFile } from "./step-compiler.js";
import { compileIfcFederation } from "./ifc-federation.js";

interface JobConsole {
  readonly job: ImportJobOptions;
  /** Writes one human line, wherever human lines belong for this run. */
  readonly report: (line: string) => void;
  readonly dispose: () => void;
}

/**
 * Wires one run's lifecycle to the terminal.
 *
 * With `--json-events` the event stream owns stdout, one object per line, and
 * every human line moves to stderr so a caller can pipe one and read the other.
 * The first interrupt cancels the job instead of killing the process, which is
 * what lets the compiler stop the adapter it started and discard the temporary
 * output; a second one is not intercepted at all and terminates immediately.
 */
function createJobConsole(jsonEvents: boolean): JobConsole {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const report = (line: string): void => {
    if (jsonEvents) process.stderr.write(`${line}\n`);
    else console.log(line);
  };
  const onEvent = (event: ImportJobEvent): void => {
    if (jsonEvents) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    const { completed, total } = event.progress;
    const step = total === null ? String(completed) : `${completed}/${total}`;
    if (
      event.state !== "completed" &&
      event.state !== "cancelled" &&
      event.state !== "failed" &&
      event.staged
    ) {
      const { staged } = event;
      report(
        `[naru] staged ${staged.discipline} ${staged.stagedCount}/${staged.totalCount} ` +
          `(${staged.nodeCount.toLocaleString("en-US")} nodes)`,
      );
      return;
    }
    report(`[naru] ${event.state} (${step})`);
  };
  return {
    job: { onEvent, signal: controller.signal },
    report,
    dispose: () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}

async function compileStep(argumentList: readonly string[]): Promise<void> {
  const { jsonEvents, ...options } = parseCompileArguments(argumentList);
  const terminal = createJobConsole(jsonEvents);
  try {
    const result = await compileStepFile({ ...options, job: terminal.job });
    terminal.report(
      `[naru] ${result.source.schema} ${result.source.displayName} ` +
        `(${result.source.sha256.slice(0, 12)})`,
    );
    terminal.report(
      `[naru] wrote ${result.report.counts.compiledPrototypeCount} shared meshes, ` +
        `${result.report.counts.renderableOccurrenceCount} renderable occurrences, ` +
        `${result.report.counts.triangleCount.toLocaleString("en-US")} triangles`,
    );
    terminal.report(`[naru] package ${result.report.output.packageDigest}`);
    if (result.cache.status !== "disabled") {
      terminal.report(`[naru] cache ${result.cache.status}: ${String(result.cache.key)}`);
    }
    terminal.report(`[naru] output: ${result.outputDirectory}`);
  } finally {
    terminal.dispose();
  }
}

async function compileIfc(argumentList: readonly string[]): Promise<void> {
  const { jsonEvents, ...options } = parseIfcCompileArguments(argumentList);
  const terminal = createJobConsole(jsonEvents);
  try {
    const result = await compileIfcFederation({ ...options, job: terminal.job });
    terminal.report(
      `[naru] IFC federation ${result.sources.map(({ discipline }) => discipline).join(", ")}`,
    );
    terminal.report(
      `[naru] wrote ${result.report.counts.compiledPrototypeCount} shared meshes, ` +
        `${result.report.counts.renderableOccurrenceCount} renderable occurrences, ` +
        `${result.report.counts.triangleCount.toLocaleString("en-US")} unique triangles`,
    );
    terminal.report(`[naru] package ${result.report.output.packageDigest}`);
    if (result.cache.status !== "disabled") {
      terminal.report(`[naru] cache ${result.cache.status}: ${String(result.cache.key)}`);
    }
    if (result.stagedPreview) {
      terminal.report(
        `[naru] staged preview: ${result.stagedPreview.stagedCount}/${result.stagedPreview.totalCount} documents`,
      );
    }
    terminal.report(`[naru] output: ${result.outputDirectory}`);
  } finally {
    terminal.dispose();
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 0 || arguments_.includes("--help")) {
    console.log(usage);
    process.exitCode = arguments_.includes("--help") ? 0 : 1;
    return;
  }
  if (arguments_[0] === "compile") {
    await compileStep(arguments_.slice(1));
    return;
  }
  if (arguments_[0] === "compile-ifc") {
    await compileIfc(arguments_.slice(1));
    return;
  }
  throw new TypeError(`Unknown command ${String(arguments_[0])}.\n\n${usage}`);
}

try {
  await main();
} catch (error) {
  if (isImportJobCancellation(error)) {
    // 130 is what a shell reports for a job stopped by SIGINT, and a cancel is
    // the outcome the caller asked for rather than a compile that went wrong.
    console.error(`[naru] cancelled while ${error.cancelledDuring}.`);
    process.exitCode = 130;
  } else {
    console.error(
      `[naru] error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
