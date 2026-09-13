# Working in the NARU repository

Guidance for coding agents and new contributors. It condenses rules that live in
`CONTRIBUTING.md`, `docs/BRANCHING.md`, `docs/README.md`, and the phase
trackers; those documents win whenever this file disagrees with them.

## What this is

NARU compiles CAD/BIM sources (STEP through an isolated OCCT adapter, IFC
through an isolated IfcOpenShell adapter) into a neutral Engineering Scene IR,
packages it as standard glTF 2.0, and renders it in the browser through a
direct, data-oriented WebGPU runtime. Status: Phase 3 open-platform beta work;
Phases 1 and 2 are complete (`docs/ROADMAP.md`, `docs/PHASE_2.md`). The roadmap is
evidence-gated: a capability counts only when the repository reproduces it.

## AI-assisted contributions

Coding agents are welcome under the same rules as every contributor, plus:

- Never act autonomously on GitHub. Do not open, edit, comment on, or reply to
  an issue or pull request unless the human contributor has reviewed and
  explicitly approved the exact content; open unreviewed work as a draft.
- Disclose substantial AI assistance in the pull request description, as
  `CONTRIBUTING.md` already requires for machine-assisted translations, and do
  not present generated text as human-written.
- Report only what was actually run: validation results, digests, counts, and
  benchmark numbers in a pull request must come from commands executed in this
  repository, never inferred or reconstructed.
- Do not submit code the contributor has not read. Keep changes minimal and
  strip scaffolding, placeholder comments, and other generation artifacts.

## Repository map

| Path | What lives there |
|---|---|
| `packages/scene-ir` | Engineering Scene IR types and `validateScene` |
| `packages/compiler` | Scene IR to glTF packaging, the `naru` CLI (`compile`, `compile-ifc`), adapter/build reports, evidence CLI |
| `packages/runtime-webgpu` | Direct WebGPU renderer, compiled-glTF loader, Worker decode, bounded residency |
| `packages/workspace` | `naru.workspace.1` manifest, fail-closed parser, canonical serializer, reopen decision |
| `apps/webgpu-spike` | Studio prototype: tree, search, properties, section plane, residency controls |
| `apps/benchmark-lab` | NARU vs Three.js industrial benchmark harness |
| `native/adapter-occt` | C++/Python OCCT STEP adapter (isolated, not a browser dependency) |
| `native/adapter-ifc` | Python IfcOpenShell federation adapter (isolated) |
| `scripts/` | Evidence recorders (`record-*.mjs`) and validators (`validate-*.mjs`) |
| `artifacts/` | Committed evidence: reports, digests, screenshots, one README per record |
| `fixtures/` | Licensed STEP fixtures and the external fixture manifest |
| `docs/` | Design documents, phase trackers, ADRs (read order in `docs/README.md`) |

## Commands

Node 22.12+ and pnpm 11 (`packageManager` pin). If `pnpm` is not on PATH, use
`corepack pnpm`.

| Command | Purpose |
|---|---|
| `pnpm install` | Bootstrap the workspace |
| `pnpm check` / `pnpm check:pr` | Pull-request gate: contracts, current evidence, lint, typecheck, test, build |
| `pnpm check:evidence:historical` | Audit completed-decision, superseded, browser, memory, and benchmark records |
| `pnpm check:scheduled` / `pnpm check:release` | Audit all committed evidence; release also requires native prerequisites and the live demo smoke check |
| `pnpm test` / `pnpm test:watch` | Vitest over `{apps,packages,tools}/**/*.test.ts` |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | Individual gates |
| `pnpm dev` | Studio prototype (Vite) |
| `pnpm demo:smoke` | Check the deployed Studio, package resources, and HTTP Range delivery |
| `pnpm naru compile <file.step> --output <dir>` | Compile a local STEP source |
| `pnpm naru compile-ifc ...` | Compile an IFC federation from discipline/document pairs |
| `pnpm <record>:check` | Validate one evidence record (`phase1:evidence`, `ifc:edges`, `ifc:federation`, `browser:evidence`, `benchmark:industrial`, `benchmark:heterogeneous`, `fixtures`, `fixtures:external`, `occt:diagnostics`, `cache`, `adr`) |
| `pnpm ifc:federation:evidence`, `pnpm phase1:compile:evidence`, `pnpm benchmark:*`, `pnpm browser:matrix` | Re-record evidence (slow; headed browsers for the last two) |
| `pnpm native:check` | Verify native toolchains before configuring adapters |

