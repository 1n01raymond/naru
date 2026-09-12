import { createHash } from "node:crypto";

import { packagePropertiesSchema } from "@naru3d/scene-ir";
import type { PackagePropertiesDocument } from "@naru3d/scene-ir";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatPropertyValue, PropertySidecarStore } from "../src/property-sidecar.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function fixture() {
  const columns = new Uint8Array(16);
  const document: PackagePropertiesDocument = {
    schemaVersion: packagePropertiesSchema,
    status: "experimental-not-interchange",
    sceneId: "scene-a",
    revisionId: "revision-a",
    sourceDigest: "sha256:source-a",
    propertyIndex: { keys: [], sets: [] },
    schemas: [],
    semanticIds: [],
    semanticSchemas: [],
    semanticSets: [],
    semanticRows: [],
    columns: {
      uri: "properties.bin",
      byteLength: columns.byteLength,
      sha256: sha256(columns),
    },
    propertyValues: {
      encoding: "madi.property-columns.1",
      valueCount: 0,
      rowCount: 0,
      distinctValueCount: 0,
      rows: { encoding: "u32le", byteOffset: 0, byteLength: 0 },
      rowOffsets: { encoding: "u32le", byteOffset: 0, byteLength: 4 },
      valueOffsets: { encoding: "u32le", byteOffset: 8, byteLength: 4 },
      valueHeap: { encoding: "utf8-json", byteOffset: 16, byteLength: 0 },
    },
  };
  const jsonBytes = new TextEncoder().encode(`${JSON.stringify(document)}\n`);
  return {
    columns,
    jsonBytes,
    ref: {
      schemaVersion: packagePropertiesSchema,
      uri: "properties.json",
      byteLength: jsonBytes.byteLength,
      sha256: sha256(jsonBytes),
    },
  };
}

function localStore(
  value: ReturnType<typeof fixture>,
  jsonBytes = value.jsonBytes,
  columns = value.columns,
): PropertySidecarStore {
  return new PropertySidecarStore({
    kind: "file",
    ref: value.ref,
    jsonFile: new File([ownedBuffer(jsonBytes)], "properties.json"),
    resourceFiles: [new File([ownedBuffer(columns)], "properties.bin")],
  });
}

function urlStore(
  value: ReturnType<typeof fixture>,
  jsonBytes = value.jsonBytes,
  columns = value.columns,
): PropertySidecarStore {
  const jsonUrl = new URL("https://example.test/model/properties.json");
  const resources = new Map([
    [jsonUrl.href, jsonBytes],
    [new URL("properties.bin", jsonUrl).href, columns],
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const href = input instanceof URL ? input.href : input;
      const bytes = resources.get(href);
      return bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(ownedBuffer(bytes));
    }),
  );
  return new PropertySidecarStore({ kind: "url", ref: value.ref, jsonUrl });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("property sidecar helpers", () => {
  it("formats every property value shape for the inspector panel", () => {
    expect(formatPropertyValue(null)).toBe("null");
    expect(formatPropertyValue(true)).toBe("true");
    expect(formatPropertyValue(21.5)).toBe("21.5");
    expect(formatPropertyValue("Concrete")).toBe("Concrete");
    expect(formatPropertyValue({ type: "quantity", value: 2.4, unit: "m" })).toBe("2.4 m");
    expect(formatPropertyValue({ type: "enum", value: "EXTERNAL", schema: "IFC4" })).toBe(
      "EXTERNAL",
    );
    expect(formatPropertyValue({ type: "uri", value: "https://example.com/spec" })).toBe(
      "https://example.com/spec",
    );
    expect(
      formatPropertyValue({
        type: "array",
        values: [1, { type: "quantity", value: 3, unit: "mm" }],
      }),
    ).toBe("1, 3 mm");
  });
});

describe("property sidecar integrity", () => {
  it("verifies and opens local and URL sidecar resources", async () => {
    const value = fixture();

    await expect(localStore(value).open()).resolves.toMatchObject({
      document: { sceneId: "scene-a" },
    });
    await expect(urlStore(value).open()).resolves.toMatchObject({
      document: { sceneId: "scene-a" },
    });
  });

  it("rejects same-length JSON tampering for local and URL sources", async () => {
    const value = fixture();
    const tampered = value.jsonBytes.slice();
    tampered[tampered.byteLength - 1] = 0x20;
    expect(tampered.byteLength).toBe(value.ref.byteLength);

    await expect(localStore(value, tampered).open()).rejects.toThrow(
      /Property sidecar digest mismatch/u,
    );
    await expect(urlStore(value, tampered).open()).rejects.toThrow(
      /Property sidecar digest mismatch/u,
    );
  });

  it("rejects same-length column tampering for local and URL sources", async () => {
    const value = fixture();
    const tampered = value.columns.slice();
    tampered[tampered.byteLength - 1] = 1;
    expect(tampered.byteLength).toBe(value.columns.byteLength);

    await expect(localStore(value, value.jsonBytes, tampered).open()).rejects.toThrow(
      /Property column digest mismatch/u,
    );
    await expect(urlStore(value, value.jsonBytes, tampered).open()).rejects.toThrow(
      /Property column digest mismatch/u,
    );
  });
});
