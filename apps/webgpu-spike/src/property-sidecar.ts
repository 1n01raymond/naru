import {
  openPropertyValueColumns,
  packagePropertiesSchema,
  parsePackageProperties,
  resolvePropertyEntries,
} from "@naru3d/scene-ir";
import type {
  ColumnPropertyBag,
  PackagePropertiesDocument,
  PropertyValue,
  PropertyValueColumnReader,
} from "@naru3d/scene-ir";
import {
  openPackageTransport,
  packageResourceDigest as sha256,
} from "@naru3d/runtime-webgpu";
import type { CompiledPropertiesRef, PackageTransport } from "@naru3d/runtime-webgpu";

/**
 * Where a scene's `madi.package-properties.1` sidecar can be loaded from. URL
 * scenes resolve both sidecar resources relative to the sidecar JSON; local
 * scenes look the column file up among the extra `.bin` files the user
 * selected next to the glTF.
 */
export type PropertySidecarSource =
  | {
      readonly kind: "url";
      readonly ref: CompiledPropertiesRef;
      readonly jsonUrl: URL;
      /** Settled by the loader that fetched the glTF; defaulted when absent. */
      readonly transport?: PackageTransport;
    }
  | {
      readonly kind: "file";
      readonly ref: CompiledPropertiesRef;
      readonly jsonFile: File;
      readonly resourceFiles: readonly File[];
    };

export interface SemanticPropertyEntries {
  readonly semanticId: string;
  readonly schema?: string;
  readonly entries: readonly (readonly [string, PropertyValue])[];
}

export interface OpenPropertySidecar {
  readonly document: PackagePropertiesDocument;
  readonly reader: PropertyValueColumnReader;
  readonly indexBySemanticId: ReadonlyMap<string, number>;
}

/** Renders one property value for the inspector panel. */
export function formatPropertyValue(value: PropertyValue): string {
  if (value === null) return "null";
  if (typeof value !== "object") return String(value);
  switch (value.type) {
    case "quantity":
      return `${String(value.value)} ${value.unit}`;
    case "enum":
    case "uri":
      return value.value;
    case "array":
      return value.values.map(formatPropertyValue).join(", ");
  }
}

export function resourceFileName(uri: string): string {
  return decodeURIComponent(new URL(uri, "https://naru.local/").pathname.split("/").pop() ?? "");
}

/**
 * The transfer policy a URL sidecar is read under. The scene loader settles one
 * policy for the whole package and passes it here; a caller that opens a
 * sidecar on its own gets the reviewed defaults for that resource's origin.
 */
function transportOf(
  source: Extract<PropertySidecarSource, { readonly kind: "url" }>,
): PackageTransport {
  return source.transport ?? openPackageTransport(source.jsonUrl);
}

/**
 * Both sidecar resources declare their own byte length, so that length is the
 * ceiling the transfer is held to; the digest check below then authenticates
 * what arrived.
 */
async function fetchBytes(
  source: Extract<PropertySidecarSource, { readonly kind: "url" }>,
  resource: URL | string,
  kind: "json" | "binary",
  declaredByteLength: number,
  sha256: string,
): Promise<Uint8Array> {
  const transport = transportOf(source);
  // A string resource is a URI the header declared, so the same transport that
  // fetches it resolves it and holds it to the package origins.
  const url = typeof resource === "string"
    ? transport.resolveResourceUrl(resource, source.jsonUrl, source.jsonUrl.href)
    : resource;
  return transport.fetchResource(url, {
    kind,
    label: typeof resource === "string" ? resource : url.href,
    limitBytes: transport.resourceLimit(declaredByteLength),
    // The declared identity lets a verified persistent tier serve or keep the
    // bytes; the digest check after the read stays in force either way.
    expected: { sha256, byteLength: declaredByteLength },
  });
}

/**
 * Lazily loads a compiled package's property sidecar: nothing is fetched
 * until the first `entriesFor` call, and both resources are validated once
 * (declared byte lengths and SHA-256 digests,
 * `madi.package-properties.1` parse, column header open) and then reused for
 * every later selection.
 */
export class PropertySidecarStore {
  readonly source: PropertySidecarSource;
  private opened?: Promise<OpenPropertySidecar>;

  constructor(source: PropertySidecarSource) {
    this.source = source;
  }

  open(): Promise<OpenPropertySidecar> {
    this.opened ??= this.load();
    return this.opened;
  }

  /**
   * Resolves the panel entries for one semantic, or undefined when the
   * semantic carries no column-backed properties.
   */
  async entriesFor(semanticId: string): Promise<SemanticPropertyEntries | undefined> {
    const { document, reader, indexBySemanticId } = await this.open();
    const index = indexBySemanticId.get(semanticId);
    if (index === undefined) return undefined;
    const schemaIndex = document.semanticSchemas[index] ?? null;
    const schema = schemaIndex === null ? undefined : document.schemas[schemaIndex];
    const bag: ColumnPropertyBag = {
      set: document.semanticSets[index] as number,
      row: document.semanticRows[index] as number,
      ...(schema === undefined ? {} : { schema }),
    };
    const resolved = resolvePropertyEntries(bag, document.propertyIndex, reader);
    const entries = Object.entries(resolved).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return { semanticId, ...(schema === undefined ? {} : { schema }), entries };
  }

  private async load(): Promise<OpenPropertySidecar> {
    const { ref } = this.source;
    if (ref.schemaVersion !== packagePropertiesSchema) {
      throw new TypeError(`Unsupported property sidecar schema ${ref.schemaVersion}.`);
    }
    const source = this.source;
    const jsonBytes = source.kind === "url"
      ? await fetchBytes(source, source.jsonUrl, "json", ref.byteLength, ref.sha256)
      : new Uint8Array(await source.jsonFile.arrayBuffer());
    if (jsonBytes.byteLength !== ref.byteLength) {
      throw new RangeError(
        `${ref.uri} must be ${String(ref.byteLength)} bytes; ` +
          `received ${String(jsonBytes.byteLength)}.`,
      );
    }
    const jsonDigest = await sha256(jsonBytes);
    if (jsonDigest !== ref.sha256) {
      throw new TypeError(`Property sidecar digest mismatch for ${ref.uri}.`);
    }
    const document = parsePackageProperties(
      JSON.parse(new TextDecoder().decode(jsonBytes)),
    );
    const columns = source.kind === "url"
      ? await fetchBytes(
          source,
          document.columns.uri,
          "binary",
          document.columns.byteLength,
          document.columns.sha256,
        )
      : await this.readLocalColumns(document.columns.uri);
    if (columns.byteLength !== document.columns.byteLength) {
      throw new RangeError(
        `${document.columns.uri} must be ${String(document.columns.byteLength)} bytes; ` +
          `received ${String(columns.byteLength)}.`,
      );
    }
    const columnDigest = await sha256(columns);
    if (columnDigest !== document.columns.sha256) {
      throw new TypeError(`Property column digest mismatch for ${document.columns.uri}.`);
    }
    const reader = openPropertyValueColumns(document.propertyValues, columns);
    return {
      document,
      reader,
      indexBySemanticId: new Map(document.semanticIds.map((id, index) => [id, index])),
    };
  }

  private async readLocalColumns(uri: string): Promise<Uint8Array> {
    if (this.source.kind !== "file") throw new TypeError("Local columns need file sources.");
    const expectedName = resourceFileName(uri);
    const file = this.source.resourceFiles.find(({ name }) => name === expectedName);
    if (!file) throw new TypeError(`Select ${expectedName} with the glTF file.`);
    return new Uint8Array(await file.arrayBuffer());
  }
}
