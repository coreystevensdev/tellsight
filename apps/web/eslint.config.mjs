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
    // v8 coverage output. Gitignored, but flat config does not read .gitignore,
    // so its bundled lcov reporter assets get linted without this.
    "coverage/**",
  ]),
  {
    // Fetch-on-mount, one hand-rolled loading flag per component. The rule is
    // right that each costs a render pass before paint, and wrong that it is a
    // correctness problem: every setState below runs after an await. Listed by
    // name on purpose, so a new file tripping this still fails the build.
    //
    // Four of the original six moved to useResource. These two did not, and both
    // were tried rather than assumed. Neither is a read-only resource; they are
    // locally edited lists synced from a server, so putting the read behind a
    // hook leaves the writes needing an override layer longer than the useState
    // it replaced. Datasets also ends up with an undismissable error banner,
    // because the dismiss button cannot clear a derived error, and there is a
    // test for exactly that.
    files: [
      'app/settings/datasets/Datasets.tsx',
      'app/settings/integrations/Integrations.tsx',
    ],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
]);

export default eslintConfig;
