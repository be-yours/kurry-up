import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import convexAuth from "@be-yours/convex-functions/eslint/convex-auth";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Convex auto-generated files:
    "convex/_generated/**",
    ".convex-build/**",
    // PATCH BOILERPLATE: areas outside the web app — the Expo app has its own
    // ESLint config, and the dormant snapshot is never linted.
    "mobile/**",
    ".template/**",
    // PATCH BOILERPLATE: static sales demos (browser JS + a CommonJS
    // serverless function), outside the scope of the Next/TS config.
    "demos/**",
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The authorisation seam only applies where a Convex function becomes
    // publicly callable: the app's own `convex/` wrappers. `_generated/` is
    // machine-written and ignored globally above.
    //
    // This is the same rule `apps/reference` runs, imported from the package
    // that owns the seam. A client site is cloned from HERE, so the guard has
    // to travel with the template, not stay behind in the test bench.
    // `convex/**/*.ts`, not `convex/*.ts`. One level left `convex/lib/` and
    // `convex/migrations/` unlinted — no builder call lives there today, which
    // is exactly why the hole was invisible: the glob was not proved by
    // anything, so the first file added under a subdirectory would have
    // inherited no guard at all.
    files: ["convex/**/*.ts"],
    plugins: { convex: convexAuth },
    rules: {
      "convex/no-unguarded-convex-function": "error",
      "convex/require-convex-permission": "error",
    },
  },
]);

export default eslintConfig;
