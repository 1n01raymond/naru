import {
  CompiledGltfError,
  NaruWebGpuError,
  NaruWebGpuRenderer,
  PackageTransport,
  resolveFallbackDepthOffset,
} from "@naru3d/runtime-webgpu";
import type {
  CompiledHierarchy,
  CompiledObjectEvidence,
  CompiledTargetChunk,
  DecodedCompiledScene,
  GeometryRepresentation,
  SpatialDemandPriority,
} from "@naru3d/runtime-webgpu";

import { resolveDefaultSceneUrl } from "./default-scene.js";
import { GeometryDecoder } from "./geometry-decoder.js";
import type { GeometryDecodeResult } from "./geometry-decoder.js";
import { HierarchyListView } from "./hierarchy-list.js";
import {
  clearMemoryDataset,
  packageRetentionBytes,
  packageRetentionDataset,
  publishMemoryDataset,
  rendererMemoryDataset,
} from "./memory-ledger.js";
import { HierarchySearchIndex } from "./hierarchy-search.js";
import type { HierarchySearchResult } from "./hierarchy-search.js";
import { AxisSectionPlane } from "./section-plane.js";
import type { SectionAxis } from "./section-plane.js";
import {
  loadSceneHierarchy,
  parseSceneUrl,
  selectLocalSceneFiles,
} from "./scene-source.js";
import type { GeometryBinarySource, SceneSource } from "./scene-source.js";
import { formatPropertyValue, PropertySidecarStore } from "./property-sidecar.js";
import { loadSpatialDemandIndex } from "./spatial-demand-source.js";
import { OrthographicOrbitCamera } from "./view.js";
import { hiddenHierarchyNodeIndices, OccurrenceVisibility } from "./visibility.js";
import type { ResidencyVisibilityUpdate } from "./visibility.js";
import {
  defaultProgressiveResidencyBudget,
  ProgressiveResidency,
} from "./progressive-residency.js";
import {
  CameraTargetScheduler,
  SpatialTargetChunkViewIndex,
  TargetChunkViewIndex,
} from "./view-priority-scheduler.js";
import type {
  RankedTargetChunk,
  TargetSchedulerEvent,
} from "./view-priority-scheduler.js";
import {
  evaluateWorkspaceReopen,
  parseWorkspace,
  serializeWorkspace,
} from "@naru3d/workspace";
import type {
  ObservedSource,
  WorkspaceDocument,
  WorkspaceEvidenceState,
  WorkspacePackageReference,
  WorkspaceReopenDecision,
  WorkspaceSection,
  WorkspaceSourceVerdict,
  WorkspaceViewResolution,
} from "@naru3d/workspace";
import { readPackageIdentity } from "./package-identity.js";
import type { PackageIdentity, PackageReportSource } from "./package-identity.js";
import {
  captureWorkspace,
  inspectWorkspaceSources,
  observeWorkspace,
  resolveRestoredObjects,
} from "./workspace-session.js";
import type { RestoredObjects, WorkspaceCapture } from "./workspace-session.js";
import faviconUrl from "../../../docs/media/naru-favicon.svg?url";
import inverseMarkUrl from "../../../docs/media/naru-mark-inverse.svg?url";

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`The NARU runtime page is missing ${selector}.`);
  return element;
}

