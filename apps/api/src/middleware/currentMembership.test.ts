import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Request, Response, NextFunction } from 'express';

const findCallerContext = vi.fn();
vi.mock('../db/queries/userOrgs.js', () => ({ findCallerContext }));
vi.mock('../lib/db.js', () => ({ dbAdmin: {} }));

const { currentMembership } = await import('./currentMembership.js');

const token = { sub: '42', org_id: 10, role: 'owner' as const, isAdmin: true, iat: 0, exp: 0 };
const run = async (user: unknown) => {
  const req = { user } as unknown as Request;
  const next = vi.fn() as unknown as NextFunction;
  await currentMembership(req, {} as Response, next);
  return { req, next };
};

beforeEach(() => vi.clearAllMocks());

describe('currentMembership', () => {
  it('asks about this caller in this org', async () => {
    findCallerContext.mockResolvedValue({ role: 'owner', isPlatformAdmin: true });

    await run(token);

    expect(findCallerContext).toHaveBeenCalledWith(42, 10, expect.anything());
  });

  it('rejects once the membership is gone', async () => {
    findCallerContext.mockResolvedValue(null);

    await expect(run(token)).rejects.toThrow(/no longer valid/i);
  });

  // roleGuard gates owner-only routes on this.
  it('takes the role from the database, not the token', async () => {
    findCallerContext.mockResolvedValue({ role: 'member', isPlatformAdmin: true });

    const { req, next } = await run(token);

    expect(req.user?.role).toBe('member');
    expect(next).toHaveBeenCalled();
  });

  // withRlsContext passes this to Postgres as the RLS bypass, so a stale true
  // here is the most expensive claim in the token to get wrong.
  it('takes the platform-admin flag from the database, not the token', async () => {
    findCallerContext.mockResolvedValue({ role: 'owner', isPlatformAdmin: false });

    const { req } = await run(token);

    expect(req.user?.isAdmin).toBe(false);
  });

  it('refuses to run without authMiddleware in front of it', async () => {
    await expect(run(undefined)).rejects.toThrow(/missing auth context/i);
    expect(findCallerContext).not.toHaveBeenCalled();
  });

  // Stubbed out in the router-wiring suites, so nothing else would notice it
  // being dropped from the one place production mounts it.
  it('is mounted on protectedRouter directly after authMiddleware', () => {
    const src = readFileSync(new URL('../routes/protected.ts', import.meta.url), 'utf8');
    const uses = [...src.matchAll(/protectedRouter\.use\((\w+)\)/g)].map((m) => m[1]);
    const auth = uses.indexOf('authMiddleware');

    expect(auth).toBeGreaterThanOrEqual(0);
    expect(uses[auth + 1]).toBe('currentMembership');
  });
});
