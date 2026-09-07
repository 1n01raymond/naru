/**
 * A workspace manifest records what a reviewer had open and how they were
 * looking at it. It is never a source of truth (ADR-0002): it names a compiled
 * package and the sources that package was built from, and it stores enough
 * identity to say, on reopen, whether either has moved underneath it.
 *
 * The parser is a trust boundary. It performs no network access, resolves no
 * filesystem path, accepts no unknown key, and refuses any schema version it
 * was not written for.
 */

export const workspaceSchemaVersion = "naru.workspace.2";

/**
 * The version this package wrote before `view.annotations` existed. It is
 * still read (annotations empty) so a saved manifest keeps reopening; it is
 * never written.
 */
export const previousWorkspaceSchemaVersion = "naru.workspace.1";

/** A hex SHA-256 digest, lowercase, unprefixed. */
const digestPattern = /^[0-9a-f]{64}$/;

export type WorkspaceErrorCode =
  | "UNSUPPORTED_SCHEMA"
  | "INVALID_WORKSPACE"
  | "LIMIT_EXCEEDED";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

/**
 * Ceilings a hostile or corrupt manifest cannot exceed. They bound work, not
 * policy: every value sits far above any workspace this repository has
 * recorded (the largest measured federation is seven documents and 78,173
 * occurrences).
 */
export interface WorkspaceParseLimits {
  /** Measured in UTF-16 code units, the unit the parser actually holds. */
  readonly documentCharacters: number;
  readonly sourceCount: number;
  readonly resourceCount: number;
  readonly hiddenOccurrenceCount: number;
  readonly annotationCount: number;
  readonly annotationTextLength: number;
  readonly identifierLength: number;
  readonly referenceLength: number;
}

export const defaultWorkspaceParseLimits: WorkspaceParseLimits = {
  documentCharacters: 64 * 1024 * 1024,
  sourceCount: 256,
  resourceCount: 256,
  hiddenOccurrenceCount: 1_000_000,
  annotationCount: 10_000,
  annotationTextLength: 1024,
  identifierLength: 512,
  referenceLength: 4096,
};

/** How a reopening host can reach the compiled package again. */
export type WorkspacePackageReference =
  | { readonly kind: "url"; readonly href: string }
  | { readonly kind: "local"; readonly fileName: string };

