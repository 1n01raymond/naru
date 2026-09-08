import { packageResourceDigest } from "./package-transport.js";

/**
 * Verified persistent package cache (ADR-0024).
 *
 * Keeps the encoded bytes of compiled package resources across browser
 * sessions so an unchanged package reopens without refetching them. A resource
 * is only ever served from here when the caller already holds the SHA-256 and
 * byte length the package declares for it, and every hit is re-hashed before it
 * is returned, so a hit is verified to exactly the contract the live fetch it
 * replaces is verified to. Encoded bytes stored here are accounted separately
 * from decoded geometry and GPU residency, which keep their own budgets.
 */

/** Names the entry namespace; a schema bump is a cold namespace. */
export const persistentPackageCacheSchema = "naru.persistent-package-cache.1";
export const persistentPackageCacheManifestSchema = "naru.persistent-package-cache-manifest.1";
export const defaultPersistentPackageCacheQuotaBytes = 256 * 1024 * 1024;

/** The identity a package declares for a resource before it is fetched. */
export interface PackageResourceIdentity {
  readonly sha256: string;
  readonly byteLength: number;
}

/** What a transport asks of a persistence tier. */
export interface PackageResourcePersistence {
  /** Verified bytes for the identity, or `undefined` for any kind of miss. */
  lookup(identity: PackageResourceIdentity, label: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
  /** Offers bytes a live fetch produced. Never throws; refusal is a stat. */
  publish(identity: PackageResourceIdentity, bytes: Uint8Array, label: string): Promise<void>;
}

/** The storage primitive under the cache: a flat, key-addressed byte store. */
export interface PersistentPackageStorage {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

export interface PersistentPackageCacheEntry {
  readonly sha256: string;
  readonly byteLength: number;
  /** Position in the use order; higher is more recent. Never a clock. */
  readonly lastUse: number;
}

export interface PersistentPackageCacheManifest {
  readonly schemaVersion: typeof persistentPackageCacheManifestSchema;
  readonly nextUse: number;
  readonly entries: readonly PersistentPackageCacheEntry[];
}

export type PersistentPackageCacheState = "closed" | "ready" | "reset";

export interface PersistentPackageCacheStats {
  readonly state: PersistentPackageCacheState;
  readonly quotaBytes: number;
  readonly entries: number;
  /** Encoded bytes held under the quota: never decoded or GPU bytes. */
  readonly storedBytes: number;
  readonly protectedEntries: number;
  readonly hits: number;
  readonly misses: number;
  readonly published: number;
  readonly refused: number;
  readonly evicted: number;
  readonly invalidated: number;
}

export interface PersistentPackageCacheOptions {
  readonly quotaBytes?: number;
  readonly warn?: (message: string) => void;
}

const sha256Pattern = /^[0-9a-f]{64}$/;
const manifestKey = `${persistentPackageCacheSchema}/manifest`;

function entryKey(sha256: string): string {
  return `${persistentPackageCacheSchema}/${sha256}`;
}

function validIdentity(identity: PackageResourceIdentity): boolean {
  return (
    sha256Pattern.test(identity.sha256) &&
    Number.isSafeInteger(identity.byteLength) &&
    identity.byteLength >= 0
  );
}

function parseManifest(bytes: Uint8Array): PersistentPackageCacheManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== persistentPackageCacheManifestSchema) return undefined;
  if (!Number.isSafeInteger(record.nextUse) || !Array.isArray(record.entries)) return undefined;
  const entries: PersistentPackageCacheEntry[] = [];
  for (const item of record.entries as unknown[]) {
    if (typeof item !== "object" || item === null) return undefined;
    const entry = item as Record<string, unknown>;
    if (typeof entry.sha256 !== "string" || !Number.isSafeInteger(entry.byteLength)) return undefined;
    if (!Number.isSafeInteger(entry.lastUse)) return undefined;
    const identity = { sha256: entry.sha256, byteLength: entry.byteLength as number };
    if (!validIdentity(identity)) return undefined;
    entries.push({ ...identity, lastUse: entry.lastUse as number });
  }
  return { schemaVersion: persistentPackageCacheManifestSchema, nextUse: record.nextUse as number, entries };
}

