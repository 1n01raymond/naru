export const validationGroups = Object.freeze({
  contracts: Object.freeze([
    "adr:check",
    "fixtures:check",
    "fixtures:external:check",
    "docs:links:check",
  ]),
  currentEvidence: Object.freeze([
    "phase1:evidence:check",
    "ifc:edges:check",
    "ifc:federation:check",
    "ifc:engineering:check",
    "cache:check",
    "cache:stages:check",
    "staged:import:browser:check",
    "fuzz:check",
    "embedder:check",
    "hierarchy:relocation:check",
    "lod:reduced:check",
    "lod:selection:check",
    "workspace:reopen:check",
  ]),
  historicalEvidence: Object.freeze([
    "occt:diagnostics:check",
    "ifc:browser:check",
    "ifc:first-frame:check",
    "ifc:first-frame:gecko:check",
    "browser:evidence:check",
    "safari:compatibility:check",
    "precision:check",
    "spatial:check",
    "spatial:localized:check",
    "demand:priority:check",
    "cache:sixty5:check",
    "cache:payload:check",
    "structure:readiness:check",
    "structure:first-emission:check",
    "node-fields:check",
    "lod:method:check",
    "hierarchy:browser:check",
    "demo:browser:check",
    "demo:baseline:check",
    "memory:envelope:check",
    "memory:retention:check",
    "benchmark:industrial:check",
    "benchmark:heterogeneous:check",
    "benchmark:repeatability:check",
    "benchmark:gpu-timing:check",
    "benchmark:gpu-timing:integrated:check",
  ]),
  quality: Object.freeze(["lint", "typecheck", "docs:api:check", "test", "build"]),
  releaseOnly: Object.freeze(["native:check", "demo:smoke:release"]),
});

const tierGroups = Object.freeze({
  pr: Object.freeze(["contracts", "currentEvidence", "quality"]),
  current: Object.freeze(["currentEvidence"]),
  historical: Object.freeze(["historicalEvidence"]),
  scheduled: Object.freeze(["currentEvidence", "historicalEvidence"]),
  release: Object.freeze([
    "contracts",
    "currentEvidence",
    "historicalEvidence",
    "quality",
    "releaseOnly",
  ]),
});

export const validationTierNames = Object.freeze(Object.keys(tierGroups));

export function scriptsForValidationTier(tier) {
  const groups = tierGroups[tier];
  if (groups === undefined) {
    throw new Error(
      `unknown validation tier ${JSON.stringify(tier)}; expected ${validationTierNames.join(", ")}`,
    );
  }

  return groups.flatMap((group) => validationGroups[group]);
}
