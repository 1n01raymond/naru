/**
 * Translates between what the Studio holds and what a workspace manifest
 * records.
 *
 * The Studio keys visibility and selection by numeric object id, which is a
 * property of one loaded scene: the loader assigns it from node order, so it
 * does not survive a recompile. A manifest keys them by `occurrenceId`, which
 * does (ADR-0022). Everything in this module is that translation plus the
 * honest reporting that goes with it — an id the manifest names and the
 * reopened scene does not carry is dropped and said to be dropped, never
 * silently ignored.
 *
 * The module is pure and DOM-free apart from reading the bytes of source files
 * the user picked, so the round trip is testable without a renderer.
 */

import {
  workspaceSchemaVersion,
  type ObservedSource,
  type WorkspaceAnnotation,
  type WorkspaceCamera,
  type WorkspaceDocument,
  type WorkspaceObservation,
  type WorkspacePackageReference,
  type WorkspacePackageResource,
  type WorkspaceSection,
  type WorkspaceSource,
  type WorkspaceViewResolution,
} from "@naru3d/workspace";

export interface WorkspaceCaptureInput {
  readonly label: string;
  readonly reference: WorkspacePackageReference;
  readonly packageDigest: string;
  readonly resources: readonly WorkspacePackageResource[];
  readonly sources: readonly WorkspaceSource[];
  readonly camera: WorkspaceCamera;
  readonly section: WorkspaceSection;
  readonly hiddenObjectIds: readonly number[];
  /** Zero means nothing is selected, the value the Studio itself uses. */
  readonly selectedObjectId: number;
  readonly annotations: readonly WorkspaceAnnotation[];
  readonly occurrenceIdOf: (objectId: number) => string | undefined;
}

export interface WorkspaceCapture {
  readonly document: WorkspaceDocument;
  /** Hidden objects the loaded scene carries no occurrence id for. */
  readonly unnamedHiddenObjectIds: readonly number[];
  /** True when a selection existed but could not be named by occurrence. */
  readonly unnamedSelection: boolean;
}

/**
 * Builds the manifest for what is currently open.
 *
 * An empty source list is refused rather than written. `evaluateWorkspaceReopen`
 * reduces source evidence from a `verified` seed, so a workspace naming no
 * source would reopen as `verified` with `geometryIsCurrent` true on package
 * evidence alone — the one claim ADR-0022 exists to prevent.
 */
export function captureWorkspace(input: WorkspaceCaptureInput): WorkspaceCapture {
  if (input.sources.length === 0) {
    throw new TypeError(
      "A workspace must name at least one source; a manifest with none would " +
        "reopen as verified without any source having been checked.",
    );
  }
  const hidden: string[] = [];
  const unnamedHiddenObjectIds: number[] = [];
  for (const objectId of input.hiddenObjectIds) {
    const occurrenceId = input.occurrenceIdOf(objectId);
    if (occurrenceId === undefined) unnamedHiddenObjectIds.push(objectId);
    else hidden.push(occurrenceId);
  }
  const selectedOccurrenceId =
    input.selectedObjectId === 0 ? undefined : input.occurrenceIdOf(input.selectedObjectId);
  return {
    document: {
      schemaVersion: workspaceSchemaVersion,
      label: input.label,
      package: {
        reference: input.reference,
        packageDigest: input.packageDigest,
        resources: input.resources,
      },
      sources: input.sources,
      view: {
        camera: input.camera,
        section: input.section,
        hiddenOccurrenceIds: hidden,
        selectedOccurrenceId: selectedOccurrenceId ?? null,
        annotations: input.annotations,
      },
    },
    unnamedHiddenObjectIds,
    unnamedSelection: input.selectedObjectId !== 0 && selectedOccurrenceId === undefined,
  };
}

export interface StudioObservationInput {
  /** False when the package the manifest names could not be opened at all. */
  readonly packagePresent: boolean;
  readonly packageDigest: string | undefined;
  readonly occurrenceIds: ReadonlySet<string> | undefined;
  /** Present only when the user supplied every source the manifest names. */
  readonly inspectedSources: readonly ObservedSource[] | undefined;
}

/**
 * States what the Studio actually saw.
 *
 * `resources` is deliberately omitted. The Studio verifies the byte length and
 * digest of every range it decodes, but it never hashes a whole binary — the
 * 657 MB package it opens is read in 64 MiB of resident chunks — so it cannot
 * honestly report a whole-resource digest. Omitting the field makes
 * `evaluateWorkspaceReopen` judge the package by its digest alone and mark
 * every resource `unverifiable`, which is exactly what a browser can support:
 * a recompiled or swapped package is detected, a tampered single resource is
 * not claimed either way.
 */
