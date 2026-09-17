import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const getOrgMembers = vi.fn();
const removeMember = vi.fn();
const mockAudit = vi.fn();

let caller = { sub: '1', org_id: 10, role: 'owner' as 'owner' | 'member', isAdmin: false };

vi.mock('../db/queries/index.js', () => ({
  userOrgsQueries: { getOrgMembers, removeMember },
}));
vi.mock('../lib/db.js', () => ({ db: {}, dbAdmin: { _tag: 'dbAdmin' } }));
vi.mock('../services/audit/auditService.js', () => ({ audit: mockAudit }));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));
vi.mock('../config.js', () => ({ env: { NODE_ENV: 'test' } }));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { orgMembersRouter } = await import('./orgMembers.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use((req, _res, next) => { (req as { user?: unknown }).user = caller; next(); });
    app.use('/org', orgMembersRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  caller = { sub: '1', org_id: 10, role: 'owner', isAdmin: false };
  removeMember.mockResolvedValue({ id: 5, orgId: 10, userId: 2, role: 'member' });
});

describe('GET /org/members', () => {
  it('lists the org, flattening the joined user', async () => {
    getOrgMembers.mockResolvedValue([
      { userId: 1, role: 'owner', joinedAt: new Date(0), user: { name: 'Ada', email: 'a@x.test', avatarUrl: null } },
    ]);

    const res = await fetch(`${baseUrl}/org/members`);
    const body = (await res.json()) as { data: Array<{ userId: number; name: string; email: string }> };

    expect(res.status).toBe(200);
    expect(body.data[0]).toMatchObject({ userId: 1, name: 'Ada', email: 'a@x.test', role: 'owner' });
    expect(getOrgMembers).toHaveBeenCalledWith(10, expect.anything());
  });

  it('marks which row is the caller, since the browser cannot tell', async () => {
    getOrgMembers.mockResolvedValue([
      { userId: 1, role: 'owner', joinedAt: new Date(0), user: { name: 'Ada', email: 'a@x.test', avatarUrl: null } },
      { userId: 2, role: 'member', joinedAt: new Date(0), user: { name: 'Bo', email: 'b@x.test', avatarUrl: null } },
    ]);

    const res = await fetch(`${baseUrl}/org/members`);
    const body = (await res.json()) as { data: Array<{ userId: number; isSelf: boolean }> };

    expect(body.data.find((m) => m.userId === 1)?.isSelf).toBe(true);
    expect(body.data.find((m) => m.userId === 2)?.isSelf).toBe(false);
  });

  it('is closed to members', async () => {
    caller = { sub: '3', org_id: 10, role: 'member', isAdmin: false };

    expect((await fetch(`${baseUrl}/org/members`)).status).toBe(403);
  });
});

describe('DELETE /org/members/:userId', () => {
  it('removes someone else from the caller org', async () => {
    const res = await fetch(`${baseUrl}/org/members/2`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(removeMember).toHaveBeenCalledWith(10, 2, expect.anything());
  });

  // Whoever is calling is an owner, so refusing self-removal is also what keeps
  // an org from ending up with members and no owner.
  it('refuses an owner removing themselves', async () => {
    const res = await fetch(`${baseUrl}/org/members/1`, { method: 'DELETE' });
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(409);
    expect(body.error.message).toMatch(/delete your account/i);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('404s for someone who was not in the org', async () => {
    removeMember.mockResolvedValue(undefined);

    expect((await fetch(`${baseUrl}/org/members/99`, { method: 'DELETE' })).status).toBe(404);
  });

  it('is closed to members', async () => {
    caller = { sub: '3', org_id: 10, role: 'member', isAdmin: false };

    expect((await fetch(`${baseUrl}/org/members/2`, { method: 'DELETE' })).status).toBe(403);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric id before touching the database', async () => {
    expect((await fetch(`${baseUrl}/org/members/abc`, { method: 'DELETE' })).status).toBe(400);
    expect(removeMember).not.toHaveBeenCalled();
  });

  // Deletion is scoped to the caller's own org, so an owner cannot reach into
  // another one. The org has to be offered in the request for this to mean
  // anything: asserting the caller's org is used proves nothing when the caller's
  // org is the only org in play.
  it.each([
    ['a query string', '/org/members/2?orgId=999'],
    ['a second path segment', '/org/members/2/999'],
  ])('ignores an org id supplied through %s', async (_label, path) => {
    caller = { sub: '1', org_id: 77, role: 'owner', isAdmin: false };

    const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });

    if (res.status === 404 && removeMember.mock.calls.length === 0) return; // no such route
    expect(removeMember).toHaveBeenCalledWith(77, 2, expect.anything());
  });

  it('ignores an org id supplied in the body', async () => {
    caller = { sub: '1', org_id: 77, role: 'owner', isAdmin: false };

    await fetch(`${baseUrl}/org/members/2`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: 999 }),
    });

    expect(removeMember).toHaveBeenCalledWith(77, 2, expect.anything());
  });

  it('writes the audit entry naming who was removed', async () => {
    await fetch(`${baseUrl}/org/members/2`, { method: 'DELETE' });

    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: 10, action: 'org.member_removed', targetId: '2' }),
    );
  });
});
