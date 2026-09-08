import { describe, expect, it, vi } from "vitest";

import {
  MemoryPersistentPackageStorage,
  PersistentPackageCache,
  persistentPackageCacheManifestSchema,
  persistentPackageCacheSchema,
} from "../src/package-cache.js";
import { openPackageTransport, packageResourceDigest } from "../src/package-transport.js";

async function resource(seed: number, byteLength = 64): Promise<{ bytes: Uint8Array; identity: { sha256: string; byteLength: number } }> {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) bytes[index] = (seed * 31 + index) & 0xff;
  return { bytes, identity: { sha256: await packageResourceDigest(bytes), byteLength } };
}

function tier(storage = new MemoryPersistentPackageStorage(), quotaBytes = 256): {
  storage: MemoryPersistentPackageStorage;
  cache: PersistentPackageCache;
  warnings: string[];
} {
  const warnings: string[] = [];
  const cache = new PersistentPackageCache(storage, { quotaBytes, warn: (m) => warnings.push(m) });
  return { storage, cache, warnings };
}

describe("PersistentPackageCache", () => {
  it("misses cold, publishes, then hits warm from a second instance", async () => {
    const { storage, cache } = tier();
    const a = await resource(1);
    expect(await cache.lookup(a.identity, "a")).toBeUndefined();
    await cache.publish(a.identity, a.bytes, "a");
    const warm = tier(storage);
    const held = await warm.cache.lookup(a.identity, "a");
    expect(held).toEqual(a.bytes);
    expect(warm.cache.stats()).toMatchObject({ state: "ready", hits: 1, misses: 0, entries: 1, storedBytes: 64 });
    expect(cache.stats()).toMatchObject({ misses: 1, published: 1 });
  });

  it("drops a corrupted entry as an invalidated miss instead of returning it", async () => {
    const { storage, cache, warnings } = tier();
    const a = await resource(2);
    await cache.publish(a.identity, a.bytes, "a");
    storage.corrupt(`${persistentPackageCacheSchema}/${a.identity.sha256}`, new Uint8Array(64));
    const warm = tier(storage);
    expect(await warm.cache.lookup(a.identity, "a")).toBeUndefined();
    expect(warm.cache.stats()).toMatchObject({ invalidated: 1, misses: 1, entries: 0 });
    expect(await storage.keys()).not.toContain(`${persistentPackageCacheSchema}/${a.identity.sha256}`);
    expect(warnings).toHaveLength(0);
  });

  it("treats a declared byte length that differs from the entry as a miss", async () => {
    const { cache } = tier();
    const a = await resource(3);
    await cache.publish(a.identity, a.bytes, "a");
    expect(await cache.lookup({ ...a.identity, byteLength: 63 }, "a")).toBeUndefined();
  });

  it("resets and wipes the store when the manifest is foreign or unparsable", async () => {
    const storage = new MemoryPersistentPackageStorage();
    await storage.put(`${persistentPackageCacheSchema}/manifest`, new TextEncoder().encode("{not json"));
    await storage.put(`${persistentPackageCacheSchema}/${"0".repeat(64)}`, new Uint8Array(8));
    const { cache } = tier(storage);
    await cache.open();
    expect(cache.stats().state).toBe("reset");
    expect(await storage.keys()).toEqual([]);
    const a = await resource(20);
    await cache.publish(a.identity, a.bytes, "a");
    const manifest = JSON.parse(
      new TextDecoder().decode((await storage.get(`${persistentPackageCacheSchema}/manifest`)) ?? new Uint8Array()),
    ) as { schemaVersion: string; entries: unknown[] };
    expect(manifest.schemaVersion).toBe(persistentPackageCacheManifestSchema);
    expect(manifest.entries).toHaveLength(1);
  });

  it("evicts least recently used unprotected entries deterministically and never protected ones", async () => {
    const { cache } = tier(new MemoryPersistentPackageStorage(), 192);
    const [a, b, c, d] = await Promise.all([resource(4), resource(5), resource(6), resource(7)]);
    await cache.publish(a.identity, a.bytes, "a");
    await cache.publish(b.identity, b.bytes, "b");
    await cache.publish(c.identity, c.bytes, "c");
    cache.release();
    await cache.lookup(a.identity, "a"); // a is now most recent AND protected
    await cache.publish(d.identity, d.bytes, "d"); // needs 64 B: b is the LRU victim
    expect(cache.entries().map((e) => e.sha256)).toEqual([c, a, d].map((r) => r.identity.sha256));
    expect(cache.stats()).toMatchObject({ evicted: 1, entries: 3, storedBytes: 192, protectedEntries: 2 });
  });

  it("refuses a publish when protected entries fill the quota or the resource exceeds it", async () => {
    const { cache, warnings } = tier(new MemoryPersistentPackageStorage(), 128);
    const [a, b, c, big] = await Promise.all([resource(8), resource(9), resource(10), resource(11, 129)]);
    await cache.publish(a.identity, a.bytes, "a");
    await cache.publish(b.identity, b.bytes, "b");
    await cache.publish(c.identity, c.bytes, "c");
    expect(cache.entries()).toHaveLength(2);
    expect(cache.stats().refused).toBe(1);
    await cache.publish(big.identity, big.bytes, "big");
    expect(cache.stats().refused).toBe(2);
    expect(warnings.some((w) => w.includes("protected entries fill the quota"))).toBe(true);
  });
});

