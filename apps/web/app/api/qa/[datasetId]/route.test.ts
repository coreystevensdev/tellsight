import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

const params = Promise.resolve({ datasetId: 'dataset-1' });

function req(body = '{}') {
  return new NextRequest('http://localhost/api/qa/dataset-1', { method: 'POST', body });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/qa/[datasetId]', () => {
  it('passes through a successful upstream response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { answer: 'revenue is up 12%' } }),
    } as Response);

    const res = await POST(req(), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { answer: 'revenue is up 12%' } });
  });

  it('returns 502 UPSTREAM_UNREACHABLE when fetch rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection refused'));

    const res = await POST(req(), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_UNREACHABLE', message: 'API server unavailable' },
    });
  });

  it('falls back to 502 instead of a stale 2xx status when the body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('aborted')),
    } as unknown as Response);

    const res = await POST(req(), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' },
    });
  });

  it('maps a genuine 5xx upstream status to 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: { code: 'PIPELINE_ERROR', message: 'busy' } }),
    } as Response);

    const res = await POST(req(), { params });

    expect(res.status).toBe(502);
  });
});
