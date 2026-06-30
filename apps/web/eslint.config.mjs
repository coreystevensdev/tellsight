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
  ]),
  {
    rules: {
      // React Compiler auto-memoization is not yet enabled for this app.
      // eslint-config-next 16.2+ ships this rule as an error; turn it off
      // until we opt in. The patterns it flags (setState in effects,
      // Date.now() in lazy initialisers) are all intentional.
      'react-compiler/react-compiler': 'off',
    },
  },
]);

export default eslintConfig;
