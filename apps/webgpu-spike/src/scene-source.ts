import { assertPackageUrl, openPackageTransport } from "@naru3d/runtime-webgpu";
import type {
  CompiledHierarchy,
  DeclaredPackageResource,
  PackageTransport,
  PackageTransportDescriptor,
  PackageTransportPolicy,
} from "@naru3d/runtime-webgpu";

import { resourceFileName } from "./resource-name.js";
import type { PropertySidecarSource } from "./property-sidecar.js";
import type { SpatialDemandSource } from "./spatial-demand-source.js";

export interface UrlSceneSource {
  readonly kind: "url";
  readonly gltfUrl: URL;
}

export interface LocalSceneSource {
  readonly kind: "local";
  readonly gltfFile: File;
  readonly binaryFiles: readonly File[];
  /** `.json` files selected next to the glTF, e.g. the property sidecar. */
  readonly sidecarFiles: readonly File[];
}

export type SceneSource = UrlSceneSource | LocalSceneSource;

export type GeometryBinarySource =
  | {
      readonly kind: "url";
      readonly href: string;
      readonly byteOffset?: number;
      readonly byteLength?: number;
    }
  | {
      readonly kind: "file";
      readonly file: File;
      readonly byteOffset?: number;
      readonly byteLength?: number;
    };

export type GeometryDocumentSource =
  | { readonly kind: "bytes"; readonly bytes: ArrayBuffer }
  | { readonly kind: "file"; readonly file: File };

export interface LoadedSceneHierarchy {
  readonly documentSource: GeometryDocumentSource;
  /**
   * Bytes of the compiled glTF document as transferred. Recorded here because
   * the Worker takes ownership of the buffer, after which its own byte length
   * reads as zero.
   */
  readonly documentByteLength: number;
  readonly hierarchy: CompiledHierarchy;
  /**
   * Bytes of the relocated hierarchy sidecar, JSON header plus columns, for a
   * package that carries its assembly tree outside the document. Recorded at
   * load because the sidecar is read once and dropped: only the decoded tree
   * outlives this call, and nothing later can restate the transferred size.
   */
  readonly relocatedHierarchyBytes?: number;
  /**
   * The transfer policy this package was opened under, for the Worker that
   * fetches its ranges. Absent for local files, which are never transferred.
   */
  readonly transport?: PackageTransportDescriptor;
  readonly targetBinary: GeometryBinarySource;
  readonly coarseBinary?: GeometryBinarySource;
  readonly properties?: PropertySidecarSource;
  readonly spatialIndex?: SpatialDemandSource;
  readonly label: string;
}

export function parseSceneUrl(value: string, baseHref: string): URL {
  const trimmed = value.trim();
  if (trimmed === "") throw new TypeError("Enter a compiled glTF URL.");
  const url = new URL(trimmed, baseHref);
  assertPackageUrl(url, "Compiled scene URLs");
  return url;
}

export function selectLocalSceneFiles(files: readonly File[]): LocalSceneSource {
  const unsupported = files.filter(
    (file) => !file.name.toLocaleLowerCase("en-US").endsWith(".gltf") &&
      !file.name.toLocaleLowerCase("en-US").endsWith(".bin") &&
      !file.name.toLocaleLowerCase("en-US").endsWith(".json"),
  );
  const gltfFiles = files.filter((file) =>
    file.name.toLocaleLowerCase("en-US").endsWith(".gltf"),
  );
  const binaryFiles = files.filter((file) =>
    file.name.toLocaleLowerCase("en-US").endsWith(".bin"),
  );
  const sidecarFiles = files.filter((file) =>
    file.name.toLocaleLowerCase("en-US").endsWith(".json"),
  );
  if (unsupported.length > 0 || gltfFiles.length !== 1 || binaryFiles.length < 1) {
    throw new TypeError(
      "Select exactly one .gltf file and all of its .bin and .json resources.",
    );
  }
  const gltfFile = gltfFiles[0];
  if (!gltfFile) throw new TypeError("The local scene package is incomplete.");
  return { kind: "local", gltfFile, binaryFiles, sidecarFiles };
}

export function validateLocalBinary(
  hierarchy: CompiledHierarchy,
  binaryFile: Pick<File, "name" | "size">,
  representation: "target" | "coarse" = "target",
): void {
  const uri = representation === "coarse" ? hierarchy.coarseBinaryUri : hierarchy.binaryUri;
  const byteLength = representation === "coarse"
    ? hierarchy.coarseBinaryByteLength
    : hierarchy.binaryByteLength;
  if (!uri || byteLength === undefined) {
    throw new TypeError(`The compiled scene has no ${representation} binary resource.`);
  }
  const binaryUrl = new URL(uri, "https://naru.local/");
  const expectedName = decodeURIComponent(binaryUrl.pathname.split("/").pop() ?? "");
  if (binaryFile.name !== expectedName) {
    throw new TypeError(
      `The glTF expects ${expectedName}; selected binary is ${binaryFile.name}.`,
    );
  }
  if (binaryFile.size !== byteLength) {
    throw new TypeError(
      `${binaryFile.name} must be ${byteLength.toLocaleString("en-US")} bytes; ` +
        `received ${binaryFile.size.toLocaleString("en-US")}.`,
    );
  }
}