Run the narrowest validator for the record you touched first. Run `pnpm check`
before opening a pull request; CI runs exactly that plus
`pnpm native:check -- --allow-missing`. Historical records remain required when
touched and are audited weekly and before releases; see `docs/VALIDATION.md`.

## How a change is expected to look

Nearly every feature lands as one vertical slice:

1. the code change (adapter, compiler, runtime, or Studio);
2. unit tests beside the package (`packages/*/test`, `apps/*/test`);
3. re-recorded evidence under `artifacts/<record>/` with its README;
4. an updated or new validator in `scripts/validate-*-evidence.mjs`, classified
   as current or historical in `scripts/lib/validation-tiers.mjs`;
5. documentation sync: `docs/PHASE_2.md` (current state, next gate, and evidence
   debt), `docs/ROADMAP.md` phase status, the affected design document
   (`COMPILER.md`, `RUNTIME.md`, `SCENE_IR.md`, `BENCHMARKS.md`), and the
   package or app README whose behavior changed. Edit `docs/PHASE_1.md` only to
   correct its historical exit record or handoff.

Rules that recur:

- A documentation claim links to a test, validator, benchmark record, or ADR.
  Keep measured and planned behavior distinguishable. Benchmark records stay
  labeled `exploratory-not-adr-decision` until the ADR-0003 decision contract
  is met.
- Validators hardcode digests, counts, and schema IDs on purpose. When a format
  changes, bump the schema ID (for example `madi.ifc-adapter-report.N`,
  `madi.ifc-scene-ir-split.N`) and update the validator deliberately; never
  loosen a check to make it pass.
- Serialized identifiers still spelled `madi` (schema IDs, the glTF
  `extras.madi` key, generator strings, benchmark backend/workload IDs) are
  frozen deliberately — see ADR-0007. Do not rename them in isolation; each
  family migrates to a `naru.` ID at its next schema bump, together with its
  validator and re-recorded evidence.
- Editing `fixtures/external/manifest.json` changes its SHA-256 and invalidates
  every `artifacts/fixtures/external/*.json` record; regenerate all of them with
  `pnpm fixtures:external inspect <id> --output <path>`.
- Determinism is a feature: two compilations must produce byte-identical JSON,
  binaries, and reports.
- A change to a public API, serialized representation, trust boundary, or major
  dependency needs an ADR under `docs/adr/` (`Status: Proposed` until its
  evidence gate passes; `pnpm adr:check` validates the files).
- Never commit proprietary CAD/BIM data or geometry derived from it. External
  fixtures enter through the manifest with license evidence; large intermediates
  and downloads stay under the gitignored `output/` directory.
- Line endings are LF (`.gitattributes`). Python's `write_text` produces CRLF on
  Windows; normalize before committing.

## Branches, commits, pull requests

GitHub Flow with `main` as the only permanent branch. Work on short-lived
`feat/`, `fix/`, `docs/`, `perf/`, or `spike/` branches; every change reaches
`main` through a squash-merged pull request whose title becomes the commit
subject. Subjects use `feat:`, `fix:`, `docs:`, `perf:` (requires benchmark
evidence), `refactor:`, `test:`, or `build:`. A pull request body states the
problem and approach, the validation commands with their results, the
compatibility/schema/performance impact, the documentation, tests, fixtures,
and ADR updates it carries, and confirms that no unlicensed engineering data is
included. Keep one logical change per pull request and split long efforts into
independently useful ones.

## Documentation and translations

`README.md` is canonical. `README.ko.md`, `README.ja.md`, and `README.zh-CN.md`
mirror its status warning, scope, and technical claims (`docs/TRANSLATIONS.md`).
A material README change updates the language selector in every README and
notes translation follow-ups; minor copy edits do not block technical changes.
Design documents under `docs/` stay English-only.