export function observeWorkspace(input: StudioObservationInput): WorkspaceObservation {
  return {
    packagePresent: input.packagePresent,
    packageDigest: input.packageDigest,
    sourceInspection: input.inspectedSources === undefined ? "unavailable" : "available",
    sources: input.inspectedSources,
    occurrenceIds: input.occurrenceIds,
  };
}

export interface RestoredObjects {
  readonly hiddenObjectIds: readonly number[];
  /** Zero when nothing is selected, the value the Studio itself uses. */
  readonly selectedObjectId: number;
  /** Occurrence ids the reopened scene cannot act on, reported not discarded. */
  readonly droppedOccurrenceIds: readonly string[];
  readonly droppedSelection: boolean;
}

/**
 * Turns a resolved view back into the object ids the Studio acts on.
 *
 * `resolveView` has already dropped ids the reopened hierarchy does not carry,
 * so the second lookup here should always succeed. It is still checked,
 * because the set a scene reports and the set its batches carry are produced
 * separately, and a mismatch must be reported rather than throw inside a
 * restore.
 */
export function resolveRestoredObjects(
  view: WorkspaceViewResolution,
  objectIdOf: (occurrenceId: string) => number | undefined,
): RestoredObjects {
  const hiddenObjectIds: number[] = [];
  const dropped = [...view.droppedHiddenOccurrenceIds];
  for (const occurrenceId of view.hiddenOccurrenceIds) {
    const objectId = objectIdOf(occurrenceId);
    if (objectId === undefined) dropped.push(occurrenceId);
    else hiddenObjectIds.push(objectId);
  }
  const selected =
    view.selectedOccurrenceId === null ? undefined : objectIdOf(view.selectedOccurrenceId);
  if (view.selectedOccurrenceId !== null && selected === undefined) {
    dropped.push(view.selectedOccurrenceId);
  }
  return {
    hiddenObjectIds: hiddenObjectIds.sort((left, right) => left - right),
    selectedObjectId: selected ?? 0,
    droppedOccurrenceIds: dropped,
    droppedSelection: view.droppedSelection || (view.selectedOccurrenceId !== null && selected === undefined),
  };
}

/** The part of `File` this module needs, so a test need not construct one. */
export interface ReadableSourceFile {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SourceInspection {
  /** Present only when every source the manifest names was covered exactly once. */
  readonly sources: readonly ObservedSource[] | undefined;
  /** Why inspection is incomplete, in sentences the Studio can show. */
  readonly reasons: readonly string[];
}

async function digestFile(file: ReadableSourceFile): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hashes the source documents the user re-picked, so a reopen can be more than
 * `unverifiable`.
 *
 * The set must cover every source the manifest names. A partial set is refused
 * rather than partly inspected, because an unpicked source would be judged
 * `missing` and report `changed-source` for a file that never moved — a false
 * alarm is as dishonest as a false clean.
 *
 * Files are read one at a time on purpose: a federation source runs to
 * hundreds of megabytes, and hashing needs the whole file in memory.
 */
export async function inspectWorkspaceSources(
  document: WorkspaceDocument,
  files: readonly ReadableSourceFile[],
): Promise<SourceInspection> {
  const reasons: string[] = [];
  const byLabel = new Map<string, ReadableSourceFile[]>();
  for (const file of files) {
    const group = byLabel.get(file.name);
    if (group === undefined) byLabel.set(file.name, [file]);
    else group.push(file);
  }
  const labelCounts = new Map<string, number>();
  for (const source of document.sources) {
    labelCounts.set(source.label, (labelCounts.get(source.label) ?? 0) + 1);
  }

  const observed: ObservedSource[] = [];
  for (const source of document.sources) {
    if ((labelCounts.get(source.label) ?? 0) > 1) {
      reasons.push(
        `This workspace names more than one source called ${source.label}, ` +
          "which cannot be told apart by file name.",
      );
      continue;
    }
    const matches = byLabel.get(source.label) ?? [];
    if (matches.length === 0) {
      reasons.push(`${source.label} was not among the selected files.`);
      continue;
    }
    if (matches.length > 1) {
      reasons.push(`More than one selected file is called ${source.label}.`);
      continue;
    }
    const file = matches[0] as ReadableSourceFile;
    observed.push({ key: source.key, byteLength: file.size, sha256: await digestFile(file) });
  }
  if (reasons.length > 0) {
    return { sources: undefined, reasons };
  }
  return { sources: observed, reasons: [] };
}