function setText(selector: string, value: string): void {
  requireElement<HTMLElement>(selector).textContent = value;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} KiB`;
}

function residencyBudgetFromLocation(): number {
  const value = new URL(window.location.href).searchParams.get("residencyMiB");
  if (value === null) return defaultProgressiveResidencyBudget;
  const mebibytes = Number(value);
  if (!Number.isFinite(mebibytes) || mebibytes < 4 || mebibytes > 1024) {
    throw new RangeError("residencyMiB must be between 4 and 1024.");
  }
  return Math.round(mebibytes * 1024 * 1024);
}

/**
 * Clip-space depth pushed onto coarse fallback proxies so resident target
 * detail wins a shared plane. `?fallbackDepthOffset=0` disables it for an A/B
 * comparison; the default is the renderer's.
 */
function fallbackDepthOffsetFromLocation(): number {
  const value = new URL(window.location.href).searchParams.get("fallbackDepthOffset");
  return resolveFallbackDepthOffset(value === null ? undefined : Number(value));
}

/**
 * Which demanded chunk the scheduler asks for first. The default keeps the
 * recorded behavior; `screen-coverage` is the opt-in ADR-0008 policy that
 * ranks by projected area, which only differs once the residency budget binds.
 */
function demandPriorityFromLocation(): SpatialDemandPriority {
  const value = new URL(window.location.href).searchParams.get("demandPriority");
  if (value === null) return "screen-distance";
  if (value !== "screen-distance" && value !== "screen-coverage") {
    throw new RangeError("demandPriority must be screen-distance or screen-coverage.");
  }
  return value;
}

function binarySourceForChunk(
  source: GeometryBinarySource,
  chunk: CompiledTargetChunk,
): GeometryBinarySource {
  return {
    ...source,
    byteOffset: chunk.byteOffset,
    byteLength: chunk.byteLength,
  };
}

function residencyInstanceFilter(
  coarseInstanceTargetMeshIndexes: Uint32Array,
  residentTargetMeshIndexes: readonly number[],
): (batchIndex: number, instanceIndex: number) => boolean {
  const residentTargets = new Set(residentTargetMeshIndexes);
  return (batchIndex, instanceIndex) =>
    batchIndex !== 0 ||
    !residentTargets.has(coarseInstanceTargetMeshIndexes[instanceIndex] ?? -1);
}

function occurrenceVisibilityForResidency(
  scene: DecodedCompiledScene["gpuScene"],
  coarseInstanceTargetMeshIndexes: Uint32Array | undefined,
  residentTargetMeshIndexes: readonly number[],
): OccurrenceVisibility {
  if (!coarseInstanceTargetMeshIndexes) return new OccurrenceVisibility(scene);
  return new OccurrenceVisibility(
    scene,
    residencyInstanceFilter(coarseInstanceTargetMeshIndexes, residentTargetMeshIndexes),
  );
}

/**
 * Rebuilds only what an admission or eviction changed: reused batch tables are
 * carried by object identity, the aggregate coarse batch (index 0) recomputes
 * its promotion mask, and user hide/isolate state transfers without a rescan.
 */
function occurrenceVisibilityResidencyUpdate(
  previous: OccurrenceVisibility,
  scene: DecodedCompiledScene["gpuScene"],
  coarseInstanceTargetMeshIndexes: Uint32Array | undefined,
  residentTargetMeshIndexes: readonly number[],
): ResidencyVisibilityUpdate {
  if (!coarseInstanceTargetMeshIndexes) {
    return OccurrenceVisibility.forResidencyUpdate(previous, scene);
  }
  return OccurrenceVisibility.forResidencyUpdate(
    previous,
    scene,
    residencyInstanceFilter(coarseInstanceTargetMeshIndexes, residentTargetMeshIndexes),
    [0],
  );
}

function targetChunkByPrototype(
  hierarchy: CompiledHierarchy,
): ReadonlyMap<string, CompiledTargetChunk> {
  const chunks = new Map<string, CompiledTargetChunk>();
  for (const chunk of hierarchy.targetChunks) {
    for (const prototypeId of chunk.prototypeIds) {
      if (chunks.has(prototypeId)) {
        throw new Error(`Prototype ${prototypeId} belongs to multiple target chunks.`);
      }
      chunks.set(prototypeId, chunk);
    }
  }
  return chunks;
}

const canvas = requireElement<HTMLCanvasElement>("#viewport");
const status = requireElement<HTMLElement>("#status");
const selection = requireElement<HTMLElement>("#selection");
const hierarchyList = requireElement<HTMLOListElement>("#hierarchy");
const hierarchySearchInput = requireElement<HTMLInputElement>("#hierarchy-search");
const hierarchySearchResult = requireElement<HTMLElement>("#hierarchy-search-result");
const hierarchyEmpty = requireElement<HTMLElement>("#hierarchy-empty");
const propertiesPanel = requireElement<HTMLElement>("#properties-panel");
const propertiesEmpty = requireElement<HTMLElement>("#properties-empty");
const propertiesContent = requireElement<HTMLElement>("#properties-content");
const propertyName = requireElement<HTMLElement>("#property-name");
const propertyVisibility = requireElement<HTMLElement>("#property-visibility");
const propertyOccurrence = requireElement<HTMLElement>("#property-occurrence");
const propertyPrototype = requireElement<HTMLElement>("#property-prototype");
const propertyNode = requireElement<HTMLElement>("#property-node");
const propertyObjectId = requireElement<HTMLElement>("#property-object-id");
const propertySourceRef = requireElement<HTMLElement>("#property-source-ref");
const propertyEdgeCount = requireElement<HTMLElement>("#property-edge-count");
const propertyEdgeRefs = requireElement<HTMLUListElement>("#property-edge-refs");
const semanticPropertyCount = requireElement<HTMLElement>("#semantic-property-count");
const semanticPropertyStatus = requireElement<HTMLElement>("#semantic-property-status");
const semanticPropertyEntries = requireElement<HTMLDListElement>("#semantic-property-entries");
const visibilityStatus = requireElement<HTMLElement>("#visibility-status");
const hideSelectionButton = requireElement<HTMLButtonElement>("#hide-selection");
const isolateSelectionButton = requireElement<HTMLButtonElement>("#isolate-selection");
const showAllButton = requireElement<HTMLButtonElement>("#show-all");
const toggleSectionButton = requireElement<HTMLButtonElement>("#toggle-section");
const sectionControls = requireElement<HTMLElement>("#section-controls");
const sectionPosition = requireElement<HTMLInputElement>("#section-position");
const sectionPositionValue = requireElement<HTMLOutputElement>("#section-position-value");
const sectionDirection = requireElement<HTMLElement>("#section-direction");
const flipSectionButton = requireElement<HTMLButtonElement>("#flip-section");
const sectionAxisButtons = document.querySelectorAll<HTMLButtonElement>("[data-section-axis]");
const sceneSourceKind = requireElement<HTMLElement>("#scene-source-kind");
const sceneSourceLabel = requireElement<HTMLElement>("#scene-source-label");
const sceneUrlForm = requireElement<HTMLFormElement>("#scene-url-form");
const sceneUrlInput = requireElement<HTMLInputElement>("#scene-url");
const openSceneUrlButton = requireElement<HTMLButtonElement>("#open-scene-url");
const localSceneFiles = requireElement<HTMLInputElement>("#local-scene-files");
const localSceneButton = requireElement<HTMLElement>(".local-scene-button");
const openDemoSceneButton = requireElement<HTMLButtonElement>("#open-demo-scene");
const openPygamerSceneButton = requireElement<HTMLButtonElement>("#open-pygamer-scene");
const cancelSceneLoadButton = requireElement<HTMLButtonElement>("#cancel-scene-load");
const saveWorkspaceButton = requireElement<HTMLButtonElement>("#save-workspace");
const workspaceFileInput = requireElement<HTMLInputElement>("#workspace-file");
const workspaceSourcesInput = requireElement<HTMLInputElement>("#workspace-sources");
const workspaceStatus = requireElement<HTMLElement>("#workspace-status");
const workspaceKind = requireElement<HTMLElement>("#workspace-kind");
const configuredDefaultSceneUrl: unknown = import.meta.env.VITE_NARU_DEFAULT_SCENE_URL;
const defaultSceneUrl = resolveDefaultSceneUrl(
  {
    baseUrl: import.meta.env.BASE_URL,
    configuredPackageUrl: configuredDefaultSceneUrl,
  },
  window.location.href,
);
const pygamerSceneUrl = new URL(
  `${import.meta.env.BASE_URL}pygamer/scene.gltf`,
  window.location.href,
);
requireElement<HTMLLinkElement>("#naru-favicon").href = faviconUrl;
requireElement<HTMLImageElement>("#naru-brand-mark").src = inverseMarkUrl;

let disposeActiveScene: (() => void) | undefined;
let cancelPendingSceneLoad: (() => void) | undefined;

/**
 * What the open scene lets a workspace do.
 *
 * The Studio holds one of these per loaded package. Every closure it carries
 * belongs to that load, so replacing a scene replaces the session outright
 * rather than leaving stale ids behind.
 */
interface StudioWorkspaceSession {
  readonly reference: WorkspacePackageReference;
  readonly label: string;
  /** Memoized: the reports are read once per load, never on the load path. */
  identity(): Promise<PackageIdentity | { readonly reason: string }>;
  occurrenceIds(): ReadonlySet<string>;
  /** Isolation has no field in `naru.workspace.1`, so a save must say so. */
  isolatedObjectId(): number | undefined;
  capture(identity: PackageIdentity): WorkspaceCapture;
  restore(view: WorkspaceViewResolution): RestoredObjects;
}

let workspaceSession: StudioWorkspaceSession | undefined;
/** Parsed but not yet applied, because its package is still opening. */
let pendingWorkspace: WorkspaceDocument | undefined;
/** Applied against the open package, so re-checking sources can re-decide. */
let activeWorkspace: WorkspaceDocument | undefined;
/** Present only when the user supplied every source the manifest names. */
let inspectedWorkspaceSources: readonly ObservedSource[] | undefined;

function setSourceControlsBusy(busy: boolean): void {
  openSceneUrlButton.disabled = busy;
  sceneUrlInput.disabled = busy;
  localSceneFiles.disabled = busy;
  openDemoSceneButton.disabled = busy;
  openPygamerSceneButton.disabled = busy;
  cancelSceneLoadButton.hidden = !busy;
  cancelSceneLoadButton.disabled = !busy;
  if (busy) localSceneButton.dataset.disabled = "true";
  else delete localSceneButton.dataset.disabled;
  workspaceFileInput.disabled = busy;
  saveWorkspaceButton.disabled = busy || workspaceSession === undefined;
  workspaceSourcesInput.disabled =
    busy || (activeWorkspace ?? pendingWorkspace) === undefined;
  document.documentElement.dataset.sceneLoading = String(busy);
}

function resetSceneUi(): void {
  delete document.documentElement.dataset.coarseReady;
  delete document.documentElement.dataset.targetReady;
  delete document.documentElement.dataset.geometryRepresentation;
  delete document.documentElement.dataset.targetChunksReady;
  delete document.documentElement.dataset.targetChunksTotal;
  delete document.documentElement.dataset.residencyBudgetReached;
  delete document.documentElement.dataset.residentDecodedBytes;
  delete document.documentElement.dataset.residentGpuBytes;
  delete document.documentElement.dataset.residencyBudgetBytes;
  delete document.documentElement.dataset.selectionResidency;
  delete document.documentElement.dataset.evictedTargetMeshCount;
  delete document.documentElement.dataset.targetSchedulerRequests;
  delete document.documentElement.dataset.targetSchedulerCancellations;
  delete document.documentElement.dataset.targetSchedulerSkips;
  delete document.documentElement.dataset.targetSchedulerSkippedChunk;
  delete document.documentElement.dataset.targetSchedulerChunk;
  delete document.documentElement.dataset.targetSchedulerPriority;
  delete document.documentElement.dataset.targetSchedulerDemandPriority;
  delete document.documentElement.dataset.fallbackDepthOffset;
  delete document.documentElement.dataset.targetSchedulerCancelledChunk;
  delete document.documentElement.dataset.targetSchedulerOrder;
  delete document.documentElement.dataset.targetSchedulerDemand;
  delete document.documentElement.dataset.targetSchedulerMode;
  delete document.documentElement.dataset.spatialNodesVisited;
  delete document.documentElement.dataset.spatialNodesTotal;
  delete document.documentElement.dataset.spatialLeavesVisible;
  delete document.documentElement.dataset.spatialLeavesTotal;
  delete document.documentElement.dataset.spatialOccurrencesTested;
  delete document.documentElement.dataset.spatialOccurrencesTotal;
  delete document.documentElement.dataset.spatialCandidateChunks;
  delete document.documentElement.dataset.spatialQueryMilliseconds;
  delete document.documentElement.dataset.workspaceState;
  delete document.documentElement.dataset.workspaceGeometryCurrent;
  delete document.documentElement.dataset.workspacePackage;
  delete document.documentElement.dataset.workspaceSources;
  delete document.documentElement.dataset.workspaceSourceInspection;
  delete document.documentElement.dataset.workspaceHiddenOccurrences;
  delete document.documentElement.dataset.workspaceDroppedOccurrences;
  delete document.documentElement.dataset.workspaceDroppedSelection;
  delete document.documentElement.dataset.workspaceSelectedObject;
  delete document.documentElement.dataset.workspaceSaved;
  workspaceSession = undefined;
  activeWorkspace = undefined;
  saveWorkspaceButton.disabled = true;
  workspaceKind.textContent = "WORKSPACE";
  delete workspaceStatus.dataset.state;
  workspaceStatus.textContent =
    pendingWorkspace === undefined
      ? "Open a package to save a workspace."
      : `Reopening ${pendingWorkspace.label}…`;
  clearMemoryDataset();
  hierarchySearchInput.value = "";
  hierarchySearchResult.textContent = "Waiting for hierarchy";
  hierarchyEmpty.hidden = true;
  hierarchyList.replaceChildren();
  propertiesEmpty.hidden = false;
  propertiesContent.hidden = true;
  selection.textContent = "No occurrence selected.";
  visibilityStatus.textContent = "Waiting for occurrences";
  hideSelectionButton.disabled = true;
  isolateSelectionButton.disabled = true;
  showAllButton.disabled = true;
  toggleSectionButton.setAttribute("aria-pressed", "false");
  sectionControls.hidden = true;
  for (const selector of ["#triangle-count", "#edge-count", "#decode-time", "#gpu-adapter"]) {
    setText(selector, "—");
  }
  for (const selector of ["#stage-hierarchy", "#stage-geometry", "#stage-webgpu"]) {
    const stage = requireElement<HTMLElement>(selector);
    delete stage.dataset.state;
  }
}

async function loadScene(source: SceneSource): Promise<boolean> {
  setSourceControlsBusy(true);
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort();
  cancelPendingSceneLoad = cancel;
  let pendingCleanup: (() => void) | undefined;
  try {
    status.textContent = "Loading compiled glTF hierarchy…";
    status.dataset.state = "loading";
    const loaded = await loadSceneHierarchy(source, cancellation.signal);
    const { hierarchy } = loaded;
    const chunksByPrototype = targetChunkByPrototype(hierarchy);
    const residencyBudget = residencyBudgetFromLocation();
    disposeActiveScene?.();
    disposeActiveScene = undefined;
    resetSceneUi();
    sceneSourceKind.textContent =
      source.kind === "local"
        ? "LOCAL"
        : source.gltfUrl.href === defaultSceneUrl.href
          ? "DEMO"
          : source.gltfUrl.href === pygamerSceneUrl.href
            ? "STEP"
            : "URL";
    sceneSourceLabel.textContent = loaded.label;
    sceneSourceLabel.title = loaded.label;
    document.documentElement.dataset.sceneSource = source.kind;
    const interactions = cancellation;
    pendingCleanup = () => interactions.abort();
    const geometryDecoder = new GeometryDecoder(
      loaded.documentSource,
      interactions.signal,
      loaded.transport,
    );
    const listenerOptions = { signal: interactions.signal };
    const hierarchyView = new HierarchyListView(hierarchyList, hierarchy.entries, {
      signal: interactions.signal,
    });
    const searchIndex = new HierarchySearchIndex(hierarchy.entries);
    let activeSearch: HierarchySearchResult;
    const applyHierarchySearch = (): void => {
      activeSearch = searchIndex.search(hierarchySearchInput.value);
      hierarchyView.setFilter(
        activeSearch.visibleNodeIndices,
        new Set(activeSearch.matchingNodeIndices),
      );
      const matches = activeSearch.matchingNodeIndices.length;
      hierarchySearchResult.textContent = activeSearch.query
        ? `${matches} ${matches === 1 ? "match" : "matches"}`
        : `${hierarchy.entries.length} nodes`;
      hierarchyEmpty.hidden = activeSearch.visibleNodeIndices.length !== 0;
      document.documentElement.dataset.hierarchyMatches = String(matches);
    };
    hierarchySearchInput.addEventListener("input", applyHierarchySearch, listenerOptions);
    applyHierarchySearch();
    setText("#prototype-count", String(hierarchy.sharedMeshes));
    setText("#occurrence-count", String(hierarchy.renderableOccurrences));
    setText("#source-format", hierarchy.sourceFormat);
    setText("#binary-size", formatBytes(hierarchy.binaryByteLength));
    setText("#hierarchy-result", `${hierarchy.entries.length} occurrence records ready`);
    requireElement<HTMLElement>("#stage-hierarchy").dataset.state = "ready";
    document.documentElement.dataset.hierarchyReady = "true";
    publishMemoryDataset(packageRetentionDataset(packageRetentionBytes(loaded)));
    status.textContent =
      `Hierarchy ready · ${hierarchy.entries.length} occurrences · ` +
      `decoding ${formatBytes(hierarchy.binaryByteLength)} in Worker…`;
    status.dataset.stage = "hierarchy";

    const renderer = await NaruWebGpuRenderer.create(canvas, {
      onDeviceLost: (message) => {
        status.textContent = `WebGPU device lost: ${message}`;
        status.dataset.state = "error";
      },
      fallbackDepthOffset: fallbackDepthOffsetFromLocation(),
    });
    document.documentElement.dataset.fallbackDepthOffset = String(renderer.fallbackDepthOffset);
    const adapterInfo = renderer.adapter.info;
    setText(
      "#gpu-adapter",
      adapterInfo.description || adapterInfo.vendor || "WebGPU adapter",
    );
    let animationFrame = 0;
    const sessionResources: {
      resizeObserver?: ResizeObserver;
      targetScheduler?: CameraTargetScheduler<GeometryDecodeResult>;
    } = {};
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      interactions.abort();
      sessionResources.resizeObserver?.disconnect();
      sessionResources.targetScheduler?.stop();
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
      geometryDecoder.dispose();
      renderer.destroy();
    };
    pendingCleanup = dispose;
    disposeActiveScene = dispose;
    const initialRepresentation: GeometryRepresentation = loaded.coarseBinary
      ? "coarse"
      : "target";
    const initial = await geometryDecoder.decode(
      loaded.coarseBinary ?? loaded.targetBinary,
      initialRepresentation,
    ).catch((error: unknown) => {
      dispose();
      throw error;
    });
    let scene = initial.scene;
    let decodeMilliseconds = initial.decodeMilliseconds;
    let residentDecodedBytes: number | undefined;
    let residentGpuBytes: number | undefined;
    const progressiveResidency =
      initialRepresentation === "coarse" && hierarchy.targetChunks.length > 0
        ? new ProgressiveResidency(scene, {
            decodedBytes: residencyBudget,
            gpuBytes: residencyBudget,
          }, {
            aggregateCoarse: initial.coarseInstanceTargetMeshIndexes !== undefined,
          })
        : undefined;
    if (progressiveResidency) {
      renderer.reconcileBatches(
        progressiveResidency.current().entries.map(({ key, batch, representation }) => ({
          key,
          batch,
          representation,
        })),
        { sharedObjectIdsAcrossBatches: true },
      );
    } else {
      renderer.setScene(scene.gpuScene);
    }

    const camera = new OrthographicOrbitCamera(scene.bounds);
    let updateTargetView = (_frame: ReturnType<OrthographicOrbitCamera["frame"]>): void => {};
    let cameraChanged = false;
    const render = (): void => {
      animationFrame = 0;
      const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
      const frame = camera.frame(aspect);
      document.documentElement.dataset.cameraOrigin = frame.origin.join(",");
      renderer.render(frame.viewProjection, { cameraOrigin: frame.origin });
      if (cameraChanged) {
        cameraChanged = false;
        updateTargetView(frame);
      }
    };
    const scheduleRender = (): void => {
      if (animationFrame === 0) animationFrame = requestAnimationFrame(render);
    };
    const scheduleCameraRender = (): void => {
      cameraChanged = true;
      scheduleRender();
    };
    render();

    if (initialRepresentation === "coarse") {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      document.documentElement.dataset.coarseReady = "true";
      publishMemoryDataset(rendererMemoryDataset(renderer.resourceStats()));
      document.documentElement.dataset.geometryRepresentation = "coarse";
      status.textContent =
        `Coarse bounds ready · ${scene.summary.partOccurrences} renderable occurrences · ` +
        `loading ${formatBytes(hierarchy.binaryByteLength)} target geometry…`;
      status.dataset.stage = "coarse";
      setText("#triangle-count", scene.summary.triangles.toLocaleString("en-US"));
      setText("#edge-count", scene.summary.edgeSegments.toLocaleString("en-US"));
      setText("#decode-time", `${decodeMilliseconds.toFixed(1)} ms`);
      setText("#geometry-result", `${formatBytes(scene.summary.binaryBytes)} coarse bounds decoded off-thread`);
      requireElement<HTMLElement>("#stage-geometry").dataset.state = "ready";
      requireElement<HTMLElement>("#stage-webgpu").dataset.state = "ready";

      if (hierarchy.targetChunks.length === 0) {
        const target = await geometryDecoder.decode(
          loaded.targetBinary,
          "target",
        ).catch((error: unknown) => {
          dispose();
          throw error;
        });
        scene = target.scene;
        decodeMilliseconds += target.decodeMilliseconds;
        renderer.setScene(scene.gpuScene);
        render();
      } else {
        if (!progressiveResidency) throw new Error("Missing progressive residency state.");
        document.documentElement.dataset.targetChunksTotal = String(
          hierarchy.targetChunks.length,
        );
        document.documentElement.dataset.residencyBudgetBytes = String(
          residencyBudget,
        );
        document.documentElement.dataset.targetChunksReady = "0";
        document.documentElement.dataset.targetReady = "loading";
      }
    }

    if (!progressiveResidency) {
      document.documentElement.dataset.geometryRepresentation = "target";
      document.documentElement.dataset.targetReady = "true";
      status.textContent =
        `Compiled glTF ready · ${scene.summary.prototypeBatches} shared meshes · ` +
        `${scene.summary.partOccurrences} renderable occurrences`;
      status.dataset.state = "ready";
      status.dataset.stage = "rendered";
    }
    setText("#triangle-count", scene.summary.triangles.toLocaleString("en-US"));
    setText("#edge-count", scene.summary.edgeSegments.toLocaleString("en-US"));
    setText("#decode-time", `${decodeMilliseconds.toFixed(1)} ms`);
    setText(
      "#geometry-result",
      residentDecodedBytes === undefined || residentGpuBytes === undefined
        ? `${formatBytes(scene.summary.binaryBytes)} decoded off-thread`
        : `${formatBytes(residentDecodedBytes)} CPU / ${formatBytes(residentGpuBytes)} GPU resident ` +
          `(budget ${formatBytes(residencyBudget)})`,
    );
    requireElement<HTMLElement>("#stage-geometry").dataset.state = "ready";
    requireElement<HTMLElement>("#stage-webgpu").dataset.state = "ready";
    const evidence = new Map(scene.objectEvidence.map((entry) => [entry.objectId, entry]));
    const evidenceByNode = new Map(scene.objectEvidence.map((entry) => [entry.nodeIndex, entry]));
    const objectIdByOccurrence = new Map(
      scene.objectEvidence.map((entry) => [entry.occurrenceId, entry.objectId]),
    );
    let visibility = occurrenceVisibilityForResidency(
      scene.gpuScene,
      progressiveResidency ? initial.coarseInstanceTargetMeshIndexes : undefined,
      progressiveResidency?.current().targetMeshIndexes ?? [],
    );
    const section = new AxisSectionPlane(scene.bounds);
    let selectedObjectId = 0;

    const propertyStore = loaded.properties
      ? new PropertySidecarStore(loaded.properties)
      : undefined;
    let semanticPropertyRequest = 0;

    const setSemanticPropertyStatus = (
      state: "absent" | "loading" | "error",
      message: string,
    ): void => {
      semanticPropertyStatus.hidden = false;
      semanticPropertyStatus.dataset.state = state;
      semanticPropertyStatus.textContent = message;
    };

    const renderSemanticProperties = (picked: CompiledObjectEvidence | undefined): void => {
      const request = ++semanticPropertyRequest;
      semanticPropertyCount.textContent = "";
      semanticPropertyEntries.hidden = true;
      semanticPropertyEntries.replaceChildren();
      if (!picked) return;
      if (!propertyStore) {
        setSemanticPropertyStatus("absent", "This package carries no property sidecar.");
        return;
      }
      const semanticId = picked.semanticId;
      if (!semanticId) {
        setSemanticPropertyStatus("absent", "This occurrence has no semantic reference.");
        return;
      }
      setSemanticPropertyStatus("loading", "Loading property sidecar…");
      propertyStore
        .entriesFor(semanticId)
        .then((resolved) => {
          if (request !== semanticPropertyRequest) return;
          if (!resolved) {
            setSemanticPropertyStatus("absent", "No property rows for this occurrence.");
            return;
          }
          semanticPropertyStatus.hidden = true;
          semanticPropertyCount.textContent =
            `· ${resolved.entries.length.toLocaleString("en-US")}` +
            (resolved.schema === undefined ? "" : ` · ${resolved.schema}`);
          const fragment = document.createDocumentFragment();
          for (const [key, value] of resolved.entries) {
            const row = document.createElement("div");
            const term = document.createElement("dt");
            term.textContent = key;
            term.title = key;
            const definition = document.createElement("dd");
            definition.textContent = formatPropertyValue(value);
            row.append(term, definition);
            fragment.append(row);
          }
          semanticPropertyEntries.replaceChildren(fragment);
          semanticPropertyEntries.hidden = false;
        })
        .catch((error: unknown) => {
          if (request !== semanticPropertyRequest) return;
          setSemanticPropertyStatus(
            "error",
            error instanceof Error ? error.message : "Failed to load the property sidecar.",
          );
        });
    };

    const updateProperties = (picked: CompiledObjectEvidence | undefined): void => {
      propertiesEmpty.hidden = Boolean(picked);
      propertiesContent.hidden = !picked;
      propertiesPanel.dataset.state = picked ? "selected" : "empty";
      document.documentElement.dataset.selectedObjectId = String(picked?.objectId ?? 0);
      renderSemanticProperties(picked);
      if (!picked) return;

      const isVisible = visibility.isVisible(picked.objectId);
      propertyName.textContent = picked.label;
      propertyVisibility.textContent = isVisible ? "Visible" : "Hidden";
      if (isVisible) delete propertyVisibility.dataset.hidden;
      else propertyVisibility.dataset.hidden = "true";
      propertyOccurrence.textContent = picked.occurrenceId;
      propertyPrototype.textContent = picked.prototypeId;
      propertyNode.textContent = String(picked.nodeIndex);
      propertyObjectId.textContent = String(picked.objectId);
      propertySourceRef.textContent = picked.sourceRef ?? "Not provided";
      propertyEdgeCount.textContent = picked.edgeSourceRefs.length.toLocaleString("en-US");

      const fragment = document.createDocumentFragment();
      for (const sourceRef of picked.edgeSourceRefs.slice(0, 3)) {
        const item = document.createElement("li");
        item.textContent = sourceRef;
        item.title = sourceRef;
        fragment.append(item);
      }
      if (picked.edgeSourceRefs.length === 0) {
        const item = document.createElement("li");
        item.textContent = "No edge references in the compiled profile.";
        fragment.append(item);
      } else if (picked.edgeSourceRefs.length > 3) {
        const item = document.createElement("li");
        item.dataset.summary = "true";
        item.textContent = `+ ${picked.edgeSourceRefs.length - 3} more`;
        fragment.append(item);
      }
      propertyEdgeRefs.replaceChildren(fragment);
    };

    const updateSelectionText = (): void => {
      const picked = evidence.get(selectedObjectId);
      selection.textContent = picked
        ? `Selected ${picked.label} · node ${picked.nodeIndex} · ID ${selectedObjectId} · ` +
          `${picked.edgeSourceRefs.length} CAD edge refs` +
          (visibility.isVisible(selectedObjectId) ? "" : " · hidden")
        : "No occurrence at that pixel.";
      updateProperties(picked);
    };

    const updateVisibilityControls = (): void => {
      const state = visibility.state();
      visibilityStatus.textContent =
        state.mode === "all"
          ? `${state.visibleOccurrences} / ${state.totalOccurrences} visible`
          : state.mode === "isolated"
            ? `${state.visibleOccurrences} / ${state.totalOccurrences} visible · isolated`
            : `${state.visibleOccurrences} / ${state.totalOccurrences} visible · ` +
              `${state.hiddenOccurrences} hidden`;
      hideSelectionButton.disabled =
        selectedObjectId === 0 || !visibility.isVisible(selectedObjectId);
      isolateSelectionButton.disabled =
        selectedObjectId === 0 || state.isolatedObjectId === selectedObjectId;
      showAllButton.disabled = state.mode === "all";
      document.documentElement.dataset.visibilityMode = state.mode;
      document.documentElement.dataset.visibleOccurrences = String(state.visibleOccurrences);
    };

    const applyVisibility = ({
      syncHierarchy = true,
      changedBatchIndexes,
    }: {
      syncHierarchy?: boolean;
      changedBatchIndexes?: readonly number[];
    } = {}): void => {
      renderer.updateVisibleInstances(
        visibility.indicesByBatch,
        visibility.counts,
        changedBatchIndexes,
      );
      if (syncHierarchy) {
        hierarchyView.setHiddenNodeIndices(
          hiddenHierarchyNodeIndices(scene.objectEvidence, (objectId) =>
            visibility.isVisible(objectId),
          ),
        );
      }
      updateSelectionText();
      updateVisibilityControls();
      scheduleRender();
    };

    const coarseScene = initial.scene;
    let decodedTargetBytes = 0;
    // Normalized at capture so the re-throw below stays a real Error.
    let schedulerFailure: Error | undefined;
    let schedulerRequests = 0;
    let schedulerCancellations = 0;
    let schedulerSkips = 0;
    let finalizePending = false;
    // A selection promotion pauses the scheduler and stamps its own terminal
    // status; a finalize resolving inside that window would overwrite the
    // "loading selected detail" message with a ready state.
    let selectionPromotionInFlight = false;
    let spatialViewIndex: SpatialTargetChunkViewIndex | undefined;
    const residentChunkCount = (): number => {
      if (!progressiveResidency) return 0;
      return hierarchy.targetChunks.filter((chunk) =>
        progressiveResidency.hasTargetMeshes(chunk.meshIndexes),
      ).length;
    };
    const applyPromotion = (
      promotion: ReturnType<ProgressiveResidency["promote"]>,
      target: GeometryDecodeResult,
    ): void => {
      scene = {
        ...scene,
        gpuScene: {
          batches: promotion.entries.map(({ batch }) => batch),
          sharedObjectIdsAcrossBatches: true,
        },
        batchEvidence: promotion.entries.map(({ evidence }, batchIndex) => ({
          ...evidence,
          batchIndex,
        })),
        summary: {
          ...scene.summary,
          prototypeBatches: promotion.entries.length,
          triangles: promotion.triangles,
          edgeSegments: promotion.edgeSegments,
          representation: "target",
        },
      };
      renderer.reconcileBatches(
        promotion.entries.map(({ key, batch, representation }) => ({
          key,
          batch,
          representation,
        })),
        { sharedObjectIdsAcrossBatches: true },
      );
      const visibilityUpdate = occurrenceVisibilityResidencyUpdate(
        visibility,
        scene.gpuScene,
        initial.coarseInstanceTargetMeshIndexes,
        promotion.targetMeshIndexes,
      );
      visibility = visibilityUpdate.visibility;
      decodeMilliseconds += target.decodeMilliseconds;
      decodedTargetBytes += target.scene.summary.binaryBytes;
      residentDecodedBytes = promotion.decodedBytes;
      residentGpuBytes = promotion.gpuBytes;
      const readyChunks = residentChunkCount();
      document.documentElement.dataset.targetChunksReady = String(readyChunks);
      document.documentElement.dataset.residentDecodedBytes = String(promotion.decodedBytes);
      document.documentElement.dataset.residentGpuBytes = String(renderer.residentGpuBytes);
      publishMemoryDataset(rendererMemoryDataset(renderer.resourceStats()));
      document.documentElement.dataset.geometryRepresentation =
        readyChunks === hierarchy.targetChunks.length ? "target" : "mixed";
      document.documentElement.dataset.targetReady =
        readyChunks === hierarchy.targetChunks.length ? "true" : "loading";
      status.textContent =
        `View-priority target detail ${readyChunks}/${hierarchy.targetChunks.length} · ` +
        `${coarseScene.objectEvidence.length} occurrences retained · ` +
        `${formatBytes(promotion.gpuBytes)} GPU resident`;
      status.dataset.state = "loading";
      status.dataset.stage = "target-chunks";
      setText("#triangle-count", promotion.triangles.toLocaleString("en-US"));
      setText("#edge-count", promotion.edgeSegments.toLocaleString("en-US"));
      setText("#decode-time", `${decodeMilliseconds.toFixed(1)} ms`);
      setText(
        "#geometry-result",
        `${formatBytes(decodedTargetBytes)} range-decoded · ` +
          `${formatBytes(promotion.decodedBytes)} CPU / ${formatBytes(promotion.gpuBytes)} GPU`,
      );
      // Residency changes batch membership, not the user's visibility intent. The
      // hierarchy markers therefore remain valid and must not be rescanned here.
      applyVisibility({
        syncHierarchy: false,
        changedBatchIndexes: visibilityUpdate.changedBatchIndexes,
      });
    };
    const finalizeProgressiveStatus = (): void => {
      if (!progressiveResidency) return;
      const current = progressiveResidency.current();
      const readyChunks = residentChunkCount();
      const complete = readyChunks === hierarchy.targetChunks.length;
      residentDecodedBytes = current.decodedBytes;
      residentGpuBytes = current.gpuBytes;
      document.documentElement.dataset.targetChunksReady = String(readyChunks);
      document.documentElement.dataset.residentDecodedBytes = String(current.decodedBytes);
      document.documentElement.dataset.residentGpuBytes = String(renderer.residentGpuBytes);
      publishMemoryDataset(rendererMemoryDataset(renderer.resourceStats()));
      document.documentElement.dataset.geometryRepresentation = complete ? "target" : "mixed";
      const spatialStats = spatialViewIndex?.queryStats();
      const spatialDemandSatisfied =
        spatialStats !== undefined && !(sessionResources.targetScheduler?.blocked ?? false);
      if (complete || spatialDemandSatisfied) {
        delete document.documentElement.dataset.residencyBudgetReached;
      } else {
        document.documentElement.dataset.residencyBudgetReached = "true";
      }
      status.textContent = complete
        ? `Compiled glTF ready · ${scene.summary.prototypeBatches} surface batches · ` +
          `${scene.summary.partOccurrences} renderable occurrences`
        : spatialDemandSatisfied
          ? `Spatial target demand ready · ${spatialStats?.candidateChunkCount ?? 0} ` +
            `visible candidate chunks · ${scene.summary.partOccurrences} renderable occurrences`
        : `Residency budget reached · ${scene.summary.prototypeBatches} surface batches retained · ` +
          `${scene.summary.partOccurrences} renderable occurrences`;
      document.documentElement.dataset.targetReady = complete
        ? "true"
        : spatialDemandSatisfied
          ? "spatial-idle"
          : "limited";
      status.dataset.state = "ready";
      status.dataset.stage = "rendered";
      setText("#triangle-count", scene.summary.triangles.toLocaleString("en-US"));
      setText("#edge-count", scene.summary.edgeSegments.toLocaleString("en-US"));
      setText("#decode-time", `${decodeMilliseconds.toFixed(1)} ms`);
      setText(
        "#geometry-result",
        `${formatBytes(current.decodedBytes)} CPU / ${formatBytes(current.gpuBytes)} GPU resident ` +
          `(budget ${formatBytes(residencyBudget)})`,
      );
    };
    // A "blocked" event arrives mid-drain: the scheduler skips the rejected
    // chunk and keeps admitting smaller ones behind it, so stamping the ready
    // status here would publish a transient below-budget endpoint. Defer the
    // stamp until the scheduler has drained every admissible chunk.
    const scheduleDeferredFinalize = (): void => {
      const scheduler = sessionResources.targetScheduler;
      if (!scheduler || finalizePending) return;
      finalizePending = true;
      void scheduler.whenIdle().then(() => {
        finalizePending = false;
        if (disposed || selectionPromotionInFlight) return;
        finalizeProgressiveStatus();
      });
    };
    const recordSchedulerEvent = (event: TargetSchedulerEvent): void => {
      document.documentElement.dataset.targetSchedulerChunk = event.chunkId;
      document.documentElement.dataset.targetSchedulerPriority = String(event.viewPriority);
      if (event.type === "request") {
        schedulerRequests += 1;
        document.documentElement.dataset.targetSchedulerRequests = String(schedulerRequests);
      } else if (event.type === "cancel") {
        schedulerCancellations += 1;
        document.documentElement.dataset.targetSchedulerCancellations = String(
          schedulerCancellations,
        );
        document.documentElement.dataset.targetSchedulerCancelledChunk = event.chunkId;
      } else if (event.type === "skipped") {
        schedulerSkips += 1;
        document.documentElement.dataset.targetSchedulerSkips = String(schedulerSkips);
        document.documentElement.dataset.targetSchedulerSkippedChunk = event.chunkId;
        scheduleDeferredFinalize();
      } else if (event.type === "blocked") {
        scheduleDeferredFinalize();
      } else if (residentChunkCount() === hierarchy.targetChunks.length) {
        finalizeProgressiveStatus();
      } else {
        // An admission leaves the mid-drain status on screen. A drain normally
        // ends on a skip or a block, which stamps the terminal state, but one
        // that ends on its own last admission -- what a budget too small to
        // take anything more does once a pinned selection resumes the
        // scheduler -- would otherwise leave a loading message with nothing in
        // flight behind it.
        scheduleDeferredFinalize();
      }
    };
    if (progressiveResidency) {
      const spatialIndex = loaded.spatialIndex
        ? await loadSpatialDemandIndex(loaded.spatialIndex, hierarchy, cancellation.signal)
        : undefined;
      const demandPriority = demandPriorityFromLocation();
      const viewIndex = spatialIndex
        ? (spatialViewIndex = new SpatialTargetChunkViewIndex(
            hierarchy.targetChunks,
            spatialIndex,
            demandPriority,
          ))
        : new TargetChunkViewIndex(
            hierarchy.targetChunks,
            coarseScene,
            initial.coarseInstanceTargetMeshIndexes,
          );
      document.documentElement.dataset.targetSchedulerMode = spatialIndex
        ? "spatial-bvh-v1"
        : "coarse-chunk-bounds-v1";
      document.documentElement.dataset.targetSchedulerDemandPriority = spatialIndex
        ? demandPriority
        : "retained-coarse-bounds";
      if (spatialIndex) {
        document.documentElement.dataset.spatialNodesTotal = String(spatialIndex.stats.nodeCount);
        document.documentElement.dataset.spatialLeavesTotal = String(spatialIndex.stats.leafCount);
        document.documentElement.dataset.spatialOccurrencesTotal = String(
          spatialIndex.stats.occurrenceCount,
        );
      }
      const scheduler = new CameraTargetScheduler(viewIndex, {
        isResident: (chunk) => progressiveResidency.hasTargetMeshes(chunk.meshIndexes),
        mayAdmit: (chunk, viewPriority) => {
          const cost = geometryDecoder.targetChunkResidencyCosts.get(chunk.id);
          // An unmeasured chunk stays admissible: the budget still decides.
          return cost === undefined || progressiveResidency.mayAdmit(cost, viewPriority);
        },
        load: (chunk, signal) =>
          geometryDecoder.decode(
            binarySourceForChunk(loaded.targetBinary, chunk),
            "target",
            chunk.id,
            signal,
          ),
        admit: (_chunk, target, viewPriority) => {
          const promotion = progressiveResidency.promote(target.scene, {
            priority: viewPriority,
          });
          if (!promotion.admitted) return false;
          applyPromotion(promotion, target);
          return true;
        },
        reprioritize: (ranked: readonly RankedTargetChunk[]) => {
          document.documentElement.dataset.targetSchedulerOrder = ranked
            .map(({ chunk }) => chunk.id)
            .join(",");
          document.documentElement.dataset.targetSchedulerDemand = ranked
            .filter(({ demanded }) => demanded)
            .map(({ chunk }) => chunk.id)
            .join(",");
          if (spatialViewIndex) {
            const stats = spatialViewIndex.queryStats();
            document.documentElement.dataset.spatialNodesVisited = String(
              stats.visitedNodeCount,
            );
            document.documentElement.dataset.spatialLeavesVisible = String(
              stats.visibleLeafCount,
            );
            document.documentElement.dataset.spatialOccurrencesTested = String(
              stats.testedOccurrenceCount,
            );
            document.documentElement.dataset.spatialCandidateChunks = String(
              stats.candidateChunkCount,
            );
            document.documentElement.dataset.spatialQueryMilliseconds = String(
              stats.queryMilliseconds,
            );
          }
          progressiveResidency.reprioritize(
            ranked.map(({ chunk, viewPriority }) => ({
              targetMeshIndexes: chunk.meshIndexes,
              priority: viewPriority,
            })),
          );
        },
        onEvent: recordSchedulerEvent,
        onError: (error) => {
          schedulerFailure = error instanceof Error ? error : new Error(String(error));
          status.textContent = schedulerFailure.message;
          status.dataset.state = "error";
        },
      });
      sessionResources.targetScheduler = scheduler;
      updateTargetView = (frame): void => scheduler.update(frame);
    }

    let selectionRequest = 0;
    const promoteSelectedResidency = async (picked: CompiledObjectEvidence): Promise<void> => {
      if (!progressiveResidency) return;
      const chunk = chunksByPrototype.get(picked.prototypeId);
      if (!chunk) return;
      const request = ++selectionRequest;
      if (progressiveResidency.hasTargetMeshes(chunk.meshIndexes)) {
        progressiveResidency.pinTargetMeshes(chunk.meshIndexes);
        document.documentElement.dataset.selectionResidency = "retained";
        return;
      }

      document.documentElement.dataset.selectionResidency = "loading";
      status.textContent = `Loading selected target detail · ${formatBytes(chunk.byteLength)}…`;
      status.dataset.stage = "selection-residency";
      const targetScheduler = sessionResources.targetScheduler;
      targetScheduler?.pause();
      selectionPromotionInFlight = true;
      try {
        const target = await geometryDecoder.decode(
          binarySourceForChunk(loaded.targetBinary, chunk),
          "target",
          chunk.id,
        );
        if (disposed || request !== selectionRequest || selectedObjectId !== picked.objectId) return;
        const promotion = progressiveResidency.promote(target.scene, {
          priority: chunk.priority,
          pin: true,
        });
        if (!promotion.admitted) {
          document.documentElement.dataset.selectionResidency = "coarse";
          status.textContent =
            `Selected target request exceeds the ${formatBytes(residencyBudget)} residency budget · ` +
            "coarse fallback retained";
          status.dataset.stage = "selection-residency";
          return;
        }

        applyPromotion(promotion, target);
        document.documentElement.dataset.residencyBudgetReached = "true";
        document.documentElement.dataset.targetReady = "limited";
        document.documentElement.dataset.selectionResidency = "target";
        document.documentElement.dataset.evictedTargetMeshCount = String(
          promotion.evictedTargetMeshIndexes.length,
        );
        status.textContent =
          `Selected target detail resident · ${promotion.evictedTargetMeshIndexes.length} colder ` +
          `target groups evicted · ${formatBytes(promotion.gpuBytes)} GPU resident`;
        status.dataset.state = "ready";
        status.dataset.stage = "selection-residency";
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        throw error;
      } finally {
        selectionPromotionInFlight = false;
        targetScheduler?.resume();
      }
    };

    const selectObject = (objectId: number): void => {
      const picked = evidence.get(objectId);
      selectedObjectId = picked ? objectId : 0;
      renderer.setSelection(selectedObjectId);
      if (picked && !hierarchyView.hasRow(picked.nodeIndex)) {
        hierarchySearchInput.value = "";
        applyHierarchySearch();
      }
      hierarchyView.setSelected(picked?.nodeIndex);
      if (picked) hierarchyView.reveal(picked.nodeIndex);
      updateSelectionText();
      updateVisibilityControls();
      scheduleRender();
      if (picked) {
        void promoteSelectedResidency(picked).catch((error: unknown) => {
          status.textContent =
            `Could not promote selected target detail: ` +
            (error instanceof Error ? error.message : String(error));
          status.dataset.state = "error";
        });
      }
    };

    const hideSelection = (): void => {
      if (selectedObjectId === 0) return;
      visibility.hide(selectedObjectId);
      applyVisibility();
    };
    const isolateSelection = (): void => {
      if (selectedObjectId === 0) return;
      visibility.isolate(selectedObjectId);
      applyVisibility();
    };
    const showAll = (): void => {
      visibility.showAll();
      applyVisibility();
    };
    updateVisibilityControls();
    updateProperties(undefined);

    const applySection = (): void => {
      const state = section.state();
      renderer.setSectionPlane(section.plane());
      toggleSectionButton.setAttribute("aria-pressed", String(state.enabled));
      sectionControls.hidden = !state.enabled;
      sectionPosition.value = String(Math.round(state.fraction * 100));
      sectionPositionValue.textContent =
        `${state.axis.toUpperCase()} · ${Math.round(state.fraction * 100)}%`;
      sectionDirection.textContent =
        `Keep ${state.direction === 1 ? "−" : "+"}${state.axis.toUpperCase()} side`;
      for (const button of sectionAxisButtons) {
        button.setAttribute("aria-pressed", String(button.dataset.sectionAxis === state.axis));
      }
      document.documentElement.dataset.sectionEnabled = String(state.enabled);
      document.documentElement.dataset.sectionAxis = state.axis;
      scheduleRender();
    };

    const toggleSection = (): void => {
      section.toggle();
      applySection();
    };
    applySection();

    let activePointer: number | undefined;
    let navigationMode: "orbit" | "pan" = "orbit";
    let lastPointerX = 0;
    let lastPointerY = 0;
    let pointerTravel = 0;
    let suppressClick = false;

    canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 && event.button !== 1) return;
        activePointer = event.pointerId;
        navigationMode = event.button === 1 || event.shiftKey ? "pan" : "orbit";
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        pointerTravel = 0;
        suppressClick = false;
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add("is-navigating");
        event.preventDefault();
      },
      listenerOptions,
    );
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId !== activePointer) return;
        const deltaX = event.clientX - lastPointerX;
        const deltaY = event.clientY - lastPointerY;
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        pointerTravel += Math.abs(deltaX) + Math.abs(deltaY);
        if (pointerTravel < 2) return;
        const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
        if (navigationMode === "pan") {
          camera.pan(deltaX, deltaY, canvas.clientWidth, canvas.clientHeight, aspect);
        } else {
          camera.orbit(deltaX, deltaY);
        }
        scheduleCameraRender();
      },
      listenerOptions,
    );
    const finishNavigation = (event: PointerEvent): void => {
      if (event.pointerId !== activePointer) return;
      suppressClick = pointerTravel >= 3;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      activePointer = undefined;
      canvas.classList.remove("is-navigating");
    };
    canvas.addEventListener("pointerup", finishNavigation, listenerOptions);
    canvas.addEventListener("pointercancel", finishNavigation, listenerOptions);
    canvas.addEventListener(
      "wheel",
      (event) => {
        camera.zoomBy(event.deltaY);
        scheduleCameraRender();
        event.preventDefault();
      },
      { ...listenerOptions, passive: false },
    );
    canvas.addEventListener("contextmenu", (event) => event.preventDefault(), listenerOptions);

    const fitView = (): void => {
      camera.fit();
      scheduleCameraRender();
    };
    requireElement<HTMLButtonElement>("#fit-view").addEventListener("click", fitView, listenerOptions);
    hideSelectionButton.addEventListener("click", hideSelection, listenerOptions);
    isolateSelectionButton.addEventListener("click", isolateSelection, listenerOptions);
    showAllButton.addEventListener("click", showAll, listenerOptions);
    toggleSectionButton.addEventListener("click", toggleSection, listenerOptions);
    flipSectionButton.addEventListener(
      "click",
      () => {
        section.flip();
        applySection();
      },
      listenerOptions,
    );
    sectionPosition.addEventListener(
      "input",
      () => {
        section.setFraction(Number(sectionPosition.value) / 100);
        applySection();
      },
      listenerOptions,
    );
    for (const button of sectionAxisButtons) {
      button.addEventListener(
        "click",
        () => {
          section.setAxis(button.dataset.sectionAxis as SectionAxis);
          applySection();
        },
        listenerOptions,
      );
    }
    hierarchySearchInput.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && hierarchySearchInput.value !== "") {
          hierarchySearchInput.value = "";
          applyHierarchySearch();
          event.preventDefault();
          return;
        }
        if (event.key !== "Enter" || activeSearch.firstRenderableNodeIndex === undefined) return;
        const picked = evidenceByNode.get(activeSearch.firstRenderableNodeIndex);
        if (picked) selectObject(picked.objectId);
        event.preventDefault();
      },
      listenerOptions,
    );
    window.addEventListener(
      "keydown",
      (event) => {
        const target = event.target;
        if (
          event.key === "/" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !(target instanceof HTMLInputElement) &&
          !(target instanceof HTMLTextAreaElement)
        ) {
          hierarchySearchInput.focus();
          hierarchySearchInput.select();
          event.preventDefault();
          return;
        }
        if (
          event.ctrlKey ||
          event.metaKey ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        ) {
          return;
        }
        const key = event.key.toLowerCase();
        if (key === "f") fitView();
        else if (key === "c") toggleSection();
        else if (key === "h" && event.shiftKey) showAll();
        else if (key === "h") hideSelection();
        else if (key === "i") isolateSelection();
        else if (key === "escape" && visibility.state().mode !== "all") showAll();
        else return;
        event.preventDefault();
      },
      listenerOptions,
    );

    const selectHierarchyTarget = (target: EventTarget | null): boolean => {
      const item = target instanceof Element ? target.closest<HTMLElement>("li[data-node-index]") : null;
      if (!item || item.dataset.renderable !== "true") return false;
      const nodeIndex = Number(item.dataset.nodeIndex);
      const picked = evidenceByNode.get(nodeIndex);
      if (!picked) return false;
      selectObject(picked.objectId);
      return true;
    };
    hierarchyList.addEventListener(
      "click",
      (event) => {
        selectHierarchyTarget(event.target);
      },
      listenerOptions,
    );
    hierarchyList.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (selectHierarchyTarget(event.target)) event.preventDefault();
      },
      listenerOptions,
    );

    sessionResources.resizeObserver = new ResizeObserver(() => {
      scheduleCameraRender();
      publishMemoryDataset(rendererMemoryDataset(renderer.resourceStats()));
    });
    sessionResources.resizeObserver.observe(canvas);

    canvas.addEventListener("click", (event) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      // `addEventListener` discards the return value, so an async handler would
      // turn a failed pick into an unhandled rejection that never reaches the
      // user. Surface it the way every other failure in this session does.
      renderer
        .pick(event.clientX, event.clientY)
        .then((objectId) => {
          selectObject(objectId);
        })
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : String(error);
          status.dataset.state = "error";
        });
    }, listenerOptions);

    if (sessionResources.targetScheduler) {
      const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
      updateTargetView(camera.frame(aspect));
      await sessionResources.targetScheduler.whenIdle();
      if (interactions.signal.aborted) {
        throw new DOMException("Scene load cancelled.", "AbortError");
      }
      if (schedulerFailure !== undefined) throw schedulerFailure;
      finalizeProgressiveStatus();
    }

    const packageReference: WorkspacePackageReference =
      source.kind === "url"
        ? { kind: "url", href: source.gltfUrl.href }
        : { kind: "local", fileName: source.gltfFile.name };
    const reportSource: PackageReportSource =
      source.kind === "url" && loaded.transport !== undefined
        ? { kind: "url", transport: PackageTransport.fromDescriptor(loaded.transport) }
        : { kind: "local", files: source.kind === "local" ? source.sidecarFiles : [] };
    let identityPromise: Promise<PackageIdentity | { readonly reason: string }> | undefined;
    let occurrenceIdSet: ReadonlySet<string> | undefined;
    const persistedSection = (): WorkspaceSection => {
      const state = section.state();
      return {
        enabled: state.enabled,
        axis: state.axis,
        direction: state.direction,
        fraction: state.fraction,
      };
    };
    workspaceSession = {
      reference: packageReference,
      label: loaded.label,
      identity: () => (identityPromise ??= readPackageIdentity(reportSource)),
      occurrenceIds: () => (occurrenceIdSet ??= new Set(objectIdByOccurrence.keys())),
      isolatedObjectId: () => visibility.state().isolatedObjectId,
      capture: (identity) =>
        captureWorkspace({
          label: loaded.label,
          reference: packageReference,
          packageDigest: identity.packageDigest,
          resources: identity.resources,
          sources: identity.sources ?? [],
          camera: camera.state(),
          section: persistedSection(),
          hiddenObjectIds: visibility.snapshot().hiddenObjectIds,
          selectedObjectId,
          occurrenceIdOf: (objectId) => evidence.get(objectId)?.occurrenceId,
        }),
      restore: (view) => {
        // An id the reopened batches cannot act on is reported as dropped
        // rather than thrown by `visibility.restore`, which refuses unknown ids.
        const restored = resolveRestoredObjects(view, (occurrenceId) => {
          const objectId = objectIdByOccurrence.get(occurrenceId);
          return objectId !== undefined && visibility.knows(objectId) ? objectId : undefined;
        });
        camera.restore(view.camera);
        section.restore(view.section);
        visibility.restore({ hiddenObjectIds: restored.hiddenObjectIds });
        applySection();
        applyVisibility();
        selectObject(restored.selectedObjectId);
        scheduleCameraRender();
        return restored;
      },
    };
    saveWorkspaceButton.disabled = false;
    const reopening = pendingWorkspace;
    if (reopening === undefined) {
      setWorkspaceStatus(`Ready to save a workspace for ${loaded.label}.`);
    } else {
      await applyWorkspace(reopening);
    }

    pendingCleanup = undefined;
    return true;
  } catch (error) {
    const cleanup = pendingCleanup;
    cleanup?.();
    if (disposeActiveScene === cleanup) disposeActiveScene = undefined;
    const message =
      error instanceof CompiledGltfError ||
      error instanceof NaruWebGpuError ||
      error instanceof Error
        ? error.message
        : String(error);
    status.textContent = message;
    status.dataset.state = "error";
    return false;
  } finally {
    if (cancelPendingSceneLoad === cancel) cancelPendingSceneLoad = undefined;
    setSourceControlsBusy(false);
  }
}

const evidenceSeverity: Readonly<Record<WorkspaceEvidenceState, number>> = {
  verified: 0,
  unverifiable: 1,
  changed: 2,
  missing: 3,
};

/**
 * Reduces the per-source verdicts to the worst one.
 *
 * `WorkspaceReopenDecision` carries no aggregated source state on purpose: the
 * decision names every source so a caller can say which one changed. The
 * Studio still needs one word for its status line, so it reduces here.
 */
function worstSourceState(sources: readonly WorkspaceSourceVerdict[]): WorkspaceEvidenceState {
  let carried: WorkspaceEvidenceState = "verified";
  for (const source of sources) {
    if (evidenceSeverity[source.state] > evidenceSeverity[carried]) carried = source.state;
  }
  return carried;
}

function setWorkspaceStatus(message: string, state?: "error" | "warning"): void {
  workspaceStatus.textContent = message;
  if (state === undefined) delete workspaceStatus.dataset.state;
  else workspaceStatus.dataset.state = state;
}

function describeReference(reference: WorkspacePackageReference): string {
  return reference.kind === "url" ? reference.href : reference.fileName;
}

function shortDigest(digest: string): string {
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest;
}

function workspaceFileName(label: string): string {
  const stem = label
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "")
    .slice(0, 80);
  return `${stem === "" ? "workspace" : stem}.naru-workspace.json`;
}

function downloadWorkspace(fileName: string, text: string): void {
  const href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  // The click takes its reference synchronously; the object URL is released on
  // the next task so the download is not cancelled by revoking it too early.
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

async function saveWorkspace(): Promise<void> {
  const session = workspaceSession;
  if (session === undefined) {
    setWorkspaceStatus("Open a package before saving a workspace.", "error");
    return;
  }
  saveWorkspaceButton.disabled = true;
  try {
    setWorkspaceStatus(`Reading the identity of ${session.label}…`);
    const identity = await session.identity();
    if ("reason" in identity) {
      setWorkspaceStatus(`This package cannot be saved as a workspace: ${identity.reason}`, "error");
      return;
    }
    if (identity.sources === undefined) {
      setWorkspaceStatus(
        `This package cannot be saved as a workspace: ` +
          `${identity.sourcesUnavailableReason ?? "its source identity could not be read"}. ` +
          `A workspace that named no source would reopen as verified without any ` +
          `source having been checked.`,
        "error",
      );
      return;
    }
    const capture = session.capture(identity);
    downloadWorkspace(
      workspaceFileName(capture.document.label),
      serializeWorkspace(capture.document),
    );
    const notes: string[] = [];
    if (capture.unnamedHiddenObjectIds.length > 0) {
      notes.push(
        `${capture.unnamedHiddenObjectIds.length} hidden occurrence(s) carry no id and were not saved`,
      );
    }
    if (capture.unnamedSelection) {
      notes.push("the selection carries no occurrence id and was not saved");
    }
    if (session.isolatedObjectId() !== undefined) {
      notes.push(
        "isolation has no field in naru.workspace.1, so only the explicit hidden set was saved",
      );
    }
    document.documentElement.dataset.workspaceSaved = "true";
    setWorkspaceStatus(
      `Saved ${capture.document.view.hiddenOccurrenceIds.length} hidden occurrence(s) and ` +
        `${capture.document.sources.length} source(s) for ${capture.document.label}.` +
        (notes.length > 0 ? ` Not saved: ${notes.join("; ")}.` : ""),
      notes.length > 0 ? "warning" : undefined,
    );
  } catch (error) {
    setWorkspaceStatus(
      `Could not save this workspace: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  } finally {
    saveWorkspaceButton.disabled = workspaceSession === undefined;
  }
}

