/**
 * Reopening a workspace is a decision, not a fetch. This module is pure: it
 * compares what a manifest recorded against what the host could actually
 * observe, and reports one state per part plus one state for the whole.
 *
 * The rule the states exist to enforce is that stale geometry is never
 * labelled current. A part the host could not inspect is `unverifiable`, which
 * is a distinct outcome from `verified` and never collapses into it.
 */

import type {
  WorkspaceAnnotation,
  WorkspaceCamera,
  WorkspaceDocument,
  WorkspaceSection,
} from "./document.js";

export type WorkspaceEvidenceState = "verified" | "changed" | "missing" | "unverifiable";

export type WorkspaceReopenState =
  | "verified"
  | "changed-source"
  | "changed-package"
  | "unverifiable"
  | "blocked";

export interface ObservedResource {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ObservedSource {
  readonly key: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * What the host managed to see. A browser can always verify the package it
 * just loaded; it can verify a source only when the embedder grants a
 * source-inspection capability, which is why the two halves are separate.
 */
export interface WorkspaceObservation {
  /** False when the package could not be opened at all. */
  readonly packagePresent: boolean;
  readonly packageDigest?: string | undefined;
  readonly resources?: readonly ObservedResource[] | undefined;
  /** True when `resources` is the reopened package's complete resource list. */
  readonly resourcesComplete?: boolean | undefined;
  /** `unavailable` means the host cannot inspect sources, not that none moved. */
  readonly sourceInspection: "available" | "unavailable";
  readonly sources?: readonly ObservedSource[] | undefined;
  /** Occurrence ids the reopened hierarchy actually carries, when known. */
  readonly occurrenceIds?: ReadonlySet<string> | undefined;
}

export interface WorkspaceResourceVerdict {
  readonly path: string;
  readonly state: WorkspaceEvidenceState;
}

export interface WorkspacePackageVerdict {
  readonly state: WorkspaceEvidenceState;
  readonly expectedDigest: string;
  readonly observedDigest: string | null;
  readonly resources: readonly WorkspaceResourceVerdict[];
}

export interface WorkspaceSourceVerdict {
  readonly key: string;
  readonly label: string;
  readonly state: WorkspaceEvidenceState;
}

export interface WorkspaceViewResolution {
  readonly camera: WorkspaceCamera;
  readonly section: WorkspaceSection;
  readonly hiddenOccurrenceIds: readonly string[];
  readonly droppedHiddenOccurrenceIds: readonly string[];
  readonly selectedOccurrenceId: string | null;
  readonly droppedSelection: boolean;
  /** Notes are anchored to world points, so none is ever dropped. */
  readonly annotations: readonly WorkspaceAnnotation[];
  /** False when no hierarchy was supplied, so nothing could be dropped. */
  readonly resolvedAgainstHierarchy: boolean;
}

export interface WorkspaceReopenDecision {
  readonly state: WorkspaceReopenState;
  /** True only when every part was inspected and every part matched. */
  readonly geometryIsCurrent: boolean;
  readonly package: WorkspacePackageVerdict;
  readonly sources: readonly WorkspaceSourceVerdict[];
  readonly view: WorkspaceViewResolution;
}

const evidenceSeverity: Record<WorkspaceEvidenceState, number> = {
  verified: 0,
  unverifiable: 1,
  changed: 2,
  missing: 3,
};

function worst(
  left: WorkspaceEvidenceState,
  right: WorkspaceEvidenceState,
): WorkspaceEvidenceState {
  return evidenceSeverity[right] > evidenceSeverity[left] ? right : left;
}

function judgePackage(
  document: WorkspaceDocument,
  observation: WorkspaceObservation,
): WorkspacePackageVerdict {
  const expectedDigest = document.package.packageDigest;
  const observedDigest = observation.packageDigest ?? null;

  if (!observation.packagePresent) {
    return {
      state: "missing",
      expectedDigest,
      observedDigest,
      resources: document.package.resources.map((resource) => ({
        path: resource.path,
        state: "missing" as const,
      })),
    };
  }

  const observed = observation.resources;
  if (observed === undefined) {
    const state: WorkspaceEvidenceState =
      observedDigest === null
        ? "unverifiable"
        : observedDigest === expectedDigest
          ? "verified"
          : "changed";
    return {
      state,
      expectedDigest,
      observedDigest,
      resources: document.package.resources.map((resource) => ({
        path: resource.path,
        state: "unverifiable" as const,
      })),
    };
  }

  const byPath = new Map(observed.map((resource) => [resource.path, resource]));
  const resources = document.package.resources.map((resource) => {
    const match = byPath.get(resource.path);
    if (match === undefined) {
      return { path: resource.path, state: "missing" as const };
    }
    const same = match.byteLength === resource.byteLength && match.sha256 === resource.sha256;
    return { path: resource.path, state: same ? ("verified" as const) : ("changed" as const) };
  });

  let state = resources.reduce<WorkspaceEvidenceState>(
    (carried, resource) => worst(carried, resource.state),
    "verified",
  );
  if (observation.resourcesComplete === true && observed.length > document.package.resources.length) {
    state = worst(state, "changed");
  }
  if (observedDigest !== null) {
    state = worst(state, observedDigest === expectedDigest ? "verified" : "changed");
  } else if (observation.resourcesComplete !== true) {
    state = worst(state, "unverifiable");
  }
  return { state, expectedDigest, observedDigest, resources };
}

function judgeSources(
  document: WorkspaceDocument,
  observation: WorkspaceObservation,
): WorkspaceSourceVerdict[] {
  if (observation.sourceInspection === "unavailable") {
    return document.sources.map((source) => ({
      key: source.key,
      label: source.label,
      state: "unverifiable" as const,
    }));
  }
  const byKey = new Map((observation.sources ?? []).map((source) => [source.key, source]));
  return document.sources.map((source) => {
    const match = byKey.get(source.key);
    if (match === undefined) {
      return { key: source.key, label: source.label, state: "missing" as const };
    }
    const same = match.byteLength === source.byteLength && match.sha256 === source.sha256;
    return {
      key: source.key,
      label: source.label,
      state: same ? ("verified" as const) : ("changed" as const),
    };
  });
}

function resolveView(
  document: WorkspaceDocument,
  observation: WorkspaceObservation,
): WorkspaceViewResolution {
  const known = observation.occurrenceIds;
  if (known === undefined) {
    return {
      camera: document.view.camera,
      section: document.view.section,
      hiddenOccurrenceIds: document.view.hiddenOccurrenceIds,
      droppedHiddenOccurrenceIds: [],
      selectedOccurrenceId: document.view.selectedOccurrenceId,
      droppedSelection: false,
      annotations: document.view.annotations,
      resolvedAgainstHierarchy: false,
    };
  }
  const retained: string[] = [];
  const dropped: string[] = [];
  for (const id of document.view.hiddenOccurrenceIds) {
    (known.has(id) ? retained : dropped).push(id);
  }
  const selected = document.view.selectedOccurrenceId;
  const selectionSurvives = selected !== null && known.has(selected);
  return {
    camera: document.view.camera,
    section: document.view.section,
    hiddenOccurrenceIds: retained,
    droppedHiddenOccurrenceIds: dropped,
    selectedOccurrenceId: selectionSurvives ? selected : null,
    droppedSelection: selected !== null && !selectionSurvives,
    annotations: document.view.annotations,
    resolvedAgainstHierarchy: true,
  };
}

/**
 * Decide what a reopened workspace is entitled to claim.
 *
 * Precedence, worst first: a package that cannot be opened blocks the reopen;
 * a moved source outranks a moved package because the source is the source of
 * truth (ADR-0002); anything uninspected leaves the reopen unverifiable. Only
 * a reopen where every part was inspected and every part matched reports
 * `verified`, and only that reopen may call its geometry current.
 */
export function evaluateWorkspaceReopen(
  document: WorkspaceDocument,
  observation: WorkspaceObservation,
): WorkspaceReopenDecision {
  const packageVerdict = judgePackage(document, observation);
  const sources = judgeSources(document, observation);
  const view = resolveView(document, observation);

  const sourceState = sources.reduce<WorkspaceEvidenceState>(
    (carried, source) => worst(carried, source.state),
    "verified",
  );

  let state: WorkspaceReopenState;
  if (packageVerdict.state === "missing") {
    state = "blocked";
  } else if (sourceState === "changed" || sourceState === "missing") {
    state = "changed-source";
  } else if (packageVerdict.state === "changed") {
    state = "changed-package";
  } else if (packageVerdict.state === "unverifiable" || sourceState === "unverifiable") {
    state = "unverifiable";
  } else {
    state = "verified";
  }

  return {
    state,
    geometryIsCurrent: state === "verified",
    package: packageVerdict,
    sources,
    view,
  };
}
