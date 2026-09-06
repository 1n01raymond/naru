import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isImportJobCancellation } from "../src/import-job.js";
import type { ImportJobEvent } from "../src/import-job.js";
import { compileIfcFederation } from "../src/ifc-federation.js";
import { compileStepFile } from "../src/step-compiler.js";

const sceneTemplatePath = fileURLToPath(
  new URL("../../../artifacts/occt/repeated-fasteners.scene.json", import.meta.url),
);

const identityBlock = `if (process.argv.slice(2).includes("--identity")) {
  console.log(JSON.stringify({
    schemaVersion: "naru.occt-adapter-identity.1",
    name: "test-occt-adapter",
    version: "1.0.0",
    fingerprint: FINGERPRINT,
  }));
  process.exit(0);
}
`;

const stepSource =
  "ISO-10303-21;\nHEADER;\n" +
  "FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'));\n" +
  "ENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";

const ifcSource = stepSource.replace(
  "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF",
  "IFC4",
);

/**
 * An adapter that behaves like the real ones in the way that matters here: it
 * runs for minutes and it starts work of its own. The descendant holds a
 * listening socket, which is how a test can prove it stopped without trusting
 * a process identifier that an operating system is free to reuse.
 */
async function writeSleepingAdapter(
  adapterPath: string,
  descendantPath: string,
  readyPath: string,
  portPath: string,
): Promise<void> {
  await writeFile(
    descendantPath,
    `import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
const server = createServer();
server.listen(0, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(portPath)}, String(server.address().port), "utf8");
});
`,
    "utf8",
  );
  await writeFile(
    adapterPath,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
${identityBlock.replace("FINGERPRINT", JSON.stringify("2".repeat(64)))}
const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
  stdio: "ignore",
});
writeFileSync(${JSON.stringify(readyPath)}, String(descendant.pid), "utf8");
await new Promise(() => {});
`,
    "utf8",
  );
}

/** An adapter that compiles instantly, for the runs that must succeed. */
async function writeWorkingAdapter(adapterPath: string): Promise<void> {
  await writeFile(
    adapterPath,
    `import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
