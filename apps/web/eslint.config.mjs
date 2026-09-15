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
    // Reading storage or the clock during render is what breaks hydration here,
    // so the effect is the fix rather than the problem. Both components paint
    // the server's answer first and correct it once on the client.
    files: [
      'app/dashboard/AiSummaryCard.tsx',
      'app/dashboard/CashBalanceStaleBanner.tsx',
    ],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
  {
    // Fetch-on-mount, one hand-rolled loading flag per component. The rule is
    // right that each costs a render pass before paint, and wrong that it is a
    // correctness problem: every setState below runs after an await. Listed by
    // name on purpose, so a new file tripping this still fails the build.
    //
    // Three of the original six moved to useResource. These did not, and each was
    // tried rather than assumed. Datasets and Integrations are not read-only
    // resources; they are locally edited lists synced from a server, and putting
    // the read behind a hook leaves the writes needing an override layer longer
    // than the useState it replaced. Datasets also ends up with an undismissable
    // error banner, because the dismiss button cannot clear a derived error.
    // Both have a test covering that. useAgentProposals owns optimistic removal
    // with rollback plus its own abort bookkeeping.
    files: [
      'app/settings/datasets/Datasets.tsx',
      'app/settings/integrations/Integrations.tsx',
      'lib/hooks/useAgentProposals.ts',
    ],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
]);

export default eslintConfig;