describe("PersistentPackageCache under contention", () => {
  it("rejects an aborted lookup without touching the store", async () => {
    const { cache } = tier();
    const a = await resource(12);
    await cache.publish(a.identity, a.bytes, "a");
    const controller = new AbortController();
    controller.abort();
    await expect(cache.lookup(a.identity, "a", controller.signal)).rejects.toThrow();
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 0 });
  });

  it("serializes concurrent lookups and publishes of one key onto one entry", async () => {
    const { storage, cache } = tier();
    const a = await resource(13);
    await Promise.all([
      cache.publish(a.identity, a.bytes, "a"),
      cache.publish(a.identity, a.bytes, "a"),
      cache.lookup(a.identity, "a"),
      cache.lookup(a.identity, "a"),
    ]);
    expect(cache.entries()).toHaveLength(1);
    expect((await storage.keys()).filter((k) => k.endsWith(a.identity.sha256))).toHaveLength(1);
    expect(cache.stats().published).toBe(1);
  });

  it("never lets two writers publish different bytes under one key", async () => {
    const { storage, cache, warnings } = tier();
    const a = await resource(14);
    const forged = new Uint8Array(a.bytes);
    forged[0] = (forged[0] ?? 0) ^ 0xff;
    await Promise.all([cache.publish(a.identity, forged, "forged"), cache.publish(a.identity, a.bytes, "a")]);
    expect(await storage.get(`${persistentPackageCacheSchema}/${a.identity.sha256}`)).toEqual(a.bytes);
    expect(cache.stats()).toMatchObject({ published: 1, refused: 1 });
    expect(warnings.some((w) => w.includes("do not match their declared identity"))).toBe(true);
  });

  it("clear() empties the store and later lookups miss", async () => {
    const { storage, cache } = tier();
    const a = await resource(15);
    await cache.publish(a.identity, a.bytes, "a");
    await cache.clear();
    expect(cache.entries()).toEqual([]);
    expect(await storage.keys()).toEqual([`${persistentPackageCacheSchema}/manifest`]);
    expect(await cache.lookup(a.identity, "a")).toBeUndefined();
  });
});

describe("PackageTransport with persistence", () => {
  const documentUrl = new URL("https://example.com/package/scene.gltf");

  function fetchOf(bytes: Uint8Array) {
    return vi.fn(async () =>
      new Response(bytes.slice().buffer, {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
      }),
    ) as unknown as typeof fetch;
  }

  it("serves a verified hit without fetching and publishes a miss after fetching", async () => {
    const { cache } = tier();
    const a = await resource(16);
    const fetchSpy = fetchOf(a.bytes);
    const transport = openPackageTransport(documentUrl, { persistence: cache, fetch: fetchSpy });
    const request = {
      kind: "binary" as const,
      label: "properties.bin",
      expected: a.identity,
      limitBytes: transport.resourceLimit(a.identity.byteLength),
    };
    const url = new URL("properties.bin", documentUrl);
    expect(await transport.fetchResource(url, request)).toEqual(a.bytes);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ misses: 1, published: 1 });
    expect(await transport.fetchResource(url, request)).toEqual(a.bytes);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBe(1);
  });

  it("returns mismatching network bytes to the caller but never publishes them", async () => {
    const { cache } = tier();
    const a = await resource(17);
    const other = await resource(18);
    const transport = openPackageTransport(documentUrl, { persistence: cache, fetch: fetchOf(other.bytes) });
    const bytes = await transport.fetchResource(new URL("properties.bin", documentUrl), {
      kind: "binary",
      label: "properties.bin",
      expected: a.identity,
      limitBytes: transport.resourceLimit(a.identity.byteLength),
    });
    expect(bytes).toEqual(other.bytes);
    expect(cache.entries()).toEqual([]);
    expect(cache.stats().refused).toBe(1);
  });

  it("does not persist a resource without a declared identity", async () => {
    const { cache } = tier();
    const a = await resource(19);
    const transport = openPackageTransport(documentUrl, { persistence: cache, fetch: fetchOf(a.bytes) });
    await transport.fetchResource(new URL("scene.bin", documentUrl), {
      kind: "binary",
      label: "scene.bin",
      limitBytes: transport.resourceLimit(a.bytes.byteLength),
    });
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 0, published: 0 });
  });
});
