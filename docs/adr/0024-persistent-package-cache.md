# ADR-0024: Keep verified package resources in a quota-bounded browser cache tier

Status: Proposed

Reviewed: 2026-09-08

## Context

Reopening an unchanged compiled package today repeats every network read.
The Studio verifies the property sidecar, the relocated hierarchy sidecar, and
the spatial demand index against the digests the package document declares
([ADR-0011](0011-remote-package-limits.md) transport), and then
discards the bytes when the tab closes. HTTP caching cannot stand in for that
tier: cache headers are a freshness hint, not an integrity contract, and a
delivery origin ([ADR-0023](0023-public-package-delivery-origin.md)) is free to
serve a package with `no-store`.

Issue #77 asks for a persistent tier that keeps unchanged resources across a
browser session under an explicit local quota while every existing trust check
stays in force. Two properties are non-negotiable: a persistent hit must never
bypass digest verification, and it must never imply shared authorization
([ADR-0002](0002-source-and-cache.md); knowing a digest grants nothing).

Two facts about the current package format shape the slice:

- Only three resources declare a SHA-256 today: `extras.madi.properties`
  (`properties.json` and `properties.bin`), `extras.madi.hierarchy`
  (`hierarchy.json` and `hierarchy.bin`), and
  `extras.madi.progressive.spatialIndex` (`spatial.bin`). The document itself,
  `scene.bin`, and `coarse.bin` declare byte lengths only, and those
  identifiers are frozen until their next schema bump
  ([ADR-0007](0007-rebrand-naru.md)).