/** The external resources a compiled glTF declares, for the package budget. */
function declaredResources(hierarchy: CompiledHierarchy): DeclaredPackageResource[] {
  const resources: DeclaredPackageResource[] = [
    { uri: hierarchy.binaryUri, byteLength: hierarchy.binaryByteLength },
  ];
  if (hierarchy.coarseBinaryUri && hierarchy.coarseBinaryByteLength !== undefined) {
    resources.push({
      uri: hierarchy.coarseBinaryUri,
      byteLength: hierarchy.coarseBinaryByteLength,
    });
  }
  if (hierarchy.properties) resources.push(hierarchy.properties);
  if (hierarchy.spatialIndex) resources.push(hierarchy.spatialIndex);
  // The sidecar's column file declares its own length inside the sidecar, so
  // only the JSON is countable here; the columns are bounded on their own.
  if (hierarchy.relocatedHierarchy) resources.push(hierarchy.relocatedHierarchy);
  return resources;
}

/** The bounded reader returns exact-size views; only a partial view is copied. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : bytes.slice().buffer;
}

/**
 * A compiled document as far as the loader takes it: the bytes to hand to the
 * geometry Worker, and the transfer policy or selected files the Worker needs to
 * read anything beside them. The document is deliberately not parsed here — the
 * Worker owns the only parsed copy for the whole scene session.
 */
export interface OpenedSceneDocument {
  readonly documentSource: GeometryDocumentSource;
  /**
   * Bytes of the compiled glTF document as transferred. Recorded here because
   * the Worker takes ownership of the buffer, after which its own byte length
   * reads as zero.
   */
  readonly documentByteLength: number;
  /**
   * The policy this package was opened under. Absent for local files, which are
   * never transferred.
   */
  readonly transport?: PackageTransport;
  /** `.json` files selected beside a local glTF, for a relocated hierarchy. */
  readonly sidecarFiles?: readonly File[];
  /** `.bin` files selected beside a local glTF, for that sidecar's columns. */
  readonly binaryFiles?: readonly File[];
  readonly label: string;
}

/** What the geometry Worker read while parsing the document it was handed. */
export interface PreparedSceneHierarchy {
  readonly hierarchy: CompiledHierarchy;
  /**
   * Bytes of the relocated hierarchy sidecar, JSON header plus columns. Recorded
   * when the Worker reads it because the sidecar is read once and dropped: only
   * the decoded tree outlives it, and nothing later can restate the size.
   */
  readonly relocatedHierarchyBytes?: number;
}

/**
 * Fetches or opens the compiled document without parsing it. A remote package
 * settles one transfer policy here and then carries it: every resource below,
 * the sidecars, and the Worker that fetches ranges read it from this object
 * instead of reaching for the defaults on their own.
 */
export async function openSceneDocument(
  source: SceneSource,
  signal?: AbortSignal,
  policy?: PackageTransportPolicy,
): Promise<OpenedSceneDocument> {
  if (source.kind === "url") {
    const transport = openPackageTransport(source.gltfUrl, policy);
    const documentBytes = await transport.fetchResource(source.gltfUrl, {
      kind: "gltf",
      label: source.gltfUrl.href,
      limitBytes: transport.limits.documentBytes,
      ...(signal ? { signal } : {}),
    });
    return {
      documentSource: { kind: "bytes", bytes: bufferOf(documentBytes) },
      documentByteLength: documentBytes.byteLength,
      transport,
      label: source.gltfUrl.href,
    };
  }
  return {
    documentSource: { kind: "file", file: source.gltfFile },
    documentByteLength: source.gltfFile.size,
    sidecarFiles: source.sidecarFiles,
    binaryFiles: source.binaryFiles,
    label: [source.gltfFile, ...source.binaryFiles].map(({ name }) => name).join(" + "),
  };
}

/**
 * Resolves every resource the assembly tree declares, once the Worker has read
 * that tree. Nothing is fetched or parsed here: a remote package is held to its
 * budget and handed URLs, a local package is matched against the files the user
 * selected.
 */
