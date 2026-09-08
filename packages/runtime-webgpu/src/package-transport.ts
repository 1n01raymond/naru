/**
 * Transport policy for compiled packages loaded over the network.
 *
 * A remote package is untrusted input (SECURITY.md, ADR-0011): its glTF
 * document, its byte-range buffers, and its sidecars all arrive before
 * anything about them has been verified. Every fetch of a package goes through
 * this module so one reviewed policy -- same origin, no redirects, an allowed
 * content type, and a byte ceiling enforced while the body streams -- decides
 * what the rest of the application is allowed to see.
 *
 * The policy is loader policy, not package policy, so it ships with the
 * runtime rather than with any one application: `PackageTransport` is the
 * surface an embedder configures, and `openPackageTransport` binds one to the
 * document whose origin its resources are held to.
 */
import type { PackageResourceIdentity, PackageResourcePersistence } from "./package-cache.js";


/** Byte and count ceilings a remote package may not exceed. */
export interface PackageTransferLimits {
  /** Largest glTF document the loader will read. */
  readonly documentBytes: number;
  /** Largest single external resource (or Range response) the loader will read. */
  readonly resourceBytes: number;
  /** Largest total the document plus its declared resources may reach. */
  readonly packageBytes: number;
  /** Most external resources one package may declare. */
  readonly resourceCount: number;
}

/**
 * Deliberately far above what this repository compiles. These are backstops
 * against a hostile declaration, not a size policy: a limit set near the
 * largest real model buys no safety a limit an order of magnitude above it
 * lacks, and only turns a legitimate larger federation into a load failure.
 * The largest recorded package is sixty5 at 657,116,508 bytes, whose glTF
 * document is 448,823,852 bytes and whose largest buffer is 120,707,064 bytes
 * across 4 resources (artifacts/ifc/sixty5-first-frame).
 *
 * `documentBytes` is the exception, and is generous for a different reason:
 * both readers decode the document to a string before parsing it, so V8's
 * maximum string length (536,870,888 bytes) is a wall no ceiling here can
 * move. One GiB sits above it, so this limit never causes a rejection an
 * engine would not; raising it further would only allocate more before the
 * parse fails.
 */
export const defaultPackageTransferLimits: PackageTransferLimits = {
  documentBytes: 1_073_741_824,
  resourceBytes: 2_147_483_648,
  /** The package is never fully resident -- residency is budgeted separately. */
  packageBytes: 8_589_934_592,
  resourceCount: 256,
};

export type PackageTransferLimitOverrides = Partial<PackageTransferLimits>;

export function resolvePackageTransferLimits(
  overrides?: PackageTransferLimitOverrides,
): PackageTransferLimits {
  const resolved = { ...defaultPackageTransferLimits, ...overrides };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`The ${key} limit must be a positive safe integer.`);
    }
  }
  return resolved;
}

export type PackageResourceKind = "gltf" | "json" | "binary";

/**
 * What each resource kind may be served as. `application/octet-stream` is
 * accepted everywhere because it claims nothing beyond "bytes"; the point of
 * the list is to reject typed documents -- a dev server's `text/html` SPA
 * fallback for a missing resource, or an error page from a host that answers
 * 200 -- before they reach a parser. The deployed demo's own types are
 * asserted by scripts/check-public-demo.mjs.
 */
const allowedContentTypes: Readonly<Record<PackageResourceKind, readonly string[]>> = {
  gltf: ["model/gltf+json", "application/json", "application/octet-stream"],
  json: ["application/json", "application/octet-stream"],
  binary: ["application/octet-stream"],
};

/**
 * Accepts only an absolute HTTP(S) URL on an allowed origin and without
 * embedded credentials, so a package cannot direct the loader at an
 * unannounced host, at a non-HTTP scheme, or at an authenticated endpoint.
 *
 * `allowedOrigins` defaults to the base URL's own origin. An embedder that
 * serves one package from more than one host widens it deliberately; the
 * package itself never gets a say, which is what makes this loader policy.
 */
export function resolvePackageResourceUrl(
  uri: string,
  documentUrl: URL,
  label: string,
  allowedOrigins?: readonly string[],
): URL {
  let resolved: URL;
  try {
    resolved = new URL(uri, documentUrl);
  } catch {
    throw new TypeError(`${label} declares an unusable resource URI.`);
  }
  assertPackageUrl(resolved, label);
  assertPackageOrigin(resolved, allowedOrigins ?? [documentUrl.origin], label);
  return resolved;
}

