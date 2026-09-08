import { openPackageTransport, packageResourceDigest } from "@naru3d/runtime-webgpu";
import type {
  CompiledHierarchyRef,
  CompiledHierarchySidecar,
  PackageTransport,
} from "@naru3d/runtime-webgpu";

import { resourceFileName } from "./property-sidecar.js";

/**
 * Where a package's `naru.package-hierarchy.1` sidecar can be loaded from. It
 * mirrors the property sidecar: URL scenes resolve the column file relative to
 * the sidecar JSON, local scenes look it up among the files the user selected.
 */
export type HierarchySidecarSource =
  | {
      readonly kind: "url";
      readonly ref: CompiledHierarchyRef;
      readonly jsonUrl: URL;
      readonly transport?: PackageTransport;
    }
  | {
      readonly kind: "file";
      readonly ref: CompiledHierarchyRef;
      readonly jsonFile: File;
      readonly resourceFiles: readonly File[];
    };

/**
 * The transfer policy a URL sidecar is read under. The scene loader settles one
 * policy for the whole package and passes it here; a caller that opens a
 * sidecar on its own gets the reviewed defaults for that resource's origin.
 */
function transportOf(
  source: Extract<HierarchySidecarSource, { readonly kind: "url" }>,
): PackageTransport {
  return source.transport ?? openPackageTransport(source.jsonUrl);
}

/**
 * Reads one sidecar resource under that policy. A string resource is a URI the
 * header declared, so it is resolved -- and held to the package origins -- by
 * the same transport that fetches it. The declared length is the ceiling.
 */
async function fetchSidecarResource(
  source: Extract<HierarchySidecarSource, { readonly kind: "url" }>,
  resource: URL | string,
  kind: "json" | "binary",
  byteLength: number,
  sha256: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const transport = transportOf(source);
  const url = typeof resource === "string"
    ? transport.resolveResourceUrl(resource, source.jsonUrl, source.jsonUrl.href)
    : resource;
  return transport.fetchResource(url, {
    kind,
    label: typeof resource === "string" ? resource : url.href,
    limitBytes: transport.resourceLimit(byteLength),
    expected: { sha256, byteLength },
    ...(signal ? { signal } : {}),
  });
}

interface SidecarColumns {
  readonly uri: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * A sidecar header carries the column file it belongs to; that much is read
 * here so the transfer can be bounded and authenticated. Everything else the
 * header declares is validated by the runtime decoder against the bytes.
 */
function columnsOf(json: unknown, uri: string): SidecarColumns {
  const columns = (json as { readonly columns?: unknown }).columns;
  if (
    typeof columns !== "object" ||
    columns === null ||
    typeof (columns as SidecarColumns).uri !== "string" ||
    !Number.isInteger((columns as SidecarColumns).byteLength) ||
    !/^[0-9a-f]{64}$/u.test((columns as SidecarColumns).sha256 ?? "")
  ) {
    throw new TypeError(`${uri} must declare its column file.`);
  }
  return columns as SidecarColumns;
}

async function verify(
  bytes: Uint8Array,
  uri: string,
  byteLength: number,
  sha256: string,
): Promise<Uint8Array> {
  if (bytes.byteLength !== byteLength) {
    throw new RangeError(
      `${uri} must be ${String(byteLength)} bytes; received ${String(bytes.byteLength)}.`,
    );
  }
  if ((await packageResourceDigest(bytes)) !== sha256) {
    throw new TypeError(`Hierarchy sidecar digest mismatch for ${uri}.`);
  }
  return bytes;
}

/**
 * Loads and authenticates both sidecar resources.
 *
 * Unlike the property sidecar this is not lazy: a package that relocates its
 * hierarchy has no assembly tree in the document at all, so the tree panel
 * cannot be built before these bytes arrive.
 */
export async function loadHierarchySidecar(
  source: HierarchySidecarSource,
  signal?: AbortSignal,
): Promise<CompiledHierarchySidecar> {
  const { ref } = source;
  const jsonBytes = source.kind === "url"
    ? await fetchSidecarResource(source, source.jsonUrl, "json", ref.byteLength, ref.sha256, signal)
    : new Uint8Array(await source.jsonFile.arrayBuffer());
  await verify(jsonBytes, ref.uri, ref.byteLength, ref.sha256);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes)) as unknown;
  const columns = columnsOf(json, ref.uri);
  const columnBytes = source.kind === "url"
    ? await fetchSidecarResource(
        source,
        columns.uri,
        "binary",
        columns.byteLength,
        columns.sha256,
        signal,
      )
    : await readLocalColumns(source.resourceFiles, columns.uri);
  await verify(columnBytes, columns.uri, columns.byteLength, columns.sha256);
  return { json, columns: columnBytes };
}

async function readLocalColumns(
  resourceFiles: readonly File[],
  uri: string,
): Promise<Uint8Array> {
  const expectedName = resourceFileName(uri);
  const file = resourceFiles.find(({ name }) => name === expectedName);
  if (!file) throw new TypeError(`Select ${expectedName} with the glTF file.`);
  return new Uint8Array(await file.arrayBuffer());
}