${identityBlock.replace("FINGERPRINT", JSON.stringify("3".repeat(64)))}
const args = process.argv.slice(2);
const sourcePath = args[0];
const option = (name) => args[args.indexOf(name) + 1];
const source = await readFile(sourcePath);
const digest = createHash("sha256").update(source).digest("hex");
const scene = JSON.parse(await readFile(${JSON.stringify(sceneTemplatePath)}, "utf8"));
scene.revision.sourceDigest = "sha256:" + digest;
scene.documents = scene.documents.map((document) => ({
  ...document,
  uriHint: option("--uri-hint"),
  displayName: basename(sourcePath),
  formatVersion: "AP242",
  sourceDigest: "sha256:" + digest,
}));
await writeFile(option("--scene"), JSON.stringify(scene));
await writeFile(option("--report"), JSON.stringify({
  schemaVersion: "test-adapter.1",
  source: {
    path: option("--uri-hint"),
    sha256: digest,
    format: "STEP AP242",
    schemaIdentifiers: ["AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF"],
  },
}));
`,
    "utf8",
  );
}

/** Resolves once `read` returns something, or rejects when patience runs out. */
async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

/** True when nothing holds `port`, which is how a dead descendant looks. */
async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const probe = createServer();
    probe.once("error", () => resolvePromise(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolvePromise(true));
    });
  });
}

const temporaryRoots: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "naru-cancel-test-"));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const directory = temporaryRoots.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

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

describe("cancelling a running import", () => {
  it("stops the adapter and every process it started", async () => {
    const root = await scratchDirectory();
    const sourcePath = join(root, "assembly.step");
    const adapterPath = join(root, "sleeping-adapter.mjs");
    const descendantPath = join(root, "descendant.mjs");
    const readyPath = join(root, "adapter-started");
    const portPath = join(root, "descendant-port");
    const outputDirectory = join(root, "compiled");
    await writeFile(sourcePath, stepSource, "utf8");
    await writeSleepingAdapter(adapterPath, descendantPath, readyPath, portPath);

    const events: ImportJobEvent[] = [];
    const controller = new AbortController();
    const compile = compileStepFile({
      sourcePath,
      outputDirectory,
      pythonExecutable: process.execPath,
      adapterScriptPath: adapterPath,
      job: { onEvent: (event) => events.push(event), signal: controller.signal },
    });

    const port = Number(
      await waitFor("the descendant to listen", async () => {
        if (!existsSync(readyPath) || !existsSync(portPath)) return undefined;
        const text = (await readFile(portPath, "utf8")).trim();
        return text.length > 0 ? text : undefined;
      }),
    );
    expect(await portIsFree(port)).toBe(false);
    expect(events.at(-1)?.state).toBe("extracting");

    controller.abort();
    await expect(compile).rejects.toSatisfy(isImportJobCancellation);

    await waitFor("the descendant to exit", async () =>
      (await portIsFree(port)) ? true : undefined,
    );
    expect(events.at(-1)).toMatchObject({
      state: "cancelled",
      cancellation: { cancelledDuring: "extracting", publishedBeforeCancellation: false },
    });
    expect(existsSync(outputDirectory)).toBe(false);
  }, 60_000);

  it("removes the temporary scene it had extracted into", async () => {
    const root = await scratchDirectory();
    const sourcePath = join(root, "assembly.step");
    const adapterPath = join(root, "sleeping-adapter.mjs");
    const readyPath = join(root, "adapter-started");
    await writeFile(sourcePath, stepSource, "utf8");
    await writeSleepingAdapter(
      adapterPath,
      join(root, "descendant.mjs"),
      readyPath,
      join(root, "descendant-port"),
    );

    const before = new Set(await readdir(tmpdir()));
    const events: ImportJobEvent[] = [];
    const controller = new AbortController();
    const compile = compileStepFile({
      sourcePath,
      outputDirectory: join(root, "compiled"),
      pythonExecutable: process.execPath,
      adapterScriptPath: adapterPath,
      job: { onEvent: (event) => events.push(event), signal: controller.signal },
    });
    await waitFor("the adapter to start", async () =>
      existsSync(readyPath) ? true : undefined,
    );
    controller.abort();
    await expect(compile).rejects.toSatisfy(isImportJobCancellation);

    const survivors = (await readdir(tmpdir())).filter(
      (entry) => entry.startsWith("naru-step-") && !before.has(entry),
    );
    expect(survivors).toEqual([]);
    expect(terminalEvent(events, "cancelled").cancellation.removedTemporaryDirectories).toBe(1);
  }, 60_000);

  it("refuses before the adapter runs when cancellation arrives first", async () => {
    const root = await scratchDirectory();
    const sourcePath = join(root, "assembly.step");
    const adapterPath = join(root, "sleeping-adapter.mjs");
    const readyPath = join(root, "adapter-started");
    await writeFile(sourcePath, stepSource, "utf8");
    await writeSleepingAdapter(
      adapterPath,
      join(root, "descendant.mjs"),
      readyPath,
      join(root, "descendant-port"),
    );

    const events: ImportJobEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(
      compileStepFile({
        sourcePath,
        outputDirectory: join(root, "compiled"),
        pythonExecutable: process.execPath,
        adapterScriptPath: adapterPath,
        job: { onEvent: (event) => events.push(event), signal: controller.signal },
      }),
    ).rejects.toSatisfy(isImportJobCancellation);
    expect(existsSync(readyPath)).toBe(false);
    expect(events.map(({ state }) => state)).toEqual(["cancelled"]);
    expect(terminalEvent(events, "cancelled").cancellation.removedTemporaryDirectories).toBe(0);
  }, 30_000);

  it("cancels once however many times the signal is raised", async () => {
    const root = await scratchDirectory();
    const sourcePath = join(root, "assembly.step");
    const adapterPath = join(root, "sleeping-adapter.mjs");
    const readyPath = join(root, "adapter-started");
    await writeFile(sourcePath, stepSource, "utf8");
    await writeSleepingAdapter(
      adapterPath,
      join(root, "descendant.mjs"),
      readyPath,
      join(root, "descendant-port"),
    );

    const events: ImportJobEvent[] = [];
    const controller = new AbortController();
    const compile = compileStepFile({
      sourcePath,
      outputDirectory: join(root, "compiled"),
      pythonExecutable: process.execPath,
      adapterScriptPath: adapterPath,
      job: { onEvent: (event) => events.push(event), signal: controller.signal },
    });
    await waitFor("the adapter to start", async () =>
      existsSync(readyPath) ? true : undefined,
    );
    controller.abort();
    controller.abort();
    await expect(compile).rejects.toSatisfy(isImportJobCancellation);
    controller.abort();
    expect(events.filter(({ state }) => state === "cancelled")).toHaveLength(1);
    expect(events.at(-1)?.state).toBe("cancelled");
  }, 60_000);
});

describe("what a cancelled import is allowed to touch", () => {
  it("leaves an already verified cache entry exactly as it found it", async () => {
    const root = await scratchDirectory();
    const sourcePath = join(root, "assembly.step");
    const workingAdapter = join(root, "working-adapter.mjs");
    const sleepingAdapter = join(root, "sleeping-adapter.mjs");
    const readyPath = join(root, "adapter-started");
    const cacheDirectory = join(root, "cache");
    await writeFile(sourcePath, stepSource, "utf8");
    await writeWorkingAdapter(workingAdapter);
    await writeSleepingAdapter(
      sleepingAdapter,
      join(root, "descendant.mjs"),
      readyPath,
      join(root, "descendant-port"),
    );

    const first = await compileStepFile({
      sourcePath,
      outputDirectory: join(root, "first"),
      pythonExecutable: process.execPath,
      adapterScriptPath: workingAdapter,
      cacheDirectory,
    });
    expect(first.cache.status).toBe("miss");
    const populated = (await readdir(cacheDirectory, { recursive: true })).sort();
    expect(populated.length).toBeGreaterThan(0);

    const controller = new AbortController();
    const cancelled = compileStepFile({
      sourcePath,
      outputDirectory: join(root, "second"),
      pythonExecutable: process.execPath,
      adapterScriptPath: sleepingAdapter,
      cacheDirectory,
      job: { signal: controller.signal },
    });
    await waitFor("the adapter to start", async () =>
      existsSync(readyPath) ? true : undefined,
    );
    controller.abort();
    await expect(cancelled).rejects.toSatisfy(isImportJobCancellation);

    expect((await readdir(cacheDirectory, { recursive: true })).sort()).toEqual(populated);
    const third = await compileStepFile({
      sourcePath,
      outputDirectory: join(root, "third"),
      pythonExecutable: process.execPath,
      adapterScriptPath: workingAdapter,
      cacheDirectory,
    });
    expect(third.cache.status).toBe("hit");
    expect(third.report.output.packageDigest).toBe(first.report.output.packageDigest);
  }, 90_000);

  it("announces completion only once the package is on disk", async () => {
    const root = await scratchDirectory();
    const sourcePath = join(root, "assembly.step");
    const adapterPath = join(root, "working-adapter.mjs");
    const outputDirectory = join(root, "compiled");
    await writeFile(sourcePath, stepSource, "utf8");
    await writeWorkingAdapter(adapterPath);

    const events: ImportJobEvent[] = [];
    const packageWasWritten: boolean[] = [];
    const result = await compileStepFile({
      sourcePath,
      outputDirectory,
      pythonExecutable: process.execPath,
      adapterScriptPath: adapterPath,
      job: {
        onEvent: (event) => {
          events.push(event);
          if (event.state === "completed") {
            packageWasWritten.push(existsSync(join(outputDirectory, "scene.gltf")));
          }
        },
      },
    });

    expect(packageWasWritten).toEqual([true]);
    expect(events.map(({ state }) => state)).toEqual([
      "queued",
      "inspecting",
      "extracting",
      "compiling",
      "verifying",
      "publishing",
      "completed",
    ]);
    expect(terminalEvent(events, "completed").result).toMatchObject({
      packageDigest: result.report.output.packageDigest,
      cache: "disabled",
    });
    expect((await stat(join(outputDirectory, "scene.bin"))).size).toBeGreaterThan(0);
  }, 60_000);
});

describe("cancelling a federation import", () => {
  it("stops the IFC adapter tree and discards the split it was extracting into", async () => {
    const root = await scratchDirectory();
    const sourcePath = join(root, "architecture.ifc");
    const adapterPath = join(root, "sleeping-ifc-adapter.mjs");
    const readyPath = join(root, "adapter-started");
    const portPath = join(root, "descendant-port");
    await writeFile(sourcePath, ifcSource, "utf8");
    await writeSleepingAdapter(adapterPath, join(root, "descendant.mjs"), readyPath, portPath);

    const before = new Set(await readdir(tmpdir()));
    const events: ImportJobEvent[] = [];
    const controller = new AbortController();
    const compile = compileIfcFederation({
      documents: [{ discipline: "architecture", sourcePath, uriHint: "arc.ifc" }],
      outputDirectory: join(root, "compiled"),
      pythonExecutable: process.execPath,
      adapterScriptPath: adapterPath,
      job: { onEvent: (event) => events.push(event), signal: controller.signal },
    });

    const port = Number(
      await waitFor("the descendant to listen", async () => {
        if (!existsSync(portPath)) return undefined;
        const text = (await readFile(portPath, "utf8")).trim();
        return text.length > 0 ? text : undefined;
      }),
    );
    expect(await portIsFree(port)).toBe(false);
    controller.abort();
    await expect(compile).rejects.toSatisfy(isImportJobCancellation);
    await waitFor("the descendant to exit", async () =>
      (await portIsFree(port)) ? true : undefined,
    );

    expect(events.at(-1)).toMatchObject({
      state: "cancelled",
      cancellation: { cancelledDuring: "extracting", removedTemporaryDirectories: 1 },
    });
    expect(
      (await readdir(tmpdir())).filter(
        (entry) => entry.startsWith("naru-ifc-") && !before.has(entry),
      ),
    ).toEqual([]);
  }, 60_000);
});

/**
 * A sleeping IFC adapter that first publishes a valid structure preview for its
 * one document, the way the real adapter does under `--structure-preview`, and
 * then starts its descendant and sleeps. It lets a test cancel a federation
 * whose tree is already staged.
 */
async function writeStagingSleepingAdapter(
  adapterPath: string,
  descendantPath: string,
  portPath: string,
): Promise<void> {
  await writeFile(
    descendantPath,
    `import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