- Decoded and GPU residency budgets ([RUNTIME.md](../RUNTIME.md#residency-budgets-are-not-a-process-bound))
  are live-memory limits. Persisted encoded bytes are a different quantity and
  must be accounted separately.

## Decision

Add a `PersistentPackageCache` tier to `@naru3d/runtime-webgpu`
(`packages/runtime-webgpu/src/package-cache.ts`) that the ADR-0011 transport
consults before the network and publishes to after a verified read.

**Content identity.** A resource is addressed by its declared identity only:
the 64-character lowercase SHA-256 and the exact byte length the package
document declares. The storage key is `naru.persistent-package-cache.1/<sha256>`.
No URL, origin, or package path enters the key, so the same bytes served from
two hosts share one entry, and two packages that declare the same sidecar
digest share one entry. A resource without a declared digest is never
persisted.

**Verification.** A hit is served only after the stored bytes are re-hashed
and re-measured against the same declared identity the network path checks;
a mismatch deletes the entry and counts as an invalidated miss. Network bytes
that fail their declared identity are returned to the caller, so the existing
sidecar errors fire unchanged, but they are refused by the tier and never
written. Two writers cannot publish different bytes under one key because the
key is the digest of the bytes.

**Partition.** The tier lives in Cache Storage under the Studio's own origin,
in one cache named for the schema (`naru-package-cache.1`). It is therefore
partitioned by the embedding application's origin, never by package origin, and
it is subject to the browser's own private-mode and site-data policies. A
cache name from another schema version found under the same origin is deleted
on open; the schema-named key prefix makes any format change a cold namespace.

**Lifetime and quota.** Entries are evicted least-recently-used by a monotonic
use counter kept in a manifest (`naru.persistent-package-cache-manifest.1`)
under an explicit byte quota, default 256 MiB. Resources of the scene that is
open are protected until the next load releases them, so an active resource is
never evicted under a reader. A publish that cannot fit beside the protected
set is refused rather than forcing eviction. Persisted encoded bytes are
reported through the tier's own statistics (`state`, `quotaBytes`, `entries`,
`storedBytes`, `protectedEntries`, hits, misses, published, refused, evicted,
invalidated) and never enter the decoded or GPU residency totals.

**Recovery.** Every entry is self-verifying, so a corrupt, truncated, or
interrupted write is detected at the next lookup and removed. An orphan sweep
on open reconciles the store against the manifest in both directions. A
manifest that cannot be parsed resets the tier: every key is deleted, no
manifest is written until the next publish, and the tier reports state
`reset`. Concurrent tabs share the store last-writer-wins on the manifest;
each instance serializes its own operations on one queue. No storage failure
throws out of a lookup or publish; it degrades to a warning plus a miss or a
refusal, so the tier can never block a scene from opening. A lookup rejects
only when its own abort signal fires.

**User control.** The Studio opens the tier with `?persistentCacheMiB=`
(default 256, `0` disables it, at most 4096), exposes a `Clear cache` button
that deletes every entry, and reports the tier through
`data-persistent-cache` (`off`, `unavailable`, `closed`, `ready`, `reset`)
with hit, miss, entry, and byte counts. A host without Cache Storage runs
network-only with state `unavailable`.

**Non-goals kept.** No upload, no cross-device sync, no shared-cache
authorization, no service-worker offline claim, and no change to the
decoded or GPU budgets.

## Consequences

### Positive

- An unchanged reopen resolves every digest-declared sidecar from local
  storage after one hash, with no network round trip and no loss of
  verification.
- The trust boundary does not widen: the only bytes the tier will ever hand
  to a decoder are bytes that hash to the identity the package document
  declares, which is exactly the check the live path already makes.
- Encoded persistent bytes and live decoded/GPU bytes are separate figures with
  separate limits, so the memory-envelope ledger keeps its meaning.

### Negative

- The largest resources (`scene.bin`, `coarse.bin`, the document) stay
  network-only until their identifiers bump and gain declared digests, so this
  slice removes sidecar reads, not the bulk of a reopen's traffic. That is
  gate 1 below, not a reason to relax the digest rule.
- Cache Storage is the browser's, not the application's: a site-data clear,
  private mode, or storage pressure can empty the tier at any time. The tier
  treats that as a miss, never as an error.
- A manifest reset discards the whole tier rather than salvaging entries, by
  design; salvaging would mean trusting a store whose bookkeeping already
  failed once.

## Alternatives considered

- **Rely on the HTTP cache.** Rejected: freshness headers carry no integrity
  and the delivery origin controls them.
- **Key by URL.** Rejected: a URL is not content identity; the same bytes from
  two origins would be two entries and a changed package at the same URL would
  be a false hit until verification caught it.
- **Persist chunk ranges of `scene.bin` under a length-only identity.**
  Rejected: a range has no declared digest today, so a hit could not be
  verified before decode.
- **Evict protected entries under quota pressure.** Rejected: an active
  resource under a reader must not disappear; refusing the publish is the
  safe failure.

## Validation

The storage tier and its transport integration are implemented and covered by
fake-storage unit tests in
[`package-cache.test.ts`](../../packages/runtime-webgpu/test/package-cache.test.ts).
No browser record was made for this slice: per the Phase 2 evidence
protocol, an ADR gate that does not close a roadmap exit criterion is proved
at unit scale first.

| Gate | Requirement | Status |
|---|---|---|
| 0 | Fake-storage tests prove cold miss then warm hit from a second instance, corrupt-entry invalidation, byte-length mismatch, manifest reset, LRU order with a protected active entry surviving, refusal when the protected set fills the quota, refusal of an oversize resource, aborted lookup with no counted hit or miss, two concurrent writers and two concurrent readers of one key settling on one entry, forged bytes refused beside genuine bytes, user clear, transport hit bypassing the network, transport miss publishing, mismatching network bytes returned but refused, and no cache activity without a declared identity | **Met** (13 tests) |
| 1 | The document, `scene.bin`, and `coarse.bin` declare a SHA-256 in the package document, so whole-buffer reads become persistable; this rides the `extras.madi` to `naru.` schema bump ([ADR-0007](0007-rebrand-naru.md)) | Open |
| 2 | One focused headed record of an unchanged Digital Hub reopen shows every digest-declared sidecar served from the tier with zero network reads for those resources, identical decoded and GPU totals, and 0 console issues | Open |
| 3 | The same record repeats on a second engine | Open |

Failing gate 2 rejects this decision. Gates 1 and 3 extend its reach and do
not gate acceptance.