function publishWorkspaceReopen(
  manifest: WorkspaceDocument,
  decision: WorkspaceReopenDecision,
  restored: RestoredObjects,
  identityReason: string | undefined,
): void {
  const root = document.documentElement.dataset;
  const sourceState = worstSourceState(decision.sources);
  root.workspaceState = decision.state;
  root.workspaceGeometryCurrent = String(decision.geometryIsCurrent);
  root.workspacePackage = decision.package.state;
  root.workspaceSources = sourceState;
  root.workspaceSourceInspection =
    inspectedWorkspaceSources === undefined ? "unavailable" : "available";
  root.workspaceHiddenOccurrences = String(restored.hiddenObjectIds.length);
  root.workspaceDroppedOccurrences = String(restored.droppedOccurrenceIds.length);
  root.workspaceDroppedSelection = String(restored.droppedSelection);
  root.workspaceSelectedObject = String(restored.selectedObjectId);
  workspaceKind.textContent = decision.state.toUpperCase();

  const sentences = [`${manifest.label} reopened as ${decision.state}.`];
  if (decision.package.state === "changed") {
    sentences.push(
      `The package digest is ${shortDigest(decision.package.observedDigest ?? "unknown")} ` +
        `but this workspace recorded ${shortDigest(decision.package.expectedDigest)}.`,
    );
  } else if (identityReason !== undefined) {
    sentences.push(`The package identity could not be read: ${identityReason}.`);
  }
  if (inspectedWorkspaceSources === undefined) {
    sentences.push(
      `No source document was checked, so its ${manifest.sources.length} source(s) are ` +
        `unverifiable; use "Check sources" to pick them.`,
    );
  } else if (sourceState !== "verified") {
    const named = decision.sources
      .filter((source) => source.state !== "verified")
      .map((source) => `${source.label} (${source.state})`);
    sentences.push(`Source evidence: ${named.join(", ")}.`);
  } else {
    sentences.push(`All ${decision.sources.length} source(s) match.`);
  }
  sentences.push(
    `Restored ${restored.hiddenObjectIds.length} hidden occurrence(s)` +
      (restored.selectedObjectId === 0 ? " and no selection." : " and the selection."),
  );
  if (restored.droppedOccurrenceIds.length > 0) {
    sentences.push(
      `${restored.droppedOccurrenceIds.length} occurrence id(s) this package does not carry ` +
        `were dropped${restored.droppedSelection ? ", including the selection" : ""}.`,
    );
  }
  setWorkspaceStatus(
    sentences.join(" "),
    decision.state === "verified"
      ? undefined
      : decision.state === "blocked"
        ? "error"
        : "warning",
  );
}

