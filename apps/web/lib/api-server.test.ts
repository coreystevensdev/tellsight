// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';

// No test file existed, and every consumer (app/dashboard/page.tsx,
// app/admin/page.tsx, app/settings/alerts/page.tsx, app/settings/email/page.tsx)
// does vi.mock('@/lib/api-server'), so this module never executed under test.
// Three separate mutations were green on the full 849-test web suite:
// cache 'no-store' to 'force-cache', the Cookie forwarding line deleted, and
// `if (!response.ok)` to `if (false)`.

vi.mock('./config', () => ({
  webEnv: { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: 'k'.repeat(32), NODE_ENV: 'test' },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { apiServer, ApiServerError } = await import('./api-server');

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('apiServer request shape', () => {
  it('calls the internal API url, not the public one', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: null }));

    await apiServer('/dashboard/charts');

    expect(fetchMock.mock.calls[0]![0]).toBe('http://api:3001/dashboard/charts');
  });

  // Server Components render per request. Without no-store, Next's Data Cache
  // can serve one user's dashboard payload to the next.
  it('never caches, since these responses are per user', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: null }));

    await apiServer('/dashboard/charts');

    expect(fetchMock.mock.calls[0]![1].cache).toBe('no-store');
  });

  // A Server Component has no ambient cookie jar: the caller reads them and
  // passes them in. Drop this and every server-side read is unauthenticated,
  // which fails open to whatever the API returns for an anonymous caller.
  it('forwards the caller cookies as a Cookie header', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: null }));

    await apiServer('/dashboard/charts', { cookies: 'access_token=abc; refresh_token=def' });

    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({
      Cookie: 'access_token=abc; refresh_token=def',
    });
  });

  it('omits the Cookie header when the caller passes none', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: null }));

    await apiServer('/health');

    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty('Cookie');
  });

  it('lets a caller add headers without dropping the cookie', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: null }));

    await apiServer('/x', { cookies: 'a=1', headers: { 'X-Request-Id': 'r1' } });

    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({
      Cookie: 'a=1',
      'X-Request-Id': 'r1',
      'Content-Type': 'application/json',
    });
  });
});

describe('apiServer responses', () => {
  it('returns the parsed body on success', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { id: 7 } }));

    await expect(apiServer('/x')).resolves.toEqual({ data: { id: 7 } });
  });

  // Without this branch an error envelope is returned as though it were a
  // success payload, and the page renders `undefined` fields instead of
  // hitting its error boundary.
  it('throws on a non-ok response rather than returning the error body', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'FORBIDDEN', message: 'no access', details: { orgId: 3 } } }, 403),
    );

    const err = (await apiServer('/x').catch((e: unknown) => e)) as InstanceType<typeof ApiServerError>;

    expect(err).toBeInstanceOf(ApiServerError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('no access');
    expect(err.details).toEqual({ orgId: 3 });
  });

  it('falls back to the status when the error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));

    const err = (await apiServer('/x').catch((e: unknown) => e)) as InstanceType<typeof ApiServerError>;

    expect(err.code).toBe('UNKNOWN_ERROR');
    expect(err.message).toBe('API error: 502');
    expect(err.statusCode).toBe(502);
  });

  it('reports an unreachable API as a network error, not a crash', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const err = (await apiServer('/x').catch((e: unknown) => e)) as InstanceType<typeof ApiServerError>;

    expect(err).toBeInstanceOf(ApiServerError);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.statusCode).toBe(0);
  });
});