/**
 * Content-addressed, quota-bounded, least-recently-used cache over a flat byte
 * store. Every manifest mutation runs through one queue so a single instance
 * is deterministic; across instances (two tabs) the manifest is last-writer-
 * wins and entries are self-verifying, so the worst outcome of a race is an
 * unlisted entry, which the next open sweeps.
 */
export class PersistentPackageCache implements PackageResourcePersistence {
  readonly quotaBytes: number;
  readonly #storage: PersistentPackageStorage;
  readonly #warn: (message: string) => void;
  readonly #protected = new Set<string>();
  #entries = new Map<string, PersistentPackageCacheEntry>();
  #nextUse = 0;
  #state: PersistentPackageCacheState = "closed";
  #ready: Promise<void> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #hits = 0;
  #misses = 0;
  #published = 0;
  #refused = 0;
  #evicted = 0;
  #invalidated = 0;

  constructor(storage: PersistentPackageStorage, options: PersistentPackageCacheOptions = {}) {
    const quota = options.quotaBytes ?? defaultPersistentPackageCacheQuotaBytes;
    if (!Number.isSafeInteger(quota) || quota < 0) {
      throw new RangeError("The persistent package cache quota must be a non-negative integer.");
    }
    this.quotaBytes = quota;
    this.#storage = storage;
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Reads the manifest, drops what cannot be trusted, sweeps orphans. */
  open(): Promise<void> {
    this.#ready ??= this.#serialized(() => this.#open());
    return this.#ready;
  }

  async #open(): Promise<void> {
    let keys: readonly string[] = [];
    let manifest: PersistentPackageCacheManifest | undefined;
    try {
      keys = await this.#storage.keys();
      const bytes = keys.includes(manifestKey) ? await this.#storage.get(manifestKey) : undefined;
      manifest = bytes ? parseManifest(bytes) : undefined;
      if (bytes && !manifest) {
        // A foreign or damaged manifest names nothing this build can trust.
        this.#state = "reset";
        this.#warn("Persistent package cache manifest was unreadable; the cache was reset.");
        for (const key of keys) await this.#storage.delete(key);
        keys = [];
      }
    } catch (error) {
      this.#state = "reset";
      this.#warn(`Persistent package cache could not be opened: ${describe(error)}`);
      manifest = undefined;
    }
    const present = new Set(keys);
    this.#entries = new Map();
    for (const entry of manifest?.entries ?? []) {
      if (present.has(entryKey(entry.sha256))) this.#entries.set(entry.sha256, entry);
    }
    this.#nextUse = manifest?.nextUse ?? 0;
    for (const key of keys) {
      if (key === manifestKey || !key.startsWith(`${persistentPackageCacheSchema}/`)) continue;
      if (!this.#entries.has(key.slice(persistentPackageCacheSchema.length + 1))) {
        await this.#tryDelete(key);
      }
    }
    if (this.#state === "closed") this.#state = "ready";
  }

  async lookup(
    identity: PackageResourceIdentity,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    await this.open();
    signal?.throwIfAborted();
    const entry = this.#entries.get(identity.sha256);
    if (!entry || entry.byteLength !== identity.byteLength) return this.#miss();
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.#storage.get(entryKey(identity.sha256));
    } catch (error) {
      this.#warn(`Persistent package cache could not read ${label}: ${describe(error)}`);
      return this.#miss();
    }
    signal?.throwIfAborted();
    if (!bytes || !(await this.#matches(identity, bytes))) {
      this.#invalidated += 1;
      this.#warn(`Persistent package cache entry for ${label} failed verification and was dropped.`);
      await this.#serialized(async () => {
        this.#entries.delete(identity.sha256);
        await this.#tryDelete(entryKey(identity.sha256));
        await this.#writeManifest();
      });
      return this.#miss();
    }
    this.#protected.add(identity.sha256);
    this.#hits += 1;
    await this.#serialized(() => this.#touch(identity.sha256));
    return bytes;
  }

  async publish(identity: PackageResourceIdentity, bytes: Uint8Array, label: string): Promise<void> {
    await this.open();
    if (!validIdentity(identity) || !(await this.#matches(identity, bytes))) {
      // The key is the digest, so bytes that do not hash to it can never be
      // published under it; this is what keeps two writers from disagreeing.
      this.#refuse(`Persistent package cache refused ${label}: bytes do not match their declared identity.`);
      return;
    }
    if (identity.byteLength > this.quotaBytes) {
      this.#refuse(`Persistent package cache refused ${label}: larger than the ${this.quotaBytes}-byte quota.`);
      return;
    }
    this.#protected.add(identity.sha256);
    await this.#serialized(async () => {
      if (this.#entries.has(identity.sha256)) {
        await this.#touch(identity.sha256);
        return;
      }
      const evict = this.#plan(identity.byteLength);
      if (!evict) {
        this.#refuse(`Persistent package cache refused ${label}: protected entries fill the quota.`);
        return;
      }
      try {
        await this.#storage.put(entryKey(identity.sha256), bytes);
      } catch (error) {
        this.#refuse(`Persistent package cache could not write ${label}: ${describe(error)}`);
        return;
      }
      for (const victim of evict) this.#entries.delete(victim.sha256);
      this.#entries.set(identity.sha256, { ...identity, lastUse: this.#nextUse++ });
      this.#published += 1;
      await this.#writeManifest();
      for (const victim of evict) {
        await this.#tryDelete(entryKey(victim.sha256));
        this.#evicted += 1;
      }
    });
  }

  /** Least-recently-used unprotected entries to free room, or `undefined`. */
  #plan(byteLength: number): PersistentPackageCacheEntry[] | undefined {
    let stored = 0;
    for (const entry of this.#entries.values()) stored += entry.byteLength;
    const victims: PersistentPackageCacheEntry[] = [];
    const candidates = [...this.#entries.values()]
      .filter((entry) => !this.#protected.has(entry.sha256))
      .sort((a, b) => a.lastUse - b.lastUse);
    for (const entry of candidates) {
      if (stored + byteLength <= this.quotaBytes) break;
      victims.push(entry);
      stored -= entry.byteLength;
    }
    return stored + byteLength <= this.quotaBytes ? victims : undefined;
  }

  /** Marks the open scene's resources; they are never evicted while held. */
  protect(sha256: string): void {
    this.#protected.add(sha256);
  }

  /** Releases every protection, typically before another scene loads. */
  release(): void {
    this.#protected.clear();
  }

  /** Deletes every entry and the manifest; the user's clear-cache action. */
  clear(): Promise<void> {
    return this.#serialized(async () => {
      await this.open();
      for (const sha256 of [...this.#entries.keys()]) await this.#tryDelete(entryKey(sha256));
      this.#entries.clear();
      this.#nextUse = 0;
      await this.#writeManifest();
    });
  }

  entries(): readonly PersistentPackageCacheEntry[] {
    return [...this.#entries.values()].sort((a, b) => a.lastUse - b.lastUse);
  }

  stats(): PersistentPackageCacheStats {
    let storedBytes = 0;
    for (const entry of this.#entries.values()) storedBytes += entry.byteLength;
    return {
      state: this.#state,
      quotaBytes: this.quotaBytes,
      entries: this.#entries.size,
      storedBytes,
      protectedEntries: this.#protected.size,
      hits: this.#hits,
      misses: this.#misses,
      published: this.#published,
      refused: this.#refused,
      evicted: this.#evicted,
      invalidated: this.#invalidated,
    };
  }

  #miss(): undefined {
    this.#misses += 1;
    return undefined;
  }

  #refuse(message: string): void {
    this.#refused += 1;
    this.#warn(message);
  }

  async #matches(identity: PackageResourceIdentity, bytes: Uint8Array): Promise<boolean> {
    return bytes.byteLength === identity.byteLength && (await packageResourceDigest(bytes)) === identity.sha256;
  }

  async #touch(sha256: string): Promise<void> {
    const entry = this.#entries.get(sha256);
    if (!entry) return;
    this.#entries.set(sha256, { ...entry, lastUse: this.#nextUse++ });
    await this.#writeManifest();
  }

  /** Runs `fn` after every earlier mutation; one writer at a time per tab. */
  #serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #writeManifest(): Promise<void> {
    const manifest: PersistentPackageCacheManifest = {
      schemaVersion: persistentPackageCacheManifestSchema,
      nextUse: this.#nextUse,
      entries: this.entries(),
    };
    try {
      await this.#storage.put(manifestKey, new TextEncoder().encode(JSON.stringify(manifest)));
    } catch (error) {
      this.#warn(`Persistent package cache manifest could not be written: ${describe(error)}`);
    }
  }

  async #tryDelete(key: string): Promise<void> {
    try {
      await this.#storage.delete(key);
    } catch (error) {
      this.#warn(`Persistent package cache could not delete ${key}: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** In-memory storage for tests and for hosts without Cache Storage. */
export class MemoryPersistentPackageStorage implements PersistentPackageStorage {
  readonly #objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    const bytes = this.#objects.get(key);
    return bytes ? bytes.slice() : undefined;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.#objects.set(key, bytes.slice());
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    return [...this.#objects.keys()];
  }

  /** Test hook: overwrite stored bytes without touching the manifest. */
  corrupt(key: string, bytes: Uint8Array): void {
    this.#objects.set(key, bytes.slice());
  }
}

/**
 * Cache Storage name. Bumping the schema bumps the name, so an old store is a
 * foreign cache that `openPersistentPackageCache` deletes rather than reads.
 */
export const persistentPackageCacheStorageName = "naru-package-cache.1";
const storageNamePrefix = "naru-package-cache.";
const keyOrigin = "https://naru-package-cache.invalid/";

/** Cache Storage adapter: one synthetic same-origin URL per key. */
export class CacheStoragePackageStorage implements PersistentPackageStorage {
  readonly #cache: Cache;

  constructor(cache: Cache) {
    this.#cache = cache;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const response = await this.#cache.match(keyOrigin + key);
    return response ? new Uint8Array(await response.arrayBuffer()) : undefined;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    await this.#cache.put(
      keyOrigin + key,
      new Response(body, {
        headers: { "content-type": "application/octet-stream", "content-length": String(body.byteLength) },
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.#cache.delete(keyOrigin + key);
  }

  async keys(): Promise<readonly string[]> {
    const requests = await this.#cache.keys();
    return requests
      .map((request) => request.url)
      .filter((url) => url.startsWith(keyOrigin))
      .map((url) => url.slice(keyOrigin.length));
  }
}

/**
 * Opens the browser-backed tier, or `undefined` when Cache Storage is absent
 * or refuses to open (private browsing, storage disabled). Callers treat
 * `undefined` as "no tier": every lookup is a miss and nothing is published.
 */
export async function openPersistentPackageCache(
  options: PersistentPackageCacheOptions = {},
): Promise<PersistentPackageCache | undefined> {
  const store = (globalThis as { caches?: CacheStorage }).caches;
  if (!store) return undefined;
  try {
    for (const name of await store.keys()) {
      if (name.startsWith(storageNamePrefix) && name !== persistentPackageCacheStorageName) {
        await store.delete(name);
      }
    }
    const cache = await store.open(persistentPackageCacheStorageName);
    const tier = new PersistentPackageCache(new CacheStoragePackageStorage(cache), options);
    await tier.open();
    return tier;
  } catch (error) {
    (options.warn ?? ((message: string) => console.warn(message)))(
      `Persistent package cache is unavailable: ${describe(error)}`,
    );
    return undefined;
  }
}
