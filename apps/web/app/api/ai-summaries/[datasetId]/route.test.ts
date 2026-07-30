import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

const params = Promise.resolve({ datasetId: 'dataset-1' });

function req() {
  return new NextRequest('http://localhost/api/ai-summaries/dataset-1');
}

function jsonHeaders() {
  return new Headers({ 'content-type': 'application/json' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/ai-summaries/[datasetId]', () => {
  it('passes through a cached JSON response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: jsonHeaders(),
      json: () => Promise.resolve({ data: { summary: 'cached' } }),
    } as unknown as Response);

    const res = await GET(req(), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { summary: 'cached' } });
  });

  it('returns 502 UPSTREAM_UNREACHABLE when fetch rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection refused'));

    const res = await GET(req(), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_UNREACHABLE', message: 'API server unavailable' },
    });
  });

  it('falls back to 502 instead of a stale 2xx status when the cached body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: jsonHeaders(),
      json: () => Promise.reject(new Error('aborted')),
    } as unknown as Response);

    const res = await GET(req(), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' },
    });
  });

  it('passes an SSE stream straight through', async () => {
    const body = new ReadableStream();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
    } as unknown as Response);

    const res = await GET(req(), { params });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });
});
