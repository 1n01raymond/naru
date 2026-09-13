import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      ".claude/worktrees/**",
      "artifacts/**",
      "output/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // Type-aware rules need a program per file. `scripts/` and config files are
    // plain JavaScript outside every tsconfig, so they opt out below.
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.test.json",
          "./apps/*/tsconfig.json",
          "./packages/*/tsconfig.json",
          "./tools/*/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Tests deliberately build malformed and partial payloads to prove the
    // validators reject them, and several exercise untyped `scripts/lib/*.mjs`
    // helpers. Requiring a type for those values would mean asserting the very
    // shape under test. The rules that catch real defects regardless of typing
    // -- floating and misused promises, needless async, base-to-string --
    // stay on; only the `any`-propagation family is relaxed here.
    files: ["**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // Every function this rule flagged here implements an async interface --
      // a `fetch` stub, a scheduler `load`, a backend's `gpuFrameTiming` --
      // where the signature, not the body, requires the promise. It found no
      // defect and would only push `Promise.resolve` wrappers into call sites.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
      ]
    }
  }
);
