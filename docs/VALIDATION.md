# Validation tiers

Status: Active 1.0

NARU keeps reproducible evidence without making every pull request re-audit
every measurement the project has ever published. Validation is split by the
question it answers. Moving a record between tiers does not weaken, delete, or
rewrite that evidence.

## Tiers

| Tier | Command | When it runs | What failure means |
|---|---|---|---|
| Pull request | `pnpm check` or `pnpm check:pr` | Every pull request and push to `main` | A portable contract, current product gate, type, test, documentation, or build regression |
| Current evidence | `pnpm check:evidence:current` | Inside the pull-request tier; directly when changing a current record | A package/security/import/LOD/workspace claim used by the current product no longer validates |
| Historical evidence | `pnpm check:evidence:historical` | Weekly audit, release audit, and directly when touching a historical record | A preserved decision, completed-phase, rejected-experiment, browser, memory, or benchmark record drifted |
| Scheduled audit | `pnpm check:scheduled` | Weekly GitHub Actions workflow and manual dispatch | Any committed current or historical evidence record drifted; it does **not** reproduce native or headed measurements |
| Release audit | `pnpm check:release` | Maintainer release candidate host | Pull-request and historical tiers pass, native prerequisites exist, and the production delivery-origin smoke check passes |

The source of truth for command membership is
`scripts/lib/validation-tiers.mjs`. A focused test compares that registry with
every `*:check` script in `package.json`, so a new evidence validator cannot be
added without choosing exactly one evidence tier.

## Pull-request gate

The pull-request tier follows the testing pyramid: many portable unit and
integration tests, a smaller number of schema/determinism contracts, and only
the evidence whose failure invalidates a current supported claim.

It runs:

- ADR, fixture provenance, external-fixture, and documentation-link contracts;
- the current STEP/IFC package, cache/rebuild, staged-import, package-security,
  embedder, hierarchy-relocation, reduced-LOD, and workspace evidence gates;
- lint, source and test type checking, TypeDoc validation, all portable tests,
  and every workspace build.

The IFC adapter's Python unit suite remains a separate required CI job because
it owns a pinned Python environment. A performance PR must also run and report
the focused recorder required by `docs/BENCHMARKS.md`; a green generic PR gate
does not create a performance claim.

## Historical evidence

Historical does not mean disposable or supported as a current interchange
format. It means the record's primary role is to preserve a completed decision,
an earlier baseline, a rejected experiment, or a host/browser measurement.
Examples include the original 268 s sixty5 browser record, Phase 0 browser
evidence, the rejected ADR-0018 payload-cache experiment, old first-frame and
memory snapshots, Safari capability evidence, and exploratory renderer
benchmarks.

These files and validators remain versioned. The weekly audit catches broken
digests, schemas, links, and internal inconsistencies without charging their
entire audit to every unrelated pull request. A pull request that edits a
historical record must run its focused `pnpm <record>:check` command before
review, regardless of the normal PR tier.

## Recording profiles

Validators inspect committed records; they do not recreate measurements. Large
recorders stay explicit because they require licensed external fixtures,
specific native toolchains, headed browsers, hardware, cache state, or a public
delivery origin. Run the relevant profile when a release or change makes its
claim current again.

| Profile | Representative commands | Required when |
|---|---|---|
| Large native import and rebuild | `pnpm cache:sixty5:evidence`, `pnpm cache:stages:evidence`, `pnpm structure:readiness:evidence`, `pnpm structure:first-emission:evidence` | Compiler/adapter transport, caching, incremental rebuild, or cold-import claims change |
| Headed browser and interaction | `pnpm browser:matrix`, `pnpm ifc:first-frame:evidence`, `pnpm ifc:first-frame:gecko:evidence`, `pnpm staged:import:browser:evidence`, `pnpm lod:selection:evidence`, `pnpm workspace:reopen:evidence` | Loading, rendering, scheduling, LOD, workspace, browser support, or interaction claims change |
| Memory matrix | `pnpm memory:envelope:evidence`, `pnpm memory:envelope:gecko:evidence`, `pnpm memory:retention:evidence` | Buffer ownership, Worker/session lifetime, cache residency, or memory claims change |
| Public delivery | `pnpm demo:browser:evidence`, `pnpm demo:baseline:evidence`, then `pnpm demo:smoke:release` | Published package bytes, origin policy, Studio deployment, or release claim changes |

Do not run these profiles blindly or on an unsuitable host. Follow each artifact
README's pinned inputs, command, environment, sample count, and failure policy.
Commit only licensed summaries and evidence allowed by the fixture policy, then
run `pnpm check:release` to audit the resulting release candidate.

## Moving evidence between tiers

A reviewed change may move a validator when one of these conditions changes:

- a current product or security contract becomes historical;
- a historical experiment becomes a supported current capability;
- an ADR is rejected, accepted, replaced, or reopened; or
- a release makes an older browser, hardware, or package profile current again.

The pull request must update this document and explain the claim boundary. It
must not loosen the validator, retarget a digest, or delete a record merely to
make a tier pass.