/** Applies a parsed manifest against the package that is already open. */
async function applyWorkspace(manifest: WorkspaceDocument): Promise<void> {
  const session = workspaceSession;
  if (session === undefined) {
    setWorkspaceStatus(
      `Open ${describeReference(manifest.package.reference)} to reopen ${manifest.label}.`,
    );
    return;
  }
  const identity = await session.identity();
  const decision = evaluateWorkspaceReopen(
    manifest,
    observeWorkspace({
      packagePresent: true,
      packageDigest: "reason" in identity ? undefined : identity.packageDigest,
      occurrenceIds: session.occurrenceIds(),
      inspectedSources: inspectedWorkspaceSources,
    }),
  );
  const restored = session.restore(decision.view);
  pendingWorkspace = undefined;
  activeWorkspace = manifest;
  workspaceSourcesInput.disabled = false;
  publishWorkspaceReopen(
    manifest,
    decision,
    restored,
    "reason" in identity ? identity.reason : undefined,
  );
}

async function openWorkspaceFile(file: File): Promise<void> {
  let manifest: WorkspaceDocument;
  try {
    manifest = parseWorkspace(await file.text());
  } catch (error) {
    setWorkspaceStatus(
      `${file.name} is not a NARU workspace: ` +
        (error instanceof Error ? error.message : String(error)),
      "error",
    );
    return;
  }
  // A manifest read earlier says nothing about the sources of this one.
  inspectedWorkspaceSources = undefined;
  activeWorkspace = undefined;
  pendingWorkspace = manifest;
  workspaceSourcesInput.disabled = false;
  const reference = manifest.package.reference;
  if (workspaceSession !== undefined && describeReference(workspaceSession.reference) === describeReference(reference)) {
    await applyWorkspace(manifest);
    return;
  }
  if (reference.kind === "local") {
    setWorkspaceStatus(
      `Open ${reference.fileName} with "Compiled files" to reopen ${manifest.label}; ` +
        `a browser cannot reach a local package by name.`,
    );
    return;
  }
  let gltfUrl: URL;
  try {
    gltfUrl = parseSceneUrl(reference.href, window.location.href);
  } catch (error) {
    setWorkspaceStatus(
      `This workspace names a package this Studio will not open: ` +
        (error instanceof Error ? error.message : String(error)),
      "error",
    );
    return;
  }
  sceneUrlInput.value = gltfUrl.href;
  setWorkspaceStatus(`Reopening ${manifest.label} against ${gltfUrl.href}…`);
  const loadedScene = await loadScene({ kind: "url", gltfUrl });
  if (loadedScene) replaceSceneQuery(gltfUrl);
}