/** One resource of the compiled package, as `build-report.json` reports it. */
export interface WorkspacePackageResource {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface WorkspacePackage {
  readonly reference: WorkspacePackageReference;
  readonly packageDigest: string;
  readonly resources: readonly WorkspacePackageResource[];
}

/** One source document, as `adapter-report.json` reports it. */
export interface WorkspaceSource {
  readonly key: string;
  readonly label: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** Orbit camera state, in the units `OrthographicOrbitCamera` keeps. */
export interface WorkspaceCamera {
  readonly yaw: number;
  readonly pitch: number;
  readonly panRight: number;
  readonly panUp: number;
  readonly zoom: number;
}

export type WorkspaceSectionAxis = "x" | "y" | "z";

/**
 * Section state without its bounds: `minimum`, `maximum` and `offset` are
 * derived from the scene the plane is applied to, so storing them would let a
 * manifest contradict the geometry it is reopened against.
 */
export interface WorkspaceSection {
  readonly enabled: boolean;
  readonly axis: WorkspaceSectionAxis;
  readonly direction: 1 | -1;
  readonly fraction: number;
}

/**
 * A text note anchored to a world-space point in the package's metre frame.
 * Notes are kept in the order they were written; they are not keyed by an
 * occurrence, so a recompile never rebinds one.
 */
export interface WorkspaceAnnotation {
  readonly position: readonly [number, number, number];
  readonly text: string;
}

/** Selection and visibility are keyed by occurrence id, never by node index. */
export interface WorkspaceView {
  readonly camera: WorkspaceCamera;
  readonly section: WorkspaceSection;
  readonly hiddenOccurrenceIds: readonly string[];
  readonly selectedOccurrenceId: string | null;
  readonly annotations: readonly WorkspaceAnnotation[];
}

export interface WorkspaceDocument {
  readonly schemaVersion: typeof workspaceSchemaVersion;
  readonly label: string;
  readonly package: WorkspacePackage;
  readonly sources: readonly WorkspaceSource[];
  readonly view: WorkspaceView;
}

function invalid(message: string): never {
  throw new WorkspaceError("INVALID_WORKSPACE", message);
}

function exceeded(message: string): never {
  throw new WorkspaceError("LIMIT_EXCEEDED", message);
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string, limit: number): unknown[] {
  if (!Array.isArray(value)) {
    invalid(`${path} must be an array.`);
  }
  if (value.length > limit) {
    exceeded(`${path} declares ${value.length} entries, above the ${limit} allowed.`);
  }
  return value;
}

function readString(value: unknown, path: string, limit: number): string {
  if (typeof value !== "string") {
    invalid(`${path} must be a string.`);
  }
  if (value.length > limit) {
    exceeded(`${path} is ${value.length} characters, above the ${limit} allowed.`);
  }
  return value;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    invalid(`${path} must be a boolean.`);
  }
  return value;
}

function readFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${path} must be a finite number.`);
  }
  return value;
}

function readByteLength(value: unknown, path: string): number {
  const bytes = readFiniteNumber(value, path);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    invalid(`${path} must be a non-negative safe integer.`);
  }
  return bytes;
}

function readDigest(value: unknown, path: string): string {
  // A generous ceiling: a wrong length is a format error, not exhaustion.
  const digest = readString(value, path, 1024);
  if (!digestPattern.test(digest)) {
    invalid(`${path} must be a lowercase hex SHA-256 digest.`);
  }
  return digest;
}

/**
 * Unknown keys are refused rather than ignored. Within a version this
 * repository issued, an unrecognized key is corruption or tampering; a future
 * version announces itself through `schemaVersion`, which is checked first.
 */
function requireKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      invalid(`${path} carries the unknown key ${JSON.stringify(key)}.`);
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function readPackageReference(
  value: unknown,
  path: string,
  limits: WorkspaceParseLimits,
): WorkspacePackageReference {
  const record = readRecord(value, path);
  const kind = readString(record["kind"], `${path}.kind`, 16);
  if (kind === "url") {
    requireKnownKeys(record, ["kind", "href"], path);
    const href = readString(record["href"], `${path}.href`, limits.referenceLength);
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      invalid(`${path}.href must be an absolute URL.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      invalid(`${path}.href must use http or https, not ${parsed.protocol}`);
    }
    if (parsed.username !== "" || parsed.password !== "") {
      invalid(`${path}.href must not carry credentials.`);
    }
    return { kind: "url", href };
  }
  if (kind === "local") {
    requireKnownKeys(record, ["kind", "fileName"], path);
    const fileName = readString(record["fileName"], `${path}.fileName`, 255);
    if (fileName === "" || fileName === "." || fileName === "..") {
      invalid(`${path}.fileName must name a file.`);
    }
    if (hasControlCharacter(fileName) || fileName.includes("/") || fileName.includes("\\")) {
      invalid(`${path}.fileName must be a bare file name, not a path.`);
    }
    return { kind: "local", fileName };
  }
  invalid(`${path}.kind must be "url" or "local".`);
}

function readPackage(
  value: unknown,
  path: string,
  limits: WorkspaceParseLimits,
): WorkspacePackage {
  const record = readRecord(value, path);
  requireKnownKeys(record, ["reference", "packageDigest", "resources"], path);
  const entries = readArray(record["resources"], `${path}.resources`, limits.resourceCount);
  const resources: WorkspacePackageResource[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const resourcePath = `${path}.resources[${index}]`;
    const resource = readRecord(entry, resourcePath);
    requireKnownKeys(resource, ["path", "byteLength", "sha256"], resourcePath);
    const declared = readString(resource["path"], `${resourcePath}.path`, limits.referenceLength);
    if (declared === "") {
      invalid(`${resourcePath}.path must not be empty.`);
    }
    if (seen.has(declared)) {
      invalid(`${resourcePath}.path repeats ${JSON.stringify(declared)}.`);
    }
    seen.add(declared);
    resources.push({
      path: declared,
      byteLength: readByteLength(resource["byteLength"], `${resourcePath}.byteLength`),
      sha256: readDigest(resource["sha256"], `${resourcePath}.sha256`),
    });
  });
  return {
    reference: readPackageReference(record["reference"], `${path}.reference`, limits),
    packageDigest: readDigest(record["packageDigest"], `${path}.packageDigest`),
    resources,
  };
}

