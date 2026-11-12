import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecute = vi.fn();
const warn = vi.fn();
const info = vi.fn();

vi.mock('./db.js', () => ({ db: { execute: mockExecute } }));
vi.mock('./logger.js', () => ({ logger: { warn, info } }));

const { assertRlsEnforced } = await import('./rlsPreflight.js');

function restricted(overrides: Record<string, unknown> = {}) {
  return { role: 'app_user', isSuper: false, canBypassRls: false, ownedUnforcedTables: 0, ...overrides };
}

describe('assertRlsEnforced', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('boots quietly when the app role is genuinely restricted', async () => {
    await expect(assertRlsEnforced('production', async () => restricted())).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  // Each of these makes every policy in the database advisory. Nothing errors at
  // query time, which is the whole problem: the rows just stop being filtered.
  it.each([
    ['the role is a superuser', { isSuper: true }],
    ['the role has BYPASSRLS', { canBypassRls: true }],
    ['the role owns RLS tables that lack FORCE', { ownedUnforcedTables: 21 }],
  ])('refuses to boot in production when %s', async (_label, overrides) => {
    await expect(
      assertRlsEnforced('production', async () => restricted(overrides)),
    ).rejects.toThrow(/row-level security/i);
  });

  it('names the role and the count so an operator can act on the message', async () => {
    const err: unknown = await assertRlsEnforced('production', async () =>
      restricted({ role: 'app_admin', ownedUnforcedTables: 21 }),
    ).catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('app_admin');
    expect((err as Error).message).toContain('21');
  });

  // Ownership only defeats RLS while FORCE is off. A later FORCE rollout must not
  // start failing boot, so the check tests the condition, not the role name.
  it('accepts a table owner once FORCE ROW LEVEL SECURITY is on', async () => {
    await expect(
      assertRlsEnforced('production', async () => restricted({ role: 'app_admin', ownedUnforcedTables: 0 })),
    ).resolves.toBeUndefined();
  });

  // Running local dev against a bare superuser postgres is a reasonable
  // convenience. It just must not be mistaken for a deployment where tenant
  // isolation holds, so it warns instead of blocking.
  it('warns but still boots outside production', async () => {
    await expect(
      assertRlsEnforced('development', async () => restricted({ isSuper: true })),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses to boot in production when the check cannot run', async () => {
    await expect(
      assertRlsEnforced('production', async () => {
        throw new Error('permission denied for relation pg_roles');
      }),
    ).rejects.toThrow(/could not verify/i);
  });

  it('warns but still boots outside production when the check cannot run', async () => {
    await expect(
      assertRlsEnforced('test', async () => {
        throw new Error('connection refused');
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// A preflight nobody calls is worse than none, because the suite goes green and
// the gate reads as present. Same posture as rlsCallSites.test.ts: check the
// call site directly rather than trusting that boot was wired.
describe('rlsPreflight wiring', () => {
  const source = readFileSync(join(import.meta.dirname ?? __dirname, '../index.ts'), 'utf8');

  it('is called during boot', () => {
    expect(source).toContain('assertRlsEnforced(');
  });

  // Listening first would serve unisolated requests for as long as the probe takes.
  it('runs before the server starts listening', () => {
    const callAt = source.indexOf('assertRlsEnforced(');
    // Without this, an absent call indexes to -1 and passes the comparison below.
    expect(callAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(source.indexOf('app.listen('));
  });

  it('exits instead of continuing when it throws', () => {
    const at = source.indexOf('assertRlsEnforced(');
    expect(source.slice(at, at + 400)).toContain('process.exit(1)');
  });
});
