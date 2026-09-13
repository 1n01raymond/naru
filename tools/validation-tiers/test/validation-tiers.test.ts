import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  scriptsForValidationTier,
  validationGroups,
  validationTierNames,
} from "../../../scripts/lib/validation-tiers.mjs";

const sorted = (values: readonly string[]) => [...values].sort();

describe("validation tiers", () => {
  it("keeps every group duplicate-free and current evidence out of history", () => {
    for (const commands of Object.values(validationGroups)) {
      expect(new Set(commands).size).toBe(commands.length);
    }

    const historical = new Set(validationGroups.historicalEvidence);
    expect(validationGroups.currentEvidence.filter((command) => historical.has(command))).toEqual(
      [],
    );
  });

  it("runs contracts, current evidence, and quality on pull requests", () => {
    expect(scriptsForValidationTier("pr")).toEqual([
      ...validationGroups.contracts,
      ...validationGroups.currentEvidence,
      ...validationGroups.quality,
    ]);
  });

  it("audits all evidence on the scheduled tier and adds host checks for releases", () => {
    expect(scriptsForValidationTier("scheduled")).toEqual([
      ...validationGroups.currentEvidence,
      ...validationGroups.historicalEvidence,
    ]);
    expect(scriptsForValidationTier("release")).toEqual([
      ...validationGroups.contracts,
      ...validationGroups.currentEvidence,
      ...validationGroups.historicalEvidence,
      ...validationGroups.quality,
      ...validationGroups.releaseOnly,
    ]);
  });

  it("classifies every focused evidence check in package.json exactly once", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const infrastructureChecks = new Set([
      ...validationGroups.contracts,
      ...validationGroups.quality,
      ...validationGroups.releaseOnly,
    ]);
    const focusedEvidenceChecks = Object.keys(packageJson.scripts).filter(
      (script) => script.endsWith(":check") && !infrastructureChecks.has(script),
    );

    expect(
      sorted([...validationGroups.currentEvidence, ...validationGroups.historicalEvidence]),
    ).toEqual(sorted(focusedEvidenceChecks));
  });

  it("rejects an unknown tier", () => {
    expect(validationTierNames).toEqual(["pr", "current", "historical", "scheduled", "release"]);
    expect(() => scriptsForValidationTier("nightly")).toThrow(/unknown validation tier/u);
  });
});