function readSources(
  value: unknown,
  path: string,
  limits: WorkspaceParseLimits,
): WorkspaceSource[] {
  const entries = readArray(value, path, limits.sourceCount);
  const sources: WorkspaceSource[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const sourcePath = `${path}[${index}]`;
    const record = readRecord(entry, sourcePath);
    requireKnownKeys(record, ["key", "label", "byteLength", "sha256"], sourcePath);
    const key = readString(record["key"], `${sourcePath}.key`, limits.identifierLength);
    if (key === "") {
      invalid(`${sourcePath}.key must not be empty.`);
    }
    if (seen.has(key)) {
      invalid(`${sourcePath}.key repeats ${JSON.stringify(key)}.`);
    }
    seen.add(key);
    sources.push({
      key,
      label: readString(record["label"], `${sourcePath}.label`, limits.identifierLength),
      byteLength: readByteLength(record["byteLength"], `${sourcePath}.byteLength`),
      sha256: readDigest(record["sha256"], `${sourcePath}.sha256`),
    });
  });
  // A workspace naming no source would reopen as `verified` with
  // `geometryIsCurrent` true while nothing about that geometry's provenance had
  // been checked, which is the one outcome the reopen states exist to prevent.
  if (sources.length === 0) {
    invalid(`${path} must name at least one source.`);
  }
  return sources;
}

function readAnnotations(
  value: unknown,
  path: string,
  limits: WorkspaceParseLimits,
): WorkspaceAnnotation[] {
  const entries = readArray(value, path, limits.annotationCount);
  return entries.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = readRecord(entry, entryPath);
    requireKnownKeys(record, ["position", "text"], entryPath);
    const positionPath = `${entryPath}.position`;
    const position = readArray(record["position"], positionPath, 3);
    if (position.length !== 3) {
      invalid(`${positionPath} must hold exactly three coordinates.`);
    }
    const text = readString(record["text"], `${entryPath}.text`, limits.annotationTextLength);
    if (text.trim() === "") {
      invalid(`${entryPath}.text must not be blank.`);
    }
    return {
      position: [
        readFiniteNumber(position[0], `${positionPath}[0]`),
        readFiniteNumber(position[1], `${positionPath}[1]`),
        readFiniteNumber(position[2], `${positionPath}[2]`),
      ],
      text,
    };
  });
}

function readView(
  value: unknown,
  path: string,
  limits: WorkspaceParseLimits,
  hasAnnotations: boolean,
): WorkspaceView {
  const record = readRecord(value, path);
  requireKnownKeys(
    record,
    hasAnnotations
      ? ["camera", "section", "hiddenOccurrenceIds", "selectedOccurrenceId", "annotations"]
      : ["camera", "section", "hiddenOccurrenceIds", "selectedOccurrenceId"],
    path,
  );

  const cameraPath = `${path}.camera`;
  const camera = readRecord(record["camera"], cameraPath);
  requireKnownKeys(camera, ["yaw", "pitch", "panRight", "panUp", "zoom"], cameraPath);
  const zoom = readFiniteNumber(camera["zoom"], `${cameraPath}.zoom`);
  if (zoom <= 0) {
    invalid(`${cameraPath}.zoom must be greater than zero.`);
  }

  const sectionPath = `${path}.section`;
  const section = readRecord(record["section"], sectionPath);
  requireKnownKeys(section, ["enabled", "axis", "direction", "fraction"], sectionPath);
  const axis = readString(section["axis"], `${sectionPath}.axis`, 1);
  if (axis !== "x" && axis !== "y" && axis !== "z") {
    invalid(`${sectionPath}.axis must be "x", "y" or "z".`);
  }
  const direction = readFiniteNumber(section["direction"], `${sectionPath}.direction`);
  if (direction !== 1 && direction !== -1) {
    invalid(`${sectionPath}.direction must be 1 or -1.`);
  }
  const fraction = readFiniteNumber(section["fraction"], `${sectionPath}.fraction`);
  if (fraction < 0 || fraction > 1) {
    invalid(`${sectionPath}.fraction must lie between 0 and 1.`);
  }

  const hiddenPath = `${path}.hiddenOccurrenceIds`;
  const hiddenEntries = readArray(
    record["hiddenOccurrenceIds"],
    hiddenPath,
    limits.hiddenOccurrenceCount,
  );
  const hidden = new Set<string>();
  hiddenEntries.forEach((entry, index) => {
    const id = readString(entry, `${hiddenPath}[${index}]`, limits.identifierLength);
    if (id === "") {
      invalid(`${hiddenPath}[${index}] must not be empty.`);
    }
    hidden.add(id);
  });

  const selected = record["selectedOccurrenceId"];
  const selectedOccurrenceId =
    selected === null
      ? null
      : readString(selected, `${path}.selectedOccurrenceId`, limits.identifierLength);
  if (selectedOccurrenceId === "") {
    invalid(`${path}.selectedOccurrenceId must not be empty.`);
  }

  return {
    camera: {
      yaw: readFiniteNumber(camera["yaw"], `${cameraPath}.yaw`),
      pitch: readFiniteNumber(camera["pitch"], `${cameraPath}.pitch`),
      panRight: readFiniteNumber(camera["panRight"], `${cameraPath}.panRight`),
      panUp: readFiniteNumber(camera["panUp"], `${cameraPath}.panUp`),
      zoom,
    },
    section: {
      enabled: readBoolean(section["enabled"], `${sectionPath}.enabled`),
      axis,
      direction,
      fraction,
    },
    hiddenOccurrenceIds: [...hidden].sort(),
    selectedOccurrenceId,
    annotations: hasAnnotations
      ? readAnnotations(record["annotations"], `${path}.annotations`, limits)
      : [],
  };
}

