import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { connectorEnvByGuard } from './connector-env.js';

/**
 * Every environment variable a connector needs has to survive three hops, and
 * the first two are easy to forget because nothing else references them:
 *
 *   GitHub secret -> deploy-aws.yml `env:` -> deploy-via-ssm.py allowlist -> container
 *
 * Shopify and Square shipped without the third hop and sat dead until
 * 2026-09-15. Xero did the identical thing on 2026-11-19, with a comment
 * warning about the Shopify incident three lines above the list it needed to be
 * added to. A per-connector test would have the same failure mode as the
 * comment did, so this derives the names instead: whatever `config.ts` says a
 * connector needs is what both deploy paths must carry.
 *
 * Reads the files as text rather than importing them. `config.ts` validates the
 * whole environment on import and the deploy script is Python, so text is the
 * only thing these three have in common.
 */

const ROOT = resolve(import.meta.dirname, '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const CONFIG = read('apps/api/src/config.ts');
const WORKFLOW = read('.github/workflows/deploy-aws.yml');
const DEPLOY_SCRIPT = read('scripts/deploy-via-ssm.py');

/**
 * The env vars each `is*Configured` helper reads, which is the product's own
 * statement of what turns a connector on.
 *
 * Deliberately parsed from the guards rather than from the Zod schema: the
 * schema declares plenty of optional vars that nothing gates on, and a name in
 * there that never reaches the instance may be entirely harmless. A name inside
 * a guard is load-bearing by construction, because the guard is what decides
 * whether the connector exists at runtime.
 */
const GUARDS = connectorEnvByGuard();

// A regex that silently matched nothing would make every assertion below pass
// for the wrong reason, which is the one failure this file cannot afford.
describe('the guards were actually found', () => {
  it('parses every connector guard in config.ts', () => {
    expect([...GUARDS.keys()].sort()).toEqual([
      'isPlaidConfigured',
      'isQbConfigured',
      'isShopifyConfigured',
      'isSquareConfigured',
      'isXeroConfigured',
    ]);
  });

  it('finds the env vars inside each one', () => {
    for (const [guard, vars] of GUARDS) {
      expect(vars.length, `${guard} parsed no env vars`).toBeGreaterThan(0);
    }
  });
});

describe('every connector env var can reach the instance', () => {
  const entries = [...GUARDS].flatMap(([guard, vars]) => vars.map((v) => [guard, v] as const));

  it.each(entries)('%s: deploy-aws.yml forwards %s', (_guard, name) => {
    expect(WORKFLOW).toContain(`${name}: \${{ secrets.${name} }}`);
  });

  it.each(entries)('%s: deploy-via-ssm.py allowlists %s', (_guard, name) => {
    expect(DEPLOY_SCRIPT).toContain(`"${name}"`);
  });
});

// Not strictly required to turn a connector on, so absent from the guards, but
// a connector pointed at the wrong environment fails in ways that do not name
// themselves. Listed explicitly because there is nothing to derive them from.
describe('the environment flags travel too', () => {
  it.each(['QUICKBOOKS_ENVIRONMENT', 'SQUARE_ENVIRONMENT', 'PLAID_ENVIRONMENT'])(
    'deploy-aws.yml forwards %s',
    (name) => {
      expect(WORKFLOW).toContain(`${name}: \${{ secrets.${name} }}`);
    },
  );

  // Xero is deliberately absent from that list: it has one set of API hosts and
  // offers its demo company inside the same tenant list, so there is no
  // sandbox host to switch to and a flag could only lie. This pins the absence
  // so nobody adds one later thinking it was an oversight.
  it('has no Xero environment flag to forward', () => {
    expect(CONFIG).not.toContain('XERO_ENVIRONMENT');
    expect(WORKFLOW).not.toContain('XERO_ENVIRONMENT');
  });
});

describe('the shared encryption key', () => {
  // Every connector's stored tokens are encrypted with it, so a deployment that
  // carries a client secret without this one leaves every guard false and looks
  // identical to never having configured anything.
  it('reaches the instance, since every guard depends on it', () => {
    for (const [guard, vars] of GUARDS) {
      expect(vars, `${guard} should gate on ENCRYPTION_KEY`).toContain('ENCRYPTION_KEY');
    }
    expect(WORKFLOW).toContain('ENCRYPTION_KEY: ${{ secrets.ENCRYPTION_KEY }}');
    expect(DEPLOY_SCRIPT).toContain('"ENCRYPTION_KEY"');
  });
});