async function checkWorkspaceSources(files: readonly File[]): Promise<void> {
  const manifest = activeWorkspace ?? pendingWorkspace;
  if (manifest === undefined) {
    setWorkspaceStatus("Open a workspace before checking its sources.", "error");
    return;
  }
  setWorkspaceStatus(`Hashing ${files.length} source file(s)…`);
  const inspection = await inspectWorkspaceSources(manifest, files);
  if (inspection.sources === undefined) {
    inspectedWorkspaceSources = undefined;
    setWorkspaceStatus(`Sources stay unverifiable: ${inspection.reasons.join(" ")}`, "warning");
    return;
  }
  inspectedWorkspaceSources = inspection.sources;
  if (activeWorkspace !== undefined) await applyWorkspace(activeWorkspace);
  else setWorkspaceStatus(`Hashed ${inspection.sources.length} source(s); open the package to reopen.`);
}

function replaceSceneQuery(sceneUrl?: URL): void {
  const pageUrl = new URL(window.location.href);
  if (sceneUrl) pageUrl.searchParams.set("scene", sceneUrl.href);
  else pageUrl.searchParams.delete("scene");
  window.history.replaceState(null, "", pageUrl);
}

sceneUrlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  let gltfUrl: URL;
  try {
    gltfUrl = parseSceneUrl(sceneUrlInput.value, window.location.href);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.dataset.state = "error";
    return;
  }
  void loadScene({ kind: "url", gltfUrl }).then((loaded) => {
    if (loaded) replaceSceneQuery(gltfUrl);
  });
});