const server = createServer();
server.listen(0, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(portPath)}, String(server.address().port), "utf8");
});
`,
    "utf8",
  );
  await writeFile(
    adapterPath,
    `import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
${identityBlock
  .replace("naru.occt-adapter-identity.1", "naru.ifc-adapter-identity.1")
  .replace("test-occt-adapter", "IfcOpenShell")
  .replace("FINGERPRINT", JSON.stringify("3".repeat(64)))}
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const documentArgument = option("--document");
const discipline = documentArgument.slice(0, documentArgument.indexOf("="));
const sourcePath = documentArgument.slice(documentArgument.indexOf("=") + 1);
const source = readFileSync(sourcePath);
const previewDirectory = option("--structure-preview");
mkdirSync(previewDirectory, { recursive: true });
const preview = Buffer.from(JSON.stringify({
  schemaVersion: "naru.ifc-structure-preview.1",
  discipline,
  uriHint: "arc.ifc",
  documentId: "document:test",
  sourceDigest: createHash("sha256").update(source).digest("hex"),
  sourceBytes: source.byteLength,
  schema: "IFC4",
  nodes: [
    { id: "a", type: "IfcProject", parent: null, name: "Project" },
    { id: "b", type: "IfcSite", parent: 0, name: "Site" },
  ],
}), "utf8");
const previewFilename = "structure-" + discipline + ".json";
writeFileSync(previewDirectory + "/" + previewFilename, preview);
writeFileSync(previewDirectory + "/index.json", JSON.stringify({
  schemaVersion: "naru.ifc-structure-preview-index.1",
  disciplines: [discipline],
  emissionOrder: [discipline],
  complete: true,
  documents: [{
    discipline,
    path: previewFilename,
    sha256: createHash("sha256").update(preview).digest("hex"),
    byteLength: preview.byteLength,
    nodeCount: 2,
    rootCount: 1,
  }],
}));
spawn(process.execPath, [${JSON.stringify(descendantPath)}], { stdio: "ignore" });
await new Promise(() => {});
`,
    "utf8",
  );
}

describe("cancelling a federation import after a tree was staged", () => {
  it("removes the staged directory with the split, stops the adapter tree, and keeps the cache", async () => {
    const root = await scratchDirectory();
    const sourcePath = join(root, "architecture.ifc");
    const adapterPath = join(root, "staging-ifc-adapter.mjs");
    const portPath = join(root, "descendant-port");
    const stagedDirectory = join(root, "staged");
    const cacheDirectory = join(root, "cache");
    await writeFile(sourcePath, ifcSource, "utf8");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(cacheDirectory, "older-entry"), "verified earlier", "utf8");
    await writeStagingSleepingAdapter(adapterPath, join(root, "descendant.mjs"), portPath);

    const before = new Set(await readdir(tmpdir()));
    const events: ImportJobEvent[] = [];
    const controller = new AbortController();
    const compile = compileIfcFederation({
      documents: [{ discipline: "architecture", sourcePath, uriHint: "arc.ifc" }],
      outputDirectory: join(root, "compiled"),
      pythonExecutable: process.execPath,
      adapterScriptPath: adapterPath,
      cacheDirectory,
      stagedPreviewDirectory: stagedDirectory,
      job: { onEvent: (event) => events.push(event), signal: controller.signal },
    });

    const staged = await waitFor("the tree to be staged", async () =>
      events.find((event) => "staged" in event && event.staged !== undefined),
    );
    if (!("staged" in staged) || staged.staged === undefined) throw new Error("unreachable");
    expect(staged.staged).toMatchObject({
      discipline: "architecture",
      nodeCount: 2,
      rootCount: 1,
      stagedCount: 1,
      totalCount: 1,
    });
    expect(existsSync(join(stagedDirectory, "hierarchy-architecture.json"))).toBe(true);
    expect(existsSync(join(stagedDirectory, "hierarchy-architecture.bin"))).toBe(true);
    const port = Number(
      await waitFor("the descendant to listen", async () => {
        if (!existsSync(portPath)) return undefined;
        const text = (await readFile(portPath, "utf8")).trim();
        return text.length > 0 ? text : undefined;
      }),
    );
    expect(await portIsFree(port)).toBe(false);

    controller.abort();
    await expect(compile).rejects.toSatisfy(isImportJobCancellation);
    await waitFor("the descendant to exit", async () =>
      (await portIsFree(port)) ? true : undefined,
    );

    expect(existsSync(stagedDirectory)).toBe(false);
    expect(existsSync(join(root, "compiled", "scene.gltf"))).toBe(false);
    expect(await readFile(join(cacheDirectory, "older-entry"), "utf8")).toBe("verified earlier");
    expect(events.at(-1)).toMatchObject({
      state: "cancelled",
      cancellation: { cancelledDuring: "extracting", removedTemporaryDirectories: 2 },
    });
    expect(
      (await readdir(tmpdir())).filter(
        (entry) => entry.startsWith("naru-ifc-") && !before.has(entry),
      ),
    ).toEqual([]);
  }, 60_000);
});
