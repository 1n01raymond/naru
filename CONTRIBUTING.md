# Contributing to NARU

NARU has completed its Phase 2 large-scene alpha and is working toward the
Phase 3 open-platform beta. Contributions that sharpen a use case, add reproducible evidence,
challenge an assumption, or reduce implementation risk are as valuable as
code. The current work order and evidence debt are maintained in
[`docs/PHASE_2.md`](docs/PHASE_2.md).

## Before opening a change

1. Read `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, and the current
   `docs/PHASE_2.md` tracker.
2. Search existing issues and architecture decision records.
3. For a large change, open a design issue before implementation.
4. Keep vendor-specific code behind an adapter boundary.
5. Do not commit proprietary CAD models or data derived from them without
   explicit redistribution rights.

Coding-agent guidance and the AI-assisted contribution rules live in
`AGENTS.md`; `CLAUDE.md` imports it for Claude Code.

## Branch and pull request workflow

NARU uses a lightweight GitHub Flow with `main` as its only permanent
development branch.

1. Create a short-lived work branch from the latest `main`.
2. Use a descriptive prefix such as `feat/`, `fix/`, `docs/`, `perf/`, or
   `spike/`.
3. Open a Draft PR early for risky or cross-cutting work.
4. Keep one logical change in each PR and record exact validation results.
5. Resolve review conversations, then squash-merge into `main`.
6. Delete the work branch after merge.

Direct pushes, force pushes, and merge commits are not part of the normal
workflow. During the single-maintainer bootstrap phase a PR is required but a
peer approval is not. See [the branching and release policy](docs/BRANCHING.md)
for branch names, merge rules, release backports, tags, and enforcement gates.

## Change categories

- `docs:` product, architecture, or API documentation;
- `feat:` a user-visible or public API capability;
- `fix:` a correctness or compatibility correction;
- `perf:` a change supported by benchmark evidence;
- `refactor:` internal structure with no intended behavior change;
- `test:` tests, fixtures, or benchmark harnesses; and
- `build:` packaging, CI, or dependency management.

## Development bootstrap

The TypeScript workspace requires Node.js 22.12 or newer and pnpm 11. From the
repository root:

```sh
pnpm install
pnpm check
pnpm dev
```

`pnpm check` is the pull-request gate: portable contracts, current product
evidence, lint, type checking, tests, and every workspace build. Historical
evidence is preserved and audited separately with `pnpm check:scheduled`; the
release-host audit is `pnpm check:release`. See the
[validation tier policy](docs/VALIDATION.md).
`pnpm phase1:compile:evidence` reproduces the historical first glTF package,
while `pnpm dev` opens the current Studio. Native OCCT work is isolated under
`native/adapter-occt`; run `pnpm native:check` before configuring it. See the
[Phase 1 completion report](docs/PHASE_1_REPORT.md) for the closed vertical
slice and the [Phase 2 tracker](docs/PHASE_2.md) for current work and limits.

## Validation by change area

Start with the narrowest relevant command. Heavy recorders often require a
licensed external fixture, native toolchain, headed browser, or specific host;
an issue should say whether a contributor can run them or a maintainer will
perform the final evidence pass.

| Change area | Narrow validation to start with | Prerequisites | Maintainer-heavy follow-up when applicable |
|---|---|---|---|
| Documentation, roadmap, or ADR | `pnpm docs:links:check`; add `pnpm adr:check` for ADR changes | None | Technical-claim and fluent-translation review |
| Scene IR, compiler, runtime, or Studio TypeScript | `pnpm test <test-file>` and `pnpm --filter <package> typecheck` | `pnpm install` | Headed browser evidence if user-visible loading, rendering, or interaction changes |
| Test files | `pnpm exec tsc -p tsconfig.test.json` | `pnpm install` and a prior `pnpm build` | None; a package's own `typecheck` covers `src/` only |
| IFC adapter | `pnpm adapter:ifc:test -- --python <path>` | Python with pinned `requirements-dev.txt`, including IfcOpenShell | External-fixture extraction/compile record on the disclosed native host |
| OCCT adapter | `pnpm native:check` plus the affected adapter test or diagnostic validator | Pinned OCCT/CadQuery environment for executable adapter work | Licensed STEP evidence re-record and exact toolchain disclosure |
| Existing evidence metadata or validator | `pnpm <record>:check` | Committed record only | Re-run the native/headed recorder if measured output changed |
| Cache behavior | `pnpm cache:check` plus focused compiler/adapter tests | Native adapter environments for a new recording | Cold/warm/corrupt external-fixture record with cache state and host disclosed |
| Browser or performance claim | The matching `pnpm <record>:check` | None for validation | Matching headed recorder across the browsers/hardware required by `docs/BENCHMARKS.md` |

These commands do not replace the repository gate. Run `pnpm check` before
opening a pull request; CI runs that gate plus
`pnpm native:check -- --allow-missing`. When a change touches historical
evidence, also run its focused validator even though unrelated pull requests do
not audit it. Large native, headed-browser, and memory measurements follow the
recording profiles in `docs/VALIDATION.md`.

## Documentation and translations

The English `README.md` is the canonical project landing page. Translations may
adapt phrasing naturally, but they should preserve project status, scope, and
technical claims. See `docs/TRANSLATIONS.md` for file naming, language status,
and terminology guidance.

Documentation-only contributions are welcome. A translation generated or
substantially assisted by a machine should be identified in the pull request so
a fluent reviewer can focus on terminology and natural phrasing.

`pnpm docs:links:check` rejects broken repository-local Markdown links and
heading anchors across every tracked Markdown file, and `pnpm check` runs it.
The check is offline: it never requests an external URL, and it resolves
targets against Git's tracked paths rather than the working filesystem, so a
link that only works on a case-insensitive volume or points at an untracked
file still fails. `http:`, `https:`, `mailto:`, `tel:`, `ftp:`, `ftps:`,
`news:`, `irc:`, and `ssh:` targets are skipped; any other scheme is reported
so a typo stays visible. Links inside fenced code blocks, inline code spans,
and HTML comments are ignored, so documentation can show a broken example.

Fix the link rather than silencing it. When a repository-local target genuinely
cannot resolve, add one reviewed entry to
`scripts/markdown-link-exceptions.json` with the exact `file`, the exact
`target`, and a `reason`:

```json
{ "file": "docs/EXAMPLE.md", "target": "generated/report.md", "reason": "written by pnpm example:evidence and never committed" }
```

An exception matches a single file/target pair; there is no directory, file, or
anchor wildcard. An entry that stops matching a real finding fails the check,
so obsolete exceptions cannot accumulate.

## Architecture changes

Changes that affect a public API, serialized representation, trust boundary,
source-of-truth rule, or major dependency require an ADR under `docs/adr/`.
Proposed ADRs begin as `Status: Proposed` and become `Accepted` only after
review and their stated evidence gate. A reviewed ADR may remain Proposed when
the evidence is incomplete.

## Performance claims

Every performance pull request should include:

- the public or redistributable input model;
- cold/warm cache state;
- browser, OS, CPU, GPU, memory, and display resolution;
- exact build and command;
- median and p95 values across repeated runs; and
- a comparison against the previous commit.

## Developer certificate of origin

By contributing, you certify that you have the right to submit the work under
the repository license. Sign every contribution commit with `git commit -s`.
GitHub's web editor is configured to require the equivalent sign-off.