export interface WorkspaceParseOptions {
  readonly limits?: Partial<WorkspaceParseLimits> | undefined;
}

function settleLimits(options: WorkspaceParseOptions | undefined): WorkspaceParseLimits {
  return { ...defaultWorkspaceParseLimits, ...(options?.limits ?? {}) };
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Validate an in-memory value and return it in canonical form: sources ordered
 * by key, package resources by path, hidden occurrences deduplicated and
 * sorted. Two workspaces describing the same state normalize identically.
 */
export function normalizeWorkspace(
  value: unknown,
  options?: WorkspaceParseOptions,
): WorkspaceDocument {
  const limits = settleLimits(options);
  const record = readRecord(value, "workspace");
  const declared = record["schemaVersion"];
  if (declared !== workspaceSchemaVersion && declared !== previousWorkspaceSchemaVersion) {
    throw new WorkspaceError(
      "UNSUPPORTED_SCHEMA",
      `workspace.schemaVersion must be ${JSON.stringify(workspaceSchemaVersion)}, not ${JSON.stringify(declared)}.`,
    );
  }
  requireKnownKeys(record, ["schemaVersion", "label", "package", "sources", "view"], "workspace");
  const sources = readSources(record["sources"], "workspace.sources", limits);
  const workspacePackage = readPackage(record["package"], "workspace.package", limits);
  return {
    schemaVersion: workspaceSchemaVersion,
    label: readString(record["label"], "workspace.label", limits.identifierLength),
    package: {
      reference: workspacePackage.reference,
      packageDigest: workspacePackage.packageDigest,
      resources: [...workspacePackage.resources].sort((left, right) =>
        compareText(left.path, right.path),
      ),
    },
    sources: sources.sort((left, right) => compareText(left.key, right.key)),
    view: readView(
      record["view"],
      "workspace.view",
      limits,
      declared === workspaceSchemaVersion,
    ),
  };
}

/** Parse a stored manifest. Never fetches, never resolves a path. */
export function parseWorkspace(
  text: string,
  options?: WorkspaceParseOptions,
): WorkspaceDocument {
  const limits = settleLimits(options);
  if (text.length > limits.documentCharacters) {
    exceeded(
      `workspace is ${text.length} characters, above the ${limits.documentCharacters} allowed.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    invalid(`workspace is not valid JSON: ${(error as Error).message}`);
  }
  return normalizeWorkspace(parsed, options);
}

/**
 * Emit the canonical text of a workspace. Keys are written in a fixed declared
 * order and no field carries a timestamp or a host detail, so saving the same
 * state twice produces the same bytes.
 */
export function serializeWorkspace(
  value: unknown,
  options?: WorkspaceParseOptions,
): string {
  const document = normalizeWorkspace(value, options);
  const reference =
    document.package.reference.kind === "url"
      ? { kind: "url", href: document.package.reference.href }
      : { kind: "local", fileName: document.package.reference.fileName };
  const ordered = {
    schemaVersion: document.schemaVersion,
    label: document.label,
    package: {
      reference,
      packageDigest: document.package.packageDigest,
      resources: document.package.resources.map((resource) => ({
        path: resource.path,
        byteLength: resource.byteLength,
        sha256: resource.sha256,
      })),
    },
    sources: document.sources.map((source) => ({
      key: source.key,
      label: source.label,
      byteLength: source.byteLength,
      sha256: source.sha256,
    })),
    view: {
      camera: {
        yaw: document.view.camera.yaw,
        pitch: document.view.camera.pitch,
        panRight: document.view.camera.panRight,
        panUp: document.view.camera.panUp,
        zoom: document.view.camera.zoom,
      },
      section: {
        enabled: document.view.section.enabled,
        axis: document.view.section.axis,
        direction: document.view.section.direction,
        fraction: document.view.section.fraction,
      },
      hiddenOccurrenceIds: document.view.hiddenOccurrenceIds,
      selectedOccurrenceId: document.view.selectedOccurrenceId,
      annotations: document.view.annotations.map((annotation) => ({
        position: [annotation.position[0], annotation.position[1], annotation.position[2]],
        text: annotation.text,
      })),
    },
  };
  return `${JSON.stringify(ordered)}\n`;
}