export function resolveSceneResources(
  source: SceneSource,
  opened: OpenedSceneDocument,
  prepared: PreparedSceneHierarchy,
): LoadedSceneHierarchy {
  const { hierarchy, relocatedHierarchyBytes } = prepared;
  const common = {
    documentSource: opened.documentSource,
    documentByteLength: opened.documentByteLength,
    hierarchy,
    ...(relocatedHierarchyBytes === undefined ? {} : { relocatedHierarchyBytes }),
    label: opened.label,
  };

  if (source.kind === "url") {
    const transport = opened.transport;
    if (!transport) {
      throw new TypeError("A remote package needs the policy it was opened under.");
    }
    const resourceUrl = (uri: string): URL =>
      transport.resolveResourceUrl(uri, source.gltfUrl, source.gltfUrl.href);
    const targetUrl = resourceUrl(hierarchy.binaryUri);
    const coarseUrl = hierarchy.coarseBinaryUri
      ? resourceUrl(hierarchy.coarseBinaryUri)
      : undefined;
    const properties = hierarchy.properties;
    const spatialIndex = hierarchy.spatialIndex;
    // The hierarchy sidecar is read by the Worker before this check, because the
    // assembly tree cannot be read without it; each of its two resources is held
    // to the single-resource ceiling on its own. Nothing else is requested until
    // the whole package fits its budget.
    transport.assertBudget(opened.documentByteLength, declaredResources(hierarchy));
    return {
      ...common,
      transport: transport.describe(),
      targetBinary: { kind: "url", href: targetUrl.href },
      ...(coarseUrl ? { coarseBinary: { kind: "url" as const, href: coarseUrl.href } } : {}),
      ...(properties
        ? {
            properties: {
              kind: "url" as const,
              ref: properties,
              jsonUrl: resourceUrl(properties.uri),
              transport,
            },
          }
        : {}),
      ...(spatialIndex
        ? {
            spatialIndex: {
              kind: "url" as const,
              ref: spatialIndex,
              url: resourceUrl(spatialIndex.uri),
              transport,
            },
          }
        : {}),
    };
  }

  const fileFor = (uri: string): File | undefined => {
    const expectedName = resourceFileName(uri);
    return source.binaryFiles.find(({ name }) => name === expectedName);
  };
  const targetFile = fileFor(hierarchy.binaryUri);
  if (!targetFile) throw new TypeError(`Select ${hierarchy.binaryUri} with the glTF file.`);
  validateLocalBinary(hierarchy, targetFile);
  const coarseFile = hierarchy.coarseBinaryUri ? fileFor(hierarchy.coarseBinaryUri) : undefined;
  if (hierarchy.coarseBinaryUri && !coarseFile) {
    throw new TypeError(`Select ${hierarchy.coarseBinaryUri} with the glTF file.`);
  }
  if (coarseFile) validateLocalBinary(hierarchy, coarseFile, "coarse");
  const spatialRef = hierarchy.spatialIndex;
  const spatialFile = spatialRef ? fileFor(spatialRef.uri) : undefined;
  if (spatialRef && !spatialFile) {
    throw new TypeError(`Select ${spatialRef.uri} with the glTF file.`);
  }
  const propertiesRef = hierarchy.properties;
  const sidecarJsonFile = propertiesRef
    ? source.sidecarFiles.find(({ name }) => name === resourceFileName(propertiesRef.uri))
    : undefined;
  const geometryFiles = new Set([
    targetFile,
    ...(coarseFile ? [coarseFile] : []),
    ...(spatialFile ? [spatialFile] : []),
  ]);
  const extraBinaries = source.binaryFiles.filter((file) => !geometryFiles.has(file));
  // A relocated tree already reached the Worker, so its column file is one of
  // the binaries selected beside the glTF rather than an unexplained extra.
  const allowedExtraBinaries =
    (sidecarJsonFile ? 1 : 0) + (hierarchy.relocatedHierarchy ? 1 : 0);
  if (extraBinaries.length > allowedExtraBinaries) {
    const expectedResourceCount = geometryFiles.size + allowedExtraBinaries;
    throw new TypeError(
      `The glTF declares ${expectedResourceCount} external binary ` +
        `${expectedResourceCount === 1 ? "resource" : "resources"}.`,
    );
  }
  return {
    ...common,
    targetBinary: { kind: "file", file: targetFile },
    ...(coarseFile ? { coarseBinary: { kind: "file" as const, file: coarseFile } } : {}),
    ...(propertiesRef && sidecarJsonFile
      ? {
          properties: {
            kind: "file" as const,
            ref: propertiesRef,
            jsonFile: sidecarJsonFile,
            resourceFiles: extraBinaries,
          },
        }
      : {}),
    ...(spatialRef && spatialFile
      ? { spatialIndex: { kind: "file" as const, ref: spatialRef, file: spatialFile } }
      : {}),
  };
}
