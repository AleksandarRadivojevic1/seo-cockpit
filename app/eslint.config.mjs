import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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

    // Vendored third-party chart source from the @bklit shadcn registry.
    // It is installed, not authored here, and `shadcn add` rewrites these
    // files wholesale — so lint findings in them are neither ours to fix nor
    // able to survive the next install. Left unignored they contribute 60 of
    // the project's 61 findings, which makes `npm run lint` useless as a gate
    // and hides real problems in code we DO own.
    //
    // The local patches inside this directory are therefore unlinted. They are
    // guarded instead by tests (tests/line-chart.test.tsx,
    // tests/area-chart.test.tsx) and by the "re-apply after any shadcn add"
    // comments each one carries.
    "components/charts/**",
  ]),
]);

export default eslintConfig;
