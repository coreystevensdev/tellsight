// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';

// This module had no test file. Every one of the eight test files that touches
// it does vi.mock('@/lib/api-client'), so the silent-refresh recovery was never
// executed: changing `if (response.status === 401)` to `if (false)` left all 834
// web tests green. useAiStream carries a second copy of the same recovery and
// that one is tested, which is probably why this read as covered.

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

interface ClientError {
  status: number;
  code: string | null;
  message: string;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Module state (refreshPromise) has to start clean for the de-dup tests.
async function freshClient() {
  vi.resetModules();
  return import('./api-client');
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('apiClient', () => {
  it('returns the parsed body and does not refresh on success', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { id: 7 } }));
    const { apiClient } = await freshClient();

    await expect(apiClient('/datasets')).resolves.toEqual({ data: { id: 7 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends cookies and the JSON content type', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: null }));
    const { apiClient } = await freshClient();

    await apiClient('/datasets');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/datasets');
    expect(init.credentials).toBe('include');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('lets a caller override the content type', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: null }));
    const { apiClient } = await freshClient();

    await apiClient('/x', { headers: { 'Content-Type': 'text/csv' } });

    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ 'Content-Type': 'text/csv' });
  });
});

describe('apiClient 401 recovery', () => {
  it('refreshes and replays the original request', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: { code: 'AUTH', message: 'expired' } }, 401))
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // the refresh
      .mockResolvedValueOnce(json({ data: { id: 7 } }));
    const { apiClient } = await freshClient();

    await expect(apiClient('/datasets')).resolves.toEqual({ data: { id: 7 } });

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(['/api/datasets', '/api/auth/refresh', '/api/datasets']);
  });

  it('replays with the original method and body, not a bare GET', async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json({ data: 'ok' }));
    const { apiClient } = await freshClient();

    await apiClient('/datasets', { method: 'POST', body: '{"name":"x"}' });

    const [, retryInit] = fetchMock.mock.calls[2]!;
    expect(retryInit.method).toBe('POST');
    expect(retryInit.body).toBe('{"name":"x"}');
  });

  it('throws the original 401 when the refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: { code: 'AUTH_EXPIRED', message: 'expired' } }, 401))
      .mockResolvedValueOnce(new Response(null, { status: 401 })); // refresh rejected
    const { apiClient, ApiClientError } = await freshClient();

    const err = await apiClient('/datasets').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as InstanceType<typeof ApiClientError>).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a thrown refresh as a failed refresh rather than propagating it', async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 401))
      .mockRejectedValueOnce(new Error('network down'));
    const { apiClient, ApiClientError } = await freshClient();

    await expect(apiClient('/datasets')).rejects.toBeInstanceOf(ApiClientError);
  });

  it('does not refresh on a non-401 failure', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'BOOM', message: 'server' } }, 500));
    const { apiClient } = await freshClient();

    await expect(apiClient('/datasets')).rejects.toThrow('server');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The refresh token rotates on every use. Without the shared promise, five
  // widgets loading at once against an expired access token fire five refreshes,
  // four of which present an already-rotated token and log the user out.
  it('collapses concurrent 401s into a single refresh', async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return new Response(null, { status: 200 });
      }
      return refreshCalls > 0 ? json({ data: 'ok' }) : json({}, 401);
    });
    const { apiClient } = await freshClient();

    const results = await Promise.all([
      apiClient('/a'),
      apiClient('/b'),
      apiClient('/c'),
      apiClient('/d'),
      apiClient('/e'),
    ]);

    expect(refreshCalls).toBe(1);
    expect(results).toEqual(Array(5).fill({ data: 'ok' }));
  });

  // The shared promise has to be released afterwards, or the first refresh of
  // the session would be the only one that ever runs.
  it('refreshes again on a later, separate 401', async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 401)) // /a
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // first refresh
      .mockResolvedValueOnce(json({ data: 'a' })) // /a replayed
      .mockResolvedValueOnce(json({}, 401)) // /b
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // second refresh
      .mockResolvedValueOnce(json({ data: 'b' })); // /b replayed
    const { apiClient } = await freshClient();

    await expect(apiClient('/a')).resolves.toEqual({ data: 'a' });
    await expect(apiClient('/b')).resolves.toEqual({ data: 'b' });

    const refreshes = fetchMock.mock.calls.filter((c) => c[0] === '/api/auth/refresh');
    expect(refreshes).toHaveLength(2);
  });
});

describe('apiClient error shaping', () => {
  it('lifts the code and message off the error envelope', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'RATE_LIMITED', message: 'slow down' } }, 429));
    const { apiClient } = await freshClient();

    const err = (await apiClient('/x').catch((e: unknown) => e)) as ClientError;

    expect(err.status).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toBe('slow down');
  });

  // Gateway timeouts and proxy errors come back as HTML, so the parse has to
  // fail softly rather than replacing the status with a JSON syntax error.
  it('falls back to the status when the body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
    const { apiClient } = await freshClient();

    const err = (await apiClient('/x').catch((e: unknown) => e)) as ClientError;

    expect(err.status).toBe(502);
    expect(err.code).toBeNull();
    expect(err.message).toBe('API error: 502');
  });
});