/** Holds a resolved URL to the origins the embedder announced. */
export function assertPackageOrigin(
  url: URL,
  allowedOrigins: readonly string[],
  label: string,
): void {
  if (allowedOrigins.includes(url.origin)) return;
  throw new TypeError(
    `${label} points at ${url.origin}; package resources must stay on ${allowedOrigins.join(", ")}.`,
  );
}

export function assertPackageUrl(url: URL, label: string): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${label} must use HTTP or HTTPS.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError(`${label} must not carry credentials.`);
  }
}

/** One external resource a compiled glTF declares, for the aggregate ceiling. */
export interface DeclaredPackageResource {
  readonly uri: string;
  readonly byteLength: number;
}

/**
 * Rejects a package whose declared size or resource count is beyond policy
 * before any of it is fetched. The sum is computed over safe integers, so an
 * overflowing or negative declaration fails here instead of wrapping into a
 * plausible-looking total.
 */
export function assertPackageBudget(
  documentByteLength: number,
  resources: readonly DeclaredPackageResource[],
  limits: PackageTransferLimits,
): void {
  if (resources.length > limits.resourceCount) {
    throw new RangeError(
      `The package declares ${resources.length} external resources; the limit is ${limits.resourceCount}.`,
    );
  }
  let total = assertDeclaredLength(documentByteLength, "The glTF document");
  if (total > limits.documentBytes) {
    throw new RangeError(
      `The glTF document declares ${total} bytes; the limit is ${limits.documentBytes}.`,
    );
  }
  for (const resource of resources) {
    const byteLength = assertDeclaredLength(resource.byteLength, resource.uri);
    if (byteLength > limits.resourceBytes) {
      throw new RangeError(
        `${resource.uri} declares ${byteLength} bytes; the limit is ${limits.resourceBytes}.`,
      );
    }
    total += byteLength;
    if (!Number.isSafeInteger(total) || total > limits.packageBytes) {
      throw new RangeError(
        `The package declares more than ${limits.packageBytes} bytes across its resources.`,
      );
    }
  }
}

function assertDeclaredLength(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} declares an unusable byte length.`);
  }
  return value;
}

/**
 * The fetch a transport issues. An embedder replaces it to add its own
 * credentials, to route through a proxy, or to serve a package from a local
 * store; the policy below still applies to whatever it returns, so a
 * replacement can narrow what is reachable but never widen what is accepted.
 */
export type PackageFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface PackageResponseRequest {
  readonly kind: PackageResourceKind;
  /** Names the resource in every diagnostic this module raises. */
  readonly label: string;
  readonly signal?: AbortSignal;
  /** Requests exactly this range; the caller validates the Content-Range. */
  readonly range?: { readonly byteOffset: number; readonly byteLength: number };
  /** Origins the URL may be on. Defaults to the URL's own, i.e. no check. */
  readonly allowedOrigins?: readonly string[];
  /** Replaces the global fetch for this request. */
  readonly fetch?: PackageFetch;
  /**
   * The identity the package declares for this resource. Only a request that
   * states one may be served from, or published to, a persistent tier: the
   * tier verifies bytes against it before they are handed back.
   */
  readonly expected?: PackageResourceIdentity;
}

/**
 * Issues the one fetch shape package resources are allowed to use: no
 * redirects to follow, no cache to serve a stale or poisoned copy, and a
 * content type the caller expects. The body is left unread so that callers
 * which must inspect status or Content-Range can do so before allocating.
 */
export async function openPackageResponse(
  url: URL,
  request: PackageResponseRequest,
): Promise<Response> {
  assertPackageUrl(url, request.label);
  if (request.allowedOrigins) {
    assertPackageOrigin(url, request.allowedOrigins, request.label);
  }
  const transfer = request.fetch ?? ((target, init) => fetch(target, init));
  const response = await transfer(url, {
    cache: "no-store",
    redirect: "error",
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.range
      ? {
          headers: {
            Range: `bytes=${request.range.byteOffset}-${
              request.range.byteOffset + request.range.byteLength - 1
            }`,
          },
        }
      : {}),
  });
  if (!response.ok) {
    throw new Error(`Failed to load ${request.label} (${String(response.status)}).`);
  }
  assertContentType(response, request.kind, request.label);
  return response;
}

function assertContentType(
  response: Response,
  kind: PackageResourceKind,
  label: string,
): void {
  const header = response.headers.get("Content-Type");
  // An absent type claims nothing; a wrong one is how an error page or an SPA
  // fallback reaches a parser, so that is what the allowlist rejects.
  if (header === null) return;
  const essence = header.split(";")[0]?.trim().toLocaleLowerCase("en-US") ?? "";
  if (!allowedContentTypes[kind].includes(essence)) {
    throw new TypeError(`${label} was served as ${essence}, which is not a package resource type.`);
  }
}

/**
 * Reads a response body without ever holding more than `limitBytes`.
 *
 * A declared `Content-Length` is checked before anything is allocated and then
 * held to: the reader fills a buffer of exactly that size and fails if the
 * body runs long or short, so a dishonest length cannot grow the allocation
 * and a truncated transfer cannot pass as a complete resource. Without a
 * declared length the body is accumulated against the ceiling and the transfer
 * is cancelled the moment it crosses it.
 */
export async function readBoundedBody(
  response: Response,
  limitBytes: number,
  label: string,
): Promise<Uint8Array> {
  const declared = declaredContentLength(response, label);
  if (declared !== undefined && declared > limitBytes) {
    throw new RangeError(`${label} declares ${declared} bytes; the limit is ${limitBytes}.`);
  }
  const body = response.body;
  if (!body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limitBytes) {
      throw new RangeError(`${label} is larger than ${limitBytes} bytes.`);
    }
    return bytes;
  }
  const reader = body.getReader();
  try {
    return declared === undefined
      ? await readUntilLimit(reader, limitBytes, label)
      : await readDeclaredLength(reader, declared, label);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function declaredContentLength(response: Response, label: string): number | undefined {
  const header = response.headers.get("Content-Length");
  if (header === null) return undefined;
  const value = Number(header);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} declares an unusable Content-Length.`);
  }
  return value;
}

