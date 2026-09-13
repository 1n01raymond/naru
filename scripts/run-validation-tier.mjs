import { spawnSync } from "node:child_process";

import {
  scriptsForValidationTier,
  validationTierNames,
} from "./lib/validation-tiers.mjs";

const tier = process.argv[2];

if (tier === undefined) {
  console.error(`usage: node scripts/run-validation-tier.mjs <${validationTierNames.join("|")}>`);
  process.exit(2);
}

let scripts;
try {
  scripts = scriptsForValidationTier(tier);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
console.log(`[validation-tier] ${tier}: ${scripts.length} command(s)`);

for (const [index, script] of scripts.entries()) {
  console.log(`\n[validation-tier] ${index + 1}/${scripts.length} pnpm run ${script}`);
  const result = spawnSync(pnpm, ["run", script], { stdio: "inherit" });
  if (result.error !== undefined) {
    console.error(`[validation-tier] could not start ${script}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[validation-tier] ${script} failed with exit code ${result.status ?? "unknown"}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\n[validation-tier] ${tier}: passed`);
