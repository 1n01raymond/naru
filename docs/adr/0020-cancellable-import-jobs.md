# ADR-0020: Report imports as a versioned lifecycle and make cancellation stop the adapter tree

Status: Proposed

## Context

A host that embeds NARU today learns what an import is doing by reading the
`[naru] ...` lines the CLI prints. That is prose written for a terminal: it has
no version, no ordering guarantee, no machine-readable shape, and it names the
source file and the temporary directory it compiled into. Anything built on it
breaks the next time a summary line is reworded.

Stopping an import is worse. Both compilers spawn a native adapter -- OCCT
through `native/adapter-occt`, IfcOpenShell through `native/adapter-ifc` -- and
a real-large IFC extraction runs for minutes
([artifacts/cache/rebuild-stages](../../artifacts/cache/rebuild-stages/README.md)
measures the sixty5 adapter at 79.1 s of a 126.1 s rebuild, and a cold sixty5
compile at 381.4 s in
[artifacts/cache/sixty5](../../artifacts/cache/sixty5/README.md)). There was no
way to ask for that work to stop. Pressing Ctrl-C killed the Node process and
left the adapter and whatever it had spawned running, holding the temporary
Scene IR directory open.

Issue #72 asks for both halves: a lifecycle contract a host can subscribe to,
and a cancel that actually reaches the process tree and leaves nothing
half-written behind. Its non-goals are explicit -- no browser UI, no hierarchy
or coarse preview (that is issue #73), and no percentage estimate derived from
a source size nobody has measured.

Two facts about this repository shape the design.

First, **publication is not atomic but cache placement is.** `writeCompiledPackage`
writes `scene.gltf`, `scene.bin`, and the sidecars as separate files, so a cancel
observed midway leaves a directory that looks like a package and is not one.
The compiled cache is the opposite: `restoreCompiledCacheEntry` verifies every
resource and places the directory through one rename, and its publish path is
idempotent (ADR-0009).

Second, **nothing here measures how long tessellating an unseen document takes.**
The stage record decomposes a rebuild after the fact; it predicts nothing before
one. Any progress number derived from source bytes would be a guess presented as
a measurement.

## Decision

### One versioned event stream, `naru.import-job-event.2`

`packages/compiler/src/import-job.ts` owns the contract. Both compilers accept
`job?: ImportJobOptions` (`{jobId?, onEvent?, signal?}`) and report into it; they
decide nothing about ordering, progress, redaction, or cancellation timing.

Nine states in one legal order: `queued`, `inspecting`, `extracting`,
`compiling`, `verifying`, `publishing`, then exactly one of `completed`,
`cancelled`, `failed`. A job announces a state when it *begins* it, may skip
states, and never revisits one. Every event carries `schemaVersion`, `jobId`,
a gapless zero-based `sequence`, monotonic `elapsedMs`, `progress`, and the
literal `redaction: "no-filesystem-paths"`. The three terminal states are
distinct union members carrying `result`, `cancellation`, or `failure`, so a
consumer that wants a completion has to say so.

Version 2 (ADR-0021) adds one optional field, `staged`, to the non-terminal
event: a verified per-document tree published while `extracting` continues. It
is the only event that repeats a state, the sequence stays gapless, progress is
unchanged, and it carries digests and counts, never paths.

`extracting` and `compiling` are skipped when a verified cache entry answers the
request. `publishing` is skipped on that same path, because restoring an entry
verifies every resource and places the directory in one atomic primitive -- there
is no separate publication to announce.

### Progress counts lifecycle steps against a settled plan

`progress.total` is `null` until the cache decision resolves, then becomes the
length of the path the job will take: six steps to rebuild, three to restore.
`progress.completed` counts states finished. It is a step count, never an
estimate from source size, which honours the issue's non-goal rather than
working around it.

### Events carry document identity, never document content or paths

An event may describe its sources as `{discipline?, sha256, byteLength}`. Every
string that leaves the module passes `redactPaths`, which substitutes the job's
own known paths first and then anything path-shaped -- a Windows drive path, a
UNC path, a multi-segment POSIX path -- with `<path>`. Adapter failures quote the
interpreter and the file they could not read, so a failure message is the one
place a path reliably reaches an event. `jobId` is a truncated SHA-256 over the
resolved sources, output directory, and result-affecting options, so it is stable
across repeated runs of one request and carries no recoverable path.

### Cancellation stops the process tree, and publication is uninterruptible

`runAdapterProcess` in `packages/compiler/src/adapter-process.ts` is now the only
way either compiler starts an adapter. It spawns detached on POSIX so the child
leads its own process group, and on abort terminates the whole tree --
`taskkill /T /F` on Windows, a group signal on POSIX -- then rejects with a
cancellation error whether the failure surfaces as `error` or `close`.

`throwIfCancelled` runs before each state is announced, so a cancelled job never
reports work it will not do, and `registerTemporaryDirectory` lets cancellation
remove the temporary Scene IR directory it was extracting into. Directories
passed as protected -- a configured cache directory -- are never removed, whatever
is registered.

Inside `enter("publishing")` the cancel check does nothing. Observing a cancel
midway through `writeCompiledPackage` is the one way to leave a half-written
package on disk, so the section runs to the end and the job reports
`cancellation.publishedBeforeCancellation: true`: the durable result exists, only
the job was cancelled. The restore plan reaches the same state through
`notePublishedResult`.

### The CLI is the first consumer

`--json-events` moves the event stream to stdout, one JSON object per line, and
every human line to stderr, so a caller can pipe one and read the other. The
first `SIGINT` or `SIGTERM` cancels the job instead of killing the process, which
is what lets the compiler stop the adapter and discard the temporary output; a
second is not intercepted. A cancelled run exits 130, the code a shell reports
for a job stopped by `SIGINT`, because a cancel is the outcome the caller asked
for rather than a compile that went wrong.

## Consequences

### Positive

- A host can drive an import without parsing prose, and can detect a dropped
  event from the sequence rather than inferring it.
- Cancelling a minutes-long real-large extraction now stops the adapter and its
  descendants instead of orphaning them.
- The temporary directory a cancelled job was writing into is removed; a
  previously verified cache entry is not.
- Redaction is a property of the module every event passes through, not a habit
  each call site has to remember.

### Negative

- Nine states are more than some hosts need. A host that wants three has to
  collapse them; the alternative -- shipping three and finding out later which
  distinctions mattered -- is worse, because widening a published contract is the
  breaking direction.
- `publishing` is genuinely uninterruptible, so a cancel during it does not stop
  the write. The event says so rather than pretending otherwise.
- Both compilers now carry lifecycle calls through their bodies. They are cheap
  and inert without a listener, but they are there.

## Alternatives considered

**Keep the prose and add a `--porcelain` flag.** Cheaper, and it makes the
current output the contract by accident, including its omissions -- no ordering
guarantee, no sequence, no redaction policy.

**Estimate progress from source bytes.** The issue names this as a non-goal, and
the stage record shows why: adapter time on the same host varies with document
content, not size, and nothing available before the compile predicts it.

**Cancel by killing the Node process from the host.** That is what happens today
and it is exactly the failure being fixed: the adapter survives its parent.

**Make publication interruptible with a rollback.** It would need the package
write to become atomic first -- a temporary directory plus one rename, the way
cache publication already works. That is a worthwhile change and a different one;
until it lands, deferring cancels through the section is the honest behaviour.

## Validation

Implemented on branch `feat/cancellable-import-jobs`. Unit coverage in
[packages/compiler/test/import-job.test.ts](../../packages/compiler/test/import-job.test.ts)
(contract, identity, progress accounting, event stream, redaction, cancellation)
and end-to-end coverage against spawned adapters in
[packages/compiler/test/import-job-cancellation.test.ts](../../packages/compiler/test/import-job-cancellation.test.ts).

Descendant death is proved by socket, not by pid: on Windows `process.kill(pid, 0)`
can succeed for an exited process whose handle is still held, so the fake
descendant holds a listening TCP port and the test proves death by binding that
port itself. libuv uses `SO_EXCLUSIVEADDRUSE` on Windows and `SO_REUSEADDR` on
POSIX, so the bind fails while the descendant lives and succeeds once it does
not, on both. Every wait is a bounded poll against a deadline rather than a fixed
sleep.

This ADR stays **Proposed**. Its gates:

1. A second consumer outside this repository's CLI drives an import through the
   event stream, the way ADR-0011 required an embedder before it was accepted.
   Until then the contract is reachable, not adopted.
2. A cancellation record on a real-large model: cancel a sixty5 IFC compile
   mid-extraction and show the adapter tree gone, the temporary split removed,
   and the configured cache directory unchanged. The unit tests prove the
   mechanism at fixture scale; they do not prove it against a minutes-long
   extraction.
3. Package publication becomes atomic, or the uninterruptible section is
   documented as permanent with the reason measured rather than argued.

Failing gate 1 or 2 rejects this ADR rather than loosening it.
