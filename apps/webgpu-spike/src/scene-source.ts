import {
  assertPackageUrl,
  inspectCompiledHierarchy,
  openPackageTransport,
  readCompiledHierarchyRef,
} from "@naru3d/runtime-webgpu";
import type {
  CompiledHierarchy,
  DeclaredPackageResource,
  PackageTransportDescriptor,
  PackageTransportPolicy,
} from "@naru3d/runtime-webgpu";

import { loadHierarchySidecar } from "./hierarchy-sidecar.js";
import { resourceFileName } from "./property-sidecar.js";
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

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError(`${label} is not valid JSON.`);
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

export async function loadSceneHierarchy(
  source: SceneSource,
  signal?: AbortSignal,
  policy?: PackageTransportPolicy,
): Promise<LoadedSceneHierarchy> {
  if (source.kind === "url") {
    // One policy is settled here and then carried: every resource below, the
    // sidecars, and the Worker that fetches ranges all read it from this
    // object instead of reaching for the defaults on their own.
    const transport = openPackageTransport(source.gltfUrl, policy);
    const documentBytes = await transport.fetchResource(source.gltfUrl, {
      kind: "gltf",
      label: source.gltfUrl.href,
      limitBytes: transport.limits.documentBytes,
      ...(signal ? { signal } : {}),
    });
    const document = parseJson(new TextDecoder().decode(documentBytes), source.gltfUrl.href);
    // Every resource is resolved against the document URL and held to the
    // package budget before one of them is requested.
    const resourceUrl = (uri: string): URL =>
      transport.resolveResourceUrl(uri, source.gltfUrl, source.gltfUrl.href);
    // A relocated hierarchy lives beside the document, so its sidecar is
    // fetched before the tree is read rather than on demand.
    const hierarchyRef = readCompiledHierarchyRef(document);
    const hierarchySidecar = hierarchyRef
      ? await loadHierarchySidecar(
          {
            kind: "url",
            ref: hierarchyRef,
            jsonUrl: resourceUrl(hierarchyRef.uri),
            transport,
          },
          signal,
        )
      : undefined;
    const { hierarchy } = inspectCompiledHierarchy(
      document,
      hierarchySidecar ? { hierarchy: hierarchySidecar } : {},
    );
    const relocatedHierarchyBytes = hierarchyRef && hierarchySidecar
      ? hierarchyRef.byteLength + hierarchySidecar.columns.byteLength
      : undefined;
    const targetUrl = resourceUrl(hierarchy.binaryUri);
    const coarseUrl = hierarchy.coarseBinaryUri
      ? resourceUrl(hierarchy.coarseBinaryUri)
      : undefined;
    const propertiesUrl = hierarchy.properties
      ? resourceUrl(hierarchy.properties.uri)
      : undefined;
    const spatialUrl = hierarchy.spatialIndex
      ? resourceUrl(hierarchy.spatialIndex.uri)
      : undefined;
    // The hierarchy sidecar is fetched above, before this check, because the
    // assembly tree cannot be read without it; each of its two resources is
    // held to the single-resource ceiling on its own. Nothing else is
    // requested until the whole package fits its budget.
    transport.assertBudget(documentBytes.byteLength, declaredResources(hierarchy));
    return {
      documentSource: { kind: "bytes", bytes: bufferOf(documentBytes) },
      documentByteLength: documentBytes.byteLength,
      hierarchy,
      ...(relocatedHierarchyBytes === undefined ? {} : { relocatedHierarchyBytes }),
      transport: transport.describe(),
      targetBinary: { kind: "url", href: targetUrl.href },
      ...(coarseUrl ? { coarseBinary: { kind: "url" as const, href: coarseUrl.href } } : {}),
      ...(hierarchy.properties && propertiesUrl
        ? {
            properties: {
              kind: "url" as const,
              ref: hierarchy.properties,
              jsonUrl: propertiesUrl,
              transport,
            },
          }
        : {}),
      ...(hierarchy.spatialIndex && spatialUrl
        ? {
            spatialIndex: {
              kind: "url" as const,
              ref: hierarchy.spatialIndex,
              url: spatialUrl,
              transport,
            },
          }
        : {}),
      label: source.gltfUrl.href,
    };
  }

  const document = parseJson(await source.gltfFile.text(), source.gltfFile.name);
  const localHierarchyRef = readCompiledHierarchyRef(document);
  const localHierarchyJson = localHierarchyRef
    ? source.sidecarFiles.find(({ name }) => name === resourceFileName(localHierarchyRef.uri))
    : undefined;
  if (localHierarchyRef && !localHierarchyJson) {
    throw new TypeError(`Select ${localHierarchyRef.uri} with the glTF file.`);
  }
  // Bound to a name rather than inlined so the transferred sidecar size stays
  // readable here; the decoded tree is all that survives this call.
  const localHierarchySidecar = localHierarchyRef && localHierarchyJson
    ? await loadHierarchySidecar({
        kind: "file",
        ref: localHierarchyRef,
        jsonFile: localHierarchyJson,
        resourceFiles: source.binaryFiles,
      })
    : undefined;
  const { hierarchy } = inspectCompiledHierarchy(
    document,
    localHierarchySidecar ? { hierarchy: localHierarchySidecar } : {},
  );
  const fileFor = (uri: string): File | undefined => {
    const expectedName = decodeURIComponent(
      new URL(uri, "https://naru.local/").pathname.split("/").pop() ?? "",
    );
    return source.binaryFiles.find(({ name }) => name === expectedName);
  };
  const targetFile = fileFor(hierarchy.binaryUri);
  if (!targetFile) throw new TypeError(`Select ${hierarchy.binaryUri} with the glTF file.`);
  validateLocalBinary(hierarchy, targetFile);
  const coarseFile = hierarchy.coarseBinaryUri
    ? fileFor(hierarchy.coarseBinaryUri)
    : undefined;
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
  const allowedExtraBinaries = (sidecarJsonFile ? 1 : 0) + (localHierarchyJson ? 1 : 0);
  if (extraBinaries.length > allowedExtraBinaries) {
    const expectedResourceCount = geometryFiles.size + allowedExtraBinaries;
    throw new TypeError(
      `The glTF declares ${expectedResourceCount} external binary ` +
        `${expectedResourceCount === 1 ? "resource" : "resources"}.`,
    );
  }
  return {
    documentSource: { kind: "file", file: source.gltfFile },
    documentByteLength: source.gltfFile.size,
    hierarchy,
    ...(localHierarchyRef && localHierarchySidecar
      ? {
          relocatedHierarchyBytes:
            localHierarchyRef.byteLength + localHierarchySidecar.columns.byteLength,
        }
      : {}),
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
      ? {
          spatialIndex: {
            kind: "file" as const,
            ref: spatialRef,
            file: spatialFile,
          },
        }
      : {}),
    label: [source.gltfFile, ...source.binaryFiles].map(({ name }) => name).join(" + "),
  };
}
