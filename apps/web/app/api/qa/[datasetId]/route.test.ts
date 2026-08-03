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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(req(), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_UNREACHABLE', message: 'API server unavailable' },
    });
    expect(warn).toHaveBeenCalledWith('[qa-route] upstream unreachable', expect.any(Error));
  });

  it('falls back to 502 instead of a stale 2xx status when the body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('aborted')),
    } as unknown as Response);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(req(), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' },
    });
    expect(warn).toHaveBeenCalledWith('[qa-route] upstream returned non-JSON body', expect.any(Error));
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

  // Matches bff-proxy.test.ts's identical case for invalidResponse -- a body-read
  // failure only makes the status untrustworthy for 2xx/null-body statuses, so a
  // genuine 5xx still passes through here too, not just non-5xx statuses.
  it('preserves a genuine 5xx status when the body fails to parse', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    } as unknown as Response);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(req(), { params });

    expect(res.status).toBe(503);
  });

  it('preserves a genuine non-5xx status when the body fails to parse', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    } as unknown as Response);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(req(), { params });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' },
    });
  });

  it('collapses to 502 when a null-body status (304) is unparseable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 304,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    } as unknown as Response);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(req(), { params });

    expect(res.status).toBe(502);
  });
});