localSceneFiles.addEventListener("change", () => {
  let source: SceneSource;
  try {
    source = selectLocalSceneFiles(Array.from(localSceneFiles.files ?? []));
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.dataset.state = "error";
    localSceneFiles.value = "";
    return;
  }
  void loadScene(source).then((loaded) => {
    localSceneFiles.value = "";
    if (loaded) replaceSceneQuery();
  });
});

openDemoSceneButton.addEventListener("click", () => {
  sceneUrlInput.value = defaultSceneUrl.href;
  void loadScene({ kind: "url", gltfUrl: defaultSceneUrl }).then((loaded) => {
    if (loaded) replaceSceneQuery();
  });
});

openPygamerSceneButton.addEventListener("click", () => {
  sceneUrlInput.value = pygamerSceneUrl.href;
  void loadScene({ kind: "url", gltfUrl: pygamerSceneUrl }).then((loaded) => {
    if (loaded) replaceSceneQuery(pygamerSceneUrl);
  });
});

cancelSceneLoadButton.addEventListener("click", () => {
  cancelPendingSceneLoad?.();
});

saveWorkspaceButton.addEventListener("click", () => {
  void saveWorkspace();
});

workspaceFileInput.addEventListener("change", () => {
  const file = workspaceFileInput.files?.[0];
  if (!file) return;
  void openWorkspaceFile(file).finally(() => {
    workspaceFileInput.value = "";
  });
});

workspaceSourcesInput.addEventListener("change", () => {
  const files = Array.from(workspaceSourcesInput.files ?? []);
  if (files.length === 0) return;
  void checkWorkspaceSources(files).finally(() => {
    workspaceSourcesInput.value = "";
  });
});

window.addEventListener(
  "beforeunload",
  () => {
    cancelPendingSceneLoad?.();
    disposeActiveScene?.();
  },
  { once: true },
);

const requestedScene = new URL(window.location.href).searchParams.get("scene");
let initialSceneUrl = defaultSceneUrl;
if (requestedScene) {
  try {
    initialSceneUrl = parseSceneUrl(requestedScene, window.location.href);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.dataset.state = "error";
  }
}
sceneUrlInput.value = initialSceneUrl.href;
await loadScene({ kind: "url", gltfUrl: initialSceneUrl });