async function readDeclaredLength(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  declared: number,
  label: string,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(declared);
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > declared) {
      throw new RangeError(`${label} sent more than the ${declared} bytes it declared.`);
    }
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  if (offset !== declared) {
    throw new RangeError(`${label} ended after ${offset} of ${declared} declared bytes.`);
  }
  return bytes;
}

async function readUntilLimit(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limitBytes: number,
  label: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      throw new RangeError(`${label} is larger than ${limitBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Applies the URL, fetch, content-type, and byte policy in one call. */
export async function fetchPackageResource(
  url: URL,
  request: PackageResponseRequest & { readonly limitBytes: number },
): Promise<Uint8Array> {
  const response = await openPackageResponse(url, request);
  return readBoundedBody(response, request.limitBytes, request.label);
}

/**
 * Hex SHA-256 of a transferred resource, for the digest its package declares.
 * The bytes are copied because a bounded read hands back a view into a larger
 * buffer, and `digest` would hash that whole buffer.
 */
export async function packageResourceDigest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Everything an embedder may change about how one package is transferred.
 *
 * Each field widens or narrows a decision the loader would otherwise make
 * alone, and none of them can be set by the package: limits are ceilings,
 * `additionalOrigins` is the announcement that a package is split across
 * hosts, and `fetch` is the transfer itself. The reviewed defaults apply to
 * every field left out.
 */
export interface PackageTransportPolicy {
  readonly limits?: PackageTransferLimitOverrides;
  /**
   * Origins besides the document's own that its resources may be served from.
   * Compiled packages are written with relative URIs, so this matters only for
   * an embedder that republishes one resource elsewhere -- a CDN for the
   * geometry buffer, for instance -- and it is stated by the embedder rather
   * than discovered from the document.
   */
  readonly additionalOrigins?: readonly string[];
  readonly fetch?: PackageFetch;
  /**
   * A verified persistent tier (ADR-0024). Consulted before the network for a
   * request that declares its `expected` identity and fed after it; never
   * part of the descriptor, so a Worker can only inherit the network policy.
   */
  readonly persistence?: PackageResourcePersistence;
}

/**
 * A resolved policy in structured-cloneable form.
 *
 * A Worker that fetches ranges on its own needs the same ceilings and the same
 * origin set as the thread that opened the package; a function cannot cross
 * that boundary, so the origins are resolved here and the replacement fetch is
 * re-supplied on the other side. Sending resolved values rather than overrides
 * means a Worker can only inherit a policy, never widen one.
 */
export interface PackageTransportDescriptor {
  readonly documentUrl: string;
  readonly limits: PackageTransferLimits;
  readonly origins: readonly string[];
}

/**
 * One package's transfer policy, bound to the document its resources are
 * resolved against.
 *
 * Every method is the corresponding free function with this policy applied, so
 * an embedder configures the transport once and hands it to whatever loads the
 * package instead of repeating the policy at each call site.
 */
export class PackageTransport {
  readonly documentUrl: URL;
  readonly limits: PackageTransferLimits;
  /** Every origin this package's resources may be fetched from. */
  readonly origins: readonly string[];
  readonly #fetch: PackageFetch | undefined;
  readonly #persistence: PackageResourcePersistence | undefined;

  constructor(documentUrl: URL | string, policy: PackageTransportPolicy = {}) {
    const url = documentUrl instanceof URL ? documentUrl : new URL(documentUrl);
    assertPackageUrl(url, "The compiled package document URL");
    this.documentUrl = url;
    this.limits = resolvePackageTransferLimits(policy.limits);
    this.origins = Object.freeze([
      url.origin,
      ...(policy.additionalOrigins ?? []).filter((origin) => origin !== url.origin),
    ]);
    this.#fetch = policy.fetch;
    this.#persistence = policy.persistence;
  }

  /** Rebuilds a transport on the far side of a Worker boundary. */
  static fromDescriptor(
    descriptor: PackageTransportDescriptor,
    policy: Pick<PackageTransportPolicy, "fetch"> = {},
  ): PackageTransport {
    return new PackageTransport(descriptor.documentUrl, {
      limits: descriptor.limits,
      additionalOrigins: descriptor.origins,
      ...(policy.fetch ? { fetch: policy.fetch } : {}),
    });
  }

  describe(): PackageTransportDescriptor {
    return {
      documentUrl: this.documentUrl.href,
      limits: this.limits,
      origins: [...this.origins],
    };
  }

  /** Resolves a declared URI against the document and holds it to the policy. */
  resolveResourceUrl(uri: string, baseUrl: URL = this.documentUrl, label = uri): URL {
    return resolvePackageResourceUrl(uri, baseUrl, label, this.origins);
  }

  assertBudget(
    documentByteLength: number,
    resources: readonly DeclaredPackageResource[],
  ): void {
    assertPackageBudget(documentByteLength, resources, this.limits);
  }

  /**
   * The ceiling one resource is read against: its own declared length when the
   * package states one, so a resource is never allowed to grow past what it
   * promised, and the single-resource ceiling otherwise.
   */
  resourceLimit(declaredByteLength?: number): number {
    return declaredByteLength === undefined
      ? this.limits.resourceBytes
      : Math.min(declaredByteLength, this.limits.resourceBytes);
  }

  open(url: URL, request: PackageResponseRequest): Promise<Response> {
    return openPackageResponse(url, this.#applied(request));
  }

  read(response: Response, limitBytes: number, label: string): Promise<Uint8Array> {
    return readBoundedBody(response, limitBytes, label);
  }

  /**
   * Reads one resource, from the persistent tier when the request declares an
   * identity the tier holds verified bytes for, and from the network otherwise.
   * Network bytes are published only when they match the declared identity;
   * mismatching bytes are returned unchanged so the caller raises its own
   * verification error, exactly as it does without a tier.
   */
  async fetchResource(
    url: URL,
    request: PackageResponseRequest & { readonly limitBytes: number },
  ): Promise<Uint8Array> {
    const tier = this.#persistence;
    const expected = request.expected;
    if (tier && expected) {
      const held = await tier.lookup(expected, request.label, request.signal);
      if (held) return held;
    }
    const bytes = await fetchPackageResource(url, {
      ...this.#applied(request),
      limitBytes: request.limitBytes,
    });
    if (tier && expected) await tier.publish(expected, bytes, request.label);
    return bytes;
  }

  /** A caller may narrow a request, so an explicit field wins over the policy. */
  #applied(request: PackageResponseRequest): PackageResponseRequest {
    const transfer = request.fetch ?? this.#fetch;
    return {
      ...request,
      allowedOrigins: request.allowedOrigins ?? this.origins,
      ...(transfer ? { fetch: transfer } : {}),
    };
  }
}

/** Opens a transfer policy for the package the given document belongs to. */
export function openPackageTransport(
  documentUrl: URL | string,
  policy?: PackageTransportPolicy,
): PackageTransport {
  return new PackageTransport(documentUrl, policy);
}
