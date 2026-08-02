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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await GET(req(), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_UNREACHABLE', message: 'API server unavailable' },
    });
    expect(warn).toHaveBeenCalledWith('[ai-summaries-route] upstream unreachable', expect.any(Error));
  });

  it('falls back to 502 instead of a stale 2xx status when the cached body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: jsonHeaders(),
      json: () => Promise.reject(new Error('aborted')),
    } as unknown as Response);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await GET(req(), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' },
    });
    expect(warn).toHaveBeenCalledWith('[ai-summaries-route] upstream returned non-JSON body (cache hit)', expect.any(Error));
  });

  it('falls back to a generic error body when a non-ok, non-SSE response is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: jsonHeaders(),
      json: () => Promise.reject(new Error('aborted')),
    } as unknown as Response);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await GET(req(), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' },
    });
    expect(warn).toHaveBeenCalledWith('[ai-summaries-route] upstream returned non-JSON body (error status)', expect.any(Error));
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

  it('propagates an upstream stream error to the client after a mid-stream abort', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
    } as unknown as Response);

    // jsdom's AbortSignal fails NextRequest's constructor-time WebIDL check, so
    // the signal is swapped in after construction (same workaround as bff-proxy.test.ts).
    const controller = new AbortController();
    // The mocked fetch above ignores init.signal entirely, so it never reproduces
    // the real Fetch API guarantee that an abort tears down an in-flight body read,
    // not just the initial connection. This listener stands in for that platform
    // behavior so the abort actually drives the outcome instead of being inert.
    controller.signal.addEventListener('abort', () => {
      streamController.error(new DOMException('The operation was aborted.', 'AbortError'));
    });
    const abortableReq = req();
    Object.defineProperty(abortableReq, 'signal', { value: controller.signal });
    const res = await GET(abortableReq, { params });

    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(res.body).toBe(body);

    const reader = res.body!.getReader();
    const chunk = new Uint8Array([1, 2, 3]);
    streamController.enqueue(chunk);
    const first = await reader.read();
    expect(first.value).toEqual(chunk);

    controller.abort();

    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
