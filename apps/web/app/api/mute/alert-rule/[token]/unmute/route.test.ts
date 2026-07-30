import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

const params = Promise.resolve({ token: 'sometoken' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/mute/alert-rule/[token]/unmute', () => {
  it('passes through a successful upstream response', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ data: { muted: false } }),
    } as Response);

    const res = await POST(new NextRequest('http://localhost/api/mute/alert-rule/sometoken/unmute', { method: 'POST' }), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { muted: false } });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes through an invalid-token error response unchanged', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 400,
      json: () => Promise.resolve({ error: { code: 'INVALID_TOKEN', message: 'bad token' } }),
    } as Response);

    const res = await POST(new NextRequest('http://localhost/api/mute/alert-rule/sometoken/unmute', { method: 'POST' }), { params });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'INVALID_TOKEN', message: 'bad token' } });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns 502 UPSTREAM_UNAVAILABLE when fetch rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection refused'));

    const res = await POST(new NextRequest('http://localhost/api/mute/alert-rule/sometoken/unmute', { method: 'POST' }), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' },
    });
    expect(warnSpy).toHaveBeenCalledWith('[unmute-route] upstream unreachable', expect.any(Error));
  });

  it('returns the upstream status with UPSTREAM_INVALID_RESPONSE when the body is not JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 500,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    } as unknown as Response);

    const res = await POST(new NextRequest('http://localhost/api/mute/alert-rule/sometoken/unmute', { method: 'POST' }), { params });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
    expect(warnSpy).toHaveBeenCalledWith('[unmute-route] upstream returned non-JSON body', expect.any(SyntaxError));
  });

  it('falls back to 502 instead of a stale 2xx status when the body is not JSON', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('aborted')),
    } as unknown as Response);

    const res = await POST(new NextRequest('http://localhost/api/mute/alert-rule/sometoken/unmute', { method: 'POST' }), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
  });

  it('falls back to 502 instead of a null-body status when the body is not JSON', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 204,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    } as unknown as Response);

    const res = await POST(new NextRequest('http://localhost/api/mute/alert-rule/sometoken/unmute', { method: 'POST' }), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
  });

  it('forwards to the expected upstream URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ data: { muted: false } }),
    } as Response);

    await POST(new NextRequest('http://localhost/api/mute/alert-rule/sometoken/unmute', { method: 'POST' }), { params });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://api:3001/alerts/unmute/sometoken'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns 502 UPSTREAM_UNAVAILABLE when the request arrives with an already-aborted signal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    });

    const request = new NextRequest('http://localhost/api/mute/alert-rule/sometoken/unmute', { method: 'POST' });
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(request, 'signal', { value: controller.signal });

    const res = await POST(request, { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' },
    });
    expect(warnSpy).toHaveBeenCalledWith('[unmute-route] upstream unreachable', expect.anything());
  });
});
