import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// No test file existed. This route also encoded only one of its two path
// segments, unlike its sibling, which is what made the asymmetry visible.

vi.mock('@/lib/config', () => ({
  webEnv: { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: 'k'.repeat(32), NODE_ENV: 'test' },
}));

const { GET } = await import('./route');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function req(query = '') {
  return new NextRequest(`http://localhost/api/ai-summaries/1/stats/x/rows${query}`, {
    headers: { cookie: 'access_token=abc' },
  });
}

function ok(body: unknown = { data: [] }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const params = (datasetId = '7', statId = 'total') => Promise.resolve({ datasetId, statId });

beforeEach(() => fetchMock.mockReset());

describe('GET /api/ai-summaries/[datasetId]/stats/[statId]/rows', () => {
  it('forwards to the internal API with the cookie', async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: [{ id: 1 }] }));

    const res = await GET(req(), { params: params() });

    expect(await res.json()).toEqual({ data: [{ id: 1 }] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://api:3001/ai-summaries/7/stats/total/rows');
    expect(init.headers).toMatchObject({ cookie: 'access_token=abc' });
  });

  it.each([
    ['the stat id', '7', 'Travel/Meals', 'http://api:3001/ai-summaries/7/stats/Travel%2FMeals/rows'],
    ['the dataset id', 'a/b', 'total', 'http://api:3001/ai-summaries/a%2Fb/stats/total/rows'],
  ])('encodes %s', async (_label, datasetId, statId, expected) => {
    fetchMock.mockResolvedValueOnce(ok());

    await GET(req(), { params: params(datasetId, statId) });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(expected);
  });

  // Pagination is the reason this route exists separately from its sibling.
  it('passes limit and offset through when present', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await GET(req('?limit=25&offset=50'), { params: params() });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('offset')).toBe('50');
  });

  it('omits them entirely when absent, rather than sending empty values', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await GET(req(), { params: params() });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.searchParams.has('offset')).toBe(false);
  });

  it('reports the API unreachable rather than throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'UPSTREAM_UNREACHABLE' } });
  });

  it('returns a shaped error when the upstream body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>500</html>', { status: 500 }));

    expect(await (await GET(req(), { params: params() })).json()).toMatchObject({
      error: { code: 'UPSTREAM_ERROR' },
    });
  });
});
